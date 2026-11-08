'use strict'

const path = require('node:path')
const { createUiServer } = require('./ui/serverbase')
const { START_PATH, CALLBACK_PATH } = require('./ui/feishulogin')

// A host facade over existing v2 authorities, not a second execution engine.
// The allowlist applies after the existing console's authentication boundary.
const READ_PATHS = ['/api/state', '/api/events', '/api/inbox', '/api/activity',
  '/api/changelog', '/api/changelog-en', '/api/codex/models', '/api/usage',
  '/api/plugins', '/api/design/styles', '/api/design/icons', '/api/fs/listdir',
  '/api/feishu/admin-candidates', '/api/feishu/org-users', '/api/feishu/resolve-contact',
  '/api/feishu/chats', '/api/feishu/chat-members', START_PATH, CALLBACK_PATH]
const WRITE_PATHS = ['/api/login', '/api/logout', '/api/logout/all',
  '/api/ui/network', '/api/ui/public-url', '/api/ui/update-settings', '/api/feishu/admins',
  '/api/groups', '/api/groups/provider', '/api/fs/mkdir',
  '/api/groups/order', '/api/groups/policy', '/api/groups/redact',
  '/api/groups/codex-steer', '/api/groups/pause', '/api/groups/stop',
  '/api/agent', '/api/provider-settings', '/api/codex/verify', '/api/usage/refresh',
  '/api/inbox/dismiss', '/api/issues/status']
const SUPPORTED_RUNNERS = ['claude', 'codex']

function createC2ConsoleFacade({ getBindings, getCapacity, getConfig, getHeld = () => new Map(),
  assertWriterLock, validateConfig, applyConfig, beforeWrite = () => true, now = Date.now } = {}) {
  for (const callback of [getBindings, getCapacity, getConfig, getHeld, assertWriterLock,
    validateConfig, applyConfig, beforeWrite, now]) {
    if (typeof callback !== 'function') throw new TypeError('C2 console needs live authority and configuration hooks')
  }
  if ([validateConfig, applyConfig, beforeWrite].some(callback => callback.constructor?.name === 'AsyncFunction')) {
    throw new TypeError('C2 console configuration hooks must be synchronous')
  }
  const startedAt = now()
  const capabilities = Object.freeze({ mode: 'durable-v2',
    reason: '此操作尚未接入当前版本的持久处理流程，未执行。',
    summary: '实时状态、认证管理、停止任务、绑定新群，以及空闲群的模型切换（Codex / Claude Code）和项目目录修改已接入；该群有任务或未结记录时不能修改。开新会话、解除绑定、控制台插话、定时任务、画布和升级暂不可用。',
    allowed: { GET: READ_PATHS, POST: WRITE_PATHS } })
  function held() {
    if (assertWriterLock() !== true) throw new Error('服务写入权限已失效，操作未执行')
  }
  const bindings = () => {
    const value = getBindings()
    if (!(value instanceof Map)) throw new TypeError('C2 console bindings must be a Map')
    return value
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
      const snapshot = binding?.journal?.snapshot()
      const pending = snapshot?.receipts?.pending || []
      const queued = snapshot?.state?.lanes?.queue?.[chatId]?.queue?.length || 0
      queue += queued
      groups[chatId] = {
        busy: !!rt?.v2NormalRouteActive,
        finalizing: !!rt?.v2TerminalStarted,
        followups: !!rt?.v2SteerControl && !rt?.v2SteerClosing && !rt?.v2TerminalStarted,
        queue: queued, pending: pending.length,
        queueFaulted: !group.paused && (!binding || (!rt?.v2NormalRouteActive && !!binding.gate?.blocked)),
        waitingForCapacity: !!rt?.v2AdmissionPending,
        sinceMs: rt?.v2StartedAt ? Math.max(0, now() - rt.v2StartedAt) : 0,
        sessionId: binding?.engine?.store?.getSession(chatId) || '',
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
      const snap = binding.journal.snapshot()
      const rt = binding.engine.rts.get(chatId)
      const group = cfg.groups[chatId]?.name || chatId.slice(-8)
      for (const receipt of snap.receipts.pending) {
        const running = rt?.v2RunningJobs?.some(job => job.msg?._c2ReceiptId === receipt.id)
        items.push({ id: receipt.id, chatId, group, ts: receipt.acceptedAt,
          kind: running ? 'start' : 'done', status: running ? 'running' : '等待处理',
          text: running ? '正在处理群消息' : '消息已登记，等待处理', sender: '' })
      }
      for (const receipt of snap.receipts.completed.slice(-30)) {
        // A settled receipt alone does not prove successful answer delivery.
        items.push({ id: receipt.id, chatId, group, ts: receipt.settledAt,
          kind: 'done', status: '已结账', text: '消息处理记录已结账', sender: '' })
      }
    }
    return items.sort((a, b) => b.ts - a.ts).slice(0, 30)
  }
  return {
    capabilities,
    allows: (method, pathname) => (capabilities.allowed[method] || []).includes(pathname),
    // A provider without a runner field is Claude Code, as everywhere else.
    providerSupported: provider => SUPPORTED_RUNNERS.includes(provider?.runner || 'claude'),
    getLiveState, getActivity,
    validateConfig(raw) { held(); validateConfig(raw) },
    beforeWrite(raw) { held(); beforeWrite(raw) },
    applyConfig(raw) { held(); applyConfig(raw) },
    decorateState(state) {
      state.runtimeCapabilities = capabilities
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
    },
  }
}

function createC2Console(options = {}) {
  const { stateDir, configPath, getConnHealth, host = '127.0.0.1', log = () => {} } = options
  if (!path.isAbsolute(stateDir || '') || !path.isAbsolute(configPath || '')) {
    throw new TypeError('C2 console requires explicit installation paths')
  }
  const facade = createC2ConsoleFacade(options)
  const ui = createUiServer({ configPath, host, log, getConnHealth,
    onHostChange: options.onHostChange,
    getLiveState: facade.getLiveState, control: facade.control, runtimePolicy: facade,
    issuesPath: path.join(stateDir, 'issues.jsonl'),
    sessionsPath: path.join(stateDir, 'ui-sessions.json'),
    auditPath: path.join(stateDir, 'audit.jsonl'),
    ledgerPath: path.join(stateDir, 'turns.jsonl'),
    inboxDismissPath: path.join(stateDir, 'inbox-dismissed.json'),
    verifyFile: path.join(stateDir, 'verify.json'),
  })
  return { ...ui, facade }
}

module.exports = { createC2Console, createC2ConsoleFacade }
