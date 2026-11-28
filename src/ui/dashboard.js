'use strict'
// 控制台「需要你处理」收件箱 + 实时活动的账本回填(纯逻辑,可测;读写盘只在 readLedgerTail / createDismissStore)。
//
// 为什么要有收件箱:agent 跑得越久、群越多,「哪里在等我」就越难从聊天记录和概览各区里拼出来 ——
// 失败的轮次、没人认领的浏览器接管、没处理的反馈、残留进程,此前散在群消息和概览的四个地方。
// 这里只**汇总**,不新增通知渠道:群里该说的照旧在群里说,控制台是人主动来看的地方。
//
// 为什么要回填:活动流是内存环形缓冲,daemon 一重启(含每次发版)概览就是空的,而账本一直在盘上。
// 回填的事件 id 与引擎同形(`chatId:ts`),之后 SSE 重放同一轮也只会原地覆盖,不会重复。

const fs = require('node:fs')
const path = require('node:path')

const FAIL_STATUSES = new Set(['error', 'failed']) // stopped 是人按的、no-reply 是设计如此、empty 会自己重试一次 —— 都不算「要人管」
const FAIL_WINDOW_MS = 72 * 3600_000 // 三天前的失败,人早就在群里重说过或者放弃了
const MAX_FAILS = 20
const DISMISS_TTL_MS = 7 * 24 * 3600_000
const DISMISS_MAX = 200

const groupLabel = (groups, chatId) => {
  const g = groups && groups[chatId]
  return (g && g.name) || String(chatId || '').slice(-8)
}

// 只读账本末尾一段:账本一轮一行、只增不减(本机 30 天约 4,600 行),整本读进来没必要。
// 从中间切开时丢掉第一行残片;坏行跳过(账本是 best-effort 追加,半行是可能的)。
function readLedgerTail(file, maxBytes = 512 * 1024) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    const rows = []
    for (const l of lines) {
      if (!l.trim()) continue
      try { const r = JSON.parse(l); if (r && typeof r === 'object') rows.push(r) } catch { /* 半行 / 坏行 */ }
    }
    return rows
  } catch { return [] } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
}

// 账本尾巴按 (大小, 修改时刻) 缓存:收件箱每次刷新都要读,账本却只在一轮结束时才变 ——
// 本机尾部 512 KB 约 2,400 行,没变也每次解析一遍是白干。返回的数组是共享的,调用方别改它。
function createLedgerTail(file, maxBytes) {
  let key = null
  let rows = []
  return {
    rows() {
      let st
      try { st = fs.statSync(file) } catch { key = null; rows = []; return rows }
      const k = `${st.size}:${st.mtimeMs}`
      if (k !== key) { rows = readLedgerTail(file, maxBytes); key = k }
      return rows
    },
  }
}

// 账本行 → 活动事件(形状对齐引擎的 done 事件)。定时脚本行跳过:它没有模型、没有 token,
// 本机 30 天里占了 93%,混进来活动流就只剩脚本了。返回从旧到新(与活动缓冲同序)。
function ledgerActivity(rows, groups, n = 20) {
  const turns = (rows || []).filter((r) => r && !r.script && r.ts && r.chatId)
  return turns.slice(-n).map((r) => ({
    id: `${r.chatId}:${r.ts}`,
    ts: r.ts,
    chatId: r.chatId,
    group: String(r.chatId).slice(-8), // 与引擎 meta.group 同口径;群名由控制台按 chatId 换
    name: groupLabel(groups, r.chatId),
    sender: r.sender || '',
    text: r.text || '',
    kind: 'done',
    status: r.status || '',
    ms: r.ms || 0,
    tokens: r.tokens || null,
    ...(r.err ? { err: String(r.err) } : {}),
    fromLedger: true,
  }))
}

// 失败轮次:同群同一个人之后又有 ok 轮 ⇒ 当作已经重说过、自动消失 —— 否则一次网络抖动的失败
// 要在收件箱里挂三天,人只能一条条手动忽略。
function failedTurns(rows, now) {
  const recent = (rows || []).filter((r) => r && !r.script && r.ts > now - FAIL_WINDOW_MS)
  const out = []
  for (let i = 0; i < recent.length; i++) {
    const f = recent[i]
    if (!FAIL_STATUSES.has(f.status)) continue
    const retried = recent.slice(i + 1).some((r) => r.chatId === f.chatId && r.sender === f.sender && r.status === 'ok')
    if (!retried) out.push(f)
  }
  return out.slice(-MAX_FAILS)
}

