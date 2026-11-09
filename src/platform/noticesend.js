'use strict'

// The CLI and the startup upgrade announcement share one delivery path. The
// platform router returns null when a chat has no card capability (WeCom and
// Slack); the text version is built from the same notice fields.
const { buildNoticeCard, noticeText, resolveTone, TONES } = require('./noticecard')
const { buildUpgradeNoticeParts } = require('../upgrade')

function cliNotice(positionals, { subtitle = '', tone = '', warnings = [], from = '', stamp = '' } = {}) {
  const title = String(positionals && positionals[0] || '').trim()
  if (!title) throw new Error('缺少标题')
  const resolved = resolveTone(tone)
  if (!resolved) throw new Error(`不认识的类别「${tone}」 — 可选:${Object.values(TONES).map((x) => x.label).join(' / ')}`)
  return {
    tone: resolved,
    title,
    subtitle,
    body: (positionals || []).slice(1).join('\n'),
    warnings,
    footer: [stamp, from || '通知'].filter(Boolean).join(' · '),
  }
}

async function deliverNotice(platform, chatId, notice, { redact, log = () => {} } = {}) {
  if (!platform || typeof platform.send !== 'function') throw new TypeError('notice platform requires send')
  // WeCom has sendCard for its own template cards, but cannot render a Feishu
  // notice card. Check the target adapter when using the multi-platform router.
  const target = typeof platform.forChat === 'function' ? platform.forChat(chatId) : platform
  if (target && target.features?.noticeCard !== false && typeof platform.sendCard === 'function') {
    try {
      const result = await platform.sendCard(chatId, buildNoticeCard(notice, { redact }))
      if (result != null) return { mode: 'card', result }
    } catch (error) {
      log(`通知卡发送失败(${chatId}),退回文本: ${error && error.message}`)
    }
  }
  const result = await platform.send(chatId, noticeText(notice, { redact }))
  return { mode: 'text', result }
}

async function deliverUpgradeNotice(platform, chatId, lastVersion, currentVersion, changelog, brand, options) {
  const notice = buildUpgradeNoticeParts(lastVersion, currentVersion, changelog, brand)
  if (!notice) return null
  return deliverNotice(platform, chatId, notice, options)
}

module.exports = { cliNotice, deliverNotice, deliverUpgradeNotice }
