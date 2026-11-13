#!/usr/bin/env node
'use strict'

// macOS Feishu entry. Each group has an independent durable authority;
// the process owns one transport, writer lease and shared session store.
const fs = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { applyProxyEnv, chatPlatform, platformsConfigured } = require('../src/config')
const { secureDataDir } = require('../src/core/datadir')
const { StateStore } = require('../src/core/store')
const { createFeishuPlatform, feishuClient } = require('../src/platform/feishu')
const { createMultiPlatform } = require('../src/platform/multi')
const { createLocalPlatform } = require('../src/platform/local')
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
  const { loadInstallation, assertPrivateDirectory, assertInstallationJournals, assertJournalScope, installationStateDir } = require('../src/c2install')
  // Setup mode: no configuration yet. With --ui, serve the local scan-to-connect
  // page (src/setupserver.js) in this process; it writes the configuration and
  // initializes the journals, then the normal start below continues.
  const setupConfig = path.resolve(values.config || process.env.SBOT_CONFIG || path.join(installationStateDir(values['data-dir']), 'config.json'))
  if (!fs.existsSync(setupConfig)) {
    if (preflightOnly || values.ui !== true) {
      throw new Error('No configuration yet. Run `sintbot start --ui` and connect Feishu in the browser (or `sintbot connect` in the terminal)')
    }
    await runSetupMode({ configFile: setupConfig, dataDir: values['data-dir'],
      host: values['ui-host'] || '127.0.0.1', port: Number(values['ui-port'] || 4600),
      open: values['no-open'] !== true })
  }
  // Groups added to the configuration since the last start are registered
  // below, after the writer lock is held; existing journals stay as mapped.
  const installation = loadInstallation(setupConfig, { dataDir: values['data-dir'], allowAddedGroups: true })
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
  // Settings outside this installation that can reroute a CLI (daemon env,
  // ~/.claude/settings.json, ~/.codex/config.toml): warn-only, keys not values.
  if (preflightOnly) require('../src/agent/envconflicts').reportEnvConflicts(installation)
  // Every installation, including one group, runs the multi-group service:
  // chat commands, the console writer and per-group fault closing live there.
  return startMultiGroupService({ installation, preflightOnly, uiEnabled, uiHost, uiPort })
}

// Serve the setup page until the configuration exists. The page is local only;
// the browser is opened once. Ctrl-C cancels the scan in progress and exits.
async function runSetupMode({ configFile, dataDir, host, port, open }) {
  const { createSetupServer, probeRunners } = require('../src/setupserver')
  const os = require('node:os')
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Console port is invalid')
  const setup = createSetupServer({ configFile, dataDir, home: os.homedir(), version: require('../package.json').version,
    runners: probeRunners(), host, port, log: message => process.stderr.write(`Setup · ${message}\n`) })
  await setup.listen()
  const url = `http://${host === '::1' ? '[::1]' : host}:${port}/`
  process.stderr.write(`SintBot is not set up yet. Open ${url} to connect Feishu by scanning, or to start with a conversation on this Mac.\n`)
  if (open && process.platform === 'darwin') {
    try { require('node:child_process').spawn('open', [url], { stdio: 'ignore', detached: true }).unref() } catch {}
  }
  // Ctrl-C: cancel the run (runConnect stops at its next step boundary, writing
  // nothing), wait for it to end, then exit.
  const onSignal = () => {
    setup.session.cancel()
    const ended = Promise.race([Promise.resolve(setup.session.wait()).catch(() => {}), new Promise(resolve => setTimeout(resolve, 15_000))])
    ended.then(() => setup.close()).finally(() => process.exit(130))
  }
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal)
  try {
    await setup.completed
    // Let the page read the final state before the console takes the port.
    await new Promise(resolve => setTimeout(resolve, 3000))
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal)
    await setup.close()
  }
  process.stderr.write('Setup · configuration written; starting the service\n')
}

