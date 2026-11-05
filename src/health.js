// Shared health check — the data behind `sbot doctor` and the console's health
// pill. Returns structured rows so both the CLI (renders to stdout) and the UI
// server (serves as JSON) work off one source of truth.

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { probeVersion, supportsFlag } = require('./agent/claudecode')
const codex = require('./agent/codexcode')
const claudestatus = require('./agent/claudestatus')
const codexstatus = require('./agent/codexstatus')
const projectsroot = require('./projectsroot')
const verify = require('./core/verify') // 凭据最近一次验证的记录:模型 key、飞书、Slack 行据此区分「配了」与「能用」
const leftover = require('./leftover') // 遗留进程:agent 轮次结束后仍在跑的后台 shell(v0.11.108)

// A provider whose baseUrl is loopback depends on a locally-run translation router
// (claude-code-router / LiteLLM) to reach a non-Anthropic model like GPT — OpenAI has
// no Anthropic endpoint, so `claude` can't hit it directly. Return {host,port} for a
// loopback baseUrl (so doctor can probe the router), else null. (The runtime vision
// strip-proxy also uses a loopback base, but that's injected at spawn, never in config.)
function loopbackTarget(baseUrl) {
  try {
    const u = new URL(baseUrl)
    const host = u.hostname
    if (!['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) return null
    // 0.0.0.0 / :: are bind-all addresses, not connect targets — Windows rejects
    // connecting to them (WSAEADDRNOTAVAIL). Dial loopback instead so the probe
    // reflects reachability rather than a platform quirk.
    const dial = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    return { host: dial, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) }
  } catch { return null }
}

// PATH 里找可执行文件(同步、零依赖;doctor 与控制台都调,不能起子进程)
function whichSync(name) {
  if (!name) return null
  const runnable = (p) => {
    try {
      if (!fs.statSync(p).isFile()) return null
      fs.accessSync(p, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
      return p
    } catch { return null }
  }
  if (name.includes('/') || name.includes('\\')) return runnable(name)
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) { const p = runnable(path.join(dir, name + ext)); if (p) return p }
  }
  return null
}

// Minimal zero-dep TCP reachability probe with a short timeout. Success just means
// the router is listening — we don't validate the translation, only that it's up, so
// doctor fails fast (NFR2) instead of the provider hanging mid-turn when it's down.
function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let done = false
    const finish = (ok, error) => { if (done) return; done = true; try { sock.destroy() } catch {} resolve({ ok, error }) }
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => finish(true))
    sock.on('timeout', () => finish(false, 'timeout'))
    sock.on('error', (e) => finish(false, e.code || e.message))
  })
}

