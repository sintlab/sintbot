'use strict'

const path = require('node:path')
const { createUiServer } = require('./ui/serverbase')
const { START_PATH, CALLBACK_PATH } = require('./ui/feishulogin')
const { assertJournalScope } = require('./c2install')
const { createDurableConsoleSay } = require('./consolesay')
const { isLocalChatId, LocalChatError } = require('./platform/local')
const { taskId } = require('./core/enginecheckpoint')

// A host facade over existing v2 authorities, not a second execution engine.
// The allowlist applies after the existing console's authentication boundary.
const READ_PATHS = ['/api/state', '/api/events', '/api/inbox', '/api/activity', '/api/activity/detail',
  '/api/changelog', '/api/changelog-en', '/api/codex/models', '/api/usage',
  '/api/plugins', '/api/design/styles', '/api/design/icons', '/api/fs/listdir',
  '/api/feishu/admin-candidates', '/api/feishu/org-users', '/api/feishu/resolve-contact',
  '/api/feishu/chats', '/api/feishu/chat-members', '/api/update', '/api/claude/models',
  '/api/groups/model-options',
  // The console's own conversations (src/platform/local.js).
  '/api/local/history',
  // Counts only, for the desktop shell: also answered to a loopback request
  // without credentials (see serverbase).
  '/api/shell/activity',
  START_PATH, CALLBACK_PATH]
const WRITE_PATHS = ['/api/login', '/api/logout', '/api/logout/all',
  '/api/ui/network', '/api/ui/public-url', '/api/ui/update-settings', '/api/feishu/admins',
  '/api/groups', '/api/groups/provider', '/api/groups/brain', '/api/fs/mkdir',
  '/api/groups/order', '/api/groups/policy', '/api/groups/redact',
  '/api/groups/codex-steer', '/api/groups/steer', '/api/groups/pause', '/api/groups/stop',
  // A fresh session only for an idle, settled group (same rule as /new).
  '/api/groups/new', '/api/groups/interrupt',
  '/api/agent', '/api/provider-settings', '/api/codex/verify', '/api/usage/refresh',
  // The model library goes through the same validated writer: an edit that
  // changes what a group runs waits for that group and starts a new session.
  '/api/providers/add', '/api/provider-key', '/api/providers/hidden', '/api/providers/order',
  '/api/default-provider', '/api/claude/verify',
  // One headless trial reply outside every journal and session (like a
  // one-off agent run); it does not take a group concurrency slot.
  '/api/test',
  '/api/inbox/dismiss', '/api/issues/status',
  // Console injection through the ordinary busy-followup ingress, the line shown in
  // the group and the reply delivered there. The posted line is the platform
  // message that drives the turn (see consolesay.createDurableConsoleSay).
  '/api/groups/say',
  // A line typed into a local conversation enters the same service ingress as
  // a group message and takes the same durable receipt.
  '/api/local/send',
  // Software updates: check and ignore anywhere; install only when launchd
  // manages this exact entry (the updater refuses every other run mode).
  '/api/update/check', '/api/update/start', '/api/update/ignore']
const SUPPORTED_RUNNERS = ['claude', 'codex']
const { groupBrain } = require('./core/brain')
const { codexCatalogWindows, windowForProvider } = require('./agent/modelwindows')
const { GROUP_COMMANDS } = require('./runtimefacts')

// What a group runs on one backend, for console rows: configured values only;
// what the executor finally selected is reported by the run itself.
function brainFields(group, name, provider, cfg) {
  const b = groupBrain(group, name, provider, { defaultProvider: cfg.defaultProvider })
  return { model: b.model, reasoningEffort: b.effort, groupModel: b.groupModel, groupEffort: b.groupEffort,
    source: b.groupModel ? 'group' : b.defaultModel ? 'provider' : 'default', actualModel: null }
}

