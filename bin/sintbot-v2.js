#!/usr/bin/env node
'use strict'

// Restricted macOS Feishu single-group entry. No legacy daemon or terminal
// chat dispatch is reachable from this entry.
const fs = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { applyProxyEnv, chatPlatform } = require('../src/config')
const { secureDataDir } = require('../src/core/datadir')
const { StateStore } = require('../src/core/store')
const { createFeishuPlatform, feishuClient } = require('../src/platform/feishu')
const { createMultiPlatform } = require('../src/platform/multi')

async function startService(rest) {
  const { values } = parseArgs({ args: rest, allowPositionals: false,
    options: { config: { type: 'string' }, ui: { type: 'boolean' },
      'no-open': { type: 'boolean' }, 'ui-port': { type: 'string' },
      'ui-host': { type: 'string' }, preflight: { type: 'boolean' } } })
  const preflightOnly = values.preflight === true
  if (values.ui || values['no-open'] || values['ui-port'] || values['ui-host']) {
    throw new Error('C2 v2 single-group service has no durable UI route; remove UI options')
  }
  const { loadInstallation, assertPrivateDirectory } = require('../src/c2install')
  const { stateDir, file, cfg, groups, serviceChatId, provider } = loadInstallation(values.config)
  assertPrivateDirectory(stateDir)
  let journalStat
  try { journalStat = fs.lstatSync(file) } catch {}
  if (!journalStat?.isFile() || journalStat.isSymbolicLink()) {
    throw new Error('No initialized journal; use sintbot init for a new installation. Existing state must be reviewed before migration.')
  }
  applyProxyEnv(cfg)
  const { spawnSync } = require('node:child_process')
  const probe = spawnSync(provider.bin || 'codex', ['--version'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    env: { ...process.env, ...(provider.env || {}) },
  })
  if (probe.error || probe.status !== 0 || !/codex/i.test(probe.stdout || '')) {
    throw new Error('Codex executable preflight failed; install and sign in to Codex, then check the configured executable.')
  }
  const runner = require('../src/agent/runner')
  secureDataDir(stateDir)
  const lockFile = path.join(stateDir, 'daemon.lock')
  const lock = require('../src/core/instancelock').acquire(lockFile)
  if (!lock.ok) throw new Error('C2 v2 development service cannot hold the single-writer lock')
  let running = false
  try {
    // The old daemon records interrupted work here and consumes it on restart.
    // Starting v2 while such a file exists would leave that work invisible;
    // never consume, delete, or reinterpret it without an explicit migration.
    for (const name of ['pending-turns.json', 'engine-receipts.json']) {
      try {
        fs.lstatSync(path.join(stateDir, name))
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      throw new Error(`C2 v2 cannot start with legacy ${name}; preserve it and drain with the old service or use a reviewed migration`)
    }
    const { createC2V2SourceQuarantine } = require('../src/core/c2sourcequarantine')
    const requireQuarantine = process.env.SBOT_C2_V2_REQUIRE_BLOCK_SOURCE_ID
    if (requireQuarantine !== undefined &&
        requireQuarantine !== '0' && requireQuarantine !== '1') {
      throw new Error('C2 v2 source quarantine requirement must be 0 or 1')
    }
    const sourceQuarantine = createC2V2SourceQuarantine([
      process.env.SBOT_C2_V2_BLOCK_SOURCE_ID,
      process.env.SBOT_C2_V2_BLOCK_SOURCE_ID_2],
      { required: requireQuarantine === '1' })
    const assertWriterLock = () => {
      try { return fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid) }
      catch { return false }
    }
    const { C2DurableJournal } = require('../src/core/c2durablejournal')
    const { validatePersistentState } = require('../src/core/c2persiststate')
    const { validatePersistentReceipts, validatePersistentRelation } = require('../src/core/c2persistrelation')
    const { createC2ServiceStartGate } = require('../src/core/c2servicestartgate')
    const { C2PayloadHandles } = require('../src/core/c2payloadhandles')
    const { createC2LocalEffectExecutor, resolveC2LocalEffectTurn } =
      require('../src/core/c2localeffectexecutor')
    const { createFeishuRecoverySender } = require('../src/core/c2platformrecoverysender')
    const journal = C2DurableJournal.open(file, { validateState: validatePersistentState,
      validateReceipts: validatePersistentReceipts,
      validateRelation: validatePersistentRelation })
    const beforeRecovery = journal.snapshot()
    if (preflightOnly && (beforeRecovery.receipts.pending.length !== 0 ||
        Object.keys(beforeRecovery.state.lanes).length !== 0 ||
        [...beforeRecovery.effects.values()].some(status => status !== 'acked') ||
        [...beforeRecovery.notices.values()].some(notice =>
          notice.status === 'attempting' || notice.status === 'unknown'))) {
      throw new Error('C2 v2 service preflight requires a settled journal; use recovery in a controlled service window')
    }
    const limits = { maxEventCount: 100_000,
      maxJournalBytes: 64 * 1024 * 1024,
      maxCompletionEvents: 1_000, maxCompletionBytes: 8 * 1024 * 1024 }
    const { routeBackend } = require('../src/agent/privatecore')
    const { C2DurableRuntime } = require('../src/core/c2durableruntime')
    const { coordinateC2GlobalFault } = require('../src/core/c2globalfault')
    const closeChecks = {
      claude: require('../src/agent/claudecode').isClosedRunnerResult,
      'codex-exec': require('../src/agent/codexcode').isClosedRunnerResult,
      'codex-app': require('../src/agent/codexapp').isClosedRunnerResult,
    }
    const validators = { validateState: validatePersistentState,
      validateReceipts: validatePersistentReceipts,
      validateRelation: validatePersistentRelation }
    const createTransport = () => {
      const client = feishuClient(cfg.feishu.appId, cfg.feishu.appSecret)
      const adapter = createFeishuPlatform({ appId: cfg.feishu.appId,
        appSecret: cfg.feishu.appSecret, botOpenId: cfg.feishu.botOpenId,
        onlyWhenMentioned: cfg.feishu.onlyWhenMentioned === true,
        ws: cfg.feishu.ws || {}, card: cfg.feishu.card || {}, client })
      const platform = createMultiPlatform({ adapters: { feishu: adapter },
        resolve: chatId => chatPlatform(cfg, chatId) })
      const sender = createFeishuRecoverySender({ cfg, platform, client })
      for (const [chatId] of groups) sender.resolveTarget({ id: '0'.repeat(32),
        chatId, source: 'message', sourceId: 'om_c2_service_probe' })
      return { platform, sender, stopPlatform: () => adapter.stop({ strict: true }) }
    }
    const buildBinding = async authorityJournal => {
      const { platform, sender, stopPlatform } = createTransport()
      const gate = createC2ServiceStartGate({ enabled: true,
        journal: authorityJournal, assertWriterLock,
        resolveTarget: sender.resolveTarget, send: sender.send,
        singleNoticePerGroup: true, ...limits })
      try {
        await gate.start()
        const runtime = gate.runtime
        if (!runtime || runtime.blocked || !assertWriterLock()) {
          throw new Error('C2 v2 development service recovery did not open ingress')
        }
        const handles = new C2PayloadHandles({ journal: authorityJournal })
        handles.reopenAfterRecovery()
        if (handles.blocked || runtime.snapshot().cursor !== authorityJournal.snapshot().cursor) {
          throw new Error('C2 v2 development service payload authority differs after recovery')
        }
        const store = new StateStore(path.join(stateDir, 'state.json'))
        const closedResults = new WeakSet()
        const startTurn = async input => {
          const backend = routeBackend(input.provider?.runner, input.codexApp,
            input.codexSteer, input.codexProjectDocFallback)
          const result = await runner.runTurn(input)
          if (closeChecks[backend]?.(result) === true) closedResults.add(result)
          return result
        }
        let engine
        const applyLocalEffect = createC2LocalEffectExecutor({
          journal: authorityJournal, store,
          verifyFile: path.join(stateDir, 'verify.json'), assertWriterLock,
          resolveTurn: identity => resolveC2LocalEffectTurn(engine, identity) })
        const { Engine } = require('../src/core/v2engine')
        engine = new Engine(cfg, { runner, store, log: message =>
          process.stderr.write(`C2 v2 · ${message}\n`),
        durableV2Runtime: runtime, durableV2Payloads: handles,
        durableV2StartTurn: startTurn, durableV2ApplyLocalEffect: applyLocalEffect,
        durableV2VerifyRunnerClosed: ({ result }) => !!result &&
          typeof result === 'object' && closedResults.has(result),
        durableV2AssertWriterLock: assertWriterLock,
        durableV2Journal: authorityJournal, durableV2NormalRoute: true })
        return { journal: authorityJournal, platform, sender, stopPlatform, gate,
          runtime, handles, store, engine }
      } catch (error) { gate.stop(); throw error }
    }
    let active = await buildBinding(journal)
    if (preflightOnly) {
      active.gate.stop()
      process.stdout.write('SintBot startup preflight passed; Feishu socket stayed disconnected\n')
      return
    }
    let stopping = false
    let rebuilds = 0
    let finishing = false
    const finish = (reason, code, platformStopped, drained) => {
      if (finishing) return
      finishing = true
      lock.release()
      process.stderr.write(`C2 v2 · ${reason}; platform stopped=${platformStopped}; runner drained=${drained}\n`,
        () => process.exit(code))
    }
    const activeTurns = snapshot => {
      const lanes = snapshot.state.lanes
      const turns = []
      for (const chatId of new Set([...Object.keys(lanes.turn || {}),
        ...Object.keys(lanes.handoff || {}),
        ...Object.keys(lanes.lifecycle || {})])) {
        const turn = lanes.turn?.[chatId]
        const handoff = lanes.handoff?.[chatId]
        const lifecycle = lanes.lifecycle?.[chatId]
        if (turn?.active != null || handoff?.phase && handoff.phase !== 'idle' ||
            lifecycle?.busy === true || lifecycle?.controller === true) {
          turns.push({ chatId, turnToken: turn?.active ?? handoff?.turnToken ?? null })
        }
      }
      return turns.sort((a, b) => a.chatId.localeCompare(b.chatId))
    }
    const launch = async binding => {
      const onFatal = createC2ReceiptIngressFatalHook({
        log: message => process.stderr.write(`C2 v2 · ${message}\n`),
        shutdown: reason => shutdown(binding, reason, 1) })
      const unsupported = source => () => {
        void onFatal(new Error(`C2 v2 unsupported Feishu ${source} source`))
      }
      await binding.platform.start((msg, sourceAdapter) => {
        if (binding !== active || binding.gate.blocked || !assertWriterLock()) {
          throw new Error('C2 v2 development service ingress lost durable authority')
        }
        if (msg?.chatId !== serviceChatId) {
          throw new Error('C2 v2 development service received a message outside its single group')
        }
        if (sourceQuarantine?.rejects(msg)) {
          process.stderr.write('C2 v2 · quarantined historical source message before receipt\n')
          return { quarantined: true }
        }
        return binding.engine.runDurableV2Message(msg, sourceAdapter)
      }, { onFatal, onRecall: unsupported('recall'),
        onReaction: unsupported('reaction'),
        onCardAction: unsupported('card action'),
        onBoardUpdated: unsupported('board update') })
      process.stderr.write('SintBot single-group Feishu ingress connected\n')
    }
    const shutdown = async (binding, reason, code = 1) => {
      if (stopping || binding !== active) return
      stopping = true
      binding.gate.stop()
      binding.engine.shutdown()
      let stopTimer
      const platformStopped = await Promise.race([
        Promise.resolve().then(() => binding.stopPlatform()).then(value => value === true, () => false),
        new Promise(resolve => {
          stopTimer = setTimeout(() => resolve(false), 2_000)
        }),
      ])
      clearTimeout(stopTimer)
      const drained = await binding.engine.drainDurableV2(12_000).catch(() => false)
      // A failed route may have already settled, leaving a closed child and
      // active durable receipt for global-fault reconciliation. A still-live
      // route or child cannot be replaced, even if the drain timer expired.
      const quiescent = [...binding.engine.rts.values()].every(rt =>
        !rt.v2Controller && !rt.v2NormalRouteActive)
      if (code === 0 || !platformStopped || !quiescent || !assertWriterLock() ||
          rebuilds >= 1) {
        finish(reason, code === 0 && platformStopped && drained ? 0 : 1,
          platformStopped, drained)
        return
      }
      rebuilds++
      try {
        const current = binding.journal.snapshot()
        const turns = activeTurns(current)
        const proofs = turns.length
          ? binding.engine.durableV2ActiveFaultProofs?.(turns) || null : null
        const result = await coordinateC2GlobalFault({
          runtime: binding.runtime, journal: binding.journal, assertWriterLock,
          abortTurn: turn => binding.engine.abortDurableV2FaultTurn?.(turn) === true,
          activeTurnProofs: proofs,
          createAuthority: () => {
            const nextJournal = C2DurableJournal.open(file, validators)
            const nextRuntime = new C2DurableRuntime({ journal: nextJournal,
              resolveTarget: binding.sender.resolveTarget,
              send: binding.sender.send, assertWriterLock,
              singleNoticePerGroup: true, ...limits })
            return { journal: nextJournal, runtime: nextRuntime }
          } })
        if (result.status !== 'recovered' || !assertWriterLock()) {
          finish(`C2 v2 recovery sealed: ${result.reason || 'writer lock lost'}`,
            1, platformStopped, drained)
          return
        }
        result.runtime.close()
        const next = await buildBinding(result.journal)
        active = next
        // A fatal callback may arrive synchronously while the fresh platform
        // starts. It must not be swallowed by the old binding's stop guard.
        stopping = false
        await launch(next)
        process.stderr.write('C2 v2 process-local authority rebuilt\n')
      } catch (error) {
        finish(`C2 v2 recovery failed: ${error?.message || String(error)}`,
          1, platformStopped, drained)
      }
    }
    process.on('SIGINT', () => { void shutdown(active, 'SIGINT', 0) })
    process.on('SIGTERM', () => { void shutdown(active, 'SIGTERM', 0) })
    process.on('exit', lock.release)
    try {
      await launch(active)
      running = true
    } catch (error) {
      active.gate.stop()
      active.engine.shutdown()
      let timer
      await Promise.race([
        Promise.resolve().then(() => active.stopPlatform()).catch(() => false),
        new Promise(resolve => { timer = setTimeout(resolve, 2_000) }),
      ])
      clearTimeout(timer)
      await active.engine.drainDurableV2(12_000).catch(() => false)
      throw error
    }
  } finally { if (!running) lock.release() }
}

