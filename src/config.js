// Config loading for sbot.
//
// Lookup order (first hit wins):
//   1. explicit path (--config)
//   2. $SBOT_CONFIG
//   3. ./sbot.config.json
//   4. ~/.sbot/config.json
// Falls back to built-in DEFAULTS when no file is found, so `sbot agent run
// --provider claude` works out of the box against your logged-in Claude auth.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { DEFAULT_TZ, normalizeTz } = require('./core/time')
const { resolveProjectsRoots, expandHome } = require('./projectsroot')
const { setKnownSecrets } = require('./core/redact')

const DEFAULTS = {
  // `agent` holds only infrastructure/safety knobs — NOT tool permissions.
  //   permissionMode 'dontAsk' = policy-driven headless perms that never hang (DESIGN §4.1).
  //   maxConcurrent: global cap on simultaneous turns across all groups (0 = unlimited).
  // Tool permissions are PER-PROJECT: each group carries its own allowedTools /
  // disallowedTools (see below). No global allow/deny — a group with none configured
  // runs fully locked down (dontAsk ⇒ read-only safe set only), which is fail-closed.
  // maxTurnTimeMins defaults to 30: an uncapped runaway turn would
  // hold a concurrency slot and the group lock forever. 0 = explicitly off.
  // autocompactTokens:上下文超过该值即让 CLI 原地压缩(claude --autocompact / codex
  // model_auto_compact_token_limit)。多天连跑的群会话历史只增不减(2026-08-09 实测 4 天涨到
  // 96 万 token 且两家 CLI 默认都没触发任何压缩),不设上限 = 每轮驮全量历史 + 闲置后整段重写缓存。
  // 0 = 关闭(交还 CLI 默认行为)。
  // ackDelayMs:收到真人消息后迟迟没动静,先回一声「已收到」的等待毫秒数(0 = 不发;
  // engine 侧另有 == null ? 25s 兜底,直构 Engine 不经本层合并也不失默认)。
  agent: { bin: 'claude', permissionMode: 'dontAsk', maxTurnTimeMins: 30, maxConcurrent: 2, autocompactTokens: 400_000, ackDelayMs: 25_000 },
  // 时间口径(IANA 时区名):群内一切时间表述/消息时间戳/spawn 出去的 TZ 都按它,
  // 默认北京时间 —— 主机系统时区不参与(海外主机部署照样说北京时间)。
  timezone: DEFAULT_TZ,
  defaultProvider: 'claude',
  // 不写死型号:spawn 时就不设 ANTHROPIC_MODEL,用这台机器上 Claude Code 自己的默认模型。
  // 写死会**覆盖 CLI 的默认**,于是每次 Anthropic 出新一代,sbot 的默认就悄悄落后一代
  // (2026-08-03 核对时正卡在 opus-4-8,而 CLI 默认已是 Opus 5)。要钉死型号在控制台选。
  providers: { claude: {} },
  // "<chatId>": { workdir, provider?, model?, codexSteer?: false, allowedTools?: [], disallowedTools?: [] }
  // codexSteer defaults on for Codex groups; explicit false opts out.
  // — one project per group; permissions are scoped to that group's own workdir.
  groups: {},
}

// "env:VAR" -> process.env.VAR ; otherwise pass through unchanged.
function resolveSecret(v) {
  if (typeof v === 'string' && v.startsWith('env:')) return process.env[v.slice(4)] || ''
  return v
}

// 新建配置的落点(setup 用):与 findConfigPath 的查找顺序一致 —— 显式 > $SBOT_CONFIG > 当前目录已有的
// sbot.config.json > ~/.sbot/config.json。全局安装后在任何目录跑都能找到,所以新装默认放家目录。
function defaultConfigPath(explicit) {
  if (explicit) return path.resolve(explicit)
  if (process.env.SBOT_CONFIG) return path.resolve(process.env.SBOT_CONFIG)
  const local = path.join(process.cwd(), 'sbot.config.json')
  if (fs.existsSync(local)) return local
  return path.join(os.homedir(), '.sbot', 'config.json')
}

