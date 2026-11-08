#!/usr/bin/env node
'use strict'

// macOS Feishu entry. Each group has an independent durable authority;
// the process owns one transport, writer lease and shared session store.
const fs = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { applyProxyEnv, chatPlatform } = require('../src/config')
const { secureDataDir } = require('../src/core/datadir')
const { StateStore } = require('../src/core/store')
const { createFeishuPlatform, feishuClient } = require('../src/platform/feishu')
const { createMultiPlatform } = require('../src/platform/multi')
const { isC2InputRejection, answerC2InputRejection } = require('../src/core/c2inputrejection')

// Answers stream into the reply card while the model works. The card is
// registered durably before any frame; feishu.card.streaming:false restores
// the single final card.
const streamFrames = cfg => cfg.feishu?.card?.streaming !== false

async function startService(rest) {
  const { values } = parseArgs({ args: rest, allowPositionals: false,
    options: { config: { type: 'string' }, 'data-dir': { type: 'string' }, ui: { type: 'boolean' },
      'no-open': { type: 'boolean' }, 'ui-port': { type: 'string' },
      'ui-host': { type: 'string' }, preflight: { type: 'boolean' } } })
  const preflightOnly = values.preflight === true
  const { loadInstallation, assertPrivateDirectory, assertInstallationJournals, assertJournalScope } = require('../src/c2install')
  // Groups added to the configuration since the last start are registered
  // below, after the writer lock is held; existing journals stay as mapped.
  const installation = loadInstallation(values.config, { dataDir: values['data-dir'], allowAddedGroups: true })
  const { stateDir, file, cfg, groups, routes, serviceChatId, provider } = installation
  const uiEnabled = values.ui === true || cfg.ui?.enabled === true
  const uiHost = values['ui-host'] || cfg.ui?.host || '127.0.0.1'
  const uiPort = Number(values['ui-port'] || cfg.ui?.port || 4600)
  if (uiEnabled && (!['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(uiHost) ||
      !Number.isSafeInteger(uiPort) || uiPort < 1 || uiPort > 65535)) {
    throw new Error('Console address or port is invalid')
  }
  if (uiEnabled && uiHost === '0.0.0.0' && !cfg.ui?.auth) {
    throw new Error('Set a console access password before enabling network access')
  }
  if (!uiEnabled && (values['ui-port'] || values['ui-host'])) {
    throw new Error('Console options require --ui or ui.enabled:true')
  }
  assertInstallationJournals(installation)
  // Every installation, including one group, runs the multi-group service:
  // chat commands, the console writer and per-group fault closing live there.
  return startMultiGroupService({ installation, preflightOnly, uiEnabled, uiHost, uiPort })
}

async function startMultiGroupService({ installation, preflightOnly, uiEnabled = false, uiHost, uiPort }) {
  const { stateDir, cfg, routes } = installation
  const { assertPrivateDirectory, assertJournalScope } = require('../src/c2install')
  const { C2DurableJournal } = require('../src/core/c2durablejournal')
  const { validatePersistentState } = require('../src/core/c2persiststate')
  const { validatePersistentReceipts, validatePersistentRelation } = require('../src/core/c2persistrelation')
  const { createC2ServiceStartGate } = require('../src/core/c2servicestartgate')
  const { C2PayloadHandles } = require('../src/core/c2payloadhandles')
  const { createC2LocalEffectExecutor, resolveC2LocalEffectTurn } = require('../src/core/c2localeffectexecutor')
  const { createFeishuRecoverySender } = require('../src/core/c2platformrecoverysender')
  const { createC2V2SourceQuarantine } = require('../src/core/c2sourcequarantine')
  const { Engine } = require('../src/core/v2engine')
  const { createC2MultiGroupService } = require('../src/c2multigroupservice')
  const { C2MultiGroupCapacity } = require('../src/c2multigroupcapacity')
  const { routeBackend } = require('../src/agent/privatecore')
  const { assertRunnerExecutable } = require('../src/c2install')
  const { C2DurableRuntime } = require('../src/core/c2durableruntime')
  // /hud reads the group's model quota; /issue appends to the console's log.
  const usageProbe = require('../src/usage').createUsageProbe({
    codexUsage: async () => { const status = require('../src/agent/codexstatus')
      return status.formatUsage(await status.rateLimits('codex')) } })
  const issues = require('../src/core/issues').createIssues(path.join(stateDir, 'issues.jsonl'),
    { withFileLock: require('../src/core/store').withFileLock,
      log: message => process.stderr.write(`C2 multi-group · ${message}\n`) })
  const runner = require('../src/agent/runner')
  const validators = { validateState: validatePersistentState,
    validateReceipts: validatePersistentReceipts, validateRelation: validatePersistentRelation }
  assertPrivateDirectory(stateDir)
  applyProxyEnv(cfg)
  const adding = new Set((installation.addedRoutes || []).map(route => route.chatId))
  for (const route of routes) {
    if (adding.has(route.chatId)) {
      if (!route.paused) assertRunnerExecutable(route.provider, cfg)
      continue
    }
    const stat = fs.lstatSync(route.file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('C2 group journal is not a real initialized file')
    if (route.paused) continue
    assertRunnerExecutable(route.provider, cfg)
  }
  const capacity = new C2MultiGroupCapacity({ maxConcurrent: cfg.agent.maxConcurrent })
  const quarantine = createC2V2SourceQuarantine([
    process.env.SBOT_C2_V2_BLOCK_SOURCE_ID, process.env.SBOT_C2_V2_BLOCK_SOURCE_ID_2],
    { required: process.env.SBOT_C2_V2_REQUIRE_BLOCK_SOURCE_ID === '1' })
  if (process.env.SBOT_C2_V2_REQUIRE_BLOCK_SOURCE_ID !== undefined &&
      !['0', '1'].includes(process.env.SBOT_C2_V2_REQUIRE_BLOCK_SOURCE_ID)) {
    throw new Error('C2 source quarantine requirement must be 0 or 1')
  }
  secureDataDir(stateDir)
  const lockFile = path.join(stateDir, 'daemon.lock')
  const lock = require('../src/core/instancelock').acquire(lockFile)
  if (!lock.ok) throw new Error('C2 multi-group service cannot hold the single-writer lock')
  try {
    const registered = require('../src/c2install').registerAddedGroups(installation)
    if (registered.length) process.stderr.write(`C2 multi-group · registered ${registered.length} new group(s) with empty journals\n`)
  } catch (error) { lock.release(); throw error }
  const assertWriterLock = () => {
    try { return fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid) }
    catch { return false }
  }
  let running = false
  let service
  let ui
  let configControl
  let liveTransport
  let onSigint, onSigterm
  try {
    const migrationFence = require('../src/c2migration').loadC2MigrationFence({ stateDir, routes })
    const incidentQuarantine = require('../src/core/c2sourcequarantine').loadC2IncidentQuarantine(stateDir)
    const combinedQuarantine = { rejects: msg => !!quarantine?.rejects(msg) ||
      !!migrationFence?.rejects(msg) || incidentQuarantine.rejects(msg) }
    for (const name of ['pending-turns.json', 'engine-receipts.json']) {
      if (fs.existsSync(path.join(stateDir, name))) throw new Error('Legacy pending authority needs explicit migration')
    }
    // A journal that cannot be opened or audited holds only its own group.
    const journals = new Map()
    const holds = new Map()
    for (const route of routes) {
      try {
        const journal = C2DurableJournal.open(route.file, validators)
        assertJournalScope(journal, route.chatId, { requireSettled: preflightOnly || route.paused })
        journals.set(route.chatId, journal)
      } catch (error) {
        if (!assertWriterLock()) throw error
        holds.set(route.chatId, error?.message || String(error))
      }
    }
    // All group Engines must share this exact object: separate Store caches
    // would overwrite sibling sessions when they save the same state file.
    const store = new StateStore(path.join(stateDir, 'state.json'))
    const closeChecks = {
      claude: require('../src/agent/claudecode').isClosedRunnerResult,
      'codex-exec': require('../src/agent/codexcode').isClosedRunnerResult,
      'codex-app': require('../src/agent/codexapp').isClosedRunnerResult,
    }
    // A runner that failed from its own exit event has closed; this frees its
    // model permit but never proves the turn's outcome.
    const closeErrorChecks = {
      claude: require('../src/agent/claudecode').isClosedRunnerError,
      'codex-exec': require('../src/agent/codexcode').isClosedRunnerError,
      'codex-app': require('../src/agent/codexapp').isClosedRunnerError,
    }
    const limits = { maxEventCount: 100_000, maxJournalBytes: 64 * 1024 * 1024,
      maxCompletionEvents: 1_000, maxCompletionBytes: 8 * 1024 * 1024 }
    let finishing = false
    const finish = result => {
      if (finishing) return
      finishing = true
      ui?.close()
      lock.release()
      process.stderr.write(`C2 multi-group · ${result.reason}; platform stopped=${result.platformStopped}; runner drained=${result.drained}\n`,
        () => process.exit(result.code))
    }
    service = createC2MultiGroupService({ routes, assertWriterLock, quarantine: combinedQuarantine,
      holds, closeCapacity: () => capacity.close(),
      // Faults in a shared resource stop every group; others hold one group.
      sharedFault: () => capacity.snapshot().closed ? 'model concurrency closed' : null,
      log: message => process.stderr.write(`C2 multi-group · ${message}\n`),
      onFatal: (error, result) => {
        process.stderr.write(`C2 multi-group failure: ${error?.message || String(error)}\n`)
        finish(result)
      },
      createTransport: () => {
        const client = feishuClient(cfg.feishu.appId, cfg.feishu.appSecret)
        const adapter = createFeishuPlatform({ appId: cfg.feishu.appId,
          appSecret: cfg.feishu.appSecret, botOpenId: cfg.feishu.botOpenId,
          onlyWhenMentioned: cfg.feishu.onlyWhenMentioned === true,
          ws: cfg.feishu.ws || {}, card: cfg.feishu.card || {}, client })
        const platform = createMultiPlatform({ adapters: { feishu: adapter },
          resolve: chatId => chatPlatform(cfg, chatId) })
        const sender = createFeishuRecoverySender({ cfg, platform, client })
        liveTransport = { platform, sender, stopPlatform: () => adapter.stop({ strict: true }) }
        return liveTransport
      },
      createRecoveryAuthority: ({ route, transport, assertWriterLock: lock }) => {
        const nextJournal = C2DurableJournal.open(route.file, validators)
        const nextRuntime = new C2DurableRuntime({ journal: nextJournal,
          resolveTarget: transport.sender.resolveTarget, send: transport.sender.send,
          assertWriterLock: lock, singleNoticePerGroup: true, ...limits })
        return { journal: nextJournal, runtime: nextRuntime }
      },
      createBinding: async ({ route, transport, journal: recoveredJournal = null }) => {
        if (recoveredJournal) journals.set(route.chatId, recoveredJournal)
        let journal = journals.get(route.chatId)
        if (!journal) {
          // A group added or resumed online opens its own mapped journal here.
          const stat = fs.lstatSync(route.file)
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('C2 group journal is not a real initialized file')
          journal = C2DurableJournal.open(route.file, validators)
          assertJournalScope(journal, route.chatId)
          journals.set(route.chatId, journal)
        }
        const gate = createC2ServiceStartGate({ enabled: true, journal, assertWriterLock,
          resolveTarget: transport.sender.resolveTarget, send: transport.sender.send,
          singleNoticePerGroup: true, ...limits })
        try {
          await gate.start()
          const runtime = gate.runtime
          if (!runtime || runtime.blocked || !assertWriterLock()) throw new Error('C2 group recovery did not open ingress')
          const handles = new C2PayloadHandles({ journal })
          handles.reopenAfterRecovery()
          if (handles.blocked) throw new Error('C2 group payload authority stayed closed')
          let engine
          const applyLocalEffect = createC2LocalEffectExecutor({ journal, store,
            verifyFile: path.join(stateDir, 'verify.json'), assertWriterLock,
            resolveTurn: identity => resolveC2LocalEffectTurn(engine, identity) })
          const closedResults = new WeakSet()
          const closedErrors = new WeakSet()
          const startTurn = async input => {
            const backend = routeBackend(input.provider?.runner, input.codexApp,
              input.codexSteer, input.codexProjectDocFallback)
            let result
            try { result = await runner.runTurn(input) } catch (error) {
              if (closeErrorChecks[backend]?.(error) === true) closedErrors.add(error)
              throw error
            }
            if (closeChecks[backend]?.(result) === true) closedResults.add(result)
            return result
          }
          engine = new Engine({ ...cfg, groups: { [route.chatId]: route.group } }, {
            store, log: message => process.stderr.write(`C2 v2 · ${message}\n`),
            durableV2Runtime: runtime, durableV2Payloads: handles,
            durableV2StartTurn: startTurn, durableV2ApplyLocalEffect: applyLocalEffect,
            durableV2VerifyRunnerClosed: ({ result, error }) => result
              ? typeof result === 'object' && closedResults.has(result)
              : !!error && typeof error === 'object' && closedErrors.has(error),
            durableV2AssertWriterLock: assertWriterLock, durableV2Journal: journal,
            durableV2AcquireCapacity: options => capacity.acquire(options),
            // A route fault holds or recovers its group alone. Shared grants
            // are sealed only when the process writer lease itself is gone.
            durableV2SealCapacity: error => {
              if (assertWriterLock() !== true) capacity.close(error)
            },
            durableV2SwitchProvider: (chatId, name) => {
              if (chatId !== route.chatId) throw new Error('Model switch targets another group')
              configControl.switchGroupProvider(chatId, name)
            },
            durableV2UsageProbe: usageProbe, durableV2Issues: issues,
            durableV2Version: require('../package.json').version,
            durableV2NormalRoute: true, durableV2StreamFrames: streamFrames(cfg) })
          return { journal, gate, runtime, engine, handles }
        } catch (error) { gate.stop(); throw error }
      } })
    // One configuration writer for the console and the chat /model command.
    configControl = require('../src/c2configcontrol').createC2ConfigControl({
      installation, getBindings: () => service.bindings, getHeld: () => service.held,
      assertWriterLock, store,
      activateRoute: route => service.addRoute(route),
      log: message => process.stderr.write(`C2 multi-group · ${message}\n`) })
    const stop = reason => { void service.stop(reason, 0).then(finish) }
    onSigint = () => stop('SIGINT')
    onSigterm = () => stop('SIGTERM')
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
    if (uiEnabled && !preflightOnly) {
      ui = require('../src/c2console').createC2Console({
        configPath: cfg._path, stateDir, host: uiHost,
        getConfig: () => cfg, getBindings: () => service.bindings,
        getHeld: () => service.held, getCapacity: () => capacity.snapshot(),
        getConnHealth: () => liveTransport?.platform.connHealth?.() || {},
        assertWriterLock, ...configControl,
        log: message => process.stderr.write(`Console · ${message}\n`) })
      await new Promise((resolve, reject) => {
        ui.server.once('error', reject)
        ui.listen(uiPort, uiHost, () => { ui.server.off('error', reject); resolve() })
      })
      process.stderr.write(`SintBot console listening on port ${uiPort}\n`)
    }
    const started = await service.start({ preflightOnly })
    if (preflightOnly) {
      process.stdout.write(`SintBot startup preflight passed for ${started.groups} groups; Feishu socket stayed disconnected\n`)
      return
    }
    process.on('exit', lock.release)
    running = true
    process.stderr.write(`SintBot Feishu ingress connected for ${started.groups} groups\n`)
    for (const item of started.held || []) {
      process.stderr.write(`SintBot group ${item.chatId} is held: ${item.reason}\n`)
    }
  } catch (error) {
    ui?.close()
    const stopped = await service?.stop('startup-failed', 1)
    if (stopped && (!stopped.startupStopped || !stopped.platformStopped || !stopped.drained)) {
      process.stderr.write('C2 multi-group startup cleanup was not confirmed; exiting with evidence preserved\n',
        () => process.exit(1))
    }
    throw error
  } finally {
    if (!running) {
      if (onSigint) process.off('SIGINT', onSigint)
      if (onSigterm) process.off('SIGTERM', onSigterm)
      capacity.close(); lock.release()
    }
  }
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

const HELP = `SintBot macOS Feishu multi-group candidate
Usage:
  sintbot init [--config <absolute path>] [--data-dir <absolute path>]
  sintbot start [--config <absolute path>] [--data-dir <absolute path>] [--preflight] [--ui] [--ui-host <address>] [--ui-port <port>] [--no-open]
  sintbot incident seal --group <oc_…> [--config <absolute path>] [--data-dir <absolute path>] [--reason <text>]
  sintbot version
  sintbot help

Supports explicit Feishu groups using Codex or Claude Code. Start runs in the foreground.
Initialization is for a new installation only; existing journals are never reset.
Console shows live groups, binds groups and switches models or projects of idle groups;
in a group, /model lists or switches models. Unsupported actions stay disabled.
Canvas, scheduled tasks, terminal chat and other platforms are unavailable.
A group whose last result cannot be proven is held alone; the other groups keep serving.
Restart first: a journal that can recover reopens on its own. If the group is still held,
stop the service, run incident seal for that group, then start again.
Sealing keeps the old journal unchanged; unknown effects are never replayed.
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
  if (!['init', 'start', 'incident'].includes(sub)) {
    throw new Error(`${sub} is unavailable in this release; use sintbot help`)
  }
  if (process.platform !== 'darwin') throw new Error('this release supports macOS only')
  if (sub === 'incident') {
    const [action, ...args] = rest
    if (rest.some(arg => arg === '--help' || arg === '-h')) { process.stdout.write(HELP); return }
    if (action !== 'seal') throw new Error('Usage: sintbot incident seal --group <oc_…> [--config <path>] [--data-dir <path>]')
    const { values } = parseArgs({ args, allowPositionals: false, options: {
      config: { type: 'string' }, 'data-dir': { type: 'string' },
      group: { type: 'string' }, reason: { type: 'string' } } })
    const installation = require('../src/c2install').loadInstallation(values.config,
      { dataDir: values['data-dir'], allowAddedGroups: true })
    const result = require('../src/c2incident').sealC2GroupIncident({ installation,
      chatId: values.group, ...(values.reason !== undefined ? { reason: values.reason } : {}),
      version: require('../package.json').version })
    process.stdout.write(`Sealed the group's previous journal unchanged in ${result.incident}.\n` +
      `${result.refusedSources} unsettled message(s) will not be processed again. ` +
      'Start the service to reopen the group with a new journal.\n')
    return
  }
  if (sub === 'init') {
    const { values } = parseArgs({ args: rest, allowPositionals: false,
      options: { config: { type: 'string' }, 'data-dir': { type: 'string' } } })
    require('../src/c2install').initializeInstallation(values.config, { dataDir: values['data-dir'] })
    process.stdout.write('SintBot journal initialized; run sintbot start to connect the configured groups.\n')
    return
  }
  await startService(rest)
}

if (require.main === module) main().catch(error => fail(error?.message || String(error)))
module.exports = { main, createC2ReceiptIngressFatalHook }
