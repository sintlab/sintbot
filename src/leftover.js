// 遗留进程:agent 轮次结束后仍活着的后台 shell(v0.11.108)。
//
// 为什么要有这一层:claude 子进程退了,它在轮中用后台方式起的 shell(轮询循环 / nohup 的脚本 /
// 卡住的 expect)并不跟着退 —— 父进程没了就挂到 pid 1 下面,而且 Claude Code 给每条 Bash 开的是
// **自己的进程组**(pgid = 自身 pid),runner 轮次结束的树杀抓不到它们。2026-10-09 在生产机上翻出
// 三个:其中一条 `until node -e …; do sleep 5; done` 每 5 秒调一次线上云函数,跑了 35 天,零 CPU、
// 零报警,一个月前某次 ps 输出里出现过也没人当回事。缺的不是围栏(四个群 1.27 万次 Bash 调用里
// 后台循环零次 —— 不常见),是**看得见**:doctor 一行 + 控制台概览一区 + 一键结束。
//
// 判据(三条同时成立才算):
//   ① ppid === 1(父进程已退,被 launchd / init 收养)
//   ② 命令行带 `shell-snapshots/snapshot-`(Claude Code 的 Bash 工具起 shell 时 source 的快照,
//      是「这条 shell 是 agent 起的」唯一可靠标记;别的进程不会带它)
//   ③ 存活 ≥ minAgeSec(默认 1 小时):刚结束的轮里还在收尾的后台命令不该被报;一小时还在跑的
//      几乎都是忘了停的循环 / 卡住的等待(轮次墙钟上限才 90 分钟)
// ⚠ 只报与「一键结束」,**不自动杀** —— 偶尔也有 agent 故意留下的东西(比如起了个 dev server
//   在看),杀不杀是 operator 的判断;自动杀等于把一次误判变成一次事故。
// ⚠ Windows 没有 ps、也没有这套 shell 快照 ⇒ supported:false,一行不占(与 browser 行同款:
//   没有的东西不吓人)。
// 纯函数(解析 / 判据 / 摘要)与 I/O(ps / kill)分开,前者单测钉死;ps 与 kill 都可注入。

const { execFile } = require('node:child_process')
const { redact } = require('./core/redact') // 出站脱敏:命令行里可能有 agent 写进去的密钥

const IS_WIN = process.platform === 'win32'
const SNAPSHOT_RE = /shell-snapshots[\\/]snapshot-/
const DEFAULT_MIN_AGE_SEC = 60 * 60
const PS_ARGS = ['-axo', 'pid=,ppid=,etime=,command=']

// ps 的 etime 形态:`ss`?不会;`mm:ss` / `hh:mm:ss` / `dd-hh:mm:ss`。解析不了返回 null(别当 0,
// 0 会让「存活多久」这条判据静默失效 —— 所有行都当刚起的,永远报不出来)。
function parseEtime(s) {
  const m = String(s || '').trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const [, d, h, mi, se] = m
  return (Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(mi) * 60) + Number(se)
}

// `ps -axo pid=,ppid=,etime=,command=` 的输出 → 行记录。command 可能含任意空白,只按前三列切。
function parsePs(text) {
  const rows = []
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), ageSec: parseEtime(m[3]), command: m[4] })
  }
  return rows
}

function isLeftover(row, minAgeSec = DEFAULT_MIN_AGE_SEC) {
  if (!row || row.ppid !== 1) return false
  if (!SNAPSHOT_RE.test(String(row.command || ''))) return false
  return row.ageSec != null && row.ageSec >= minAgeSec
}