function findConfigPath(explicit) {
  const candidates = [
    explicit,
    process.env.SBOT_CONFIG,
    path.join(process.cwd(), 'sbot.config.json'),
    path.join(os.homedir(), '.sbot', 'config.json'),
  ].filter(Boolean)
  return candidates.find((c) => fs.existsSync(c)) || null
}

function loadConfig(explicit) {
  const p = findConfigPath(explicit)
  let user = {}
  if (p) {
    try {
      user = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch (e) {
      throw new Error(`sbot: failed to parse config ${p}: ${e.message}`)
    }
  }

  return normalizeConfig(user, p)
}

// The console validates proposed JSON before replacing the live file. Keep
// normalization identical to disk loading without mutating the proposed object
// or changing the live redaction registry during validation.
function normalizeConfig(raw, p = null, { registerSecrets = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Configuration must be a JSON object')
  }
  const user = JSON.parse(JSON.stringify(raw))
  const cfg = {
    agent: { ...DEFAULTS.agent, ...(user.agent || {}) },
    timezone: normalizeTz(user.timezone || DEFAULTS.timezone), // 写错回退默认,不漂到主机时区
    defaultProvider: user.defaultProvider || DEFAULTS.defaultProvider,
    providers: { ...DEFAULTS.providers, ...(user.providers || {}) },
    groups: { ...DEFAULTS.groups, ...(user.groups || {}) },
    _path: p,
  }

  // 群目录认 `~`:1.0.0–1.0.2 的向导把输入原样存进配置,`~/x` 成了字面路径(轮次会在 daemon 的 cwd 下找一个叫 `~` 的目录)。
  // 只在内存里展开,配置文件不改 —— 控制台重新保存该群时写成绝对路径。
  for (const [id, g] of Object.entries(cfg.groups)) {
    if (g && typeof g.workdir === 'string' && /^~(?:[\\/]|$)/.test(g.workdir.trim())) cfg.groups[id] = { ...g, workdir: expandHome(g.workdir) }
  }

  // Resolve apiKey secrets up front so consumers get plain values.
  for (const prov of Object.values(cfg.providers)) {
    if (prov && prov.apiKey) prov.apiKey = resolveSecret(prov.apiKey)
  }

  // Feishu platform block (optional; only present when configured for `sbot start`).
  if (user.feishu) {
    cfg.feishu = { ...user.feishu }
    if (cfg.feishu.appId) cfg.feishu.appId = resolveSecret(cfg.feishu.appId)
    if (cfg.feishu.appSecret) cfg.feishu.appSecret = resolveSecret(cfg.feishu.appSecret)
    if (cfg.feishu.botOpenId) cfg.feishu.botOpenId = resolveSecret(cfg.feishu.botOpenId)
    // 示例里的占位 `ou_xxxx…` 当作没填(真 open_id 是 ou_ + 十六进制,不会出现 x):留着它,@ 门控会拿占位值
    // 去比对,真 @ 机器人的消息反被当成「@ 了别人」整条丢掉;当没填则退回宽松判定,doctor 也会提醒
    if (/^ou_x/i.test(String(cfg.feishu.botOpenId || ''))) cfg.feishu.botOpenId = ''
  }

  // 企业微信平台块(可选):智能机器人 API 模式的 Bot ID + 长连接 Secret(docs/WECOM.md)。
  // 双平台并存(2026-10-10 用户定):**配了哪个平台就接哪个**,两个都配就两个都接;每个群自己带 `platform`
  // 说明它属于哪边。顶层 `platform` 字段(分支上活过一天的「二选一」)已废弃 —— 存在则忽略,记下来让 doctor 提一句。
  if (user.platform !== undefined) cfg._deprecatedPlatform = String(user.platform)
  if (user.wecom) {
    cfg.wecom = { ...user.wecom }
    if (cfg.wecom.botId) cfg.wecom.botId = resolveSecret(cfg.wecom.botId)
    if (cfg.wecom.secret) cfg.wecom.secret = resolveSecret(cfg.wecom.secret)
  }
  // Slack 平台块(可选;docs/SLACK.md「形态」):与飞书 / 企微平级,配了就接;群归属走下面同一套归一。
  if (user.slack) {
    cfg.slack = { ...user.slack }
    if (cfg.slack.botToken) cfg.slack.botToken = resolveSecret(cfg.slack.botToken)   // xoxb-
    if (cfg.slack.appToken) cfg.slack.appToken = resolveSecret(cfg.slack.appToken)   // xapp-(connections:write)
    if (cfg.slack.botUserId) cfg.slack.botUserId = resolveSecret(cfg.slack.botUserId)
  }
  // 群级 platform 归一:写了合法值就认;没写的按 chatId 形态推断(oc_ 飞书 / wr 企微,两者不会撞),形态认不出
  // (企微单聊的 chatId = 对方 userid,长什么样都有)就按「只配了一个平台 ⇒ 那个」兜底;两个都配且认不出 ⇒ 记进
  // ambiguous 让 doctor 报 warn(运行时只认该会话最近一次入站的适配器)。⚠ 推断只在这里做一次写进内存态,运行时不再看 id 形态
  // —— 配置文件里的值不改(控制台重新保存该群时才补写字段),所以推断结果要可解释、可报告。
  cfg._groupPlatform = normalizeGroupPlatforms(cfg)

  // Optional proxy split (official Claude via proxy, CN endpoints direct).
  if (user.proxy && (user.proxy.http || user.proxy.https)) cfg.proxy = { ...user.proxy }

  // Console (UI) block — e.g. `ui.auth` (access-password scrypt hash). The console
  // server reads the raw file itself; this passthrough lets `sbot start --ui`
  // fail-closed on LAN exposure without a password.
  if (user.ui) cfg.ui = { ...user.ui }

  // 群预览服务(`sbot preview`)调优:idleMin / maxHours / portFrom-portTo / host。
  // 原样透传,归一化在 src/preview.js 的 normalizeOptions(非法值回默认,单一口径)。
  if (user.preview) cfg.preview = { ...user.preview }

  // ⚠ **这个函数是白名单式的:顶层键漏写 = 该键静默失效。** 配置文件里明明写了、doctor 不报、
  // 消费点恒拿 undefined 走兜底 —— 三处都不出声,所以能潜伏很久。2026-08-18 第一次真去配
  // `instance` 才发现它与 `design` 从来没生效过:反馈本恒用主机名(自定名白配),而取图标那处
  // 注释里「配置里的 design.iconsDir 优先(operator 可以指到别处)」是一句假话。
  // **新增顶层配置项时,连同这里和 tests/unit/config.test.js 的透传用例一起加。**
  if (user.instance) cfg.instance = String(user.instance)   // 这台机器在反馈本里怎么自称(跨机汇总用)
  if (user.design) cfg.design = { ...user.design }          // design.iconsDir:图标库另指目录
  if (user.browser) cfg.browser = { ...user.browser }       // browser.cdpUrl / takeoverMinutes:常驻浏览器地址与接管链接有效期(docs/BROWSER.md)
  if (user.alerts) cfg.alerts = { ...user.alerts }          // alerts.chatId:运维告警群 —— 模型账号异常 / 额度用完 / 自动切换发到这里(src/core/opsalert.js)
  // 产品在群成员面前叫什么(自知清单的自我认知 + 升级播报)。不写 = SintBot。
  // ⚠ 抽成配置项而不是写死:不同部署给机器人起的名字不同,只能由配置决定。
  if (user.brand) cfg.brand = String(user.brand)

  // 项目根目录围栏(控制台绑群 / 目录浏览 / 风格提炼共用,src/projectsroot.js):顶层 `projectsRoots`,
  // 字符串或数组、认 `~`。这里就解析成绝对路径数组;没配 = 平台默认(~/Projects);「等于没围」的值
  // (/、家目录、/Users)被丢掉并记在 _projectsRoots.dropped 给 doctor 报。⚠ 永不退到家目录 ——
  // 旧的目录选择器在 ~/Projects 建不出来时静默退到 $HOME,等于围栏悄悄没了。
  const pr = resolveProjectsRoots(user)
  cfg.projectsRoots = pr.roots
  cfg._projectsRoots = pr

  // 把配置里凭据的**值**登记给出站脱敏(src/core/redact.js 按值替换):每个 provider 的 apiKey、
  // provider env 里名字带 TOKEN / KEY / SECRET / PASSWORD 的值、飞书 appSecret。形状模式认不出的
  // 凭据(UUID 形的火山 key、裸十六进制的 appSecret)靠这条兜住;热重载走的也是这里 ⇒ 换 key 即换名单。
  if (registerSecrets) setKnownSecrets(collectSecretValues(cfg))

  return cfg
}

// 从装配好的配置里收集凭据原文;只收字符串,长短由 redact 侧裁决(< 16 字符一律不登记)。
function collectSecretValues(cfg) {
  const out = []
  for (const prov of Object.values((cfg && cfg.providers) || {})) {
    if (!prov) continue
    if (typeof prov.apiKey === 'string') out.push(prov.apiKey)
    for (const [k, v] of Object.entries(prov.env || {})) {
      if (/token|key|secret|password/i.test(k) && typeof v === 'string') out.push(v)
    }
  }
  if (cfg && cfg.feishu && typeof cfg.feishu.appSecret === 'string') out.push(cfg.feishu.appSecret)
  if (cfg && cfg.wecom && typeof cfg.wecom.secret === 'string') out.push(cfg.wecom.secret)
  return out
}

// Apply a config `proxy` block to process.env so every spawned `claude` child
// inherits it — without clobbering a value already set in the shell. Lets the
// operator bake the proxy split into config instead of exporting it each session.
function applyProxyEnv(cfg) {
  const p = cfg && cfg.proxy
  if (!p) return
  const set = (k, v) => { if (v && !process.env[k]) process.env[k] = v }
  const https = p.https || p.http
  set('HTTP_PROXY', p.http); set('http_proxy', p.http)
  set('HTTPS_PROXY', https); set('https_proxy', https)
  set('NO_PROXY', p.noProxy); set('no_proxy', p.noProxy)
}

// Build a NO_PROXY list from the configured providers' hostnames, so CN-direct
// endpoints bypass the proxy while official Claude still goes through it.
function deriveNoProxy(providers) {
  const hosts = new Set(['localhost', '127.0.0.1', '::1'])
  for (const p of Object.values(providers || {})) {
    if (!p || !p.baseUrl) continue
    try {
      const h = new URL(p.baseUrl).hostname.replace(/^\[|\]$/g, '')
      hosts.add(h)
      // IP 不取后两段:127.0.0.1 会变出一条 `*.0.1`(1.0.11 实装时 NO_PROXY 里真出现过)
      const parts = h.split('.')
      if (!net.isIP(h) && parts.length > 2) hosts.add('*.' + parts.slice(-2).join('.'))
    } catch { /* skip malformed baseUrl */ }
  }
  return [...hosts].join(',')
}

// 哪些聊天平台配齐了凭据(= daemon 会接哪些;doctor / 控制台 / bin 三处同一判据)。
function platformsConfigured(cfg) {
  const fe = (cfg && cfg.feishu) || {}
  const we = (cfg && cfg.wecom) || {}
  const sl = (cfg && cfg.slack) || {}
  return { feishu: !!(fe.appId && fe.appSecret), wecom: !!(we.botId && we.secret), slack: !!(sl.botToken && sl.appToken) }
}

// 按 chatId 形态猜平台:飞书的会话 id 一律 `oc_` 开头;企微群 id `wr` 开头(实测 wrXXXXXX…)。认不出返回 null
// (企微单聊 chatId 是对方 userid,没有形态可认)。
function inferChatPlatform(chatId) {
  const id = String(chatId || '')
  if (/^oc_/.test(id)) return 'feishu'
  if (/^wr[A-Za-z0-9_-]{6,}$/.test(id)) return 'wecom'
  // Slack:频道 C… / 私有 G… / 私聊 D…,后接全大写字母数字。⚠ 企微单聊 userid 也可能长这样(「DAVID1234」),
  // 所以这一形态只在配了 Slack 时才作数(trustGuess)—— 这里只报形态,不看配置。
  if (/^[CGD][A-Z0-9]{8,}$/.test(id)) return 'slack'
  return null
}
// 形态推断的结果在「推出 slack 却没配 Slack」时不作数(企微 userid 撞形态),其余照旧。
const trustGuess = (guess, on) => (guess === 'slack' && !on.slack ? null : guess)

const PLATFORMS = ['feishu', 'wecom', 'slack']

// 把每个群的 platform 归一成 'feishu' | 'wecom' 写进 cfg.groups[*].platform(内存态);返回推断记录给 doctor。
// 规则见 loadConfig 里的注释。只配了一个平台时所有认不出形态的群都归它;一个都没配时按飞书(老行为,doctor 另有行报没配平台)。
function normalizeGroupPlatforms(cfg) {
  const on = platformsConfigured(cfg)
  const live = PLATFORMS.filter((p) => on[p])
  const onlyOne = live.length === 1 ? live[0] : null
  const rec = { inferred: [], ambiguous: [], invalid: [] }
  for (const [chatId, g] of Object.entries(cfg.groups || {})) {
    if (!g || typeof g !== 'object') continue
    if (PLATFORMS.includes(g.platform)) continue
    if (g.platform !== undefined) rec.invalid.push(chatId) // 写了个认不得的值:当没写处理,但要出声
    const guess = trustGuess(inferChatPlatform(chatId), on)
    if (guess) { g.platform = guess; rec.inferred.push(chatId); continue }
    if (onlyOne) { g.platform = onlyOne; rec.inferred.push(chatId); continue }
    // 两个都配且认不出:**不写** platform(留 undefined)⇒ chatPlatform 回 null ⇒ 路由器只认该会话最近一次入站用的适配器,
    // 没见过入站就不发并记日志。对抗审查逮到的:此前「暂按飞书」会让定时任务 / 控制台插话拿飞书适配器去喂企微单聊 ——
    // 不是丢,是发错边,而且清单口径来回翻、每轮重注入。一个平台都没配时按飞书(老行为,doctor 另有行报没配平台)。
    if (live.length > 1) { delete g.platform; rec.ambiguous.push(chatId) }
    else { g.platform = 'feishu'; rec.inferred.push(chatId) }
  }
  return rec
}

// 某个会话属于哪个平台(运行时查表:群配置里归一过的 platform > id 形态 > 只配了一个平台就是它 > null)。
// 未绑定的群(运维告警群 / 定时任务指到的群)也走这里 —— 它们不在 groups 里,只能靠形态与「只有一个平台」兜底。
function chatPlatform(cfg, chatId) {
  const g = cfg && cfg.groups && cfg.groups[chatId]
  if (g && PLATFORMS.includes(g.platform)) return g.platform
  const on = platformsConfigured(cfg)
  const guess = trustGuess(inferChatPlatform(chatId), on)
  if (guess) return guess
  const live = PLATFORMS.filter((p) => on[p])
  return live.length === 1 ? live[0] : null
}

module.exports = { loadConfig, normalizeConfig, findConfigPath, defaultConfigPath, DEFAULTS, applyProxyEnv, deriveNoProxy, resolveSecret, platformsConfigured, inferChatPlatform, normalizeGroupPlatforms, chatPlatform, PLATFORMS }
