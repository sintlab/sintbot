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
  idleCompactPlan, idleCompactSettle, compactEvent, classifyError, scheduleStep, unfinishedStep } = require('../agent/privatecore')
const { taskId } = require('./enginecheckpoint')
const { prepareCardTerminalPath } = require('./c2cardterminalpath')
const { terminalReplyText, terminalNoticeText } = require('./c2terminaleffectbridge')
const { createC2TurnProjection } = require('./c2turnprojection')
const { prepareC2RunnerInput, prepareC2CompactionInput } = require('./c2runnerinput')
const { continueC2Successor } = require('./c2successorbridge')
const { rejectC2Input } = require('./c2inputrejection')
const progress = require('./turnprogress')
const { groupBrain } = require('./brain')
const { modelName } = require('./modelname')
const { chatLang, pick } = require('../chatlang')
const { parseModelWords, resolveModel, effortsFor, speedsFor, fastNote, whatName, modelChoices, fillPicks, recommendEffort, MODEL_LIST_CAP } = require('./modelcmd')
const { DEFAULT_VALUE: MODEL_CARD_DEFAULT } = require('../platform/modelcard')
// A /model card answers taps for ten minutes; older cards turn read-only.
const MODEL_CARD_TTL_MS = 10 * 60 * 1000
const { GROUP_COMMANDS, RUNTIME_ENTRY, runtimeCommand } = require('../runtimefacts')
// Platforms whose routes this engine serves: Feishu groups, the console's own
// conversations (src/platform/local.js) and WeCom groups and direct chats
// (src/platform/wecom.js), which share every durable rule. Local and WeCom are
// plain-reply platforms: their message IDs are reserved `om_local_` /
// `om_wecom_` shapes of the same source ID the journal validates. Slack
// channels and direct messages (src/platform/slack.js) are a plain-reply
// platform too, with `oc_slack_` / `om_slack_` identities.
const DURABLE_PLATFORMS = ['feishu', 'local', 'wecom', 'slack']
const NO_REPLY = 'NO_REPLY'
const SYSTEM_APPENDIX = systemAppendix(NO_REPLY)
const V2_NORMAL_ROUTE_MISSING = Object.freeze(['complete durable v2 authority'])
// Permission tiers the manifest describes to the agent as read-only: 1 is
// the Codex read-only sandbox, 3 the fail-closed default. 0 is full access
// and 2 an allow-listed tool set, which may still change files.
const READ_ONLY_TIERS = Object.freeze([1, 3])
// The third argument of replyOnce marks a sentence the engine itself wrote (a
// queue, stop or refusal notice). A platform whose users type commands with
// another prefix rewrites the commands named in it; an answer is never marked.
const ENGINE_NOTICE = Object.freeze({ notice: true })
const DURABLE_V2_COMMANDS = new Set(GROUP_COMMANDS.filter(cmd => !['/skip', '/stop'].includes(cmd)))
// Token counts: 1.2万 / 3亿 in Chinese; 1.2k / 12k / 1.2M in English.
function fmtWan(n, lang = 'zh') {
  n = Number(n) || 0
  if (lang === 'en') {
    const short = (value, unit) => `${value.toFixed(1).replace(/\.0$/, '')}${unit}`
    if (n >= 999_950_000) return short(n / 1_000_000_000, 'B')
    if (n >= 999_500) return short(n / 1_000_000, 'M')
    if (n >= 10_000) return `${Math.round(n / 1000)}k`
    if (n >= 1000) return short(n / 1000, 'k')
    return String(n)
  }
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}万`
  return String(n)
}
// Durations: 2 分 5 秒 in Chinese; 2 min 5 s in English.
function humanDuration(ms, lang = 'zh') {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (lang === 'en') {
    if (seconds < 60) return `${seconds} s`
    const mins = Math.floor(seconds / 60)
    if (mins < 60) return `${mins} min ${seconds % 60} s`
    return `${Math.floor(mins / 60)} h ${mins % 60} min`
  }
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
// The final card is an accounting line: keep seconds for short turns and
// switch to minutes/hours before a long turn becomes an unreadable number.
function cardDuration(ms, lang = 'zh') {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (lang === 'en') {
    if (seconds < 60) return `${seconds} s`
    const mins = Math.floor(seconds / 60)
    if (mins < 60) return seconds % 60 ? `${mins} min ${seconds % 60} s` : `${mins} min`
    const hrs = Math.floor(mins / 60)
    return mins % 60 ? `${hrs} h ${mins % 60} min` : `${hrs} h`
  }
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`
}
function cardModelInfo(brain, lang = 'zh') {
  if (!brain) return { model: '', effort: '', speed: '' }
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim()
  return { model: clean(brain.model ? modelName(brain.model, lang) : ''), effort: clean(brain.effort),
    speed: brain.speed === 'fast' ? 'fast' : '' }
}
// An example depth for /model replies: high when available, else another one.
const exEffortOf = (efforts, cur) => ((efforts || []).includes('high') && cur !== 'high' ? 'high' : ((efforts || []).find(e => e !== cur) || ''))
// "codex · GPT-6-Astra · high": what this group runs on its current backend.
// Speed is written only when Fast is on; standard adds nothing, so a group
// that never turned Fast on reads exactly as before.
function brainLabel(name, brain, lang = 'zh') {
  return [name, brain?.model ? modelName(brain.model, lang) : '', brain?.effort || '', brain?.speed === 'fast' ? 'Fast' : '']
    .filter(Boolean).join(' · ')
}
const MAX_TIMER_MS = 2 ** 31 - 1 // the longest delay setTimeout can represent
// A message posted by a scheduled task (src/schedulefire.js). The mark lives on
// the message object in this process only, like a Slack thread: it is in no
// journal, so after a restart the same message is an ordinary one. (`cron` is
// the older routes' mark for the same thing.)
const isScheduledMessage = msg => msg?.scheduled === true || msg?.cron === true
// What a turn may do is the core's answer (schedule_step "turn"): a turn a
// scheduled task started takes no follow-ups and never runs Fast (nobody is
// waiting for it and Fast costs more quota); any other turn keeps what it was
// given.
function scheduledTurnPolicy(scheduled, followups, speed) {
  const turn = scheduleStep({ type: 'turn', scheduled: scheduled === true, followups: followups === true,
    speed: speed === 'fast' ? 'fast' : null })
  return { followups: turn.followups, speed: turn.speed === 'fast' ? 'fast' : '' }
}
// The brain a turn actually runs with: the group's, at the speed the core allows.
function turnBrain(brain, msg) {
  if (!brain || typeof brain !== 'object') return brain
  const speed = scheduledTurnPolicy(isScheduledMessage(msg), false, brain.speed).speed
  return speed === (brain.speed || '') ? brain : { ...brain, speed }
}
function cardModelDetail(info, result) {
  // A rejected configured effort may have been retried at the model default.
  const fellBack = result?.effortFellBack || result?.result?.effortFellBack
  // Fast is written only when this turn really ran Fast: the runner reports
  // speedFellBack when the tier was asked for but did not take.
  const speedFellBack = result?.speedFellBack || result?.result?.speedFellBack
  return [info?.model, fellBack ? '' : info?.effort, info?.speed === 'fast' && !speedFellBack ? 'Fast' : '']
    .filter(Boolean).join(' ')
}
// Group texts name the project by its folder only, never by a machine path.
function projectName(group, lang = 'zh') {
  return String(group?.workdir || '').split(/[\\/]/).filter(Boolean).pop() || pick(lang, '（未设）', '(not set)')
}
// How group texts name the conversation. An adapter may describe one itself
// (conversationOf): a Slack channel or direct message, a WeCom single chat.
// A Feishu or WeCom group keeps these words.
const GROUP_WORDS = Object.freeze({ noun: '群', here: '本群', of: '本群', recall: '撤回' })
// The same words in English. An adapter gives its own under the `en` key of
// conversationOf ("this channel", "this direct message"); the Chinese keys of
// that object also reach the model's prompt and are never translated.
const GROUP_WORDS_EN = Object.freeze({ noun: 'group', here: 'this group', of: "this group's", recall: 'recall' })
const wordsOf = (platform, chatId, lang = 'zh') => (lang === 'en'
  ? { ...GROUP_WORDS_EN, ...(platform?.conversationOf?.(chatId)?.en || {}) }
  : { ...GROUP_WORDS, ...(platform?.conversationOf?.(chatId) || {}) })
