'use strict'
// Harness slice (ABI 37): runner-side pieces of idle compaction and the
// rate_limit_event quota source. Engine behaviour is covered in
// tests/idlecompact.test.js.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const claude = require('../src/agent/claudecode')
const runner = require('../src/agent/runner')
const cu = require('../src/agent/claudeusage')
const core = require('../src/agent/privatecore')

const NOW = 1_731_000_000_000
const INFO = { status: 'allowed', resetsAt: 1731400000, rateLimitType: 'five_hour',
  unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1731400000 }, seven_day: { utilization: 0.1, resetsAt: 1731900000 } } }

// A fake `claude` child: emits the given stream-json lines, then closes 0.
function fakeChild(lines) {
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.pid = 4242
  child.kill = () => { child.emit('close', 143); return true }
  setImmediate(() => {
    for (const line of lines) child.stdout.write(JSON.stringify(line) + '\n')
    child.stdout.end()
    setImmediate(() => child.emit('close', 0))
  })
  return child
}

test('normalizeEvent: init carries the CLI-reported slash commands; other system events do not', () => {
  const init = claude.normalizeEvent({ type: 'system', subtype: 'init', session_id: 's1', slash_commands: ['compact', 'clear', 7] })
  assert.deepEqual(init.slashCommands, ['compact', 'clear'])
  const other = claude.normalizeEvent({ type: 'system', subtype: 'hook_started', session_id: 's1', slash_commands: ['compact'] })
  assert.equal(other.slashCommands, undefined)
  const boundary = claude.normalizeEvent({ type: 'system', subtype: 'compact_boundary', session_id: 's1', compact_metadata: { trigger: 'manual', pre_tokens: 310_000 } })
  assert.equal(boundary.preTokens, 310_000)
})

test('normalizeEvent: /compact emits user and assistant events whose content is a string; neither throws', () => {
  assert.doesNotThrow(() => claude.normalizeEvent({ type: 'user', session_id: 's', message: { role: 'user', content: 'Compacted' } }))
  assert.doesNotThrow(() => claude.normalizeEvent({ type: 'assistant', session_id: 's', message: { role: 'assistant', content: 'x' } }))
})

test('compactSession: prompt is /compact plus the keep note; steer, durable and acceptance hooks are stripped; keep is required', async () => {
  const seen = []
  const spawnFn = (file, args, opts) => { seen.push({ args, env: opts.env }); return fakeChild([
    { type: 'system', subtype: 'init', session_id: 'sid-1', slash_commands: ['compact'] },
    { type: 'system', subtype: 'compact_boundary', session_id: 'sid-1', compact_metadata: { trigger: 'manual', pre_tokens: 300_000 } },
    { type: 'result', subtype: 'success', session_id: 'sid-1', is_error: false, num_turns: 0, result: '' },
  ]) }
  const events = []
  const out = await claude.compactSession({ bin: 'claude', sessionId: 'sid-1', workdir: process.cwd(), keep: '保留：要点。',
    steer: true, onSteerReady: () => {}, onTurnAccepted: () => { throw new Error('must not be passed') }, onDurableEvent: () => { throw new Error('must not be passed') },
    spawnFn, onEvent: ev => events.push(ev), prompt: 'ignored' })
  assert.equal(out.sessionId, 'sid-1')
  assert.equal(out.result.subtype, 'success')
  assert.ok(events.some(ev => ev.type === 'system' && ev.subtype === 'compact_boundary' && ev.preTokens === 300_000))
  assert.ok(events.some(ev => ev.type === 'system' && ev.subtype === 'init' && ev.slashCommands.includes('compact')))
  assert.ok(seen[0].args.includes('--resume') && seen[0].args.includes('sid-1'))
  assert.ok(!seen[0].args.some(a => /compact/.test(a) && !a.startsWith('--autocompact')), 'the prompt travels over stdin, not argv')
  await assert.rejects(claude.compactSession({ bin: 'claude', sessionId: 'sid-1', spawnFn }), /keep required/)
})

