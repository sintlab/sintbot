'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { atomicWriteJSON } = require('./core/store')
const { loadInstallationFromRaw, assertJournalScope, assertRunnerExecutable,
  MANIFEST, VALIDATORS, SUPPORTED_RUNNERS } = require('./c2install')
const { C2DurableJournal } = require('./core/c2durablejournal')
const { assertNoLegacyGroupState } = require('./c2migration')

const GLOBAL_TASK_KEYS = ['agent', 'timezone', 'brand']
const RESET_KEYS = ['provider', 'model', 'workdir', 'codexApp']
const EFFORT_ENV = 'CLAUDE_CODE_EFFORT_LEVEL'

// What a group's session belongs to: backend, executable, endpoint, model and
// the environment the backend starts with. Effort, reasoning effort, tool
// quality, key, image support, visibility and order apply from the next turn.
function sessionIdentity(provider, group) {
  if (!provider || typeof provider !== 'object') return null
  const env = { ...(provider.env && typeof provider.env === 'object' ? provider.env : {}) }
  delete env[EFFORT_ENV]
  return { runner: provider.runner, bin: provider.bin || '', baseUrl: provider.baseUrl || '',
    model: group?.model || provider.model || '', env }
}

// Synchronous validation/application around one atomic configuration write.
// A group-scoped edit waits only for that group to settle. Changing a group's
// model, project or backend clears its session before the new configuration
// is written, so no later turn can resume a session from another backend.
// It never moves a journal, settles a receipt or reconnects the platform.
function createC2ConfigControl({ installation, getBindings, getHeld = () => new Map(),
  assertWriterLock, store = null, activateRoute = null, probeRunner = assertRunnerExecutable,
  isFrozen = () => false, log = () => {} } = {}) {
  if (!installation?.cfg?._path || typeof getBindings !== 'function' ||
      typeof getHeld !== 'function' || typeof isFrozen !== 'function' ||
      typeof assertWriterLock !== 'function' ||
      store !== null && typeof store.resetGroupSession !== 'function' ||
      activateRoute !== null && typeof activateRoute !== 'function' ||
      typeof probeRunner !== 'function') {
    throw new TypeError('Configuration control needs live installation authority')
  }
  const { cfg, routes, stateDir } = installation
  let prepared = null
  let appliedResets = []

  function held() {
    if (assertWriterLock() !== true) throw new Error('Service writer authority is unavailable')
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
    const next = loadInstallationFromRaw(raw, cfg._path, { dataDir: stateDir,
      allowAddedGroups: !!activateRoute && !!store })
    const bindings = getBindings()
    const current = new Set(routes.map(route => route.chatId))
    if (routes.some(route => !next.routes.some(item => item.chatId === route.chatId))) {
      throw new Error('Removing a configured group requires a stopped migration')
    }
    const added = next.routes.filter(route => !current.has(route.chatId))
    if (added.length && (!activateRoute || !store)) {
      throw new Error('Adding a group requires a service that can open it online')
    }
    const connectionOnly = value => {
      const copy = { ...value }
      delete copy.admins; delete copy.adminOpenId; delete copy.adminName
      return copy
    }
    if (!isDeepStrictEqual(connectionOnly(cfg.feishu), connectionOnly(next.cfg.feishu))) {
      throw new Error('Connection settings require a service restart')
    }
    for (const key of ['wecom', 'slack', 'proxy', 'projectsRoots', 'browser']) {
      if (!isDeepStrictEqual(cfg[key], next.cfg[key])) throw new Error('Connection and filesystem settings require a service restart')
    }
    if (cfg.agent.maxConcurrent !== next.cfg.agent.maxConcurrent) {
      throw new Error('Changing global concurrency requires a service restart')
    }
    // The model a group runs: a runtime override first (as the engine
    // resolves it), then the group's own provider, then the default.
    const sessions = chatId => store || bindings.get(chatId)?.engine?.store || null
    const effective = (chatId, group, config) =>
      sessions(chatId)?.getProvider?.(chatId) || group.provider || config.defaultProvider
    assertProviderEdits(next, effective)
    const resets = [], activations = [], changed = [], moved = []
    const heldGroups = getHeld()
    for (const route of routes) {
      const target = next.routes.find(item => item.chatId === route.chatId)
      if (route.group.platform !== target.group.platform) {
        throw new Error('Moving a group to another platform requires an explicit state migration')
      }
      // A model library or default change reaches every group that runs
      // the edited provider, even though its own settings stay the same.
      const providerMoved = !isDeepStrictEqual(
        sessionIdentity(cfg.providers?.[effective(route.chatId, route.group, cfg)], route.group),
        sessionIdentity(next.cfg.providers?.[effective(route.chatId, target.group, next.cfg)], target.group))
      if (heldGroups.has(route.chatId)) {
        // Edits elsewhere proceed; the held group keeps its exact settings.
        if (!isDeepStrictEqual(route.group, target.group)) {
          throw new Error('This group is held after an unresolved fault; seal its incident and restart before changing it')
        }
        if (providerMoved) {
          throw new Error('有群因未解决的故障暂停处理，它用的模型、后端或端点要等处理完并重启后才能改')
        }
        continue
      }
      if (!isDeepStrictEqual(route.group, target.group)) changed.push(route.chatId)
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
    const global = GLOBAL_TASK_KEYS.some(key => !isDeepStrictEqual(cfg[key], next.cfg[key]))
    for (const [chatId, binding] of bindings) {
      if (global || changed.includes(chatId)) assertSettled(chatId, binding)
      else if (moved.includes(chatId)) {
        const name = next.cfg.groups?.[chatId]?.name || chatId.slice(-8)
        assertSettled(chatId, binding,
          `「${name}」有任务进行中或记录未结账，等它结束后再改它用的模型、后端或端点`)
      }
    }
    prepared = { raw: JSON.stringify(raw), next, resets, activations, added }
    return true
  }

  // Runs after validation and before the configuration file is replaced.
  // Every step is idempotent or fails closed; a crash leaves either the old
  // configuration with a fresh session, or a mapped empty journal for review.
  function beforeWrite(raw) {
    held()
    if (!prepared || prepared.raw !== JSON.stringify(raw)) {
      throw new Error('Configuration was not validated against the current service')
    }
    for (const chatId of prepared.resets) store.resetGroupSession(chatId)
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
    const { next, activations, added, resets } = prepared
    const global = GLOBAL_TASK_KEYS.some(key => !isDeepStrictEqual(cfg[key], next.cfg[key]))
    // Every engine copies the model library at construction and reads it
    // when a turn starts: a library edit must reach all of them, including
    // busy ones (their running turn keeps the settings it started with).
    const library = !isDeepStrictEqual(cfg.providers, next.cfg.providers) ||
      cfg.defaultProvider !== next.cfg.defaultProvider
    prepared = null
    appliedResets = [...resets]
    for (const key of Object.keys(cfg)) delete cfg[key]
    Object.assign(cfg, next.cfg)
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
    for (const route of [...routes.filter(item => activations.includes(item.chatId)),
      ...added.filter(item => !item.paused)]) {
      // Opening runs the group's normal recovery gate. Until it finishes the
      // service ignores that group's messages instead of admitting receipts.
      Promise.resolve().then(() => activateRoute(route)).catch(error => {
        log(`group ${route.chatId}: online activation failed: ${error?.message || String(error)}`)
      })
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

  function switchGroupProvider(chatId, name) {
    return writeConfig(raw => {
      const group = raw.groups?.[chatId]
      if (!group) throw new Error('Unknown group')
      if (!cfg.providers?.[name]) throw new Error('Unknown model')
      group.provider = name
      // A pinned model id belongs to the previous provider.
      delete group.model
    })
  }

  return { validateConfig, beforeWrite, applyConfig, writeConfig, switchGroupProvider,
    // Groups whose session the last applied write reset (for the console).
    appliedResets: () => [...appliedResets] }
}

module.exports = { createC2ConfigControl }
