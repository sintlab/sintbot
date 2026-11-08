// 企业微信机器人的名字从哪来:平台没有「取机器人信息」的接口(长连接命令集 / 官方命令行工具都没有),但群成员 @ 它时
// 消息正文里就带着「@SintBot」—— 而长连接只推 @ 机器人的消息,所以每条群消息里必有它的名字。这里只做纯逻辑:
//   mentionsOf(text)    正文里的 @ 名字列表(名字到空白 / 全角标点为止;两个人名连着 @ 时各算各的)
//   guessBotName(msgs)  一批群历史消息里出现最多的那个 @ 名字 ⇒ 机器人名(群里被 @ 最多的就是它;别人也会被 @,但没它多)
// 守护进程收到 @ 消息时现学现用(wecom.js),控制台「刷新身份」扫近几天群历史统计后落进配置(server.js)。
// 手填框去掉了:填错一个字,剥 @ 和点名判断就全失效,而对不对只有群里知道。

const MENTION_RE = /@([^\s@,，。!！?？:：;；、()()\[\]【】]+)/g

// 零宽字符(U+200B~200D / 2060 / FEFF)不在 JS 的 \s 里,手机端粘贴夹带时会学成「SintBot\u200b」这种名字 —— 与剥 @ 那边(wecom.js ZERO_WIDTH_RE)同口径,入口先去掉
const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g
function mentionsOf(text) {
  const out = []
  const s = String(text || '').replace(ZERO_WIDTH_RE, '')
  let m
  while ((m = MENTION_RE.exec(s))) { const n = m[1].trim(); if (n) out.push(n) }
  return out
}

// 一条历史消息的所有文字片段(text / 图文混排里的 text 项;两套字段名都认)
function textsOf(m) {
  if (!m) return []
  if (m.msg_type === 'text') return [String((m.text && m.text.content) || '')]
  if (m.msg_type === 'mixed') return ((m.mixed && (m.mixed.items || m.mixed.msg_item)) || []).filter((it) => it && it.msg_type === 'text').map((it) => String((it.text && it.text.content) || ''))
  return []
}

// 返回 { name, count, total }:total = 含 @ 的消息数;name = null 表示一条 @ 都没见到
function guessBotName(msgs) {
  const counts = new Map()
  let total = 0
  for (const m of msgs || []) {
    const names = new Set(textsOf(m).flatMap(mentionsOf))
    if (!names.size) continue
    total++
    for (const n of names) counts.set(n, (counts.get(n) || 0) + 1)
  }
  let best = null, bestN = 0
  for (const [n, c] of counts) if (c > bestN) { best = n; bestN = c }
  return { name: best, count: bestN, total }
}

module.exports = { mentionsOf, guessBotName, textsOf }
