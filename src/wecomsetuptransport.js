"use strict"
const { createWecomPlatform } = require('./platform/wecom')

// How long setup waits for the first message after the bot connects.
const WECOM_GROUP_WAIT_MS = 10 * 60 * 1000
const GROUP_NOTICE = '在企业微信里给机器人发一句话（单聊，或在群里 @它）即可完成接入。'
const CONFIRM_REPLY_MS = 5000

// The conversation a setup message binds: a group @mention (its wr… id) or a
// direct chat, which the adapter maps to the reserved wr_dm_<hex userid> id.
// The adapter carries the chat type in replyCtx, not on the message itself.
const CHAT_ID = /^wr[A-Za-z0-9_-]{1,124}$/
function boundConversation(message) {
  const chatId = message?.chatId
  const chatType = message?.replyCtx?.chatType
  if (typeof chatId !== 'string' || !CHAT_ID.test(chatId) || !['group', 'single'].includes(chatType)) return null
  // A direct chat must arrive under its mapped id; a group id never carries that prefix.
  if ((chatType === 'single') !== chatId.startsWith('wr_dm_')) return null
  return { chatId, chatType }
}

// A bounded setup connection owns the socket until the first message (a direct
// chat or a group @mention). `confirm` may check the binding while the socket
// is still open and return a sentence to reply with. The connection is closed
// before the daemon starts; no production connection is probed.
async function discoverWecomGroup({ botId, secret, signal, inboxDir, onNotice = () => {}, notice = GROUP_NOTICE,
  confirm = null, timeoutMs = WECOM_GROUP_WAIT_MS, createPlatform = createWecomPlatform } = {}) {
  if (typeof botId !== 'string' || !botId.trim() || typeof secret !== 'string' || !secret.trim()) {
    throw new Error('请填写机器人 Bot ID 和 Secret')
  }
  if (signal?.aborted) throw new Error('已取消接入')
  let timer, abort, adapter
  try {
    const found = await new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        error ? reject(error) : resolve(value)
      }
      abort = () => finish(new Error('已取消接入'))
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish(new Error('等待消息超时，请在企业微信里给机器人发一句话后重试')), timeoutMs)
      adapter = createPlatform({ botId: botId.trim(), secret: secret.trim(), cli: false,
        pollSec: 0, inboxDir, log: () => {},
        onIssue: () => finish(new Error('机器人连接不可用，请检查凭据及是否被其他设备使用')) })
      if (notice) onNotice(notice)
      Promise.resolve(adapter.start(message => {
        const bound = boundConversation(message)
        if (bound) finish(null, { ...bound, replyCtx: message.replyCtx || null })
      })).catch(() => finish(new Error('机器人连接失败，请检查凭据和网络')))
    })
    clearTimeout(timer)
    if (signal?.aborted) throw new Error('已取消接入')
    if (confirm) {
      const text = await confirm({ chatId: found.chatId, chatType: found.chatType })
      if (signal?.aborted) throw new Error('已取消接入')
      // Best effort: the binding does not depend on the reply arriving.
      if (text && found.replyCtx && typeof adapter.reply === 'function') {
        let wait
        await Promise.race([Promise.resolve().then(() => adapter.reply(found.replyCtx, text)).catch(() => null),
          new Promise(resolve => { wait = setTimeout(resolve, CONFIRM_REPLY_MS) })])
        clearTimeout(wait)
      }
    }
    return found.chatId
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (adapter && await adapter.stop({ strict: true }) !== true) {
      throw new Error('机器人连接尚未完全关闭，请稍后重试')
    }
  }
}

// The reply that tells the person in WeCom the binding worked.
const confirmReply = projectName => `已连接项目 ${projectName}，可以直接发任务。`

module.exports = { discoverWecomGroup, boundConversation, confirmReply, WECOM_GROUP_WAIT_MS, GROUP_NOTICE }
