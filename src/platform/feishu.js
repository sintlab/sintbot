// Feishu (Lark) platform — implements the core.Platform contract (interfaces.js)
// over @larksuiteoapi/node-sdk's WSClient (WebSocket long connection, no public
// URL needed). The SDK manages tenant_access_token + reconnect/heartbeat.
//
// Scope:
//   - one WS connection for the whole daemon (same app_id must share one WS, or
//     the platform load-balances events across connections and drops messages)
//   - normalize text / post messages into InboundMessage
//   - group @mention gating (p2p DMs are not gated)
//   - reply / send as plain-text messages (CardKit streaming cards are M3)
//
// Not handled yet (later): images, streaming cards, permission card buttons.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const lark = require('@larksuiteoapi/node-sdk')
const { createWatchdog } = require('./wswatchdog')
const { scanTables, cleanCell, mdTablesToText } = require('../core/mdtable')

// lark SDK failures bury the actionable message (missing scope + the grant link,
// error code) inside the axios response body — surface it, or operators only see
// "Request failed with status code 400" (hit live: 99991672 缺 im:chat 权限).
function larkErrMsg(e) {
  const d = e && e.response && e.response.data
  const msg = (d && (d.msg || d.message)) || (e && e.message) || String(e)
  return d && d.code ? `${msg} [code ${d.code}]` : msg
}

// Extract plain text from a Feishu message (text + basic post/rich-text).
function parseText(message) {
  let c
  try { c = JSON.parse(message.content) } catch { return null }

  // 附件标记:图片/文件消息不再整条丢弃 —— 转成带下载坐标的文本标记喂给 agent
  // (真机踩过:「我发给你的图里的那张表」,图被静默丢了,agent 无从知道有图)。标记里
  // message_id + key 正是 `sbot feishu download` 要的两个参数,清单同步教这条藤怎么摸;
  // 历史(fetchChatHistory)同一条解析线 ⇒ 群里翻旧图也拿得到坐标。
  const mid = message.message_id || ''
  const mark = (kind, key, name) => `[${kind}${name ? ' ' + name : ''} message_id=${mid || '?'} key=${key}]`

  if (message.message_type === 'text') {
    const t = String(c.text || '').replace(/@_user_\d+/g, ' ').replace(/\s+/g, ' ').trim()
    return t || null
  }
  if (message.message_type === 'image') {
    return c.image_key ? mark('图片', c.image_key) : null
  }
  if (message.message_type === 'file') {
    return c.file_key ? mark('文件', c.file_key, c.file_name || '') : null
  }
  if (message.message_type === 'post') {
    try {
      const parts = []
      for (const line of c.content || []) {
        for (const seg of line) {
          if (!seg) continue
          if (seg.tag === 'text' && seg.text) parts.push(seg.text)
          // rich-text links must reach the model (FR1.4): keep text AND href —
          // "看下这个 issue: <链接>" without the URL is useless to the agent.
          else if (seg.tag === 'a' && (seg.href || seg.text)) parts.push(seg.text && seg.href ? `${seg.text}(${seg.href})` : (seg.href || seg.text))
          // 富文本里嵌的图与文字一起到 —— 「一段说明+一张截图」是最常见的报障形态
          else if (seg.tag === 'img' && seg.image_key) parts.push(mark('图片', seg.image_key))
        }
      }
      const t = parts.join(' ').replace(/\s+/g, ' ').trim()
      return t || null
    } catch { return null }
  }
  return null // sticker / 音视频等 — 仍不进轮(表情包不值得起一轮)
}

// Group-message gating: handle everything EXCEPT a message that
// @mentions other people but not the bot. no mention → handle · @bot (even with
// others) → handle · @others-only → skip. onlyWhenMentioned ⇒ strict (only @bot).
// Needs botOpenId to distinguish the bot's mention; without it, can't filter.
function shouldHandleGroup(message, botOpenId, onlyWhenMentioned) {
  const mentions = (message && message.mentions) || []
  const botMentioned = botOpenId ? mentions.some((m) => m && m.id && m.id.open_id === botOpenId) : false
  if (onlyWhenMentioned) return botMentioned
  if (!mentions.length || botMentioned || !botOpenId) return true
  return false
}

// 流式卡片推送节流(v0.7.6,飞书 API 月调用量优化)。两个 runner 都是**每条 assistant 消息**
// 推一次累积全文(claudecode 合并 text blocks / codex 的 agent_message 完成才发,非 token
// delta)⇒ 模型连续说话时短时间内多次 cardElement.content,每次都是一次计入配额的 API 调用。
// 累积文本天然幂等(后一帧含前一帧全部内容)⇒ **丢中间帧无损**,只是打字机粒度变粗(用户
// 2026-07-25 拍板:一行一行显示也可接受)。策略 = 时间窗 + trailing flush:窗内的更新只记
// pending,窗一到补发最后一帧 —— 少了 trailing,末段文字会停在半路直到 finish 才出现。
// 首帧不等待(lastSentAt=-Infinity),首字尽快落地。intervalMs=0 ⇒ 逐帧推(旧行为)。
// 纯工厂,now/setTimer/clearTimer 全注入 ⇒ 可单测(同 wswatchdog 纪律)。
function createCardThrottle({ intervalMs = 0, send, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = null // 待发的累积文本(null = 无挂起帧)
  let timer = null
  let lastSentAt = -Infinity
  let lastSent = null

  function fire() {
    timer = null
    if (pending == null) return
    const t = pending
    pending = null
    lastSentAt = now()
    lastSent = t
    send(t)
  }

  return {
    push(text) {
      pending = text
      if (!intervalMs) return fire()
      const wait = intervalMs - (now() - lastSentAt)
      if (wait <= 0) return fire()
      if (!timer) { timer = setTimer(fire, wait); if (timer && timer.unref) timer.unref() } // unref:挂起帧不拖住进程退出
    },
    // 收尾:取消挂起的定时器,交出尚未推送的文本(null = 已全部推完)。
    drain() { if (timer) { clearTimer(timer); timer = null } const t = pending; pending = null; return t },
    lastSent: () => lastSent,
  }
}

// ⚠ **每一个 cardkit 调用都必须过这道门**:SDK 对业务错误(HTTP 200 + code≠0)**不抛**,
// 失败与成功长得一模一样。2026-08-21 的教训就是这道门只装在整卡更新上、流式推送与关流式
// 两处漏了 ⇒ 推送被拒却一路 resolve,引擎当答案已送达、账本记 ok,而群里那张卡永远停在
// 最后一帧。判据只此一处,别再各写一份。
function assertCardOk(r, what = '卡片操作') {
  if (r && typeof r.code === 'number' && r.code !== 0) {
    // 码永远带上:msg 是给人看的,码才是能查文档/能对上真机探针的那个东西(larkErrMsg 同形)。
    const msg = r.msg ? String(r.msg).replace(/^ErrMsg:\s*/, '').replace(/;\s*$/, '').trim() : ''
    const e = new Error(`${what}被拒:${msg ? msg + ' ' : ''}[code ${r.code}]`)
    e.code = r.code
    throw e
  }
  return r
}

// 飞书:流式更新模式在**开启后 10 分钟自动关闭**(官方文档 streaming-updates-openapi-overview:
// "The streaming update mode will automatically close 10 minutes after it is enabled")。
// 而整卡更新(card.update)只受卡片实体 14 天有效期约束 —— 实测流式关闭后仍 code=0。
// ⚠ **两个码**都表示「流式这条路已经走不通」,12 分钟真机探针里同一张卡先后回过这两个:
//   t=10min → 200850 card streaming timeout    —— 恰好撞线的那一帧
//   t=12min → 300309 streaming mode is closed  —— 此后一直是它
// 只认其中一个,撞线那一帧就会被当成真错误丢掉(而日志里只留一行没人会看的报错)。
const ERR_STREAM_DEAD = new Set([200850, 300309])
const STREAM_WINDOW_MS = 9 * 60 * 1000 // 10 分钟的窗口留 1 分钟余量(时钟漂移 + 在途请求)

// Opt-in seam for a future durable effect executor. Every call to invoke is
// exactly one SDK request; the boundary sees its stable operation ID, target,
// confirmed result or thrown error. It must persist intent before invoking.
// Without a boundary, all existing card behavior remains unchanged.
async function cardOperation(boundary, operationKey, kind, target, invoke) {
  if (!boundary) return invoke()
  if (typeof boundary !== 'function' || typeof operationKey !== 'string' ||
      !operationKey || Buffer.byteLength(operationKey) > 256) {
    throw new TypeError('card operation boundary needs a stable operation key')
  }
  let invoked = false
  let settled = false
  let invokeError = null
  const result = await boundary({ operationId: `${operationKey}:${kind}${target.sequence == null ? '' : ':' + target.sequence}`,
    kind, ...target, invoke: async () => {
      if (invoked) throw new Error('card operation already invoked')
      invoked = true
      try { return await invoke() } catch (e) { invokeError = e; throw e }
      finally { settled = true }
    } })
  if (invokeError) throw invokeError
  if (!invoked || !settled) throw new Error('card operation boundary did not await one SDK call')
  return result
}

// ── 卡片写入器(纯工厂:client / 时钟 / 窗口全可注入 ⇒ 可单测)─────────────────────
// 一张流式卡的**所有**写操作都从这里出去,好处是「往哪条路写」只剩一个判断点:
//   窗口内        → cardElement.content(有打字机动画)
//   窗口外 / 被拒 → card.update 整卡更新(动画没了,但内容一定落地)
// ⚠ 收尾正文**一律走整卡更新** —— 它是一轮里唯一不能丢的东西,而流式那条路会在第 10 分钟
//   静默失效。2026-08-21 某项目实测:24 分钟的一轮,卡停在第 10 分钟的脉搏上,活白干,
//   而日志、账本、控制台三处都显示这轮 ok。
function createCardWriter({
  client, cardId, elementId = 'answer', log = () => {}, now = () => Date.now(),
  throttleMs = 0, streamWindowMs = STREAM_WINDOW_MS, setTimer = setTimeout, clearTimer = clearTimeout,
  operationBoundary = null, operationKey = null,
  initialText = '', initialSequence = 1,
} = {}) {
  const openedAt = now()
  let seq = initialSequence // Includes any confirmed settings call before this writer opens.
  let streamOpen = true  // 飞书侧流式模式还开着吗
  // ⚠ 「已收尾」与「已冻结」是两件事,合成一个标记会吃掉一条兜底路径:撤回失败时调用方
  //   要退一句中性收尾(engine 的 dropAckCard),而 recall 若把 finish 一并封死,那张卡就
  //   永远晾在「处理中」—— 正是这次要根治的症状。
  let done = false       // finish 已经跑过(幂等用)
  let frozen = false     // 撤回在途:不再受理新的流式帧,但 finish 仍可收尾
  // 配额账三个数(飞书租户级 100 万次/月,见 memory)。⚠ 记的是**调用次数**、成败都算:
  // 一次被拒的整卡更新照样占了一次请求,而「退路会再记一次」正是要看见的东西。
  let pushes = 0         // 流式帧 cardElement.content
  let fulls = 0          // 整卡更新 card.update
  let closes = 0         // 关流式 card.settings
  const resumes = initialText ? 1 : 0 // Confirmed pre-writer streaming enable.
  let lastSeen = initialText // Seed only after the snapshot's create/post have been confirmed.
  let confirmedText = initialText || null // 只记录平台确认过的正文,不能把已派发当成已送达
  let chain = Promise.resolve()
  let finishResult = null
  let boundaryError = null
  let updateRevision = 0
  let flushedRevision = -1
  const enqueue = (fn, { terminal = false } = {}) => {
    const operation = chain.then(() => { if (boundaryError) throw boundaryError; return fn() })
    chain = operation.catch((e) => {
      log('feishu card op error: ' + (e && e.message))
      if (operationBoundary) boundaryError = e
      return null
    })
    return terminal ? (operationBoundary ? operation : operation.then((ack) => ack === true ? true : null, () => null)) : chain
  }
  const confirmedCardAck = (response, action) => {
    assertCardOk(response, action)
    if (!response || response.code !== 0) throw new Error(`${action}未确认:未返回 code=0`)
    return true
  }
  const expired = () => now() - openedAt >= streamWindowMs

  // ⚠ 序号由上面那个分配器**统一发**,整卡更新不再自己取秒级时间戳 —— 服务端只比大小
  // (倒退实测回 300317 sequence number compare failed),小整数完全够用;两条路各自取号
  // 才是会撞的那种写法。
  const writeBody = async (elements, boundary = operationBoundary) => {
    fulls++
    const sequence = seq++
    await cardOperation(boundary, operationKey, 'card.update',
      { cardId, sequence }, async () => {
        const response = await updateCardEntity(client, cardId, {
          schema: '2.0',
          config: { streaming_mode: false, summary: { content: '' } },
          body: { elements },
        }, sequence)
        confirmedCardAck(response, '更新卡')
        return response
      })
    streamOpen = false
    return true
  }
  const writeFull = async (text) => {
    const ack = await writeBody([{ tag: 'markdown', content: text, element_id: elementId }])
    confirmedText = text
    return ack
  }

  const pushStream = async (text) => {
    pushes++
    const sequence = seq++
    const uuid = crypto.randomUUID()
    await cardOperation(operationBoundary, operationKey, 'cardElement.content',
      { cardId, elementId, sequence, uuid }, async () => confirmedCardAck(await client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { content: text, sequence, uuid },
    }), '流式推送'))
    confirmedText = text
    return true
  }

  // 单一写入口。⚠ **只有「流式到期」那两个码才降级** —— 其它错误照抛(由 enqueue 记进
  // 日志),绝不能再被吞掉:这次事故的一半就是「失败与成功长得一模一样」。
  // 两道判断缺一不可:上面那道(按时间)省掉注定失败的调用,下面那道(按错误码)兜住
  // 「窗口其实比我们以为的短/起点不同」—— 判据不一致时,以服务端说的为准。
  const write = async (text) => {
    if (streamOpen && expired()) {
      log(`feishu card: 已跨过流式窗口(${Math.round(streamWindowMs / 60000)} 分钟),改走整卡更新`)
      streamOpen = false
    }
    if (streamOpen) {
      try { return await pushStream(text) } catch (e) {
        if (operationBoundary || !ERR_STREAM_DEAD.has(e.code)) throw e
        log(`feishu card: 流式已到期(${e.code}),改走整卡更新`)
        streamOpen = false
      }
    }
    await writeFull(text)
  }

  const closeStreaming = async () => {
    if (!streamOpen) return true
    closes++
    const sequence = seq++
    const uuid = crypto.randomUUID()
    try {
      await cardOperation(operationBoundary, operationKey, 'card.settings',
        { cardId, sequence, uuid }, async () => confirmedCardAck(await client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence, uuid },
      }), '关流式'))
    } catch (e) { if (operationBoundary || !ERR_STREAM_DEAD.has(e.code)) throw e } // 已经自动关了 = 目的已达成
    streamOpen = false
    return true
  }

  const throttle = createCardThrottle({ intervalMs: throttleMs, send: (t) => enqueue(() => write(t)), now, setTimer, clearTimer })

  return {
    // 推累积全量文本(旧文本是新文本前缀 ⇒ 打字机动画)。节流:窗内攒着,窗到补最后一帧。
    update(text) {
      if (done || frozen) return
      const t = String(text || '')
      if (!t || t === lastSeen) return
      lastSeen = t
      updateRevision++
      flushedRevision = -1
      throttle.push(t)
    },
    // Durable v2 callers use this before a terminal reply attempt. Drain a
    // throttled trailing frame and wait for every earlier SDK operation. A
    // concurrent update invalidates the proof, so finish must flush again.
    async flush() {
      if (!operationBoundary || done || frozen) {
        throw new Error('durable card flush needs an open operation boundary')
      }
      const revision = updateRevision
      const trailing = throttle.drain()
      if (trailing !== null) enqueue(() => write(trailing))
      await chain
      if (boundaryError) throw boundaryError
      if (done || frozen || updateRevision !== revision) {
        throw new Error('durable card changed during flush')
      }
      flushedRevision = revision
      return true
    },
    // buildElements(t):答案含表格时给出整卡元素(表格精致化);返回 null ⇒ 普通 markdown。
    finish(text, { buildElements = () => null, terminalOperationBoundary } = {}) {
      if (done) return finishResult
      const terminal = terminalOperationBoundary !== undefined
      if (terminal && (!operationBoundary || typeof terminalOperationBoundary !== 'function' ||
          flushedRevision !== updateRevision || frozen ||
          typeof text !== 'string' || !text.trim())) {
        throw new Error('durable card terminal needs flushed nonempty text and one boundary')
      }
      done = true
      const leftover = throttle.drain() // 取消挂起帧,拿回还没推的文本
      const t = String(text || '') || leftover || ''
      let els = null
      try { els = buildElements(t) } catch { /* 构建失败按无表格处理 */ }
      finishResult = enqueue(async () => {
        try {
          if (terminal) {
            // The outer finalReply effect owns this one SDK call. A final
            // card.update also closes streaming mode; no card.settings or
            // second outbound attempt may be nested under that effect.
            const elements = els || [{ tag: 'markdown', content: t, element_id: elementId }]
            const ack = await writeBody(elements, terminalOperationBoundary)
            confirmedText = t
            return ack
          }
          if (els) {
            // 表格被拒就退普通 markdown(宁可松散不可丢内容)
            try { const ack = await writeBody(els); confirmedText = t; return ack }
            catch (e) {
              if (operationBoundary) throw e
              log('feishu card table render fallback: ' + (e && e.message))
            }
          }
          // ⭐ 有正文一律整卡更新落地;没有新正文才只关流式 —— **绝不拿空正文去刷卡**,
          //    那会把已经推上去的内容抹掉(「ack 后转静默」走的正是空正文这条)。
          if (t && t !== confirmedText) return await writeFull(t)
          return await closeStreaming()
        } finally {
          // ⚠ 这行必须打在**收尾之后**:收尾自己那一次调用(整卡更新 / 关流式)就发生在这个
          // 回调里。原先它打在回调外、且只报节流器的派发次数 ⇒ 降级后的整卡更新与收尾那次
          // 全在账外(实测漏计 ≈44 次/天)。注释写着「配额账可实测」,那就得真能对上账。
          log(`card ops: ${pushes + fulls + closes + resumes} 次调用(流式 ${pushes} · 整卡 ${fulls} · 关流式 ${closes}${resumes ? ` · 恢复流式 ${resumes}` : ''})`)
        }
      }, { terminal: true })
      return finishResult
    },
    // recall:先断掉后续流式帧再去删消息。⚠ 只冻结不收尾 —— 撤不掉时调用方还要退一句中性收尾。
    markClosed() { frozen = true; flushedRevision = -1 },
    settle: () => chain.then((result) => { if (boundaryError) throw boundaryError; return result }),
    stats: () => ({ pushes, fullUpdates: fulls, closes, calls: pushes + fulls + closes + resumes, streamOpen, seq }),
  }
}

