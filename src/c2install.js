'use strict'

// First-install filesystem preparation only. Existing authorities and legacy
// state are never adopted, cleared, migrated or replayed by this entry.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadConfig, platformsConfigured } = require('./config')
const { C2DurableJournal } = require('./core/c2durablejournal')
const { validatePersistentState } = require('./core/c2persiststate')
const { validatePersistentReceipts, validatePersistentRelation } = require('./core/c2persistrelation')
const VALIDATORS = { validateState: validatePersistentState,
  validateReceipts: validatePersistentReceipts, validateRelation: validatePersistentRelation }

function loadInstallation(explicitConfig) {
  const stateDir = path.join(os.homedir(), '.sbot')
  const file = process.env.SBOT_C2_V2_JOURNAL || path.join(stateDir, 'c2-v2.log')
  if (!path.isAbsolute(file) || file !== path.resolve(file) ||
      path.dirname(file) !== stateDir || !/^c2-v2(?:[._-][a-zA-Z0-9._-]+)?\.log$/.test(path.basename(file))) {
    throw new Error('The journal must be a c2-v2*.log file directly in the installation state directory')
  }
  const configFile = explicitConfig || process.env.SBOT_CONFIG || path.join(stateDir, 'config.json')
  if (!path.isAbsolute(configFile) || !fs.existsSync(configFile)) {
    throw new Error('An existing configuration file with an absolute path is required')
  }
  const cfg = loadConfig(configFile)
  const configured = platformsConfigured(cfg)
  const groups = Object.entries(cfg.groups || {})
  if (groups.length !== 1) throw new Error('This release requires exactly one explicit Feishu group')
  const [serviceChatId, group] = groups[0]
  const provider = cfg.providers?.[group?.provider || cfg.defaultProvider]
  if (path.resolve(cfg._path || '') !== path.resolve(configFile) ||
      !configured.feishu || configured.wecom || configured.slack || cfg.wecom || cfg.slack ||
      (cfg._groupPlatform?.inferred || []).length ||
      !/^oc_[A-Za-z0-9_-]{1,124}$/.test(serviceChatId) || !group ||
      group.platform !== 'feishu' || group.paused || group.board ||
      group.crons && (!Array.isArray(group.crons) || group.crons.length) ||
      provider?.runner !== 'codex' || group.codexSteer !== false || group.codexApp === true ||
      cfg.alerts?.chatId || cfg.ui && cfg.ui.enabled !== false) {
    throw new Error('This release accepts one explicit Feishu Codex message route, with codexSteer:false and without canvas, scheduled tasks, console or synthetic sources')
  }
  if (cfg.feishu.onlyWhenMentioned === true &&
      !/^ou_[a-zA-Z0-9_-]+$/.test(cfg.feishu.botOpenId || '')) {
    throw new Error('Mention-only messages require the Feishu botOpenId; otherwise set onlyWhenMentioned:false for the dedicated group')
  }
  if (typeof group.workdir !== 'string' || !path.isAbsolute(group.workdir) ||
      !fs.existsSync(group.workdir) || !fs.statSync(group.workdir).isDirectory()) {
    throw new Error('The group workdir must be an existing absolute project directory')
  }
  return { stateDir, file, cfg, groups, serviceChatId, provider }
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
  absent(file, 'Journal')
  // An independently named journal must not make existing authority disappear.
  if (fs.readdirSync(stateDir).some(name => /^c2-v2.*\.log$/.test(name))) {
    throw new Error('An existing journal requires review; initialization cannot replace its authority')
  }
}

function initializeInstallation(explicitConfig) {
  const { stateDir, file } = loadInstallation(explicitConfig)
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
    C2DurableJournal.initialize(file, {
      state: { version: 2, seq: 0, lanes: {} },
      receipts: { pending: [], completed: [] },
    }, VALIDATORS)
    const journal = C2DurableJournal.open(file, VALIDATORS)
    const snapshot = journal.snapshot()
    if (journal.blocked || snapshot.cursor !== 0 || snapshot.eventCount !== 0 ||
        snapshot.receipts.pending.length || snapshot.receipts.completed.length ||
        snapshot.effects.size || snapshot.notices.size || Object.keys(snapshot.state.lanes).length) {
      throw new Error('New journal verification failed; preserve the file for review')
    }
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

module.exports = { loadInstallation, initializeInstallation, assertPrivateDirectory }
