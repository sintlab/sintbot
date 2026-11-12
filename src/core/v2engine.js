// Dedicated durable v2 host. The binary and journal own turn decisions;
// this class owns process-local payloads, runner handles and platform I/O.
// No legacy Engine, retry/failover scheduler or v1 reducer is loaded here.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { redact } = require('./redact')
const { fmtStamp, normalizeTz } = require('./time')
const { settleUsage, manifestPolicy, manifestHeader, manifestContext, manifestFeatures, manifestSkills,
  followupEnabled, systemAppendix, turnPrompt, engineTerminalStep, engineQueueStep,
  idleCompactPlan, idleCompactSettle, compactEvent, classifyError } = require('../agent/privatecore')
const { taskId } = require('./enginecheckpoint')
const { prepareCardTerminalPath } = require('./c2cardterminalpath')
const { terminalReplyText } = require('./c2terminaleffectbridge')
const { createC2TurnProjection } = require('./c2turnprojection')
const { prepareC2RunnerInput, prepareC2CompactionInput } = require('./c2runnerinput')
const { continueC2Successor } = require('./c2successorbridge')
const { rejectC2Input } = require('./c2inputrejection')
const progress = require('./turnprogress')
const { groupBrain } = require('./brain')
const { modelName } = require('./modelname')
const { parseModelWords, resolveModel, effortsFor, modelChoices, fillPicks, recommendEffort } = require('./modelcmd')
const { DEFAULT_VALUE: MODEL_CARD_DEFAULT } = require('../platform/modelcard')
// A /model card answers taps for ten minutes; older cards turn read-only.
const MODEL_CARD_TTL_MS = 10 * 60 * 1000
const { GROUP_COMMANDS, RUNTIME_ENTRY, runtimeCommand } = require('../runtimefacts')
const NO_REPLY = 'NO_REPLY'
const SYSTEM_APPENDIX = systemAppendix(NO_REPLY)
const V2_NORMAL_ROUTE_MISSING = Object.freeze(['complete durable v2 authority'])
// Permission tiers the manifest describes to the agent as read-only: 1 is
// the Codex read-only sandbox, 3 the fail-closed default. 0 is full access
// and 2 an allow-listed tool set, which may still change files.
const READ_ONLY_TIERS = Object.freeze([1, 3])
const DURABLE_V2_COMMANDS = new Set(GROUP_COMMANDS.filter(cmd => !['/skip', '/stop'].includes(cmd)))
function fmtWan(n) {
  n = Number(n) || 0
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}万`
  return String(n)
}
function humanDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
// The final card is an accounting line: keep seconds for short turns and
// switch to minutes/hours before a long turn becomes an unreadable number.
function cardDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`
}
function cardModelInfo(brain) {
  if (!brain) return { model: '', effort: '' }
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim()
  return { model: clean(brain.model ? modelName(brain.model) : ''), effort: clean(brain.effort) }
}
// An example depth for /model replies: high when available, else another one.
const exEffortOf = (efforts, cur) => ((efforts || []).includes('high') && cur !== 'high' ? 'high' : ((efforts || []).find(e => e !== cur) || ''))
// "codex · GPT-6-Astra · high": what this group runs on its current backend.
function brainLabel(name, brain) {
  return [name, brain?.model ? modelName(brain.model) : '', brain?.effort || ''].filter(Boolean).join(' · ')
}
function cardModelDetail(info, result) {
  // A rejected configured effort may have been retried at the model default.
  const fellBack = result?.effortFellBack || result?.result?.effortFellBack
  return [info?.model, fellBack ? '' : info?.effort]
    .filter(Boolean).join(' ')
}
// Group texts name the project by its folder only, never by a machine path.
function projectName(group) {
  return String(group?.workdir || '').split(/[\\/]/).filter(Boolean).pop() || '（未设）'
}
const T = {
  queued: n => n > 1 ? `⏳ 已排队 — 当前任务结束后与前面 ${n - 1} 条一并处理` : '⏳ 已排队 — 当前任务结束后处理',
  stopped: '已停止',
  noActiveTask: '没有正在运行的任务',
  unsupportedCommand: '这个命令暂不支持。只放弃手头这件发 /skip，连排队的一起取消发 /stop；其他需求直接用文字说明。',
  unsupportedCommandWithModel: '这个命令暂不支持，发 /help 查看可用命令；其他需求直接用文字说明。',
  // Plain text: 【】 sections and "· " items, each read in one glance, no
  // alignment. Commands go by urgency; the three cancel commands rise in what
  // they discard and describe the queue and the conversation in the same words.
  help: ({ project, model, steer, readOnly }) => ['【这是什么】',
    `· 本群绑着项目「${project}」，模型 ${model}`,
    readOnly ? '· 直接问它，它看代码、答问题；之前聊的都记得'
      : '· 直接说事它就干，做完在群里回你；之前聊的都记得',
    steer ? '· 任务进行中再发的消息会补充进当前任务'
      : '· 任务进行中再发的消息会排队，等这一轮结束再处理',
    '',
    '【命令】',
    '· /status — 跑了多久、还有没有动静、排队几条',
    '· /skip — 只放弃手头这件，排队的继续；之前聊的还记得',
    '· /stop — 手头和排队的全取消；之前聊的还记得',
    '· /new — 忘掉之前聊的，从头开始（要等手头任务结束）',
    '· /model — 看或改本群模型：/model high 调深度、/model 型号 换型号（都接着当前对话）、/model 后端 换后端（开新对话）；要等手头任务结束',
    '· /hud — 额度与本段对话的用量',
    '· /issue 一句话 — 记下问题反馈，给管理员看',
    '· /help — 这份说明',
    // Not "trailing text is ignored": /stop with text after it is not recognised.
    '⚠ 命令单独发一条，后面别跟别的字（/issue、/model 除外）',
    // Same boundary as handleRecall: a queued message, or the task running on
    // that message alone; a steered follow-up takes its whole task with it.
    steer ? '⚠ 撤回自己发的消息 = 取消那件事；撤回补进当前任务的那条，会连当前任务一起取消'
      : '⚠ 撤回自己发的消息 = 取消那件事（已和别的消息合成一轮在做的除外）',
    ...(readOnly ? ['⚠ 本群为只读模式：能看代码、答问题；要改文件需管理员放开权限'] : []),
  ].join('\n'),
  status: ({ model, project, state, doing = [], queue, session }) => ['【本群状态】', `· 模型：${model}`,
    `· 项目：${project}`, `· 状态：${state}`,
    ...(doing.length ? [`· 最近在做：${doing.join(' · ')}`] : []),
    `· 排队：${queue}`, `· 对话：${session}`].join('\n'),
  freshSession: '✅ 已开始新的一段对话，之前聊的内容不再带着',
  newBusy: '⚠ 手头还有任务在跑 —— 等它跑完，或先发 /stop 再发 /new',
  quotaShow: (name, value) => `${name} 额度：${value}`,
  quotaMiss: name => `${name} 额度暂时没查到，稍后再试`,
  quotaNone: name => `模型「${name}」不支持查额度`,
  sessionLine: (turns, ctx, inTotal, { idleAt = 0, lastAt = '' } = {}) => `【对话】第 ${turns} 轮 · ${ctx ? `上下文约 ${fmtWan(ctx)} token` : `累计处理约 ${fmtWan(inTotal)} token`}`
    + (idleAt > 0 ? `（空闲时过 ${fmtWan(idleAt)} 先整理${lastAt ? ` · 上次整理 ${lastAt}` : ''}）` : ''),
  noSession: '【对话】本段对话还没开始',
  issueUsage: '用法：/issue 后面跟一句话，说清哪里不对劲\n例：/issue 刚才发的图它没理我',
  issueLogged: id => `📝 已记下 #${id}`,
  issueFailed: '⚠ 没记下来 —— 麻烦再说一次，或直接在群里说',
  // /model replies list backends, models and depths on separate lines, with
  // examples taken from this group's real choices. Any unrecognised word
  // rejects the whole command and changes nothing (no fuzzy matching).
  //   o = { current, names, name, choices|null|undefined, efforts, exEffort, exModel, exProvider }
  //   choices === null: this backend's model is set in the console (third-party endpoint).
  modelInfo: (o) => {
    const L = [`【本群模型】${o.current}`]
    L.push(`【后端】${o.names.join(' · ')}`)
    if (o.choices === null) L.push(`【${o.name} 型号】到控制台改`)
    else if (o.choices && o.choices.length) L.push(`【${o.name} 型号】${o.choices.map((x) => modelName(x)).join(' · ')}`)
    if (o.efforts && o.efforts.length) L.push(`【思考深度】${o.efforts.join(' · ')}`)
    if (o.exEffort) L.push(`· 调深度：/model ${o.exEffort}（接着当前对话）`)
    if (o.exModel) L.push(`· 换型号：/model ${modelName(o.exModel)}（接着当前对话）`)
    if (o.exProvider) L.push(`· 换后端：/model ${o.exProvider}（开新对话）`)
    L.push('⚠ 要等手头任务结束才能改')
    return L.join('\n')
  },
  modelUnknownWord: (word, o) => (o.choices === null
    ? `⚠ 「${word}」不是可选的后端或深度（${o.name} 的型号要到控制台改）—— 一项都没改`
    : `⚠ 「${word}」不是可选的后端、型号或深度 —— 一项都没改`)
    + `\n【后端】${o.names.join(' · ')}` + (o.choices && o.choices.length ? `\n【${o.name} 型号】${o.choices.map((x) => modelName(x)).join(' · ')}` : '')
    + (o.efforts && o.efforts.length ? `\n【思考深度】${o.efforts.join(' · ')}` : ''),
  modelDup: (what, a, b) => `⚠ 一次只能选一个${what}（写了 ${a} 和 ${b}）—— 一项都没改`,
  modelNoCatalog: name => `⚠ 暂时取不到 ${name} 的可选型号 —— 一项都没改；稍后再试，或请管理员到控制台改`,
  modelEffortUnsupported: (model, e, list) => list.length
    ? `⚠ ${modelName(model) || model} 没有「${e}」这档深度 —— 一项都没改\n【可选】${list.join(' · ')}`
    : `⚠ ${modelName(model) || model} 不支持调思考深度 —— 一项都没改`,
  modelSame: current => `本群已经在用 ${current}，没有变化`,
  modelBusy: '⚠ 手头还有任务在跑 —— 等它跑完再改，或先发 /stop',
  modelSwitched: (current, note, filled) => `✅ 已切到 ${current}\n⚠ 换了后端，新的一段对话从这里开始，之前聊的内容不再带着` + (note ? ` —— ${note}` : '')
    + (filled ? `\n· 本群在这个后端还没选过${filled}，先用推荐的；要换就 /model 加名字` : ''),
  modelChanged: (current, filled) => `✅ 已改为 ${current} —— 接着当前对话，下条消息生效\n· 对话很长时新型号可能装不下，可发 /new 重开`
    + (filled ? `\n· ${filled}先用推荐的` : ''),
  effortSwitched: (effort, label) => `✅ 思考深度已调为 ${effort}（${label}）—— 接着当前对话，下条消息生效`,
  modelSwitchFailed: '⚠ 没换成 —— 请管理员到控制台看一下',
  stopPending: '正在停止当前任务，这条消息没有处理，请稍后重发。',
  stopUnavailable: '当前任务正在收尾，暂时无法停止。',
  stoppedWithQueue: n => `已停止 — 连同排队的 ${n} 条一并取消`,
  skipped: n => n > 0 ? `已跳过当前任务（后面还有 ${n} 条排队，接着处理）` : '已跳过当前任务',
  skipUnavailable: '当前任务正在收尾，暂时无法跳过。',
  skipPending: '正在跳过当前任务，这条消息没有处理，请稍后重发。',
  quotaFailure: 'Codex 订阅额度已用完，本次任务未完成。请恢复额度后重新发送；本次请求不会自动重试。',
  cardFooter: ({ ms, tokens }) => {
    const parts = [`耗时 ${cardDuration(ms)}`]
    const tokenLabel = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
    if (tokens && ((tokens.in || 0) + (tokens.cr || 0) + (tokens.cw || 0) + (tokens.out || 0)) > 0) {
      parts.push(`tokens ↑${tokenLabel((tokens.in || 0) + (tokens.cr || 0) + (tokens.cw || 0))} ↓${tokenLabel(tokens.out || 0)}`)
    }
    return parts.join(' · ')
  },
}
// /stop with no stoppable turn is user input refused before any receipt; the
// running turn, if any, keeps its own durable path untouched.
function durableV2StopUnavailable(rt) {
  const idle = !rt?.v2NormalRouteActive || !rt.v2RunningJobs?.length
  return rejectC2Input('C2 v2 /stop is unsupported or closed', idle
    ? { reason: 'stop-idle', notice: T.noActiveTask }
    : { reason: 'stop-unavailable', notice: T.stopUnavailable })
}

// The binary owns quota/error and side-effect classification. This host route
// only admits the supported, closed Codex subscription failure; it never
// retries a runner or turns that failure into a successful outcome.
function supportedV2QuotaFailure(payload, runnerResult) {
  if (!payload || payload.source !== 'result' || payload.aborted ||
      payload.sessionMissing || payload.transientNetwork || payload.freshRetried ||
      payload.resumedSessionCurrent || runnerResult?.aborted !== false ||
      runnerResult?.result?.quota?.kind !== 'quota' ||
      typeof payload.bufferText !== 'string' || payload.bufferText.trim() ||
      typeof payload.answerText !== 'string' || payload.answerText.trim()) return false
  const terminal = { ...payload, type: 'finalize' }
  delete terminal.receiptId; delete terminal.turnToken; delete terminal.quiet
  const outcome = engineTerminalStep({ finalized: false, outcome: null }, terminal).state.outcome
  return outcome.status === 'error' && outcome.quotaError === true &&
    outcome.sideEffects === false
}

// Admit only an observed, closed result on this release's no-retry route.
// Error classification remains in the core; close/session/effect authority is
// checked by the terminal path before any delivery can be attempted.
function supportedV2ClosedFailure(payload, runnerResult) {
  if (!payload || !['result', 'runner-exit'].includes(payload.source) || payload.aborted ||
      payload.sessionMissing || payload.transientNetwork || payload.hasQuota ||
      payload.freshRetried || payload.resumedSessionCurrent ||
      runnerResult?.aborted !== false ||
      (payload.source === 'runner-exit' && runnerResult.result != null)) return false
  const terminal = { ...payload, type: 'finalize' }
  delete terminal.receiptId; delete terminal.turnToken; delete terminal.quiet
  return engineTerminalStep({ finalized: false, outcome: null }, terminal)
    .state.outcome.status === 'error'
}

function ordinaryV2Cohort(snapshot, jobs, binding, chatId, receiptId) {
  if (!Array.isArray(jobs) || !jobs.length ||
      jobs.some(job => !job || job.msg?.batch || job.msg?.synthetic ||
        job.msg?.cron || job.msg?.polled || job.msg?.quiet ||
        job.msg?.chatId !== chatId ||
        job.msg?.replyCtx?.chatId !== chatId ||
        job.msg?.replyCtx?.messageId !== job.msg?.msgId ||
        typeof job.msg?._c2ReceiptId !== 'string' ||
        !/^[0-9a-f]{32}$/.test(job.msg._c2ReceiptId)) ||
      !isDeepStrictEqual(binding?.receiptIds,
        jobs.map(job => job.msg._c2ReceiptId)) ||
      new Set(binding.receiptIds).size !== binding.receiptIds.length ||
      !isDeepStrictEqual(binding?.batchReceiptIds, binding.receiptIds) ||
      !binding.receiptIds.includes(receiptId) ||
      !isDeepStrictEqual(snapshot.state?.lanes?.handoff?.[chatId]?.acceptedReceiptIds,
        jobs.length > 1 ? binding.receiptIds : []) ||
      jobs.some(job => {
        const receipt = snapshot.receipts?.pending?.find(item =>
          item.id === job.msg._c2ReceiptId)
        return receipt?.chatId !== chatId || receipt.source !== 'message' ||
          receipt.sourceId !== job.msg.msgId || receipt.quiet !== false
      })) return null
  return { jobs, anchor: jobs.find(job => job.msg._c2ReceiptId === receiptId),
    receiptIds: [...binding.receiptIds] }
}
function v2QueueSelection(queue) {
  if (!Array.isArray(queue)) throw new TypeError('durable queue must be an array')
  const result = engineQueueStep({ queue }, { type: 'dequeue' })
  const effect = result.effects[0]
  if (!queue.length && result.effects.length === 0) return { jobs: [], anchor: null }
  if (result.effects.length !== 1 || effect.type !== 'dispatch' ||
      !Array.isArray(effect.batch) || !effect.batch.length ||
      !effect.batch.includes(effect.anchor)) throw new Error('binary queue selection invalid')
  const jobs = effect.batch.map(id => queue.find(job => job.id === id))
  if (jobs.some(job => !job)) throw new Error('binary selected unknown queue handle')
  return { jobs, anchor: effect.anchor.slice('receipt:job:'.length) }
}

// The group skills the release entry serves through `sbot feishu` (the same
// executable as `sintbot`): messages, notice cards, history, reply, edit,
// recall, download and reactions. Canvas, image generation and takeover cards
// are not in this release, and neither are scheduled tasks, so the cron
// section the core renders after the skills is cut off.
function releaseSkillLines(platform) {
  const features = manifestFeatures({ ...(platform?.features || {}),
    boards: false, imagen: false, takeoverCard: false })
  const lines = manifestSkills({ features: { ...features, localAnswers: true },
    platformName: String(platform?.chatLabel || '飞书群').replace(/群$/, '') })
  const cron = lines.findIndex(line => line.startsWith('【定时任务】'))
  return (cron < 0 ? lines : lines.slice(0, cron))
    .map(line => line.replace(/sbot feishu/g, `${runtimeCommand()} feishu`))
}

// The group skills call `sbot feishu`. A machine can carry another `sbot` on
// PATH (an older global install), so a turn puts first the bin directory whose
// `sbot` is this very entry: an npm global prefix's bin next to
// lib/node_modules/sintbot. Nothing is changed when no such directory exists
// (a source checkout, tests).
let releaseBin
function releaseBinDir(entry = path.join(__dirname, '..', '..', 'bin', 'sintbot-v2.js')) {
  if (releaseBin !== undefined && arguments.length === 0) return releaseBin
  let found = null
  try {
    const self = fs.realpathSync(entry)
    const dir = path.resolve(path.dirname(self), '..', '..', '..', '..', 'bin')
    if (fs.realpathSync(path.join(dir, 'sbot')) === self) found = dir
  } catch {}
  if (arguments.length === 0) releaseBin = found
  return found
}