/**
 * @param {object} opts
 *   appId, appSecret      — Feishu app credentials
 *   botOpenId             — the bot's open_id; used to detect @mentions precisely
 *   requireMention        — gate group messages on an @mention (default true)
 *   log                   — (msg) => void
 *   onConn                — (health) => void, connection-state changes (console SSE)
 *   ws                    — WS watchdog tuning (real-machine tunable, all optional):
 *                           pingTimeoutSec / handshakeTimeoutMs / tickIntervalMs /
 *                           staleReconnectingMs / backoffBaseMs / backoffCapMs
 *   card                  — 流式卡片调优:throttleMs(推送节流窗,默认 1500;0 = 逐帧推)
 * @returns {import('../core/interfaces').Platform}
 */
// ── 回答卡表格精致化──────────────────────────────────────────────
// markdown 表格在卡片里被客户端渲染成分页控件:行高松散、长列截断还要横向滚动
// (2026-08-04 群里真实反馈「显示不全、不紧凑、不精致」)。原生 table 组件能钉住这些:
// 紧凑行高(low)+ 固定列宽 + 灰底表头。列宽策略出自真机探针逐张对比、operator 拍板:
//   ⚠ 自定义 px 宽下限 80(更小被 200912 拒,「column idx:N」);
//   ⚠ auto/百分比列宽在手机端直接不渲染该列(真机踩过,整列消失比截断严重得多)
//     ⇒ 全表**恰好一个 auto**(给内容最宽的文本列,通常是标题/描述列),其余一律固定 px。
// 表格数 >5 超官方单卡上限 ⇒ 返回 null,走 markdown 原样兜底(宁可松散不可丢内容)。

// 显示宽度粗估(px):CJK/全角 14px、ASCII 7px,加左右内边距。只用来选「哪列最宽给 auto」
// 与给短文本列钉宽,估歪一点无碍(有 80/220 双向夹紧)。
const cellPx = (s) => 26 + [...String(s)].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? 14 : 7), 0)