// The opt-in receipt authority cannot keep accepting Feishu messages after
// its ingress callback rejects. The adapter closes its socket first; the
// daemon then aborts running turns and exits nonzero under the supervisor.
function createC2ReceiptIngressFatalHook({ log, shutdown }) {
  if (typeof log !== 'function' || typeof shutdown !== 'function') {
    throw new TypeError('C2 receipt ingress fatal hook needs log and shutdown')
  }
  let fired = false
  return error => {
    if (fired) return
    fired = true
    log('C2 receipt ingress failed: ' + (error && error.message || String(error)))
    return shutdown('C2 receipt ingress failed', 1)
  }
}

function fail(message) {
  process.stderr.write(`sintbot: ${message}\n`)
  process.exitCode = 1
}

const HELP = `SintBot macOS Feishu single-group release
Usage:
  sintbot init [--config <absolute path>]
  sintbot start [--config <absolute path>] [--preflight]
  sintbot version
  sintbot help

Supports one explicit Feishu group using Codex. Start runs in the foreground.
Initialization is for a new installation only; existing journals are never reset.
Canvas, multiple groups, console, scheduled tasks, terminal chat and other platforms are unavailable.
`

async function main(argv = process.argv.slice(2)) {
  const [sub, ...rest] = argv
  if (sub === 'version' || sub === '--version' || sub === '-v') {
    if (rest.length) throw new Error('version does not accept arguments')
    process.stdout.write(require('../package.json').version + '\n')
    return
  }
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h' ||
      ['init', 'start'].includes(sub) && rest.length === 1 && ['--help', '-h'].includes(rest[0])) {
    process.stdout.write(HELP)
    return
  }
  if (!['init', 'start'].includes(sub)) {
    throw new Error(`${sub} is unavailable in this single-group release; use sintbot help`)
  }
  if (process.platform !== 'darwin') throw new Error('this release supports macOS only')
  if (sub === 'init') {
    const { values } = parseArgs({ args: rest, allowPositionals: false,
      options: { config: { type: 'string' } } })
    require('../src/c2install').initializeInstallation(values.config)
    process.stdout.write('SintBot journal initialized; run sintbot start to connect the configured group.\n')
    return
  }
  await startService(rest)
}

if (require.main === module) main().catch(error => fail(error?.message || String(error)))
module.exports = { main, createC2ReceiptIngressFatalHook }
