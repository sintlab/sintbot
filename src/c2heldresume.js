'use strict'

// Resume a held group from the group itself or from the console. The seal is
// the operator tool's (src/c2incident.js): the journal is kept unchanged under
// incidents/, nothing is settled, replayed or notified, and the sealed source
// messages are refused from then on. It runs in place, with the service still
// serving every other group, whenever the held turn has fully closed; only a
// turn still running falls back to the console's stop-and-restart seal.
const { answerC2InputRejection, rejectC2Input } = require('./core/c2inputrejection')
const { inferChatPlatform } = require('./config')
const { resumeCheck } = require('./agent/privatecore')

const COMMAND = /^\/(?:resume|继续)$/i

const TEXTS = Object.freeze({
  zh: Object.freeze({
    resumed: '已封存上一轮：记录原样存档，那一轮的消息不会再处理，也不会重试。本群已恢复，可以继续发消息。',
    restarting: '上一轮还没完全退出，正在封存并重启 SintBot，约半分钟后本群恢复；那一轮的消息不会再处理，需要的话请重发。',
    notAdmin: '只有管理员可以恢复本群。',
    busy: '上一轮还没完全退出，暂时无法恢复，请过一会儿再发 /resume。',
    failed: '本群暂时无法在群里恢复，请稍后再试，或由管理员在 SintBot 控制台处理。',
  }),
  en: Object.freeze({
    resumed: 'The previous task was sealed: its record is archived unchanged, and its messages are not handled again or retried. This conversation is back; you can keep sending messages.',
    restarting: 'The previous task has not fully stopped, so SintBot is sealing it and restarting; this conversation is back in about half a minute. Its messages are not handled again, so resend them if needed.',
    notAdmin: 'Only an admin can resume this conversation.',
    busy: 'The previous task has not fully stopped yet, so this conversation cannot be resumed right now. Send /resume again in a moment.',
    failed: 'This conversation cannot be resumed from here right now. Try again later, or ask an admin to handle it in the SintBot console.',
  }),
})

// "@SintBot /resume" and "/resume" alike; mentions are dropped first.
function isResumeCommand(text) {
  if (typeof text !== 'string') return false
  const bare = text.replace(/@\S+/g, ' ').trim()
  return COMMAND.test(bare)
}

// `admins`: the admin list from the configuration as it is, read each time.
// `platformOf`: the conversation's platform as the service resolves it (by
// default from the shape of its id). Whether the sender may resume is the
// built-in core's answer to these facts.
function createHeldResume({ resumeInPlace, restartSeal = null, canRestart = () => restartSeal !== null,
  admins = () => [], platformOf = chatId => inferChatPlatform(chatId), lang = () => 'zh', log = () => {} }) {
  if (typeof resumeInPlace !== 'function' || typeof admins !== 'function' ||
      typeof platformOf !== 'function' ||
      typeof lang !== 'function' || typeof canRestart !== 'function' ||
      restartSeal !== null && typeof restartSeal !== 'function') {
    throw new TypeError('Held resume needs the in-place seal')
  }
  const textsOf = chatId => (lang(chatId) === 'en' ? TEXTS.en : TEXTS.zh)

  // Seal in place; a turn that has not closed falls back to stop-and-restart
  // where launchd starts the service again. Returns { inPlace, restarting }.
  async function seal(chatId) {
    try {
      await resumeInPlace(chatId)
      return { ok: true, chatId, inPlace: true, restarting: false }
    } catch (error) {
      if (error?.code === 'still-running' && restartSeal && canRestart()) {
        return { ...restartSeal(chatId), inPlace: false }
      }
      throw error
    }
  }

  // The command as the held group's service hook: undefined when the message
  // is not the command, so the ordinary held reply answers it.
  function command(msg, platform) {
    if (!isResumeCommand(msg?.text)) return undefined
    const T = textsOf(msg.chatId)
    const answer = notice => answerC2InputRejection({ error: rejectC2Input('C2 group resume',
      { reason: 'group-resume', notice }), msg, platform, log })
    let verdict
    try {
      verdict = resumeCheck({ via: 'group', platform: platformOf(msg.chatId) ?? null,
        userId: msg?.userId ?? null, admins: admins() ?? [] })
    } catch (error) {
      log(`group ${msg.chatId}: resume from the group could not be checked: ${error?.message || error}`)
      return answer(T.failed)
    }
    if (!verdict.allow) return answer(T.notAdmin)
    return (async () => {
      try {
        await resumeInPlace(msg.chatId)
        log(`group ${msg.chatId}: resumed from the group`)
        return answer(T.resumed)
      } catch (error) {
        if (error?.code === 'still-running' && restartSeal && canRestart()) {
          // The reply leaves first; the restart seal stops the service after it.
          const out = await answer(T.restarting)
          try { restartSeal(msg.chatId) } catch (failure) {
            log(`group ${msg.chatId}: restart seal refused: ${failure?.message || failure}`)
            return answer(T.failed)
          }
          return out
        }
        log(`group ${msg.chatId}: resume from the group failed: ${error?.message || error}`)
        return answer(error?.code === 'still-running' ? T.busy : T.failed)
      }
    })()
  }
  return { command, seal }
}

module.exports = { createHeldResume, isResumeCommand, TEXTS }