function tableElement(seg) {
  const n = seg.header.length
  const meta = []
  for (let c = 0; c < n; c++) {
    const cells = seg.rows.map((r) => (r[c] == null ? '' : r[c]))
    meta.push({
      numeric: cells.length > 0 && cells.every((v) => /^-?\d+(\.\d+)?$/.test(v)), // 纯数字列(含小数);带 %/千分位按文本走
      md: cells.some((v) => /\[[^\]]*\]\([^)]*\)|\*\*|~~|`|<br/i.test(v)), // 含 markdown 语法 ⇒ lark_md 保渲染(链接可点)
      maxPx: Math.max(cellPx(seg.header[c] || ''), ...cells.map(cellPx)),
    })
  }
  // 恰好一个 auto:内容最宽的非数字列;全是数字列则给最后一列(表不能没有弹性列)
  let autoIdx = -1
  let best = -1
  for (let c = 0; c < n; c++) if (!meta[c].numeric && meta[c].maxPx > best) { best = meta[c].maxPx; autoIdx = c }
  if (autoIdx < 0) autoIdx = n - 1
  const columns = meta.map((m, c) => {
    const col = {
      name: 'c' + c,
      display_name: cleanCell(seg.header[c] || ''),
      data_type: m.numeric ? 'number' : (m.md ? 'lark_md' : 'text'),
      width: c === autoIdx ? 'auto' : (m.numeric ? '80px' : Math.min(220, Math.max(80, m.maxPx)) + 'px'),
    }
    if (m.numeric && c > 0) col.horizontal_align = 'right' // 数字右对齐好比大小;首列序号仍左对齐(探针 A 形态)
    return col
  })
  const rows = seg.rows.map((r) => {
    const o = {}
    for (let c = 0; c < n; c++) {
      const v = r[c] == null ? '' : r[c]
      // lark_md 保留原始语法(<br/> 换成真换行);纯文本列剥掉粗体/行内代码标记(不渲染只会露原字符)
      o['c' + c] = meta[c].numeric ? Number(v) : (meta[c].md ? v.replace(/<br\s*\/?>/gi, '\n') : cleanCell(v))
    }
    return o
  })
  return {
    tag: 'table',
    page_size: 10, // 官方上限;>10 行翻页(结构性限制,伴随文本版恒完整)
    row_height: 'low',
    freeze_first_column: false,
    header_style: { text_align: 'left', background_style: 'grey', text_size: 'normal', text_color: 'grey', bold: true },
    columns,
    rows,
  }
}

// 可复制版折叠区:原生 table 好看但手机端选不中、整卡转发也带不走表格内容(飞书平台
// 限制,卡片 config 无「可复制」开关)。v0.11.4 的解法是每次都**另发一条**纯文本 —— 真机 14 小时
// 里 4 次,其中 2 次卡片内已有同样的表格,纯属重复,群里嫌累赘(2026-08-06 用户提)。
// 现在收进卡片内一个**默认收起**的折叠面板:不要的人完全看不见,要复制的人展开即得,群里不再
// 多一条消息、不需要按钮回调、不存任何状态、重启无影响。
// ⚠ 字段已用 card.create 探针验过被服务端接受(全字段/最小字段/plain_text 标题三形态皆收),
// 但「服务端接受 ≠ 语义生效」是本项目头等坑 —— 真实渲染仍以真机目视为准。
function copyPanel(tsv) {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: '📋 可复制版(粘贴进表格自动分列)' },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px', color: 'grey' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    // 代码块:等宽对齐 + 客户端自带复制;内容是 Tab 分隔,复制出去粘进表格即自动分列。
    elements: [{ tag: 'markdown', content: '```\n' + tsv + '\n```' }],
  }
}

// 「过程」折叠区:引擎从本轮正文里认出的里程碑行(`>> …`,见 engine milestonesOf),收尾
// 时整批交到这里。默认收起 —— 卡片仍然只露答案(v0.11.11 的「简」不破),要看做了哪几步的人展开即得;
// 中止 / 出错时它就是「做到哪了」。形状与 copyPanel 同款(同一组已被服务端接受的字段)。
function milestonePanel(lines) {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: `▶ 过程(${lines.length} 步)` },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px', color: 'grey' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: lines.map((l) => '▶ ' + l).join('\n') }],
  }
}

// 最终回答 → 卡片 body 元素序列:markdown 段照旧,表格段换成原生 table 组件,末尾挂一个
// 默认收起的「可复制版」折叠区;有里程碑再挂一个「过程」折叠区;有 footer 再在最底加一行小字。
// 三样都没有 ⇒ null(调用方走原 markdown 收尾,零变化)。
// footer(2026-09-16 用户提):耗时与 tokens 一行,引擎拼好文字、这里只管形状 —— 与生图进度卡 /
// 接管卡的小字同款(text_size notation + 灰字;note 组件在 schema 2.0 已被拒,见 memory 卡片全集)。
function answerCardElements(text, { milestones = [], footer = '', footerDetail = '' } = {}) {
  const segs = scanTables(text)
  const tables = segs.filter((s) => s.kind === 'table')
  const ms = (Array.isArray(milestones) ? milestones : []).filter((m) => typeof m === 'string' && m.trim())
  const ft = typeof footer === 'string' ? footer.trim() : ''
  const ftDetail = typeof footerDetail === 'string' ? footerDetail.trim() : ''
  const nativeTables = tables.length > 0 && tables.length <= 5
  if (!nativeTables && !ms.length && !ft && !ftDetail) return null
  const elements = []
  if (nativeTables) {
    for (const seg of segs) {
      if (seg.kind === 'text') {
        const t = seg.text.replace(/^\n+|\n+$/g, '')
        if (t.trim()) elements.push({ tag: 'markdown', content: t })
      } else {
        elements.push(tableElement(seg))
      }
    }
    const tsv = mdTablesToText(text)
    if (tsv) elements.push(copyPanel(tsv))
  } else {
    // 表格走不了原生组件(没有 / 超上限)⇒ 正文整段 markdown 原样,只是多挂一个折叠区
    const t = String(text || '').replace(/^\n+|\n+$/g, '')
    if (t.trim()) elements.push({ tag: 'markdown', content: t })
  }
  if (ms.length) elements.push(milestonePanel(ms))
  // ⚠ 顺序钉死:正文 → 可复制版 → 过程 → 小字。小字是整卡最底、右对齐(2026-09-16 定下的位置:
  //   「小号字体、卡片右下角」);notation = 12px,是 markdown 组件最小的一档,右对齐靠 text_align。
  // 合为同一段次要信息，避免两个组件的垂直留白；手机宽度不足时自然换行。
  // 型号来自可配置字段，继续转义，不能直接插进 font 标签。
  const safeDetail = ftDetail.replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const footerText = [ft, safeDetail].filter(Boolean).join(' · ')
  if (footerText) {
    elements.push({ tag: 'markdown', text_size: 'notation', text_align: 'right', content: `<font color='grey'>${footerText}</font>` })
  }
  return elements
}

function createFeishuPlatform({ appId, appSecret, botOpenId = null, onlyWhenMentioned = false, log = () => {}, onConn = () => {}, ws = {}, card = {}, client: suppliedClient = null } = {}) {
  if (!appId || !appSecret) throw new Error('feishu: appId and appSecret required')

  const client = suppliedClient || new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.warn })
  // 流式卡片推送节流窗(ms)。缺省 1500 = 每 1.5s 最多刷一次卡;显式 0 ⇒ 逐帧推(旧行为)。
  const cardThrottleMs = Number(card.throttleMs) === 0 ? 0 : Math.max(0, Number(card.throttleMs) || 1500)
  let wsClient = null
  let watchdog = null
  let tickTimer = null
  let serviceIntakeClosed = true

  // WS liveness tuning — see wswatchdog.js. All configurable via cfg.feishu.ws so the
  // detection策略 can be tuned on the real machine without a code change. pingTimeout is the KEY knob: the SDK's pong-watchdog is off by
  // default, so a half-open socket goes undetected and the bot silently goes deaf.
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d)
  const pingTimeoutSec = num(ws.pingTimeoutSec, 30)      // ping unanswered this long ⇒ terminate ⇒ reconnect
  const handshakeTimeoutMs = num(ws.handshakeTimeoutMs, 15_000) // stuck DNS/proxy handshake ⇒ abort attempt
  const tickIntervalMs = num(ws.tickIntervalMs, 30_000)  // health tick (drives the wedged-state rebuild)
  const wdOpts = {
    staleReconnectingMs: num(ws.staleReconnectingMs, 120_000),
    backoffBaseMs: num(ws.backoffBaseMs, 2_000),
    backoffCapMs: num(ws.backoffCapMs, 60_000),
  }

  // Sender display names: the event only carries open_id, but the
  // [sender] prompt tag must be a human name — an opaque ou_… id is useless for
  // attribution and gets mangled by outbound redaction. Best-effort with a
  // process-lifetime cache; a failed lookup (e.g. missing contact:contact.base:readonly
  // scope) is cached as null so we don't hammer the API, and callers fall back.
  const nameCache = new Map() // openId -> name | null
  let nameScopeWarned = false
  let memberNameWarned = false
  async function senderNameOf(openId, chatId = null) {
    if (!openId) return null
    if (nameCache.has(openId)) return nameCache.get(openId)
    let name = null
    try {
      const r = await client.contact.user.get({ params: { user_id_type: 'open_id' }, path: { user_id: openId } })
      name = (r && r.data && r.data.user && (r.data.user.name || r.data.user.nickname)) || null
    } catch (e) {
      if (!nameScopeWarned) {
        nameScopeWarned = true
        log('feishu: 拉取用户名失败(需要 contact:contact.base:readonly scope?),发送者标注回退为 open_id — ' + larkErrMsg(e))
      }
    }
    // 通讯录查不到(缺 scope、或发送者不在应用的通讯录范围内 —— 基础版多人群常见)时,退到当前群的
    // 成员列表:名字随成员一起返回,顺带把同群其他人也写进同一份缓存。
    if (!name && chatId) {
      try {
        for (const m of await fetchChatMembers(client, chatId)) {
          if (m.name && m.name !== m.openId && !nameCache.get(m.openId)) nameCache.set(m.openId, m.name)
        }
        name = nameCache.get(openId) || null
      } catch (e) {
        if (!memberNameWarned) {
          memberNameWarned = true
          log('feishu: 群成员列表取名失败 — ' + larkErrMsg(e))
        }
      }
    }
    nameCache.set(openId, name)
    return name
  }

  async function sendText(chatId, content) {
    if (!chatId || !content) return null
    try {
      const r = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: content }) },
      })
      // SDK 对 HTTP 200 + 业务 code≠0 不抛。只有 code===0 且有消息 ID
      // 才能把主动发送当作已确认；调用方据此决定是否结算。
      if (!r || r.code !== 0) { log('feishu send rejected: code=' + (r && r.code)); return null }
      const messageId = (r.data && r.data.message_id) || r.message_id || null
      if (!messageId) log('feishu send rejected: missing message_id')
      return messageId
    } catch (e) {
      log('feishu send error: ' + larkErrMsg(e))
      return null
    }
  }

  return {
    features: { cardQuota: true, noticeCard: true, cardPinned: true }, // 回复卡钉在触发消息下;补话落地后可搬到新消息下
    async start(onMessage, hooks = {}) {
      if (!botOpenId && !onlyWhenMentioned) log('warning: feishu.botOpenId not set — cannot tell @bot from @others; all group messages will be handled')
      if (hooks.onFatal !== undefined && typeof hooks.onFatal !== 'function') {
        throw new TypeError('feishu fatal intake hook must be a function')
      }
      serviceIntakeClosed = false
      let intakeClosed = false
      const closeFatalIntake = (error) => {
        if (!hooks.onFatal || intakeClosed) return
        // This is the opt-in durable ingress boundary: a failed receipt/lock
        // operation cannot be reduced to a log line and followed by more input.
        intakeClosed = true
        serviceIntakeClosed = true
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
        if (watchdog) watchdog.stop()
        try { if (wsClient?.close) wsClient.close({ force: true }) } catch {}
        try {
          Promise.resolve(hooks.onFatal(error)).catch(e =>
            log('feishu fatal intake hook rejected: ' + (e && e.message)))
        } catch (e) {
          log('feishu fatal intake hook threw: ' + (e && e.message))
        }
      }
      const reportOnMessageFailure = error => {
        log('feishu onMessage error: ' + (error && error.message))
        closeFatalIntake(error)
      }

      const dispatcher = new lark.EventDispatcher({}).register({
        // 撤回即停:用户撤回了发给 bot 的消息 ⇒ 引擎跳过/中止对它的处理(排队剔除,运行中如 /stop)。
        // 表情回应 → hooks.onReaction:画布播报「点 👍 即触发按标注改」的确认信号(匹配与防重
        // 语义在 boardwatch/bin,本文件只做事件搬运)。该事件早已随 recall 一并订阅(err.log 曾见
        // no-handle 警告实锤在推),注册 handler 即收,不需要发版。⚠ payload 不带 chat_id —— 匹配
        // 只靠 message_id(播报消息 id 全局唯一,足够)。
        'im.message.reaction.created_v1': async (data) => {
          if (serviceIntakeClosed) return
          if (watchdog) watchdog.onEvent()
          try {
            const ev = (data && data.event) || data || {}
            const msgId = ev.message_id
            const operatorId = (ev.user_id && ev.user_id.open_id) || ev.operator_id || null
            const emoji = (ev.reaction_type && ev.reaction_type.emoji_type) || ''
            if (msgId && hooks.onReaction) hooks.onReaction({ msgId, operatorId, emoji })
          } catch (e) {
            log('feishu reaction event error: ' + (e && e.message))
          }
        },
        // 卡片按钮回调(2026-07-22):画布播报卡「按标注改图」等 callback 按钮 → hooks.onCardAction。
        // 走同一条 WS 长连接 —— SDK 低层 EventDispatcher.invoke 认此 key,**handler 的返回值经
        // WSClient 回传作 3s 响应**(base64(respPayload.data)→ toast/更新卡片;见
        // SDK 契约实锤)。前提:飞书后台开「长连接接收回调」
        // + 发版(2026-07-22 用户已发版)。normalizeCardAction 归一 → {messageId(卡片
        // open_message_id),chatId,operator.openId,action.value}。返回 undefined = 保持卡片不变。
        'card.action.trigger': async (data) => {
          if (watchdog) watchdog.onEvent() // 任何入站事件都是链路活性信号
          try {
            const evt = lark.normalizeCardAction((data && data.event) || data)
            if (!evt) return
            if (evt.operator && evt.operator.openId && botOpenId && evt.operator.openId === botOpenId) return // bot 自身,忽略
            if (hooks.onCardAction) return await hooks.onCardAction(evt) // 返回值 = WS 回传的 3s 响应
          } catch (e) {
            log('feishu card action error: ' + (e && e.message))
          }
        },
        // 需在开放平台补订阅 im.message.recalled_v1(与 receive_v1 同权限);未订阅则事件不来,零回归。
        'im.message.recalled_v1': async (data) => {
          if (serviceIntakeClosed) return
          if (watchdog) watchdog.onEvent() // 任何入站事件都是链路活性信号
          try {
            const ev = (data && data.event) || data || {}
            const chatId = ev.chat_id || (ev.message && ev.message.chat_id)
            const msgId = ev.message_id || (ev.message && ev.message.message_id)
            // 到达即打日志(哪怕后面不匹配)——「事件没到 vs 到了没停」是排查这条链路的第一刀:
            // 没这行时事件未订阅和解析失败都表现为无声无息,真机上无从区分。
            log(`feishu recall event: chat=${chatId || '?'} msg=${msgId || '?'}`)
            if (chatId && msgId && hooks.onRecall) hooks.onRecall({ chatId, msgId })
            else if (!chatId || !msgId) log('feishu recall event: 缺 chat_id/message_id,raw=' + JSON.stringify(ev).slice(0, 300))
          } catch (e) {
            log('feishu recall event error: ' + (e && e.message))
          }
        },
        // 画布自动感知(B3;docs/BOARD.md):画板被编辑 ⇒ 交给 hooks.onBoardUpdated(去抖/diff/
        // 播报的语义在守护进程侧的 boardwatch,本文件只做事件搬运)。该事件是**按画板订阅制**
        // (subscribeBoard),后台还须订阅事件类型 + 发版;未订阅零回归。纪律同 recall:到达即
        // 打日志、不在 handler 里 await 慢查询。
        'board.whiteboard.updated_v1': async (data) => {
          if (serviceIntakeClosed) return
          if (watchdog) watchdog.onEvent()
          try {
            const ev = (data && data.event) || data || {}
            const wbId = ev.whiteboard_id
            // operator_ids 为三元 id 对象数组;只取 open_id 系,供 boardwatch 做自编辑抑制
            const ops = Array.isArray(ev.operator_ids)
              ? ev.operator_ids.map((o) => (o && (o.open_id || o.user_id || o.union_id)) || '').filter(Boolean)
              : []
            log(`feishu board event: wb=${wbId || '?'} ops=${ops.join(',') || '?'}`)
            if (wbId && hooks.onBoardUpdated) hooks.onBoardUpdated({ whiteboardId: wbId, operatorIds: ops })
            else if (!wbId) log('feishu board event: 缺 whiteboard_id,raw=' + JSON.stringify(ev).slice(0, 300))
          } catch (e) {
            log('feishu board event error: ' + (e && e.message))
          }
        },
        'im.message.receive_v1': async (data) => {
          if (intakeClosed || serviceIntakeClosed) return
          if (watchdog) watchdog.onEvent() // any inbound event ⇒ link is alive (liveness signal)
          try {
            const ev = (data && data.event) || data || {}
            const message = ev.message
            const sender = ev.sender
            if (!message || !message.chat_id) return

            const isGroup = message.chat_type === 'group'
            if (isGroup && !shouldHandleGroup(message, botOpenId, onlyWhenMentioned)) return

            const text = parseText(message)
            if (!text) return

            const openId = sender && sender.sender_id && sender.sender_id.open_id
            // Sender-name resolution must NOT await here: the SDK dispatches each WS frame on
            // its own concurrent async listener (communicate() → ws.on('message', async …)), so
            // an await on a cache-miss name lookup (a contact API round-trip) lets a later-but-
            // already-cached message reach the engine first, advance the per-group watermark, and
            // make the earlier message get dropped as stale (engine.js monotonic watermark). So:
            // cache hit → use the real name synchronously (no await, order preserved); miss →
            // fall back to open_id and warm the cache in the background so the NEXT message from
            // the same sender carries the real name. Only a sender's very first line shows the id.
            let senderName = openId || 'user'
            if (openId) {
              if (nameCache.has(openId)) senderName = nameCache.get(openId) || openId
              else senderNameOf(openId, message.chat_id).catch(() => {}) // background warm; does not reorder onMessage
            }
            // Fire-and-forget into the engine (NFR1): a turn can run for minutes,
            // and whether the SDK serializes pending handlers is not contractual —
            // message reception must never block on turn completion.
            let result
            try { result = onMessage({
              chatId: message.chat_id,
              userId: openId || 'unknown',
              senderName,
              text,
              msgId: message.message_id,
              createTimeMs: Number(message.create_time) || Date.now(),
              replyCtx: { chatId: message.chat_id, messageId: message.message_id },
            }) } catch (error) { reportOnMessageFailure(error); return }
            Promise.resolve(result).catch(reportOnMessageFailure)
          } catch (e) {
            log('feishu event error: ' + (e && e.message))
            closeFatalIntake(e)
          }
        },
      })

      // Build (or rebuild) the WSClient. The dispatcher is reused across rebuilds;
      // only the socket + its watchdog callbacks are fresh each time.
      const buildClient = () => {
        wsClient = new lark.WSClient({
          appId,
          appSecret,
          loggerLevel: lark.LoggerLevel.warn,
          // L1 — enable the SDK's built-in pong-watchdog: if a ping goes unanswered
          // for pingTimeout seconds the SDK terminate()s the socket so its own
          // 'close'→reconnect fires, instead of believing it's still connected while
          // the bot has gone deaf. Healthy connections clear it on every pong, so only
          // a genuinely dead socket trips it. pingTimeout is in SECONDS.
          wsConfig: { pingTimeout: pingTimeoutSec },
          handshakeTimeoutMs,
          // L2 — lifecycle → the watchdog state machine (health snapshot + rebuild decisions).
          onReady: () => { if (watchdog) watchdog.onReady() },
          onReconnecting: () => { if (watchdog) watchdog.onReconnecting() },
          onReconnected: () => { if (watchdog) watchdog.onReconnected() },
          onError: (e) => { if (watchdog) watchdog.onError(e) },
        })
        wsClient.start({ eventDispatcher: dispatcher })
      }

      // L3 — force-rebuild when the SDK gives up. close({force}) tears down the old
      // socket + timers so no orphan reconnect loop races the fresh client.
      const rebuild = () => {
        try { if (wsClient && wsClient.close) wsClient.close({ force: true }) } catch {}
        buildClient()
      }

      watchdog = createWatchdog({ rebuild, log, onConn, ...wdOpts })
      buildClient()
      // Periodic health tick: drives the wedged-state rebuild (a connection stuck
      // non-connected past the grace). unref'd so it never keeps the process alive.
      tickTimer = setInterval(() => { if (watchdog) watchdog.tick() }, tickIntervalMs)
      if (tickTimer.unref) tickTimer.unref()
      log(`feishu WS connection started (pingTimeout ${pingTimeoutSec}s · watchdog on)`)
    },

    // Connection health for the console: our watchdog snapshot merged with the SDK's
    // own live view (getConnectionStatus). Read on every /api/state poll + SSE tick.
    connHealth() {
      const base = watchdog ? watchdog.snapshot() : { state: 'stopped', since: 0, lastReadyAt: 0, lastEventAt: 0, reconnects: 0, rebuilds: 0, lastError: null }
      let sdkState = null
      let reconnectAttempts = 0
      try {
        if (wsClient && wsClient.getConnectionStatus) {
          const st = wsClient.getConnectionStatus()
          sdkState = st && st.state
          reconnectAttempts = (st && st.reconnectAttempts) || 0
        }
      } catch {}
      return { ...base, sdkState, reconnectAttempts, pingTimeoutSec }
    },

    async reply(replyCtx, content) {
      const mid = replyCtx && replyCtx.messageId
      // 挂到触发它的那条消息下:群里多人交叉说话时,独立发一条看不出这句在回应谁。
      // 回复失败(原消息已撤回/超期)⇒ 退回直接发 —— 形态是锦上添花,把消息弄丢才是事故。
      if (mid && content) {
        try {
          // ⚠ 同上:code≠0 时 SDK 不抛,只认返回 id 会把「没发出去」当成发出去了 ⇒ 消息凭空消失。
          const r = await client.im.message.reply({ path: { message_id: mid }, data: { msg_type: 'text', content: JSON.stringify({ text: content }) } })
          if (r && r.code === 0) return (r.data && r.data.message_id) || r.message_id || null
          log('feishu reply rejected: ' + ((r && r.msg) || 'code≠0')) // 落到下面直发兜底
        } catch (e) { log('feishu reply fallback: ' + (e && e.message)) }
      }
      return sendText(replyCtx && replyCtx.chatId, content)
    },

    // Durable terminal effects already record one attempt before this call.
    // Return the raw SDK outcome so the caller can require a message ID;
    // never fall back to a second send when this attempt is ambiguous.
    async replyOnce(replyCtx, content) {
      const mid = replyCtx && replyCtx.messageId
      if (typeof mid !== 'string' || !/^om_[A-Za-z0-9_-]{1,124}$/.test(mid) ||
          typeof replyCtx.chatId !== 'string' || !replyCtx.chatId ||
          typeof content !== 'string' || !content) {
        throw new TypeError('durable Feishu reply needs exact message target and text')
      }
      return client.im.message.reply({ path: { message_id: mid },
        data: { msg_type: 'text', content: JSON.stringify({ text: content }) } })
    },

    async send(chatId, content) {
      return sendText(chatId, content)
    },

    // One interactive reply under a group command (the /model card). Like
    // replyOnce it is best-effort and never retried; the caller falls back
    // to the text reply when this does not confirm.
    async replyCardOnce(replyCtx, card) {
      const mid = replyCtx && replyCtx.messageId
      if (typeof mid !== 'string' || !/^om_[A-Za-z0-9_-]{1,124}$/.test(mid) ||
          !card || typeof card !== 'object') {
        throw new TypeError('Feishu card reply needs exact message target and a card')
      }
      return client.im.message.reply({ path: { message_id: mid },
        data: { msg_type: 'interactive', content: JSON.stringify(card) } })
    },

    // open_id → display name (cached; null when unknown). The model card's
    // receipt says who changed it; a card callback only carries the open_id.
    nameOf: (openId) => senderNameOf(openId),

    // 发一张静态富卡,返回 { msgId, cardId }(msgId=按钮/表情命中锚点;cardId=实体更新回填用)。
    // 文本已由调用方在构卡时逐字段 redact(卡是 JSON 不能整体脱敏),故这里不再包 redact。
    async sendCard(chatId, cardJson) {
      return sendChatCard(client, chatId, cardJson)
    },

    // CardKit v2 streaming card. Create a streaming card, post it to
    // the chat, then push cumulative text into one markdown element — because the
    // old content is always a prefix of the new, the client renders a typewriter
    // effect. `finish` flips streaming_mode off so the card settles.
    // All ops are serialized so the per-card `sequence` stays strictly increasing.
    async createStreamingCard(replyCtx, { title = 'sbot', operationBoundary = null,
      operationKey = null, initialText = '' } = {}) {
      const chatId = replyCtx && replyCtx.chatId
      if (!chatId) return null
      if (typeof initialText !== 'string') throw new TypeError('card initial text must be a string')
      if (operationBoundary && (typeof operationBoundary !== 'function' ||
          typeof operationKey !== 'string' || !operationKey ||
          Buffer.byteLength(operationKey) > 256)) {
        throw new TypeError('card operation boundary needs a stable operation key')
      }
      const ELEM = 'answer'
      // No header — the reply card shows just the answer body (no "sbot" title line).
      const cardJson = {
        schema: '2.0',
        config: { streaming_mode: !initialText, summary: { content: '' }, streaming_config: { print_strategy: 'fast' } },
        body: { elements: [{ tag: 'markdown', content: initialText, element_id: ELEM }] },
      }

      let cardId
      let msgId = null // 静默收尾时撤回这张卡要用;投递结果里带回来,别丢在地上
      try {
        // ⚠ SDK 对业务错误(HTTP 200 + code≠0)不抛 —— 不查 code 的话,建卡被拒时这里拿到的是
        //   空 card_id,拿着它去投递会 400,**真实的 cardkit 拒绝理由就被那个 400 盖掉了**
        //   (排查时只看得见「消息发送失败」)。sendChatCard 早修过同一处,写法照抄。
        const created = await cardOperation(operationBoundary, operationKey, 'card.create',
          { chatId, replyToMsgId: replyCtx && replyCtx.messageId || null },
          async () => {
            const response = assertCardOk(await client.cardkit.v1.card.create({
              data: { type: 'card_json', data: JSON.stringify(cardJson) },
            }), '建卡')
            if (operationBoundary && response?.code !== 0) {
              throw new Error('建卡结果未确认:未返回 code=0')
            }
            if (!response?.data?.card_id) throw new Error('建卡被拒:未返回 card_id')
            return response
          })
        cardId = created && created.data && created.data.card_id
        if (!cardId) throw new Error('建卡被拒:未返回 card_id')
        // 挂到触发它的那条消息下:群里多人交叉说话时,独立发一条卡看不出在回应谁。
        // 排队合并批次的锚点是最新那条(见 _coalesce)。回复形态的卡照常流式更新(真机探针验过)。
        // 拿不到消息 id(合成消息)或回复失败(原消息已被撤回)⇒ 退回直接发,绝不因此丢答案。
        const posted = await postCard(client, chatId, replyCtx && replyCtx.messageId, cardId,
          { operationBoundary, operationKey })
        msgId = posted
        // A moved card is first delivered with its complete, static snapshot.
        // Enable streaming only afterward: old text never enters the typewriter
        // endpoint, and the next cumulative frame continues from this baseline.
        if (initialText) {
          const sequence = 1
          const uuid = crypto.randomUUID()
          await cardOperation(operationBoundary, operationKey, 'card.settings',
            { cardId, sequence, uuid }, async () => {
              const response = assertCardOk(await client.cardkit.v1.card.settings({
                path: { card_id: cardId },
                data: { settings: JSON.stringify({ config: { streaming_mode: true } }), sequence, uuid },
              }), '恢复流式')
              if (response?.code !== 0) throw new Error('恢复流式未确认:未返回 code=0')
              return response
            })
        }
      } catch (e) {
        log('feishu card create error: ' + (e && e.message))
        if (operationBoundary) throw e
        return null // caller falls back to a plain-text reply
      }

      // 全部写操作交给写入器(流式窗口判断、序号分配、错误码检查都在它一处)。
      const writer = createCardWriter({ client, cardId, elementId: ELEM, log,
        throttleMs: cardThrottleMs, operationBoundary, operationKey,
        initialText, initialSequence: initialText ? 2 : 1 })

      return {
        durableTarget() {
          if (!operationBoundary || !cardId || !msgId) {
            throw new Error('durable card target unavailable')
          }
          return Object.freeze({ chatId, cardId, msgId })
        },
        // 撤回整张卡(ack 或过程文字之后该轮却以静默收场时用)。scope 零新增 —— send_as_bot 本就
        // 覆盖撤回自己发的消息。先把在途的卡片操作排干,免得撤完又被补一帧打回来。
        async recall() {
          if (!msgId) return false
          writer.markClosed()
          try { await writer.settle() } catch (e) {
            if (operationBoundary) throw e
            /* 在途操作失败无所谓,照撤 */
          }
          try {
            await cardOperation(operationBoundary, operationKey, 'message.delete',
              { chatId, cardId, msgId }, async () => {
                const response = assertCardOk(await client.im.message.delete({
                  path: { message_id: msgId },
                }), '撤卡')
                if (operationBoundary && response?.code !== 0) {
                  throw new Error('撤卡结果未确认:未返回 code=0')
                }
                return response
              })
            return true
          } catch (e) {
            log('feishu card recall error: ' + (e && e.message))
            if (operationBoundary) throw e
            return false
          }
        },
        // push the FULL text so far (cumulative). No-ops if unchanged (hash-skip).
        update(text) { writer.update(text) },
        // Opt-in durable terminal handoff: all earlier card operations must
        // finish before the terminal effect begins its own external attempt.
        flush() { return writer.flush() },
        // 收尾:把最终正文落地并关掉流式。表格精致化= 答案含表格时整卡更新成
        // 「markdown 段 + 原生表格组件」;无表格也走整卡更新(流式那条路会在第 10 分钟失效)。
        // opts.milestones:引擎认出的 `>> ` 里程碑,收进「过程」折叠区
        // opts.footer:耗时与 tokens 一行小字,挂在整卡最底(2026-09-16)
        finish(text, opts = {}) { return writer.finish(text, {
          buildElements: (t) => answerCardElements(t, opts),
          ...(Object.hasOwn(opts, 'terminalOperationBoundary')
            ? { terminalOperationBoundary: opts.terminalOperationBoundary } : {}),
        }) },
      }
    },

    async stop({ strict = false } = {}) {
      // Stop the watchdog + tick first so a mid-shutdown state change can't trigger
      // a rebuild, then close the socket cleanly (close({force}) is the SDK's
      // documented teardown — kills timers + the reconnect loop, no orphan sockets).
      if (typeof strict !== 'boolean') throw new TypeError('feishu stop strict must be boolean')
      serviceIntakeClosed = true
      if (tickTimer) { try { clearInterval(tickTimer) } catch {} tickTimer = null }
      if (watchdog) {
        if (strict) watchdog.stop()
        else try { watchdog.stop() } catch {}
      }
      const closing = wsClient
      if (strict) {
        if (closing) {
          if (typeof closing.close !== 'function' ||
              typeof closing.getConnectionStatus !== 'function') {
            throw new Error('feishu strict stop cannot verify WS closure')
          }
          await closing.close({ force: true })
          const state = closing.getConnectionStatus()?.state
          if (state !== 'idle') {
            throw new Error('feishu strict stop WS remains connected or unverified')
          }
        }
        wsClient = null
        return true
      }
      try { if (closing?.close) await closing.close({ force: true }) } catch {}
      wsClient = null
    },
  }
}

// Setup/console helpers: build a client from raw creds, auto-fetch the bot's own
// open_id, and list the groups the bot is in — so operators pick instead of
// hand-copying opaque ids. Best-effort; callers fall back to manual entry.
const SILENT_LOGGER = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, fatal() {} }
function feishuClient(appId, appSecret) {
  // Silent logger — every helper here surfaces failures itself (larkErrMsg →
  // toast/endpoint/CLI), so the SDK's own console logging is pure noise (loggerLevel
  // doesn't gate it; it even dumps caught 4xx from the precheck's probes all over
  // `sbot doctor`). A no-op logger keeps it quiet.
  return new lark.Client({ appId, appSecret, logger: SILENT_LOGGER })
}
// ── 应用身份(控制台「设置 → 飞书应用 · 身份」)────────────────────────────
// 两个来源,能力天差地别,合起来才是一块完整身份:
//   bot/v3/info          官方标「权限要求:无」—— 名称 / 头像 / open_id / 启用状态,任何 bot 都拿得到
//   application/v6/get   要 application:application:self_manage(或 admin:app.info:readonly)
//                        并发布版本 —— **只有它有「应用描述」**
// 所以名称与头像是白拿的(此前只取 open_id、其余字段一直丢在地上),描述是「开了权限才有」的
// 增量:缺权限降级成一条可操作提示,绝不把整块身份拖垮(同 feishuPrecheck 通例:失败映射成
// 人话、不抛)。activate_status / status 两套枚举各属各的接口,别混用。
const BOT_ACTIVATE_STATUS = { 0: '待安装', 1: '已停用', 2: '已启用', 3: '安装后待启用', 4: '升级待启用', 5: 'license 过期停用', 6: '套餐到期 / 降级停用' }
const APP_STATUS = { 0: '已停用', 1: '已启用', 2: '未启用', 3: '未知' }
const APP_INFO_SCOPE_HINT = '应用描述需在开放平台开通 application:application:self_manage(或 admin:app.info:readonly)并发布版本 — 名称 / 头像 / 状态不受影响'
// scope 类报错的统一判据(precheck 各探针原本各写一遍同样的正则,收敛到一处)。
const PERM_RE = /permission|scope|access denied|权限|无权|未开通/i
const isPermErr = (raw) => PERM_RE.test(raw || '')

// SDK 有时把 body 摊平、有时裹在 data 里 —— 两种都收。纯函数,便于单测钉住字段映射。
function normalizeBotInfo(raw) {
  const bot = (raw && (raw.bot || (raw.data && raw.data.bot))) || {}
  const st = typeof bot.activate_status === 'number' ? bot.activate_status : null
  return {
    openId: bot.open_id || null,
    appName: bot.app_name || '',
    avatarUrl: bot.avatar_url || '',
    activateStatus: st,
    activateText: st == null ? '' : (BOT_ACTIVATE_STATUS[st] || `未知状态(${st})`),
    activateOk: st === 2, // 2 = 租户已启用;其余各档都是「装了但跑不起来」,值得在控制台标出来
  }
}
// application/v6 的应用信息。`lang` 指定的语言优先取顶层字段,取不到再落 i18n 数组。
// 形状已用一个**开了该权限**的真实应用核对过(2026-08-03):`data.app.{app_id,app_name,
// description,avatar_url,status}`,i18n 条目的键是 `i18n_key`(不是 language);`language`
// 那支与顶层/裹 data 两种写法都留着做防御 —— 这条路多数租户没权限,探不到就只能容错。
function normalizeAppInfo(raw, lang = 'zh_cn') {
  const app = (raw && (raw.app || (raw.data && raw.data.app))) || {}
  const i18n = Array.isArray(app.i18n) ? app.i18n : []
  const hit = i18n.find((x) => x && (x.i18n_key === lang || x.language === lang)) || {}
  const st = typeof app.status === 'number' ? app.status : null
  return {
    appId: app.app_id || '',
    appName: app.app_name || hit.name || '',
    description: app.description || hit.description || '',
    avatarUrl: app.avatar_url || '',
    status: st,
    statusText: st == null ? '' : (APP_STATUS[st] || `未知(${st})`),
    // 空壳响应(权限探测返回了别的东西)与真拿到应用信息要分得开
    ok: !!(app.app_id || app.app_name || app.description),
  }
}
async function fetchBotInfo(client) {
  return normalizeBotInfo(await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }))
}
async function fetchBotOpenId(client) {
  return (await fetchBotInfo(client)).openId
}
async function fetchAppInfo(client, appId, lang = 'zh_cn') {
  if (!appId) throw new Error('缺 appId')
  const r = await client.request({ method: 'GET', url: `/open-apis/application/v6/applications/${encodeURIComponent(appId)}`, params: { lang } })
  return normalizeAppInfo(r, lang)
}
// 合并成控制台要显示的那块身份。bot 那半失败即整体抛(凭证 / 未加机器人能力,调用方已有处理);
// 描述那半永不抛 —— 用 descState 说明为什么没有:ok · scope(缺权限)· error · skip(没 appId)。
async function fetchAppIdentity(client, appId) {
  const out = { ...(await fetchBotInfo(client)), appId: appId || '', description: '', descState: 'skip', descHint: '' }
  if (!appId) { out.descHint = '未填 appId — 查不了应用描述'; return out }
  try {
    const app = await fetchAppInfo(client, appId)
    if (app.appName) out.appName = app.appName // v6 按 lang 本地化,比 bot/v3 的更准
    out.description = app.description || ''
    out.descState = app.ok ? 'ok' : 'error'
    if (app.ok && !app.description) out.descHint = '该应用在开放平台未填描述'
    else if (!app.ok) out.descHint = '接口未返回应用信息'
  } catch (e) {
    const raw = larkErrMsg(e)
    const perm = isPermErr(raw)
    out.descState = perm ? 'scope' : 'error'
    out.descHint = perm ? APP_INFO_SCOPE_HINT : raw
  }
  return out
}
// 身份 → 预检清单里的一行。名称永远拿得到,所以这行的 warn 只可能是「描述缺权限/读失败」。
function identityCheck(identity) {
  const label = '应用名称 / 描述'
  if (!identity) return { key: 'appinfo', status: 'skip', label, detail: '先通过 bot 身份再验' }
  const name = identity.appName ? `「${identity.appName}」` : '(未取到名称)'
  if (identity.descState === 'ok') return { key: 'appinfo', status: 'ok', label, detail: identity.description ? `${name} · 名称与描述已读取` : `${name} · ${identity.descHint || '该应用未填描述'}` }
  if (identity.descState === 'skip') return { key: 'appinfo', status: 'skip', label, detail: identity.descHint || '未填 appId' }
  if (identity.descState === 'scope') return { key: 'appinfo', status: 'warn', label, detail: `${name} 名称 / 头像已可读;${identity.descHint}` }
  return { key: 'appinfo', status: 'warn', label, detail: `${name} · ${identity.descHint || '描述读取失败'}` }
}
async function fetchChats(client) {
  const out = []
  let pageToken = null
  do { // paginate — a bot in >100 chats must not get a truncated picker
    const r = await client.im.chat.list({ params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } })
    const d = (r && r.data) || {}
    for (const c of d.items || []) out.push({ chatId: c.chat_id, name: c.name || '(未命名群)' })
    pageToken = d.has_more ? d.page_token : null
  } while (pageToken)
  return out
}

// Create a new group chat; bot becomes owner (keeps the disband ability) and is
// auto-added. memberIds (open_id) join at creation — a bot-only group is visible
// to NOBODY in the Feishu client, so the operator must ride along.
// Requires the im:chat scope. Returns {chatId, name} so the console can pick the
// new chat right away without re-fetching the whole list.
async function createChat(client, name, description, memberIds = []) {
  const r = await client.im.chat.create({
    params: { user_id_type: 'open_id' },
    data: { chat_mode: 'group', chat_type: 'public', name, description: description || '', ...(memberIds.length ? { user_id_list: memberIds } : {}) },
  })
  const d = (r && r.data) || {}
  return { chatId: d.chat_id, name: d.name || name }
}

// List a chat's members (open_id + name), paginated — the console invite
// picker's candidate source (import the humans from a group the bot is in).
async function fetchChatMembers(client, chatId) {
  const out = []
  let pageToken = null
  do {
    const r = await client.im.chatMembers.get({ params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) }, path: { chat_id: chatId } })
    const d = (r && r.data) || {}
    for (const m of d.items || []) out.push({ openId: m.member_id, name: m.name || m.member_id })
    pageToken = d.has_more ? d.page_token : null
  } while (pageToken)
  return out
}