async function checkHealth(cfg, opts = {}) {
  const rows = []
  const add = (status, label, detail) => rows.push({ status, label, detail })

  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22
  add(nodeOk ? 'ok' : 'warn', 'node', process.version + (nodeOk ? '' : ' (need ≥ 22)'))
  // 配置里有密钥:组 / 其他人能读就提醒(Windows 没有这套权限位,不查)
  let cfgStatus = cfg._path ? 'ok' : 'warn'
  let cfgDetail = cfg._path || '(built-in defaults — run setup)'
  if (cfg._path && process.platform !== 'win32') {
    try {
      const m = fs.statSync(cfg._path).mode & 0o777
      if (m & 0o077) { cfgStatus = 'warn'; cfgDetail += `(权限 ${m.toString(8)}:里面有密钥,建议 chmod 600)` }
    } catch { /* 读不到就不评 */ }
  }
  add(cfgStatus, 'config', cfgDetail)

  const v = await probeVersion(cfg.agent.bin)
  add(v.ok ? 'ok' : 'fail', 'claude', v.ok ? v.version : v.error)
  // 长会话自动压缩:老 CLI 不认 `--autocompact`,spawn 侧会自动不传(否则每轮必崩)。
  // ⚠ 但**降级必须看得见** —— 不说的话症状是「会话越长越糊」,没人会想到是 CLI 版本(教训 26)。
  // 阈值为 0 = operator 主动关掉,不必报。
  if (v.ok && (cfg.agent.autocompactTokens || 0) > 0) {
    const sup = await supportsFlag(cfg.agent.bin, '--autocompact')
    add(sup === true ? 'ok' : 'warn', 'agent.autocompact',
      sup === true ? `可用(阈值 ${cfg.agent.autocompactTokens})`
        : sup === false ? '⚠ 该 claude 版本不认 --autocompact ⇒ 长会话自动压缩已停用,升级 claude 恢复'
          : '⚠ 能力探测失败(--help 没跑通)⇒ 保守起见不传该旗子,长会话不会自动压缩')
  }
  add(cfg.agent.permissionMode === 'dontAsk' ? 'ok' : 'warn', 'permissionMode',
    cfg.agent.permissionMode + (cfg.agent.permissionMode === 'dontAsk' ? '' : ' (recommend dontAsk)'))

  if (cfg.proxy && cfg.proxy.http) add('ok', 'proxy', cfg.proxy.http)

  // 常驻浏览器(docs/BROWSER.md):群 agent 的网页操作与控制台「接管浏览器」页都靠它。探到就报 ok;探不到时只有
  // 显式配了 browser 段才 warn —— 没配又探不到,多半是这台机器本来就没有常驻浏览器(Windows 常见),不出行不吓人。
  {
    const cdp = require('./cdp'); const cdpUrl = String((cfg.browser || {}).cdpUrl || cdp.DEFAULT_CDP_URL).replace(/\/+$/, '')
    let v = null; try { v = await cdp.versionInfo(cdpUrl, { timeoutMs: 1000 }) } catch { v = null } // 本机端口,1 秒探不到就当没有,别拖慢 doctor
    if (v) add('ok', 'browser', `${(v && v.Browser) || '已连上'} · ${cdpUrl} · 接管页可用`)
    else if (cfg.browser) add('warn', 'browser', `浏览器没连上(${cdpUrl}):群里的网页操作与「接管浏览器」页都用不了 —— 先把常驻浏览器起来`)
  }

  // 遗留进程(src/leftover.js,v0.11.108):agent 轮次结束后仍活着的后台 shell。它们零 CPU、不报错、
  // 不在任何日志里 —— 2026-10-09 翻出一条每 5 秒打线上云函数、跑了 35 天的循环,正是因为没有一处看得见。
  // 有就 warn(列最老的几条),没有 ok,Windows 不支持就一行不占。opts.leftover 仅测试注入。
  try {
    const lf = await (opts.leftover || (() => leftover.cachedList()))()
    const d = leftover.describe(lf)
    if (d) add(d.status, 'leftover', d.text)
  } catch {}

  // 图标库(docs/ICONS.md):几个包合计几十 MB,不随 sbot 分发 ⇒ 机器上单独装。
  // ⚠ **没装不是 fail** —— 教训 6:这类策略对半可信 agent 本质不可强制,硬拦只会挡住正当情况;
  // 真防线是「正路存在 + 如实可见」。所以没装记 warn 并给装法,agent 会退回自创 path。
  // ⚠ **判据是「缺了几个」不是「有没有一个」**:原先只要装了 lucide 就报 ok —— 而一个选了
  //   phosphor 却没装该包的项目会 doctor 全绿、控制台却挂着「库未安装」,**两个消费者两套口径**。
  //   装法也要列**全部缺的包**,不能停在最早那两个(每加一套系统这行都得跟着长)。
  {
    const design = require('./design')
    const roots = design.iconRoots({ base: require('node:path').join(__dirname, '..'), extra: (cfg.design && cfg.design.iconsDir) || null })
    const has = Object.entries(roots).filter(([, v]) => v).map(([k]) => k)
    const miss = Object.entries(roots).filter(([, v]) => !v).map(([k]) => k)
    const pkgs = miss.map((k) => (design.ICON_LIBS[k] || {}).pkg).filter(Boolean).join(' ')
    add(miss.length ? 'warn' : 'ok', 'design.icons',
      miss.length
        ? `缺 ${miss.join(' / ')}${has.length ? `(已装 ${has.join(' + ')})` : ''} — \`npm i -g ${pkgs}\`;选了缺的那套时取不到图标,agent 只能自己画,与设计图对不上`
        : has.join(' + ') + ' 已装(`sbot design icon` 可用)')
  }

  // 运维告警群(alerts.chatId):模型账号异常 / 额度用完 / 自动切换发到这里。没配不算错,但要说清后果 ——
  // 账号类异常此前只在出事的群里说一句,operator 不在那个群就一无所知(09-25 OAuth 过期 10 小时无人知)。
  {
    const a = cfg.alerts && cfg.alerts.chatId != null ? String(cfg.alerts.chatId).trim() : ''
    if (!a) add('ok', 'alerts', '未配运维告警群(可选)— 模型账号异常 / 额度用完只会在出事的群里说')
    else if (cfg.groups && cfg.groups[a]) add('warn', 'alerts', '运维告警群同时绑定了项目 — 它应保持未绑定,否则助手会在里面干活、告警被对话淹掉')
    else add('ok', 'alerts', '运维告警群已配 — 模型账号异常 / 额度用完 / 自动切换 / 平台连接中断会通知到那里' + (require('./config').chatPlatform(cfg, a) === 'wecom' ? '(企业微信群:要先在群里 @ 过机器人,否则推不进去)' : ''))
  }

  // codex 登录态:`codex login status` 只读本机状态(已登录退出码 0)。provider 行和指向 codex 的备用模型行
  // 共用一次探测;opts.codexLogin 仅测试注入。
  let codexLoginP = null
  const codexLogin = () => codexLoginP || (codexLoginP = (opts.codexLogin || (() => codexstatus.cachedLoginStatus('codex')))().catch(() => null))
  const codexLoggedOut = async () => { const s = await codexLogin(); return !!(s && s.ok && s.loggedIn === false) }

  // 有没有人在用:默认模型、有群选它、或是谁的备用。没人用的模型出了问题只提醒不报错
  // (只用 DeepSeek 的新手,配置里留着别的预设,不该让体检一上来就是红的)
  const inUse = (name) => name === cfg.defaultProvider
    || Object.values(cfg.groups || {}).some((g) => g && g.provider === name)
    || Object.values(cfg.providers).some((q) => q && !q.hidden && q.fallback === name)
  const verifyFile = opts.verifyFile || (opts.home ? path.join(opts.home, '.sbot', 'verify.json') : undefined)
  const lookup = (fp) => verify.lookup(fp, verifyFile ? { file: verifyFile } : undefined)
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (p.hidden) continue  // operator 主动撤下 — 不进健康检查(与 UI 隐藏一致)
    // 额度自动切换的备用模型(v0.11.107):写错名字 / 指到隐藏的 / 指到自己,运行时只是静默不切 —— 这里把它说出来
    if (p.fallback != null) {
      const to = String(p.fallback).trim()
      const t = cfg.providers[to]
      if (!to || to === name) add('warn', `fallback:${name}`, `备用模型不能是自己或空(${JSON.stringify(p.fallback)})`)
      else if (!t) add('warn', `fallback:${name}`, `备用模型「${to}」不存在 — 额度用完时不会自动切换`)
      else if (t.hidden) add('warn', `fallback:${name}`, `备用模型「${to}」已隐藏 — 额度用完时不会自动切换`)
      else if (t.runner === 'codex' && await codexLoggedOut()) add('warn', `fallback:${name}`, `备用模型「${to}」的 codex 没登录 — 额度用完时切不过去;跑一次 codex login`)
      else add('ok', `fallback:${name}`, `额度用完 / 账号不可用时自动切到 ${to}`)
    }
    if (p.baseUrl) {
      // 配了 key 不等于能用:看最近一次验证(向导试跑、控制台测试、真实轮次都会记;换了 key 就回到「未验证」)
      const v = p.apiKey ? lookup(verify.providerFp(p)) : null
      if (!p.apiKey) add('warn', `provider:${name}`, '没配 apiKey')
      else if (v && v.ok) add('ok', `provider:${name}`, `能用(${verify.when(v.at)} 验证通过)`)
      else if (v) add(inUse(name) ? 'fail' : 'warn', `provider:${name}`, `上次验证失败(${verify.when(v.at)}):${v.reason || 'key 不对'}`)
      else add('warn', `provider:${name}`, `已配 key,还没验证 — 控制台「模型」页点测试,或 sintbot agent run --provider ${name} "你好"`)
      // Router-backed provider (loopback base = local translation router for GPT/非-Anthropic):
      // probe it so doctor reports the router being down, rather than the turn hanging (NFR2).
      const lb = loopbackTarget(p.baseUrl)
      if (lb) {
        const r = await probeTcp(lb.host, lb.port)
        add(r.ok ? 'ok' : 'fail', `router:${name}`,
          r.ok ? `在线 ${lb.host}:${lb.port}` : `连不上 ${lb.host}:${lb.port} — 先把翻译代理起来,否则这个模型的轮次会立刻失败`)
      }
    } else if (p.runner === 'codex') {
      // codex provider 无 baseUrl/apiKey —— 认证是机器上 `codex login` 的 ChatGPT 订阅,跟 Claude 登录态无关。
      // 探不出来(没装 / 超时)才标「未验证」;没装由下面的 codex 行报。
      const s = await codexLogin()
      if (s && s.ok && s.loggedIn) add('ok', `provider:${name}`, s.mode === 'apikey' ? 'codex 已登录(API key,按量计费)' : 'codex 订阅已登录')
      else if (s && s.ok) add('warn', `provider:${name}`, '没登录 — 在这台机器上跑 codex login(没图形界面用 codex login --device-auth)')
      else add('ok', `provider:${name}`, 'codex 订阅登录(未验证)')
    } else {
      // 无 baseUrl 的非 codex provider = **Claude 订阅登录**(不填端点/key 就是它的正确形态)。
      // 此前这里只能写死「登录态(未验证)」—— 真没登录也照样绿,要到群里跑一轮才炸。
      // `claude auth status --json` 是官方非交互子命令(0.2s、不吃订阅额度),据此报真状态。
      // 只有 provider 真在用(未隐藏)才探:比如 claude 标了 hidden 的部署,上面已 continue,零噪音。
      // 没登录但没人用(不是默认、没有群选它、也不是谁的备用)⇒ 只提醒不报错:只用 DeepSeek 等 API key 模型的
      // 新手,配置里留着这一行,不该让体检一上来就是红的。opts.claudeLogin 仅测试注入。
      const s = await (opts.claudeLogin ? opts.claudeLogin() : claudestatus.cachedLoginStatus(cfg.agent.bin))
      const d = claudestatus.describeLogin(s)
      if (d.level === 'fail' && !inUse(name)) add('warn', `provider:${name}`, '未登录 — 目前没有群在用;要用 Claude 订阅时在这台机器上跑 claude auth login')
      else add(d.level, `provider:${name}`, d.text)
    }
  }

  // Codex CLI backend (GPT): only probed when a provider actually uses it, so users
  // without a codex provider don't see a spurious row. Verifies the binary; login is
  // reported on the provider row above.
  const hasCodex = Object.values(cfg.providers).some((p) => p && !p.hidden && p.runner === 'codex')
  if (hasCodex) {
    const cv = await codex.probeVersion()
    add(cv.ok ? 'ok' : 'fail', 'codex', cv.ok ? cv.version : cv.error)
  }

  // 常驻浏览器(chrome-devtools 类 MCP 的 --browserUrl):机器级 MCP 配置里指了就探活 ——
  // 浏览器实例没起时,agent 要到轮中调工具才失败,doctor 先报(NFR2 同款思路,与 router 行
  // 一致)。没配置则一行不加;两侧(claude/codex)常指同一实例,按 url 去重、来源合并展示。
  // opts.home 仅测试注入 —— 生产读真实 home 下的 ~/.claude.json 与 ~/.codex/config.toml。
  try {
    const byUrl = new Map()
    for (const t of require('./plugins').browserTargets(opts.home)) {
      const e = byUrl.get(t.url) || { name: t.name, sources: [] }
      if (!e.sources.includes(t.source)) e.sources.push(t.source)
      byUrl.set(t.url, e)
    }
    for (const [url, e] of byUrl) {
      let host = null, port = null
      try {
        const u = new URL(url)
        host = u.hostname === '0.0.0.0' || u.hostname === '::' ? '127.0.0.1' : u.hostname
        port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
      } catch {}
      if (!host) { add('warn', `browser:${e.name}`, `无法解析 --browserUrl:${url}`); continue }
      const r = await probeTcp(host, port)
      add(r.ok ? 'ok' : 'fail', `browser:${e.name}`,
        r.ok ? `up ${host}:${port}(${e.sources.join('+')})` : `DOWN ${host}:${port} — MCP 指向的常驻浏览器不可达,浏览器工具会失败(确认该 Chrome 实例在运行)`)
    }
  } catch {}

  // MCP 可达性(2026-09-05):群里勾选的 MCP 连不上时,**每一轮 spawn 都要替它付一次启动失败**
  // (实测一个没起的本地 http MCP:22 个流文件 129 处 transport 致命错,每次重试若干轮才放弃),
  // 而此前 doctor / 控制台 / 群里没有任何一处说过它连不上 —— 勾选框看着一切正常。
  // ⚠ **连不上是 warn 不是 fail**:库里躺着的多半是 operator 别的项目才起的服务,没起是常态,
  //   不该让整机体检变红(真正要报的是「它被某个群勾着、正在每轮烧钱」,故顺带报勾选它的群数)。
  // ⚠ unknown(公网直连没通)也只 warn 且措辞不同 —— daemon 直连不走代理,失败不代表 agent 用不了。
  // opts.home 仅测试注入。
  try {
    const groups = Object.entries(cfg.groups || {}).filter(([id, g]) => g && id !== 'oc_example_chat_id').map(([, g]) => g)
    const enabledBy = (name) => groups.filter((g) => g.plugins && Array.isArray(g.plugins.mcp) && g.plugins.mcp.includes(name)).length
    // ⚠ 没配过插件的群是「默认加载」:claude 自己读用户级全部 MCP,**不经过跳过机制**(claudecode.js 只对配了
    //   plugins 的群走 buildMcpConfig)。它们才是每轮真在替死 MCP 付启动失败的那批 —— 对它们说「会跳过」是假话,
    //   得分开说清。codex 群不读这份库,不算在内。
    const isCodexGroup = (g) => { const p = (cfg.providers || {})[g.provider || cfg.defaultProvider]; return !!(p && p.runner === 'codex') }
    const defaultLoaders = groups.filter((g) => !g.plugins && !isCodexGroup(g)).length
    // opts.mcpProbe 仅测试注入探针(生产走默认的 TCP / 可执行文件探针)
    for (const r of await require('./plugins').mcpReachability(opts.home, opts.mcpProbe || {})) {
      if (r.status === 'unprobed') continue // 判不了的形态不占行(相对路径 / 非 http 端点)
      const n = enabledBy(r.name)
      const used = n ? `${n} 个群勾着它` : '当前没有群勾选'
      const dl = defaultLoaders ? `;另有 ${defaultLoaders} 个群没配过插件、按默认加载全部 —— 这些群不会跳过,每轮都替它付一次启动失败,要跳过就在群卡保存一次勾选` : ''
      add(r.status === 'ok' ? 'ok' : 'warn', `mcp:${r.name}`,
        r.status === 'ok' ? r.detail
          : r.status === 'down' ? `⚠ ${r.detail} — ${used};勾了它的群会跳过注入(否则每轮白付一次启动失败),服务起来后自动恢复${dl}`
            : `⚠ 无法确认可达:${r.detail} — ${used};仍会照常注入(本机直连不走代理,探不通不等于不可用)`)
    }
  } catch {}

  // 平台(双平台并存):配了哪个就报哪个 —— feishu 块 / wecom 块各按自己的配齐程度出 ok / fail;两个都没配只 warn
  // 一行(doctor 在开发机上也跑,没配平台是常态,只影响 `sbot start`)。顶层 platform 字段已废弃:写着就提一句。
  const { platformsConfigured, PLATFORMS } = require('./config')
  const plat = platformsConfigured(cfg)
  const PLN = { feishu: '飞书', wecom: '企业微信', slack: 'Slack' } // doctor 是 CLI 输出,平台中文名就写在这
  const livePlats = PLATFORMS.filter((p) => plat[p])
  if (cfg._deprecatedPlatform !== undefined) add('warn', 'platform', '顶层 platform 字段已废弃、被忽略 — 现在配了哪个平台就接哪个,每个群自己带 platform 字段;删掉这行即可')
  if (cfg.feishu) {
    const hasId = !!cfg.feishu.appId, hasSecret = !!cfg.feishu.appSecret
    if (hasId && hasSecret) {
      // 凭据能不能用看最近一次预检(向导、控制台、doctor 现场都会记;换了凭据就回到「未预检」)
      const v = lookup(verify.feishuFp(cfg.feishu))
      if (v && !v.ok) add('fail', 'feishu', `上次预检失败(${verify.when(v.at)}):${v.reason}`)
      else add('ok', 'feishu', v ? `飞书应用能用(${verify.when(v.at)} 预检通过)` : '飞书应用已配(appId + appSecret),还没预检')
      if (!cfg.feishu.botOpenId) add('warn', 'feishu.botOpenId', (cfg.feishu.onlyWhenMentioned
        ? '没填 — 开着「只在 @ 时回复」却认不出哪个 @ 是机器人,群里一条都不会回'
        : '没填 — 分不清 @机器人 和 @别人,群里 @ 别人的消息也会接') + ';重跑 sintbot setup 选飞书预检可自动填')
    } else if (!hasId && !hasSecret) { if (!plat.wecom && !plat.slack) add('warn', 'platforms', '还没接聊天平台 — 在控制台「设置」里接飞书 / Slack / 企业微信') }
    else add('fail', 'feishu', hasId ? '缺 appSecret' : '缺 appId')
  } else if (!plat.wecom && !plat.slack) {
    add('warn', 'platforms', '还没接聊天平台 — 在控制台「设置」里接飞书 / Slack / 企业微信')
  }
  // 写了 wecom 块就要报:env: 引用解析成空串也算缺(真机踩到 —— 非交互 shell 没 source 凭据文件,doctor 一声不吭地把群报成「没配企微」)
  if (cfg.wecom) {
    const w = cfg.wecom
    if (plat.wecom) add('ok', 'wecom', '企业微信机器人已配(长连接,免公网)' + (w.botName ? ` · ${w.botName}` : ''))
    else add('fail', 'wecom', (w.botId ? '缺 wecom.secret' : w.secret ? '缺 wecom.botId' : '缺 wecom.botId 与 secret') + '(env: 引用的环境变量为空也算缺)')
    // 官方命令行工具:发送者姓名、群内发图发文件都靠它;没装只降级(群里显示账号而非姓名、助手发不了图)
    if (w.cli === false) { /* 明确关掉:不搜姓名、基础技能不用,不占行 */ }
    else if (whichSync(w.cli || 'wecom-cli')) add('ok', 'wecom.cli', '企业微信命令行工具已装 — 群里显示成员姓名,助手可发图发文件')
    else add('warn', 'wecom.cli', '企业微信命令行工具未装 — 群里只显示成员账号、助手不能发图发文件、「不 @ 也回复」不生效(装好后按机器人凭据授权一次即可)')
    // 「不 @ 也回复」:轮询群历史(零 token)+ 规则门控;只报口径,让 operator 知道现在是哪一档
    if (plat.wecom && w.cli !== false) {
      const ps = w.pollSec === undefined || w.pollSec === null || w.pollSec === '' ? 0 : Number(w.pollSec) // 默认关(10-12 拍板)
      const fs2 = w.followSec === undefined || w.followSec === null || w.followSec === '' ? 300 : Number(w.followSec)
      add('ok', 'wecom.poll', ps > 0 ? `「不 @ 也回复」开:每 ${ps}s 看一次群历史;${fs2 > 0 ? `被 @ / 回复后 ${fs2}s 内的消息不 @ 也答,点名的随时答` : '⚠ 没设跟进窗口 —— 群里每一句都会喂模型,很烧额度'}` : '「不 @ 也回复」关(默认)— 群里 @ 机器人才答;开了要轮询群历史,官方使用规则对自动抓取有限制、大企业未开放')
      // 第二道门:便宜模型门控。配了就要能用 —— 指的模型得有 baseUrl + apiKey(订阅登录 / codex 都不行),否则等于没配,必须出声
      const gk = w.gatekeeper
      if (ps > 0 && gk) {
        const { askableProvider } = require('./agent/askonce')
        const name = typeof gk === 'string' ? gk : (gk && gk.provider) || ''
        const why = askableProvider((cfg.providers || {})[name], name, { model: gk && gk.model })
        if (why) add('warn', 'wecom.gate', `便宜模型门控没生效:${why} —— 规则判不了的消息现在一律不答`)
        else add('ok', 'wecom.gate', `便宜模型门控:${name}${gk && gk.model ? `(${gk.model})` : ''} — 没点名、也不在跟进窗口里的消息先问它要不要答,说要才喂真正的模型`)
      }
    }
  }
  // Slack 块:写了就报,与企微同口径(env: 引用解析成空串也算缺)
  if (cfg.slack) {
    const sl = cfg.slack
    const v = plat.slack ? lookup(verify.slackFp(sl)) : null
    if (v && !v.ok) add('fail', 'slack', `上次预检失败(${verify.when(v.at)}):${v.reason}`)
    else if (plat.slack) add('ok', 'slack', (v ? `Slack 应用能用(${verify.when(v.at)} 预检通过)` : 'Slack 应用已配(Socket Mode 长连接,免公网),还没预检') + (sl.identity && sl.identity.botName ? ` · ${sl.identity.botName}` : ''))
    else add('fail', 'slack', (sl.botToken ? '缺 slack.appToken' : sl.appToken ? '缺 slack.botToken' : '缺 slack.botToken 与 appToken') + '(env: 引用的环境变量为空也算缺)')
  }
  // 群级 platform:没写的已在 loadConfig 里按 id 形态推断(内存态),这里如实报推断了几个、哪些判不出(两个平台都配
  // 且 id 认不出形态 ⇒ 运行时按飞书走,这多半是错的,warn 让人补字段);标成某平台却没配那个平台的群收不到消息 ⇒ warn。
  const gp = cfg._groupPlatform || { inferred: [], ambiguous: [], invalid: [] }
  const tail = (ids) => ids.map((id) => '…' + id.slice(-8)).join(' · ')
  if (gp.invalid.length) add('warn', 'groups.platform', `${gp.invalid.length} 个群的 platform 写了认不得的值(只认 ${PLATFORMS.join(' / ')}),已当没写处理:${tail(gp.invalid)}`)
  if (gp.ambiguous.length) add('warn', 'groups.platform', `${gp.ambiguous.length} 个群判不出属于${livePlats.map((p) => PLN[p]).join('还是')}(暂按飞书):${tail(gp.ambiguous)} — 在控制台重新保存该群,或在配置里给它写 platform`)
  else if (gp.inferred.length && livePlats.length > 1) add('ok', 'groups.platform', `${gp.inferred.length} 个群没写 platform,已按群 id 形态推断;控制台重新保存该群时会自动补上`)

  const groups = Object.entries(cfg.groups || {})
  // 项目根目录(控制台绑群 / 目录浏览 / 风格提炼三处共用的围栏,src/projectsroot.js)。
  // 配了却被忽略的条目必须报 —— 否则人以为围栏按他写的在跑;配置里指定的根不存在是 fail,
  // 默认根不存在只是还没用过(首次在控制台浏览时自动建),warn 即可。
  const pr = (cfg._projectsRoots && Array.isArray(cfg._projectsRoots.roots)) ? cfg._projectsRoots : projectsroot.resolveProjectsRoots(cfg)
  for (const d of pr.dropped || []) add('warn', 'projectsRoots', `已忽略 ${d.value}(${d.why})`)
  const missingRoots = pr.roots.filter((r) => !fs.existsSync(r))
  if (!missingRoots.length) add('ok', 'projectsRoots', pr.roots.join(' · '))
  else add(pr.fromConfig ? 'fail' : 'warn', 'projectsRoots', `不存在: ${missingRoots.join(' · ')}` + (pr.fromConfig ? '' : '(默认根,首次在控制台浏览时自动创建)'))

  if (!groups.length) add('warn', 'groups', '还没绑定群 — 在控制台「群 · 项目」页绑定,或重跑 sintbot setup')
  for (const [chatId, g] of groups) {
    const placeholder = chatId === 'oc_example_chat_id' || (g.workdir && g.workdir.startsWith('/abs/path/to'))
    const exists = g.workdir && fs.existsSync(g.workdir)
    if (placeholder) add('warn', `group:…${chatId.slice(-8)}`, '示例占位,不是真的群 — 换成真实群 ID 与项目目录,或删掉')
    // 标成某平台却没配那个平台:这个群一条消息都收不到,比目录越界更要紧,先报;一个平台都没配(开发机)时不报 —— 否则盖掉 workdir MISSING 的 fail
    else if (g.platform && plat[g.platform] === false && livePlats.length) add('warn', `group:…${chatId.slice(-8)}`, `${g.workdir}(标为${PLN[g.platform] || g.platform}群,但没配${{ feishu: '飞书应用', wecom: '企业微信机器人', slack: 'Slack 应用' }[g.platform] || g.platform} — 这个群收不到消息)`)
    // 越界的既有绑定照常运行(配置文件是 operator 手写的,fail-open),但要出声:控制台不会再允许新的这类绑定
    else if (exists && !projectsroot.withinRoots(g.workdir, pr.roots)) add('warn', `group:…${chatId.slice(-8)}`, `${g.workdir}(在项目根目录之外;控制台不再允许新的这类绑定)`)
    else add(exists ? 'ok' : 'fail', `group:…${chatId.slice(-8)}`, exists ? g.workdir : `项目目录不存在: ${g.workdir}`)
  }

  const fails = rows.filter((r) => r.status === 'fail').length
  const warns = rows.filter((r) => r.status === 'warn').length
  return { rows, fails, warns }
}

module.exports = { checkHealth, whichSync }
