'use strict'
// Engine side of idle compaction (ABI 37). The Engine's methods are driven on
// a minimal process-local stand-in: no journal, no platform, no child process.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Engine } = require('../src/core/v2engine')

const CHAT = 'oc_idle_compact_test_0001'
const SID = 'sess-1111'

function fakeEngine({ capacity = { closed: false, maxConcurrent: 3, active: 0, waiting: 0 }, stats, session = SID,
  provider = { runner: 'claude', autocompactTokens: 600_000 }, busy = false, compactSession, locked = true } = {}) {
  const log = []
  const eng = Object.create(Engine.prototype)
  const store = {
    session, stats: stats === undefined ? { sessionId: SID, turns: 3, in: 1000, out: 100, ctx: 310_000 } : stats,
    getSession: () => store.session,
    getSessionStats: () => store.stats,
    putSessionStats: (chatId, s) => { store.written = (store.written || []).concat([{ chatId, s }]); store.stats = s },
    getProvider: () => null,
  }
  const releases = []
  Object.assign(eng, {
    cfg: { agent: { bin: 'claude' }, defaultProvider: 'claude', providers: { claude: provider },
      groups: { [CHAT]: { workdir: '/tmp/idle-compact-test', permissionMode: 'dontAsk', allowedTools: ['Read'] } } },
    store, log: m => log.push(m), rts: new Map(), tz: 'Asia/Shanghai',
    durableV2CompactSession: compactSession,
    durableV2CapacitySnapshot: () => capacity,
    durableV2AcquireCapacity: async ({ signal }) => {
      if (signal.aborted) { const e = new Error('cancelled'); e.code = 'C2_CAPACITY_WAIT_CANCELLED'; throw e }
      const release = () => releases.push(Date.now())
      return release
    },
    durableV2AssertWriterLock: () => locked,
    durableV2VerifyRunnerClosed: () => true,
    durableV2Runtime: { close() { eng.runtimeClosed = true } },
    _durableV2GroupBusy: () => (typeof busy === 'function' ? busy() : busy),
    baseSkillEnv: chatId => ({ SBOT_CHAT_ID: chatId }),
    _brain: () => ({ model: 'claude-opus-5-5', effort: 'high' }),
  })
  const rt = eng._rt(CHAT)
  rt.v2CanCompact = { provider: 'claude', ok: true }
  return { eng, rt, store, log, releases }
}

// A controllable stand-in for runner.compactSession: records the input, emits
// init (+ boundary when asked) and resolves when told or when aborted.
function fakeCompactor({ boundary = true, unsupported = false, fail = null, autoResolve = true } = {}) {
  const calls = []
  let finish
  const fn = input => {
    if (unsupported) return null
    calls.push(input)
    return new Promise((resolve, reject) => {
      input.onEvent({ type: 'system', subtype: 'init', sessionId: input.sessionId, slashCommands: ['compact'] })
      const done = () => {
        if (fail) return reject(fail)
        resolve({ sessionId: input.sessionId, result: { type: 'result', subtype: 'success', isError: false }, code: 0, aborted: input.signal.aborted })
      }
      finish = () => { if (boundary) input.onEvent({ type: 'system', subtype: 'compact_boundary', sessionId: input.sessionId, preTokens: 310_000 }); done() }
      input.signal.addEventListener('abort', () => resolve({ sessionId: input.sessionId, result: null, code: 143, aborted: true }), { once: true })
      if (autoResolve) setImmediate(finish)
    })
  }
  return { fn, calls, finish: () => finish && finish() }
}

