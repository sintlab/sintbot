'use strict'

// First-install filesystem preparation only. Existing authorities and legacy
// state are never adopted, cleared, migrated or replayed by this entry.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { loadConfig, normalizeConfig, platformsConfigured } = require('./config')
const { C2DurableJournal } = require('./core/c2durablejournal')
const { validatePersistentState } = require('./core/c2persiststate')
const { validatePersistentReceipts, validatePersistentRelation } = require('./core/c2persistrelation')
const VALIDATORS = { validateState: validatePersistentState,
  validateReceipts: validatePersistentReceipts, validateRelation: validatePersistentRelation }

const GROUP_ID = /^(?:oc_|wr)[A-Za-z0-9_-]{1,124}$/
// A conversation held in the console (src/platform/local.js). Its identity is
// a reserved subset of the group shape, so every journal rule applies as is.
const { isLocalChatId } = require('./platform/local')
const MANIFEST = 'c2-groups.json'
const SUPPORTED_RUNNERS = Object.freeze(['codex', 'claude'])

// The executable a route will spawn must answer --version before the route
// can serve. Successful probes are cached per executable for this process.
const probedExecutables = new Set()
function assertRunnerExecutable(provider, cfg, { spawnSync = require('node:child_process').spawnSync } = {}) {
  const isCodex = provider?.runner === 'codex'
  if (!isCodex && provider?.runner !== 'claude') throw new Error('Unsupported model runner')
  const bin = isCodex ? (provider.bin || 'codex') : (cfg?.agent?.bin || 'claude')
  const key = `${provider.runner}\0${bin}`
  if (probedExecutables.has(key)) return true
  const probe = spawnSync(bin, ['--version'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    env: { ...process.env, ...(provider.env || {}) } })
  if (probe.error || probe.status !== 0 || !(isCodex ? /codex/i : /claude/i).test(probe.stdout || '')) {
    throw new Error(isCodex
      ? 'Codex executable preflight failed; install and sign in to Codex, then check the configured executable.'
      : 'Claude Code executable preflight failed; install and sign in to Claude Code, then check the configured executable.')
  }
  probedExecutables.add(key)
  return true
}

function installationStateDir(dataDir) {
  const stateDir = dataDir === undefined ? path.join(os.homedir(), '.sbot') : dataDir
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) ||
      stateDir !== path.resolve(stateDir) || stateDir === path.parse(stateDir).root) {
    throw new Error('The data directory must be a normalized absolute private directory')
  }
  return stateDir
}

function loadInstallation(explicitConfig, { dataDir, allowAddedGroups = false } = {}) {
  const stateDir = installationStateDir(dataDir)
  const configFile = explicitConfig || process.env.SBOT_CONFIG || path.join(stateDir, 'config.json')
  if (!path.isAbsolute(configFile) || !fs.existsSync(configFile)) {
    throw new Error('An existing configuration file with an absolute path is required')
  }
  return resolveInstallation(loadConfig(configFile), configFile, stateDir, { allowAddedGroups })
}

function loadInstallationFromRaw(raw, configFile, { dataDir, allowAddedGroups = false } = {}) {
  const stateDir = installationStateDir(dataDir)
  if (typeof configFile !== 'string' || !path.isAbsolute(configFile)) {
    throw new Error('Configuration requires an absolute path')
  }
  return resolveInstallation(normalizeConfig(raw, configFile, { registerSecrets: false }), configFile, stateDir,
    { allowAddedGroups })
}

// An online group addition may extend the persisted mapping: every mapped
// group keeps its exact journal and each new group has no journal file yet.
function mappingExtends(persisted, manifest, stateDir) {
  const groups = Array.isArray(persisted?.groups) ? persisted.groups : null
  if (!groups || persisted.version !== 1 ||
      !isDeepStrictEqual({ ...persisted, groups: manifest.groups }, manifest) ||
      !groups.every(group => manifest.groups.some(item => isDeepStrictEqual(item, group)))) return false
  return manifest.groups.filter(item => !groups.some(group => group.chatId === item.chatId))
    .every(item => !fs.existsSync(path.join(stateDir, item.journal)))
}

