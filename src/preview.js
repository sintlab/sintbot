// 群预览服务(`sbot preview`)—— 让群成员在局域网打开 agent 做的 HTML 原型,受管、可回收。
//
// 病史(docs/PREVIEW.md 有全文):agent 为了让群里打开原型,先是把静态服务装成 launchctl 常驻
// 作业(挂了一周、整个项目目录暴露在局域网),v0.8.1 禁了常驻作业之后,它改用**故意不结束本轮**
// 给服务续命(占住群锁、群成员消息全排队)—— 比原问题更糟。v0.8.2 只补了清单文案(首选 send-file、
// 真脱离用 screen、严禁拖轮次),剩下三个软肋全靠自觉:关服务靠跨轮记忆、operator 看不见、
// screen 是能起任意进程的通用逃生阀。本模块把这件事收成一个受管动作。
//
// 形态(立项措辞的订正):**socket 在 detached worker,生命周期策略在 daemon**。daemon 是全群单点,
// 把吃 LAN 请求的 HTTP handler 塞进去 ⇒ 任何解析 bug 都是「整台 bot 下线」;且生产机每次发版都
// kickstart daemon ⇒ in-daemon 托管的预览每次升级都断,「跨轮存活」名存实亡。立项要的「有人替它
// 记得关」是**策略**不是套接字。worker 自己也会闲置自尽 ⇒ 不装 daemon / daemon 崩了,回收仍成立。
//
// 记录所有权铁律:**谁杀谁写**。worker 只写自己的生命周期跃迁(running / 自己闲置停 / 绑定失败);
// 被别人 kill 时不写(收割方已经把 reason 写进去了,worker 再写会把 reason 覆盖成 'signal')。
//
// 本文件只放可单测纯逻辑(端口序 / 围栏裁决 / 请求路径 / 记录 / 回收判定 / 文案);http 服务、
// spawn、发群在 bin(项目纪律:src 可测,bin 接线)。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { atomicWriteJSON } = require('./core/store')

// 端口段:紧邻控制台 4600 便于记忆与防火墙整段放行,且躲开 3000/5173/8000/8080/9222(常驻 Chrome CDP)
const PORT_FROM = 4610
const PORT_TO = 4629
const IDLE_MIN_DEFAULT = 30 // 闲置回收(分钟);0 = 不按闲置回收(仍受 maxHours 顶)
const MAX_HOURS_DEFAULT = 8 // 总时长硬顶(小时)
const LASTREQ_DEBOUNCE_MS = 5_000 // lastReqAt 落盘去抖:静态页一次加载几十个请求,不能每个都打一次盘
const KEEP_STOPPED = 20 // 历史记录保留条数(status 可回看,又不无限堆积)

function previewDir() {
  return path.join(os.homedir(), '.sbot', 'preview')
}

// 配置归一(顶层 `preview` 块 + 可选的按群覆盖)。缺省即默认;非法值一律回默认(fail-safe,同
// normalizeTz 口径)。**按群覆盖只由 operator 设**(控制台群卡 / 配置文件 `groups[chatId].preview`)——
// 真机由来:群里要求「随时都能打开」,agent 自己造了份配置用 `--config` 把回收全关(2026-07-30)。
// 「要不要长期把一个目录暴露在局域网」是 operator 的决定,不该被一句话说服;故给正规入口 = 按群覆盖,
// 同时禁掉 agent 用 `--config` 换策略(bin 侧)。
function normalizeOptions(raw, perGroup) {
  const base = raw && typeof raw === 'object' ? raw : {}
  const over = perGroup && typeof perGroup === 'object' ? perGroup : {}
  const o = { ...base, ...over }
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d)
  let from = Math.trunc(num(o.portFrom, PORT_FROM))
  let to = Math.trunc(num(o.portTo, PORT_TO))
  if (from < 1 || from > 65535) from = PORT_FROM
  if (to < from || to > 65535) to = Math.min(65535, Math.max(from, PORT_TO > from ? PORT_TO : from))
  const idleMin = Math.trunc(num(o.idleMin, IDLE_MIN_DEFAULT))
  const maxHours = num(o.maxHours, MAX_HOURS_DEFAULT)
  return {
    from, to, idleMin, maxHours,
    host: typeof o.host === 'string' && o.host.trim() ? o.host.trim() : '0.0.0.0',
    idleMs: idleMin > 0 ? idleMin * 60_000 : 0,
    maxMs: maxHours > 0 ? Math.round(maxHours * 3_600_000) : 0,
  }
}