// 把 Claude Code 那段 shell 前导(source 快照 && setopt … && { unalias } && eval '<命令>' < /dev/null
// && pwd -P >| /tmp/claude-xxxx-cwd)剥掉,只留 agent 真正写的那条命令 —— 控制台 / doctor 要给人看的
// 是「它在干什么」,不是机器路径(零工具名:快照路径、/tmp 落点都是实现细节)。剥不干净就退回
// 粗剪:去掉快照前导之前的部分;再不行原样截断。
function summarizeCommand(cmd, max = 100) {
  let s = String(cmd || '')
  const ev = s.match(/\beval '([\s\S]*)' < \/dev\/null/)
  // eval 单引号串里嵌的单引号有两种写法:'\'' 与 '"'"',都还原成 '
  if (ev) s = ev[1].replace(/'\\''/g, "'").replace(/'"'"'/g, "'")
  else {
    const i = s.search(SNAPSHOT_RE)
    if (i >= 0) {
      // 快照之后的 `… || true && ` 链是前导;取最后一个 `&& ` 之后、`< /dev/null` 之前的段
      const tail = s.slice(i).replace(/ < \/dev\/null[\s\S]*$/, '')
      const parts = tail.split(/ \|\| true && /)
      s = parts[parts.length - 1].replace(/^\{[^}]*\}\s*&&\s*/, '')
    }
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function describeAge(sec) {
  if (sec == null) return '?'
  if (sec >= 86400) return `${Math.floor(sec / 86400)} 天`
  if (sec >= 3600) return `${Math.floor(sec / 3600)} 小时`
  return `${Math.max(1, Math.floor(sec / 60))} 分钟`
}

function runPs() {
  return new Promise((resolve, reject) => {
    execFile('ps', PS_ARGS, { maxBuffer: 16 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
}

// 列出遗留进程。{ supported, rows:[{pid, ageSec, age, command, summary}], error? }
// opts.ps 注入(测试);opts.minAgeSec 判据;opts.isWin 注入平台(测试)。
async function list(opts = {}) {
  const isWin = opts.isWin == null ? IS_WIN : !!opts.isWin
  if (isWin) return { supported: false, rows: [] }
  let out
  try { out = await (opts.ps || runPs)() } catch (e) { return { supported: true, rows: [], error: (e && e.message) || String(e) } }
  // command / summary 都过一遍出站脱敏:agent 写的后台循环可能带 `-H "Authorization: Bearer …"`,
  // 这两个字段会进 doctor stdout / 控制台 / 审计账本
  const rows = parsePs(out).filter((r) => isLeftover(r, opts.minAgeSec)).map((r) => ({
    pid: r.pid, ageSec: r.ageSec, age: describeAge(r.ageSec), command: redact(r.command), summary: redact(summarizeCommand(r.command)),
  })).sort((a, b) => b.ageSec - a.ageSec)
  return { supported: true, rows }
}

// 带 TTL 的列表:控制台每次 /api/state 都会问,ps 一次几十毫秒,30 秒内复用。
let CACHE = { at: 0, val: null }
async function cachedList(opts = {}) {
  const ttl = opts.ttlMs == null ? 30_000 : opts.ttlMs
  const now = (opts.now || Date.now)()
  if (CACHE.val && now - CACHE.at < ttl) return CACHE.val
  const val = await list(opts)
  CACHE = { at: now, val }
  return val
}
function clearCache() { CACHE = { at: 0, val: null } }

// pid 的全部后代(按 ppid 链广度优先),用于组杀失败时兜底。
function descendants(rows, pid) {
  const out = []; const seen = new Set([pid]); const q = [pid]
  while (q.length) {
    const p = q.shift()
    for (const r of rows) if (r.ppid === p && !seen.has(r.pid)) { seen.add(r.pid); out.push(r.pid); q.push(r.pid) }
  }
  return out
}

// 结束一组遗留进程。三条纪律(对抗审查 10-09 逮出来的):
//   ① **动手前按身份复核**:只对此刻仍满足「ppid 1 + 快照标记」的 pid 发信号(不看年龄),其余归 skipped。
//      名单是分钟级之前的快照,pid 会回绕复用 —— 最坏是新起的一轮 Bash shell 顶了这个号、它正好也是
//      组长,照单 SIGKILL -pid 会把活着的轮次整组掐掉。
//   ② 先整个进程组 SIGTERM(真实 wrapper 自成一组,子 sleep / expect 一起收),宽限后 SIGKILL 兜底
//      (实测 expect 不理 SIGTERM);**组杀打不到(不是组长 / 组已散)就本体 + 全部后代逐个发**,只杀外层
//      zsh 会让真正在打接口的 node / curl 被 pid 1 收养、从此没标记再也看不见。
//   ③ 杀完清缓存,调用方不必记得。ESRCH(已经不在)不算失败。ps / kill / sleep 可注入。
async function kill(pids, opts = {}) {
  const k = opts.kill || ((pid, sig) => process.kill(pid, sig))
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const graceMs = opts.graceMs == null ? 1500 : opts.graceMs
  const targets = [...new Set(pids.map(Number).filter((p) => Number.isInteger(p) && p > 1))]
  let rows
  try { rows = parsePs(await (opts.ps || runPs)()) } catch (e) {
    return { killed: [], failed: targets.map((pid) => ({ pid, error: 'ps: ' + ((e && e.message) || String(e)) })), skipped: [] }
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const skipped = targets.filter((pid) => !isLeftover(byPid.get(pid), 0))
  const live = targets.filter((pid) => !skipped.includes(pid))
  const failed = []
  const singles = new Map() // 组杀失败的 pid → 要逐个发信号的 [本体, ...后代](按动手前的 ps 快照算)
  const send = (pid, sig) => {
    if (!singles.has(pid)) { try { k(-pid, sig); return } catch {} singles.set(pid, [pid, ...descendants(rows, pid)]) }
    for (const q of singles.get(pid)) {
      try { k(q, sig) } catch (e) { if (!(e && e.code === 'ESRCH')) failed.push({ pid: q, sig, error: (e && e.message) || String(e) }) }
    }
  }
  for (const pid of live) send(pid, 'SIGTERM')
  if (live.length && graceMs > 0) await sleep(graceMs)
  for (const pid of live) send(pid, 'SIGKILL')
  clearCache()
  const failedPids = new Set(failed.map((f) => f.pid))
  return { killed: live.filter((p) => !failedPids.has(p)), failed, skipped }
}

// doctor / 控制台健康行共用的一句话。零工具名:不写命令、不写路径。
function describe(res) {
  if (!res || !res.supported) return null
  if (res.error) return { status: 'warn', text: `⚠ 查不了(${res.error})` }
  if (!res.rows.length) return { status: 'ok', text: '无 —— 对话轮次结束后没有留下后台进程' }
  const oldest = res.rows[0]
  const heads = res.rows.slice(0, 3).map((r) => `${r.age}前起:${r.summary.slice(0, 60)}`).join(' · ')
  return { status: 'warn', text: `⚠ ${res.rows.length} 个后台进程在对话轮次结束后仍在跑(最老 ${oldest.age}):${heads}${res.rows.length > 3 ? ' · …' : ''} —— 它们可能还在反复打接口 / 占端口,到概览里看一眼并结束` }
}

module.exports = { parseEtime, parsePs, isLeftover, summarizeCommand, describeAge, descendants, list, cachedList, clearCache, kill, describe, DEFAULT_MIN_AGE_SEC, SNAPSHOT_RE, PS_ARGS }
