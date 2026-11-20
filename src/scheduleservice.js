'use strict'
// Scheduled tasks in the running service: the minute tick, the questions to
// the core, and the edits the console makes.
//
// The host's part is to keep the definitions and the ledger (src/schedules.js),
// tell the time (src/scheduletime.js) and carry out effects (src/schedulefire.js).
// Every decision is the core's (schedule_step, ABI 39):
//   "due"     does this occurrence fire or is it skipped, is it written to the
//             ledger, is a one-off task finished;
//   "result"  how a finished occurrence reads in the task list.
// There is no fallback: a core that cannot answer stops scheduled tasks.
//
// Each tick, for every enabled task, the latest occurrence since the task was
// created, enabled or rescheduled is put to the core together with whether
// the ledger already holds it. The first tick after a start does the same, so
// what was missed while the service was down is answered by the core too: it
// records one "missed" for the latest occurrence and nothing is made up for.
// An edit is read by the next tick; nothing waits for the conversation.
const { scheduleStep } = require('./agent/privatecore')
const { expandAt } = require('./scheduleexpr')
const { DEFAULT_TIMEOUT_MS } = require('./schedulescript')
const { compileSchedule, nextOccurrence, prevOccurrence, describeSchedule, minuteOfWall,
  isValidTz, normalizeTz, MINUTE_MS } = require('./scheduletime')
const { newTaskId, KINDS, ScheduleStoreError } = require('./schedules')

// Conversations a scheduled task can be created for. A WeCom conversation is
// refused: see `unsupportedReason`.
const PLATFORMS = Object.freeze(['feishu', 'slack', 'local'])
const DEFAULT_TIMEOUT_MIN = DEFAULT_TIMEOUT_MS / MINUTE_MS

// Every sentence a schedule request can be refused with, in one place: the
// console's English dictionary is checked against `refusalSamples()` below
// (tests/unit/console-schedules.test.js), so a new sentence cannot be added
// here without its translation.
const SAY = {
  unavailable: () => '当前运行方式未接入定时任务',
  storeFault: () => '定时任务当前不可用：任务数据无法读取或写入，已停止触发（详见服务日志）',
  coreFault: () => '定时任务当前不可用：决策核心没有给出答复，已停止触发（详见服务日志）',
  wecom: () => '企业微信会话暂不支持定时任务：企业微信的主动推送需要会话里先有人 @ 过机器人，也不返回可核对的消息编号',
  platform: () => '这个会话所在的平台暂不支持定时任务',
  noConversation: () => '没有这个群项目',
  noTask: () => '没有这个定时任务',
  nameMissing: () => '任务名称必填',
  nameLines: () => '任务名称不能换行',
  nameLong: (length, max) => `任务名称过长（${length} 字，上限 ${max}）`,
  kind: () => '任务类型须为 model（交给模型处理）、script（运行命令）或 say（只发一句）',
  textMissing: kind => kind === 'model' ? '任务内容必填' : kind === 'script' ? '命令必填' : '消息文本必填',
  textLong: (length, max) => `内容过长（${length} 字，上限 ${max}）`,
  slash: () => '定时任务不执行斜杠命令，请直接写要做的事',
  zone: () => '时区无法识别（示例：Asia/Shanghai、America/New_York）',
  whenBoth: () => '循环时间（expr）与一次性时间（at）只能填一个',
  whenMissing: () => '请填写循环时间（expr）或一次性时间（at）',
  atInvalid: () => '一次性时间无效',
  exprInvalid: () => 'cron 表达式无效',
  // A step as large as its field never steps: "*/90" in the minute field
  // fires at minute 0 only, which is not what "every 90 minutes" asks for.
  stepMinute: part => `分钟字段「${part}」的步长超出范围：分钟只有 0–59，这样写每小时只在起始那一分钟触发一次；步长请用 1–59`,
  stepHour: part => `小时字段「${part}」的步长超出范围：小时只有 0–23，这样写每天只在起始那个小时触发；步长请用 1–23`,
  atGap: () => '这个时间在该时区不存在（日期无效或正逢夏令时拨快），请换一个时间',
  atPast: () => '一次性时间已经过去',
  never: () => '这个时间表达式不会到点（例如 2 月 31 日），请检查',
  timeout: max => `超时须为 1–${max} 的整数（分钟）`,
  enabled: () => 'enabled 须为布尔值',
  expired: () => '这个一次性任务的时间已经过去，请先修改时间',
  limit: max => `每个会话最多 ${max} 个定时任务，请先删除不用的`,
  total: () => '定时任务总数已达上限',
  notSaved: () => '定时任务没有保存：任务数据当前无法写入（详见服务日志）',
}
// One example of every refusal sentence, the parser's own included (they are
// produced by the parser itself here, so its wording cannot drift either).
function refusalSamples() {
  const thrown = action => { try { action() } catch (error) { return error.message } throw new Error('expected a refusal') }
  const zone = 'Asia/Shanghai'
  return [SAY.unavailable(), SAY.storeFault(), SAY.coreFault(), SAY.wecom(), SAY.platform(), SAY.noConversation(), SAY.noTask(),
    SAY.nameMissing(), SAY.nameLines(), SAY.nameLong(61, 60), SAY.kind(), SAY.textMissing('model'), SAY.textMissing('script'),
    SAY.textMissing('say'), SAY.textLong(4001, 4000), SAY.slash(), SAY.zone(), SAY.whenBoth(), SAY.whenMissing(), SAY.atInvalid(),
    SAY.exprInvalid(), SAY.stepMinute('*/90'), SAY.stepHour('0-12/24'), SAY.atGap(), SAY.atPast(), SAY.never(), SAY.timeout(720),
    SAY.enabled(), SAY.expired(), SAY.limit(20), SAY.total(), SAY.notSaved(),
    thrown(() => compileSchedule({ expr: ' ' })), thrown(() => compileSchedule({ at: 'x' })),
    thrown(() => compileSchedule({ expr: 'whenever' })), thrown(() => compileSchedule({ expr: '61 9 * * *' })),
    thrown(() => compileSchedule({ expr: '0 9 * * x' })), thrown(() => compileSchedule({ expr: '0 9 1-0 * *' })),
    thrown(() => expandAt('soon', 0, zone)), thrown(() => expandAt('25:00', 0, zone)), thrown(() => expandAt('2026-13-01 09:00', 0, zone)),
    thrown(() => expandAt('13-40 09:00', 0, zone))]
}