class Engine {
  constructor(cfg, options = {}) {
    const { store, log = () => {}, durableV2Runtime, durableV2Payloads,
      durableV2StartTurn, durableV2ApplyLocalEffect, durableV2VerifyRunnerClosed,
      durableV2AssertWriterLock, durableV2Journal,
      durableV2NormalRoute = true, durableV2StreamFrames = false,
      durableV2AcquireCapacity = null, durableV2SealCapacity = null,
      durableV2SwitchProvider = null, durableV2SetBrain = null, durableV2ModelCatalog = null,
      durableV2ModelCard = null,
      durableV2UsageProbe = null, durableV2Issues = null,
      durableV2Version = '', durableV2DataDir = '', durableV2ConsoleEnabled = false,
      durableV2CompactSession = null, durableV2CapacitySnapshot = null } = options
    const sync = f => typeof f === 'function' && f.constructor?.name !== 'AsyncFunction'
    if (!cfg || !cfg.agent || !cfg.groups || !cfg.providers ||
        options.receiptJournal || options.unifiedStepHost ||
        !durableV2Runtime || !durableV2Payloads ||
        typeof durableV2Runtime.enqueueMessage !== 'function' ||
        typeof durableV2Runtime.snapshot !== 'function' ||
        typeof durableV2Runtime.close !== 'function' ||
        typeof durableV2Runtime.beginRunnerStart !== 'function' ||
        typeof durableV2Runtime.confirmRunnerClosed !== 'function' ||
        typeof durableV2Runtime.commitClosedRunnerSession !== 'function' ||
        typeof durableV2Payloads.preflight !== 'function' ||
        typeof durableV2Payloads.attach !== 'function' ||
        typeof durableV2StartTurn !== 'function' ||
        !sync(durableV2ApplyLocalEffect) || !sync(durableV2VerifyRunnerClosed) ||
        !sync(durableV2AssertWriterLock) ||
        typeof durableV2Journal?.snapshot !== 'function' ||
        typeof store?.getSession !== 'function' ||
        typeof store?.getSessionStats !== 'function' ||
        typeof store?.setSessionAtomic !== 'function' ||
        durableV2NormalRoute !== true || typeof durableV2StreamFrames !== 'boolean' ||
        durableV2AcquireCapacity !== null && typeof durableV2AcquireCapacity !== 'function' ||
        durableV2SealCapacity !== null && !sync(durableV2SealCapacity) ||
        durableV2SwitchProvider !== null && !sync(durableV2SwitchProvider) ||
        durableV2SetBrain !== null && !sync(durableV2SetBrain) ||
        durableV2ModelCatalog !== null && typeof durableV2ModelCatalog !== 'function' ||
        durableV2ModelCard !== null && !sync(durableV2ModelCard) ||
        durableV2UsageProbe !== null && typeof durableV2UsageProbe !== 'function' ||
        durableV2Issues !== null && typeof durableV2Issues?.add !== 'function' ||
        typeof durableV2Version !== 'string' ||
        durableV2CompactSession !== null && typeof durableV2CompactSession !== 'function' ||
        durableV2CapacitySnapshot !== null && !sync(durableV2CapacitySnapshot)) {
      throw new TypeError('dedicated Engine requires complete durable v2 authority')
    }
    Object.assign(this, { cfg, store, log, durableV2Runtime, durableV2Payloads,
      durableV2StartTurn, durableV2ApplyLocalEffect, durableV2VerifyRunnerClosed,
      durableV2AssertWriterLock, durableV2Journal, durableV2NormalRoute,
      durableV2StreamFrames, durableV2AcquireCapacity, durableV2SealCapacity,
      durableV2SwitchProvider, durableV2SetBrain, durableV2ModelCatalog, durableV2ModelCard,
      durableV2UsageProbe, durableV2Issues, durableV2Version,
      durableV2DataDir, durableV2ConsoleEnabled, durableV2CompactSession, durableV2CapacitySnapshot })
    this.projectMemory = options.projectMemory || null
    this.repoInfo = options.repoInfo || null
    this.activity = options.activity || null
    this.tz = normalizeTz(cfg.timezone)
    this.rts = new Map()
  }

  // Read-only diagnostics must never change admission, delivery or settlement.
  _observeActivity(method, value) {
    try { this.activity?.[method]?.(value) }
    catch { this.log('Activity display update unavailable') }
  }

  shutdown() {
    this.durableV2Runtime.close()
    this._closing = true // 关停中不再起空闲整理
    let aborted = 0
    for (const rt of this.rts.values()) {
      rt.v2AdmissionController?.abort()
      this._stopIdleCompact(rt, '关停', { force: true }) // 整理一并停掉(不等压缩边界),不算被打断的轮次(它没有收据)
      if (rt.v2Controller) {
        try { rt.v2Controller.abort() } catch {}
        aborted++
      }
    }
    return aborted
  }

drain(timeoutMs = 12_000) { return this.drainDurableV2(timeoutMs) }

async drainDurableV2(timeoutMs = 12_000) {
    if (!this.durableV2Runtime || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('C2 v2 runner drain needs an exact timeout')
    }
    const active = [...this.rts.values()]
    if (active.some(rt => rt.v2NormalRouteFailure)) return false
    const runs = active.filter(rt => rt.v2RunnerStopPromise || rt.v2Controller)
    const routes = active.filter(rt => rt.v2NormalRouteActive)
    const compacting = active.filter(rt => rt.v2Compacting?.exited)
    if (!runs.length && !routes.length && !compacting.length) return true
    if (runs.some(rt => !rt.v2RunnerStopPromise) ||
        routes.some(rt => !rt.v2NormalRoutePromise)) return false
    let timer
    try {
      const results = await Promise.race([
        Promise.all([...runs.map(rt => rt.v2RunnerStopPromise),
          ...routes.map(rt => rt.v2NormalRoutePromise),
          ...compacting.map(rt => rt.v2Compacting.exited.then(closed => closed === true, () => false))]),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) }),
      ])
      return Array.isArray(results) && results.every(value => value === true)
    } finally { if (timer) clearTimeout(timer) }
  }

durableV2ActiveFaultProofs(activeTurns) {
    const journal = this.durableV2Journal
    const runtime = this.durableV2Runtime
    if (!runtime || !journal || !Array.isArray(activeTurns) ||
        activeTurns.length === 0 || activeTurns.length > 32 ||
        !isDeepStrictEqual(runtime.snapshot(), journal.snapshot())) return null
    const snapshot = journal.snapshot()
    const lanes = snapshot.state.lanes
    const expected = []
    for (const chatId of new Set([
      ...Object.keys(lanes.turn || {}), ...Object.keys(lanes.handoff || {}),
      ...Object.keys(lanes.lifecycle || {}),
    ])) {
      const turn = lanes.turn?.[chatId]
      const handoff = lanes.handoff?.[chatId]
      const lifecycle = lanes.lifecycle?.[chatId]
      if (turn?.active != null || handoff?.phase && handoff.phase !== 'idle' ||
          lifecycle?.busy === true || lifecycle?.controller === true) {
        expected.push({ chatId, turnToken: turn?.active ?? handoff?.turnToken ?? null })
      }
    }
    expected.sort((a, b) => a.chatId.localeCompare(b.chatId))
    if (!isDeepStrictEqual(activeTurns, expected)) return null
    const suppliedChats = new Set()
    const proofs = []
    for (const turn of activeTurns) {
      const chatId = turn?.chatId
      const turnToken = turn?.turnToken
      if (typeof chatId !== 'string' || !chatId || suppliedChats.has(chatId) ||
          !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
          snapshot.state.lanes.turn?.[chatId]?.active !== turnToken ||
          snapshot.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
          snapshot.state.lanes.handoff[chatId].turnToken !== turnToken) return null
      suppliedChats.add(chatId)
      const rt = this.rts.get(chatId)
      const binding = rt?.v2DispatchEffect
      const jobs = rt?.v2RunningJobs
      const receiptId = binding?.receiptIds?.[0]
      const generation = rt?.v2RunnerGeneration
      const closeEvidenceId = rt?.v2RunnerCloseEvidenceId
      const durable = closeEvidenceId && journal.lookupRunnerClosed(closeEvidenceId)
      const receipt = snapshot.receipts.pending.find(item => item.id === receiptId)
      const descriptor = binding?.effectId && journal.effectDescriptor(binding.effectId)
      if (!rt || rt.v2TurnToken !== turnToken ||
          rt.v2RunnerStopVerified !== true || rt.v2Controller ||
          binding?.type !== 'dispatch' || binding.turnToken !== turnToken ||
          !Array.isArray(binding.receiptIds) || binding.receiptIds.length !== 1 ||
          !/^[0-9a-f]{32}$/.test(receiptId || '') ||
          !/^[0-9a-f]{32}$/.test(generation || '') ||
          closeEvidenceId !==
            `sbot-c2-runner-closed-v1:${receiptId}:${generation}` ||
          !Array.isArray(jobs) || jobs.length !== 1 ||
          jobs[0]?.msg?._c2ReceiptId !== receiptId ||
          receipt?.chatId !== chatId || receipt.source !== 'message' ||
          jobs[0].msg.msgId !== receipt.sourceId ||
          durable?.receiptId !== receiptId || durable.chatId !== chatId ||
          durable.turnToken !== turnToken || durable.generation !== generation ||
          durable.dispatchEffectId !== binding.effectId ||
          descriptor?.domain !== 'atomicHandoff' || descriptor.type !== 'dispatch' ||
          descriptor.scope !== chatId || descriptor.receiptId !== receiptId ||
          descriptor.turnToken !== turnToken ||
          journal.effectStatus(binding.effectId) !== 'acked') return null
      proofs.push(Object.freeze({ chatId, receiptId, turnToken,
        runnerGeneration: generation, runnerClosed: true, closeEvidenceId }))
    }
    return Object.freeze(proofs)
  }

abortDurableV2FaultTurn(turn) {
    const chatId = turn?.chatId
    const turnToken = turn?.turnToken
    const rt = typeof chatId === 'string' ? this.rts.get(chatId) : null
    if (!this.durableV2Runtime || !rt ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        rt.v2TurnToken !== turnToken ||
        this.durableV2Journal?.snapshot().state.lanes.turn?.[chatId]?.active !== turnToken) {
      return false
    }
    if (rt.v2Controller) {
      try { rt.v2Controller.abort(); return true } catch { return false }
    }
    return this.durableV2ActiveFaultProofs([turn]) !== null
  }

_rt(chatId) {
    if (!this.rts.has(chatId)) this.rts.set(chatId, { chatId })
    return this.rts.get(chatId)
  }

baseSkillEnv(chatId) {
    const g = (this.cfg.groups || {})[chatId]
    const bin = releaseBinDir()
    return { ...(bin ? { PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter) } : {}),
      SBOT_RUNTIME_ENTRY: RUNTIME_ENTRY, SBOT_RUNTIME_VERSION: this.durableV2Version || '',
      ...(this.durableV2DataDir ? { SBOT_DATA_DIR: this.durableV2DataDir } : {}),
      SBOT_CHAT_ID: chatId, ...(g && g.platform ? { SBOT_PLATFORM: g.platform } : {}), TZ: this.tz, ...(this.cfg._path ? { SBOT_CONFIG: this.cfg._path } : {}), ...(this.uiLocalUrl ? { SBOT_UI_URL: this.uiLocalUrl } : {}) }
  }

_resolveGroup(chatId) {
    return (this.cfg.groups && this.cfg.groups[chatId]) || this.defaultGroup || null
  }

_resolveProvider(chatId, group) {
    const name = this.store.getProvider(chatId) || group.provider || this.cfg.defaultProvider
    return { name, provider: this.cfg.providers[name] }
  }

// The group's model and depth on the backend actually running (core/brain.js).
_brain(group, name, provider) {
    return groupBrain(group, name, provider, { defaultProvider: this.cfg.defaultProvider })
  }

// Chat commands are answered before any receipt, like /stop with nothing to
// stop: nothing enters the journal and each returns its single reply as an
// input rejection. Commands that reset a session need the group idle and its
// journal settled, and share the console's configuration writer.
_durableV2GroupBusy(chatId) {
    const rt = this.rts.get(chatId)
    const pending = this.durableV2Runtime.snapshot().receipts?.pending?.some(item => item.chatId === chatId)
    return !!(rt?.v2NormalRouteActive || rt?.v2AdmissionPending || rt?.v2Controller ||
      rt?.v2QueueReceiptIds?.length || pending)
  }

async _durableV2Command(msg, cmd, rest) {
    const reject = (reason, notice) =>
      rejectC2Input('C2 v2 chat command answered before receipt', { reason, notice })
    const group = this._resolveGroup(msg.chatId)
    if (!group || group.paused) return reject('unsupported-command', T.unsupportedCommandWithModel)
    const { name, provider } = this._resolveProvider(msg.chatId, group)
    const label = (n, p) => brainLabel(n, this._brain(group, n, p))
    if (cmd === '/model') return this._durableV2ModelCommand(msg, rest, group)
    if (cmd === '/help') {
      const isCodex = provider?.runner === 'codex'
      // Read-only exactly when the manifest tells the agent so, for either
      // runner; an unreadable policy reads as read-only.
      let readOnly = true
      try {
        readOnly = READ_ONLY_TIERS.includes(manifestPolicy(group.permissionMode, isCodex,
          group.allowedTools, group.disallowedTools).tier)
      } catch {}
      return reject('help', T.help({ project: projectName(group), model: label(name, provider),
        steer: followupEnabled(group, provider.runner), readOnly }))
    }
    if (cmd === '/status') {
      const rt = this.rts.get(msg.chatId)
      const queued = this.durableV2Runtime.snapshot().state?.lanes?.queue?.[msg.chatId]?.queue?.length || 0
      // "Running for long" is not "stuck": steps and the last activity tell them apart.
      const busy = !!rt?.v2NormalRouteActive
      const state = busy
        ? `运行中（已跑 ${humanDuration(Date.now() - (rt.v2StartedAt || Date.now()))}${rt.v2Steps ? ` · 已执行 ${rt.v2Steps} 步` : ''}${rt.v2AliveAt ? ` · 最近动静 ${humanDuration(Date.now() - rt.v2AliveAt)}前` : ''}）`
        : rt?.v2AdmissionPending ? '消息已登记，等待并发名额' : '空闲'
      return reject('status', T.status({ model: label(name, provider), project: projectName(group), state,
        doing: busy && Array.isArray(rt.v2Doing) ? rt.v2Doing : [], queue: queued,
        session: this.store.getSession(msg.chatId) ? '进行中（记着上下文）' : '未开始' }))
    }
    if (cmd === '/new') {
      if (this._durableV2GroupBusy(msg.chatId)) return reject('new-busy', T.newBusy)
      let locked = false
      try { locked = this.durableV2AssertWriterLock() === true } catch {}
      if (!locked) throw new Error('C2 v2 /new lost single-writer lock')
      const stopping = this._stopIdleCompact(this.rts.get(msg.chatId), '开新会话')
      if (stopping && await stopping !== true) return reject('new-busy', T.newBusy)
      if (this.durableV2AssertWriterLock() !== true || this._durableV2GroupBusy(msg.chatId)) return reject('new-busy', T.newBusy)
      this.store.resetSessionAndStats(msg.chatId)
      this.log(`/new: ${msg.chatId} (by ${msg.senderName || 'unknown'})`)
      return reject('new-session', T.freshSession)
    }
    if (cmd === '/hud') {
      const lines = []
      if (this.durableV2UsageProbe && provider) {
        let usage = null
        try { usage = await this.durableV2UsageProbe(name, provider) } catch {}
        const value = typeof usage === 'string' ? usage : usage?.value || null
        const supported = typeof usage === 'string' ? !!usage : !!usage && usage.supported !== false
        lines.push(value ? T.quotaShow(name, value) : supported ? T.quotaMiss(name) : T.quotaNone(name))
      }
      const stats = this.store.getSessionStats(msg.chatId)
      const session = this.store.getSession(msg.chatId)
      const hudRt = this.rts.get(msg.chatId)
      const idleAt = provider && provider.runner === 'claude' && this._idleCompactCapability(hudRt, name) === true
        ? idleCompactPlan({ threshold: this._idleCompactThreshold(provider), now: 0 }).at : 0
      lines.push(stats?.sessionId && stats.sessionId === session
        ? T.sessionLine(stats.turns, stats.ctx || 0, stats.in || 0,
          { idleAt, lastAt: stats.compactedAt ? fmtStamp(stats.compactedAt, this.tz).slice(-5) : '' }) : T.noSession)
      return reject('hud', lines.join('\n'))
    }
    if (cmd === '/issue') {
      if (!rest) return reject('issue-usage', T.issueUsage)
      let record = null
      try {
        record = this.durableV2Issues?.add({ chatId: msg.chatId, group: group.name || '',
          sender: msg.senderName || msg.userId || '', text: rest,
          version: this.durableV2Version || '', turn: null }) || null
      } catch (error) { this.log(`issue add failed: ${error?.message || String(error)}`) }
      return record ? reject('issue-logged', T.issueLogged(record.id)) : reject('issue-failed', T.issueFailed)
    }
    return reject('unsupported-command', T.unsupportedCommandWithModel)
  }

// /model: backend · model · thinking depth. Words are parsed exactly
// (core/modelcmd.js); the decision is _durableV2ApplyModel (shared with the
// model card) and the write goes through the console's configuration writer.
// Every change needs this group idle and settled; only a backend change
// starts a new conversation.
async _durableV2ModelCommand(msg, want, group) {
    const reject = (reason, notice) =>
      rejectC2Input('C2 v2 model command answered before receipt', { reason, notice })
    const { name, provider } = this._resolveProvider(msg.chatId, group)
    const names = this._modelNames()
    const words = String(want || '').split(/\s+/).map(w => w.trim()).filter(Boolean)
    if (!words.length) {
      const cat = await this._modelCatalog(name, provider)
      const cur = this._brain(group, name, provider)
      const o = this._modelOpts(names, name, cat, cur)
      const concrete = cat && Array.isArray(cat.models) ? cat.models.map(m => m.id) : []
      const exModel = concrete.find(c => (o.choices || []).includes(c) && c !== cur.model) || ''
      const text = T.modelInfo({ ...o, current: brainLabel(name, cur),
        exEffort: exEffortOf(o.efforts, cur.effort), exModel,
        exProvider: names.find(n => n !== name) || '' })
      // Feishu gets a tap-to-pick card; the text above is its fallback.
      let card = null
      if (this.durableV2ModelCard) {
        try { card = this.durableV2ModelCard(await this._modelPanel(msg.chatId, group, { issuedAt: Date.now() })) } catch (error) {
          this.log(`/model card not built: ${error?.message || String(error)}`)
        }
      }
      return rejectC2Input('C2 v2 model command answered before receipt', { reason: 'model-info', notice: text, card })
    }
    const sender = msg.senderName || msg.userId || 'unknown'
    const pw = parseModelWords(words, names)
    if (pw.error) {
      this._logModelReject(msg.chatId, words.join(' '), 'dup', sender)
      return reject('model-dup', T.modelDup(pw.error.what, pw.error.a, pw.error.b))
    }
    const out = await this._durableV2ApplyModel(msg.chatId, group, pw,
      { sender, said: words.join(' '), source: 'command' })
    const reason = out.kind === 'reject' ? `model-${out.reason}` : out.kind === 'model' ? 'model-changed' : `model-${out.kind}`
    return reject(reason, out.text)
  }