// 汇总成一张单子。文案不在这里拼:控制台有中英两套界面,这里只给事实(kind + 字段),由前端成句。
//   failed     失败的轮次 · 可忽略
//   takeover   agent 在群里发了接管链接、还没人认领(只算挂了群卡的票;管理员自己在控制台签的不算)
//   issues     反馈本里没处理的(一行汇总,点了滚到反馈本)
//   leftovers  残留的后台进程(同上)
//   preview    服务整个项目目录的预览(全部代码都在局域网上可读)
//   health     健康检查没通过的项(一行汇总,排最前:它是「现在就坏着」,没有发生时刻可排)
function buildInbox({ ledgerRows = [], issues = null, previews = [], leftovers = null, health = null, update = null, takeovers = [], groups = {}, dismissed = new Set(), now = Date.now() } = {}) {
  const items = []
  if (update && update.available && update.latestVersion) {
    items.push({ key: `update:${update.latestVersion}`, kind: 'update', from: update.currentVersion || '', to: update.latestVersion, ts: update.checkedAt || now, dismissable: true })
  }
  for (const f of failedTurns(ledgerRows, now)) {
    items.push({ key: `failed:${f.chatId}:${f.ts}`, kind: 'failed', chatId: f.chatId, group: groupLabel(groups, f.chatId), ts: f.ts,
      sender: f.sender || '', text: f.text || '', err: f.err ? String(f.err) : '', dismissable: true })
  }
  for (const t of takeovers || []) {
    if (!t || !t.chatId) continue
    items.push({ key: `takeover:${t.id}`, kind: 'takeover', chatId: t.chatId, group: groupLabel(groups, t.chatId), ts: t.at, exp: t.exp,
      pageTitle: t.pageTitle || '', pageUrl: t.pageUrl || '' })
  }
  if (issues && issues.openCount > 0) {
    const latest = (issues.open || [])[0]
    items.push({ key: 'issues', kind: 'issues', count: issues.openCount, ts: latest ? latest.ts : null })
  }
  const lo = leftovers && Array.isArray(leftovers.rows) ? leftovers.rows : []
  if (lo.length) {
    const oldest = Math.max(...lo.map((x) => Number(x.ageSec) || 0))
    items.push({ key: 'leftovers', kind: 'leftovers', count: lo.length, ts: now - oldest * 1000 })
  }
  for (const p of previews || []) {
    if (!p || !p.projectRoot) continue
    items.push({ key: `preview:${p.id}`, kind: 'preview', chatId: p.chatId, group: p.name || groupLabel(groups, p.chatId), ts: now - (Number(p.upMs) || 0), port: p.port })
  }
  const sorted = items.filter((it) => !dismissed.has(it.key)).sort((a, b) => (b.ts || 0) - (a.ts || 0))
  const bad = health && Array.isArray(health.rows) ? health.rows.filter((r) => r && r.status === 'fail') : [] // warn 不算:那是「可以更好」,不是「在等你」
  return bad.length ? [{ key: 'health', kind: 'health', count: bad.length, labels: bad.map((r) => String(r.label || '')) }, ...sorted] : sorted
}

// 「忽略」记在盘上(daemon 重启不复活),7 天后清、最多 200 条 —— 失败轮次本身 72 小时就出窗口了,
// 留 7 天只是余量。文件读坏就当空:最坏是几条已忽略的失败重新出现,不阻断任何东西。
function createDismissStore({ file, now = Date.now, log = () => {} } = {}) {
  let keys = null // key -> 忽略时刻
  const load = () => {
    if (keys) return
    keys = new Map()
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const [k, t] of Object.entries((d && d.keys) || {})) if (typeof t === 'number') keys.set(k, t)
    } catch { /* 没有 / 读坏 ⇒ 空 */ }
  }
  const prune = () => {
    const t = now()
    for (const [k, at] of keys) if (!(at > t - DISMISS_TTL_MS)) keys.delete(k)
    const extra = keys.size - DISMISS_MAX
    if (extra > 0) for (const k of [...keys.keys()].slice(0, extra)) keys.delete(k) // Map 按插入序 ⇒ 先丢最老的
  }
  return {
    set() { load(); prune(); return new Set(keys.keys()) },
    add(key) {
      load(); keys.delete(key); keys.set(String(key), now()); prune()
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        const tmp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, keys: Object.fromEntries(keys) }) + '\n', { mode: 0o600 })
        fs.renameSync(tmp, file)
      } catch (e) { log(`inbox: 写不进 ${path.basename(file)}(${e.message})—— 这次忽略只在内存里`) }
    },
  }
}

module.exports = { FAIL_WINDOW_MS, readLedgerTail, createLedgerTail, ledgerActivity, failedTurns, buildInbox, createDismissStore }