// Feishu error code → actionable Chinese hint. Well-known codes get a specific fix;
// everything else falls back to the raw message (larkErrMsg carries code + msg). The
// point of the precheck is to turn "逐个撞坑" into one labelled checklist.
// 换不到 tenant_access_token = 凭证本身不对。此后每个接口都会报同一个错,而它不是「权限错」——
// 探针若照「非权限错 ⇒ 已授权」去判,会把后面几项全报成 ✓(假绿)。
function isTokenErr(e) { return /access_token/i.test(larkErrMsg(e)) }

function feishuHint(e, scope) {
  const code = e && e.response && e.response.data && e.response.data.code
  const raw = larkErrMsg(e)
  if (code === 11205) return 'app 未添加「机器人」能力或未发布版本 — 开放平台「添加应用能力 → 机器人」后创建版本并发布'
  if (isTokenErr(e)) return '凭证不对(拿不到 tenant_access_token)— 核对 App ID 与 App Secret · ' + raw
  // permission / scope family: app hasn't applied for (or published) the needed scope.
  if (isPermErr(raw))
    return (scope ? `缺权限 ${scope} — 开放平台「权限管理」开通后重新发布版本 · ` : '缺权限 — ') + raw
  return raw
}

// One-pass readiness probe of a Feishu app. Each check is independent and
// best-effort — a failure is mapped to a fix, never thrown — so the console/CLI can
// show a full ✓/✗ checklist instead of surfacing errors one at a time at runtime.
// Severity: `fail` = hard blocker (bad creds / no bot identity), `warn` = degrades
// gracefully (missing a recommended scope), `ok` = good, `skip` = not probeable here.
// Receive (长连接 + im.message.receive_v1) and send scopes can't be REST-probed — the
// caller surfaces "发条群消息实测" for those.
async function feishuPrecheck(client, { appId = '' } = {}) {
  const checks = []
  let botOpenId = null
  let identity = null

  // 1) credentials + bot identity in one call — also where "no bot capability /
  //    unpublished app" surfaces (11205), the single most common first-run wall.
  //    同一趟顺带带回名称 / 头像 / 启用状态(零 scope),以及描述(要 scope,缺则降级)。
  try {
    identity = await fetchAppIdentity(client, appId)
    botOpenId = identity.openId
    checks.push(botOpenId
      ? { key: 'bot', status: 'ok', label: 'bot 身份', detail: identity.appName ? `${identity.appName} · ${botOpenId}` : botOpenId }
      : { key: 'bot', status: 'fail', label: 'bot 身份', detail: '取到空 open_id — 确认已「添加应用能力 → 机器人」并发布版本' })
  } catch (e) {
    checks.push({ key: 'bot', status: 'fail', label: '凭证 / bot 身份', detail: feishuHint(e) })
    if (isTokenErr(e)) {
      // 凭证不通:后面的权限一项都验不了,如实标「未验」,不许假绿
      checks.push(identityCheck(null))
      const scopes = [['im:chat', 'im:chat'], ['cardkit', 'cardkit:card:write'], ['contact', 'contact:contact.base:readonly'], ['contact-name', 'contact:user.base:readonly'], ['contact-id', 'contact:user.id:readonly'], ['board', 'board:whiteboard:node:read']]
      for (const [key, label] of scopes) checks.push({ key, status: 'skip', label, detail: '凭证没通过,未验' })
      return { botOpenId, identity, checks }
    }
  }

  // 1b) 应用名称 / 描述 —— 名称白拿,描述缺 scope 时给出「开哪个权限」而不是静默留白。
  checks.push(identityCheck(identity))

  // 2) im:chat — list chats (建群 / 绑群 / 成员管理 all need it). Degrades: without it
  //    you can still bind a group by pasting chatId, so warn rather than fail.
  try {
    await fetchChats(client)
    checks.push({ key: 'im:chat', status: 'ok', label: 'im:chat', detail: '可建群 / 绑群 / 成员管理' })
  } catch (e) {
    checks.push({ key: 'im:chat', status: 'warn', label: 'im:chat', detail: feishuHint(e, 'im:chat') })
  }

  // 3) cardkit:card:write — create a card ENTITY (not posted to any chat, harmless);
  //    missing ⇒ streaming cards fall back to plain text, so warn.
  // ⚠ 这道探针原先只 try/catch 不查 code ⇒ 只要飞书对缺权限返的是 200+code≠0 而非 403,
  //   它就会报「可用」——「假绿」是本项目最贵的一类。飞书对缺 scope 到底返哪种,手上没有
  //   缺该 scope 的应用可探、至今未验;assertCardOk 两种都兜得住(code=0 时它是空操作),
  //   所以先把门关上,不等那次验证。
  try {
    assertCardOk(await client.cardkit.v1.card.create({ data: { type: 'card_json', data: JSON.stringify({ schema: '2.0', config: {}, body: { elements: [] } }) } }), '建卡探针')
    checks.push({ key: 'cardkit', status: 'ok', label: 'cardkit:card:write', detail: '流式打字机卡片可用' })
  } catch (e) {
    checks.push({ key: 'cardkit', status: 'warn', label: 'cardkit:card:write', detail: '缺则回退纯文本 · ' + feishuHint(e, 'cardkit:card:write') })
  }

  // 4) contact:contact.base:readonly — resolve a display name. Best-effort: probe the
  //    bot's own id; a permission error ⇒ missing scope, anything else (e.g. the bot
  //    itself isn't a queryable contact) ⇒ the scope is fine.
  if (botOpenId) {
    try {
      await client.contact.user.get({ params: { user_id_type: 'open_id' }, path: { user_id: botOpenId } })
      checks.push({ key: 'contact', status: 'ok', label: 'contact:contact.base:readonly', detail: '发送者显示真名' })
    } catch (e) {
      const raw = larkErrMsg(e)
      const perm = isPermErr(raw)
      checks.push(perm
        ? { key: 'contact', status: 'warn', label: 'contact:contact.base:readonly', detail: '缺则发送者回退 open_id · ' + feishuHint(e, 'contact:contact.base:readonly') }
        : { key: 'contact', status: 'ok', label: 'contact:contact.base:readonly', detail: '已授权(bot 自身不可查属正常)' })
    }
  } else {
    checks.push({ key: 'contact', status: 'skip', label: 'contact:contact.base:readonly', detail: '先通过 bot 身份再验' })
  }

  // 4b) contact:user.base:readonly — 通讯录成员**真名**。2026-09-05 两个租户对照验出:contact.base + 数据范围都够,
  //     缺这条时「从通讯录添加」列表与发送者名字全是 open_id。探法:拉根部门直属成员 1 人看有没有 name;
  //     权限错 ⇒ warn;没有直属成员 / SDK 无此方法 ⇒ skip(判不了就说判不了,别假绿)。
  try {
    const fbd = client.contact && client.contact.user && client.contact.user.findByDepartment
    if (typeof fbd !== 'function') throw Object.assign(new Error('no findByDepartment'), { sbotSkip: true })
    const r = await fbd.call(client.contact.user, { params: { department_id: '0', department_id_type: 'open_department_id', user_id_type: 'open_id', page_size: 1 } })
    const items = (r && r.data && r.data.items) || []
    if (!items.length) checks.push({ key: 'contact-name', status: 'skip', label: 'contact:user.base:readonly', detail: '根部门下没有直属成员,判不了(通讯录列表里名字若显示成 open_id ⇒ 缺此 scope)' })
    else if (items.some((u) => u && u.name)) checks.push({ key: 'contact-name', status: 'ok', label: 'contact:user.base:readonly', detail: '通讯录成员显示真名' })
    else checks.push({ key: 'contact-name', status: 'warn', label: 'contact:user.base:readonly', detail: '成员名字为空 ⇒ 列表与发送者会显示成 open_id · 去开放平台开通 contact:user.base:readonly 并发版' })
  } catch (e) {
    if (e && e.sbotSkip) checks.push({ key: 'contact-name', status: 'skip', label: 'contact:user.base:readonly', detail: '此 SDK 无部门成员接口,未验' })
    else checks.push({ key: 'contact-name', status: 'warn', label: 'contact:user.base:readonly', detail: '缺则通讯录名字显示成 open_id · ' + feishuHint(e, 'contact:user.base:readonly') })
  }

  // 5) contact:user.id:readonly — email→open_id lookup (how the admin's id is
  //    found before the bot is in any group). Probe with a throwaway email:
  //    a permission error ⇒ scope missing; a normal (empty) result ⇒ granted.
  try {
    await client.contact.user.batchGetId({ params: { user_id_type: 'open_id' }, data: { emails: ['sbot-precheck-none@example.invalid'] } })
    checks.push({ key: 'contact-id', status: 'ok', label: 'contact:user.id:readonly', detail: '邮箱查管理员 openid 可用' })
  } catch (e) {
    const raw = larkErrMsg(e)
    const perm = isPermErr(raw)
    checks.push(perm
      ? { key: 'contact-id', status: 'warn', label: 'contact:user.id:readonly', detail: '邮箱查 openid 需要 · ' + feishuHint(e, 'contact:user.id:readonly') }
      : { key: 'contact-id', status: 'ok', label: 'contact:user.id:readonly', detail: '邮箱查管理员 openid 可用' })
  }

  // 6) board:whiteboard:node:read — 设计画布(docs/BOARD.md)。探一个语法合法但不存在的画板 id:
  //    2890003(record missing)⇒ scope 已授权;权限类报错 ⇒ 缺 scope。画布另需 docx/drive/分享/
  //    标签页等 scope(无法无害探测),完整清单见控制台飞书应用卡。
  try {
    await client.request({ method: 'GET', url: '/open-apis/board/v1/whiteboards/sbotprecheckprobe0000000000/nodes' })
    checks.push({ key: 'board', status: 'ok', label: 'board:whiteboard:node:read', detail: '设计画布可用' })
  } catch (e) {
    const raw = larkErrMsg(e)
    const perm = isPermErr(raw)
    checks.push(perm
      ? { key: 'board', status: 'warn', label: 'board:whiteboard:node:read', detail: '缺则设计画布不可用 · ' + feishuHint(e, 'board:whiteboard:node:read') }
      : { key: 'board', status: 'ok', label: 'board:whiteboard:node:read', detail: '已授权(探测画板不存在属正常)' })
  }

  return { botOpenId, identity, checks }
}