// The /model card's panel state (platform-neutral; Feishu draws it with
// src/platform/modelcard.js). "Current" is the backend actually running and
// this group's choice on it. The draft (p backend, m model, e depth) starts
// as the group's choice on that backend; unchosen items are filled with the
// catalog's recommendation, so the card always shows a concrete pick. A draft
// that differs from the current one gets a preview, which enables confirm.
async _modelPanel(chatId, group, extra = {}) {
    const { name, provider } = this._resolveProvider(chatId, group)
    const b = this._brain(group, name, provider)
    const current = brainLabel(name, b)
    const mode = extra.mode || 'edit'
    if (mode !== 'edit') return { mode, current: extra.current || current, receipt: extra.receipt, issuedAt: extra.issuedAt || 0 }
    const names = this._modelNames()
    const d0 = extra.draft || {}
    const known = extra.draft && names.includes(d0.p)
    const dp = known ? d0.p : name
    const dProv = this.cfg.providers[dp]
    const base = this._brain(group, dp, dProv)
    const third = !!(dProv && dProv.baseUrl)
    const draft = known ? { p: dp, m: String(d0.m || ''), e: String(d0.e || '') } : { p: dp, m: '', e: '' }
    const cat = await this._modelCatalog(dp, dProv)
    const rec = cat && cat.ok !== false && cat.recommended ? cat.recommended : null
    let model = null // null: a third-party endpoint, whose model is set in the console
    if (!draft.e) draft.e = base.effort || ''
    if (!cat || cat.models !== null) {
      const choices = cat && cat.ok !== false ? (cat.models || []).map(m => m.id) : []
      if (!draft.m && !third) draft.m = base.model || ''
      if (!draft.m && rec && rec.model) draft.m = rec.model
      const options = choices.map(v => ({ value: v, label: modelName(v) }))
      if (draft.m && !choices.includes(draft.m)) options.push({ value: draft.m, label: modelName(draft.m) })
      model = { options, selected: draft.m }
    } else draft.m = ''
    const dModel = draft.m || (third ? base.model : '')
    const listed = cat && Array.isArray(cat.models) ? cat.models.find(m => m.id === dModel) : null
    const noDepth = !!(listed && Array.isArray(listed.efforts) && !listed.efforts.length)
    const effList = cat && !noDepth ? effortsFor(cat, dModel) : []
    if (noDepth) draft.e = ''
    else if (!draft.e || (effList.length && !effList.includes(draft.e))) draft.e = cat ? recommendEffort(cat, dModel) : draft.e
    const dEffort = draft.e
    const efforts = effList.map(e => ({ value: e, label: e, selected: e === dEffort }))
    let preview = null
    if (dp !== name || dModel !== b.model || (dEffort || '') !== (b.effort || '')) {
      preview = { to: brainLabel(dp, { model: dModel, effort: dEffort }),
        note: dp !== name ? '换了后端 —— 会开新对话' : dModel !== b.model ? '换了型号 —— 接着当前对话' : '只调深度 —— 接着当前对话' }
    }
    return { mode, current, draft, preview, failover: '', quota: '',
      backends: names.map(n => ({ name: n, selected: n === dp })),
      model, efforts, issuedAt: extra.issuedAt || 0 }
  }

// A tap on the /model card. value = the callback value { f, v?, d, t },
// option = the dropdown choice, who = the operator's name.
//   f = p | m | e: change only the card's draft (nothing is written)
//   f = ok: apply the draft once through _durableV2ApplyModel → receipt card
//   f = x: close; nothing changes, the card turns grey in place
// Returns { toast?, state? }; state is drawn into a card that replaces this one.
async handleModelCard({ chatId, who = '', value = {}, option } = {}) {
    const group = this.cfg.groups && this.cfg.groups[chatId]
    if (!group) return { toast: { type: 'info', content: '这个群还没绑定项目' } }
    const issued = Number(value.t) || 0
    const now = Date.now()
    if (value.f === 'x') return { toast: { type: 'info', content: '已关闭 · 模型没变' }, state: await this._modelPanel(chatId, group, { mode: 'closed' }) }
    if (group.paused) return { toast: { type: 'warning', content: '本群已暂停 —— 恢复后再改' } }
    if (!issued || now - issued > MODEL_CARD_TTL_MS) {
      return { toast: { type: 'info', content: '这张卡已过期 —— 发 /model 重新打开' }, state: await this._modelPanel(chatId, group, { mode: 'expired' }) }
    }
    const d = value.d && typeof value.d === 'object' ? { p: String(value.d.p || ''), m: String(value.d.m || ''), e: String(value.d.e || '') } : null
    const norm = x => (x == null || x === MODEL_CARD_DEFAULT ? '' : String(x))
    if (value.f === 'p' || value.f === 'm' || value.f === 'e') {
      let draft = d
      if (value.f === 'p') draft = { p: norm(value.v), m: '', e: '' }
      else if (value.f === 'm') draft = { ...(d || {}), m: norm(option) }
      else draft = { ...(d || {}), e: norm(value.v) }
      return { state: await this._modelPanel(chatId, group, { draft, issuedAt: now }) }
    }
    if (value.f !== 'ok' || !d) return {}
    const by = String(who || '').trim() || '有人'
    const before = await this._modelPanel(chatId, group)
    const { name: curName } = this._resolveProvider(chatId, group)
    const target = d.p || curName
    const tb = this._brain(group, target, this.cfg.providers[target])
    const out = await this._durableV2ApplyModel(chatId, group, {
      provider: d.p && d.p !== curName ? d.p : undefined,
      model: d.m && d.m !== tb.model ? d.m : undefined,
      effort: d.e && d.e !== tb.effort ? d.e : undefined },
    { sender: by, said: `[模型卡] ${d.p}·${d.m || '-'}·${d.e || '-'}`, source: 'card' })
    if (out.kind === 'reject' && out.reason === 'busy') return { toast: { type: 'warning', content: '手头还有任务在跑 —— 等它做完再确认，或先发 /stop' } }
    if (out.kind === 'reject' || out.kind === 'failed') return { toast: { type: 'error', content: String(out.text || '').split('\n')[0].replace(/^⚠\s*/, '') } }
    const g2 = (this.cfg.groups && this.cfg.groups[chatId]) || group
    if (out.kind === 'same') return { toast: { type: 'info', content: '已经是这个了，没有变化' }, state: await this._modelPanel(chatId, g2, { issuedAt: now }) }
    const hm = fmtStamp(now, this.tz).slice(-5)
    const after = await this._modelPanel(chatId, g2)
    const how = out.kind === 'switched' ? '已开新对话' : '接着当前对话'
    return {
      toast: { type: 'success', content: `已改为 ${after.current} · ${how}` },
      state: { mode: 'receipt', current: after.current,
        receipt: { line: `${by} 改为 ${after.current} · ${how} · ${hm}`, before: `之前：${before.current}` } },
    }
  }

_modelNames() {
    return Object.entries(this.cfg.providers || {})
      .filter(([, p]) => p && !p.hidden && ['claude', 'codex'].includes(p.runner || 'claude'))
      .map(([n]) => n)
  }
async _modelCatalog(name, provider) {
    if (!this.durableV2ModelCatalog) return null
    try { return await this.durableV2ModelCatalog(name, provider) } catch { return null }
  }
_modelOpts(names, name, cat, brain) {
    return { names, name,
      choices: !cat ? undefined : cat.models === null ? null : cat.ok === false ? [] : modelChoices(cat),
      efforts: cat ? effortsFor(cat, brain && brain.model) : [] }
  }
_logModelReject(chatId, said, reason, sender) {
    this.log(`/model rejected: ${chatId} ${JSON.stringify(String(said || '')).slice(0, 80)} ${reason} (by ${sender})`)
  }

// pw = { provider?, model?, models?, effort? } from parseModelWords, or the
// model card's confirmed draft. Returns { kind, reason?, text, label?, after? }
// with kind ∈ reject | failed | same | switched | model | effort.
// Missing picks on the target backend are filled with the catalog's
// recommendation (fillPicks); a depth-only change never fills a model.
async _durableV2ApplyModel(chatId, group, pw, { sender = 'unknown', said = '', source = 'command' } = {}) {
    const reject = (reason, text) => { this._logModelReject(chatId, said, reason, sender); return { kind: 'reject', reason, text } }
    const { name, provider } = this._resolveProvider(chatId, group)
    const names = this._modelNames()
    const target = pw.provider || name
    // The card's draft comes back from the platform: accept only a listed backend.
    if (pw.provider && !names.includes(pw.provider)) return reject('unknown', T.modelUnknownWord(target, this._modelOpts(names, name, null, null)))
    const tProv = this.cfg.providers[target]
    const tBrain = this._brain(group, target, tProv)
    if (pw.model === '') pw = { ...pw, model: undefined }
    if (pw.effort === '') pw = { ...pw, effort: undefined }
    if (pw.models) {
      const mcat = await this._modelCatalog(target, tProv)
      const bad = pw.models.find(w => !resolveModel(w, mcat))
      if (bad) return reject('unknown', T.modelUnknownWord(bad, this._modelOpts(names, target, mcat, tBrain)))
      const ids = [...new Set(pw.models.map(w => resolveModel(w, mcat)))]
      if (ids.length > 1) return reject('dup', T.modelDup('型号', pw.models[0], pw.models[1]))
      pw = { ...pw, model: ids[0] }
      delete pw.models
    }
    const switching = target !== name
    const wantsBrain = pw.model !== undefined || pw.effort !== undefined
    const cat = wantsBrain || switching ? await this._modelCatalog(target, tProv) : null
    let model
    if (pw.model !== undefined) {
      if (cat && cat.models === null) return reject('unknown', T.modelUnknownWord(pw.model, this._modelOpts(names, target, cat, tBrain)))
      if (!cat || cat.ok === false) return reject('no-catalog', T.modelNoCatalog(target))
      model = resolveModel(pw.model, cat)
      if (!model) return reject('unknown', T.modelUnknownWord(pw.model, this._modelOpts(names, target, cat, tBrain)))
      if (model === tBrain.model) model = undefined
    }
    const f = fillPicks({ switching, model, effort: pw.effort, currentModel: tBrain.model,
      currentEffort: tBrain.effort, third: !!(tProv && tProv.baseUrl), cat })
    model = f.model
    const nextModel = model === undefined ? tBrain.model : model
    let effort
    if (pw.effort !== undefined) {
      const effs = cat ? effortsFor(cat, nextModel) : []
      const known = cat && cat.models && cat.models.find(m => m.id === nextModel)
      const unsupported = known && Array.isArray(known.efforts) && !known.efforts.length
      if (unsupported || (effs.length && !effs.includes(pw.effort))) {
        return reject('effort', T.modelEffortUnsupported(nextModel || target, pw.effort, unsupported ? [] : effs))
      }
      effort = pw.effort === tBrain.effort && model === undefined && !switching ? undefined : pw.effort
    } else effort = f.effort
    const current = brainLabel(name, this._brain(group, name, provider))
    if (!switching && model === undefined && effort === undefined) return { kind: 'same', text: T.modelSame(current), label: current }
    if (this._durableV2GroupBusy(chatId)) return reject('busy', T.modelBusy)
    const stopping = this._stopIdleCompact(this.rts.get(chatId), '会话已重置')
    if (stopping && await stopping !== true) return reject('busy', T.modelBusy)
    if (this.durableV2AssertWriterLock() !== true || this._durableV2GroupBusy(chatId)) return reject('busy', T.modelBusy)
    let r
    try {
      if (this.durableV2SetBrain) {
        r = this.durableV2SetBrain(chatId, { provider: switching ? target : undefined, model, effort },
          { by: sender, source })
      } else if (switching && model === undefined && effort === undefined) {
        this.durableV2SwitchProvider(chatId, target)
      } else throw new Error('Model and depth writer unavailable')
    } catch (error) {
      this.log(`/model failed for ${chatId} → ${target}: ${error?.message || String(error)}`)
      return { kind: 'failed', reason: 'failed',
        text: /settled|任务进行中|空闲/.test(error?.message || '') ? T.modelBusy : T.modelSwitchFailed }
    }
    const g2 = (this.cfg.groups && this.cfg.groups[chatId]) || group
    const after = r?.after || this._brain(g2, target, this.cfg.providers[target])
    const label = brainLabel(target, after)
    this.log(`/model: ${chatId} ${name}·${tBrain.model || '-'}·${tBrain.effort || '-'} → ${target}·${after.model || '-'}·${after.effort || '-'} (by ${sender}, ${source})`)
    const filled = f.filled.length ? f.filled.join('和') : ''
    if (switching) {
      let note = ''
      try {
        const opts = { full: group.permissionMode === 'bypassPermissions', isCodex: tProv?.runner === 'codex' }
        const h = this.projectMemory ? this.projectMemory(group.workdir, opts) : null
        if (h?.note) note = h.note
      } catch {}
      return { kind: 'switched', text: T.modelSwitched(label, note, filled), label, after }
    }
    if (r?.modelChanged) return { kind: 'model', text: T.modelChanged(label, filled), label, after }
    return { kind: 'effort', text: T.effortSwitched(after.effort, brainLabel(target, { model: after.model })), label, after }
  }