function createC2ConsoleFacade({ getBindings, getCapacity, getConfig, getHeld = () => new Map(), activity = null, store = null,
  assertWriterLock, validateConfig, applyConfig, beforeWrite = () => true,
  appliedResets = () => [], now = Date.now,
  // Console injection reaches a group only through the service's own ingress
  // and that group's real platform adapter. Without them it is refused.
  getPlatform = null, routeMessage = null, isServing = () => false, isFrozen = () => false,
  acquireCapacity = null,
  // The local conversation adapter of the live transport (null until it starts).
  getLocal = () => null, localConfirmMs = 5_000, localPollMs = 10,
  log = () => {} } = {}) {
  for (const callback of [getBindings, getCapacity, getConfig, getHeld, assertWriterLock,
    validateConfig, applyConfig, beforeWrite, appliedResets, now, isServing, isFrozen, log]) {
    if (typeof callback !== 'function') throw new TypeError('C2 console needs live authority and configuration hooks')
  }
  if ((getPlatform === null) !== (routeMessage === null) ||
      getPlatform !== null && (typeof getPlatform !== 'function' || typeof routeMessage !== 'function')) {
    throw new TypeError('C2 console injection needs both the group platform and the service ingress')
  }
  if ([validateConfig, applyConfig, beforeWrite].some(callback => callback.constructor?.name === 'AsyncFunction')) {
    throw new TypeError('C2 console configuration hooks must be synchronous')
  }
  const startedAt = now()
  const trials = require('./consoletrials').createConsoleTrials({ getCapacity, acquireCapacity,
    assertWriterLock, isServing, isFrozen })
  const capabilities = Object.freeze({ mode: 'durable-v2',
    // Conversations held in the console itself; the page shows them when set.
    localChat: typeof getLocal === 'function',
    groupCommands: GROUP_COMMANDS,
    reason: '此操作尚未接入当前版本的持久处理流程，未执行。',
    summary: '实时状态、认证管理、停止任务、空闲群开新会话、支持忙时跟进的控制台插话、绑定新群、空闲群的模型切换（Codex / Claude Code）和项目目录修改、模型的添加与设置，以及后台运行时的软件升级已接入；该群有任务或未结记录时不能修改，也不能开新会话；改模型的型号、后端或端点时，用它的群须空闲，并会开始新的一段对话。插话会把这句话（标着「管理员」）和回复都发进群，群忙时按该群的忙时跟进设置尝试加入当前任务，关闭或暂不支持时排队；确认模型读取后才显示已加入；静默插话和不回复的插话暂不支持。解除绑定、移除模型、定时任务和画布暂不可用。',
    allowed: { GET: READ_PATHS, POST: WRITE_PATHS } })
  function held() {
    if (assertWriterLock() !== true) throw new Error('服务写入权限已失效，操作未执行')
  }
  const bindings = () => {
    const value = getBindings()
    if (!(value instanceof Map)) throw new TypeError('C2 console bindings must be a Map')
    return value
  }
  // The engine's /new guard, read from the same runtime and journal the live
  // view uses: a running, admitted, controlled or queued turn, any receipt of
  // this group's journal not yet settled, or an outbound effect still in
  // flight keeps the current session.
  function groupBusy(chatId, binding) {
    const rt = binding.engine?.rts?.get(chatId)
    const snapshot = binding.journal?.consoleSnapshot?.() || binding.journal?.snapshot()
    return !!(rt?.v2NormalRouteActive || rt?.v2AdmissionPending || rt?.v2Controller ||
      rt?.v2QueueReceiptIds?.length || snapshot?.receipts?.pending?.length ||
      snapshot?.state?.lanes?.queue?.[chatId]?.queue?.length ||
      binding.gate?.blocked || binding.runtime?.blocked)
  }
  function clearSession(chatId) {
    held()
    const binding = bindings().get(chatId)
    if (!binding) throw new Error('此群未运行，未开新会话')
    if (binding.runtime?.closed === true) throw new Error('此群当前未开放，未开新会话')
    const busy = '该群有任务进行中或记录未结账，先停止或等它结束再开新会话'
    if (groupBusy(chatId, binding)) throw new Error(busy)
    // The configuration writer's settled check as well: an effect not yet
    // acknowledged or a notice of unknown outcome also keeps the session.
    try { assertJournalScope(binding.journal, chatId, { requireSettled: true }) } catch (error) {
      throw new Error(busy, { cause: error })
    }
    if (binding.engine.stopIdleCompact?.(chatId, '会话已重置')) {
      throw new Error('正在停止会话整理，请稍后再开新会话')
    }
    binding.engine.store.resetSessionAndStats(chatId)
    return true
  }
  // Console injection: an open group, idle or running. Checked
  // before the line is posted, so a refused group shows nothing, and again
  // right after; the service ingress remains the final authority.
  function sayGate(chatId) {
    let locked = false
    try { locked = assertWriterLock() === true } catch {}
    if (!locked || isServing() !== true) return 'not-serving'
    if (getConfig().groups?.[chatId]?.paused) return 'paused'
    if (getHeld().has(chatId)) return 'held'
    if (isFrozen() === true) return 'upgrading'
    const binding = bindings().get(chatId)
    if (!binding || binding.runtime?.closed === true) return 'not-serving'
    const rt = binding.engine?.rts?.get(chatId)
    const snapshot = binding.journal?.consoleSnapshot?.() || binding.journal?.snapshot()
    if (rt?.v2StopControl || rt?.v2SkipWaiter || snapshot?.state?.lanes?.stopIntent?.[chatId]) return 'busy'
    // A normal active turn may accept ordinary messages. Unowned pending work
    // still refuses; it must not become a new execution path or bypass recovery.
    if (!rt?.v2NormalRouteActive && !rt?.v2AdmissionPending && (groupBusy(chatId, binding) || rt?.v2RunningJobs)) return 'busy'
    const queued = snapshot?.state?.lanes?.queue?.[chatId]?.queue?.length || 0
    if (queued >= (rt?.v2AdmissionPending ? 3 : 2)) return 'queue-full'
    return null
  }
  function receiptState(chatId, receiptId) {
    const receipts = bindings().get(chatId)?.journal?.snapshot()?.receipts
    if (receipts?.pending?.some(item => item.id === receiptId)) return 'pending'
    if (receipts?.completed?.some(item => item.id === receiptId)) return 'completed'
    return null
  }
  function locateSay(chatId, receiptId) {
    const binding = bindings().get(chatId)
    const rt = binding?.engine?.rts?.get(chatId)
    const state = receiptState(chatId, receiptId)
    if (state === 'completed') return { state: 'done' }
    const steer = rt?.v2SteerEntries?.get(receiptId)
    if (steer) return { state: steer.accepted && steer.landed ? 'joined' : 'following' }
    const queue = (binding?.journal?.consoleSnapshot?.() || binding?.journal?.snapshot())?.state?.lanes?.queue?.[chatId]?.queue || []
    const index = queue.findIndex(item => item.id === `receipt:job:${receiptId}`)
    if (index >= 0) return { state: 'queued', ahead: index, join: false }
    if (rt?.v2RunningJobs?.some(job => job.msg?._c2ReceiptId === receiptId)) return { state: 'started' }
    return { state: 'accepted' }
  }
  const say = getPlatform ? createDurableConsoleSay({ getPlatform,
    getGroup: chatId => getConfig().groups?.[chatId] || null,
    gate: sayGate, route: routeMessage, receiptState, locate: locateSay, log, now }) : null
  // A line typed into a local conversation. The adapter stores it, then hands
  // it to the service ingress; this waits only until the message is registered
  // (a receipt exists) or refused, never for the turn itself. Pause, hold,
  // recovery and upgrade are decided by the ingress and answered in the
  // conversation like in a group.
  const REFUSALS = { 'group-held': 'held', 'group-recovering': 'recovering', upgrading: 'upgrading' }
  async function localSend(chatId, text, { requestId } = {}) {
    const group = isLocalChatId(chatId) ? getConfig().groups?.[chatId] : null
    if (!group || group.platform !== 'local') return { ok: false, reason: 'unbound' }
    if (group.paused) return { ok: false, reason: 'paused' }
    let locked = false
    try { locked = assertWriterLock() === true } catch {}
    const local = getLocal()
    if (!locked || isServing() !== true || !local) return { ok: false, reason: 'not-serving' }
    let sent
    try { sent = local.submit(chatId, String(text ?? ''), { requestId }) } catch (error) {
      if (error instanceof LocalChatError) return { ok: false, reason: error.reason }
      log('local send: ' + (error?.message || String(error)))
      return { ok: false, reason: 'store-failed' }
    }
    const receiptId = taskId({ source: 'message', chatId, sourceId: sent.id })
    const settled = sent.settled.then(value => ({ value }), error => ({ error }))
    let stopped = false
    settled.then(() => { stopped = true })
    const registered = (async () => {
      const deadline = Date.now() + localConfirmMs
      while (!stopped && Date.now() < deadline) {
        if (receiptState(chatId, receiptId)) return { admitted: true }
        await new Promise(resolve => setTimeout(resolve, localPollMs))
      }
      return receiptState(chatId, receiptId) ? { admitted: true } : { timeout: true }
    })()
    const first = await Promise.race([settled, registered])
    if (first.admitted) return { ok: true, id: sent.id, where: locateSay(chatId, receiptId) }
    if (first.timeout) return { ok: true, id: sent.id, where: { state: 'unconfirmed' } }
    const { value, error } = first
    const state = receiptState(chatId, receiptId)
    if (state) return { ok: true, id: sent.id, where: state === 'completed' ? { state: 'done' } : locateSay(chatId, receiptId) }
    if (error) return { ok: false, id: sent.id, reason: 'inject-failed' }
    if (value?.duplicate) return { ok: true, id: sent.id, where: { state: 'duplicate' } }
    // A command or a refusal: the ingress has already answered in the conversation.
    if (value?.rejected) {
      return { ok: true, id: sent.id, where: { state: String(text).trim().startsWith('/') && !REFUSALS[value.reason]
        ? 'command' : 'refused', reason: REFUSALS[value.reason] || value.reason, notified: value.notified === true } }
    }
    if (value?.held) return { ok: true, id: sent.id, where: { state: 'refused', reason: 'held' } }
    if (value?.recovered) return { ok: true, id: sent.id, where: { state: 'refused', reason: 'recovering' } }
    if (value?.ignored || value?.quarantined) return { ok: false, id: sent.id, reason: 'not-serving' }
    return { ok: true, id: sent.id, where: { state: 'done' } }
  }
  function localHistory(chatId, options = {}) {
    const group = isLocalChatId(chatId) ? getConfig().groups?.[chatId] : null
    if (!group || group.platform !== 'local') return null
    const local = getLocal()
    return local ? local.history(chatId, options) : []
  }
  function getLiveState() {
    const cfg = getConfig()
    const capacity = getCapacity()
    const heldGroups = getHeld()
    const groups = {}
    let queue = 0
    for (const [chatId, group] of Object.entries(cfg.groups || {})) {
      const binding = bindings().get(chatId)
      const hold = heldGroups.get(chatId)
      const rt = binding?.engine?.rts.get(chatId)
      const snapshot = binding?.journal?.consoleSnapshot?.() || binding?.journal?.snapshot()
      const pending = snapshot?.receipts?.pending || []
      const queued = snapshot?.state?.lanes?.queue?.[chatId]?.queue?.length || 0
      queue += queued
      groups[chatId] = {
        context: activity?.context(chatId, (binding?.engine?.store || store)?.getSession(chatId),
          !!rt?.v2NormalRouteActive, rt?.v2RunnerGeneration) || null,
        busy: !!rt?.v2NormalRouteActive,
        finalizing: !!rt?.v2TerminalStarted,
        followups: !!rt?.v2SteerControl && !rt?.v2SteerClosing && !rt?.v2TerminalStarted,
        queue: queued, pending: pending.length,
        queueFaulted: !group.paused && (!binding || (!rt?.v2NormalRouteActive && !!binding.gate?.blocked)),
        waitingForCapacity: !!rt?.v2AdmissionPending,
        sinceMs: rt?.v2StartedAt ? Math.max(0, now() - rt.v2StartedAt) : 0,
        sessionId: (binding?.engine?.store || store)?.getSession(chatId) || '',
        // Why a console injection would be refused right now (null = accepted).
        sayBlocked: say ? sayGate(chatId) : 'not-serving',
        // A held group needs the operator: its last result is unknown.
        ...(hold ? { held: true, heldReason: hold.reason, heldSinceMs: Math.max(0, now() - hold.since) } : {}),
      }
    }
    const activeBindingsReady = Object.entries(cfg.groups || {})
      .filter(([chatId, group]) => !group.paused && !heldGroups.has(chatId))
      .every(([chatId]) => bindings().has(chatId))
    return { running: assertWriterLock() === true && !capacity.closed && activeBindingsReady,
      uptimeMs: Math.max(0, now() - startedAt),
      concurrency: { active: capacity.active, max: capacity.maxConcurrent },
      queue, waiting: capacity.waiting, held: heldGroups.size, groups }
  }
  function getActivity() {
    const cfg = getConfig(), items = []
    for (const [chatId, binding] of bindings()) {
      const snap = binding.journal.consoleSnapshot?.() || binding.journal.snapshot()
      const rt = binding.engine.rts.get(chatId)
      const group = cfg.groups[chatId]?.name || chatId.slice(-8)
      for (const receipt of snap.receipts.pending) {
        if (activity?.has(chatId, receipt.id)) continue
        const running = rt?.v2RunningJobs?.some(job => job.msg?._c2ReceiptId === receipt.id)
        items.push({ id: receipt.id, chatId, group, ts: receipt.acceptedAt,
          kind: running ? 'start' : 'done', status: running ? 'running' : '等待处理',
          text: running ? '正在处理群消息' : '消息已登记，等待处理', sender: '' })
      }
      for (const receipt of snap.receipts.completed.slice(-30)) {
        if (activity?.has(chatId, receipt.id)) continue
        // A settled receipt alone does not prove successful answer delivery.
        items.push({ id: receipt.id, chatId, group, ts: receipt.settledAt,
          kind: 'done', status: '已结账', text: '消息处理记录已结账', sender: '' })
      }
    }
    const recent = activity?.list({ limit: 100 }).activity || []
    return [...recent, ...items].filter(item => cfg.groups[item.chatId])
      .sort((a, b) => Number(a.kind !== 'start') - Number(b.kind !== 'start') || b.ts - a.ts).slice(0, 100)
  }
  function activityPage(query = {}) {
    const cfg = getConfig(), live = getLiveState()
    const meta = activity?.list({ limit: 1 }) || { epoch: 'receipts', revision: 0 }
    const groups = Object.entries(cfg.groups || {}).map(([chatId, group]) => {
      const binding = bindings().get(chatId), groupStore = binding?.engine?.store || store
      const providerName = groupStore?.getProvider?.(chatId) || group.provider || cfg.defaultProvider
      const provider = cfg.providers?.[providerName] || {}
      const stats = groupStore?.getSessionStats?.(chatId), session = groupStore?.getSession?.(chatId)
      const context = live.groups[chatId].context || (session && stats?.sessionId === session && Number.isFinite(stats.ctx)
        ? { usedTokens: stats.ctx, windowTokens: null, measuredAt: null, quality: 'historical' } : null)
      return { chatId, name: group.name || chatId.slice(-8), project: path.basename(group.workdir || '') || '—',
        workdir: group.workdir || '', runner: provider.runner || 'claude',
        ...brainFields(group, providerName, provider, cfg),
        paused: !!group.paused, ...live.groups[chatId], context }
    })
    const rows = getActivity().filter(row => (!query.chatId || row.chatId === query.chatId) && (!query.status || row.status === query.status))
    const offset = Math.max(0, Math.min(100, Number(query.offset) || 0)), limit = Math.max(1, Math.min(100, Number(query.limit) || 30))
    return { epoch: meta.epoch, revision: meta.revision, storageError: !!meta.storageError, groups,
      total: rows.length, activity: rows.slice(offset, offset + limit) }
  }
  return {
    capabilities,
    beginTrial: controller => trials.begin(controller),
    allows: (method, pathname) => (capabilities.allowed[method] || []).includes(pathname),
    // A provider without a runner field is Claude Code, as everywhere else.
    providerSupported: provider => SUPPORTED_RUNNERS.includes(provider?.runner || 'claude'),
    getLiveState, getActivity, activityPage,
    activityDetail(chatId, id) { return getConfig().groups?.[chatId] ? activity?.detail(chatId, id) || null : null },
    validateConfig(raw) { held(); validateConfig(raw) },
    beforeWrite(raw) { held(); beforeWrite(raw) },
    applyConfig(raw) { held(); applyConfig(raw) },
    // Groups whose session the last applied configuration write reset.
    appliedResets: () => appliedResets(),
    decorateState(state) {
      state.runtimeCapabilities = capabilities
      for (const group of state.groups || []) {
        const cfg = getConfig(), source = cfg.groups?.[group.chatId] || {}
        const provider = cfg.providers?.[group.effectiveProvider || source.provider || cfg.defaultProvider]
        const name = group.effectiveProvider || source.provider || cfg.defaultProvider
        const fields = brainFields(source, name, provider, cfg)
        Object.assign(group, { configuredModel: fields.model, modelSource: fields.source,
          actualModel: null, brain: { provider: name, model: fields.model, effort: fields.reasoningEffort,
            groupModel: fields.groupModel, groupEffort: fields.groupEffort },
          providerPrefs: source.providerPrefs || null,
          contextWindow: provider ? windowForProvider({ ...provider, model: fields.model }, null, codexCatalogWindows()) : null })
      }
      state.previews = (state.previews || []).filter(item => getConfig().groups?.[item.chatId])
      state.leftovers = { supported: false, rows: [], error: null }
    },
    control: {
      providerOf(chatId) {
        const binding = bindings().get(chatId)
        const cfg = getConfig(), group = cfg.groups?.[chatId]
        return binding?.engine?.store?.getProvider(chatId) || group?.provider || cfg.defaultProvider
      },
      stop(chatId) {
        held()
        const binding = bindings().get(chatId)
        if (!binding) throw new Error('此群未运行，未执行停止')
        return binding.engine.stop(chatId)
      },
      clearSession,
      // Same signature as the legacy daemon's say; the result says honestly
      // whether the line drove a turn ({ ok, where }) or why it did not.
      say(chatId, text, shown, quiet, options) {
        return say ? say(chatId, text, shown, quiet, options)
          : Promise.resolve({ ok: false, reason: 'no-daemon' })
      },
      // A durable stop settles later, so a busy group is never reset here:
      // the operator stops it first and starts the new session once idle.
      interrupt(chatId) {
        clearSession(chatId)
        return { wasBusy: false }
      },
      localSend, localHistory,
    },
  }
}

