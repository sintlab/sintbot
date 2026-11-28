'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { atomicWriteJSON } = require('./core/store')
const { loadInstallationFromRaw, assertJournalScope, assertRunnerExecutable,
  MANIFEST, RETIRED, RETIRED_DIR, readRetired, VALIDATORS, SUPPORTED_RUNNERS } = require('./c2install')
const { C2DurableJournal } = require('./core/c2durablejournal')
const { assertNoLegacyGroupState } = require('./c2migration')
const { applyBrainChange } = require('./groupbrain')
const { platformsConfigured } = require('./config')

const GLOBAL_TASK_KEYS = ['agent', 'timezone', 'brand']
// The concurrency cap is read at start only, so saving a new one changes no
// running turn and need not wait for any of them.
const taskSetting = (config, key) => key === 'agent' && config.agent
  ? (({ maxConcurrent, ...rest }) => rest)(config.agent) : config[key]
const globalTaskChanged = (a, b) => GLOBAL_TASK_KEYS.some(key => !isDeepStrictEqual(taskSetting(a, key), taskSetting(b, key)))
// A group's model and depth (providerPrefs, legacy model) are not here: the
// executors resume the same session with another model of the same backend.
const RESET_KEYS = ['provider', 'workdir', 'codexApp']
const EFFORT_ENV = 'CLAUDE_CODE_EFFORT_LEVEL'

// What a group's session belongs to: backend, executable, endpoint and the
// environment the backend starts with. Model, depth, tool quality, key, image
// support, visibility and order apply from the next turn in the same session:
// both executors resume a session with another model of the same backend.
function sessionIdentity(provider) {
  if (!provider || typeof provider !== 'object') return null
  const env = { ...(provider.env && typeof provider.env === 'object' ? provider.env : {}) }
  delete env[EFFORT_ENV]
  delete env.ANTHROPIC_MODEL
  return { runner: provider.runner, bin: provider.bin || '', baseUrl: provider.baseUrl || '', env }
}