async runDurableV2Message(msg, platform) {
    if (msg?.text?.trim() === '/stop') {
      return this.runDurableV2Stop(msg, platform)
    }
    if (typeof msg?.text === 'string' && /^\/skip(?:\s|$)/.test(msg.text.trim())) {
      throw await this.runDurableV2Skip(msg)
    }
    if (!this.durableV2NormalRoute) {
      const error = new Error('C2 v2 normal route is closed: runner transcript, tool/stream effects, and terminal projection lack durable evidence')
      error.code = 'C2_V2_NORMAL_ROUTE_CLOSED'
      error.missingEvidence = [...V2_NORMAL_ROUTE_MISSING]
      throw error
    }
    const authority = this.durableV2Runtime
    const waiting = this.rts.get(msg?.chatId)
    while (waiting?.v2QueueNoticePromise) await waiting.v2QueueNoticePromise
    if (waiting?.v2StreamChain) await waiting.v2StreamChain
    if (waiting?.v2CardBinding?.opened) await waiting.v2CardBinding.path.flushForTerminal()
    if (!authority || authority.blocked ||
        !msg || typeof msg !== 'object' || msg.synthetic || msg.cron ||
        msg.polled || msg.wantsAck || msg.resetSessionAfter || msg.quiet ||
        msg.batch ||
        msg.receiptSource && msg.receiptSource !== 'message' ||
        typeof msg.text !== 'string' || !msg.text.trim() ||
        typeof msg.chatId !== 'string' || !msg.chatId ||
        typeof msg.msgId !== 'string' ||
        !/^om_[A-Za-z0-9_-]{1,124}$/.test(msg.msgId) ||
        !platform || platform.features?.cardQuota !== true ||
        typeof platform.reply !== 'function' ||
        typeof platform.replyOnce !== 'function' ||
        typeof platform.createStreamingCard !== 'function') {
      throw new Error('C2 v2 ordinary Feishu message is unsupported or closed')
    }
    // An unmigrated chat command is user input, not an authority fault. It is
    // refused before admission with no receipt; the service decides delivery.
    const command = /^(\/[a-z]+)(?:\s+([\s\S]*))?$/.exec(msg.text.trim())
    if (command && this.durableV2SwitchProvider && DURABLE_V2_COMMANDS.has(command[1])) {
      throw await this._durableV2Command(msg, command[1], (command[2] || '').trim())
    }
    if (msg.text.trim().startsWith('/')) {
      throw rejectC2Input('C2 v2 ordinary Feishu message is unsupported or closed',
        { reason: 'unsupported-command', notice: this.durableV2SwitchProvider
          ? T.unsupportedCommandWithModel : T.unsupportedCommand })
    }
    const group = this._resolveGroup(msg.chatId)
    const { provider } = group ? this._resolveProvider(msg.chatId, group) : {}
    if (!group || group.paused || group.platform && group.platform !== 'feishu' ||
        !provider || !['claude', 'codex'].includes(provider.runner)) {
      throw new Error('C2 v2 ordinary group control is not migrated')
    }
    let locked = false
    try { locked = this.durableV2AssertWriterLock() === true } catch {}
    if (!locked) {
      authority.close()
      throw new Error('C2 v2 ordinary route lost single-writer lock')
    }
    const rt = this._rt(msg.chatId)
    if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
    const before = authority.snapshot()
    const receiptId = taskId({ source: 'message', chatId: msg.chatId,
      sourceId: msg.msgId })
    if (before.receipts.pending.some(item => item.id === receiptId) ||
        before.receipts.completed.some(item => item.id === receiptId)) {
      const duplicate = this.stageDurableV2Message(msg, platform)
      return { receiptId, duplicate: true, staged: false,
        ingressClosed: duplicate.ingressClosed }
    }
    if (rt.v2StopControl || before.state.lanes.stopIntent?.[msg.chatId]) {
      throw rejectC2Input('C2 v2 ordinary route is waiting for stop acknowledgement',
        { reason: 'stop-pending', notice: T.stopPending })
    }
    // Between /skip and its durable cancellation the runner may already be
    // closed; refuse before receipt instead of reaching the closed busy route.
    if (rt.v2SkipWaiter) {
      throw rejectC2Input('C2 v2 ordinary route is waiting for /skip to settle',
        { reason: 'skip-pending', notice: T.skipPending })
    }
    const lane = before.state?.lanes
    const queue = lane?.queue?.[msg.chatId]?.queue
    if (rt.v2AdmissionPending) {
      if (!Array.isArray(queue) || !queue.length || rt.v2RunningJobs ||
          lane?.turn?.[msg.chatId]?.active != null ||
          lane?.handoff?.[msg.chatId]?.phase === 'running') {
        authority.close()
        throw new Error('C2 capacity wait differs from durable queued authority')
      }
      this.durableV2Payloads.auditOrdinaryQueue(msg.chatId, rt.v2QueueReceiptIds || [])
      const queued = this.stageDurableV2Message(msg, platform)
      // Preserve even the overflow source receipt, then seal rather than drop
      // an acknowledged platform message or run an unbounded in-memory queue.
      if (queue.length >= 3) {
        authority.close()
        throw new Error('C2 capacity wait queue exceeded its bound; receipts preserved')
      }
      return { receiptId: queued.receiptId, queued: true, staged: queued.staged,
        waitingForCapacity: true, ingressClosed: !!authority.blocked }
    }
    const busy = lane?.turn?.[msg.chatId]?.active != null ||
      lane?.handoff?.[msg.chatId]?.phase === 'running' ||
      Array.isArray(queue) && queue.length > 0 ||
      rt.v2RunningJobs || rt.v2QueueReceiptIds?.length
    if (busy && rt.v2FollowupEnabled &&
        rt.v2SteerControl && rt.v2NormalRouteActive && !rt.v2RunnerStopVerified &&
        !rt.v2TerminalStarted && !rt.v2StreamQuiescing && rt.v2Controller &&
        !rt.v2Controller.signal.aborted && !rt.v2SteerClosing) {
      this.durableV2Payloads.auditOrdinaryQueue(msg.chatId, rt.v2QueueReceiptIds || [])
      const queued = this.stageDurableV2Message(msg, platform)
      return this._runDurableV2Steer(rt, queued.receiptId)
    }
    if (busy && rt.v2NormalRouteActive &&
        lane?.turn?.[msg.chatId]?.active === rt.v2TurnToken &&
        lane?.handoff?.[msg.chatId]?.phase === 'running' &&
        rt.v2DispatchEffect?.type === 'dispatch' &&
        rt.v2RunningJobs?.length === 1 &&
        rt.v2RunnerStopVerified !== true &&
        Array.isArray(queue) && queue.length < 2 &&
        queue.every(item => !item.batch &&
          /^receipt:job:[0-9a-f]{32}$/.test(item.id)) &&
        queue.every(item => [...before.effects].some(([effectId, status]) => {
          const descriptor = this.durableV2Journal.effectDescriptor(effectId)
          return status === 'acked' && descriptor?.type === 'queueNotice' &&
            descriptor.receiptId === item.id.slice('receipt:job:'.length)
        })) &&
        isDeepStrictEqual(queue.map(item => item.id.slice('receipt:job:'.length)),
          rt.v2QueueReceiptIds || []) &&
        isDeepStrictEqual(this.durableV2Journal.snapshot(), before)) {
      try { this.durableV2Payloads.auditOrdinaryQueue(msg.chatId,
        rt.v2QueueReceiptIds || []) }
      catch (error) { authority.close(); throw error }
      const queued = this.stageDurableV2Message(msg, platform)
      let attached
      try { attached = this.durableV2Payloads.requireQueued(queued.receiptId) }
      catch (error) { authority.close(); throw error }
      if (!queued.staged || queued.duplicate ||
          attached?.msg?._c2ReceiptId !== queued.receiptId) {
        authority.close()
        throw new Error('C2 v2 queued follow-up lacks exact payload handle')
      }
      try { this.durableV2Payloads.auditOrdinaryQueue(msg.chatId,
        rt.v2QueueReceiptIds) }
      catch (error) { authority.close(); throw error }
      const notice = authority.prepareQueueNotice({ receiptId: queued.receiptId,
        chatId: msg.chatId, payloadHandles: this.durableV2Payloads })
      const noticePromise = authority.executeQueueNotice({
        effectId: notice.effectId, receiptId: queued.receiptId, chatId: msg.chatId,
        payloadHandles: this.durableV2Payloads,
        assertWriterLock: this.durableV2AssertWriterLock,
        perform: ({ target }) => platform.replyOnce(target, T.queued(notice.visibleQueue)),
        confirm: response => response?.code === 0 &&
          /^om_[A-Za-z0-9_-]{1,124}$/.test(response?.data?.message_id || ''),
      })
      rt.v2QueueNoticePromise = noticePromise
      try { await noticePromise } finally {
        if (rt.v2QueueNoticePromise === noticePromise) rt.v2QueueNoticePromise = null
      }
      return { receiptId: queued.receiptId, queued: true, staged: true,
        ingressClosed: !!authority.blocked }
    }
    if (busy) {
      if (rt.v2NormalRouteActive && Array.isArray(queue) && queue.length > 0) {
        try { this.durableV2Payloads.auditOrdinaryQueue(msg.chatId,
          rt.v2QueueReceiptIds || []) }
        catch (error) { authority.close(); throw error }
      }
      if (!rt.v2NormalRouteActive || !Array.isArray(queue) || queue.length === 0) {
        authority.close()
      }
      const error = new Error('C2 v2 busy follow-up route is not migrated')
      error.code = 'C2_V2_BUSY_ROUTE_CLOSED'
      throw error
    }
    const accepted = this.stageDurableV2Message(msg, platform)
    if (!accepted.staged || accepted.duplicate) {
      authority.close()
      throw new Error('C2 v2 ordinary receipt admission changed')
    }
    rt.v2NormalRouteActive = true
    const execute = async () => {
      let release = null
      let failed = false
      try {
        // 空闲整理不占群锁:收据已登记,起轮前先停掉整理并等它退出(同一个会话文件不能两个进程同时写)。
        // 等待期间按「等并发名额」对外:后到的消息走 waitingForCapacity 那一支排队,而不是撞上已关闭的忙时路由。
        if (rt.v2Compacting && !(await this._awaitIdleCompactStop(rt))) {
          this._observeActivity('unknown', { chatId: msg.chatId })
          return { receiptId: accepted.receiptId, status: 'interruptedBeforeDispatch',
            queued: true, ingressClosed: true }
        }
        let receiptId = accepted.receiptId
        if (this.durableV2AcquireCapacity) {
          const controller = new AbortController()
          rt.v2AdmissionController = controller
          rt.v2AdmissionPending = true
          try {
            release = await this.durableV2AcquireCapacity({ signal: controller.signal })
          } catch (error) {
            if (controller.signal.aborted && !rt.v2DispatchEffect &&
                error?.code === 'C2_CAPACITY_WAIT_CANCELLED') {
              this._observeActivity('unknown', { chatId: msg.chatId })
              return { receiptId, status: 'interruptedBeforeDispatch',
                queued: true, ingressClosed: true }
            }
            throw error
          }
          if (typeof release !== 'function' || controller.signal.aborted ||
              authority.blocked || this.durableV2AssertWriterLock() !== true) {
            throw new Error('C2 capacity permit lost before durable dispatch')
          }
          rt.v2AdmissionPending = false
          const queued = authority.snapshot().state.lanes.queue?.[msg.chatId]?.queue
          this.durableV2Payloads.auditOrdinaryQueue(msg.chatId, rt.v2QueueReceiptIds || [])
          receiptId = v2QueueSelection(queued).anchor
        }
        const dispatched = this.commitDurableV2InitialDispatch({ chatId: msg.chatId, receiptId })
        return await this._drainDurableV2NormalChain({ chatId: msg.chatId, receiptId,
          turnToken: dispatched.turnToken, effectId: dispatched.effectsPending?.[0] })
      } catch (error) {
        // Seal shared grants before releasing this turn's permit. Waiting
        // siblings must not dispatch in the microtask before the service sees
        // this rejection and begins its process-wide stop.
        failed = true
        this._observeActivity('unknown', { chatId: msg.chatId })
        this.durableV2SealCapacity?.(error)
        throw error
      } finally {
        rt.v2AdmissionPending = false
        rt.v2AdmissionController = null
        if (release) this._releaseDurableV2Capacity(rt, release, failed)
      }
    }
    const execution = execute()
    rt.v2NormalRoutePromise = execution.then(() => true, () => {
      rt.v2NormalRouteFailure = true
      return false
    })
    let outcome = null
    try {
      outcome = await execution
      return outcome
    } finally {
      rt.v2NormalRouteActive = false
      rt.v2NormalRoutePromise = null
      // 群已空闲、槽已还:看这一轮要不要接一次空闲整理(同步判定,起跑后才异步)。
      this._maybeIdleCompact(rt, outcome?.status)
    }
  }

// A failed route returns its shared model permit only once its runner is
// proven closed or proven never started. Otherwise the permit stays taken
// until the process exits, so a sibling group never runs beside a child that
// may still be alive.
_releaseDurableV2Capacity(rt, release, failed) {
    const closed = () => !rt.v2Controller && (rt.v2RunnerStopVerified === true ||
      rt.v2RunnerNotStarted === true)
    const stop = rt.v2RunnerStopPromise
    if (!failed || !rt.v2Controller && (!stop || closed())) return release()
    const kept = () => this.log(`group ${rt.chatId}: model permit kept until restart; runner close unproven`)
    if (!stop) return kept()
    stop.then(() => {
      if (!closed()) return kept()
      // A failed binary release closes the shared capacity itself.
      try { release() } catch (error) { this.log(`group ${rt.chatId}: model permit release failed: ${error.message}`) }
    }, kept)
  }

async _runDurableV2Steer(rt, receiptId) {
    const authority = this.durableV2Runtime
    const chatId = rt.chatId
    const job = this.durableV2Payloads.requireQueued(receiptId)
    const identity = authority.prepareSteer({ receiptId, chatId,
      parentReceiptId: rt.v2DispatchEffect.receiptIds.at(-1),
      turnToken: rt.v2TurnToken, generation: rt.v2RunnerGeneration,
      payloadHandles: this.durableV2Payloads })
    this.durableV2Payloads.takeSteer(receiptId, chatId, identity.effectId)
    rt.v2QueueReceiptIds = authority.scopeState('queue', chatId).queue
      .map(item => item.id.slice('receipt:job:'.length))
    const entry = { identity, job, landed: false, accepted: false }
    rt.v2SteerEntries.set(receiptId, entry)
    const control = rt.v2SteerControl
    const work = (async () => {
      const text = `[${fmtStamp(job.msg.createTimeMs || Date.now(), this.tz)} ${job.msg.senderName || job.msg.userId || 'user'}] [群里新消息：关联当前任务就立即调整；独立任务先完成当前任务再处理，并分别回应] ${job.msg.text.trim()}`
      const accepted = await authority.executeSteer(identity, {
        assertWriterLock: this.durableV2AssertWriterLock,
        invoke: () => control.steerDurable({ msgId: job.msg.msgId, text }) })
      entry.accepted = accepted
      if (accepted) {
        try { this.activity?.merge(chatId, identity.parentReceiptId, [receiptId], entry.landed ? 'landed' : 'accepted') } catch {}
        if (entry.landed) {
          authority.commitSteerObservation({ ...identity, type: 'landed' })
        }
        return { receiptId, steered: true, accepted: true, landed: entry.landed, staged: true }
      }
      if (entry.landed) throw new Error('C2 rejected steer also landed; outcome inconsistent')
      rt.v2SteerEntries.delete(receiptId)
      this.durableV2Payloads.attach(receiptId, job)
      rt.v2QueueReceiptIds = authority.scopeState('queue', chatId).queue
        .map(item => item.id.slice('receipt:job:'.length))
      // A prior readiness-wait queue notice is already acknowledged.
      const priorNotice = [...authority.snapshot().effects].some(([id, status]) =>
        status === 'acked' && this.durableV2Journal.effectDescriptor(id)?.type === 'queueNotice' &&
        this.durableV2Journal.effectDescriptor(id)?.receiptId === receiptId)
      if (!priorNotice) {
        const notice = authority.prepareQueueNotice({ receiptId, chatId, payloadHandles: this.durableV2Payloads })
        await authority.executeQueueNotice({ ...notice, payloadHandles: this.durableV2Payloads,
          assertWriterLock: this.durableV2AssertWriterLock,
          perform: ({ target }) => job.platform.replyOnce(target, T.queued(notice.visibleQueue)),
          confirm: response => response?.code === 0 && /^om_[A-Za-z0-9_-]{1,124}$/.test(response?.data?.message_id || '') })
      }
      return { receiptId, queued: true, staged: true, accepted: false }
    })()
    rt.v2QueueNoticePromise = work
    let outcome
    try { outcome = await work }
    catch (error) { authority.close(); rt.v2Controller?.abort(); this.durableV2SealCapacity?.(error); throw error }
    finally { if (rt.v2QueueNoticePromise === work) rt.v2QueueNoticePromise = null }
    try {
      if (outcome.accepted && entry.landed) {
        await rt.v2SteerLandedChain
        await rt.v2MoveCard?.(entry)
      }
      return outcome
    } catch (error) {
      authority.close(); rt.v2Controller?.abort(); this.durableV2SealCapacity?.(error)
      throw error
    }
  }

async runDurableV2Stop(msg, platform) {
    const authority = this.durableV2Runtime
    const chatId = msg?.chatId
    const rt = this.rts.get(chatId)
    if (!this.durableV2NormalRoute || !authority ||
        !msg || msg.synthetic || msg.cron || msg.polled || msg.quiet ||
        msg.wantsAck || msg.batch || msg.text?.trim() !== '/stop' ||
        typeof chatId !== 'string' || !chatId ||
        typeof msg.msgId !== 'string' ||
        !/^om_[A-Za-z0-9_-]{1,124}$/.test(msg.msgId) ||
        msg.replyCtx?.chatId !== chatId ||
        msg.replyCtx?.messageId !== msg.msgId ||
        typeof platform?.replyOnce !== 'function') {
      throw new Error('C2 v2 /stop is unsupported or closed')
    }
    if (!rt?.v2NormalRouteActive || !rt.v2RunningJobs?.length ||
        !rt.v2Controller || rt.v2TerminalStarted ||
        rt.v2CancelControl || rt.v2StopControl || rt.v2StreamQuiescing ||
        rt.v2TimeoutProof) {
      throw durableV2StopUnavailable(rt)
    }
    const group = this._resolveGroup(chatId)
    if (!group || group.paused || group.platform && group.platform !== 'feishu') {
      throw new Error('C2 v2 /stop group control is not migrated')
    }
    const requestedGeneration = rt.v2RunnerGeneration
    const requestedTurnToken = rt.v2TurnToken
    // A busy receipt may already be sending its durable queue notice. Keep
    // that external effect and the stop intent ordered: otherwise the notice
    // can become unknown while the stop transition clears its target queue.
    if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
    if (!rt.v2NormalRouteActive ||
        !rt.v2RunningJobs?.length || !rt.v2Controller ||
        rt.v2TerminalStarted || rt.v2CancelControl || rt.v2StopControl ||
        rt.v2StreamQuiescing || rt.v2TimeoutProof ||
        rt.v2RunnerGeneration !== requestedGeneration ||
        rt.v2TurnToken !== requestedTurnToken) {
      throw durableV2StopUnavailable(rt)
    }
    const before = authority.snapshot()
    const controlReceipt = { source: 'message', chatId, sourceId: msg.msgId,
      acceptedAt: Date.now(), quiet: false }
    controlReceipt.id = taskId(controlReceipt)
    const runningReceiptId = rt.v2DispatchEffect?.receiptIds?.at(-1)
    const cohort = ordinaryV2Cohort(before, rt.v2RunningJobs,
      rt.v2DispatchEffect, chatId, runningReceiptId)
    const generation = rt.v2RunnerGeneration
    const turnToken = rt.v2TurnToken
    const queue = before.state.lanes.queue?.[chatId]?.queue
    const queuedReceiptIds = queue?.map(item => item.id.slice('receipt:job:'.length))
    if (!cohort || !/^[0-9a-f]{32}$/.test(runningReceiptId || '') ||
        !/^[0-9a-f]{32}$/.test(generation || '') ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        !Array.isArray(queue) || queue.some(item => item.batch || item.synthetic ||
          item.quiet || item.polled ||
          !/^receipt:job:[0-9a-f]{32}$/.test(item.id) ||
          before.receipts.pending.find(receipt =>
            receipt.id === item.id.slice('receipt:job:'.length))?.source !== 'message' ||
          ![...before.effects].some(([effectId, status]) => {
            const descriptor = this.durableV2Journal.effectDescriptor(effectId)
            return status === 'acked' && descriptor?.type === 'queueNotice' &&
              descriptor.receiptId === item.id.slice('receipt:job:'.length)
          })) ||
        !isDeepStrictEqual(queuedReceiptIds, rt.v2QueueReceiptIds || []) ||
        before.state.lanes.turn?.[chatId]?.active !== turnToken ||
        before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
        before.receipts.pending.find(item => item.id === runningReceiptId)?.sourceId !==
          cohort.anchor.msg.msgId ||
        before.receipts.pending.some(item => item.id === controlReceipt.id) ||
        before.receipts.completed.some(item => item.id === controlReceipt.id)) {
      authority.close()
      throw new Error('C2 v2 /stop differs from durable running turn')
    }
    try { this.durableV2Payloads.auditOrdinaryQueue(chatId,
      queuedReceiptIds) }
    catch (error) { authority.close(); throw error }
    let releaseIntentGate = null
    try {
      // Stop admitting process frames, then drain any already prepared card
      // calls before persisting the stop count and aborting the child.
      rt.v2StreamQuiescing = true
      rt.v2StopIntentGate = new Promise(resolve => { releaseIntentGate = resolve })
      try {
        await rt.v2StreamChain
        if (rt.v2CardBinding?.opened) {
          await rt.v2CardBinding.path.flushForTerminal()
        }
        if (authority.blocked || rt.v2CancelControl || rt.v2TerminalStarted ||
            rt.v2RunnerGeneration !== generation || rt.v2TurnToken !== turnToken) {
          throw new Error('C2 v2 /stop card drain lost running turn')
        }
      } catch (error) {
        releaseIntentGate()
        throw error
      }
      if (this.durableV2AssertWriterLock() !== true) throw new Error('writer lock lost')
      const cardTarget = rt.v2CardBinding?.opened
        ? rt.v2CardBinding.path.cancellationTarget() : null
      authority.commitStopIntent({ controlReceipt, runningReceiptId, chatId,
        turnToken, generation, cardTarget,
        assertWriterLock: this.durableV2AssertWriterLock })
      rt.v2StopControl = { controlReceiptId: controlReceipt.id, runningReceiptId,
        turnToken, generation, runningReceiptIds: cohort.receiptIds,
        queuedReceiptIds,
        target: { receiptId: controlReceipt.id, chatId,
          sourceId: msg.msgId, replyCtx: msg.replyCtx },
        platform }
      rt.v2CancelControl = 'stop'
      rt.v2Controller.abort()
      releaseIntentGate()
      const completed = await rt.v2NormalRoutePromise
      if (completed !== true || authority.blocked ||
          !authority.snapshot().receipts.completed.some(item =>
            item.id === controlReceipt.id)) {
        throw new Error('C2 v2 /stop acknowledgement was not durably settled')
      }
      return { status: 'stopped', controlReceiptId: controlReceipt.id,
        cancelledReceiptIds: [...cohort.receiptIds, ...queuedReceiptIds] }
    } catch (error) {
      releaseIntentGate?.()
      rt.v2StopIntentGate = null
      try { rt.v2Controller?.abort() } catch {}
      authority.close(); throw error
    }
  }