// Resolve an email OR mobile → open_id via contact.user.batchGetId (needs
// contact:user.id:readonly). Before the bot is in any group there are no member
// candidates, so a contact lookup is how an admin's open_id is obtained.
// `query` with an '@' is treated as an email, else a mobile. Returns { openId,
// query }; openId is null when the contact isn't a registered Feishu user here.
async function resolveContactToOpenId(client, query) {
  query = String(query || '').trim()
  const data = query.includes('@') ? { emails: [query] } : { mobiles: [query] }
  const r = await client.contact.user.batchGetId({ params: { user_id_type: 'open_id' }, data })
  const list = (r && r.data && r.data.user_list) || []
  const hit = list.find((u) => u && u.user_id)
  return { openId: hit ? hit.user_id : null, query }
}

// Derive adminOpenId candidates without hand-copying opaque ids: walk the
// chats the bot is in, collect distinct non-bot members → the console's「就是我」picker.
// Capped so a bot in many big groups doesn't fan out unbounded. Per-chat failures are
// skipped so one un-listable chat doesn't sink the whole derivation.
async function fetchAdminCandidates(client, botOpenId, { maxChats = 10, maxCandidates = 60 } = {}) {
  const chats = await fetchChats(client)
  const seen = new Map() // openId -> name
  for (const c of chats.slice(0, maxChats)) {
    let members = []
    try { members = await fetchChatMembers(client, c.chatId) } catch { continue }
    for (const m of members) {
      if (m.openId && m.openId !== botOpenId && !seen.has(m.openId)) seen.set(m.openId, m.name || m.openId)
      if (seen.size >= maxCandidates) break
    }
    if (seen.size >= maxCandidates) break
  }
  return [...seen].map(([openId, name]) => ({ openId, name }))
}

