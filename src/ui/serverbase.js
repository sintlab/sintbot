// sbot console — a local control panel served by Node's http(除「接管浏览器」经 src/cdp.js 用 `ws` 连 CDP 外零依赖).
// Binds to 127.0.0.1 only; REST for actions, SSE for live push. Reads/writes the
// same config file the CLI uses (raw form, so `env:VAR` refs survive), redacts
// secrets on the way out. Shares health.js / feishu helpers with the CLI so the
// two stay in sync.

const http = require('node:http')
const { followupEnabled } = require('../agent/privatecore')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadConfig, migrateModelSettings, applyProxyEnv, deriveNoProxy, DEFAULTS, resolveSecret } = require('../config')
const verify = require('../core/verify') // 凭据最近一次验证的记录:模型测试 / 平台预检写,概览读
const projectsroot = require('../projectsroot') // 项目根目录围栏:目录浏览 / 保存绑定 / 风格提炼三处同一份判据
const { atomicWriteJSON } = require('../core/store')
const { createLedger } = require('../core/ledger')
const { normalizeTz, isValidTz, tzOffsetMin, tzParts } = require('../core/time')
// Runner dispatch (Claude vs Codex by provider.runner) — so 测试/试跑 run codex
// providers on the Codex CLI, not Claude. Same module the daemon/CLI use.
const { runTurn, probeVersion, isClosedRunnerResult, isClosedRunnerError } = require('../agent/runner')
const codexstatus = require('../agent/codexstatus') // codex 订阅登录态 + 用量(卡片「验证登录」)
const { codexCatalogWindows, windowForProvider } = require('../agent/modelwindows')
const claudestatus = require('../agent/claudestatus') // Claude 订阅登录态(卡片「检测登录」· doctor 同源)
const claudemodels = require('../agent/claudemodels') // Claude 模型候选(仅登录后给)
const claudeusage = require('../agent/claudeusage') // Claude 订阅额度(oauth/usage,cc-hud 同源;v0.11.3)
const codexAgent = require('../agent/codexcode') // codex --version 探针(概览健康,仅配了 codex provider 时)
const { globalPlugins, codexPlugins, projectPlugins, mcpReachability } = require('../plugins')
const gitrepo = require('../gitrepo') // 群项目 ↔ git 远端关联(「仓库地址」:init + origin,幂等)+ ls-remote 连通性探测
const design = require('../design') // 设计风格档:风格库(内置预设 + 自定义)与各群当前风格档的可视化卡片
const preview = require('../preview') // 群预览服务:运行中的预览要在概览里看得见、能一键停(那个挂了一周的服务就是因为没人看得见)
const { createIssues, summarize, fingerprint } = require('../core/issues') // 群内反馈本:同理 —— 只躺在文件里没人看,和消失没区别
const leftover = require('../leftover') // 遗留进程:对话轮次结束后仍在跑的后台 shell —— 同一条道理,那条每 5 秒打线上接口的循环跑了 35 天就是因为没处看见
const { withFileLock } = require('../core/store') // 反馈本改状态要与 CLI/群命令共用同一把跨进程锁
const { redact } = require('../core/redact') // 出站脱敏:预览停止通知里含 agent 提供的 label
const { hashPassword, verifyPassword } = require('./auth')
const feishulogin = require('./feishulogin') // 控制台「用飞书登录」:OAuth 授权码流程的纯逻辑(公网入口;只放行管理员名单)
const { createSessionStore } = require('./sessions') // 登录会话落盘 + 30 天过期(守护进程重启不再把人登出)
const { listWecomSessions, wecomAuthShow } = require('../platform/wecom')
const { createWecomCli } = require('../platform/wecomcli')
const { guessBotName } = require('../platform/wecomname') // 机器人名从群历史的 @ 里统计(企微没有取机器人信息的接口) // 企业微信:群候选 = 机器人被 @ 过的群(控制台「绑定群」用)
const { platformsConfigured, chatPlatform, inferChatPlatform, PLATFORMS } = require('../config') // 双平台并存:哪些平台配齐了 · 某群属于哪个平台(与 daemon 路由器同一个函数)
const { feishuClient, fetchBotOpenId, fetchAppIdentity, fetchChats, createChat, fetchChatMembers, addChatMembers, deleteChat, sendChatText, larkErrMsg, feishuPrecheck, fetchAdminCandidates, resolveContactToOpenId, fetchOrgUsers } = require('../platform/feishu')
const { slackPrecheck, fetchSlackChannels, sendSlackText } = require('../platform/slack') // Slack:控制台侧只用这三个助手(收发在 daemon 里)
const { getUsage, refreshUsage } = require('../usage')

// 反馈本默认落点(与 CLI / 群命令同一个文件 —— 三个入口一本账,不许各记各的)
const DEFAULT_ISSUES_FILE = () => path.join(os.homedir(), '.sbot', 'issues.jsonl')
// 登录会话落点(与反馈本同目录;注入式只为可测)
const DEFAULT_SESSIONS_FILE = () => path.join(os.homedir(), '.sbot', 'ui-sessions.json')

