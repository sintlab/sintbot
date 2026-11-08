// 企业微信「不 @ 也回复」:轮询群历史补入站(纯逻辑,依赖全注入,可单测)。
//
// 为什么要它:长连接只推 @ 机器人的消息(平台边界,10-10 真机实证),而官方命令行工具能拉近 7 天群历史、含不 @ 的
// 人类发言。所以「不 @ 也回复」= 每隔 intervalMs 拉一次已绑群的历史,把新出现的人类消息喂给引擎;回复走主动推送。
// 轮询本身零 token(HTTP 调用,不经模型);**真正烧 token 的是喂模型** —— 一条就是一轮、带整段会话上下文。
// 所以这里有一道**规则门控**(零 token),只放行两类:
//   ① 消息里点了机器人的名(botName / keywords 里任一,如「机器人」「助手」);
//   ② 跟进窗口内:机器人在这个群上一次被 @ 或上一次开口之后 followMs 内的消息(「@ 一次开了头,接下来几句不用再 @」)。
// 其余只留在历史里不喂(agent 要上下文时自己 history)。followMs = 0 ⇒ 不设窗口,全部都喂(明知烧 token 的 operator 自己选)。
// 第二道门「便宜模型门控」(规则不放行的再问一个便宜 provider 该不该接)由 wecomgate.js 实现、经 gate 选项注入;没配就只有规则这一道。
//
// 去重两道:① 与长连接已投递的 @ 消息去重(同一群、剥 @ 后正文相同、时间差 ≤ DUP_WINDOW_MS)—— 否则每条 @ 消息会被答两遍;
//          ② 同一秒内的重叠:水位按 send_time 字面量(秒级)推进,边界那一秒的消息靠 (send_time|userid|content) 键去重。
// 启动第一轮只建基线不投递(否则把近 7 天的旧消息全灌进去)。

const DUP_WINDOW_MS = 3 * 60_000

// 工具给的 send_time 是北京时间字面量「YYYY-MM-DD HH:MM:SS」⇒ 毫秒
function parseBeijing(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6])
}

