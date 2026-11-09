// 控制台「向群里插一句」的守护进程侧动作—— **会驱动一轮**的注入,不是纯通知。
//
// ⚠ 与 notifyGroup 的区别:那条只让群里多一行字、agent 不动;这条要它真去做事。
// ⚠ 与定时任务 `--do` 的区别:立刻生效,不用算触发时间、不留一次性任务的残迹。
// `shown` 非空 ⇒ 先把这句话发进群(群成员看得见来龙去脉);为 null ⇒ 静默注入,群里只看到产出。
// 返回结构化结果而不是布尔:前端要**如实**告诉人「到底插进去没有、落在哪」。
//
// ⭐ 先等「【管理员】…」那句**发出去**,再注入:以前是发出去不等就注入,
//   注入后的第一句回执(「↪ 已加入正在处理的任务」「📝 已记下 #7」「⏳ 已排队」)常常比它还快到群里 ——
//   群成员读到的就成了「先回答、后提问」。发送失败或超时也照样注入:指令本身比群里那行字要紧,
//   卡在这里等于把管理员的指令丢了。
//
// 依赖全注入(平台、群配置、引擎入口、落点查询),纯逻辑可单测。

const { syntheticSource } = require('./core/c2sourceidentity')
const { taskId } = require('./core/enginecheckpoint')

const SEND_TIMEOUT_MS = 5000

// 发群里那行「【管理员】…」:等它落地,最多 sendTimeoutMs;出错 / 超时只记日志。
// 返回它的消息 id(平台给的话):回执与卡片要挂到它下面;拿不到就 null。
// onLate:超时之后发送才回来时报一声(持久路径据此在日志里留下「这行字其实发出去了」)。
async function sendShownLine(platform, chatId, shown, sendTimeoutMs, log, onLate = null) {
  let timer = null
  let timedOut = false
  const sending = Promise.resolve().then(() => platform.send(chatId, shown))
  if (onLate) sending.then(id => { if (timedOut) onLate(id) }, () => {})
  try {
    const id = await Promise.race([
      sending,
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error(`发送超时(${sendTimeoutMs}ms)`)) }, sendTimeoutMs) }),
    ])
    return typeof id === 'string' && id ? id : null
  } catch (e) {
    log('say(shown): ' + (e && e.message))
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createConsoleSay({ getPlatform, getGroup, handle, locate, log = () => {}, now = () => Date.now(), sendTimeoutMs = SEND_TIMEOUT_MS }) {
  // 发群里那行「【管理员】…」:出错 / 超时只记日志、不拦注入(见 sendShownLine)。
  const sendShown = (platform, chatId, shown) => sendShownLine(platform, chatId, shown, sendTimeoutMs, log)

  // `requestId`:控制台每次提交自己生成的 32 位十六进制幂等键(静默注入时的唯一持久锚点)。
  // 没传就没有 —— 下面只在拿得到持久锚点时才给这条合成消息一个持久收据身份。
  return async function say(chatId, text, shown, quiet, { requestId } = {}) {
    const platform = getPlatform()
    if (!platform || !platform.send) return { ok: false, reason: 'no-daemon' } // `sbot ui` 纯配置模式
    const g = getGroup(chatId)
    if (!g) return { ok: false, reason: 'unbound' }
    if (g.paused) return { ok: false, reason: 'paused' } // 暂停群按语义跳过,与 cron 一致
    const shownId = shown ? await sendShown(platform, chatId, shown) : null
    try {
      // 时刻取在发完之后:它是这条消息的 createTimeMs,应当晚于群里那行字
      const t = now()
      const msgId = `console:${chatId}:${t}`
      const body = String(text || '')
      // 持久收据身份(C2):发出去的那行字就是锚点;静默注入只认控制台自己带的幂等键。
      // 两者都没有 ⇒ 不给 receiptSource/receiptSourceId,让持久路径继续按「来源不可持久」拒收,
      // 而不是拿 Date.now() 拼一个崩溃重放后会变成另一笔任务的 ID(那就是重复发言的来源)。
      let durable = null
      try {
        durable = syntheticSource({ kind: 'console', chatId,
          ...(shownId ? { shownMessageId: shownId } : { requestId }) })
      } catch { durable = null }
      const receiptFields = durable
        ? { receiptSource: durable.source, receiptSourceId: durable.sourceId } : {}
      // ⚠ synthetic:true 是关键 —— 它让这条消息**不推水位线**(合成消息的时间戳来自本机
      //    Date.now(),与平台消息不是同一把钟;拿它推水位线会静默吞掉真人消息)。
      // wantsAck:插话勾了「回复」= operator 就在等结果 ⇒ 该走 ack(合成消息默认不 ack)。
      // operator:只决定插进当前任务时的来源标签(「管理员插话」);能不能并进当前任务看的是 wantsAck(有人在等),判据在引擎。
      // replyCtx 带上群里那行字的消息 id:排队回执 / 答案卡片就挂到它下面,与群成员自己发的消息长得一样;
      // 没发那行 / 发失败 ⇒ 只有 chatId,平台退回直发(答案照样到群里,只是不带引用)。
      // visible = 这句话本身在群里看得见:引擎据此决定忙时跟进时卡片要不要跟过来 —— 看不见的补话没有可跟的消息。
      handle({ chatId, userId: 'console', senderName: '管理员', synthetic: true, operator: true, quiet: !!quiet, wantsAck: !quiet, visible: !!shownId, text: body, msgId, createTimeMs: t, replyCtx: shownId ? { chatId, messageId: shownId } : { chatId }, ...receiptFields })
      // 去向在 handle 的第一个 await 之前就已定下(见 engine.locateMessage),这里**同步**读到的就是落点 ——
      // ⚠ 所以 handle 与 locate 之间不许插 await。
      const where = body.trim().startsWith('/') ? { state: 'command' } : locate(chatId, msgId)
      return { ok: true, where }
    } catch (e) {
      log('say: ' + (e && e.message))
      return { ok: false, reason: 'inject-failed' }
    }
  }
}

// ── 持久处理流程(sintbot-v2)的插话,第 1 版:只接「空闲群 · 这句话进群 · 回复进群」 ──
//
// 群里那行「【管理员】…」就是驱动这一轮的那条平台消息:它的 om_ 消息 id 就是这笔任务的来源身份
// (source 'message'),与群成员自己发的一条消息同形 —— 收据、回复锚点、/stop、重启后的中断告知
// (回在这行字下面)、事故封存全走现有的持久路径,引擎和日志一处不改。所以顺序是硬的:先等这行字
// 发出去、拿到平台给的消息 id,才会有收据;发失败 / 超时 / 没拿到 id ⇒ 不注入、如实报错 ——
// 没有锚点就没有持久身份,绝不拿本机时间拼一个(崩溃重放后会变成另一笔任务)。
//
// 第 1 版不做的,都在发群消息**之前**就拒,群里不留痕:
//   · 静默插话(这句不进群):没有平台消息可锚,需要另一种来源和重启告知路径;
//   · 不回复的插话(quiet):持久路径还不接静默收据;
//   · 群正忙:不排队、也不加入当前任务;
//   · 斜杠命令:群命令不走插话(停止、开新会话在概览里有按钮)。
//
// requestId:控制台每次提交带的 32 位十六进制幂等键(经 syntheticSource 校验并折成键)。发出那行字
// 之后才记下「这个键 → 那行字」;同一个键再来:那行字已有收据 ⇒ 报 duplicate、不再处理;还没有收据
// (上次在发出之后被拒)⇒ 沿用群里已有的那行再试,不发第二行。这张表只在本进程内有效:服务重启后
// 同一个键当作新的一次;已登记的那笔由启动恢复按现有规则收尾(回在那行字下面),不会重跑。
const FEISHU_MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,124}$/
const CONFIRM_MS = 5000
const POLL_MS = 10
const MAX_REQUESTS = 256
// 群里被拒时(注入后、收据前)服务给的原因 → 控制台的说法
const REJECTION_REASONS = { 'group-held': 'held', 'group-recovering': 'recovering',
  upgrading: 'upgrading', 'stop-pending': 'busy', 'skip-pending': 'busy' }