class ScheduleError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ScheduleError'
    this.status = status
    this.code = code
  }
}
const refuse = (status, code, message) => { throw new ScheduleError(status, code, message) }

// Dependencies, all injected:
//   store                the opened schedule store
//   getConfig()          the live configuration (groups, timezone)
//   chatFacts(chatId)    the `chat` object of the core's "due" step
//   firing               { fire, notify, stop } (src/schedulefire.js)
//   platformOf(chatId)   'feishu' | 'slack' | 'local' | 'wecom' | …
function createScheduleService({ store, getConfig, chatFacts, firing, platformOf, core = scheduleStep,
  now = () => Date.now(), log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  for (const hook of [getConfig, chatFacts, platformOf, core, now, log, setTimer, clearTimer, firing?.fire, firing?.notify, firing?.stop]) {
    if (typeof hook !== 'function') throw new TypeError('schedule service needs explicit hooks')
  }
  if (!store || typeof store.claim !== 'function') throw new TypeError('schedule service needs its store')
  let timer = null
  let started = false
  let stopped = false
  let halted = null            // why the tick stopped asking (a core fault)
  const searches = new Map()   // task id -> { signature, schedule, through, latest }
  const answered = new Map()   // task id -> the claimed occurrence the core has already answered for
  const inflight = new Set()

  const productZone = () => normalizeTz(getConfig().timezone)
  const zoneOf = task => task.tz && isValidTz(task.tz) ? task.tz : productZone()
  const minuteNow = () => Math.floor(now() / MINUTE_MS)

  // The latest occurrence of a task up to this minute, counted from after the
  // minute it was created, enabled or rescheduled. Found once by a backward
  // search (from the ledger's newest occurrence when it has one), then kept
  // current one minute at a time.
  function latestOccurrence(task, zone, minute) {
    const signature = `${task.expr || ''}|${task.at || ''}|${zone}|${task.since}`
    let search = searches.get(task.id)
    // Searched again from the ledger when the schedule changed, and when the
    // clock is behind where the search already got to (it was ahead for a
    // while): what was recorded for a future minute stays claimed, but it must
    // not hide the occurrences between now and then.
    if (!search || search.signature !== signature || minute < search.through) {
      const known = store.latestOccurrence(task.id, minute)
      search = { signature, schedule: search?.signature === signature ? search.schedule : compileSchedule(task), latest: null,
        through: Math.max(Math.floor(task.since / MINUTE_MS), known === null ? -1 : known - 1) }
      searches.set(task.id, search)
    }
    if (minute > search.through) {
      const found = prevOccurrence(search.schedule, search.through, minute, zone)
      if (found !== null) search.latest = found
      search.through = minute
    }
    return search.latest !== null && search.latest <= minute ? search.latest : null
  }

  // A one-off that the core has finished: kept in the list, switched off for
  // good, so its last result stays readable. Old ones make room for new ones.
  function retire(task) {
    const current = store.get(task.id)
    if (!current || current.retired) return
    store.replace({ ...current, enabled: false, retired: true, updatedAt: now() })
    const retired = store.tasks().filter(item => item.chatId === current.chatId && item.retired)
      .sort((a, b) => a.updatedAt - b.updatedAt)
    while (retired.length > store.limits.tasks) forget(retired.shift().id)
  }
  function forget(id) {
    store.remove(id)
    searches.delete(id); answered.delete(id)
  }

  // Every question to the core goes through here. One that is not answered
  // (malformed input, a fault in the core) is never read as "skip": the tick
  // stops asking until the service starts again.
  function ask(input) {
    try { return core(input) } catch (error) {
      if (!halted) {
        halted = `the core did not answer: ${error?.message || String(error)}`
        log(`scheduled tasks stopped: ${halted}`)
      }
      throw error
    }
  }

  // Ask the core how the occurrence reads and write that to the ledger.
  function settle(task, occurrence, result) {
    const verdict = ask({ type: 'result', kind: task.kind, outcome: result.outcome,
      exitCode: result.outcome === 'exit' ? result.exitCode : null, reason: result.reason ?? null })
    store.settle(task.id, occurrence, { status: verdict.status,
      reason: verdict.status === 'ok' ? null : result.reason ?? null, detail: result.detail ?? null, at: now() })
    return verdict
  }

  function launch(task, occurrence, zone) {
    // Asked again by a model task once its line is posted: the same question
    // with the facts of that moment (the claim just written is this very
    // attempt, so it is put as not claimed). Null while the core still says fire.
    const recheck = () => {
      const again = ask({ type: 'due', task: { kind: task.kind, enabled: task.enabled, once: task.once },
        occurrence, now: Math.max(occurrence, minuteNow()), claimed: false, chat: chatFacts(task.chatId) })
      return again.decision === 'fire' ? null : again.reason || 'refused'
    }
    const run = (async () => {
      const result = await firing.fire(task, occurrence, zone, { recheck })
      const verdict = settle(task, occurrence, result)
      // The core calls the run failed (and never retried): tell the
      // conversation once. The run itself is already in the ledger.
      if (task.kind === 'script' && verdict.status === 'failed' && result.notice) {
        const sent = await firing.notify(task, result.notice)
        if (sent !== 'sent') log(`scheduled script ${task.id}: failure notice ${sent}; not sent again`)
      }
    })().catch(error => log(`scheduled task ${task.id}: ${error?.message || String(error)}`))
      .finally(() => inflight.delete(run))
    inflight.add(run)
  }

  function evaluate(task, minute) {
    const zone = zoneOf(task)
    const occurrence = latestOccurrence(task, zone, minute)
    if (occurrence === null) return
    const claimed = store.claimed(task.id, occurrence)
    // The core's answer for an occurrence already in the ledger cannot change:
    // once it has said "claimed", the same question is not put again.
    if (claimed && answered.get(task.id) === occurrence) return
    const decision = ask({ type: 'due', task: { kind: task.kind, enabled: task.enabled, once: task.once },
      occurrence, now: minute, claimed, chat: chatFacts(task.chatId) })
    // Ledger first: nothing is posted or started unless the claim is on disk.
    if (decision.record) store.claim(task.id, occurrence, { decision: decision.decision, reason: decision.reason, at: now() })
    else if (decision.decision === 'fire') {
      halted = 'the core asked to fire without a ledger record'
      log(`scheduled tasks stopped: ${halted}`)
      throw new Error(halted)
    }
    if (claimed) answered.set(task.id, occurrence)
    if (decision.retire) retire(task)
    if (decision.decision === 'fire') return launch(task, occurrence, zone)
    if (decision.record) {
      settle(task, occurrence, { outcome: 'skipped', reason: decision.reason, detail: null })
      log(`scheduled task ${task.id} skipped (${decision.reason})`)
    }
  }

  function tick() {
    if (!started || stopped || halted) return
    if (store.fault) return
    const minute = minuteNow()
    for (const task of store.tasks()) {
      if (!task.enabled) continue
      // A task whose conversation is no longer in the configuration is left
      // alone: nothing is asked and nothing is written until it is back (or
      // the task is deleted, which stays possible).
      if (!groupOf(task.chatId)) continue
      try { evaluate(task, minute) } catch (error) {
        log(`scheduled task ${task.id} not evaluated: ${error?.message || String(error)}`)
        if (halted || store.fault) return
      }
    }
  }

  function arm() {
    if (stopped) return
    // Half a second into the next minute, so a tick lands inside it.
    timer = setTimer(() => {
      timer = null
      // Whatever a tick meets, the next minute is still armed.
      try { tick() } catch (error) { log(`scheduled tick failed: ${error?.message || String(error)}`) }
      arm()
    }, MINUTE_MS - (now() % MINUTE_MS) + 500)
    timer?.unref?.()
  }

  // ── The console's edits ───────────────────────────────────────────────────

  // Own entries only: "constructor" and the like are not conversations.
  const groupOf = chatId => {
    const groups = getConfig().groups
    return typeof chatId === 'string' && chatId && groups && Object.hasOwn(groups, chatId) ? groups[chatId] || null : null
  }
  function unsupportedReason(chatId) {
    if (store.fault) return SAY.storeFault()
    if (halted) return SAY.coreFault()
    const platform = platformOf(chatId)
    // A WeCom push is refused until someone has mentioned the bot in that
    // conversation, and its message id is made on this machine after the
    // acknowledgement, not given by the platform. Unattended use there is
    // not verified, so tasks are not created for it.
    if (platform === 'wecom') return SAY.wecom()
    if (!PLATFORMS.includes(platform)) return SAY.platform()
    return null
  }
  const requireGroup = chatId => groupOf(chatId) || refuse(404, 'no-conversation', SAY.noConversation())
  // A task is reachable only through its own conversation. `orphan`: also
  // when that conversation is no longer in the configuration (to delete it).
  function requireTask(chatId, id, { orphan = false } = {}) {
    const task = typeof id === 'string' ? store.get(id) : null
    if (!(orphan && task && task.chatId === chatId)) requireGroup(chatId)
    if (!task || task.chatId !== chatId) refuse(404, 'no-task', SAY.noTask())
    return task
  }
  const activeCount = chatId => store.tasks().filter(task => task.chatId === chatId && !task.retired).length
  const requireRoom = chatId => {
    if (activeCount(chatId) >= store.limits.tasks) refuse(409, 'limit', SAY.limit(store.limits.tasks))
  }
  const requireSupport = chatId => {
    const reason = unsupportedReason(chatId)
    if (reason) refuse(409, 'unsupported', reason)
  }

  const given = value => value !== undefined && value !== null && value !== ''
  // The fields of a task from what the console sent, over what the task
  // already has (`base`, null for a new one). Returns the stored shape
  // without id and times.
  function readFields(input, base, at) {
    const limits = store.limits
    const pickField = key => input[key] !== undefined ? input[key] : base?.[key]
    const name = String(pickField('name') ?? '').trim()
    if (!name) refuse(400, 'name', SAY.nameMissing())
    if (/[\r\n]/.test(name)) refuse(400, 'name', SAY.nameLines())
    if (name.length > limits.name) refuse(400, 'name', SAY.nameLong(name.length, limits.name))
    const kind = pickField('kind')
    if (!KINDS.includes(kind)) refuse(400, 'kind', SAY.kind())
    const text = String(pickField('text') ?? '').trim()
    if (!text) refuse(400, 'text', SAY.textMissing(kind))
    if (text.length > limits.text) refuse(400, 'text', SAY.textLong(text.length, limits.text))
    // A command typed in a conversation is answered by the service, not run
    // as a task; a schedule does not send one.
    if (kind === 'model' && text.startsWith('/')) refuse(400, 'text', SAY.slash())
    let tz = input.tz !== undefined ? input.tz : base?.tz
    if (!given(tz)) tz = undefined
    else if (typeof tz !== 'string' || tz.length > 64 || !isValidTz(tz)) refuse(400, 'tz', SAY.zone())
    const zone = tz || productZone()
    const hasExpr = given(input.expr), hasAt = given(input.at)
    if (hasExpr && hasAt) refuse(400, 'when', SAY.whenBoth())
    if (!hasExpr && !hasAt && !base) refuse(400, 'when', SAY.whenMissing())
    let when = base ? (base.at ? { at: base.at } : { expr: base.expr }) : null
    if (hasAt) {
      try { when = { at: expandAt(String(input.at), at, zone) } } catch (error) { refuse(400, 'when', error?.message || SAY.atInvalid()) }
    } else if (hasExpr) {
      try { when = { expr: compileSchedule({ expr: String(input.expr) }).expr } } catch (error) { refuse(400, 'when', error?.message || SAY.exprInvalid()) }
      // The parser takes a step of any size; one as large as the field is
      // refused here (minute and hour), where it would silently mean "once".
      const [minuteField, hourField] = when.expr.split(' ')
      for (const [field, size, say] of [[minuteField, 60, SAY.stepMinute], [hourField, 24, SAY.stepHour]]) {
        const part = field.split(',').find(item => Number(item.split('/')[1]) >= size)
        if (part) refuse(400, 'when', say(part))
      }
    }
    const rescheduled = !base || (when.at || null) !== (base.at || null) || (when.expr || null) !== (base.expr || null) ||
      (tz || null) !== (base.tz || null)
    if (rescheduled) {
      // A schedule that can never come is refused now, not left to sit.
      const minute = Math.floor(at / MINUTE_MS)
      if (when.at) {
        const due = minuteOfWall(when.at, zone)
        if (due === null) refuse(400, 'when', SAY.atGap())
        if (due <= minute) refuse(400, 'when', SAY.atPast())
      } else if (nextOccurrence(compileSchedule(when), minute, zone) === null) {
        refuse(400, 'when', SAY.never())
      }
    }
    let timeoutMin
    if (kind === 'script') {
      const raw = input.timeoutMin !== undefined ? input.timeoutMin : base?.kind === 'script' ? base.timeoutMin : undefined
      if (given(raw)) {
        if (!Number.isSafeInteger(raw) || raw < 1 || raw > limits.timeoutMin) refuse(400, 'timeoutMin', SAY.timeout(limits.timeoutMin))
        timeoutMin = raw
      }
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') refuse(400, 'enabled', SAY.enabled())
    return { fields: { name, kind, ...when, ...(tz ? { tz } : {}), text, once: !!when.at,
      ...(timeoutMin !== undefined ? { timeoutMin } : {}) }, rescheduled, zone }
  }
  // A one-off whose minute has come cannot be switched on again.
  function assertCanEnable(task, at) {
    if (!task.once) return
    const due = minuteOfWall(task.at, zoneOf(task))
    if (task.retired || due === null || due <= Math.floor(at / MINUTE_MS)) {
      refuse(409, 'expired', SAY.expired())
    }
  }
  const write = action => {
    try { return action() } catch (error) {
      if (error instanceof ScheduleStoreError) {
        refuse(409, error.code,
          error.code === 'limit' ? SAY.total() : SAY.notSaved())
      }
      throw error
    }
  }

  // The task as the console reads it (the HTTP API's Task).
  function view(task, at = now()) {
    const zone = zoneOf(task)
    const last = store.last(task.id)
    let nextRun = null
    if (task.enabled) {
      try {
        const next = nextOccurrence(compileSchedule(task), Math.floor(at / MINUTE_MS), zone)
        nextRun = next === null ? null : next * MINUTE_MS
      } catch { nextRun = null }
    }
    return { id: task.id, chatId: task.chatId, name: task.name, kind: task.kind,
      expr: task.expr ?? null, at: task.at ?? null, tz: zone, tzOwn: !!task.tz, text: task.text,
      enabled: task.enabled, once: task.once,
      // A one-off whose time has come and gone: kept for its last result, it
      // does not count toward the conversation's task limit.
      retired: task.retired === true,
      timeoutMin: task.kind === 'script' ? task.timeoutMin ?? DEFAULT_TIMEOUT_MIN : null,
      describe: describeSchedule(task, zone, at), nextRun,
      last: last ? { occurrence: last.occurrence * MINUTE_MS, status: last.status, reason: last.reason,
        at: last.at, detail: last.detail } : null,
      createdAt: task.createdAt, updatedAt: task.updatedAt }
  }

  return {
    // Start ticking. False when the store cannot be used: scheduled tasks
    // stay off and the service goes on without them.
    start() {
      if (started || stopped) return false
      if (store.fault) { log(`scheduled tasks are off: ${store.fault}`); return false }
      started = true
      for (const key of store.interrupted()) log(`scheduled occurrence ${key} was interrupted by the last stop; its result is unknown and it is not run again`)
      tick()
      arm()
      return true
    },
    // Stop ticking and end running scripts. Called before the service stops.
    stop() {
      if (stopped) return { scripts: 0, inflight: inflight.size }
      stopped = true
      if (timer) { clearTimer(timer); timer = null }
      return { scripts: firing.stop(), inflight: inflight.size }
    },
    tick,
    // Resolves when no effect started by a tick is still in progress.
    async idle() { while (inflight.size) await Promise.allSettled([...inflight]) },
    get running() { return started && !stopped && !halted && !store.fault },
    get halted() { return halted },

    // The stored task of this conversation, or null (for the audit of a
    // script task's command before an edit or a removal).
    peek(chatId, id) {
      const task = typeof id === 'string' ? store.get(id) : null
      return task && task.chatId === chatId ? task : null
    },
    list(chatId) {
      requireGroup(chatId)
      const reason = unsupportedReason(chatId)
      const at = now()
      return { ok: true, supported: !reason, reason, timezone: productZone(),
        limits: { tasks: store.limits.tasks, name: store.limits.name, text: store.limits.text },
        tasks: store.tasks().filter(task => task.chatId === chatId)
          .sort((a, b) => a.createdAt - b.createdAt).map(task => view(task, at)) }
    },
    add(input = {}) {
      const chatId = input.chatId
      requireGroup(chatId)
      requireSupport(chatId)
      const at = now()
      const { fields } = readFields(input, null, at)
      requireRoom(chatId)
      const task = write(() => store.add({ id: newTaskId(), chatId, ...fields, enabled: input.enabled !== false,
        createdAt: at, updatedAt: at, since: at }))
      return { ok: true, task: view(task, at) }
    },
    update(input = {}) {
      const base = requireTask(input.chatId, input.id)
      requireSupport(base.chatId)
      const at = now()
      const { fields, rescheduled } = readFields(input, base, at)
      // A new time arms the task again; otherwise it stays as it was unless
      // the edit says so.
      const enabled = input.enabled !== undefined ? input.enabled : rescheduled && base.retired ? true : base.enabled
      const next = { id: base.id, chatId: base.chatId, ...fields, enabled, createdAt: base.createdAt, updatedAt: at,
        // Occurrences count from the moment a task is rescheduled or switched on.
        since: rescheduled || enabled && !base.enabled ? at : base.since,
        ...(base.retired && !rescheduled ? { retired: true } : {}) }
      if (enabled && !base.enabled && !rescheduled) assertCanEnable(base, at)
      if (next.retired && next.enabled) refuse(409, 'expired', SAY.expired())
      // A finished one-off given a new time is a live task again: it needs room like a new one.
      if (base.retired && !next.retired) requireRoom(base.chatId)
      const task = write(() => store.replace(next))
      return { ok: true, task: view(task, at) }
    },
    toggle(input = {}) {
      const base = requireTask(input.chatId, input.id)
      if (typeof input.enabled !== 'boolean') refuse(400, 'enabled', SAY.enabled())
      const at = now()
      if (input.enabled === base.enabled) return { ok: true, task: view(base, at) }
      if (input.enabled) { requireSupport(base.chatId); assertCanEnable(base, at) }
      const task = write(() => store.replace({ ...base, enabled: input.enabled, updatedAt: at,
        ...(input.enabled ? { since: at } : {}) }))
      return { ok: true, task: view(task, at) }
    },
    remove(input = {}) {
      // Also for a task whose conversation was taken out of the configuration.
      const base = requireTask(input.chatId, input.id, { orphan: true })
      write(() => forget(base.id))
      return { ok: true }
    },
  }
}

module.exports = { createScheduleService, ScheduleError, PLATFORMS, refusalSamples, SCHEDULES_UNAVAILABLE: SAY.unavailable() }
