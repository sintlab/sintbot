'use strict'

const { chatPlatform } = require('../config')
const { isLocalChatId, isLocalMessageId } = require('../platform/local')

const RECEIPT_ID = /^[0-9a-f]{32}$/
const FEISHU_CHAT_ID = /^oc_[A-Za-z0-9_-]{1,124}$/
const FEISHU_MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,124}$/
const NOTICE_TEXT = '上一轮没有完成（模型出错或服务中断），请重新发送原请求。'

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

// The same single-attempt notice for a local conversation: one appended line
// under the accepted message. A failed append reports null (unknown), exactly
// as an ambiguous chat service call does; it is never retried.
function createLocalRecoverySender({ cfg, platform } = {}) {
  if (!cfg || typeof cfg !== 'object' || !cfg.groups ||
      !platform || typeof platform.get !== 'function' || typeof platform.forChat !== 'function' ||
      typeof platform.get('local')?.notice !== 'function') {
    throw new TypeError('C2 local recovery needs active conversation routing')
  }
  const local = platform.get('local')

  function validReceipt(receipt) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        !RECEIPT_ID.test(receipt.id || '') ||
        !isLocalChatId(receipt.chatId) ||
        receipt.source !== 'message' ||
        !isLocalMessageId(receipt.sourceId)) {
      throw new TypeError('C2 local recovery receipt identity invalid')
    }
    if (!cfg.groups[receipt.chatId] || chatPlatform(cfg, receipt.chatId) !== 'local' ||
        platform.get('local') !== local || platform.forChat(receipt.chatId) !== local) {
      throw new Error('C2 local recovery conversation route is unavailable')
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
      throw new Error('C2 local recovery target differs from durable receipt')
    }
    try {
      const id = local.notice(receipt.chatId, NOTICE_TEXT, receipt.sourceId)
      return isLocalMessageId(id) ? id : null
    } catch { return null }
  }

  return Object.freeze({ resolveTarget, send })
}

// One sender for a service that carries several platforms: each receipt goes
// to the sender of the platform its conversation is configured for. A receipt
// whose platform has no sender here is refused, never rerouted.
function createRoutedRecoverySender({ cfg, senders } = {}) {
  if (!cfg || typeof cfg !== 'object' || !cfg.groups || !senders || typeof senders !== 'object' ||
      !Object.keys(senders).length ||
      Object.values(senders).some(sender => typeof sender?.resolveTarget !== 'function' ||
        typeof sender.send !== 'function')) {
    throw new TypeError('C2 recovery routing needs one sender per active platform')
  }
  const senderOf = receipt => {
    const name = chatPlatform(cfg, receipt?.chatId)
    const sender = name && Object.hasOwn(senders, name) ? senders[name] : null
    if (!sender) throw new Error('C2 recovery route has no sender for this conversation')
    return sender
  }
  return Object.freeze({
    resolveTarget: receipt => senderOf(receipt).resolveTarget(receipt),
    send: (receipt, target) => senderOf(receipt).send(receipt, target),
  })
}

module.exports = { createFeishuRecoverySender, createLocalRecoverySender, createRoutedRecoverySender }