test('a normal settle above the idle line starts a compaction with the turn\'s own session and arguments, then records the result', async () => {
  const c = fakeCompactor()
  const { eng, rt, store, log, releases } = fakeEngine({ compactSession: c.fn })
  eng._maybeIdleCompact(rt, 'answered')
  assert.ok(rt.v2Compacting, 'handle set synchronously')
  await rt.v2Compacting.exited
  assert.equal(c.calls.length, 1)
  const input = c.calls[0]
  assert.equal(input.sessionId, SID)
  assert.equal(input.steer, false)
  assert.match(input.keep, /^保留/)
  assert.equal(input.prompt, undefined)
  assert.equal(input.onTurnAccepted, undefined)
  assert.equal(input.onDurableEvent, undefined)
  assert.equal(input.model, 'claude-opus-5-5'); assert.equal(input.effort, 'high')
  assert.deepEqual(input.allowedTools, ['Read']); assert.equal(input.permissionMode, 'dontAsk')
  assert.equal(input.autocompactTokens, 600_000)
  assert.equal(rt.v2Compacting, null)
  assert.equal(rt.v2Compacted, true, 'next turn carries the compacted hint')
  assert.equal(store.written.length, 1)
  assert.equal(store.stats.ctx, undefined, 'post size unknown until the next turn reports it')
  assert.ok(store.stats.compactedAt > 0)
  assert.equal(store.stats.sessionId, SID)
  assert.equal(releases.length, 1, 'permit released after a proven close')
  assert.ok(log.some(l => /空闲整理开始/.test(l)) && log.some(l => /空闲整理完成/.test(l)), log.join('\n'))
  assert.deepEqual(rt.v2CompactFails, { sid: SID, n: 0 })
})

test('no compaction: below the line, capability unknown or false, Codex, no spare slot, busy, failed turn; only above-line skips are logged', async () => {
  const cases = [
    ['below line', { stats: { sessionId: SID, turns: 1, ctx: 299_999 } }, 'answered', false],
    ['capability unknown', {}, 'answered', true, rt => { rt.v2CanCompact = null }],
    ['capability false', {}, 'answered', true, rt => { rt.v2CanCompact = { provider: 'claude', ok: false } }],
    ['codex', { provider: { runner: 'codex', autocompactTokens: 600_000 } }, 'answered', false],
    ['one free slot', { capacity: { closed: false, maxConcurrent: 2, active: 1, waiting: 0 } }, 'answered', true],
    ['capacity closed', { capacity: { closed: true, maxConcurrent: 3, active: 0, waiting: 0 } }, 'answered', true],
    ['busy', { busy: true }, 'answered', true],
    ['error turn', {}, 'error', true],
    ['threshold 0', { provider: { runner: 'claude', autocompactTokens: 0 } }, 'answered', false],
    ['stats of another session', { stats: { sessionId: 'other', turns: 1, ctx: 400_000 } }, 'answered', true],
  ]
  for (const [name, opts, status, logged, prep] of cases) {
    const c = fakeCompactor()
    const { eng, rt, log } = fakeEngine({ compactSession: c.fn, ...opts })
    if (prep) prep(rt)
    eng._maybeIdleCompact(rt, status)
    assert.ok(!rt.v2Compacting, name)
    assert.equal(c.calls.length, 0, name)
    assert.equal(log.some(l => /空闲整理未起/.test(l)), logged, `${name}: ${log.join(' | ')}`)
  }
})

test('a new message stops the compaction and waits for the exit; stopped runs do not count as failures', async () => {
  const c = fakeCompactor({ autoResolve: false })
  const { eng, rt, store, log } = fakeEngine({ compactSession: c.fn })
  eng._maybeIdleCompact(rt, 'answered')
  await new Promise(r => setImmediate(r))
  assert.equal(c.calls.length, 1)
  const stopping = eng._stopIdleCompact(rt, '新消息')
  assert.ok(stopping && typeof stopping.then === 'function')
  assert.equal(c.calls[0].signal.aborted, true, 'aborted at once: no boundary yet')
  await stopping
  assert.equal(rt.v2Compacting, null)
  assert.equal(rt.v2Compacted, undefined)
  assert.equal(store.written, undefined)
  assert.deepEqual(rt.v2CompactFails, { sid: SID, n: 0 })
  assert.ok(log.some(l => /被新消息打断/.test(l)), log.join('\n'))
  assert.equal(eng._stopIdleCompact(rt, 'x'), null, 'nothing running')
})