function resolveInstallation(cfg, configFile, stateDir, { allowAddedGroups = false } = {}) {
  const configured = platformsConfigured(cfg)
  const groups = Object.entries(cfg.groups || {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (groups.length < 1 || groups.length > 32) {
    throw new Error('This release requires 1 to 32 explicit project conversations')
  }
  // Feishu credentials are required exactly when a Feishu group is configured.
  // An installation of local conversations alone has no platform credentials.
  const needsFeishu = groups.some(([, group]) => group?.platform === 'feishu')
  if (path.resolve(cfg._path || '') !== path.resolve(configFile) ||
      needsFeishu && !configured.feishu ||
      groups.some(([, group]) => group?.platform === 'wecom') && !configured.wecom ||
      configured.slack || cfg.slack ||
      (cfg._groupPlatform?.inferred || []).length || cfg.alerts?.chatId) {
    throw new Error('This release accepts explicit supported message routes without synthetic sources')
  }
  if (!Number.isSafeInteger(cfg.agent.maxConcurrent) || cfg.agent.maxConcurrent < 1 ||
      cfg.agent.maxConcurrent > 32) throw new Error('maxConcurrent must be an integer from 1 to 32')
  if (cfg.feishu?.onlyWhenMentioned === true &&
      !/^ou_[a-zA-Z0-9_-]+$/.test(cfg.feishu.botOpenId || '')) {
    throw new Error('Mention-only messages require the Feishu botOpenId; otherwise set onlyWhenMentioned:false')
  }
  const override = process.env.SBOT_C2_V2_JOURNAL
  if (override && groups.length !== 1) throw new Error('A shared journal override cannot be used for multiple groups')
  // A persisted mapping keeps each group's journal name, so a one-group
  // installation (c2-v2.log) can grow without renaming live authority.
  const manifestFile = path.join(stateDir, MANIFEST)
  let persisted = null
  if (fs.existsSync(manifestFile)) {
    const st = fs.lstatSync(manifestFile)
    if (!st.isFile() || st.isSymbolicLink() ||
        typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new Error('Group journal mapping is not an owned regular file')
    }
    persisted = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  }
  const mappedJournal = new Map((Array.isArray(persisted?.groups) ? persisted.groups : [])
    .filter(item => item && typeof item.chatId === 'string' && typeof item.journal === 'string')
    .map(item => [item.chatId, item.journal]))
  // A provider without an explicit runner has always meant Claude Code. The
  // durable route requires the explicit name, so normalize it in memory only.
  for (const provider of Object.values(cfg.providers || {})) {
    if (provider && typeof provider === 'object' && provider.runner === undefined) provider.runner = 'claude'
  }
  const routes = groups.map(([chatId, group]) => {
    // The reserved local prefix and the local platform always go together:
    // a Feishu group can never take a local identity, nor the reverse.
    if (!GROUP_ID.test(chatId) || !group || !['feishu', 'local', 'wecom'].includes(group.platform) ||
        (group.platform === 'local') !== isLocalChatId(chatId) ||
        (group.platform === 'wecom') !== /^wr/.test(chatId) ||
        group.platform !== 'local' && /^oc_local_/.test(chatId)) {
      throw new Error('Every configured group must have an explicit matching platform identity')
    }
    if (group.paused !== undefined && typeof group.paused !== 'boolean') {
      throw new Error('Group paused must be a boolean')
    }
    if (group.steer !== undefined && typeof group.steer !== 'boolean') throw new Error('Group steer must be a boolean')
    if (group.codexSteer !== undefined && typeof group.codexSteer !== 'boolean') {
      throw new Error('Group codexSteer must be a boolean')
    }
    const provider = cfg.providers?.[group.provider || cfg.defaultProvider]
    // Paused routes keep their original metadata, but cannot execute it. They
    // must pass the full active-route checks before a later restart enables them.
    if (!group.paused && (group.board ||
        group.crons && (!Array.isArray(group.crons) || group.crons.length) ||
        !SUPPORTED_RUNNERS.includes(provider?.runner) || group.codexApp === true)) {
      throw new Error('Active groups require Codex or Claude Code without canvas, scheduled tasks or desktop App integration')
    }
    if (!group.paused && (typeof group.workdir !== 'string' || !path.isAbsolute(group.workdir) ||
        !fs.existsSync(group.workdir) || !fs.statSync(group.workdir).isDirectory())) {
      throw new Error('Each active group workdir must be an existing absolute project directory')
    }
    const base = mappedJournal.get(chatId) || (groups.length === 1 ? 'c2-v2.log' :
      `c2-v2-group-${createHash('sha256').update(chatId).digest('hex').slice(0, 24)}.log`)
    const file = override || path.join(stateDir, base)
    if (!path.isAbsolute(file) || file !== path.resolve(file) ||
        path.dirname(file) !== stateDir || !/^c2-v2(?:[._-][a-zA-Z0-9._-]+)?\.log$/.test(path.basename(file))) {
      throw new Error('The journal must be a c2-v2*.log file directly in the installation state directory')
    }
    return { chatId, group, provider, file, paused: group.paused === true }
  })
  if (!routes.some(route => !route.paused)) throw new Error('At least one configured group must be active')
  const manifest = { version: 1, groups: routes.map(({ chatId, file }) => ({ chatId, journal: path.basename(file) })) }
  let addedRoutes = []
  if (persisted) {
    if (persisted.migrationSha256 !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(persisted.migrationSha256)) {
        throw new Error('Group journal migration binding is invalid')
      }
      manifest.migrationSha256 = persisted.migrationSha256
    }
    if (!isDeepStrictEqual(persisted, manifest)) {
      if (!(allowAddedGroups && mappingExtends(persisted, manifest, stateDir))) {
        throw new Error('Group journal mapping differs; preserve existing authority and review configuration migration')
      }
      addedRoutes = routes.filter(route => !mappedJournal.has(route.chatId))
    }
    const expected = new Set(routes.map(route => path.basename(route.file)))
    if (fs.readdirSync(stateDir).some(name => /^c2-v2.*\.log$/.test(name) && !expected.has(name))) {
      throw new Error('Unmapped existing journal requires review; no authority may be silently ignored')
    }
  }
  if (routes.length === 1 && !persisted && fs.existsSync(stateDir)) {
    const selected = path.basename(routes[0].file)
    if (fs.readdirSync(stateDir).some(name => /^c2-v2.*\.log$/.test(name) && name !== selected)) {
      throw new Error('Unmapped existing journal requires review; legacy single-group authority cannot hide other logs')
    }
  }
  const first = routes[0]
  return { stateDir, file: first.file, cfg, groups, routes, addedRoutes,
    serviceChatId: first.chatId, provider: first.provider, manifestFile, manifest }
}

function assertJournalScope(journal, chatId, { requireSettled = false } = {}) {
  if (!GROUP_ID.test(chatId)) throw new Error('Journal group identity invalid')
  const snap = journal.snapshot()
  for (const lanes of Object.values(snap.state.lanes)) {
    if (Object.keys(lanes).some(scope => scope !== chatId)) throw new Error('Journal contains another group scope')
  }
  if (snap.receipts.pending.some(receipt => receipt.chatId !== chatId) ||
      [...snap.notices.values()].some(notice => notice.chatId !== chatId) ||
      [...snap.effects.keys()].some(id => journal.effectDescriptor(id)?.scope !== chatId) ||
      journal.runnerClosedProofs().some(proof => proof.chatId !== chatId) ||
      journal.runnerNotStartedProofs().some(proof => proof.chatId !== chatId)) {
    throw new Error('Journal receipts or effects belong to another group')
  }
  if (requireSettled && (snap.receipts.pending.length ||
      [...snap.effects.values()].some(status => status !== 'acked') ||
      [...snap.notices.values()].some(notice => ['attempting', 'unknown'].includes(notice.status)) ||
      Object.values(snap.state.lanes.turn || {}).some(lane => lane.active !== null) ||
      Object.values(snap.state.lanes.handoff || {}).some(lane => lane.phase !== 'idle') ||
      Object.values(snap.state.lanes.lifecycle || {}).some(lane => lane.busy || lane.controller) ||
      Object.values(snap.state.lanes.queue || {}).some(lane => lane.queue.length) ||
      Object.values(snap.state.lanes.session || {}).some(lane => lane.settled !== true) ||
      ['terminal', 'stopIntent', 'cardCleanup', 'steer'].some(domain => Object.keys(snap.state.lanes[domain] || {}).length))) {
    throw new Error('Group journal has unresolved work; preserve it and explicitly review recovery')
  }
  return snap
}

function assertInstallationJournals(installation) {
  const { routes, manifestFile } = installation
  if (routes.length > 1 && !fs.existsSync(manifestFile)) {
    throw new Error('No initialized journal mapping; initialize a new data directory or review existing state migration')
  }
  const adding = new Set((installation.addedRoutes || []).map(route => route.chatId))
  for (const route of routes) {
    if (adding.has(route.chatId)) continue
    let st
    try { st = fs.lstatSync(route.file) } catch {}
    if (!st?.isFile() || st.isSymbolicLink() ||
        typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new Error('No initialized journal; initialize a new installation and preserve existing state')
    }
  }
}

function assertPrivateDirectory(dir) {
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('The installation state directory must be a real directory owned by this user')
  }
}