// Everything the bot itself says in a chat, written once per language: T in
// Chinese and T_EN in English, with the same keys, kinds and parameters (the
// module refuses to load otherwise). textsFor(lang) picks the table; a method
// that answers one conversation names its table T as well, so each sentence
// below is read in that conversation's language. An agent's answer is never
// one of these.
const T = {
  // Says what the core decided for this message: how many queued turns start
  // before its own, and how many earlier messages share it. Messages from
  // different threads of one chat never share a turn.
  queued: ({ ahead = 0, joins = 0 } = {}) => ahead > 0
    ? `⏳ 已排队 — 前面还有 ${ahead} 件在排队，轮到后${joins > 0 ? `与同一线程的前 ${joins} 条一并处理` : '单独处理'}`
    : joins > 0 ? `⏳ 已排队 — 当前任务结束后与前面 ${joins} 条一并处理` : '⏳ 已排队 — 当前任务结束后处理',
  queueFull: '排队的任务已满，这条消息没有处理，请等当前任务结束后重发。',
  busyUnavailable: '当前任务正在收尾，这条消息没有处理，请稍后重发。',
  // The Stop of one round (Slack's button under "Working…"): that round only.
  roundEnded: '这一轮已经结束，无需停止。',
  roundStopped: n => n > 0 ? `已停止 — 排队的 ${n} 条接着处理` : '已停止',
  // A stop typed as a reply in a thread whose task is not the one running.
  threadIdle: '这个线程没有在跑的任务；还在排队的，删除那条消息就能取消。要停整个频道的任务，在频道里 @ 我发 /stop。',
  stopped: '已停止',
  noActiveTask: '没有正在运行的任务',
  unsupportedCommand: '这个命令暂不支持。只放弃手头这件发 /skip，连排队的一起取消发 /stop；其他需求直接用文字说明。',
  unsupportedCommandWithModel: '这个命令暂不支持，发 /help 查看可用命令；其他需求直接用文字说明。',
  // Plain text: 【】 sections and "· " items, each read in one glance, no
  // alignment. Commands go by urgency; the three cancel commands rise in what
  // they discard and describe the queue and the conversation in the same words.
  help: ({ project, model, steer, readOnly, threads = false, w = GROUP_WORDS }) => ['【这是什么】',
    `· ${w.here}绑着项目「${project}」，模型 ${model}`,
    readOnly ? '· 直接问它，它看代码、答问题；之前聊的都记得'
      : `· 直接说事它就干，做完在${w.noun}里回你；之前聊的都记得`,
    // A chat with threads (a Slack channel): each thread is its own task.
    threads ? (steer ? '· 任务进行中，在它的线程里再发的消息会补充进当前任务；另起的消息单独排队，答案回在各自的线程里'
      : '· 任务进行中再发的消息会排队，等这一轮结束再处理；不同线程的消息分开处理')
      : steer ? '· 任务进行中再发的消息会补充进当前任务'
        : '· 任务进行中再发的消息会排队，等这一轮结束再处理',
    '',
    '【命令】',
    '· /status — 跑了多久、还有没有动静、排队几条',
    '· /skip — 只放弃手头这件，排队的继续；之前聊的还记得',
    // Stop where it is said: in a task's thread, that task only.
    threads ? '· /stop — 在任务的线程里发，只停那一件，排队的继续；在频道里发，手头和排队的全取消；之前聊的还记得'
      : '· /stop — 手头和排队的全取消；之前聊的还记得',
    '· /new — 忘掉之前聊的，从头开始（要等手头任务结束）',
    `· /model — 看或改${w.of}模型：/model high 调深度、/model 型号 换型号（都接着当前对话）、/model 后端 换后端（开新对话）；要等手头任务结束`,
    '· /hud — 额度与本段对话的用量',
    '· /issue 一句话 — 记下问题反馈，给管理员看',
    '· /help — 这份说明',
    // Not "trailing text is ignored": /stop with text after it is not recognised.
    '⚠ 命令单独发一条，后面别跟别的字（/issue、/model 除外）',
    // Same boundary as handleRecall: a queued message, or the task running on
    // that message alone; a steered follow-up takes its whole task with it.
    steer ? `⚠ ${w.recall}自己发的消息 = 取消那件事；${w.recall}补进当前任务的那条，会连当前任务一起取消`
      : `⚠ ${w.recall}自己发的消息 = 取消那件事（已和别的消息合成一轮在做的除外）`,
    ...(readOnly ? [`⚠ ${w.here}为只读模式：能看代码、答问题；要改文件需管理员放开权限`] : []),
  ].join('\n'),
  status: ({ model, project, state, doing = [], queue, session, w = GROUP_WORDS }) => [`【${w.of}状态】`, `· 模型：${model}`,
    `· 项目：${project}`, `· 状态：${state}`,
    ...(doing.length ? [`· 最近在做：${doing.join(' · ')}`] : []),
    `· 排队：${queue}`, `· 对话：${session}`].join('\n'),
  // The state and conversation values of /status. "Running for long" is not
  // "stuck": the steps and the last activity tell them apart.
  stateRunning: ({ ms, steps = 0, aliveMs = null }) => `运行中（已跑 ${humanDuration(ms)}${steps ? ` · 已执行 ${steps} 步` : ''}${aliveMs != null ? ` · 最近动静 ${humanDuration(aliveMs)}前` : ''}）`,
  stateWaiting: '消息已登记，等待并发名额',
  stateIdle: '空闲',
  sessionActive: '进行中（记着上下文）',
  sessionNone: '未开始',
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
  issueFailed: (w = GROUP_WORDS) => `⚠ 没记下来 —— 麻烦再说一次，或直接在${w.noun}里说`,
  // The model reads this on a follow-up merged into the running task. The
  // built-in core words it, told how the conversation is named and its
  // language.
  followUp: (stamp, sender, text, w = GROUP_WORDS, lang = 'zh') => turnPrompt({ followUp: { stamp, sender, text },
    chatNoun: w.noun, ...(lang === 'en' ? { replyLang: 'en' } : {}) }),
  // /model replies list backends, models and depths on separate lines, with
  // examples taken from this group's real choices. Any unrecognised word
  // rejects the whole command and changes nothing (no fuzzy matching).
  //   o = { current, names, name, choices|null|undefined, efforts, exEffort, exModel, exProvider }
  //   choices === null: this backend's model is set in the console (third-party endpoint).
  modelInfo: (o) => {
    const L = [`【${(o.w || GROUP_WORDS).of}模型】${o.current}`]
    L.push(`【后端】${o.names.join(' · ')}`)
    if (o.choices === null) L.push(`【${o.name} 型号】到控制台改`)
    else if (o.choices && o.choices.length) L.push(`【${o.name} 型号】${o.choices.map((x) => modelName(x)).join(' · ')}${o.more ? ' · 更多见控制台' : ''}`)
    if (o.efforts && o.efforts.length) L.push(`【思考深度】${o.efforts.join(' · ')}`)
    // Speed: listed only when the current model has a Fast tier; its cost is
    // written next to it so it is known before turning it on.
    if (o.speeds && o.speeds.length) L.push(`【速度】标准 · Fast（${o.fastNote}）`)
    if (o.exEffort) L.push(`· 调深度：/model ${o.exEffort}（接着当前对话）`)
    if (o.speeds && o.speeds.length) L.push(o.speed === 'fast' ? '· 回到标准：/model 标准（接着当前对话）' : '· 开 Fast：/model fast（接着当前对话）')
    if (o.exModel) L.push(`· 换型号：/model ${modelName(o.exModel)}（接着当前对话）`)
    if (o.exProvider) L.push(`· 换后端：/model ${o.exProvider}（开新对话）`)
    L.push('⚠ 要等手头任务结束才能改')
    return L.join('\n')
  },
  modelUnknownWord: (word, o) => (o.choices === null
    ? `⚠ 「${word}」不是可选的后端或深度（${o.name} 的型号要到控制台改）—— 一项都没改`
    : `⚠ 「${word}」不是可选的后端、型号或深度 —— 一项都没改`)
    + `\n【后端】${o.names.join(' · ')}` + (o.choices && o.choices.length ? `\n【${o.name} 型号】${o.choices.map((x) => modelName(x)).join(' · ')}${o.more ? ' · 更多见控制台' : ''}` : '')
    + (o.efforts && o.efforts.length ? `\n【思考深度】${o.efforts.join(' · ')}` : '')
    + (o.speeds && o.speeds.length ? '\n【速度】标准 · Fast' : ''),
  modelDup: (what, a, b) => `⚠ 一次只能选一个${what}（写了 ${a} 和 ${b}）—— 一项都没改`,
  modelNoCatalog: name => `⚠ 暂时取不到 ${name} 的可选型号 —— 一项都没改；稍后再试，或请管理员到控制台改`,
  modelEffortUnsupported: (model, e, list) => list.length
    ? `⚠ ${modelName(model) || model} 没有「${e}」这档深度 —— 一项都没改\n【可选】${list.join(' · ')}`
    : `⚠ ${modelName(model) || model} 不支持调思考深度 —— 一项都没改`,
  modelSpeedUnsupported: model => `⚠ ${modelName(model) || model} 没有 Fast 档 —— 一项都没改`,
  modelSame: (current, w = GROUP_WORDS) => `${w.here}已经在用 ${current}，没有变化`,
  modelBusy: '⚠ 手头还有任务在跑 —— 等它跑完再改，或先发 /stop',
  // dropped: Fast was on and the new model has no Fast tier, so the group is
  // back at standard speed; said out loud, or it reads as still on.
  speedDropped: dropped => (dropped ? `\n· ${modelName(dropped) || dropped} 没有 Fast 档，已回到标准速度` : ''),
  modelSwitched: (current, note, filled, dropped, w = GROUP_WORDS) => `✅ 已切到 ${current}\n⚠ 换了后端，新的一段对话从这里开始，之前聊的内容不再带着` + (note ? ` —— ${note}` : '')
    + (filled ? `\n· ${w.here}在这个后端还没选过${filled}，先用推荐的；要换就 /model 加名字` : '') + T.speedDropped(dropped),
  modelChanged: (current, filled, dropped) => `✅ 已改为 ${current} —— 接着当前对话，下条消息生效\n· 对话很长时新型号可能装不下，可发 /new 重开`
    + (filled ? `\n· ${filled}先用推荐的` : '') + T.speedDropped(dropped),
  effortSwitched: (effort, label) => `✅ 思考深度已调为 ${effort}（${label}）—— 接着当前对话，下条消息生效`,
  // Speed changed (possibly together with depth): turning Fast on states its
  // cost first, then that scheduled tasks stay at standard speed.
  tuneSwitched: ({ effort, effortChanged, speed, label, note }) => {
    const did = [effortChanged ? `思考深度已调为 ${effort || '未选'}` : '', speed === 'fast' ? '已开 Fast' : '已回到标准速度'].filter(Boolean).join('、')
    return `✅ ${did}（${label}）—— ` + (speed === 'fast' ? `${note}；` : '') + '接着当前对话，下条消息生效'
      + (speed === 'fast' ? '；定时任务仍按标准速度' : '')
  },
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
  // Under a reply card: whose follow-ups joined the task it answers.
  cardJoined: names => `\n\n↪ 已加入 ${names.join('、')} 的补充`,
}
// The English table. Commands are written plainly (never in backticks or
// quotes) so a platform with another command prefix can rewrite them, and
// every command shown is one the parser accepts.
const upperFirst = text => text.charAt(0).toUpperCase() + text.slice(1)
const plural = (n, one, many) => (n === 1 ? one : many)
const T_EN = {
  queued: ({ ahead = 0, joins = 0 } = {}) => ahead > 0
    ? `⏳ Queued — ${ahead} ${plural(ahead, 'task is', 'tasks are')} ahead; then it runs ${joins > 0 ? `together with the ${joins} earlier ${plural(joins, 'message', 'messages')} in the same thread` : 'on its own'}`
    : joins > 0 ? `⏳ Queued — runs after the current task, together with the ${joins} earlier ${plural(joins, 'message', 'messages')}` : '⏳ Queued — runs after the current task',
  queueFull: 'The queue is full, so this message was not handled. Please resend it after the current task finishes.',
  busyUnavailable: 'The current task is wrapping up, so this message was not handled. Please resend it in a moment.',
  roundEnded: 'This round has already ended; there is nothing to stop.',
  roundStopped: n => n > 0 ? `Stopped — the ${n} queued ${plural(n, 'message runs', 'messages run')} next` : 'Stopped',
  threadIdle: 'No task is running in this thread. To cancel a message that is still queued, delete it. To stop everything in the channel, mention me in the channel and send /stop.',
  stopped: 'Stopped',
  noActiveTask: 'No task is running',
  unsupportedCommand: 'This command is not supported yet. Send /skip to drop only the current task, or /stop to cancel it together with everything queued. For anything else, just say it in plain words.',
  unsupportedCommandWithModel: 'This command is not supported yet. Send /help to see the available commands. For anything else, just say it in plain words.',
  help: ({ project, model, steer, readOnly, threads = false, w = GROUP_WORDS_EN }) => ['What this is',
    `· ${upperFirst(w.here)} is bound to project "${project}", model ${model}`,
    readOnly ? '· Just ask: it reads the code and answers questions, and it remembers the conversation so far'
      : `· Just say what you need: it does the work and answers in ${w.here}, and it remembers the conversation so far`,
    threads ? (steer ? '· A message sent in the thread of a running task is added to that task; a message started elsewhere waits its turn, and each answer arrives in its own thread'
      : '· A message sent while a task is running waits until that round ends; messages in different threads are handled separately')
      : steer ? '· A message sent while a task is running is added to that task'
        : '· A message sent while a task is running waits until that round ends',
    '',
    'Commands',
    '· /status — how long it has been running, whether it is still active, how many are queued',
    '· /skip — drop only the current task; queued ones go on; the conversation is kept',
    threads ? '· /stop — sent in the thread of a task, it stops that task only and queued ones go on; sent in the channel, it cancels the current task and everything queued; the conversation is kept'
      : '· /stop — cancel the current task and everything queued; the conversation is kept',
    '· /new — forget the conversation so far and start over (waits for the current task to finish)',
    `· /model — see or change ${w.of} model: /model high sets the thinking effort, /model plus a model name switches the model (both keep the conversation), /model plus a backend name switches the backend (starts a new conversation); waits for the current task to finish`,
    '· /hud — quota and how much this conversation has used',
    '· /issue plus one sentence — report a problem to the admin',
    '· /help — this message',
    '⚠ Send a command as a message of its own, with nothing after it (except /issue and /model)',
    steer ? `⚠ ${upperFirst(w.recall)} your own message to cancel that task; if it had been added to the current task, the whole current task is cancelled`
      : `⚠ ${upperFirst(w.recall)} your own message to cancel that task (unless it is already running in one round with other messages)`,
    ...(readOnly ? [`⚠ ${upperFirst(w.here)} is read-only: it can read code and answer questions; changing files needs an admin to grant permission`] : []),
  ].join('\n'),
  status: ({ model, project, state, doing = [], queue, session, w = GROUP_WORDS_EN }) => [`${upperFirst(w.of)} status`, `· Model: ${model}`,
    `· Project: ${project}`, `· State: ${state}`,
    ...(doing.length ? [`· Recently: ${doing.join(' · ')}`] : []),
    `· Queued: ${queue}`, `· Conversation: ${session}`].join('\n'),
  stateRunning: ({ ms, steps = 0, aliveMs = null }) => `running (for ${humanDuration(ms, 'en')}${steps ? ` · ${steps} ${plural(steps, 'step', 'steps')} done` : ''}${aliveMs != null ? ` · last activity ${humanDuration(aliveMs, 'en')} ago` : ''})`,
  stateWaiting: 'message received, waiting for a free slot',
  stateIdle: 'idle',
  sessionActive: 'in progress (context is kept)',
  sessionNone: 'not started',
  freshSession: '✅ A new conversation has started; earlier messages are no longer carried along',
  newBusy: '⚠ A task is still running — wait for it to finish, or send /stop and then /new',
  quotaShow: (name, value) => `${name} quota: ${value}`,
  quotaMiss: name => `The ${name} quota could not be read just now; try again later`,
  quotaNone: name => `Model "${name}" has no quota to look up`,
  sessionLine: (turns, ctx, inTotal, { idleAt = 0, lastAt = '' } = {}) => `Conversation: round ${turns} · ${ctx ? `context about ${fmtWan(ctx, 'en')} tokens` : `about ${fmtWan(inTotal, 'en')} tokens processed in total`}`
    + (idleAt > 0 ? ` (compacted when idle above ${fmtWan(idleAt, 'en')}${lastAt ? ` · last compacted ${lastAt}` : ''})` : ''),
  noSession: 'Conversation: not started yet',
  issueUsage: 'Usage: /issue plus one sentence that says what went wrong\nExample: /issue It ignored the image I just sent',
  issueLogged: id => `📝 Noted as #${id}`,
  issueFailed: (w = GROUP_WORDS_EN) => `⚠ That was not saved — please say it again, or just say it in ${w.here}`,
  // The model reads this one, in the language of its prompt: not translated.
  followUp: T.followUp,
  modelInfo: (o) => {
    const L = [`${upperFirst((o.w || GROUP_WORDS_EN).of)} model: ${o.current}`]
    L.push(`Backends: ${o.names.join(' · ')}`)
    if (o.choices === null) L.push(`${o.name} models: change them in the console`)
    else if (o.choices && o.choices.length) L.push(`${o.name} models: ${o.choices.map((x) => modelName(x, 'en')).join(' · ')}${o.more ? ' · more in the console' : ''}`)
    if (o.efforts && o.efforts.length) L.push(`Thinking effort: ${o.efforts.join(' · ')}`)
    if (o.speeds && o.speeds.length) L.push(`Speed: standard · Fast (${o.fastNote})`)
    if (o.exEffort) L.push(`· Change the effort: /model ${o.exEffort} (keeps the conversation)`)
    if (o.speeds && o.speeds.length) L.push(o.speed === 'fast' ? '· Back to standard: /model standard (keeps the conversation)' : '· Turn on Fast: /model fast (keeps the conversation)')
    if (o.exModel) L.push(`· Switch the model: /model ${modelName(o.exModel, 'en')} (keeps the conversation)`)
    if (o.exProvider) L.push(`· Switch the backend: /model ${o.exProvider} (starts a new conversation)`)
    L.push('⚠ A change waits until the current task has finished')
    return L.join('\n')
  },
  modelUnknownWord: (word, o) => (o.choices === null
    ? `⚠ "${word}" is not an available backend or effort (${o.name} models are changed in the console) — nothing was changed`
    : `⚠ "${word}" is not an available backend, model or effort — nothing was changed`)
    + `\nBackends: ${o.names.join(' · ')}` + (o.choices && o.choices.length ? `\n${o.name} models: ${o.choices.map((x) => modelName(x, 'en')).join(' · ')}${o.more ? ' · more in the console' : ''}` : '')
    + (o.efforts && o.efforts.length ? `\nThinking effort: ${o.efforts.join(' · ')}` : '')
    + (o.speeds && o.speeds.length ? '\nSpeed: standard · Fast' : ''),
  modelDup: (what, a, b) => `⚠ Only one ${what} can be chosen at a time (got ${a} and ${b}) — nothing was changed`,
  modelNoCatalog: name => `⚠ The list of ${name} models is not available just now — nothing was changed; try again later, or ask an admin to change it in the console`,
  modelEffortUnsupported: (model, e, list) => list.length
    ? `⚠ ${modelName(model, 'en') || model} has no "${e}" effort — nothing was changed\nAvailable: ${list.join(' · ')}`
    : `⚠ ${modelName(model, 'en') || model} has no adjustable thinking effort — nothing was changed`,
  modelSpeedUnsupported: model => `⚠ ${modelName(model, 'en') || model} has no Fast tier — nothing was changed`,
  modelSame: (current, w = GROUP_WORDS_EN) => `${upperFirst(w.here)} already uses ${current}; nothing changed`,
  modelBusy: '⚠ A task is still running — wait for it to finish before changing, or send /stop first',
  speedDropped: dropped => (dropped ? `\n· ${modelName(dropped, 'en') || dropped} has no Fast tier; back at standard speed` : ''),
  modelSwitched: (current, note, filled, dropped, w = GROUP_WORDS_EN) => `✅ Switched to ${current}\n⚠ The backend changed, so a new conversation starts here and earlier messages are no longer carried along` + (note ? ` — ${note}` : '')
    + (filled ? `\n· ${upperFirst(w.here)} had no ${filled} chosen on this backend, so the recommendation is used; to change it, send /model plus the name` : '') + T_EN.speedDropped(dropped),
  modelChanged: (current, filled, dropped) => `✅ Changed to ${current} — the conversation continues; it applies from the next message\n· A long conversation may not fit the new model; send /new to start over`
    + (filled ? `\n· Using the recommended ${filled} for now` : '') + T_EN.speedDropped(dropped),
  effortSwitched: (effort, label) => `✅ Thinking effort set to ${effort} (${label}) — the conversation continues; it applies from the next message`,
  tuneSwitched: ({ effort, effortChanged, speed, label, note }) => {
    const did = [effortChanged ? `thinking effort set to ${effort || 'none'}` : '', speed === 'fast' ? 'Fast turned on' : 'back at standard speed'].filter(Boolean).join(', ')
    return `✅ ${upperFirst(did)} (${label}) — ` + (speed === 'fast' ? `${note}; ` : '') + 'the conversation continues; it applies from the next message'
      + (speed === 'fast' ? '; scheduled tasks stay at standard speed' : '')
  },
  modelSwitchFailed: '⚠ The change did not go through — please ask an admin to check the console',
  stopPending: 'The current task is being stopped, so this message was not handled. Please resend it in a moment.',
  stopUnavailable: 'The current task is wrapping up and cannot be stopped right now.',
  stoppedWithQueue: n => `Stopped — the ${n} queued ${plural(n, 'message was', 'messages were')} cancelled as well`,
  skipped: n => n > 0 ? `Skipped the current task (${n} more queued, running next)` : 'Skipped the current task',
  skipUnavailable: 'The current task is wrapping up and cannot be skipped right now.',
  skipPending: 'The current task is being skipped, so this message was not handled. Please resend it in a moment.',
  quotaFailure: 'The Codex subscription quota is used up, so this task was not completed. Please send it again once the quota is back; this request is not retried automatically.',
  cardFooter: ({ ms, tokens }) => {
    const parts = [`Took ${cardDuration(ms, 'en')}`]
    const tokenLabel = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
    if (tokens && ((tokens.in || 0) + (tokens.cr || 0) + (tokens.cw || 0) + (tokens.out || 0)) > 0) {
      parts.push(`tokens ↑${tokenLabel((tokens.in || 0) + (tokens.cr || 0) + (tokens.cw || 0))} ↓${tokenLabel(tokens.out || 0)}`)
    }
    return parts.join(' · ')
  },
  cardJoined: names => `\n\n↪ Follow-ups from ${names.join(', ')} were added`,
}
// A sentence that exists in one language only would be said in the wrong one,
// or not at all: both tables must have the same entries of the same kind.
function sameShape(zh, en) {
  const keys = table => Object.keys(table).sort()
  if (keys(zh).join() !== keys(en).join()) return false
  return keys(zh).every(key => typeof zh[key] === typeof en[key] &&
    ['string', 'function'].includes(typeof zh[key]) &&
    (typeof zh[key] !== 'function' || zh[key].length === en[key].length))
}
if (!sameShape(T, T_EN)) throw new Error('v2engine chat texts differ between languages')
const TEXTS = Object.freeze({ zh: Object.freeze(T), en: Object.freeze(T_EN) })
const textsFor = lang => (lang === 'en' ? TEXTS.en : TEXTS.zh)
// /stop with no stoppable turn is user input refused before any receipt; the
// running turn, if any, keeps its own durable path untouched.
function durableV2StopUnavailable(rt, texts = T) {
  const idle = !rt?.v2NormalRouteActive || !rt.v2RunningJobs?.length
  return rejectC2Input('C2 v2 /stop is unsupported or closed', idle
    ? { reason: 'stop-idle', notice: texts.noActiveTask }
    : { reason: 'stop-unavailable', notice: texts.stopUnavailable })
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
// `threads`: each job's thread as the host knows it (payload handles), the
// fact the core batches by; null when the chat has none.
function v2QueueSelection(queue, threads = null) {
  if (!Array.isArray(queue)) throw new TypeError('durable queue must be an array')
  const result = engineQueueStep({ queue }, { type: 'dequeue', ...(threads ? { threads } : {}) })
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
// are not in this release, and neither is the agent's own scheduling command
// (scheduled tasks are managed from the console), so the cron section the
// core renders after the skills is cut off.
function releaseSkillLines(platform, named = {}) {
  const features = manifestFeatures({ ...(platform?.features || {}),
    boards: false, imagen: false, takeoverCard: false })
  const lines = manifestSkills({ features: { ...features, localAnswers: true, wecomTools: platform?.skillCmd === 'sbot wecom' },
    platformName: String(platform?.chatLabel || '飞书群').replace(/群$/, ''), ...named })
  const cron = lines.findIndex(line => line.startsWith('【定时任务】'))
  return (cron < 0 ? lines : lines.slice(0, cron))
    .map(line => line.replace(/sbot feishu/g, `${runtimeCommand()} feishu`).replace(/sbot wecom/g, `${runtimeCommand()} wecom`))
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
      durableV2CompactSession = null, durableV2CapacitySnapshot = null,
      durableV2RecoveryNotes = null, durableV2RollbackWindow = null } = options
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
        durableV2CapacitySnapshot !== null && !sync(durableV2CapacitySnapshot) ||
        durableV2RecoveryNotes !== null && (typeof durableV2RecoveryNotes.set !== 'function' ||
          typeof durableV2RecoveryNotes.delete !== 'function') ||
        durableV2RollbackWindow !== null && !sync(durableV2RollbackWindow)) {
      throw new TypeError('dedicated Engine requires complete durable v2 authority')
    }
    Object.assign(this, { cfg, store, log, durableV2Runtime, durableV2Payloads,
      durableV2StartTurn, durableV2ApplyLocalEffect, durableV2VerifyRunnerClosed,
      durableV2AssertWriterLock, durableV2Journal, durableV2NormalRoute,
      durableV2StreamFrames, durableV2AcquireCapacity, durableV2SealCapacity,
      durableV2SwitchProvider, durableV2SetBrain, durableV2ModelCatalog, durableV2ModelCard,
      durableV2UsageProbe, durableV2Issues, durableV2Version,
      durableV2DataDir, durableV2ConsoleEnabled, durableV2CompactSession, durableV2CapacitySnapshot,
      durableV2RecoveryNotes, durableV2RollbackWindow })
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

// Codex exec failed before turn.started, or Claude Code before system/init,
// and its child has closed (rule 1, ABI 40). The core judges the shape; only a not-started verdict records the
// runner-not-started witness, and its notice is kept for this receipt's one
// recovery notice. An unknown verdict, a witness that cannot be recorded (a
// merged batch, a changed authority) or a core failure leaves the start
// unknown, as before: the runner rejects and the group is held.
_durableV2PreStartFailure({ rt, chatId, receiptId, capability, facts }) {
    const known = value => typeof value === 'string' && value ? value : null
    const runner = ['codex-exec', 'claude-code'].includes(facts?.runner) ? facts.runner : null
    if (!runner) throw new Error('C2 pre-start failure names no supported runner')
    const decision = unfinishedStep({ type: 'prestart', runner, phase: facts?.phase === 'after' ? 'after' : 'before', event: known(facts?.event),
      item: known(facts?.item), tag: known(facts?.tag), excerpt: known(facts?.excerpt),
      rollbackWindowOpen: this._durableV2RollbackWindowOpen(), lang: this._chatLang(chatId) })
    this.log(`group ${chatId}: the executor failed before it started; core says ${decision.decision} (${decision.reason})`)
    if (decision.decision !== 'not-started') return { notStarted: false }
    const witnessed = capability.onSpawnFailed({ backend: runner, code: 'PRE_START_ERROR',
      turnStarted: false, closed: true })
    if (witnessed !== true) throw new Error('C2 runner not-started witness was not confirmed')
    rt.v2PreStartNotice = { receiptId, notice: decision.notice, resetSession: decision.resetSession === true }
    return { notStarted: true }
  }

// The host fact for unfinished_step: an upgrade switch that has not confirmed
// this release may still start the previous one. Unreadable counts as open.
_durableV2RollbackWindowOpen() {
    if (!this.durableV2RollbackWindow) return false
    try { return this.durableV2RollbackWindow() !== false } catch { return true }
  }

// The two runner witnesses that existed before ABI 40 (the exec child never
// spawned; the App Server rejected the thread before any turn/start) ask the
// core too, so a not-started proof is never written while an upgrade can still
// roll back. Their recovery notice stays the ordinary one.
_durableV2SpawnWitness({ chatId, capability, value }) {
    const runner = value?.backend === 'codex-app-server' ? 'codex-app-server'
      : value?.backend === 'codex-exec' ? 'codex-exec' : null
    if (!runner) return capability.onSpawnFailed(value)
    const decision = unfinishedStep({ type: 'prestart', runner, phase: 'before', event: null, item: null, tag: null,
      excerpt: null, rollbackWindowOpen: this._durableV2RollbackWindowOpen(), lang: this._chatLang(chatId) })
    if (decision.decision !== 'not-started') {
      this.log(`group ${chatId}: the executor did not start; core says ${decision.decision} (${decision.reason})`)
      throw new Error(`C2 runner not-started witness withheld (${decision.reason})`)
    }
    return capability.onSpawnFailed(value)
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
      SBOT_CHAT_ID: chatId, ...(this.wecomSocket && g?.platform === 'wecom' ? { SBOT_WECOM_SOCKET: this.wecomSocket } : {}), ...(g && g.platform ? { SBOT_PLATFORM: g.platform } : {}), TZ: this.tz, ...(this.cfg._path ? { SBOT_CONFIG: this.cfg._path } : {}), ...(this.uiLocalUrl ? { SBOT_UI_URL: this.uiLocalUrl } : {}) }
  }