// Enumerate the org's contacts → [{openId, name}] for the admin picker (从通讯录选).
// Feishu has no "list all users" call AND a self-built app only sees its 通讯录授权范围
// (data authority) — querying root "0" without it 403s (code 40004). So we start from
// contact.scope.list (the authorized departments + users), expand each authorized dept
// into its subtree (children fetch_child), page users per dept via find_by_department,
// and fold in directly-authorized users (name via contact.user.batch). Deduped + capped;
// unreadable branches are skipped. Needs contact:department.base:readonly + a user-read
// scope, AND the app's 通讯录授权范围 set to the departments/members to expose.
async function fetchOrgUsers(client, { maxDepts = 400, maxUsers = 1000 } = {}) {
  // 1) authorized range — which departments + users this app may actually read.
  const rootDeptIds = []
  const directUserIds = []
  let spt = null
  do {
    const s = await client.contact.scope.list({ params: { page_size: 50, department_id_type: 'open_department_id', user_id_type: 'open_id', ...(spt ? { page_token: spt } : {}) } })
    const d = (s && s.data) || {}
    for (const id of d.department_ids || []) rootDeptIds.push(id)
    for (const uid of d.user_ids || []) directUserIds.push(uid)
    spt = d.has_more ? d.page_token : null
  } while (spt)

  // 2) expand each authorized department into its whole subtree.
  const deptIds = [...rootDeptIds]
  for (const rid of rootDeptIds) {
    if (deptIds.length >= maxDepts) break
    let cpt = null
    do {
      let r
      try { r = await client.contact.department.children({ path: { department_id: rid }, params: { department_id_type: 'open_department_id', fetch_child: true, page_size: 50, ...(cpt ? { page_token: cpt } : {}) } }) }
      catch { break }
      const d = (r && r.data) || {}
      for (const dep of d.items || []) { const id = dep.open_department_id || dep.department_id; if (id && deptIds.length < maxDepts) deptIds.push(id) }
      cpt = d.has_more && deptIds.length < maxDepts ? d.page_token : null
    } while (cpt)
  }

  const seen = new Map() // openId -> name
  let truncated = false
  // 3) users per department.
  for (const id of deptIds) {
    if (seen.size >= maxUsers) { truncated = true; break }
    let pt = null
    do {
      let r
      try { r = await client.contact.user.findByDepartment({ params: { department_id: id, department_id_type: 'open_department_id', user_id_type: 'open_id', page_size: 50, ...(pt ? { page_token: pt } : {}) } }) }
      catch { break } // a department the app can't read → skip (don't sink the whole scan)
      const d = (r && r.data) || {}
      for (const u of d.items || []) {
        if (u && u.open_id && !seen.has(u.open_id)) seen.set(u.open_id, u.name || u.open_id)
        if (seen.size >= maxUsers) { truncated = true; break }
      }
      pt = d.has_more && seen.size < maxUsers ? d.page_token : null
    } while (pt)
  }
  // 4) directly-authorized users not under any dept — batch-get names (contact.base).
  const missing = directUserIds.filter((id) => !seen.has(id))
  for (let i = 0; i < missing.length && seen.size < maxUsers; i += 50) {
    try {
      const r = await client.contact.user.batch({ params: { user_ids: missing.slice(i, i + 50), user_id_type: 'open_id' } })
      for (const u of (r && r.data && r.data.items) || []) if (u && u.open_id && !seen.has(u.open_id)) seen.set(u.open_id, u.name || u.open_id)
    } catch { /* names unavailable → fall through to the id below */ }
  }
  for (const id of missing) { if (seen.size >= maxUsers) { truncated = true; break } if (!seen.has(id)) seen.set(id, id) } // never drop an authorized admin

  return { users: [...seen].map(([openId, name]) => ({ openId, name })), truncated }
}

// Add members (open_id) to an existing chat — the API caps id_list at 50/call.
async function addChatMembers(client, chatId, memberIds) {
  for (let i = 0; i < memberIds.length; i += 50) {
    await client.im.chatMembers.create({ params: { member_id_type: 'open_id' }, path: { chat_id: chatId }, data: { id_list: memberIds.slice(i, i + 50) } })
  }
}

// Disband a chat the bot OWNS (i.e. one it created). Irreversible; the API
// rejects it when the bot isn't the owner — callers surface that error.
async function deleteChat(client, chatId) {
  await client.im.chat.delete({ path: { chat_id: chatId } })
}

// One-off text into a chat (console notices, e.g. the bind confirmation).
async function sendChatText(client, chatId, text) {
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
  })
}

// ── Base skill: send a local file / image to a chat (agent-facing, via `sbot feishu`).
// The agent produces a file in its workdir and calls `sbot feishu send-file <path>`;
// sbot uploads (as the bot, own app creds) then posts it. Mirrors lark-cli semantics.

// Path fence (mirrors lark-cli's send: cwd-relative only). The agent runs `sbot feishu`
// with cwd = its project workdir; confining sends to that dir stops it from exfiltrating
// arbitrary host files (e.g. ~/.sbot/config.json) through sbot's privileged send. Reject
// absolute paths and any '..' segment; resolve the rest against cwd and re-check it stays in.
// mustExist=true for sends (the file must be there); false for downloads (writing a new
// file into the fenced dir — the target legitimately doesn't exist yet).
function resolveSendPath(cwd, p, mustExist = true) {
  if (!p) throw new Error('缺少文件路径')
  if (path.isAbsolute(p)) throw new Error('只允许项目目录内的相对路径,拒绝绝对路径:' + p)
  if (p.split(/[\\/]/).includes('..')) throw new Error("路径不得包含 '..':" + p)
  const abs = path.resolve(cwd, p)
  const root = path.resolve(cwd)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径超出项目目录:' + p)
  if (mustExist && !fs.existsSync(abs)) throw new Error('文件不存在:' + p)
  return abs
}

// The SDK's upload response shape varies by version: image_key/file_key may sit at the
// TOP LEVEL of the returned object OR nested under .data. Read both (real-machine finding,
// v0.2.0→0.2.1) — reading only .data.* made the send fail with "未返回 …_key".
async function uploadImage(client, absPath) {
  const r = await client.im.image.create({ data: { image_type: 'message', image: fs.createReadStream(absPath) } })
  const key = r && ((r.data && r.data.image_key) || r.image_key)
  if (!key) throw new Error('图片上传失败:未返回 image_key')
  return key
}

async function uploadFile(client, absPath) {
  const r = await client.im.file.create({ data: { file_type: 'stream', file_name: path.basename(absPath), file: fs.createReadStream(absPath) } })
  const key = r && ((r.data && r.data.file_key) || r.file_key)
  if (!key) throw new Error('文件上传失败:未返回 file_key')
  return key
}

async function sendChatImage(client, chatId, absPath) {
  const image_key = await uploadImage(client, absPath)
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key }) },
  })
  return image_key
}

// 发送一张静态富卡(Card JSON 2.0)。走 cardkit 建卡实体 + im 投递 card_id —— 与流式卡
// (createStreamingCard)同一条已验证的 2.0 渲染路径,只是不再流式更新。返回 { msgId, cardId }:
// msgId 供按钮回调/表情命中(takeNotice 锚点),cardId 供后续实体全量更新(单卡回填)。
// 投递一张已建好的卡:优先「回复」到指定消息(群里看得出在回应谁),没有消息 id 或回复被拒
// (原消息已撤回/超出可回复期)就退回直接发到群里。返回 message_id(撤回/表情命中锚点)。
async function postCard(client, chatId, replyToMsgId, cardId,
  { operationBoundary = null, operationKey = null } = {}) {
  const content = JSON.stringify({ type: 'card', data: { card_id: cardId } })
  const pick = (r) => (r && ((r.data && r.data.message_id) || r.message_id)) || null
  if (replyToMsgId) {
    try {
      // ⚠ SDK 对业务错误不抛(HTTP 200 + code≠0)⇒ 判成功要看 code,不能只看有没有 id:
      // 成功却没取到 id 时若落到下面的直发,群里就是**两张卡**(比失去撤回能力糟得多)。
      const r = await cardOperation(operationBoundary, operationKey, 'message.reply',
        { chatId, cardId, replyToMsgId }, async () => {
          const response = await client.im.message.reply({ path: { message_id: replyToMsgId },
            data: { msg_type: 'interactive', content } })
          if (operationBoundary && typeof response?.code !== 'number') {
            throw new Error('卡片回复结果未确认:未返回业务码')
          }
          if (operationBoundary && response?.code === 0 && !pick(response)) {
            throw new Error('卡片回复结果未确认:未返回 message_id')
          }
          return response
        })
      if (r && r.code === 0) return pick(r)
    } catch (e) {
      if (operationBoundary) throw e
      /* 原消息已撤回/超期 ⇒ 退回直接发 */
    }
  }
  const r = await cardOperation(operationBoundary, operationKey, 'message.create',
    { chatId, cardId }, async () => {
      const response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content },
      })
      if (operationBoundary) {
        assertCardOk(response, '投递卡')
        if (response?.code !== 0) throw new Error('卡片投递结果未确认:未返回 code=0')
        if (!pick(response)) throw new Error('卡片投递结果未确认:未返回 message_id')
      }
      return response
    })
  return pick(r)
}