test('after the boundary arrived a stop does not kill; the run finishes and its result is kept', async () => {
  const c = fakeCompactor({ autoResolve: false })
  const { eng, rt, store } = fakeEngine({ compactSession: c.fn })
  eng._maybeIdleCompact(rt, 'answered')
  await new Promise(r => setImmediate(r))
  const input = c.calls[0]
  input.onEvent({ type: 'system', subtype: 'compact_boundary', sessionId: SID, preTokens: 310_000 })
  const stopping = eng._stopIdleCompact(rt, '新消息')
  assert.equal(input.signal.aborted, false, 'not killed once compacted')
  assert.ok(rt.v2Compacting.lateKill)
  setImmediate(() => c.finish())
  await stopping
  assert.equal(rt.v2Compacted, true)
  assert.ok(store.stats.compactedAt > 0)
})

test('a stop while the group is already busy keeps the stats untouched but still flags the compacted hint', async () => {
  const c = fakeCompactor({ autoResolve: false })
  let busy = false
  const { eng, rt, store } = fakeEngine({ compactSession: c.fn, busy: () => busy })
  eng._maybeIdleCompact(rt, 'answered')
  await new Promise(r => setImmediate(r))
  c.calls[0].onEvent({ type: 'system', subtype: 'compact_boundary', sessionId: SID, preTokens: 310_000 })
  busy = true
  const stopping = eng._stopIdleCompact(rt, '新消息')
  setImmediate(() => c.finish())
  await stopping
  assert.equal(store.written, undefined)
  assert.equal(rt.v2Compacted, true)
})

test('failures: the second consecutive failure rests the session for an hour and the next settle skips; a quota error rests at once', async () => {
  const boom = new Error('claude exited 1')
  const c = fakeCompactor({ fail: boom })
  const { eng, rt, log } = fakeEngine({ compactSession: c.fn })
  eng._maybeIdleCompact(rt, 'answered'); await rt.v2Compacting.exited
  assert.deepEqual(rt.v2CompactFails, { sid: SID, n: 1 }); assert.equal(rt.v2CompactRest, null)
  eng._maybeIdleCompact(rt, 'answered'); await rt.v2Compacting.exited
  assert.equal(rt.v2CompactFails.n, 2); assert.ok(rt.v2CompactRest && rt.v2CompactRest.until > Date.now() + 3_500_000)
  eng._maybeIdleCompact(rt, 'answered')
  assert.equal(rt.v2Compacting, null)
  assert.ok(log.some(l => /歇息期/.test(l)), log.join('\n'))

  const quota = { fn: input => { input.onEvent({ type: 'system', subtype: 'init', sessionId: SID, slashCommands: ['compact'] })
    return Promise.resolve({ sessionId: SID, result: { type: 'result', isError: true, quota: 'account', text: 'rate limit' }, code: 0, aborted: false }) } }
  const q = fakeEngine({ compactSession: quota.fn })
  q.eng._maybeIdleCompact(q.rt, 'answered'); await q.rt.v2Compacting.exited
  assert.equal(q.rt.v2CompactFails.n, 0, 'quota errors do not climb the failure ladder')
  assert.ok(q.rt.v2CompactRest && q.rt.v2CompactRest.until > Date.now() + 3_500_000)
})

test('a backend without headless compaction is remembered as unsupported and nothing is recorded as a failure', async () => {
  const c = fakeCompactor({ unsupported: true })
  const { eng, rt, log, releases } = fakeEngine({ compactSession: c.fn })
  eng._maybeIdleCompact(rt, 'answered'); await rt.v2Compacting.exited
  assert.deepEqual(rt.v2CanCompact, { provider: 'claude', ok: false })
  assert.equal(rt.v2CompactFails, undefined)
  assert.equal(releases.length, 1)
  assert.ok(log.some(l => /不支持/.test(l)))
  eng._maybeIdleCompact(rt, 'answered')
  assert.equal(rt.v2Compacting, null)
})