// ── 端口 ─────────────────────────────────────────────────────────────────────
// FNV-1a:要的只是「同 chatId 恒同起点、不同 chatId 散得开」,不是密码学强度。
function _hash(s) {
  let h = 0x811c9dc5
  const str = String(s == null ? '' : s)
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

// 该群的首选端口:同群恒定 ⇒ 「同一项目固定复用一个端口」在机制层兑现(v0.8.1 清单只写了约定)。
function preferredPort(chatId, { from = PORT_FROM, to = PORT_TO } = {}) {
  const lo = Math.min(from, to); const hi = Math.max(from, to)
  const span = hi - lo + 1
  return lo + (_hash(chatId) % span)
}

// 绑定候选序:首选端口起环形扫全段。**由 worker 按序试绑**(不在受理侧先探再交给 worker 绑 ——
// 那中间有竞态窗,受理侧打印出去的 URL 可能绑不上,agent 就把死链发进群了)。受理侧改为回读
// worker 写下的实际端口再打印,URL 恒真。`only` = --port 显式指定:候选只有它,占用就报人话。
function portCandidates(chatId, { from = PORT_FROM, to = PORT_TO, only } = {}) {
  const lo = Math.min(from, to); const hi = Math.max(from, to)
  if (only != null) return [Number(only)]
  const span = hi - lo + 1
  const start = preferredPort(chatId, { from: lo, to: hi })
  const out = []
  for (let i = 0; i < span; i++) out.push(lo + ((start - lo + i) % span))
  return out
}

// ── 围栏 ─────────────────────────────────────────────────────────────────────
// 无论在哪一层目录都不服务的东西。点开头的一律拒(覆盖 .git/.env/.ssh/.DS_Store…),这里只列
// 点号之外的。⚖ 拍板 B:denylist 起步而非扩展名白名单 —— 白名单会挡掉正常原型资源(wasm/字体/
// 视频/自造扩展名),真机踩到再收紧。
const DENY_NAMES = new Set(['node_modules'])
const DENY_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.asc', '.ppk'])
const DENY_FILE_RE = [/^sbot\.config.*\.json$/i, /^id_(rsa|dsa|ecdsa|ed25519)$/i]

// 单个路径段是否拒绝服务。段级判定(不是整串正则)⇒ 任何层级的 node_modules/.git 都挡得住。
function isDeniedSegment(seg) {
  const s = String(seg || '')
  if (!s || s === '.' || s === '..') return true
  if (s.startsWith('.')) return true // 点文件/点目录:.git/.env/.ssh/.claude…
  if (DENY_NAMES.has(s.toLowerCase())) return true
  if (DENY_EXT.has(path.extname(s).toLowerCase())) return true
  return DENY_FILE_RE.some((re) => re.test(s))
}

const isDenied = (rel) => String(rel || '').split(/[\\/]/).filter(Boolean).some(isDeniedSegment)

// serveRoot 裁决。**故意是 resolveSendPath(feishu.js)的超集**:同样的 cwd 围栏 + 多两层 ——
//   ① realpath 判定:resolveSendPath 不解析符号链接。单文件外发时无所谓,但一个要被 HTTP handler
//      **遍历**的目录里,只要有一条指向 ~/ 的软链就是逃逸。故受理时判 realpath 仍在 workdir 内。
//   ② 默认拒绝项目根:v0.8.1 那起事故的实质就是「整个项目目录被暴露一周」。要这么干必须显式
//      --project-root,且受理时往群里发一行告知(bin 侧),不静默放行。
// 不 require feishu.js 复用那 4 行:那会把 lark SDK 拖进一个完全不需要它的长命 worker 进程。
// 注入 realpathSync/statSync ⇒ 纯逻辑可单测。
function resolveServeTarget({ cwd, rel, projectRoot = false, realpathSync = fs.realpathSync, statSync = fs.statSync } = {}) {
  if (!rel || !String(rel).trim()) throw new Error('缺少路径:sbot preview start <项目内相对路径>')
  const p = String(rel)
  if (path.isAbsolute(p)) throw new Error('只允许项目目录内的相对路径,拒绝绝对路径:' + p)
  if (p.split(/[\\/]/).includes('..')) throw new Error("路径不得包含 '..':" + p)
  const root = path.resolve(cwd || process.cwd())
  const abs = path.resolve(root, p)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径超出项目目录:' + p)
  let st
  try { st = statSync(abs) } catch { throw new Error('路径不存在:' + p) }
  // realpath 容器判定(软链逃逸):两边都解析后再比,否则 workdir 自身带软链时会误判越界
  let realRoot; let realAbs
  try { realRoot = realpathSync(root); realAbs = realpathSync(abs) } catch (e) {
    throw new Error(`路径解析失败(${(e && e.code) || (e && e.message)})—— 无法确认它在项目目录内,不敢服务`)
  }
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) throw new Error('路径经符号链接指到了项目目录之外,拒绝服务:' + p)
  const serveRoot = st.isDirectory() ? realAbs : path.dirname(realAbs)
  const entry = st.isDirectory() ? 'index.html' : path.basename(realAbs)
  // ⚠ 必须查**整串**而不只是 entry 的文件名:只查文件名的话,`start .private/proto` 会把一个点目录
  // 下的整棵子树挂上局域网(denied 的那几段已经烘进 serveRoot,每请求的判定再也看不到它们)。
  // 文档承诺的是「无论在哪一层」,这里就得真按整串兑现。以 realRoot 起算,projectRoot 情形是空串。
  const relFromRoot = path.relative(realRoot, realAbs)
  if (isDenied(relFromRoot)) throw new Error('这个路径不在可服务范围内(点目录/点文件、node_modules、密钥、配置一律不服务):' + p)
  if (serveRoot === realRoot && !projectRoot) {
    throw new Error(`会把整个项目目录暴露到局域网 —— 把原型放到子目录(如 design/prototype/)再起;\n确实要服务项目根请显式加 --project-root(会在群里告知)`)
  }
  if (st.isDirectory()) {
    // 目录形态必须有 index.html:不做目录列表(列表 = 把目录结构送出去),也不猜首页
    let ist
    try { ist = statSync(path.join(serveRoot, 'index.html')) } catch { ist = null }
    if (!ist || !ist.isFile()) throw new Error(`${p} 里没有 index.html —— 目录形态需要它当首页(不做目录列表);或直接把那个 .html 文件传给 start`)
  }
  // single = 传进来的是**一个文件** ⇒ 只服务这一个文件,兄弟文件一律 404。
  // 真机由来(2026-07-30):agent 把原型放在 design/ 下、传的是文件,结果整个 design 目录(20 个文件:
  // board-history.jsonl、diagrams 全部源码、十几张历史图)都上了局域网 —— 而它对用户说的是「仅暴露
  // design 目录中的原型文件」。这不只是暴露面问题,是**让 agent 对用户说了假话**。自包含单文件本来
  // 不需要任何兄弟文件(那正是推荐路径);要带 assets 的原型就传目录,语义与暴露面从此一致。
  return { serveRoot, entry, single: !st.isDirectory(), projectRoot: serveRoot === realRoot }
}

