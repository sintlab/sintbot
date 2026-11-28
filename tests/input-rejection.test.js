'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { rejectC2Input, isC2InputRejection, answerC2InputRejection } = require('../src/core/c2inputrejection')
const { Engine } = require('../src/core/v2engine')
const msg = text => ({ text, chatId: 'oc_fixture', msgId: 'om_fixture', replyCtx: { chatId: 'oc_fixture', messageId: 'om_fixture' } })
const platform = { features: { cardQuota: true }, reply() {}, replyOnce() {}, createStreamingCard() {} }
function engine({ stopPending = false, rt = {} } = {}) {
  const e = Object.create(Engine.prototype)
  e.durableV2NormalRoute = true
  e.rts = new Map([['oc_fixture', rt]])
  e.cfg = { groups: { oc_fixture: { platform: 'feishu', provider: 'codex', codexSteer: false } }, providers: { codex: { runner: 'codex' } } }
  e.store = { getProvider: () => null }
  e.durableV2AssertWriterLock = () => true
  e.durableV2Runtime = { blocked: false, snapshot: () => ({ receipts: { pending: [], completed: [] }, state: { lanes: { stopIntent: stopPending ? { oc_fixture: {} } : {} } } }) }
  return e
}
test('ordinary input while stop acknowledgement is pending rejects before staging', async () => {
  await assert.rejects(engine({ stopPending: true }).runDurableV2Message(msg('hello'), platform), e => isC2InputRejection(e) && e.reason === 'stop-pending')
})
test('finishing stop refuses without treating invalid platform input as a benign rejection', async () => {
  const e = engine({ rt: { v2NormalRouteActive: true, v2RunningJobs: [{}], v2Controller: {}, v2TerminalStarted: true } })
  await assert.rejects(e.runDurableV2Message(msg('/stop'), platform), e => isC2InputRejection(e) && e.reason === 'stop-unavailable')
  await assert.rejects(e.runDurableV2Message({ ...msg('/stop'), msgId: 'invalid' }, platform), e => !isC2InputRejection(e))
})
test('rejection notice is single attempt and failures never retry or become successful', async () => {
  let calls = 0
  const error = rejectC2Input('refused', { reason: 'unsupported-command', notice: 'Not available' })
  const result = await answerC2InputRejection({ error, msg: msg('/hud'), platform: { replyOnce: async () => { calls++; throw Error('network') } } })
  assert.equal(calls, 1); assert.equal(result.notified, false)
  const wrongTarget = { ...msg('/hud'), replyCtx: { chatId: 'oc_other', messageId: 'om_fixture' } }
  await answerC2InputRejection({ error, msg: wrongTarget, platform: { replyOnce: async () => { calls++ } } })
  assert.equal(calls, 1)
  assert.equal(isC2InputRejection(Error('ordinary failure')), false)
})