// /skip cancels only the running turn, through the same durable cancellation
// as the console stop: queued receipts stay queued and run next, and the
// session is kept. Like the other chat commands it gets no receipt and is
// answered as an input rejection, here only after the cancellation has
// committed. That reply is best effort: the durable stop acknowledgement
// exists only for /stop, whose transition empties the queue.
async runDurableV2Skip(msg) {
    const authority = this.durableV2Runtime
    const chatId = msg?.chatId
    if (!this.durableV2NormalRoute || !authority ||
        !msg || msg.synthetic || msg.cron || msg.polled || msg.quiet ||
        msg.wantsAck || msg.batch ||
        typeof chatId !== 'string' || !chatId ||
        typeof msg.msgId !== 'string' ||
        !/^om_[A-Za-z0-9_-]{1,124}$/.test(msg.msgId) ||
        msg.replyCtx?.chatId !== chatId ||
        msg.replyCtx?.messageId !== msg.msgId) {
      throw new Error('C2 v2 /skip is unsupported or closed')
    }
    const group = this._resolveGroup(chatId)
    if (!group || group.paused || group.platform && group.platform !== 'feishu') {
      throw new Error('C2 v2 /skip group control is not migrated')
    }
    // As for /stop, a /skip with nothing it may cancel is refused before receipt.
    const reject = (reason, notice) => rejectC2Input(reason === 'skipped'
      ? 'C2 v2 /skip answered after durable cancellation'
      : 'C2 v2 /skip is unsupported or closed', { reason, notice })
    // Without a receipt nothing durable dedupes this command, so a platform
    // redelivery must not cancel a later task: a repeat this process has seen
    // is dropped silently, and so is a /skip sent before the newest message of
    // the running task (both are platform times).
    const seen = this.durableV2SkipSeen || (this.durableV2SkipSeen = new Set())
    const key = `${chatId}\n${msg.msgId}`
    if (seen.has(key)) return reject('skip-duplicate', null)
    seen.add(key)
    if (seen.size > 256) seen.delete(seen.values().next().value)
    const rt = this.rts.get(chatId)
    if (!rt?.v2NormalRouteActive || !rt.v2RunningJobs?.length) {
      return reject('skip-idle', T.noActiveTask)
    }
    const sentAt = Number(msg.createTimeMs)
    if (Number.isSafeInteger(sentAt) && sentAt > 0 && rt.v2RunningJobs.some(job =>
      Number(job?.msg?.createTimeMs) > sentAt)) {
      return reject('skip-stale', null)
    }
    const route = rt.v2NormalRoutePromise
    let settle
    const settled = new Promise(resolve => { settle = resolve })
    const waiter = { turnToken: rt.v2TurnToken, settle }
    if (rt.v2SkipWaiter || !route || !Number.isSafeInteger(waiter.turnToken)) {
      return reject('skip-unavailable', T.skipUnavailable)
    }
    rt.v2SkipWaiter = waiter
    try {
      if (!this.requestDurableV2Stop(chatId)) {
        if (authority.blocked) throw new Error('C2 v2 /skip closed its durable authority')
        return reject('skip-unavailable', T.skipUnavailable)
      }
      const queued = await Promise.race([settled, route.then(() => null)])
      if (queued === null) {
        // The turn ended without this cancellation, e.g. its runner was proven
        // never started. Nothing was skipped and the group is not at fault;
        // only a closed authority is.
        if (authority.blocked) throw new Error('C2 v2 /skip cancellation was not durably settled')
        return reject('skip-unavailable', T.skipUnavailable)
      }
      this.log(`/skip: ${chatId} (by ${msg.senderName || 'unknown'}), ${queued} queued`)
      return reject('skipped', T.skipped(queued))
    } finally {
      if (rt.v2SkipWaiter === waiter) rt.v2SkipWaiter = null
    }
  }

async _cleanupDurableV2CancelledCard(rt, identity, generation,
    verifyGeneration) {
    if (!rt.v2CardBinding?.opened) return null
    const authority = this.durableV2Runtime
    const binding = rt.v2CardBinding
    if (binding.receiptId !== identity.receiptId ||
        binding.turnToken !== identity.turnToken ||
        binding.generation !== generation) {
      authority.close()
      throw new Error('C2 v2 cancellation card differs from running turn')
    }
    const cleanupBase = { receiptId: identity.receiptId,
      chatId: identity.chatId, turnToken: identity.turnToken, generation,
      verifyGeneration, assertWriterLock: this.durableV2AssertWriterLock }
    const intent = authority.commitCardCleanupIntent({ ...cleanupBase,
      target: binding.path.cancellationTarget() })
    if (await binding.path.recallForCancellation() !== true) {
      authority.close()
      throw new Error('C2 v2 cancellation card delete unconfirmed')
    }
    return authority.commitCardCleanupConfirmed({ ...cleanupBase,
      target: binding.path.cancellationTarget(), proof: intent })
  }

async _drainDurableV2NormalChain(initial) {
    const authority = this.durableV2Runtime
    const firstReceiptId = initial.receiptId
    const settled = []
    let identity = initial
    while (identity) {
      let locked = false
      try { locked = this.durableV2AssertWriterLock() === true } catch {}
      if (!locked) {
        authority.close()
        throw new Error('C2 v2 ordinary route lost single-writer lock before runner')
      }
      const started = await this.startDurableV2Runner(identity)
      if (started.startFailureRecovered === true) {
        this._observeActivity('finish', { ...identity, status: 'not-started', err: '任务未启动，已通知群内' })
        settled.push({ receiptId: identity.receiptId, status: 'startupNotified' })
        return { receiptId: firstReceiptId, status: settled[0].status,
          settledReceiptIds: settled.map(item => item.receiptId),
          ingressClosed: authority.blocked }
      }
      const rt = this._rt(identity.chatId)
      if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
      if (rt.v2CancelControl === 'recall' || rt.v2CancelControl === 'stop') {
        const control = rt.v2CancelControl
        const generation = rt.v2RunnerGeneration
        if (rt.v2RunnerStopVerified !== true ||
            rt.v2RunnerCloseEvidenceId !==
              `sbot-c2-runner-closed-v1:${identity.receiptId}:${generation}` ||
            rt.v2SessionCloseEventId !==
              `sbot-c2-session-close-v1:${identity.receiptId}:${generation}` ||
            typeof authority.commitRunningCancellation !== 'function') {
          authority.close()
          throw new Error('C2 v2 cancelled runner lacks durable close proof')
        }
        const verifyGeneration = value => value.chatId === identity.chatId &&
          value.receiptId === identity.receiptId &&
          value.turnToken === identity.turnToken &&
          value.generation === generation && rt.v2RunnerGeneration === generation
        const cardCleanup = await this._cleanupDurableV2CancelledCard(
          rt, identity, generation, verifyGeneration)
        const stop = control === 'stop' ? rt.v2StopControl : null
        const cancelled = stop
          ? authority.commitStopAll({ chatId: identity.chatId,
            controlReceiptId: stop.controlReceiptId,
            runningReceiptId: identity.receiptId,
            turnToken: identity.turnToken, generation,
            queuedReceiptIds: stop.queuedReceiptIds,
            cardCleanup,
            payloadHandles: this.durableV2Payloads,
            verifyGeneration, assertWriterLock: this.durableV2AssertWriterLock })
          : authority.commitRunningCancellation({ ...identity, generation,
            control, cardCleanup, verifyGeneration,
            assertWriterLock: this.durableV2AssertWriterLock })
        rt.v2RunnerResult = null
        rt.v2TerminalProjection = null
        rt.v2UsageDecision = null
        rt.v2StartedAt = null
        rt.v2CardBinding = null
        rt.v2StreamRequested = false
        rt.v2StreamQuiescing = false
        rt.v2StreamChain = null
        rt.v2StopIntentGate = null
        rt.v2TimeoutProof = null
        rt.v2RunningJobs = null
        rt.v2RunnerGeneration = null
        rt.v2RunnerCloseEvidenceId = null
        rt.v2SessionCloseEventId = null
        rt.v2DispatchEffect = null
        rt.v2TurnToken = null
        rt.v2CancelControl = null
        if (stop) {
          rt.v2QueueReceiptIds = []
          const text = stop.queuedReceiptIds.length
            ? T.stoppedWithQueue(stop.queuedReceiptIds.length) : T.stopped
          await authority.executeStopAck({ effectId: cancelled.effectId,
            controlReceiptId: stop.controlReceiptId, chatId: identity.chatId,
            target: stop.target,
            perform: target => stop.platform.replyOnce(target.replyCtx, text),
            confirm: response => response?.code === 0 &&
              /^om_[A-Za-z0-9_-]{1,124}$/.test(response?.data?.message_id || ''),
            assertWriterLock: this.durableV2AssertWriterLock })
          rt.v2StopControl = null
        }
        for (const settledReceiptId of cancelled.cancelledReceiptIds ||
          [identity.receiptId]) {
          this._observeActivity('finish', { chatId: identity.chatId, receiptId: settledReceiptId,
            status: control === 'recall' ? 'recalled' : 'stopped' })
          settled.push({ receiptId: settledReceiptId,
            status: control === 'recall' ? 'recalled' : 'stopped',
            terminalEffectId: null, cancellationEventId: cancelled.eventId })
        }
        if (authority.blocked) throw new Error('C2 v2 cancellation closed ingress')
        // A chat /skip answers once its own turn is durably cancelled; what
        // stays in the queue is the work that runs next.
        const skip = rt.v2SkipWaiter
        if (!stop && skip?.turnToken === identity.turnToken) {
          rt.v2SkipWaiter = null
          skip.settle(authority.snapshot().state.lanes.queue?.[identity.chatId]?.queue?.length || 0)
        }
        const nextReceiptId = this._nextDurableV2NormalAnchor(identity.chatId)
        if (nextReceiptId) {
          const next = this.commitDurableV2InitialDispatch({
            chatId: identity.chatId, receiptId: nextReceiptId })
          identity = { chatId: identity.chatId, receiptId: nextReceiptId,
            turnToken: next.turnToken, effectId: next.effectsPending[0] }
        } else identity = null
        continue
      }
      if (rt.v2TimeoutProof) {
        const generation = rt.v2RunnerGeneration
        const timeoutProof = rt.v2TimeoutProof
        if (rt.v2RunnerStopVerified !== true ||
            rt.v2RunnerCloseEvidenceId !==
              `sbot-c2-runner-closed-v1:${identity.receiptId}:${generation}` ||
            rt.v2SessionCloseEventId !==
              `sbot-c2-session-close-v1:${identity.receiptId}:${generation}` ||
            typeof authority.commitHardTimeoutRelease !== 'function') {
          authority.close()
          throw new Error('C2 v2 hard timeout lacks durable child close proof')
        }
        const verifyGeneration = value => value.chatId === identity.chatId &&
          value.receiptId === identity.receiptId &&
          value.turnToken === identity.turnToken &&
          value.generation === generation && rt.v2RunnerGeneration === generation
        const cardCleanup = await this._cleanupDurableV2CancelledCard(
          rt, identity, generation, verifyGeneration)
        const released = authority.commitHardTimeoutRelease({ ...identity,
          generation, timeoutProof, cardCleanup, verifyGeneration,
          assertWriterLock: this.durableV2AssertWriterLock })
        rt.v2RunnerResult = null
        rt.v2TerminalProjection = null
        rt.v2UsageDecision = null
        rt.v2StartedAt = null
        rt.v2CardBinding = null
        rt.v2StreamRequested = false
        rt.v2StreamQuiescing = false
        rt.v2StreamChain = null
        rt.v2StopIntentGate = null
        rt.v2TimeoutProof = null
        rt.v2RunningJobs = null
        rt.v2RunnerGeneration = null
        rt.v2RunnerCloseEvidenceId = null
        rt.v2SessionCloseEventId = null
        rt.v2DispatchEffect = null
        rt.v2TurnToken = null
        for (const settledReceiptId of released.settledReceiptIds ||
          [identity.receiptId]) {
          this._observeActivity('finish', { chatId: identity.chatId, receiptId: settledReceiptId,
            status: 'timeout', err: '任务超过运行时限，已停止' })
          settled.push({ receiptId: settledReceiptId,
            status: 'timeout', terminalEffectId: null,
            cancellationEventId: released.eventId })
        }
        if (authority.blocked) throw new Error('C2 v2 hard timeout closed ingress')
        const nextReceiptId = this._nextDurableV2NormalAnchor(identity.chatId)
        if (nextReceiptId) {
          const next = this.commitDurableV2InitialDispatch({
            chatId: identity.chatId, receiptId: nextReceiptId })
          identity = { chatId: identity.chatId, receiptId: nextReceiptId,
            turnToken: next.turnToken, effectId: next.effectsPending[0] }
        } else identity = null
        continue
      }
      const payload = rt.v2TerminalProjection?.payload
      if (!payload) {
        authority.close()
        const error = new Error('C2 v2 ordinary result needs an unresolved-turn policy')
        error.code = 'C2_V2_UNRESOLVED_TURN'
        throw error
      }
      const terminal = { ...payload, type: 'finalize' }
      delete terminal.receiptId
      delete terminal.turnToken
      delete terminal.quiet
      const outcome = engineTerminalStep({ finalized: false, outcome: null },
        terminal).state.outcome
      const quotaFailure = supportedV2QuotaFailure(payload, rt.v2RunnerResult)
      const closedFailure = supportedV2ClosedFailure(payload, rt.v2RunnerResult)
      if (['error', 'empty', 'stopped'].includes(outcome.status) && !quotaFailure && !closedFailure) {
        const classified = this.classifyDurableV2UnresolvedTurn({ ...identity,
          payload })
        const error = new Error('C2 v2 ordinary result requires fault recovery')
        error.code = 'C2_V2_UNRESOLVED_TURN'
        error.classificationEventId = classified.eventId
        throw error
      }
      if ((payload.source !== 'result' && !closedFailure) || payload.sessionMissing ||
          (payload.hasQuota && !quotaFailure) || payload.transientNetwork || payload.freshRetried ||
          payload.resumedSessionCurrent ||
          (!['ok', 'no-reply'].includes(outcome.status) && !quotaFailure && !closedFailure)) {
        authority.close()
        const error = new Error('C2 v2 ordinary result needs a retry or notice decision')
        error.code = 'C2_V2_UNRESOLVED_TURN'
        throw error
      }
      let stillLocked = false
      try { stillLocked = this.durableV2AssertWriterLock() === true } catch {}
      if (!stillLocked) {
        authority.close()
        throw new Error('C2 v2 ordinary route lost single-writer lock before delivery')
      }
      const silent = payload.quiet || outcome.silent
      const completed = await this.completeDurableV2CardTurn({ ...identity, payload,
        ...(silent ? {} : { replyText: terminalReplyText(payload) }) })
      for (const settledReceiptId of completed.settledReceiptIds ||
        [identity.receiptId]) {
        settled.push({ receiptId: settledReceiptId,
          status: quotaFailure || closedFailure ? 'error' : silent ? 'silent' : 'answered',
          terminalEffectId: completed.terminalEffectId })
      }
      if (authority.blocked) {
        throw new Error('C2 v2 ordinary route closed during terminal settlement')
      }
      identity = completed.successor
        ? { chatId: initial.chatId, receiptId: completed.successor.receiptId,
          turnToken: completed.successor.turnToken,
          effectId: completed.successor.effectId }
        : null
    }
    return { receiptId: firstReceiptId, status: settled[0].status,
      terminalEffectId: settled[0].terminalEffectId,
      ...(settled[0].cancellationEventId
        ? { cancellationEventId: settled[0].cancellationEventId } : {}),
      settledReceiptIds: settled.map(item => item.receiptId),
      ingressClosed: false }
  }

stageDurableV2Message(msg, platform) {
    const authority = this.durableV2Runtime
    const handles = this.durableV2Payloads
    if (!authority || !handles) throw new Error('C2 v2 staging is unavailable')
    if (authority.blocked) throw new Error('C2 v2 ingress is closed')
    if (!msg || typeof msg !== 'object' || msg.synthetic || msg.cron ||
        msg.receiptSource && msg.receiptSource !== 'message' ||
        typeof msg.text !== 'string' || !msg.text.trim() ||
        typeof msg.chatId !== 'string' || typeof msg.msgId !== 'string' ||
        !/^om_[A-Za-z0-9_-]{1,124}$/.test(msg.msgId) ||
        !msg.replyCtx || typeof msg.replyCtx !== 'object' ||
        msg.replyCtx.chatId !== msg.chatId ||
        msg.replyCtx.messageId !== msg.msgId ||
        !platform || typeof platform.reply !== 'function') {
      throw new TypeError('C2 v2 staging needs a platform message and reply target')
    }
    const group = this._resolveGroup(msg.chatId)
    if (!group || group.paused) throw new Error('C2 v2 staging needs an active bound group')
    const acceptedAt = Date.now()
    const receipt = { source: 'message', chatId: msg.chatId, sourceId: msg.msgId,
      acceptedAt, quiet: !!msg.quiet }
    receipt.id = taskId(receipt)
    const prior = authority.snapshot()
    const pendingDuplicate = prior.receipts?.pending?.find(item => item.id === receipt.id)
    const completedDuplicate = prior.receipts?.completed?.some(item => item.id === receipt.id)
    if (pendingDuplicate || completedDuplicate) {
      if (pendingDuplicate && (pendingDuplicate.chatId !== msg.chatId ||
          pendingDuplicate.source !== 'message' || pendingDuplicate.sourceId !== msg.msgId)) {
        authority.close()
        throw new Error('C2 v2 duplicate identity differs from durable receipt')
      }
      return { receiptId: receipt.id, cursor: prior.cursor, staged: false,
        duplicate: true, ingressClosed: false }
    }
    const job = { msg: { ...msg, _c2ReceiptId: receipt.id }, platform, group }
    handles.preflight(receipt, job)
    const flags = { quiet: receipt.quiet, polled: !!msg.polled, synthetic: false,
      wantsAck: !!msg.wantsAck, resetSessionAfter: !!msg.resetSessionAfter,
      emptyRetried: false, freshRetried: false, firstResumed: false, failedOver: false }
    let result
    try { result = authority.enqueueMessage({ receipt, flags }) }
    catch (error) {
      authority.close()
      throw error
    }
    try { handles.attach(receipt.id, job) }
    catch (error) {
      authority.close()
      throw error
    }
    const rt = this._rt(msg.chatId)
    if (!rt.v2QueueReceiptIds) rt.v2QueueReceiptIds = []
    rt.v2QueueReceiptIds.push(receipt.id)
    this._observeActivity('receive', { chatId: msg.chatId, receiptId: receipt.id,
      sourceMessageId: msg.msgId,
      text: msg.text, sender: msg.senderName || '', acceptedAt })
    return { receiptId: receipt.id, cursor: result.cursor, staged: true,
      ingressClosed: !!authority.blocked }
  }

_nextDurableV2NormalAnchor(chatId) {
    const authority = this.durableV2Runtime
    const snapshot = authority?.snapshot?.()
    const queue = snapshot?.state?.lanes?.queue?.[chatId]?.queue
    const rt = this._rt(chatId)
    const ids = queue?.map(item => typeof item?.id === 'string'
      ? item.id.slice('receipt:job:'.length) : null)
    if (!authority || authority.blocked || !Array.isArray(queue) ||
        !isDeepStrictEqual(ids, rt.v2QueueReceiptIds || []) ||
        !isDeepStrictEqual(this.durableV2Journal?.snapshot(), snapshot)) {
      authority?.close()
      throw new Error('C2 v2 successor differs from durable queue')
    }
    if (!queue.length) return null
    const taken = v2QueueSelection(queue).jobs
    if (!taken.length || taken.some(item => item.synthetic || item.batch ||
        item.quiet || item.polled ||
        !/^receipt:job:[0-9a-f]{32}$/.test(item.id) ||
        snapshot.receipts.pending.find(receipt =>
          receipt.id === item.id.slice('receipt:job:'.length))?.chatId !== chatId ||
        ![...snapshot.effects].some(([effectId, status]) => {
          const descriptor = this.durableV2Journal.effectDescriptor(effectId)
          return status === 'acked' && descriptor?.type === 'queueNotice' &&
            descriptor.receiptId === item.id.slice('receipt:job:'.length)
        }))) {
      authority.close()
      throw new Error('C2 v2 successor lacks flat acknowledged queue cohort')
    }
    try { this.durableV2Payloads.auditOrdinaryQueue(chatId, ids) }
    catch (error) { authority.close(); throw error }
    return v2QueueSelection(queue).anchor
  }