const CONSOLE_HTML = path.join(__dirname, 'console.html')
const LIVE_ACTIVITY_JS = fs.readFileSync(path.join(__dirname, 'liveactivity-client.js'), 'utf8')
const BROWSER_HTML = path.join(__dirname, 'browser.html') // 接管浏览器页(自包含单文件,群成员凭一次性链接也能进)
const takeover = require('./takeover') // 接管链接的票据与 cookie(纯逻辑)
const dashboard = require('./dashboard') // 「需要你处理」收件箱 + 活动流的账本回填(纯逻辑)
const { createBrowserRoutes } = require('./browserroutes') // /api/browser/* 的实现;这里只裁决谁能进
const PKG_VERSION = (() => { try { return 'v' + require('../../package.json').version } catch { return '' } })() // 顶栏版本徽章
let changelogCache = null // 随包分发的版本历史,进程内读一次
const readChangelog = () => {
  if (changelogCache) return changelogCache
  try { changelogCache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.json'), 'utf8')) } catch { changelogCache = [] }
  return Array.isArray(changelogCache) ? changelogCache : (changelogCache = [])
}
// 版本历史的英文本(CHANGELOG.en.json,按 version 与中文条目对应,可以缺版本 —— 缺了页面回退中文)。
// 没这个文件 / 文件坏了都当「一条英文都没有」,整卡照旧出中文,不是错误。
let changelogEnCache = null
const readChangelogEn = () => {
  if (changelogEnCache) return changelogEnCache
  try { changelogEnCache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.en.json'), 'utf8')) } catch { changelogEnCache = [] }
  return Array.isArray(changelogEnCache) ? changelogEnCache : (changelogEnCache = [])
}
const isEnvRef = (v) => typeof v === 'string' && v.startsWith('env:')
// 目录浏览—— 只在**项目根目录**之内一层层列。围栏判据(哪些根 / realpath 比较)全在
// src/projectsroot.js,与保存绑定、风格提炼、doctor 同一份;这里只管列目录。
// `roots` = 有效根目录数组(字符串也认,单测传单个根)。target 在某个根之内就列它,否则**夹回**:
// 单根 ⇒ 根本身;多根 ⇒ 先出「选一个根」的列表(cwd 为空,rootList=true,前端据此不画新建行)。
// 只列目录;点开头目录与 node_modules 不列(那些不是项目,只是噪音);符号链接不列(Dirent.isDirectory
// 对链接为 false)—— 但手填一个穿过链接的路径同样过不了 realpath 围栏,链接指到根外就夹回。
// createMissing:默认根不存在就建(围栏得有个实在的底);配置里指定的根**不建** —— 挂载盘没挂时把目录
// 建在挂载点上是事故不是帮忙,那种情况 doctor 会报 fail。
function listDirs(target, roots, { createMissing = false } = {}) {
  roots = Array.isArray(roots) ? roots : (roots ? [roots] : [])
  if (!roots.length) throw new Error('项目根目录不可用:配置里的 projectsRoots 没有一条有效')
  let root = null, cwd = null
  if (target) {
    root = projectsroot.withinRoots(target, roots)
    if (root) cwd = path.resolve(target)
  }
  if (!cwd) {
    if (roots.length > 1) return { cwd: '', root: '', roots, items: roots.map((r) => ({ name: r, path: r })), atRoot: true, rootList: true }
    root = roots[0]; cwd = root
  }
  if (createMissing && !fs.existsSync(root)) { try { fs.mkdirSync(root, { recursive: true }) } catch { /* 下面 readdir 把真实错误报出来 */ } }
  let names
  try { names = fs.readdirSync(cwd, { withFileTypes: true }) }
  catch (e) { throw new Error('无法读取目录: ' + cwd + '(' + (e && e.code) + ')') }
  const items = []
  for (const d of names) {
    if (d.name.startsWith('.') || d.name === 'node_modules') continue
    try { if (!d.isDirectory()) continue } catch { continue }
    items.push({ name: d.name, path: path.join(cwd, d.name) })
  }
  items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  const atRoot = projectsroot.norm(projectsroot.realpathLenient(cwd)) === projectsroot.norm(projectsroot.realpathLenient(root))
  return { cwd, items, root, roots, atRoot }
}
// 从目录浏览器新建项目文件夹 —— 同样围在根目录之内。`name` 只能是单段安全名(无分隔符 / 穿越 / 非法字符);
// `parent` 不在任何根内就夹回:单根 ⇒ 根;多根 ⇒ 报错让人先进入某个根(不替他猜建在哪)。返回新目录,浏览器直接进入。
function makeDir(parent, name, roots, { createMissing = false } = {}) {
  roots = Array.isArray(roots) ? roots : (roots ? [roots] : [])
  if (!roots.length) throw new Error('项目根目录不可用:配置里的 projectsRoots 没有一条有效')
  name = String(name || '').trim()
  if (!name) throw new Error('文件夹名必填')
  if (/[\\/]/.test(name) || name === '.' || name === '..' || /[:*?"<>|]/.test(name)) throw new Error('文件夹名含非法字符(不能有 / \\ : * ? " < > |)')
  if (name.startsWith('.')) throw new Error('文件夹名不能以 . 开头(选择器不列这类目录,建了就找不回来)')
  let base = parent && projectsroot.withinRoots(parent, roots) ? path.resolve(parent) : null
  if (!base) {
    if (roots.length > 1) throw new Error('先进入某个项目根目录再新建')
    base = roots[0]
  }
  // 只补建**根本身**(与 listDirs 同口径),不替人把不存在的多级父目录一路建出来
  if (createMissing && projectsroot.norm(base) === projectsroot.norm(roots[0]) && !fs.existsSync(base)) { try { fs.mkdirSync(base, { recursive: true }) } catch { /* 下面 mkdir 把真实错误报出来 */ } }
  const dir = path.join(base, name)
  if (!projectsroot.withinRoots(dir, roots)) throw new Error('超出项目根目录范围')
  if (fs.existsSync(dir)) throw new Error('该文件夹已存在')
  fs.mkdirSync(dir, { recursive: false })
  return { path: dir, parent: base, name }
}
const keyStatus = (k) => (!k ? 'none' : isEnvRef(k) ? 'env' : 'set')
const resolvedKey = (pr) => (pr.apiKey ? (isEnvRef(pr.apiKey) ? (process.env[pr.apiKey.slice(4)] || '') : pr.apiKey) : '')
const isConfigured = (pr) => !pr.baseUrl || !!resolvedKey(pr) // logged-in, or has a resolvable key
// The default provider = the first configured, non-hidden one in list order (so
// "drag to the top" = set default). Falls back to the current one if none fit.
const pickDefault = (providers) => { for (const [n, pr] of Object.entries(providers)) if (!pr.hidden && isConfigured(pr)) return n; return null }
const fixDefault = (raw) => { const d = raw.providers && raw.providers[raw.defaultProvider]; if (!d || d.hidden || !isConfigured(d)) { const n = pickDefault(raw.providers || {}); if (n) raw.defaultProvider = n } }
// Admins (可多个) — the operators auto-invited into console-created groups. Migrates
// the legacy single feishu.adminOpenId/adminName into a one-element list so old
// configs keep working. Returns [{openId, name}].
const adminList = (fe) => {
  if (!fe) return []
  if (Array.isArray(fe.admins)) return fe.admins.filter((a) => a && a.openId).map((a) => ({ openId: a.openId, name: a.name || '' }))
  return fe.adminOpenId ? [{ openId: fe.adminOpenId, name: fe.adminName || '' }] : []
}
// 应用身份 → 落配置的展示缓存。取名短字段是因为它纯给前端渲染;`descState`/`descHint` 保留,
// 缺权限时前端要照实说「描述为什么没有 / 怎么开」,而不是留一片空白让人以为应用没填描述。
const identityCache = (id) => ({
  name: id.appName || '', desc: id.description || '', avatar: id.avatarUrl || '',
  status: id.activateText || '', statusOk: !!id.activateOk,
  descState: id.descState || '', descHint: id.descHint || '', at: Date.now(),
})

// 安装命令的实际执行串。Windows:cmd.exe 与多数 CLI 按 OEM 码页(zh-CN 为 GBK)输出,
// Node exec 默认按 UTF-8 解码 → 中文报错乱码(如"'X' 不是内部或外部命令")。先把会话码页
// 切到 UTF-8(65001)再跑,输出即可正确解码;`>nul` 吞掉 chcp 自身回显。非 Windows 原样。
function execShellCommand(cmd, platform = process.platform) {
  return platform === 'win32' ? `chcp 65001>nul & ${cmd}` : cmd
}

// 飞书 WS 连接健康度 → 概览健康行的状态/文案(watchdog snapshot,见 wswatchdog.js)。
// connected=绿;connecting/reconnecting=黄(自愈中);failed/其它=红。
function connHealthStatus(c) {
  if (!c) return 'warn'
  if (c.state === 'connected') return 'ok'
  if (c.state === 'connecting' || c.state === 'reconnecting') return 'warn'
  return 'fail' // failed / stopped
}
// 连接健康字典 → 概览健康行(一行一个平台)。⚠ 兼容旧形状:单个快照(带 state 字段)按飞书算 —— 单测与旧 daemon 都这么给。
const CONN_LABEL = { feishu: '飞书连接', wecom: '企业微信连接', slack: 'Slack 连接' }
function connHealthRows(conn) {
  if (!conn) return []
  if (typeof conn.state === 'string') return [{ status: connHealthStatus(conn), label: CONN_LABEL.feishu, detail: connHealthDetail(conn) }]
  return Object.entries(conn).filter(([k]) => CONN_LABEL[k]).map(([k, c]) => ({ status: connHealthStatus(c), label: CONN_LABEL[k], detail: connHealthDetail(c) }))
}
function connHealthDetail(c) {
  if (!c) return ''
  const label = { connected: '已连接', connecting: '连接中', reconnecting: '重连中', failed: '连接失败', stopped: '已停止' }[c.state] || c.state
  const bits = [label]
  if (c.reconnects) bits.push(`重连 ${c.reconnects}`)
  if (c.rebuilds) bits.push(`重建 ${c.rebuilds}`) // 看门狗强制重建次数——非零=SDK 曾放弃
  if (c.state !== 'connected' && c.lastError) bits.push(String(c.lastError).slice(0, 60))
  return bits.join(' · ')
}

// 本机非环回 IPv4(局域网访问地址,控制台「本机访问地址」卡用)
function lanIPv4() {
  const out = []
  const ifs = os.networkInterfaces()
  for (const name of Object.keys(ifs)) for (const ni of ifs[name] || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
  return out
}

// control (optional, only in `sbot start --ui`) lets the console drive the live
// daemon: switch a group's model, clear its session, stop its turn — in real time.
// 「配了访问密码吗」在配置读不出来时怎么判(纯函数,可测)。
// ⚠ 只绑环回:退成「没配」—— 让本机还能打开控制台去修坏掉的配置(fail-safe 往能修的方向倒)。
// ⚠ 对外绑定:退成「配了」—— 否则一份写坏的配置会让页面给任何局域网访客注入免密 token(2026-09-07 通读
//   逮到;安全判定读不到信息时必须拒绝而不是放行)。此时本机浏览器仍免密(localBypass 按 TCP 源地址判,
//   与这里无关),LAN 访客会看到登录框、而 /api/login 因读不到密码返回 400 —— 修好配置即恢复。
function authConfiguredFrom(getAuth, loopbackBind) {
  try { return !!getAuth() } catch { return !loopbackBind }
}

// 首次绑定群时发进群的那句。⚠ 这是群消息不是控制台:机器上的绝对路径不能进群(用户面零机器路径,
// 出过同形状的一次违规),只说项目目录名。
// 企微群只收 @ 机器人的消息(平台边界),「直接发消息」对它是错指引 ⇒ 按平台措辞。
// ⚠ 命令前缀按平台传:Slack 把 `/` 开头的输入当成它自己的斜杠命令吃掉(真机验过),写死 `/help`
//   等于第一句话就教错用法。
function bindNoticeText(workdir, platform = 'feishu', cmd = '/help') {
  return `✅ 本群已绑定项目「${path.basename(String(workdir || '')) || '(未命名)'}」\n${platform === 'wecom' ? '@我 派单(只有 @ 我的消息我才收得到)' : '直接发消息或 @我 派单'};${cmd} 查看命令`
}

function createUiServer({ configPath, getLiveState = null, getConnHealth = null, onConfigChange = null, onHostChange = null, control = null, updater = null, host = '127.0.0.1', log = () => {}, issuesPath = null, sessionsPath = null, auditPath = null, ledgerPath = null, inboxDismissPath = null, fetchImpl = null, cdpImpl = null, onTakeoverClaim = null, onTakeoverExpire = null, onTakeoverEnd = null, takeoverNow = null, wecomExec = null, verifyFile = null, setupMode = null, cronRecoveryEnabled = false, runtimePolicy = null, cronTools = null } = {}) {
  // Legacy scheduling rules are injected by its compatibility wrapper only.
  // The durable console cannot acquire those rules through this base module.
  const unsupportedCron = () => { throw new Error('当前控制台未接入定时任务') }
  const { normalizeCron = unsupportedCron, normalizeAt = unsupportedCron,
    describeTask = () => '当前版本未接入', expandAt = unsupportedCron,
    qualifyFuture = unsupportedCron } = cronTools || {}
  // wecomExec:企业微信命令行工具的执行器注入(只为可测;生产走默认 execFile)
  // verifyFile:凭据验证记录的落点注入(只为可测;生产 = ~/.sbot/verify.json)
  const vopts = verifyFile ? { file: verifyFile } : undefined
  const WECOM_NO_API = '企业微信这边机器人没有建群 / 解散 / 拉人的接口 —— 请在企业微信里建群、把机器人加进群并 @ 它一次,然后回到这里选择那个群'
  // 某个群属于哪个平台:**与 daemon 路由器用同一个函数**(config.chatPlatform,在配置文件原文上判:群写了 platform 就认 ·
  // id 形态 · 只配了一个平台就是它),这里只多一步「判不出按飞书」—— 两处各写一份必漂移,所以不重写。
  const chatPlatformOf = (raw, chatId) => chatPlatform(raw, chatId) || 'feishu'
  // 反馈本落点。注入式**只为可测**:单测若写默认路径就会污染本机真实的反馈本(而那本账
  // 是生产数据)。daemon 不传 ⇒ 走默认,与 CLI / 群命令同一个文件。
  const issuesFile = () => issuesPath || DEFAULT_ISSUES_FILE()
  // Localhost binding alone is NOT a security boundary — cross-site POSTs (no-cors
  // text/plain skips preflight) and DNS rebinding both reach 127.0.0.1. Every /api/*
  // request must carry a per-process token (header, or ?token= for EventSource),
  // and every request must present an allowed Host.
  //
  // Two token flavors: `token` is the loopback convenience token, auto-injected into
  // the served page when no password is set. `sessions` holds tokens minted by a
  // successful /api/login — the path used when a password IS set (any LAN exposure
  // requires one; bin fail-closes otherwise). Auth check accepts either.
  const token = crypto.randomBytes(16).toString('hex')
  // 登录签发的会话令牌:落盘 + 30 天过期(此前随进程存亡 ⇒ 每次发版重启都要重输密码)。
  // 注入 sessionsPath 只为可测:单测写默认路径会污染本机真实会话。
  const sessions = createSessionStore({ file: sessionsPath || DEFAULT_SESSIONS_FILE(), log })
  // 「用飞书登录」:一次性 state(防 CSRF)+ fetch 注入(单测用假飞书)+ 就绪判据(三样齐才亮入口)
  const oauthStates = feishulogin.createStateStore()
  const doFetch = fetchImpl || globalThis.fetch
  // 凭证的 env: 引用用 config.js 同一个解析器(CLI 与控制台同源,别各写一份)
  const resolveRef = (v) => resolveSecret(v) || ''
  // 会话与配置对齐:会话活得比进程久,**名单里删掉的人、换过的密码**必须让旧会话立刻失效,否则被删的人最多还能
  // 再用 30 天(对抗审查 🔴)。判据来源 = 配置文件本身;按 mtime 缓存,只有配置真变了才重读一次,不给每个请求加
  // 一次 JSON.parse。配置读坏时不动会话(修好后下一次自然对齐)。
  let sessSyncMtime = -1
  const syncSessionsWithConfig = () => {
    let mt = 0; try { mt = fs.statSync(cfgFile()).mtimeMs } catch { mt = 0 }
    if (mt === sessSyncMtime) return
    sessSyncMtime = mt
    let raw; try { raw = readRaw() } catch { return }
    const admins = adminList(raw.feishu || {}); const authRef = String((raw.ui || {}).auth || '').slice(0, 16)
    const n = sessions.revokeWhere((m) => (m.via === 'feishu' && !feishulogin.adminMatch(admins, m.openId)) || (m.via === 'password' && (!authRef || m.authRef !== authRef)))
    if (n) log(`ui: ${n} 个登录会话因管理员名单或密码变更而失效`)
  }
  const feishuLoginInfo = () => {
    // 配置读坏要出声(v0.11.36/71 的教训):不能吞成「未填公网地址」那种会误导人的缺项
    let raw; try { raw = readRaw() } catch { return { ready: false, why: '配置文件损坏,先修好它', publicUrl: '', redirectUri: '', appId: '', appSecret: '', admins: [] } }
    const fe = raw.feishu || {}; const ui = raw.ui || {}
    const publicUrl = feishulogin.normalizePublicUrl(ui.publicUrl)
    const appId = resolveRef(fe.appId), appSecret = resolveRef(fe.appSecret), admins = adminList(fe)
    const r = feishulogin.feishuLoginReadiness({ publicUrl, appId, appSecret, admins })
    const enabled = ui.publicEnabled !== false // 未出现这个字段的旧配置保持原行为
    return { ready: enabled && r.ready, configured: r.ready, enabled, why: !enabled ? '公网登录已关闭' : r.why,
      publicUrl: publicUrl || '', redirectUri: publicUrl ? feishulogin.redirectUri(publicUrl) : '', appId, appSecret, admins }
  }
  // Host 白名单:环回时只认 loopback(防 DNS-rebinding);对外(--host 非环回)额外放行私网段
  // IPv4(10./192.168./172.16-31./169.254.)。攻击者域名不匹配私网 IP 模式 → rebinding 仍挡住。
  let activeHost = String(host)
  let loopbackBind = /^(127\.0\.0\.1|localhost|::1)$/i.test(activeHost)
  const hostPattern = () => loopbackBind
    ? /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i
    : /^(127\.0\.0\.1|localhost|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2})(:\d+)?$/i
  let HOST_OK = hostPattern()
  const authed = (req, url) => { const t = req.headers['x-sbot-token'] || url.searchParams.get('token'); return (!!t && t === token) || sessions.has(t) }
  // 是否已配访问密码(配了 ⇒ 页面不发 token,走登录)。config 读坏时的裁决见 authConfiguredFrom。
  const authConfigured = () => authConfiguredFrom(() => (readRaw().ui || {}).auth, loopbackBind)
  // 该请求是否来自本机 loopback。remoteAddress 是 TCP 对端真实地址,LAN 访客伪造不了
  // loopback 源 IP(TCP 三次握手挡住源地址欺骗),故可信。
  const isLoopbackReq = (req) => {
    const a = String((req.socket && req.socket.remoteAddress) || '')
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  }

  const cfgFile = () => configPath || path.join(process.cwd(), 'sbot.config.json')
  const readRaw = () => {
    const p = cfgFile()
    if (!fs.existsSync(p)) return {}
    // A corrupted config must SURFACE, never be silently replaced — returning {}
    // here would let the next writeRaw wipe the whole file (FR11.1).
    try { return migrateModelSettings(JSON.parse(fs.readFileSync(p, 'utf8'))) }
    catch (e) { throw new Error(`配置文件损坏(${e.message}),已拒绝读写 — 请先手工修复 ${p}`) }
  }
  const writeRaw = (obj) => {
    // Durable hosts validate synchronously before changing the configuration;
    // their commit hook must never be swallowed as a successful legacy reload.
    if (runtimePolicy) runtimePolicy.validateConfig(obj)
    // A model/project change resets the group session before the file says so.
    if (runtimePolicy && runtimePolicy.beforeWrite) runtimePolicy.beforeWrite(obj)
    atomicWriteJSON(cfgFile(), obj)
    if (runtimePolicy) runtimePolicy.applyConfig(obj)
    else if (onConfigChange) { try { onConfigChange() } catch (e) { log('reload hook error: ' + (e && e.message)) } }
  }
  // 默认模型的兜底。旧守护进程:默认模型隐藏了 / 在本进程看来没配好(如 key 是读不到的 env:X)/
  // 文件里没写(跟随内置的 claude),都改成第一个可用的。持久处理流程里这会把跟随默认模型的群
  // 悄悄换到另一个后端并重置会话(拖一下排序、加一个不相干的模型都会触发)⇒ 那里**只在默认模型
  // 已不存在**(文件和内置都没有这个名字)时补一个,其余一律不动;隐藏默认模型由写入方直接拒绝。
  // 返回 { from, to } = 这次自动改了默认模型(调用方据此如实报告),null = 没改。
  const settleDefault = (raw) => {
    if (!runtimePolicy) { fixDefault(raw); return null }
    const current = raw.defaultProvider || DEFAULTS.defaultProvider
    if ({ ...DEFAULTS.providers, ...(raw.providers || {}) }[current]) return null
    const next = pickDefault(raw.providers || {})
    if (!next || next === raw.defaultProvider) return null
    const from = raw.defaultProvider || null
    raw.defaultProvider = next
    return { from, to: next }
  }
  // 持久处理流程下模型库写入的如实回执:这次写入重置了几个群的会话、默认模型有没有被自动补上。
  const runtimeLibraryChange = (defaultChange) => runtimePolicy ? {
    resetGroups: runtimePolicy.appliedResets ? runtimePolicy.appliedResets().length : 0,
    ...(defaultChange ? { defaultProvider: defaultChange.to } : {}) } : null
  // 群内通知统一出口:暂停群不打扰(暂停语义=完全静默,配置变更通知也不例外 —— 2026-07-22
  // 真机踩过:暂停群仍收到「模型已更新」;operator 在控制台自己改的,群成员恢复后清单会重注入,
  // 静默无损)。唯 force:true 豁免 —— 暂停/恢复动作本身的那条告知必须送达。
  const notifyGroup = (chatId, text, { force } = {}) => {
    if (!control || !control.notifyGroup || !chatId) return
    if (!force) {
      try { const g = (readRaw().groups || {})[chatId]; if (g && g.paused) return } catch { /* 配置读不了则照发,通知不因此丢 */ }
    }
    control.notifyGroup(chatId, text)
  }
  const sseClients = new Set()

  // Recent-activity ring buffer (下一步 ②「活动重同步」): SSE has no replay, so any
  // turn event lost to a browser disconnect / late-open / reload is gone — hence the
  // "打开即空列表 / 卡住 / 缺失" symptoms. The daemon keeps the last N turn events here
  // (upsert by turn id: the 'done' supersedes its 'start'), and the console fetches
  // this via /api/activity on load AND on every SSE (re)connect to fill the gap with
  // the REAL done data (not just the synthetic '✓' self-heal). In-memory only: after a
  // daemon restart it starts empty (no live activity yet anyway; the durable audit
  // trail is the turn ledger, ~/.sbot/turns.jsonl).
  const ACT_MAX = 30 // console shows ≤10, holds 20 — 30 gives margin after a gap
  const activityBuf = [] // raw turn events, oldest→newest, latest-per-id
  const recordActivity = (ev) => {
    if (!ev || !ev.id) return
    const i = activityBuf.findIndex((e) => e.id === ev.id)
    if (i >= 0) activityBuf[i] = ev // same turn: 'done' replaces 'start' in place (keeps order)
    else { activityBuf.push(ev); if (activityBuf.length > ACT_MAX) activityBuf.shift() }
  }
  const recentActivity = () => runtimePolicy ? runtimePolicy.getActivity() : activityBuf.slice().reverse() // newest-first for the console
  // 账本落点注入**只为可测**(同反馈本):单测写默认路径会读到本机真实账本。
  const ledgerFile = () => ledgerPath || path.join(os.homedir(), '.sbot', 'turns.jsonl')
  const ledgerTail = dashboard.createLedgerTail(ledgerFile()) // 按文件大小与修改时刻缓存:账本只在一轮结束时才变
  // 启动即用账本最近的轮次垫底:此前 daemon 一重启(含每次发版)概览的活动流就是空的,
  // 要等下一轮才有东西看。id 与引擎同形,之后真实事件进来只会原地覆盖、不会重复。
  try {
    let groupsRaw = {}
    try { groupsRaw = readRaw().groups || {} } catch {}
    for (const ev of dashboard.ledgerActivity(ledgerTail.rows(), groupsRaw, 20)) recordActivity(ev)
  } catch { /* 回填是锦上添花,读不了就空着 */ }
  const inboxDismiss = dashboard.createDismissStore({ file: inboxDismissPath || path.join(os.homedir(), '.sbot', 'inbox-dismissed.json'), log })
  let lastHealth = null // 最近一次 buildState 的健康检查,给只算收件箱的 /api/inbox 用(那里不重跑探针)
  // 升级排队时还有任务、排队、未结或暂停的群(只给名字,升级弹窗据此说明在等谁)
  const upgradeWaitingGroups = () => {
    let live = null, groupsRaw = {}
    try { live = getLiveState ? getLiveState() : null } catch { return [] }
    try { groupsRaw = readRaw().groups || {} } catch {}
    return Object.entries((live && live.groups) || {})
      .filter(([, g]) => g && (g.busy || g.finalizing || g.waitingForCapacity || g.queue > 0 || g.pending > 0 || g.held))
      .map(([chatId, g]) => ({ name: (groupsRaw[chatId] && groupsRaw[chatId].name) || chatId.slice(-8), held: !!g.held }))
  }
  // 「需要你处理」:从 state 各区取数(反馈本 / 预览 / 残留进程 / 健康)+ 账本 + 接管票,不再各算一遍
  const buildInboxFor = ({ issues, previews, leftovers, health }, raw) => {
    try {
      const update = updater ? { ...updater.status(), announce: !raw || !raw.ui || raw.ui.announceUpdates !== false } : null
      return dashboard.buildInbox({
        ledgerRows: ledgerTail.rows(),
        issues, previews, leftovers, health,
        update,
        takeovers: takeoverStore.pending(),
        groups: (raw && raw.groups) || {},
        dismissed: inboxDismiss.set(),
      })
    } catch (e) { log('inbox: 汇总失败(忽略): ' + (e && e.message)); return [] }
  }

  // Disband hardening: server-enforced two-phase with a one-time
  // token — a bare &confirm=1 must never skip the in-group notice/cool-down.
  // Phase 1 issues {token, readyAt(+30s when other users exist), expiresAt(+10min)};
  // phase 2 must present the token, after readyAt, before expiresAt. Dangerous
  // operations are audited to ~/.sbot/audit.jsonl.
  const disbandPending = new Map() // chatId -> { token, readyAt, expiresAt, users, names }
  let codexStatusCache = null // { at, login, usage } — codex 订阅登录态+额度缓存(供 /api/state 回填 + verify 60s 去抖)
  let claudeStatusCache = null // { at, login } — Claude 订阅登录态(`claude auth status --json`),同上回填
  let codexModelsCache = null // { at, val } — codex model/list 探测缓存(10 分钟)
  // 审计本落点。注入 auditPath 只为可测:单测里的「飞书登录成功」若写进真实审计本,出事时排查者 grep 到的就是假记录。
  const audit = createLedger(auditPath || path.join(os.homedir(), '.sbot', 'audit.jsonl'), log)

  // /api/state runs after every console mutation — cache the version probe so
  // each click doesn't spawn a `claude --version` child.
  let probeCache = null // { val, ts }
  const probeCached = async (bin) => {
    if (probeCache && probeCache.bin === bin && Date.now() - probeCache.ts < 60_000) return probeCache.val
    const val = await probeVersion(bin)
    probeCache = { val, bin, ts: Date.now() }
    return val
  }
  // Same 60s cache for the codex CLI probe — only run when a codex provider exists.
  let codexProbeCache = null
  const probeCodexCached = async () => {
    if (codexProbeCache && Date.now() - codexProbeCache.ts < 60_000) return codexProbeCache.val
    const val = await codexAgent.probeVersion()
    codexProbeCache = { val, ts: Date.now() }
    return val
  }

  // 运行中的群预览服务(`sbot preview`)。**必须在概览里看得见** —— v0.8.1 那个 agent 私装的
  // 静态服务在局域网上挂了一周才被人肉发现,「operator 看不见」正是本技能要治的三个软肋之一。
  // 纯读 ~/.sbot/preview/ 的记录文件(不 spawn、不探网),每个 API 响应都跑得起。
  const previewsState = (raw) => {
    try {
      const t = Date.now()
      // 只列 **running**:'starting' 期间端口还没绑定,列出来等于给一个可能打不开的 URL
      return preview.listRecords(preview.previewDir()).filter((r) => r.status === 'running' && preview.isLive(r)).map((r) => ({
        id: r.id, chatId: r.chatId, name: (raw.groups && raw.groups[r.chatId] && raw.groups[r.chatId].name) || r.chatId,
        label: r.label || r.entry, port: r.port, entry: r.entry,
        serveRoot: preview.displayRoot(r), // 展示用相对路径(与 CLI/doctor 同一份实现)
        single: !!r.single,                 // 只服务 entry 这一个文件(文件形态)
        served: preview.displayServed(r),   // 实际服务到的位置:single ⇒ 到文件,目录 ⇒ 到目录
        projectRoot: !!r.projectRoot, // 服务整个项目目录 ⇒ 前端标风险色
        upMs: t - (r.startedAt || t), lastReqMs: r.lastReqAt ? t - r.lastReqAt : null, reqCount: r.reqCount || 0,
        idleLeftMs: r.idleMs > 0 ? Math.max(0, r.idleMs - (t - (r.lastReqAt || r.startedAt || t))) : null,
        url: preview.buildUrl(r, preview.hostForUrl(r, lanIPv4())),
      }))
    } catch { return [] }
  }

  // 群内反馈本(群里 /issue 提的)。**未处理的必须在概览里看得见** —— 与上面的预览服务
  // 同一条道理:这本账存在的全部意义是「反馈不会不声不响地消失」,而它要是只躺在本机
  // 文件里没人看,和消失没区别。纯读一个小 JSONL(不 spawn、不探网),与 previews 同量级。
  // ⚠ open 封顶 50 条:正常一天几条,封顶是防「这里有一天变成拖垮每个 API 响应的地方」。
  const issuesState = (raw) => {
    try {
      const book = createIssues(issuesFile(), { host: raw.instance || undefined })
      const all = book.list({ all: true })
      const open = all.filter((i) => i.status === 'open').reverse() // 新的在上:反馈按「最近发生什么」读
      const closed = all.filter((i) => i.status === 'closed').reverse()
      const trim = (i) => ({ id: i.id, ts: i.ts, chatId: i.chatId, group: i.group, sender: i.sender, text: i.text, version: i.version, note: i.note, fp: fingerprint(i.turn) })
      return { host: book.host, open: open.slice(0, 50).map(trim), closed: closed.slice(0, 5).map(trim), openCount: open.length, closedCount: closed.length }
    } catch { return { host: '', open: [], closed: [], openCount: 0, closedCount: 0 } }
  }

  // 遗留进程:agent 在对话轮次里用后台方式起的 shell,轮次结束后挂到 pid 1 下继续跑。
  // **必须在概览里看得见** —— 与预览服务 / 反馈本同一条道理:2026-10-09 在生产机翻出一条每 5 秒
  // 打线上云函数的循环,零 CPU、零报警地跑了 35 天。走 30 秒 TTL 缓存(每次 /api/state 都问,ps 一次
  // 几十毫秒,不必每次都跑)。⚠ **不下发完整 command**:它带 shell 快照路径、/tmp 落点等机器布局
  // (零工具名约束),页面只需要 summary(agent 真正写的那条命令)+ 年龄 + pid。
  // supported:false(Windows 没有 ps 也没有这套快照)⇒ rows 为空,前端一个字不出现。
  const leftoversState = async () => {
    try {
      const r = await leftover.cachedList()
      return { supported: !!r.supported, rows: (r.rows || []).map((x) => ({ pid: x.pid, ageSec: x.ageSec, age: x.age, summary: x.summary })), error: r.error || null }
    } catch { return { supported: false, rows: [], error: null } }
  }

  // 只算收件箱(轮次结束、忽略之后控制台来取这一块):不走 buildState —— 那里有 CLI 探针、
  // 逐群读项目插件与设计卡,一轮一次全量太重。健康检查借上一次 buildState 的结果(概览每分钟刷新一次)。
  const inboxOnly = async () => {
    const raw = readRaw()
    return buildInboxFor({ issues: issuesState(raw), previews: previewsState(raw), leftovers: await leftoversState(), health: lastHealth }, raw)
  }

  async function buildState() {
    const cfg = loadConfig(configPath)
    const raw = readRaw()
    // ⚠ 必须与 loadConfig 同一口径:**内置默认 + 文件**,文件覆盖同名。
    // 原先是 `raw.providers || cfg.providers` —— 只要文件里写了 providers 键,内置默认就整块
    // 消失,而 daemon 那边照样 merge ⇒ **控制台少显示一个真实可用的模型**(2026-09-01 撞到:
    // 给临时配置加了 codex,claude 当场从模型库消失,而 daemon 仍然认它)。
    // 「显示的 ≠ 实际生效的」是这类界面最贵的一种错。
    const provSrc = { ...DEFAULTS.providers, ...(raw.providers || {}) }
    const reportedWindows = new Map()
    try {
      for (const g of runtimePolicy?.activityPage?.({ limit: 1 })?.groups || []) {
        const name = (control?.providerOf?.(g.chatId)) || raw.groups?.[g.chatId]?.provider || raw.defaultProvider || cfg.defaultProvider
        const provider = provSrc[name]
        if (raw.groups?.[g.chatId]?.model && raw.groups[g.chatId].model !== provider?.model) continue
        const configuredModel = raw.groups?.[g.chatId]?.model || provider?.model || provider?.env?.ANTHROPIC_MODEL || ''
        const tokens = g.context?.windowTokens
        if (provider && g.model === configuredModel && (!g.context?.sessionId || g.context.sessionId === g.sessionId) &&
            Number.isSafeInteger(tokens) && tokens > 0) reportedWindows.set(name, tokens)
      }
    } catch { /* A missing live sample is not a model capacity. */ }
    const codexWindows = codexCatalogWindows()
    // 一次性任务过期判断:at(群时区本地串)< 当前群时区时间串(YYYY-MM-DD HH:mm 字典序=时间序)
    const nowTzStr = (() => { try { const p = tzParts(Date.now(), normalizeTz(raw.timezone)); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` } catch { return '' } })()
    const cronExpired = (at) => { try { return !!at && normalizeAt(at) < nowTzStr } catch { return false } }
    const providers = Object.entries(provSrc)
      .filter(([, p]) => !runtimePolicy || runtimePolicy.providerSupported(p))
      .map(([name, p]) => ({
      name,
      model: p.model || '',
      runner: p.runner || '', // 'codex' → GPT via Codex CLI (subscription login, no key); else Claude Code
      baseUrl: p.baseUrl || '',
      loggedIn: !p.baseUrl,
      keyStatus: keyStatus(p.apiKey),
      keyRef: isEnvRef(p.apiKey) ? p.apiKey.slice(4) : '',
      toolQuality: p.toolQuality || '',
      effort: (p.env && p.env.CLAUDE_CODE_EFFORT_LEVEL) || '',
      reasoningEffort: p.reasoningEffort || '', // codex-only: -c model_reasoning_effort
      autocompactTokens: p.autocompactTokens ?? 0,
      reportedContextTokens: reportedWindows.get(name) || null,
      contextWindowTokens: p.runner === 'codex' ? (p.contextWindowTokens || 0) : null,
      contextWindowMax: p.runner === 'codex' ? (codexWindows.get(p.model)?.maxTokens || null) : null,
      contextWindow: windowForProvider(p, reportedWindows.get(name), codexWindows),
      vision: p.vision !== false, // false = 纯文本模型 ⇒ 图片走 strip-proxy 降级
      hidden: !!p.hidden,
      configured: isConfigured(p), // usable: logged-in, or has a resolvable key
    }))
    const groups = Object.entries(raw.groups || {})
      .filter(([id]) => id !== 'oc_example_chat_id')
      // repo:群项目关联的 git 远端(可空)。repoState 走纯 fs 的 .git/config 读取(quickLinkState)
      // —— 群卡标签要反映真实关联(origin 被手改/删掉时不能还绿着),但这里每个 API 响应都跑一遍,
      // per-group spawn git 会把控制台拖垮,所以只读文件、不 spawn。
      .map(([chatId, g]) => ({ chatId, name: g.name || '', workdir: g.workdir || '', repo: g.repo || '', platform: chatPlatformOf(raw, chatId) /* 群属于哪个平台:配置写了就认,没写按 id 形态 / 唯一平台推断(与 config.normalizeGroupPlatforms 同口径) */, repoState: gitrepo.quickLinkState(g.workdir, g.repo), board: g.board && g.board.url ? { url: g.board.url, createdAt: g.board.createdAt || null } : null, provider: g.provider || '', effectiveProvider: (control && control.providerOf && control.providerOf(chatId)) || g.provider || raw.defaultProvider || cfg.defaultProvider, codexSteer: followupEnabled(g, 'codex'), steer: g.steer ?? null, followupEnabled: followupEnabled(g, cfg.providers[(control && control.providerOf && control.providerOf(chatId)) || g.provider || cfg.defaultProvider]?.runner || 'claude'), model: g.model || '', allowedTools: g.allowedTools || [], disallowedTools: g.disallowedTools || [], permissionMode: g.permissionMode || '', paused: g.paused === true, plugins: g.plugins || null,
        // 项目级插件/技能(workdir 自带声明,随项目恒加载)—— 群卡摘要行不点开也看得见。
        // projectPlugins 纯 fs 读且各错各兜(readJson/scanSkills 都 catch),与同行的 projectStyleCard 同量级。
        // ⚠ workdir 必须先判空:空串会让 path.join 退化成 daemon cwd 相对读(实验证实能读到别的项目的
        // .mcp.json)—— 无 workdir 的群就是没有项目声明,不能拿 cwd 凑。
        proj: (() => { if (!g.workdir) return { mcp: [], skills: [] }; try { const pp = projectPlugins(g.workdir); return { mcp: pp.mcp.map((m) => m.name), skills: pp.skills.map((s) => s.name) } } catch { return { mcp: [], skills: [] } } })(),
        redactPii: g.redactPii !== false, // false = 数据明文群;true = 默认遮盖
        preview: g.preview || null, styles: design.projectStyleCards(g.workdir),
        // 图标那一行:与「设计风格」平级的第二个选择(2026-08-25)。用哪套图标系统是**项目**的
        // 事、住在 design/icons.md ——「换风格就换图标」是要拆掉的那个绑定。
        icons: g.workdir ? design.projectIconCard(g.workdir) : null, crons: (Array.isArray(g.crons) ? g.crons : []).map((c) => ({ ...c, human: describeTask(c, nowTzStr), expired: cronExpired(c.at) })), exists: g.workdir ? fs.existsSync(g.workdir) : false }))
    // Console overview health — deliberately minimal: backend CLI 探针 + "有无可用模型/群"。
    // Codex CLI 行仅在配了 codex provider 时出现(与 doctor 一致);`sbot doctor` 保留全量。
    const hasClaude = providers.some((p) => !p.hidden && p.runner !== 'codex')
    const v = !runtimePolicy || hasClaude ? await probeCached(cfg.agent.bin) : null
    const hasCodex = providers.some((p) => !p.hidden && p.runner === 'codex')
    const cv = hasCodex ? await probeCodexCached() : null
    // 「可用模型」= 能用的,不只是配了的(1.0.3;此前没登录的 Claude 订阅、试跑失败的 key 都算在内)。
    // key 型看最近一次验证:失败的不算,还没验证的先算上;Claude 订阅看本机登录态,探不出来(没装 / 超时)不扣。
    // codex 用服务端判据(与 doctor、卡片「验证登录」同一个探针,按 bin 共用一份缓存):`codex login status`
    // 只读本地文件,令牌被吊销后照样「已登录」。只有服务端明确拒绝(dead)才扣;探不到(没装 / 超时 / 连不上)不扣。
    // ⚠ 概览**绝不等**这个探针(起进程出网,冷缓存 2s、连不上 12s):peekAuthProbe 只读 10 分钟内的缓存,
    // 没有就按「未验证」算(不扣)并在后台刷新一次,下一次重建就是真结果。claude 那条是 60s 缓存的本地调用,照旧等。
    const live = providers.filter((p) => !p.hidden && p.configured)
    const subLogin = live.some((p) => !p.baseUrl && p.runner !== 'codex') ? await claudestatus.cachedLoginStatus(cfg.agent.bin).catch(() => null) : null
    const cxLogin = live.some((p) => p.runner === 'codex') ? codexstatus.peekAuthProbe('codex', 10 * 60_000) : null
    const loggedOut = (st) => !!(st && st.ok && st.loggedIn === false)
    const unusable = (p) => {
      if (p.baseUrl) { const v = verify.lookup(verify.providerFp(cfg.providers[p.name] || {}), vopts); return !!(v && !v.ok) }
      if (p.runner === 'codex') return !!(cxLogin && cxLogin.dead)
      return loggedOut(subLogin)
    }
    const badProv = live.filter(unusable).map((p) => p.name)
    const usableProv = live.length - badProv.length
    const usableGroups = groups.filter((g) => g.exists).length
    // 各平台连接健康度(仅 daemon 运行时有):路由器出 { feishu: 快照, wecom: 快照 } 字典 → 概览一行一个平台 + 完整块给前端。
    const conn = getConnHealth ? getConnHealth() : null
    const connRows = connHealthRows(conn)
    const rows = [
      ...(v ? [{ status: v.ok ? 'ok' : 'fail', label: 'Claude CLI', detail: v.ok ? v.version : v.error }] : []),
      ...(cv ? [{ status: cv.ok ? 'ok' : 'fail', label: 'Codex CLI', detail: cv.ok ? `${cv.version} · GPT 订阅` : cv.error }] : []),
      { status: !usableProv ? 'fail' : badProv.length ? 'warn' : 'ok', label: '可用模型',
        detail: (usableProv ? `${usableProv} 个能用${live.some((p) => p.runner === 'codex' && !badProv.includes(p.name)) ? '(含 Codex)' : ''}` : '无可用模型 — 去「模型 · 库」页添加 / 测试')
          + (badProv.length ? `;${badProv.join('、')} 没登录或验证失败` : '') },
      { status: usableGroups ? 'ok' : 'warn', label: '可用群 / 项目', detail: usableGroups ? `${usableGroups} 个已绑定` : '无绑定群/项目 — 去「群·项目」页创建' },
      ...connRows,
      // 平台凭据:最近一次预检失败才出一行(通过 / 没预检过不占地方;daemon 在跑时上面的连接行已经说明了连没连上)
      ...[['feishu', '飞书凭据', verify.feishuFp(cfg.feishu)], ['slack', 'Slack 凭据', verify.slackFp(cfg.slack)]].flatMap(([, label, fp]) => {
        const v = fp ? verify.lookup(fp, vopts) : null
        return v && !v.ok ? [{ status: 'fail', label, detail: `上次预检失败:${v.reason} — 去「设置」页改凭据后再预检` }] : []
      }),
    ]
    const health = { rows, fails: rows.filter((r) => r.status === 'fail').length, warns: rows.filter((r) => r.status === 'warn').length }
    lastHealth = health
    const feishu = raw.feishu ? {
      appId: isEnvRef(raw.feishu.appId) ? '' : (raw.feishu.appId || ''),
      appIdRef: isEnvRef(raw.feishu.appId) ? raw.feishu.appId.slice(4) : '',
      appSecretStatus: keyStatus(raw.feishu.appSecret),
      botOpenId: String(raw.feishu.botOpenId || '').startsWith('ou_x') ? '' : (raw.feishu.botOpenId || ''),
      identity: raw.feishu.identity || null, // 应用名称/描述/头像/状态 — 预检或「刷新」时落盘的缓存
      admins: adminList(raw.feishu), // 可多个;兼容旧的单 adminOpenId
      onlyWhenMentioned: !!raw.feishu.onlyWhenMentioned,
    } : null
    // 企业微信机器人(设置页那张卡):凭据只给形状不给值(botId 是 env: 引用时留空并给引用名,secret 只给 none/env/set);
    // names 是 operator 手填的 userid → 显示名映射,原样回给表单。cli 字段不进控制台(机器布局,配置文件里改)。
    const wecom = raw.wecom ? {
      botId: isEnvRef(raw.wecom.botId) ? '' : (raw.wecom.botId || ''),
      botIdRef: isEnvRef(raw.wecom.botId) ? raw.wecom.botId.slice(4) : '',
      secretStatus: keyStatus(raw.wecom.secret),
      botName: raw.wecom.botName || '',
      welcome: raw.wecom.welcome || '',
      names: (raw.wecom.names && typeof raw.wecom.names === 'object' && !Array.isArray(raw.wecom.names)) ? raw.wecom.names : {},
      cliOff: raw.wecom.cli === false,
      keywords: Array.isArray(raw.wecom.keywords) ? raw.wecom.keywords.map(String) : null, // 点名词;null = 用默认(机器人 / 助手)
      pollSec: raw.wecom.pollSec === undefined || raw.wecom.pollSec === null || raw.wecom.pollSec === '' ? 0 : Number(raw.wecom.pollSec), // 「不 @ 也回复」轮询间隔(默认 0 = 关,产品决定)
      followSec: raw.wecom.followSec === undefined || raw.wecom.followSec === null || raw.wecom.followSec === '' ? 300 : Number(raw.wecom.followSec), // 跟进窗口(默认 300;0 全喂)
      // 第二道门(便宜模型门控):配置里允许写成模型名字串(手写配置的简写)或 { provider, model? };表单是「下拉 + 型号框」两个控件,
      // 要一个稳定形状才好回填,所以这里统一成 { provider, model }(没型号给空串);没配 = null(下拉落到「不问」)
      gatekeeper: raw.wecom.gatekeeper ? (typeof raw.wecom.gatekeeper === 'string' ? { provider: raw.wecom.gatekeeper, model: '' } : { provider: String(raw.wecom.gatekeeper.provider || ''), model: String(raw.wecom.gatekeeper.model || '') }) : null,
    } : null
    const fli = feishuLoginInfo() // 公网地址 + 飞书登录就绪态(设置页要显示回调地址与缺哪样)
    // Slack 应用块(与 feishu 平级)。⚠ token 一律**只回状态不回明文** —— xoxb 拿到就能以 bot
    // 身份发消息,比飞书的 appId 敏感得多;界面只需要知道"配没配"。
    const slack = raw.slack ? {
      botTokenStatus: keyStatus(raw.slack.botToken),
      appTokenStatus: keyStatus(raw.slack.appToken),
      botUserId: raw.slack.botUserId || '',
      identity: raw.slack.identity || null, // 预检时落盘:bot 名 / workspace 名(与飞书 identity 同惯例)
      onlyWhenMentioned: !!raw.slack.onlyWhenMentioned,
      replyInThread: raw.slack.replyInThread !== false,
      commandAlias: raw.slack.commandAlias || '!',
    } : null
    const state = {
      configPath: cfg._path,
      health,
      providers,
      defaultProvider: raw.defaultProvider || cfg.defaultProvider,
      groups,
      // 项目根目录:绑群弹窗的路径提示用 projectsRoots(生效值);设置页那张卡用 projectsRootsInfo
      //(每条根在不在 · 配置原文 · 被忽略的值与原因 · 哪些群在根外)。与围栏同一份判据。
      ...(() => {
        const pr = projectsroot.resolveProjectsRoots(raw)
        const outside = groups.filter((g) => g.workdir && g.exists && !projectsroot.withinRoots(g.workdir, pr.roots)).map((g) => ({ chatId: g.chatId, name: g.name, workdir: g.workdir }))
        const configured = Array.isArray(raw.projectsRoots) ? raw.projectsRoots.map(String) : (typeof raw.projectsRoots === 'string' ? [raw.projectsRoots] : null)
        return { projectsRoots: pr.roots, projectsRootsInfo: { roots: pr.roots.map((r) => ({ root: r, exists: fs.existsSync(r) })), fromConfig: pr.fromConfig, dropped: pr.dropped, configured, outside } }
      })(),

      // 图标系统的可选项(两条,约 120 字节)。⚠ 随心跳下发而不是让前端另拉一次:群卡上那个
      // 下拉要在**每次重画群卡时**就绪,单独拉会有「先画出来只剩『未选』、拉回来才补上」的空窗,
      // 而那种空窗看起来和「这个项目没选」一模一样(与图标包没装要如实标是同一条理由)。
      iconSystems: design.iconSystemList(),
      feishu,
      wecom,
      slack,
      platforms: platformsConfigured(raw), // 双平台并存:哪些平台配齐了凭据(env: 引用按已配算)—— 弹窗要不要显示平台切换 · 概览连接行 · 群卡徽标都看它
      agent: {
        permissionMode: cfg.agent.permissionMode,
        maxConcurrent: cfg.agent.maxConcurrent,
        maxTurnTimeMins: cfg.agent.maxTurnTimeMins,
        ackDelayMs: cfg.agent.ackDelayMs, // 回执等待毫秒(默认 25s 经 config 层合并;界面按秒显示)
      },
      proxy: raw.proxy && raw.proxy.http ? { http: raw.proxy.http, noProxy: raw.proxy.noProxy || '' } : null,
      live: getLiveState ? getLiveState() : { running: false },
      // 守护进程还没接平台、只开着控制台(cmdStart 配置模式):supervised = 由服务托管,接上平台后会自己重启连上
      setupMode: setupMode ? { supervised: !!setupMode.supervised } : null,
      conn, // 各平台连接健康度字典 { feishu, wecom }(daemon 运行时);未运行为 null
      previews: previewsState(raw),

      issues: issuesState(raw),

      leftovers: await leftoversState(),

      codexStatus: codexStatusCache ? { login: codexStatusCache.login, usage: codexStatusCache.usage } : null, // 前端加载回填,codex 卡片刷新不丢
      claudeStatus: claudeStatusCache ? claudeStatusCache.login : null, // 同上,Claude 订阅登录态
      // 服务器时区/时间(顶栏时钟):tz/offsetMin = bot 工作时区(cfg.timezone,默认北京)——
      // 群里/prompt 时间戳用的就是这个口径,运维看到的钟要和群里一致;hostTz 是主机系统时区
      // (不同才在悬浮提示里补充)。前端用 now 校准一次时差后本地走秒,不轮询。
      time: (() => {
        const tz = normalizeTz(cfg.timezone)
        let hostTz = ''
        try { hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch {}
        return { tz, offsetMin: tzOffsetMin(tz), hostTz, hostOffsetMin: -new Date().getTimezoneOffset(), now: Date.now() }
      })(),
      timezone: raw.timezone || '', // 设置页编辑用(空 = 未显式配置,跑默认北京)
      brand: raw.brand || '', // 机器人自称(设置页编辑;空 = SintBot)
      // 本进程环境里的代理(装服务时从终端带进来的 https_proxy 等;带认证的只说「带认证」):设置页据此说明「服务里已有代理」
      envProxy: require('../core/proxy').proxyDescribe(process.env),
      // 本机访问地址(控制台「设置」页展示):本机 URL 恒有;对外绑定时列出局域网 URL。
      net: (() => {
        const addr = server.address()
        const port = addr && typeof addr === 'object' ? addr.port : null
        return {
          lan: !loopbackBind,
          host: activeHost,
          port,
          local: port ? `http://127.0.0.1:${port}` : null,
          lanUrls: (!loopbackBind && port) ? lanIPv4().map((ip) => `http://${ip}:${port}`) : [],
          authOn: authConfigured(),
          publicUrl: fli.publicUrl, // 公网地址(飞书登录回调的根;设置页可填)
          publicEnabled: fli.enabled,
          publicReady: fli.configured,
          feishuLogin: { ready: fli.ready, why: fli.why, redirectUri: fli.redirectUri },
        }
      })(),
      update: updater ? { ...updater.status(), announce: !raw.ui || raw.ui.announceUpdates !== false } : null,
    }
    state.inbox = buildInboxFor(state, raw)
    if (runtimePolicy) runtimePolicy.decorateState(state)
    return state
  }

  async function testProvider(name, prompt) {
    const cfg = loadConfig(configPath); applyProxyEnv(cfg)
    const provider = cfg.providers[name]
    if (!provider) return { ok: false, error: `unknown provider '${name}'` }
    if (provider.hidden) return { ok: false, error: '模型已隐藏，不能试运行' }
    if (provider.baseUrl && !provider.apiKey) return { ok: false, error: 'no apiKey' }
    const ac = new AbortController()
    let lease, closed = false
    try { lease = runtimePolicy ? await runtimePolicy.beginTrial(ac) : null }
    catch (error) { return { ok: false, error: error.message } }
    // codex 跑整轮 GPT(冷启动 + reasoning)远慢于 Anthropic 的快问快答;给更长的测试超时。
    // 中止现在真生效(codexcode 强制收尾),超时到点能掐断,不会再干等到自然结束。
    const timer = setTimeout(() => ac.abort(), provider.runner === 'codex' ? 180000 : 60000)
    const t0 = Date.now()
    try {
      const execution = await runTurn({
        bin: cfg.agent.bin,
        prompt: prompt || verify.TRIAL_PROMPT,
        provider,
        model: provider.model,
        permissionMode: cfg.agent.permissionMode,
        signal: ac.signal, // a one-line reply — needs no tools, so no allow list
      })
      closed = isClosedRunnerResult(execution)
      const { result } = execution
      if (lease && !closed) throw new Error('试运行进程关闭状态未知，结果未保存，并发名额已保留')
      lease?.assertWritable()
      const ok = !(result && result.isError)
      verify.recordTurn(provider, ok, (result && result.text) || '', vopts) // doctor / 概览据此报「能用」或「key 不对」
      return { ok, model: provider.model, reply: (result && result.text) || '(no text)', ms: Date.now() - t0 }
    } catch (e) {
      closed ||= isClosedRunnerError(e)
      if (!lease) verify.recordTurn(provider, false, (e && e.message) || String(e), vopts)
      else if (closed) {
        try { lease.assertWritable(); verify.recordTurn(provider, false, e.message || String(e), vopts) }
        catch { /* lease loss must never write verification evidence */ }
      }
      return { ok: false, error: (e && e.message) || String(e), ms: Date.now() - t0 }
    } finally { clearTimeout(timer); lease?.finish(closed) }
  }

  // ── request handling ──────────────────────────────────────────────────────
  const sendJSON = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
  const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy() }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } }) })

  // 安装命令执行(操作台专用,等价一个开放终端):白名单 env(剔 provider 密钥,npx postinstall
  // 等捞不到 key)+ Windows UTF-8 码页(execShellCommand,防中文乱码)+ audit(命令/结果各一行)。
  async function runInstallCommand(command, cwd) {
    const t0 = Date.now()
    audit.append({ kind: 'plugin-exec', command, cwd, ts: t0 })
    const { exec } = require('node:child_process')
    const SAFE_ENV = ['PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
    const childEnv = {}
    for (const k of SAFE_ENV) if (process.env[k] !== undefined) childEnv[k] = process.env[k]
    return new Promise((resolve) => {
      exec(execShellCommand(command), { cwd, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: childEnv }, (err, stdout, stderr) => {
        const out = ((stdout || '') + (stderr ? '\n' + stderr : '')).trim()
        const ok = !err
        audit.append({ kind: 'plugin-exec-result', ok, ms: Date.now() - t0, exitCode: err ? (err.code ?? null) : 0, outputTail: (out || '').slice(-500), ts: Date.now() })
        resolve({ ok, output: (out.length > 8000 ? '…' + out.slice(-8000) : out) || (err ? String(err.message || err) : '(无输出)') })
      })
    })
  }

  // 接管浏览器(src/ui/browserroutes.js + takeover.js):一次性链接的票据在这一层签发与核验,/api/browser/* 的实现在路由对象里。
  // 三种人:管理员(令牌)· 群成员(接管 cookie,只认 /api/browser/* 且不能签票)· 本机环回进程(群 agent 跑命令签票)。
  const takeoverStore = takeover.createTakeoverStore({ onClaimed: onTakeoverClaim, onExpired: onTakeoverExpire, onEnded: onTakeoverEnd, ...(takeoverNow ? { now: takeoverNow } : {}) }) // takeoverNow 只给测试拨钟
  const browserRoutes = createBrowserRoutes({
    readRaw, audit, log, cdp: cdpImpl || require('../cdp'), sendJSON, body,
    takeover: { ...takeover, mint: (o) => takeoverStore.mint(o), consume: (k, o) => takeoverStore.consume(k, o), attach: (id, m) => takeoverStore.attach(id, m), revokeSession: (sid) => takeoverStore.revokeSession(sid) },
    publicBase: () => feishuLoginInfo().publicUrl || '',
    // 只绑环回时局域网地址根本连不上(对抗审查 🟡4)⇒ 不给,让签票退成 127.0.0.1 并标 reach:'local'
    lanBase: () => { const a = server.address(); const ip = lanIPv4()[0]; return !loopbackBind && a && ip ? `http://${ip}:${a.port}` : '' },
    localBase: () => { const a = server.address(); return a ? `http://127.0.0.1:${a.port}` : '' },
    secureFor: (req) => String(req.headers['x-forwarded-proto'] || '') === 'https',
  })
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    try {
      if (!HOST_OK.test(req.headers.host || '')) { res.writeHead(403); return res.end('forbidden') }
      // 三个不需要令牌的入口:密码登录、飞书登录的起跳与回调 —— 其余 /api/* 一律先验令牌。
      if (p.startsWith('/api/')) syncSessionsWithConfig() // 名单 / 密码变了,旧会话在这一步就失效
      const openPath = p === '/api/login' || (req.method === 'GET' && (p === feishulogin.START_PATH || p === feishulogin.CALLBACK_PATH)) || (p === '/api/browser/claim' && req.method === 'POST') // claim 的凭证就是票本身
      // 接管浏览器的两扇小门:① 接管 cookie 只对 /api/browser/*(签票接口除外)有效 —— 群成员到不了控制台其它接口;
      // ② 签票接口另认「本机环回且不带反代头」的请求(群 agent 跑 sbot browser link 时没有令牌)。伪造反代头只会让自己失去这条资格,方向安全。
      const takeoverSid = takeover.cookieValue(req.headers.cookie)
      const takeoverSess = takeoverSid ? takeoverStore.session(takeoverSid) : null
      const isMintPath = p === '/api/browser/link' || p === '/api/browser/link/attach'
      const viaTakeover = p.startsWith('/api/browser/') && !isMintPath && !!takeoverSess
      const localNoProxy = isLoopbackReq(req) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-proto']
      // ⚠ 还要带 X-Sbot-Local 头:自定义头逼出 CORS 预检,而控制台不答预检 ⇒ 本机网页的跨站 POST(no-cors text/plain)到不了签票
      //   (文件头钉的不变量:环回绑定不是安全边界)。本机进程(群 agent 的 sbot browser link)加个头不费事。对抗审查 🟡3。
      const viaLocalMint = isMintPath && localNoProxy && String(req.headers['x-sbot-local'] || '') === '1'
      if (p.startsWith('/api/') && !openPath && !authed(req, url) && !viaTakeover && !viaLocalMint) return sendJSON(res, 401, { error: 'unauthorized — 重新打开控制台页面' })
      if (runtimePolicy && p.startsWith('/api/') && !runtimePolicy.allows(req.method, p)) {
        return sendJSON(res, 409, { error: runtimePolicy.capabilities.reason, code: 'C2_CONSOLE_UNSUPPORTED' })
      }
      if (!cronTools && p.startsWith('/api/groups/cron/')) {
        return sendJSON(res, 409, { error: '当前控制台未接入定时任务', code: 'C2_CONSOLE_UNSUPPORTED' })
      }
      // 登出:作废本次会话令牌(落盘,重启后也不再认)
      if (p === '/api/logout' && req.method === 'POST') { sessions.remove(String(req.headers['x-sbot-token'] || '')); return sendJSON(res, 200, { ok: true }) }
      // 退出所有设备:吊销这台机器签发过的全部会话(自己这枚也在内)
      if (p === '/api/logout/all' && req.method === 'POST') { const n = sessions.clear() + takeoverStore.revokeAll(); browserRoutes.endTakeoverStreams(); audit.append({ kind: 'ui-logout-all', n, ip: (req.socket && req.socket.remoteAddress) || '', ts: Date.now() }); return sendJSON(res, 200, { ok: true, n }) }
      // 「用飞书登录」起跳:三样齐才起跳(否则说清缺哪样),签一次性 state,302 到飞书授权页。
      if (p === feishulogin.START_PATH && req.method === 'GET') {
        const info = feishuLoginInfo()
        if (!info.ready) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(feishulogin.loginResultHtml({ ok: false, message: `飞书登录还没配好:${info.why}` })) }
        const state = oauthStates.issue()
        res.writeHead(302, { Location: feishulogin.buildAuthorizeUrl({ appId: info.appId, redirectUri: info.redirectUri, state }), 'Cache-Control': 'no-store' })
        return res.end()
      }
      // 回调:state 一次性校验 → 换 token → 取 open_id → 对照管理员名单 → 签会话 → 落地页把令牌写进浏览器再回首页。
      // 每一步失败都只说人话、都进审计;名单外的人授权成功也进不来(审计记 ok:false 与是谁)。
      if (p === feishulogin.CALLBACK_PATH && req.method === 'GET') {
        const ip = (req.socket && req.socket.remoteAddress) || ''
        const xff = String(req.headers['x-forwarded-for'] || '') // 经隧道后 ip 恒为本机地址,真实来源只在这个头里(只记录)
        const page = (code, o) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(feishulogin.loginResultHtml(o)) }
        const state = url.searchParams.get('state') || ''; const code = url.searchParams.get('code') || ''
        if (!oauthStates.consume(state)) { audit.append({ kind: 'ui-login', ok: false, via: 'feishu', why: 'bad-state', ip, xff, ts: Date.now() }); return page(400, { ok: false, message: '这次登录已过期,或不是从登录页发起的。请回到登录页重试' }) }
        const info = feishuLoginInfo()
        if (!info.ready || !code) { audit.append({ kind: 'ui-login', ok: false, via: 'feishu', why: info.ready ? 'no-code' : 'not-ready', ip, xff, ts: Date.now() }); return page(400, { ok: false, message: info.ready ? '飞书没有返回授权码,请重试' : `飞书登录还没配好:${info.why}` }) }
        try {
          const { accessToken } = await feishulogin.exchangeCode({ fetchImpl: doFetch, appId: info.appId, appSecret: info.appSecret, code, redirectUri: info.redirectUri })
          const who = await feishulogin.fetchUserInfo({ fetchImpl: doFetch, accessToken })
          const admin = feishulogin.adminMatch(info.admins, who.openId)
          if (!admin) {
            audit.append({ kind: 'ui-login', ok: false, via: 'feishu', why: 'not-admin', who: who.name, openId: who.openId, ip, xff, ts: Date.now() })
            log(`ui: 飞书登录被拒 —— ${who.name || who.openId} 不在管理员名单里`)
            return page(403, { ok: false, message: `${who.name ? who.name + ',' : ''}你的飞书账号不在这台机器的管理员名单里。请管理员在「设置 → 飞书应用」把你加为管理员后再试` })
          }
          const name = admin.name || who.name
          const token = sessions.add({ via: 'feishu', who: name, ip, xff, openId: who.openId })
          audit.append({ kind: 'ui-login', ok: true, via: 'feishu', who: name, openId: who.openId, ip, xff, ts: Date.now() })
          return page(200, { ok: true, token, name })
        } catch (e) {
          audit.append({ kind: 'ui-login', ok: false, via: 'feishu', why: 'exchange', ip, xff, ts: Date.now() })
          log('ui: 飞书登录失败 — ' + (e && e.message))
          return page(502, { ok: false, message: (e && e.message) || '飞书登录失败' })
        }
      }
      // Login: verify password → mint a session token (reuses the header-token pipeline,
      // so no cookie ⇒ no CSRF). Fixed 400ms delay + audit on failure keeps online
      // brute-force impractical for a decent passphrase. Only reachable when a password set.
      if (p === '/api/login' && req.method === 'POST') {
        const stored = (() => { try { return (readRaw().ui || {}).auth || null } catch { return null } })()
        const ip = (req.socket && req.socket.remoteAddress) || ''
        if (!stored) return sendJSON(res, 400, { error: '未设置访问密码' })
        const { password } = await body(req)
        if (verifyPassword(String(password || ''), stored)) {
          const xff = String(req.headers['x-forwarded-for'] || '') // 经反代时的真实来源(只记录,不做任何裁决)
          const sess = sessions.add({ via: 'password', ip, xff, authRef: String(stored).slice(0, 16) })
          audit.append({ kind: 'ui-login', ok: true, via: 'password', ip, xff, ts: Date.now() })
          return sendJSON(res, 200, { token: sess })
        }
        audit.append({ kind: 'ui-login', ok: false, ip, ts: Date.now() })
        await new Promise((r) => setTimeout(r, 400))
        return sendJSON(res, 401, { error: '密码错误' })
      }
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        // The page is the token delivery channel. Deliver the token (免密) when it's safe
        // without a password:
        //   - no password set, OR
        //   - a password exists only because we're bound to a LAN address, and THIS request
        //     came in over loopback (same machine). Pure-local access must not be gated by
        //     the LAN password — the "127.0.0.1 免密" invariant (FR9.4a) should survive
        //     exposing the console to the LAN.
        // A password on a loopback-ONLY bind is a deliberate local lock, so it still prompts.
        // Any request that must authenticate gets an empty token → the login form.
        // ⚠ 再加一道:带着反代头(X-Forwarded-*)的请求一律不算本机 —— 本机浏览器不会带,nginx 一定带。
        //   隧道对端哪天被写成 127.0.0.1:4600,也不会退化成「公网全员免密」;伪造这两个头只会让自己失去免密,方向安全。
        const localBypass = !loopbackBind && isLoopbackReq(req) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-proto']
        const injectTok = (authConfigured() && !localBypass) ? '' : token
        return fs.readFile(CONSOLE_HTML, 'utf8', (e, html) => e ? (res.writeHead(500), res.end('console.html missing')) : (res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }), res.end(html.replace('__SBOT_TOKEN__', injectTok).replace('__SBOT_VERSION__', PKG_VERSION).replace('__SBOT_FEISHU_LOGIN__', feishuLoginInfo().ready ? '1' : '').replace('/*__LIVE_ACTIVITY__*/', () => LIVE_ACTIVITY_JS))))
      }
      // 接管浏览器页。群成员的一次性链接是 /browser#k=<票>:票在 URL 片段里,服务端根本收不到 ⇒ 不进任何日志、链接预览的
      //   裸 GET 也抓不走;页面脚本读片段、人点「开始接管」后 POST /api/browser/claim 换 cookie。这里只分发页面:
      //   与首页同一套免密 / 令牌规则(管理员从控制台进来);既没令牌也没有效 cookie 又没票的人看到的是「去登录」。
      if (req.method === 'GET' && p === '/browser') {
        const localBypass = !loopbackBind && isLoopbackReq(req) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-proto']
        const injectTok = (authConfigured() && !localBypass) ? '' : token
        const viaCookie = !!takeoverSess
        return fs.readFile(BROWSER_HTML, 'utf8', (e, html) => e ? (res.writeHead(500), res.end('browser.html missing')) : (res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }), res.end(html.replace(/__SBOT_TOKEN__/g, injectTok).replace(/__SBOT_TAKEOVER__/g, viaCookie ? '1' : ''))))
      }
      if (p.startsWith('/api/browser/')) {
        const ip = (req.socket && req.socket.remoteAddress) || ''
        const handled = await browserRoutes.handle(req, res, url, { p, authedAdmin: authed(req, url), takeoverSid: viaTakeover ? takeoverSid : '', takeoverTarget: viaTakeover ? (takeoverSess.targetId || '') : '', takeoverExp: viaTakeover ? (takeoverSess.exp || 0) : 0, localMint: viaLocalMint, ip, xff: String(req.headers['x-forwarded-for'] || '') })
        if (handled) return
      }
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        res.write('event: hello\ndata: {}\n\n')
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
        return
      }
      if (p === '/api/state' && req.method === 'GET') return sendJSON(res, 200, await buildState())
      if (p === '/api/inbox' && req.method === 'GET') return sendJSON(res, 200, { inbox: await inboxOnly() })
      // Recent activity for the console to seed/merge on load + SSE reconnect (下一步 ②).
      // Lightweight + kept off /api/state so mutations don't re-ship it every write.
      if (p === '/api/activity' && req.method === 'GET') return sendJSON(res, 200, runtimePolicy?.activityPage
        ? runtimePolicy.activityPage(Object.fromEntries(url.searchParams)) : { activity: recentActivity() })
      if (p === '/api/activity/detail' && req.method === 'GET') {
        const detail = runtimePolicy?.activityDetail?.(url.searchParams.get('chatId'), url.searchParams.get('id'))
        return sendJSON(res, detail ? 200 : 404, detail || { error: '活动详情未记录' })
      }
      // 版本历史(设置页「版本历史」卡):CHANGELOG.json 随包分发 = 单一事实源,发版时更新
      if (p === '/api/changelog' && req.method === 'GET') return sendJSON(res, 200, { changelog: readChangelog() })
      // 同一份版本历史的英文本(界面切英文时才拉;缺的版本前端按 version 回退中文)
      if (p === '/api/changelog-en' && req.method === 'GET') return sendJSON(res, 200, { changelog: readChangelogEn() })
      // 升级进度:控制台的升级弹窗在升级期间每一两秒读一次。只读,只给升级状态和还有任务的群名,
      // 不重算整份 state(那里有健康探针);服务重启的那几秒连不上,由页面当作「正在重启」处理。
      if (p === '/api/update' && req.method === 'GET') {
        if (!updater) return sendJSON(res, 503, { error: '版本检查暂不可用' })
        return sendJSON(res, 200, { ...updater.status(), waitingGroups: upgradeWaitingGroups() })
      }
      if (p === '/api/update/check' && req.method === 'POST') {
        if (!updater) return sendJSON(res, 503, { error: '版本检查暂不可用' })
        return sendJSON(res, 200, await updater.check())
      }
      if (p === '/api/update/start' && req.method === 'POST') {
        if (!updater) return sendJSON(res, 503, { error: '版本升级暂不可用' })
        const { version, announce } = await body(req)
        try { return sendJSON(res, 202, updater.startUpgrade({ version, announce })) }
        catch (e) { return sendJSON(res, 409, { error: e.message, update: updater.status() }) }
      }
      if (p === '/api/update/ignore' && req.method === 'POST') {
        if (!updater) return sendJSON(res, 503, { error: '版本升级暂不可用' })
        const { version } = await body(req)
        try { return sendJSON(res, 200, updater.ignore(version)) }
        catch (e) { return sendJSON(res, 400, { error: e.message }) }
      }
      if (p === '/api/ui/update-settings' && req.method === 'POST') {
        const patch = await body(req)
        if (typeof patch.announce !== 'boolean') return sendJSON(res, 400, { error: '请提供升级播报偏好' })
        const raw = readRaw(); raw.ui = raw.ui || {}
        raw.ui.announceUpdates = patch.announce
        delete raw.ui.autoUpdateCheck
        writeRaw(raw)
        return sendJSON(res, 200, await buildState())
      }
      // codex 可用模型(codex 面板「模型」下拉):app-server model/list 实时探测(当前
      // 账号真实可用集,含各模型支持的推理强度),失败回退内置预设;探测要 spawn 进程
      // +触网 → 10 分钟缓存。
      if (p === '/api/codex/models' && req.method === 'GET') {
        if (codexModelsCache && Date.now() - codexModelsCache.at < 600_000) return sendJSON(res, 200, codexModelsCache.val)
        const live = await codexstatus.listModels('codex')
        const val = live ? { source: 'live', models: live } : { source: 'preset', models: codexstatus.PRESET_MODELS }
        codexModelsCache = { at: Date.now(), val }
        return sendJSON(res, 200, val)
      }
      if (p === '/api/usage' && req.method === 'GET') { const cfg = loadConfig(configPath); return sendJSON(res, 200, await getUsage(cfg.providers)) }
      // 模型卡「额度」行的 ↻:只刷这一个 provider 且绕过两层缓存(见 usage.js refreshUsage)。
      // 分工 = 整页 /api/usage 走 5 分钟缓存,手点才现拉;codex 走自家 /api/codex/verify 的 force。
      if (p === '/api/usage/refresh' && req.method === 'POST') {
        const { name } = await body(req)
        const cfg = loadConfig(configPath)
        const prov = cfg.providers && cfg.providers[name]
        if (!prov) return sendJSON(res, 400, { error: `未知模型 '${name}'` })
        return sendJSON(res, 200, { name, usage: await refreshUsage(name, prov) })
      }

      if (p === '/api/provider-key' && req.method === 'POST') {
        const { name, apiKey } = await body(req)
        const raw = readRaw(); if (!raw.providers || !raw.providers[name]) return sendJSON(res, 404, { error: 'no such provider' })
        if (apiKey) raw.providers[name].apiKey = apiKey
        writeRaw(raw); return sendJSON(res, 200, await buildState())
      }
      if (p === '/api/default-provider' && req.method === 'POST') {
        const { name } = await body(req); const raw = readRaw()
        if (!(raw.providers || {})[name]) return sendJSON(res, 404, { error: 'no such provider' })
        raw.defaultProvider = name; writeRaw(raw); return sendJSON(res, 200, await buildState())
      }
      // upsert a provider (add or edit — the ⚙ config panel + 添加模型 both use this)
      if (p === '/api/providers/add' && req.method === 'POST') {
        const { name, baseUrl, model, apiKey, env, toolQuality, effort, reasoningEffort, autocompactTokens, contextWindowTokens, hidden, vision, modelClear, runner } = await body(req)
        if (!name || !/^[\w.-]+$/.test(name)) return sendJSON(res, 400, { error: '名称必填,且只用字母/数字/._-' })
        // 持久处理流程只跑 Codex / Claude Code:别的后端名不能被下面的白名单悄悄改写成 Claude 存进去。
        if (runtimePolicy && runner !== undefined && runner !== '' && !runtimePolicy.providerSupported({ runner })) {
          return sendJSON(res, 400, { error: '当前只能添加或修改 Codex 或 Claude Code 模型' })
        }
        const raw = readRaw(); raw.providers = raw.providers || {}
        // 编辑前快照:model / 推理强度变了要联动受影响群(通知 + model 变更重置会话)
        const prev = raw.providers[name] ? { model: raw.providers[name].model || '', re: raw.providers[name].reasoningEffort || '' } : null
        const pr = { ...(raw.providers[name] || {}) }
        if (baseUrl !== undefined) pr.baseUrl = baseUrl || undefined
        if (model) pr.model = model
        // 「默认(跟随 Claude Code)」= 不指定型号 ⇒ spawn 时不设 ANTHROPIC_MODEL,用 CLI 自己的默认。
        // 空 model 与「没传 model」要分开,所以用显式的 modelClear,而不是 `model !== undefined`
        // ——后者会让别处只传部分字段的保存请求把型号误清掉。
        else if (modelClear) delete pr.model
        if (apiKey) pr.apiKey = apiKey
        if (toolQuality !== undefined) { if (toolQuality) pr.toolQuality = toolQuality; else delete pr.toolQuality }
        if (env && typeof env === 'object') pr.env = { ...(pr.env || {}), ...env }
        if (effort !== undefined) { pr.env = pr.env || {}; if (effort) pr.env.CLAUDE_CODE_EFFORT_LEVEL = effort; else delete pr.env.CLAUDE_CODE_EFFORT_LEVEL; if (!Object.keys(pr.env).length) delete pr.env }
        // codex-only reasoning-effort (`-c model_reasoning_effort`) — 档位集合随模型演进
        // (model/list 实测 gpt-5.6 系已到 xhigh/max/ultra),故按形状校验而非枚举白名单;
        // 传参走 argv 数组无 shell 展开,无注入面。坏形状清空(回模型默认),不炸轮。
        if (reasoningEffort !== undefined) { if (typeof reasoningEffort === 'string' && /^[a-z]{2,16}$/.test(reasoningEffort)) pr.reasoningEffort = reasoningEffort; else delete pr.reasoningEffort }
        if (autocompactTokens !== undefined) {
          if (!Number.isInteger(autocompactTokens) || autocompactTokens < 0 ||
              (autocompactTokens > 0 && (autocompactTokens < 100_000 || autocompactTokens > 1_000_000))) {
            return sendJSON(res, 400, { error: '模型压缩阈值须为 0(执行器默认)或 100000–1000000 之间的整数(token 数)' })
          }
          pr.autocompactTokens = autocompactTokens
        }
        if (hidden !== undefined) { if (hidden) pr.hidden = true; else delete pr.hidden }
        // 识图能力:只存"没有"这一种情况(vision:false ⇒ spawn 时把 claude 挂到本地
        // strip-proxy,图片块降级成占位文本);有识图=默认透传,不写字段免得配置长毛。
        // 此前只能手改配置文件 —— 控制台建的第三方 provider 因此漏标,文本模型撞图片就 400 崩整轮。
        if (vision !== undefined) { if (vision === false) pr.vision = false; else delete pr.vision }
        // 后端选择(GPT 走 Codex CLI)。⚠ **白名单,不是原样存** —— 这个字段决定 spawn 哪个
        // 可执行文件(src/agent/runner.js 的派发),存进去一个随便的字符串等于给自己开一道门。
        // 不传 ⇒ 保持原值(编辑已有 codex provider 的常态,别把它降级成 claude 后端)。
        if (runner !== undefined) { if (runner === 'codex') pr.runner = 'codex'; else delete pr.runner }
        if (contextWindowTokens !== undefined) {
          if (pr.runner !== 'codex') return sendJSON(res, 400, { error: '上下文窗口设置仅适用于 Codex' })
          if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 0 ||
              (contextWindowTokens > 0 && (contextWindowTokens < 100_000 || contextWindowTokens > 1_050_000))) {
            return sendJSON(res, 400, { error: '上下文窗口须为 0 或 100000–1050000 之间的整数' })
          }
          pr.contextWindowTokens = contextWindowTokens
        }
        if (pr.runner !== 'codex') delete pr.contextWindowTokens
        if (pr.contextWindowTokens > 0) {
          const maximum = codexCatalogWindows().get(pr.model)?.maxTokens
          if (maximum && pr.contextWindowTokens > maximum) return sendJSON(res, 400, { error: `上下文窗口超过当前模型目录上限 ${maximum} token` })
        }
        raw.providers[name] = pr
        const defaultChange = settleDefault(raw); writeRaw(raw)
        // 变更联动(仅编辑已有 provider 时):受影响群 = 用着它(显式或经 defaultProvider)
        // 且无 per-group model 覆盖的群。model 变 = 换脑 → 按「切模型即重置」的既有拍板,
        // 重置这些群会话 + 群内一行通知;仅推理强度变 → 通知不重置。daemon 未运行(无
        // control/platform)⇒ 只落盘,前端据 live 提示"下次启动生效"。
        const modelChanged = prev && prev.model !== (pr.model || '')
        const reChanged = prev && prev.re !== (pr.reasoningEffort || '')
        const affected = (prev && (modelChanged || reChanged))
          // 用着它 = 实际在用(daemon 在线时问它;额度临时切换中的群按备用算),daemon 不在线才退回配置
          ? Object.keys(raw.groups || {}).filter((id) => { const g = raw.groups[id]; const cur = (control && control.providerOf && control.providerOf(id)) || g.provider || raw.defaultProvider; return id !== 'oc_example_chat_id' && !g.model && cur === name })
          : []
        const live = !!(control && control.notifyGroup)
        if (live && affected.length) {
          for (const chatId of affected) {
            try {
              if (modelChanged) {
                if (control.clearSession) control.clearSession(chatId)
                notifyGroup(chatId, `🔄 本群模型已更新:${name}${pr.model ? ' · ' + pr.model : ''}(会话已重置,下条消息生效)`)
              } else {
                notifyGroup(chatId, `⚙️ 本群模型 ${name} 推理强度已调为 ${pr.reasoningEffort || '默认'}(会话保留,下条消息生效)`)
              }
            } catch (e) { log('providerChange notify: ' + (e && e.message)) }
          }
        }
        // 持久处理流程:会话重置由配置写入方按「谁实际在用、型号/后端/端点是否变了」决定并已完成,
        // 这里如实报它重置了几个群、默认模型有没有被补上(上面的 affected 是旧守护进程的通知口径)。
        return sendJSON(res, 200, { ...(await buildState()), providerChange: { modelChanged: !!modelChanged, reChanged: !!reChanged, affected: affected.length, live, ...(runtimeLibraryChange(defaultChange) || {}) } })
      }
      if (p === '/api/providers' && req.method === 'DELETE') {
        const name = url.searchParams.get('name'); const raw = readRaw()
        // 占用守卫:还有群显式用着它就不许删(否则这些群下一条消息直接报错)
        const users = Object.keys(raw.groups || {}).filter((id) => id !== 'oc_example_chat_id' && raw.groups[id].provider === name).map((id) => raw.groups[id].name || id.slice(-8))
        if (users.length) return sendJSON(res, 400, { error: `「${name}」正被 ${users.length} 个群使用(${users.slice(0, 3).join('、')}${users.length > 3 ? '…' : ''})— 先在「群·项目」页把它们切到其它模型` })
        // ⚠ 内置默认(DEFAULTS.providers)不在配置文件里,删不掉也删不得 —— 不明说的话
        // 界面上就是「点了移除,它还在」,而那看起来和 bug 一模一样。
        if (DEFAULTS.providers[name] && !(raw.providers && raw.providers[name])) {
          return sendJSON(res, 400, { error: `「${name}」是内置默认模型,移不掉 —— 不想让它出现在列表里就用「隐藏」` })
        }
        if (raw.providers) delete raw.providers[name]
        const defaultChange = settleDefault(raw); writeRaw(raw)
        const change = runtimeLibraryChange(defaultChange)
        return sendJSON(res, 200, { ...(await buildState()), ...(change ? { providerChange: change } : {}) })
      }
      if (p === '/api/providers/hidden' && req.method === 'POST') {
        const { name, hidden } = await body(req); const raw = readRaw()
        if (!raw.providers || !raw.providers[name]) return sendJSON(res, 404, { error: 'no such provider' })
        if (hidden) raw.providers[name].hidden = true; else delete raw.providers[name].hidden
        const defaultChange = settleDefault(raw); writeRaw(raw)
        const change = runtimeLibraryChange(defaultChange)
        return sendJSON(res, 200, { ...(await buildState()), ...(change ? { providerChange: change } : {}) })
      }
      if (p === '/api/providers/order' && req.method === 'POST') {
        const { order } = await body(req); const raw = readRaw()
        if (Array.isArray(order) && raw.providers) {
          const next = {}
          for (const n of order) if (raw.providers[n]) next[n] = raw.providers[n]
          for (const [n, v] of Object.entries(raw.providers)) if (!(n in next)) next[n] = v // keep any not listed
          raw.providers = next
          // ordering doesn't set default; just keep the invisible fallback valid
          // (durable mode: only when the default no longer exists — see settleDefault)
          const defaultChange = settleDefault(raw)
          writeRaw(raw)
          const change = runtimeLibraryChange(defaultChange)
          if (change) return sendJSON(res, 200, { ...(await buildState()), providerChange: change })
        }
        return sendJSON(res, 200, await buildState())
      }
      if (p === '/api/groups/order' && req.method === 'POST') {
        // display order = config key order (buildState walks Object.entries);
        // cosmetic only — keys unchanged, engine routing unaffected
        const { order } = await body(req); const raw = readRaw()
        if (Array.isArray(order) && raw.groups) {
          const next = {}
          for (const id of order) if (raw.groups[id]) next[id] = raw.groups[id]
          for (const [id, v] of Object.entries(raw.groups)) if (!(id in next)) next[id] = v // keep any not listed
          raw.groups = next
          writeRaw(raw)
        }
        return sendJSON(res, 200, await buildState())
      }
      if (p === '/api/provider-settings' && req.method === 'POST') {
        const { name, toolQuality, effort } = await body(req); const raw = readRaw()
        if (!raw.providers || !raw.providers[name]) return sendJSON(res, 404, { error: 'no such provider' })
        const pr = raw.providers[name]
        if (toolQuality !== undefined) { if (toolQuality) pr.toolQuality = toolQuality; else delete pr.toolQuality }
        if (effort !== undefined) {
          pr.env = pr.env || {}
          if (effort) pr.env.CLAUDE_CODE_EFFORT_LEVEL = effort; else delete pr.env.CLAUDE_CODE_EFFORT_LEVEL
          if (!Object.keys(pr.env).length) delete pr.env
        }
        writeRaw(raw); return sendJSON(res, 200, await buildState())
      }
      // 反馈本改状态(标记已处理 / 放回未处理)。与 CLI `sbot issue close` 同口径:
      // 同一把跨进程锁、同一条回群告知 —— 提了没下文,下次就没人提了。
      // ⚠ 出站必过 redact:notifyGroup 直通 platform.send **不脱敏**(engine 是自己 redact
      // 完才调它的),而反馈正文里粘一段带 key 的日志是很常见的事。
      // 向群里插一句:operator 从概览页直接给某个群发一条**会驱动一轮**的消息。
      // 由来:在此之前只能拿定时任务 `--do` 当"现在说句话"用 —— 要算时间、要等触发、还留残迹。
      // ⚠ 是否显示到群里由 operator 选:显示 ⇒ 群成员看得见来龙去脉;不显示 ⇒ 群里凭空多出一轮,
      //   改动没争议时无所谓,一旦有争议就会被读成「它自己乱改」。默认显示 —— 安全的一边是可见。
      // ⚠ 注入给 agent 的是**原文**,发进群的才过 redact:注入侧脱敏会改坏 operator 的指令本身。
      if (p === '/api/groups/say' && req.method === 'POST') {
        const b0 = await body(req)
        const chatId = String(b0 && b0.chatId != null ? b0.chatId : '')
        const show = b0 && b0.show
        // reply:它的回复要不要进群。两个开关**平级** —— 四种组合都可达,其中「都不勾」
        // (群里彻底无痕)恰恰是最有用的一种:后台维护动作不该在群里刷屏。
        const wantReply = !(b0 && b0.reply === false)
        const t = String(b0 && b0.text != null ? b0.text : '').trim()
        if (!t) return sendJSON(res, 400, { error: '内容不能为空' })
        if (t.length > 2000) return sendJSON(res, 400, { error: `内容过长(${t.length} 字,上限 2000)` })
        const raw = readRaw()
        const gCfg = raw.groups && raw.groups[chatId]
        if (!gCfg) return sendJSON(res, 404, { error: '没有这个群项目' })
        const visible = show !== false
        const pii = !(gCfg.redactPii === false)
        // ⚠ 群里看到的必须**标明是谁说的**。平台上 bot 只能以自己的身份发,不加标记的话
        //   这句话读起来就是「机器人在自言自语」—— 而它其实是人下的指令,后面紧跟着的
        //   回复才是机器人的。加【管理员】之后,群里读到的是「有人问 → 它答」,与真人对话同形。
        //   体裁按群消息规矩:纯文本不渲染 markdown,层次只能用【】与「· 」。
        const shownText = visible ? `【管理员】${redact(t, { pii })}` : null
        // say 会先等群里那行「【管理员】…」发出去再注入(见 src/consolesay.js),所以要 await;最多多等一次发送
        // requestId:前端每次提交生成的 32 位十六进制幂等键。静默注入(群里无可见那行字)
        // 时它是唯一跨重启稳定的锚点 —— 带了就能让重复提交落到同一笔持久收据上;没带只是
        // 退回现状(不给持久身份),不改变行为。格式不对一律当没带,不拿它去拼身份。
        const requestId = typeof (b0 && b0.requestId) === 'string' &&
          /^[0-9a-f]{32}$/.test(b0.requestId) ? b0.requestId : undefined
        const r = (control && control.say)
          ? await control.say(chatId, t, shownText, !wantReply,
            ...(requestId ? [{ requestId }] : []))
          : { ok: false, reason: 'no-daemon' }
        // 审计留痕。⚠ 只留经 redact 的摘要不留全文:audit 是长期留存的,而插话内容由人手输、
        // 什么都可能带进来;要追责有摘要 + 时间 + 群就够了。
        // where = 这句落在哪(起了一轮 / 加入当前任务 / 排队);守护进程侧给不出时为 null,前端退回旧说法
        const where = (r && r.where && typeof r.where.state === 'string') ? r.where : null
        audit.append({ kind: 'group-say', chatId, show: visible, reply: wantReply, ok: !!r.ok, reason: r.reason || null, where: where ? where.state : null, chars: t.length, preview: redact(t, { pii }).slice(0, 80), ts: Date.now() })
        // 说不清就别说成功:与 issues 那条 canNotify 同一条纪律 —— 「让人以为已经插进去了」
        // 比直接报错更糟,因为他会等一个永远不来的回应。
        if (!r.ok) {
          const why = { 'no-daemon': '守护进程没在跑(纯配置模式)—— 插话需要它在线', paused: '这个群项目已暂停,先恢复再插话', unbound: '没有这个群项目', 'inject-failed': '注入失败(守护进程侧报错,看日志)',
            // 持久处理流程(第 1 版插话)的拒绝原因。shown-failed 之前的几条在发群消息之前就拒,群里没有任何字;
            // 从 shown-failed 起,群里可能已经有那行「【管理员】…」
            busy: '该群正在停止、跳过或处理未结记录,请稍后再插话',
            'queue-full': '该群等待处理的消息已满,请稍后再插话',
            held: '该群上一个任务结果不明,已暂停处理、等待人工确认;插话未执行',
            recovering: '该群上一个任务出错,正在收尾;插话未执行,请稍后再试',
            upgrading: '正在升级,插话未执行,请一分钟后再试',
            'not-serving': '服务正在启动或停止,或该群当前未开放;插话未执行',
            'silent-unsupported': '当前版本的插话必须把这句话发进群(勾选「插话」);静默插话暂不支持',
            'quiet-unsupported': '当前版本的插话必须让回复进群(勾选「回复」);群里无痕的插话暂不支持',
            command: '插话不执行群命令;停止任务、开新会话请用概览里的按钮',
            'request-id': '这次提交缺少有效的提交编号,请刷新控制台后再试',
            empty: '内容不能为空',
            'shown-failed': '群里那行「【管理员】…」没能确认发出(失败或超时),插话未执行;即使群里随后出现这行,它也不会被处理',
            'busy-after-post': '这行字发进群时该群正在停止或处理未结记录,这句没有处理;稍后原样再点一次插入,会沿用群里已有的那行',
            refused: '该群拒收了这句(原因已回复在群里那行下面);插话未执行',
            quarantined: '这句的来源已被隔离,未执行',
            unconfirmed: '这行字已发进群,但没在 5 秒内确认登记,结果以群里和「实时活动」为准;原样再点一次插入不会重复处理' }[r.reason] || '插话失败'
          return sendJSON(res, 409, { error: why, reason: r.reason || null })
        }
        return sendJSON(res, 200, Object.assign(await buildState(), { sayInjected: { chatId, show: visible, reply: wantReply, where } }))
      }

      if (p === '/api/issues/status' && req.method === 'POST') {
        const { id, op, note } = await body(req)
        if (op !== 'close' && op !== 'reopen') return sendJSON(res, 400, { error: "op 只能是 'close' 或 'reopen'" })
        const raw = readRaw()
        const book = createIssues(issuesFile(), { host: raw.instance || undefined, withFileLock })
        const it = book.setStatus(id, op, note)
        if (!it) return sendJSON(res, 404, { error: `#${id} 不存在,或本来就是${op === 'close' ? '已处理' : '未处理'}状态` })
        // 能不能真的告知到群,要**先算清楚再告诉前端**:纯配置模式(无 daemon)notifyGroup 是
        // 静默 no-op、暂停群按语义跳过 —— 这两种情况下前端若照样弹「已告知群里」就是在说谎,
        // 而「让人以为已经告知了」正是这本账要消灭的那类失信。
        const gCfg = raw.groups && raw.groups[it.chatId]
        const canNotify = op === 'close' && !!it.chatId && !!(control && control.notifyGroup) && !(gCfg && gCfg.paused)
        if (canNotify) {
          const pii = !(gCfg && gCfg.redactPii === false)
          const body2 = `✅ 你提的 #${it.id} 已处理\n「${summarize(it, { width: 40 })}」` + (it.note ? `\n${it.note}` : '')
          notifyGroup(it.chatId, redact(body2, { pii }))
        }
        // issueNotified 是响应级瞬态字段(不属于 state),前端读完即删,不进状态签名
        return sendJSON(res, 200, Object.assign(await buildState(), { issueNotified: canNotify }))
      }
      if (p === '/api/proxy' && req.method === 'POST') {
        const { http: httpUrl, enabled } = await body(req); const raw = readRaw()
        if (enabled && httpUrl && !/^https?:\/\/\S+$/i.test(String(httpUrl))) return sendJSON(res, 400, { error: '代理地址要像 http://127.0.0.1:7890' })
        if (enabled && httpUrl) raw.proxy = { http: httpUrl, https: httpUrl, noProxy: deriveNoProxy(raw.providers) }
        else delete raw.proxy
        writeRaw(raw); return sendJSON(res, 200, await buildState())
      }
      if (p === '/api/agent' && req.method === 'POST') {
        const patch = await body(req); const raw = readRaw(); raw.agent = raw.agent || {}
        for (const k of ['permissionMode', 'maxConcurrent', 'maxTurnTimeMins']) if (k in patch) raw.agent[k] = patch[k]
        // 机器人自称(顶层 brand):空或默认名就不落盘,和安装向导 --full 的写法一致
        if ('brand' in patch) { const b = String(patch.brand || '').trim().slice(0, 40); if (b && b !== 'SintBot') raw.brand = b; else delete raw.brand }
        if ('autocompactTokens' in patch) return sendJSON(res, 400, { error: '请在模型卡片中设置压缩策略' })
        // 回执等待:非负整数毫秒即可,0 = 不发。不设上限 —— 大于单轮超时只是永不触发,无害。
        if ('ackDelayMs' in patch) {
          const n = Number(patch.ackDelayMs)
          if (!Number.isInteger(n) || n < 0) return sendJSON(res, 400, { error: '回执等待须为不小于 0 的整数(毫秒;0 = 不发)' })
          raw.agent.ackDelayMs = n
        }
        // 时区是顶层配置(不在 agent 块):存前验 IANA 名;清空 = 回默认(Asia/Shanghai)
        if ('timezone' in patch) {
          const tz = String(patch.timezone || '').trim()
          if (tz && !isValidTz(tz)) return sendJSON(res, 400, { error: `无效时区名「${tz}」— 用 IANA 名,如 Asia/Shanghai、Asia/Tokyo、UTC` })
          if (tz) raw.timezone = tz; else delete raw.timezone
        }
        writeRaw(raw); return sendJSON(res, 200, await buildState())
      }
      // 公网地址(飞书登录回调的根):只认 https://host[:port],存归一后的值;空 = 关掉飞书登录入口。
      if (p === '/api/ui/public-url' && req.method === 'POST') {
        const { publicUrl } = await body(req); const raw = readRaw(); raw.ui = raw.ui || {}
        const t = String(publicUrl || '').trim()
        if (t) { const n = feishulogin.normalizePublicUrl(t); if (!n) return sendJSON(res, 400, { error: '公网地址要写成 https://域名(可带端口),不带路径' }); raw.ui.publicUrl = n } else delete raw.ui.publicUrl
        writeRaw(raw); return sendJSON(res, 200, await buildState())
      }
      if (p === '/api/ui/network' && req.method === 'POST') {
        const patch = await body(req); const raw = readRaw(); raw.ui = raw.ui || {}
        const previousHost = activeHost
        let nextHost = activeHost
        if (typeof patch.lanEnabled === 'boolean') {
          if (patch.lanEnabled && patch.password) {
            const password = String(patch.password)
            if (password.length < 6) return sendJSON(res, 400, { error: '访问密码至少 6 位' })
            raw.ui.auth = hashPassword(password)
          }
          if (patch.lanEnabled && !raw.ui.auth) return sendJSON(res, 400, { error: '开启局域网访问前要先设置访问密码' })
          if (patch.lanEnabled !== !loopbackBind) {
            nextHost = patch.lanEnabled ? '0.0.0.0' : '127.0.0.1'
            raw.ui.host = nextHost
          }
        }
        if (typeof patch.publicEnabled === 'boolean') {
          const wasEnabled = raw.ui.publicEnabled !== false
          if (patch.publicEnabled) {
            const fe = raw.feishu || {}; const publicUrl = feishulogin.normalizePublicUrl(raw.ui.publicUrl)
            const ready = feishulogin.feishuLoginReadiness({ publicUrl, appId: resolveRef(fe.appId), appSecret: resolveRef(fe.appSecret), admins: adminList(fe) })
            if (!ready.ready) return sendJSON(res, 400, { error: `公网登录尚未就绪：${ready.why}` })
          }
          raw.ui.publicEnabled = patch.publicEnabled
          if (wasEnabled && !patch.publicEnabled) {
            const n = sessions.revokeWhere((session) => session && session.via === 'feishu')
            if (n) audit.append({ kind: 'ui-public-access-revoked', sessions: n, ts: Date.now() })
          }
        }
        writeRaw(raw)
        audit.append({ kind: 'ui-network-settings', lan: nextHost !== '127.0.0.1', publicEnabled: raw.ui.publicEnabled !== false,
          hostChanged: nextHost !== previousHost, ts: Date.now() })
        if (nextHost !== previousHost) {
          const responseSocket = res.socket
          let rebindStarted = false
          const startRebind = () => {
            if (rebindStarted) return
            rebindStarted = true
            clearTimeout(rebindFallback)
            setImmediate(() => rebindHost(nextHost).catch((e) => {
              try {
                const latest = readRaw(); latest.ui = latest.ui || {}; latest.ui.host = previousHost
                writeRaw(latest)
              } catch (rollbackErr) { log('ui host rollback failed: ' + (rollbackErr && rollbackErr.message)) }
              audit.append({ kind: 'ui-network-rebind', ok: false, from: nextHost, to: previousHost, ts: Date.now() })
              log('ui host change failed: ' + (e && e.message))
            }))
          }
          // Wait for the switching response's connection to close before closing
          // the listener; a fixed delay can still reset the response under load.
          const rebindFallback = setTimeout(startRebind, 1000)
          if (rebindFallback.unref) rebindFallback.unref()
          if (responseSocket && !responseSocket.destroyed) responseSocket.once('close', startRebind)
          res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' })
          res.end(JSON.stringify({ ok: true, rebinding: true, lan: nextHost !== '127.0.0.1' }), () => {
            if (!responseSocket || responseSocket.destroyed) startRebind()
          })
          return
        }
        return sendJSON(res, 200, await buildState())
      }
      if (p === '/api/feishu' && req.method === 'POST') {
        const { appId, appSecret, botOpenId, adminOpenId, adminName, onlyWhenMentioned } = await body(req); const raw = readRaw()
        raw.feishu = raw.feishu || { onlyWhenMentioned: false }
        // Only overwrite on a non-empty value (symmetric with appSecret below): when appId is
        // an `env:VAR` ref, buildState renders the field blank, so a plain 保存 posts appId:'' —
        // `!= null` would silently wipe the env ref and break creds. Empty appId has no valid use.
        // 换了应用 ⇒ 缓存的身份属于上一个应用,留着会让顶栏和身份条显示错的应用名(比缺失更糟)。
        // 作废即可,不必在保存时联网重取:下一次「预检 / 刷新身份」会填上,期间显示「尚未获取」。
        if (appId && raw.feishu.appId && appId !== raw.feishu.appId) delete raw.feishu.identity
        if (appId) raw.feishu.appId = appId
        if (appSecret) raw.feishu.appSecret = appSecret
        // manual botOpenId entry must persist too, not just the auto-fetch path (审查 P1)
        if (typeof botOpenId === 'string') raw.feishu.botOpenId = botOpenId.trim()
        // operator/admin — auto-invited into every console-created chat
        if (typeof adminOpenId === 'string') raw.feishu.adminOpenId = adminOpenId.trim()
        if (typeof adminName === 'string') raw.feishu.adminName = adminName.trim()
        if (onlyWhenMentioned != null) raw.feishu.onlyWhenMentioned = !!onlyWhenMentioned
        writeRaw(raw); return sendJSON(res, 200, await buildState())
      }
      // ── Slack 应用(与上面飞书那组平级)────────────────────────────────────────
      // ⚠ 两个 token 都是**完整凭据**:xoxb 能以 bot 身份发消息,xapp 能开长连接。
      //   因此只写不读 —— buildState 只回 status,任何路径都不把明文送回浏览器。
      if (p === '/api/slack' && req.method === 'POST') {
        const { botToken, appToken, botUserId, onlyWhenMentioned, replyInThread, commandAlias } = await body(req)
        const raw = readRaw()
        raw.slack = raw.slack || {}
        // 与飞书那组同惯例:空值不覆盖(界面上密钥框恒显示为空,一次「保存」不该把已配的抹掉)
        if (botToken) {
          if (raw.slack.botToken && botToken !== raw.slack.botToken) delete raw.slack.identity // 换了 app ⇒ 缓存的身份属于上一个
          raw.slack.botToken = botToken.trim()
        }
        if (appToken) raw.slack.appToken = appToken.trim()
        if (typeof botUserId === 'string') raw.slack.botUserId = botUserId.trim()
        if (onlyWhenMentioned != null) raw.slack.onlyWhenMentioned = !!onlyWhenMentioned
        if (replyInThread != null) raw.slack.replyInThread = !!replyInThread
        if (typeof commandAlias === 'string' && commandAlias.trim()) raw.slack.commandAlias = commandAlias.trim().slice(0, 2)
        writeRaw(raw); return sendJSON(res, 200, await buildState())
      }
      // 一次把「能不能用」查清楚:凭据 / scope / Socket Mode / 已加入的频道。
      // ⭐ scope 那条最要紧 —— 缺 scope 的典型症状是**事件静默不来**,不主动对照只能靠猜。
      if (p === '/api/slack/precheck' && req.method === 'POST') {
        const raw = readRaw(); const sl = raw.slack || {}
        const bt = isEnvRef(sl.botToken) ? (process.env[String(sl.botToken).slice(4)] || '') : sl.botToken
        const at = isEnvRef(sl.appToken) ? (process.env[String(sl.appToken).slice(4)] || '') : sl.appToken
        if (!bt || !at) return sendJSON(res, 400, { error: '先填 xoxb- 与 xapp- 两个 token(env: 引用要求该变量在 daemon 环境里存在)' })
        try {
          const r = await slackPrecheck(bt, at)
          verify.recordPrecheck('slack', { botToken: bt, appToken: at }, r.checks, vopts)
          if (r.identity) { raw.slack.identity = r.identity; if (r.botUserId) raw.slack.botUserId = r.botUserId; writeRaw(raw) }
          return sendJSON(res, 200, r)
        } catch (e) { return sendJSON(res, 502, { error: (e && e.message) || String(e) }) }
      }
      // 绑群下拉的数据源:**bot 已加入的**频道(没 /invite 的频道绑了也收不到消息)
      if (p === '/api/slack/channels' && req.method === 'GET') {
        const raw = readRaw(); const sl = raw.slack || {}
        const bt = isEnvRef(sl.botToken) ? (process.env[String(sl.botToken).slice(4)] || '') : sl.botToken
        if (!bt) return sendJSON(res, 400, { error: '先配 Slack 的 xoxb- token' })
        try { return sendJSON(res, 200, { channels: await fetchSlackChannels(bt) }) }
        catch (e) { return sendJSON(res, 502, { error: (e && e.code) === 'missing_scope' ? '缺 channels:read / groups:read —— 改 manifest 后要重新安装' : ((e && e.message) || String(e)) }) }
      }
      // 应用身份(名称 / 描述 / 头像 / 启用状态)—— 只刷这一块,不跑整套预检。
      // **落盘缓存而不是每次渲染现拉**:控制台 60s 自动刷新 + 每次切页签都会重画,现拉就是
      // 每分钟一次飞书调用,而月调用量是这个租户的硬约束(2026-07 已撞过线)。与 adminName
      // 同惯例:远端来的展示数据落配置,点「预检 / 刷新」时才更新。
      if (p === '/api/feishu/appinfo' && req.method === 'POST') {
        const raw = readRaw(); const fe = raw.feishu || {}
        if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先填 appId/appSecret(明文)' })
        try {
          const id = await fetchAppIdentity(feishuClient(fe.appId, fe.appSecret), fe.appId)
          raw.feishu.identity = identityCache(id)
          if (id.openId && id.openId !== raw.feishu.botOpenId) raw.feishu.botOpenId = id.openId
          writeRaw(raw)
          return sendJSON(res, 200, { identity: raw.feishu.identity, botOpenId: raw.feishu.botOpenId || '' })
        } catch (e) { return sendJSON(res, 502, { error: larkErrMsg(e) }) }
      }
      if (p === '/api/feishu/botid' && req.method === 'POST') {
        const raw = readRaw(); const fe = raw.feishu || {}
        if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先填 appId/appSecret(明文)' })
        try { const oid = await fetchBotOpenId(feishuClient(fe.appId, fe.appSecret)); if (!oid) return sendJSON(res, 502, { error: '未取到 open_id' }); raw.feishu.botOpenId = oid; writeRaw(raw); return sendJSON(res, 200, { botOpenId: oid }) }
        catch (e) { return sendJSON(res, 502, { error: larkErrMsg(e) }) }
      }
      // One-pass Feishu readiness checklist: probe creds / bot identity /
      // scopes and return ✓/✗ rows so the setup card shows what to fix in one look.
      // Persists the botOpenId it discovers (same as /botid) so the field auto-fills.
      if (p === '/api/feishu/precheck' && req.method === 'POST') {
        const raw = readRaw(); const fe = raw.feishu || {}
        if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先填 appId/appSecret(明文)' })
        try {
          const r = await feishuPrecheck(feishuClient(fe.appId, fe.appSecret), { appId: fe.appId })
          verify.recordPrecheck('feishu', fe, r.checks, vopts)
          let dirty = false
          if (r.botOpenId && r.botOpenId !== raw.feishu.botOpenId) { raw.feishu.botOpenId = r.botOpenId; dirty = true }
          if (r.identity) { raw.feishu.identity = identityCache(r.identity); dirty = true }
          if (dirty) writeRaw(raw)
          return sendJSON(res, 200, { ...r, identity: raw.feishu.identity || null })
        } catch (e) { return sendJSON(res, 502, { error: larkErrMsg(e) }) }
      }
      // Admin candidates: non-bot members across the bot's chats → the
      // 「就是我」picker, so adminOpenId is chosen not hand-copied. Needs the bot in
      // at least one chat (the one manual step: 把 bot 拉进任意群).
      if (p === '/api/feishu/admin-candidates' && req.method === 'GET') {
        const raw = readRaw(); const fe = raw.feishu || {}
        if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先填 appId/appSecret(明文)' })
        try {
          const client = feishuClient(fe.appId, fe.appSecret)
          const botOpenId = fe.botOpenId || (await fetchBotOpenId(client).catch(() => null))
          const candidates = await fetchAdminCandidates(client, botOpenId)
          return sendJSON(res, 200, { candidates })
        } catch (e) { return sendJSON(res, 502, { error: larkErrMsg(e) }) }
      }
      // Org contacts — enumerate the whole address book (dept-tree walk) so the admin
      // picker can choose anyone, not just group members. Needs contact:department.
      // base:readonly + a user-read scope; a scope error surfaces via larkErrMsg.
      if (p === '/api/feishu/org-users' && req.method === 'GET') {
        const raw = readRaw(); const fe = raw.feishu || {}
        if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先填 appId/appSecret(明文)' })
        try { return sendJSON(res, 200, await fetchOrgUsers(feishuClient(fe.appId, fe.appSecret))) }
        catch (e) { return sendJSON(res, 502, { error: '拉取通讯录失败 — 需在开放平台开通 contact:department.base:readonly + 用户读权限并发版 · ' + larkErrMsg(e) }) }
      }
      // Resolve an admin's open_id from their email OR mobile — the way to
      // add an admin before the bot is in any group (no member candidates yet). Needs
      // the contact:user.id:readonly scope; a non-Feishu contact resolves to openId=null.
      if (p === '/api/feishu/resolve-contact' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim()
        if (!q) return sendJSON(res, 400, { error: '邮箱或手机号必填' })
        const raw = readRaw(); const fe = raw.feishu || {}
        if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先填 appId/appSecret(明文)' })
        try { return sendJSON(res, 200, await resolveContactToOpenId(feishuClient(fe.appId, fe.appSecret), q)) }
        catch (e) { return sendJSON(res, 502, { error: larkErrMsg(e) }) }
      }
      // Save the admins list (可多个). Replaces the whole list; migrates away from the
      // legacy single adminOpenId/adminName. Each entry is {openId, name}.
      if (p === '/api/feishu/admins' && req.method === 'POST') {
        const { admins } = await body(req); const raw = readRaw(); raw.feishu = raw.feishu || { onlyWhenMentioned: false }
        const seen = new Set()
        raw.feishu.admins = (Array.isArray(admins) ? admins : [])
          .filter((a) => a && typeof a.openId === 'string' && a.openId.trim())
          .map((a) => ({ openId: a.openId.trim(), name: String(a.name || '').trim() }))
          .filter((a) => (seen.has(a.openId) ? false : (seen.add(a.openId), true))) // dedup by openId
        delete raw.feishu.adminOpenId; delete raw.feishu.adminName // migrate off the single-admin fields
        writeRaw(raw); return sendJSON(res, 200, await buildState())
      }
      // 企业微信机器人凭据与选项(设置页「企业微信机器人」卡)。写回规矩与飞书 appSecret 完全一致:填了写明文、支持 env: 引用、
      // 空值不覆盖(botId 是 env: 引用时表单渲染为空,回传空串不能把引用冲掉)。names:{ userid: 显示名 },整体替换(表单是全量编辑)。
      if (p === '/api/wecom' && req.method === 'POST') {
        const { botId, secret, botName, welcome, names, pollSec, followSec, gatekeeper, keywords, cliOff } = await body(req); const raw = readRaw()
        raw.wecom = raw.wecom || {}
        // 点名词:数组或「逗号 / 顿号 / 空白」分隔的字串;空 = 回默认(删字段)。只认 1~20 个、每个 ≤ 20 字
        if (keywords !== undefined) {
          const arr = (Array.isArray(keywords) ? keywords : String(keywords || '').split(/[,,、\s]+/)).map((k) => String(k || '').trim()).filter(Boolean)
          if (arr.some((k) => k.length > 20) || arr.length > 20) return sendJSON(res, 400, { error: '点名词最多 20 个,每个不超过 20 字' })
          if (arr.length) raw.wecom.keywords = [...new Set(arr)]; else delete raw.wecom.keywords
        }
        // 命令行工具开关:关 = cli:false(不搜姓名 / 不发图 / 「不 @ 也回复」不生效);开 = 删掉 false(可执行名若是自定义字串不动)
        if (cliOff !== undefined) {
          if (cliOff === true || cliOff === 'true') raw.wecom.cli = false
          else if (raw.wecom.cli === false) delete raw.wecom.cli
        }
        // 第二道门:{ provider, model? };provider 空 / null = 关(删字段)。只认配置里存在的模型名,能不能用(有没有 key)由 doctor 的 wecom.gate 行报
        if (gatekeeper !== undefined) {
          const prov = gatekeeper && typeof gatekeeper === 'object' ? String(gatekeeper.provider || '').trim() : String(gatekeeper || '').trim()
          if (!prov) delete raw.wecom.gatekeeper
          else {
            if (!(raw.providers || {})[prov]) return sendJSON(res, 400, { error: `门控模型「${prov}」不在模型列表里` })
            const model = gatekeeper && typeof gatekeeper === 'object' ? String(gatekeeper.model || '').trim() : ''
            raw.wecom.gatekeeper = model ? { provider: prov, model } : { provider: prov }
          }
        }
        // 「不 @ 也回复」两档:数字就写(0 有意义:关 / 全喂),空串 = 回默认(删字段),非数字拒
        for (const [k, v] of [['pollSec', pollSec], ['followSec', followSec]]) {
          if (v === undefined) continue
          if (v === '' || v === null) { delete raw.wecom[k]; continue }
          const n = Number(v)
          if (!Number.isFinite(n) || n < 0) return sendJSON(res, 400, { error: `${k === 'pollSec' ? '轮询间隔' : '跟进窗口'}要是不小于 0 的秒数` })
          raw.wecom[k] = Math.round(n)
        }
        if (typeof botId === 'string' && botId.trim()) raw.wecom.botId = botId.trim()
        if (typeof secret === 'string' && secret.trim()) raw.wecom.secret = secret.trim()
        if (typeof botName === 'string') { if (botName.trim()) raw.wecom.botName = botName.trim(); else delete raw.wecom.botName }
        if (typeof welcome === 'string') { if (welcome.trim()) raw.wecom.welcome = welcome.trim(); else delete raw.wecom.welcome }
        if (names && typeof names === 'object' && !Array.isArray(names)) {
          const clean = {}
          for (const [k, v] of Object.entries(names)) { const kk = String(k || '').trim(), vv = String(v || '').trim(); if (kk && vv) clean[kk] = vv }
          if (Object.keys(clean).length) raw.wecom.names = clean; else delete raw.wecom.names
        }
        writeRaw(raw); return sendJSON(res, 200, await buildState())
      }
      // 企业微信预检:只调本机官方命令行工具(以机器人凭据授权过的那一份),**不另开长连接**(一个机器人只许一条,开了就把守护进程踢下线)。
      // 三行:凭据形状 · 工具装没装 · 工具授权能不能列出会话(顺带给出候选群数 —— 这就是「绑定群」弹窗能看到的那份)。
      // 长连接本身只有守护进程验得了,末尾一句指到概览的「企业微信连接」行。手动点按钮才跑,控制台自动刷新不碰它。
      // 刷新身份:企微没有「取机器人信息」接口 ⇒ 扫最近被 @ 过的几个群的历史,被 @ 最多的名字就是它,落进 wecom.botName(剥 @ / 点名 / 门控提示词都用它)
      if (p === '/api/wecom/identity' && req.method === 'POST') {
        const raw = readRaw(); const we = raw.wecom || {}
        if (!we.botId || !we.secret) return sendJSON(res, 400, { error: '先填 Bot ID / Secret' })
        if (we.cli === false) return sendJSON(res, 400, { error: '命令行工具已关闭,取不到群历史;先把「不用命令行工具」取消' })
        try {
          const cli = we.cli || 'wecom-cli'
          const wc = createWecomCli({ bin: cli, ...(wecomExec ? { exec: wecomExec } : {}) })
          // 正路:工具的身份接口直接给名字(10-12 调研确认是平台唯一能取到机器人名的地方)
          try {
            const who = await wc.whoami()
            const changed = we.botName !== who.bot.name
            raw.wecom = { ...we, botName: who.bot.name }; writeRaw(raw)
            return sendJSON(res, 200, { name: who.bot.name, botId: who.bot.id, user: who.user, source: 'identity', changed, state: await buildState() })
          } catch (e) { if (e && e.code === 'ENOENT') throw e /* 没装:下面也做不了 */ }
          // 退路(老版工具没有身份服务):扫最近几个群的历史,被 @ 最多的名字就是它
          const chats = (await listWecomSessions({ cli, ...(wecomExec ? { exec: wecomExec } : {}) })).slice(0, 5) // 最近 5 个群够用,每个群一次子进程
          const all = []
          for (const c of chats) { try { all.push(...(await wc.history(c.chatId))) } catch { /* 单个群拉不到不影响别的 */ } }
          const g = guessBotName(all)
          if (!g.name) return sendJSON(res, 200, { name: null, groups: chats.length, scanned: all.length, hint: chats.length ? '最近的群历史里没有人 @ 过它 —— 先在群里 @ 它说一句,再刷新' : '还没有机器人被 @ 过的群 —— 建群、把机器人加进去并 @ 一次' })
          const changed = we.botName !== g.name
          raw.wecom = { ...we, botName: g.name }; writeRaw(raw)
          return sendJSON(res, 200, { name: g.name, count: g.count, total: g.total, groups: chats.length, scanned: all.length, changed, source: 'history', state: await buildState() })
        } catch (e) { return sendJSON(res, 502, { error: (e && e.message) || String(e) }) }
      }
      if (p === '/api/wecom/precheck' && req.method === 'POST') {
        const raw = readRaw(); const we = raw.wecom || {}
        const checks = []
        const credOk = !!(we.botId && we.secret)
        checks.push({ status: credOk ? 'ok' : 'fail', label: '凭据', detail: credOk ? ((isEnvRef(we.botId) || isEnvRef(we.secret)) ? 'Bot ID / Secret 已配(环境变量引用,由守护进程解析)' : 'Bot ID / Secret 已配') : (we.botId ? '缺 Secret' : (we.secret ? '缺 Bot ID' : '缺 Bot ID 与 Secret')) })
        if (we.cli === false) {
          checks.push({ status: 'skip', label: '命令行工具', detail: '配置里已关闭 — 群里只显示成员账号,助手不能发图发文件' })
        } else {
          try {
            const chats = await listWecomSessions({ cli: we.cli || 'wecom-cli', ...(wecomExec ? { exec: wecomExec } : {}) })
            checks.push({ status: 'ok', label: '命令行工具', detail: '已安装并授权' })
            // 工具授权的是不是同一个机器人:不是 ⇒ 姓名照样查得到,但发图 / 发文件、这里列出的群都是另一个机器人的
            try {
              // 身份接口给名字 + ID(正路);老版工具没有就退回 auth show(只有 ID)
              let botId = null, botName = null, authorized = true
              try { const who = await createWecomCli({ bin: we.cli || 'wecom-cli', ...(wecomExec ? { exec: wecomExec } : {}) }).whoami(); botId = who.bot.id; botName = who.bot.name }
              catch { const a = await wecomAuthShow({ cli: we.cli || 'wecom-cli', ...(wecomExec ? { exec: wecomExec } : {}) }); authorized = a.authorized; botId = a.botId }
              const mine = resolveRef(we.botId)
              const tag = botId ? `${botId.slice(0, 6)}…${botId.slice(-4)}` : ''
              if (!authorized) checks.push({ status: 'fail', label: '工具授权身份', detail: '未授权 — 用这里填的 Bot ID / Secret 给命令行工具授权一次' })
              else if (botId && mine && botId !== mine) checks.push({ status: 'warn', label: '工具授权身份', detail: `授权给了另一个机器人(${botName ? botName + ' · ' : ''}${tag})— 成员姓名照常,但助手发的图 / 文件和下面列出的群都属于那个机器人;请用这里的凭据重新授权` })
              else checks.push({ status: 'ok', label: '工具授权身份', detail: botId ? `同一个机器人(${botName ? botName + ' · ' : ''}${tag})` : '已授权' })
            } catch (e) { checks.push({ status: 'warn', label: '工具授权身份', detail: '查不到授权状态:' + String((e && e.message) || e).slice(0, 120) }) }
            // 通讯录能力单独探一次:工具对「消息 / 通讯录」各有独立的 7 天授权,auth show 看不出;过期 = 群里查不到姓名
            try {
              await createWecomCli({ bin: we.cli || 'wecom-cli', ...(wecomExec ? { exec: wecomExec } : {}) }).findUser('a')
              checks.push({ status: 'ok', label: '通讯录授权', detail: '可查成员姓名(授权每 7 天一续,过期会进运维告警群)' })
            } catch (e) {
              const expired = e && String(e.code) === '850003'
              checks.push({ status: expired ? 'fail' : 'warn', label: '通讯录授权', detail: expired ? '已过期 — 请机器人创建者在企业微信里点续期链接;过期期间群里只显示成员账号' : '查不通:' + String((e && e.message) || e).slice(0, 120) })
            }
            checks.push({ status: chats.length ? 'ok' : 'warn', label: '可绑定的群', detail: chats.length ? `${chats.length} 个(机器人被 @ 过的群)` : '0 个 — 新群要先把机器人加进群并 @ 一次' })
          } catch (e) {
            const msg = (e && e.message) || String(e)
            if (/未安装/.test(msg)) checks.push({ status: 'warn', label: '命令行工具', detail: '未安装 — 群里只显示成员账号、助手不能发图发文件、这里列不出群(装好后按机器人凭据授权一次即可)' })
            else checks.push({ status: 'fail', label: '命令行工具', detail: '已安装但调不通:' + msg.slice(0, 160) + ' — 多半是没用机器人凭据授权,或授权已过期' })
          }
        }
        return sendJSON(res, 200, { checks, note: '长连接只有守护进程连得上(一个机器人只许一条),连接状态看「概览 → 企业微信连接」那一行' })
      }
      // 企业微信:候选 = 机器人被 @ 过的群(没有「bot 所在群」接口);群名同样顺手回写(企微群改名后下次打开选择器即同步)。
      // 与飞书那条各管各的 —— 双平台并存时弹窗按所选平台调对应接口。
      if (p === '/api/wecom/chats' && req.method === 'GET') {
        const raw = readRaw(); const we = raw.wecom || {}
        if (!we.botId || !we.secret) return sendJSON(res, 400, { error: '先在设置里填企业微信机器人的 Bot ID / Secret' })
        try {
          const chats = await listWecomSessions({ cli: we.cli || 'wecom-cli', ...(wecomExec ? { exec: wecomExec } : {}) })
          if (raw.groups) {
            const byId = new Map(chats.map((c) => [c.chatId, c.name]))
            let changed = 0
            for (const [cid, g] of Object.entries(raw.groups)) { const nm = byId.get(cid); if (nm && nm !== g.name) { g.name = nm; changed++ } }
            if (changed) writeRaw(raw)
          }
          return sendJSON(res, 200, { chats, hint: '企业微信只能列出机器人被 @ 过的群:新群要先把机器人加进去并 @ 一次,才会出现在这里' })
        } catch (e) { return sendJSON(res, 502, { error: (e && e.message) || String(e) }) }
      }
      if (p === '/api/feishu/chats' && req.method === 'GET') {
        const raw = readRaw(); const fe = raw.feishu || {}
        if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先在设置里填 appId/appSecret' })
        try {
          const chats = await fetchChats(feishuClient(fe.appId, fe.appSecret))
          // Self-healing display names: whenever the picker loads the
          // live chat list, sync bound groups' names — replaces the manual
          // 刷新群名 button (renames in Feishu get picked up on next open).
          if (raw.groups) {
            const byId = new Map(chats.map((c) => [c.chatId, c.name]))
            let changed = 0
            for (const [cid, g] of Object.entries(raw.groups)) {
              const nm = byId.get(cid)
              if (nm && nm !== g.name) { g.name = nm; changed++ }
            }
            if (changed) writeRaw(raw)
          }
          return sendJSON(res, 200, { chats })
        } catch (e) { return sendJSON(res, 502, { error: larkErrMsg(e) }) }
      }
      // Create a new Feishu group chat and return it so the console can pick it
      // without a re-list. `memberIds` = the admin open_ids the operator chose to
      // auto-invite (可选任意几个);a bot-only group is invisible in every Feishu
      // client, so if none were selected we fall back to ALL configured
      // admins to avoid an invisible group. Further members are invited inside Feishu.
      if (p === '/api/feishu/chats/create' && req.method === 'POST') {
        const { name, description, memberIds } = await body(req)
        if (!name || !name.trim()) return sendJSON(res, 400, { error: '群名称必填' })
        const raw = readRaw(); const fe = raw.feishu || {}
        if (!platformsConfigured(raw).feishu && platformsConfigured(raw).wecom) return sendJSON(res, 400, { error: WECOM_NO_API }) // 只配了企微:建群这件事平台上就没有
        if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先在设置里填 appId/appSecret' })
        const picked = Array.isArray(memberIds) ? memberIds.filter(Boolean) : []
        const members = [...new Set(picked.length ? picked : adminList(fe).map((a) => a.openId))]
        try { return sendJSON(res, 200, await createChat(feishuClient(fe.appId, fe.appSecret), name.trim(), description, members)) }
        catch (e) {
          const raw = larkErrMsg(e)
          // 232043 "bot is invisible to user ids" — 成员不在应用「可用范围」内(≠ 通讯录数据授权范围)。
          if (/invisible|232043|unavailable ids/i.test(raw)) {
            const named = adminList(fe).filter((a) => raw.includes(a.openId)).map((a) => a.name || a.openId)
            const who = named.length ? `(${named.join('、')})` : ''
            return sendJSON(res, 502, { error: `部分管理员${who}不在应用「可用范围」内,bot 拉不进群 —— 去开放平台「应用发布 → 可用范围」把 TA 加入(或设为全部员工),或建群时取消勾选 TA。\n原始:${raw}` })
          }
          return sendJSON(res, 502, { error: raw })
        }
      }
      // Members of one chat — the invite picker's candidate source.
      if (p === '/api/feishu/chat-members' && req.method === 'GET') {
        const chatId = url.searchParams.get('chatId')
        if (!chatId) return sendJSON(res, 400, { error: 'chatId 必填' })
        const raw = readRaw(); const fe = raw.feishu || {}
        if (chatPlatformOf(raw, chatId) === 'wecom') return sendJSON(res, 400, { error: WECOM_NO_API }) // 企微群:成员列表 / 拉人没有接口
        if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先在设置里填 appId/appSecret' })
        try { return sendJSON(res, 200, { members: await fetchChatMembers(feishuClient(fe.appId, fe.appSecret), chatId) }) }
        catch (e) { return sendJSON(res, 502, { error: larkErrMsg(e) }) }
      }
      // Invite members into an existing chat.
      if (p === '/api/feishu/chats/members' && req.method === 'POST') {
        const { chatId, memberIds } = await body(req)
        if (!chatId || !Array.isArray(memberIds) || !memberIds.filter(Boolean).length) return sendJSON(res, 400, { error: 'chatId 与 memberIds 必填' })
        const raw = readRaw(); const fe = raw.feishu || {}
        if (chatPlatformOf(raw, chatId) === 'wecom') return sendJSON(res, 400, { error: WECOM_NO_API })
        if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先在设置里填 appId/appSecret' })
        try { await addChatMembers(feishuClient(fe.appId, fe.appSecret), chatId, memberIds.filter(Boolean)); return sendJSON(res, 200, { ok: true, added: memberIds.filter(Boolean).length }) }
        catch (e) { return sendJSON(res, 502, { error: larkErrMsg(e) }) }
      }
      // Disband a chat — safety model:
      //   1. only a BOUND chat may be disbanded (sbot's own turf; enforced here,
      //      not just hidden in the UI). Success removes the binding atomically.
      //   2. STRICT two-phase for every disband: phase 1 issues a one-time token
      //      (10 min); other users present ⇒ in-group notice + 30s cool-down,
      //      both server-enforced. Phase 2 (&confirm=1&dtoken=…) validates the
      //      token/cool-down before touching anything.
      //   3. empty / admin-only chat: token flow too, but zero cool-down — the
      //      console chains the two calls so it stays one interaction.
      //   4. both phases are appended to ~/.sbot/audit.jsonl.
      if (p === '/api/feishu/chats' && req.method === 'DELETE') {
        const chatId = url.searchParams.get('chatId')
        const confirmed = url.searchParams.get('confirm') === '1'
        const dtoken = url.searchParams.get('dtoken') || ''
        if (!chatId) return sendJSON(res, 400, { error: 'chatId 必填' })
        const raw = readRaw(); const fe = raw.feishu || {}
        if (chatPlatformOf(raw, chatId) === 'wecom') return sendJSON(res, 400, { error: WECOM_NO_API }) // 企微群:解散本就没有接口
        const bound = raw.groups && raw.groups[chatId]
        if (!bound) return sendJSON(res, 400, { error: '仅已绑定的群可从控制台解散 — 未绑定的群不在本产品管辖内' })

        if (confirmed) { // phase 2 — token/cool-down gate BEFORE any credential use
          const pend = disbandPending.get(chatId)
          if (!pend || !dtoken || pend.token !== dtoken) return sendJSON(res, 400, { error: '解散确认无效 — 请重新发起解散' })
          if (Date.now() > pend.expiresAt) { disbandPending.delete(chatId); return sendJSON(res, 400, { error: '解散确认已过期(10 分钟)— 请重新发起' }) }
          if (Date.now() < pend.readyAt) return sendJSON(res, 400, { error: `冷静期未过 — 还需 ${Math.ceil((pend.readyAt - Date.now()) / 1000)}s(给群成员留出看到预告的时间)` })
          if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先在设置里填 appId/appSecret' })
          try {
            await deleteChat(feishuClient(fe.appId, fe.appSecret), chatId)
            disbandPending.delete(chatId)
            delete raw.groups[chatId]
            writeRaw(raw) // hot-reloads the daemon — binding gone with the group
            audit.append({ kind: 'disband-confirmed', chatId, name: bound.name || '', users: pend.users, ts: Date.now() })
            return sendJSON(res, 200, { ...(await buildState()), ok: true, unbound: true })
          } catch (e) { return sendJSON(res, 502, { error: '解散失败: ' + larkErrMsg(e) }) }
        }

        // phase 1 — reuse a still-valid pending request (don't spam the group
        // with repeated notices), else fetch members, notify, arm the token.
        const prev = disbandPending.get(chatId)
        if (prev && Date.now() < prev.expiresAt) {
          return sendJSON(res, 200, { needConfirm: true, users: prev.users, names: prev.names, disbandToken: prev.token, coolDownSec: Math.max(0, Math.ceil((prev.readyAt - Date.now()) / 1000)), reused: true })
        }
        if (!fe.appId || !fe.appSecret || isEnvRef(fe.appId) || isEnvRef(fe.appSecret)) return sendJSON(res, 400, { error: '先在设置里填 appId/appSecret' })
        const client = feishuClient(fe.appId, fe.appSecret)
        try {
          const members = await fetchChatMembers(client, chatId)
          const adminSet = new Set(adminList(fe).map((a) => a.openId))
          const others = members.filter((m) => !adminSet.has(m.openId))
          const coolDownSec = others.length ? 30 : 0
          const pend = { token: crypto.randomBytes(12).toString('hex'), readyAt: Date.now() + coolDownSec * 1000, expiresAt: Date.now() + 10 * 60_000, users: others.length, names: others.slice(0, 10).map((m) => m.name) }
          if (others.length) await sendChatText(client, chatId, `⚠ 管理员即将解散本群(绑定项目将一并解除),${coolDownSec}s 后可执行。如有异议请立即联系管理员。`)
          disbandPending.set(chatId, pend)
          audit.append({ kind: 'disband-request', chatId, name: bound.name || '', users: others.length, coolDownSec, ts: Date.now() })
          return sendJSON(res, 200, { needConfirm: true, users: pend.users, names: pend.names, disbandToken: pend.token, coolDownSec, notified: others.length > 0 })
        } catch (e) { return sendJSON(res, 502, { error: '解散失败: ' + larkErrMsg(e) }) }
      }
      // ⚠ 项目根目录在控制台**只读**(产品决定):它是围栏的策略,谁登上控制台谁就能改的话,围栏只剩
      //   一次点击的距离。故意**没有**写接口 —— 只藏按钮不够,拿到令牌照样能 POST。修改只走两条路:安装向导,
      //   或在机器上改配置文件的 projectsRoots(daemon watchFile 热重载、控制台每请求现读 ⇒ 即时生效)。
      //   tests/unit/uiserver.test.js 钉着 POST /api/projects-roots 与 …/create 必须 404。
      // 目录浏览:只列目录、一层一层来,**围在项目根目录之内**(根从配置 projectsRoots 现读,
      // 改配置即生效;默认根缺失时自动建,配置指定的根不建)。越界的 path 夹回根,不报错 —— 浏览器里
      // 「回到根」比「读取失败」更像一个选目录的控件该有的样子。
      if (p === '/api/fs/listdir' && req.method === 'GET') {
        const target = url.searchParams.get('path') || ''
        try { const info = projectsroot.resolveProjectsRoots(readRaw()); return sendJSON(res, 200, listDirs(target, info.roots, { createMissing: !info.fromConfig })) }
        catch (e) { return sendJSON(res, 400, { error: (e && e.message) || String(e) }) }
      }
      // 在根目录之内新建项目文件夹(围栏同上)
      if (p === '/api/fs/mkdir' && req.method === 'POST') {
        const { parent, name } = await body(req)
        try { const info = projectsroot.resolveProjectsRoots(readRaw()); return sendJSON(res, 200, makeDir(parent, name, info.roots, { createMissing: !info.fromConfig })) }
        catch (e) { return sendJSON(res, 400, { error: (e && e.message) || String(e) }) }
      }
      if (p === '/api/groups' && req.method === 'POST') {
        const { chatId, workdir: workdirIn, provider, model, name, platform } = await body(req)
        if (!chatId || !workdirIn) return sendJSON(res, 400, { error: 'chatId 与 workdir 必填' })
        if (platform !== undefined && platform !== '' && !PLATFORMS.includes(platform)) return sendJSON(res, 400, { error: `platform 只认 ${PLATFORMS.join(' / ')}` })
        // 显式平台与 id 形态打架(oc_ 标企微 / wr… 标飞书)一定是弹窗档位没切对,不替人猜、直接拒(对抗审查:改既有群时会把企微群改写成飞书)
        // ⚠ Slack 形态不拿来拒:企微单聊 userid 可能恰好长成 C…/D… 大写串,只有 oc_ / wr 这两种强形态才判冲突
        if (PLATFORMS.includes(platform) && inferChatPlatform(chatId) && inferChatPlatform(chatId) !== 'slack' && inferChatPlatform(chatId) !== platform) return sendJSON(res, 400, { error: `这个群 id 看着是${inferChatPlatform(chatId) === 'wecom' ? '企业微信' : '飞书'}的,与所选平台不符 — 在弹窗顶部切到对的平台再保存` })
        // 只收规范的绝对路径(认 `~`,存展开后的):相对路径会随 daemon 的 cwd 漂;含 `.`/`..` 段或重复分隔符的写法直接拒,
        // 不替人猜 —— `proj/link/..` 字面在根内、内核在链接指向处,存下这个字符串等于把围栏交给内核去反着解释(对抗审查 🔴)。
        const wd = projectsroot.workdirInput(String(workdirIn))
        if (wd.error) return sendJSON(res, 400, { error: wd.error })
        const workdir = wd.path
        // Fail here, not at the first task: a binding to a missing
        // directory would only surface when a turn tries to run in it.
        if (!fs.existsSync(workdir)) return sendJSON(res, 400, { error: `workdir 不存在: ${workdir}` })
        const raw = readRaw(); raw.groups = raw.groups || {}; delete raw.groups.oc_example_chat_id
        // 已绑定的群重存:旧对象在下面整个展开再覆盖(见 next),这里只是取出来比目录有没有改
        const prev = raw.groups[chatId] || {}
        // 项目根目录围栏(src/projectsroot.js):只对**新的或改过的**目录判 —— 配置文件里手写的越界老绑定
        // 原样保留(doctor 出 warn),否则只想换个模型的保存也会被拦。选择器那侧的围栏在这儿必须重跑一遍:
        // 文本框能手填任意路径,受理侧的围栏管不到执行侧(2026-09-08 复核时这里只查了「目录存在」)。
        // 「没改」按内核语义比(realpath 之后),不按字面:字面相等而 realpath 不同的写法上面已经拒了,这里是第二道
        if (!prev.workdir || !projectsroot.samePath(workdir, prev.workdir)) {
          const info = projectsroot.resolveProjectsRoots(raw)
          if (!projectsroot.withinRoots(workdir, info.roots)) return sendJSON(res, 400, { error: `项目目录须在项目根目录下(${projectsroot.describeRoots(info.roots)}):${workdir}` })
        }
        const isNewBinding = !prev.workdir
        // ⚠ 从旧对象展开再覆盖,不从头重建:本接口只管目录 / 模型 / 名字,这个群的其它配置(permissionMode /
        //   repo / plugins / crons / board / redactPii / preview / paused …)各有各的接口写入。此前这里 `{ workdir, provider }`
        //   起手、逐个挑字段保留 —— 只记得工具白名单与名字,其余对已绑定的群点一次「保存修改」就整个丢掉:完全访问
        //   退回只读、画布解绑、定时任务消失、远端断开,而界面上看不出任何异常(2026-09-09 复现,uiserver 单测钉住)。
        //   逐个挑必然再漏(每加一个群级字段都得回来补一行);展开旧对象才是「没碰的就不动」。
        const next = { ...prev, workdir, provider: provider || prev.provider || raw.defaultProvider }
        // 钉住的模型(groups[].model)是型号 id、各家不同:显式给了就用;没给时同一家照留(展开已带上),
        // 换了家必须丢 —— 把上一家的型号 id 带到新家,等于每轮都指定一个不存在的模型。
        if (model) next.model = model
        else if (!isNewBinding && next.provider !== (prev.provider || raw.defaultProvider)) delete next.model
        // 群的显示名来自飞书群列表,卡片 / 概览靠它代替不可读的 chatId;没发来就沿用旧的(展开已带上)
        if (name) next.name = name
        // 群属于哪个平台(双平台并存):弹窗显式给了就写;没给沿用旧的;都没有按 id 形态 / 只配了一个平台推断后**写进配置**
        // —— 老配置缺这个字段靠推断在跑,控制台重新保存一次就把它钉死(doctor 那行提示的出路就是这里)
        // ⚠ 不按「那个平台配了凭据没」拒绝:纯配置模式(先绑群、后填凭据)一直是允许的;没配的平台由 doctor 的群行报「收不到消息」
        next.platform = PLATFORMS.includes(platform) ? platform : chatPlatformOf(raw, chatId)
        raw.groups[chatId] = next
        writeRaw(raw)
        // First-time binding: drop a confirmation into the group (best-effort) so a
        // fresh chat is immediately alive and members know how to use it.
        let notified = false, noticeQueued = false // notified = 真送达(飞书 await 判);noticeQueued = 已交 daemon 发(企微 fire-and-forget,送没送到只有日志知道)
        const fe = raw.feishu || {}
        const sl = raw.slack || {}
        if (isNewBinding && next.platform === 'slack') {
          const bt = isEnvRef(sl.botToken) ? (process.env[String(sl.botToken).slice(4)] || '') : sl.botToken
          if (bt) {
            try { await sendSlackText(bt, chatId, bindNoticeText(workdir, 'slack', `${sl.commandAlias || '!'}help`)); notified = true }
            catch (e) { log('bind notice failed (slack): ' + ((e && e.message) || e)) }
          }
        }
        if (isNewBinding && next.platform === 'feishu' && fe.appId && fe.appSecret && !isEnvRef(fe.appId) && !isEnvRef(fe.appSecret)) {
          try { await sendChatText(feishuClient(fe.appId, fe.appSecret), chatId, bindNoticeText(workdir, 'feishu')); notified = true }
          catch (e) { log('bind notice failed: ' + larkErrMsg(e)) }
        }
        // 企微群:控制台自己没有机器人的长连接(一个机器人只许一条),绑定通知只能借 daemon 的那条发;`sbot ui` 独立态发不了
        if (isNewBinding && next.platform === 'wecom' && control && control.notifyGroup) {
          try { control.notifyGroup(chatId, bindNoticeText(workdir, 'wecom')); noticeQueued = true } catch (e) { log('bind notice failed: ' + (e && e.message)) }
        }
        return sendJSON(res, 200, { ...(await buildState()), notified, noticeQueued })
      }
      if (p === '/api/groups' && req.method === 'DELETE') {
        const chatId = url.searchParams.get('chatId'); const raw = readRaw()
        if (raw.groups) delete raw.groups[chatId]
        writeRaw(raw); return sendJSON(res, 200, await buildState())
      }
      // 群项目的 git 远端(可空)。场景 = 本地已有代码、远端是刚建的空仓库,填地址是为了往上推,
      // 所以这里只建立关联(git init + origin,幂等),不 clone、不 commit/push —— 推什么、
      // 怎么写 commit 由 agent 判断。清空地址只解除配置记录,不动 workdir 里的 git。
      if (p === '/api/groups/repo' && req.method === 'POST') {
        const { chatId, repo } = await body(req)
        const raw = readRaw()
        const g = raw.groups && raw.groups[chatId]
        if (!g) return sendJSON(res, 400, { error: '未找到该群绑定' })
        const url2 = String(repo == null ? '' : repo).trim()
        if (!url2) { // 清空 = 解除关联记录
          delete g.repo; writeRaw(raw)
          return sendJSON(res, 200, { ...(await buildState()), cleared: true })
        }
        const r = await gitrepo.linkRepo(g.workdir, url2)
        if (!r.ok) return sendJSON(res, 400, { error: r.error })
        g.repo = r.url
        writeRaw(raw)
        // 与模型/权限/插件变更同源:daemon 在跑时往群里同步一条精简通知
        if (control && control.notifyGroup) {
          notifyGroup(chatId, `📦 本群项目已关联代码仓库:${r.url}${r.initialized ? '(已在项目目录初始化 git)' : ''}`)
        }
        return sendJSON(res, 200, { ...(await buildState()), initialized: r.initialized, replaced: r.replaced, branch: r.branch })
      }
      // 连通性 + 权限探测:ls-remote 不落地任何东西。凭据/主机密钥是这条链路最常见的两种挂法,
      // 错误已翻成人话(见 gitrepo.humanizeGitError),省得 operator 对着英文 stderr 猜。
      if (p === '/api/groups/repo/test' && req.method === 'POST') {
        const { repo } = await body(req)
        const r = await gitrepo.testRemote(repo)
        return sendJSON(res, r.ok ? 200 : 400, r.ok ? { ok: true, branches: r.branches, empty: r.empty } : { error: r.error })
      }
      // per-project permissions: set this group's allow/deny (scoped to its workdir)
      // and/or its permissionMode override (only the two never-hang
      // modes are accepted; 'default'/'acceptEdits' would hang a headless turn).
      // writeRaw hot-reloads the daemon → the new policy applies on the group's next turn.
      if (p === '/api/groups/policy' && req.method === 'POST') {
        const { chatId, allowedTools, disallowedTools, permissionMode } = await body(req); const raw = readRaw()
        if (!raw.groups || !raw.groups[chatId]) return sendJSON(res, 404, { error: 'no such group' })
        if (Array.isArray(allowedTools)) raw.groups[chatId].allowedTools = allowedTools
        if (Array.isArray(disallowedTools)) raw.groups[chatId].disallowedTools = disallowedTools
        if (permissionMode !== undefined) {
          if (permissionMode && permissionMode !== 'dontAsk' && permissionMode !== 'bypassPermissions') {
            return sendJSON(res, 400, { error: '按群执行模式仅支持 dontAsk / bypassPermissions — 其余模式在无头下会挂起等待审批' })
          }
          if (permissionMode) raw.groups[chatId].permissionMode = permissionMode
          else delete raw.groups[chatId].permissionMode // '' = 清除覆盖 → 默认 dontAsk(只读,fail-closed)
        }
        writeRaw(raw)
        if (control && control.notifyGroup) {
          const t = permissionMode === 'bypassPermissions' ? '⚠ 本群已切到完全访问(可执行任意命令)'
            : (permissionMode === 'dontAsk' || permissionMode === '') ? '🔧 本群已切到受限模式(白名单/只读)'
            : '🔧 本群工具权限已更新'
          notifyGroup(chatId, t)
        }
        return sendJSON(res, 200, await buildState())
      }
      // Codex 忙时跟进默认开启；显式 false 才关闭。当前轮按启动时配置运行。
      // providerOf 覆盖运行时模型切换/额度回退，因此必须以实际有效 runner 校验。
      if ((p === '/api/groups/steer' || p === '/api/groups/codex-steer') && req.method === 'POST') {
        const { chatId, enabled } = await body(req); const raw = readRaw()
        if (!chatId || !raw.groups || !raw.groups[chatId]) return sendJSON(res, 404, { error: 'no such group' })
        if (typeof enabled !== 'boolean') return sendJSON(res, 400, { error: 'enabled 必须为布尔值' })
        const name = (control && control.providerOf && control.providerOf(chatId)) || raw.groups[chatId].provider || raw.defaultProvider || loadConfig(configPath).defaultProvider
        const provider = { ...DEFAULTS.providers, ...(raw.providers || {}) }[name]
        if (p === '/api/groups/codex-steer' && (!provider || provider.runner !== 'codex')) return sendJSON(res, 400, { error: '仅实际使用 Codex 的群项目可开启忙时跟进' })
        raw.groups[chatId].steer = enabled
        delete raw.groups[chatId].codexSteer
        writeRaw(raw)
        return sendJSON(res, 200, await buildState())
      }
      // 暂停/恢复(完全可逆,配置全保留):paused=true ⇒ 该群消息静默丢弃(engine 拦截+推水位线)、
      // 排队清空、cron 到点跳过、画布轮询跳过、升级播报跳过;进行中的轮跑完不中断(/stop 兜底已有)。
      // 落盘只写 true 一种情况(恢复=删字段,配置不长毛);热重载即生效。通知发在写回后 —— 出站
      // platform.send 不受 paused 拦截(拦的是入站),两条通知都能到群。
      if (p === '/api/groups/pause' && req.method === 'POST') {
        const { chatId, paused } = await body(req); const raw = readRaw()
        if (!chatId || !raw.groups || !raw.groups[chatId]) return sendJSON(res, 404, { error: 'no such group' })
        if (paused) raw.groups[chatId].paused = true
        else delete raw.groups[chatId].paused
        writeRaw(raw)
        audit.append({ kind: 'group-pause', chatId, paused: !!paused, ts: Date.now() })
        // force:暂停/恢复动作本身的告知必须送达(暂停后群唯一还会收到的一条)
        notifyGroup(chatId, paused
          ? '⏸ 本群项目已暂停 — 期间消息不处理,定时任务与画布播报停发;恢复请到控制台'
          : '▶ 本群项目已恢复', { force: true })
        return sendJSON(res, 200, await buildState())
      }
      // 群预览策略(按群覆盖顶层 preview)。**这是 operator 的正规入口** —— 真机(2026-07-30)群里
      // 要求「随时都能打开」,agent 就自己造了份配置用 --config 把回收全关;禁掉那条绕法之后,
      // 合理需求必须有正规出口,否则它还会再找别的绕法。「要不要长期把一个目录暴露在局域网」
      // 是 operator 的决定,不该被一句话说服。
      if (p === '/api/groups/preview' && req.method === 'POST') {
        const { chatId, persist } = await body(req); const raw = readRaw()
        if (!chatId || !raw.groups || !raw.groups[chatId]) return sendJSON(res, 404, { error: 'no such group' })
        const g = raw.groups[chatId]
        // ⚠ 合并而非整块替换:operator 可能手配过该群的其它预览字段(host/portFrom…),
        // 整块写会把它们抹掉。取消常驻时只摘掉这两个键,块空了才删。
        if (persist) g.preview = { ...(g.preview || {}), idleMin: 0, maxHours: 0 }
        else if (g.preview) {
          delete g.preview.idleMin; delete g.preview.maxHours
          if (!Object.keys(g.preview).length) delete g.preview
        }
        writeRaw(raw)
        audit.append({ kind: 'group-preview', chatId, persist: !!persist, ts: Date.now() })
        // 文案按**生效后的实际策略**算,别硬编码「30 分钟 / 8 小时」—— operator 配过顶层
        // preview 时那就是假话。v0.9.3 起策略对在跑的预览也立刻生效(收割器现读配置),
        // 所以这里可以把「包括正在跑的那个」写实:此前勾了常驻它照样到点停,通知等于骗人。
        const eff = preview.normalizeOptions(raw.preview, raw.groups[chatId].preview)
        notifyGroup(chatId, persist
          ? '🔓 本群预览已设为常驻(不再按闲置或时长自动停止,正在跑的那个也一并生效)—— 用完请说一声关掉,别让它一直挂在局域网上'
          : `🔒 本群预览已回到默认回收策略(${eff.idleMin > 0 ? `闲置 ${eff.idleMin} 分钟` : '不按闲置回收'} / ${eff.maxHours > 0 ? `最长 ${eff.maxHours} 小时` : '不限时长'})`)
        return sendJSON(res, 200, await buildState())
      }
      // 群数据明文开关:业务数据群里手机号/邮箱就是用户要查的内容本身,被出站
      // 脱敏遮成 ‹redacted:phone› 反而把人逼去截图绕行(2026-08-04 真机)。**只放行 PII 类,
      // 密钥类没有开关**(凭据出现在群里只能是事故)。「这个群的数据能不能见光」是 operator
      // 的决定 —— 与 preview 常驻同理,agent 不能自己开。改动即通知群(配置变更群内同步惯例)。
      if (p === '/api/groups/redact' && req.method === 'POST') {
        const { chatId, showPii } = await body(req); const raw = readRaw()
        if (!chatId || !raw.groups || !raw.groups[chatId]) return sendJSON(res, 404, { error: 'no such group' })
        const g = raw.groups[chatId]
        if (showPii) g.redactPii = false
        else delete g.redactPii // 关掉 = 回默认遮盖,配置里不留字段(完全可逆惯例)
        writeRaw(raw)
        audit.append({ kind: 'group-redact', chatId, showPii: !!showPii, ts: Date.now() })
        notifyGroup(chatId, showPii
          ? '🔓 本群已设为数据明文输出:回复里的手机号/邮箱将原样显示(密钥类信息仍会自动遮盖)'
          : '🔒 本群已恢复数据遮盖:回复里的手机号/邮箱将显示为遮盖标记')
        return sendJSON(res, 200, await buildState())
      }
      // 「需要你处理」里忽略一条。只有失败轮次能忽略:其余几类各有自己的处理路径(反馈本标已处理、
      // 结束进程、停预览),在这里「忽略」只会把还在的问题藏起来。只回收件箱,前端只重画这一块。
      if (p === '/api/inbox/dismiss' && req.method === 'POST') {
        const { key } = await body(req)
        if (typeof key !== 'string' || !key.startsWith('failed:') || key.length > 300) return sendJSON(res, 400, { error: '这一条不能忽略' })
        inboxDismiss.add(key)
        return sendJSON(res, 200, { inbox: await inboxOnly() })
      }
      // 群预览服务:手动停一个(概览「预览服务」区的停止按钮)。控制台停 ⇒ **发群一行告知**
      // (群成员可能正开着那个链接,悄悄拔掉会让人以为 bot 坏了);记录由这里写 —— 「谁杀谁写」。
      if (p === '/api/previews/stop' && req.method === 'POST') {
        const { id } = await body(req)
        const dir = preview.previewDir()
        const hit = preview.listRecords(dir).find((r) => r.id === id && preview.isLive(r))
        if (!hit) return sendJSON(res, 404, { error: '没有这个运行中的预览(可能刚被回收)' })
        preview.markStopped(dir, hit, 'console', { notify: false }) // 先落判定再杀;通知这里直接发,不劳 reaper 重试
        preview.killWorker(hit.pid)
        audit.append({ kind: 'preview-stop', id, chatId: hit.chatId, port: hit.port, ts: Date.now() })
        // ⚠ 文案里含 label —— 那是 **agent 提供的文本**,与群回复同款过 redact(其它控制台通知的文案
        // 都是 operator 写死的字符串,这条是第一条带外部输入的)
        notifyGroup(hit.chatId, redact(preview.buildStoppedMessage(hit, 'console')))
        return sendJSON(res, 200, await buildState())
      }
      // 遗留进程:一键结束(概览「后台进程」区的按钮)。只认 pid 列表,但**不直接照单杀** ——
      // 先不走缓存重新列一遍,只杀此刻仍在遗留名单里的 pid:页面上那份名单最多是 30 秒前的,
      // 其间进程可能自己退了、pid 被系统发给别的东西,照单 kill 就是误杀无辜进程。名单外的
      // pid 整单拒绝(400)而不是跳过:请求与实际动作不一致时,静默少杀几个会让人以为都结束了。
      // 审计记 summary 而不是完整命令行(与 state 同一口径);杀完清缓存,返回的状态立刻是新的。
      if (p === '/api/leftovers/kill' && req.method === 'POST') {
        const b = await body(req)
        const pids = [...new Set((Array.isArray(b.pids) ? b.pids : []).map(Number).filter((n) => Number.isInteger(n) && n > 1))]
        if (!pids.length) return sendJSON(res, 400, { error: '没有指定要结束的进程' })
        const cur = await leftover.list()
        if (!cur.supported) return sendJSON(res, 400, { error: '这台机器不支持查看后台进程' })
        if (cur.error) return sendJSON(res, 500, { error: `查不了后台进程:${cur.error}` })
        const byPid = new Map(cur.rows.map((r) => [r.pid, r]))
        const stale = pids.filter((pid) => !byPid.has(pid))
        if (stale.length) return sendJSON(res, 400, { error: `有 ${stale.length} 个进程已经不在后台进程名单里(可能刚自己退出了),为防误杀没有动任何进程 —— 刷新后再试` })
        const r = await leftover.kill(pids)
        audit.append({ kind: 'leftover-kill', pids, summaries: pids.map((pid) => byPid.get(pid).summary), killed: r.killed, failed: r.failed, ts: Date.now() })
        leftover.clearCache()
        if (r.failed.length) return sendJSON(res, 500, { error: `有 ${r.failed.length} 个进程没能结束(${r.failed.map((f) => f.error).join('; ')})` })
        return sendJSON(res, 200, await buildState())
      }
      // 定时任务(定时任务基础技能): per-group crons at groups[chatId].crons. Same store as the
      // CLI `sbot cron`; the daemon's scheduler picks changes up via config hot-reload. Server is
      // single-threaded so readRaw→writeRaw here is atomic per-request (the CLI uses a file lock
      // for cross-process concurrency). crons are scoped to their own group — no cross-group reach.
      if (p === '/api/groups/cron/add' && req.method === 'POST') {
        const { chatId, expr, at, kind, text, note } = await body(req); const raw = readRaw()
        if (!chatId || !raw.groups || !raw.groups[chatId]) return sendJSON(res, 404, { error: 'no such group' })
        if (kind !== 'do' && kind !== 'say' && kind !== 'run') return sendJSON(res, 400, { error: 'kind 须为 do(触发 agent)、say(只发消息)或 run(跑脚本)' })
        if (!text || !String(text).trim()) return sendJSON(res, 400, { error: kind === 'do' ? '指令内容必填' : kind === 'run' ? '命令必填' : '消息文本必填' })
        // at(一次性,YYYY-MM-DD HH:mm) 与 expr(循环 cron) 二选一
        let when
        // 简写展开成绝对时间(只填 10:20 → 今天;07-16 10:20 → 今年;完整日期照旧),存绝对值,
        // 显示层再相对化。用群时区定位「今天/明天」。
        if (at) { try { when = { at: expandAt(at, Date.now(), normalizeTz(raw.timezone)), once: true } } catch (e) { return sendJSON(res, 400, { error: e && e.message }) } }
        else { try { when = { expr: normalizeCron(expr) } } catch (e) { return sendJSON(res, 400, { error: (e && e.message) || 'cron 表达式无效' }) } }
        const g = raw.groups[chatId]; g.crons = Array.isArray(g.crons) ? g.crons : []
        const task = { id: crypto.randomBytes(4).toString('hex'), ...when, kind, text: String(text), enabled: true }
        if (note && String(note).trim()) task.note = String(note).trim()
        if (cronRecoveryEnabled || raw._c2CronRecovery?.enabled === true) {
          qualifyFuture(task, Date.now(), normalizeTz(raw.timezone))
        }
        g.crons.push(task); writeRaw(raw)
        return sendJSON(res, 200, await buildState())
      }
      if (p === '/api/groups/cron/toggle' && req.method === 'POST') {
        const { chatId, id, enabled } = await body(req); const raw = readRaw()
        const g = raw.groups && raw.groups[chatId]
        const c = g && Array.isArray(g.crons) && g.crons.find((x) => x.id === id)
        if (!c) return sendJSON(res, 404, { error: 'no such cron' })
        c.enabled = !!enabled
        if (cronRecoveryEnabled || raw._c2CronRecovery?.enabled === true) {
          qualifyFuture(c, Date.now(), normalizeTz(raw.timezone))
        } else delete c.c2RecoveryKey
        writeRaw(raw)
        return sendJSON(res, 200, await buildState())
      }
      if (p === '/api/groups/cron/remove' && req.method === 'POST') {
        const { chatId, id } = await body(req); const raw = readRaw()
        const g = raw.groups && raw.groups[chatId]
        if (!g || !Array.isArray(g.crons)) return sendJSON(res, 404, { error: 'no such group' })
        const i = g.crons.findIndex((x) => x.id === id)
        if (i < 0) return sendJSON(res, 404, { error: 'no such cron' })
        g.crons.splice(i, 1); writeRaw(raw)
        return sendJSON(res, 200, await buildState())
      }
      // Plugin discovery: the machine's global library, plus — when
      // chatId is given — that group's project-level plugins and enablement state.
      // 风格库(只读):内置预设(assets/design-styles/,数量随版本增删)+ ~/.sbot/design-styles 自定义。每项带 layout 图元表,前端直接
      // 画成 SVG。不进 /api/state —— 它是自动刷新定时拉的,而风格库只在切到「群·项目」页时要,
      // 没必要让每次心跳都背着 8 份图元。坏掉的单个预设跳过即可,不让整个库列不出来。
      if (p === '/api/design/styles' && req.method === 'GET') {
        const out = []
        for (const s of design.allStyles()) {
          try { out.push(design.styleCard(fs.readFileSync(s.path, 'utf8'), { slug: s.slug, source: s.source, name: s.name, description: s.description, suits: s.suits })) } catch { /* 单个预设读不动就跳过 */ }
        }
        // 不回传预设目录的绝对路径:控制台不展示内部实现路径(前端也不再有地方用),
        // 少一份就少一处泄漏面 —— 新建与收录都在这一页上做,operator 用不着知道它们存在哪儿。
        // ⚠ 也不回传字体说明(2026-09-02 产品决定:表单里连那行只读说明都不要)——
        // 字体恒定用 SANS_STACK 那一套,新建风格时不需要知道,更没有可选项;
        // 留个没人消费的字段只会变成下一次「两处各写一份」的种子。
        return sendJSON(res, 200, { styles: out })
      }
      // ── 图标库(只读,2026-08-25)───────────────────────────────────────────────
      // ⭐ **与设计风格库平级**:一个项目分别选「用哪套风格」和「用哪套图标」,而不是把图标
      //   绑在风格上(换风格就换图标是错的)。这张表在代码里预先整理好,**不开放自定义**。
      // 每套带 8 个真实图标做样张 —— 挑哪套是「认不认得出、好不好看」的判断,**断言判不了,
      // 必须按真实尺寸渲染出来看**;而这 8 个正是实测两套库几何全不同的那几个。
      // ⚠ 图标包不随 sbot 分发(四套合计约 160MB) ⇒ 没装如实标 installed:false(空白会被读成「这套是空的」)。
      if (p === '/api/design/icons' && req.method === 'GET') {
        return sendJSON(res, 200, { systems: design.iconSystemPreviews() })
      }
      // 给某个群项目选一套图标系统 ⇒ **落进那个项目的 design/icons.md**(不写群配置)。
      // ⚠ 落点必须在项目里:`sbot design icon` 是 agent 在项目目录里跑的,够不着群配置;
      //   而项目 clone 到别处时,写在群配置里的选择会整个丢掉。控制台是入口,项目档是落点
      //   (与「设计风格」那一行同款做法)。
      if (p === '/api/design/icons' && req.method === 'POST') {
        const { chatId, system, style, force } = await body(req)
        const g = (readRaw().groups || {})[chatId]
        if (!g || !g.workdir) return sendJSON(res, 400, { error: '这个群还没绑定项目目录' })
        if (!fs.existsSync(g.workdir)) return sendJSON(res, 400, { error: '项目目录不存在:' + g.workdir })
        const cur = design.findIconsDoc({ cwd: g.workdir })
        // 换系统 = 换掉整套命名词汇,而**页面上已经取过的图标不会自动跟着变**(教训 10:
        // 做了 A 别让人以为做了 B)⇒ 换之前必须让人明确知道这件事。
        if (cur && cur.system !== system && !force) {
          return sendJSON(res, 409, {
            error: 'confirm',
            current: cur.system,
            note: `这个项目现在用的是「${cur.system}」。换成「${system}」会换掉整套命名词汇`
              + `(同一个「更多」:${design.resolveIconName('more', design.ICON_SYSTEMS[cur.system] || {})} → ${design.resolveIconName('more', design.ICON_SYSTEMS[system] || {})}),`
              + '页面上已经取过的图标不会自动跟着变 —— 换完要把用到图标的页面重新取一遍。',
          })
        }
        // ⚠ 已有档只改 front matter,正文逐字节保留(同 CLI:人往这份档里写的项目细则不许被冲掉)
        let text
        // 线性/实心。⚠ **「没传」与「传了空」是两回事**:没传 = 这次不动它,
        //   得把当前值原样传回(withIconsDocFront 里空值 = 删键)—— 否则前端「只换系统」
        //   那一次请求会把人家声明过的实心静默抹成线性;传空串 = 明确清掉,回默认线性。
        const carried = style === undefined ? (cur && cur.style) || '' : String(style || '')
        // ⚠ 换到一套供不起当前形态的系统时(Tabler 实心 → Lucide),**丢掉形态而不是报错**:
        //   这一步用户想做的是换系统,拿「Lucide 没有实心」把整个操作挡下来只会让人卡在这儿;
        //   而带着它写盘又会落出一份自相矛盾的档。丢掉,并在回执里说一声(不声不响地丢
        //   就成了「做了 A 让人以为做了 B」)。
        const sysDef = design.ICON_SYSTEMS[String(system || '').toLowerCase()]
        const styleDropped = !!(carried && sysDef && !(sysDef.styles || []).includes(carried))
        // ⭐ 形态要改到**真正说得上话的那份档**去。优先级是 风格档 > 图标档 ⇒
        //   风格档一旦声明了形态,只写图标档就是白写。真机实证:测试群的两份风格档都写着 filled,
        //   群卡那个控件因此被压成灰的 —— 「加了个控件但它不管用」比没加更糟。
        // ⚠ 多份档各说各话时**不替人统一**:点名让人去各自那份里改(小程序用实心、后台用线性
        //   本来就是正当的,替他抹平等于毁掉别人的设计决定)。
        let styleTargets = []
        if (style !== undefined && !styleDropped) {
          const declared = []
          for (const d of design.findStyleDocs({ cwd: g.workdir })) {
            let t = null
            try { t = fs.readFileSync(d.abs, 'utf8') } catch { continue }
            const tk = design.parseStyleTokens(t)
            const st = tk && tk.icons && tk.icons.style
            if (st) declared.push({ ...d, text: t, style: String(st).toLowerCase() })
          }
          if (declared.length) {
            const forms = [...new Set(declared.map((x) => x.style))]
            if (forms.length > 1) {
              return sendJSON(res, 400, {
                error: '这个项目的几份风格档形态各不相同(' + declared.map((x) => x.name + ' → ' + (x.style === 'filled' ? '实心' : '线性')).join(' · ')
                  + ')—— 要改请到各自那份档里改,这里不替你统一',
              })
            }
            for (const d of declared) {
              const next = design.withIconsStyleInStyleDoc(d.text, carried)
              if (next == null || next === d.text) continue
              const t2 = d.abs + '.' + process.pid + '.tmp'
              try { fs.writeFileSync(t2, next); fs.renameSync(t2, d.abs) }
              catch (e) { try { fs.unlinkSync(t2) } catch { /* 没写出来 */ }
                return sendJSON(res, 500, { error: '写入风格档失败:' + ((e && e.message) || e) }) }
              styleTargets.push(d.name)
            }
          }
        }
        const opts = { system, style: styleDropped ? '' : carried, assets: cur ? cur.assets.join(' , ') : '', fallback: cur && cur.fallbackLibrary === null ? 'none' : '' }
        try { text = design.iconsDocText(cur && cur.text, opts) }
        catch (e) { return sendJSON(res, 400, { error: (e && e.message) || '写入失败' }) }
        const abs = path.join(g.workdir, design.ICONS_DOC_REL)
        const tmp = abs + '.' + process.pid + '.tmp'
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          fs.writeFileSync(tmp, text)
          fs.renameSync(tmp, abs) // 原子写:半截档会被认帧挡下,连带图标口径整个消失
        } catch (e) {
          try { fs.unlinkSync(tmp) } catch { /* 没写出来 */ } // 不清的话项目 design/ 里会留一个 .tmp
          return sendJSON(res, 500, { error: '写入图标档失败:' + ((e && e.message) || e) })
        }
        log(`design icons: ${chatId} → ${system}${opts.style ? ' · ' + opts.style : ''}${styleTargets.length ? ' · 风格档 ' + styleTargets.join('/') : ''}`)
        return sendJSON(res, 200, { ok: true, styleDropped, styleTargets, icons: design.projectIconCard(g.workdir), styles: design.projectStyleCards(g.workdir) })
      }
      // ── 自定义风格:表单 → 标准风格档 ────────────────────────────────
      // 实时预览:表单值 → 编译成档 → styleCard。**不落盘、不报错** —— 半填的表单也要出图
      // (边填边看才是这张表单存在的理由)。布局仍在服务端算,前端只把 rects 画成 SVG:
      // 与群里那张 PNG 永远同一份几何,不给「两端各画各的」留缝。
      // ⚠ 这两条都把 form **整个**交给 design.js,**不要**在这里挑字段:表单会长出新项
      //   (补充色 extraColors、字距/描边/间距那组 extraTokens 就是这么加的),白名单一旦
      //   写在这层,新字段就会静默丢在半路,而校验与归一的唯一权威在 design.js。
      if (p === '/api/design/preview' && req.method === 'POST') {
        const { form } = await body(req)
        try { return sendJSON(res, 200, { card: design.styleCard(design.composeStyleDoc(form)) }) }
        catch (e) { return sendJSON(res, 400, { error: (e && e.message) || '预览失败' }) }
      }
      // 保存:严格校验 → 编译 → 原子落盘。同 slug 已有自定义 ⇒ 409(前端提示勾「覆盖同名」);
      // 与内置同名不是错误,但要如实回 shadowed,让人知道自己遮住了哪一套。
      if (p === '/api/design/styles' && req.method === 'POST') {
        const { form, slug, overwrite, keepProse } = await body(req)
        try {
          const f = design.validateStyleForm(form)
          const s = design.validateStyleSlug(slug)
          let doc = design.composeStyleDoc(f)
          // 「修改」默认保留原正文:表单只管 tokens,正文里的 Do's/Don'ts 与具体参照
          // 是人在群里一轮轮磨出来的 —— 换个强调色就把它冲掉,是这个功能最容易造成的损失。
          // 勾了「按新设定重写正文」才走整份重生成(那时 keepProse 为假)。
          // ⚠ 与正文分开的一件事:**表单管不到的 front matter 段(如 icons)一律原样带过去**,
          // 不受「重写正文」那个勾影响 —— 图标声明不是正文,改个强调色就把它冲掉是静默的损失
          // (v0.11.33 审出来的:往返后 icons 段整段消失,而页面上没有任何提示)。
          const cur0 = design.allStyles().find((x) => x.slug === s && x.source === 'user')
          if (cur0) {
            try {
              const old = fs.readFileSync(cur0.path, 'utf8')
              if (keepProse) doc = design.withStyleProse(doc, old)
              doc = design.withKeptSections(doc, old)
            } catch { /* 读不动就用新骨架,不阻断保存 */ }
          }
          const r = design.saveUserStyle(s, doc, { overwrite: !!overwrite })
          return sendJSON(res, 200, { ok: true, slug: s, name: f.name, replaced: r.replaced, shadowed: r.shadowed })
        } catch (e) { return sendJSON(res, e && e.code === 'CONFLICT' ? 409 : 400, { error: (e && e.message) || '保存失败' }) }
      }
      // 删除只碰用户目录 —— 内置的删不掉;删掉一个遮蔽内置的同名 slug ⇒ 那一套回归内置。
      if (p === '/api/design/styles' && req.method === 'DELETE') {
        const b = await body(req)
        try { return sendJSON(res, 200, { ok: true, ...design.deleteUserStyle(b.slug || url.searchParams.get('slug')) }) }
        catch (e) { return sendJSON(res, 400, { error: (e && e.message) || '删除失败' }) }
      }
      // 从参考提炼(确定性提取器,不过模型):网址 ⇒ 抓 HTML + 同源样式表;绝对路径 ⇒ 扫本机目录。
      // 回的是**候选 + 证据**,不是结论 —— 用户看得见它凭什么这么猜,才知道该改哪一项。
      //
      // 两侧的围栏口径**故意不同**:
      //   网址侧 = 「服务器替我去取」的口子 ⇒ 只接公网地址,本机/内网/云元数据段一律拒。
      //     这里先挡一次(读代码的人在端点上就看得见围栏);跟跳时**每一跳**的重校验在 design
      //     那侧 —— 跟跳发生在那儿,只查首跳等于没查(公网 301 到 127.0.0.1 是最省事的一招)。
      //   目录侧 = 与目录浏览、保存绑定**同一道**项目根目录围栏(src/projectsroot.js)。2026-09-08 之前这里
      //     敞开着(「他本来就能开终端」)—— 但控制台已开到公网、名单可能不止 operator 一人,而且围栏
      //     写在三处必然漂:一处收紧另两处还敞着,等于没围。
      if (p === '/api/design/extract' && req.method === 'POST') {
        const { ref } = await body(req)
        const s = String(ref == null ? '' : ref).trim()
        if (!s) return sendJSON(res, 400, { error: '先填一个参考:网址,或本机上项目所在目录的绝对路径' })
        try {
          if (/^https?:\/\//i.test(s)) { design.assertPublicUrl(s); return sendJSON(res, 200, await design.extractFromUrl(s)) }
          if (path.isAbsolute(s)) {
            const info = projectsroot.resolveProjectsRoots(readRaw())
            if (!projectsroot.withinRoots(s, info.roots)) return sendJSON(res, 400, { error: `本机目录须在项目根目录下(${projectsroot.describeRoots(info.roots)}):${s}` })
            return sendJSON(res, 200, design.extractFromDir(s))
          }
          return sendJSON(res, 400, { error: '认不出这个参考 —— 网址要以 http:// 或 https:// 开头,本机目录要写绝对路径' })
        } catch (e) { return sendJSON(res, 400, { error: (e && e.message) || '提炼失败' }) }
      }
      // 收录:把某个群项目里打磨好的那份风格档复制进全局库(原文照抄,只允许改 name)。
      // 认帧仍走 findStyleDoc + isStyleDoc —— 项目根的 DESIGN.md 很可能是架构文档,不能当风格档收。
      if (p === '/api/design/collect' && req.method === 'POST') {
        const { chatId, slug, name, overwrite, rel } = await body(req)
        const raw = readRaw()
        const g = raw.groups && raw.groups[chatId]
        if (!g || !g.workdir) return sendJSON(res, 404, { error: '这个群还没绑定项目目录' })
        // 一个项目可能有多份风格档(小程序一份、后台一份…)⇒ 必须说清收哪一份。
        // rel 缺省时收列表第一份(通用档),与 pickStyleDoc 同一套匹配 —— 各写一份必漂移。
        const docs = design.findStyleDocs({ cwd: g.workdir })
        if (!docs.length) return sendJSON(res, 404, { error: '这个项目里还没有风格档,没有可收录的内容' })
        const pick = design.pickStyleDoc(docs, rel || '')
        if (!pick) return sendJSON(res, 404, { error: '这个项目里没有这一份风格档' })
        const abs = pick.abs
        try {
          let text = fs.readFileSync(abs, 'utf8')
          if (!design.isStyleDoc(text)) return sendJSON(res, 400, { error: '这个项目里的那份不是风格档,没有收录' })
          if (name && String(name).trim()) text = design.withStyleName(text, name)
          const s = design.validateStyleSlug(slug)
          const r = design.saveUserStyle(s, text, { overwrite: !!overwrite })
          return sendJSON(res, 200, { ok: true, slug: s, replaced: r.replaced, shadowed: r.shadowed })
        } catch (e) { return sendJSON(res, e && e.code === 'CONFLICT' ? 409 : 400, { error: (e && e.message) || '收录失败' }) }
      }
      // Read-only probe; sbot never installs plugins, it only gates them per group.
      if (p === '/api/plugins' && req.method === 'GET') {
        const chatId = url.searchParams.get('chatId')
        const out = { global: globalPlugins(), codex: codexPlugins() } // global=Claude 用户级 MCP;codex=~/.codex/config.toml
        // 可达性:连不上的 MCP 此前在这里长得和好的一模一样 —— 勾选框全绿,而每一轮都在替它
        // 付启动失败。探测带 TTL 缓存(见 plugins.js),控制台反复开合不会真的反复探。
        // 两套 MCP 都探(codex 那套虽然没有按群门控,连不上一样是每轮白付)。
        try {
          const reach = await mcpReachability(os.homedir(), { codex: true }) // doctor 读的是同一个出口,两处不会分叉
          const attach = (list, results) => {
            const by = new Map((results || []).map((r) => [r.name, r]))
            for (const m of list) {
              const r = by.get(m.name)
              if (r && r.status !== 'unprobed') m.reach = { status: r.status, detail: r.detail }
            }
          }
          attach(out.global.mcp, reach.claude)
          attach(out.codex.mcp, reach.codex)
        } catch {}
        if (chatId) {
          const raw = readRaw()
          const g = raw.groups && raw.groups[chatId]
          if (!g) return sendJSON(res, 404, { error: 'no such group' })
          out.project = g.workdir && fs.existsSync(g.workdir) ? projectPlugins(g.workdir) : { mcp: [], skills: [] }
          out.enabled = g.plugins || null // null = 未接管(claude 默认自加载)
        }
        return sendJSON(res, 200, out)
      }
      // Per-group plugin enablement. A saved plugins config means strict
      // MCP takeover on that group's next turn; reset=true removes the config and
      // restores traditional self-loading. Hot-reload via writeRaw, 下轮生效.
      if (p === '/api/groups/plugins' && req.method === 'POST') {
        const { chatId, mcp, skills, reset } = await body(req); const raw = readRaw()
        if (!raw.groups || !raw.groups[chatId]) return sendJSON(res, 404, { error: 'no such group' })
        if (reset) delete raw.groups[chatId].plugins
        else raw.groups[chatId].plugins = {
          mcp: (Array.isArray(mcp) ? mcp : []).filter((s) => typeof s === 'string' && s),
          skills: (Array.isArray(skills) ? skills : []).filter((s) => typeof s === 'string' && s),
        }
        writeRaw(raw)
        if (control && control.notifyGroup) {
          const t = reset ? '🧩 本群插件已恢复默认(全部加载)'
            : (Array.isArray(mcp) && mcp.length) ? `🧩 本群插件已更新:${mcp.join('、')}`
            : '🧩 本群已停用全部额外插件'
          notifyGroup(chatId, t)
        }
        return sendJSON(res, 200, await buildState())
      }
      // Plugin install command (整合自群卡):把 MCP 加进本机库
      // (`claude mcp add --scope user …`)。在中性 cwd(home)执行 —— 用户级安装与 cwd 无关;
      // 群卡那个 install 框只是 cwd=workdir 的同一动作,对"用户级库"口径冗余,已合并到此。
      // 操作台专用(localhost/LAN + token/密码),等价开放终端;白名单 env(无密钥);全审计。
      if (p === '/api/plugins/exec' && req.method === 'POST') {
        const { command } = await body(req)
        const cmd = String(command || '').trim()
        if (!cmd) return sendJSON(res, 400, { error: '命令为空' })
        return sendJSON(res, 200, await runInstallCommand(cmd, os.homedir()))
      }
      // real-time per-group model switch: persist to config (+ hot-reload) AND set
      // the live runtime override so it takes effect on the very next turn.
      if (p === '/api/groups/provider' && req.method === 'POST') {
        const { chatId, provider } = await body(req); const raw = readRaw()
        if (!raw.groups || !raw.groups[chatId]) return sendJSON(res, 404, { error: 'no such group' })
        if (!(raw.providers || {})[provider]) return sendJSON(res, 400, { error: `未知模型 '${provider}'` })
        raw.groups[chatId].provider = provider
        // Durable hosts drop the previous provider's pinned model id; their
        // writer resets the session and applies the change before returning.
        if (runtimePolicy) delete raw.groups[chatId].model
        writeRaw(raw)
        let live = !!runtimePolicy
        // switch the runtime override AND reset the group's session — else the next
        // turn resumes the old session, whose history carries the old model's identity.
        if (control && control.setProvider) { try { control.setProvider(chatId, provider); if (control.clearSession) control.clearSession(chatId); live = true } catch (e) { log('setProvider: ' + (e && e.message)) } }
        if (live && control.notifyGroup) {
          const pm = (raw.providers[provider] || {}).model
          // 换脑 = 会话清空,群成员当场最担心的是「之前交代过的都白说了」。项目里确实有沉淀时补一句。
          // ⚠ 探测式 —— 没有沉淀的项目说了就是假话(承诺它会读、其实无处可读)。
          // ⚠ 只陈述事实(东西还在),**不承诺行为**(「它会先读」):读不读是半可信 agent 的事,
          //   编排层保证不了 —— 清单自己都写着「上下文里没有就自己读一遍」(教训 6/10 形状)。
          // ⚠ 用户面零工具名:只说人话,不提约定文件名、更不提机器上的目录。
          // ⭐ 判据必须与自知清单**同一个函数**(probeHandover),且要按**切换之后**那个大脑算 ——
          //   它才是接下来读东西的那个。曾经分叉过:这里只问「有没有东西」,而清单另有一层
          //   够不够得着的门控 ⇒ 群里说「都还在」而清单一个字都没给(教训 26/35 家族)。
          let carry = ''
          try {
            const g = raw.groups[chatId] || {}
            const opts = { full: g.permissionMode === 'bypassPermissions', isCodex: (raw.providers[provider] || {}).runner === 'codex' }
            const h = require('../projectmemory').probeHandover(g.workdir, opts)
            if (h) carry = ' —— ' + h.note   // ⚠ 文案取自读取器,别在这里另写一份(群内 /model 也说这句)
          } catch { /* 探不到就不说 */ }
          notifyGroup(chatId, `🔄 本群模型已切到 ${provider}${pm ? ' · ' + pm : ''}(会话已重置)${carry}`)
        }
        return sendJSON(res, 200, { ...(await buildState()), switched: { chatId, provider, live } })
      }
      if (p === '/api/groups/new' && req.method === 'POST') {
        const { chatId } = await body(req)
        if (!control || !control.clearSession) return sendJSON(res, 400, { error: '后台服务未运行 — 这个动作需要它在跑' })
        control.clearSession(chatId); return sendJSON(res, 200, { ok: true })
      }
      if (p === '/api/groups/stop' && req.method === 'POST') {
        const { chatId } = await body(req)
        if (!control || !control.stop) return sendJSON(res, 400, { error: '后台服务未运行 — 这个动作需要它在跑' })
        return sendJSON(res, 200, { ok: control.stop(chatId) })
      }
      // 中断并开新:abort 当前 turn + 清队列 + 清 session,等价 busy 时的 /new
      if (p === '/api/groups/interrupt' && req.method === 'POST') {
        const { chatId } = await body(req)
        if (!control || !control.interrupt) return sendJSON(res, 400, { error: '后台服务未运行 — 这个动作需要它在跑' })
        const r = control.interrupt(chatId); return sendJSON(res, 200, { ok: true, wasBusy: !!(r && r.wasBusy) })
      }
      if (p === '/api/test' && req.method === 'POST') {
        const { provider, prompt } = await body(req); return sendJSON(res, 200, await testProvider(provider, prompt))
      }
      // Claude 卡片「检测登录」:`claude auth status --json`(官方非交互子命令,0.2s,不吃订阅额度)。
      // 与 codex 的「验证登录」对称。**force 才绕过缓存**:点按钮就是要看此刻的状态(刚
      // `claude auth login` 完回来点它,拿到缓存的旧「未登录」会让人以为登录没成功);而页面
      // 加载的自动探不带 force —— daemon 重启后 operator 重登控制台、开几个标签页,每次都
      // 强制现打就是一轮突发,恰好捅上游额度端点的低限流阈值(429 持续数分钟,群里 /hud
      // 会跟着遭殃),所以自动探 60s 内直接吃上次的答案,过期了也只顺 TTL 取、不清缓存。
      if (p === '/api/claude/verify' && req.method === 'POST') {
        const { force } = await body(req)
        const cfg = loadConfig(configPath)
        if (force) claudestatus.clearCache()
        else if (claudeStatusCache && Date.now() - claudeStatusCache.at < 60_000) return sendJSON(res, 200, claudeStatusCache.login)
        const login = await claudestatus.cachedLoginStatus(cfg.agent.bin)
        // 订阅额度(v0.11.3,cc-hud 同源通道):已登录才拉。拿不到(网络/门禁/凭据过期)⇒ null,
        // 前端不显示额度行,不拖垮登录检测本身。
        let usage = null
        if (login && login.ok && login.loggedIn) {
          try { if (force) claudeusage.clearCache(); usage = await claudeusage.usageLine() } catch { usage = null }
        }
        claudeStatusCache = { at: Date.now(), login: { ...login, usage } }
        return sendJSON(res, 200, { ...login, usage })
      }
      // Claude 模型下拉的候选。**未登录不给任何型号**(产品决定:没登录就别列)。
      // 已登录时 = 内置候选 + 本机账号的额外可选项;为什么不是官方实时清单,见 claudemodels.js 头部。
      if (p === '/api/claude/models' && req.method === 'GET') {
        const cfg = loadConfig(configPath)
        const login = await claudestatus.cachedLoginStatus(cfg.agent.bin)
        // ⚠ 回填这份缓存时必须**留住上一次拉到的 usage**:本条路不查额度,直接写 { at, login }
        // 会把 usage 字段洗掉,而 /api/claude/verify 的 60s 去抖随后会把这份缺 usage 的缓存原样
        // 吐回去 —— 表现就是卡片上的额度行凭空消失,而登录态一切正常,没人查得出为什么。
        if (login && login.ok) {
          const keep = claudeStatusCache && claudeStatusCache.login && claudeStatusCache.login.usage
          claudeStatusCache = { at: Date.now(), login: keep ? { ...login, usage: keep } : login }
        }
        return sendJSON(res, 200, { ...claudemodels.listModels({ loggedIn: !!(login && login.ok && login.loggedIn) }), login })
      }
      // codex 卡片「验证登录」:带令牌问一次服务端(app-server account/rateLimits/read),登录态 + 订阅用量
      // 一次拿到。无需 API key;探针缓存 60s(app-server 有 spawn 开销)。
      if (p === '/api/codex/verify' && req.method === 'POST') {
        // force = 卡片额度行的 ↻:点按钮就是要此刻的数,绕过下面的 60s 去抖
        // (去抖是给开局自动探测用的 —— app-server spawn 不便宜,但手点一次的开销该认)。
        const { force } = await body(req).catch(() => ({}))
        // 登录态与额度合成**一次**带令牌的服务端询问(额度接口)。此前先 `codex login status` 再取额度 ——
        // 前者只读本地文件,令牌被吊销后照样「已登录」,卡片一直绿着。现在服务端明确拒绝 ⇒ dead:true、loggedIn:false;
        // 探不到(超时)⇒ verified:false,保留上一份额度、文案「未验证」,不当成未登录。
        if (force) codexstatus.clearCache()
        const probe = await codexstatus.cachedAuthProbe('codex')
        const file = codexstatus.readAuthFile()
        const d = codexstatus.describeLogin(probe, file)
        const login = { ok: true, verified: !!probe.verified, loggedIn: !!(probe.ok || (!probe.verified && file.exists && !file.expired)), dead: !!probe.dead, mode: file.mode || 'chatgpt', level: d.level, text: d.text }
        let usage = probe.usage || null
        if (!usage && !probe.dead && codexStatusCache && codexStatusCache.usage) usage = codexStatusCache.usage // 探不到时保住旧额度(同前端那条「同一份状态两个消费者」的教训)
        codexStatusCache = { at: Date.now(), login, usage } // cached into /api/state so the card survives a page reload
        return sendJSON(res, 200, { login, usage })
      }
      if (p === '/api/playground/run' && req.method === 'POST') {
        const { provider: provName, workdir, prompt, sessionId } = await body(req)
        const cfg = loadConfig(configPath); applyProxyEnv(cfg)
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`) } catch { /* client gone */ } }
        const provider = cfg.providers[provName]
        if (!prompt) { send('error', { error: 'prompt 为空' }); return res.end() }
        if (!provider) { send('error', { error: `未知 provider '${provName}'` }); return res.end() }
        if (provider.baseUrl && !provider.apiKey) { send('error', { error: `provider '${provName}' 缺 apiKey` }); return res.end() }
        const ac = new AbortController()
        req.on('close', () => ac.abort()) // browser aborts fetch → stop the turn
        let buf = ''
        // Perms are per-project: if this workdir matches a bound group, inherit that
        // project's allow/deny; otherwise none (dontAsk ⇒ read-only). 试跑 isn't a
        // "project", so it doesn't get any global default.
        const pgGroup = Object.values(cfg.groups || {}).find((x) => x.workdir && x.workdir === workdir)
        try {
          const { sessionId: newSid, result, aborted } = await runTurn({
            bin: cfg.agent.bin,
            prompt,
            provider,
            model: provider.model,
            workdir: workdir || undefined,
            sessionId: sessionId || undefined,
            permissionMode: (pgGroup && pgGroup.permissionMode) || 'dontAsk', // 试跑继承匹配群的模式(无全局默认,unset ⇒ dontAsk)
            allowedTools: pgGroup && pgGroup.allowedTools,
            disallowedTools: pgGroup && pgGroup.disallowedTools,
            signal: ac.signal,
            onEvent: (ev) => {
              if (ev.type === 'system' && ev.subtype === 'init') send('session', { sessionId: ev.sessionId })
              if (ev.type === 'assistant') {
                if (ev.tools && ev.tools.length) send('tool', { tools: ev.tools.map((t) => t.name) })
                if (ev.text) { buf += ev.text; send('delta', { text: buf }) } // cumulative
              }
            },
          })
          send('done', {
            sessionId: newSid,
            status: aborted ? 'stopped' : (result && result.isError) ? 'error' : 'ok',
            text: (result && result.text) || buf,
            usage: result && result.usage ? { in: result.usage.input_tokens || 0, out: result.usage.output_tokens || 0 } : null,
          })
        } catch (e) {
          send('error', { error: (e && e.message) || String(e) })
        }
        return res.end()
      }
      res.writeHead(404); res.end('not found')
    } catch (e) {
      log('ui error: ' + (e && e.message)); sendJSON(res, 500, { error: (e && e.message) || 'server error' })
    }
  })

  function setActiveHost(value) {
    const changed = activeHost !== String(value)
    activeHost = String(value)
    loopbackBind = /^(127\.0\.0\.1|localhost|::1)$/i.test(activeHost)
    HOST_OK = hostPattern()
    if (changed && onHostChange) { try { onHostChange(activeHost, server.address()) } catch (e) { log('ui host callback: ' + (e && e.message)) } }
  }
  function listenAgain(bindHost, port) {
    return new Promise((resolve, reject) => {
      const onError = (e) => { server.removeListener('listening', onListening); reject(e) }
      const onListening = () => { server.removeListener('error', onError); setActiveHost(bindHost); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, bindHost)
    })
  }
  async function rebindHost(nextHost) {
    if (!['127.0.0.1', '0.0.0.0'].includes(nextHost)) throw new Error('只支持本机或全部局域网接口')
    const address = server.address()
    if (!address || typeof address !== 'object') throw new Error('控制台尚未监听端口')
    const oldHost = activeHost
    if (nextHost === oldHost) return
    for (const client of sseClients) { try { client.end() } catch {} }
    sseClients.clear()
    const stopped = new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await stopped
    try { await listenAgain(nextHost, address.port) }
    catch (e) {
      try { await listenAgain(oldHost, address.port) } catch (restoreErr) { log('ui host restore listen failed: ' + (restoreErr && restoreErr.message)) }
      throw e
    }
  }

  // Broadcast live state + heartbeat over SSE (cheap; no health probe here).
  const tick = setInterval(() => {
    if (!sseClients.size) return
    const live = getLiveState ? getLiveState() : { running: false }
    const conn = getConnHealth ? getConnHealth() : null // 飞书 WS 健康度随心跳带上(SSE 无重放,轮询兜底)
    const msg = `event: tick\ndata: ${JSON.stringify({ live, conn, ts: Date.now(),
      ...(runtimePolicy && !runtimePolicy.activityPage ? { activity: runtimePolicy.getActivity() } : {}) })}\n\n`
    for (const c of sseClients) { try {
      if (c.writableLength > 256 * 1024) { c.destroy(); sseClients.delete(c) }
      else c.write(msg)
    } catch { sseClients.delete(c) } }
  }, 3000)

  return {
    server,
    listen(port, host, cb) { server.listen(port, host, cb) },
    rebind: rebindHost,
    // let a daemon push turn events into the console's activity feed
    pushEvent(type, data) {
      if (type === 'turn') recordActivity(data) // also buffer it for replay (下一步 ②)
      let msg = `event: ${type}\ndata: ${JSON.stringify(data || {})}\n\n`
      // turn 同帧附带一枚 tick:任务出现的瞬间,群 busy 标/并发格/队列同步刷新,
      // 不等 3s 心跳 —— 「新任务出现」与「状态变化」在控制台永远同步可见。
      if (type === 'turn' && getLiveState) {
        msg += `event: tick\ndata: ${JSON.stringify({ live: getLiveState(), conn: getConnHealth ? getConnHealth() : null, ts: Date.now() })}\n\n`
      }
      for (const c of sseClients) { try {
        if (c.writableLength > 256 * 1024) { c.destroy(); sseClients.delete(c) }
        else c.write(msg)
      } catch { sseClients.delete(c) } }
    },
    close() { clearInterval(tick); for (const c of sseClients) { try { c.end() } catch {} } try { browserRoutes.close() } catch {} server.close(); if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); if (updater) updater.close() },
    _browserRoutes: browserRoutes, // 测试探 CDP 会话注册表用
  }
}

module.exports = { createUiServer, execShellCommand, listDirs, makeDir, authConfiguredFrom, bindNoticeText, connHealthRows }