function absent(file, label) {
  try { fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  throw new Error(`${label} already exists; initialization never overwrites or migrates existing state`)
}

function assertFirstInstall(stateDir, file) {
  assertPrivateDirectory(stateDir)
  for (const name of ['state.json', 'pending-turns.json', 'engine-receipts.json']) {
    absent(path.join(stateDir, name), name)
  }
  absent(path.join(stateDir, MANIFEST), 'Group journal mapping')
  absent(file, 'Journal')
  // An independently named journal must not make existing authority disappear.
  if (fs.readdirSync(stateDir).some(name => /^c2-v2.*\.log$/.test(name))) {
    throw new Error('An existing journal requires review; initialization cannot replace its authority')
  }
}

function initializeInstallation(explicitConfig, options) {
  const installation = loadInstallation(explicitConfig, options)
  const { stateDir, file, routes, manifestFile, manifest } = installation
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  assertFirstInstall(stateDir, file)
  const lockFile = path.join(stateDir, 'daemon.lock')
  // Unlike normal start, initialization refuses even stale locks.
  absent(lockFile, 'Service lock')
  let fd
  let ownsLock = false
  try {
    fd = fs.openSync(lockFile, 'wx', 0o600)
    ownsLock = true
    fs.writeSync(fd, String(process.pid))
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    assertFirstInstall(stateDir, file)
    fs.chmodSync(stateDir, 0o700)
    for (const route of routes) {
      C2DurableJournal.initialize(route.file, {
        state: { version: 2, seq: 0, lanes: {} },
        receipts: { pending: [], completed: [] },
      }, VALIDATORS)
      const journal = C2DurableJournal.open(route.file, VALIDATORS)
      const snapshot = assertJournalScope(journal, route.chatId, { requireSettled: true })
      if (journal.blocked || snapshot.cursor !== 0 || snapshot.eventCount !== 0 ||
          snapshot.receipts.pending.length || snapshot.receipts.completed.length ||
          snapshot.effects.size || snapshot.notices.size || Object.keys(snapshot.state.lanes).length) {
        throw new Error('New journal verification failed; preserve the file for review')
      }
    }
    // Last write commits the complete mapping. A partial initialization is
    // deliberately preserved and rejected, never silently retried or erased.
    const mappingFd = fs.openSync(manifestFile, 'wx', 0o600)
    try { fs.writeSync(mappingFd, JSON.stringify(manifest, null, 2) + '\n'); fs.fsyncSync(mappingFd) }
    finally { fs.closeSync(mappingFd) }

    return file
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (ownsLock) {
      try {
        if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockFile)
      } catch { /* Do not remove a lock that no longer belongs to this operation. */ }
    }
  }
}