commitDurableV2InitialDispatch({ chatId, receiptId } = {}) {
    const authority = this.durableV2Runtime
    const handles = this.durableV2Payloads
    if (!authority || !handles || authority.blocked ||
        typeof authority.snapshot !== 'function' ||
        typeof authority.commitInitialDispatch !== 'function' ||
        typeof handles.consumeCommittedDispatch !== 'function') {
      throw new Error('C2 v2 initial dispatch is unavailable')
    }
    const before = authority.snapshot()
    const queue = before.state?.lanes?.queue?.[chatId]?.queue
    const rt = this._rt(chatId)
    const takenIds = Array.isArray(queue)
      ? v2QueueSelection(queue).jobs.map(item =>
        typeof item?.id === 'string' ? item.id.slice('receipt:job:'.length) : null) : []
    if (typeof chatId !== 'string' || !chatId ||
        typeof receiptId !== 'string' || !/^[0-9a-f]{32}$/.test(receiptId) ||
        !Array.isArray(queue) || v2QueueSelection(queue).anchor !== receiptId ||
        !isDeepStrictEqual(queue.map(item => item.id.slice('receipt:job:'.length)),
          rt.v2QueueReceiptIds)) {
      authority.close()
      throw new Error('C2 v2 initial dispatch differs from durable queue')
    }
    try {
      handles.auditQueued()
      const result = authority.commitInitialDispatch({ receiptId, payloadHandles: handles })
      const token = result.decision?.turnToken
      const jobs = handles.consumeCommittedDispatch({ eventId: result.eventId,
        turnToken: token, receiptIds: result.jobReceiptIds })
      const after = authority.snapshot()
      const remaining = after.state?.lanes?.queue?.[chatId]?.queue
      if (!Array.isArray(remaining) || !Array.isArray(jobs) ||
          !isDeepStrictEqual(result.jobReceiptIds, takenIds) ||
          jobs.length !== result.jobReceiptIds.length ||
          !isDeepStrictEqual(remaining.map(item => item.id.slice('receipt:job:'.length)),
            queue.slice(result.jobReceiptIds.length).map(item => item.id.slice('receipt:job:'.length)))) {
        throw new Error('C2 v2 initial dispatch host result invalid')
      }
      rt.v2QueueReceiptIds = remaining.map(item => item.id.slice('receipt:job:'.length))
      rt.v2RunningJobs = jobs
      rt.v2TurnToken = token
      // This is only a process-local binding for the next migration step.
      // The durable journal stores IDs/status, not an executable reply target.
      rt.v2DispatchEffect = { effectId: result.effects[0].effectId,
        type: result.effects[0].type, turnToken: token,
        receiptIds: [...result.jobReceiptIds],
        batchReceiptIds: [...result.batchReceiptIds] }
      if (!this.durableV2StartTurn ||
          !ordinaryV2Cohort(after, jobs, rt.v2DispatchEffect, chatId, receiptId)) {
        authority.close()
      }
      return { cursor: result.cursor, turnToken: token,
        dispatchedReceiptIds: [...result.jobReceiptIds],
        effectsPending: result.effects.map(effect => effect.effectId),
        ingressClosed: !!authority.blocked }
    } catch (error) { authority.close(); throw error }
  }

async startDurableV2Runner({ chatId, receiptId, turnToken, effectId } = {}) {
    const authority = this.durableV2Runtime
    if (!this.durableV2StartTurn || !authority || authority.blocked) {
      throw new Error('C2 v2 runner start is unavailable')
    }
    const rt = typeof chatId === 'string' && chatId ? this._rt(chatId) : null
    const snapshot = authority.snapshot()
    const receipt = snapshot.receipts?.pending?.find(item => item.id === receiptId)
    const binding = rt?.v2DispatchEffect
    const jobs = rt?.v2RunningJobs
    const cohort = ordinaryV2Cohort(snapshot, jobs, binding, chatId, receiptId)
    if (!/^[0-9a-f]{32}$/.test(receiptId || '') ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        typeof effectId !== 'string' || !effectId ||
        receipt?.chatId !== chatId ||
        snapshot.state?.lanes?.turn?.[chatId]?.active !== turnToken ||
        snapshot.state?.lanes?.handoff?.[chatId]?.phase !== 'running' ||
        snapshot.state.lanes.handoff[chatId].turnToken !== turnToken ||
        binding?.type !== 'dispatch' || binding.effectId !== effectId ||
        binding.turnToken !== turnToken ||
        !cohort ||
        snapshot.effects?.get(effectId) !== 'pending' ||
        rt.v2RunnerGeneration) {
      authority.close()
      throw new Error('C2 v2 runner start differs from durable dispatch')
    }
    const generation = randomBytes(16).toString('hex')
    rt.v2RunnerGeneration = generation
    rt.v2StartedAt = Date.now()
    // Evidence that the turn is still moving, for /status and the card pulse;
    // every turn starts from zero.
    rt.v2Steps = 0
    rt.v2AliveAt = 0
    rt.v2Doing = []
    rt.v2AutoMilestones = []
    rt.v2CardQuotaFailure = false
    rt.v2CardModelInfo = null
    rt.v2CardBinding = null
    rt.v2CardAnchor = null
    rt.v2CardJoinedNames = []
    rt.v2LastCardText = ''
    rt.v2MoveCard = null
    rt.v2StreamRequested = false
    rt.v2StreamQuiescing = false
    rt.v2StreamChain = Promise.resolve()
    rt.v2StopIntentGate = null
    rt.v2TimeoutProof = null
    const verifyGeneration = value => value.chatId === chatId &&
      value.receiptId === receiptId && value.turnToken === turnToken &&
      value.generation === generation && rt.v2RunnerGeneration === generation
    let capability
    let accepted = false
    let controller = null
    let capTimer = null
    let ackTimer = null
    let ackDue = false
    let pulseTimer = null
    const stopProgressTimers = () => {
      if (ackTimer) { clearTimeout(ackTimer); ackTimer = null }
      if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null }
    }
    try {
      capability = authority.beginRunnerStart({ receiptId, chatId, turnToken,
        generation, verifyGeneration })
      if (capability.effectId !== effectId) {
        throw new Error('C2 v2 runner effect changed before start')
      }
      const projection = createC2TurnProjection({ receiptId, turnToken,
        quiet: receipt.quiet, requireResult: true,
        resumed: !!this.store.getSession(chatId), freshRetried: false,
        ...(cohort.receiptIds.length > 1
          ? { batchReceiptIds: cohort.receiptIds } : {}) })
      const job = cohort.anchor
      const { name, provider } = this._resolveProvider(chatId, job.group)
      if (!provider || (provider.baseUrl && !provider.apiKey)) {
        throw new Error('C2 v2 runner provider unavailable')
      }
      rt.v2Brain = this._brain(job.group, name, provider)
      rt.v2CardModelInfo = cardModelInfo(rt.v2Brain)
      this._observeActivity('start', { chatId, receiptId, receiptIds: cohort.receiptIds, generation,
        sessionId: this.store.getSession(chatId), model: rt.v2Brain.model, effort: rt.v2Brain.effort,
        runner: provider.runner, project: projectName(job.group) })
      rt.v2FollowupEnabled = followupEnabled(job.group, provider.runner)
      rt.v2SteerControl = null
      rt.v2SteerEntries = new Map()
      rt.v2SteerClosing = false
      rt.v2SteerLandedChain = Promise.resolve()
      const steerIdentity = { chatId, parentReceiptId: receiptId, turnToken, generation }
      const steerAlive = () => rt.v2RunnerGeneration === generation && !rt.v2SteerClosing &&
        !controller?.signal.aborted && !rt.v2TerminalStarted
      const onSteerReady = control => {
        if (!steerAlive()) return
        if (typeof control?.steerDurable !== 'function') {
          authority.close(); controller?.abort(); return
        }
        rt.v2SteerControl = control
        // Receipts arriving before control readiness already have a durable
        // queue notice. Pull only those still queued in this generation.
        const drain = async () => {
          if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
          await rt.v2StreamChain
          if (rt.v2CardBinding?.opened) await rt.v2CardBinding.path.flushForTerminal()
          for (const id of [...(rt.v2QueueReceiptIds || [])]) {
            if (!steerAlive()) break
            if (!rt.v2QueueReceiptIds?.includes(id)) continue
            await this._runDurableV2Steer(rt, id)
          }
        }
        rt.v2SteerDrain = drain().catch(error => {
          authority.close(); controller?.abort(); throw error
        })
        rt.v2SteerDrain.catch(() => {})
      }
      const onSteerLanded = msgId => {
        if (!steerAlive()) return
        const entry = [...rt.v2SteerEntries.values()].find(value => value.job.msg.msgId === msgId)
        if (!entry || entry.landed) return
        // Keep the trusted observation in process while the RPC ACK is still
        // pending. A crash here remains unknown; it never authorizes replay.
        entry.landed = true
        if (!entry.accepted) return
        const observation = rt.v2SteerLandedChain.then(async () => {
          while (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
          await rt.v2StreamChain
          if (rt.v2CardBinding?.opened) await rt.v2CardBinding.path.flushForTerminal()
          if (rt.v2RunnerGeneration !== generation) return
          authority.commitSteerObservation({ ...steerIdentity, receiptId: entry.identity.receiptId, type: 'landed' })
          try { this.activity?.merge(chatId, receiptId, [entry.identity.receiptId], 'landed') } catch {}
          await rt.v2MoveCard?.(entry)
        })
        rt.v2SteerLandedChain = observation
        observation.catch(() => { authority.close(); controller?.abort() })
      }
      const prompt = this._prepareRunnerPrompt({ msg: job.msg, group: job.group,
        platform: job.platform, providerName: name, provider, rt,
        batch: cohort.receiptIds.length > 1 ? cohort.jobs.map(item => item.msg) : null,
        consumeLifecycle: false })
      controller = new AbortController()
      rt.v2Controller = controller
      rt.v2RunnerStopPromise = null
      rt.v2RunnerStopVerified = false
      rt.v2RunnerNotStarted = false
      let streamChain = Promise.resolve()
      let streamFailure = null
      const joinedLine = () => rt.v2CardJoinedNames.length
        ? `\n\n↪ 已加入 ${rt.v2CardJoinedNames.join('、')} 的补充` : ''
      // Card progress (same mechanism and wording as the legacy engine): deterministic
      // milestones and "recently doing" from tool calls, an early "received" card
      // and a pulse line. All of it is process-local card text; the card itself is
      // still opened through the durable terminal path below.
      const autoMs = []
      rt.v2AutoMilestones = autoMs
      const pushAuto = m => {
        if (m && !autoMs.includes(m) && autoMs.length < progress.MILESTONE_MAX) autoMs.push(m)
      }
      const autoBlock = () => (autoMs.length ? autoMs.map(m => '▶ ' + m).join('\n') + '\n\n' : '')
      const pulseFrom = Date.now()
      let cardTouchedAt = 0
      const progressClosed = () => rt.v2RunnerGeneration !== generation ||
        rt.v2TerminalStarted || controller.signal.aborted || rt.v2CancelControl ||
        rt.v2StreamQuiescing || !!authority.scopeState('stopIntent', chatId)
      const enqueueCardText = text => {
        rt.v2LastCardText = text
        rt.v2StreamRequested = true
        streamChain = streamChain.then(async () => {
          if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
          // An earlier frame or pulse may still await its platform response;
          // only a closed authority ends the stream.
          if (authority.closed) throw new Error('C2 v2 stream authority closed')
          if (controller.signal.aborted || rt.v2CancelControl ||
              authority.scopeState('stopIntent', chatId)) return
          if (!rt.v2CardBinding) {
            const path = prepareCardTerminalPath({ runtime: authority,
              payloadHandles: this.durableV2Payloads, platform: job.platform,
              replyCtx: job.msg.replyCtx, cardAnchor: rt.v2CardAnchor,
              receiptId, chatId, turnToken,
              generation, verifyGeneration,
              applyLocalEffect: this.durableV2ApplyLocalEffect,
              assertWriterLock: this.durableV2AssertWriterLock,
              // An early card may end as the supported quota failure; its final
              // text then uses the same fixed notice as an unopened card.
              redactText: value => redact(rt.v2CardQuotaFailure === true
                ? T.quotaFailure : value, { pii: job.group?.redactPii !== false }),
              sendPlainReply: typeof job.platform.replyOnce === 'function'
                ? (target, value) => job.platform.replyOnce(target.replyCtx, value)
                : null })
            const opened = await path.open()
            rt.v2CardBinding = { path, receiptId, turnToken,
              generation, opened }
          }
          if (rt.v2CardBinding.opened) rt.v2CardBinding.path.update(text + joinedLine())
        })
        rt.v2StreamChain = streamChain
        streamChain.catch(error => {
          streamFailure = error
          try { controller.abort() } catch {}
        })
      }
      rt.v2MoveCard = entry => {
        if (entry.movePromise) return entry.movePromise
        const move = streamChain.then(async () => {
          if (progressClosed() || job.platform.features?.cardPinned !== true) return false
          const anchor = { receiptId: entry.identity.receiptId,
            replyCtx: entry.job.msg.replyCtx }
          const who = entry.job.msg.senderName || entry.job.msg.userId || 'user'
          if (!rt.v2CardJoinedNames.includes(who)) rt.v2CardJoinedNames.push(who)
          if (!rt.v2CardBinding) {
            rt.v2CardAnchor = anchor
            return true
          }
          if (!rt.v2CardBinding.opened) return false
          rt.v2CardBinding.path.update((rt.v2LastCardText || progress.T.ackWorking) + joinedLine())
          const moved = await rt.v2CardBinding.path.relocate(anchor)
          if (moved) rt.v2CardAnchor = anchor
          return moved
        })
        streamChain = move
        rt.v2StreamChain = move
        entry.movePromise = move
        move.catch(error => {
          streamFailure = error
          try { controller.abort() } catch {}
        })
        return move
      }
      const enqueueFrame = event => {
        if (event.type !== 'assistant') return
        // /status and the pulse read these; a late event from an older
        // generation must not write progress into this turn.
        if (rt.v2RunnerGeneration === generation) {
          rt.v2AliveAt = Date.now()
          if (event.tools && event.tools.length) {
            rt.v2Steps = (rt.v2Steps || 0) + event.tools.length
            for (const tool of event.tools) {
              progress.pushDoing(rt.v2Doing, progress.describeTool(tool.name, tool.input))
              pushAuto(progress.autoMilestone(tool.name, tool.input))
            }
          }
        }
        if (!this.durableV2StreamFrames) return
        if (!event.text || controller.signal.aborted || rt.v2CancelControl ||
            rt.v2StreamQuiescing ||
            authority.scopeState('stopIntent', chatId)) return
        const buffer = projection.streamSnapshot().bufferText
        const trimmed = buffer.trim()
        if (!trimmed || NO_REPLY.startsWith(trimmed)) return
        cardTouchedAt = Date.now()
        enqueueCardText(autoBlock() + progress.renderMilestones(buffer))
      }
      const cardsVisible = this.durableV2StreamFrames && !receipt.quiet &&
        typeof job.platform?.createStreamingCard === 'function'
      // No visible output after ackDelayMs: open the card that would be opened
      // anyway and fill it with "received"; the answer replaces it in place and
      // a turn that ends silent recalls it at the terminal.
      const ackMs = this.cfg.agent?.ackDelayMs == null ? 25_000 : Number(this.cfg.agent.ackDelayMs)
      // No card before the runner is accepted. A runner accepted after the
      // delay (Codex holds its events until its turn start returns) gets the
      // card as soon as it is accepted.
      const tryAck = () => {
        if (!accepted) { ackDue = true; return }
        if (progressClosed() || rt.v2CardBinding || rt.v2StreamRequested ||
            projection.streamSnapshot().bufferText.trim()) return
        cardTouchedAt = Date.now()
        enqueueCardText(progress.T.ackWorking)
      }
      const armAck = delayMs => {
        ackTimer = setTimeout(() => { ackTimer = null; tryAck() }, delayMs)
        if (ackTimer.unref) ackTimer.unref()
      }
      if (cardsVisible && ackMs > 0) armAck(ackMs)
      // Pulse: only rewrites the open card. Every PULSE_MS for the first
      // PULSE_SLOW_AFTER_MS, then every PULSE_SLOW_MS; "recent activity" is only
      // added after PULSE_STALE_MS without an assistant event.
      const agentCfg = this.cfg.agent || {}
      const PULSE_MS = agentCfg.cardPulseMs == null ? 15_000 : Number(agentCfg.cardPulseMs)
      const PULSE_SLOW_MS = agentCfg.cardPulseSlowMs == null ? 60_000 : Number(agentCfg.cardPulseSlowMs)
      const PULSE_SLOW_AFTER_MS = agentCfg.cardPulseSlowAfterMs == null ? 10 * 60 * 1000 : Number(agentCfg.cardPulseSlowAfterMs)
      const PULSE_STALE_MS = agentCfg.cardPulseStaleMs == null ? 2 * 60 * 1000 : Number(agentCfg.cardPulseStaleMs)
      if (cardsVisible && PULSE_MS > 0) {
        const pulseEvery = () => (Date.now() - pulseFrom >= PULSE_SLOW_AFTER_MS
          ? Math.max(PULSE_MS, PULSE_SLOW_MS) : PULSE_MS)
        pulseTimer = setInterval(() => {
          const binding = rt.v2CardBinding
          if (progressClosed() || !binding?.opened || binding.generation !== generation) return
          if (Date.now() - cardTouchedAt < pulseEvery()) return
          cardTouchedAt = Date.now()
          const sinceAlive = Date.now() - (rt.v2AliveAt || pulseFrom)
          const stale = sinceAlive >= PULSE_STALE_MS ? progress.humanDur(sinceAlive) : ''
          // Same gate as the stream frame: text that may still become NO_REPLY
          // never reaches the card.
          const buffer = projection.streamSnapshot().bufferText
          const sofar = buffer.trim()
          const body = autoBlock() + (sofar && !NO_REPLY.startsWith(sofar)
            ? progress.renderMilestones(buffer) + '\n\n' : '')
          enqueueCardText(body + progress.T.pulse(
            progress.humanDur(Date.now() - pulseFrom), rt.v2Doing, stale))
        }, PULSE_MS)
        if (pulseTimer.unref) pulseTimer.unref()
      }
      const maxMins = Number(this.cfg.agent.maxTurnTimeMins) || 0
      const timeoutMs = maxMins > 0 ? maxMins * 60_000 : 0
      const timeoutDeadlineAt = timeoutMs > 0 ? Date.now() + timeoutMs : null
      if (timeoutDeadlineAt !== null &&
          (!Number.isSafeInteger(timeoutDeadlineAt) || timeoutDeadlineAt <= 0)) {
        throw new Error('C2 v2 hard timeout deadline invalid')
      }
      const onHardDeadline = () => {
          const elapsedAt = Date.now()
          if (rt.v2RunnerGeneration !== generation ||
              rt.v2Controller !== controller || rt.v2CancelControl ||
              rt.v2StreamQuiescing) return
          // Timers and Date.now need not tick together. An early callback (or
          // a backward wall-clock adjustment) is not proof of elapsed time.
          if (elapsedAt < timeoutDeadlineAt) {
            capTimer = setTimeout(onHardDeadline, timeoutDeadlineAt - elapsedAt)
            return
          }
          rt.v2TimeoutProof = { receiptId, turnToken, generation,
            deadlineAt: timeoutDeadlineAt, elapsedAt }
          controller.abort()
      }
      capTimer = timeoutDeadlineAt !== null ? setTimeout(onHardDeadline, timeoutMs) : null
      const input = prepareC2RunnerInput({ prompt,
        appendSystemPrompt: SYSTEM_APPENDIX, msg: job.msg, group: job.group,
        provider, config: this.cfg, brain: { model: rt.v2Brain.model, effort: rt.v2Brain.effort },
        sessionId: this.store.getSession(chatId) || null,
        signal: controller.signal, extraEnv: this.baseSkillEnv(chatId),
        onDurableEvent: event => {
          projection.accept(event)
          enqueueFrame(event)
          this._observeActivity('observe', { chatId, receiptId, generation, event,
            doing: rt.v2Doing, milestones: event.text?.includes('>>') ? progress.milestonesOf(projection.streamSnapshot().bufferText) : undefined })
        },
        onEvent: event => {
          if (event.type === 'system' && event.subtype === 'context')
            this._observeActivity('observe', { chatId, receiptId, generation, event })
          // CLI 在 init 里自报的可用命令:含 compact 才能空闲整理(按这一家 provider 记)。
          if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.slashCommands))
            rt.v2CanCompact = { provider: this._resolveProvider(chatId, job.group).name, ok: event.slashCommands.includes('compact') }
        },
        onTurnAccepted: value => {
          const ack = capability.onTurnAccepted(value)
          accepted = true
          if (ackDue) { ackDue = false; armAck(0) }
          return ack
        },
        onSpawnFailed: value => capability.onSpawnFailed(value),
        onSteerReady, onSteerLanded,
        log: this.log })
      rt.v2Compacted = false // 「进度可能已折叠」只带一轮
      let started
      try { started = this.durableV2StartTurn(input) }
      catch (error) { started = Promise.reject(error) }
      const running = Promise.resolve(started)
      const stopWitness = (result, error) => {
        let verified = false
        try {
          verified = this.durableV2VerifyRunnerClosed?.({ chatId, receiptId,
            turnToken, generation, result, error }) === true
        } catch { /* missing or failed close witness stays unverified */ }
        rt.v2RunnerStopVerified = verified
        return verified
      }
      rt.v2RunnerStopPromise = running.then(
        result => stopWitness(result, null),
        error => stopWitness(null, error))
      let result
      try {
        result = await running
        stopProgressTimers()
        rt.v2SteerClosing = true
        rt.v2SteerControl = null
        if (rt.v2SteerDrain) await rt.v2SteerDrain
        if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
        await rt.v2RunnerStopPromise
        await streamChain
        await rt.v2SteerLandedChain
        if (streamFailure) throw streamFailure
        const steer = authority.scopeState('steer', chatId)
        if (!rt.v2CancelControl && !rt.v2StopControl && !rt.v2TimeoutProof &&
            steer?.entries.some(entry => entry.status !== 'landed')) {
          throw new Error('C2 accepted steer lacks userMessage landing; replay forbidden')
        }
        if (rt.v2CardBinding?.opened && !rt.v2StreamQuiescing) {
          await rt.v2CardBinding.path.flushForTerminal()
        }
        if (rt.v2StreamQuiescing && rt.v2StopIntentGate) {
          await rt.v2StopIntentGate
        }
      }
      finally {
        if (capTimer) clearTimeout(capTimer)
        stopProgressTimers()
        if (rt.v2Controller === controller) rt.v2Controller = null
      }
      if (authority.blocked && rt.v2RunnerStopVerified !== true) {
        throw new Error('C2 v2 runner closure is unverified after shutdown')
      }
      if (!accepted) throw new Error('C2 v2 runner exited before trusted acceptance')
      // A wall-clock cap or shutdown may abort after the last result event but
      // before the child closes. The original result object remains the close
      // witness; the host projection must still classify the turn as stopped.
      const settledResult = controller.signal.aborted && result?.aborted === false
        ? { ...result, aborted: true } : result
      // Codex reports cumulative session usage. Use the same private-core
      // arithmetic as the legacy path, without writing session state before
      // terminal effects have been confirmed.
      const usage = settledResult?.result?.usage
      const usageDecision = usage ? settleUsage(
        this.store.getSessionStats?.(chatId) || null,
        settledResult?.sessionId || this.store.getSession(chatId) || null,
        settledResult.result) : null
      const outputTokens = Number(usageDecision?.tokens?.out) || 0
      const projected = projection.complete({ runnerResult: settledResult,
        outputTokens, resumedSessionCurrent: false })
      if (this.durableV2VerifyRunnerClosed) {
        const closed = authority.confirmRunnerClosed({ receiptId, chatId,
          turnToken, generation, verifyGeneration,
          assertRunnerClosed: () => rt.v2RunnerStopVerified === true })
        rt.v2RunnerCloseEvidenceId = closed.evidenceId
        if (usageDecision?.write &&
            (!projected.display.sessionId ||
              usageDecision.stats?.sessionId !== projected.display.sessionId)) {
          throw new Error('C2 v2 usage session identity unresolved after runner close')
        }
        const session = authority.commitClosedRunnerSession({ receiptId, chatId,
          turnToken, generation, verifyGeneration,
          sessionId: projected.display.sessionId || null,
          ...(usageDecision?.write ? { usageDecision } : {}),
          aborted: settledResult.aborted, assertWriterLock: this.durableV2AssertWriterLock,
          store: this.store })
        rt.v2SessionCloseEventId = session.eventId
        if (rt.v2CancelControl || rt.v2StopControl || rt.v2TimeoutProof) {
          authority.cancelClosedSteer({ chatId, parentReceiptId: receiptId, turnToken,
            generation, assertWriterLock: this.durableV2AssertWriterLock })
        }
      }
      rt.v2RunnerResult = settledResult // process-local only; no reply until terminal effect
      rt.v2TerminalProjection = projected
      rt.v2UsageDecision = usageDecision
      return { effectId, accepted: true, outputHeld: true }
    } catch (error) {
      if (capTimer) clearTimeout(capTimer)
      stopProgressTimers()
      if (controller && rt.v2Controller === controller) rt.v2Controller = null
      const proofId = `sbot-c2-runner-not-started-v1:${receiptId}:${generation}`
      const eventId = `sbot-c2-runner-not-started-commit-v1:${receiptId}:${turnToken}:${generation}`
      const provenNotStarted = !accepted &&
        ['AGENT_BIN_MISSING', 'AGENT_THREAD_REJECTED'].includes(error?.code) &&
        this.durableV2Journal?.lookupRunnerNotStarted(proofId)?.dispatchEffectId === effectId &&
        this.durableV2Journal?.hasEvent(eventId) === true
      if (provenNotStarted) {
        authority.close()
        await authority.open()
        if (authority.snapshot().receipts.pending.some(item => item.id === receiptId) ||
            !authority.snapshot().receipts.completed.some(item => item.id === receiptId)) {
          authority.close()
          throw new Error('C2 v2 unstarted runner receipt remains unsettled')
        }
        // Recovery also settles messages queued behind this turn, each with its
        // own confirmed notice. Forget their bodies and the local queue so the
        // next message is admitted as idle, not as a busy follow-up. A queue
        // the recovery left in place has no dispatcher here: fail closed.
        const durableQueue = authority.snapshot().state.lanes.queue?.[chatId]?.queue || []
        if (durableQueue.length) {
          authority.close()
          throw new Error('C2 v2 unstarted runner left queued receipts unsettled')
        }
        try {
          for (const id of rt.v2QueueReceiptIds || []) this.durableV2Payloads.dropConfirmed(id)
        } catch (dropError) { authority.close(); throw dropError }
        rt.v2QueueReceiptIds = []
        // A resume the server itself rejected leaves the saved thread unusable
        // (missing rollout, unreadable history). As /new on this now idle and
        // settled group: the next message starts a fresh session instead of
        // meeting the same rejection again.
        if (error.code === 'AGENT_THREAD_REJECTED' && this.store.getSession(chatId)) {
          let locked = false
          try { locked = this.durableV2AssertWriterLock?.() === true } catch {}
          if (!locked) {
            authority.close()
            throw new Error('C2 v2 rejected-session reset lost single-writer lock')
          }
          this.store.resetSessionAndStats(chatId)
          this.log(`group ${chatId}: Codex rejected the saved session before any turn; the next message starts a new session`)
        }
        rt.v2RunnerGeneration = null
        rt.v2RunningJobs = null
        rt.v2DispatchEffect = null
        rt.v2RunnerNotStarted = true
        // A console stop or /skip asked of this turn has nothing left to
        // cancel; carried over, it would cancel the group's next turn.
        if (!rt.v2StopControl) {
          rt.v2CancelControl = null
          rt.v2StreamQuiescing = false
          rt.v2StopIntentGate = null
        }
        return { effectId, accepted: false, startFailureRecovered: true }
      }
      if (capability && !accepted) {
        try { capability.markUnknown() } catch { /* journal itself seals on failed write */ }
      }
      authority.close()
      throw error
    }
  }