test('runner.compactSession: Codex routes get null (unsupported); Claude routes get a promise', async () => {
  assert.equal(runner.compactSession({ provider: { runner: 'codex' }, keep: 'x' }), null)
  const p = runner.compactSession({ bin: 'claude', provider: { runner: 'claude' }, sessionId: 's', keep: '保留。', spawnFn: () => fakeChild([
    { type: 'system', subtype: 'init', session_id: 's', slash_commands: [] },
    { type: 'result', subtype: 'success', session_id: 's', is_error: false, result: '' }]) })
  assert.ok(p && typeof p.then === 'function')
  await p
})

test('rate_limit_event: a subscription run feeds the quota cache; third-party endpoints and own keys do not', async t => {
  t.after(() => { cu.clearEvents(); cu.clearCache() })
  const run = provider => claude.runTurn({ bin: 'claude', prompt: 'hi', provider, workdir: process.cwd(), spawnFn: () => fakeChild([
    { type: 'system', subtype: 'init', session_id: 's', slash_commands: ['compact'] },
    { type: 'rate_limit_event', rate_limit_info: INFO },
    { type: 'result', subtype: 'success', session_id: 's', is_error: false, result: 'ok' }]) })
  cu.clearEvents()
  await run({ baseUrl: 'https://gw.example', apiKey: 'k' })
  assert.equal(cu.eventFresh(Date.now()), false)
  await run({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } })
  assert.equal(cu.eventFresh(Date.now()), false)
  await run({})
  assert.equal(cu.eventFresh(Date.now()), true)
})

test('noteRateLimit: utilization becomes a percentage, resets round to the minute, weekly maps to weekly_all; one-window events keep the other window', () => {
  cu.clearEvents()
  assert.equal(cu.noteRateLimit(INFO, NOW), true)
  const merged = cu.mergeEvent([], 0, NOW)
  assert.deepEqual(merged.map(l => [l.kind, l.percent, l.resetsAt]), [['session', 42, 1731400020000], ['weekly_all', 10, 1731900000000]]) // 1731400000 s rounds up to the next minute
  assert.equal(cu.noteRateLimit({ status: 'allowed', utilization: 0.9, resetsAt: 1731400000, rateLimitType: 'five_hour' }, NOW + 1000), true)
  const again = cu.mergeEvent([], 0, NOW + 1000)
  assert.deepEqual(again.map(l => [l.kind, l.percent]), [['session', 90], ['weekly_all', 10]])
  assert.equal(cu.noteRateLimit({ status: 'allowed' }, NOW), false)
  assert.equal(cu.noteRateLimit(null, NOW), false)
  assert.match(cu.formatClaudeUsage(again, NOW), /^5h:90% \(.*7d:10%/)
  cu.clearEvents()
})

test('usageLine: a fresh event answers from the event and hits the endpoint at most every 30 minutes; the endpoint wins only when newer', async t => {
  t.after(() => { cu.clearEvents(); cu.clearCache() })
  cu.clearEvents(); cu.clearCache()
  let clock = NOW
  const calls = []
  const curl = async () => { calls.push(clock); return { limits: [{ kind: 'weekly_scoped', percent: 3, resets_at: null, scope: { model: { display_name: 'Fable' } } }, { kind: 'session', percent: 1, resets_at: null }] } }
  const io = { now: () => clock, readToken: () => 'tok', curl, sleep: async () => {}, log: () => {} }
  cu.noteRateLimit(INFO, clock)
  const line1 = await cu.usageLine(io)
  assert.equal(calls.length, 1)
  assert.match(line1, /5h:42%/)   // endpoint said 1%, but the event is newer (same instant → event kept)
  assert.doesNotMatch(line1, /5h:1%/)
  assert.match(line1, /Fable:3%/)
  clock += 61_000 // the 60 s line cache expires; the raw endpoint cache is kept (clearCache is the manual refresh)
  await cu.usageLine(io)
  assert.equal(calls.length, 1, 'inside the 30-minute window the endpoint is not called again')
  clock += 31 * 60_000
  const line3 = await cu.usageLine(io)
  assert.equal(calls.length, 2)
  assert.match(line3, /Fable:3%/); assert.match(line3, /5h:1%/); assert.doesNotMatch(line3, /42%/) // event expired: plain endpoint data only
})

test('usageLine: no token but a fresh event still produces a line without running the fallback', async t => {
  t.after(() => { cu.clearEvents(); cu.clearCache() })
  cu.clearEvents(); cu.clearCache()
  cu.noteRateLimit(INFO, NOW)
  let fallbackCalls = 0
  const line = await cu.usageLine({ now: () => NOW + 5000, readToken: () => null, fallback: async () => { fallbackCalls++; return null } })
  assert.equal(fallbackCalls, 0)
  assert.match(line, /^5h:42%/)
})

test('core idle_compact_plan and idle_compact_settle are reachable through the loader with shape checks', () => {
  const plan = core.idleCompactPlan({ threshold: 600_000, ctx: 310_000, canCompact: true, outcome: 'ok', busy: false, queued: 0, sessionMatch: true, freeSlots: 2, now: NOW })
  assert.equal(plan.start, true); assert.equal(plan.at, 300_000); assert.match(plan.keep, /^保留/)
  const skip = core.idleCompactPlan({ threshold: 600_000, ctx: 10, canCompact: true, outcome: 'ok', sessionMatch: true, freeSlots: 2, now: NOW })
  assert.equal(skip.start, false); assert.match(skip.reason, /整理线/)
  const done = core.idleCompactSettle({ boundary: { pre: 310_000, post: 18_000 }, elapsedMs: 150_000, now: NOW, fails: 0, live: true })
  assert.equal(done.status, 'compacted'); assert.equal(done.ctx, 18_000)
})


test('compaction waits for actual child close after the grace kill instead of returning an unproved result', async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.pid = 4243
  let killed = false, closed = false
  child.kill = () => {
    killed = true
    setTimeout(() => { closed = true; child.emit('close', 137) }, 30)
    return true
  }
  const pending = claude.compactSession({ keep: 'keep task', sessionId: 's',
    spawnFn: () => child, closeGraceMs: 10, closeProofGraceMs: 200 })
  await new Promise(resolve => setImmediate(resolve))
  child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's', is_error: false, result: '' }) + '\n')
  const result = await pending
  assert.equal(killed, true)
  assert.equal(closed, true)
  assert.equal(claude.isClosedRunnerResult(result), true)
})