function createC2Console(options = {}) {
  const { stateDir, configPath, getConnHealth, host = '127.0.0.1', log = () => {} } = options
  if (!path.isAbsolute(stateDir || '') || !path.isAbsolute(configPath || '')) {
    throw new TypeError('C2 console requires explicit installation paths')
  }
  const facade = createC2ConsoleFacade(options)
  // The process-wide model list (also used by /model), when the service has one.
  facade.modelCatalog = typeof options.modelCatalog === 'function' ? options.modelCatalog : null
  const ui = createUiServer({ configPath, host, log, getConnHealth, updater: options.updater || null,
    onHostChange: options.onHostChange,
    getLiveState: facade.getLiveState, control: facade.control, runtimePolicy: facade,
    issuesPath: path.join(stateDir, 'issues.jsonl'),
    sessionsPath: path.join(stateDir, 'ui-sessions.json'),
    auditPath: path.join(stateDir, 'audit.jsonl'),
    ledgerPath: path.join(stateDir, 'turns.jsonl'),
    inboxDismissPath: path.join(stateDir, 'inbox-dismissed.json'),
    verifyFile: path.join(stateDir, 'verify.json'),
  })
  let previous = null
  const unsubscribe = options.activity?.subscribe(() => {
    const page = facade.activityPage({ limit: 100 })
    const before = new Map((previous?.activity || []).map(row => [row.chatId + ':' + row.id, JSON.stringify(row)]))
    const current = new Set(page.activity.map(row => row.chatId + ':' + row.id))
    const changed = page.activity.filter(row => before.get(row.chatId + ':' + row.id) !== JSON.stringify(row))
    const groups = page.groups.filter(group => JSON.stringify(previous?.groups.find(g => g.chatId === group.chatId)) !== JSON.stringify(group))
    ui.pushEvent('activity-update', { epoch: page.epoch, revision: page.revision, storageError: page.storageError,
      activity: changed, groups, removed: [...before.keys()].filter(id => !current.has(id)) })
    previous = page
  })
  return { ...ui, facade, close() { unsubscribe?.(); ui.close() } }
}

module.exports = { createC2Console, createC2ConsoleFacade }