// Model and depth used to live on model cards; they now belong to each group.
// Once every group is connected (a console upgrade can no longer roll back
// onto this configuration), copy each card's value into the groups that have
// not chosen and remove it from the card, in one validated write. Effective
// values do not change, so no session resets. The file is backed up first;
// a group still running is retried later.
function scheduleCardDefaultsMigration({ service, configControl, updater, cfg, stateDir, log,
  delayMs = 15_000, tries = 40 } = {}) {
  const fs = require('node:fs')
  const { fillGroupPicks, stripCardDefaults } = require('../src/groupbrain')
  const pending = () => {
    const probe = JSON.parse(fs.readFileSync(cfg._path, 'utf8'))
    const filled = fillGroupPicks(probe).changed
    return stripCardDefaults(probe).changed || filled
  }
  try { if (!pending()) return } catch (error) { log(`card defaults migration skipped: ${error?.message || String(error)}`); return }
  let left = tries
  const attempt = () => {
    left -= 1
    try {
      if (!service.serving || service.held.size || service.inMaintenance ||
          updater?.status?.()?.job?.state === 'switching') throw new Error('service not settled')
      if (!pending()) return
      const dir = path.join(stateDir, 'config-backups')
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const backup = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-group-model.json`)
      fs.copyFileSync(cfg._path, backup)
      fs.chmodSync(backup, 0o600)
      let summary = null
      configControl.writeConfig(raw => {
        const filled = fillGroupPicks(raw)
        const stripped = stripCardDefaults(raw)
        summary = { groups: filled.groups.length, providers: stripped.providers }
      })
      log(`model and depth moved from model cards into groups: ${summary.groups} group(s), cards ${summary.providers.join(', ') || '-'}; backup ${path.basename(backup)}`)
    } catch (error) {
      if (left > 0) { const t = setTimeout(attempt, delayMs * 4); t.unref?.() }
      else log(`card defaults migration not applied: ${error?.message || String(error)}`)
    }
  }
  const timer = setTimeout(attempt, delayMs)
  timer.unref?.()
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
  const { createFeishuRecoverySender, createLocalRecoverySender, createRoutedRecoverySender } = require('../src/core/c2platformrecoverysender')
  const { createC2V2SourceQuarantine } = require('../src/core/c2sourcequarantine')
  const { Engine } = require('../src/core/v2engine')
  const { createC2MultiGroupService } = require('../src/c2multigroupservice')
  const { C2MultiGroupCapacity } = require('../src/c2multigroupcapacity')
  const { routeBackend } = require('../src/agent/privatecore')
  const { assertRunnerExecutable } = require('../src/c2install')
  const { C2DurableRuntime } = require('../src/core/c2durableruntime')
  // /hud reads the group's model quota; /issue appends to the console's log.
  const usageProbe = require('../src/usage').createUsageProbe({
    bin: cfg.agent?.bin || 'claude',
    codexUsage: async () => { const status = require('../src/agent/codexstatus')
      return status.formatUsage(await status.rateLimits('codex')) } })
  const issues = require('../src/core/issues').createIssues(path.join(stateDir, 'issues.jsonl'),
    { withFileLock: require('../src/core/store').withFileLock,
      log: message => process.stderr.write(`C2 multi-group · ${message}\n`) })
  // Backend · model · depth: one live model list per process (also used by the
  // console), and every effective change is audited.
  const modelCatalog = require('../src/modelcatalog').createModelCatalog({
    codexstatus: require('../src/agent/codexstatus'), claudemodels: require('../src/agent/claudemodels'),
    claudeBin: cfg.agent?.bin || 'claude', cacheFile: path.join(stateDir, 'model-lists.json'),
    log: message => process.stderr.write(`C2 multi-group · ${message}\n`) })
  const groupBrainMod = require('../src/groupbrain')
  const { buildModelCard } = require('../src/platform/modelcard')
  const audit = require('../src/core/ledger').createLedger(path.join(stateDir, 'audit.jsonl'),
    message => process.stderr.write(`C2 multi-group · ${message}\n`))
  const setGroupBrain = (chatId, change, { by = '', source = 'console' } = {}) => {
    const result = configControl.setGroupBrain(chatId, change)
    if (result?.changed) audit.append(groupBrainMod.auditRow(chatId, result, { source, by }))
    return result
  }
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
  let updater
  let consoleSeal = null
  let liveTransport
  let activity
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
    activity = require('../src/ui/liveactivity').createLiveActivity({
      file: path.join(stateDir, 'activity-v1.json'), canWrite: assertWriterLock,
      log: message => process.stderr.write(`Console · ${message}\n`) })
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
    const finish = async (result, { seal = null } = {}) => {
      if (finishing) return
      finishing = true
      ui?.close()
      updater?.close()
      await activity?.close()
      lock.release()
      let code = result.code
      if (seal) {
        // A seal asked from the console: the operator tool runs now that the
        // lock is free, and a clean exit lets launchd start the service again.
        require('../src/c2consoleseal').sealAfterStop({ chatId: seal, result, stateDir,
          seal: chatId => require('../src/c2incident').sealC2GroupIncident({
            installation: require('../src/c2install').loadInstallation(cfg._path,
              { dataDir: stateDir, allowAddedGroups: true }),
            chatId, reason: 'sealed from the console after an unresolved fault',
            version: require('../package.json').version }),
          log: message => process.stderr.write(`C2 multi-group · ${message}\n`) })
        code = 0
      }
      process.stderr.write(`C2 multi-group · ${result.reason}; platform stopped=${result.platformStopped}; runner drained=${result.drained}\n`,
        () => process.exit(code))
    }
    service = createC2MultiGroupService({ routes, assertWriterLock, quarantine: combinedQuarantine,
      holds, closeCapacity: () => capacity.close(),
      // Faults in a shared resource stop every group; others hold one group.
      sharedFault: () => capacity.snapshot().closed ? 'model concurrency closed' : null,
      log: message => process.stderr.write(`C2 multi-group · ${message}\n`),
      // /model card taps: the engine decides, the reply replaces the card.
      onModelCard: async (event, binding) => {
        let who = event.operator?.name || ''
        const adapter = liveTransport?.platform.forChat(event.chatId)
        if (!who && adapter?.nameOf && event.operator?.openId) { try { who = (await adapter.nameOf(event.operator.openId)) || '' } catch {} }
        const out = await binding.engine.handleModelCard({ chatId: event.chatId, who,
          value: event.action.value || {}, option: event.action.option })
        const resp = {}
        if (out?.toast) resp.toast = out.toast
        if (out?.state) resp.card = { type: 'raw', data: buildModelCard(out.state) }
        return Object.keys(resp).length ? resp : undefined
      },
      onFatal: (error, result) => {
        process.stderr.write(`C2 multi-group failure: ${error?.message || String(error)}\n`)
        finish(result)
      },
      createTransport: () => {
        // The console's own conversations are always available, so one can be
        // added online. Feishu joins when its credentials are configured; an
        // installation of local conversations alone opens no outside connection.
        const local = createLocalPlatform({ stateDir,
          senderName: (() => { try { return require('node:os').userInfo().username } catch { return '' } })(),
          onEvent: event => ui?.pushEvent('local-message', event),
          log: message => process.stderr.write(`Local chat · ${message}\n`) })
        const adapters = { local }
        let client = null
        if (platformsConfigured(cfg).feishu) {
          client = feishuClient(cfg.feishu.appId, cfg.feishu.appSecret)
          adapters.feishu = createFeishuPlatform({ appId: cfg.feishu.appId,
            appSecret: cfg.feishu.appSecret, botOpenId: cfg.feishu.botOpenId,
            onlyWhenMentioned: cfg.feishu.onlyWhenMentioned === true,
            ws: cfg.feishu.ws || {}, card: cfg.feishu.card || {}, client })
        }
        const platform = createMultiPlatform({ adapters,
          resolve: chatId => chatPlatform(cfg, chatId) })
        const sender = createRoutedRecoverySender({ cfg, senders: {
          local: createLocalRecoverySender({ cfg, platform }),
          ...(client ? { feishu: createFeishuRecoverySender({ cfg, platform, client }) } : {}) } })
        liveTransport = { platform, sender,
          stopPlatform: async () => {
            const stopped = await Promise.all([
              adapters.feishu ? adapters.feishu.stop({ strict: true }) : true, local.stop()])
            return stopped.every(value => value === true)
          } }
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
          // Idle compaction shares the turn's close evidence so its permit is
          // released only once the child is proven closed (or never started).
          const compactSession = input => {
            const started = runner.compactSession(input)
            if (started === null) return null
            return started.then(result => {
              if (closeChecks.claude?.(result) === true) closedResults.add(result)
              return result
            }, error => {
              if (closeErrorChecks.claude?.(error) === true) closedErrors.add(error)
              throw error
            })
          }
          engine = new Engine({ ...cfg, groups: { [route.chatId]: route.group } }, {
            store, activity, log: message => process.stderr.write(`C2 v2 · ${message}\n`),
            durableV2Runtime: runtime, durableV2Payloads: handles,
            durableV2StartTurn: startTurn, durableV2ApplyLocalEffect: applyLocalEffect,
            durableV2VerifyRunnerClosed: ({ result, error }) => result
              ? typeof result === 'object' && closedResults.has(result)
              : !!error && typeof error === 'object' && closedErrors.has(error),
            durableV2AssertWriterLock: assertWriterLock, durableV2Journal: journal,
            durableV2AcquireCapacity: options => capacity.acquire(options),
            durableV2CapacitySnapshot: () => capacity.snapshot(),
            durableV2CompactSession: compactSession,
            // A route fault holds or recovers its group alone. Shared grants
            // are sealed only when the process writer lease itself is gone.
            durableV2SealCapacity: error => {
              if (assertWriterLock() !== true) capacity.close(error)
            },
            durableV2SwitchProvider: (chatId, name) => {
              if (chatId !== route.chatId) throw new Error('Model switch targets another group')
              setGroupBrain(chatId, { provider: name }, { source: 'command' })
            },
            durableV2SetBrain: (chatId, change, meta) => {
              if (chatId !== route.chatId) throw new Error('Model change targets another group')
              return setGroupBrain(chatId, change, meta)
            },
            durableV2ModelCatalog: (name, provider) => modelCatalog(name, provider),
            durableV2ModelCard: state => buildModelCard(state),
            durableV2UsageProbe: usageProbe, durableV2Issues: issues,
            durableV2Version: require('../package.json').version,
            durableV2DataDir: stateDir,
            durableV2ConsoleEnabled: uiEnabled,
            // What outlives a session in this project: its convention files and the
            // executor's own memory directory, probed (never guessed) each turn so
            // either executor is told they exist. Paths and size buckets only.
            projectMemory: (workdir, options) => {
              try { return require('../src/projectmemory').probeHandover(workdir, options) } catch { return null }
            },
            durableV2NormalRoute: true, durableV2StreamFrames: streamFrames(cfg) })
          return { journal, gate, runtime, engine, handles }
        } catch (error) { gate.stop(); throw error }
      } })
    // One configuration writer for the console and the chat /model command.
    configControl = require('../src/c2configcontrol').createC2ConfigControl({
      installation, getBindings: () => service.bindings, getHeld: () => service.held,
      assertWriterLock, store,
      activateRoute: route => service.addRoute(route), isFrozen: () => service.inMaintenance,
      log: message => process.stderr.write(`C2 multi-group · ${message}\n`) })
    if (!preflightOnly) {
      // Console software updates. Only a launchd job that starts this exact
      // entry may upgrade, and only while every group is idle and settled.
      const c2updates = require('../src/c2updater')
      const pkg = require('../package.json')
      const upgradeGate = c2updates.createC2UpgradeGate({ isRunning: () => running,
        service: () => service, capacity, assertJournalScope })
      const runMode = c2updates.detectRunMode({ privateBuild: pkg.private === true, entry: __filename })
      updater = c2updates.createC2Updater({ currentVersion: pkg.version, runMode,
        stateFile: path.join(stateDir, 'update.json'), dataDir: stateDir, configPath: cfg._path,
        gate: upgradeGate, beginMaintenance: () => service.beginMaintenance(),
        endMaintenance: () => service.endMaintenance(), expectedGroups: () => service.bindings.size,
        registries: c2updates.registriesFromEnv(),
        fetchImpl: require('../src/core/proxy').getProxyFetch() || globalThis.fetch,
        // The same store as the startup announcement below.
        setAnnouncementBaseline: version => store.setLastVersion(version),
        autoCheck: uiEnabled, log: message => process.stderr.write(`C2 update · ${message}\n`) })
      // Sealing a held group from the console, with the same idle gate as an
      // upgrade; only where launchd starts the service again afterwards.
      const sealing = require('../src/c2consoleseal')
      if (sealing.consoleSealAvailable({ runMode, readPlist: c2updates.readPlist })) {
        consoleSeal = sealing.createConsoleSeal({ getHeld: () => service.held, gate: upgradeGate,
          upgradeActive: () => ['queued', 'installing', 'switching'].includes(updater.status().job?.state),
          beginMaintenance: () => service.beginMaintenance(), endMaintenance: () => service.endMaintenance(),
          requestStop: chatId => { void service.stop('console seal', 0).then(result => finish(result, { seal: chatId })) } })
      }
    }
    const stop = reason => { void service.stop(reason, 0).then(finish) }
    onSigint = () => stop('SIGINT')
    onSigterm = () => stop('SIGTERM')
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
    if (uiEnabled && !preflightOnly) {
      ui = require('../src/c2console').createC2Console({
        configPath: cfg._path, stateDir, host: uiHost, activity, store,
        getConfig: () => cfg, getBindings: () => service.bindings,
        getHeld: () => service.held, getCapacity: () => capacity.snapshot(),
        acquireCapacity: options => capacity.acquire(options),
        getConnHealth: () => liveTransport?.platform.connHealth?.() || {},
        // Console injection enters through the same ingress as a group
        // message, posted and answered with that group's own adapter.
        getPlatform: chatId => liveTransport?.platform.forChat(chatId) || null,
        getLocal: () => liveTransport?.platform.get('local') || null,
        routeMessage: (msg, adapter) => service.routeMessage(msg, adapter),
        isServing: () => service.serving, isFrozen: () => service.inMaintenance,
        assertWriterLock, ...configControl, setGroupBrain, modelCatalog, updater,
        sealHeld: consoleSeal ? chatId => consoleSeal.request(chatId) : null,
        lastSealFailure: () => require('../src/c2consoleseal').lastSealFailure(stateDir),
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
    // Groups hear about a version change once, as a notice card. A console
    // upgrade to this version that cannot connect every group is rolled back
    // by the switch process, so that start announces nothing and leaves the
    // baseline as it was.
    const version = require('../package.json').version
    const switchJob = started.held?.length ? updater?.status().job : null
    if (!(switchJob?.state === 'switching' && switchJob.to === version)) {
      const announce = require('../src/upgradeannounce')
      announce.announceUpgradeOnStart({ store, cfg, platform: liveTransport?.platform,
        changelog: announce.readChangelog(), currentVersion: version,
        heldGroups: (started.held || []).map(item => item.chatId),
        log: message => process.stderr.write(`SintBot · ${message}\n`) })
    }
    // A console upgrade that switched to this version is done once every
    // group is connected; then the daily version check starts.
    if (!started.held?.length) updater?.confirmStarted()
    void updater?.start()
    // Model lists are probed once in the background shortly after startup, so
    // a later /model or console group card does not wait for a CLI handshake.
    const runners = new Set(Object.values(cfg.providers || {}).filter(p => p && !p.hidden)
      .map(p => p.runner === 'codex' ? 'codex' : !p.baseUrl ? 'claude' : '').filter(Boolean))
    const warm = setTimeout(() => { void modelCatalog.warm([...runners]).catch(() => {}) }, 30_000)
    warm.unref?.()
    scheduleCardDefaultsMigration({ service, configControl, updater, cfg, stateDir,
      log: message => process.stderr.write(`SintBot · ${message}\n`) })
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
      await activity?.close()
      updater?.close()
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
  sintbot connect [--config <absolute path>] [--data-dir <absolute path>] [--workdir <absolute path>] [--name <project>] [--provider codex|claude] [--app-id <cli_…>] [--chat <oc_…>] [--basic] [--attach] [--no-open]
  sintbot incident seal --group <oc_…> [--config <absolute path>] [--data-dir <absolute path>] [--reason <text>]
  sintbot feishu <action> [arguments…] [--chat <oc_…>] [--config <path>]
  sintbot version
  sintbot help

Supports explicit Feishu groups using Codex or Claude Code. Start runs in the foreground.
start --ui with no configuration opens a local setup page that connects Feishu by scanning (the
browser form takes the same inputs as connect); the service starts once setup has written and
initialized the configuration.
connect scans a Feishu QR code to create the app, then creates a group (or binds --chat), the project
folder under ~/Projects, the configuration and the journals, in that order; a failed check stops before
the folder and configuration exist. It refuses existing configuration, state or a running service;
--app-id resumes only when no configuration or an empty-group one for that app exists.
Initialization is for a new installation only; existing journals are never reset.
Console shows live groups, binds groups and switches models or projects of idle groups;
in a group, /model lists or switches models. Unsupported actions stay disabled.
feishu sends to a group without the service (send-msg · send-notice · send-file · send-image ·
history · reply · edit · recall · download · react); sintbot feishu --help lists the arguments.
A conversation in the console needs no Feishu: the setup page offers it, and the console's Chat page adds more.
connect --attach adds Feishu to such an installation later: stop the service, run it, start again; the
conversations, their journals and the configuration stay, and a backup of the configuration is kept.
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
      ['init', 'start', 'connect'].includes(sub) && rest.length === 1 && ['--help', '-h'].includes(rest[0])) {
    process.stdout.write(HELP)
    return
  }
  if (sub === 'upgrade-switch') {
    // Internal: started detached by a console upgrade; never run it by hand.
    const { values } = parseArgs({ args: rest, allowPositionals: false, options: { state: { type: 'string' } } })
    if (!values.state || !path.isAbsolute(values.state)) throw new Error('upgrade-switch needs --state <absolute path>')
    const outcome = await require('../src/c2upgradeswitch').runUpgradeSwitch({ stateFile: values.state })
    process.exitCode = outcome === 'done' ? 0 : 1
    return
  }
  if (!['init', 'start', 'connect', 'incident', 'feishu'].includes(sub)) {
    throw new Error(`${sub} is unavailable in this release; use sintbot help`)
  }
  if (process.platform !== 'darwin') throw new Error('this release supports macOS only')
  if (sub === 'connect') {
    // Operator-only onboarding; deliberately not an action of the feishu skill,
    // which the agent may run from a group.
    process.exitCode = await require('../src/connect').runConnect(rest)
    return
  }
  if (sub === 'feishu') {
    // The agent's group skills. Each call uses the app credentials directly;
    // the service need not run. Text after the action may itself start with
    // '-', so only the first two positions can ask for help.
    const feishuCli = require('../src/feishucli')
    if (rest.slice(0, 2).some(arg => arg === '--help' || arg === '-h')) {
      process.stdout.write(feishuCli.feishuUsage('sintbot'))
      return
    }
    await feishuCli.runFeishuAction(rest)
    return
  }
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
