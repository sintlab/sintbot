// 群内反馈本(issue)—— 每台 sbot 一本,存在本机 `~/.sbot/issues.jsonl`。
//
// 为什么要有它:群成员(产品、运营、业务同事)是这套系统真正的使用者,但他们的反馈至今
// 只能散在群消息里,靠 operator 事后翻聊天记录去捞 —— 2026-08-13 就丢过一次(4 条消息
// 静默蒸发,靠用户贴截图才被发现)。给他们一个够得着的入口,反馈才不会蒸发。
// ⚠ 与仓库托管平台上的 issue 无关,不同步、不关联:这是 sbot 自己的本地反馈本。
//
// 形态:**事件流 JSONL**,与 turns.jsonl / audit.jsonl 同族。open/close/reopen 各追加一行,
// 读时按 id 折叠成当前态 —— 从不改写历史行(崩溃安全、无锁读、天然可审计:谁在什么时候
// 关的、备注是什么,全留在文件里)。
//
// id 只在**本机**内递增(#7 这种短号,群里好念好报)。跨机汇总时用 `host` 字段区分,故
// 两台各自编号撞车也不影响 —— 全局标识是 host + id,而群成员只在自己那台的语境里念它。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 正文上限。⚠ 不是为了省空间(这本账一天几条),是防「顺手粘一整段日志/一屏报错」把
// 单行撑到兆级 —— 而这本账是要被整本读进来做分析的,一条撑爆等于整本读不动。
// 4000 字远超任何正常反馈的长度,截断处留标记,让人知道后面还有东西、别当成全文。
const MAX_TEXT = 4000
const TRUNC_MARK = '…(过长已截断)'

// ── 纯逻辑(无 IO,可单测)──────────────────────────────────────────────────

