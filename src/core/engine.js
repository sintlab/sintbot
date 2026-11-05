// Engine — the dumb, deterministic orchestration core (DESIGN §3).
//
// Platform-agnostic: it talks only to the Platform + AgentRunner contracts
// (see interfaces.js), never to "feishu"/"claudecode" by name. Responsibilities:
//   - dedup (msgId) + drop-if-older-than-startup + monotonic per-group watermark
//     (重投防护三件套只作用于平台投递的消息;合成消息整体绕开 —— 见 handleMessage)
//   - group → project routing (one project per group)
//   - per-GROUP session (--resume) + per-GROUP execution lock + queue
//   - slash commands (/model /new /stop /status /help) handled inline
//   - sender tagging for shared multi-user threads
//   - NO_REPLY: the model decides silence; core just detects the token
//
// Concurrency model: one active turn per group (shared workdir ⇒ no concurrent
// turns that would stomp files/git). Busy ⇒ queue, never inject mid-turn.

const { redact } = require('./redact')
const { fmtStamp, normalizeTz } = require('./time')
const { parseResetAt } = require('./quotaerr') // 额度用尽原话里的「几点重置」(切备用模型后到点切回的依据)
const { humanReset } = require('./quotaalert') // 「约 2 小时后」—— 与额度告警同一份措辞
// 额度自动切换(v0.11.107):主模型的某个额度窗口已用 ≥ 这个百分比,就在下一轮开始前切到备用模型,
// 不等它真撞上限(撞上限那一轮已经失败、群里已经出错)。与额度告警的 90/95 同族,写死不给旋钮。
const QUOTA_FAILOVER_AT = 95
// 账号类切换(没有重置时刻)之后,多久探一次主模型恢复了没;额度类到点切回,探针只是校验
const FAILOVER_PROBE_MS = 30 * 60_000

const NO_REPLY = 'NO_REPLY'
const DEDUP_WINDOW_MS = 60_000

// Injected every turn via --append-system-prompt:
// teaches the model the shared-group context (timestamped sender tags) and the
// NO_REPLY silence token. ASCII-only on purpose — it travels as an argv element, and on
// Windows the npm claude.cmd shim runs through cmd.exe (see agent/claudecode.js).
// 回复体裁与排版的唯一出处(v0.11.11 重写)。此前只管排版、不管**说多少** ⇒ 群里真机取证:
// 一个「3325 是什么口径」的问题,答案约 200 字,群里实收约 1500 字(预告 + 4 段过程播报 +
// 答案 + 重复的答案)。所以「简」这一层必须写进规范,且要具体到可判断 —— 「不要啰嗦」是形容词,
// 「不要预告你即将做的事」才是能照做的规则。排版符号一并钉死:此前 · / • / 1⃣ 三套混用。
const SYSTEM_APPENDIX =
  'You are replying inside a group chat shared by multiple users; each user message is prefixed ' +
  'with a [time sender] tag: when it was sent (in the configured timezone) and who wrote it - ' +
  'do not prefix your own replies with such a tag. Treat the latest tag as the current time, and ' +
  'use that same timezone for any time or date you mention. ' +
  // ── 简 ──────────────────────────────────────────────────────────────
  'Lead with the answer and stop early. The group reads your reply, not your reasoning: open with ' +
  'the conclusion or the finding, then add only detail that changes what someone would do next. ' +
  'Do NOT announce work you are about to do ("let me check that", "I will get back to you", ' +
  '"coming right up") - a receipt is posted automatically, so an announcement is pure noise. ' +
  'Do NOT narrate method, tooling, how many ways you cross-checked, or that a check came back ' +
  'clean; state evidence in one clause only when a number needs backing. Do NOT apologise, ' +
  'reassure, or comment on your own performance ("my mistake", "false alarm", "rest assured"). ' +
  'Never talk ABOUT someone who is in the room - if they asked, answer them directly rather than ' +
  'reporting that you have replied to them. Land the substance in roughly 200 characters; if it ' +
  'genuinely needs more, put the extra in a list rather than more prose. ' +
  // ── 进度(v0.11.93)──────────────────────────────────────────────────
  // 上面「不预告 · 不复述过程」把长任务压成了一言不发(2026-09-11 某项目真机:51 分钟 138 次工具,
  // 卡上只有心跳数字,群里两次问「怎么不更新」)。这条开的口子只给**已完成的阶段**:一行 `>> ` 起头,
  // 引擎认它 —— 跑的时候显示成「▶ …」,收尾收进折叠区;其它中途文本仍然只流不留(v0.11.11)。
  // ⚠ 产品决定:进度汇报要精简高效 —— 一行几个字,只说做成了什么,不解释怎么做的。
  'Progress: on a task that takes several steps, each time you COMPLETE a stage (a feature done, ' +
  'a check passed, a file delivered), output one line starting with ">> " naming what was just ' +
  'completed in a few words - no explanation, no plans or intentions, at most 12 such lines per ' +
  'turn. Those lines stay visible in the card while you keep working and are kept when you ' +
  'finish; nothing else you say mid-way is kept, so do not narrate. ' +
  // 显示顺序 != 执行顺序(2026-08-06 真机:卡片写「预览码已发上面」,而二维码在卡片下方)。
  // 卡片的位置钉死在本轮开始的时刻,轮次中途发的图/文件必然排在它下面 —— agent 按自己的
  // 执行顺序推理就会说反。这条每轮注入,比放清单里(仅首轮/变更时注入)更不容易被淡忘。
  'Positioning: your reply is delivered as a card whose position in the chat is fixed at the ' +
  'moment this turn STARTED. Any image, file or message you post during the turn therefore appears ' +
  'BELOW that card, even though you sent it earlier than you wrote this text. So never point ' +
  '"above" at something you posted this turn - say "below" or simply "sent to the group". ' +
  // ── 排版 ────────────────────────────────────────────────────────────
  'Format replies for a chat, not a document: put a blank line between paragraphs, keep each ' +
  'paragraph short, and use a list whenever you report multiple items, steps, or per-item ' +
  'results - never send one dense wall of text. Markdown renders here; style guide: never use ' +
  // ⚠ 这整个字符串必须 ASCII-only(Windows 上作为 argv 过 cmd.exe,单测钉着这条不变量)——
  // 所以符号只能用码点名描述,不能直接写 · 或 •。实际符号示例放在清单里(那条走 stdin,UTF-8 安全)。
  '# heading lines - open a section with a short bold line instead; open unordered items with a ' +
  'middle dot (U+00B7) followed by a space, and use "1. 2. 3." when order matters - never open ' +
  'items with the bullet character U+2022 or with keycap-number emoji; ' +
  'reserve emoji for a single leading status mark and never sprinkle them through prose; use a ' +
  'markdown table only for genuinely tabular data, keep only informative columns and do not ' +
  // ⚠ 这句必须跟着实现走(v0.11.11 换过):可复制版不再另发一条消息,而是作为**卡片内默认收起
  // 的折叠区**自动挂上。说法不改的话,agent 会以为群里会多出一条,进而自己动手重复表格。
  'shorten long cells yourself (they truncate with tap-to-expand), and never repeat the table in ' +
  'another form - a collapsible copyable version is attached to your reply automatically; nest lists at ' +
  'most one level deep; use code fences only for real code, commands or log output, never for ' +
  'emphasis; use --- dividers sparingly. ' +
  'If the latest message needs no reply from you (users talking to each other, or nothing actionable), ' +
  `output exactly ${NO_REPLY} and nothing else.`

// Tiny async semaphore for the global concurrency cap (max<=0 ⇒ unlimited).
// On release the slot is handed straight to the next waiter, so `cur` (slots in
// use) only drops when nobody is queued — keeping the count consistent.
// acquire(signal) is abortable (FR7.2): /stop while waiting cancels the wait
// instead of letting the turn spawn later just to be killed.
// reserve(两车道,v0.11.115):低优先级的轮次(轮询来的不 @ 消息)按「软上限 max - reserve」拿槽,
// 给 @ 消息留一个坑 —— 否则五个群的闲聊能把五个槽占满,真人 @ 只能等。max ≤ 1 时没有坑可留,reserve 视为 0。
// release 把槽直接交给**第一个够得着的**等待者:一个 reserve=1 的等待者在只剩最后一个槽时不接,让给后面 reserve=0 的。
class Semaphore {
  constructor(max) { this.max = max > 0 ? max : 0; this.cur = 0; this.waiters = [] }
  _cap(reserve) { return this.max > 1 && reserve > 0 ? this.max - Math.min(reserve, this.max - 1) : this.max }
  wouldBlock(reserve = 0) { return this.max > 0 && this.cur >= this._cap(reserve) }
  // onWait(waiter):调用方可留住等待者对象,之后改它的 reserve(同群来了 @ 时把等槽的轮询轮次就地提升,见 _dispatch)
  async acquire(signal, reserve = 0, onWait = null) {
    if (!this.max) return
    if (this.cur < this._cap(reserve)) { this.cur++; return }
    return new Promise((resolve, reject) => {
      const waiter = { reserve, fn: () => { if (signal) signal.removeEventListener('abort', onAbort); resolve() } }
      if (onWait) onWait(waiter)
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error('aborted while waiting for a concurrency slot'))
      }
      this.waiters.push(waiter)
      if (signal) {
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
  release() {
    if (!this.max) return
    // 交接后占用数不变(cur 不减):等待者要能在 cur-1 的基础上进得了自己的软上限
    const i = this.waiters.findIndex((w) => this.cur - 1 < this._cap(w.reserve))
    if (i >= 0) { const [next] = this.waiters.splice(i, 1); next.fn() }
    else if (this.cur > 0) this.cur--
  }
}

// 群内系统文案:集中一处、默认中文,slash 命令名保持英文。
// core 逻辑里不散落字符串 — 要换语言/措辞只改这张表。
// token 数的群内显示:整数 + 中文单位,不写 400000 这种一眼数不清的裸数。
function fmtWan(n) {
  n = Number(n) || 0
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}万`
  return String(n)
}

// 时长说人话(/status 用):群成员要的是「久不久」,不是精确秒数。
// ⚠ 不做「刚刚」这类模糊词 —— 「它还在动吗」正是要靠这个数判断,含糊了就白给。
function humanDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`
}
// 卡片底部那行的耗时:比 humanDur 细一档(到秒)—— 那行是「这一轮花了多少」的账,与控制台详情的
// 「159.2s」同一量级;humanDur 服务的是「已跑多久」的脉搏,分钟粒度够用。
function fmtDurFine(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分钟`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`
}
// 与控制台 fmtTok 同一写法(≥1000 用 k、一位小数):群里与控制台看到的数字要对得上
function fmtTok(n) { n = +n || 0; return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n) }

// ⚠ 这张表里的每一条都经 platform.reply 发出,而 reply 发的是 **msg_type:'text' 纯文本消息**
// —— markdown 一律不渲染(`**粗体**` 会原样显示成星号)。层次只能用【】与「· 」,不能用 # 或 **。
// 卡片(agent 正文输出)才渲染 markdown,两层规矩不同,别互相照搬。
// 句首状态符统一为 8 个:⏳ 进行中 · ✅ 完成 · ⚠ 提醒 · ❌ 失败 · ⏸ 暂停 · ▶ 恢复 · 🔄 变更 · ⏰ 定时任务。
const T = {
  notBound: '⚠ 此会话还没有绑定项目 — 请管理员在控制台「群·项目」页绑定(本提示只发一次)',
  internalError: (m) => `❌ 内部错误:${m}`,
  queued: (n) => n > 1 ? `⏳ 已排队 — 当前任务结束后与前面 ${n - 1} 条一并处理` : '⏳ 已排队 — 当前任务结束后处理',
  queuedGlobal: '⏳ 已排队 — 当前有其它任务在跑(/stop 可取消)',
  // 定时任务的排队提示(2026-09-16 产品决定改措辞):此前与真人消息共用「⏳ 已排队」。真人那句是挂在
  // 他自己那条消息下面的回复,看得出在回应谁;而合成消息没有平台 message_id,只能独立发一条 ⇒ 群里
  // 凭空多出一句没头没尾的排队。生产机账本 44 天里 65 次,其中 56 次任务最后静默收尾,那句排队后面永远
  // 没有下文。现在说清它是定时任务、会自己跑,不用谁来管;句首 ⏰ 与真人消息的 ⏳ 区分开。
  // ⚠ 不点名是哪条任务(产品决定「统一都不用名字」):任务没有名字字段,从正文推出来的一半不像名字
  //   (「跑 python3 tools/x.py 把…」),点了还不如不点。
  queuedCron: (n) => `⏰ 定时任务已排队 — 当前任务结束后自动运行${n > 1 ? `(与前面 ${n - 1} 条一并处理)` : ''}`,
  queuedGlobalCron: '⏰ 定时任务已排队 — 当前有其它任务在跑,结束后自动运行',
  // 卡片右下角一行小字(2026-09-16 用户提):耗时与 tokens,放在「过程」折叠区之下、整卡最底、右对齐。
  // 口径与控制台「实时活动」详情底部一致:↑ = 输入侧总量(含缓存读 / 写),↓ = 输出;数字格式同 fmtTok。
  // ⚠ 缓存读 / 写的拆分**故意不上卡**:那是给 operator 看成本结构的,群成员要的是一眼的量;右下角一行
  //   在手机上只放得下这么多,拆分留在控制台详情里。没有用量(runner 没报 / 被中止)就只有耗时。
  cardFooter: ({ ms, tokens }) => {
    const parts = []
    if (Number.isFinite(ms)) parts.push(`耗时 ${fmtDurFine(ms)}`)
    if (tokens && ((tokens.in || 0) + (tokens.out || 0) + (tokens.cr || 0) + (tokens.cw || 0)) > 0) {
      parts.push(`tokens ↑${fmtTok((tokens.in || 0) + (tokens.cr || 0) + (tokens.cw || 0))} ↓${fmtTok(tokens.out || 0)}`)
    }
    return parts.join(' · ')
  },
  recalledStopped: '消息已撤回,已停止处理',
  noActiveTask: '没有正在运行的任务',
  stopped: '已停止',
  // ⚠ 丢了几条必须说出来:群成员发过的消息被清掉了,不告诉他就是让他等一个永远不来的回应。
  stoppedWithQueue: (n) => `已停止 — 连同排队的 ${n} 条一并取消`,
  skipped: (n) => n > 0 ? `已跳过当前任务 — 接着做排队的 ${n} 条` : '已跳过当前任务(后面没有排队的了)',
  freshSession: '✅ 已开启新会话',
  interrupted: '✅ 已中断当前任务,并开启新会话',
  // 群内切模型(v0.11.60,产品决定「全员可切」)。此前是只读的,理由是「模型 = 花钱 + 能力 +
  // 吃谁的额度,该由控制台当唯一写入方」。⚠ 真机推翻了它:codex 容量满时群里原样透传「请换个
  // 模型」,**而切模型只有 operator 做得到 —— 等于指引用户去做他做不到的事**。
  // ⚠ 「唯一写入方」这条约束没作废,只是换了兑现方式:群内切走的是**与控制台同一套写入动作**
  //   (配置落盘 + 运行时覆盖 + 清会话一起做),不是新开一条写法。
  // `current`/`list` 都是预格式化的「模型名 · 型号」,免得把名字与型号混为一谈。
  // 没有注入写入器只发生在 CLI 试跑(sintbot chat;守护进程总会注入):如实说这里切不了、群里能切,
  // 别给一条按了没反应的指令,也别说成「群内不支持」(1.0.9 及以前那样说,读起来像群里也切不了)。
  modelInfo: (current, list, canSwitch) => `【当前模型】${current}\n【可用】${list}\n` + (canSwitch
    ? '换模型:发「/model 名字」,例如 /model volcano\n⚠ 换完是**新的一段对话**,之前聊的内容不再带着'
    : '这里是终端试跑,不能切换 —— 换模型用 sintbot chat --provider 名字;在群里发「/model 名字」就能切'),
  modelUnknown: (want, names) => `⚠ 没有「${want}」这个模型\n【可用】${names}\n发「/model 名字」换,名字要一模一样`,
  modelSame: (current) => `本群已经在用 ${current},没有变化`,
  // ⚠ 忙的时候不切:换模型要清会话,而当前这轮正靠它跑;悄悄换掉等于把人手头的活废了。
  modelBusy: '⚠ 手头还有任务在跑,现在换会把它打断 —— 等它跑完再换,或先发 /stop',
  modelSwitched: (current, note) => `✅ 已切到 ${current}\n⚠ 新的一段对话从这里开始,之前聊的内容不再带着` + (note ? ` —— ${note}` : ''),
  // ⚠ **不回显原始报错** —— 写入器抛的可能是 fs 错误,原文里带着机器上的配置文件绝对路径
  //   (`ENOENT … open '/Users/…/sbot.config.json'`),那就把机器布局发进群了(用户面零工具名)。
  //   群里只说「谁该去做什么」,详情打进日志给 operator。
  modelSwitchFailed: '⚠ 没换成 — 请管理员到控制台看一下',
  // ⚠ 零工具名(2026-08-06 补漏):这三条原文暴露 baseUrl/apiKey/环境变量/daemon/`sbot start`
  // —— 全是实现细节,而它们恰恰发给群成员看。群里只说「谁该去做什么」。
  modelNoKey: (name) => `⚠ 模型「${name}」还差密钥没配 — 请管理员到控制台补上`,
  quotaUnavailable: '⚠ 额度查询需要后台服务在运行',
  quotaShow: (name, u) => `${name} 额度:${u}`,
  // ⚠ 这两句必须分家:「不支持」是结构性事实(这个模型根本没有额度接口,别再问了),
  // 「没查到」是这一次没成功(接口超时/限流,过会儿再问就有)。此前两种情况共用上面那句
  // 「不支持」—— 于是每次接口抖动,群里都被告知一件不存在的事,而且劝人别再试。
  quotaNone: (name) => `模型「${name}」不支持查额度`,
  quotaMiss: (name) => `${name} 额度暂时没查到,稍后再试`,
  // 压缩发生时的群通知(v0.11.19):群成员该知道「它可能忘了很久以前的细节」。一行,不解释机制;
  // 有具体量就报(压缩前上下文),没有(极早期压缩、数据缺失)退无数字版。
  // 阈值一并报(产品决定:控制台设置里那个数,群里该看得见它起了作用);关着(0)就不提。
  // ⚠ 写「阈值 40万」不写「超过阈值」:轮首压缩报的是上一轮收尾的上下文,可能 39.8万 < 40万
  //   (新消息 + 重注入的清单一进才超),说「超过」会自相矛盾。
  // ctx 优先取 runner 从压缩事件透传的 preTokens(v0.11.93):此前拿上一条 assistant 的 usage 顶替,
  // 而工具结果(读进来的文件)还没进任何 usage,真机少报 5 倍(报 3.6 万,实际 18.8 万)。有压缩后的量就一并报。
  compacted: (ctx, limit = 0, post = 0) => {
    const facts = [
      ctx > 0 ? `此前上下文约 ${fmtWan(ctx)} token${post > 0 ? ` → 压缩后约 ${fmtWan(post)}` : ''}` : '',
      limit > 0 ? `阈值 ${fmtWan(limit)}` : '',
    ].filter(Boolean).join(' · ')
    return `🔄 会话已自动压缩${facts ? `(${facts})` : ''}:久远内容折叠为摘要,近期上下文保留`
  },
  // 压缩通知附带的会话用量行:轮数 + 累计处理量(与 /hud 会话行的「累计处理约」同口径 = 输入侧总量,
  // 含缓存)。**不报上下文大小** —— 那是压缩前的数,首句已经说了,再报一遍还会被读成压缩后的。
  sessionUsage: (turns, inTotal) => `【会话】第 ${turns} 轮 · 累计处理约 ${fmtWan(inTotal)} token`,
  // /hud 会话行(v0.11.17):让「会话滚了多大」第一次可见。ctx = 当前上下文(有些模型不报,
  // 退累计输入量);limit>0 时点破自动压缩的存在 —— 群成员不用自己记着 /new。
  sessionLine: (turns, ctx, inTotal, limit) => {
    const size = ctx ? `上下文约 ${fmtWan(ctx)} token` : `累计处理约 ${fmtWan(inTotal)} token`
    return `【会话】第 ${turns} 轮 · ${size}` + (limit > 0 ? `(超 ${fmtWan(limit)} 会自动压缩久远内容)` : '')
  },
  providerNotConfigured: (name) => `⚠ 模型「${name}」未配置`,
  unknownCommand: (cmd) => `⚠ 未知命令 ${cmd}(试试 /help)`,
  errorPrefix: '❌ 出错:',
  // 瞬时错(服务端过载 / 限流)的下一步:提问已在会话历史里,再来一句就接着做 —— 这是事实不是安慰。
  // ⚠ 不说「换个模型」:那是服务端给 ChatGPT 用户的建议,群里 /model 会清会话,照做反而更糟。
  transientHint: '你刚才那条我记着,过一会儿发一句「继续」就接着做',
  failedPrefix: '❌ 执行失败:',
  noOutput: '(无输出)',
  // 迟迟没动静时先回一声(v0.11.10):填进本来就要建的那张流式卡,答案到了原地替换 ——
  // 不多发消息。文案过零工具名,且不说「马上/很快」这类无法兑现的承诺。
  ackWorking: '⏳ 已收到,正在处理…',
  // ack 之后该轮却以静默收场:优先撤回整张卡(保住「静默轮群里无痕」),撤不掉才退这句中性收尾。
  ackDropped: '_(已处理)_',
  // 长任务的「活着」信号。⚠ 只在卡里滚动,不另发消息 —— 群里多一条就是一次刷屏。
  // ⭐ 三个数各答一个问题:已跑 = 等了多久 · 已执行 N 步 = **在不在推进**(两次之间 31→47 就是
  //    证据,只看时间是看不出的)· 最近动静 = 还活着没。字段顺序与 /status 保持一致。
  // v0.11.95 瘦成一行(产品决定「精简高效」):有了「最近在做」,「已执行 N 步」就是重复的(都在说「在推进」);
  // 「最近动静」只在**停滞**时才有信息量 ⇒ 超过 cardPulseStaleMs(默认 2 分钟)没动静才追加。
  // 完整数字(步数 · 最近动静)仍在 /status —— 那是人主动问的。还没调过任何工具时退回「处理中 · 已跑」。
  pulse: (ran, doing, stale) => (doing && doing.length ? `⏳ 已跑 ${ran} · ${T.pulseDoing(doing)}` : `⏳ 处理中 · 已跑 ${ran}`) + (stale ? ` · 最近动静 ${stale}前` : ''),
  // 「最近在做」(v0.11.93):由工具调用**确定性**推出(describeTool),模型一个字不说也有东西看。
  // 脉搏与 /status 共用。只给文件名不给路径、不给命令内容 —— 群面零机器路径。
  pulseDoing: (list) => `最近在做:${list.join(' · ')}`,
  // 空轮重试仍空(见 finalizeTurn 的 nothingProduced):这句取代旧的「(无输出)」——
  // 后者对群成员零信息量,看不出「要不要再说一遍」。不解释原因(群里不谈机器内部),
  // 只给下一步动作。第一次空轮不出这句:那一轮会静默重试,成功了群里就像什么都没发生。
  emptyTurn: '这条我没处理成功(已自动重试过)— 麻烦再发一次',
  // 空轮换会话重做(v0.11.103,_retryEmpty):会话接不上了(上一轮被掐断 / 续接连空),自动开新会话把这条
  // 重做。丢的是聊天上下文,得让群成员知道;交接句与 /model 切换那句同一口径 —— 长期约定与积累在磁盘上。
  freshRetry: '🔄 上一段对话接不上了,已自动开新会话重做这条 —— 之前聊的内容不再带着,本项目的长期约定与积累都还在',
  // 续接的会话记录已经不在了(_retrySessionGone):同样换新会话重做,原因不同 —— 是记录过期被清掉,不是被掐断
  sessionGone: '🔄 上一段对话的记录已过期清理,已自动开新会话重做这条 —— 之前聊的内容不再带着,本项目的长期约定与积累都还在',
  // 额度自动切换(v0.11.107)。模型名(claude / codex)群里本来就看得见(/model 列的就是它们),不算工具名。
  // 「新的一段对话从这里开始」与 /model 那句同口径:换的是另一套后端,会话必然重开,群成员得知道。
  failoverWhy: (kind, window) => (kind === 'account' ? '本群模型的账号暂时不可用' : `本群模型的${T.quotaWindow(window)}额度用完了`),
  quotaWindow: (window) => (window === 'weekly' ? '一周' : window === 'session' ? '5 小时' : ''),
  failoverSwitched: (why, to, back, redo) => `🔄 ${why},已自动切到 ${to}${back ? `(${back})` : ''}${redo ? ',刚才那条在新模型上重做' : ''}\n⚠ 新的一段对话从这里开始,之前聊的内容不再带着 —— 本项目的长期约定与积累都还在`,
  failoverBackWhen: (home, when) => (when ? `原模型 ${home} ${when}重置,到点切回` : `原模型 ${home} 恢复后切回`),
  // 出错行上的额度 / 账号类人话(与 transient 同一位置):英文原话只进账本。没配备用时群里也该看得懂为什么失败
  quotaErr: (kind, when, window) => (kind === 'account' ? '本群模型的账号暂时不可用,需要管理员处理' : `本群模型的${T.quotaWindow(window)}额度用完了${when ? `,${when}重置` : ''}`),
  failoverBack: (home) => `🔄 原模型已恢复,本群切回 ${home}\n⚠ 新的一段对话从这里开始,之前聊的内容不再带着 —— 本项目的长期约定与积累都还在`,
  // 切过去了但这条没法在新模型上重做(它已经动过手:调过工具或产出过正文,重跑会把副作用做第二遍)
  failoverRedoHint: '你刚才那条做到一半断了,请再发一次',
  // 备用模型也没额度:不切,说清为什么只能等
  failoverNoTarget: (why, when) => `⚠ ${why}${when ? `,${when}重置` : ''};备用模型眼下也用不了,只能等`,
  // /status · /hud 共用的一行
  failoverLine: (to, home, kind, when) => `· 临时切换:因${kind === 'account' ? '账号' : '额度'}原因已切到 ${to},原模型 ${home} ${when ? `${when}重置,到点切回` : '恢复后切回'}`,
  // 群内反馈本(/issue)。⚠ 全过零工具名:不提命令名以外的实现、不提机器与文件 ——
  // 对群成员而言这就是「跟开发说一声」,存在哪儿、怎么汇总不是他们要知道的事。
  issueUsage: '用法:/issue 后面跟一句话,说清哪里不对劲\n例:/issue 刚才发的图它没理我',
  issueLogged: (id, withTurn) => `📝 已记下 #${id}` + (withTurn ? '(附上了刚才那一轮的运行记录)' : '') + ' — 处理完会在群里告诉你',
  issueUnavailable: '⚠ 反馈本暂时不可用,先在群里直接说吧',
  issueFailed: '⚠ 没记下来 — 麻烦再说一次,或直接在群里说',
}

// 表格可复制(v0.11.4 起):卡片里的表格在手机端无法选中复制,整卡转发也带不走表格内容
// (飞书平台限制,卡片 config 无「可复制」开关,2026-08-04 官方文档逐字段核对)。
// ⚠ 解法在 v0.11.11 换过一次:原本由 finalize **另发一条**伴随消息,群里嫌累赘(每个含表格的
// 回答都多一条,真机 14 小时 4 次、其中 2 次卡片内已有同样的表格)⇒ 现在收进卡片内一个默认
// 收起的折叠区,engine 这边一条消息都不发。实现见 `feishu.js copyPanel/answerCardElements`,
// 表格判定与清理见 `core/mdtable.js` 头注(与原生表格渲染共享同一套判定,两处各写会漂移)。

// 型号缺省时的群内显示(v0.11.1):订阅登录型 provider(claude 登录态 / codex,均无 baseUrl)
// 不指定型号是**推荐形态**(跟随 CLI 自己的默认,v0.11.0 拍板)⇒ 显示「默认」;第三方端点
// (有 baseUrl)缺 model 多半是漏配 ⇒ 保留「?」当信号。控制台同形态显示「跟随 Claude Code 默认」。
const modelLabel = (provider, groupModel) =>
  groupModel || (provider && provider.model) || (provider && provider.baseUrl ? '?' : '默认')

// 群内 /help(v0.11.3 按群拼,不再是静态常量):静态清单对做不到的群就是说谎 ——
// codex 只读群没有基础技能(沙箱无法联网/写),生图依赖机器有 codex;帮助里列了却做不到,
// 比不列更糟。另:首行此前写「sbot 命令:」= 用户面零工具名规则(2026-07-30 拍板)的漏网 ——
// v0.9.2 清了控制台与版本历史,偏偏漏了群成员最常看到的这一行。
// 生图桥可用性 —— **/help 与自知清单共用这一个判据**(v0.11.16 修):此前两处各写一份,
// codex 完全访问群正落在缺口里 —— 帮助里承诺了「生成图片」,清单却不注入生图桥说明(条件写的
// 是 !isCodex),于是 agent 根本不知道它存在,只能用自带生图(前台阻塞、不自动上板)。
// 生产 5 个群里 4 个是 codex ⇒ 那行帮助对四个群是假的。同一份策略两个消费者必漂移。
const canImagen = (isCodex, full, hasImagen) => !!hasImagen && (!isCodex || full)

// usageProbe 的返回归一(纯函数,单测钉死):正式形状是 `{ supported, value }`,但也收一个
// 裸串(老形状 / 试跑桩)。**抛错或裸 null 归到「不支持」** —— 那是没有任何信息的输入,
// 沿用老口径最保守;真要说「暂时没查到」得由探针明说 supported:true,免得凭空劝人重试。
const normalizeUsage = (r) => {
  if (typeof r === 'string' && r) return { supported: true, value: r }
  if (r && typeof r === 'object') return { supported: r.supported !== false, value: r.value || null }
  return { supported: false, value: null }
}