async completeDurableV2CardTurn({ chatId, receiptId, turnToken, effectId,
    payload, replyText, paused = false, updates = [] } = {}) {
    const authority = this.durableV2Runtime
    const handles = this.durableV2Payloads
    const rt = typeof chatId === 'string' && chatId ? this._rt(chatId) : null
    if (!authority || !handles || !this.durableV2StartTurn ||
        !this.durableV2ApplyLocalEffect || authority.blocked ||
        typeof paused !== 'boolean' || !Array.isArray(updates) ||
        !updates.every(text => typeof text === 'string')) {
      throw new Error('C2 v2 card terminal path is unavailable')
    }
    const snapshot = authority.snapshot()
    const receipt = snapshot.receipts?.pending?.find(item => item.id === receiptId)
    const binding = rt?.v2DispatchEffect
    const jobs = rt?.v2RunningJobs
    const cohort = ordinaryV2Cohort(snapshot, jobs, binding, chatId, receiptId)
    const job = cohort?.anchor
    const generation = rt?.v2RunnerGeneration
    const projected = rt?.v2TerminalProjection
    const resultText = projected?.payload?.resultText
    const quotaFailure = supportedV2QuotaFailure(payload, rt?.v2RunnerResult)
    const closedFailure = supportedV2ClosedFailure(payload, rt?.v2RunnerResult)
    if (!/^[0-9a-f]{32}$/.test(receiptId || '') ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        typeof effectId !== 'string' || !effectId ||
        typeof generation !== 'string' || !/^[0-9a-f]{32}$/.test(generation) ||
        typeof resultText !== 'string' ||
        rt.v2RunnerCloseEvidenceId !==
          `sbot-c2-runner-closed-v1:${receiptId}:${generation}` ||
        rt.v2SessionCloseEventId !==
          `sbot-c2-session-close-v1:${receiptId}:${generation}` ||
        receipt?.source !== 'message' || receipt.chatId !== chatId ||
        snapshot.state?.lanes?.turn?.[chatId]?.active !== turnToken ||
        snapshot.state?.lanes?.handoff?.[chatId]?.phase !== 'running' ||
        snapshot.state.lanes.handoff[chatId].turnToken !== turnToken ||
        binding?.type !== 'dispatch' || binding.effectId !== effectId ||
        binding.turnToken !== turnToken ||
        !cohort ||
        snapshot.effects?.get(effectId) !== 'acked' ||
        !Number.isSafeInteger(rt.v2StartedAt) || rt.v2StartedAt <= 0 ||
        job.msg.msgId !== receipt.sourceId ||
        job.msg.replyCtx?.chatId !== chatId ||
        job.msg.replyCtx.messageId !== receipt.sourceId ||
        (typeof job.platform?.createStreamingCard !== 'function' &&
          typeof job.platform?.replyOnce !== 'function') ||
        !payload || typeof payload !== 'object' || Array.isArray(payload) ||
        payload.type !== 'finalizeEffectCommit' ||
        payload.receiptId !== receiptId || payload.turnToken !== turnToken ||
        payload.quiet !== receipt.quiet || payload.resultText !== resultText ||
        (cohort.receiptIds.length > 1 &&
          (!isDeepStrictEqual(payload.batchReceiptIds, cohort.receiptIds) ||
            payload.replyTargetReceiptId !== receiptId)) ||
        !isDeepStrictEqual(payload, projected.payload) ||
        // A deterministic failure is delivered once, after the same durable
        // close checks as success. Retry and unknown outcomes stay sealed.
        (payload.source !== 'result' && !closedFailure) || payload.aborted || (payload.isError && !quotaFailure && !closedFailure) ||
        payload.sessionMissing || (payload.hasQuota && !quotaFailure) || payload.transientNetwork ||
        payload.freshRetried || payload.resumedSessionCurrent ||
        (replyText !== undefined && replyText !== terminalReplyText(projected.payload)) ||
        rt.v2TerminalStarted) {
      authority.close()
      throw new Error('C2 v2 card terminal differs from accepted turn')
    }
    rt.v2TerminalStarted = true
    const verifyGeneration = value => value.chatId === chatId &&
      value.receiptId === receiptId && value.turnToken === turnToken &&
      value.generation === generation && rt.v2RunnerGeneration === generation
    try {
      const preopened = rt.v2CardBinding
      if (closedFailure) authority.assertClosedFailureReady({ receiptId, chatId,
        turnToken, generation, verifyGeneration,
        assertWriterLock: this.durableV2AssertWriterLock })
      if (preopened && (preopened.receiptId !== receiptId ||
          preopened.turnToken !== turnToken ||
          preopened.generation !== generation)) {
        throw new Error('C2 v2 streamed card differs from terminal turn')
      }
      const path = preopened?.path || prepareCardTerminalPath({ runtime: authority,
        payloadHandles: handles, platform: job.platform,
        replyCtx: job.msg.replyCtx, cardAnchor: rt.v2CardAnchor, preferPlain: closedFailure,
        receiptId, chatId, turnToken, generation,
        verifyGeneration, applyLocalEffect: this.durableV2ApplyLocalEffect,
        assertWriterLock: this.durableV2AssertWriterLock,
        redactText: text => redact(quotaFailure
          ? T.quotaFailure
          : text, { pii: job.group?.redactPii !== false }),
        sendPlainReply: typeof job.platform.replyOnce === 'function'
          ? (target, text) => job.platform.replyOnce(target.replyCtx, text)
          : null })
      const suppressCard = (payload.quiet || projected.display.silent) &&
        projected.display.assistantEvents === 0 && updates.length === 0
      if (!preopened) await path.open({ suppressCard })
      for (const text of updates) path.update(text)
      const footer = T.cardFooter({ ms: Math.max(0, Date.now() - rt.v2StartedAt),
        tokens: rt.v2UsageDecision?.tokens || null })
      const footerDetail = job.platform.features?.cardQuota === true
        ? cardModelDetail(rt.v2CardModelInfo, rt.v2RunnerResult) : ''
      // Milestones from tool calls first, then the model's own `>> ` lines;
      // the card shows them in its "process" fold (display only).
      rt.v2CardQuotaFailure = !!quotaFailure
      const redactMilestone = value => redact(value, { pii: job.group?.redactPii !== false })
      const milestones = [...(rt.v2AutoMilestones || []),
        ...progress.milestonesOf(payload.bufferText)]
        .filter((m, i, a) => a.indexOf(m) === i).map(redactMilestone)
        .filter(m => typeof m === 'string' && m.trim())
      this._observeActivity('sending', { chatId, receiptId })
      const completed = await path.complete({ payload, replyText, paused,
        footer, footerDetail, milestones })
      this._observeActivity('finish', { chatId, receiptId,
        status: quotaFailure || closedFailure ? 'error' : payload.quiet || projected.display.silent ? 'silent' : 'answered',
        reply: redact(quotaFailure ? T.quotaFailure : replyText || '', { pii: job.group?.redactPii !== false }),
        err: quotaFailure ? T.quotaFailure : closedFailure ? terminalReplyText(payload) : '',
        tokens: rt.v2UsageDecision?.tokens || null, sessionId: projected.display.sessionId })
      const after = authority.snapshot()
      const queue = after.state?.lanes?.queue?.[chatId]?.queue
      let successor = null
      if (completed?.nextReceiptId === null) {
        if (!Array.isArray(completed.pendingEffects) ||
            completed.pendingEffects.length !== 0 ||
            !Array.isArray(queue) || queue.length !== 0 ||
            after.state?.lanes?.turn?.[chatId]?.active !== null ||
            after.state?.lanes?.handoff?.[chatId]?.phase !== 'idle' ||
            after.receipts.pending.some(item => item.chatId === chatId) ||
            !Array.isArray(rt.v2QueueReceiptIds) ||
            rt.v2QueueReceiptIds.length !== 0) {
          throw new Error('C2 v2 terminal successor lacks durable dispatch wiring')
        }
      } else {
        if (!this.durableV2Journal || !this.durableV2AssertWriterLock) {
          throw new Error('C2 v2 terminal successor lacks durable dispatch wiring')
        }
        const next = continueC2Successor({ runtime: authority,
          journal: this.durableV2Journal, payloadHandles: handles,
          chatId, priorReceiptId: receiptId, priorTurnToken: turnToken,
          terminalResult: completed, generation: randomBytes(16).toString('hex'),
          assertWriterLock: this.durableV2AssertWriterLock })
        if (!ordinaryV2Cohort(authority.snapshot(), next.jobs,
          { receiptIds: next.jobReceiptIds,
            batchReceiptIds: next.batchReceiptIds }, chatId, next.receiptId) ||
            !isDeepStrictEqual(rt.v2QueueReceiptIds,
              [...next.jobReceiptIds, ...next.queuedReceiptIds])) {
          throw new Error('C2 v2 successor jobs differ from queued host state')
        }
        successor = next
      }
      rt.v2RunnerResult = null
      rt.v2TerminalProjection = null
      rt.v2UsageDecision = null
      rt.v2StartedAt = null
      rt.v2AutoMilestones = []
      rt.v2CardQuotaFailure = false
      rt.v2CardBinding = null
      rt.v2StreamRequested = false
      rt.v2TimeoutProof = null
      rt.v2RunningJobs = null
      rt.v2RunnerGeneration = null
      rt.v2RunnerCloseEvidenceId = null
      rt.v2SessionCloseEventId = null
      rt.v2DispatchEffect = null
      rt.v2TurnToken = null
      rt.v2TerminalStarted = false
      if (successor) {
        rt.v2QueueReceiptIds = [...successor.queuedReceiptIds]
        rt.v2RunningJobs = [...successor.jobs]
        rt.v2TurnToken = successor.turnToken
        rt.v2DispatchEffect = { effectId: successor.effectId,
          type: 'dispatch', turnToken: successor.turnToken,
          receiptIds: [...successor.jobReceiptIds],
          batchReceiptIds: [...successor.batchReceiptIds] }
        return { ...completed, settledReceiptIds: cohort.receiptIds,
          successor: { receiptId: successor.receiptId,
          turnToken: successor.turnToken, effectId: successor.effectId,
          cursor: successor.cursor } }
      }
      return { ...completed, settledReceiptIds: cohort.receiptIds }
    } catch (error) { authority.close(); throw error }
  }

