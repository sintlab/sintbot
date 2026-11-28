'use strict'
// First use (issue #1): the record of this installation's first successful task,
// kept by src/firstuse.js with every rule in the built-in core (first_use_step).
// Covered: a new and an old installation, failures then a retry that succeeds,
// a restart or upgrade reading the same record, choosing and taking back a
// source, repeated clicks, close, clear, a damaged file, a read-only service,
// the activity hook, and the console routes and whitelist. Nothing here (or in
// the module) opens a network connection.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createFirstUse, machineFacts } = require('../src/firstuse')
const { createLiveActivity } = require('../src/ui/liveactivity')

const FACTS = () => ({ service: '1.4.40', osMajor: 26, chip: 'apple' })
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-firstuse-'))
  return { dir, file: path.join(dir, 'first-use.json') }
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
function make(file, extra = {}) {
  let t = 1000
  return createFirstUse({ file, facts: FACTS, now: () => (t += 1000), ...extra })
}

test('a new installation records nothing to show until its first answered turn, then shows the card once', () => {
  const { file } = tmp()
  const fu = make(file)
  assert.deepEqual(read(file), { v: 1 })
  assert.equal(fu.shown(), false)
  assert.deepEqual(fu.view({ lang: 'zh' }), { show: false })
  // Failures before the first success are counted by class; a stop is not.
  fu.observe({ status: 'error', err: "You've hit your usage limit" })
  fu.observe({ status: 'not-started', err: 'Not logged in · Please run /login' })
  fu.observe({ status: 'stopped', err: '' })
  assert.deepEqual(read(file), { v: 1, failures: { quota: 1, login: 1 } })
  fu.observe({ status: 'answered', err: '' })
  assert.equal(read(file).at, 5000)
  assert.equal(fu.shown(), true)
  const view = fu.view({ lang: 'en', app: '0.1.10' })
  assert.equal(view.show, true)
  assert.equal(view.source, null)
  assert.equal(view.summary, 'SintBot first-use feedback\nService version: 1.4.40\nApp version: 0.1.10\nSystem: macOS 26\nChip: Apple silicon\nSource (self-reported): not given\nSetup stage: setup complete, first task done\nFirst task: succeeded\nFailures before it: usage limit ×1, sign-in or account ×1')
  // A second success and later failures change nothing.
  const before = fs.readFileSync(file, 'utf8')
  fu.observe({ status: 'answered' })
  fu.observe({ status: 'error', err: 'rate limit' })
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

test('a restart or an upgrade reads the same record and never counts a second first success', () => {
  const { file } = tmp()
  make(file).observe({ status: 'answered' })
  const first = read(file)
  // The next process (same data directory, any version) opens the record as it is,
  // even though its activity now has answered turns.
  const again = make(file, { answeredBefore: () => true })
  again.observe({ status: 'answered' })
  assert.deepEqual(read(file), first)
  assert.equal(again.shown(), true)
})

test('an installation that already answered before the record existed is inherited: no card, no count', () => {
  const { file } = tmp()
  const fu = make(file, { answeredBefore: () => true })
  assert.deepEqual(read(file), { v: 1, inherited: true })
  fu.observe({ status: 'answered' })
  assert.deepEqual(read(file), { v: 1, inherited: true })
  assert.equal(fu.shown(), false)
  assert.deepEqual(fu.act({ op: 'source', value: 'github' }), { ok: true, firstUse: { show: false } })
  // A failing probe of the activity reads as already answered (fail closed).
  const { file: other } = tmp()
  make(other, { answeredBefore: () => { throw new Error('no activity') } })
  assert.deepEqual(read(other), { v: 1, inherited: true })
})

test('choosing, re-clicking, taking back the source, closing and clearing the card', () => {
  const { file } = tmp()
  const fu = make(file)
  fu.observe({ status: 'answered' })
  let out = fu.act({ op: 'source', value: 'chatgpt', lang: 'zh' })
  assert.equal(out.ok, true)
  assert.equal(out.firstUse.source, 'chatgpt')
  assert.match(out.firstUse.summary, /来源（自报）：ChatGPT/)
  assert.match(out.firstUse.summary, /App 版本：未使用（在浏览器里打开控制台）/)
  // The same click twice changes nothing; null takes it back.
  const saved = fs.readFileSync(file, 'utf8')
  fu.act({ op: 'source', value: 'chatgpt' })
  assert.equal(fs.readFileSync(file, 'utf8'), saved)
  out = fu.act({ op: 'source', value: null })
  assert.equal(out.firstUse.source, null)
  assert.equal(read(file).source, undefined)
  // A source that is not offered is refused and nothing changes.
  assert.deepEqual(fu.act({ op: 'source', value: 'reddit' }), { ok: false, error: 'refused' })
  assert.deepEqual(fu.act({ op: 'launch' }), { ok: false, error: 'unknown action' })
  fu.act({ op: 'source', value: 'friend' })
  out = fu.act({ op: 'dismiss' })
  assert.deepEqual(out.firstUse, { show: false })
  assert.equal(read(file).dismissed, true)
  assert.equal(read(file).source, 'friend')
  out = fu.act({ op: 'clear' })
  assert.deepEqual(read(file), { v: 1, cleared: true })
  // After a clear nothing is recorded again, in this process or the next.
  fu.observe({ status: 'error', err: 'quota exceeded' })
  make(file).observe({ status: 'answered' })
  assert.deepEqual(read(file), { v: 1, cleared: true })
})

test('a damaged record is kept as it is and counts nothing until it is cleared', () => {
  const { file } = tmp()
  fs.writeFileSync(file, '{not json')
  const logs = []
  const fu = make(file, { log: m => logs.push(m) })
  fu.observe({ status: 'answered' })
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json')
  assert.equal(fu.shown(), false)
  assert.ok(logs.some(m => /could not be read/.test(m)))
  fs.writeFileSync(file, JSON.stringify({ v: 1, at: 5, project: '/Users/someone/secret' }))
  const odd = make(file)
  odd.observe({ status: 'answered' })
  assert.deepEqual(read(file), { v: 1, at: 5, project: '/Users/someone/secret' })
  odd.act({ op: 'clear' })
  assert.deepEqual(read(file), { v: 1, cleared: true })
})

test('a service that lost its writer lock records nothing', () => {
  const { file } = tmp()
  const fu = make(file, { canWrite: () => false })
  fu.observe({ status: 'answered' })
  assert.equal(fs.existsSync(file), false)
})

test('the App version from the page only reaches the summary when it looks like a version', () => {
  const { file } = tmp()
  const fu = make(file)
  fu.observe({ status: 'answered' })
  assert.match(fu.view({ lang: 'zh', app: '0.1.10' }).summary, /App 版本：0\.1\.10/)
  assert.match(fu.view({ lang: 'zh', app: '<img src=x onerror=alert(1)>' }).summary, /App 版本：未知/)
  assert.match(fu.view({ lang: 'zh', app: 'x'.repeat(100) }).summary, /App 版本：未使用/)
  assert.match(fu.view({ lang: 'fr' }).summary, /^SintBot 首次使用反馈/)
})

test('machine facts are read from sw_vers and sysctl, each guarded', () => {
  const calls = []
  const exec = (bin, args) => { calls.push([bin, ...args].join(' ')); if (bin.endsWith('sw_vers')) return '26.6.2\n'; return '1\n' }
  assert.deepEqual({ ...machineFacts({ exec, platform: 'darwin' }), service: null }, { service: null, osMajor: 26, chip: 'apple' })
  assert.deepEqual(calls, ['/usr/bin/sw_vers -productVersion', '/usr/sbin/sysctl -n hw.optional.arm64'])
  const intel = machineFacts({ exec: bin => { if (bin.endsWith('sysctl')) throw new Error('unknown oid'); return '15.8.3' }, platform: 'darwin' })
  assert.equal(intel.osMajor, 15)
  assert.equal(intel.chip, 'intel')
  const broken = machineFacts({ exec: () => { throw new Error('nope') }, platform: 'darwin' })
  assert.equal(broken.osMajor, null)
  assert.deepEqual({ ...machineFacts({ platform: 'linux' }), service: null }, { service: null, osMajor: null, chip: null })
  assert.match(machineFacts({ platform: 'linux' }).service, /^\d+\.\d+\.\d+/)
})

test('the activity record tells each closed turn once, including the unknown ones it closes itself', () => {
  const closed = []
  const activity = createLiveActivity({ onClose: v => closed.push(v) })
  activity.receive({ chatId: 'oc_a', receiptId: 'r1', text: 'hi', sender: 'Ann' })
  activity.finish({ chatId: 'oc_a', receiptId: 'r1', status: 'answered', reply: 'done' })
  activity.finish({ chatId: 'oc_a', receiptId: 'r1', status: 'error', err: 'late' })   // already closed
  activity.finish({ chatId: 'oc_a', receiptId: 'missing', status: 'answered' })
  activity.receive({ chatId: 'oc_a', receiptId: 'r2', text: 'again', sender: 'Ann' })
  activity.unknown({ chatId: 'oc_a' })
  assert.deepEqual(closed, [{ status: 'answered', err: '' }, { status: 'unknown', err: '结果尚未确认，请查看群状态' }])
  // A throwing listener never breaks the recorder.
  const quiet = createLiveActivity({ onClose: () => { throw new Error('boom') } })
  quiet.receive({ chatId: 'oc_b', receiptId: 'r', text: 'x', sender: 'B' })
  quiet.finish({ chatId: 'oc_b', receiptId: 'r', status: 'answered' })
  assert.equal(quiet.list({ chatId: 'oc_b' }).activity[0].status, 'answered')
})

test('the console reads and writes the card only through /api/first-use, which the durable console allows', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/c2console.js'), 'utf8')
  const read = src.slice(src.indexOf('const READ_PATHS'), src.indexOf('const WRITE_PATHS'))
  const write = src.slice(src.indexOf('const WRITE_PATHS'), src.indexOf('const DELETE_PATHS'))
  assert.match(read, /'\/api\/first-use'/)
  assert.match(write, /'\/api\/first-use'/)
  // The module itself never reaches the network.
  const mod = fs.readFileSync(path.join(__dirname, '../src/firstuse.js'), 'utf8')
  assert.doesNotMatch(mod, /require\(['"]node:(https?|net|tls|dgram|dns)['"]\)|fetch\(/)
})
