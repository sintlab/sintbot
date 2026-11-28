// GFM 表格扫描(v0.11.5 从 engine.js 提炼共享):引擎的「表格伴随文本」与飞书卡片的
// 「原生表格渲染」共用同一套判定 —— 两处各写一份的话,「卡片认成了表格、伴随文本却没跟上」
// 这种不一致没人会当 bug 报(与 swatchLayout 两端共用几何同理)。
// 判定保守防误判:只认「| 开头且 | 结尾」的整行(散文里的竖线不算),必须是 GFM 形状
// (第二行是分隔行)且分隔行外至少两行(表头+≥1 行数据)—— 光有表头没数据不算;
// 代码块围栏内的竖线一律不算(agent 贴 shell 管道命令是常态)。

const splitCells = (l) => {
  // 转义竖线 \| 是单元格内容不是分隔符 —— 先换成占位符(NUL,正文里不可能出现)再切,切完还原
  let s = l.trim().replace(/\\\|/g, '\u0000')
  s = s.replace(/^\|/, '').replace(/\|$/, '')
  return s.split('|').map((c) => c.replace(/\u0000/g, '|').trim())
}
const isSepRow = (l) => { const cs = splitCells(l); return cs.length > 0 && cs.every((c) => /^:?-+:?$/.test(c)) }

// 单元格转纯文本:链接留「标题 地址」(转发场景地址才是干货)、剥粗体/行内代码标记、
// <br/> 转空格(真换行会破 TSV/单行结构)。
const cleanCell = (c) => String(c)
  .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (_m, t, u) => (t && u ? `${t} ${u}` : t || u))
  .replace(/\*\*|`/g, '')
  .replace(/<br\s*\/?>/gi, ' ')

// 把回答文本切成段序列 [{kind:'text',text} | {kind:'table',header:[…],rows:[[…]]}]。
// 单元格保留原始 markdown(消费方按需清理/渲染);不构成表格的竖线行原样退回文本段。
function scanTables(text) {
  const src = String(text == null ? '' : text)
  const segs = []
  let textBuf = []
  let run = []
  let inFence = false
  const flushText = () => { if (textBuf.length) { segs.push({ kind: 'text', text: textBuf.join('\n') }); textBuf = [] } }
  const flushRun = () => {
    const rows = run; run = []
    if (rows.length >= 3 && isSepRow(rows[1])) {
      const cellRows = rows.filter((r) => !isSepRow(r)).map(splitCells)
      if (cellRows.length >= 2) {
        flushText()
        segs.push({ kind: 'table', header: cellRows[0], rows: cellRows.slice(1) })
        return
      }
    }
    textBuf.push(...rows)
  }
  for (const raw of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; flushRun(); textBuf.push(raw); continue }
    if (!inFence && /^\s*\|.*\|\s*$/.test(raw)) { run.push(raw); continue }
    flushRun(); textBuf.push(raw)
  }
  flushRun(); flushText()
  return segs
}

// 表格 → Tab 分隔纯文本(引擎「表格伴随文本」用):长按可复制、粘贴进电子表格自动分列。
// 无表格 ⇒ 空串。多张表格空行分隔。
function mdTablesToText(text) {
  if (!text || String(text).indexOf('|') === -1) return ''
  const tables = []
  for (const seg of scanTables(text)) {
    if (seg.kind !== 'table') continue
    tables.push([seg.header, ...seg.rows].map((r) => r.map(cleanCell).join('\t')).join('\n'))
  }
  return tables.join('\n\n')
}

module.exports = { scanTables, mdTablesToText, cleanCell }