// ── 里程碑与「最近在做」(v0.11.93)─────────────────────────────────────────
// 长任务卡片只有心跳数字,根因是附言把中途说话压没了(2026-09-11 某项目:51 分钟 138 次工具,卡上
// 一个字的进展都没有)。开一个窄口子:模型每完成一个阶段输出一行 `>> …`,引擎认它 —— 跑的时候随
// 打字机进卡(显示成 ▶),收尾收进卡片折叠区,不再被 v0.11.11「只留最后一段」丢掉。
// 判据收在这里,不散在三处(打字机 / 脉搏 / 收尾):同一条正则三处各写一份必然漂移。
const MILESTONE_MAX = 12
const MILESTONE_RE = /^>>\s*(.*\S)\s*$/
// 逐行扫、跳过代码围栏 —— shell 的 `>> file` 与 Python 的 `>>>` 都可能出现在代码块里。
function scanMilestoneLines(text, onLine) {
  let fence = false
  for (const line of String(text || '').split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; onLine(line, null); continue }
    const m = fence ? null : MILESTONE_RE.exec(line)
    onLine(line, m ? m[1] : null)
  }
}
// 本轮全部里程碑(去重、封顶),从流式全量文本里取 —— 中途说的与收尾说的都算。
function milestonesOf(text) {
  const out = []
  scanMilestoneLines(text, (_l, m) => { if (m && !out.includes(m) && out.length < MILESTONE_MAX) out.push(m) })
  return out
}
// 打字机 / 脉搏用:`>> ` 原地换成 ▶(不换的话 markdown 会把 `>>` 渲染成嵌套引用)。
function renderMilestones(text) {
  const lines = []
  scanMilestoneLines(text, (l, m) => lines.push(m == null ? l : '▶ ' + m))
  return lines.join('\n')
}
// 收尾用:正文里的里程碑行剔掉(它们进折叠区),只剩答案。
function stripMilestones(text) {
  const lines = []
  scanMilestoneLines(text, (l, m) => { if (m == null) lines.push(l) })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
// 「最近在做」:一次工具调用 → 一句人话。只给文件名不给路径(群面零机器路径);命令内容不给
// (那是 agent 写的,可能带机器路径);插件按名字(与 /help 插件行同一口径);认不出的返回 null,
// 不拿框架里的工具名去凑数。codex 的工具名经 codexcode 映射后与 claude 同形(Bash / Write / MCP)。
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''
function describeTool(name, input = {}) {
  const n = String(name || '')
  const inp = input && typeof input === 'object' ? input : {}
  const file = baseName(inp.file_path || inp.path || inp.notebook_path)
  const withFile = (verb) => (file ? `${verb} ${file}` : `${verb}文件`)
  const mcp = /^mcp__(.+?)__/.exec(n)
  if (mcp) return `用插件 ${mcp[1]}`
  switch (n) {
    case 'Read': return withFile('看')
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return withFile('改')
    case 'Write': return withFile('写')
    case 'Delete': return withFile('删')
    case 'Bash': return '跑命令'
    case 'Glob': case 'Grep': case 'FileSearch': return '搜代码'
    case 'WebFetch': case 'WebSearch': return '查网页'
    case 'Task': case 'Agent': return '派子任务'
    case 'MCP': return `用插件${inp.server ? ' ' + baseName(inp.server) : ''}`
    default: return null
  }
}
// ── 确定性里程碑(2026-09-14)──────────────────────────────────────────────────────
// 另一台机器上一个真实群的取证:116 轮里模型只吐过 1 行 `>> `(claude-opus-5:附言 · 项目 CLAUDE.md 硬规则 ·
// CLI 自带的「你很久没说话」提醒三层都没用 —— thinking 与 tool_use 之间零文本)。「最近在做」只滚最近
// 3 条,回答的是「还活着吗」;这里回答「做到哪了」:从工具调用里只认**交付类**动作(写 / 改文件 · 发到群 ·
// 上画布 / 生图 / 预览 · git 提交推送 · 出 PDF),累积、去重、封顶,与模型自己的 `>> ` 行并排进卡、收尾同进折叠区。
// 只给文件名不给路径,临时目录里的脚本不算(那是它写给自己用的),命令内容不给 —— 群面零机器路径。
// 一次 Bash 只记最重的一条(`cat > x && … && send-file y` 记「已发文件 y」)。
const TMP_PATH_RE = /^(?:\/private)?\/tmp\/|^\/var\/folders\/|^\$TMPDIR|^%TEMP%|\\Temp\\/i
const unquote = (s) => String(s || '').trim().replace(/^(["'])(.*)\1$/, '$2')
const SH_ARG = '("[^"]+"|\'[^\']+\'|[^\\s;|&<>]+)'
function autoMilestone(name, input = {}) {
  const n = String(name || '')
  const inp = input && typeof input === 'object' ? input : {}
  // 路径里带 shell 变量(`$OUT`)或命令替换 ⇒ 名字解不出来,只报动作不报名(真机第一轮就出过「已出 PDF $OUT」)
  const fileMs = (verb, raw) => { const p = unquote(raw); const f = baseName(p); return f && !TMP_PATH_RE.test(p) && !/[$`]/.test(p) ? `${verb} ${f}` : null }
  const target = inp.file_path || inp.path || inp.notebook_path
  switch (n) {
    case 'Write': return fileMs('写了', target)
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return fileMs('改了', target)
    case 'Bash': break
    default: return null
  }
  const cmd = String(inp.command || '')
  const grab = (re) => { const m = re.exec(cmd); return m ? m[1] : '' }
  let a
  // 平台基础技能的命令名不写死(sbot feishu / sbot wecom …):里程碑只认动作名
  if ((a = grab(new RegExp('\\bsbot\\s+[a-z]+\\s+send-file\\s+' + SH_ARG)))) return fileMs('已发文件', a) || '已发文件到群'
  if ((a = grab(new RegExp('\\bsbot\\s+[a-z]+\\s+send-image\\s+' + SH_ARG)))) return fileMs('已发图片', a) || '已发图片到群'
  if (/\bsbot\s+[a-z]+\s+send-msg\b/.test(cmd)) return '已发消息到群'
  if (/\bsbot\s+feishu\s+board-add-(?:image|diagram|nodes)\b/.test(cmd)) return '已上画布'
  if (/\bsbot\s+imagen\s/.test(cmd) && /--out\b/.test(cmd)) return '已提交生图'
  if (/\bsbot\s+preview\s+start\b/.test(cmd)) return '已开预览'
  if (/\bgit\s+(?:-C\s+\S+\s+)?push\b/.test(cmd)) return '已推送远端'
  if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd)) return '已提交代码'
  if ((a = grab(new RegExp('--print-to-pdf=' + SH_ARG)))) return fileMs('已出 PDF', a) || '已出 PDF'
  if (/--print-to-pdf\b/.test(cmd)) return '已出 PDF'
  if ((a = grab(new RegExp('(?:^|[\\s;&|(])cat\\s*>{1,2}\\s*' + SH_ARG)))) return fileMs('写了', a)
  return null
}
// 最多留 3 条、去重、最新在最后(脉搏与 /status 共用同一个列表 rt.doing)。
function pushDoing(list, d) {
  if (!d) return list
  const i = list.indexOf(d)
  if (i >= 0) list.splice(i, 1)
  list.push(d)
  while (list.length > 3) list.shift()
  return list
}

function helpText(group, provider, hasImagen, caps = {}) {
  const canSwitchModel = !!caps.switchModel
  const isCodex = provider && provider.runner === 'codex'
  const full = group.permissionMode === 'bypassPermissions'
  const base = !isCodex || full // 基础技能可用性(画布/定时/预览/风格;codex 只读沙箱无法联网发送)
  const imagen = canImagen(isCodex, full, hasImagen)
  // ⚠ /help 走 reply() = 纯文本消息 ⇒ 不能用 markdown 做层次(`**标题**` 只会显示成星号),
  // 用【】起段、「· 」起条。也**不要用空格对齐命令名** —— 群消息是比例字体,对齐必然歪;
  // 用「— 」分隔命令与说明,窄屏折行也读得通。
  // ⭐ **精简的判据是「一条能不能一眼读完」,不是「能不能少列几条」** —— 帮助是着急时看的
  //   (卡住了、要叫停、要报问题),一条折成三行就等于没写。所以逐条压到一行内,
  //   并按**着急程度**排:先「它怎么了 / 怎么叫停」,再「查看」,最后「报问题」。
  // v0.11.82 重排(产品决定):开头两三行简介(绑的项目、模型、后台地址 —— 全是本群活数据,不写死),
  //   命令仍在能力之前(着急时要的是第一屏),设计五行并成三行,基础操作一行,新增「插件」一行。
  //   ⚠ 简介里的项目名只给目录名不给机器路径(零工具名);后台地址只给公网的(局域网 IP 出了局域网
  //   打不开、还要密码,写进群只会引来「打不开」),没配就整行不出现。
  //   ⚠ 插件行:接了的按本群名单报;没接的只说类别、不点软件名(产品决定):点了 Blender / Photoshop
  //     会被读成「已经能用」。名单最多列 3 个,超 62 字符就再减,保住「一行一眼读完」。
  const projectName = String(group.workdir || '').split(/[\\/]/).filter(Boolean).pop() || '(未绑定)'
  const modelText = (caps.providerName ? caps.providerName + ' · ' : '') + modelLabel(provider, group.model)
  const plugins = (Array.isArray(caps.plugins) ? caps.plugins : []).map((n) => String(n || '').trim()).filter(Boolean)
  const pluginLine = (n) => `· 插件:本群已接 ${plugins.slice(0, n).join(' · ')}${plugins.length > n ? ` 等 ${plugins.length} 个` : ''};要操控别的软件找管理员加`
  let pluginsLine = pluginLine(3)
  for (let n = 2; n >= 1 && pluginsLine.length > 62; n--) pluginsLine = pluginLine(n)
  const L = [
    '【这是什么】',
    `· 本群绑着项目「${projectName}」,模型 ${modelText}`,
    // 只读群不说「它就干」—— 那是说满了(它只能看代码答问题),末尾那行 ⚠ 会解释,简介先别许诺
    base ? '· 直接说事它就干,做完在群里回你;之前聊的都记得' : '· 直接问它,它看代码、答问题;之前聊的都记得',
  ]
  if (caps.publicUrl) L.push(`· 后台:${caps.publicUrl},管理员用飞书账号登录看进度与反馈`)
  L.push(
    '',
    '【命令】',
    // ⚠ /status 的说明按「群成员真正想知道的」写,不是按字段列表写:那天有人连敲 /status
    //   也没敢确定它是不是卡住了 —— 「还有没有动静」才是那个判据,必须摆在最前面。
    '· /status — 跑了多久、还有没有动静、排队几条' + (group.board && group.board.url ? '(含画布链接)' : ''),
    // ⚠ 三条「叫停」按**破坏性递增**排,且用**同一组词**描述同两维(排队的怎么办 · 记不记得
    //   之前)。由来:2026-08-21 有人要「停这个、让它继续后面的」,有人以为 /stop 会把队列一并停掉。
    '· /skip — 只放弃手头这件,排队的继续;之前聊的还记得',
    '· /stop — 手头和排队的全取消;之前聊的还记得',
    '· /new — 全取消,并忘掉之前聊的,从头开始',
    '· /model — 本群在用的模型' + (canSwitchModel ? ';换:/model 名字(换完之前聊的不再带着)' : '(终端试跑里不能切,换用 --provider)'),
    // 压缩那半句(v0.11.92):群里会冒出「🔄 会话已自动压缩 + 额度」这条通知,/help 里得有它的出处 ——
    //   否则第一次见到的人只会问「这是什么」;放在 /hud 这行,因为会话规模正是它管的。
    '· /hud — 额度与本会话用量;聊太长会自动压缩,群里会提示',
    '· /issue <一句话> — 报问题给开发,处理完在群里回你',
    '· /help — 这份说明',
    // ⚠ 命令是整条生效的:除 /issue 外都不看后面跟的字。不说这句,「/stop 然后帮我改成 X」的
    //   后半句就会凭空消失,人还在等一个永远不来的回应。
    // ⚠ 不能写成「· 命令请单独发一条 — …」——那和上面每条命令长得一模一样,会被当成又一个命令。
    //   用 ⚠ 起句把它和命令列表分开。
    '⚠ 命令单独发一条;除 /issue' + (canSwitchModel ? ' 与 /model' : '') + ' 外,后面跟的字不算数',
    // 撤回即停(DESIGN §4.5)一直在,但 /help 里从没说过 —— 群成员不知道「撤回」是个动作,只会再敲 /stop。
    //   ⚠ 边界照实写:已和别人的消息合成一轮在跑的那条,撤回不打断那轮(handleRecall 同款判据)。
    '⚠ 撤回自己发的消息 = 取消那件事(已和别人的合成一轮在做的除外)',
    '',
    '【直接说事就行】',
    '· 项目:改代码、跑构建测试、部署、查资料、整理文档',
  )
  if (base) {
    // 记忆(v0.11.59 跨模型记忆交接):机制在,群里却没人知道可以「让它记下来」—— 换模型 / /new 清的是
    //   对话,项目文件里记的规矩不清。只给完全访问的群:只读群写不了项目文件,列了就是说谎。
    L.push('· 记忆:说好的规矩、口径让它记进项目文件;换模型或 /new 也不丢')
    // 设计三行:画布(出图 + 板上改了会跟进)· 风格与图标(⭐ 仍写明「各选各的」—— 当初分两行是怕读成
    //   「挑风格顺带定了图标」,合成一行但把这四个字留住,意思不丢)· 生成图片按可用性单列(门控不同)。
    L.push('· 设计:「画一张…」出图上画布;画布上改了、标注了,它会跟进')
    L.push('· 风格与图标:各出一张对照图挑,各选各的;定了产出就按它')
  }
  if (imagen) L.push('· 生成图片:「生成一张…」后台跑,好了发群')
  if (base) {
    L.push('· 定时:「每天 9:00 …」一句话建,改 / 删 / 停也一句话')
    L.push('· 预览:网页原型开成局域网链接,手机电脑直接打开')
    // 基础操作一行:浏览器按群门控(chrome-devtools 插件),图片 / 文件自 v0.11.7 起恒可用 —— 有浏览器
    // 就把网址并进同一行,没有就只说文件,不列做不到的。
    L.push(caps.browser
      ? '· 网页与文件:发网址、图片、表格给它,说「看看 / 截图 / 分析」'
      : '· 文件:发图片、表格给它,说「看这张图 / 帮我分析」')
    // 插件行:接了什么按本群实际名单报(与 /model 列模型名同一口径,名字是管理员配的);没接就只说类别。
    L.push(plugins.length ? pluginsLine : '· 插件:接上插件就能操控对应软件(建模 / 设计 / 办公…),找管理员加')
  }
  if (!base) L.push('', '⚠ 本群为只读模式:能看代码、答问题;改动与画布 / 定时 / 预览需管理员放开权限')
  return L.join('\n')
}

// 清单重注入的轮数兜底。为什么要兜底:压缩事件只有 claude 报得出来,codex 原生压缩不上
// exec 输出流 ⇒ 那些群没有任何信号,只能按轮数定期重发。20 轮 × 一份几 KB 的清单,摊到每轮
// 一两百字符,相对一次压缩(几十万 token)可以忽略。
const MANIFEST_REINJECT_TURNS = 20

// 失败原因的组装:细分码在前(机器可读、能分类计数),人话在后(能读懂)。
// ⚠ **绝不能拿 `outcome.preview` 当原因** —— 它是 `finalText || buf`,而出错轮的 `result.text`
//   常常是空的(隔壁卡片路径为此写了三级兜底),于是会退回 `buf` = **模型崩掉之前流式吐的那段
//   正常回答**。那段话落进一个叫 `err` 的字段,查账本的人拿到的是一个**自信的错误答案** ——
//   比原来只有 `status:"error"` 更糟。故只收调用方明确交来的错误文本。
// ⚠ codex 侧的 subtype 恒为字面量 `'error'`(与 status 同义、零信息)⇒ 丢掉,别让每条 err
//   都以「error: 」开头白占字数;claude 侧才有 `error_max_turns` 这类真细分。
// ⚠ 走 redact:错误原文可能带密钥。**先截断再脱敏** —— redact 的邮箱模式在长串上是二次的
//   (实测 128KB 要 7.7s),而 UI 与 daemon 同进程,一次卡死就是全群停摆。
// ⚠ redact **不管机器上的绝对路径**(它只认密钥/PII)—— 而 `issue list --json` 是设计来跨机
//   汇总的,这份 err 会被带出去。知情接受:排查时路径正是最有用的线索之一。
const ERR_MAX = 400 // 200 太短:一条英文 API 报错大约就到 200,message 会被腰斩、位置全丢
function turnErrText(subtype, text) {
  const sub = String(subtype == null ? '' : subtype).trim()
  // 「error」与「success」两个细分码都不带进原因:前者是空信息,后者是 claude CLI 在 API 出错时的真实形状
  // (subtype success + is_error),写成「success: API Error: 529 …」查的人会以为两条矛盾
  const parts = [sub === 'error' || sub === 'success' ? '' : sub, String(text == null ? '' : text).trim()].filter(Boolean)
  if (!parts.length) return ''
  return redact(parts.join(': ').slice(0, ERR_MAX * 2)).replace(/\s+/g, ' ').trim().slice(0, ERR_MAX)
}

class Engine {
  /**
   * @param {object} cfg  loaded config (providers, defaultProvider, groups, agent)
   * @param {{runner, store, log?, defaultGroup?}} deps
   *   runner       — AgentRunner ({ runTurn })
   *   store        — StateStore
   *   defaultGroup — fallback { workdir, provider?, model? } for unmapped chatIds (dev/CLI)
   */
  constructor(cfg, { runner, store, log = () => {}, defaultGroup = null, onActivity = () => {}, ledger = null, usageProbe = null, quotaStatus = null, uiUrl = null, uiLocalUrl = null, repoInfo = null, codexMcp = null, hasImagen = null, projectMcp = null, styleDocs = null, projectMemory = null, setProvider = null, issues = null, version = '', onAlert = null, verifyTurn = null } = {}) {
    this.cfg = cfg
    this.runner = runner
    this.store = store
    this.log = log
    this.defaultGroup = defaultGroup
    this.uiUrl = uiUrl // console address to advertise in the agent's self-knowledge manifest (群项目基础能力); daemon sets it when --ui
    // 环回地址(免密 —— 密码只拦局域网访客):agent 自己要看控制台时用这个。与 uiUrl 分开是因为
    // 对外绑定时 uiUrl 是 LAN IP(给人用、要密码),拿它自查会撞登录框(2026-07-30 真机踩过)。
    this.uiLocalUrl = uiLocalUrl
    // 控制台公网地址(v0.11.72 起的公网入口,daemon 从 ui.publicUrl 归一后设):/help 与清单给人的是它 ——
    // 局域网 IP 出了局域网就打不开,还要密码;公网入口只认飞书登录。没配就为 null,两处都不出现。
    this.publicUrl = null
    // Optional (workdir, configuredRepo) => { state:'ok'|'missing'|'drift'|'', origin } — reads the
    // project dir's REAL origin so the manifest reflects actual repo state (not just config echo),
    // mirroring the console's 仓库 badge. Pure fs (no spawn); daemon injects gitrepo. null ⇒ manifest
    // falls back to echoing the configured address (e.g. the CLI stub, which has no git reader).
    this.repoInfo = repoInfo
    this.codexMcp = codexMcp // () => [全局 codex MCP server 名] — codex 无按群门控,清单如实列全局(bin 注入,core 无感)
    // (workdir) => [项目级 .mcp.json 的 server 名] — 项目自带 MCP 随项目恒加载(插件门控 strict 也保留全部),
    // 但清单此前只列群卡勾选的用户级 ⇒ agent 不知道自己带着它们,浏览器纪律段的触发判据也看不见
    // 项目级的 chrome-devtools(有浏览器工具没使用纪律)。bin 注入读取器,core 不碰 fs(v0.11.2)。
    this.projectMcp = projectMcp
    // 项目现有的风格档清单(v0.11.22)。注入式,core 不碰 fs —— 与 repoInfo/projectMcp 同一条纪律。
    this.styleDocs = styleDocs
    // (workdir, {full,isCodex}) => { convention:[文件名], memory:{dir,bucket,index}|null, landing }
    // | null —— 项目里跨会话留得住、**且这一轮给得出去**的东西(约定文件 + 私有记忆目录)。
    // 注入式;core 不碰 fs。⚠ 门控与落点由读取器裁决(那是具体 agent 的行为知识),core 只打印;
    // 控制台切模型的群内通知调**同一个**读取器 —— 两处曾经分叉过,收成一处才挡得住复发。
    this.projectMemory = projectMemory
    // async (chatId, providerName) => void —— 群内 /model 切模型的写入器(v0.11.60)。注入式:core 不碰 fs。
    // ⚠ 它必须做**与控制台完全相同的一组动作**(配置落盘 + 运行时覆盖 + 清会话/会话账)——
    //   「配置唯一写入方」那条约束靠这个兑现,不是靠「只有控制台能改」。null ⇒ 群内如实说不支持。
    this.setProvider = setProvider
    this.hasImagen = hasImagen // () => bool — 机器可用 `sbot imagen` 生图与否(bin 注入判断,core 不认具体 runner 名)
    this.onActivity = onActivity // observer for the console's live feed (optional)
    // 运维告警钩子(可选):模型账号 / 额度类故障、自动切换 ⇒ 吐结构化事件(src/core/opsalert.js 写了形状),
    // bin 接线发到 alerts.chatId。core 只吐事件不发消息;钩子抛了只记日志,绝不影响轮次。
    this.onAlert = onAlert
    this.ledger = ledger // optional { append(rec) } — persisted per-turn usage
    // optional (provider, ok, text) => void —— 真实轮次的成败交给凭据验证记录(src/core/verify.js),doctor / 控制台概览据此报「能用 / key 不对」
    this.verifyTurn = verifyTurn
    // 群内反馈本(/issue,src/core/issues.js)。注入式:core 不碰 fs,也不认「本机文件在哪」——
    // 与 ledger 同一条纪律。null ⇒ 该命令如实回「暂时不可用」(CLI 试跑就是这条路)。
    this.issues = issues
    this.version = version // 记进反馈里的当版版本号 —— 事后分析时「这条是哪一版报的」是第一判据
    this.usageProbe = usageProbe // optional async (name, provider) => { supported, value } — for /hud (daemon-only; core stays runner-agnostic);裸串也收,见 normalizeUsage
    // 结构化额度探针(v0.11.107,额度自动切换用):async (providerName) => { ok, windows:[{kind:'session'|'weekly', percent, resetsAt}] } | null。
    // ok=false = 这个模型眼下连登录态都没有;null = 这次没探到(超时 / 限流),不下结论。bin 注入,core 不认具体 runner。
    this.quotaStatus = quotaStatus
    // Hard lock-release ceiling (never-hang invariant, engine-level): once a turn's answer
    // is delivered, if the runner's process won't close (clinging pipe / lingering MCP
    // children) the per-group lock would wedge the group forever — /stop included. After
    // this grace we force-release regardless of the runner. Generous so a normal close
    // wins first; only pathological hangs hit it.
    this.hardReleaseMs = (cfg.agent && cfg.agent.hardReleaseMs) || 20000
    // 时间口径(DESIGN §4.10):群内一切时间默认北京,cfg.timezone 可换;loadConfig 已
    // 规范化,这里再兜一层(测试/嵌入方可能传裸 cfg)。
    this.tz = normalizeTz(cfg.timezone)
    this.startedAt = Date.now()
    this.seen = new Map() // msgId -> ts, for short-window dedup
    this._injectedManifest = new Map() // chatId -> last self-knowledge manifest sent; re-inject only when it changes (no session reset)
    this.rts = new Map()  // chatId -> { busy, queue, controller, startedAt }
    this.unboundNotified = new Set() // chatId → guidance sent once (FR1.2: DM/未绑群不刷屏)
    this.sem = new Semaphore(cfg.agent && cfg.agent.maxConcurrent) // global cap across groups
  }

  _activity(ev) { try { this.onActivity(ev) } catch { /* observer must never break a turn */ } }

  // Live snapshot for the console (uptime, concurrency, per-group busy/queue/session).
  liveState() {
    const groups = {}
    let active = 0
    for (const [chatId, rt] of this.rts) {
      // Display the REAL lock (rt.busy), not a settled-adjusted view: a message arriving
      // while busy queues, so "idle" must mean "accepts work now" — else the console shows
      // idle while messages silently queue (the finalize-window mismatch). The lock lingers
      // only until close, now bounded by the runner's close-grace so it never wedges.
      if (rt.busy) active++
      groups[chatId] = {
        busy: !!rt.busy,
        // `settled` (answer delivered, still closing) surfaces as a distinct hint so the UI
        // can say "finalizing" instead of a bare "busy" during the brief close window.
        finalizing: !!(rt.busy && rt.settled),
        queue: rt.queue.length,
        sinceMs: rt.busy && rt.startedAt ? Date.now() - rt.startedAt : 0,
        sessionId: this.store.getSession(chatId) || '',
      }
    }
    const queue = [...this.rts.values()].reduce((n, rt) => n + rt.queue.length, 0)
    return { running: true, uptimeMs: Date.now() - this.startedAt, concurrency: { active, max: this.sem.max || 0 }, queue, groups }
  }

  // Hot-reload config into the running daemon (FR-console): providers / groups /
  // agent policy take effect on the NEXT turn without a restart. (Feishu WS creds
  // are bound to the platform at start — changing those still needs a restart.)
  reload(newCfg) {
    this.cfg = newCfg
    const max = newCfg.agent && newCfg.agent.maxConcurrent
    this.sem.max = max > 0 ? max : 0
  }

  // Graceful shutdown (FR10.3): abort every in-flight turn (which SIGTERMs then
  // SIGKILLs its child claude) and drop queued work, so no orphan processes survive.
  shutdown() {
    let aborted = 0
    for (const rt of this.rts.values()) {
      if (rt.controller) { try { rt.controller.abort() } catch {} aborted++ }
      rt.queue.length = 0
    }
    return aborted
  }

  // 关停会掐断的轮次快照(「恢复后自动续做」v1,机制见 src/core/pending.js 头注)。
  // ⚠ **必须在 shutdown() 之前调** —— abort 触发的 release() 会清掉 rt.pending。
  // settled 的轮不算欠账:答案已经发进群了(控制台显示 finalizing),只差子进程没退干净。
  interruptedTurns() {
    const out = []
    for (const rt of this.rts.values()) {
      if (!rt.busy || rt.settled || !rt.pending) continue
      // ⚠ **用户主动停的绝不重做**,而「停」与「锁真的松开」之间有窗口:撤回只 abort 不
      // forceRelease(等 runner 自己收尾)、`/stop` 也是 abort 后最多等 1s 才强制清锁 ——
      // 关停恰好落在这段窗口里,光靠 release() 清 rt.pending 就漏了。三个一次性标记本就
      // 是「这轮是被人叫停的」的当场证据,直接认它们。撤回那条尤其要紧:用户明确收回了
      // 请求,重启后把它重做一遍等于把撤回的内容又办了(DESIGN §4.5 说的是隐私正确性)。
      if (rt.recalled || rt.stopRequested || rt.interrupt) continue
      out.push({ ...rt.pending })
    }
    return out
  }

  // Wait until every aborted turn has actually finished (child reaped). Callers
  // must NOT exit before this settles — the SIGTERM→SIGKILL grace is ~10s, and
  // exiting earlier would orphan a child that ignores SIGTERM (FR10.3).
  async drain(timeoutMs = 12_000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (![...this.rts.values()].some((rt) => rt.busy)) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  _rt(chatId) {
    // `busy` is the serialization LOCK (start → process close); `settled` is the
    // DISPLAY state (flips true the instant the answer is delivered, before close).
    // Splitting them means the console/card stop showing "in progress" at
    // answer-time while the lock stays held to close so resume stays correct.
    if (!this.rts.has(chatId)) this.rts.set(chatId, { busy: false, queue: [], controller: null, interrupt: false, settled: false, pending: null, slotWaiter: null })
    return this.rts.get(chatId)
  }

  // Cancel a group's running turn (the console and /stop share this path) —
  // callers shouldn't reach into rts internals.
  stop(chatId) {
    const rt = this.rts.get(chatId)
    if (!rt || !rt.busy) return false
    this._markCancelled(chatId, '控制台停止')
    // Release the lock NOW (which also aborts/kills the process) instead of hoping the
    // runner's own grace fires — so /stop always works, even on a clinging/hung turn.
    if (rt.forceRelease) rt.forceRelease()
    else if (rt.controller) { try { rt.controller.abort() } catch {} }
    return true
  }

  // Force-restart a group: abort the in-flight turn, drop its queue, and
  // clear the session so the next message starts a fresh topic. Used by /new (busy
  // branch) and the console's "interrupt & new" button. Safe when idle (just clears).
  // The rt.interrupt flag tells the aborting turn NOT to persist its (partial)
  // session in _runTurn — otherwise it would resurrect the session we just cleared.
  interrupt(chatId) {
    const rt = this._rt(chatId)
    const wasBusy = !!rt.busy
    if (wasBusy) {
      rt.interrupt = true // skip persisting the interrupted turn's partial session
      rt.queue.length = 0 // discard queued-but-not-started jobs
      // Release NOW (aborts/kills the process too) so /new works even on a hung turn.
      if (rt.forceRelease) rt.forceRelease()
      else if (rt.controller) { try { rt.controller.abort() } catch {} }
    }
    this._freshSession(chatId)
    return { wasBusy }
  }

  // 开新会话的唯一动作(/new · 控制台「中断并新开」· 空轮换会话重做共用):会话与会话账一起清,
  // 两个挂在会话上的一次性标记一起作废。三处各清一份必漂移 —— 空轮那条路当初就差点只清会话。
  _freshSession(chatId) {
    const rt = this._rt(chatId)
    rt.compacted = false // 新会话没有「刚压缩过」这回事
    rt.cancelled = null // 会话都清了,没有「上一条」可捡 —— 遗留标记只会让新会话首轮收到一句莫名其妙的话
    this.store.clearSession(chatId) // 连带清「被掐断」标记(store 里做)
    this.store.clearSessionStats(chatId) // 新会话从零起账(/hud 会话行 + codex 累计基线)
  }

  // 压缩阈值唯一出口(runTurn 旗子与 /hud 显示共用):>0 时收进 CLI 文档区间 [10万,100万] ——
  // 手改配置写 5 万这类区间外值会让 CLI 拒参数、每轮必死;静默收编比死轮好,控制台存前
  // 另有同区间校验,这里是兜底。/hud 显示收编后的值 = 实际生效值,两处不会说两个数。
  // 群项目基础能力的环境变量(agent 子进程与定时脚本任务共用的**唯一出口**):SBOT_CHAT_ID = 本群 chat id(`sbot feishu`
  // 发到本群靠它)· TZ = 产品时区 · SBOT_CONFIG = daemon 用的配置路径(cwd 是 workdir,默认查找会找不到)· SBOT_UI_URL =
  // 控制台环回地址(签接管链接用;没开控制台不注入)。两个消费者:runTurn 的 extraEnv、bin 里 createCronFire 的 env。
  // SBOT_PLATFORM = 本群所在平台(config 归一过的 groups[].platform,没有就不注入):让 `sbot feishu` 在
  // Slack 群里拦得住、`sbot design styles` 的发群提示不再指向飞书。core 不认平台名,这里只是把配置值原样递下去。
  baseSkillEnv(chatId) {
    const g = (this.cfg.groups || {})[chatId]
    return { SBOT_CHAT_ID: chatId, ...(g && g.platform ? { SBOT_PLATFORM: g.platform } : {}), TZ: this.tz, ...(this.cfg._path ? { SBOT_CONFIG: this.cfg._path } : {}), ...(this.uiLocalUrl ? { SBOT_UI_URL: this.uiLocalUrl } : {}) }
  }

  _autocompactTokens() {
    const n = Number(this.cfg.agent.autocompactTokens) || 0
    return n > 0 ? Math.min(1_000_000, Math.max(100_000, Math.floor(n))) : 0
  }

  // 当前模型的额度行 —— `/hud` 与压缩通知**共用这一个出口**(两处各写一份,「不支持 / 没查到」
  // 那两句必漂移)。探针答两件事:这个模型能不能查(supported)、这次查到没有(value)。
  // 查不到时**不许**说成「不支持」—— 接口偶发超时/限流,说错就是劝人别再问一件其实能问的事。
  // auto = 不是人问的(压缩后自动附带):没探针、模型本就不支持查 ⇒ 返回 null 一个字不出 ——
  // 人问了得答,自动附带的只在有东西可说时说;「暂时没查到」仍然出(否则会被读成没这功能)。
  async _quotaLine(name, provider, { auto = false } = {}) {
    if (!this.usageProbe) return auto ? null : T.quotaUnavailable
    const u = normalizeUsage(await this.usageProbe(name, provider).catch(() => null))
    if (u.value) return T.quotaShow(name, u.value)
    if (u.supported) return T.quotaMiss(name)
    return auto ? null : T.quotaNone(name)
  }

  // Token 口径两坑(2026-08-09 实测):
  //  ① claude 的 result.usage 里 input_tokens 只是未命中缓存的零头(实测个位数),大头在
  //     cache_read/cache_creation —— 原来的 ledger 把驮着几十万上下文的轮记成 in:2。
  //  ② codex 的 turn.completed usage 是**会话累计值**(runner 标 usageCumulative)——
  //     直接当单轮记,一句「好了吗」录出 322 万,按日求和还会把累计数反复相加。
  // 这里统一归一成本轮增量 {in, out, cr(缓存读), cw(缓存写)},并顺手维护会话规模账
  // sessionStats(轮数/累计输入/上下文)。累计→增量靠 store 里的上轮基线相减:同会话才减,
  // 换会话以当前值起账;基线意外丢失(state 被清)时首轮偏大一次,可接受。
  _settleUsage(chatId, sessionKey, result) {
    const usage = result && result.usage
    if (!usage) return null
    let s = this.store.getSessionStats(chatId)
    if (!s || !sessionKey || s.sessionId !== sessionKey) s = { sessionId: sessionKey || null, turns: 0, in: 0, out: 0 }
    let t
    if (result.usageCumulative) {
      // 累计形态:input_tokens 含 cached_input_tokens(rollout 对照核实),先求差再拆缓存
      const prev = s.cum || { in: 0, cr: 0, out: 0 }
      const dIn = Math.max(0, (usage.input_tokens || 0) - prev.in)
      const dCr = Math.max(0, (usage.cached_input_tokens || 0) - prev.cr)
      t = { in: Math.max(0, dIn - dCr), out: Math.max(0, (usage.output_tokens || 0) - prev.out) }
      if (dCr) t.cr = dCr
      s.cum = { in: usage.input_tokens || 0, cr: usage.cached_input_tokens || 0, out: usage.output_tokens || 0 }
    } else {
      t = { in: usage.input_tokens || 0, out: usage.output_tokens || 0 }
      if (usage.cache_read_input_tokens) t.cr = usage.cache_read_input_tokens
      if (usage.cache_creation_input_tokens) t.cw = usage.cache_creation_input_tokens
    }
    s.turns += 1
    s.in += t.in + (t.cr || 0) + (t.cw || 0) // 会话累计按「输入侧总量」记 —— 含缓存,反映真实驮量
    s.out += t.out
    if (result.contextTokens) s.ctx = result.contextTokens // claude 报;codex 无此数,行内自然省略
    if (sessionKey) this.store.putSessionStats(chatId, s)
    return t
  }

  _resolveGroup(chatId) {
    return (this.cfg.groups && this.cfg.groups[chatId]) || this.defaultGroup || null
  }

  _resolveProvider(chatId, group) {
    const name = this.store.getProvider(chatId) || group.provider || this.cfg.defaultProvider
    return { name, provider: this.cfg.providers[name] }
  }

  _dedup(msgId) {
    const now = Date.now()
    for (const [k, ts] of this.seen) if (now - ts > DEDUP_WINDOW_MS) this.seen.delete(k)
    if (this.seen.has(msgId)) return true
    this.seen.set(msgId, now)
    return false
  }

  // Entry point: a Platform calls this for every inbound message.
  async handleMessage(msg, platform) {
    try {
      if (!msg || !msg.text || !msg.text.trim()) return
      if (msg.msgId && this._dedup(msg.msgId)) return
      // 重投防护(丢旧消息)只对**平台投递**的消息成立,合成消息(定时任务 / 画布按钮)必须整体绕开:
      //   ① 平台永远不会重发它 —— 它是本进程现造的,msgId 也是本地生成,防的东西根本不存在;
      //   ② 更要命的是**两把钟**:合成消息的 createTimeMs 取自本机 Date.now(),平台消息的取自
      //      平台服务器。拿它们比大小,主机时钟快 N 秒就等于让每条合成消息盖下一个「未来 N 秒」的
      //      水位线,把随后 N 秒内到达的真人消息全判成陈年重投、静默吞掉(反向亦然:主机钟慢则
      //      合成消息自己被吞)。2026-08-06 真机:主机快 27s,12:10 的定时任务吃掉了群成员
      //      12:09:54 发的消息,ledger 无行、日志无字,只能靠反推 —— 故下面那条丢弃也补了留痕。
      if (!msg.synthetic) {
        if (msg.createTimeMs && msg.createTimeMs < this.startedAt) return // drop pre-startup redelivery
        const wm = this.store.getWatermark(msg.chatId)
        if (msg.createTimeMs && msg.createTimeMs < wm) { // monotonic watermark
          this.log(`group ${msg.chatId}: message dropped as stale — createTime ${msg.createTimeMs} < watermark ${wm} (${msg.msgId || 'no-id'})`)
          return
        }
        if (msg.createTimeMs) this.store.setWatermark(msg.chatId, msg.createTimeMs)
      }

      const group = this._resolveGroup(msg.chatId)
      if (!group) {
        // One-time guidance per chat (FR1.2, v0.6 已决): an unbound DM/group must
        // not get a nag on every message — reply once, then stay silent.
        // ⚠ quiet 的判断必须排在 unboundNotified 之前:它是**一次性**的,若让 quiet 轮把它消耗掉,
        //   后面真人发消息时反倒收不到那句引导 —— 那就不是「这次不留痕」,是把别人的提示吃了。
        if (msg.quiet) return
        if (this.unboundNotified.has(msg.chatId)) return
        this.unboundNotified.add(msg.chatId)
        return platform.reply(msg.replyCtx, T.notBound)
      }

      // 群已暂停(operator 在控制台设,groups[chatId].paused):完全静默丢弃 —— 含 slash 命令。
      // 水位线已在上面无条件推进 ⇒ 恢复后飞书重投的暂停期消息不会被回放补处理;排队残留
      // 一并清空(拍板 2026-07-22:暂停语义=别处理了,恢复后陈年消息突然被处理更怪)。
      if (group.paused) {
        const rt = this.rts.get(msg.chatId)
        if (rt && rt.queue.length) { rt.queue.length = 0 }
        this.log(`group ${msg.chatId}: paused — message dropped`)
        return
      }

      const text = msg.text.trim()
      if (text.startsWith('/')) return this._handleCommand(text, msg, platform, group)
      return this._dispatch({ msg, platform, group })
    } catch (e) {
      this.log('handleMessage error: ' + (e && e.message))
      // quiet 同样管到这里(去重/水位线/store 写盘出错都会落到这条):承诺是全称的,
      // 破在哪一条都一样破。⚠ 日志照常打 —— 不广播不是丢掉。
      if (msg && msg.quiet) return
      try { await platform.reply(msg.replyCtx, redact(T.internalError(e && e.message))) } catch {}
    }
  }

  async _handleCommand(text, msg, platform, group) {
    const [cmd, ...args] = text.split(/\s+/)
    const rt = this._rt(msg.chatId)
    const red = (s) => redact(s, { pii: !group || group.redactPii !== false }) // 群面出站:PII 按群开关,密钥恒遮
    // 控制台插话的内容若以 / 开头就会走到这儿。勾掉「回复」= 这次不在群里留痕,那就一条也不发 ——
    // 命令**照常执行**(/new 该清会话就清),只是回执不进群。⚠ operator 因此看不到 /status 的输出:
    // 这是他自己选的「什么都不出现」,不是漏掉;概览页本来就有同样的信息。
    const reply = (s) => (msg.quiet ? Promise.resolve() : platform.reply(msg.replyCtx, red(s)))

    switch (cmd) {
      case '/help': {
        const { name, provider } = this._resolveProvider(msg.chatId, group)
        // 生图可用性与清单同一判据:机器能生图 且 平台没声明 imagen:false(完成通知那条路只接了飞书)
        return reply(helpText(group, provider, !!(this.hasImagen && this.hasImagen()) && !(platform && platform.features && platform.features.imagen === false), {
          browser: this._hasBrowser(group, provider),
          switchModel: !!this.setProvider,
          providerName: name,
          publicUrl: this.publicUrl || '',
          plugins: this._pluginNames(group, provider), // 与浏览器判据同一份名单,两处各算必漂
        }))
      }

      case '/model': {
        const { name, provider } = this._resolveProvider(msg.chatId, group)
        const fmt = (n, p) => `${n} · ${modelLabel(p, n === name ? group.model : '')}`
        // hidden 的不列也不让切 —— 那是 operator 标了「别在界面上给人选」的(如没配 key 的直连)。
        const avail = Object.entries(this.cfg.providers || {}).filter(([, p]) => !p.hidden)
        const list = avail.map(([n, p]) => fmt(n, p)).join(' / ')
        const canSwitch = !!this.setProvider
        const want = String(args[0] || '').trim()
        if (!want || !canSwitch) return reply(T.modelInfo(fmt(name, provider), list, canSwitch))
        // ⚠ 名字要精确匹配(只放宽大小写)——**不做模糊匹配**:切错模型 = 换了花的钱、换了能力,
        //   还把这段对话清掉;宁可让人重发一条,也不猜他想切哪个。
        const hit = avail.find(([n]) => n.toLowerCase() === want.toLowerCase())
        if (!hit) return reply(T.modelUnknown(want, avail.map(([n]) => n).join(' / ')))
        // 正处于额度临时切换中、而人点名的恰是那个备用 ⇒ 不是「没变化」,是「钉住它」:照常走写入器(配置落盘 +
        // 记录作废),之后引擎不再到点切回。否则人想留在备用上只能先切走再切回来,白清一次会话。
        const pinning = this._hasFailoverStore() && !!this.store.getFailover(msg.chatId)
        if (hit[0] === name && !pinning) return reply(T.modelSame(fmt(name, provider)))
        if (rt.busy) return reply(T.modelBusy)
        // 写入器由 bin 注入(core 不碰 fs):它做的是**与控制台完全相同的一组动作** ——
        // 配置落盘 + 运行时覆盖 + 清会话/会话账。⚠ **清会话不能省**:换的是另一套后端,
        // 把 codex 的 thread-id 喂给 claude 的 --resume 会当场坏掉。
        // 钉住当前这个(hit === name,只在临时切换中会走到这):后端没变,写入器不必清会话 —— 否则钉住的代价是白丢上下文
        try { await this.setProvider(msg.chatId, hit[0], { keepSession: hit[0] === name }) } catch (e) {
          this.log(`/model 切换失败: ${msg.chatId} → ${hit[0]}: ${e && e.message}`) // 详情只进日志,不进群
          return reply(T.modelSwitchFailed)
        }
        this.log(`/model: ${msg.chatId} ${name} → ${hit[0]} (by ${msg.senderName || 'unknown'})`)
        rt.pendingFailover = null // 人切了模型,引擎排着的「下一轮前切备用」作废(落盘那份由 store.setProvider 一并清)
        // 换脑后那句「之前交代过的不用重讲」——判据与文案都取自同一个读取器(控制台切模型那条路
        // 用的也是它),且按**切到的那个** provider 算够不够得着。两处各写一份必然漂移。
        let note = ''
        try {
          const nextIsCodex = !!(hit[1] && hit[1].runner === 'codex')
          const opts = { full: group.permissionMode === 'bypassPermissions', isCodex: nextIsCodex }
          const h = this.projectMemory ? this.projectMemory(group.workdir, opts) : null
          if (h) note = h.note
        } catch { /* 探不到就不说 */ }
        return reply(T.modelSwitched(fmt(hit[0], hit[1]), note))
      }

      case '/new': {
        // Busy ⇒ force-restart: interrupt the running turn, drop the queue, and clear
        // the session so this becomes a clean new topic. Idle ⇒ just clear.
        const { wasBusy } = this.interrupt(msg.chatId)
        return reply(wasBusy ? T.interrupted : T.freshSession)
      }

      case '/stop': {
        // 单条终态确认(v0.3.5 优化):此前回「正在停止…」后就没下文,停没停成要去卡片角落找
        // 小字。现在 abort 后原地等到真停(绝大多数在 1s 内),只回一条「已停止」;等待窗内
        // 没停(挂死进程)则走 forceRelease 强制清锁杀树(与控制台停止按钮同款)——「已停止」
        // 从尽力而为升级成保证兑现。stopRequested 让 finalize/排队中止路径不再各发一条重复确认。
        // /stop = 全都别做了(2026-08-21 定下的口径):当前这一件 + 排队的一起取消,只保留会话。
        // 想「只停这一件、后面接着做」用 /skip —— 两条命令的差别就在队列上,别混。
        // ⚠ 队列必须**在 abort 之前**清:release() 紧接着就会出队派发,晚一步就把它派出去了。
        if (!rt.busy || !rt.controller) return reply(T.noActiveTask)
        // ⚠ 报数只报群里看得见的;quiet 插话照样一起丢(「全都别做了」对它同样成立),
        //   但走日志留痕而不是群消息 —— operator 那边有据可查,群里不露出无痕的东西。
        this._markCancelled(msg.chatId, '/stop')
        const dropped = this._visibleQueue(rt)
        const droppedQuiet = rt.queue.filter((j) => j.msg && j.msg.quiet).length
        const droppedPolled = rt.queue.filter((j) => j.msg && j.msg.polled && !j.msg.quiet).length
        if (droppedQuiet) this.log(`group ${msg.chatId}: /stop also dropped ${droppedQuiet} quiet (console) job(s)`)
        if (droppedPolled) this.log(`group ${msg.chatId}: /stop also dropped ${droppedPolled} polled (unaddressed) job(s)`)
        rt.queue.length = 0
        rt.stopRequested = true
        rt.controller.abort()
        // ⚠ 等待的判据必须是**「我要停的那一轮」停了没**,不能是「这个群忙不忙」(v0.11.46 修)。
        //   `rt` 是每群一份、跨轮复用的:前一轮 release() 会**立刻**把排队的下一轮派出去 ⇒
        //   `rt.busy` 转眼又是 true。光看 rt.busy,这个循环就会把**继任者**当成赖着不走的前任,
        //   等到 stopWaitMs 到点一记 forceRelease 把它杀了 —— 而它是别人刚排上队的真人消息。
        //   2026-08-21 某项目真机现场:继任轮 ledger 8453ms(≈stopWaitMs 8000)、群里连出两条
        //   「已停止」(第二条来自继任轮 finalize —— 防重复的 stopRequested 已被前一轮 release
        //   重置)、被杀的正是排队中的 3 条真人消息。
        //   ⭐ 与 v0.11.30 同族:别处都拿 `rt.startedAt` 当轮次身份,唯独这里漏了。
        const mine = rt.startedAt
        const deadline = Date.now() + ((this.cfg.agent && this.cfg.agent.stopWaitMs) || 8000)
        while (Date.now() < deadline && rt.busy && rt.startedAt === mine) await new Promise((r) => setTimeout(r, 120))
        // 只强杀我自己那一轮:身份对不上 = 它已经收尾、现在跑的是别人,碰不得。
        if (rt.busy && rt.startedAt === mine && rt.forceRelease) rt.forceRelease()
        return reply(dropped ? T.stoppedWithQueue(dropped) : T.stopped)
      }

      // /skip = 只放弃正在跑的这一件,排队的照常接着做(2026-08-21 新增)。
      // 由来:一轮跑了 42 分钟没动静,群里想「停这个、让它继续后面的」—— 当时只有 /stop,
      // 而 /stop 是「全都别做了」。两种需求本就不同,靠一条命令区分不了,所以分开两条。
      // ⚠ 与 /stop 的实现差别只有一处:**不碰队列**。其余(身份守卫、等待、强制释放、
      //   stopRequested 让 finalize 不再重复确认)完全一致 —— 差异越小越不容易漂。
      case '/skip': {
        if (!rt.busy || !rt.controller) return reply(T.noActiveTask)
        // ⚠ 报数在动手**之前**读:/skip 不碰队列,此刻的长度就是「接下来还要做的」。放到等待
        //   之后读会撞上一堆竞态(继任者可能已出队开跑、也可能还在 setImmediate 里),数字忽大忽小。
        this._markCancelled(msg.chatId, '/skip')
        const pending = this._visibleQueue(rt)
        rt.stopRequested = true
        rt.controller.abort()
        const mine = rt.startedAt
        const deadline = Date.now() + ((this.cfg.agent && this.cfg.agent.stopWaitMs) || 8000)
        while (Date.now() < deadline && rt.busy && rt.startedAt === mine) await new Promise((r) => setTimeout(r, 120))
        if (rt.busy && rt.startedAt === mine && rt.forceRelease) rt.forceRelease()
        return reply(T.skipped(pending))
      }

      case '/status': {
        const { name, provider } = this._resolveProvider(msg.chatId, group)
        const modelId = modelLabel(provider, group.model)
        // ⚠ 零工具名(2026-08-06 补漏):原来这里有一行 `目录: /Users/…/某项目` —— 群消息里
        // 不该出现机器上的绝对路径(规则的豁免只给控制台群卡,那是 operator 的配置界面)。
        // 换成项目名:群成员要的是「在哪个项目上干活」,不是这台机器的目录布局。
        const projectName = String(group.workdir || '').split(/[\\/]/).filter(Boolean).pop() || '(未设)'
        return reply([
          '【本群状态】',
          `· 模型:${name} · ${modelId}`,
          `· 项目:${projectName}`,
          // ⚠ 只说「运行中」等于没说 —— 2026-08-21 某项目真机:一轮跑了 42 分钟,群成员敲
          //   /status 得到的就是这三个字,于是两个人猜了 15 分钟「是不是卡住了」,最后把一个
          //   马上要交付的任务掐了。引擎当时**完全知道**它已经跑了 27 分钟、刚有过动静。
          // ⭐ 判据是 aliveAt 不是 startedAt:「跑了很久」不等于「卡住了」,能把两者分开的只有
          //   「最近一次动静距今多久」。跑 42 分钟但 12 秒前还在动 = 在干活;20 分钟没动静才该管。
          `· 状态:${rt.busy ? `运行中(已跑 ${humanDur(Date.now() - rt.startedAt)}${rt.steps ? ` · 已执行 ${rt.steps} 步` : ''}${rt.aliveAt ? ` · 最近动静 ${humanDur(Date.now() - rt.aliveAt)}前` : ''})` : '空闲'}`,
          // 「最近在做」(v0.11.93):忙时才有,与卡片脉搏同一份数据 —— 「它在干什么」比「跑了多久」更能回答「卡没卡住」
          ...(rt.busy && rt.doing && rt.doing.length ? [`· ${T.pulseDoing(rt.doing)}`] : []),
          `· 排队:${this._visibleQueue(rt)}`,
          `· 会话:${this.store.getSession(msg.chatId) ? '进行中(记着上下文)' : '未开始'}`,
          ...(group.board && group.board.url ? [`· 画布:${group.board.url}`] : []),
          ...(this._failoverLine(msg.chatId) ? [this._failoverLine(msg.chatId)] : []),
        ].join('\n'))
      }

      // v0.11.16 由 /quota 更名而来。**不留 /quota 别名** —— 帮助里列的命令与这个 switch
      // 必须一一对应,留个不在帮助里的暗门就是又一处「说的和做的不一致」;打错的人会收到
      // 「未知命令(试试 /help)」,一步就自己纠回来。
      case '/issue': {
        // 群内反馈本(src/core/issues.js):群成员是这套系统真正的使用者,却一直没有一个
        // 够得着的反馈入口 —— 说了就散在聊天记录里,靠 operator 事后去捞(2026-08-13 丢过
        // 一次)。⚠ 只认显式命令,**不让 agent 去猜哪句话是 bug 报告**:智能不进编排层
        // (与「调度 agent 判合并」同一条已锁定决策),而误判产出的垃圾反馈会淹掉真的那些。
        // ⚠ 正文用 slice 取而不是 args.join(' '):后者会把换行和连续空格压成单空格,
        // 而反馈里的换行往往是「现象 / 复现步骤」的分隔,压掉就少了半条线索。
        const body = text.slice(cmd.length).trim()
        if (!body) return reply(T.issueUsage)
        if (!this.issues) return reply(T.issueUnavailable)
        // 附带上一轮的技术指纹 —— 这是整件事最值钱的地方。群成员的原话通常是「它刚才
        // 没理我」,单凭这句没法查;带上那轮的 status/耗时/token,空轮、超时、模型报错、
        // 「其实答了但没看见」当场就能分开。rt.lastTurn 是内存里的(daemon 重启即空),
        // 取不到就不附,绝不为了凑一个字段去读盘。
        // ⚠ 落盘会抛(跨进程锁超时、磁盘满、权限)—— 那时必须如实说「没记下来」,而不是让
        // 异常冒泡成一句「内部错误」。区别是实打实的:前者让人知道要再说一次,后者让人
        // 以为已经记下了 —— 而这本账存在的全部意义就是「反馈不会不声不响地消失」。
        let rec = null
        try {
          rec = this.issues.add({
            chatId: msg.chatId,
            group: group.name || '',
            sender: msg.senderName || msg.userId || '',
            text: body,
            version: this.version || '',
            turn: rt.lastTurn || null,
          })
        } catch (e) {
          this.log('issue add failed: ' + ((e && e.message) || e))
        }
        if (!rec) return reply(T.issueFailed)
        this.log(`issue #${rec.id} logged by ${rec.sender}: ${rec.text.slice(0, 60)}`)
        return reply(T.issueLogged(rec.id, !!rec.turn))
      }

      case '/hud': {
        // Read-only usage/balance for the group's current model (a per-provider lookup,
        // injected so core stays runner-agnostic; cached upstream). codex → subscription
        // 5h/weekly %; keyed providers → account balance/quota; else nothing to show.
        const { name, provider } = this._resolveProvider(msg.chatId, group)
        if (!provider) return reply(T.providerNotConfigured(name))
        if (!this.usageProbe) return reply(T.quotaUnavailable)
        const lines = [await this._quotaLine(name, provider)]
        // 会话规模行(v0.11.17):只在账本确属**当前**会话时显示 —— /new 或换模型后旧账已清,
        // 但防御一手 sessionId 对不上的陈账(state 手工恢复之类),错的规模比没有更糟。
        const stats = this.store.getSessionStats(msg.chatId)
        if (stats && stats.sessionId && stats.sessionId === this.store.getSession(msg.chatId)) {
          lines.push(T.sessionLine(stats.turns, stats.ctx || 0, stats.in, this._autocompactTokens()))
        }
        if (this._failoverLine(msg.chatId)) lines.push(this._failoverLine(msg.chatId))
        return reply(lines.join('\n'))
      }

      default:
        return reply(T.unknownCommand(cmd))
    }
  }

  // 「这条请求已被取消,别自己捡回去做」—— 一次性标记,下一轮拼进 prompt 后即消。
  // ⚠ 引擎中止一轮,并不等于那条请求从会话里消失了:**它仍留在历史里、且从没被回答过**,
  //   下一轮 --resume 接上去,模型自然把它当成待办接着做。2026-08-21 实证:/skip 掉一个
  //   sleep 90 的长任务后,继任轮产出「长任务完成 排队甲 排队乙」、耗时 149s —— 那 90 秒又跑了
  //   一遍。⇒「跳过」在群成员眼里没兑现:他喊了停,它转头又做了一遍,还多花一次钱。
  // ⭐ 修在编排层而不是指望模型自觉:引擎知道「哪一条被取消了」,把这个事实说给它听即可。
  // ⚠ 只标**人主动取消**的那几种(/stop · /skip · 控制台停止 · 撤回即停);
  //   墙钟超时**不标** —— 那件事是想做的,只是超时了,下一轮接着做才对。
  //   /new 也不标:它清了会话,压根没有历史可捡。
  _markCancelled(chatId, how) {
    const rt = this.rts.get(chatId)
    if (!rt || !rt.busy) return
    rt.cancelled = { text: rt.turnText || '', how }
  }

  // 群里能看见的排队条数 —— **凡是要发进群的数字都必须走这里**(v0.11.46 复核阶段补齐)。
  // ⚠ 直接用 `rt.queue.length` 会把控制台那些「群里彻底无痕」的插话一起数进去:群成员看到
  //   「排队 3 条」却一条也没见过,等于把无痕漏了出去。本版早先只在排队提示那一处修了,
  //   而随后新增的 /stop 丢弃数、/skip 待办数又各漏一次,/status 的排队行则一直漏着 ——
  //   ⭐ **逐处补必然再漏,所以收成一个函数**(与「闸装在唯一出口上」是同一条纪律)。
  //   operator 面(控制台 liveState)不走这里:那里就该看到全部,包括自己插的。
  // polled(轮询来的不 @ 消息)也不数:@ 消息入队时排在它们前面(_dispatch),「前面 N 条」里本就没有它们。
  _visibleQueue(rt) {
    return rt.queue.filter((j) => !(j.msg && (j.msg.quiet || j.msg.polled))).length
  }

  // 出队时只取队首**一段 quiet 标记相同**的消息去合并,不把两种混进同一轮。
  // ⚠ 混批两个方向都错,而 `{...last}`(代表取末条)让哪个方向发生纯看谁最后到:
  //   · quiet 排最后 ⇒ 整批静音 ⇒ **真人的问题被一起吞掉,他永远等不到回答**(v0.11.12 水位线、
  //     v0.11.24 空轮记 ok 都是这个形状 —— 静默吞真人消息是本项目最贵的一类 bug);
  //   · quiet 排前面 ⇒ 整批出声 ⇒ 说好「群里无痕」的那条,内容被广播进群。
  // 拆开跑两轮,两个承诺都不破,代价只是多一次 spawn。剩下的留在队里,release() 下一轮自然接着跑。
  // ⚠ 隔壁 emptyRetried 特意用 `jobs.some` 没照搬代表(注释写着「照搬会把标记洗掉」)—— 同一个
  //   函数、同一个坑,quiet 当初没躲过;凡是「批内各条取值可能不同」的标记,都得先想清楚怎么归并。
  // 入队的唯一出口(两车道不变量:非 polled 全在 polled 前面)。front = 插到自己那一段的最前面(空轮重试 / 额度切换重做用)。
  //   非 polled:front ⇒ 队首;否则插到第一个 polled 之前(没有 polled ⇒ 队尾)
  //   polled:front ⇒ 第一个 polled 的位置(= 所有非 polled 之后);否则队尾
  _enqueue(rt, job, { front = false } = {}) {
    const firstPolled = rt.queue.findIndex((j) => j.msg && j.msg.polled)
    let at
    if (job.msg && job.msg.polled) at = front ? (firstPolled >= 0 ? firstPolled : rt.queue.length) : rt.queue.length
    else at = front ? 0 : (firstPolled >= 0 ? firstPolled : rt.queue.length)
    rt.queue.splice(at, 0, job)
  }

  // polled 同理(两车道):@ 消息走流式回复、轮询消息走主动推送,混进一批只能二选一,且代表取末条会把形态带偏。
  _runLen(queue) {
    const lane = (j) => `${!!j.msg.quiet}|${!!j.msg.polled}`
    const l0 = lane(queue[0])
    let k = 1
    while (k < queue.length && lane(queue[k]) === l0) k++
    return k
  }

  // Merge queued jobs into ONE batch job (dequeue-time coalescing). While a turn runs,
  // follow-ups pile up; running them one-by-one is slow, costly, and splits what is often
  // a single evolving request ("对了还要加 X"). The DECISION of how the messages relate is
  // the agent's (each line keeps its [time sender] tag) — the engine only does the dumb,
  // deterministic part: hand them over together. Reply/card anchor to the NEWEST message.
  // ⚠ 只喂同一段(见 _runLen):批内的 quiet 必须一致,否则代表取末条会把整批带偏。
  _coalesce(jobs) {
    if (jobs.length === 1) return jobs[0]
    const msgs = jobs.map((j) => j.msg)
    // 代表 = 最后一条**真人**消息(卡片/回复锚定它);整批都是合成消息才取末条。
    // ⚠ 此前一律取末条:定时任务/插话恰好排最后时,卡片会锚到一条没有平台 message_id 的合成消息上,
    //   而真人那条明明就在批里。
    const last = [...jobs].reverse().find((j) => j.msg && !j.msg.synthetic) || jobs[jobs.length - 1]
    // emptyRetried 取「批内任一为真」而不是随代表走:空轮重试的 job 排在队首,若这期间
    // 又来了新消息,代表就是新消息 —— 照搬它会把重试标记洗掉,同一批便可能一空再空反复重试。
    // ⚠ 下面三个标记同理,逐个裁决(2026-09-07 通读逮到,与 v0.11.42 quiet 那次同形):
    //   · synthetic:批里有一条真人消息就不算合成 —— ack(有人在等)与关停记账(真人的请求要重做)都按真人算;
    //   · wantsAck:有人在等回复就先回一声;
    //   · resetSessionAfter:**全批都要求才翻篇**。整理类定时任务(某项目 04:40)带着它,若恰与一条真人消息
    //     合并成一批,照末条/任一裁决会把那个人刚聊的上下文一起清掉 —— 静默吞真人这一族里最贵;少翻一次篇
    //     只是会话多攒一天,自动压缩兜着。
    return {
      ...last,
      batch: msgs,
      emptyRetried: jobs.some((j) => j.emptyRetried),
      // 空轮换会话重做的两个标记同理(v0.11.103):任一为真即为真 —— 洗掉就会一空再空反复换会话。
      freshRetried: jobs.some((j) => j.freshRetried),
      firstResumed: jobs.some((j) => j.firstResumed),
      failedOver: jobs.some((j) => j.failedOver), // 额度切换后的重做同理:洗掉就会在备用再出错时整批再做一遍
      msg: {
        ...last.msg,
        synthetic: msgs.every((m) => m && m.synthetic),
        wantsAck: msgs.some((m) => m && m.wantsAck),
        resetSessionAfter: msgs.every((m) => m && m.resetSessionAfter),
      },
    }
  }

  // A platform reported an inbound message was RECALLED (e.g. feishu im.message.recalled_v1).
  // Queued ⇒ drop it silently (never started, nothing to clean up). Running solo ⇒ abort like
  // /stop, but silently when no card exists — the user visibly withdrew the request, and
  // continuing could even echo content they meant to retract. A message already merged into a
  // running batch is NOT aborted (other senders' requests share that turn); rare edge, logged.
  handleRecall({ chatId, msgId } = {}) {
    if (!chatId || !msgId) return false
    const rt = this.rts.get(chatId)
    if (!rt) return false
    const qi = rt.queue.findIndex((j) => j.msg.msgId === msgId)
    if (qi >= 0) {
      rt.queue.splice(qi, 1)
      this.log(`group ${chatId}: queued message recalled — dropped (${msgId})`)
      return true
    }
    if (rt.busy && rt.msgIds && rt.msgIds.has(msgId)) {
      if (rt.msgIds.size > 1) { this.log(`group ${chatId}: recalled message is part of a running batch — turn continues (${msgId})`); return false }
      rt.recalled = true
      this.log(`group ${chatId}: running turn's message recalled — aborting (${msgId})`)
      this._markCancelled(chatId, '发送者撤回了消息')
      if (rt.controller) { try { rt.controller.abort() } catch {} }
      return true
    }
    // 无匹配也留痕:撤回的多半是已处理完的消息(正常),但排查「撤回没停」时这行区分
    // 「引擎收到了但没东西可停」和「事件压根没到」。
    this.log(`group ${chatId}: recall for ${msgId} — no queued/running match (already finished?)`)
    return false
  }

  async _dispatch(job) {
    const rt = this._rt(job.msg.chatId)
    if (rt.busy) {
      // 两车道:@ 消息(及其它非轮询消息)插到队里所有轮询消息之前 —— 真人 @ 了就是在等,不能排在
      // 三条闲聊后面;轮询消息之间、非轮询消息之间仍按先后。msg.polled 由投递方标,core 只认这个布尔。
      this._enqueue(rt, job)
      // 正在跑的若是一条还在等并发槽的轮询轮次,它握着群锁 ⇒ 这条 @ 只能等它;就地把它的 reserve 清零
      // (release 交接时现读 reserve),让它按 @ 的优先级拿槽 —— 否则别的群越忙,这个群的 @ 等得越久(优先级反转)
      if (!job.msg.polled && rt.slotWaiter) rt.slotWaiter.reserve = 0
      // queue.length counts the running turn's successors: position N ⇒ N tasks ahead
      // (the running one + N-1 queued before this job); they'll be coalesced at dequeue.
      // ⚠ quiet(控制台插话勾掉「回复」)连排队提示都不能发 —— 这是 _runTurn 那道 reply 闸
      //   够不着的地方(排队发生在轮次开始之前)。「群里彻底无痕」若被一句「⏳ 已排队」破功,
      //   反而最刺眼:群成员看见一条没头没尾的排队,却永远等不到它对应的产出。
      // polled 也不提示:没人在等一条不 @ 的消息被「排队」,推送还占每会话 30 条 / 分的额度。
      if (job.msg.quiet || job.msg.polled) return
      // ⚠ 计数只数**和自己同一类**的:直接用 queue.length 会把队里那些 quiet 插话数进去 ——
      //   群成员看到「与前面 2 条一并处理」却一条也没见过,等于把「群里无痕」漏了出去;
      //   而且它们已不与本条同批(见 _runLen),「一并处理」也不再是真话。
      //   代价是队里堆着 quiet 时把等待说短了 —— 宁可少说等待,也不能让看不见的东西露头。
      // 定时任务另一句(见 T.queuedCron)。msg.cron 由投递方标(bin 的调度器),core 只认这个布尔。
      return job.platform.reply(job.msg.replyCtx, job.msg.cron ? T.queuedCron(this._visibleQueue(rt)) : T.queued(this._visibleQueue(rt)))
    }
    rt.busy = true
    rt.startedAt = Date.now()
    // 本轮的「活着的证据」,只服务 /status(v0.11.46)。⚠ 群成员真正想知道的不是「忙不忙」
    // 而是「它还在动吗」—— 这两者只有 `aliveAt` 分得开:跑了 27 分钟但 12 秒前刚有动静 = 在
    // 干活;跑了 27 分钟而 20 分钟没动静 = 该管了。每轮开始清零,别把上一轮的步数带过来。
    rt.steps = 0
    rt.aliveAt = 0
    rt.doing = [] // 「最近在做」(v0.11.93):脉搏与 /status 共用,每轮从零起
    // ⚠ 把开始时刻捕进闭包:release() 会把 rt.startedAt 清 0(它是「本轮身份」,必须清),而
    // reportDone 可能在那之后才到(/stop 的 forceRelease、hardRelease 都是这条路)——
    // 那时 `Date.now() - rt.startedAt` 算出来是 epoch 毫秒,直接写进 ledger 当耗时。
    // 生产机上 stopped 轮全中,污染的正是「拿 ledger 挑阈值」这类分析的输入。
    const startedAt = rt.startedAt
    // 本轮正文,只服务「被取消后别自己捡回去做」那条提示(_markCancelled)。比 ledger 的 60 字
    // 摘要留得长一点 —— 它要让模型认出「是哪一条被取消了」,太短会指代不清。
    rt.turnText = (job.batch ? job.batch.map((m) => (m.text || '').trim()).join(' ⏎ ') : (job.msg.text || '').trim()).slice(0, 160)
    rt.settled = false
    rt.msgIds = new Set((job.batch || [job.msg]).map((m) => m.msgId).filter(Boolean)) // recall matching
    const senders = [...new Set((job.batch || [job.msg]).map((m) => m.senderName || m.userId || 'user'))]
    const meta = {
      id: `${job.msg.chatId}:${startedAt}`,
      ts: startedAt,
      chatId: job.msg.chatId, // 完整 chatId(活动观察者按群定位用,如画布单卡回填兜底);UI 只用 group 显示
      msgId: job.msg.msgId, // 代表消息 id(排队合并批次取末条)
      msgIds: (job.batch || [job.msg]).map((m) => m.msgId).filter(Boolean), // 全批消息 id —— 观察者判断
      // 「本批含某驱动源」必须扫全批:合并批的代表是末条,单看 msgId 会漏掉批内其它驱动(如 boardgo:*)
      group: String(job.msg.chatId).slice(-8),
      sender: senders.join('、'),
      text: (job.batch ? job.batch.map((m) => (m.text || '').trim()).join(' ⏎ ') : (job.msg.text || '').trim()).slice(0, 60),
    }
    // 被打断的轮次记账快照(v1,见 src/core/pending.js):关停时 interruptedTurns() 取它。
    // ⚠ 存**完整**正文 —— ledger 的 text 是 60 字摘要,拿它续做会把请求截半。
    // 只记真人消息:合成消息(定时任务 / 画布按钮)各有自己的触发源,且免掉「续做的轮又被
    // 掐断 ⇒ 前缀层层嵌套」。批次里混着合成消息时只取真人那几条。
    // polled(轮询来的不 @ 消息)也不记欠账:没人 @ 过的闲聊,重启后「续做」一遍只会凭空推送一条没头没尾的回答
    const realMsgs = (job.batch || [job.msg]).filter((m) => m && !m.synthetic && !m.polled)
    rt.pending = realMsgs.length ? {
      chatId: job.msg.chatId,
      text: realMsgs.map((m) => (m.text || '').trim()).filter(Boolean).join('\n'),
      msgId: job.msg.msgId || null,
      sender: meta.sender,
      ts: startedAt,
    } : null
    this._activity({ ...meta, kind: 'start' })
    // The "logical done": the console feed + ledger fire the INSTANT the answer is
    // delivered (from _runTurn, at the runner's result event) — not at process close.
    // Idempotent (`reported`) so _runTurn's early call wins and the finally is a
    // no-op fallback for abort/throw paths. `ms` thus measures real work time, not
    // the Windows codex.exe pipe-cling lag.
    let reported = false
    let released = false
    let hardTimer = null
    // release() is the SINGLE lock-cleanup path, idempotent, callable from three places:
    // the normal finally, the hard-release timer, and /stop · /new (via rt.forceRelease).
    // So the group can never wedge: even if _runTurn never resolves (process won't close),
    // the timer or the operator frees it. A late _runTurn resolution is then a no-op.
    const release = () => {
      if (released) return
      released = true
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null }
      if (rt.controller) { try { rt.controller.abort() } catch {} } // best-effort: kill the lingering process/MCP tree
      rt.busy = false
      rt.controller = null
      rt.startedAt = 0
      rt.settled = false
      rt.interrupt = false // one-shot: only the just-finished (possibly interrupted) turn honored it
      rt.recalled = false  // one-shot recall marker (see handleRecall)
      rt.stopRequested = false // one-shot /stop marker (single-confirmation ownership)
      rt.msgIds = null
      rt.pending = null // 本轮已收尾 ⇒ 不再是欠账(关停快照只认还在跑的)
      rt.forceRelease = null
      // Dequeue-time coalescing: take EVERYTHING that queued up during this turn as one
      // batch job (see _coalesce) instead of paying one spawn per message.
      // 暂停兜底:暂停动作发生在本轮进行中时,handleMessage 的拦截管不到已排队的消息 ——
      // 出队前再查一次(每次现读 cfg,热重载即生效),暂停群丢弃队列不派发。
      const gNow = this._resolveGroup(job.msg.chatId)
      if (gNow && gNow.paused && rt.queue.length) { this.log(`group ${job.msg.chatId}: paused — ${rt.queue.length} queued message(s) dropped`); rt.queue.length = 0 }
      // ⚠ 只取一段(不再清空队列)带来一个良性副作用:`rt.busy` 此刻已是 false,若恰好有新消息
      //   在 setImmediate 之前落地,它会抢先开跑,随后 next 被 push 到**剩余段之后** —— 顺序会
      //   变,但不会丢、也不会混批(下一轮照样过 _runLen)。窗口只有一个事件循环 tick,不值得
      //   为它改造派发环路。
      const next = rt.queue.length ? this._coalesce(rt.queue.splice(0, this._runLen(rt.queue))) : null
      if (next) setImmediate(() => this._dispatch(next))
    }
    rt.forceRelease = release // /stop and /new release the lock immediately, not "best effort via the runner"
    const reportDone = (o) => {
      if (reported) return
      reported = true
      o = o || { status: 'failed' } // never deref null — a turn must always report a status
      rt.settled = true // answer delivered → console feed 'done' + ledger, at answer-time
      // 上一轮的技术指纹,留给紧随其后的 /issue 附带(见该命令)。只留指标不留正文:群成员
      // 报问题时的「刚才」就是这一轮,而 status/耗时/token 正是他们描述不出、我们最需要的那半。
      // 内存态、每群一份、后一轮覆盖前一轮 —— 反馈本身不该让引擎多做一次盘 IO。
      // 失败原因算**一次**,账本与 /issue 指纹共用 —— 同一判据两处各算一份是本文件反复栽过的形状。
      // ⚠ 只在**失败**时有值:stopped 是人主动叫停、no-reply 是设计如此、empty 本身就是信号。
      // ⚠ 失败却拿不到原因时**也写一句**:字段缺席 = 旧格式,写了通用句 = 我们记了、runner 没给 ——
      //   两者必须分得开,否则又是「没查过」和「查过没问题」长一模一样。
      // ⚠ 原因由**产出它的那一处**交来(那里才有 finalText/异常对象),这里只做兜底与判据 ——
      //   在这儿反推等于第二次猜,而第一版正是那么写的、拿正常正文当了错误原因。
      // ⚠ 这一行必须**不会抛**:reportDone 排在 release() 之前,抛一次 = 该群锁永久卡死
      //   (DESIGN §4.4「群永不卡死」)。故只读一个已经算好的字符串,不在这里调任何可能抛的东西。
      const errText = (o.status === 'error' || o.status === 'failed') ? (String(o.errText || '') || '(未拿到原因)') : null
      // ⚠ 失败时连原因一起留给 /issue —— 群成员报问题的原话通常就是「它刚才没理我」,而这份
      //   指纹是唯一能把「空轮 / 超时 / 模型报错 / 其实答了但没看见」分开的东西。此前 status
      //   说了「error」却说不出是什么错,拿到反馈的人还得再猜一遍。
      rt.lastTurn = { ts: startedAt, status: o.status, ms: Date.now() - startedAt, tokens: o.tokens || null, provider: o.provider || null, ...(errText ? { err: errText } : {}) }
      // err 与账本同一个值:控制台活动行出错时直接显示原因,不用再去翻账本
      this._activity({ ...meta, kind: 'done', status: o.status, ms: Date.now() - startedAt, tokens: o.tokens, preview: o.preview, reply: o.reply, tools: o.tools, ...(errText ? { err: errText } : {}) })
      // ⚠ 账本此前只记 `status:"error"`,**一个字的原因都没有**;而日志那边又没有时间戳
      //   ⇒ 线上失败**事后无从查起**(2026-09-01 真机:生产群一周 15 次 error,一次都查不出
      //   原因 —— 两边各缺一半)。原因其实一直在手上(preview/subtype),只是落盘时被丢掉了。
      //   ok 轮一个字节都不多写 —— 账本一轮一行,常态不该为异常付代价。判据见上面的 errText。
      if (this.ledger) this.ledger.append({ ts: startedAt, chatId: job.msg.chatId, provider: o.provider || null, sender: meta.sender, text: meta.text, status: o.status, ms: Date.now() - startedAt, tokens: o.tokens || null, ...(errText ? { err: errText } : {}) })
      // ⚠ 失败在**日志里也要留一行** —— 账本是结构化记录,日志才有**上下文**(失败前调了什么
      //   工具、卡片推送有没有报错)。此前 error/failed 这条路在日志里一个字都不留:账本说
      //   「这一轮失败了」、日志连提都没提,而排查时最有用的往往正是失败前后那几行。
      // ⚠ 这里**故意不包 try**:审查提过「reportDone 抛一次就卡死群锁」,查下来不成立 ——
      //   已经有两层 finally 兜着:`_runTurn` 末尾那个 finally 照常 `releaseSlot()`(并发槽不漏),
      //   外层 finally 再调一次 reportDone 时 `reported` 已置位、早返,`release()` 照跑(群锁不卡)。
      //   加的 try **正反都绿、不可观测** —— 按本文件的先例(见下面 pulseTimer 那两段),
      //   不可观测且不必要的防御不留。⚠ 若哪天那两层 finally 被重构掉,这里就要重新审。
      if (errText) this.log(`group ${job.msg.chatId}: 轮次失败(${o.status})— ${errText}`)
      // Arm the hard-release ceiling: the work is done; if the process won't close within
      // the grace, force-release so the group never bricks (the runner promise, if it ever
      // resolves, hits the `released` guard).
      // ⚠ 锁**已经**释放了就别再武装(v0.11.46):`/stop`/`/new` 走 forceRelease 时,runner 往往
      //   晚一步才 resolve,reportDone 于是在 release 之后才跑 —— 那时再挂一个 hardReleaseMs 的
      //   定时器,既没有锁可救(release 里 `released` 已置位、回调进去就原地返回),又没人再来
      //   clearTimeout(release 只在第一次执行时清)。结果是一个纯粹空转的残留定时器。
      //   生产上无害(daemon 长期运行、回调是 no-op),但它会把 `node --test` 拖住整整一个
      //   hardReleaseMs 才退出 —— 本文件一度因此从 16 秒变成 121 秒。
      // ⚠ **这个 `!released` 没有直接的单测**:残留定时器只能从「进程多久才退」上观察,写不出
      //   有分辨力的断言(硬编时长的测试比没有更糟)。判据留在这儿:engine.test.js 的挂钟时间
      //   若突然涨到接近某个 hardReleaseMs 的整数倍,先回来看这一行。别因为没测试就删它。
      if (!hardTimer && !released && this.hardReleaseMs > 0) hardTimer = setTimeout(() => { this.log(`group ${job.msg.chatId}: lock force-released — process did not close in ${this.hardReleaseMs}ms`); release() }, this.hardReleaseMs)
    }
    // 额度临时切换的落实点(v0.11.107):切换 / 切回只在两轮之间做 —— 换后端必须清会话,轮中清会把正在跑的
    // 那轮的会话 id 落进下一个后端的 --resume。放在这里(锁已拿、轮还没起)正是「两轮之间」。
    // ⚠ 它是**同步**的(零 await):这里到 controller 建好之间不能有异步点,否则 /stop · 中断 · 关停都够不着这一轮。
    // ⚠ 绝不能让它弄死一轮:store 抛错吞掉,最多是这一轮没切。
    try { this._settleFailover(rt, job) } catch (e) { this.log(`group ${job.msg.chatId}: failover settle failed (ignored): ${e && e.message}`) }
    let outcome = { status: 'failed' }
    try {
      outcome = (await this._runTurn(job, reportDone)) || outcome // never let a null return through
    } finally {
      reportDone(outcome) // fallback: abort/throw never reached the result event
      if (outcome && outcome.status === 'empty') this._retryEmpty(rt, job, outcome, released)
      // 续接的会话记录已不在 ⇒ 换新会话重做(早返与 _retryEmpty 同款)
      else if (outcome && outcome.status === 'error' && outcome.sessionGone) this._retrySessionGone(rt, job, released)
      // 额度 / 账号类失败 ⇒ 切备用模型(并在能重做时把这条插回队首)。与 _retryEmpty 同一位置、同一套早返。
      else if (outcome && outcome.status === 'error' && outcome.quota) { try { this._failoverAfterError(rt, job, outcome, released) } catch (e) { this.log(`group ${job.msg.chatId}: failover after error failed (ignored): ${e && e.message}`) } }
      release()
    }
  }

  // 空轮(零产出)之后怎么办 —— 派发层的唯一决策点(v0.11.24 同会话重试一次;v0.11.103 加换会话重做)。
  // 零产出 ⇒ 模型没做任何事,消息还在,重跑几乎不花钱;但**在哪段会话里重跑**要分两种:
  //   · 同会话重试(原有):偶发空转(典型 = 上一轮的后台命令被收掉,CLI 续接时先塞一条完成通知)。
  //   · 换新会话重做(新增):会话本身接不上了 —— 上一轮被掐断过(store.tainted,见 store.markTainted
  //     的注释),或续接旧会话连空两次。2026-09-15 某项目实证:掐掉一个起过两个后台子任务的轮,
  //     之后每次 --resume CLI 都先塞它们的完成通知、模型答「不需要回复」退出,三条真人消息全空转,
  //     同会话重试同样空,直到有人 /new。这种形状下再试同会话是确定性徒劳,直接换会话;群里说一句
  //     为什么(丢的是聊天上下文,群成员得知道),项目的长期约定与积累在磁盘上不受影响。
  // 插回**队首**而不是直接 _dispatch —— release() 紧接着就会出队,直接派会和它抢同一把群锁开两轮。
  // 走队列还顺带获得两个既有行为:期间新到的消息与它合并(与正常排队同路)、群若已暂停则连重试
  // 一起丢弃(暂停就该真停)。三个标记各只加一次,故同会话最多重试一次、换会话最多一次。
  // ⚠ 重试用完仍空才出声(T.emptyTurn),而且在**这里**出声不在 finalizeTurn 里:那边只知道
  //   「本轮空了」,不知道还有没有下一次机会;两处各判一份就是「说了两次 / 一次没说」的来源。
  // ⚠ 换会话只对**续接的**会话做:新开的会话也空,清了它没有任何意义。
  _retryEmpty(rt, job, outcome, released) {
    const chatId = job.msg.chatId
    // 三道早返(审查逮到,都是「先说要重做、然后什么都不发生」或「停了却重做」的形状):
    //   · /stop 落在「result 已空、进程未 close」的窗口:队列已清、stopRequested 还没被 release 重置 ⇒ 用户说的是全都别做了;
    //   · 锁已被 forceRelease 释放:runner 迟到 resolve,此刻 unshift 的重试没人派发(release 早跑过),滞留到下一轮才出队;
    //   · 群已暂停:release 会把队列整个丢掉,出声与清会话就都成了空话 —— 暂停的口径是彻底静默。
    if (rt.stopRequested || released) { this.log(`group ${chatId}: empty turn after stop/release — not retried`); return }
    const g = this._resolveGroup(chatId)
    if (g && g.paused) { this.log(`group ${chatId}: empty turn on a paused group — not retried`); return }
    // 标记只对**续接的**会话有意义:新开会话空了与上一段会话被掐无关(标记可能是迟到的中止收尾在 /new 之后打的)
    const tainted = !!outcome.resumed && !!(this.store.isTainted && this.store.isTainted(chatId))
    const hasSession = !!this.store.getSession(chatId)
    const say = (text) => { if (job.msg.quiet) return; Promise.resolve(job.platform.reply(job.msg.replyCtx, text)).catch(() => {}) }
    if (!job.emptyRetried && !tainted) {
      this.log(`group ${chatId}: empty turn (nothing produced) — retrying once`)
      // firstResumed:第一次空的是不是续接会话 —— 决定重试再空时还有没有「换会话」这一步
      this._enqueue(rt, { ...job, emptyRetried: true, firstResumed: !!outcome.resumed }, { front: true })
      return
    }
    if (!job.freshRetried && hasSession && outcome.resumed && (tainted || job.firstResumed)) {
      this.log(`group ${chatId}: empty turn on a ${tainted ? 'tainted (interrupted)' : 'resumed'} session — retrying in a fresh session`)
      this._freshSession(chatId)
      say(T.freshRetry)
      this._enqueue(rt, { ...job, emptyRetried: true, freshRetried: true }, { front: true })
      return
    }
    say(T.emptyTurn)
  }

  // 续接的会话在 CLI 那边已经没了(runner 标 sessionGone;典型是 Claude Code 默认清掉 30 天没动过的会话记录)。
  // 不处理的话死 id 一直留在 store 里,这个群之后每条消息都去续接它、条条报错,直到有人 /new。这种错 CLI 在
  // 起步就退出、什么都没做,所以换新会话把这条重做一次;群里说一句为什么(丢的是聊天上下文)。出错卡已在
  // finalize 里撤掉(只剩 ack 时),重做成功群成员看到的就是这句 + 答案。最多一次:新会话不续接,不会再报这个错。
  _retrySessionGone(rt, job, released) {
    const chatId = job.msg.chatId
    if (job.freshRetried) return
    if (rt.stopRequested || released) { this.log(`group ${chatId}: session gone after stop/release — not retried`); return }
    const g = this._resolveGroup(chatId)
    if (g && g.paused) return
    this.log(`group ${chatId}: resumed session no longer exists — retrying in a fresh session`)
    this._freshSession(chatId)
    if (!job.msg.quiet) Promise.resolve(job.platform.reply(job.msg.replyCtx, T.sessionGone)).catch(() => {})
    this._enqueue(rt, { ...job, freshRetried: true }, { front: true })
  }

  // ===== 额度自动切换(v0.11.107)=====
  // 配置:`providers.<主模型>.fallback = "<备用模型名>"`。主模型额度用完 / 账号不可用 ⇒ 切到备用;额度到点重置
  // (或探针探到恢复)⇒ 切回。两条触发腿:① 出错轮(runner 标 result.quota)—— 事后切,能重做就把那条插回队首;
  // ② bin 每轮结算后把额度窗口喂进 noteQuota —— 用到 95% 就在**下一轮开始前**切,不等撞上限。
  // 切换 = 运行时覆盖 + 落盘记录 + 清会话,**只在两轮之间做**(_settleFailover 在派发层拿到锁之后、起轮之前)。
  // ⚠ 派发层这两处(_settleFailover · _failoverAfterError)**一个 await 都不许有**:拿到锁到 controller 建好之间此前
  //    没有任何异步点,/stop(看 controller)· 关停(abort controller)· 中断(forceRelease)都默认这段是原子的;
  //    第一版在这里 await 过探针,审查实测 /stop 在那 300ms 里回「没有正在运行的任务」、中断后轮照起、同群两轮并发。
  //    所以探针一律放后台(_probeHomeLater),结果只落成「下一轮前切回」的 pending —— 切回因此晚一轮,可接受。
  // ⚠ 人用 /model · 控制台切模型 ⇒ 记录作废(store.setProvider 连带清),引擎不再自作主张切回。
  // ⚠ 备用模型自己也标了「没额度」就不切(09-28 真机:claude 周额度用完切 codex,codex 当天也撞上限;
  //    两边都没额度时来回切、每轮清会话,是最糟的形状)。标过期 ≠ 恢复:切回前要探过(没探针才按时间信)。
  // core 只认结构化字段:result.quota(runner 判)· quotaStatus(bin 注入)· cfg.providers[*].fallback —— 不认 runner 名;错误原话只透传给
  // 运维告警事件的 detail(进日志不进群,opsalert 不打印它)与账本,判定从不读它。

  // 主模型 name 配的备用 ⇒ 名字 | null。指到自己 / 不存在 / 标了 hidden 的都当没配:hidden 是 operator 说
  // 「别在界面上给人选」(/model 也不列它),自动切过去等于替他选了一个他撤下的;doctor 对这三种各报一行 warn。
  _alert(ev) {
    if (!this.onAlert) return
    try { this.onAlert(ev) } catch (e) { this.log(`ops alert hook failed (ignored): ${e && e.message}`) }
  }

  _fallbackFor(name) {
    const p = (this.cfg.providers || {})[name]
    const to = p && typeof p.fallback === 'string' ? p.fallback.trim() : ''
    if (!to || to === name) return null
    const t = (this.cfg.providers || {})[to]
    return t && !t.hidden ? to : null
  }

  // store 有没有这组接口:生产 StateStore 必有;单测与 CLI 试跑用的 mock store 可能只实现了老接口 ⇒ 整条切换路静默不做,
  // 而不是在派发层抛 TypeError 把轮次弄死(这条路挂在 finally 里,抛了就是群锁卡死)。
  _hasFailoverStore() { return !!(this.store.getFailover && this.store.setFailover && this.store.clearFailover) }

  // /status 与 /hud 共用的那一行(两处各拼一份必漂):有记录才有这一行,额度类带「约 N 后切回」
  _failoverLine(chatId) {
    const rec = this._hasFailoverStore() ? this.store.getFailover(chatId) : null
    return rec ? T.failoverLine(rec.to, rec.home, rec.kind, rec.kind === 'quota' ? humanReset(rec.until - Date.now()) : '') : ''
  }

  _currentName(chatId) { return this._resolveProvider(chatId, this._resolveGroup(chatId) || {}).name }

  // 主模型 name 不可用时挑备用 ⇒ { to, home } | null。home = 配置里的模型(已在临时切换中则沿用记录里的 home)。
  _pickFailover(chatId, name) {
    const rec = this.store.getFailover(chatId)
    const g = this._resolveGroup(chatId)
    const home = rec ? rec.home : ((g && g.provider) || this.cfg.defaultProvider)
    const to = this._fallbackFor(name)
    if (!to || to === name) return null
    if (this.store.isExhausted && this.store.isExhausted(to)) return null
    return { to, home }
  }

  // 落实一次切换:记录 + 覆盖 + 清会话,三件一起(少一件就是半状态)。to === home ⇒ 这是切回:清记录、跟随配置。
  _applyFailover(chatId, { from, to, home, kind, until }) {
    if (to === home) this.store.clearFailover(chatId)
    else this.store.setFailover(chatId, { home, from, to, kind, until: typeof until === 'number' ? until : null, at: Date.now() })
    this._freshSession(chatId)
    this.log(`group ${chatId}: failover ${from} → ${to}(${kind}${typeof until === 'number' ? ' · until ' + new Date(until).toISOString() : ''})`)
    this._alert({ kind: 'failover', chatId, from, to, home, cause: kind, until: typeof until === 'number' ? until : null, back: to === home })
  }

  // 切换的群面通知。切换是**群级**状态变更(下一条真人消息就跑在另一个模型上、上下文没了),不是触发它的那条消息的
  // 产出 ⇒ quiet 插话触发的也要说,只是不挂在那条无痕消息上(走 send);平台没有 send 就只能不说。
  _sayFailover(job, text) {
    const p = job.platform
    let pr = null
    try { pr = job.msg.quiet ? (p && p.send ? p.send(job.msg.chatId, text) : null) : p.reply(job.msg.replyCtx, text) } catch { pr = null }
    return Promise.resolve(pr).catch(() => {})
  }

  // 探针结果 → 主模型能不能切回。null / 没有窗口数据 = **没探到**(接口抖动 / 形状变了),不是「全退下去了」:
  // 额度类按时间信(到点就切回),账号类只能再等。ok:false = 连登录态都没有 ⇒ 不切回。
  _homeVerdict(s, timed) {
    if (!s) return { back: timed, hot: null }
    if (s.ok === false) return { back: false, hot: null }
    const wins = Array.isArray(s.windows) ? s.windows.filter((w) => w && typeof w.percent === 'number') : []
    if (!wins.length) return { back: timed, hot: null }
    const hot = wins.filter((w) => w.percent >= QUOTA_FAILOVER_AT).sort((a, b) => (b.resetsAt || 0) - (a.resetsAt || 0))[0] || null
    return { back: !hot, hot }
  }

  // 后台探主模型(零等待):派发层从不等它;结果只落成「下一轮前切回」的 pending,或把下次再看的时刻往后挪。
  // 同群同时只起一个;探前先记 checkedAt,探针抛了也不至于每轮都起一次。记录在探的期间被换掉(人切了 / 已切回)⇒ 结果作废。
  _probeHomeLater(chatId, rec) {
    const rt = this._rt(chatId)
    if (!this.quotaStatus || rt.failoverProbing) return
    rt.failoverProbing = true
    // touch 自己吞错:它在 Promise 链外也调一次(下面那行),同步抛了会把 failoverProbing 永远卡在 true ⇒ 这群再也不探、再也不切回
    const touch = (patch) => { try { if (this.store.touchFailover) this.store.touchFailover(chatId, patch) } catch (e) { this.log(`group ${chatId}: failover probe settle failed (ignored): ${e && e.message}`) } }
    touch({ checkedAt: Date.now() })
    Promise.resolve().then(() => this.quotaStatus(rec.home)).catch(() => null).then((s) => {
      rt.failoverProbing = false
      const cur = this.store.getFailover(chatId)
      if (!cur || cur.at !== rec.at) return
      const timed = typeof rec.until === 'number'
      const v = this._homeVerdict(s, timed)
      if (v.back) { rt.pendingFailover = { from: rec.to, to: rec.home, home: rec.home, kind: rec.kind, until: null, back: true }; return }
      // 额度类吸收探针给的重置时刻(含原话里解不出、until 还是 null 的那种 —— 不然它永远按 30 分钟盲探);账号类没有重置时刻可吸收
      if (rec.kind === 'quota') touch({ until: v.hot && typeof v.hot.resetsAt === 'number' && v.hot.resetsAt > Date.now() ? v.hot.resetsAt : Date.now() + FAILOVER_PROBE_MS })
    }).catch((e) => { rt.failoverProbing = false; this.log(`group ${chatId}: failover probe settle failed (ignored): ${e && e.message}`) }) // touch → 落盘抛了不能变成 unhandled rejection 把 daemon 带走
  }

  // 出错轮之后(派发层 finally,锁还没松;**同步**):标主模型不可用 → 挑备用 → 切 → 这条没动过手就插回队首在新模型上重做。
  _failoverAfterError(rt, job, outcome, released) {
    if (!this._hasFailoverStore()) return
    const chatId = job.msg.chatId
    const q = outcome.quota
    const name = outcome.provider || this._currentName(chatId)
    const now = Date.now()
    // 重置时刻只从原话里解(解不出 = 不知道,切回交给后台探针);账号类没有重置时刻(要人处理)。不在这里 await 探针。
    const until = q.kind === 'quota' ? parseResetAt(outcome.errText, { now, tz: this.tz }) : null
    if (this.store.markExhausted) this.store.markExhausted(name, { until, kind: q.kind }, now)
    // 运维告警:故障已经发生,下面不管切不切都要让 operator 知道(没配备用的群尤其 —— 那是它唯一的出声渠道)
    this._alert({ kind: 'provider-down', provider: name, cause: q.kind, window: q.window || null, until, chatId, source: 'turn', detail: outcome.errText || '' })
    // 三道早返与 _retryEmpty 同款:停了 / 锁已被强制释放 / 群已暂停 ⇒ 不切也不重做
    if (rt.stopRequested || released) { this.log(`group ${chatId}: quota error after stop/release — no failover`); return }
    const g = this._resolveGroup(chatId)
    if (g && g.paused) return
    const why = T.failoverWhy(q.kind, q.window)
    const when = q.kind === 'quota' ? humanReset(until - now) : ''
    const pick = this._pickFailover(chatId, name)
    // 备用死了而主模型的标恰好过期 ⇒ pick.to === home:过期 ≠ 恢复,有探针就先探(结果落到下一轮前),不当场切回去重做
    const needVerify = !!(pick && pick.to === pick.home && this.quotaStatus)
    if (!pick || needVerify) {
      // 配了备用但眼下用不了 ⇒ 说清为什么只能等;没配备用 ⇒ 出错卡已经说了,这里不再多一句
      if (this._fallbackFor(name)) this._sayFailover(job, T.failoverNoTarget(why, when))
      const rec = this.store.getFailover(chatId)
      if (needVerify && rec) this._probeHomeLater(chatId, rec)
      return
    }
    this._applyFailover(chatId, { from: name, to: pick.to, home: pick.home, kind: q.kind, until })
    // 重做判据:这条还没被切换过(最多重做一次,免得备用也出错时来回)+ 这轮没动过手(副作用不做第二遍)
    const redo = !job.failedOver && !outcome.sideEffects
    const back = pick.to === pick.home ? '' : T.failoverBackWhen(pick.home, when)
    this._sayFailover(job, T.failoverSwitched(why, pick.to, back, redo) + (!redo && !job.msg.synthetic ? '\n' + T.failoverRedoHint : ''))
    if (redo) this._enqueue(rt, { ...job, failedOver: true }, { front: true })
  }

  // bin 每轮结算后(节流)把某模型的额度窗口交进来:{ ok, windows:[{kind, percent, resetsAt}] }。core 只判定:
  // 用到阈值 / 登录态没了 ⇒ 标不可用 + 给所有正用它的群排一次「下一轮前切备用」;窗口都退下去了 ⇒ 清不可用标。
  // ⚠ 没有窗口数据 = 没探到,什么都不动(清标要有「真退下去了」的证据)。不动会话、不发消息 —— 切换只在两轮之间做。
  noteQuota(name, status) {
    if (!this._hasFailoverStore() || !status || !name) return
    const now = Date.now()
    const wins = Array.isArray(status.windows) ? status.windows.filter((w) => w && typeof w.percent === 'number') : []
    if (status.ok !== false && !wins.length) return
    const hot = wins.filter((w) => w.percent >= QUOTA_FAILOVER_AT).sort((a, b) => (b.resetsAt || 0) - (a.resetsAt || 0))[0]
    const kind = status.ok === false ? 'account' : (hot ? 'quota' : null)
    if (!kind) {
      // 之前标过不可用、现在探到退下去了 ⇒ 清标 + 告警群说一句「已恢复」(没标过就什么都不说:平时每 5 分钟都走这里)。
      // ⚠ 用 clearExhausted 的返回值判「之前有没有标」,不能用 getExhausted:额度类的标带 until,窗口一过它就返回 null,
      //    「已恢复」就永远发不出(审查逮到)。
      const had = this.store.clearExhausted ? this.store.clearExhausted(name) === true : false
      if (had) this._alert({ kind: 'provider-up', provider: name })
      return
    }
    const until = kind === 'quota' && typeof hot.resetsAt === 'number' && hot.resetsAt > now ? hot.resetsAt : null
    if (this.store.markExhausted) this.store.markExhausted(name, { until, kind }, now)
    this._alert({ kind: 'provider-down', provider: name, cause: kind, window: hot ? hot.kind : null, until, source: 'probe' })
    for (const [chatId, g] of Object.entries(this.cfg.groups || {})) {
      if (!g || g.paused) continue
      if (this._resolveProvider(chatId, g).name !== name) continue
      const pick = this._pickFailover(chatId, name)
      if (!pick) continue
      const rt = this._rt(chatId)
      if (rt.pendingFailover && rt.pendingFailover.to === pick.to) continue
      rt.pendingFailover = { from: name, to: pick.to, home: pick.home, kind, until, window: kind === 'quota' ? hot.kind : null }
      this.log(`group ${chatId}: ${name} ${kind === 'account' ? '账号不可用' : `额度已用 ${Math.round(hot.percent)}%`} ⇒ 下一轮开始前切到 ${pick.to}`)
    }
  }

  // 两轮之间的落实点(派发层拿到锁、起轮之前;**同步,零 await**):① 排着的 pending(切备用 / 切回)就落实并告知;
  // ② 处于临时切换中且到点 / 到了该探的时候 ⇒ 有探针就后台探一次(结果下一轮前落实),没探针:额度类按时间切回,账号类只能等人。
  _settleFailover(rt, job) {
    if (!this._hasFailoverStore()) return
    const chatId = job.msg.chatId
    const now = Date.now()
    const pend = rt.pendingFailover
    if (pend) {
      rt.pendingFailover = null
      const cur = this._currentName(chatId)
      if (cur === pend.from && pend.to !== cur && !(this.store.isExhausted && this.store.isExhausted(pend.to))) {
        this._applyFailover(chatId, pend)
        if (pend.back) {
          if (this.store.clearExhausted) this.store.clearExhausted(pend.home)
          this._sayFailover(job, T.failoverBack(this._currentName(chatId))) // 切回后实际跟随的是**现在**的配置(期间可能被手改过)
        } else {
          const back = pend.to === pend.home ? '' : T.failoverBackWhen(pend.home, pend.kind === 'quota' ? humanReset(pend.until - now) : '')
          this._sayFailover(job, T.failoverSwitched(T.failoverWhy(pend.kind, pend.window), pend.to, back, false))
        }
        return
      }
    }
    const rec = this.store.getFailover(chatId)
    if (!rec) {
      // 跨群预判:别的群已经撞出「这个模型眼下不可用」的标(账号类尤其 —— 一个账号三个群,不预判就是三次失败轮 +
      // 三张错误卡),这群下一轮还没起就直接切过去,不再白跑一轮。只认落盘的 exhausted 标,备用也标了就不切(与出错路同判据)。
      const name = this._currentName(chatId)
      const ex = this.store.getExhausted ? this.store.getExhausted(name, now) : null
      if (!ex) return
      const pick = this._pickFailover(chatId, name)
      if (!pick) return
      this._applyFailover(chatId, { from: name, to: pick.to, home: pick.home, kind: ex.kind, until: ex.until })
      const back = pick.to === pick.home ? '' : T.failoverBackWhen(pick.home, ex.kind === 'quota' && typeof ex.until === 'number' ? humanReset(ex.until - now) : '')
      this._sayFailover(job, T.failoverSwitched(T.failoverWhy(ex.kind, null), pick.to, back, false))
      return
    }
    const timed = typeof rec.until === 'number'
    const due = timed ? now >= rec.until : (now - (rec.checkedAt || rec.at || 0) >= FAILOVER_PROBE_MS)
    if (!due) return
    if (this.quotaStatus) { this._probeHomeLater(chatId, rec); return }
    if (!timed) return // 账号类且没探针:只能等人来切
    if (this.store.clearExhausted) this.store.clearExhausted(rec.home)
    this._applyFailover(chatId, { from: rec.to, to: rec.home, home: rec.home, kind: rec.kind, until: null })
    this._sayFailover(job, T.failoverBack(this._currentName(chatId)))
  }

  // Self-knowledge manifest (群项目基础能力): a compact "who you are + current capabilities"
  // block, prepended to the FIRST turn's prompt. Kept in sync with config — base skills always
  // listed; enabled plugins/skills reflect the group's current gating, so as the plugin library
  // grows the agent's self-view updates too. Backend-agnostic (goes via the prompt/stdin).
  // 本轮真会加载的 MCP 名单。codex 的 MCP 全局生效(config.toml,无按群子集开关)—— 群配置里
  // 没有,经注入的读取器如实列出;claude 走群卡勾选。**清单与 /help 共用**:两处各算一份
  // 必漂移(生图那条已经踩过一次)。
  _mcpNames(group, isCodex) {
    if (isCodex) return (this.codexMcp && this.codexMcp()) || []
    const mcp = (group.plugins || {}).mcp
    return Array.isArray(mcp) ? mcp : []
  }

  // 群里能不能「打开网页看看」:浏览器是 chrome-devtools MCP 提供的(用户级/项目级都算)。
  // 本群这一轮真会带上的插件名(用户级按群勾选 + 项目级 .mcp.json;codex 走全局)。/help 的「插件」行
  // 与浏览器判据都从这里取 —— 一份名单两个消费者,不各算一份。
  _pluginNames(group, provider) {
    const isCodex = !!(provider && provider.runner === 'codex')
    return [...this._mcpNames(group, isCodex), ...((!isCodex && this.projectMcp) ? (this.projectMcp(group.workdir) || []) : [])]
  }

  _hasBrowser(group, provider) {
    return this._pluginNames(group, provider).some((n) => /chrome|browser|playwright|puppeteer/i.test(String(n)))
  }

  _buildManifest(msg, group, providerName, provider, platform = null) {
    // 产品在群成员面前叫什么。走顶层 `brand` 配置,不写 = SintBot。
    // ⚠ 抽成配置而不是写死:同一个字符串在不同部署下有不同的正确答案,只能由配置决定。
    const brand = (this.cfg && this.cfg.brand) || 'SintBot'
    const isCodex = provider && provider.runner === 'codex'
    // 平台自描述(core 不认识任何平台名,只读这几个字段):skillCmd = 基础技能命令名(清单末尾整体替换);
    // features.<x> === false = 该平台没有这项能力,对应那几行不教(教了 agent 就会去调一个不存在的动作);
    // mediaMarker:'path' = 入站图片 / 文件已由平台落盘、标记里给的是本机路径,不是「先下载」的坐标。
    const feat = (k) => !(platform && platform.features && platform.features[k] === false)
    const mediaByPath = !!(platform && platform.features && platform.features.mediaMarker === 'path')
    const skillCmd = (platform && platform.skillCmd) || 'sbot feishu'
    const chatLabel = (platform && platform.chatLabel) || '飞书群'
    const platformName = chatLabel.replace(/群$/, '') // 「飞书群」→「飞书」,用在「飞书收发」这类短语里
    const model = group.model || (provider && provider.model) || ''
    const full = group.permissionMode === 'bypassPermissions'
    const perm = group.permissionMode === 'bypassPermissions'
      ? '完全访问(可执行任意命令)'
      : isCodex ? '只读(codex 沙箱 — 不能联网/改文件;基础技能〔' + platformName + '收发 / 定时任务 / 设计风格档〕需该群设为完全访问才可用)'
      : (group.allowedTools && group.allowedTools.length) ? '白名单(受限工具集)'
      : '只读(缺省 fail-closed)'
    const L = []
    L.push(`【你是 ${brand}】一个从${chatLabel}驱动的编码助手,背后模型可换,正在为绑定本群的项目工作。以下是你当前的处境与能力(自我认知,非用户消息):`)
    L.push(`· 群:${group.name || msg.chatId}(${msg.chatId})`)
    L.push(`· 项目目录:${group.workdir || '(未设)'}`)
    // 代码仓库(可空):控制台已把 workdir 关联到该 origin。远端常是新建的空仓库 —— 场景是把
    // 本地项目推上去,推什么/怎么写 commit 由你判断(编排层不替你拍板)。这里报的是项目目录的
    // 真实关联状态(读 .git/config,与控制台「仓库」徽章同源),不是回显配置 —— 让 agent 心里有数。
    if (group.repo) {
      const info = (this.repoInfo && this.repoInfo(group.workdir, group.repo)) || null
      const state = info && info.state
      let line = `· 代码仓库(origin):${group.repo}`
      if (state === 'missing') line += ' — ⚠ 项目目录还没设 origin(未 git init 或未加 remote),首次 git 操作前先:git init(如需) && git remote add origin ' + group.repo
      else if (state === 'drift') line += `;⚠ 但项目目录当前 origin 与此不一致(实际是 ${info.origin || '未知'})—— 以哪个为准请先问用户,别擅自改 remote`
      else line += ' — 项目目录已关联好,可直接 git 操作' // 'ok' 或无 repoInfo(CLI 无 git 读取器)
      line += ';远端若是空仓库,首次推送用 git push -u origin <当前分支>'
      L.push(line)
      // push 可行性如实告知:只有完全访问(claude Bash(*) / codex danger-full-access),或 claude 白名单
      // 里显式放行了 git push,才推得动。只读 / 开发档(deny 了 git push)/ codex 只读都会被拒 —— 提前
      // 说清,免得 agent 照着推却被拦、还反复重试(控制台群卡也对 operator 标了同一个坑)。
      const pushAllowed = full || (!isCodex && (group.allowedTools || []).some((r) => r === 'Bash(*)' || /^Bash\(git (push|\*)/.test(r)))
      const pushDenied = !pushAllowed || (group.disallowedTools || []).some((r) => /^Bash\(git push/.test(r))
      if (pushDenied) L.push('  ⚠ 当前执行权限不放行 git push(会被拒)—— 本地 commit 照做,需要推送时请提示用户在控制台放开权限,别反复重试')
    }
    L.push(`· 当前模型:${providerName}${model ? ' · ' + model : ''}`)
    // 纯文本模型(provider 标 vision:false):图片根本到不了模型 —— strip-proxy(DESIGN §4.3)把每个
    // 图片块换成占位文本。不明说的话 agent 会照常"看图"(截图确认、Read 截图文件、等工具返图),
    // 全是白跑还自以为看过了。把这条写进自我认知,比让它撞一次墙便宜。
    if (provider && provider.vision === false) {
      L.push('  ⚠ 本模型没有识图能力:任何图片(群里发的图、Read 的图片文件、工具返回的截图)到你这里都会被自动换成一句占位文本 —— 你看不到图像内容,别假装看到了。需要图里的信息就在群里请人用文字描述;给人看的图照常存文件发群即可(那是给人看的,不经你的眼睛)')
    }
    L.push(`· 执行权限:${perm}`)
    // 只写"约定"不写当前钟点 —— 清单指纹要跨轮稳定,钟点放每条消息的 [时间 发送者] 前缀里
    L.push(`· 时间口径:一切时间表述一律用 ${this.tz}${this.tz === 'Asia/Shanghai' ? '(北京时间)' : ''};每条用户消息的 [时间 发送者] 前缀即该时区的收到时间,以最新一条为当前时间参考,不要用其它时区报时间`)
    // ⚠ 措辞踩过一次(2026-07-30 真机):这行原来写「运维配置用,群成员一般用不到」= 等于劝它别碰,
    // 于是群里让它「看控制台/截图控制台」时,它反过来要求用户去 Chrome 里连浏览器扩展 —— 而它自己
    // 就跑在这台机器上、手里还有常驻浏览器。给地址不等于给了「你可以自己去看」的授权,得明写。
    // 配了公网地址就先给它(v0.11.72 起的入口;此前这行只给局域网 IP —— 群成员问「控制台在哪」拿到的是
    // 出了局域网就打不开、还要密码的地址,而公网入口只认飞书登录),局域网地址退居第二段。
    // ⚠ 「局域网内 …(密码登录)」只在真绑了局域网地址时说:环回绑定(127.0.0.1)时 uiUrl 就是环回地址,
    //   既不是局域网能到的,也不要密码 —— 照写就是两句假话。agent 自查另有 uiLocalUrl,这里不重复。
    const lanUrl = this.uiUrl && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(this.uiUrl) ? this.uiUrl : ''
    if (this.publicUrl) L.push(`· 控制台:${this.publicUrl}(公网,飞书账号登录、只放行管理员名单)${lanUrl ? `;局域网内 ${lanUrl}(密码登录)` : ''}`)
    else if (this.uiUrl) L.push(`· 控制台:${this.uiUrl}(给人用的地址,对外需密码登录)`)
    // 【这个项目的长期记忆】跨模型记忆交接。⭐ 缺的不是能力是**可达** —— 够得着的群那些
    // markdown 本来就读得到,只是没人告诉过它。所以这里给的是坐标与规矩,不搬运任何内容。
    // ⚠ 探测式:项目里没有(或这一轮给不出去)时**一个字都不出现**(清单每轮都付 token)。
    // ⚠ 门控与落点的裁决**不在这里** —— 「哪个 runner 会自动加载哪份档」「文件工具被围在哪」
    //   都是具体 agent 的行为知识,core 不该知道;读取器收下 {full,isCodex} 后返回已经裁决好的
    //   结果,这里只负责打印。**控制台切模型的群内通知调的是同一个读取器**,两处不可能再分叉
    //   (它们分叉过一次:群里说「都还在」而清单一个字没给 —— 教训 26/35 家族)。
    // ⚠ 条数走档位不走精确值:清单指纹要跨轮稳定(见 projectmemory.js 的 countBucket)。
    const pmem = this.projectMemory ? this.projectMemory(group.workdir, { full, isCodex }) : null
    if (pmem) {
      const seg = []
      if (pmem.landing) seg.push(`· 项目约定:${pmem.convention.join('、')}(项目根)—— 这是本项目的规矩,不是可选参考`)
      if (pmem.memory) seg.push(`· 长期记忆:${pmem.memory.dir}(${pmem.memory.bucket}${pmem.memory.index ? `,先读 ${pmem.memory.index} 索引再按需读具体条目` : ''})`)
      // 单一落点(教训 26 家族):claude 侧框架会自动往私有记忆写,codex 不会 ⇒ 同一件事容易两处
      // 各一份、且换脑后只有项目文件一定被人读到。故凡跨会话要用的结论一律钉在项目约定文件上。
      if (pmem.landing) seg.push(`· ⚠ 凡**跨会话还要用得上**的结论(进度、口径、踩过的坑),落点是 ${pmem.landing} 里的交接段落 —— 长期记忆是一套框架私有的档案,换了模型大脑就没有东西会自动把它端上来`)
      // 只读(产品决定):格式规矩 codex 不熟,写坏了对面读到的就是垃圾。代价 = codex 的经验只沉淀
      // 在项目文件里 —— 有约定文件时明说落点,没有时**不劝它建**(不替用户往项目里新增文件)。
      if (pmem.memory && isCodex) seg.push(`· ⚠ 上面那个长期记忆目录**只读**:它由另一套框架按自己的格式维护,你不要往里写${pmem.landing ? `(要沉淀就写 ${pmem.landing})` : ''}`)
      // 读取器的契约是「这一轮给不出东西就返回 null」;这里再兜一层**只是不让标题孤零零地留下**,
      // 不是把门控策略再写一遍(重写策略正是刚刚收掉的那个分叉源)。
      if (seg.length) {
        L.push('【这个项目的长期记忆】跨会话的约定与经验存在下面这些地方 —— **会话开头不一定加载得到,上下文里没有就自己读一遍**:')
        for (const s of seg) L.push(s)
      }
    }
    // 对外表述(2026-07-30 产品决定):产品对群成员只有一个身份(`brand`) —— 下面那些 CLI 命令名、
    // 机器上的目录路径都是**实现细节**,是给你自己执行用的,不是对话内容。群里冒出 `sbot xxx`
    // 或 `/Users/…/.sbot/…` 只会让人看见脚手架,而且暴露机器布局。**只约束你说什么,不约束你做什么**:
    // 命令照调,路径照传;向人复述时换成人话(「预览」「风格库」「定时任务」)。
    L.push(`【对外怎么说】你在群里的身份就是 ${brand} 一个整体。**群消息里不要出现工具/命令名(sbot …、CLI 动作名)、也不要出现机器上的目录路径**(/Users/… 之类)—— 那些是你自己执行用的实现细节,不是对话内容。要指代就用人话:「预览」「风格库」「定时任务」「画布」。项目内的相对路径(如 design/xxx.png)可以说,那是用户项目里的东西。`)
    // 数据明文(v0.11.6):管理员显式开过的群,PII 出站不再被系统遮盖 —— 告知 agent 免得它
    // 自我审查或绕路(2026-08-04 真机:手机号被遮,agent 被要求改走截图);默认群不注入此行
    // (系统会兜底遮盖,agent 无需知道)。跟着指纹走:开关翻转 ⇒ 下轮重注入,不重置会话。
    if (group.redactPii === false) L.push('【数据输出】本群是内部数据群,管理员已设置:回复里的手机号/邮箱**原样输出,不要自行打码或省略**;密钥/凭据类(token、key、私钥)例外 —— 系统会自动遮盖,你也不该主动往群里贴。')
    // 【怎么回话】必须排在【基础技能】**之前**(v0.11.11)。此前只有一句加了括号的
    // 「(普通文字回复直接输出即可…)」压在一大段命令说明后面,权重完全不对等 ⇒ agent 形成了
    // 「要发群就 send-msg」的习惯,于是**答案发两遍**:自己 send-msg 一条纯文本,最终输出又被
    // finalize 进卡片(08-05 22:09 真机取证,两条内容逐句重合)。而纯文本消息不渲染 markdown,
    // 那条里的 `**3325 = …**` 在群里显示成字面星号 —— 规范说的「markdown renders here」只对
    // 卡片成立,这个落差不写明,agent 无从知道。
    // cardPinned:false 的平台(回复是普通消息、不是钉在轮次开头的卡片)换说法;plainSend:false 的平台 send-msg 本身就渲染 markdown。
    L.push(feat('cardPinned') ? '【怎么回话】你的正文输出**就是**群里的回复 —— 系统会自动把它渲染成一张卡片发出去,不需要用任何命令去「发」:' : '【怎么回话】你的正文输出**就是**群里的回复 —— 系统会自动把它作为一条消息发出去(markdown 会渲染),不需要用任何命令去「发」:')
    L.push('· 要对群里说的话 ⇒ **直接输出正文**;说完就结束本轮,**不要再用 send-msg 把同样的内容发一遍**(那会让群里同一个答案出现两次)')
    L.push('· send-msg 只用于两种场景:① 长任务跑到中途、有阶段性结果要先交代一声(是「这一段有结果了」,不是预告「我要去做了」)② 定时静默轮里主动发的通知')
    if (feat('plainSend')) L.push('· ⚠ send-msg 发的是**纯文本消息**:`**粗体**`、markdown 表格、代码块一律**不渲染**,会原样显示成星号和竖线 —— 要排版就走正文输出')
    else L.push('· send-msg 发的是 markdown 消息:粗体 / 列表 / 链接 / 行内代码会渲染;**表格与代码块不渲染**(系统会把表格改成列表、代码块改成逐行等宽,标题改成加粗行 —— 所以表格列数越少越好,代码块只放真代码)')
    if (feat('cardPinned')) L.push('· ⚠ **你的回复卡片钉在本轮开始的位置**:本轮中途发的图片/文件/消息在群里都排在它**下面**(哪怕你是先发图、后写这段文字)。指路要说「下面」或直接说「已发群里」,**别说「上面 👆」**')
    // 后台进程纪律(v0.11.108):轮次结束 claude 退出,它在后台起的 shell 不跟着退 —— 父进程没了就挂到
    // pid 1 下继续跑,而且自成进程组,runner 的树杀抓不到。真机:一条 `until …; do sleep 5; done` 每 5 秒
    // 打一次线上云函数跑了 35 天,零 CPU 零报错没人知道。围栏做不了(半可信 agent + 它确实偶尔需要
    // 后台),能做的是把纪律写明 + doctor / 控制台看得见(src/leftover.js)。浏览器那句同源:页用完不关,
    // 常驻浏览器里攒一堆闲置标签(10-09 看到 4 个,两个指向早停掉的预览端口)。静态文本,不嵌运行时状态。
    L.push('【后台进程与浏览器页】等外部就绪(端口起来 / 部署生效 / 文件出现)只许**前台有限次数**轮询 —— 比如最多 30 次、每次 sleep 几秒,到数就停下如实报「还没好」;**绝不起后台无限 until / while 循环、不 nohup 长跑**:本轮结束它不会跟着退,会一直跑到有人发现为止(曾有一条循环每 5 秒打一次线上接口跑了一个多月)。静态页面要常驻就走「预览」;其它服务本轮用完即停,长期需求在群里说明、交管理员处理。浏览器页面用完就关掉自己开的那一页,别在常驻浏览器里留一堆闲置标签。')
    const skillsAt = L.length // 没有基础技能命令的平台(features.skills === false)整段替换用(见这段末尾)
    L.push('【基础技能】用 `sbot feishu <动作>` 操作「当前群」(文件路径限项目目录内的相对路径):')
    // ⚠ 真机踩到(2026-07-29):agent 在 send-msg 的参数里写 `\n` 当换行,群里原样显示成字面反斜杠 n
    // ——与 Mermaid 标签那条同源的错误认知(以为 `\n` 到哪儿都是换行)。shell 双引号不解释转义。
    L.push('· 发送:send-file "<路径>" / send-image "<路径>" / send-msg "<文本>"')
    L.push('  ⚠ send-msg/reply/edit 的文本里**换行就直接敲真换行**(shell 里用 $\'第一行\\n第二行\' 或多行字符串),**别在双引号里写 `\\n`** —— 那会原样显示成字面的反斜杠 n')
    if (feat('history')) L.push(feat('editRecall') ? '· 读历史:history [条数]  →  每条含 {message_id},供下面按 id 操作' : '· 读历史:history [条数]  →  群里最近 7 天的发言(含没 @ 你的那些),带发言人与时间,用来补上下文')
    if (feat('editRecall')) L.push('· 回复:reply <message_id> "<文本>" · 编辑自己发的:edit <message_id> "<文本>" · 撤回自己发的:recall <message_id>')
    if (feat('download')) L.push('· 下载群文件/图片到项目目录:download <message_id> <file_key> <file|image> [目标路径]')
    // 附件标记(v0.11.7):图片/文件消息不再被丢弃,转成带坐标的文本标记进消息流 —— 教 agent
    // 顺着标记摸到内容,否则「我发给你的图」它永远接不住(真机踩过)。
    if (mediaByPath) L.push('· ⚠ 群消息里的图片/文件会以「[图片 path=…]」标记出现 —— 文件已经下载到那个路径,用户说「看这张图/这个文件」时直接读它(图片用能看图的工具打开);标记是给你的坐标,回复里别原样复述它。**群里单独发的图片 / 文件 / 视频**只在「刚被 @ 过 / 刚对话过的几分钟内」会推给你(夹在一句话里的图随时会),用户说「我发了个文件」而你没看到标记时,请对方把文件和一句话一起发、或在单聊里发')
    else L.push('· ⚠ 群消息里的图片/文件会以「[图片 message_id=… key=…]」标记出现(历史里同款)—— 用户说「看这张图/这个文件」时,先用标记里的两个值 download 下来再读文件;标记是给你的坐标,回复里别原样复述它')
    if (feat('react')) L.push('· 表情回应:react <message_id> <emoji>(如 THUMBSUP)')
    // ⚠ 用 splice 整段换、不给上面每行套 if:这段是热点文案,少碰它的行,合并时才不打架。
    // features.skills === false(如 Slack 适配器)= 这个平台连基础技能命令都没有 —— 不是少几个动作,是整组都调不通。
    if (!feat('skills')) L.splice(skillsAt, L.length - skillsAt,
      `【基础技能】本群在 ${platformName.trim()} 上:\`sbot feishu\` 的动作(发文件/发图/读历史/回复/编辑/撤回/下载/表情)**在本群一律不可用**,别调用 —— ${platformName.trim()} 侧的文件上下行还没接上`,
      '· 要给群成员看的产物(网页/截图/文件):存在项目目录里,**回复正文写清相对路径与打开方式**;下文凡说「sbot feishu send-file / send-image 发群」的地方,在本群都改成这么做',
      '· 群消息里的图片/文件会以「[图片 …]」标记出现,但 download 在本群同样不可用 —— 用户说「看这张图」时如实说明本群暂收不到附件内容,请对方贴成文字或说要点')
    L.push('【定时任务】用 `sbot cron` 给本群排期(时间按上面的时间口径,只作用于本群):')
    L.push('· 创建-到点触发你执行:sbot cron add "<cron>" --do "<到点让你做的事>"(像收到一条消息那样触发你,可查/改/报告)')
    L.push('· 创建-到点只发一条固定消息:sbot cron add "<cron>" --say "<文本>"(不触发你,纯提醒)')
    L.push('· 创建-到点直接跑一条命令:sbot cron add "<cron>" --run "<命令>"(在项目根执行,不触发你、不占用对话;退出码 0 只留日志,失败群里提示一句附输出末尾;加 --escalate 改为失败时交给你排查)—— 「跑脚本自己发报告、你只需确认退出码」这类任务一律用它,别用 --do 白白起一轮')
    L.push('· 一次性(只触发一次、触发后自动消失):sbot cron add --at "2026-07-16 13:10" --do/--say "..." —— 凡「某月某日只做一次」务必用 --at,别用 cron(cron 无年份会每年重复)')
    L.push('· 修改:sbot cron update <id> [--expr "<新cron>"|--at "<新日期时间>"] [--do/--say/--run "<新文本或命令>"] [--timeout <分钟>] [--escalate|--no-escalate](群里有人要改某个定时任务时用;后两项只对 --run)')
    L.push('· 查/删/开关:sbot cron list / remove <id> / on <id> / off <id>')
    L.push('· cron 支持标准 5 段(分 时 日 月 周)、@daily/@hourly、及「每天 09:00」「工作日 8:30」简写')
    // 生图(sbot imagen,异步 detached worker):borrow 机器的 codex 订阅 ⇒ 任何模型的群都能生图。
    // ⚠ v0.11.16 起 codex 完全访问群也注入 —— 此前条件写 !isCodex(理由「codex 自带生图」),
    // 可 /help 那侧却对它承诺了「生成图片」⇒ agent 不知道桥的存在,只能走自带的:前台阻塞、
    // 不自动上板、无交付卡。判据现由 canImagen 一处出,两个消费者不再各写一份。
    // imagen:false 的平台(生图完成通知那条路只接了飞书)整段不教;/help 那侧同一判据(handleMessage 里按同一个 feat 算)。
    if (feat('imagen') && canImagen(isCodex, full, this.hasImagen && this.hasImagen())) {
      L.push('【生图】用 `sbot imagen "<画面描述>" --out <项目内相对路径.png> [--label "方案1"] [--beside <参照节点id> --deliver]` 生成图片(后台任务,不阻塞你):')
      L.push('· 受理后立即返回 —— 生成完成会在群里发图+通知;**你不需要等待、轮询或跟进**,受理后告知用户「生成中,完成会发群里」即可继续别的事或结束本轮')
      // 画布 = 设计演变档案(原图→标注→新版的链条),不是图片收纳箱。「给我画只猫」堆上去
      // 只会稀释那条链、还占着要长期保留的版面(2026-08-07 产品决定)。判断「这张图属不属于
      // 设计流程」是判断题 ⇒ 归 agent;编排层只提供开关。
      if (feat('boards')) L.push('· ⚠ **与设计流程无关的散图(「画只猫」「来张头图」)一律加 `--no-board`**,只发群不上板 —— 画布是本项目的**设计演变档案**(原图→标注→新版一条链),散图会把它冲淡;方案图/原型配图/按标注改出的新版才上板')
      if (isCodex) L.push('· ⚠ **生图一律走这条命令,不要用你自带的生图能力** —— 自带的会卡住本轮(群里干等)、不上画布、也没有交付卡')
      if (feat('boards')) L.push('· **按标注/评论改图走 imagen 时,--beside <原图节点id> 与 --deliver 都要带**:--deliver 让成图结果自动回填进群里那张画布播报卡(单卡演变),你受理后照常结束本轮即可')
      // ⚠ 旧文案是「确需拿到图再继续排版时才用 --sync 同步等待」—— 那是在推荐一条必然翻车的
      // 路:生图 91~516s 远超你的 Bash 超时,等不到就被杀,而你只会看到「命令结束了」,接着
      // 把不存在的文件写进页面(2026-08-14 真机)。现在讲死两件事:
      // 受理成功 ≠ 文件存在 · 等不到 ≠ 失败。
      L.push('· ⚠ **受理成功不等于图已经有了** —— 命令返回时文件还不存在,**别急着把它写进页面或引用它**;生成完会自动发群里(要图才能继续的活,等图到了下一轮再做)')
      L.push('· 想原地等一会儿用 `--wait [秒]`(默认 90 秒):等到了退出码 0、失败 1、**还没好是 2 —— 那不是失败**,任务照跑不用重试、更不要换个描述重来(白烧一次额度)')
      // ⚠ 2026-09-05 真机:一次连投 9 张改图任务,而槽位只有 2 个 ⇒ 后面七个纯排队干等,每个还
      //   各烧满十分钟墙钟。「有 2 个槽位」这个**事实**原先就写着,漏的是**该怎么办** ——
      //   事实不等于可照做的动作,少了后半句它照样一次投一批。故把两半并进同一条,不另起一行
      //   重复陈述槽位数(同一事实两处各写一份必然漂移,本文件反复栽过)。
      L.push('· **同时只有 2 个生图槽位**:一次别投一大批 —— 第 3 个起只能排队干等,还会把槽位占死、别人的图也插不进来;**成系列的图一张一张来**(出一张、看对了再投下一张)。任务状态 `sbot imagen --list`')
      // ⚠ 同一次真机:同一张图**原样重投了 3 次**。失败卡上已经写明原因(要求里有做不到的硬条件),
      //   而重投时一个字没改 ⇒ 同一份输入换回同一个失败,每次再烧满一次十分钟。
      L.push('· ⚠ **失败了别原样重投** —— 同一份要求换回来的还是同一个失败,只是再烧十分钟;**先看失败卡上说的原因、按它改要求**(去掉做不到的硬条件、补上该给的参照图),改完再投')
      // 「喂给生图后端」是有边界的承诺:探测只看根 DESIGN.md 与退档位 design/DESIGN.md 两处
      // (bin 的 findStyleDoc),--out 自定义位置不在内 —— 措辞必须与实现严格一致,不能让 agent
      // 以为随便放哪的风格档都会自动生效。
      L.push("· 项目有风格档(根 `DESIGN.md`、退档位置 `design/DESIGN.md`,或 `design/styles/<用途>.md`)时,画面描述先对照它的色板/字体/Don'ts 写(这些位置的风格档会喂给生图后端 —— 多份时用 `--style <用途>` 指名要哪份,不指名用第一份;但描述本身不对齐照样出戏)")
      // 改/抠图通道(v0.11.27):同一条命令按参数切语义 —— 给了 --ref 就是「在这张图上动手」
      // 而不是「照着描述重画一张」。这是从设计图里取素材的唯一正路,不说清楚 agent 会退回
      // 「凭印象重画一张相似的」,而那正是设计图与网页对不上的根源。
      L.push('· **改图/抠图/补全**同一条命令:`--ref <输入图>`(可多次,按给的顺序在要求里用 [1] [2] 指代)⇒ 在这些图上动手,不是照描述重画;`--mask <遮罩图>` ⇒ 只重绘遮罩里**透明**的部分、不透明处逐像素保持原样(补全被挡住的区域用它);`--transparent` ⇒ 输出真透明底 PNG(给网页当素材用)')
      L.push('· ⚠ **要保留原图细节就必须给 `--ref`** —— 只写描述让它「画一个一样的」,拿到的是另一张图(颜色、比例、光影都会变),用在网页上就是设计图与实现对不上')
      // ⚠ 2026-09-05 真机:群里连改 9 张挂钟,要求写「其余逐像素保持不变」⇒ 生图后端自评达不到,
      //   放弃图像编辑改去写脚本手工补像素,12 个任务全部撞满 10 分钟墙钟。后端模板已挡住这条路
      //   (imagen.js 的编辑底线),这里再堵住源头 —— 让写要求的人一开始就别提不可能的条件。
      L.push('· ⚠ **改图要求里别写「逐像素一致」「完全不变」「一模一样」这类做不到的硬条件** —— 生成式改图必然带来细微像素差异,把它写成验收条件会让后端反复重做到超时、什么都交不出;要保原样就说「主体、构图、配色、光影不变,只改 X」')
    }
    // 设计图 → 网页 的图片资产管线(v0.11.27):此前这一环是断的 —— agent 能
    // 照着设计图写 HTML/CSS,但设计图里的图片素材没法拆出来给网页用,只能凭印象重画或干脆
    // 拿占位图,做出来的页面与设计图对不上。四步写成流程而不是罗列能力:它们有严格先后。
    if (canImagen(isCodex, full, this.hasImagen && this.hasImagen())) {
      L.push('【设计图 → 网页:图片素材怎么来】照设计图做页面时,按这四步走,别跳:')
      L.push('· ① **先列资产清单**:看一遍设计图,分清哪些东西 CSS 能画(纯色块/圆角/阴影/渐变/图标字体)、哪些必须是图片(照片、插画、复杂纹理、带质感的 logo)。**能用 CSS 的一律不要出图** —— 出一张图比写几行 CSS 贵得多,还糊')
      L.push('· ② **抠素材**:从设计图里裁出该素材所在区域 → 去背景。**要保原样就别用生成**:机器上有 `rembg` 时优先 `rembg i <输入> <输出.png>`(逐像素抠,免额度、结果确定);没有或抠不干净再用 `sbot imagen "去掉背景,只保留主体" --ref <裁下来的图> --transparent --out <素材.png>`')
      L.push('· ③ **补全被挡住的部分**:素材在设计图里被别的元素压住时,`rembg` 补不了(它只会照着看得见的部分抠)—— 必须用 `sbot imagen "补全被遮挡的部分,其余保持不变" --ref <素材> --mask <遮罩> --out <完整素材.png>`,遮罩里**透明**的地方就是要它补画的地方')
      // 等比裁切/变形拦截。⚠ 这条**不做机器检查**:响应式布局里
      // width/height 与 CSS 覆盖的合法组合太多,逐个判必然满屏假警报(与「间距不测」同理)。
      // 但它是真实事故 —— 素材抠得再准,放进页面被拉扁一样白做,而拉扁后人眼常常只觉得
      // 「哪里怪怪的」说不出所以然。故写成硬约定 + 交付自查项。
      L.push('· ③b **放进页面时不许把素材拉变形**:别同时写死 `width` 和 `height` 去凑版面 —— 要填满某个框用 `object-fit: cover`(允许裁掉边缘)、要完整显示用 `contain`;**需要的是裁切就先把素材裁成目标比例**(裁的是画面、不是把画面压扁)。素材原始宽高比是多少,页面上就得是多少')
      L.push('· ④ **交付前自己比一遍**:素材放 `assets/` 并按用途命名;页面做完用浏览器截图,和设计图**并排对照**看比例/颜色/位置/圆角;**逐张确认图片没被拉伸变形**(人像/logo 被压扁最容易看漏,对比原图宽高比);**对不上的地方主动在群里点名说明**(哪些素材是重绘的、哪里没能还原、为什么),别让用户以为页面里用的就是设计图上那张原图')
    }
    // 【本项目的设计口径】—— ⚠ 从「设计画布」段里**移出来**独立成段(v0.11.29):它原先挂在
    // `if (group.board && group.board.url)` 里,也就是**只有建了画布的群才看得到风格档** ——
    // 可写 HTML/CSS 该守什么色板,跟这个群有没有画布毫无关系。
    // 「风格档未被强制加载」,一部分原因就在这儿:没建画布的群,清单里连提都没提过风格档。
    // tokens 直接摆出来(不是给路径)是这条的另一半:给指路牌它可能根本没去读,摆上下文里
    // 就取消了「没加载」这个可能。**⚠ 不做阻断式强制** —— 教训 6:配置类策略对半可信 agent
    // 本质不可强制,硬拦只会得到绕得过去的假门槛,还会挡住正当例外(设计图自带的渐变、
    // 第三方 logo 的品牌色)。真防线是让偏离**可见**,判断权留给群里的人。
    {
      const docs = (this.styleDocs && this.styleDocs(group.workdir)) || []
      // 风格库曾对任何页面样式/出图任务都主动推荐,但预设效果并不总符合项目需求。
      // 现在按是否属于全新产品创建、以及是否已有视觉方向来决定是否提示。
      L.push('【风格库提示边界】仅在明确启动全新产品/应用/网站且未提供视觉方向时,才可简短推荐风格预设。已有项目的页面、功能迭代、改版、缺陷修复、图片素材或按参考图实现时,不要主动提风格库,按项目现状、参考素材和本轮说明执行;主动询问风格或预设时再介绍。')
      L.push('  符合条件时,先简短询问是否需要看预设;需要时再展示少量候选预览,由对方选定后保存。已有视觉方向就直接照做,不要为选风格中断工作。')
      if (docs.length) {
        L.push('【本项目的设计口径】出图、写页面样式前按它来:')
        if (docs.length > 1) {
          // ⚠ 三条命令的指名参数**不同名**(生图是 `--style`,design 子命令是 `--as`)⇒ 必须逐条写出来,
          // 只说一个的后果是另两个照样不指名。2026-08-18 真机:某项目放进两份档当天,不指名的
          // `design check` 拿后台那份去查小程序的 wxss,把小程序自己的主绿 #1B6B37 报成「不在色板
          // 里」。**对错了档的报告比没有报告更糟** —— 它长得像一份正经回归报告,人照着改反而把对的改错。
          L.push('⚠ **本项目有 ' + docs.length + ' 份风格档**:' + docs.map((d) => `${d.rel}${d.platform ? `(${d.platform})` : '(通用)'}`).join(' · ')
            + ' —— 动手前**先认准这次做的是哪一块**,读对应那份,并且**每条命令都要指名**:'
            + '`sbot design check <文件…> --as <用途>` · `sbot design icon <名字…> --as <用途>` · 生图 `--style <用途>`(注意前两个是 `--as`,生图是 `--style`)。'
            + '**不指名一律用第一份** —— 拿后台那份去查小程序的样式,连小程序自己的主色都会被报成「不在色板里」,这种对错了档的报告比没有报告更糟')
        } else {
          L.push(`· 风格档:${docs[0].rel}${docs[0].platform ? `(${docs[0].platform})` : ''}`)
        }
        for (const d of docs) if (d.digest) L.push(`· ${docs.length > 1 ? (d.platform || d.rel) + ':' : ''}${d.digest}`)
        // ⚠ 退出码这句必须写:查到偏离时命令返回 3,你的 Bash 工具会把它显示成「命令失败」——
        // 不点破,agent 会以为检查工具坏了/自己用错了,转头去重试或干脆不提这件事(imagen 的
        // `--wait` 退出码 2 踩过同款,那边写了这边漏了,是复审补上的)。
        L.push('· **交付前必做**:`sbot design check <改过的 html/css…>` —— 对照风格档逐项查颜色/圆角/字体/图标,以及**中文字体兜底**(产物里有汉字、且档里声明过中文族时才查)和**字体可得性**(档里定的字体在这批文件里找不到 @font-face 或字体服务链接、又不是系统自带 ⇒ 报它实际会显示成什么;**把 css 一起传**,否则 css 里的 @font-face 看不见),**把它的输出原样贴进你给群里的交付说明**(哪怕零偏离也说一句「已检查、无不一致」)')
        // 布局体检(v0.11.52):与 check 并列的第三条。真机来源:交付前 check 零不一致,而页面上
        // 有四处文字压在头像上 —— **「合规」和「好用」是两件事**,写法查不出渲染出来的样子。
        L.push('· **页面做完再跑一次 `sbot design layout <html…>`** —— 它把页面真渲染出来量几何,报五件事:文字重叠 · 内容被裁掉且不可滚 · 点击目标小于 24px · 文字对比度低于 WCAG · 中文字号低于风格档声明过的最小档位(图表里的坐标轴文字天生就小,不计)。⚠ **默认扫 1280/1000/430 三档宽度**,因为同一处重叠可能宽屏一处没有、窄一点就冒出四处;这台机器没有常驻浏览器时它会直说,不影响别的事')
        // 风格档体检(v0.11.62):与上面三条**平级**的第四条,按查什么对象分 —— check 查页面写法、
        // icon-assets 查图标文件、layout 查渲染出来的几何,**三条都只会说「产物偏离了档」**,谁都
        // 不会说「档本身有问题」;而真机上缺口常常就在档里。⚠ 这里不写 `icon-assets` 的命令名 ——
        // 那条挂在「声明了资产目录」上,无条件提它会让没声明的项目收到一条跑不通的指路(单测钉着)。
        L.push('· **档本身也要体检**:`sbot design doctor`(`--as <用途>` 指名哪份 · `--json`)—— 上面几条查的都是**产物**(页面写法 / 图标文件 / 渲染出来的几何),只会说「产物偏离了档」,**从不说「档本身有问题」**,而缺口常常就在档里:语义色放错段(写进色板会抢走强调色)· 色板配底色读不清 · 缺中文字体兜底 · 字重不是九档标准值')
        L.push('· ⚠ 这几条(check / layout / doctor)**查到东西时退出码是 3**(零发现才是 0)—— **那不是命令出错、更不用重试**,3 就是「查出来了,看输出」的意思')
        L.push('· ⚠ 查出的「不一致」**不等于做错了**:设计图自带的渐变、第三方 logo 的品牌色都会出现在里面 —— 你要做的是**连同你的判断一起说出来**(哪些是有意为之、哪些确实该改),而不是闷头把它们全改成色板里的值;判过「这样就对」的连同**理由**记进 `design/check-accepted.md`,下次起折叠成一行不再重复(没写理由的不生效)')
        // 图标(契约见 docs/ICONS.md)。⚠ 一致性由**取得到正确图标**保证,不由检查保证 ——
        // 手绘 path 必然与设计图不是同一套,而这正是「页面图标跟设计图对不上」的根因。
        // 未启用时也要说一句:否则「没报图标问题」会被读成「图标没问题」。
        if (docs.some((d) => d.icons)) {
          L.push('· **图标一律用 `sbot design icon <名字…>` 取**(`--sprite` 一次取多个 · `--size sm|md|lg` 选档 · `--label "返回"` 给无障碍名)—— **绝不要自己写 path**:手绘的图标和设计图必然不是同一套。语义名(back / more / close…)先查风格档 icons.semantics,没有就用图标库的英文名(chevron-left / trophy…);取出来的已按风格档归一好描边、端点、尺寸与无障碍名')
          // ⚠ 这两样都是**产出时留下、事后靠它办事**的东西:来源标记让交付前的检查认得出图标
          //   打哪儿来(没有它,换过系统的页面没有任何东西会发现),许可声明是 MIT/ISC 的硬要求。
          //   2026-08-25 真机上那份产物**一条注释都没有** —— 整理时被顺手删干净了。
          L.push('· ⚠ 取出来的图标带两样东西:每个图标上的来源标记(`data-icon="库/名字"`)与 sprite 顶部那行许可声明(`<!-- icons: … -->`)—— **整理代码时都不许删**:前者是交付前检查认出「这图标是不是当前这套系统的」的唯一依据,后者是图标库许可要求保留的声明')
          // ⚠ 这句只能待在**有风格档**这一支里:没档的项目提对照检查等于指路去跑一条跑不通的
          //   命令(既有约束,单测钉着)。图标来源虽然不看风格档,但它是 `design check` 的一部分。
          // ⚠ 与下面那条「换系统不会自动改页面」故意不重复:那条讲事实,这条只讲**多出来的那件事**
          //   —— 现在查得出来了、报出来该怎么办。清单每轮都付 token,重复一遍不值。
          L.push('· 换过系统后漏掉的旧图标,交付前的 `sbot design check` 会报「图标来源不符」并点名 —— 报到了就把那几个重新取一遍,别手改 path')
          L.push('· **emoji 不能当操作图标**(按钮、链接里不要放 emoji):它不能跟着主题着色、各平台字形不一样,读屏念出来的是 emoji 的名字而不是这个按钮要做的事;装饰性的 emoji 放正文里没问题')
          L.push('· 小程序端落地:SVG 转 base64 走 `mask-image`(能跟着主题换色)或 image 组件;**别用字体图标** —— 微信不让上传字体文件、字体图标还只支持单色')
          // 资产体检只在**声明了资产目录**时才提:没声明就没有扫描范围,多这一句是纯噪音。
          // ⚠ 不进「交付前必做」——它是整理时才跑的东西,每次交付都跑那几十行会把交付报告淹掉。
          if (docs.some((d) => d.iconAssets)) {
            L.push('· 图标**文件本身**的体检(不是页面写法)用 `sbot design icon-assets` —— 报三件事:颜色能不能继承(写死颜色是「同一个图存好几份」的根因)· 有没有同图多份 · 参数偏不偏离声明。**整理图标时才跑,不必每次交付都跑**;它只出清单不改文件,要不要合并由群里的人定')
          }
        } else {
          L.push('· ⚠ 本项目**还没选图标系统**(没有 design/icons.md)⇒ 取不到图标、图标这一类也**不会被检查**,页面图标与设计图对不对得上全靠人眼')
        }
      }
        // ⭐ 图标系统是「群里的人能不能自己看、自己换」的唯一通道 —— 群里没有按钮,全靠对话,
        //    而 agent **不知道有这条命令就等于这个能力不存在**(v0.11.49 那两条同病:声明了却报
        //    未启用 / 新项目一个字不提设计规范 —— 都是「能力的到达率」)。所以这一段**在 if/else 之外**注入 —— 之前它写在「有风格档」那一支里,
        //    零风格档的新项目一个字都读不到,而注释还写着「无条件」。⚠ 与本版的立论直接打架:
        //    图标与风格是**平级**的两件事,把图标能力挂在风格档存不存在上,等于又绑了一次。
        L.push('· **图标系统与设计风格是平级的两件事**:风格管**怎么画**(颜色/字体/圆角/描边),图标系统管**图形从哪来、叫什么名**。群里有人问「有哪几套图标风格 / 现在用的哪套」⇒ 跑 `sbot design icons` 把结果**用人话转述**(每套一句话气质 + 当前这套);有人说「换成 X」⇒ `sbot design icons use <系统>`(换与当前不同的要加 `--force`)')
        L.push('· ⭐ **要「看」图标就出图**:`sbot design icons --sheet` 生成一张四套并排的对照图(带序号),**把图发进群里**让人指着说「用第 3 个」—— 挑图标是「认不认得出」的判断,念「256 网格填充型」对群里的人毫无意义。与挑设计风格出预览图是同一个做法')
        L.push('· ⚠ 换图标系统会**换掉整套命名词汇**(同一个「更多」:more-horizontal / dots / dots-three),而**页面上已经取过的图标不会自动跟着变** —— 换完必须主动说这一句,并把用到图标的页面重新取一遍;别让人以为改一下就全变了')
    }
    // 设计画布(飞书画板;docs/BOARD.md):群的图形工作区。有画布 ⇒ 完整用法+约定;没有 ⇒ 只教
    // 怎么建(懒创建:首次需要展示/迭代图像时自动建 —— 用户不需要先学会「画布」这个概念)。
    // 约定跟着 group.board 进指纹:建/换画布 ⇒ 清单变 ⇒ 下轮自动重注入,不重置会话(repo 行同款)。
    if (group.board && group.board.url) {
      L.push(`【设计画布】本群画布(飞书画板,群成员手机/电脑都可打开和标注):${group.board.url}`)
      L.push('· 放图上板:sbot feishu board-add-image "<图片相对路径>" [--beside <参照节点id>] [--label "方案1"] [--deliver --note "改动说明"] —— --beside 让新图落在参照图右侧同排(按标注改图必用:参照=标注箭头吸附的原图节点,版本演进横向一排对比一眼可见);不带 --beside 才是全局最右;--label 在图下加标签;**--deliver 把这张图作为「结果卡」交付到群(图在卡内+打开画布按钮);按标注改图交付一律加 --deliver —— 它会把群里那张播报卡就地更新成结果卡(处理中→结果卡,单卡演变),不要再单独 send-image;--note 写一句改动说明**')
      L.push('· 画流程图/架构图/思维导图等:写 Mermaid(优先,存 design/diagrams/*.mmd;PlantUML 则存 *.puml),再 sbot feishu board-add-diagram "design/diagrams/xxx.mmd" [--type flow|mindmap|sequence|class|er|component|usecase|activity] [--beside <参照节点id>] [--label "文案"] [--deliver] —— 默认渲染成「多节点可编辑」图形(用户能对具体图形画箭头标注、board-nodes 也读得到每个图形),--as-image 出整张图片(单节点好拖动,但不可编辑、标注无法吸附到具体图形 —— **只适合一次性示意图;要进「按标注改」迭代闭环的图表一律用默认多节点**);**新图表自动放进画板空白区(先算已有内容边界,不会压到现有内容)**;迭代版本用 --beside <旧图表任意节点id> 放旧版旁边横排对比;改图=改 .mmd 源文件重新上板(源码在仓库可版本管理),旧版默认保留(演变档案);改图交付加 --deliver(结果预览回填进群里那张画布播报卡)')
      // 两条 Mermaid 写法约束(2026-07-29 真机坐实,别再犯):① 节点标签里的 `\n` 飞书渲染端**原样透传**
      // 成字面反斜杠 n(读回的节点文字就带着它),换行必须用 `<br/>`;② classDef 只作用于节点,子图容器
      // 保持 Mermaid 默认淡黄,与项目风格档的配色打架 —— 要 style 单独上色。
      L.push('· ⚠ Mermaid 两条硬约束:**节点标签换行必须用 `<br/>`,绝不能用 `\\n`**(飞书渲染端原样透传,画布上会显示成字面的反斜杠 n);**子图容器要单独上色** `style <子图id> fill:#…,stroke:#…`(classDef 只作用于节点,子图不写就是默认淡黄,与项目风格档不搭)')
      L.push('· 精细通道(mermaid 表达不了时):sbot feishu board-add-nodes "<节点JSON相对路径>" 直接写结构化节点(60+ 图形/自由布局/section 分区/结构化思维导图)')
      L.push('· 读画布(含用户标注):sbot feishu board-nodes —— 返回结构化数据:图片/箭头(含吸附的目标节点)/文字/图形/思维导图节点的坐标与内容;读标注一律用它,不要靠截图')
      // ⚠ 措辞是有代价的:此前这行只写单数 <节点id>,agent 就老老实实一个一个删 —— 真机一轮删 34 个
      // 节点跑了 270 秒、约 100 次飞书 API 调用(月配额是全公司共用的硬约束)。删=整板 overwrite 且
      // **每次 id 全变**,所以「循环删」还必然每轮重读。这里必须把「一次删完」写成硬规则。
      L.push('· 删节点:sbot feishu board-del-node <节点id> [更多id…](仅在用户明确要求清理时用;被删节点自动存档到项目 design/board-history.jsonl)')
      L.push('  **一次传完所有要删的 id** —— 无论几个都只重写画板一次;删除会整板重写、**所有节点 id 随即全变**,所以循环一个一个删既慢又费(旧 id 会失效、每轮还得重读),严禁那么做')
      L.push('  删整张图表/整组:直接传**组 id**(board-nodes 输出里的 `[组] xxx 含 N 个成员`)即可连带删掉全部成员;传思维导图节点会连带删掉它的整棵子树;成员被删光的空组会自动清掉。只想删点名的那几个而不连带,加 --no-cascade')
      L.push('· 读评论:sbot feishu board-comments —— 文档评论是第二条意见通道(锚点[画板]/[图片];附图列为 token,用 board-get-media <图token> "<相对路径>" 下载到项目目录);每处理完一条评论就 board-resolve-comment <评论id> 标记已解决(与删标注同语义,别漏)')
      L.push('· ⚠ **能直接改的就让用户直接改** —— 画布上的文字、连线、节点位置他自己动手最快;**不要引导他「画个箭头写上说明」**,那只在「提意见/要你判断怎么改」时才需要。你收到「画布内容已修改」通知 = 他已经改好了')
      L.push('  ⚠ **纯挪动位置/改样式不会通知你,也不需要你同步** —— 图表源码(.mmd 等)里没有坐标,排版是画布上的事。但要如实告诉用户:**之后重渲一版新的,不会继承他挪好的排版**(旧版仍留在板上)')
      // ⚠ 轮询关着还写「会自动播报」= 清单对 agent 说假话,agent 转头就对群成员说「你改完我会
      // 收到」。轮询默认关(飞书月调用量)⇒ 这一句必须跟着真实状态走,判据取 boardWatch 那个
      // 固化值(bin 注入,一处算两处用)。
      L.push(this.boardWatchOn && this.boardWatchOn()
        ? '· 画布有新反馈时会自动在群里播报摘要(新增标注、改已有节点文字、删节点都算,纯挪动/改样式不算),你无需轮询'
        : '· ⚠ **画布反馈不会自动播报**(本机未开画布轮询)—— 用户在画布上改了什么、贴了什么标注,**要等他在群里说一声你才知道**;**绝不能对他说「你改完我会自动收到」**。他一提「我改了/我标注了」,就 board-nodes + board-comments 各拉一次去看')
      L.push('· 被要求处理画布任务时,动手前先 board-nodes 和 board-comments 各拉一次,标注+评论一起消化;**用户「直接编辑/删除」画布内容(改图表文字、删节点,而非画箭头贴便签提意见)会以「画布内容已修改」通知卡出现 —— 这类确认后你只做源码同步:把改动并回 .mmd 等源文件、不要重新上板出新版(画板已是终态)**')
      L.push('· 约定:生成的图先存项目目录再上板;少量图可同时 sbot feishu send-image 发群一份(**设计稿**批量 ≥3 张只发画布链接,别刷屏);按标注改内容 ⇒ **看标注落在什么上分叉**:落在**图片**上 ⇒ board-add-image --beside <原图节点id> --deliver 出新图放原图右侧、不动原图;落在**图表图形**上 ⇒ 改对应 .mmd 源码后 board-add-diagram --beside <该图形任意节点id> --deliver 重渲一版放旧图旁,**不要把图表改动做成图片**;**画布上图表/图片内容被用户「直接改过」(不是画箭头贴便签提意见)⇒ 只把改动合并回源文件(.mmd 等),不要重新上板 —— 画板上已经是用户改后的样子,再渲染一版是冗余;重渲染仅当用户明确要求改结构/出新版,且渲染前必须先并入用户的画板编辑**;交付一律加 --deliver(结果就地回填进群里那张播报卡,别裸 send-image),并在群里**用列表逐条复述**你对每条标注与评论的理解与处理(每条一行/一个列表项,别堆成一大段);**画布是设计演变档案:历史版本图与标注一律保留、不要删除**(原图→标注→新图的链条让演变过程一眼可见;用户明确要求清理时才 board-del-node,删除会自动存档);触发消息里列出的标注就是本轮要处理的全部,更早的旧标注是已处理过的历史、不要重复处理;**交付设计结果的群消息末尾附画布链接**(上面那个 url,用户点开直达);画布文档打不开/被删 ⇒ 先问用户,确认后才 board-create --new 重建')
      // 设计风格档(项目根 DESIGN.md):风格是跨轮跨任务复用的东西,不落文件必漂 —— 这几行把
      // 「先定风格再批量产出」写成硬约定,并给出两条建档路与两条写档铁律(形容词写档等于没写)。
      // 静态文本:清单指纹要跨轮稳定,一个字都不能嵌运行时状态。
      L.push("· 设计流程:复杂设计任务且风格未定 ⇒ **先定风格档,再批量产出**。风格档 = 项目根 `DESIGN.md`(根目录已被架构设计文档占用时用 `design/DESIGN.md`):YAML front matter 放 colors/typography 等 tokens,正文写氛围、版式规则与 Do's and Don'ts")
      // 一个项目可以有多份风格档(v0.11.22):同一个项目常常有两块面(小程序 + 后台网站),
      // 它们的圆角尺度、间距、正文字号本来就不该一样,压成一份对两边都不准。**列出现有的几份**
      // 是这里唯一的运行时内容 —— 它变了(新建/删除一份档)清单指纹才该变,那正是要重注入的时刻。
      L.push('  一个项目可以有**多份**风格档:`design/styles/<用途>.md`,每份 front matter 写 `platform:` 说明自己管哪块(小程序 / 后台网站 / 网页前台 / 移动 App / 印刷物料);老位置那份(根 `DESIGN.md`)是没指名时的通用档。落多份用 `sbot design use <slug> --as 小程序`')
      // 建档路①的「让用户选」以前只有文字 —— 而「瑞士网格」和「新中式」用文字描述都是「浅底
      // 深字一点强调色」,让人凭想象选风格。swatch 把 tokens 画成微缩界面预览图,选风格这件事
      // 变成看图。序号对照必须由消息带上:图上只有阿拉伯数字(风格名是中文,点阵字模画不了)。
      // ⚠ 风格库有二十几种 ⇒ **挑之前先确认用途**。agent 只看名字和一句话是挑不准的,
      // 而它挑漏的那个用户根本看不到(候选图之外的等于不存在)。styles 已按场景分组输出。
      L.push('  建档路①(从内置预设起步):**先确认这是什么用途**(控制台/落地页/长文/海报/只出图),再 `sbot design styles` —— 它按场景分组,**从对应那组里**挑 2-4 个候选方向(别凭名字硬猜,库里风格多,猜漏的那个用户就看不到了)→ **`sbot design swatch <slug> <slug> …` 出一张候选对比图**(每种风格按它的色板/圆角/字重/描边/图片处理画成微缩预览)→ `sbot feishu send-image "<图片路径>"` 发群,消息里**逐条列出「序号 + 名称 + 一句话(色板+字体+气质)」**(图上只有数字序号,用户回「第2个」时你得对得上)→ 用户选定后 `sbot design use <slug>` 落盘 → 按项目需要改写')
      L.push('  用户想**先看看有哪些**(「有哪些风格」「都给我看看」)⇒ `sbot design swatch --all` 出一张全库网格图(一张图看完所有风格),消息里把 stdout 给的「序号 + 名称 + 场景」**全列上** —— 图上只有数字。⚠ 这是**浏览**;真要选还是回到「挑 2-4 个出对比图」,那时每张大得多、细节看得清')
      L.push('  用途拿不准就**直接问用户一句**(「这是要做后台工具、品牌落地页,还是主要用来出图?」)—— 比闷头挑四个不搭的强')
      L.push('  风格档落盘/改写后想看效果:`sbot design swatch --current` 出本项目现有风格档的预览图(有几份画几份,一张图看出它们差在哪)(图完全由 front matter 的 tokens 派生 ⇒ **图和你的设计产出对不上,说明风格档本身写歪了**,是道自检);它还会打印判定出的「底色/文字/强调/次要」各是哪个键 —— **改完色板务必核对这行**,别只凭自己以为的')
      // 真机(2026-07-31):用户说「主色改靛蓝」,agent 改了色值、图也重画了,但按钮还是黄的
      // (几何构成的 blue/yellow/red 都不在角色词表 ⇒ 按彩度挑,黄恒胜),它却在群里说「靛蓝
      // 将承担主要视觉面积」。这条把「为什么改了没用」写死,免得它反复改色值还越改越糊涂。
      L.push("  ⚠ **改主色 ≠ 改色值**:角色按**键名**判定(`accent`/`brand`/`highlight`/`pop` 直接命中),键名是 `blue`/`red` 这类颜色名时只能退回「挑彩度最高的那个」—— 所以把 blue 的值换成靛蓝,强调色可能仍是旁边那个更鲜艳的黄,怎么改色值都没用。**要指定主色就把那个键改名为 `accent`**,再用上面的判定输出确认改对了")
      // 真机(2026-07-31):用户说「把设计主色换成正红」,agent 改完风格档就回「主色已换为正红,
      // 并发送了更新后的预览图」—— 用户去看 HTML 原型,纹丝未动(那份原型停在两天前,用的还是
      // 两套风格之前的色板)。风格档的语义确实是「之后的产出遵循它」,但用户说那句话时想的是
      // 「我的设计要变成正红的」。**落差不说破,就成了又一次「说的和做的不一致」** —— 这和
      // v0.9.3 修的两件事同源:系统/agent 做了 A,却让人以为做了 B。
      L.push('  ⚠ **改风格档不会自动改已有产物** —— HTML 原型、之前生成的图' + (feat('boards') ? '、画布上的内容' : '') + '都不会跟着变。改完必须主动说清影响范围:「风格已改,这对**之后新出的东西**生效;项目里已有的 <逐个点名> 还是旧风格,要不要我一并更新?」**别让用户自己去发现原型没变**')
      L.push('  说「预览图」时要讲明那是**风格预览图**(色板缩略图),不是原型的预览 —— 否则「发送了更新后的预览图」会被理解成原型已经更新了')
      L.push('  建档路②(用户给了参考):网址 ⇒ 浏览器 `evaluate_script` 提取(**优先收割 `:root` 的 CSS 自定义属性**,再统计主色占比/字体族/字号档),并 fullPage 截图存项目目录+上板存档;参考图 ⇒ `sbot design extract-colors "<图片相对路径>"` 提主色板(有识图能力再看图归纳气质与构图)⇒ 归纳成 DESIGN.md')
      L.push("  写档铁律:**一个具体参照胜过一堆形容词**(写「卡片间距 24px、正文 16px/行高 1.7、像某站的卡片式布局」,别写「高级感、有呼吸感」);**Don'ts 写具体**(写「不用紫蓝渐变、圆角不超过 12px、正文不小于 14px」,别写「不要太丑」)—— 形容词写的档等于没写,下轮照样漂")
      L.push('  风格定稿后**每次生图/出图表前必读并遵循**;批量生图逐张交付 —— 每完成一张就上板并报进度,不要攒齐再交')
      // ⚠ 这条原本是无条件的「先出图评审再动手」,对**延续类任务**是纯粹的摩擦:给既有项目加个
      // 小模块,它会先劝用户去画布上补一版流程图/原型 —— 而画板上没有那部分图,只说明当初就没走
      // 画布流程,不是欠账。2026-08-07 产品决定收窄到「从零开始」那一档。⚠ 收窄的是**主动引导**,
      // 不是禁止出图:用户开口要图照出(下一句明写),否则会从「过度引导」翻到「该出不出」。
      if (feat('boards')) L.push('  ⚠ **「先出图评审再动手」只对「从零开始」成立**:全新产品/全新工具的**创建初期**先出原型流程图或架构图上板评审,图过了再写码(图便宜、返工贵)。**既有项目的延续类任务(升级、加小模块、改 bug、重构、接口调整)直接做** —— 不要劝用户「先去画布补个流程图/原型」;**画板上没有那部分图 ≠ 缺了要补**,只说明当初没走画布那条路。用户自己要图时照常出,别主动往那儿引')
      if (provider && provider.vision === false) {
        L.push('· ⚠ 画布上的图片内容你看不见(无识图能力)—— 图的位置与用户标注以 board-nodes 的结构化数据为准;画板上贴的图和评论附图就算下载了你也看不见,请用户用文字描述要点')
        L.push('  同理**参考图你也看不见**:extract-colors 只能给你色板(颜色是真的),气质/构图/版式一律请用户用文字描述后再写进风格档,别假装看过那张图')
      }
    } else if (feat('boards')) {
      L.push('· 设计画布:本群还没有画布 —— 首次需要向群里展示/迭代图片时,先 sbot feishu board-create 创建(会自动建飞书画板文档并分享给本群),把返回的链接发到群里,再用 board-add-image 放图')
    }
    // 本机运行约定(2026-07-29 真机踩到)：agent 为了让群成员能打开 HTML 原型,起了局域网静态服务,
    // 还用 `launchctl submit` 把它装成**常驻作业**(无 plist、kill 掉自动拉起),两个端口各一份、其中
    // 一个挂了一周 —— 整个项目目录就这么持续暴露在局域网上。这台是常驻生产机(daemon 与其它群项目
    // 共用),「起的东西要自己收干净」必须写成硬规则,不能指望每次都想起来。
    // v0.8.2 补了禁令却只给了 `screen -dmS` 这种通用逃生阀当正路(能起任意进程、暴露任意目录,
    // 清单管不住);v0.9.0 起正路收成**一条** `sbot preview`(受管:围栏 + 按群固定端口 + daemon
    // 侧闲置回收 + 控制台可见)—— 禁令必须配正路,而且正路只留一条才管得住(两条并列 = 给逃生阀发许可)。
    L.push('【本机运行约定】这台机器常驻运行、多个群项目共用(sbot daemon 就在上面),你起的进程要自己收干净:')
    L.push('· 给群成员看可交互的 HTML 原型,**首选 sbot feishu send-file 把 html 发群里**让人下载本地打开(自包含单文件、零服务、不暴露目录)—— 这是默认做法;确实需要「局域网在线访问」才起服务')
    // 交付载体三分(2026-09-08 测试群现场):2025 个 Lucide 图标切成 15 张全上了画布 —— agent 照的是画布段
    // 「批量 ≥3 张只发画布链接」那条,而查阅型产物根本不该进画布(原话「画布太麻烦」)。判据按
    // **读者要干什么**分、不按产物类型分:对照图(挑一个)既不是设计演变也不是查阅,二分法会漏掉它。
    // 三条各给正路,不留禁令(禁令不配正路,agent 会绕出更糟的办法);「可按名字搜索」是唯一硬要求,
    // 再多规定格式它会照搬到不合适的场合。画布段那条已就地加了「设计稿」限定,两处不互相引用。
    L.push(feat('boards')
      ? '· 交付载体按**读者要干什么**选:要**翻找**(图标全集 / 素材清单 / 色板总览)⇒ 可按名字搜索的自包含单页 HTML,send-file 发群;要**挑一个**(候选风格 / 图标系统)⇒ 一张带序号的对照图发群;要**评审、改**(方案稿、按标注改版)⇒ 上画布。目录类不上画布 —— 画布是设计演变档案,几十张目录图会把它撑成图片收纳箱'
      : '· 交付载体按**读者要干什么**选:要**翻找**(图标全集 / 素材清单 / 色板总览)⇒ 可按名字搜索的自包含单页 HTML,send-file 发群;要**挑一个**(候选风格 / 图标系统)⇒ 一张带序号的对照图发群;要**评审、改**(方案稿、改版)⇒ 逐张图发群并说清改了哪儿')
    // ⚠ 2026-08-24 真机:让它做两个后台页面,它做得很好(取图标、指名风格档、交付前自查、原样贴报告
    // 全做到了),但群里只收到一个 zip —— **要下载、解压、双击才看得见长什么样**。它其实截过图
    // (自己要验),图就躺在项目里没发出去。⭐ 缺口不在能力(send-image 一直有),在**这条路径上没人
    // 让它发**:三处截图教学全是条件性的(有画布 / 群里主动要 / 有设计图可对照),而「做完页面直接
    // 交付」恰好落在三个条件之外。与本版 `icon:` 回落、零风格档引导同族 —— **能力的到达率**。
    // ⚠ 这条**不许挂条件**:一挂就又会漏掉别的路径,这正是它这次没被触发的原因。
    L.push('· ⚠ **交付界面类产物时,连一张截图一起发**(`sbot feishu send-image "<截图路径>"`;多页发 1-2 张代表页,别刷屏)—— 附件要下载解压才看得见,**群里的人尤其在手机上,得先看见长什么样**才谈得上评价;你为自查截的图直接发即可,不用另截')
    L.push('· 本轮内自己起的临时服务(调试服务器、构建预览等):同一项目**固定复用一个端口**,别每次换新端口越堆越多;**用完立刻停掉**,并在群里说明已停')
    L.push('· 确需「群成员在线打开」时,**唯一正路是 `sbot preview start <相对路径(.html 或目录)> [--label "记账原型"]`** —— 受理即返回并给出局域网链接(把链接发群即可),服务跨轮存活、按群固定端口、闲置一段时间自动停(会在群里说一声,具体时长以命令输出为准;operator 可按群设成常驻不自动停),**不用你记着关**;要提前停 `sbot preview stop`,查状态 `sbot preview status`;同项目再 start 会自动复用或替换,不会越堆越多')
      // 单文件形态只服务那一个文件(v0.9.0 最小暴露面,不推翻)⇒ 它引用的
      // css/图片全 404,而链接已经发出去了。命令受理时会列出会丢的资源,这里让 agent 知道
      // 「看到那段就必须处理,别照发链接」。
      L.push('· ⚠ **给单个 .html 起预览时,它引用的 css/js/图片会全部 404**(只服务那一个文件)—— 命令受理时会把会丢的资源列出来:**看到就先处理再发链接**(改成起它所在的目录,或把样式脚本内联、图片转 data:),别让人点开看到一个裂的页面。改起目录前先确认那个目录里没有不该给人看的东西')
    L.push('  原型请放**子目录**(如 `design/prototype/`)再 start:预览默认拒绝服务整个项目目录(那等于把全部代码暴露在局域网上);**传单个 .html 文件时只有这一个文件对外可见**(自包含单页最省事),要连带 assets 才传目录')
    // 2026-07-30 反向诱导测试:群里要「随时都能打开」,它自己造了份配置用 --config 把回收全关。
    // 禁了绕法必须同时给出正路(这条铁律 v0.8.1→v0.8.2 已经栽过一次)。
    L.push('  预览策略(闲置/时长上限、绑定地址、端口段)是 operator 的设置,**不要自己造配置文件用 --config 去改**;群里要求「一直开着」时,如实说明需要 operator 在控制台该群卡的「预览」勾「常驻」')
    L.push('· **不要自己起长活服务**:`screen`/`setsid`/`nohup … &` 之类不用你操心(预览已经替你脱离了);**更严禁靠「拖着本轮不结束」来给服务续命** —— 那会占住群锁,群成员随后发的每条消息都被排队干等,代价远大于重起一次服务')
    L.push('· **绝不把服务装成常驻/自启作业** —— 不限于某个系统的机制(macOS 的 launchctl submit/load 与 plist、Linux 的 systemd/nohup 守护循环、Windows 的服务注册与计划任务、pm2 startup 之类**一律算**):那会一直把项目目录暴露在局域网上,而且手动杀掉还会自动拉起、很难排查;确需长期可访问,先在群里说明用途并征得用户同意')
    // ⚠ 后台任务活不过本轮(2026-09-05 真机取证,三次空轮的根因)。现场:agent 把「跑 12 张生图」
    // 丢进后台命令、答案给完就结束本轮。**每轮是一个独立的无头进程**,答案一到进程就被收尾 ⇒
    // 那个后台任务没有留下收尾记录;下一次 `--resume` 时 CLI 会先把一条「上一轮的后台任务没有
    // 结果」的系统提示**排进队列、排在群消息前面**,那一轮于是零 API 调用、零产出退出
    // (ledger 记 empty、引擎静默重试一次)。三次 empty 的紧前一轮全部起过后台命令,而当天
    // 其余轮次一次都没有 —— 对照组见 claudecode.js 里 armCloseGrace 那段注释。
    // ⭐ 写成清单条目而不是加大重试:**代价不落在起它的那一轮,而落在下一个说话的人身上** ——
    //   起它的 agent 永远看不到后果,靠「自己收干净」这条通则拦不住,必须点名说清代价。
    L.push('· **不要把活儿丢进后台再回头查** —— 每一轮都是一个独立进程:后台起的命令你下一轮既拿不到结果、也接不回去,**而进程本身并不会退**(见【后台进程与浏览器页】)。⚠ 而且代价不由你这轮承担 —— 留下一个没收尾的后台任务,会让**下一条群消息的那一轮空转**(系统要先替它收尾,那一轮什么都产不出,发消息的人白等一次)。要等的事就在本轮里等完(生图用 `--wait`),等不完就说一句「还在跑,好了我再说」,下一轮再查')
    // ⚠ 工具名只对 claude 群说:codex 没有这两样,写给它就是一条对不上号的指令(与本段
    //   `isCodex` 分流的其它几处同理)。上面那条通则两边都成立,故不分流。
    if (!isCodex) L.push('  具体就是 `Bash` 的 `run_in_background`、以及靠它轮询的 `Monitor` —— 这两样在这里都用不了,别起')
    // 长会话自动压缩(v0.11.17):CLI 会在上下文超限时原地压缩久远内容 —— agent 的对话记忆
    // 不再无限。点破它,agent 才会把阶段性结论落盘;压缩后忘了口径也能从文件捡回来。
    L.push('【长会话】群会话跨多天持续累积,对话历史超限时会自动压缩久远内容(细节可能丢失)—— 阶段性结论、口径、决定要及时写进项目文件(文档/备忘),别只放在对话记忆里')
    const mcpNames = this._mcpNames(group, isCodex)
    // 项目级 MCP(workdir/.mcp.json,随项目恒加载):claude 群单独列出 —— 不列的话 agent 不知道
    // 自己带着这些工具;codex 不读项目级 .mcp.json,不注入。指纹随 .mcp.json 内容变 ⇒ 项目加/删
    // MCP 后下轮自动重注入,不重置会话(repo 行同款)。
    const projMcp = (!isCodex && this.projectMcp) ? (this.projectMcp(group.workdir) || []) : []
    if (mcpNames.length) L.push('【已启用插件(MCP)】' + mcpNames.join(', '))
    if (projMcp.length) L.push('【项目自带插件(MCP)】' + projMcp.join(', ') + '(项目自带声明,随项目自动加载)')
    const skills = (group.plugins || {}).skills
    if (Array.isArray(skills) && skills.length) L.push('【已启用技能(Skill)】' + skills.join(', '))
    // 浏览器类插件(chrome-devtools 等)在场时注入用法纪律:长时重操作下,取信息的方式直接
    // 决定上下文成本;浏览器是常驻实例,标签页与登录态跨轮存续,agent 得知道这两个事实。
    // ⚠ 判据必须把项目级也算上(v0.11.2):某项目真踩 —— chrome-devtools 声明在项目 .mcp.json
    // 里,此前这段纪律一条都不注入,agent 有浏览器却没规矩。
    if ([...mcpNames, ...projMcp].some((n) => /chrome|browser|playwright|puppeteer/i.test(n))) {
      L.push('【浏览器使用约定】浏览器是常驻实例,登录态与页面跨轮保留。取页面信息优先 take_snapshot / evaluate_script(文本,省上下文),截图仅在需目视确认时用;开新页用 new_page、任务完成 close_page(别让标签页越攒越多);发现网站登录态失效 → 按下面「接管链接」那条办,不要反复重试')
      // 2026-09-09 真机(某群要登录一个网站后台):验证码在群里接力 14 轮、2 小时 40 分,密码明文进了群,滑块要人过 ——
      // 「接管链接」把这些收成一步:人打开链接直接在 bot 的浏览器上操作,登录态留在这边。没开控制台就不教这条(命令会失败)。
      const takeoverMin = Number((this.cfg.browser || {}).takeoverMinutes) > 0 ? Number(this.cfg.browser.takeoverMinutes) : 10
      if (this.uiLocalUrl && feat('takeoverCard')) L.push(`· **撞到登录墙 / 验证码 / 滑块 / 扫码,自己做不了时**:跑 \`sbot browser link --tab <你卡住的那个页面的网址片段> --send\` —— 命令会**自己把页面截图和接管入口发进群**(只能打开一次、${takeoverMin} 分钟内有效、只对应那一个页面),你**不用再贴链接、不用再解释**,只需在自己的回复里说一句「已经把接管入口发到群里了,做完告诉我一声」;命令失败时把它说的原因用人话转述,别贴命令。登录态会留在这台机器的浏览器里,之后你自己接着干。**不要在群里要密码或验证码**(收到密码提醒对方撤回),也别反复重试;登录页上填写用 fill / click / press_key 这类真实输入,不用 evaluate_script 往输入框塞值`)
      L.push('· 给群里发截图:take_screenshot 带 filePath 存到项目目录(整页/长页面加 fullPage:true,一张截全,别只截可视区),再 sbot feishu send-image 发群;特别长/大的图改 sbot feishu send-file 发原文件 —— 截图是给人看的,别贴在回复文本里')
      L.push('· 整页截图前先用 evaluate_script 处理悬浮元素:fixed/sticky 定位的顶栏/底部导航会按当前滚动位置画进长图中间(截长图的经典脏点)—— 先 window.scrollTo(0,0),再把 position 为 fixed/sticky 的元素临时改 absolute(或 display:none),截完刷新页面即复原')
      // 2026-07-30 真机:群里让它「控制台截图发来」,它答「未连接到可控制的浏览器窗口,请你在 Chrome
      // 打开…并回复已连接」—— 把本该自己做的事推回给用户。它有常驻浏览器、且就跑在控制台所在的机器上,
      // 环回访问还免密(密码只拦局域网访客)。这条是「知道地址」到「知道自己能去看」之间缺的那一句。
      if (this.uiLocalUrl) {
        L.push(`· 群里要你「看控制台 / 控制台截图发来」时,**你自己用浏览器打开 ${this.uiLocalUrl} 就行** —— 你跑在控制台所在的机器上,环回访问免密(密码只拦局域网访客);按上面两条整页截图后 send-image 发群。**不要反过来要求用户去连浏览器或回复「已连接」**`)
        L.push('  能在控制台看到的:概览(健康/并发/各群忙闲/实时活动)· 群·项目(模型/权限/插件/定时任务/画布/预览服务)· 模型 · 设置(运行限制/版本历史)')
      }
      // 文本模型 + 浏览器 = 最容易白跑的组合:截图工具默认把图片塞回上下文,而这类模型
      // 收到的只是占位文本。约定收紧成硬规则(必带 filePath / 看页面只用文本工具)。
      if (provider && provider.vision === false) {
        L.push('· ⚠ 你没有识图能力(见上)⇒ take_screenshot 必须带 filePath 存成文件(不带 filePath 的截图到你这儿只剩一句占位文本,纯属白跑);要「看」页面内容一律用 take_snapshot / evaluate_script 取文本,绝不靠截图确认;截图只用于发给群里的人看')
      }
    }
    const out = L.join('\n')
    return skillCmd === 'sbot feishu' ? out : out.split('sbot feishu').join(skillCmd)
  }

  // 空轮的收尾(撤卡 · 静默)在这里,**要不要重试 / 出不出声**在派发层 _retryEmpty:这里不知道
  // 还有没有下一次机会(v0.11.103 前 emptyRetried 标记传到这儿判「重试仍空才出声」,换会话重做
  // 加进来后那一处判据就不够用了 —— 决策收回派发层一处)。
  async _runTurn({ msg, platform, group, batch, freshRetried }, reportDone = () => {}) {
    const rt = this._rt(msg.chatId)
    const myStartedAt = rt.startedAt // identity of THIS turn — invalidated if it's force-released / a newer turn takes over
    // 群面出站脱敏(v0.11.6):PII(手机号/邮箱)按群开关 —— 业务数据群里那就是用户要查的
    // 内容(redactPii:false 时明文);密钥类恒遮盖。⚠ 只作用于发进群的文本;outcome.preview/
    // outcome.reply(控制台活动 + ledger 落盘)仍走全遮 —— 磁盘日志的暴露面与群消息不同。
    const red = (s) => redact(s, { pii: !group || group.redactPii !== false })
    // quiet(控制台插话勾掉「回复」):这一轮在群里**彻底无痕**。⚠ 闸门必须装在 reply 这个
    // **唯一出口**上,而不是逐处 if —— v0.11.38~41 正是逐处装的,只堵住了 finalizeTurn 那条
    // if/else 链,链外还有六个出声口(排队提示 ×2 · catch 分支报错 · provider 未配置 ·
    // 压缩通知 · 等锁被中止),全都照发。逐处补的写法,下次新增出声点还会再漏一次。
    const quiet = !!msg.quiet
    // opts 透传给平台(目前只有 { final:true } = 这是本轮最终回答,不是排队 / 重试类系统短句);平台不认就忽略
    const reply = (s, opts) => (quiet ? Promise.resolve() : platform.reply(msg.replyCtx, red(s), opts))
    const { name, provider } = this._resolveProvider(msg.chatId, group)
    if (!provider) { await reply(T.providerNotConfigured(name)); return { status: 'error', provider: name, errText: turnErrText('provider_not_configured', `模型「${name}」未配置`) } }
    if (provider.baseUrl && !provider.apiKey) { await reply(T.modelNoKey(name)); return { status: 'error', provider: name, errText: turnErrText('provider_missing_key', `模型「${name}」还差密钥没配`) } }

    const controller = new AbortController()
    rt.controller = controller
    // [收到时间 发送者] 前缀:时间按 cfg.timezone(默认北京)格式化 —— 模型每轮都拿到
    // "当前时间"锚点(排队久了也如实是消息到达时刻),"刚才/明天"有解析依据。
    // 批量(排队合并,见 _coalesce):每条消息各带自己的 [时间 发送者] 行,一并交给 agent —
    // 是补充同一件事还是几件独立的事,由 agent 判断;加一行说明免得它当成单条长消息。
    const line = (m) => `[${fmtStamp(m.createTimeMs || Date.now(), this.tz)} ${m.senderName || m.userId || 'user'}] ${(m.text || '').trim()}`
    let prompt = (batch && batch.length > 1)
      ? `(以下 ${batch.length} 条消息在你处理上一件事时先后到达,一并处理 —— 相关的合并回应,独立的逐条回应)\n${batch.map(line).join('\n')}`
      : line(msg)
    // 上一轮被人取消过 ⇒ 告诉它别自己捡回去做(见 _markCancelled)。一次性,读完即清。
    // ⚠ 留了「除非这一条明确要求你继续」这个口子:取消之后紧接着说「继续」是常见的,把话说死
    //   会让人喊不动它。默认不做 + 明说可做,两边都不失手。
    // ⚠ 走 prompt 不走自知清单:清单是长期契约(每轮比对指纹、压缩后重注入),塞临时状态进去
    //   会让指纹每轮都变、清单被反复重发。
    if (rt.cancelled) {
      const c = rt.cancelled
      rt.cancelled = null
      prompt = `(系统提示:上一条请求已被${c.how ? '「' + c.how + '」' : '人工'}取消${c.text ? `,内容是「${c.text}」` : ''} —— **默认不要继续做它**,除非下面这条明确要求你继续。)\n\n` + prompt
    }
    // 上一轮发生过上下文压缩 ⇒ 提醒它别凭记忆往下做(一次性,读完即清)。
    // ⚠ 与「重发自知清单」是两件事:清单管**规矩**(v0.11.34 已治),这条管**任务进度**。
    //   实测(2026-08-17):一次 46.5 万 token 的压缩后,清单 13 条关键约定丢了 12 条;
    //   ⚠ 工具能力**不丢**(MCP 定义每轮随请求重传,压不掉)⇒ 症状是「做事变随意」而不是
    //   「不会做」,这两者排查方向完全相反。进度那一半同理会被折叠,而它没有重发机制可依。
    // ⚠ 不说「你忘了什么」——它自己不知道丢了什么;只给**可照做的动作**:先确认再动手。
    if (rt.compacted) {
      rt.compacted = false
      prompt = '(系统提示:刚才发生了上下文自动压缩,久远内容已折叠成摘要 —— 手上任务的进度细节可能已经不准。动手前先自己确认一遍当前状态(看项目里的进度记录、git 改动、相关文件的实际内容),不要凭记忆接着做;拿不准就先说清你确认到了什么。)\n\n' + prompt
    }
    // Self-knowledge manifest (群项目基础能力): prepend it (via prompt/stdin ⇒ UTF-8-safe for both
    // backends) only when it would DIFFER from what the agent was last told — a fresh session (no
    // sid), or the capabilities/status changed mid-session (e.g. a plugin got enabled). The latter
    // just re-informs on the next turn — NO session reset, so context is preserved (adding an
    // ability is additive). Unchanged follow-ups skip it: --resume already carries it, no re-paying.
    const manifest = this._buildManifest(msg, group, name, provider, platform)
    // ⚠ 清单不能只注入一次(v0.11.34,真机实证):它在会话最开头,而**压缩把最久远的内容
    // 折叠掉** —— 2026-08-17 某项目那次压缩后的 18KB 摘要里,清单的 13 条关键约定丢了 12 条
    // (身份/零工具名/画布/生图/预览/交付纪律全没,只剩 NO_REPLY)。症状不是「不会用工具」
    // (MCP 工具定义每轮随请求重传,压不掉),而是**规矩没了**:群里开始冒命令名、不再先给结论、
    // 交付前不再自查。故两条腿:①压缩事件即失效(见 onEvent 里的 compact 分支);
    // ②轮数兜底 —— **codex 的压缩不上 exec 输出流**(生产机三个群全是 codex),它只有这一条。
    const rec = this._injectedManifest.get(msg.chatId)
    const hasSession = !!this.store.getSession(msg.chatId)
    const changed = !rec || rec.text !== manifest
    if (!hasSession || changed || rec.n >= MANIFEST_REINJECT_TURNS) {
      // 「能力已更新」只在**内容真变了**时说:压缩/兜底重注入的是同一份清单,那么说就是假话
      const updated = hasSession && rec !== undefined && changed
      prompt = (updated ? '(注意:你的能力/配置已更新,下面是最新版)\n' : '') + manifest + '\n\n---\n\n用户消息:\n' + prompt
      this._injectedManifest.set(msg.chatId, { text: manifest, n: 0 })
    } else {
      this._injectedManifest.set(msg.chatId, { text: rec.text, n: rec.n + 1 })
    }
    const mins = this.cfg.agent.maxTurnTimeMins || 0

    // Global concurrency cap (FR7.2): a wait must be visible to the group, and
    // /stop must cancel the wait itself — not spawn-then-kill once a slot frees.
    // 定时任务同样另一句。msg.cron 不进 _coalesce 的逐标记裁决:代表取「最后一条真人」,批里只要有
    // 真人就走真人那句、全是定时任务才走这句 —— 代表规则本身已给出正确答案。
    // 两车道:轮询来的不 @ 消息按软上限拿槽(给 @ 留一个),且不发「全局排队」提示(没人在等它)
    const reserve = msg.polled ? 1 : 0
    if (!msg.polled && this.sem.wouldBlock()) await reply(msg.cron ? T.queuedGlobalCron : T.queuedGlobal)
    try {
      await this.sem.acquire(controller.signal, reserve, (w) => { rt.slotWaiter = w })
    } catch {
      rt.slotWaiter = null
      // /stop 的确认由命令处理器统一发一条(stopRequested),这里再发就重复;/new 等其它中止照旧。
      if (!rt.stopRequested) await reply(T.stopped)
      return { status: 'stopped', provider: name, tokens: null, preview: '', reply: '', tools: [] }
    }
    rt.slotWaiter = null
    const capTimer = mins > 0 ? setTimeout(() => controller.abort(), mins * 60_000) : null
    // Free the global slot at ANSWER-time, not close: a codex.exe clinging to
    // its stdout pipe past the answer would otherwise keep a concurrency slot — and
    // block other groups — for the whole flush window. Safe because the freed slot
    // goes to a DIFFERENT group's turn (different session/rollout), so early release
    // can't disturb this turn's resume. Once-guarded; the finally is the fallback for
    // paths that never finalized.
    let semReleased = false
    const releaseSlot = () => { if (semReleased) return; semReleased = true; this.sem.release() }
    // Streaming card is LAZY (FR6.1/FR6.5): created on the first visible
    // output that can no longer be the bare NO_REPLY token — a silent turn must not
    // leave any card in the group, and the token itself must never render. card stays
    // null when the platform has no cards or creation failed ⇒ plain-text fallback.
    let card = null
    let cardP = null // in-flight creation; updates/finalize are ordered behind it
    // quiet 时**卡片也不能建** —— 卡是流式的,建了就已经在群里亮着了,等到最后再压回复已经
    // 晚了。所以除了上面那道 reply 闸,这里还要单独拦一道(与 NO_REPLY 同一位置)。
    const ensureCard = () => {
      if (cardP || !platform.createStreamingCard || quiet) return
      cardP = platform.createStreamingCard(msg.replyCtx).then((c) => (card = c)).catch(() => (card = null))
    }
    let buf = ''
    // 卡片最终态只留答案(v0.11.11):`buf` 是流式打字机用的累积全量(过程照常可见),`answer`
    // 只装**最后一次工具调用之后**的文本 —— 群里留下的是结论,不是心路历程。实测过一轮:
    // 卡片累积了近千字,其中 4 段是「这个问题关系到…」「已回复…」这类说给自己听的过程播报,
    // 而答案只有最后一段。
    let answer = ''
    let fullText = '' // full assistant text (redacted), accumulated regardless of card — for the console's expandable activity
    const toolCounts = new Map() // toolName -> count, deduped for the activity detail
    // 确定性里程碑(见 autoMilestone):本轮从工具调用推出的「已完成」,去重封顶;打字机 / 脉搏 / 收尾三处同一份。
    const autoMs = []
    const pushAuto = (m) => { if (m && !autoMs.includes(m) && autoMs.length < MILESTONE_MAX) autoMs.push(m) }
    const autoBlock = () => (autoMs.length ? autoMs.map((m) => '▶ ' + red(m)).join('\n') + '\n\n' : '')
    // 本轮实际会话 id,从事件流里捕(system init / thread 事件先于 result 到)。finalize 在
    // store.setSession **之前**跑(答案即结算),新会话首轮只有这里知道 id —— 会话规模记账
    // 与 codex 累计→增量换算都按它对账。
    // 本轮**接着谁跑**:空轮取证的判据之一(见下面 finalizeTurn 里那行)。必须在这里另存一份 ——
    // seenSessionId 会被事件流覆盖成本轮真实 id,事后就分不清「接的是旧会话」还是「新开的」。
    const resumedSid = this.store.getSession(msg.chatId) || null
    let seenSessionId = resumedSid
    let assistantEvents = 0 // 模型这一轮开没开口 —— 空轮取证判据之二(工具数由 toolCounts 另记)
    let compactNotified = false // 压缩群通知每轮至多一次(一轮内理论上也只压一次,双保险)
    // 「此刻会话驮着多大」的实时值,压缩通知报数用。压缩多发生在**轮次开始**(上一轮攒的
    // 上下文 + 新消息超限),此刻本轮还没有任何用量数 ⇒ 起点取会话账里上一轮收尾的 ctx;
    // 轮中压缩(工具结果撑大)则被本轮流式的逐请求值覆盖,谁新用谁。
    const st0 = this.store.getSessionStats(msg.chatId)
    let liveCtx = (st0 && st0.sessionId === seenSessionId && st0.ctx) || 0
    let cardDone = false
    const finishCard = (text, opts) => { cardDone = true; return card.finish(text, opts) }

    // Idempotent finalize: compute the outcome, settle the card (or send the plain
    // reply), and fire the console/ledger "done" (reportDone) — all at ANSWER-time.
    // Called first from onEvent's result event, so the group card and operator
    // console stop showing "in progress" the moment the answer lands rather than when
    // the process finally closes (codex.exe under the Windows cmd.exe shim can
    // cling to the stdout pipe for seconds past the answer). Called again post-await
    // as a no-op fallback for abort/error turns that never emitted a result event.
    let finalized = false
    let finalOutcome = null

    // 迟迟没动静先回一声(v0.11.10)。卡是懒建的(NO_REPLY 轮必须在群里无痕),所以**不能**一收到
    // 就回执 —— onlyWhenMentioned:false 的群里每句闲聊都会起一轮,那样比现在吵得多。做法 =
    // 等 ackDelayMs 还没有任何可见输出时,把本来就要建的那张流式卡**提前建出来**填「已收到」,
    // 答案到了在同一张卡里原地替换(update 走累积全量,天然覆盖),不多发任何消息。
    // ⚠ 「ack 后却转静默」是**一等公民路径**而非罕见兜底(生产机 ledger 里有 43s 才 NO_REPLY 的
    // 真任务),靠 finalize 撤回这张卡自愈 ⇒ 阈值只影响噪音量、不承载正确性。
    // 判据是**有没有人在等回复**,不是「是不是合成消息」(2026-08-21 修正)。
    // 原规则写的是「合成消息永不 ack:没人在等一句『收到』」—— 那条写在控制台插话存在**之前**。
    // 插话勾了「回复」时,operator 就在等;而它是合成消息 ⇒ 不 ack ⇒ 整轮没有卡,连脉搏都无处
    // 可写。实测(codex 那种整段文字在末尾才吐的后端):真人消息 39ms 就建出卡、期间 5 帧脉搏;
    // 同样的活走插话则 221ms 才建卡(临近收尾)、0 帧脉搏 —— operator 全程看不到任何动静。
    // ⇒ 定时任务 / 画布按钮仍然不 ack(确实没人等),插话由 wantsAck 显式声明。
    const ackMs = this.cfg.agent.ackDelayMs == null ? 25_000 : Number(this.cfg.agent.ackDelayMs)
    let ackTimer = null
    let ackShown = false
    let cardTouchedAt = 0            // 卡片最近一次被写过的时刻(脉搏据此避免白花调用)
    const pulseFrom = Date.now()     // 脉搏报「已跑多久」的起点(rt.startedAt 会被 release 清 0)
    if (ackMs > 0 && (!msg.synthetic || msg.wantsAck) && platform.createStreamingCard) {
      ackTimer = setTimeout(() => {
        // 同步复查,堵 24.9s 真输出 vs 25.0s timer 的竞态:此刻已有卡/有文本/已结算就别插手,
        // 否则 ack 文案会短暂盖掉真答案(buf 是 NO_REPLY 前缀同样在此被拦 —— 静默将至,别建了再撤)。
        if (finalized || cardP || buf.trim()) return
        ackShown = true
        ensureCard()
        if (cardP) cardP.then(() => { if (card && !cardDone) card.update(T.ackWorking) })
      }, ackMs)
    }

    // 长任务活体征(卡片脉搏):卡片只在**有文字输出**时更新,而一轮 25 分钟里可能全是工具调用
    // —— 2026-08-21 某项目实测:1508s / 40 次工具 / 正文 877 字,卡就原地停在「已收到,正在
    // 处理…」半小时,群里读起来就是「它卡死了」。那次事故正是这么误判、把一个马上要交付的任务
    // 掐掉的。⇒ 每隔一段往**已存在的**卡里补一行「已跑多久 · 最近动静多久前」。
    // ⭐ 判据是 aliveAt 不是 startedAt:跑了很久 ≠ 卡住了,能分开两者的只有「最近一次动静」。
    // ⚠ 三条硬约束:
    //   ① **绝不建卡** —— 卡是懒建的,NO_REPLY / quiet 轮建了就破坏「群里不留痕」;只在卡已存在
    //      时更新(quiet 轮 card 恒 null,天然免疫)。
    //   ② **自己控间隔** —— card.update 每次调用就是一次飞书 API。按真实流量算(日均 44 轮 /
    //      172 分钟,租户上限 100 万/月、sbot 全家现状 ≈9 千):120s ⇒ 合计 1.1% · 60s ⇒ 1.4% ·
    //      **15s ⇒ 2.9%(取用,仍有 34 倍余量)** · 10s ⇒ 3.9%。取 15s 而不是更保守的值,是因为
    //      配额根本不是约束(2026-08-21 用户明确「别超 100 万就行」),而**文字流式本来就是
    //      1500ms 一推** —— 脉搏 15 秒比现有行为温和得多。⚠ 上面是上界:**卡刚被文字更新过就
    //      跳过**(它已经在动,不必再补),真实更低。⚠ QPS 频控(99991400)是另一条独立限制,
    //      这个量级远够不着。
    //   ③ **必须 clearInterval + unref** —— 残留定时器会拖住 node --test 退出(ackTimer 有前科)。
    // ⚠ 做成可配是为了**能被测出来**:写死 120s,单测只能验「不该做什么」(没建卡、定时器清了)
    //   —— 而脉搏压根不触发时那些断言照样全绿,等于假测试(教训 29)。顺带 operator 也能按
    //   飞书配额自己调:0 = 关掉。
    //   ④ **跑久了就降频**(v0.11.48):15 秒的节奏是给「还在等它出声」那几分钟的;一轮跑到
    //      第 25 分钟时,盯着看的人早走了,而 100 帧脉搏里有 60 帧是纯浪费。跨过 slowAfter
    //      就把间隔放大到 cardPulseSlowMs(默认 60s)——「已跑多久」这种信息,一分钟一跳
    //      完全够用。⚠ 平台侧还有一层原因:超过 10 分钟后每帧都不再是流式推送而是**整卡
    //      更新**(飞书的流式模式 10 分钟自动关闭),单帧更贵,更不该按 15 秒刷。
    const PULSE_MS = this.cfg.agent.cardPulseMs == null ? 15_000 : Number(this.cfg.agent.cardPulseMs)
    //      ⚠ 阈值同样做成可配 —— 写死 10 分钟,单测只能靠等十分钟,等于没法验(教训 29)。
    const PULSE_SLOW_MS = this.cfg.agent.cardPulseSlowMs == null ? 60_000 : Number(this.cfg.agent.cardPulseSlowMs)
    const PULSE_SLOW_AFTER_MS = this.cfg.agent.cardPulseSlowAfterMs == null ? 10 * 60 * 1000 : Number(this.cfg.agent.cardPulseSlowAfterMs)
    //   ⑤ **停滞才提「最近动静」**(v0.11.95):没动静超过这个阈值才在脉搏里追加「最近动静 N 前」,平时那三个字
    //      是噪音。同样做成可配(默认 2 分钟)—— 写死两分钟,单测只能靠等两分钟。
    const PULSE_STALE_MS = this.cfg.agent.cardPulseStaleMs == null ? 2 * 60 * 1000 : Number(this.cfg.agent.cardPulseStaleMs)
    let pulseTimer = null
    if (PULSE_MS > 0 && platform.createStreamingCard) {
      // 本轮已跑多久 ⇒ 现在该多久一帧。定时器仍按 PULSE_MS 空转(不发 API),真正的闸在这。
      const pulseEvery = () => (Date.now() - pulseFrom >= PULSE_SLOW_AFTER_MS ? Math.max(PULSE_MS, PULSE_SLOW_MS) : PULSE_MS)
      pulseTimer = setInterval(() => {
        if (finalized || cardDone || !card) return
        // ⚠ 轮次身份守卫:本轮若已被强制释放(挂死进程)而 finally 还没跑到,这个 interval 仍活着
        //   —— 而 rt.steps / rt.aliveAt 此刻已属于**新一轮**,照读就会把别人的进度写进旧卡。
        if (rt.startedAt !== myStartedAt) return
        if (Date.now() - cardTouchedAt < pulseEvery()) return
        cardTouchedAt = Date.now()
        // 停滞判据:最近一次动静(aliveAt;还没有过动静就按开跑时刻)距今超过 PULSE_STALE_MS 才报
        const sinceAlive = Date.now() - (rt.aliveAt || pulseFrom)
        const stale = sinceAlive >= PULSE_STALE_MS ? humanDur(sinceAlive) : ''
        // ⚠ 正文这一段必须与流式那道门**同源判据**(见下方 ev.text 分支):`ack 预建卡`打破了
        //   「有卡 ⇒ 文本必已分歧」这个巧合 —— 少了 NO_REPLY.startsWith 这一问,静默轮里逐字
        //   吐出的 NO_REPLY 会被脉搏原样打进那张 ack 卡(痕迹泄漏)。实测复现过:
        //   卡上出现「NO_R ⏎⏎ ⏳ 处理中 …」。⚠ 两处各写一份判据必然漂移,改一处记得改另一处。
        const sofar = buf.trim()
        const body = autoBlock() + (sofar && !NO_REPLY.startsWith(sofar) ? red(renderMilestones(buf)) + '\n\n' : '')
        // 「最近在做」(v0.11.93)并进同一行(v0.11.95):模型不说话时,这就是卡上唯一的**内容**进展
        try { card.update(body + T.pulse(humanDur(Date.now() - pulseFrom), rt.doing || [], stale)) } catch { /* 卡不可用就算了,绝不影响轮次 */ }
      }, PULSE_MS)
      if (pulseTimer.unref) pulseTimer.unref()
    }

    // ack 卡后转静默 ⇒ 撤回它,保住「静默轮群里不留痕迹」这条不变量。
    // 撤不掉(平台不支持 / 超时 / 已被人删)才退一句中性收尾 —— 绝不把 streaming 卡晾在那。
    const dropAckCard = async () => {
      cardDone = true // 先置:失败也不能让 finally 兜底再 finish 一次
      if (card && card.recall) { try { if (await card.recall()) return true } catch { /* 退中性句 */ } }
      try { await card.finish(T.ackDropped) } catch { /* 卡已不可用,静默作罢 */ }
      return false
    }

    const finalizeTurn = async ({ result, aborted }) => {
      if (finalized) return finalOutcome
      finalized = true
      // Compute the outcome and publish finalOutcome SYNCHRONOUSLY — before any await — so a
      // concurrent finalizeTurn (the result event racing the post-await call) can never hit
      // the `if (finalized) return finalOutcome` guard while finalOutcome is still null. That
      // null propagated to reportDone(null) and crashed the daemon on `o.status`.
      const finalText = (result && result.text) || ''
      // Silence covers both shapes: NO_REPLY as the final result text, or streamed
      // as the only assistant output with no result text.
      const silent = finalText.trim() === NO_REPLY || (!finalText.trim() && buf.trim() === NO_REPLY)
      // 归一成「本轮增量」并顺手记会话规模账(/hud 会话行数据源)。finalized 闸门保证只结一次。
      const tokens = this._settleUsage(msg.chatId, seenSessionId, result)
      const tools = [...toolCounts.entries()].map(([name, count]) => ({ name, count }))
      // 空轮:进程正常退出,却一个字没产出、一个工具没调、输出 token 为 0 —— 模型压根没跑。
      // 旧口径把它记成 ok,群里只吐一句「(无输出)」:2026-08-13 某项目一条真人消息(合并
      // 4 条,含 3 张图)就这么静默蒸发了 25 分钟,而 ledger 那行写着 ok —— 连来排查的人都
      // 被这个 ok 骗过去。故 ok 的语义收窄为「真有产出」,零产出单列一档、自动重试一次。
      // ⚠ 三个零必须同时成立(宁可漏判不可误判):只要调过工具或产出过 token,本轮就可能已经
      // 改了文件、发过消息,重跑会把副作用做第二遍 —— 那种情况仍走 ok,不碰。
      const nothingProduced = !aborted && !(result && result.isError) && !silent &&
        !answer.trim() && !buf.trim() && !String(finalText || '').trim() &&
        tools.length === 0 && !(tokens && tokens.out > 0)
      const status = aborted ? 'stopped'
        : (result && result.isError) ? 'error'
          : silent ? 'no-reply'
            : nothingProduced ? 'empty'
              : 'ok'
      // 空轮取证(2026-09-05):「empty」这三个字**本身没有分辨力** —— 「模型开了口但没话说」
      // 和「这一轮压根没轮到我们的消息」在账本里长得一模一样,而两者的下一步动作完全相反。
      // 判据就三样,此刻都在手上,且**反过来输出会不同**:
      //   · result 事件到没到 ⇒ 到了 = CLI 正常收尾了一轮(只是那一轮干的不是我们的活);没到 = 进程半路没了
      //   · assistant 事件数 ⇒ 0 = 模型一次都没被调用(本次三例全是 0);>0 = 模型开过口,是它自己没话说
      //   · 接的是旧会话还是新开的 ⇒ 只有接旧会话才可能被上一轮的残留占掉这一轮
      // 配上 runner 侧「答案已到但没退出 ⇒ 强制收尾」那一行(claudecode.js armCloseGrace),
      // 一次复现即可定案:两行紧挨着 = 上一轮的后台任务把这一轮吃了。
      // ⚠ 放在这里(status 刚算出、卡片分支之前)是**有意的**:下面撤卡那条路与无卡那条路各有
      //   一个空轮出口,挂在任一处都会漏掉另一半 —— 而真机三次全落在无卡那条路上,正好是
      //   「只补看得见的那处」会漏掉的形状。
      if (nothingProduced) {
        this.log(`group ${msg.chatId}: 空轮判据 — result 事件=${result ? '有(' + (result.subtype || 'success') + ')' : '无'} · assistant 事件=${assistantEvents} · 会话=${resumedSid ? '续接 ' + String(resumedSid).slice(0, 8) : '新开'} · 耗时 ${Date.now() - myStartedAt}ms`)
      }
      // 「这段会话被掐断过」标记(v0.11.103,见 store.markTainted):被中止就打上 —— 不管是谁掐的
      //   (/stop · /skip · 控制台 · 撤回 · 墙钟 · 关停),被掐的轮若起过后台子任务,这段会话之后
      //   每一轮都会空转;真产出过一轮(ok / 静默)就清 —— 会话证明了自己接得上。空轮与出错
      //   两态不碰它:空轮正是它要指导的对象,出错说明不了会话好坏。
      // ⚠ 打标不看轮次身份(被 forceRelease 的轮 rt.startedAt 早被清零,而它恰是最需要打标的);
      //   清标同样不看 —— 迟到的 ok 也证明会话接得上。
      // ⚠ 只标**我接的那段**(store 里仍是 resumedSid):会话已被 /new 清掉、或继任者已在新会话上跑完并落盘,
      //   迟到的中止收尾都不该碰它(审查逮到:守卫只问「有没有会话」会把新会话打脏)。新开会话的首轮被掐断时
      //   这里 store 还是空的(会话在 runner resolve 后才落盘)⇒ 由下面 setSession 那一处顺手打标,两种形状各归其位。
      if (aborted) { if (this.store.markTainted && resumedSid && this.store.getSession(msg.chatId) === resumedSid) this.store.markTainted(msg.chatId) }
      else if ((status === 'ok' || status === 'no-reply') && this.store.clearTainted) this.store.clearTainted(msg.chatId)
      // 成功跑完一轮是「这个模型能用」最硬的证据:清掉它的「没额度 / 不可用」标(账号类的标否则只能等探针或人来清)
      if ((status === 'ok' || status === 'no-reply') && this.store.clearExhausted) this.store.clearExhausted(name)
      // 同一条证据也交给凭据验证记录;出错轮把原话交过去,由它判是不是认证 / 账户问题(网络、超时不算)
      if (this.verifyTurn && !aborted && (status === 'ok' || status === 'no-reply' || status === 'error')) {
        try { this.verifyTurn(provider, status !== 'error', String(finalText || '')) } catch { /* 只是体检参考,不能影响轮次收尾 */ }
      }
      const outcome = {
        status,
        provider: name,
        tokens,
        resumed: !!resumedSid, // 空轮重试的判据之一:只有续接的会话才有「换会话重做」这一步(_retryEmpty)
        preview: redact(String(finalText || buf || '')).replace(/\s+/g, ' ').trim().slice(0, 120),
        reply: redact(fullText || finalText || ''),
        tools,
        // 失败原因:**只认 finalText 与 subtype**,不碰 buf/answer(见 turnErrText 的注释 ——
        // 拿正常正文冒充错误原因,比不给原因更糟)。判据与卡片路径同源:那边也是 finalText 优先。
        errText: (result && result.isError) ? turnErrText(result.subtype, finalText) : '',
        // 额度 / 账号类失败(runner 标的 quota):派发层据此切备用模型。sideEffects = 这轮已经动过手(调过工具 /
        // 产出过 token),那就**不能**在新模型上重做(副作用会做第二遍)—— 判据与空轮重试的「三个零」同源。
        quota: (result && result.isError && result.quota) ? result.quota : null,
        // 续接的会话记录已不在(runner 标的 sessionGone):派发层换新会话重做。只对续接轮成立,也只重做一次
        sessionGone: !!(result && result.isError && result.sessionGone && resumedSid && !freshRetried),
        // ⚠ 不看 usage:claude CLI 会把「API Error: …」当一条 assistant 文本流出来、可能带 usage,按 output_tokens 判会把
        //   什么都没做的额度错轮判成「动过手」永不重做。判据 = 调过工具,或剔掉那行报错后还有真正文。
        sideEffects: tools.length > 0 || !!String(buf || '').replace(/\s*API Error:[^\n]*/gi, '').trim(),
      }
      finalOutcome = outcome
      // 额度 / 账号类出错行的人话(v0.11.107):与 transient 同一位置顶掉英文原话;重置时刻从原话解,解不出就不说
      const quotaHuman = outcome.quota ? T.quotaErr(outcome.quota.kind, outcome.quota.kind === 'quota' ? humanReset(parseResetAt(finalText, { tz: this.tz }) - Date.now()) : '', outcome.quota.window) : ''
      if (cardP) await cardP // settle card creation before finalizing the card
      // 卡上此刻显示的是不是那句 ack:ack 建过卡,且流式文本一次都没穿过 update 门(buf 为空,
      // 或还只是 NO_REPLY 的前缀)。判据与 onEvent 那道门同源 —— 两处各写一份必然漂移。
      const shown = buf.trim()
      const cardShowsAck = ackShown && !(shown && !NO_REPLY.startsWith(shown))
      // 卡上只有 ack 而本轮以静默/中止收场 ⇒ 撤掉整张卡。留着它是最糟的残留:群里永远挂着
      // 一句「正在处理…」,而事实是这轮早就结束了(静默轮还要保住「群里无痕」这条不变量)。
      // 空轮:撤掉整张卡,群里一点痕迹都不留 —— 接下来重试(同会话 / 换会话)还是出声,由派发层
      // _retryEmpty 定;重试成功群成员就当什么都没发生过。留一张写着「(无输出)」的卡反而在制造
      // 噪音和误解。(卡上此时必然只有 ack 或全空:nothingProduced 已要求 buf/answer/finalText 全空。)
      if (card && nothingProduced) {
        await dropAckCard()
      } else if (card && cardShowsAck && (silent || aborted)) {
        await dropAckCard()
      } else if (card && cardShowsAck && outcome.sessionGone) {
        await dropAckCard() // 派发层马上换新会话重做并说明原因;留一张英文报错卡只会让人以为失败了
      } else if (card) {
        let out
        // Recall-abort (handleRecall) closes the card with its own note; a plain /stop keeps 已停止.
        // answer 优先(v0.11.11):答案 = 最后一次工具调用之后的文本。answer 为空 = 这轮只有过程
        // 播报没有收尾答案 ⇒ 退回 buf(全量),宁可啰嗦也不空卡。中止路径同样先取 answer:被砍时
        // answer 多半为空(正卡在工具调用里),自然退回 buf 让人看见做到哪了。
        // 里程碑(v0.11.93):`>> ` 行从正文剔掉、整批交给平台收进折叠区 —— 不然「只留最后一段」会把
        // 中途报的进展全丢掉。剔完正文空了(模型只报了阶段、没写收尾)就让它们原地当正文,不空卡;
        // 中止 / 出错时哪怕正文空也交折叠区 —— 「做到哪了」正是那时最要看的。
        // 自动推出的在前、模型自己报的在后(后者极少;两者都有时也不互相排斥),去重后整批交平台。
        const milestones = [...autoMs, ...milestonesOf(buf)].filter((m, i, a) => a.indexOf(m) === i).map((m) => red(m))
        const rawAnswer = answer.trim() ? answer : buf
        let shownAnswer = milestones.length ? stripMilestones(rawAnswer) : rawAnswer
        let finishOpts
        if (milestones.length) {
          if (shownAnswer.trim() || aborted || (result && result.isError)) finishOpts = { milestones }
          else shownAnswer = milestones.map((m) => '▶ ' + m).join('\n') // 整批(不只最后一段里的),这就是「做到哪了」
        }
        if (aborted) out = red(shownAnswer) + (shownAnswer ? '\n\n' : '') + `_(${rt.recalled ? T.recalledStopped : T.stopped})_`
        else if (result && result.isError) {
          // 出错行:瞬时错说人话(runner 标的 transient;服务端原话只进账本),否则 finalText / 细分码 / 无输出。
          // ⚠ 已流出的正文**保住**,错误行跟在后面 —— 与中止路径同一形状。此前整卡被错误文案顶掉
          //   (finalText 出错时恒非空,shownAnswer 永远轮不到),群成员看到一句话闪了一下就没了
          //   (2026-09-08 测试群:「这个场景更适合可搜索的单页图标目录」被英文原话覆盖)。
          // ⚠ 「你刚才那条」只对真人消息成立:定时任务 / 画布通知 / 插话这类合成轮没有人「刚才说过」,不给这句
          const errLine = T.errorPrefix + red(result.transient || quotaHuman || finalText || (result.subtype ? `(${result.subtype})` : T.noOutput))
            + (result.transient && !msg.synthetic ? '\n' + T.transientHint : '')
          // ⚠ claude CLI 在 API 出错时会把「API Error: 529 {…}」同时当一条 assistant 文本流出来(2026-09-08 审查从
          //   二进制核对):它落进 buf / answer,不剔的话卡片正文就是英文原话 + 人话两份。流式片段是直接拼接的
          //   (前一段正文与这段之间没有换行),所以按片段剔:从「API Error:」起到行尾,前面的真正文一字不动。
          const body = String(shownAnswer || '').replace(/\s*API Error:[^\n]*/gi, '').trim()
          out = (body ? red(body) + '\n\n' : '') + errLine
        }
        // 空轮走到这儿 = 重试那一轮又空了 ⇒ 给下一步动作(再发一次),不再吐无信息量的「(无输出)」。
        else out = red(shownAnswer || finalText || (nothingProduced ? T.emptyTurn : T.noOutput))
        // 底部小字(T.cardFooter):耗时按本轮身份时刻算(与账本 ms 同一起点),用量取上面归一过的本轮增量。
        // 三条收尾路(正常 / 出错 / 中止)都带 —— 中止时更想知道白跑了多久。
        const footer = T.cardFooter({ ms: Date.now() - myStartedAt, tokens })
        if (footer) finishOpts = { ...(finishOpts || {}), footer }
        await finishCard(out, finishOpts)
        // v0.11.4~v0.11.10 这里会**另发一条**「表格文本版」纯文本。v0.11.11 拆除:可复制的内容
        // 已经收进卡片内一个默认收起的折叠区(feishu.js copyPanel)—— 不要的人看不见,要的人展开
        // 即得,群里不再为每个含表格的回答多一条消息(2026-08-06 用户提「太累赘」;真机 14 小时里
        // 4 次,其中 2 次卡片内已有同样的表格)。⚠ 退化路径(表格 >5 个 / 整卡更新被拒 ⇒ 退回
        // markdown 原样)因此也没有可复制版了 —— 那条路上清单教 agent 按要求补发一份纯文本。
      } else if (quiet) {
        // ⚠ 排在最前 = **连报错和中止提示也不进群**。这是取舍不是漏网:开关的语义是「这次动作
        // 在群里不留痕」,漏一条错误出去就破了承诺;而群成员从没看到过那句指令,凭空冒出一条
        // 报错只会更费解。代价是失败群里没人知道 ⇒ 界面必须写明「连出错也不会说」。
        // 账本与活动流照常记(status 仍是 ok/error),**是不广播,不是丢掉**。
        this.log('quiet turn — 群里不留痕(回复与报错都不广播)')
      } else if (aborted) {
        // Recall with nothing visible yet ⇒ stay fully silent (the user withdrew the message).
        // /stop ⇒ the command handler owns the single「已停止」confirmation (stopRequested) —
        // replying here too would double it. Other aborts (wall-clock cap) keep this reply.
        if (!rt.recalled && !rt.stopRequested) await reply(T.stopped)
      } else if (outcome.sessionGone) {
        // 无卡路径同上:不报错,派发层换新会话重做并说明原因
      } else if (result && result.isError) {
        // 无卡路径与卡片路径同一口径:瞬时错说人话 + 下一步
        await reply(T.errorPrefix + (result.transient || quotaHuman || finalText || (result.subtype ? `(${result.subtype})` : T.noOutput))
          + (result.transient && !msg.synthetic ? '\n' + T.transientHint : ''))
      } else if (silent) {
        // ⚠ quiet 连**报错**也一并压掉 —— 这个开关的语义就是「这次动作不在群里留痕」,
        // 漏一条错误出去就破了承诺。代价是失败也没人在群里知道,所以界面上必须写明
        // 「出错也不会说,状态去实时活动看」;账本与活动流照常记,不是丢掉而是不广播。
        this.log('NO_REPLY — staying silent') // no card, no reply — the turn stays fully silent
      } else if (nothingProduced) {
        // 无卡路径的空轮(纯文本兜底群 / 卡片建失败):这里静默,重试还是出声由派发层 _retryEmpty 定。
        this.log('empty turn — staying silent here; dispatcher decides retry / notice')
      } else {
        // Mirror the card path (answer || buf || finalText): the streamed buffer is the full
        // answer, while result.text may be only the LAST agent_message (codex streams several)
        // — so a plain-text fallback (cardkit scope missing) must prefer the buffers or codex
        // multi-part answers lose everything but the final chunk. reply() redacts.
        await reply((answer.trim() ? answer : buf) || finalText || T.noOutput, { final: true })
      }
      reportDone(outcome)
      releaseSlot() // hand the concurrency slot to the next group now — don't wait for close
      return outcome
    }

    try {
      const { sessionId, result, aborted } = await this.runner.runTurn({
        bin: this.cfg.agent.bin,
        prompt,
        appendSystemPrompt: SYSTEM_APPENDIX,
        provider,
        model: group.model,
        workdir: group.workdir,
        sessionId: this.store.getSession(msg.chatId),
        // Per-group permissionMode (no global default): each group picks its
        // own mode on its console card; unset ⇒ 'dontAsk', the fail-closed floor. Only the
        // two never-hang modes exist (dontAsk = read-only/whitelist · bypassPermissions =
        // full) — a headless 'default'/'acceptEdits' would hang on every out-of-policy call.
        permissionMode: group.permissionMode || 'dontAsk',
        // 长会话自动压缩阈值(agent.autocompactTokens,config 默认 40 万;0 = 关):两个 runner
        // 各自翻成自家 CLI 旗子。不设的话历史只增不减 —— 多天群会话实测涨到 96 万 token,
        // 两家 CLI 默认都一次没压过(2026-08-09 某项目数据;claude 40 万首压 08-11 已实证)。
        autocompactTokens: this._autocompactTokens(),
        // Permissions are PER-PROJECT: each group carries its own allow/deny, scoped
        // to its own workdir (cwd=workdir in the runner). No group ⇒ undefined ⇒ the
        // runner passes no --allowedTools ⇒ dontAsk locks it to the read-only safe set.
        allowedTools: group.allowedTools,
        disallowedTools: group.disallowedTools,
        // Per-group plugin enablement — opaque data to core, the runner
        // decides how to enforce. Absent ⇒ runner keeps its default plugin loading.
        plugins: group.plugins,
        signal: controller.signal,
        // Base-skill context (群项目基础能力): SBOT_CHAT_ID = the group's own chat id, and
        // SBOT_CONFIG = the daemon's resolved config path so `sbot feishu` finds the SAME config
        // regardless of cwd (the agent runs it from its workdir, where loadConfig's ./sbot.config.json
        // and ~/.sbot/config.json lookups would miss a config living elsewhere, e.g. ~/sbot/). Both
        // runners merge extraEnv; harmless to codex if it never runs the command.
        // TZ = cfg.timezone(默认北京):子进程里 date/Node/Python 及 CLI 自带的"今天日期"
        // 注入全部对齐产品时间口径(Windows cmd 的 date 不理 TZ,但 prompt 时间戳兜底)。
        // SBOT_UI_URL:控制台环回地址,`sbot browser link` 签接管链接时打它(没开控制台就不注入,命令会说清缘由)
        // ⚠ 收成 baseSkillEnv 一处(v0.11.105):定时脚本任务(cronfire)也要同一组变量 —— 09-17 18:00 一个报告脚本里
        //   `sbot feishu send-msg` 因为没有 SBOT_CHAT_ID 报「缺少目标群」退出码 1,两边各写一份就是这么漏的。
        extraEnv: this.baseSkillEnv(msg.chatId),
        log: this.log, // runner diagnostics (e.g. codex answer→close rollout-flush lag, ③)
        onEvent: (ev) => {
          if (ev.sessionId) seenSessionId = ev.sessionId
          // 压缩真发生时留痕 + 群里说一声(claude 以 system 事件报,subtype 形如 compact_boundary;
          // codex 的压缩不上 exec 输出流 ⇒ 只能对 claude 群通知,如实)。每轮至多一次;
          // fire-and-forget,通知失败绝不碰轮次。
          if (ev.type === 'assistant' && ev.contextTokens) liveCtx = ev.contextTokens
          if (ev.type === 'system' && /compact/i.test(ev.subtype || '')) {
            this.log(`context auto-compacted (${msg.chatId}, ~${ev.preTokens || liveCtx} tokens${ev.postTokens ? ` → ${ev.postTokens}` : ''})`)
            // 压缩会把会话最开头的自知清单折叠掉 ⇒ 作废注入记录,下一轮自然重发(v0.11.34)
            this._injectedManifest.delete(msg.chatId)
            // 清单会重发(上一行),但**任务进度那一半没人管**:压缩把久远内容折叠成摘要,
            // 「这个功能改到第几步、动过哪些文件、上次说好的口径」可能只剩一句概括。
            // ⚠ **引擎救不了当前这一轮** —— 压缩发生在轮次进行中,prompt 早发出去了,补不进话;
            //   能管的只有下一轮。所以这里只打标记,由下一轮的 prompt 消费(见 rt.compacted)。
            rt.compacted = true
            if (!compactNotified) {
              compactNotified = true
              // 压缩 = 这段会话刚烧掉几十万 token,正是该看一眼额度的时候(产品决定:
              // 压缩通知后汇报当前模型额度与用量)。通知与额度行并成**一条**发 —— 群里多一条就是
              // 一次刷屏;等探针回来再发,探针有缓存、冷路径也只是几秒,通知本就是轮中旁白。
              // ⚠ 上下文量必须此刻快照:探针回来前 liveCtx 可能已被压缩后的新请求值覆盖,
              //   那「此前上下文约 X」就会报成压缩**后**的数。额度探不到不拦通知(auto 模式给 null)。
              // 会话用量行取轮首读的会话账 st0(本轮还没结算):轮数 = 已结算轮数 + 进行中的这一轮;
              // 累计量不含本轮,略少一点如实。只认**当前会话**的账(与 /hud 同一道防线:换会话后的陈账不挂)。
              // runner 透传的 preTokens 优先(v0.11.93):liveCtx 是上一条 assistant 的 usage,工具结果没计进去
              const ctxAtCompact = ev.preTokens || liveCtx
              const postAtCompact = ev.postTokens || 0
              const sess = (st0 && st0.sessionId && st0.sessionId === resumedSid) ? T.sessionUsage(st0.turns + 1, st0.in) : null
              this._quotaLine(name, provider, { auto: true }).catch(() => null)
                .then((q) => reply([T.compacted(ctxAtCompact, this._autocompactTokens(), postAtCompact), q, sess].filter(Boolean).join('\n')))
                .catch(() => {})
            }
          }
          // The answer is complete → finalize NOW (card + console), decoupled from the
          // process close that the promise below still awaits. Both runners emit
          // this before close (codexcode/claudecode), so the path is runner-agnostic.
          // ⚠ aborted 必须现读信号,不能写死 false:被杀的 CLI **临死前还会吐一个 result 事件**
          // (探针实测 claude 2.1.228:SIGTERM 后 ~0.05s 出 subtype=error_during_execution ·
          // is_error=true · terminal_reason=aborted_streaming · usage 全零,再 close code=143)。
          // 写死 false 就等于让这一发抢先把轮次定成 error —— 撤回即停 / `/stop` / 墙钟到点全被
          // 记成故障,群里还给一句「出错」;runner 稍后带着正确的 aborted 回来时闸门已经关上。
          // 判据取 signal 而不是认 CLI 的 terminal_reason:core 不按名认具体 runner 的字段。
          if (ev.type === 'result') { finalizeTurn({ result: ev, aborted: controller.signal.aborted }).catch(() => {}); return }
          if (ev.type !== 'assistant') return
          assistantEvents += 1
          // /status 的「还在动吗」:任何 assistant 事件都算一次心跳。⚠ 必须带轮次身份守卫 ——
          // 被强释放的迟到轮还会吐事件,让它去撞新一轮的计数就等于报了个假进度。
          if (rt.startedAt === myStartedAt) {
            rt.aliveAt = Date.now()
            if (ev.tools && ev.tools.length) {
              rt.steps = (rt.steps || 0) + ev.tools.length
              for (const t of ev.tools) pushDoing(rt.doing || (rt.doing = []), describeTool(t.name, t.input))
            }
          }
          if (ev.tools && ev.tools.length) {
            this.log(`tool: ${ev.tools.map((t) => t.name).join(', ')}`)
            for (const t of ev.tools) { toolCounts.set(t.name, (toolCounts.get(t.name) || 0) + 1); pushAuto(autoMilestone(t.name, t.input)) }
          }
          if (ev.text) {
            // 里程碑边界补换行(v0.11.94):真机(生产机 deepseek)三行 `>> …` 各是一条事件、直接拼黏成
            // 「>> a>> b>> c」,只认出一条。⚠ 只在里程碑边界补(新文本以 `>>` 起头,或缓冲末行是 `>>` 行),
            // **不**对所有相邻事件补 —— 一条回复拆成多个事件到达是既有形状(codex multi-part、NO_REPLY 逐段吐),
            // 一律补会把一句话拆成两行、把逐段吐的 NO_REPLY 认不出来。打字机「旧文本是新文本前缀」不破。
            const atMilestone = /^>>/.test(ev.text)
            const sep = (s) => (s && !s.endsWith('\n') && !ev.text.startsWith('\n') && (atMilestone || /(^|\n)>>[^\n]*$/.test(s)) ? '\n' : '')
            fullText += sep(fullText) + ev.text
            buf += sep(buf) + ev.text
            answer += sep(answer) + ev.text
            const t = buf.trim()
            // hold the card back while the output could still become just NO_REPLY
            if (t && !NO_REPLY.startsWith(t)) ensureCard()
            // ⚠ 这道门与上面 ensureCard 同一判据:ack 预建卡打破了「有卡 ⇒ 文本必已分歧」这个
            // 巧合,少了它,流式吐出的 NO_REPLY 会被逐字打进那张 ack 卡里(痕迹泄漏)。
            if (cardP && t && !NO_REPLY.startsWith(t)) { cardTouchedAt = Date.now(); cardP.then(() => { if (card) card.update(autoBlock() + red(renderMilestones(buf))) }) } // cumulative → typewriter(`>> ` 显示成 ▶;自动里程碑块在前)
          }
          // 过程只流不留(v0.11.11):本段文本后面若跟着工具调用,它就是**过程说明**而不是答案
          // ——「我先去查一下」「派个 agent 核实」这类。清空 answer,只让最后一次工具调用之后
          // 的文本活到 finalize。⚠ 必须放在 text 累积之后:claude 把 text 与 tool_use 放在同一
          // 个 assistant 事件里(text 在前),先清后累会把该丢的那段留下来;codex 两者是分开的
          // 事件,顺序天然成立。answer 全程为空(只播报、没答案)时 finalize 退回 buf,不会空卡。
          if (ev.tools && ev.tools.length) answer = ''
        },
      })

      // Session persistence stays gated on the runner RESOLVING (= process close =
      // codex rollout durably written), so the next same-group resume finds its
      // rollout — the invariant restored in bdc3d33. Skip if /new interrupted this
      // turn, else the partial session resurrects the topic we just cleared.
      // Persist the session ONLY if this turn is still the active one: an interrupt (/new)
      // or a force-release (hung process) sets rt.startedAt away from ours, so a
      // late resolution can't resurrect a cleared session or clobber a newer turn's.
      if (sessionId && rt.startedAt === myStartedAt) {
        this.store.setSession(msg.chatId, sessionId)
        // 新开会话的首轮就被掐断(真实 runner 里 result 事件先到、finalize 已跑过、那时会话还没落盘)⇒ 落盘的同时打标,
        // 否则「只有一轮且那轮被掐断」的会话存在了却没标,下一条空转要多白跑一次同会话重试。
        if (aborted && this.store.markTainted) this.store.markTainted(msg.chatId)
      }
      // No-op if the result event already finalized; the fallback that covers a clean
      // close that streamed no explicit result event.
      const out = await finalizeTurn({ result, aborted })
      // 任务后开新会话(cron resetSession → msg.resetSessionAfter,v0.11.19):挂在「整理落盘」类
      // 定时任务之后的确定性翻篇 —— 交接文书就是任务刚写完的文档,比压缩的通用摘要干净。
      // 必须在 setSession **之后**清(先清会被上一行写回);只在成功结算时翻(出错/被人叫停
      // 时会话可能还有用,人工干预优先);turn 身份守卫同上一行 —— 迟到轮不许清新轮的会话。
      if (msg.resetSessionAfter && rt.startedAt === myStartedAt && (out.status === 'ok' || out.status === 'no-reply')) {
        this.store.clearSession(msg.chatId)
        this.store.clearSessionStats(msg.chatId)
        this.log(`定时任务后开新会话 (${msg.chatId})`)
      }
      return out
    } catch (e) {
      if (cardP) { try { await cardP } catch {} } // settle a mid-flight creation first
      // 模型程序找不到(runner 标 code,文案已是人话):让运维告警群知道 —— 否则只有人恰好开了会话才会发现
      if (e && e.code === 'AGENT_BIN_MISSING') this._alert({ kind: 'provider-down', provider: name, cause: 'binary', chatId: msg.chatId, source: 'turn', detail: e.message })
      if (card) { await finishCard(red((buf ? buf + '\n\n' : '') + T.failedPrefix + (e && e.message))) }
      else { await reply(T.failedPrefix + (e && e.message)) }
      return { status: 'failed', provider: name, tokens: null, preview: String((e && e.message) || '').slice(0, 120), reply: redact(fullText || ''), tools: [...toolCounts.entries()].map(([name, count]) => ({ name, count })), errText: turnErrText('exception', (e && e.message) || '') }
    } finally {
      // never leave a card stuck in streaming mode (gotcha: preheat needs fallback finalize)
      if (cardP) { try { await cardP } catch {} }
      if (card && !cardDone) { try { await card.finish(red(buf || `_${T.noOutput}_`)) } catch {} }
      if (capTimer) clearTimeout(capTimer)
      if (ackTimer) clearTimeout(ackTimer) // 必须清:残留的 25s timer 会拖住 node --test 退出
      // ⚠ 必须清:它是 **interval**,不清就每轮泄漏一个、永远跑下去。
      // ⚠ **这一行没有单测覆盖,别因为没测试就删它**。试过两版判据都不合格:
      //   ① 「收尾后卡片还有没有写入」—— 没分辨力:泄漏的回调进来会被 cardDone 挡住,不写卡
      //      照样泄漏;② `process.getActiveResourcesInfo()` 数 Timeout —— 也没分辨力:这个
      //      interval 是 unref 过的,压根不算「活跃资源」。正反都绿的测试比没有测试更糟(教训 29),
      //      所以宁可不写。判据留在这儿:daemon 长跑后若发现定时器随轮次累积,先回来看这一行。
      if (pulseTimer) clearInterval(pulseTimer)
      releaseSlot() // no-op if the answer already freed it; fallback for abort/error/silence
    }
  }
}

// 群内控制面的命令清单 —— **单一事实源**。加它是因为 Slack 那边 `/` 被平台自己占了
// (真机 2026-09-01:`/status` 根本发不出来,Slack 当成它自己的斜杠命令吃掉),
// 适配器要按这份清单把替代前缀(如 `!stop`)还原成 `/stop` 再交给引擎。
// ⚠ 与上面 switch 的 case 标签必须一致 —— tests/unit/engine.test.js 有一条用例直接从本文件
//   源码里把 case 标签抠出来对比,新增命令忘了加进这里会自己红(教训:写成注释挡不住漂移)。
const SLASH_COMMANDS = ['/help', '/model', '/new', '/stop', '/skip', '/status', '/issue', '/hud']

module.exports = { Engine, Semaphore, NO_REPLY, turnErrText, milestonesOf, renderMilestones, stripMilestones, describeTool, autoMilestone, SLASH_COMMANDS }