// 事件流 → 当前态。open 建档,close/reopen 只改状态与备注,其余字段一律以 open 那条为准
// (后续事件不许改写正文 —— 反馈原话是证据,不能被后来的操作悄悄改掉)。
// 未知 op 一律忽略:老版本读新文件时宁可少认几条,也不能整本读不出来。
function foldEvents(events) {
  const byId = new Map()
  for (const e of events) {
    if (!e || e.id == null) continue
    if (e.op === 'open') {
      byId.set(e.id, {
        id: e.id,
        ts: e.ts || 0,
        chatId: e.chatId || null,
        group: e.group || '',
        sender: e.sender || '',
        text: e.text || '',
        version: e.version || '',
        host: e.host || '',
        turn: e.turn || null,
        status: 'open',
        note: '',
        closedAt: 0,
      })
      continue
    }
    const cur = byId.get(e.id)
    if (!cur) continue // close 一个不存在的 id:忽略(文件被截断/手工编辑过)
    if (e.op === 'close') {
      cur.status = 'closed'
      cur.closedAt = e.ts || 0
      if (e.note) cur.note = e.note
    } else if (e.op === 'reopen') {
      cur.status = 'open'
      cur.closedAt = 0
      if (e.note) cur.note = e.note
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

// 下一个本机序号。⚠ 取「历史最大 + 1」而不是「条数 + 1」:后者在文件被手工删过行之后
// 会发出重复号,而重复号会让 close 打在错的那条上。
function nextId(issues) {
  let max = 0
  for (const i of issues) if (typeof i.id === 'number' && i.id > max) max = i.id
  return max + 1
}

// 正文规整:去首尾空白 + 封顶。截断只发生在超长时,正常反馈逐字保留(原话是证据)。
function clampText(text) {
  const s = String(text || '').trim()
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + TRUNC_MARK : s
}

// 解析一行 JSONL,坏行返回 null(整本不能因为一行坏掉就读不出来)。
function parseLines(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 坏行跳过 */ }
  }
  return out
}

// 群里回执 / CLI 列表共用的单行摘要。⚠ 正文压成一行并截断 —— 反馈里常有换行,
// 直接进列表会把一屏冲掉。
function summarize(issue, { width = 60 } = {}) {
  const t = String(issue.text || '').replace(/\s+/g, ' ').trim()
  return t.length > width ? t.slice(0, width) + '…' : t
}

// 出问题那一轮的技术指纹 —— 这是整个反馈本最值钱的一个字段。
// 群成员的原话通常是「它刚才没回我」,单靠这句没法查;带上那一轮的 status/耗时/token,
// 一眼就能分辨「空轮」「超时」「模型报错」还是「它其实答了但没看见」。
// ⚠ 只带指标不带**正常正文**:正文可能含群里的业务数据,而反馈本是要被跨机收集、集中分析的。
// ⚠ **失败原因是例外,而且必须显示**:它不是业务正文,是「为什么没成」——「模型报错」这一类
//   光看 status 只知道错了、不知道错在哪,拿到反馈的人还得再猜一遍(这正是本字段存在的理由)。
//   ⭐ 只有在**上游保证 err 里装的是错误文本、不是模型的正常回答**时这条才成立(见 engine 的
//   turnErrText:第一版就是拿正常正文冒充原因,那样带出去才真的破了上面那条规矩)。
//   指纹是给人扫一眼的,故这里再收一次长度;全文在 `issue show` 里。
function fingerprint(turn) {
  if (!turn) return ''
  const bits = []
  if (turn.status) bits.push(turn.status)
  if (turn.ms >= 0) bits.push(Math.round(turn.ms / 1000) + 's')
  const tk = turn.tokens
  if (tk) bits.push(`tokens{in:${tk.in ?? 0},out:${tk.out ?? 0}}`)
  if (turn.provider) bits.push(turn.provider)
  if (turn.err) bits.push(String(turn.err).replace(/\s+/g, ' ').trim().slice(0, 120))
  return bits.join(' · ')
}

// ── 落盘层(薄壳)────────────────────────────────────────────────────────
// withFileLock 从 store 注入而不是这里 require:core 里已有一份跨进程写锁实现,
// 两份锁 = 两把不同的锁,等于没锁。

function createIssues(file, { log = () => {}, withFileLock = (f, fn) => fn(), host = os.hostname().split('.')[0] } = {}) {
  const readAll = () => {
    try { return foldEvents(parseLines(fs.readFileSync(file, 'utf8'))) } catch { return [] }
  }
  const appendEvent = (ev) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.appendFileSync(file, JSON.stringify(ev) + '\n', { mode: 0o600 }) // 反馈原文含群成员的话,同账本只给自己读
  }
  return {
    file,
    host,
    // 新建。⚠ 「算号 + 追加」必须在同一把锁里:两个群同时提,分头算出的会是同一个号。
    add({ chatId, group, sender, text, version, turn } = {}) {
      let created = null
      withFileLock(file, () => {
        const id = nextId(readAll())
        const ev = {
          op: 'open',
          id,
          ts: Date.now(),
          chatId: chatId || null,
          group: group || '',
          sender: sender || '',
          text: clampText(text),
          version: version || '',
          host,
          turn: turn || null,
        }
        appendEvent(ev)
        created = { ...ev, status: 'open', note: '', closedAt: 0 }
      })
      return created
    },
    list({ all = false } = {}) {
      const arr = readAll()
      return all ? arr : arr.filter((i) => i.status === 'open')
    },
    get(id) {
      return readAll().find((i) => i.id === Number(id)) || null
    },
    // close/reopen 返回**变更后**的那条(调用方要拿它的 chatId 去原群回一句)。
    // 找不到 / 状态已经是目标态 ⇒ 返回 null,让调用方如实说「没这条」或「本来就是开着的」。
    setStatus(id, op, note) {
      const n = Number(id)
      // 备注先验形再走 clampText:到得了这里的两个入口(CLI / 控制台 API)都是 operator 侧,
      // 但 API 传来的可能不是字符串 —— 不拦就会以对象形态写进事件行,前端渲染时炸整页
      // (整本账连坐);拦成 '[object Object]' 也一样是脏数据。非字符串一律当没写。
      const clean = typeof note === 'string' ? clampText(note) : ''
      let out = null
      withFileLock(file, () => {
        const cur = readAll().find((i) => i.id === n)
        if (!cur) return
        if (op === 'close' && cur.status === 'closed') return
        if (op === 'reopen' && cur.status === 'open') return
        appendEvent({ op, id: n, ts: Date.now(), note: clean })
        out = { ...cur, status: op === 'close' ? 'closed' : 'open', note: clean || cur.note }
      })
      return out
    },
  }
}

module.exports = { createIssues, foldEvents, nextId, parseLines, summarize, fingerprint, clampText, MAX_TEXT }
