'use strict'
const { createSlackPlatform, isSlackChatId, isSlackDmChatId } = require('./platform/slack')

// How long setup waits for the first message after the app connects.
const SLACK_WAIT_MS = 10 * 60 * 1000
const SLACK_NOTICE = '在 Slack 里给机器人发一句话（私聊，或在已邀请它的频道里 @它）即可完成接入。'
const CONFIRM_REPLY_MS = 5000
const CONNECT_WAIT_MS = 30_000

// The conversation a setup message binds: a direct message, or a channel
// message that mentions the bot. The adapter already maps both to the
// reserved `oc_slack_<channel>` identity and drops unmentioned channel talk.
function boundConversation(message) {
  const chatId = message?.chatId
  if (!isSlackChatId(chatId) || message?.replyCtx?.chatId !== chatId) return null
  return { chatId, chatType: isSlackDmChatId(chatId) ? 'direct' : 'channel' }
}

// A bounded setup connection owns the app's socket until the first message.
// `confirm` may check the binding while the socket is still open and return a
// sentence to reply with. The connection is closed before the service opens
// its own: Slack hands each event to one of an app's connections at random,
// so two at once would lose messages.
async function discoverSlackConversation({ botToken, appToken, signal, inboxDir, onNotice = () => {}, notice = SLACK_NOTICE,
  confirm = null, timeoutMs = SLACK_WAIT_MS, connectWaitMs = CONNECT_WAIT_MS, createPlatform = createSlackPlatform } = {}) {
  if (typeof botToken !== 'string' || !botToken.trim() || typeof appToken !== 'string' || !appToken.trim()) {
    throw new Error('请填写应用级令牌和 Bot Token')
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
      timer = setTimeout(() => finish(new Error('等待消息超时，请在 Slack 里给机器人发一句话后重试')), timeoutMs)
      adapter = createPlatform({ botToken: botToken.trim(), appToken: appToken.trim(), durable: true,
        onlyWhenMentioned: true, inboxDir, log: () => {},
        onConn: snapshot => { if (snapshot?.state === 'failed') finish(new Error('Slack 连接不可用，请检查两枚令牌是否仍然有效')) } })
      Promise.resolve(adapter.start(message => {
        const bound = boundConversation(message)
        if (bound) finish(null, { ...bound, replyCtx: message.replyCtx })
      })).then(async () => {
        // The notice only follows a live connection: a message sent earlier would be lost.
        if (await adapter.ready(connectWaitMs) !== true) return finish(new Error('连不上 Slack，请检查网络或代理后重试'))
        if (notice) onNotice(notice)
      }).catch(() => finish(new Error('Slack 连接失败，请检查令牌和网络')))
    })
    clearTimeout(timer)
    if (signal?.aborted) throw new Error('已取消接入')
    if (confirm) {
      const text = await confirm({ chatId: found.chatId, chatType: found.chatType })
      if (signal?.aborted) throw new Error('已取消接入')
      // Best effort: the binding does not depend on the reply arriving.
      if (text && found.replyCtx) {
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
      throw new Error('Slack 连接尚未完全关闭，请稍后重试')
    }
  }
}

// The reply that tells the person in Slack the binding worked.
const confirmReply = projectName => `已连接项目 ${projectName}，可以直接发任务。命令以 ! 开头，例如 !status。`

module.exports = { discoverSlackConversation, boundConversation, confirmReply, SLACK_WAIT_MS, SLACK_NOTICE }
