// 插件(MCP / Skill)探测与按群启用拼装
//
// 概念:全局插件库(机器上有什么)→ 按群启用(项目允许用什么)→ spawn 注入(强制生效)。
//   · 全局库:~/.claude.json 的 mcpServers + ~/.claude/skills/
//   · 项目级:<workdir>/.mcp.json + <workdir>/.claude/skills/
//   · 按群:groups[chatId].plugins = { mcp: [全局启用名], skills: [放行 skill 名] }
//
// 语义(2026-07-03 拍板):
//   · 群配置过 plugins ⇒ strict 接管:spawn 传 --mcp-config <file> --strict-mcp-config,
//     只载入「项目级全部 + 全局勾选」;未配置的群零回归(claude 自行加载)。
//   · 启用即放行:载入的 MCP server 自动放行 mcp__名__*,勾选的 skill 放行 Skill(名);
//     运行时合并进 allowedTools,不写回群权限清单;deny 依然优先可压住。
//
// UI 展示(src/ui/server.js)与 agent spawn(src/agent/claudecode.js)共用本模块。
// 零依赖;home 可注入便于测试。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// MCP server 定义 → 一行摘要(UI 展示用;不透出 env 等敏感字段)
function mcpSummary(def = {}) {
  if (def.url) return (def.type ? def.type + ' · ' : '') + def.url
  return [def.command, ...(def.args || [])].filter(Boolean).join(' ').slice(0, 120)
}

// skills 目录 → [{name, description}];只认含 SKILL.md 的子目录,description 取 frontmatter。
// 不用 withFileTypes 判目录 — 用户 skills 常是符号链接(isDirectory()=false 会整批漏掉),
// 直接尝试读 <name>/SKILL.md,读得到就算(readFileSync 跟随链接)。
function scanSkills(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    let md = null
    try { md = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8') } catch { continue }
    const m = md.match(/^description:\s*(.+)$/m)
    out.push({ name, description: m ? m[1].trim().slice(0, 200) : '' })
  }
  return out
}

function readMcpServers(file) {
  return (readJson(file) || {}).mcpServers || {}
}

// 已安装插件清单(~/.claude/plugins/installed_plugins.json)→ [{id, name, root}]
function installedPlugins(home = os.homedir()) {
  const ip = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json')) || {}
  const out = []
  for (const [id, arr] of Object.entries(ip.plugins || {})) {
    const inst = Array.isArray(arr) ? arr[0] : null
    if (!inst || !inst.installPath) continue
    out.push({ id, name: id.split('@')[0], root: inst.installPath })
  }
  return out
}

// 全局插件库(产品拍板 2026-07-03,收敛口径):
//   · MCP 只认「用户级」= ~/.claude.json 顶层 mcpServers — 库即"这台机器明确共享的
//     MCP"。项目登记(local scope)/ 其他项目的 .mcp.json / Desktop 配置一律不聚合,
//     降噪;想让某 MCP 进库 → `claude mcp add --scope user` 升为用户级。
//   · skills(用户级 ~/.claude/skills + 已装插件,插件 skill 调用名带 `插件名:` 前缀)
//     不在「插件库」页展示 — 只供群项目卡「插件」区按群勾选放行。
function globalPlugins(home = os.homedir()) {
  const mcp = Object.entries(readMcpServers(path.join(home, '.claude.json')))
    .map(([name, def]) => ({ name, detail: mcpSummary(def), source: '用户级' }))
  const skills = scanSkills(path.join(home, '.claude', 'skills')).map((s) => ({ ...s, source: '用户级' }))
  for (const p of installedPlugins(home))
    for (const s of scanSkills(path.join(p.root, 'skills')))
      skills.push({ name: p.name + ':' + s.name, description: s.description, source: '插件' }) // 调用名 = plugin:skill
  return { mcp, skills }
}