// worker 侧的记录复核。**为什么需要**:`--_worker` 名义上是内部入口,但 `BASE_SKILL_ALLOWS` 放行的是
// `Bash(sbot preview *)` ⇒ agent 够得着,而 worker 原本对记录内容一个字都不校验(围栏只在受理侧跑过)。
// 实测(v0.9.0 提交后自查):自造一份 `{serveRoot:"$HOME", projectRoot:true}` 的记录喂给 `--_worker`,
// 整个家目录就被挂上去了(`~/Projects/sbot/package.json` 返 200)—— 受理侧那套「拒项目根 / 整串
// denylist / workdir 围栏」被完整绕过。**记录是不可信输入**,围栏必须在这里重跑一遍。
//
// 锚点取 **operator 配置里该群的 workdir**,而不是记录自称的 workdir —— 后者同样是攻击者可写的
// (伪造 `workdir:"/" + projectRoot:true` 就能自洽通过)。残余风险:能往 `~/.sbot/preview/` 写文件
// 或能伪造配置文件的对手仍可绕过 —— 但那种对手已经能直接读文件了,围栏的职责是不让 sbot 自己的
// 工具变成「把任意目录挂上局域网」的便捷入口。
function verifyRecordFence(rec, { anchorWorkdir, realpathSync = fs.realpathSync, statSync = fs.statSync } = {}) {
  if (!rec || !rec.serveRoot || !rec.entry) throw new Error('记录缺 serveRoot/entry')
  const root = anchorWorkdir || rec.workdir
  if (!root) throw new Error('记录缺 workdir 锚点')
  // ⚠ 锚点必须先 realpath 再算相对路径:`serveRoot` 是受理时 realpath 过的,而锚点来自
  // **operator 手写的配置**(或 rec.workdir),完全可能走软链(`/Users/x/proj` → `/Volumes/data/proj`)。
  // 两者文本根不同 ⇒ path.relative 会吐出 `../../..`,把**合法**预览一并拒掉(误杀,实现时被单测抓到)。
  let base = root
  try { base = realpathSync(root) } catch { /* 锚点目录不在了:用原值,下面 statSync 会拒 */ }
  // ⚠ 必须**按记录声明的形态**去重跑裁决,不能一律拼 serveRoot+entry:那样算出来的永远是「文件
  // 路径」⇒ 裁决恒返回 single=true,目录形态的记录必然被判「与裁决不符」而全部起不来(实现时
  // 单文件/目录两种模式都跑了一遍才抓到 —— 只测一种就会带着「目录预览全挂」发版)。
  //   single=true(文件形态)⇒ 用 serveRoot/entry 这个文件复核,期望裁决也说 single=true
  //   single=false(目录形态)⇒ 用 serveRoot 这个目录复核,期望裁决说 single=false 且 entry=index.html
  // 谎报形态也逃不掉:目录形态照样要过 index.html 存在、denylist、拒项目根、realpath 容器判定。
  const rel = rec.single ? path.relative(base, path.join(rec.serveRoot, rec.entry)) : path.relative(base, rec.serveRoot)
  const t = resolveServeTarget({ cwd: base, rel, projectRoot: !!rec.projectRoot, realpathSync, statSync })
  if (t.serveRoot !== rec.serveRoot || t.entry !== rec.entry) throw new Error('serveRoot/entry 与围栏裁决不符')
  // single 要与裁决自洽(文件形态的 entry 必须真是文件、目录形态必须真是目录且有 index.html)。
  // ⚠ 别把它当安全边界:目录形态本来就是**合法可选**的(agent 直接 `start <目录>` 即可拿整个目录),
  // 所以改记录里的 single 并不能拿到「本来拿不到的东西」。single 的价值是**最小暴露的默认值** ——
  // 要一个文件就只给这一个文件,好让 agent 那句「仅暴露原型文件」是真话(2026-07-30 真机:它这么
  // 说了,而实际整个 design 目录 20 个文件都在局域网上)。
  if (!!rec.single !== !!t.single) throw new Error('single(单文件模式)与围栏裁决不符')
  return t
}

