"use strict"
const { createWecomPlatform } = require('./platform/wecom')

// A bounded setup connection owns the socket until the first group message.
// It is closed before the daemon starts; no production connection is probed.
async function discoverWecomGroup({ botId, secret, signal, inboxDir, onNotice = () => {},
  timeoutMs = 180000, createPlatform = createWecomPlatform } = {}) {
  if (typeof botId !== 'string' || !botId.trim() || typeof secret !== 'string' || !secret.trim()) {
    throw new Error('请填写机器人 Bot ID 和 Secret')
  }
  if (signal?.aborted) throw new Error('已取消接入')
  let timer, abort, adapter
  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, chatId) => {
        if (settled) return
        settled = true
        error ? reject(error) : resolve(chatId)
      }
      abort = () => finish(new Error('已取消接入'))
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish(new Error('等待群消息超时，请确认机器人已添加到群后重试')), timeoutMs)
      adapter = createPlatform({ botId: botId.trim(), secret: secret.trim(), cli: false,
        pollSec: 0, inboxDir, log: () => {},
        onIssue: () => finish(new Error('机器人连接不可用，请检查凭据及是否被其他设备使用')) })
      onNotice('请将机器人添加到目标企业微信群，并在群里 @ 机器人发送“连接”。')
      Promise.resolve(adapter.start(message => {
        if (message?.chatType === 'group' && /^wr[A-Za-z0-9_-]+$/.test(message.chatId || '')) {
          finish(null, message.chatId)
        }
      })).catch(() => finish(new Error('机器人连接失败，请检查凭据和网络')))
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (adapter && await adapter.stop({ strict: true }) !== true) {
      throw new Error('机器人连接尚未完全关闭，请稍后重试')
    }
  }
}
module.exports = { discoverWecomGroup }