test('a session replaced during the compaction (console new session) leaves the new session\'s stats alone', async () => {
  const c = fakeCompactor({ autoResolve: false })
  const { eng, rt, store } = fakeEngine({ compactSession: c.fn })
  eng._maybeIdleCompact(rt, 'answered')
  await new Promise(r => setImmediate(r))
  eng.stopIdleCompact(CHAT, '会话已重置')
  store.session = null; store.stats = null
  await rt.v2Compacting.exited
  assert.equal(store.written, undefined)
  assert.equal(rt.v2Compacted, undefined)
})

test('shutdown stops a running compaction and drain waits for its exit', async () => {
  const c = fakeCompactor({ autoResolve: false })
  const { eng, rt } = fakeEngine({ compactSession: c.fn })
  eng._maybeIdleCompact(rt, 'answered')
  await new Promise(r => setImmediate(r))
  const exited = rt.v2Compacting.exited
  assert.equal(eng.shutdown(), 0, 'a compaction is not an aborted turn')
  assert.equal(eng._closing, true)
  assert.equal(c.calls[0].signal.aborted, true)
  assert.equal(await eng.drainDurableV2(2000), true)
  await exited
  assert.equal(rt.v2Compacting, null)
  eng._maybeIdleCompact(rt, 'answered')
  assert.ok(!rt.v2Compacting, 'no new compaction while closing')
})

test('the hud idle line follows the provider threshold and the CLI capability', () => {
  const { eng, rt } = fakeEngine({})
  const { idleCompactPlan } = require('../src/agent/privatecore')
  assert.equal(eng._idleCompactThreshold({ autocompactTokens: 600_000 }), 600_000)
  assert.equal(eng._idleCompactThreshold({ autocompactTokens: 50_000 }), 100_000, 'clamped like the runner flag')
  assert.equal(eng._idleCompactThreshold({}), 0)
  assert.equal(idleCompactPlan({ threshold: eng._idleCompactThreshold({ autocompactTokens: 600_000 }), now: 0 }).at, 300_000)
  assert.equal(eng._idleCompactCapability(rt, 'claude'), true)
  assert.equal(eng._idleCompactCapability(rt, 'other'), null)
})

// ── fixes from the 11-12 adversarial review ───────────────────────────────────

test('review 1: while a turn waits for the compaction to stop, the group reports "waiting for capacity"; shutdown during the wait ends the turn before dispatch', async () => {
  const c = fakeCompactor({ autoResolve: false })
  const { eng, rt } = fakeEngine({ compactSession: c.fn })
  eng._maybeIdleCompact(rt, 'answered')
  await new Promise(r => setImmediate(r))
  const waiting = eng._awaitIdleCompactStop(rt)
  assert.equal(rt.v2AdmissionPending, true, 'a second message now takes the queued branch')
  assert.ok(rt.v2AdmissionController)
  assert.equal(await waiting, true)
  assert.equal(rt.v2AdmissionController, null)
  assert.equal(await eng._awaitIdleCompactStop(rt), true, 'nothing running: immediate')

  const c2 = fakeCompactor({ autoResolve: false })
  const second = fakeEngine({ compactSession: c2.fn })
  second.eng._maybeIdleCompact(second.rt, 'answered')
  await new Promise(r => setImmediate(r))
  const waiting2 = second.eng._awaitIdleCompactStop(second.rt)
  second.rt.v2AdmissionController.abort()
  assert.equal(await waiting2, false)
  assert.equal(second.rt.v2AdmissionPending, false)
})