// 每个请求的路径裁决(worker 热路径)。token 做**路径前缀**而非 query,是为了让页面里的**相对**
// 资源引用照常工作(绝对引用 /assets/x.css 会失效 —— 与「首选自包含单文件」的约定一致)。
// 返回 { ok:true, abs } 或 { ok:false, code, reason }:一律 404 不回显细节,免得成探测器。
function resolveRequestPath({ serveRoot, urlPath, token, entry = 'index.html', single = false, realpathSync = fs.realpathSync, statSync = fs.statSync } = {}) {
  let raw = String(urlPath || '')
  const q = raw.search(/[?#]/)
  if (q >= 0) raw = raw.slice(0, q)
  let segs
  try { segs = raw.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s)) } catch { return { ok: false, code: 400, reason: 'bad-encoding' } }
  if (!segs.length || segs[0] !== token) return { ok: false, code: 404, reason: 'token' } // 局域网扫到端口也拿不到内容
  const rest = segs.slice(1)
  // 目录形态的裸访问(/<token> 或 /<token>/)⇒ 首页;其余逐段过围栏(编码后的 ..%2f 在这里已解码)
  const parts = rest.length ? rest : [entry]
  if (parts.some(isDeniedSegment)) return { ok: false, code: 404, reason: 'denied' }
  // 单文件模式:只有 entry 本身可取,兄弟文件一律 404(见 resolveServeTarget 的 single 注释)
  if (single && !(parts.length === 1 && parts[0] === entry)) return { ok: false, code: 404, reason: 'not-entry' }
  const abs = path.resolve(serveRoot, ...parts)
  if (abs !== serveRoot && !abs.startsWith(serveRoot + path.sep)) return { ok: false, code: 404, reason: 'escape' }
  let real
  try { real = realpathSync(abs) } catch { return { ok: false, code: 404, reason: 'missing' } }
  if (real !== serveRoot && !real.startsWith(serveRoot + path.sep)) return { ok: false, code: 404, reason: 'symlink-escape' }
  let st
  try { st = statSync(real) } catch { return { ok: false, code: 404, reason: 'missing' } }
  if (st.isDirectory()) return { ok: false, code: 404, reason: 'directory' } // 无目录列表
  if (!st.isFile()) return { ok: false, code: 404, reason: 'not-file' }
  return { ok: true, abs: real, size: st.size, mtimeMs: st.mtimeMs }
}

// ── 记录 ─────────────────────────────────────────────────────────────────────
function newRecord({ chatId, workdir, serveRoot, entry, label, port, candidates, host, idleMs, maxMs, projectRoot, single, configPath }) {
  const cands = Array.isArray(candidates) && candidates.length ? candidates.slice() : (port ? [port] : [])
  return {
    id: crypto.randomBytes(5).toString('hex'),
    token: crypto.randomBytes(5).toString('hex'), // 能力 URL:扫到端口≠拿到内容
    chatId, workdir, serveRoot, entry,
    configPath: configPath || null, // worker 复核围栏时要读同一份配置取该群 workdir 作锚点(imagen 同款)
    label: label || '', host: host || '0.0.0.0',
    // 候选序在受理侧算好(纯函数可单测),worker 只按序试绑 —— 绑定权在 worker,受理侧回读实际端口
    candidates: cands,
    port: port || cands[0] || null, // 受理时是首选值,worker 绑成功后写实际值
    projectRoot: !!projectRoot,
    single: !!single, // 只服务 entry 这一个文件(文件形态);目录形态为 false
    idleMs: idleMs == null ? IDLE_MIN_DEFAULT * 60_000 : idleMs,
    maxMs: maxMs == null ? MAX_HOURS_DEFAULT * 3_600_000 : maxMs,
    pid: null, startedAt: Date.now(), lastReqAt: null, reqCount: 0,
    status: 'starting', // starting → running → stopped | fail
    stoppedReason: null, notifyPending: false,
  }
}

const recordFile = (dir, id) => path.join(dir, id + '.json')

function writeRecord(dir, rec) {
  fs.mkdirSync(dir, { recursive: true })
  atomicWriteJSON(recordFile(dir, rec.id), rec)
  return rec
}

function readRecord(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function listRecords(dir) {
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const n of names) {
    if (!/^[0-9a-f]+\.json$/.test(n)) continue // 跳过 .log 等
    try { out.push(readRecord(path.join(dir, n))) } catch { /* 损坏条目跳过 */ }
  }
  return out.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

// 「活着的」= starting/running 且(未接手 or 进程在)。starting 也算活 —— 防受理竞态起两个。
function isLive(rec, { isAlive = pidAlive } = {}) {
  if (!rec || (rec.status !== 'running' && rec.status !== 'starting')) return false
  if (rec.pid == null) return true
  return isAlive(rec.pid)
}

// 本群当前那一个(一群最多一个,见 docs/PREVIEW.md)。多条并存(异常残留)取最新,旧的交给 reaper。
function findLive(dir, chatId, { isAlive = pidAlive } = {}) {
  const live = listRecords(dir).filter((r) => r && r.chatId === chatId && isLive(r, { isAlive }))
  return live.length ? live[live.length - 1] : null
}

// 杀 worker。它没有子进程(就是个 node http 服务),故 POSIX 一发 SIGTERM 即可;win32 沿用仓库
// 既有的 taskkill 惯例。**杀完由调用方 markStopped**(「谁杀谁写」)。bin 与控制台共用这一份。
function killWorker(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') require('node:child_process').spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    else process.kill(pid, 'SIGTERM')
  } catch { /* 已经死了 */ }
}

// 标记停止(收割方调用 —— 「谁杀谁写」)。notify=true 的会被 reaper 拾起发群一行。
function markStopped(dir, rec, reason, { notify = false } = {}) {
  const next = { ...rec, status: 'stopped', stoppedReason: reason, stoppedAt: Date.now(), notifyPending: !!notify }
  writeRecord(dir, next)
  return next
}

