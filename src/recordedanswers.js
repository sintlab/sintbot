'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { redact } = require('./core/redact')

// Read only the bounded observation file. Never open/rewrite execution journals
// or infer that a stored draft reached Feishu.
function readRecordedAnswers({ dataDir, chatId, id = '' }) {
  if (!path.isAbsolute(dataDir || '') || !chatId) throw new Error('缺少当前服务的数据目录或群信息，无法读取本机答复记录')
  const file = path.join(dataDir, 'activity-v1.json')
  let data
  try {
    if (fs.statSync(file).size > 12 * 1024 * 1024) throw new Error('size')
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.rows) || data.rows.length > 256) throw new Error('format')
  } catch { throw new Error('本机答复记录不存在或不可读；不能据此判断机器人没有回复') }
  const rows = data.rows.filter(row => row && row.chatId === chatId && typeof row.id === 'string' &&
    (!id || row.id === id || Array.isArray(row.receiptIds) && row.receiptIds.includes(id) ||
      Array.isArray(row.messages) && row.messages.some(message => message?.sourceMessageId === id)))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, id ? 1 : 10)
  return { source: 'local-activity-v1', retention: '全服务最多保留最近 256 轮；每轮答复最多 16384 字符；旧记录可能没有消息 ID',
    chatId, answers: rows.map(row => ({ id: row.id, ts: row.ts,
      status: row.status, deliveryConfirmed: row.status === 'answered',
      truncated: !!row.truncated, reply: redact(String(row.reply || ''), { pii: false }).slice(0, 16384),
      sourceMessageIds: (Array.isArray(row.messages) ? row.messages : []).map(message => message?.sourceMessageId).filter(id => typeof id === 'string') })) }
}
module.exports = { readRecordedAnswers }