// Synchronous validation/application around one atomic configuration write.
// A group-scoped edit waits only for that group to settle. Changing a group's
// model, project or backend clears its session before the new configuration
// is written, so no later turn can resume a session from another backend.
// It never settles a receipt or reconnects the platform. Removing a group
// closes its binding and archives its journal unchanged (retired/, listed in
// c2-retired.json); a held group may be removed once its turn has closed.
function createC2ConfigControl({ installation, getBindings, getHeld = () => new Map(),
  assertWriterLock, store = null, activateRoute = null, deactivateRoute = null, removalBlocked = null,
  probeRunner = assertRunnerExecutable,
  isFrozen = () => false, validateConnectionAddition = null, activateConnection = null,
  onApplied = null, log = () => {}, env = process.env } = {}) {
  if (!installation?.cfg?._path || typeof getBindings !== 'function' ||
      typeof getHeld !== 'function' || typeof isFrozen !== 'function' ||
      typeof assertWriterLock !== 'function' ||
      store !== null && typeof store.resetGroupSession !== 'function' ||
      activateRoute !== null && typeof activateRoute !== 'function' ||
      deactivateRoute !== null && typeof deactivateRoute !== 'function' ||
      removalBlocked !== null && typeof removalBlocked !== 'function' ||
      typeof probeRunner !== 'function') {
    throw new TypeError('Configuration control needs live installation authority')
  }
  const { cfg, routes, stateDir } = installation
  let prepared = null
  let appliedResets = []

  function held() {
    if (assertWriterLock() !== true) throw new Error('Service writer authority is unavailable')
  }
  // The group as the settled gate sees it: everything but the per-backend
  // speed and the language of the bot's own words (src/chatlang.js). Neither
  // touches the session; each is read again for the next message.
  function taskView(group) {
    if (!group || typeof group !== 'object') return group
    const view = { ...group }
    delete view.lang
    if (!group.providerPrefs || typeof group.providerPrefs !== 'object') return view
    const prefs = {}
    for (const [name, pref] of Object.entries(group.providerPrefs)) {
      if (!pref || typeof pref !== 'object') { prefs[name] = pref; continue }
      const { speed, ...rest } = pref
      if (Object.keys(rest).length) prefs[name] = rest
    }
    delete view.providerPrefs
    if (Object.keys(prefs).length) view.providerPrefs = prefs
    return view
  }
  function assertSettled(chatId, binding,
    message = 'Wait until the group task is settled before changing its task settings') {
    if (!binding) return
    if (binding.gate.blocked || binding.runtime.blocked ||
        [...binding.engine.rts.values()].some(rt => rt.v2NormalRouteActive ||
          rt.v2AdmissionPending || rt.v2Controller || rt.v2QueueReceiptIds?.length)) {
      throw new Error(message)
    }
    assertJournalScope(binding.journal, chatId, { requireSettled: true })
  }

  // Model library edits. A provider that is added or edited must be one the
  // durable route can run; the default must stay a visible runnable model;
  // a provider still used by an active group or as the default stays listed.
  function assertProviderEdits(next, effective) {
    const before = cfg.providers || {}, after = next.cfg.providers || {}
    for (const [name, provider] of Object.entries(after)) {
      if (isDeepStrictEqual(before[name], provider)) continue
      if (!provider || typeof provider !== 'object' || !SUPPORTED_RUNNERS.includes(provider.runner)) {
        throw new Error(`模型「${name}」的后端不受支持；只能添加或修改 Codex 或 Claude Code 模型`)
      }
    }
    if (cfg.defaultProvider !== next.cfg.defaultProvider) {
      const chosen = after[next.cfg.defaultProvider]
      if (!chosen || typeof chosen !== 'object' || chosen.hidden ||
          !SUPPORTED_RUNNERS.includes(chosen.runner)) {
        throw new Error('默认模型须是列表中未隐藏的 Codex 或 Claude Code 模型')
      }
    }
    for (const [name, provider] of Object.entries(before)) {
      if (!provider || provider.hidden || (after[name] && !after[name].hidden)) continue
      const action = after[name] ? '隐藏' : '移除'
      if (name === cfg.defaultProvider) {
        throw new Error(`「${name}」是默认模型，先把默认模型换成别的再${action}`)
      }
      const users = next.routes.filter(route => !route.paused &&
        effective(route.chatId, route.group, next.cfg) === name).length
      if (users) throw new Error(`「${name}」正被 ${users} 个群使用，先把这些群切到其它模型再${action}`)
    }
  }

  function validateConfig(raw) {
    prepared = null
    appliedResets = []
    held()
    if (isFrozen()) throw new Error('SintBot is upgrading; settings cannot change until it restarts')
    const bindings = getBindings()
    const heldGroups = getHeld()
    const nextIds = new Set(Object.keys(raw?.groups && typeof raw.groups === 'object' ? raw.groups : {}))
    const removed = routes.filter(route => !nextIds.has(route.chatId))
    if (removed.length) {
      if (!deactivateRoute) throw new Error('Removing a configured group requires a stopped migration')
      const left = [...nextIds].map(chatId => raw.groups[chatId])
      if (!left.some(group => group && group.paused !== true)) {
        throw new Error('至少要保留一个在用的群项目；要移除最后一个，先添加一个新的群项目')
      }
      for (const route of removed) assertRemovable(route, bindings, heldGroups)
    }
    const next = loadInstallationFromRaw(raw, cfg._path, { dataDir: stateDir,
      allowAddedGroups: !!activateRoute && !!store, retiring: removed.map(route => route.chatId) })
    const current = new Set(routes.map(route => route.chatId))
    const added = next.routes.filter(route => !current.has(route.chatId))
    if (added.length && (!activateRoute || !store)) {
      throw new Error('Adding a group requires a service that can open it online')
    }
    const connectionOnly = value => {
      const copy = { ...value }
      delete copy.admins; delete copy.adminOpenId; delete copy.adminName
      return copy
    }
    // Feishu, WeCom or Slack may be added online, and only as the exact
    // configuration its attach flow has just proven (an installation without
    // that platform yet); any other change to its block needs a restart.
    const connectionAdded = []
    if (!isDeepStrictEqual(connectionOnly(cfg.feishu), connectionOnly(next.cfg.feishu))) {
      if (platformsConfigured(cfg).feishu || typeof validateConnectionAddition !== 'function' ||
          typeof activateConnection !== 'function' || validateConnectionAddition(cfg, next.cfg, 'feishu') !== true) {
        throw new Error('Connection settings require a service restart')
      }
      connectionAdded.push('feishu')
    }
    for (const name of ['wecom', 'slack']) {
      if (isDeepStrictEqual(cfg[name], next.cfg[name])) continue
      if (typeof validateConnectionAddition !== 'function' || typeof activateConnection !== 'function' ||
          validateConnectionAddition(cfg, next.cfg, name) !== true) throw new Error('Connection settings require a service restart')
      connectionAdded.push(name)
    }
    // The proxy is read once, at start: a change is saved for the next start
    // and this process keeps going out the way it does now. (A Slack attach
    // saves the proxy this process already uses; the console's network
    // setting saves any other, and offers a restart.)
    for (const key of ['projectsRoots', 'browser']) {
      if (!isDeepStrictEqual(cfg[key], next.cfg[key])) throw new Error('Connection and filesystem settings require a service restart')
    }
    // Global concurrency is fixed for the life of the process (the shared
    // capacity is built once at start). A new value is saved for the next
    // start; the running capacity and every queued receipt stay as they are.
    // The model a group runs: a runtime override first (as the engine
    // resolves it), then the group's own provider, then the default.
    const sessions = chatId => store || bindings.get(chatId)?.engine?.store || null
    const effective = (chatId, group, config) =>
      sessions(chatId)?.getProvider?.(chatId) || group.provider || config.defaultProvider
    assertProviderEdits(next, effective)
    const resets = [], activations = [], changed = [], moved = []
    for (const route of routes) {
      const target = next.routes.find(item => item.chatId === route.chatId)
      if (!target) continue   // being removed (checked above)
      if (route.group.platform !== target.group.platform) {
        throw new Error('Moving a group to another platform requires an explicit state migration')
      }
      // A model library or default change reaches every group that runs
      // the edited provider, even though its own settings stay the same.
      const providerMoved = !isDeepStrictEqual(
        sessionIdentity(cfg.providers?.[effective(route.chatId, route.group, cfg)]),
        sessionIdentity(next.cfg.providers?.[effective(route.chatId, target.group, next.cfg)]))
      if (heldGroups.has(route.chatId)) {
        // Edits elsewhere proceed; the held group keeps its exact settings,
        // except the language of the bot's own words: the notice that says
        // the conversation is held is itself said in that language.
        const sansLang = group => { const view = { ...group }; delete view.lang; return view }
        if (!isDeepStrictEqual(sansLang(route.group), sansLang(target.group))) {
          throw new Error('This group is held after an unresolved fault; seal its incident and restart before changing it')
        }
        if (providerMoved) {
          throw new Error('有群因未解决的故障暂停处理，它用的模型、后端或端点要等处理完并重启后才能改')
        }
        continue
      }
      // Speed is read at the start of each turn and never touches the
      // session, so a speed-only edit does not wait for a running turn.
      if (!isDeepStrictEqual(taskView(route.group), taskView(target.group))) changed.push(route.chatId)
      const groupReset = RESET_KEYS.some(key => !isDeepStrictEqual(route.group[key], target.group[key]))
      if (groupReset || providerMoved) {
        if (!store) throw new Error('Changing model or project requires session reset authority')
        resets.push(route.chatId)
        if (!groupReset) moved.push(route.chatId)
        // A reset also clears any runtime override: the group then runs
        // its configured provider, which is the one probed here.
        if (!target.paused) probeRunner(target.provider, next.cfg)
      }
      if (!bindings.has(route.chatId)) {
        // Only a route paused since startup lacks a binding once serving.
        if (!route.paused) throw new Error('The group is not open yet; wait for the service to finish starting')
        if (!target.paused) {
          if (!activateRoute) throw new Error('An initially paused group must be activated during a service restart')
          activations.push(route.chatId)
          probeRunner(target.provider, next.cfg)
        }
      }
    }
    for (const route of added) {
      assertNoLegacyGroupState({ stateDir, chatId: route.chatId })
      if (fs.existsSync(route.file)) {
        throw new Error('A journal already exists for the new group; preserve it and review it before binding')
      }
      if (!route.paused) probeRunner(route.provider, next.cfg)
    }
    // Global task settings affect every group; a group edit affects only that
    // group. Authentication/profile-only edits never wait for running turns.
    const global = globalTaskChanged(cfg, next.cfg)
    for (const [chatId, binding] of bindings) {
      if (!nextIds.has(chatId)) continue
      if (global || changed.includes(chatId)) assertSettled(chatId, binding)
      else if (moved.includes(chatId)) {
        const name = next.cfg.groups?.[chatId]?.name || chatId.slice(-8)
        assertSettled(chatId, binding,
          `「${name}」有任务进行中或记录未结账，等它结束后再改它用的模型、后端或端点`)
      }
    }
    prepared = { raw: JSON.stringify(raw), next, resets, activations, added, connectionAdded, removed, retired: [] }
    return true
  }
  // A group may be removed when nothing of it is running or waiting. Its
  // records must be settled, unless it is held: a held group's unresolved
  // turn is archived with its journal, never replayed or settled here.
  function assertRemovable(route, bindings, heldGroups) {
    const name = route.group?.name || route.chatId.slice(-8)
    const blocked = removalBlocked ? removalBlocked(route.chatId) : null
    if (blocked === 'busy') throw new Error(`「${name}」还有任务在进行，等它结束后再移除`)
    if (blocked === 'opening') throw new Error(`「${name}」正在打开或恢复，稍后再移除`)
    if (blocked) throw new Error('服务正在启动、升级或停止，稍后再移除群项目')
    const binding = bindings.get(route.chatId)
    if (binding && !heldGroups.has(route.chatId)) {
      assertSettled(route.chatId, binding, `「${name}」有任务进行中或记录未结账，等它结束后再移除`)
    }
  }

  // Runs after validation and before the configuration file is replaced.
  // Every step is idempotent or fails closed; a crash leaves either the old
  // configuration with a fresh session, or a mapped empty journal for review.
  function beforeWrite(raw) {
    held()
    if (!prepared || prepared.raw !== JSON.stringify(raw)) {
      throw new Error('Configuration was not validated against the current service')
    }
    const bindings = getBindings()
    // Stop every affected compactor before mutating any session or file.
    let stopping = false
    for (const chatId of prepared.resets) {
      if (bindings.get(chatId)?.engine?.stopIdleCompact?.(chatId, '会话已重置')) stopping = true
    }
    for (const route of prepared.removed) {
      if (bindings.get(route.chatId)?.engine?.stopIdleCompact?.(route.chatId, '群项目已移除')) stopping = true
    }
    if (stopping) throw new Error('正在停止会话整理，请稍后再保存设置')
    for (const chatId of prepared.resets) store.resetGroupSession(chatId)
    if (prepared.removed.length) {
      // The ledger first: once the configuration no longer has these chats,
      // their mapping entries and journals are retired even if this process
      // stops before it archives them (src/c2install.js readRetired).
      const stamp = new Date().toISOString().replace(/[:.]/g, '')
      const entries = prepared.removed.map(route => ({ chatId: route.chatId, journal: path.basename(route.file),
        archive: `${RETIRED_DIR}/${path.basename(route.file)}.${stamp}`, at: Date.now() }))
      atomicWriteJSON(path.join(stateDir, RETIRED), { version: 1, groups: [...readRetired(stateDir), ...entries] }, { mode: 0o600 })
      prepared.retired = entries
      // A chat bound again later starts a new conversation.
      for (const route of prepared.removed) store?.resetGroupSession?.(route.chatId)
    }
    if (prepared.added.length) {
      for (const route of prepared.added) {
        C2DurableJournal.initialize(route.file, {
          state: { version: 2, seq: 0, lanes: {} },
          receipts: { pending: [], completed: [] },
        }, VALIDATORS)
        const journal = C2DurableJournal.open(route.file, VALIDATORS)
        const snapshot = assertJournalScope(journal, route.chatId, { requireSettled: true })
        if (journal.blocked || snapshot.cursor !== 0 || snapshot.eventCount !== 0) {
          throw new Error('New group journal verification failed; preserve the file for review')
        }
      }
      const manifestFile = path.join(stateDir, MANIFEST)
      const persisted = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      const manifest = { version: 1,
        groups: prepared.next.routes.map(({ chatId, file }) => ({ chatId, journal: path.basename(file) })) }
      if (persisted.migrationSha256 !== undefined) manifest.migrationSha256 = persisted.migrationSha256
      atomicWriteJSON(manifestFile, manifest, { mode: 0o600 })
    }
    return true
  }

  function applyConfig(raw) {
    if (assertWriterLock() !== true || !prepared || prepared.raw !== JSON.stringify(raw)) {
      throw new Error('Configuration was not validated against the current service')
    }
    const { next, activations, added, resets, connectionAdded, removed, retired } = prepared
    const global = globalTaskChanged(cfg, next.cfg)
    // Every engine copies the model library at construction and reads it
    // when a turn starts: a library edit must reach all of them, including
    // busy ones (their running turn keeps the settings it started with).
    const library = !isDeepStrictEqual(cfg.providers, next.cfg.providers) ||
      cfg.defaultProvider !== next.cfg.defaultProvider
    prepared = null
    appliedResets = [...resets]
    for (const key of Object.keys(cfg)) delete cfg[key]
    Object.assign(cfg, next.cfg)
    // Removed groups: close the binding, drop the route, then rewrite the
    // mapping and archive each journal. Validation ran in this same tick, so
    // the group is still idle; a failed file step is completed by the ledger.
    for (const route of removed) {
      try { deactivateRoute(route.chatId) } catch (error) {
        log(`group ${route.chatId}: closing the removed group failed: ${error?.message || String(error)}`)
      }
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
    if (removed.length) {
      try {
        const manifestFile = path.join(stateDir, MANIFEST)
        const persisted = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {}
        const manifest = { version: 1,
          groups: next.routes.map(({ chatId, file }) => ({ chatId, journal: path.basename(file) })) }
        if (persisted.migrationSha256 !== undefined) manifest.migrationSha256 = persisted.migrationSha256
        atomicWriteJSON(manifestFile, manifest, { mode: 0o600 })
      } catch (error) { log(`removed groups: mapping not rewritten yet: ${error?.message || String(error)}`) }
      for (const entry of retired) {
        try {
          fs.mkdirSync(path.join(stateDir, RETIRED_DIR), { recursive: true, mode: 0o700 })
          const from = path.join(stateDir, entry.journal)
          if (fs.existsSync(from)) fs.renameSync(from, path.join(stateDir, entry.archive))
        } catch (error) { log(`group ${entry.chatId}: journal not archived yet: ${error?.message || String(error)}`) }
      }
    }
    const bindings = getBindings()
    for (const route of routes) {
      const target = next.routes.find(item => item.chatId === route.chatId)
      const groupChanged = !isDeepStrictEqual(route.group, target.group)
      Object.assign(route, target)
      const engine = bindings.get(route.chatId)?.engine
      if (engine && (global || groupChanged || library)) {
        engine.cfg = { ...cfg, groups: { [route.chatId]: route.group } }
        engine.tz = cfg.timezone
      }
    }
    for (const route of added) routes.push(route)
    routes.sort((a, b) => a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0)
    const connectionReady = connectionAdded.length ? Promise.resolve().then(() => activateConnection(cfg, connectionAdded)) : Promise.resolve()
    connectionReady.catch(error => log(`connection activation failed: ${error?.message || String(error)}`))
    for (const route of [...routes.filter(item => activations.includes(item.chatId)),
      ...added.filter(item => !item.paused)]) {
      // Opening runs the group's normal recovery gate. Until it finishes the
      // service ignores that group's messages instead of admitting receipts.
      connectionReady.then(() => activateRoute(route)).catch(error => {
        log(`group ${route.chatId}: online activation failed: ${error?.message || String(error)}`)
      })
    }
    // The service now runs this configuration (console, chat command and
    // attach flows all end here). An observer cannot undo the change.
    if (typeof onApplied === 'function') {
      try { onApplied() } catch (error) { log(`after configuration change: ${error?.message || String(error)}`) }
    }
    return true
  }

  // One writer for the console and chat commands: read the file, change it,
  // validate, reset affected sessions, replace atomically, then go live.
  function writeConfig(mutate) {
    held()
    if (typeof mutate !== 'function') throw new TypeError('Configuration change needs a mutation')
    const raw = JSON.parse(fs.readFileSync(cfg._path, 'utf8'))
    mutate(raw)
    validateConfig(raw)
    beforeWrite(raw)
    atomicWriteJSON(cfg._path, raw, { mode: 0o600 })
    applyConfig(raw)
    return raw
  }

  // Backend · model · depth of one group (console, /model, model card). The
  // writer validates, resets the session only when the backend changes, and
  // goes live. Returns the change summary; throws on refusal.
  function setGroupBrain(chatId, change = {}) {
    let summary = null
    writeConfig(raw => {
      if (!raw.groups?.[chatId]) throw new Error('Unknown group')
      const result = applyBrainChange(raw, chatId, change)
      if (result.error) throw new Error({ 'unknown-provider': 'Unknown model',
        'bad-model': 'Invalid model id', 'bad-effort': 'Invalid thinking depth' }[result.error] || 'Unknown group')
      summary = result
    })
    return summary
  }
  function switchGroupProvider(chatId, name) {
    return setGroupBrain(chatId, { provider: name })
  }

  return { validateConfig, beforeWrite, applyConfig, writeConfig, switchGroupProvider, setGroupBrain,
    // Groups whose session the last applied write reset (for the console).
    appliedResets: () => [...appliedResets] }
}

module.exports = { createC2ConfigControl, sessionIdentity, RESET_KEYS, GLOBAL_TASK_KEYS }
