'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { initializeInstallation, loadInstallation } = require('../src/c2install')
const { createC2ConfigControl } = require('../src/c2configcontrol')
const { createC2ConsoleFacade } = require('../src/c2console')
const { StateStore } = require('../src/core/store')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sintbot-idle-control-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const configPath = path.join(dir, 'config.json'), stateDir = path.join(dir, 'data')
  const raw = { defaultProvider: 'claude', providers: { claude: { runner: 'claude' } },
    feishu: { appId: 'fixture', appSecret: 'fixture' }, groups: {
      oc_A: { platform: 'feishu', provider: 'claude', workdir: dir },
      oc_B: { platform: 'feishu', provider: 'claude', workdir: dir },
    } }
  fs.writeFileSync(configPath, JSON.stringify(raw))
  initializeInstallation(configPath, { dataDir: stateDir })
  const installation = loadInstallation(configPath, { dataDir: stateDir })
  const store = new StateStore(path.join(stateDir, 'state.json'))
  for (const chatId of ['oc_A', 'oc_B']) store.setSessionAtomic(chatId, 'session-' + chatId)
  const snap = { state: { lanes: {} }, receipts: { pending: [] }, notices: new Map(), effects: new Map() }
  const stops = []
  let running = true
  const bindings = new Map(['oc_A', 'oc_B'].map(chatId => [chatId, {
    engine: { cfg: installation.cfg, store, rts: new Map(),
      stopIdleCompact(id) { stops.push(id); return id === 'oc_B' && running ? Promise.resolve(true) : null } },
    gate: { blocked: false }, runtime: { blocked: false },
    journal: { snapshot: () => snap, runnerClosedProofs: () => [], runnerNotStartedProofs: () => [] },
  }]))
  const control = createC2ConfigControl({ installation, getBindings: () => bindings,
    assertWriterLock: () => true, store, probeRunner: () => true })
  return { dir, configPath, raw, installation, store, bindings, control, stops, close: () => { running = false } }
}

test('config reset stops all affected compactors before changing any session and succeeds only on a closed retry', t => {
  const f = fixture(t)
  const before = fs.readFileSync(f.configPath)
  const next = structuredClone(f.raw)
  next.providers.claude.bin = '/usr/bin/true'
  f.control.validateConfig(next)
  assert.throws(() => f.control.beforeWrite(next), /正在停止会话整理/)
  assert.deepEqual(f.stops, ['oc_A', 'oc_B'])
  assert.equal(f.store.getSession('oc_A'), 'session-oc_A', 'no partial reset of the first idle group')
  assert.equal(f.store.getSession('oc_B'), 'session-oc_B')
  assert.deepEqual(fs.readFileSync(f.configPath), before)
  f.close()
  f.control.validateConfig(next)
  assert.equal(f.control.beforeWrite(next), true)
  assert.equal(f.store.getSession('oc_A'), null)
  assert.equal(f.store.getSession('oc_B'), null)
})

test('console new session preserves the session while compaction is stopping and resets only after closure', t => {
  const f = fixture(t)
  const facade = createC2ConsoleFacade({ getBindings: () => f.bindings,
    getCapacity: () => ({ closed: false, maxConcurrent: 3, active: 1, waiting: 0 }),
    getConfig: () => f.installation.cfg, assertWriterLock: () => true,
    validateConfig: () => true, applyConfig: () => true })
  assert.throws(() => facade.control.clearSession('oc_B'), /正在停止会话整理/)
  assert.equal(f.store.getSession('oc_B'), 'session-oc_B')
  f.close()
  assert.equal(facade.control.clearSession('oc_B'), true)
  assert.equal(f.store.getSession('oc_B'), null)
})