// 历史记录修剪:只删已停的老条目,活的一概不动。
function pruneRecords(dir, { keep = KEEP_STOPPED, isAlive = pidAlive } = {}) {
  const stopped = listRecords(dir).filter((r) => r && !isLive(r, { isAlive }))
  const drop = stopped.slice(0, Math.max(0, stopped.length - keep))
  for (const r of drop) {
    try { fs.unlinkSync(recordFile(dir, r.id)) } catch {}
    try { fs.unlinkSync(path.join(dir, r.id + '.log')) } catch {} // worker 的 stdio 落盘,别只删记录留一堆日志
  }
  return drop.length
}

// ── URL 与展示 ───────────────────────────────────────────────────────────────
function buildUrl(rec, hostAddr) {
  const h = hostAddr || (rec && rec.host && rec.host !== '0.0.0.0' && rec.host !== '::' ? rec.host : '127.0.0.1')
  return `http://${h}:${rec.port}/${rec.token}/${rec.entry}`
}

const LOOPBACK_RE = /^(127\.0\.0\.1|localhost|::1)$/i

// 可点链接用哪个地址:绑了环回就只能是 127.0.0.1;绑 0.0.0.0 则取本机第一个 LAN IP(群成员够得着,
// 同控制台口径)。**CLI / doctor / 控制台三处共用这一份** —— 此前是三处各自内联同一段判断(其中
// 控制台还把正则重抄了一遍),属「CLI 与控制台同源,改一处两边同步」要防的那种漂移。
function hostForUrl(rec, ips = []) {
  if (rec && rec.host && LOOPBACK_RE.test(String(rec.host))) return '127.0.0.1'
  return (Array.isArray(ips) && ips[0]) || '127.0.0.1'
}

// serveRoot 的展示形态:项目内则给相对路径(`.` = 项目根),否则原样。
// 两处讲究:① 前缀比对**带分隔符守卫**(否则 workdir `/a/proj` 会把 `/a/project-x` 当成自己的子目录);
// ② serveRoot 是 realpath 过的、workdir 是 process.cwd() 原样 —— workdir 带软链时两者前缀对不上,
// 故 realpath 一次再比(比不出来就退绝对路径,只是显示难看,不影响判定)。
function displayRoot(rec, { realpathSync = fs.realpathSync } = {}) {
  const abs = (rec && rec.serveRoot) || ''
  const root = (rec && rec.workdir) || ''
  if (!abs || !root) return abs
  let real = root
  try { real = realpathSync(root) } catch { /* 目录没了/读不动:用原值试 */ }
  for (const base of root === real ? [root] : [root, real]) {
    if (!base) continue
    if (abs === base) return '.'
    const withSep = base.endsWith(path.sep) ? base : base + path.sep
    if (abs.startsWith(withSep)) return abs.slice(withSep.length) || '.'
  }
  return abs
}

// 「实际服务到哪」的展示:single(文件形态)⇒ 到那个文件;目录形态 ⇒ 到目录。
// 控制台/doctor 都用它 —— 只显示 serveRoot 会让单文件模式看着像在服务整个目录(说谎)。
function displayServed(rec, opts) {
  const root = displayRoot(rec, opts)
  if (!rec || !rec.single || !rec.entry) return root
  return root === '.' ? rec.entry : root + '/' + rec.entry
}

// ── 回收判定 ─────────────────────────────────────────────────────────────────
// 顺序有讲究:先看进程死没死(dead 之后其它判断都没意义)→ 群还在不在 → 群暂停 → 总时长 → 闲置。
// 返回 null = 不动它。reason 决定要不要发群通知(unbound 不发 —— 群都没了)。
//
// `policy`(v0.9.3):**回收策略以配置为准,不用记录里的快照**。真机踩到(2026-07-31)——
// operator 在控制台勾了「常驻」、群里也收到「已设为常驻」通知,预览却照样按闲置 30 分钟停了:
// idleMs/maxMs 是 start 那一刻快照进记录的,之后改配置没人回头改它。而同一个收割器里 `paused`
// 一直是**每 tick 现读配置**的 ⇒ 同一个判定函数里两套口径,漏的是这一半。
// 缺省(policy=null)退回记录快照:CLI/测试直接调用时不必凭空造策略,行为与旧版一致。
function reapDecision(rec, { now = Date.now(), bound = true, paused = false, isAlive = pidAlive, policy = null } = {}) {
  if (!rec || (rec.status !== 'running' && rec.status !== 'starting')) return null
  const t = typeof now === 'function' ? now() : now
  if (rec.pid != null && !isAlive(rec.pid)) return { reason: 'dead', notify: true }
  // starting 迟迟不上位(worker 没起来/秒崩):给 60s 宽限,过后按 dead 收,免得永久占着「本群那一个」
  if (rec.status === 'starting' && t - (rec.startedAt || 0) > 60_000) return { reason: 'dead', notify: false }
  if (!bound) return { reason: 'unbound', notify: false }
  // 群暂停 ⇒ 收但**不发消息**:「暂停 = 群里安静」是既有口径(cron 到点跳过、画布轮询跳过),
  // 而暂停通知本身已经说了「期间消息不处理、定时任务与画布播报停发」。这里再补一条属于打扰。
  if (paused) return { reason: 'paused', notify: false }
  // 配置值优先(见上);只认有限数,坏配置退回快照而不是当成 0 —— 0 的语义是「永不回收」,
  // 让一个写坏的字段把服务变成常驻,方向正好反了(fail-safe 要往「会停」那边倒)。
  const pol = policy && typeof policy === 'object' ? policy : null
  const maxMs = pol && Number.isFinite(pol.maxMs) ? pol.maxMs : rec.maxMs
  const idleMs = pol && Number.isFinite(pol.idleMs) ? pol.idleMs : rec.idleMs
  if (maxMs > 0 && t - (rec.startedAt || 0) > maxMs) return { reason: 'max', notify: true }
  if (idleMs > 0 && t - (rec.lastReqAt || rec.startedAt || 0) > idleMs) return { reason: 'idle', notify: true }
  return null
}