// ── Codex MCP 库 ────────────────────────────────────────────────────────────
// Codex 有自己独立的 MCP 机制(官方 developers.openai.com/codex/mcp):CLI `codex mcp add
// <name> [--env K=V] -- <cmd>`(stdio)或 `--url`(remote),写进 ~/.codex/config.toml 的
// [mcp_servers.NAME] 表 —— 与 Claude 的 ~/.claude.json 完全两套。codex exec 全局加载该文件里
// 所有 server(无按调用取子集的开关),故 codex MCP 是「装了就对所有 codex 群生效」。
// 这里只读该文件、抽每个 server 的 command/args 或 url 拼一行摘要给「插件库」页展示;
// 不引 TOML 依赖 —— 极简行解析,只认 [mcp_servers.NAME] 顶层表,忽略 .env/.http_headers 子表。
function unquoteToml(s) {
  s = String(s).trim()
  const q = s.match(/^"([^"]*)"/) || s.match(/^'([^']*)'/)
  if (q) return q[1]
  return s.replace(/\s+#.*$/, '').trim() // 裸值:去行尾注释
}
function parseCodexMcpServers(toml) {
  const servers = {}
  let cur = null, pend = null // pend:跨行 args = [ … ] 累积
  for (const raw of String(toml).split(/\r?\n/)) {
    if (pend) { // 续接多行数组直到 ]
      pend.buf += ' ' + raw
      if (raw.includes(']')) { try { servers[pend.name].args = JSON.parse(pend.buf.slice(0, pend.buf.lastIndexOf(']') + 1).replace(/'/g, '"')) } catch {} pend = null }
      continue
    }
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) { // 任意 section 头:只有恰好 [mcp_servers.NAME] 是一个 server,子表 → cur=null
      const m = line.match(/^\[\s*mcp_servers\.\s*("[^"]+"|[^.\]]+?)\s*\]$/)
      cur = m ? m[1].replace(/^"|"$/g, '') : null
      if (cur) servers[cur] = servers[cur] || {}
      continue
    }
    if (!cur) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim()
    if (k === 'command') servers[cur].command = unquoteToml(v)
    else if (k === 'url') servers[cur].url = unquoteToml(v)
    else if (k === 'args') {
      if (v.includes(']')) { try { servers[cur].args = JSON.parse(v.slice(0, v.lastIndexOf(']') + 1).replace(/'/g, '"')) } catch {} }
      else pend = { name: cur, buf: v } // 数组跨行
    }
  }
  return servers
}
function codexPlugins(home = os.homedir()) {
  let toml
  try { toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8') } catch { return { mcp: [] } }
  const servers = parseCodexMcpServers(toml)
  return { mcp: Object.entries(servers).map(([name, def]) => ({ name, detail: mcpSummary(def), source: 'codex' })) }
}

// MCP server 定义 → 它指向的常驻浏览器地址(chrome-devtools 类的 --browserUrl=… / -u …);无则 null。
// 用途:doctor 探活 —— 浏览器没起时工具要到轮中才失败,提前在健康检查里报出来。
function mcpBrowserUrl(def = {}) {
  const a = def.args || []
  for (let i = 0; i < a.length; i++) {
    const m = String(a[i]).match(/^(?:--browserUrl|-u)(?:=(.*))?$/)
    if (m) return (m[1] !== undefined ? m[1] : String(a[i + 1] || '')) || null
  }
  return null
}

// 两侧机器级 MCP 配置(用户级 ~/.claude.json + codex ~/.codex/config.toml)里指向常驻
// 浏览器的条目 → [{source, name, url}];没配置返回 []。按 url 去重交给调用方(两侧常指同一实例)。
function browserTargets(home = os.homedir()) {
  const out = []
  for (const [name, def] of Object.entries(readMcpServers(path.join(home, '.claude.json')))) {
    const url = mcpBrowserUrl(def)
    if (url) out.push({ source: '用户级', name, url })
  }
  let toml = null
  try { toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8') } catch {}
  if (toml) for (const [name, def] of Object.entries(parseCodexMcpServers(toml))) {
    const url = mcpBrowserUrl(def)
    if (url) out.push({ source: 'codex', name, url })
  }
  return out
}

// 项目级插件:workdir 自带声明
function projectPlugins(workdir) {
  const mcp = Object.entries(readMcpServers(path.join(workdir, '.mcp.json')))
    .map(([name, def]) => ({ name, detail: mcpSummary(def) }))
  return { mcp, skills: scanSkills(path.join(workdir, '.claude', 'skills')) }
}

// ── MCP 可达性预检(2026-09-05)────────────────────────────────────────────────
// 由来:某群勾了一个「别的项目才起」的本地 http MCP(127.0.0.1:27182),那个服务没跑。
// 后果是**每一轮 spawn 都替它付一次启动失败** —— 实测 22 个流文件里 129 处
// `rmcp::transport::worker: worker quit with fatal: Transport channel closed`,每次重试
// 若干轮才放弃。而 doctor / 控制台 / 群里**没有任何一处说过它连不上**,勾选框看着一切正常。
// 这就是本项目反复踩的那一族:「配置写着 / doctor 不报 / 运行不报错,只是行为跟没配一样」。
//
// ⭐ 三态,不是两态 —— 「探不通」和「确定不可用」必须分开:
//   ok      探通了(端口在听 / 可执行文件在且可执行)
//   down    **板上钉钉**不可用 —— 唯一会导致跳过注入的一档
//   unknown 没探明白(超时 / 公网地址直连失败 / 定义形态判不了)⇒ 只报不跳过
// ⚠ 保守偏向由产品决定:**宁可漏跳过,也不要把一个其实活着的服务挡在外面**。
//   漏跳过的代价 = 那一轮再白付一次启动失败(可恢复);错跳过的代价 = 群里能力凭空消失
//   且没人知道为什么(不可恢复,而且正是本次要治的那种「静默不一致」)。
//
// ⚠ **公网地址一律判不了 down**:`src/core/proxy.js` 段头那条 —— Node 的 fetch/ws 都不读
//   代理环境变量,墙内机器上直连公网必失败,而 agent 那侧走的是 spawn 出去的 CLI(继承
//   HTTPS_PROXY,能出去)。拿本进程的直连结果去否决子进程的可达性,就是拿错的钟去校表。
//   ⇒ 只有**本机/内网 + 连接被拒**(ECONNREFUSED = 那个端口上没有东西在听)才算 down。
// ⚠ **探的是传输层不是 MCP 协议层**:TCP 连得上只说明有人在听,不代表它是个能用的 MCP。
//   故意不发 HTTP 请求 —— GET 一个 MCP 端点可能被当成开 SSE 流而挂住(比不探还贵),
//   而且要正确判 404/401 就得懂各家实现。要治的病是「端口上根本没东西」,TCP 足够且无副作用。

const PROBE_TIMEOUT_MS = 1200   // 短超时:doctor 里所有 MCP 并行探,墙钟≈这个数,不会把体检拖死
const PROBE_TTL_OK_MS = 60_000  // ok / unknown 的缓存寿命:一分钟内不重复探
// down 的缓存更短:① 用户看到警告后会去把服务起起来,recovery 延迟越短越好;
// ② 复探一个被拒的端口是**立刻返回**的(ECONNREFUSED 不吃超时),几乎不花钱。
const PROBE_TTL_DOWN_MS = 20_000

// 主机是不是「本机 / 内网」—— 只有这类地址的直连失败才有资格被判 down(理由见段头)。
function isLocalHost(host) {
  const h = String(host || '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '[::1]') return true
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true
  const m = h.match(/^172\.(\d+)\./)
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31
}

// MCP 定义 → 可探测的目标(纯函数)。kind:'http' 探端口 / 'stdio' 探可执行文件 /
// 'none' 判不了(不出行、不跳过)。同时兼作缓存键的一部分 —— 改了 url/command 即失效。
function mcpProbeTarget(def = {}) {
  if (def.url) {
    let u = null
    try { u = new URL(def.url) } catch { return { kind: 'none', why: 'url 解析不了' } }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'none', why: '非 http(s) 端点' }
    // WHATWG URL 对 IPv6 主机保留方括号(`[::1]`),而 net.connect 不认带括号的写法 ⇒ 先剥掉,否则永远探成 unknown
    const rawHost = u.hostname.replace(/^\[|\]$/g, '')
    // 0.0.0.0 / :: 是绑定地址不是连接目标(Windows 直接拒),拨环回才反映真实可达性(与 health.js 同款处理)
    const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost
    return { kind: 'http', url: def.url, host, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), local: isLocalHost(host) }
  }
  if (!def.command) return { kind: 'none', why: '既无 url 也无 command' }
  const cmd = String(def.command)
  // ⚠ command 手写成一整串(`"npx -y pkg"`)判不了:整串当可执行名去查 PATH 必然 ENOENT ⇒ 会被错判 down 而跳过,
  //   而「宁可漏跳过、不错跳过」是本机制的底线 ⇒ 直接不探。
  if (/\s/.test(cmd.trim())) return { kind: 'none', why: 'command 带空格(整串当可执行名判不了)' }
  const bare = !cmd.includes('/') && !(process.platform === 'win32' && cmd.includes('\\'))
  // ⚠ 相对路径判不了:claude 是以**群 workdir** 为 cwd 起 MCP 的,daemon 的 cwd 不是它,
  //   拿本进程 cwd 去解析必然误判 ⇒ 直接不探。绝对路径与裸名(走 PATH)才探。
  if (!bare && !path.isAbsolute(cmd)) return { kind: 'none', why: '相对路径(取决于群工作目录,不判)' }
  return { kind: 'stdio', command: cmd, bare }
}

// 默认网络探针:一次 TCP connect。可注入 ⇒ 单测零网络。
function defaultTcpProbe(host, port, timeoutMs) {
  const net = require('node:net')
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let done = false
    const finish = (ok, code) => { if (done) return; done = true; try { sock.destroy() } catch {} resolve({ ok, code }) }
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => finish(true, null))
    sock.on('timeout', () => finish(false, 'ETIMEDOUT'))
    sock.on('error', (e) => finish(false, (e && e.code) || (e && e.message) || 'ERR'))
  })
}

// 默认可执行文件探针:绝对路径直接查,裸名走 PATH(Windows 另试 PATHEXT 后缀)。
// ⚠ 用 daemon 自己的 PATH 是**对的** —— claude 是 daemon spawn 出来的子进程,继承同一份 PATH,
//   所以「daemon 找不到」等价于「claude 也找不到」。可注入 ⇒ 单测不碰真实文件系统。
function defaultExecProbe(command) {
  const win = process.platform === 'win32'
  const exts = win ? ['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : ['']
  const tryOne = (base) => {
    for (const e of exts) {
      const f = base + e
      let st = null
      try { st = fs.statSync(f) } catch { continue }   // statSync 跟随符号链接
      if (!st.isFile()) continue
      if (!win) { try { fs.accessSync(f, fs.constants.X_OK) } catch { return { ok: false, code: 'EACCES', path: f } } }
      return { ok: true, path: f }
    }
    return null
  }
  if (!command.includes('/') && !(win && command.includes('\\'))) {
    for (const d of String(process.env.PATH || '').split(win ? ';' : ':').filter(Boolean)) {
      const r = tryOne(path.join(d, command))
      if (r) return r
    }
    return { ok: false, code: 'ENOENT', path: command }
  }
  return tryOne(command) || { ok: false, code: 'ENOENT', path: command }
}

// 单个 MCP 的探测(纯逻辑 + 注入探针)。返回 {name, status, detail, target}。
async function probeMcp(name, def, opts = {}) {
  const t = mcpProbeTarget(def || {})
  const mk = (status, detail) => ({ name, status, detail, target: t })
  if (t.kind === 'none') return mk('unprobed', t.why)
  if (t.kind === 'http') {
    const tcp = opts.tcp || defaultTcpProbe
    const r = await tcp(t.host, t.port, opts.timeoutMs || PROBE_TIMEOUT_MS)
    if (r && r.ok) return mk('ok', `${t.host}:${t.port} 在听`)
    const code = (r && r.code) || 'ERR'
    if (t.local && code === 'ECONNREFUSED') return mk('down', `连不上 ${t.url}(${code} — 那个端口上没有服务在听)`)
    return mk('unknown', `直连未通 ${t.url}(${code})`)
  }
  const exec = opts.exec || defaultExecProbe
  let r = null
  try { r = exec(t.command) } catch { r = null }
  if (!r) return mk('unknown', `探测失败 ${t.command}`)
  if (r.ok) return mk('ok', r.path || t.command)
  if (r.code === 'EACCES') return mk('down', `${r.path || t.command} 在,但没有可执行权限`)
  return mk('down', t.bare ? `${t.command} 不在 PATH 上` : `找不到 ${t.command}`)
}

// ── 探测缓存(TTL)────────────────────────────────────────────────────────────
// ⚠ 为什么必须有 TTL:服务过一会儿就可能起来(fusion 正是「别的项目开着才有」),
//   探一次就永久拉黑是错的 —— 那会把「暂时没起」变成「这个群从此没有这个能力」。
// 键含 target ⇒ 改了 url/command 立刻失效,不会拿旧结论套新配置。
const probeCache = new Map()
function cacheKey(name, def) { return name + ' ' + JSON.stringify(mcpProbeTarget(def || {})) }
function ttlFor(status) { return status === 'down' ? PROBE_TTL_DOWN_MS : PROBE_TTL_OK_MS }
function cachedProbe(name, def, now) {
  const e = probeCache.get(cacheKey(name, def))
  if (!e || now - e.at >= ttlFor(e.status)) return null
  return e
}
function resetProbeCache() { probeCache.clear(); skipLogged.clear() }

// 批量探测(并行)+ 写缓存。opts:{tcp, exec, timeoutMs, now, force}
async function probeMcpServers(defs = {}, opts = {}) {
  const now = opts.now || Date.now()
  if (probeCache.size > 200) probeCache.clear() // 配置反复改时的兜底,不做 LRU
  return Promise.all(Object.keys(defs).map(async (name) => {
    const def = defs[name]
    if (!opts.force) {
      const c = cachedProbe(name, def, now)
      if (c) return { name, status: c.status, detail: c.detail, target: c.target, cached: true }
    }
    const r = await probeMcp(name, def, opts)
    probeCache.set(cacheKey(name, def), { status: r.status, detail: r.detail, target: r.target, at: now })
    return r
  }))
}

// 用户级 MCP 库(+ 可选 codex 库)的可达性 —— doctor 与控制台的同一个数据源。
async function mcpReachability(home = os.homedir(), opts = {}) {
  const claude = await probeMcpServers(readMcpServers(path.join(home, '.claude.json')), opts)
  if (!opts.codex) return claude
  let toml = null
  try { toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8') } catch {}
  return { claude, codex: toml ? await probeMcpServers(parseCodexMcpServers(toml), opts) : [] }
}

// 跳过注入时的痕迹:一行,按名 10 分钟节流(每轮都刷等于没人会看)。
const skipLogged = new Map()
const SKIP_LOG_THROTTLE_MS = 10 * 60_000
function noteSkipped(items, opts, now) {
  const fresh = items.filter((it) => now - (skipLogged.get(it.name) || 0) >= SKIP_LOG_THROTTLE_MS)
  if (!fresh.length) return
  for (const it of fresh) skipLogged.set(it.name, now)
  const log = opts.log || ((m) => { try { process.stderr.write('· ' + m + '\n') } catch {} })
  log('MCP 预检不通,本轮跳过注入(免得每轮都替它付一次启动失败;服务起来后自动恢复):'
    + fresh.map((it) => `${it.name} — ${it.detail}`).join(';'))
}

// strict 接管的 MCP 清单:项目级全部 + 用户级按名启用(同名项目级覆盖)。
//
// ⚠ 本函数是**同步**的(spawn 路径上,claudecode.js 直接调),所以它只读缓存、绝不现探:
//   · 缓存里有**新鲜的 down** ⇒ 跳过注入(唯一的跳过判据)
//   · 缓存里没有 / 过期 / 是 ok / 是 unknown ⇒ 照常注入
//   ⇒ 「没探过」天然等于「不跳过」,daemon 刚起的第一轮永远不会误伤。
// 每次调用顺手放一发后台探测(不 await,不阻塞本轮),下一轮就有数据可依。
// ⚠ **只对「用户级 + 群里勾选」的那批生效**;项目级 `.mcp.json` 是项目自带、恒加载,
//   不是群里勾出来的,不在本机制的管辖范围内(改它是改项目,不是改群门控)。
function buildMcpConfig(workdir, enabledGlobalNames = [], home = os.homedir(), opts = {}) {
  const g = readMcpServers(path.join(home, '.claude.json'))
  const now = opts.now || Date.now()
  const out = {}
  const picked = {}
  const skipped = []
  for (const n of enabledGlobalNames) {
    if (!g[n]) continue
    picked[n] = g[n]
    const c = cachedProbe(n, g[n], now)
    if (c && c.status === 'down') { skipped.push({ name: n, detail: c.detail }); continue }
    out[n] = g[n]
  }
  Object.assign(out, readMcpServers(path.join(workdir, '.mcp.json')))
  if (skipped.length) noteSkipped(skipped, opts, now)
  if (opts.refresh !== false) {
    try { Promise.resolve(probeMcpServers(picked, { tcp: opts.tcp, exec: opts.exec })).catch(() => {}) } catch {}
  }
  return { mcpServers: out }
}

// spawn 用:strict config 落盘到 ~/.sbot/mcp/<hash>.json(按 workdir 稳定路径)。
// 原子写(temp+rename,避免并发 spawn 读到截断 JSON)+ POSIX mode 0o600(含 MCP server
// 密钥的文件限本用户读)+ 写时清理 >1h 旧残留(进程崩溃留下的孤儿;当前 turn 刚写不删)。
// 不走 argv 内联 JSON —— Windows npm shim 经 cmd.exe,引号必被打碎。
//
// temp 名带 pid+序号唯一(#4 并发写锁):两个共用同一 workdir 的群并发 spawn 会算出同一个
// 稳定路径 f,若共用固定 .tmp,则会互相截断、且后一个 renameSync 撞 ENOENT(tmp 已被前一个
// rename 走)令那轮崩溃。各写各的唯一 temp、再原子 rename 覆盖 f —— 互不干扰,last-writer-wins。
let mcpTmpSeq = 0
function writeMcpConfigFile(workdir, cfg, home = os.homedir()) {
  const dir = path.join(home, '.sbot', 'mcp')
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, crypto.createHash('sha1').update(String(workdir)).digest('hex').slice(0, 12) + '.json')
  // 清 >1h 孤儿:既清旧 config(.json),也清写一半没 rename 的 temp(.tmp;唯一名下更需主动回收)
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue
    const p = path.join(dir, name)
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p) } catch {}
  }
  const tmp = f + '.' + process.pid + '.' + (mcpTmpSeq++) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600 })
  fs.renameSync(tmp, f)
  return f
}

module.exports = { globalPlugins, codexPlugins, parseCodexMcpServers, projectPlugins, buildMcpConfig, writeMcpConfigFile, scanSkills, mcpSummary, installedPlugins, mcpBrowserUrl, browserTargets,
  // MCP 可达性预检
  mcpProbeTarget, isLocalHost, probeMcp, probeMcpServers, mcpReachability, resetProbeCache, PROBE_TIMEOUT_MS, PROBE_TTL_OK_MS, PROBE_TTL_DOWN_MS }