_resolveGroup(chatId) {
    return (this.cfg.groups && this.cfg.groups[chatId]) || this.defaultGroup || null
  }

// The language of the bot's own words in one conversation (src/chatlang.js),
// read from the live group each time: a changed setting applies to the next
// sentence, and a conversation without the setting speaks its platform's
// default (Slack English, the others Chinese).
_chatLang(chatId) {
    return chatLang(this._resolveGroup(chatId))
  }
_texts(chatId) {
    return textsFor(this._chatLang(chatId))
  }
// A turn that failed ends with one of three fixed notices. The terminal path
// compares and settles the canonical (Chinese) text; this is the wording the
// conversation is shown, applied where the text leaves for the platform and
// only to a failed turn, so an answer is never touched.
_failureNoticeText(chatId, text, failed) {
    if (!failed || this._chatLang(chatId) !== 'en') return text
    return text === T.quotaFailure ? T_EN.quotaFailure : terminalNoticeText(text, 'en')
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

async _durableV2Command(msg, cmd, rest, platform = null) {
    const reject = (reason, notice) =>
      rejectC2Input('C2 v2 chat command answered before receipt', { reason, notice })
    const group = this._resolveGroup(msg.chatId)
    const lang = chatLang(group)
    const T = textsFor(lang)
    if (!group || group.paused) return reject('unsupported-command', T.unsupportedCommandWithModel)
    const { name, provider } = this._resolveProvider(msg.chatId, group)
    const label = (n, p) => brainLabel(n, this._brain(group, n, p), lang)
    const w = wordsOf(platform, msg.chatId, lang)
    if (cmd === '/model') return this._durableV2ModelCommand(msg, rest, group, w)
    if (cmd === '/help') {
      const isCodex = provider?.runner === 'codex'
      // Read-only exactly when the manifest tells the agent so, for either
      // runner; an unreadable policy reads as read-only.
      let readOnly = true
      try {
        readOnly = READ_ONLY_TIERS.includes(manifestPolicy(group.permissionMode, isCodex,
          group.allowedTools, group.disallowedTools).tier)
      } catch {}
      return reject('help', T.help({ project: projectName(group, lang), model: label(name, provider),
        steer: followupEnabled(group, provider.runner), readOnly, w,
        threads: typeof msg.thread === 'string' && !!msg.thread }))
    }
    if (cmd === '/status') {
      const rt = this.rts.get(msg.chatId)
      const queued = this.durableV2Runtime.snapshot().state?.lanes?.queue?.[msg.chatId]?.queue?.length || 0
      const busy = !!rt?.v2NormalRouteActive
      const state = busy
        ? T.stateRunning({ ms: Date.now() - (rt.v2StartedAt || Date.now()), steps: rt.v2Steps || 0,
          aliveMs: rt.v2AliveAt ? Date.now() - rt.v2AliveAt : null })
        : rt?.v2AdmissionPending ? T.stateWaiting : T.stateIdle
      return reject('status', T.status({ model: label(name, provider), project: projectName(group, lang), state,
        doing: busy && Array.isArray(rt.v2Doing) ? rt.v2Doing : [], queue: queued,
        session: this.store.getSession(msg.chatId) ? T.sessionActive : T.sessionNone, w }))
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
        // The probe words its value in the conversation's language.
        try { usage = await (lang === 'en' ? this.durableV2UsageProbe(name, provider, { lang }) : this.durableV2UsageProbe(name, provider)) } catch {}
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
      return record ? reject('issue-logged', T.issueLogged(record.id)) : reject('issue-failed', T.issueFailed(w))
    }
    return reject('unsupported-command', T.unsupportedCommandWithModel)
  }

// /model: backend · model · thinking depth. Words are parsed exactly
// (core/modelcmd.js); the decision is _durableV2ApplyModel (shared with the
// model card) and the write goes through the console's configuration writer.
// Every change needs this group idle and settled; only a backend change
// starts a new conversation.
async _durableV2ModelCommand(msg, want, group, w = null) {
    const reject = (reason, notice) =>
      rejectC2Input('C2 v2 model command answered before receipt', { reason, notice })
    const lang = chatLang(group)
    const T = textsFor(lang)
    if (!w) w = wordsOf(null, msg.chatId, lang)
    const { name, provider } = this._resolveProvider(msg.chatId, group)
    const names = this._modelNames()
    const words = String(want || '').split(/\s+/).map(w => w.trim()).filter(Boolean)
    // The typed /model waits (bounded) for every listed backend's stale model
    // list, so a model the CLI just gained is on the card and its name is
    // recognised on this first use. Card clicks keep using the cached list.
    await Promise.all(names.map(n => this._modelCatalog(n, this.cfg.providers[n], { fresh: true })))
    if (!words.length) {
      const cat = await this._modelCatalog(name, provider)
      const cur = this._brain(group, name, provider)
      const o = this._modelOpts(names, name, cat, cur, lang)
      const concrete = cat && Array.isArray(cat.models) ? cat.models.map(m => m.id) : []
      const exModel = concrete.find(c => (o.choices || []).includes(c) && c !== cur.model) || ''
      const text = T.modelInfo({ ...o, w, current: brainLabel(name, cur, lang),
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
    const pw = parseModelWords(words, names, lang)
    if (pw.error) {
      this._logModelReject(msg.chatId, words.join(' '), 'dup', sender)
      return reject('model-dup', T.modelDup(pw.error.what, pw.error.a, pw.error.b))
    }
    const out = await this._durableV2ApplyModel(msg.chatId, group, pw,
      { sender, said: words.join(' '), source: 'command', w })
    const reason = out.kind === 'reject' ? `model-${out.reason}` : out.kind === 'model' ? 'model-changed' : `model-${out.kind}`
    return reject(reason, out.text)
  }

// The /model card's panel state (platform-neutral; Feishu draws it with
// src/platform/modelcard.js). "Current" is the backend actually running and
// this group's choice on it. The draft (p backend, m model, e depth) starts
// as the group's choice on that backend; unchosen items are filled with the
// catalog's recommendation, so the card always shows a concrete pick. A draft
// that differs from the current one gets a preview, which enables confirm.
// s (speed): 'fast' | 'std'; absent (new card, older card) means the
// backend's current speed. The row and the draft field exist only when the
// draft model has a Fast tier, so other cards keep their previous shape.
async _modelPanel(chatId, group, extra = {}) {
    const { name, provider } = this._resolveProvider(chatId, group)
    const b = this._brain(group, name, provider)
    // The card's own labels are the platform's; an English conversation marks
    // its state so they can follow (a Chinese one keeps the state it had).
    const lang = chatLang(group)
    const marked = lang === 'en' ? { lang } : {}
    const current = brainLabel(name, b, lang)
    const mode = extra.mode || 'edit'
    if (mode !== 'edit') return { mode, current: extra.current || current, receipt: extra.receipt, issuedAt: extra.issuedAt || 0, ...marked }
    const names = this._modelNames()
    const d0 = extra.draft || {}
    const known = extra.draft && names.includes(d0.p)
    const dp = known ? d0.p : name
    const dProv = this.cfg.providers[dp]
    const base = this._brain(group, dp, dProv)
    const third = !!(dProv && dProv.baseUrl)
    const draft = known ? { p: dp, m: String(d0.m || ''), e: String(d0.e || ''), s: String(d0.s || '') } : { p: dp, m: '', e: '', s: '' }
    const cat = await this._modelCatalog(dp, dProv)
    const rec = cat && cat.ok !== false && cat.recommended ? cat.recommended : null
    let model = null // null: a third-party endpoint, whose model is set in the console
    if (!draft.e) draft.e = base.effort || ''
    if (!cat || cat.models !== null) {
      const choices = cat && cat.ok !== false ? (cat.models || []).map(m => m.id) : []
      // Every card with a list starts from the model this group runs now (its
      // own pick, else the card's); a key-route card is no exception.
      if (!draft.m) draft.m = base.model || ''
      if (!draft.m && rec && rec.model) draft.m = rec.model
      // The card's dropdown lists the first MODEL_LIST_CAP models (and the drafted one); the console has the rest.
      const options = choices.slice(0, MODEL_LIST_CAP).map(v => ({ value: v, label: modelName(v, lang) }))
      if (draft.m && !options.some(o => o.value === draft.m)) options.push({ value: draft.m, label: modelName(draft.m, lang) })
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
    // Speed: the row appears only when the draft model has a Fast tier. A
    // draft model without it while that backend runs Fast counts as standard
    // (confirm goes back to standard; the preview says so).
    const speedList = cat ? speedsFor(cat, dModel) : []
    const wantSpeed = draft.s === 'fast' ? 'fast' : draft.s === 'std' ? '' : (base.speed || '')
    const dSpeed = wantSpeed === 'fast' && !speedList.includes('fast') ? '' : wantSpeed
    const speedDropped = wantSpeed === 'fast' && !dSpeed
    if (speedList.includes('fast')) draft.s = dSpeed === 'fast' ? 'fast' : 'std'
    else delete draft.s
    const speeds = speedList.includes('fast') ? [{ value: 'std', label: pick(lang, '标准', 'Standard'), selected: dSpeed !== 'fast' }, { value: 'fast', label: 'Fast', selected: dSpeed === 'fast' }] : null
    const speedNote = !speeds ? '' : lang === 'en' ? `Fast: ${fastNote(cat, dModel, lang)} · scheduled tasks always run at standard speed`
      : `Fast：${fastNote(cat, dModel)} · 定时任务始终按标准`
    let preview = null
    if (dp !== name || dModel !== b.model || (dEffort || '') !== (b.effort || '') || dSpeed !== (b.speed || '')) {
      const effortTuned = (dEffort || '') !== (b.effort || '')
      const speedTuned = dSpeed !== (b.speed || '')
      const tuned = [effortTuned ? pick(lang, '深度', 'effort') : '', speedTuned ? pick(lang, '速度', 'speed') : ''].filter(Boolean).join(pick(lang, '和', ' and '))
      const note = lang === 'en'
        ? (dp !== name ? 'Backend changed — a new conversation will start' : dModel !== b.model ? 'Model changed — the conversation continues' : `Only the ${tuned} ${effortTuned && speedTuned ? 'change' : 'changes'} — the conversation continues`)
        : dp !== name ? '换了后端 —— 会开新对话' : dModel !== b.model ? '换了型号 —— 接着当前对话' : `只调${tuned} —— 接着当前对话`
      preview = { to: brainLabel(dp, { model: dModel, effort: dEffort, speed: dSpeed }, lang),
        note: note + (speedDropped ? pick(lang, ' · 这个型号没有 Fast，回到标准速度', ' · this model has no Fast tier; back to standard speed') : '') }
    }
    return { mode, current, draft, preview, failover: '', quota: '',
      backends: names.map(n => ({ name: n, selected: n === dp })),
      model, efforts, speeds, speedNote, issuedAt: extra.issuedAt || 0, ...marked }
  }

// A tap on the /model card. value = the callback value { f, v?, d, t },
// option = the dropdown choice, who = the operator's name.
//   f = p | m | e | s: change only the card's draft (nothing is written; s = speed)
//   f = ok: apply the draft once through _durableV2ApplyModel → receipt card
//   f = x: close; nothing changes, the card turns grey in place
// Returns { toast?, state? }; state is drawn into a card that replaces this one.
async handleModelCard({ chatId, who = '', value = {}, option } = {}) {
    const group = this.cfg.groups && this.cfg.groups[chatId]
    if (!group) return { toast: { type: 'info', content: '这个群还没绑定项目' } }
    const lang = chatLang(group)
    const issued = Number(value.t) || 0
    const now = Date.now()
    if (value.f === 'x') return { toast: { type: 'info', content: pick(lang, '已关闭 · 模型没变', 'Closed · the model is unchanged') }, state: await this._modelPanel(chatId, group, { mode: 'closed' }) }
    if (group.paused) return { toast: { type: 'warning', content: pick(lang, '本群已暂停 —— 恢复后再改', 'This group is paused — change it after it resumes') } }
    if (!issued || now - issued > MODEL_CARD_TTL_MS) {
      return { toast: { type: 'info', content: pick(lang, '这张卡已过期 —— 发 /model 重新打开', 'This card has expired — send /model to open a new one') }, state: await this._modelPanel(chatId, group, { mode: 'expired' }) }
    }
    const d = value.d && typeof value.d === 'object' ? { p: String(value.d.p || ''), m: String(value.d.m || ''), e: String(value.d.e || ''), s: String(value.d.s || '') } : null
    const norm = x => (x == null || x === MODEL_CARD_DEFAULT ? '' : String(x))
    if (value.f === 'p' || value.f === 'm' || value.f === 'e' || value.f === 's') {
      let draft = d
      if (value.f === 'p') draft = { p: norm(value.v), m: '', e: '', s: '' }
      else if (value.f === 'm') draft = { ...(d || {}), m: norm(option) }
      else if (value.f === 's') draft = { ...(d || {}), s: norm(value.v) === 'fast' ? 'fast' : 'std' }
      else draft = { ...(d || {}), e: norm(value.v) }
      return { state: await this._modelPanel(chatId, group, { draft, issuedAt: now }) }
    }
    if (value.f !== 'ok' || !d) return {}
    const by = String(who || '').trim() || pick(lang, '有人', 'Someone')
    const before = await this._modelPanel(chatId, group)
    const { name: curName } = this._resolveProvider(chatId, group)
    const target = d.p || curName
    const tb = this._brain(group, target, this.cfg.providers[target])
    // An older card's draft has no speed field: leave speed alone.
    const ds = d.s === 'fast' ? 'fast' : d.s === 'std' ? '' : undefined
    const speed = ds !== undefined && ds !== (tb.speed || '') ? ds : undefined
    const out = await this._durableV2ApplyModel(chatId, group, {
      provider: d.p && d.p !== curName ? d.p : undefined,
      model: d.m && d.m !== tb.model ? d.m : undefined,
      effort: d.e && d.e !== tb.effort ? d.e : undefined,
      ...(speed !== undefined ? { speed } : {}) },
    { sender: by, said: `[模型卡] ${d.p}·${d.m || '-'}·${d.e || '-'}${d.s === 'fast' ? '·fast' : ''}`, source: 'card' })
    if (out.kind === 'reject' && out.reason === 'busy') return { toast: { type: 'warning', content: pick(lang, '手头还有任务在跑 —— 等它做完再确认，或先发 /stop', 'A task is still running — confirm after it finishes, or send /stop first') } }
    if (out.kind === 'reject' || out.kind === 'failed') return { toast: { type: 'error', content: String(out.text || '').split('\n')[0].replace(/^⚠\s*/, '') } }
    const g2 = (this.cfg.groups && this.cfg.groups[chatId]) || group
    if (out.kind === 'same') return { toast: { type: 'info', content: pick(lang, '已经是这个了，没有变化', 'Already set to this; nothing changed') }, state: await this._modelPanel(chatId, g2, { issuedAt: now }) }
    const hm = fmtStamp(now, this.tz).slice(-5)
    const after = await this._modelPanel(chatId, g2)
    if (lang === 'en') {
      const how = out.kind === 'switched' ? 'a new conversation has started' : 'the conversation continues'
      return {
        toast: { type: 'success', content: `Changed to ${after.current} · ${how}` },
        state: { mode: 'receipt', current: after.current, lang,
          receipt: { line: `${by} changed it to ${after.current} · ${how} · ${hm}`, before: `Before: ${before.current}` } },
      }
    }
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
async _modelCatalog(name, provider, opts) {
    if (!this.durableV2ModelCatalog) return null
    try { return await this.durableV2ModelCatalog(name, provider, opts) } catch { return null }
  }
_modelOpts(names, name, cat, brain, lang = 'zh') {
    // A long live list is listed up to MODEL_LIST_CAP (the rest: 「更多见控制台」); a typed name still resolves on the whole list.
    const all = !cat ? undefined : cat.models === null ? null : cat.ok === false ? [] : modelChoices(cat)
    return { names, name,
      choices: Array.isArray(all) ? all.slice(0, MODEL_LIST_CAP) : all, more: Array.isArray(all) ? Math.max(0, all.length - MODEL_LIST_CAP) : 0,
      efforts: cat ? effortsFor(cat, brain && brain.model) : [],
      // Speed: only the live catalog says whether this model has a Fast tier.
      speeds: cat ? speedsFor(cat, brain && brain.model) : [], speed: (brain && brain.speed) || '',
      fastNote: fastNote(cat, brain && brain.model, lang) }
  }
_logModelReject(chatId, said, reason, sender) {
    this.log(`/model rejected: ${chatId} ${JSON.stringify(String(said || '')).slice(0, 80)} ${reason} (by ${sender})`)
  }

// pw = { provider?, model?, models?, effort?, speed? } from parseModelWords,
// or the model card's confirmed draft. Returns { kind, reason?, text, label?, after? }
// with kind ∈ reject | failed | same | switched | model | effort | tune.
// Missing picks on the target backend are filled with the catalog's
// recommendation (fillPicks); a depth-only change never fills a model.
// speed: 'fast' turns Fast on, '' goes back to standard (meaningful, not
// "unset"), undefined leaves it alone. Like depth it keeps the session; Fast
// on a model without the tier (live catalog) refuses the whole command, and a
// model or backend change onto such a model drops Fast and says so (fillPicks).
async _durableV2ApplyModel(chatId, group, pw, { sender = 'unknown', said = '', source = 'command', w = null } = {}) {
    const reject = (reason, text) => { this._logModelReject(chatId, said, reason, sender); return { kind: 'reject', reason, text } }
    const lang = chatLang(group)
    const T = textsFor(lang)
    if (!w) w = wordsOf(null, chatId, lang)
    const { name, provider } = this._resolveProvider(chatId, group)
    const names = this._modelNames()
    const target = pw.provider || name
    // The card's draft comes back from the platform: accept only a listed backend.
    if (pw.provider && !names.includes(pw.provider)) return reject('unknown', T.modelUnknownWord(target, this._modelOpts(names, name, null, null, lang)))
    const tProv = this.cfg.providers[target]
    const tBrain = this._brain(group, target, tProv)
    if (pw.model === '') pw = { ...pw, model: undefined }
    if (pw.effort === '') pw = { ...pw, effort: undefined }
    if (pw.models) {
      const mcat = await this._modelCatalog(target, tProv)
      const bad = pw.models.find(w => !resolveModel(w, mcat))
      if (bad) return reject('unknown', T.modelUnknownWord(bad, this._modelOpts(names, target, mcat, tBrain, lang)))
      const ids = [...new Set(pw.models.map(w => resolveModel(w, mcat)))]
      if (ids.length > 1) return reject('dup', T.modelDup(whatName('model', lang), pw.models[0], pw.models[1]))
      pw = { ...pw, model: ids[0] }
      delete pw.models
    }
    const switching = target !== name
    const wantsBrain = pw.model !== undefined || pw.effort !== undefined || pw.speed !== undefined
    const cat = wantsBrain || switching ? await this._modelCatalog(target, tProv) : null
    let model
    if (pw.model !== undefined) {
      if (cat && cat.models === null) return reject('unknown', T.modelUnknownWord(pw.model, this._modelOpts(names, target, cat, tBrain, lang)))
      if (!cat || cat.ok === false) return reject('no-catalog', T.modelNoCatalog(target))
      model = resolveModel(pw.model, cat)
      if (!model) return reject('unknown', T.modelUnknownWord(pw.model, this._modelOpts(names, target, cat, tBrain, lang)))
      if (model === tBrain.model) model = undefined
    }
    const f = fillPicks({ switching, model, effort: pw.effort, speed: pw.speed, currentModel: tBrain.model,
      currentEffort: tBrain.effort, currentSpeed: tBrain.speed || '', third: !!(tProv && tProv.baseUrl), cat, lang })
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
    let speed // undefined = keep; '' = standard; 'fast'
    if (pw.speed === 'fast') {
      if (!cat || cat.ok === false) return reject('no-catalog', T.modelNoCatalog(target))
      if (!speedsFor(cat, nextModel).includes('fast')) return reject('speed', T.modelSpeedUnsupported(nextModel || target))
      speed = tBrain.speed === 'fast' && model === undefined && !switching ? undefined : 'fast'
    } else if (pw.speed !== undefined) speed = pw.speed === (tBrain.speed || '') && model === undefined && !switching ? undefined : pw.speed
    else speed = f.speed
    const current = brainLabel(name, this._brain(group, name, provider), lang)
    if (!switching && model === undefined && effort === undefined && speed === undefined) return { kind: 'same', text: T.modelSame(current, w), label: current }
    // Speed alone is read at the next turn's start and keeps the session, so
    // it may change while a task runs; anything else waits for the group.
    const speedOnly = !switching && model === undefined && effort === undefined && speed !== undefined
    if (!speedOnly) {
      if (this._durableV2GroupBusy(chatId)) return reject('busy', T.modelBusy)
      const stopping = this._stopIdleCompact(this.rts.get(chatId), '会话已重置')
      if (stopping && await stopping !== true) return reject('busy', T.modelBusy)
      if (this._durableV2GroupBusy(chatId)) return reject('busy', T.modelBusy)
    }
    if (this.durableV2AssertWriterLock() !== true) return reject('busy', T.modelBusy)
    let r
    try {
      if (this.durableV2SetBrain) {
        r = this.durableV2SetBrain(chatId, { provider: switching ? target : undefined, model, effort,
          ...(speed !== undefined ? { speed } : {}) }, { by: sender, source })
      } else if (switching && model === undefined && effort === undefined && speed === undefined) {
        this.durableV2SwitchProvider(chatId, target)
      } else throw new Error('Model and depth writer unavailable')
    } catch (error) {
      this.log(`/model failed for ${chatId} → ${target}: ${error?.message || String(error)}`)
      return { kind: 'failed', reason: 'failed',
        text: /settled|任务进行中|空闲/.test(error?.message || '') ? T.modelBusy : T.modelSwitchFailed }
    }
    const g2 = (this.cfg.groups && this.cfg.groups[chatId]) || group
    const after = r?.after || this._brain(g2, target, this.cfg.providers[target])
    const label = brainLabel(target, after, lang)
    const sp = b => (b && b.speed ? '·' + b.speed : '')
    this.log(`/model: ${chatId} ${name}·${tBrain.model || '-'}·${tBrain.effort || '-'}${sp(tBrain)} → ${target}·${after.model || '-'}·${after.effort || '-'}${sp(after)} (by ${sender}, ${source})`)
    const filled = f.filled.length ? f.filled.join(pick(lang, '和', ' and ')) : ''
    // Fast was on and the model now in effect has no tier: say it went back to standard.
    const dropped = f.speedDropped && tBrain.speed === 'fast' && after.speed !== 'fast' ? (after.model || target) : ''
    if (switching) {
      let note = ''
      try {
        const opts = { full: group.permissionMode === 'bypassPermissions', isCodex: tProv?.runner === 'codex',
          ...(lang === 'en' ? { lang } : {}) }
        const h = this.projectMemory ? this.projectMemory(group.workdir, opts) : null
        if (h?.note) note = h.note
      } catch {}
      return { kind: 'switched', text: T.modelSwitched(label, note, filled, dropped, w), label, after }
    }
    if (r?.modelChanged) return { kind: 'model', text: T.modelChanged(label, filled, dropped), label, after }
    // Speed changed (maybe with depth): kind 'tune'; a depth-only change keeps its own receipt.
    const speedChanged = r ? !!r.speedChanged : speed !== undefined && (tBrain.speed || '') !== (after.speed || '')
    if (speedChanged) {
      const effortChanged = r ? !!r.effortChanged : effort !== undefined && tBrain.effort !== after.effort
      return { kind: 'tune', text: T.tuneSwitched({ effort: after.effort, effortChanged, speed: after.speed || '', note: fastNote(cat, after.model, lang),
        label: brainLabel(target, { model: after.model, effort: effortChanged ? '' : after.effort }, lang) }), label, after }
    }
    return { kind: 'effort', text: T.effortSwitched(after.effort, brainLabel(target, { model: after.model }, lang)), label, after }
  }

async runDurableV2Message(msg, platform) {
    if (msg?.text?.trim() === '/stop') {
      // Stop where it is said: typed as a reply in a thread it reaches that
      // thread's running task only, like the Stop button there (the core
      // decides which); anywhere else it stops the whole chat.
      const scope = this._durableV2StopScope(msg)
      if (scope !== 'all') throw await this.runDurableV2Skip(msg, { threadStop: scope })
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
        !platform ||
        typeof platform.reply !== 'function' ||
        typeof platform.replyOnce !== 'function' ||
        // A card platform streams into its reply card. A plain platform (the
        // console's own conversation) declares that its one final reply is a
        // text line; the terminal path then never opens a card.
        !(platform.features?.cardQuota === true && typeof platform.createStreamingCard === 'function' ||
          platform.features?.plainReplies === true && platform.createStreamingCard === undefined)) {
      throw new Error('C2 v2 ordinary Feishu message is unsupported or closed')
    }
    const T = this._texts(msg.chatId)
    // An unmigrated chat command is user input, not an authority fault. It is
    // refused before admission with no receipt; the service decides delivery.
    const command = /^(\/[a-z]+)(?:\s+([\s\S]*))?$/.exec(msg.text.trim())
    if (command && this.durableV2SwitchProvider && DURABLE_V2_COMMANDS.has(command[1])) {
      throw await this._durableV2Command(msg, command[1], (command[2] || '').trim(), platform)
    }
    if (msg.text.trim().startsWith('/')) {
      throw rejectC2Input('C2 v2 ordinary Feishu message is unsupported or closed',
        { reason: 'unsupported-command', notice: this.durableV2SwitchProvider
          ? T.unsupportedCommandWithModel : T.unsupportedCommand })
    }
    const group = this._resolveGroup(msg.chatId)
    const { provider } = group ? this._resolveProvider(msg.chatId, group) : {}
    if (!group || group.paused || group.platform && !DURABLE_PLATFORMS.includes(group.platform) ||
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
      // It waits for the slot without a notice, as in 1.4.24.
      if (queued.staged) (rt.v2SilentReceiptIds ||= new Set()).add(queued.receiptId)
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
    if (busy) {
      // Where a busy message goes is the core's decision (its queue step); the
      // host passes the facts: follow-ups open and the runner ready to take
      // one, whether a message can wait here right now, this message's thread
      // and the threads of the running task's messages. The core joins it to
      // that task, lets it wait, or refuses it before any receipt (the queue
      // is full, or the task is wrapping up). A busy message never holds the
      // group; only a queue that disagrees with the journal is a fault.
      const ready = !!(rt.v2FollowupEnabled && rt.v2SteerControl && rt.v2NormalRouteActive &&
        !rt.v2RunnerStopVerified && !rt.v2TerminalStarted && !rt.v2StreamQuiescing &&
        rt.v2Controller && !rt.v2Controller.signal.aborted && !rt.v2SteerClosing &&
        rt.v2RunningJobs?.length > 0)
      const consistent = rt.v2NormalRouteActive && Array.isArray(queue) &&
        queue.every(item => !item.batch && /^receipt:job:[0-9a-f]{32}$/.test(item.id)) &&
        isDeepStrictEqual(queue.map(item => item.id.slice('receipt:job:'.length)),
          rt.v2QueueReceiptIds || []) &&
        isDeepStrictEqual(this.durableV2Journal.snapshot(), before)
      // A message can wait here with its own notice while the task runs and
      // every waiting message has a confirmed notice or none at all (one that
      // arrived while the chat waited for a model slot waits silently, as in
      // 1.4.24).
      const waitable = !!consistent &&
        lane?.turn?.[msg.chatId]?.active === rt.v2TurnToken &&
        lane?.handoff?.[msg.chatId]?.phase === 'running' &&
        rt.v2DispatchEffect?.type === 'dispatch' &&
        rt.v2RunningJobs?.length > 0 &&
        rt.v2RunnerStopVerified !== true &&
        queue.every(item => this._durableV2QueueNoticeSettled(rt, before, item))
      if (consistent) {
        try { this.durableV2Payloads.auditOrdinaryQueue(msg.chatId, rt.v2QueueReceiptIds || []) }
        catch (error) { authority.close(); throw error }
        // A message a scheduled task posted never joins the running task: the
        // core closes follow-ups for it, so it waits its turn like any other.
        const joinable = scheduledTurnPolicy(isScheduledMessage(msg), ready, null).followups
        const queued = this.stageDurableV2Message(msg, platform, {
          busy: { followups: joinable, waitable, ...this._durableV2ThreadFacts(rt, msg) },
          accept: route => route === 'join' ? joinable : waitable })
        if (queued.route === 'refuse') {
          const full = queued.refusal === 'full'
          throw rejectC2Input('C2 v2 busy message refused before receipt', {
            reason: full ? 'queue-full' : 'busy-unavailable', notice: full ? T.queueFull : T.busyUnavailable })
        }
        if (queued.staged && queued.route === 'join') {
          const steered = await this._runDurableV2Steer(rt, queued.receiptId)
          if (steered) return steered
        }
        if (queued.staged) {
          if (!waitable) {
            authority.close()
            throw new Error('C2 v2 busy message has no waiting route')
          }
          return this._queueDurableV2Notice(rt, msg, platform, queued.receiptId)
        }
      }
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
          receiptId = v2QueueSelection(queued, this.durableV2Payloads.queueThreads(queued)).anchor
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

// The facts the core decides joining by: this message's thread (a Slack
// channel thread) and those of the running task's messages. A chat without
// threads gives null for all, so every message is in the same thread.
_durableV2ThreadFacts(rt, msg) {
    const of = value => typeof value?.thread === 'string' && value.thread ? value.thread : null
    return { thread: of(msg), turnThreads: (rt.v2RunningJobs || []).map(job => of(job?.msg)) }
  }

// What a typed /stop reaches ("all", "turn" or "none"), decided by the core
// from where it was said. A message without a thread never asks: it stops the
// whole chat, as on every platform without threads.
_durableV2StopScope(msg) {
    if (typeof msg?.thread !== 'string' || !msg.thread) return 'all'
    const rt = this.rts.get(msg.chatId)
    const scope = engineQueueStep({ queue: [] }, { type: 'peek',
      stop: { ...this._durableV2ThreadFacts(rt || {}, msg), reply: msg.threadReply === true } }).stop
    if (!['all', 'turn', 'none'].includes(scope)) throw new Error('SintBot binary core returned invalid stop scope')
    return scope
  }

// One queued message's notice, sent once: what the core decided for it.
async _queueDurableV2Notice(rt, msg, platform, receiptId) {
    const authority = this.durableV2Runtime
    let attached
    try { attached = this.durableV2Payloads.requireQueued(receiptId) }
    catch (error) { authority.close(); throw error }
    if (attached?.msg?._c2ReceiptId !== receiptId) {
      authority.close()
      throw new Error('C2 v2 queued follow-up lacks exact payload handle')
    }
    try { this.durableV2Payloads.auditOrdinaryQueue(msg.chatId, rt.v2QueueReceiptIds) }
    catch (error) { authority.close(); throw error }
    const notice = authority.prepareQueueNotice({ receiptId,
      chatId: msg.chatId, payloadHandles: this.durableV2Payloads })
    const noticePromise = authority.executeQueueNotice({
      effectId: notice.effectId, receiptId, chatId: msg.chatId,
      payloadHandles: this.durableV2Payloads,
      assertWriterLock: this.durableV2AssertWriterLock,
      perform: ({ target }) => platform.replyOnce(target, this._texts(msg.chatId).queued(notice), ENGINE_NOTICE),
      confirm: response => response?.code === 0 &&
        /^om_[A-Za-z0-9_-]{1,124}$/.test(response?.data?.message_id || ''),
    })
    rt.v2QueueNoticePromise = noticePromise
    try { await noticePromise } finally {
      if (rt.v2QueueNoticePromise === noticePromise) rt.v2QueueNoticePromise = null
    }
    return { receiptId, queued: true, staged: true, ingressClosed: !!authority.blocked }
  }

// A queued message is settled for waiting when its notice is confirmed, or
// when it never had one because this process admitted it while the chat
// waited for a model slot (it waits silently, as in 1.4.24).
_durableV2QueueNoticeSettled(rt, snapshot, item) {
    const receiptId = typeof item?.id === 'string' ? item.id.slice('receipt:job:'.length) : null
    for (const [effectId, status] of snapshot.effects) {
      const descriptor = this.durableV2Journal.effectDescriptor(effectId)
      if (descriptor?.type === 'queueNotice' && descriptor.receiptId === receiptId) return status === 'acked'
    }
    return !!rt?.v2SilentReceiptIds?.has(receiptId)
  }

async _runDurableV2Steer(rt, receiptId) {
    const authority = this.durableV2Runtime
    const chatId = rt.chatId
    const job = this.durableV2Payloads.requireQueued(receiptId)
    const identity = authority.prepareSteer({ receiptId, chatId,
      parentReceiptId: rt.v2DispatchEffect.receiptIds.at(-1),
      turnToken: rt.v2TurnToken, generation: rt.v2RunnerGeneration,
      payloadHandles: this.durableV2Payloads, ...this._durableV2ThreadFacts(rt, job.msg) })
    // Another thread of the chat: the core keeps it out of this task.
    if (!identity) return null
    this.durableV2Payloads.takeSteer(receiptId, chatId, identity.effectId)
    rt.v2QueueReceiptIds = authority.scopeState('queue', chatId).queue
      .map(item => item.id.slice('receipt:job:'.length))
    const entry = { identity, job, landed: false, accepted: false }
    rt.v2SteerEntries.set(receiptId, entry)
    const control = rt.v2SteerControl
    const work = (async () => {
      const text = T.followUp(fmtStamp(job.msg.createTimeMs || Date.now(), this.tz), job.msg.senderName || job.msg.userId || 'user',
        job.msg.text.trim(), wordsOf(job.platform, chatId), this._chatLang(chatId))
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
          perform: ({ target }) => job.platform.replyOnce(target, this._texts(chatId).queued(notice), ENGINE_NOTICE),
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
      throw durableV2StopUnavailable(rt, this._texts(chatId))
    }
    const group = this._resolveGroup(chatId)
    if (!group || group.paused || group.platform && !DURABLE_PLATFORMS.includes(group.platform)) {
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
      throw durableV2StopUnavailable(rt, this._texts(chatId))
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
          // A confirmed notice, or none: it waited silently for a model slot.
          !this._durableV2QueueNoticeSettled(rt, before, item)) ||
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
async runDurableV2Skip(msg, { threadStop = null } = {}) {
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
    if (!group || group.paused || group.platform && !DURABLE_PLATFORMS.includes(group.platform)) {
      throw new Error('C2 v2 /skip group control is not migrated')
    }
    const T = textsFor(chatLang(group))
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
    // The Stop of one round names the round by one of its messages (`turnSource`,
    // as the platform saw it running). It stops that round only, and only while
    // that round is the one running; the queue goes on, like /skip.
    const bound = Object.hasOwn(msg, 'turnSource')
    if (bound) {
      const source = typeof msg.turnSource === 'string' && /^om_[A-Za-z0-9_-]{1,124}$/.test(msg.turnSource)
        ? taskId({ source: 'message', chatId, sourceId: msg.turnSource }) : null
      if (!source || !rt?.v2NormalRouteActive || !rt.v2RunningJobs?.length ||
          !(rt.v2DispatchEffect?.receiptIds || []).includes(source) && !rt.v2SteerEntries?.has(source)) {
        return reject('skip-ended', T.roundEnded)
      }
    }
    // A stop typed in a thread (`threadStop`: what the core answered in this
    // same tick) is a /skip of that thread's running task; when that thread
    // has no running task, nothing is stopped.
    if (threadStop && threadStop !== 'turn') return reject('stop-thread-idle', T.threadIdle)
    if (!rt?.v2NormalRouteActive || !rt.v2RunningJobs?.length) {
      return reject(threadStop ? 'stop-thread-idle' : 'skip-idle', threadStop ? T.threadIdle : T.noActiveTask)
    }
    // A round-bound stop already names its round by identity; only an
    // unbound /skip guards a late redelivery by platform time.
    const sentAt = Number(msg.createTimeMs)
    if (!bound && Number.isSafeInteger(sentAt) && sentAt > 0 && rt.v2RunningJobs.some(job =>
      Number(job?.msg?.createTimeMs) > sentAt)) {
      return reject('skip-stale', null)
    }
    const route = rt.v2NormalRoutePromise
    let settle
    const settled = new Promise(resolve => { settle = resolve })
    const waiter = { turnToken: rt.v2TurnToken, settle }
    if (rt.v2SkipWaiter || !route || !Number.isSafeInteger(waiter.turnToken)) {
      return reject('skip-unavailable', threadStop ? T.stopUnavailable : T.skipUnavailable)
    }
    rt.v2SkipWaiter = waiter
    try {
      if (!this.requestDurableV2Stop(chatId)) {
        if (authority.blocked) throw new Error('C2 v2 /skip closed its durable authority')
        return reject('skip-unavailable', threadStop ? T.stopUnavailable : T.skipUnavailable)
      }
      const queued = await Promise.race([settled, route.then(() => null)])
      if (queued === null) {
        // The turn ended without this cancellation, e.g. its runner was proven
        // never started. Nothing was skipped and the group is not at fault;
        // only a closed authority is.
        if (authority.blocked) throw new Error('C2 v2 /skip cancellation was not durably settled')
        return reject('skip-unavailable', threadStop ? T.stopUnavailable : T.skipUnavailable)
      }
      this.log(`/skip: ${chatId} (by ${msg.senderName || 'unknown'}${bound ? ', round Stop' : threadStop ? ', thread stop' : ''}), ${queued} queued`)
      return reject('skipped', bound || threadStop ? T.roundStopped(queued) : T.skipped(queued))
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
          const said = this._texts(identity.chatId)
          const text = stop.queuedReceiptIds.length
            ? said.stoppedWithQueue(stop.queuedReceiptIds.length) : said.stopped
          await authority.executeStopAck({ effectId: cancelled.effectId,
            controlReceiptId: stop.controlReceiptId, chatId: identity.chatId,
            target: stop.target,
            perform: target => stop.platform.replyOnce(target.replyCtx, text, ENGINE_NOTICE),
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

stageDurableV2Message(msg, platform, { busy = null, accept = null } = {}) {
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
    // A busy message is checked once the core has placed it: a refused one
    // never reaches the payload bound.
    if (!busy) handles.preflight(receipt, job)
    const flags = { quiet: receipt.quiet, polled: !!msg.polled, synthetic: false,
      wantsAck: !!msg.wantsAck, resetSessionAfter: !!msg.resetSessionAfter,
      emptyRetried: false, freshRetried: false, firstResumed: false, failedOver: false }
    let result
    try { result = authority.enqueueMessage({ receipt, flags,
      ...(busy ? { busy, accept, preflight: () => handles.preflight(receipt, job) } : {}) }) }
    catch (error) {
      authority.close()
      throw error
    }
    // Not admitted (refused by the core, or a route this state cannot take):
    // no receipt exists and nothing was written.
    if (result.staged === false) {
      return { receiptId: receipt.id, route: result.route, refusal: result.refusal ?? null,
        staged: false, ingressClosed: !!authority.blocked }
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
      ...(result.route ? { route: result.route } : {}), ingressClosed: !!authority.blocked }
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
    const taken = v2QueueSelection(queue, this.durableV2Payloads.queueThreads(queue)).jobs
    if (!taken.length || taken.some(item => item.synthetic || item.batch ||
        item.quiet || item.polled ||
        !/^receipt:job:[0-9a-f]{32}$/.test(item.id) ||
        snapshot.receipts.pending.find(receipt =>
          receipt.id === item.id.slice('receipt:job:'.length))?.chatId !== chatId ||
        // A confirmed notice, or none: it waited silently for a model slot.
        !this._durableV2QueueNoticeSettled(rt, snapshot, item))) {
      authority.close()
      throw new Error('C2 v2 successor lacks flat acknowledged queue cohort')
    }
    try { this.durableV2Payloads.auditOrdinaryQueue(chatId, ids) }
    catch (error) { authority.close(); throw error }
    return v2QueueSelection(queue, this.durableV2Payloads.queueThreads(queue)).anchor
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
      ? v2QueueSelection(queue, handles.queueThreads(queue)).jobs.map(item =>
        typeof item?.id === 'string' ? item.id.slice('receipt:job:'.length) : null) : []
    if (typeof chatId !== 'string' || !chatId ||
        typeof receiptId !== 'string' || !/^[0-9a-f]{32}$/.test(receiptId) ||
        !Array.isArray(queue) || v2QueueSelection(queue, handles.queueThreads(queue)).anchor !== receiptId ||
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
      if (rt.v2SilentReceiptIds) {
        rt.v2SilentReceiptIds = new Set([...rt.v2SilentReceiptIds].filter(id => rt.v2QueueReceiptIds.includes(id)))
      }
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
    rt.v2CardFailureNotice = false
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
      // The turn reads the group's settings as they are now, not the copy
      // taken when its message arrived: an edit that does not wait for a
      // running turn (speed) replaces the group object while this job queued.
      const liveGroup = this.cfg.groups?.[chatId]
      if (liveGroup) for (const item of cohort.jobs) item.group = liveGroup
      const job = cohort.anchor
      const { name, provider } = this._resolveProvider(chatId, job.group)
      if (!provider || (provider.baseUrl && !provider.apiKey)) {
        throw new Error('C2 v2 runner provider unavailable')
      }
      // Runner input, card footer and activity all use this one brain; a
      // scheduled turn runs at standard speed. The turn is a scheduled one
      // when any message it starts with was posted by a scheduled task.
      const scheduledTurn = cohort.jobs.some(item => isScheduledMessage(item.msg))
      rt.v2Brain = turnBrain(this._brain(job.group, name, provider), { scheduled: scheduledTurn })
      rt.v2CardModelInfo = cardModelInfo(rt.v2Brain, this._chatLang(chatId))
      this._observeActivity('start', { chatId, receiptId, receiptIds: cohort.receiptIds, generation,
        sessionId: this.store.getSession(chatId), model: rt.v2Brain.model, effort: rt.v2Brain.effort,
        ...(rt.v2Brain.speed === 'fast' ? { speed: 'fast' } : {}),
        runner: provider.runner, project: projectName(job.group) })
      // Follow-ups as the group has them, unless the core closes them for a
      // scheduled turn: then the runner's control is never taken, so later
      // messages wait in the queue instead of joining it.
      const groupFollowups = followupEnabled(job.group, provider.runner)
      rt.v2FollowupEnabled = scheduledTurnPolicy(scheduledTurn, groupFollowups, null).followups
      const followupsClosed = groupFollowups && !rt.v2FollowupEnabled
      rt.v2SteerControl = null
      rt.v2SteerEntries = new Map()
      rt.v2SteerClosing = false
      rt.v2SteerLandedChain = Promise.resolve()
      const steerIdentity = { chatId, parentReceiptId: receiptId, turnToken, generation }
      const steerAlive = () => rt.v2RunnerGeneration === generation && !rt.v2SteerClosing &&
        !controller?.signal.aborted && !rt.v2TerminalStarted
      const onSteerReady = control => {
        if (!steerAlive() || followupsClosed) return
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
            // A scheduled task's message keeps its place too: it is never a follow-up.
            if (!scheduledTurnPolicy(isScheduledMessage(this.durableV2Payloads.requireQueued(id).msg), true, null).followups) continue
            // The core declines another thread's message: it keeps its place.
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
      rt.v2InterruptNote = null
      const prompt = this._prepareRunnerPrompt({ msg: job.msg, group: job.group,
        platform: job.platform, providerName: name, provider, rt,
        batch: cohort.receiptIds.length > 1 ? cohort.jobs.map(item => item.msg) : null,
        consumeLifecycle: false })
      controller = new AbortController()
      rt.v2Controller = controller
      rt.v2RunnerStopPromise = null
      rt.v2RunnerStopVerified = false
      rt.v2RunnerNotStarted = false
      rt.v2PreStartNotice = null
      let streamChain = Promise.resolve()
      let streamFailure = null
      const joinedLine = () => rt.v2CardJoinedNames.length
        ? this._texts(chatId).cardJoined(rt.v2CardJoinedNames) : ''
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
              redactText: value => this._failureNoticeText(chatId, redact(rt.v2CardQuotaFailure === true
                ? T.quotaFailure : value, { pii: job.group?.redactPii !== false }), rt.v2CardFailureNotice === true),
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
          rt.v2CardBinding.path.update((rt.v2LastCardText || progress.textsFor(this._chatLang(chatId)).ackWorking) + joinedLine())
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
              progress.pushDoing(rt.v2Doing, progress.describeTool(tool.name, tool.input, this._chatLang(chatId)))
              pushAuto(progress.autoMilestone(tool.name, tool.input, this._chatLang(chatId)))
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
        enqueueCardText(progress.textsFor(this._chatLang(chatId)).ackWorking)
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
          const lang = this._chatLang(chatId)
          const stale = sinceAlive >= PULSE_STALE_MS ? progress.humanDur(sinceAlive, lang) : ''
          // Same gate as the stream frame: text that may still become NO_REPLY
          // never reaches the card.
          const buffer = projection.streamSnapshot().bufferText
          const sofar = buffer.trim()
          const body = autoBlock() + (sofar && !NO_REPLY.startsWith(sofar)
            ? progress.renderMilestones(buffer) + '\n\n' : '')
          enqueueCardText(body + progress.textsFor(lang).pulse(
            progress.humanDur(Date.now() - pulseFrom, lang), rt.v2Doing, stale))
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
            capTimer = setTimeout(onHardDeadline, Math.min(timeoutDeadlineAt - elapsedAt, MAX_TIMER_MS))
            return
          }
          rt.v2TimeoutProof = { receiptId, turnToken, generation,
            deadlineAt: timeoutDeadlineAt, elapsedAt }
          controller.abort()
      }
      // A delay past the timer maximum fires after 1 ms; the deadline check
      // above re-arms an early callback, so the clamp keeps the same deadline.
      capTimer = timeoutDeadlineAt !== null ? setTimeout(onHardDeadline, Math.min(timeoutMs, MAX_TIMER_MS)) : null
      const input = prepareC2RunnerInput({ prompt,
        appendSystemPrompt: SYSTEM_APPENDIX, msg: job.msg, group: job.group,
        provider, config: this.cfg, brain: { model: rt.v2Brain.model, effort: rt.v2Brain.effort,
          ...(rt.v2Brain.speed === 'fast' ? { speed: 'fast' } : {}) },
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
          this._consumeInterruptNote(chatId, rt)
          return ack
        },
        onSpawnFailed: value => this._durableV2SpawnWitness({ chatId, capability, value }),
        onPreStartFailure: facts => this._durableV2PreStartFailure({ rt, chatId, receiptId, capability, facts }),
        onSteerReady, onSteerLanded,
        log: this.log })
      rt.v2Compacted = false // 「进度可能已折叠」只带一轮
      // The handed-back reply belongs to that same turn only; and this turn's
      // own reply is not known until its terminal delivery completes.
      rt.v2HandbackReply = null
      rt.v2LastReply = ''
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
      // Codex reports cumulative session usage. Use the same built-in core
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
        ['AGENT_BIN_MISSING', 'AGENT_THREAD_REJECTED', 'AGENT_NOT_STARTED'].includes(error?.code) &&
        this.durableV2Journal?.lookupRunnerNotStarted(proofId)?.dispatchEffectId === effectId &&
        this.durableV2Journal?.hasEvent(eventId) === true
      // The core's verdict on a Codex start that failed before turn.started:
      // its notice is the recovery notice of this one receipt.
      const preStart = error?.code === 'AGENT_NOT_STARTED' && rt.v2PreStartNotice?.receiptId === receiptId
        ? rt.v2PreStartNotice : null
      rt.v2PreStartNotice = null
      if (provenNotStarted) {
        authority.close()
        if (preStart) this.durableV2RecoveryNotes?.set(receiptId, preStart.notice)
        try { await authority.open() }
        finally { if (preStart) this.durableV2RecoveryNotes?.delete(receiptId) }
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
        if ((error.code === 'AGENT_THREAD_REJECTED' || preStart?.resetSession === true) && this.store.getSession(chatId)) {
          let locked = false
          try { locked = this.durableV2AssertWriterLock?.() === true } catch {}
          if (!locked) {
            authority.close()
            throw new Error('C2 v2 rejected-session reset lost single-writer lock')
          }
          this.store.resetSessionAndStats(chatId)
          this.log(`group ${chatId}: Codex ${preStart ? 'could not resume' : 'rejected'} the saved session before any turn; the next message starts a new session`)
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
        redactText: text => this._failureNoticeText(chatId, redact(quotaFailure
          ? T.quotaFailure
          : text, { pii: job.group?.redactPii !== false }), !!(quotaFailure || closedFailure)),
        sendPlainReply: typeof job.platform.replyOnce === 'function'
          ? (target, text) => job.platform.replyOnce(target.replyCtx, text)
          : null })
      const suppressCard = (payload.quiet || projected.display.silent) &&
        projected.display.assistantEvents === 0 && updates.length === 0
      if (!preopened) await path.open({ suppressCard })
      for (const text of updates) path.update(text)
      const footer = this._texts(chatId).cardFooter({ ms: Math.max(0, Date.now() - rt.v2StartedAt),
        tokens: rt.v2UsageDecision?.tokens || null })
      const footerDetail = job.platform.features?.cardQuota === true
        ? cardModelDetail(rt.v2CardModelInfo, rt.v2RunnerResult) : ''
      // Milestones from tool calls first, then the model's own `>> ` lines;
      // the card shows them in its "process" fold (display only).
      rt.v2CardQuotaFailure = !!quotaFailure
      rt.v2CardFailureNotice = !!(quotaFailure || closedFailure)
      const redactMilestone = value => redact(value, { pii: job.group?.redactPii !== false })
      const milestones = [...(rt.v2AutoMilestones || []),
        ...progress.milestonesOf(payload.bufferText)]
        .filter((m, i, a) => a.indexOf(m) === i).map(redactMilestone)
        .filter(m => typeof m === 'string' && m.trim())
      this._observeActivity('sending', { chatId, receiptId })
      const completed = await path.complete({ payload, replyText, paused,
        footer, footerDetail, milestones })
      const groupReply = this._failureNoticeText(chatId, redact(quotaFailure ? T.quotaFailure : replyText || '', { pii: job.group?.redactPii !== false }),
        !!(quotaFailure || closedFailure))
      const finishStatus = quotaFailure || closedFailure ? 'error' : payload.quiet || projected.display.silent ? 'silent' : 'answered'
      // The group-visible text of a delivered answer, in memory only: a
      // successful idle compaction hands it to the next turn.
      rt.v2LastReply = finishStatus === 'answered' ? groupReply : ''
      this._observeActivity('finish', { chatId, receiptId,
        status: finishStatus,
        reply: groupReply,
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
      rt.v2CardFailureNotice = false
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
    const wecomTools = group.platform === 'wecom' && !!this.wecomSocket
    const groupTools = wecomTools || group.platform === 'feishu' && manifestFeatures(platform.features || {}).skills
    const info = group.repo && this.repoInfo ? this.repoInfo(group.workdir, group.repo) : null
    // The conversation as its adapter names it (a Slack direct message is not a group).
    const conversation = platform.conversationOf?.(msg.chatId) || null
    const named = conversation ? { chatNoun: conversation.noun, chatHere: conversation.here } : {}
    // Idle compaction later words its note for this conversation too.
    if (rt && conversation?.noun) rt.v2ChatNoun = conversation.noun
    const manifest = [
      ...manifestHeader({ restrictedV2: true, brand, chatLabel: conversation?.label || platform.chatLabel || '项目群', ...named,
        chatId: msg.chatId, groupName: group.name || msg.chatId,
        workdir: group.workdir, repo: group.repo || '', repoState: info?.state || '',
        repoOrigin: info?.origin || '未知', pushDenied: policy.pushDenied,
        providerName, model: this._brain(group, providerName, provider).model,
        runtimeVersion: this.durableV2Version || '', runtimeCommand: runtimeCommand(),
        noVision: provider.vision === false, platformName: platform.chatLabel || '项目群',
        permissionTier: policy.tier, tz: this.tz, publicUrl: '', uiUrl: '', lanUrl: '' }),
      // An English conversation also asks the model to answer members in
      // English (the core words that line; without the field nothing changes).
      ...manifestContext({ restrictedV2: true, brand, isCodex: provider.runner === 'codex', ...named,
        ...(this._chatLang(msg.chatId) === 'en' ? { replyLang: 'en' } : {}),
        groupCommands: GROUP_COMMANDS, groupTools, wecomTools,
        ...(platform.commandPrefix ? { commandPrefix: platform.commandPrefix } : {}),
        ...(!groupTools && platform.features?.mediaMarker === 'path' ? { mediaByPath: true } : {}),
        consoleEnabled: this.durableV2ConsoleEnabled === true,
        pmem: this.projectMemory ? this.projectMemory(group.workdir,
          { full: policy.full, isCodex: provider.runner === 'codex' }) : null,
        unredactedPii: group.redactPii === false,
        cardPinned: platform.features?.cardPinned === true, plainSend: false }),
      ...(groupTools ? releaseSkillLines(platform, named) : []),
    ].join('\n')
    // Reinject current supported context each turn. No legacy feature menu,
    // external-message commands or v1 manifest refresh scheduler is included.
    const interrupted = this._interruptNote(msg.chatId, rt)
    return turnPrompt({ lines: batch?.length > 1 ? batch.map(line) : [line(msg)],
      cancelled: null, compacted: rt?.v2Compacted === true, manifest, updated: false,
      ...(interrupted ? { interrupted } : {}),
      ...this._handbackReply(rt, msg.chatId, group, providerName, provider) })
  }

  // Rule 2 (ABI 40): the session of a crash-interrupted turn is kept; its next
  // turn carries the core's sentence (turn_prompt) until a runner accepts that
  // turn. The fact lives with the group's session state (StateStore); it
  // counts only while the journal has its crashInterrupt event and the session
  // is the one it was written for, otherwise it is dropped unused.
  _interruptNote(chatId, rt) {
    const fact = this.store?.getInterrupted?.(chatId)
    if (!fact) return null
    const valid = /^[0-9a-f]{32}$/.test(fact.receiptId || '') && /^[0-9a-f]{32}$/.test(fact.generation || '') &&
      Number.isSafeInteger(fact.turnToken) && fact.turnToken > 0 &&
      (fact.sessionId || null) === (this.store.getSession(chatId) || null) &&
      this.durableV2Journal?.hasEvent(`sbot-c2-crash-interrupt-v1:${fact.receiptId}:${fact.turnToken}:${fact.generation}`) === true
    if (!valid) {
      try { this.store.clearInterrupted(chatId) } catch (error) { this.log(`group ${chatId}: interrupted note not cleared: ${error.message}`) }
      return null
    }
    if (rt) rt.v2InterruptNote = fact
    return { lang: this._chatLang(chatId), text: typeof fact.text === 'string' && fact.text ? fact.text : null }
  }

  // Once a runner accepted the turn that carried the sentence it is used up.
  // A failed write keeps it for the next turn rather than losing it.
  _consumeInterruptNote(chatId, rt) {
    const fact = rt?.v2InterruptNote
    if (!fact) return
    rt.v2InterruptNote = null
    try {
      if (this.store.getInterrupted?.(chatId)?.receiptId === fact.receiptId) this.store.clearInterrupted(chatId)
      this.log(`group ${chatId}: the turn after the crash-interrupted one carried its note`)
    } catch (error) { this.log(`group ${chatId}: interrupted note not cleared: ${error.message}`) }
  }

  // The reply kept by a successful idle compaction, for the session, backend
  // and model it was compacted on. Anything else (a new conversation, another
  // backend or model) gets no field at all, so the prompt input is unchanged.
  // The core decides whether and how the text is rendered (turn_prompt).
  _handbackReply(rt, chatId, group, providerName, provider) {
    const held = rt?.v2HandbackReply
    if (!held || !held.text || held.sid !== (this.store.getSession(chatId) || null) ||
        held.provider !== providerName ||
        held.model !== (this._brain(group, providerName, provider).model || '')) return {}
    return { deliveredReply: held.text }
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
        now: Date.now(), ...(rt.v2ChatNoun ? { chatNoun: rt.v2ChatNoun } : {}) })
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
    const rec = { controller, sid, provider: name, model: brain.model || '', boundary: null, startedAt: Date.now(), why: '', lateKill: null, exited: null, skip: false, closed: false }
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
      // 摘要常把已经发出的回复写成「还没回」、编号清单丢项:上一轮发进群的原文留给下一轮(只在内存,重启即丢)。
      rt.v2HandbackReply = rt.v2LastReply
        ? { sid: rec.sid, provider: rec.provider, model: rec.model, text: rt.v2LastReply } : null
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

module.exports = { releaseBinDir, Engine, brainLabel, turnBrain, cardModelInfo, cardModelDetail, texts: T, textsEn: T_EN, textsFor,
  wordsOf, fmtWan, humanDuration, cardDuration, projectName }