// Start-time registration of groups added to the configuration: each gets an
// empty verified journal, then the mapping is extended in one replacement.
// Existing journals are never touched; a group with legacy history is refused.
function registerAddedGroups(installation) {
  const { stateDir, addedRoutes = [], manifestFile, manifest } = installation
  if (!addedRoutes.length) return []
  const { assertNoLegacyGroupState } = require('./c2migration')
  for (const route of addedRoutes) assertNoLegacyGroupState({ stateDir, chatId: route.chatId })
  for (const route of addedRoutes) {
    absent(route.file, 'Journal for a newly added group')
    C2DurableJournal.initialize(route.file, {
      state: { version: 2, seq: 0, lanes: {} }, receipts: { pending: [], completed: [] },
    }, VALIDATORS)
    const journal = C2DurableJournal.open(route.file, VALIDATORS)
    const snapshot = assertJournalScope(journal, route.chatId, { requireSettled: true })
    if (journal.blocked || snapshot.cursor !== 0 || snapshot.eventCount !== 0) {
      throw new Error('New group journal verification failed; preserve the file for review')
    }
  }
  const { atomicWriteJSON } = require('./core/store')
  atomicWriteJSON(manifestFile, manifest, { mode: 0o600 })
  installation.addedRoutes = []
  return addedRoutes.map(route => route.chatId)
}

module.exports = { registerAddedGroups, loadInstallation, loadInstallationFromRaw, initializeInstallation, installationStateDir, assertPrivateDirectory,
  assertJournalScope, assertInstallationJournals, assertRunnerExecutable, SUPPORTED_RUNNERS, MANIFEST,
  VALIDATORS }