async function sendChatCard(client, chatId, cardJson) {
  const created = await client.cardkit.v1.card.create({ data: { type: 'card_json', data: JSON.stringify(cardJson) } })
  const cardId = created && ((created.data && created.data.card_id) || created.card_id)
  // ⚠ SDK 对业务错误(HTTP 200 + code≠0)不抛 —— cardkit 校验拒卡时 card_id 为空串,拿着它去投递
  // 会 400 且丢失真实错误(v0.6.10 真机踩过:img 带 size 字段被拒,msg 里的 ErrPath 才是真诊断)。
  if (!cardId) throw new Error('建卡被拒:' + ((created && created.msg) || '未返回 card_id'))
  const r = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }) },
  })
  const msgId = (r && ((r.data && r.data.message_id) || r.message_id)) || null
  return msgId ? { msgId, cardId } : null
}

// 按 card_id 全量更新一张已发出的实体卡 =「按标注改」结果回填进原播报卡(单卡:处理中 → 结果卡)。
// ⚠ 我们发的是 cardkit 实体卡(消息里只有 card_id 引用)⇒ 更新必须走 cardkit card.update(官方:
// 「以全新的卡片内容更新已有卡片」,消息同步刷新);im.message.patch 打不中实体卡(v0.6.9 自查纠正)。
// sequence 须对同卡严格递增,且是 **int32(1~2147483647)** —— 毫秒时间戳(1.75e12)超限直接 400
// (v0.6.9 真机踩过:结果卡回填 400);秒级(≈1.75e9)在范围内、恒大于此前的小序号(create/回调
// 路径用 1、2、3…),2038 年前安全;同卡两次 update 不会落在同一秒(一张卡只回填一次)。
// sequence 缺省 = 秒级时间戳(单发一张卡时用它最省事);写入器那种「同一张卡要写很多次」的
// 场合必须自带序号,由它那个唯一的分配器统一发 —— 两条路各自取号才是会撞的写法。
async function updateCardEntity(client, cardId, cardJson, sequence = null) {
  return assertCardOk(await client.cardkit.v1.card.update({
    path: { card_id: cardId },
    data: { card: { type: 'card_json', data: JSON.stringify(cardJson) }, sequence: sequence == null ? Math.floor(Date.now() / 1000) : sequence },
  }), '更新卡')
}

async function sendChatFile(client, chatId, absPath) {
  const file_key = await uploadFile(client, absPath)
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key }) },
  })
  return file_key
}

// ── Base skill (read/manage): history + reply/edit/recall + download + react, all keyed off a
// message_id obtained from `history` (or the user's own message). edit/recall only affect the
// bot's OWN messages (Feishu rejects touching others'). Same bot identity as the send skills.

// Pull the last N messages of THIS chat, newest→oldest, as structured records. Sender is the
// open_id (resolving names would be N extra calls); text is best-effort via parseText.
async function fetchChatHistory(client, chatId, n = 20) {
  const size = Math.min(Math.max(Number(n) || 20, 1), 50)
  const r = await client.im.message.list({ params: { container_id_type: 'chat', container_id: chatId, sort_type: 'ByCreateTimeDesc', page_size: size } })
  const items = (r && ((r.data && r.data.items) || r.items)) || []
  return items.map((m) => ({
    msgId: m.message_id,
    senderId: (m.sender && (m.sender.id || m.sender.sender_id)) || '',
    senderType: (m.sender && m.sender.sender_type) || '',
    createTimeMs: Number(m.create_time) || 0,
    msgType: m.msg_type,
    text: parseText({ message_type: m.msg_type, message_id: m.message_id, content: (m.body && m.body.content) || '' }), // message_id 进附件标记 ⇒ 历史里的图也能 download
    // ⚠ @ 信息只在**这一层**补:parseText 把 `@_user_N` 占位符抹掉是对的(实时收信那条路也用它,
    //   agent 每轮收到的正文本就不该带占位符),但历史里因此看不出「这条是发给崔总的」还是「问我的」——
    //   排查者据此误判过「真人消息被静默吞掉」(实为 @了别人未@bot,门控正确不触发);agent 读 history 也分不清。
    //   某项目近 200 条里真人 76 条,12 条(16%)是这种。id 可能是字符串也可能是 {open_id} 对象,两种都认。
    mentions: (Array.isArray(m.mentions) ? m.mentions : []).map((x) => ({
      id: String((x && (typeof x.id === 'string' ? x.id : (x.id && (x.id.open_id || x.id.user_id)))) || ''),
      name: String((x && x.name) || ''),
    })).filter((x) => x.id || x.name),
  }))
}

// history 那行里的 @ 标记(纯函数,bin 只消费):`→@bot` / `→@李雷·未@bot` / `→@bot·李雷`;没 @ 任何人 ⇒ 空串。
// 「@了别人未@bot」的消息按设计不触发轮次,历史里不标就与真问 bot 的长得一模一样 —— 这正是要分开的两种东西。
// botOpenId 是占位符(ou_x…)或空时,不判 bot,只列名字。
function historyAtMark(mentions, botOpenId) {
  const ms = Array.isArray(mentions) ? mentions.filter((x) => x && (x.id || x.name)) : []
  if (!ms.length) return ''
  const bot = String(botOpenId || '')
  const known = !!bot && !bot.startsWith('ou_x')
  const hitBot = known && ms.some((x) => x.id === bot)
  const others = ms.filter((x) => !(known && x.id === bot)).map((x) => x.name || (x.id ? String(x.id).slice(0, 8) + '…' : '?'))
  return ' →@' + [...(hitBot ? ['bot'] : []), ...others].join('·') + (hitBot ? '' : '·未@bot')
}

// Reply to a specific message (threads under it). Text should be redacted by the caller.
async function replyMessage(client, messageId, text) {
  await client.im.message.reply({ path: { message_id: messageId }, data: { msg_type: 'text', content: JSON.stringify({ text }) } })
}

// Edit one of the BOT'S OWN text messages. Text should be redacted by the caller.
async function editMessage(client, messageId, text) {
  await client.im.message.update({ path: { message_id: messageId }, data: { msg_type: 'text', content: JSON.stringify({ text }) } })
}

// Recall (delete) one of the BOT'S OWN messages.
async function recallMessage(client, messageId) {
  await client.im.message.delete({ path: { message_id: messageId } })
}

// Download a file/image attached to a group message to absPath (already fenced by the caller).
// type ∈ { file, image }; fileKey/imageKey comes from history or the user's message payload.
async function downloadResource(client, messageId, fileKey, type, absPath) {
  const res = await client.im.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type: type === 'image' ? 'image' : 'file' } })
  if (!res || typeof res.writeFile !== 'function') throw new Error('下载失败:未返回资源流')
  await res.writeFile(absPath)
  return absPath
}

// React with an emoji. emoji_type is a FIXED Feishu enum (THUMBSUP/HEART/…); a made-up name
// 231001s (project memory). Map a few aliases, else pass the upper-cased token through.
const EMOJI_ALIASES = { '👍': 'THUMBSUP', 赞: 'THUMBSUP', '❤️': 'HEART', 爱心: 'HEART', '😄': 'SMILE', 笑: 'SMILE', 好的: 'OK', '👏': 'APPLAUSE', 鼓掌: 'APPLAUSE', 完成: 'DONE', '✅': 'DONE' }
function normalizeEmoji(e) { return EMOJI_ALIASES[e] || EMOJI_ALIASES[String(e).toLowerCase()] || String(e).toUpperCase() }
async function reactMessage(client, messageId, emoji) {
  await client.im.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: normalizeEmoji(emoji) } } })
}

// ---------------------------------------------------------------------------
// 群设计画布(飞书画板)— docx/drive/board 协作(DESIGN §4.10d / docs/BOARD.md)。
// SDK 无 board 领域封装,统一走 client.request 通用口(fetchBotOpenId 同款);响应双读防外形差异。
// 真机事实(2026-07-21 逐一验证):
//  · 画板块 = docx 块 block_type 43,body 的 board 传空对象即可;响应 children[0].board.token
//    即 whiteboard_id(27 字符,前缀不定,别按 wbcn 校验)
//  · 空画板 GET 响应没有 nodes 键(不是空数组)
//  · 写节点服务端会改写传入 id("n1"→"d1:1")— 持久 id 一律以响应 ids 为准
//  · 无删除端点 — 删节点 = 读全量、滤掉目标、overwrite:true 重写;空集被拒(至少留 1 节点);
//    overwrite 后数据异步应用,紧接 GET 报 4003101 需退避重试
//  · 素材上传 parent_type=whiteboard 未文档化但可用(size 必须是真实字节数);独立 type:"text"
//    节点被拒 — 画板文字用 text_shape / composite_shape+text(形状对齐官方 whiteboard-cli 输出)

// 建画布文档:docx 文档 + 画板块 + 可打开 URL(metas batch_query,with_url 必须显式 true)。
async function createBoardDoc(client, { title }) {
  const r = await client.request({ method: 'POST', url: '/open-apis/docx/v1/documents', data: { title } })
  const d = (r && r.data) || r || {}
  const docToken = d.document && d.document.document_id
  if (!docToken) throw new Error('创建画布文档失败:未返回 document_id')
  const br = await client.request({
    method: 'POST',
    url: `/open-apis/docx/v1/documents/${docToken}/blocks/${docToken}/children`,
    params: { document_revision_id: -1 },
    data: { children: [{ block_type: 43, board: {} }], index: 0 },
  })
  const bd = (br && br.data) || br || {}
  const child = Array.isArray(bd.children) && bd.children[0]
  const whiteboardId = child && child.board && child.board.token
  if (!whiteboardId) throw new Error('创建画板块失败:未返回画板 token')
  const url = await fetchDocUrl(client, docToken)
  return { docToken, whiteboardId, url }
}

// 文档可打开 URL 的权威来源(创建响应不带 url;拼租户域不可靠)。
async function fetchDocUrl(client, docToken) {
  const r = await client.request({ method: 'POST', url: '/open-apis/drive/v1/metas/batch_query', data: { request_docs: [{ doc_token: docToken, doc_type: 'docx' }], with_url: true } })
  const d = (r && r.data) || r || {}
  const meta = Array.isArray(d.metas) && d.metas[0]
  if (!meta || !meta.url) throw new Error('查询文档链接失败:metas 未返回 url')
  return meta.url
}

// 文档分享给群(openchat 成员,默认可编辑 — 群成员要能在画板上标注)。
async function shareDocWithChat(client, docToken, chatId, perm = 'edit') {
  await client.request({ method: 'POST', url: `/open-apis/drive/v1/permissions/${docToken}/members`, params: { type: 'docx' }, data: { member_type: 'openchat', member_id: chatId, perm } })
}

// 画布文档挂群标签页(常驻入口,免翻聊天记录)。bot 须在群内;失败由调用方降级,不阻断建画布。
async function addChatTabDoc(client, chatId, url, tabName) {
  await client.request({ method: 'POST', url: `/open-apis/im/v1/chats/${chatId}/chat_tabs`, data: { chat_tabs: [{ tab_name: String(tabName || '设计画布').slice(0, 60), tab_type: 'doc', tab_content: { doc: url } }] } })
}

// 上传画板图片素材 → file_token(image 节点引用)。size 与实际字节数不符报 1062009。
async function uploadBoardImage(client, whiteboardId, absPath) {
  const size = fs.statSync(absPath).size
  const media = (client.drive && client.drive.v1 && client.drive.v1.media) || (client.drive && client.drive.media)
  if (!media || typeof media.uploadAll !== 'function') throw new Error('SDK 缺少 drive.media.uploadAll — 请升级 @larksuiteoapi/node-sdk')
  let r
  try {
    r = await media.uploadAll({ data: { file_name: path.basename(absPath), parent_type: 'whiteboard', parent_node: whiteboardId, size, file: fs.createReadStream(absPath) } })
  } catch (e) {
    // parent_type=whiteboard 属未文档化用法(2026-07 真机可用)— 失败时把这层可能性说出来
    throw new Error('画板素材上传失败(注:parent_type=whiteboard 属未文档化用法,若飞书侧变更需重查):' + larkErrMsg(e))
  }
  const token = (r && r.data && r.data.file_token) || (r && r.file_token)
  if (!token) throw new Error('画板素材上传失败:未返回 file_token')
  return token
}

// 写画板节点。opts.overwrite ⇒ 清空全部现有节点后写入(飞书的"删除"唯一途径)。
async function createBoardNodes(client, whiteboardId, nodes, opts = {}) {
  const data = { nodes }
  if (opts.overwrite) data.overwrite = true
  const r = await client.request({ method: 'POST', url: `/open-apis/board/v1/whiteboards/${whiteboardId}/nodes`, data })
  const d = (r && r.data) || r || {}
  const ids = Array.isArray(d.ids) ? d.ids : []
  if (!ids.length) throw new Error('写画板节点失败:未返回节点 ids')
  return ids // ⚠ 服务端会改写传入 id — 持久 id 一律以此为准
}