test('compaction rejects a missing close proof within a bound and cannot manufacture proof from a kill signal', async () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.pid = 4244; child.kill = () => true
  const pending = claude.compactSession({ keep: 'keep task', sessionId: 's',
    spawnFn: () => child, closeGraceMs: 5, closeProofGraceMs: 20 })
  await new Promise(resolve => setImmediate(resolve))
  child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's', is_error: false, result: '' }) + '\n')
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'CLAUDE_COMPACTION_CLOSE_UNPROVEN')
    assert.equal(claude.isClosedRunnerError(error), false)
    return true
  })
})

test('compaction real subprocess abort waits for close before returning the session permit proof', async () => {
  const { spawn } = require('node:child_process')
  const controller = new AbortController()
  let child, closed = false
  const pending = claude.compactSession({ keep: 'keep task', sessionId: 'test-session', signal: controller.signal,
    softStopGraceMs: 10, closeGraceMs: 20, closeProofGraceMs: 500,
    spawnFn: (_bin, _args, opts) => {
      child = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], { ...opts, env: { PATH: process.env.PATH } })
      child.once('close', () => { closed = true })
      return child
    } })
  await new Promise(resolve => setTimeout(resolve, 40))
  controller.abort()
  const result = await pending
  assert.equal(result.aborted, true)
  assert.equal(closed, true)
  assert.equal(claude.isClosedRunnerResult(result), true)
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH')
})


test('a newer event invalidates the formatted usage line immediately without repeating the endpoint request', async t => {
  t.after(() => { cu.clearEvents(); cu.clearCache() })
  cu.clearEvents(); cu.clearCache()
  let now = NOW, calls = 0
  const io = { now: () => now, readToken: () => 'fixture-token',
    curl: async () => { calls++; return { limits: [{ kind: 'session', percent: 2 }] } }, sleep: async () => {} }
  cu.noteRateLimit(INFO, now)
  assert.match(await cu.usageLine(io), /5h:42%/)
  now += 1_000
  cu.noteRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.67 }, now)
  assert.match(await cu.usageLine(io), /5h:67%/)
  assert.equal(calls, 1, 'formatted invalidation preserves the endpoint throttle')
})