// 历史消息 → 片段:{ type:'text', text } | { type:'media', kind:'image'|'file'|'video', mediaId, name }。
// 历史列表里的媒体只有 media_id(内容要另调取媒体接口),所以这里只拆不下载 —— 下不下载由 pollChat 按门控结果决定:
// 门控不放行的消息根本不喂,也就不必为它起一次子进程去取图。语音有转写就当文字(不下载音频)。
function messageParts(m) {
  if (!m) return []
  const media = (kind, obj) => ({ type: 'media', kind, mediaId: (obj && obj.media_id) || null, name: (obj && obj.file_name) || null })
  switch (m.msg_type) {
    case 'text': return [{ type: 'text', text: String((m.text && m.text.content) || '') }]
    // ⚠ 历史接口的图文混排是 `mixed.items`(schema MixedContent.items,真机 10-12 一条带字的图就这样被拆成空、静默略过),
    //    长连接回调那边是 `mixed.msg_item` —— 两套字段名,两个都认
    case 'mixed': return ((m.mixed && (m.mixed.items || m.mixed.msg_item)) || []).map((it) => it && it.msg_type === 'text' ? { type: 'text', text: String((it.text && it.text.content) || '') } : (it && it.msg_type === 'image' ? media('image', it.image) : null)).filter(Boolean)
    case 'image': return [media('image', m.image)]
    case 'file': return [media('file', m.file)]
    case 'voice': return [{ type: 'text', text: String((m.voice && m.voice.content) || '') ? '(语音转文字)' + m.voice.content : '[语音]' }]
    case 'video': return [media('video', m.video)]
    default: return []
  }
}
const mediaLabel = (kind) => (kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件')
// 片段 → 一行正文(媒体给占位标记):去重键与日志用;喂引擎的正文由 pollChat 另拼(媒体换成本机路径标记)
function messageText(m) {
  return messageParts(m).map((p) => p.type === 'text' ? p.text : `[${mediaLabel(p.kind)}${p.name ? ' ' + p.name : ''}]`).filter(Boolean).join(' ')
}
// 只取文字片段(去重与点名判定用:长连接那边记的是剥 @ 后的纯文字,不含媒体标记 —— 只发一张图 @ 机器人时两边都是空串才对得上)
const plainText = (m) => messageParts(m).filter((p) => p.type === 'text').map((p) => p.text).filter(Boolean).join(' ')
// 本机路径标记,与长连接入站那条(wecom.js mediaMark)同一形状 —— 清单只教了一种写法
const defaultMark = (kind, p) => `[${mediaLabel(kind)} path=${p}]`

function createHistoryPoll({
  chats = () => [],            // () => 要轮询的群 id 列表(每 tick 现读,跟随配置热重载)
  list,                        // (chatId) => Promise<messages[]>(工具的 chat messages list)
  deliver,                     // (msg) => void 把一条人类消息喂给引擎(InboundMessage 形状)
  wasDelivered = () => false,  // (chatId, text, tMs, {userId,userName}) => bool 长连接是否已投递过这条(去重 @ 消息;text = 剥 @ 后的纯文字,不含媒体标记;meta 让适配器把账号 ↔ 姓名对上)
  stripMention = (t) => t,     // 剥正文里的 @机器人
  fetchMedia = null,           // async ({kind, mediaId, name}, base) => 本机路径;null = 不下载,媒体只给「[图片]」占位(没装命令行工具时)
  mark = defaultMark,          // (kind, path) => 正文里的本机路径标记(与长连接入站同形)
  gate = null,                 // 第二道门(便宜模型门控,wecomgate.js):async (chatId, {text, sender, recent}) => bool;规则不放行时才问;null = 没配
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  intervalMs = 20_000, followMs = 5 * 60_000,
  // 分档间隔(两车道,v0.11.115):intervalMs 是「温」档(配置里的 pollSec);热 = 跟进窗口内(刚被 @ / 刚开口 / 刚喂过),
  // 冷 = 这个群 idleMs 内没有任何人类发言;授权 / 规模门控类错误(850003 / 853006)整体暂停 pauseMs 再试 —— 刷也刷不出来,只会刷出告警
  hotMs = 8_000, coldMs = 0, idleMs = 10 * 60_000, pauseMs = 30 * 60_000,
  botName = '', keywords = ['机器人', '助手'],
  log = () => {},
} = {}) {
  const state = new Map()   // chatId → { last: send_time 字面量, keys: Set }
  const followUntil = new Map() // chatId → 跟进窗口截止(ms)
  const nextAt = new Map()      // chatId → 下次该拉的时刻(ms);没记录 = 立刻
  const lastHumanAt = new Map() // chatId → 历史里最后一条人类消息的时刻(ms),喂没喂都记 —— 分档用
  let pausedUntil = 0           // 授权类错误 ⇒ 整体暂停到这个时刻
  const coldOf = () => (coldMs > 0 ? coldMs : Math.max(6 * intervalMs, 120_000))
  const hotOf = () => Math.min(hotMs, intervalMs)
  // 这个群现在该多久拉一次:热 / 温 / 冷
  const tierMs = (chatId) => {
    const t = now()
    if ((followUntil.get(chatId) || 0) > t) return hotOf()
    const lh = lastHumanAt.get(chatId)
    if (lh == null || !(t - lh >= idleMs)) return intervalMs // 没见过 = 温
    return coldOf()
  }
  const tierName = (chatId) => { const ms = tierMs(chatId); return ms === hotOf() && (followUntil.get(chatId) || 0) > now() ? 'hot' : ms === intervalMs ? 'warm' : 'cold' }
  const recent = new Map()  // chatId → [{sender, text}] 最近几句(只给第二道门当上下文;喂没喂都记,机器人自己的话读不到 —— 历史里没有)
  const RECENT_KEEP = 8
  const remember = (chatId, sender, text) => { const arr = recent.get(chatId) || []; arr.push({ sender, text }); if (arr.length > RECENT_KEEP) arr.shift(); recent.set(chatId, arr) }
  let timer = null, stopped = true, failStreak = 0
  // botName / keywords 可以是函数(现读配置,控制台改了热生效);每次判定现算名单,几个字符串的开销可忽略
  const names = () => { const b = typeof botName === 'function' ? botName() : botName; let k = typeof keywords === 'function' ? keywords() : keywords; if (!Array.isArray(k)) k = ['机器人', '助手']; return [b, ...k].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean) }

  const mentioned = (text) => { const t = String(text || '').toLowerCase(); return names().some((n) => t.includes(n)) }
  // 规则门控:点名 ⇒ 喂;跟进窗口内 ⇒ 喂;followMs 为 0 ⇒ 全喂
  const shouldFeed = (chatId, text, tMs) => {
    if (followMs === 0) return true
    if (mentioned(text)) return true
    return tMs <= (followUntil.get(chatId) || 0)
  }

  async function pollChat(chatId) {
    let msgs
    try { msgs = await list(chatId) } catch (e) {
      failStreak++
      if (failStreak <= 3 || failStreak % 30 === 0) log(`企业微信群历史轮询失败(…${String(chatId).slice(-8)},第 ${failStreak} 次): ` + String((e && e.message) || e).slice(0, 160))
      if (e && e.code === 'ENOENT') { stop(); log('企业微信命令行工具未安装,「不 @ 也回复」已停') }
      // 850003 = 工具能力授权过期(创建者点链接续期)· 853006 = 企业规模门控(官方未开放):都不是刷能刷出来的,整体歇 pauseMs 再试
      else if (e && /^(850003|853006)$/.test(String(e.code))) { pausedUntil = now() + pauseMs; log(`企业微信「不 @ 也回复」暂停 ${Math.round(pauseMs / 60_000)} 分钟(${e.code}:${e.code === '853006' || e.code === 853006 ? '企业规模门控,官方未对本企业开放读群历史' : '工具能力授权过期,要创建者续期'})`) }
      return
    }
    failStreak = 0
    const st = state.get(chatId)
    const sorted = (msgs || []).filter((m) => m && m.send_time).sort((a, b) => String(a.send_time).localeCompare(String(b.send_time)))
    if (sorted.length) { const lt = parseBeijing(String(sorted[sorted.length - 1].send_time)); if (Number.isFinite(lt)) lastHumanAt.set(chatId, lt) }
    if (!st) { // 第一轮:只建基线
      const last = sorted.length ? String(sorted[sorted.length - 1].send_time) : ''
      state.set(chatId, { last, keys: new Set(sorted.filter((m) => String(m.send_time) === last).map(keyOf)) })
      return
    }
    const fed = [] // 本轮放行的消息:攒成一批投递(一轮答完),不是每条各起一轮
    for (const m of sorted) {
      const t = String(m.send_time)
      if (t < st.last) continue
      const k = keyOf(m)
      if (st.keys.has(k)) continue
      if (t > st.last) { st.last = t; st.keys = new Set() }
      st.keys.add(k)
      const parts = messageParts(m)
      const plain = stripMention(plainText(m)).replace(/\s+/g, ' ').trim()
      const medias = parts.filter((p) => p.type === 'media')
      if (!plain && !medias.length) continue
      const tMs = parseBeijing(t)
      // 去重与门控都按纯文字判:长连接那边记的也是纯文字(只发一张图 @ 机器人 ⇒ 两边都是空串,才对得上;拿带「[图片]」的串去比永远对不上 = 同一张图答两遍)
      const sender = String(m.user_name || m.userid || '')
      if (wasDelivered(chatId, plain, tMs, { userId: String(m.userid || ''), userName: String(m.user_name || '') })) { remember(chatId, sender, plain || messageText(m)); continue } // 长连接已投递的 @ 消息(上下文照记,纯图记成占位;meta 给适配器桥接姓名)
      // 第一道门(规则,零 token)不放行 ⇒ 有第二道门(便宜模型)就问它;它说不要、或没配 ⇒ 不喂。
      // 先 remember 再问:给门控看的上下文不含这一句本身(它在「候选消息」里单独给)
      const ctx = (recent.get(chatId) || []).slice()
      remember(chatId, sender, plain || messageText(m))
      if (!shouldFeed(chatId, plain, tMs)) {
        if (!gate || !plain) continue // 纯媒体没有文字可判,不问
        // 候选句要带上附件提示:门控看不到图,「这是什么界面」配一张图是在问机器人,光看文字像闲聊(真机 11:44 判成了 NO)
        const hint = medias.length ? ' ' + medias.map((md) => `[附${mediaLabel(md.kind)}${md.name ? ' ' + md.name : ''}]`).join(' ') : ''
        let ok = false
        try { ok = await gate(chatId, { text: plain + hint, sender, recent: ctx }) } catch (e) { log('企业微信门控异常(当作不答): ' + (e && e.message)) }
        if (!ok) continue
      }
      // 门控放行了才去取媒体(每个媒体一次子进程):取到给本机路径标记,取不到给一句能看懂的失败标记 —— agent 至少知道「这里有张图我没拿到」
      const marks = []
      const stamp = t.replace(/\D/g, '')
      for (let i = 0; i < medias.length; i++) {
        const md = medias[i]
        if (!fetchMedia || !md.mediaId) { marks.push(`[${mediaLabel(md.kind)}${md.name ? ' ' + md.name : ''}]`); continue }
        try { marks.push(mark(md.kind, await fetchMedia(md, `poll-${stamp}-${hash(k)}-${i + 1}`))) }
        // ⚠ 失败标记不带错误原话:原话里有命令行工具名 / 机器路径(ENOENT 的完整路径、工具 usage),agent 会顺手复述给群成员;它只需要知道「这张图没拿到」
        catch (e) { log(`企业微信群历史媒体下载失败(${md.kind}): ` + String((e && e.message) || e).slice(0, 160)); marks.push(`[${mediaLabel(md.kind)} 下载失败]`) }
      }
      const text = [plain, ...marks].filter(Boolean).join('\n')
      // label = 给推送引用行用的原话:纯文字,媒体只给「[图片 a.png]」这种不带本机路径的标记(用户面零路径)
      fed.push({ userId: String(m.userid || ''), sender, text, label: plain || messageText(m), stamp, k, tMs: Number.isFinite(tMs) ? tMs : now(), hhmm: t.slice(11, 16) })
    }
    if (!fed.length) return
    // 攒批:同一轮拉到的多条放行消息合成一条投递 —— 引擎按一轮处理,回复一次。多条时每行带「[时分 发送者]」,
    // 代表(msgId / 时间 / 发送者)取末条,与引擎出队合并的口径一致;推送回复要引用的也是末条。
    const last = fed[fed.length - 1]
    const body = fed.length === 1 ? last.text : fed.map((f) => `[${f.hhmm} ${f.sender}] ${f.text}`).join('\n')
    try {
      deliver({
        chatId,
        userId: last.userId,
        senderName: last.sender,
        text: body,
        msgId: `poll:${chatId}:${last.stamp}:${hash(last.k)}`,
        createTimeMs: last.tMs,
        // 没有 req_id ⇒ 回复走主动推送、没有流式;quote 给适配器在推送开头引用原话(推送不会自动引用,群里分不清在回谁)
        // 攒批时引用行要让群里看出「这一条回了好几句」:more = 末条之前还有几条;senders = 几个人在说
        replyCtx: { chatId, chatType: 'group', quote: { sender: last.sender, text: String(last.label || '').slice(0, 40), more: fed.length - 1, senders: new Set(fed.map((f) => f.sender)).size } },
        polled: true,
        batchOf: fed.length,
      })
    } catch (e) { log('企业微信轮询投递异常: ' + (e && e.message)) }
    bump(chatId, now() + hotOf()) // 喂过 ⇒ 下次拉取按热档提前(跟进窗口由机器人开口时开,这里不开 —— 门控口径不变)
  }

  const chatIds = () => { try { return (chats() || []).filter((id) => /^wr/.test(String(id))) } catch { return [] } }
  // 一个定时器,到点扫一遍:只拉到期的群,拉完按各自档位记下次;定时器定在最早到期的那个群。
  // 手动调 tick()(测试 / 排障)= 不看档位全拉一遍;定时器走 tick(false) 只拉到期的
  // ⚠ 不可重入:一轮 tick 里 await 着门控 / 媒体下载时,kick / noteActivity 会重定定时器 —— 若放任第二个 tick 并发跑同一个群,
  //   两份 pollChat 会乱序投递(后一份先投了更新的消息,前一份随后投的旧消息被引擎水位线当陈旧丢掉 = 静默吞消息)。
  //   跑着时只记「要再来一次」,末尾 arm 时 nextAt 已被 bump 改过,自然算出立即到期。
  let running = false
  async function tick(force = true) {
    if (stopped || running) return
    running = true
    timer = null
    try {
      const ids = chatIds()
      const t0 = now()
      for (const id of ids) {
        if (!force && pausedUntil > now()) break // 撞到授权 / 门控类错误:别让剩下的群各起一次子进程撞同一个错
        if (!force && (nextAt.get(id) || 0) > t0) continue
        try { await pollChat(id) } catch (e) { log('企业微信轮询异常(跳过本群本轮): ' + (e && e.message)) } // 串行:一次一个子进程,别把工具打爆;任何意外抛出都不许杀掉整条轮询
        // 本轮内有人 bump 过(喂过 ⇒ 热档、答完补拉)就保留那个更早的时刻;否则按档位记下次。cur > t0 区分「新 bump」与触发本次的旧到期值
        const cur = nextAt.get(id); const planned = now() + tierMs(id)
        nextAt.set(id, cur != null && cur > t0 && cur < planned ? cur : planned)
      }
      if (pausedUntil > now()) for (const id of ids) nextAt.set(id, Math.max(nextAt.get(id) || 0, pausedUntil))
    } finally { running = false }
    arm()
  }
  function arm(ids = chatIds()) {
    if (stopped || running) return // 跑着时不设定时器:tick 末尾会按最新的 nextAt 重定
    if (timer) { clearTimer(timer); timer = null }
    const t = now()
    let due = Infinity
    for (const id of ids) due = Math.min(due, nextAt.has(id) ? nextAt.get(id) : t)
    if (!Number.isFinite(due)) due = t + intervalMs // 一个群都没绑:按温档再看(配置热重载可能加群)
    timer = setTimer(() => tick(false), Math.max(0, due - t))
  }
  // 把某个群的下次拉取提前到 at(只提前不推后),并重定定时器
  function bump(chatId, at) { if (!chatId || stopped) return; const cur = nextAt.get(chatId); if (cur == null || at < cur) nextAt.set(chatId, at); arm() }

  function start() {
    if (!(intervalMs > 0)) return false
    stopped = false
    timer = setTimer(() => tick(false), 0)
    return true
  }
  function stop() { stopped = true; if (timer) { clearTimer(timer); timer = null } }
  // 机器人在这个群被 @ 了 / 开口了 / 喂过了 ⇒ 开(续)跟进窗口,并切到热档(下次拉取提前到 hotMs 内)
  function noteActivity(chatId) { if (!chatId) return; if (followMs > 0) followUntil.set(chatId, now() + followMs); bump(chatId, now() + hotOf()) }
  // 补拉:delayMs 后就拉这个群一次(机器人刚答完,跟进句通常紧跟其后)
  function kick(chatId, delayMs = 0) { bump(chatId, now() + Math.max(0, delayMs)) }

  return { start, stop, tick, noteActivity, kick, shouldFeed, tierName, _state: state, _nextAt: nextAt }
}

const keyOf = (m) => `${m.send_time}|${m.userid || ''}|${messageText(m)}`
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) }

module.exports = { createHistoryPoll, parseBeijing, messageText, messageParts, plainText, DUP_WINDOW_MS }
