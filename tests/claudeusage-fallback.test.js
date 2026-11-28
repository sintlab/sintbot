'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const cu = require('../src/agent/claudeusage')

const NOW = 1731400000000
const H = 3600e3, D = 864e5
const HOME = '/tmp/sintbot-fallback-home'
const LINE = (now) => `5h:42% (1h)${cu.QUOTA_SEP}7d:10% (5d)`
// Expired OAuth credentials → the read-only rule yields null (never refreshed by us).
const expiredToken = () => cu.parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: NOW - 1 } }), NOW)
// ~/.claude.json as the CLI leaves it; `fetchedAt` only when the test says so.
const claudeJson = (now, fetchedAt) => JSON.stringify({ cachedUsageUtilization: { limits: [
  { kind: 'session', percent: 42, resets_at: new Date(now + H).toISOString() },
  { kind: 'weekly_all', percent: 10, resets_at: new Date(now + 5 * D).toISOString() }], ...(fetchedAt != null ? { fetchedAt } : {}) } })
const tick = (ms) => new Promise((r) => setTimeout(r, ms))
// The fallback's own timers are unref'd (a daemon always has sockets alive); a bare test
// process does not, so hung-child cases hold the loop open themselves.
const keepAlive = (ms = 3000) => { const t = setTimeout(() => {}, ms); return () => clearTimeout(t) }

