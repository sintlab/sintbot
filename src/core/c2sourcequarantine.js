'use strict'

const FEISHU_MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,124}$/

// An operator must carry these exact source IDs across every restart of a
// restricted trial. A fresh journal alone cannot recognize messages already
// accepted by different, preserved authorities.
function createC2V2SourceQuarantine(value, { required = false } = {}) {
  if (typeof required !== 'boolean') throw new TypeError('C2 source quarantine mode invalid')
  const raw = Array.isArray(value) ? value : [value]
  if (!raw.length || raw.length > 2 ||
      (raw.length === 2 && (raw[0] === undefined || raw[0] === '') &&
        raw[1] !== undefined && raw[1] !== '')) {
    throw new TypeError('C2 v2 blocked source list invalid')
  }
  const ids = raw.filter(id => id !== undefined && id !== '')
  if (!ids.length) {
    if (required) throw new Error('C2 v2 formal service needs an explicit blocked source message ID')
    return null
  }
  if (ids.some(id => typeof id !== 'string' || !FEISHU_MESSAGE_ID.test(id)) ||
      new Set(ids).size !== ids.length) {
    throw new TypeError('C2 v2 blocked source message ID invalid')
  }
  const sourceIds = Object.freeze([...ids])
  return Object.freeze({ sourceId: sourceIds[0], sourceIds,
    rejects: message => sourceIds.includes(message?.msgId) })
}

module.exports = { createC2V2SourceQuarantine }