test('unproven compaction close retains its handle and permit, seals admission and prevents drain or another session writer', async () => {
  for (const fail of [null, new Error('unknown child failure')]) {
    const c = fakeCompactor({ fail })
    const { eng, rt, releases, log, store } = fakeEngine({ compactSession: c.fn })
    eng.durableV2VerifyRunnerClosed = () => false
    eng._maybeIdleCompact(rt, 'answered')
    const rec = rt.v2Compacting
    assert.equal(await rec.exited, false)
    assert.equal(releases.length, 0)
    assert.equal(rt.v2Compacting, rec)
    assert.equal(store.written, undefined, 'unproven close cannot settle session stats')
    assert.equal(rt.v2Compacted, undefined)
    assert.equal(eng.runtimeClosed, true)
    assert.equal(await eng.drainDurableV2(100), false)
    assert.equal(await eng._awaitIdleCompactStop(rt), false)
    assert.equal(await eng.stopIdleCompact(CHAT), false)
    eng._maybeIdleCompact(rt, 'answered')
    assert.equal(c.calls.length, 1, 'retained handle prevents another compaction')
    assert.ok(log.some(l => /permit kept/.test(l)))
  }
})

test('a thrown subscription quota error uses the core classification and rests immediately', async () => {
  const c = fakeCompactor({ fail: new Error("You've hit your limit · resets 10pm (Asia/Shanghai)") })
  const { eng, rt } = fakeEngine({ compactSession: c.fn })
  eng._maybeIdleCompact(rt, 'answered')
  assert.equal(await rt.v2Compacting.exited, true)
  assert.equal(rt.v2CompactFails.n, 0)
  assert.ok(rt.v2CompactRest?.until >= Date.now() + 3_500_000)
})

test('review 4: shutdown aborts at once even after the boundary (no 10 s grace); console resets also force the stop', async () => {
  const c = fakeCompactor({ autoResolve: false })
  const { eng, rt } = fakeEngine({ compactSession: c.fn })
  eng._maybeIdleCompact(rt, 'answered')
  await new Promise(r => setImmediate(r))
  c.calls[0].onEvent({ type: 'system', subtype: 'compact_boundary', sessionId: SID, preTokens: 310_000, postTokens: 18_000 })
  eng.shutdown()
  assert.equal(c.calls[0].signal.aborted, true)
  await rt.v2Compacting?.exited

  const d = fakeCompactor({ autoResolve: false })
  const other = fakeEngine({ compactSession: d.fn })
  other.eng._maybeIdleCompact(other.rt, 'answered')
  await new Promise(r => setImmediate(r))
  d.calls[0].onEvent({ type: 'system', subtype: 'compact_boundary', sessionId: SID, preTokens: 310_000 })
  other.eng.stopIdleCompact(CHAT)
  assert.equal(d.calls[0].signal.aborted, true, 'console path cannot wait, so it kills')
  await other.rt.v2Compacting?.exited
})

test('review 6/7: a throwing _brain leaves no stuck handle; postTokens from the boundary become the new context size', async () => {
  const c = fakeCompactor()
  const { eng, rt, log } = fakeEngine({ compactSession: c.fn })
  eng._brain = () => { throw new Error('no brain') }
  eng._maybeIdleCompact(rt, 'answered')
  assert.ok(!rt.v2Compacting)
  assert.ok(log.some(l => /判定出错/.test(l)))
  eng._brain = () => ({ model: 'm', effort: 'high' })
  const p = fakeCompactor({ autoResolve: false, boundary: false }) // the test emits the boundary itself, with postTokens
  const { eng: e2, rt: r2, store } = fakeEngine({ compactSession: p.fn })
  e2._maybeIdleCompact(r2, 'answered')
  await new Promise(r => setImmediate(r))
  p.calls[0].onEvent({ type: 'system', subtype: 'compact_boundary', sessionId: SID, preTokens: 310_000, postTokens: 18_000 })
  p.finish()
  await r2.v2Compacting.exited
  assert.equal(store.stats.ctx, 18_000)
})