// Fake child: closes after `delay` with `code`; in `hang` mode it ignores SIGTERM and closes only on SIGKILL.
function fakeSpawn({ code = 0, delay = 0, hang = false } = {}) {
  const calls = []
  const fn = (file, args, opts) => {
    const child = new EventEmitter()
    const rec = { file, args, opts, kills: [], closed: false }
    child.kill = (sig) => { rec.kills.push(sig); if (hang && sig === 'SIGKILL') setTimeout(() => { rec.closed = true; child.emit('close', null) }, 0) }
    child.on('close', () => { rec.closed = true })
    calls.push(rec)
    if (!hang) setTimeout(() => child.emit('close', code), delay)
    return child
  }
  fn.calls = calls
  return fn
}
function harness({ spawn = fakeSpawn(), supportsFlag = async () => true, clock = { t: NOW }, fetchedAt = null, buildEnv } = {}) {
  cu.clearCache(); cu.resetFallback()
  const now = () => clock.t
  const reads = []
  const io = { home: HOME, bin: 'claude', spawn, supportsFlag, now, log: () => {}, tmpdir: () => '/tmp/sintbot-usage-cwd',
    buildEnv: buildEnv || ((p) => { assert.deepEqual(p, {}); return { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-should-go' } }),
    stat: async () => ({ mtimeMs: clock.mtime || 1 }),
    readFile: async (p) => { reads.push(p); if (p === `${HOME}/.claude.json`) return claudeJson(now(), typeof fetchedAt === 'function' ? fetchedAt() : fetchedAt); const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
    readToken: expiredToken, timeoutMs: 50, killGraceMs: 10, flagProbeMs: 50 }
  return { io, clock, spawn, reads, line: () => cu.usageLine(io) }
}

test('cold run never blocks: the caller gets null before the child exits; after exit 0 the file is trusted with fetchedAt = completion time', async () => {
  const h = harness({ spawn: fakeSpawn({ delay: 40 }) })
  const started = Date.now()
  assert.equal(await h.line(), null)
  assert.ok(Date.now() - started < 30, 'returned before the child closed')
  await tick(5) // the flag probe runs first; the spawn follows in the background
  assert.equal(h.spawn.calls.length, 1)
  assert.equal(h.spawn.calls[0].closed, false)
  const { file, args, opts } = h.spawn.calls[0]
  assert.equal(file, 'claude')
  assert.deepEqual(args, ['-p', '/usage', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence'])
  assert.deepEqual(args, [...cu.FALLBACK_ARGS])
  assert.equal(opts.cwd, '/tmp/sintbot-usage-cwd')
  assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'ignore'])
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined, 'OAuth-only child')
  assert.equal(opts.env.PATH, '/usr/bin')
  await cu.settleFallback()
  assert.equal(h.spawn.calls[0].closed, true)
  cu.clearCache()
  assert.equal(await h.line(), LINE())
})

test('the real buildEnv({}) plus the fallback leave no ANTHROPIC_* routing in the child env', async () => {
  const { buildEnv } = require('../src/agent/claudecode')
  const saved = {}
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY']) { saved[k] = process.env[k]; process.env[k] = 'leak-' + k }
  try {
    const h = harness({ buildEnv })
    await h.line(); await cu.settleFallback()
    const env = h.spawn.calls[0].opts.env
    for (const k of Object.keys(saved)) assert.equal(env[k], undefined, k)
    assert.equal(env.PATH, process.env.PATH)
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})

test('a file written by someone else is not trusted: without an exit-0 run in this process the answer is null', async () => {
  const h = harness({ spawn: fakeSpawn({ code: 1 }), fetchedAt: () => h.clock.t - 1000 })
  await h.line(); await cu.settleFallback()
  cu.clearCache()
  assert.equal(await h.line(), null, 'exit code 1 → not trusted even with a fresh fetchedAt')
  assert.equal(h.spawn.calls.length, 1)
})

test('throttle: one CLI run per 10 minutes per account; reads in between use the mtime cache', async () => {
  const h = harness()
  await h.line(); await cu.settleFallback()
  cu.clearCache(); h.clock.t = NOW + 60_000
  assert.equal(await h.line(), LINE()) // first read of the file (the cold call read nothing)
  cu.clearCache(); h.clock.t = NOW + 120_000
  assert.match(await h.line(), /^5h:42% \(59m\) │ 7d:10% \(5d\)$/) // same parsed body served from the mtime cache a minute later
  assert.equal(h.spawn.calls.length, 1)
  assert.equal(h.reads.filter((p) => p.endsWith('.claude.json')).length, 1, 'same mtime → parsed once')
  h.clock.mtime = 2; cu.clearCache()
  await h.line()
  assert.equal(h.reads.filter((p) => p.endsWith('.claude.json')).length, 2, 'mtime changed → re-read')
  cu.clearCache(); h.clock.t = NOW + cu.FALLBACK_INTERVAL_MS + 1
  await h.line()
  await cu.settleFallback() // the new run starts in the background
  assert.equal(h.spawn.calls.length, 2)
})

test('the file\'s own fetchedAt wins over the completion time, so a stale body stays null', async () => {
  const h = harness({ fetchedAt: NOW - 700_000 })
  await h.line(); await cu.settleFallback()
  cu.clearCache()
  assert.equal(await h.line(), null)
})

test('single flight: concurrent callers share one CLI run', async () => {
  const h = harness({ spawn: fakeSpawn({ delay: 15 }) })
  const [a, b, c] = await Promise.all([h.line(), cu.cachedUsageFallback(h.io), cu.cachedUsageFallback(h.io)])
  assert.deepEqual([a, b, c], [null, null, null])
  await cu.settleFallback()
  assert.equal(h.spawn.calls.length, 1)
})

test('timeout: SIGTERM, then SIGKILL after the grace period; the hung child blocks a second run until it closes, and the result is null', async () => {
  const stop = keepAlive()
  const h = harness({ spawn: fakeSpawn({ hang: true }) })
  await h.line()
  await tick(30)
  assert.equal(h.spawn.calls[0].closed, false)
  h.clock.t = NOW + cu.FALLBACK_INTERVAL_MS + 1; cu.clearCache()
  assert.equal(await h.line(), null)
  assert.equal(h.spawn.calls.length, 1, 'no overlap while the first child is alive')
  await cu.settleFallback()
  assert.deepEqual(h.spawn.calls[0].kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(h.spawn.calls[0].closed, true)
  cu.clearCache()
  assert.equal(await h.line(), null, 'timed-out run → nothing trusted')
  await tick(5)
  assert.equal(h.spawn.calls.length, 2, 'next run starts once the hung child has closed')
  await cu.settleFallback(); stop()
})

test('unsupported or unknown flag support → skip the fallback and return null, no spawn', async () => {
  for (const answer of [false, null]) {
    const h = harness({ supportsFlag: async (bin, flag) => (flag === '--setting-sources' ? answer : true) })
    assert.equal(await h.line(), null)
    await cu.settleFallback()
    assert.equal(h.spawn.calls.length, 0)
  }
  const stop = keepAlive()
  const h = harness({ supportsFlag: () => new Promise(() => {}) }) // probe hangs → short timeout → unknown → skip
  await h.line(); await cu.settleFallback()
  assert.equal(h.spawn.calls.length, 0)
  stop()
})

test('readCachedUtilization keeps only the object itself; no sibling timestamp guessing', () => {
  assert.equal(cu.readCachedUtilization('not json'), null)
  assert.equal(cu.readCachedUtilization(JSON.stringify({})), null)
  assert.equal(cu.readCachedUtilization(JSON.stringify({ cachedUsageUtilization: [] })), null)
  assert.deepEqual(cu.readCachedUtilization(JSON.stringify({ cachedUsageUtilization: { limits: [] }, cachedUsageUtilizationFetchedAt: 123 })), { limits: [] })
  assert.deepEqual(cu.readCachedUtilization(JSON.stringify({ cachedUsageUtilization: { limits: [], fetchedAt: 5 } })), { limits: [], fetchedAt: 5 })
})

test('current CLI cache envelope is parsed and its fetchedAtMs cannot be freshened by a successful child', async () => {
  for (const age of [1000, 700_000]) {
    const h = harness()
    h.io.readFile = async () => JSON.stringify({ cachedUsageUtilization: {
      fetchedAtMs: NOW - age, accountUuid: 'fixture-account',
      utilization: JSON.parse(claudeJson(NOW)).cachedUsageUtilization,
    } })
    await h.line(); await cu.settleFallback(); cu.clearCache()
    assert.equal(await h.line(), age === 1000 ? LINE() : null)
  }
})

test('native-style immediate exit preserves a long help page and concurrent flags share one process', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sintbot-help-probe-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, 'cli'), count = path.join(dir, 'calls')
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(count)}, '1'); process.stdout.write('x'.repeat(512 * 1024) + ${JSON.stringify(cu.FALLBACK_FLAGS.join(' '))}); process.exit(0)\n`, { mode: 0o700 })
  const actual = await Promise.all([...cu.FALLBACK_FLAGS, '--unsupported-option'].map(flag => cu.supportsUsageFlag(bin, flag)))
  assert.deepEqual(actual, [true, true, true, true, false])
  assert.equal(fs.readFileSync(count, 'utf8'), '1')
  assert.equal(await cu.supportsUsageFlag(path.join(dir, 'missing'), '--tools'), null)
})