function refusalOf(value) {
  if (value && value.quarantined) return 'quarantined'
  if (value && value.held) return 'held'
  if (value && value.recovered) return 'recovering'
  if (value && value.ignored) return 'not-serving'
  if (value && value.rejected) return REJECTION_REASONS[value.reason] || 'refused'
  return 'inject-failed'
}

// 依赖全注入:
//   getPlatform(chatId)        该群真实的平台适配器(与群成员消息进来时同一个),没有 ⇒ null
//   getGroup(chatId)           群配置
//   gate(chatId)               此刻能不能插:null = 能;否则原因('busy' | 'held' | 'upgrading' | 'not-serving' …)
//   route(msg, platform)       服务的统一入口(routeMessage):暂停 / 待人工 / 收尾中 / 升级中都在那里把关
//   receiptState(chatId, id)   该群日志里这笔收据:'pending' | 'completed' | null
function createDurableConsoleSay({ getPlatform, getGroup, gate, route, receiptState,
  log = () => {}, now = () => Date.now(), sendTimeoutMs = SEND_TIMEOUT_MS,
  confirmMs = CONFIRM_MS, pollMs = POLL_MS, maxRequests = MAX_REQUESTS } = {}) {
  for (const hook of [getPlatform, getGroup, gate, route, receiptState, log, now]) {
    if (typeof hook !== 'function') throw new TypeError('durable console say needs explicit hooks')
  }
  const posted = new Map() // 请求键 → 群里那行字的消息 id(按插入顺序,超过上限丢最早的)
  const inflight = new Map() // 请求键 → 进行中的那一次:同一个键并发再来,排在它后面
  const remember = (key, shownId) => {
    posted.delete(key)
    posted.set(key, shownId)
    while (posted.size > maxRequests) posted.delete(posted.keys().next().value)
  }
  const receiptOf = (chatId, shownId) => taskId({ source: 'message', chatId, sourceId: shownId })

  // route 要等这一轮跑完才回来;收据一登记就算插进去了。轮询该群日志,最多 confirmMs。
  function watch(chatId, receiptId, settled) {
    let stopped = false
    settled.then(() => { stopped = true })
    return (async () => {
      const deadline = Date.now() + confirmMs
      while (!stopped && Date.now() < deadline) {
        if (receiptState(chatId, receiptId)) return { admitted: true }
        await new Promise(resolve => setTimeout(resolve, pollMs))
      }
      return receiptState(chatId, receiptId) ? { admitted: true } : { timeout: true }
    })()
  }

  async function attempt(platform, chatId, body, shown, key) {
    let shownId = posted.get(key) || null
    if (shownId && receiptState(chatId, receiptOf(chatId, shownId))) {
      return { ok: true, where: { state: 'duplicate' } }
    }
    const closed = gate(chatId)
    if (closed) return { ok: false, reason: closed }
    if (!shownId) {
      shownId = await sendShownLine(platform, chatId, shown, sendTimeoutMs, log,
        late => log('say(shown): 超时后才发出' + (typeof late === 'string' && late ? `(${late})` : '') + ',这条插话未处理'))
      if (!shownId || !FEISHU_MESSAGE_ID.test(shownId)) {
        if (shownId) log('say(shown): 平台给的消息 id 不能当持久来源,未注入')
        return { ok: false, reason: 'shown-failed' }
      }
      remember(key, shownId)
      // 发这行字的这会儿群里可能刚开始了别的任务:此时不注入(第 1 版忙时不排队、不加入)
      const late = gate(chatId)
      if (late) return { ok: false, reason: late === 'busy' ? 'busy-after-post' : late }
    }
    const receiptId = receiptOf(chatId, shownId)
    // 与平台送进来的一条群消息同形:没有 synthetic / quiet / wantsAck,msgId 与回复锚点都是那行字。
    // 时刻取在发完之后,晚于群里那行字。
    const msg = { chatId, userId: 'console', senderName: '管理员', text: body, msgId: shownId,
      createTimeMs: now(), replyCtx: { chatId, messageId: shownId } }
    const settled = Promise.resolve().then(() => route(msg, platform))
      .then(value => ({ value }), error => ({ error }))
    const first = await Promise.race([settled, watch(chatId, receiptId, settled)])
    if (first.admitted || first.timeout) {
      // 这一轮在后台继续;它之后的成败由该群自己的持久路径收尾,这里只留日志
      settled.then(({ error }) => { if (error) log('say: ' + (error && error.message)) })
      return first.admitted ? { ok: true, where: { state: 'started' } } : { ok: false, reason: 'unconfirmed' }
    }
    const { value, error } = first
    if (value && value.duplicate) return { ok: true, where: { state: 'duplicate' } }
    const state = receiptState(chatId, receiptId)
    if (state) return { ok: true, where: { state: state === 'completed' ? 'done' : 'started' } }
    if (error) {
      log('say: ' + (error && error.message))
      return { ok: false, reason: 'inject-failed' }
    }
    return { ok: false, reason: refusalOf(value) }
  }

  return async function say(chatId, text, shown, quiet, { requestId } = {}) {
    const platform = getPlatform(chatId)
    if (!platform || typeof platform.send !== 'function') return { ok: false, reason: 'no-daemon' }
    const g = getGroup(chatId)
    if (!g) return { ok: false, reason: 'unbound' }
    if (g.paused) return { ok: false, reason: 'paused' }
    const body = String(text || '')
    if (!body.trim()) return { ok: false, reason: 'empty' }
    if (!shown) return { ok: false, reason: 'silent-unsupported' }
    if (quiet) return { ok: false, reason: 'quiet-unsupported' }
    if (body.trim().startsWith('/')) return { ok: false, reason: 'command' }
    let key
    try { key = syntheticSource({ kind: 'console', chatId, requestId }).sourceId }
    catch { return { ok: false, reason: 'request-id' } }
    const prior = inflight.get(key)
    const run = (prior ? prior.then(() => {}, () => {}) : Promise.resolve())
      .then(() => attempt(platform, chatId, body, shown, key))
    inflight.set(key, run)
    const clear = () => { if (inflight.get(key) === run) inflight.delete(key) }
    run.then(clear, clear)
    try { return await run } catch (e) {
      log('say: ' + (e && e.message))
      return { ok: false, reason: 'inject-failed' }
    }
  }
}

module.exports = { createConsoleSay, createDurableConsoleSay }