// daemon 侧收割器(工厂全注入,同 createScheduler/createBoardWatch 风格)。职责三件:
//   ① 该收的收(kill + 写 stopped) ② 拾起 notifyPending 发群一行(worker 自己闲置停下的那些也在这)
//   ③ 修剪历史记录
// worker 自尽路径为什么还要 ② :worker 不带飞书 SDK(它只是个静态服务,不该为发一句话拖进 SDK)
// ⇒ 它把 notifyPending 立起来,由 daemon 代发。没 daemon 就没通知 —— 没 daemon 时群消息本来也发不出。
const NOTIFY_STUCK_MS = 5 * 60_000 // 一条通知发超过这么久仍未 settle ⇒ 认作卡死,放行重试

function createPreviewReaper({ dir, groupState, kill, notify, now = Date.now, isAlive = pidAlive, log = () => {}, tickMs = 60_000, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  let timer = null
  // 正在发的 id → 开始时刻。清标志是异步的,慢发送遇上下一 tick 会重发,故要去重;但**不能只用
  // Set** —— 若 platform.send 永不 settle(SDK 卡住),那条 id 会永久留在集合里,通知既不重试也不
  // 上报、群里永远收不到。项目其它等待都有兜底(waitPreviewBound 4s / withFileLock / hardReleaseMs),
  // 这里同理:超过 NOTIFY_STUCK_MS 就当它废了,放行重试。
  const notifying = new Map()
  const nowMs = () => (typeof now === 'function' ? now() : now)
  function tick() {
    let recs
    try { recs = listRecords(dir) } catch (e) { log('preview reaper 读记录失败: ' + (e && e.message)); return }
    for (const rec of recs) {
      try {
        const gs = (groupState && groupState(rec.chatId)) || { bound: true, paused: false }
        const d = reapDecision(rec, { now: nowMs(), bound: gs.bound !== false, paused: !!gs.paused, isAlive, policy: gs })
        if (d) {
          // ⚠ 顺序要紧:**先落判定再杀**。反过来的话,worker 在收到信号前的那点时间里若还有 in-flight
          // 请求,它会把 status 写回 'running' 并抹掉 notifyPending(实现期实测复现过)⇒ 群里收不到
          // 「预览已停止」。先落盘,worker 那侧的写前回读就能看见判定并自己退场(两层防线)。
          markStopped(dir, rec, d.reason, { notify: d.notify })
          if (rec.pid != null && isAlive(rec.pid)) { try { kill(rec.pid) } catch (e) { log('preview kill 失败: ' + (e && e.message)) } }
          log(`preview 已回收(${d.reason}): ${rec.label || rec.entry} :${rec.port}`)
          continue // 通知留到下一 tick 统一走 ② —— 一个动作只做一件事,失败也只重试通知
        }
        // 策略对齐(v0.9.3):配置里的回收策略变了 ⇒ 写进记录,让 **worker 侧**的自尽判定也跟上。
        // 收割方这边已经用配置值判过了(上面的 policy),但 worker 不认配置、只认磁盘这份记录 ——
        // 少了这一步,operator 勾了常驻、daemon 这边不收了,worker 自己还是会到点把它停掉。
        // 只动活记录;回读合并,别把 worker 刚写的 lastReqAt/reqCount 冲掉。
        if (rec.status === 'running' || rec.status === 'starting') {
          const wantIdle = Number.isFinite(gs.idleMs) ? gs.idleMs : rec.idleMs
          const wantMax = Number.isFinite(gs.maxMs) ? gs.maxMs : rec.maxMs
          if (wantIdle !== rec.idleMs || wantMax !== rec.maxMs) {
            const cur = readRecordSafe(dir, rec)
            // 回读后可能已被判停(worker 自尽/另一路收割);那就别把它写回活的样子
            if (cur && (cur.status === 'running' || cur.status === 'starting')) {
              writeRecord(dir, { ...cur, idleMs: wantIdle, maxMs: wantMax })
              log(`preview 策略跟随配置更新(${rec.label || rec.entry} :${rec.port}): 闲置 ${wantIdle > 0 ? Math.round(wantIdle / 60_000) + ' 分钟' : '不回收'} · 时长 ${wantMax > 0 ? Math.round(wantMax / 3_600_000) + ' 小时' : '不限'}`)
            }
          }
        }
        if (rec.notifyPending) {
          // 群暂停期间不发(同上口径)—— 且**清掉标志**而不是攒着:等群恢复时这条早就过时了,
          // 攒着只会在恢复瞬间倒出一堆陈旧的「预览已停止」。
          if (gs.paused) { writeRecord(dir, { ...rec, notifyPending: false }); continue }
          const started = notifying.get(rec.id)
          if (started != null && nowMs() - started < NOTIFY_STUCK_MS) continue // 上一轮还在发,别发第二条
          if (started != null) log(`preview 通知疑似卡死(${Math.round((nowMs() - started) / 1000)}s),重试一次`)
          notifying.set(rec.id, nowMs())
          const text = buildStoppedMessage(rec, rec.stoppedReason)
          Promise.resolve(notify(rec.chatId, text))
            .then(() => writeRecord(dir, { ...readRecordSafe(dir, rec), notifyPending: false }))
            .catch((e) => log('preview 通知失败(下轮重试): ' + (e && e.message)))
            .finally(() => notifying.delete(rec.id))
        }
      } catch (e) { log('preview reaper: ' + (e && e.message)) }
    }
    try { pruneRecords(dir, { isAlive }) } catch {}
  }
  // 清 notifyPending 前重读:通知是异步的,期间记录可能被别处改过(比如同群又起了新预览)
  function readRecordSafe(d, rec) {
    try { return readRecord(recordFile(d, rec.id)) } catch { return rec }
  }
  return {
    tick,
    // 定时器注入(默认真 setInterval)⇒ 「start 幂等」「unref 了」这两条主张可被单测真验证,
    // 而不是靠一条零断言的测试装作验过。
    start() { if (timer) return; timer = setIntervalFn(tick, tickMs); if (timer && timer.unref) timer.unref() },
    stop() { if (timer) clearIntervalFn(timer); timer = null },
  }
}

// ── 文案 ─────────────────────────────────────────────────────────────────────
// 自动停止**必须**发群一行:不通知的自动回收 = 群成员点链接打不开、以为 bot 坏了。
function buildStoppedMessage(rec, reason) {
  const name = rec && (rec.label || rec.entry) ? (rec.label || rec.entry) : '预览'
  const idleMin = Math.round(((rec && rec.idleMs) || 0) / 60_000)
  const hours = Math.round((((rec && rec.maxMs) || 0) / 3_600_000) * 10) / 10
  const again = '\n还要看就在群里说一声,我再起一个。'
  switch (reason) {
    case 'idle': return `⏹ 预览已停止:${name} — 闲置超过 ${idleMin} 分钟自动回收。${again}`
    case 'max': return `⏹ 预览已停止:${name} — 已运行满 ${hours} 小时(单次上限)。${again}`
    case 'paused': return `⏹ 预览已停止:${name} — 本群项目已暂停,预览一并停掉了。`
    case 'dead': return `⚠ 预览意外停止:${name} — 链接暂时打不开了。${again}`
    case 'console': return `⏹ 预览已停止:${name} — 由控制台手动停止。${again}`
    default: return `⏹ 预览已停止:${name}。${again}`
  }
}

// 受理成功的 stdout(给 agent 看)。**这段话是本技能的主要交付物** —— 它替掉的正是「拖着本轮
// 不结束给服务续命」那个反射,所以「不要等待/不要拖轮次」必须写在最显眼处。
function buildStartedText(rec, url, { replaced = null, idleMin = 30, maxHours = 0, lan = true } = {}) {
  const L = []
  if (replaced) L.push(`(已替换上一个预览:${replaced.label || replaced.entry} :${replaced.port})`)
  L.push(`预览已启动:${url}`)
  // 绑定地址决定这句话的真假:环回绑定(preview.host 设成 127.0.0.1)时群成员**打不开**,
  // 不能照抄「手机也能打开」—— 承诺必须与实际绑定一致,否则 agent 会把打不开的链接发进群。
  L.push(lan
    ? `把这个链接发到群里即可(同一局域网的手机/电脑都能打开)。`
    : `⚠ 本机预览只绑了环回地址,**局域网里的群成员打不开** —— 要给群里看,请让管理员把预览绑定地址改成 0.0.0.0;或者直接把 html 当文件发群里。`)
  L.push(`服务已脱离本轮独立运行 —— **不要等待、不要轮询、更不要为了让链接有效而拖着本轮不结束**,现在就可以正常收尾。`)
  // ⚠ 真机(2026-07-30):idleMin=0 时这里只说「用完请 stop」,没提总时长上限仍在 ⇒ agent 以为完全
  // 不回收了,进而对用户说「不再按闲置或时长自动停止」。回收策略必须**逐项如实**,否则它照着编。
  const hours = maxHours > 0 ? (Math.round(maxHours * 10) / 10) : 0
  const stopHint = ';要提前停:preview stop 动作'
  if (idleMin > 0) L.push(`闲置 ${idleMin} 分钟后自动停止(会在群里说一声),不用你记着关` + (hours ? `;最长运行 ${hours} 小时` : '') + stopHint)
  else if (hours) L.push(`本群未设闲置回收,但**仍会在运行满 ${hours} 小时后自动停止**(会在群里说一声)` + stopHint)
  else L.push('本群预览**不会自动停止**(闲置与时长上限都已由管理员关闭)—— 用完必须自己停掉,别把它一直挂在局域网上')
  // 这整段是给 agent 看的操作反馈,而 agent 会把其中的要点转告群里 ⇒ 明确划线:能转的是
  // 「链接 + 何时自动关」,工具名/命令/机器路径一律留在自己这边(产品对外只有一个身份)。
  L.push(`转告群里时:只说链接和「什么时候会自动关」—— **不要把命令、工具名、机器上的目录路径写进群消息**。`)
  return L.join('\n') + '\n'
}

function buildStatusLines(recs, { now = Date.now(), isAlive = pidAlive } = {}) {
  const t = typeof now === 'function' ? now() : now
  const live = recs.filter((r) => isLive(r, { isAlive }))
  if (!live.length) return ['(当前没有运行中的预览)']
  return live.map((r) => {
    const mins = (ms) => (ms == null ? '—' : Math.round(ms / 60_000) + ' 分钟')
    const idleLeft = r.idleMs > 0 ? Math.max(0, r.idleMs - (t - (r.lastReqAt || r.startedAt || 0))) : null
    // 常驻(两个上限都关)必须明说 —— 否则 operator 巡检时看不出「这个永远不会自己停」
    const policy = idleLeft != null ? `,闲置回收剩 ${mins(idleLeft)}`
      : r.maxMs > 0 ? `,最长运行 ${Math.round(r.maxMs / 3_600_000)} 小时` : ',⚠ 常驻(不会自动停)'
    return `${r.id}  :${r.port}  ${r.label || r.entry}  已运行 ${mins(t - (r.startedAt || 0))}` +
      `  访问 ${r.reqCount || 0} 次` +
      (r.lastReqAt ? `,最后 ${mins(t - r.lastReqAt)}前` : ',尚无访问') + policy
  })
}

// ── 单文件预览的关联素材(v0.11.29)────────────────────
// 反馈原话:「单文件预览未校验关联素材,导致资源 404」。**不是 bug 是设计**:v0.9.0 起
// 文件形态只服务 entry 那一个文件、兄弟文件一律 404(最小暴露面 —— 当时的教训是 agent 把
// 原型丢在 design/ 下,整个设计资产目录被挂上局域网)。⇒ 收紧本身要保留,缺的是**没人
// 告诉用户素材会丢**:链接发出去了,打开一看图全裂,而受理时一句提示都没有。
//
// 做法与本项目其它几处一致:**不阻断、把问题在受理那一刻就说清楚**,并给出两条正路
// (改服务目录 / 把资源内联)。⚠ 故意**不自动改成目录形态** —— 那会扩大暴露面,而暴露面
// 的变化必须是人的显式决定(v0.9.0/v0.9.1 两次教训都指向这条)。

// 从 HTML 里扫出「会被 single 形态 404 掉」的本地引用。
// 只认真正会发请求的那几种:link[href] / script[src] / img|video|audio|source|iframe[src]
// / srcset / 内联样式里的 url()。跳过:协议地址(http、//)、data:/blob:、#锚点、
// 绝对路径(/x —— 那本来也不归这个服务管)、以及模板占位({{x}}、${x})。
function scanLocalRefs(html, { max = 12 } = {}) {
  const src = String(html == null ? '' : html)
  const out = []
  const push = (raw) => {
    const u = String(raw || '').trim().replace(/^['"]|['"]$/g, '')
    if (!u) return
    if (/^(https?:)?\/\//i.test(u)) return          // 外链
    if (/^(data|blob|mailto|tel|javascript):/i.test(u)) return
    if (u.startsWith('#') || u.startsWith('/')) return
    if (/[{}$]/.test(u)) return                      // 模板占位,不是真路径
    const clean = u.split(/[?#]/)[0]
    if (!clean) return
    if (!out.includes(clean)) out.push(clean)
  }
  for (const m of src.matchAll(/<link\b[^>]*?\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) push(m[1])
  for (const m of src.matchAll(/<(?:script|img|video|audio|source|iframe|embed)\b[^>]*?\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) push(m[1])
  for (const m of src.matchAll(/\bsrcset\s*=\s*("[^"]*"|'[^']*')/gi)) {
    for (const part of m[1].replace(/^['"]|['"]$/g, '').split(',')) push(part.trim().split(/\s+/)[0])
  }
  for (const m of src.matchAll(/url\(\s*("[^"]*"|'[^']*'|[^)]+)\s*\)/gi)) push(m[1])
  return out.slice(0, max)
}

// 受理时的提示。⚠ 措辞要点:①说清后果(打开会裂)而不是只报「有引用」②两条正路都给全
// ③**不说「失败」** —— 服务确实起来了,只是这些资源取不到。
function localRefsWarning(refs, { entry = '', dirHint = '' } = {}) {
  if (!refs || !refs.length) return ''
  const L = ['⚠ 这是**单文件**预览:只有 ' + entry + ' 本身能取到,它引用的下面这些会 404(页面打开会缺样式/图片):']
  for (const r of refs) L.push('   · ' + r)
  L.push('两条路二选一:')
  L.push('   ① 想让它们也能取到 ⇒ 改成服务它们所在的目录:`sbot preview start ' + (dirHint || '<该文件所在目录>') + '`')
  L.push('      ⚠ 那会把该目录下**所有**文件挂到局域网上 —— 先确认里面没有不该给人看的东西(设计资产、导出的数据、备份)')
  L.push('   ② 想保持只暴露一个文件 ⇒ 把样式/脚本内联进 HTML、图片转成 data: URI,再重新起')
  L.push('把这件事**在群里说清楚再发链接** —— 别让人点开看到一个裂的页面。')
  return L.join('\n')
}

module.exports = {
  PORT_FROM, PORT_TO, IDLE_MIN_DEFAULT, MAX_HOURS_DEFAULT, LASTREQ_DEBOUNCE_MS, KEEP_STOPPED,
  previewDir, normalizeOptions,
  preferredPort, portCandidates,
  isDeniedSegment, isDenied, resolveServeTarget, verifyRecordFence, resolveRequestPath,
  newRecord, recordFile, writeRecord, readRecord, listRecords, pidAlive, isLive, findLive, markStopped, pruneRecords, killWorker,
  buildUrl, hostForUrl, displayRoot, displayServed, reapDecision, createPreviewReaper, NOTIFY_STUCK_MS,
  buildStoppedMessage, buildStartedText, buildStatusLines,
  scanLocalRefs, localRefsWarning,
}