classifyDurableV2UnresolvedTurn({ chatId, receiptId, turnToken, effectId,
    payload } = {}) {
    const authority = this.durableV2Runtime
    const rt = typeof chatId === 'string' && chatId ? this._rt(chatId) : null
    if (!authority || authority.blocked || !rt ||
        typeof authority.commitUnresolvedClassification !== 'function') {
      throw new Error('C2 v2 unresolved classification is unavailable')
    }
    try {
      const snapshot = authority.snapshot()
      const receipt = snapshot.receipts?.pending?.find(item => item.id === receiptId)
      const binding = rt.v2DispatchEffect
      const jobs = rt.v2RunningJobs
      const cohort = ordinaryV2Cohort(snapshot, jobs, binding, chatId, receiptId)
      const generation = rt.v2RunnerGeneration
      if (!/^[0-9a-f]{32}$/.test(receiptId || '') ||
          !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
          typeof effectId !== 'string' || !effectId ||
          typeof generation !== 'string' || !/^[0-9a-f]{32}$/.test(generation) ||
          rt.v2RunnerCloseEvidenceId !==
            `sbot-c2-runner-closed-v1:${receiptId}:${generation}` ||
          rt.v2SessionCloseEventId !==
            `sbot-c2-session-close-v1:${receiptId}:${generation}` ||
          receipt?.source !== 'message' || receipt.chatId !== chatId ||
          snapshot.state?.lanes?.turn?.[chatId]?.active !== turnToken ||
          snapshot.state?.lanes?.handoff?.[chatId]?.phase !== 'running' ||
          snapshot.state.lanes.handoff[chatId].turnToken !== turnToken ||
          binding?.type !== 'dispatch' || binding.effectId !== effectId ||
          binding.turnToken !== turnToken ||
          !cohort ||
          snapshot.effects?.get(effectId) !== 'acked' ||
          cohort.anchor.msg.msgId !== receipt.sourceId ||
          !payload || typeof payload !== 'object' || Array.isArray(payload) ||
          !isDeepStrictEqual(payload, rt.v2TerminalProjection?.payload) ||
          rt.v2TerminalStarted) {
        throw new Error('C2 v2 unresolved classification differs from accepted turn')
      }
      const terminal = { ...payload, type: 'finalize' }
      delete terminal.receiptId
      delete terminal.turnToken
      delete terminal.quiet
      const status = engineTerminalStep({ finalized: false, outcome: null },
        terminal).state.outcome.status
      if (!['error', 'empty', 'stopped'].includes(status)) {
        throw new Error('C2 v2 unresolved classification needs error, empty or stopped outcome')
      }
      rt.v2TerminalStarted = true
      authority.registerTerminalCallback({ receiptId, generation,
        registeredAt: Date.now(), reuse: true })
      return authority.commitUnresolvedClassification({ receiptId, generation,
        turnToken, status, payload,
        verifyGeneration: value => value.chatId === chatId &&
          value.receiptId === receiptId && value.turnToken === turnToken &&
          value.generation === generation && rt.v2RunnerGeneration === generation,
        assertWriterLock: this.durableV2AssertWriterLock })
    } catch (error) { authority.close(); throw error }
  }

  _prepareRunnerPrompt({ msg, group, platform, providerName, provider, batch, rt }) {
    if (rt.cancelled) throw new Error('C2 v2 cancelled prompt lacks durable control event')
    const line = m => `[${fmtStamp(m.createTimeMs || Date.now(), this.tz)} ${m.senderName || m.userId || 'user'}] ${(m.text || '').trim()}`
    const policy = manifestPolicy(group.permissionMode, provider.runner === 'codex',
      group.allowedTools, group.disallowedTools)
    const brand = this.cfg.brand || 'SintBot'
    const groupTools = group.platform === 'feishu' && manifestFeatures(platform.features || {}).skills
    const info = group.repo && this.repoInfo ? this.repoInfo(group.workdir, group.repo) : null
    const manifest = [
      ...manifestHeader({ restrictedV2: true, brand, chatLabel: platform.chatLabel || '项目群',
        chatId: msg.chatId, groupName: group.name || msg.chatId,
        workdir: group.workdir, repo: group.repo || '', repoState: info?.state || '',
        repoOrigin: info?.origin || '未知', pushDenied: policy.pushDenied,
        providerName, model: this._brain(group, providerName, provider).model,
        runtimeVersion: this.durableV2Version || '', runtimeCommand: runtimeCommand(),
        noVision: provider.vision === false, platformName: platform.chatLabel || '项目群',
        permissionTier: policy.tier, tz: this.tz, publicUrl: '', uiUrl: '', lanUrl: '' }),
      ...manifestContext({ restrictedV2: true, brand, isCodex: provider.runner === 'codex',
        groupCommands: GROUP_COMMANDS, groupTools,
        consoleEnabled: this.durableV2ConsoleEnabled === true,
        pmem: this.projectMemory ? this.projectMemory(group.workdir,
          { full: policy.full, isCodex: provider.runner === 'codex' }) : null,
        unredactedPii: group.redactPii === false,
        cardPinned: platform.features?.cardPinned === true, plainSend: false }),
      ...(groupTools ? releaseSkillLines(platform) : []),
    ].join('\n')
    // Reinject current supported context each turn. No legacy feature menu,
    // external-message commands or v1 manifest refresh scheduler is included.
    return turnPrompt({ lines: batch?.length > 1 ? batch.map(line) : [line(msg)],
      cancelled: null, compacted: rt?.v2Compacted === true, manifest, updated: false })
  }

  handleMessage() { throw new Error('legacy Engine execution path is not enabled') }

  // ── 空闲整理(ABI 37:核心 idle_compact_plan / idle_compact_settle 定规则,这里只起停进程)──────────
  // 一轮正常收尾、群里没人在等时,对同一个 Claude 会话跑一次无头 /compact,把压缩从成员等着的轮次挪到间隙。
  // 没有收据的运行不进持久日志:只占一个并发槽、写 store 的会话统计、记守护进程日志。不占群锁(rt.v2Compacting
  // 只是句柄):新消息照常走空闲路径,起轮前先 _stopIdleCompact 并等进程退出;/new、换型号、关停同样先停。
  _idleCompactThreshold(provider) {
    const raw = Number(provider?.autocompactTokens) || 0
    return raw > 0 ? Math.min(1_000_000, Math.max(100_000, Math.floor(raw))) : 0
  }

  _idleCompactCapability(rt, name) {
    return rt?.v2CanCompact && rt.v2CanCompact.provider === name ? rt.v2CanCompact.ok : null
  }

  _maybeIdleCompact(rt, status) {
    if (!this.durableV2CompactSession || !this.durableV2CapacitySnapshot || !rt) return
    try {
      const chatId = rt.chatId
      const group = this.cfg.groups?.[chatId]
      if (!group) return
      const { name, provider } = this._resolveProvider(chatId, group)
      if (!provider || provider.runner !== 'claude') return
      const sid = this.store.getSession(chatId) || null
      const stats = this.store.getSessionStats(chatId) || null
      const cap = this.durableV2CapacitySnapshot()
      const freeSlots = cap && !cap.closed ? Math.max(0, cap.maxConcurrent - cap.active - cap.waiting) : 0
      const outcome = status === 'answered' ? 'ok' : status === 'silent' ? 'no-reply' : String(status || '')
      const plan = idleCompactPlan({ threshold: this._idleCompactThreshold(provider), ctx: stats?.ctx || 0,
        canCompact: this._idleCompactCapability(rt, name), outcome,
        busy: this._durableV2GroupBusy(chatId) || !!rt.v2Compacting,
        queued: rt.v2QueueReceiptIds?.length || 0,
        paused: group.paused === true, closing: this._closing === true,
        sessionMatch: !!(sid && stats && stats.sessionId === sid), freeSlots,
        restUntil: rt.v2CompactRest && rt.v2CompactRest.sid === sid ? rt.v2CompactRest.until : null,
        now: Date.now() })
      if (!plan.start) {
        if (plan.at > 0 && (stats?.ctx || 0) >= plan.at) this.log(`group ${chatId}: 空闲整理未起 — ${plan.reason}`)
        return
      }
      this._startIdleCompact(rt, { group, name, provider, sid, ctx: stats.ctx, plan })
    } catch (error) {
      this.log(`group ${rt.chatId}: 空闲整理判定出错(忽略): ${error.message}`)
    }
  }

  _startIdleCompact(rt, { group, name, provider, sid, ctx, plan }) {
    const chatId = rt.chatId
    const brain = this._brain(group, name, provider) // 可能抛:要在挂句柄之前
    const controller = new AbortController()
    const rec = { controller, sid, provider: name, boundary: null, startedAt: Date.now(), why: '', lateKill: null, exited: null, skip: false, closed: false }
    rt.v2Compacting = rec
    this.log(`group ${chatId}: 空闲整理开始 — 上下文约 ${fmtWan(ctx)},过了整理线 ${fmtWan(plan.at)}`)
    const cap = setTimeout(() => { if (!rec.why) rec.why = '超时'; controller.abort() }, plan.maxMs)
    cap.unref?.()
    rec.exited = (async () => {
      let release = null, result = null, error = null, spawned = false, verified = false
      try {
        if (this.durableV2AcquireCapacity) release = await this.durableV2AcquireCapacity({ signal: controller.signal })
        if (controller.signal.aborted) {
          const stopped = new Error('idle compaction stopped before start'); stopped.code = 'IDLE_COMPACT_STOPPED'; throw stopped
        }
        // ⚠ 与平时轮次同一组启动参数(工具、MCP、系统提示附录、型号、深度、env)—— 缓存才命中。
        const input = prepareC2CompactionInput({ appendSystemPrompt: SYSTEM_APPENDIX, chatId, group, provider,
          config: this.cfg, brain: { model: brain.model, effort: brain.effort }, sessionId: sid,
          signal: controller.signal, extraEnv: this.baseSkillEnv(chatId), keep: plan.keep, log: this.log,
          onEvent: event => {
            if (event.type !== 'system') return
            if (event.subtype === 'init' && Array.isArray(event.slashCommands)) {
              rt.v2CanCompact = { provider: name, ok: event.slashCommands.includes('compact') }
            } else if (compactEvent(event.subtype || '')) {
              rec.boundary = { pre: event.preTokens || ctx, post: event.postTokens || 0 }
            }
          } })
        const started = this.durableV2CompactSession(input)
        if (started === null) {
          rt.v2CanCompact = { provider: name, ok: false }
          rec.skip = true
          this.log(`group ${chatId}: 空闲整理 — 这个后端不支持,只在轮内压缩`)
          return true
        }
        spawned = true
        result = await started
        verified = this.durableV2VerifyRunnerClosed({ result }) === true
      } catch (e) {
        error = e
        verified = !spawned || this.durableV2VerifyRunnerClosed({ error: e }) === true
      } finally {
        clearTimeout(cap)
        if (rec.lateKill) clearTimeout(rec.lateKill)
        rec.closed = !spawned || verified
        if (rec.closed) {
          try { this._settleIdleCompact(rt, rec, result, error) } catch (e) { this.log(`group ${chatId}: 空闲整理收尾出错(忽略): ${e.message}`) }
          if (release) { try { release() } catch (e) { this.log(`group ${chatId}: model permit release failed: ${e.message}`) } }
          if (rt.v2Compacting === rec) rt.v2Compacting = null
        } else {
          // Keep the handle as well as the permit: drain, recovery and the next
          // session writer must all see the same unresolved close evidence.
          rec.closeError = error || Object.assign(new Error('Compaction close remains unproven'), { code: 'IDLE_COMPACT_CLOSE_UNPROVEN' })
          this.log(`group ${chatId}: model permit kept until restart; compaction close unproven`)
          try { this.durableV2Runtime.close() } catch {}
        }
      }
      return rec.closed
    })()
  }

  _settleIdleCompact(rt, rec, result, error) {
    if (rec.skip) return
    const chatId = rt.chatId
    const res = result?.result || null
    const now = Date.now()
    const live = this.store.getSession(chatId) === rec.sid
    const failureText = error ? String(error.message || error) : res?.isError ? String(res.text || res.subtype || '') : ''
    const quota = res?.quota || (failureText ? classifyError(failureText)?.quota : null)
    const out = idleCompactSettle({ boundary: rec.boundary, resultError: !!res?.isError, quota: !!quota,
      error: failureText,
      aborted: rec.controller.signal.aborted, why: rec.why,
      fails: rt.v2CompactFails && rt.v2CompactFails.sid === rec.sid ? rt.v2CompactFails.n : 0,
      resetAt: null, elapsedMs: now - rec.startedAt, now, live })
    if (out.status === 'compacted' && live) {
      rt.v2Compacted = true // 下一轮带「进度可能已折叠为摘要」
      let locked = false
      try { locked = this.durableV2AssertWriterLock() === true } catch {}
      const stats = this.store.getSessionStats(chatId)
      // 群忙(新消息刚停掉整理)时不碰统计:那一轮结算会写新值。
      if (locked && stats && stats.sessionId === rec.sid && !this._durableV2GroupBusy(chatId)) {
        const next = { ...stats, compactedAt: now }
        if (out.ctx) next.ctx = out.ctx; else delete next.ctx
        this.store.putSessionStats(chatId, next)
      }
    }
    rt.v2CompactFails = { sid: rec.sid, n: out.fails }
    rt.v2CompactRest = out.restUntil ? { sid: rec.sid, until: out.restUntil } : null
    this.log(`group ${chatId}: ${out.notice}`)
  }

  // 同步发出停止信号,返回「进程退干净了」的 Promise(没有在跑 ⇒ null)。已收到压缩边界 ⇒ 不杀(压完了只差落盘),
  // 兜底 10 s 再杀;否则立刻 abort(与普通轮同一条两段式收尾)。
  _stopIdleCompact(rt, why, { force = false } = {}) {
    const rec = rt?.v2Compacting
    if (!rec) return null
    if (!rec.why) rec.why = why
    if (rec.boundary && !force) {
      if (!rec.lateKill) { rec.lateKill = setTimeout(() => { try { rec.controller.abort() } catch {} }, 10_000); rec.lateKill.unref?.() }
    } else { try { rec.controller.abort() } catch {} }
    return rec.exited
  }

  // 控制台 / 配置写入是同步接口:只能发信号,所以不等边界、立刻杀,收尾认不到会话就不记统计。
  stopIdleCompact(chatId, why = '会话已重置') { return this._stopIdleCompact(this.rts.get(chatId), why, { force: true }) }

  // 起轮前等整理退出。等待期间挂「等并发名额」的标志与控制器,让这期间到的消息按排队处理;
  // 关停会中止这个控制器 ⇒ 返回 false,调用方按「派发前被打断」收场。
  async _awaitIdleCompactStop(rt) {
    const stopping = this._stopIdleCompact(rt, '新消息')
    if (!stopping) return true
    const controller = new AbortController()
    rt.v2AdmissionController = controller
    rt.v2AdmissionPending = true
    let closed = false
    try { closed = await stopping === true } finally {
      if (rt.v2AdmissionController === controller) rt.v2AdmissionController = null
    }
    if (!closed || controller.signal.aborted) { rt.v2AdmissionPending = false; return false }
    return true
  }

  stop(chatId) {
    const rt = this.rts.get(chatId)
    return rt?.v2NormalRouteActive ? this.requestDurableV2Stop(chatId) : false
  }

requestDurableV2Stop(chatId) {
    const rt = this.rts.get(chatId)
    if (!this.durableV2NormalRoute || !rt?.v2NormalRouteActive ||
        !rt.v2RunningJobs?.length || rt.v2TerminalStarted ||
        rt.v2CancelControl || rt.v2StopControl || rt.v2StreamQuiescing ||
        rt.v2TimeoutProof || !rt.v2Controller ||
        !this.durableV2Runtime || this.durableV2Runtime.blocked) return false
    try {
      if (this.durableV2AssertWriterLock() !== true) throw new Error('writer lock lost')
      const snapshot = this.durableV2Runtime.snapshot()
      const receiptId = rt.v2DispatchEffect?.receiptIds?.at(-1)
      if (!ordinaryV2Cohort(snapshot, rt.v2RunningJobs,
        rt.v2DispatchEffect, chatId, receiptId) ||
          snapshot.state?.lanes?.turn?.[chatId]?.active !== rt.v2TurnToken ||
          snapshot.state?.lanes?.handoff?.[chatId]?.phase !== 'running') {
        throw new Error('console stop differs from durable running cohort')
      }
      const controller = rt.v2Controller
      const generation = rt.v2RunnerGeneration
      let releaseGate
      rt.v2StopIntentGate = new Promise(resolve => { releaseGate = resolve })
      rt.v2StreamQuiescing = true
      rt.v2CancelControl = 'stop'
      Promise.resolve().then(async () => {
        if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
        await rt.v2StreamChain
        if (rt.v2CardBinding?.opened) {
          await rt.v2CardBinding.path.flushForTerminal()
        }
        if (rt.v2RunnerGeneration !== generation ||
            rt.v2TimeoutProof || this.durableV2AssertWriterLock() !== true) {
          throw new Error('console stop lost exact running turn')
        }
      }).catch(error => {
        this.durableV2Runtime.close()
        this.log(`group ${chatId}: durable console stop closed: ${error.message}`)
      }).finally(() => {
        try { controller.abort() } catch { this.durableV2Runtime.close() }
        releaseGate()
      })
      return true
    } catch (error) {
      this.durableV2Runtime.close()
      this.log(`group ${chatId}: durable stop closed: ${error.message}`)
      return false
    }
  }

  handleRecall({ chatId, msgId } = {}) {
    if (!chatId || !msgId) return false
    const rt = this.rts.get(chatId)
    if (!rt || !this.durableV2NormalRoute || !rt.v2NormalRouteActive) return false
    const authority = this.durableV2Runtime
    const receiptId = taskId({ source: 'message', chatId, sourceId: msgId })
    if (rt.v2QueueReceiptIds?.includes(receiptId)) {
      try {
        authority.commitQueuedCancellation({ receiptId, chatId, control: 'recall',
          payloadHandles: this.durableV2Payloads,
          assertWriterLock: this.durableV2AssertWriterLock })
        rt.v2QueueReceiptIds = rt.v2QueueReceiptIds.filter(id => id !== receiptId)
        this._observeActivity('finish', { chatId, receiptId, status: 'recalled' })
        return true
      } catch (error) { authority?.close(); this.log(error.message); return false }
    }
    if ((rt.v2SteerEntries?.has(receiptId) ||
        rt.v2RunningJobs?.length === 1 && rt.v2RunningJobs[0]?.msg?.msgId === msgId) &&
        !rt.v2TerminalStarted) {
      rt.v2CancelControl = 'recall'
      if (rt.v2Controller) { try { rt.v2Controller.abort() } catch { authority?.close() } }
      return true
    }
    return false
  }

}

module.exports = { releaseBinDir, Engine }