// 图表通道(Mermaid/PlantUML → 画板节点):POST …/nodes/plantuml,5 qps,scope
// board:whiteboard:node:create(与写节点同,零新权限)。SDK 无此封装 ⇒ client.request 逃生口。
// 请求体:plant_uml_code(必填)· syntax_type(1=PlantUML 2=Mermaid,必填)· diagram_type
// (0=自动;可选)· style_type(1=多节点可编辑 2=整张图片;可选)。⚠ 无任何位置/坐标参数 —— 落点
// 由飞书自动排布。响应只返 data.node_id(单个根节点 id;style=1 的子节点靠 parent_id 挂它下面,
// 响应不给子节点清单 ⇒ 调用方靠前后 listBoardNodes diff 取全部新增 id)。
async function createBoardDiagram(client, whiteboardId, { code, syntaxType, diagramType, styleType } = {}) {
  const data = { plant_uml_code: code, syntax_type: syntaxType }
  if (Number.isFinite(diagramType) && diagramType > 0) data.diagram_type = diagramType
  if (Number.isFinite(styleType)) data.style_type = styleType
  let r
  try {
    r = await client.request({ method: 'POST', url: `/open-apis/board/v1/whiteboards/${whiteboardId}/nodes/plantuml`, data })
  } catch (e) {
    throw new Error('创建图表节点失败:' + feishuHint(e, 'board:whiteboard:node:create'))
  }
  const d = (r && r.data) || r || {}
  const nodeId = (d && d.node_id) || (r && r.node_id)
  if (!nodeId) throw new Error('创建图表节点失败:未返回 node_id(可能语法有误或图类型不支持)')
  return nodeId
}

// 读画板全部节点。写后应用窗口有两种表现都要吃掉(真机踩过):① 4003101(doc is applying)
// 报错;② 200 + 空响应的**假空**(overwrite 删 2 节点后立即读返回 0 节点,数秒后 6 节点)。
// 空结果复验一次再信 —— 真空画板多等 2s,可接受;假空当真会让 agent 误判「画布被清空」。
async function listBoardNodes(client, whiteboardId) {
  let lastErr = null
  let sawEmpty = false
  for (let i = 0; i < 4; i++) {
    try {
      const r = await client.request({ method: 'GET', url: `/open-apis/board/v1/whiteboards/${whiteboardId}/nodes` })
      const d = (r && r.data) || r || {}
      const nodes = Array.isArray(d.nodes) ? d.nodes : [] // 空画板没有 nodes 键
      if (nodes.length || sawEmpty) return nodes
      sawEmpty = true
    } catch (e) {
      lastErr = e
      if (!/4003101|applying|not ready/i.test(larkErrMsg(e))) throw e
    }
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)))
  }
  if (lastErr) throw lastErr
  return []
}

// 删节点 = 读全量 → 滤掉目标 → overwrite 重写(无删除端点)。⚠ 读写窗口内用户的并发编辑会被
// 覆盖 — 调用方应在处理标注后立刻删,窗口秒级;overwrite 后所有节点 id 会变(再操作先重读)。
// cascade(默认开):删容器/导图树根时连带其内容、并清掉变空的组 —— 展开用的是**已经读回来的**
// nodes,零额外 API 调用,却能把「逐个删 34 次 ≈100 次调用」压成「1 次调用 2 次 API」(见 board.js
// expandDeleteIds 的账)。`--no-cascade` 走精确删除(只删点名的,可能留下悬空子节点/空组)。
async function deleteBoardNodes(client, whiteboardId, ids, { cascade = true } = {}) {
  const nodes = await listBoardNodes(client, whiteboardId)
  const { expandDeleteIds } = require('./board')
  const exp = cascade ? expandDeleteIds(nodes, ids) : { ids: [...new Set(ids)], cascaded: [] }
  const drop = new Set(exp.ids)
  const keep = nodes.filter((n) => n && !drop.has(n.id))
  if (keep.length === nodes.length) throw new Error('未找到要删除的节点(id 以 board-nodes 输出为准;画布每次全量重写后节点 id 会变,先重新读一遍)')
  if (!keep.length) throw new Error('无法删空画板(飞书画板 API 要求至少保留 1 个节点)')
  const keepIds = await createBoardNodes(client, whiteboardId, keep, { overwrite: true })
  // deleted 供调用方存档(拍板 2026-07-21);keepIds = overwrite 后**全量新 id**(服务端改写)——
  // 供 bot 留痕(boardops rewrite),轮询自动感知据此重置基线,不把 id 全变的整板当「新增」。
  return { deleted: nodes.filter((n) => n && drop.has(n.id)), keepIds, cascaded: exp.cascaded }
}

// 订阅画板变更事件(board.whiteboard.updated_v1 是按画板订阅制;订阅方需画板管理权,
// bot 自建文档即满足)。⚠ 真机(2026-07-21):body **必须带 `event_type`**,缺则 99992402
// field validation failed(空 body / 空对象 / 加 user_id_type 全被拒,唯 event_type 通过)。
// 幂等语义:重复订阅报错由调用方 catch 后降级,不阻断主流程。
async function subscribeBoard(client, whiteboardId) {
  await client.request({ method: 'POST', url: `/open-apis/board/v1/whiteboards/${whiteboardId}/subscribe`, data: { event_type: 'board.whiteboard.updated_v1' } })
}

// 拉文档全部评论(设计画布的第二条意见通道)。真机事实(2026-07-21):分页判停看 has_more
// (结束时 page_token 仍非空,别看它);图片在**回复级** extra.image_list(裸 token,走
// medias download 可下);parent_type "WHITEBOARD_BLOCK" 的 parent_token **就是 whiteboard_id**;
// 画板内元素级锚定不透出元素 id(quote 只有「[画板]/[图片]」文案)。
async function listBoardComments(client, docToken) {
  const items = []
  let pageToken
  for (let i = 0; i < 20; i++) { // 上限截断代替无界循环(每页 50 ⇒ 封顶 1000 条)
    const r = await client.request({ method: 'GET', url: `/open-apis/drive/v1/files/${docToken}/comments`, params: { file_type: 'docx', user_id_type: 'open_id', ...(pageToken ? { page_token: pageToken } : {}) } })
    const d = (r && r.data) || r || {}
    if (Array.isArray(d.items)) items.push(...d.items)
    if (!d.has_more) break
    pageToken = d.page_token
  }
  return items
}

// 解决/恢复一条评论(agent 处理完反馈后闭环,与「删已处理标注」同语义)。
async function resolveBoardComment(client, docToken, commentId, solved = true) {
  await client.request({ method: 'PATCH', url: `/open-apis/drive/v1/files/${docToken}/comments/${commentId}`, params: { file_type: 'docx' }, data: { is_solved: !!solved } })
}

// 下载画板素材 / 评论附图(GET /drive/v1/medias/:token/download,响应为流)。评论附图与
// 画板 image 节点的 token 走同一端点;SDK 流对象 writeFile,与 downloadResource 同款。
// 画板整板导出预览图 → (可选)聚焦裁剪到新标注附近 + 限尺寸 → 上传成消息图,返回 image_key
// (播报卡内嵌画板现状用)。刻意走临时文件而非流直传:response 流直接 append 进 multipart 依赖
// axios/form-data 对无 filename/length 流的推断(两层不确定),fs.createReadStream 则与生产在用的
// uploadImage 完全同路径 —— 稳字优先。失败由调用方降级(无图卡照发);finally 清临时文件。
// 聚焦裁剪(整板图太大、看不清标注):annotationFocusRegion 纯几何算像素
// 框(board.js 可单测),执行用 macOS 自带 sips(-c h w --cropOffset y x;零依赖纪律不破,生产
// daemon 在 mac);非 darwin / sips 失败 / 不值得裁 ⇒ 整板原图,渐进增强绝不阻断。
// 最后 -Z 限最大边 1600(文件小、上传快;显示是自适应,裁剪才是治「太高」的正解)。
async function boardPreviewImageKey(client, whiteboardId, { nodes = null, freshNodes = null } = {}) {
  const wb = client.board && client.board.v1 && client.board.v1.whiteboard
  if (!wb || typeof wb.downloadAsImage !== 'function') throw new Error('SDK 缺少 board.whiteboard.downloadAsImage — 请升级 @larksuiteoapi/node-sdk')
  const res = await wb.downloadAsImage({ path: { whiteboard_id: whiteboardId } })
  if (!res || typeof res.writeFile !== 'function') throw new Error('画板导出失败:未返回图片流')
  const os = require('node:os')
  const { execFileSync } = require('node:child_process')
  const { imageSize, annotationFocusRegion } = require('./board')
  const stem = path.join(os.tmpdir(), `sbot-board-preview-${whiteboardId.replace(/[^\w-]/g, '')}-${Date.now()}`)
  const tmp = stem + '.png'
  const cropped = stem + '-crop.png'
  let useFile = tmp
  try {
    await res.writeFile(tmp)
    if (process.platform === 'darwin' && nodes && freshNodes) {
      try {
        const dim = imageSize(fs.readFileSync(tmp))
        const region = annotationFocusRegion(nodes, freshNodes, dim.width, dim.height)
        if (region) {
          execFileSync('sips', ['-c', String(region.h), String(region.w), '--cropOffset', String(region.y), String(region.x), tmp, '--out', cropped], { stdio: 'ignore', timeout: 15_000 })
          useFile = cropped
        }
      } catch { /* 聚焦失败 → 整板原图 */ }
      try {
        const d2 = imageSize(fs.readFileSync(useFile))
        if (Math.max(d2.width, d2.height) > 1100) execFileSync('sips', ['-Z', '1100', useFile], { stdio: 'ignore', timeout: 15_000 })
      } catch { /* 缩放失败 → 原尺寸上传 */ }
    }
    return await uploadImage(client, useFile)
  } finally {
    for (const f of [tmp, cropped]) { try { fs.unlinkSync(f) } catch { /* 已清/未生成 */ } }
  }
}

async function downloadBoardMedia(client, fileToken, absPath) {
  const media = (client.drive && client.drive.v1 && client.drive.v1.media) || (client.drive && client.drive.media)
  if (!media || typeof media.download !== 'function') throw new Error('SDK 缺少 drive.media.download — 请升级 @larksuiteoapi/node-sdk')
  const res = await media.download({ path: { file_token: fileToken } })
  if (!res || typeof res.writeFile !== 'function') throw new Error('下载失败:未返回资源流')
  await res.writeFile(absPath)
  return absPath
}

// 画板文字节点(形状对齐官方 whiteboard-cli 的 openapi 输出;独立 type:"text" 会被拒)。
function boardTextNode(id, x, y, width, height, text, opts = {}) {
  return {
    id, type: 'text_shape', x, y, width, height,
    text: { text, font_weight: 'regular', font_size: opts.fontSize || 14, horizontal_align: opts.align || 'left', vertical_align: 'top', text_color: opts.color || '#1f2329', text_color_type: 1 },
  }
}

// 「使用说明」便签(board-create 时确定性放置,零模型成本):浅黄底卡片 + 文字,
// 用户第一次打开画板就知道怎么改、怎么触发。
// ⚠ v0.11.16 改口:原文把「画箭头 + 写文字说明」当成唯一路子,可**文字/连线/位置本来就能
// 直接在画板上改**(产品决定)—— 让人为了改俩字先画个箭头是白绕一圈。标注降为
// 「提意见 / 要它判断怎么改」时才用。
// ⚠ 「改完回群里说一声」这半句不能省:自动感知靠画布轮询,而轮询默认关(飞书月调用量)
// ⇒ 多数部署里**没人在轮询**,写「它会自动发现」就是假话。
function boardUsageNoteNodes() {
  return [
    { id: 'note-bg', type: 'composite_shape', x: 0, y: -152, width: 560, height: 116, composite_shape: { type: 'rect' }, style: { border_style: 'none', fill_opacity: 100, fill_color: '#fff7d6', fill_color_type: 1 } },
    boardTextNode('note-tx', 16, -136, 528, 84, '使用说明:机器人生成的图会出现在这里。文字、连线、位置都可以直接在画板上改,改完回群里说一声就行。要提意见、或想让它判断怎么改,再在图上画箭头 + 写说明,回群里说「按标注改」。', { fontSize: 14 }),
  ]
}

module.exports = { createFeishuPlatform, createCardThrottle, createCardWriter, assertCardOk, ERR_STREAM_DEAD, STREAM_WINDOW_MS, answerCardElements, parseText, shouldHandleGroup, feishuClient, fetchBotOpenId, fetchBotInfo, fetchAppInfo, fetchAppIdentity, normalizeBotInfo, normalizeAppInfo, identityCheck, APP_INFO_SCOPE_HINT, fetchChats, createChat, fetchChatMembers, addChatMembers, deleteChat, sendChatText, sendChatImage, sendChatFile, sendChatCard, updateCardEntity, uploadImage, resolveSendPath, larkErrMsg, feishuHint, feishuPrecheck, fetchAdminCandidates, resolveContactToOpenId, fetchOrgUsers, fetchChatHistory, historyAtMark, replyMessage, editMessage, recallMessage, downloadResource, reactMessage, normalizeEmoji, createBoardDoc, fetchDocUrl, shareDocWithChat, addChatTabDoc, uploadBoardImage, createBoardNodes, createBoardDiagram, listBoardNodes, deleteBoardNodes, boardTextNode, boardUsageNoteNodes, subscribeBoard, listBoardComments, resolveBoardComment, downloadBoardMedia, boardPreviewImageKey }
