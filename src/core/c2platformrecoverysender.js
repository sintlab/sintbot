'use strict'

const { chatPlatform } = require('../config')

const RECEIPT_ID = /^[0-9a-f]{32}$/
const FEISHU_CHAT_ID = /^oc_[A-Za-z0-9_-]{1,124}$/
const FEISHU_MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,124}$/
const NOTICE_TEXT = '上一轮因服务中断未完成，请重新发送原请求。'

// A deliberately narrow recovery sender for a previously accepted Feishu
// message. The ordinary platform.reply() can fall back to a second send after
// an ambiguous SDK failure; startup recovery may make exactly one outward
// attempt, so use the same SDK's reply operation directly and never fall back.
// The caller supplies the active app's SDK client and the multi-platform
// router under its single-writer lease. Neither credentials nor reply text
// enter the durable receipt.
function createFeishuRecoverySender({ cfg, platform, client } = {}) {
  if (!cfg || typeof cfg !== 'object' || !cfg.groups ||
      !platform || typeof platform.names !== 'function' ||
      typeof platform.get !== 'function' || typeof platform.forChat !== 'function' ||
      !client || typeof client.im?.message?.reply !== 'function' ||
      !platform.names().includes('feishu') || !platform.get('feishu')) {
    throw new TypeError('C2 Feishu recovery needs active group routing and SDK client')
  }
  const feishu = platform.get('feishu')

  function validReceipt(receipt) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        !RECEIPT_ID.test(receipt.id || '') ||
        !FEISHU_CHAT_ID.test(receipt.chatId || '') ||
        receipt.source !== 'message' ||
        !FEISHU_MESSAGE_ID.test(receipt.sourceId || '')) {
      throw new TypeError('C2 Feishu recovery receipt identity invalid')
    }
    const group = cfg.groups[receipt.chatId]
    if (!group || chatPlatform(cfg, receipt.chatId) !== 'feishu' ||
        platform.get('feishu') !== feishu || platform.forChat(receipt.chatId) !== feishu) {
      throw new Error('C2 Feishu recovery group route is unavailable')
    }
  }

  function resolveTarget(receipt) {
    validReceipt(receipt)
    return Object.freeze({ receiptId: receipt.id, chatId: receipt.chatId,
      sourceId: receipt.sourceId,
      replyCtx: Object.freeze({ chatId: receipt.chatId, messageId: receipt.sourceId }) })
  }

  async function send(receipt, target) {
    validReceipt(receipt)
    if (!target || typeof target !== 'object' || Array.isArray(target) ||
        target.receiptId !== receipt.id || target.chatId !== receipt.chatId ||
        target.sourceId !== receipt.sourceId ||
        target.replyCtx?.chatId !== receipt.chatId ||
        target.replyCtx?.messageId !== receipt.sourceId) {
      throw new Error('C2 Feishu recovery target differs from durable receipt')
    }
    try {
      const response = await client.im.message.reply({
        path: { message_id: receipt.sourceId },
        data: { msg_type: 'text', content: JSON.stringify({ text: NOTICE_TEXT }) },
      })
      const id = response?.data?.message_id ?? response?.message_id
      return response?.code === 0 && typeof id === 'string' &&
        FEISHU_MESSAGE_ID.test(id) ? id : null
    } catch {
      // The SDK call may have reached the platform. The recovery gate records
      // a null outcome as unknown and will never retry it on another startup.
      return null
    }
  }

  return Object.freeze({ resolveTarget, send })
}

module.exports = { createFeishuRecoverySender }
