// 企业微信「智能机器人(API 模式)」长连接适配器 —— 满足 src/core/interfaces.js 的 Platform 契约。
// core 不认识本文件,只认接口形状;bin 按配置 `platform:"wecom"` 选用它(否则仍是飞书)。
//
// 协议(2026-10-10 真机逐项实测,见 docs/WECOM.md):
//   · bot 主动连 wss://openws.work.weixin.qq.com,发 aibot_subscribe{bot_id,secret} 订阅;不需要公网、
//     域名、可信 IP、加解密 —— 家庭宽带动态 IP 直接能跑。
//   · 每 30s 发 ping;回包与请求靠 headers.req_id 配对。⚠ 判活只认 ping 的回包:真机上首连一小时后
//     服务端静默停投,TCP 仍是 ESTABLISHED、没有 close / error 事件 —— 75s 没回包就主动掐线重连。
//   · 收:aibot_msg_callback(群里只有 @ 机器人的消息才来;单聊全来)、aibot_event_callback(进入会话 /
//     卡片按钮 / 反馈 / 被另一条连接踢下线)。断线期间的消息**不补发**。
//   · 回:aibot_respond_msg 透传回调的 req_id(同一 req_id 24h 内可多次回复);流式 = 同一 stream.id
//     全量替换、finish=true 收尾,**首帧起 10 分钟内必须收尾**(超了 846608)。
//   · 推:aibot_send_msg{chatid, chat_type 1 单聊 / 2 群} 只认 markdown / template_card / 图 / 文件 /
//     语音 / 视频(text、stream 都是 40008);前提 = 该会话有人先给机器人发过消息。
//   · markdown ≤ 20480 字节(超了 40058,且那条错误回包**不带 req_id**)。
//   · 同一个机器人只许一条长连接:新连踢旧连(旧连收到 disconnected_event)。
//
// 不在本文件做的事(与飞书适配器对齐的边界):撤回事件(企微没有)· 群历史(走官方 CLI)·
// 发送者姓名的权威来源(CLI 搜人,这里只做缓存与后台预热)。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')
const http = require('node:http')
const { execFile } = require('node:child_process')
const { HISTORY_DAYS, fmtBeijing, createWecomCli } = require('./wecomcli') // 群历史可查天数(6:整 7 天踩边界被拒)· 时间字面量按北京 · 工具封装(轮询历史用)
const { createHistoryPoll, DUP_WINDOW_MS } = require('./wecompoll')
const { mentionsOf } = require('./wecomname') // 机器人名从群消息里的 @ 学(平台没有取机器人信息的接口) // 「不 @ 也回复」:轮询群历史补入站 + 规则门控
const { createWatchdog } = require('./wswatchdog')
const NAME_WAIT_MS = 5_000 // 首次见到某人时最多等搜人这么久(真机搜人 1~3 秒);超时先显示账号
const { scanTables, cleanCell } = require('../core/mdtable')

const WS_URL = 'wss://openws.work.weixin.qq.com'
const PING_MS = 30_000          // 文档建议的心跳间隔
const STALE_MS = 75_000         // 连续两个 ping 没回包 ⇒ 判死(SDK 口径是 12s,这里放宽免误杀)
const TICK_MS = 15_000          // 看门狗巡检(卡在非连接态过久 ⇒ 强制重建)
const MD_MAX_BYTES = 20_480     // markdown.content 上限(服务端 40058)
const MD_SAFE_BYTES = 19_000    // 自留余量:切片时按它切,免得边界上多一个多字节字符就被拒
const STREAM_ROLL_MS = 9 * 60_000 // 流式 10 分钟硬上限 ⇒ 9 分钟就收掉这一段、另起一段接着流
const RESPOND_WINDOW_MS = 23 * 3600_000 // 回调 req_id 的可回复窗口(文档 24h,自留 1h)
const MEDIA_MAX_BYTES = 100 * 1024 * 1024 // 入站媒体上限(文档:文件 / 视频 ≤ 100MB)

// ── 纯函数:入站归一 ───────────────────────────────────────────────────────────────

// 去掉正文里对机器人的 @:群聊回调的 text.content 形如「@SintBot 帮我看下」—— @ 文本混在内容里,
// 不剥的话每轮 prompt 开头都是一个无意义的提及。知道机器人名字就按名字剥(任意位置、可多次);
// 不知道就只剥开头那一个(群里能到的消息必然 @ 了它,开头那个 @ 十有八九是它)。
// 去重键归一:多段文字之间长连接用换行拼、历史接口用空格拼,引用只在长连接有 —— 不归一就对不上(对不上 = 同一条 @ 消息答两遍)
const plainKey = (parts) => parts.join(' ').replace(/\s+/g, ' ').trim()

// 零宽字符(U+200B~200D / 2060 / FEFF):手机端复制粘贴常夹带,肉眼看不见却会进 prompt、也会让去重键对不上 —— 一律去掉
const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g
const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function stripMention(text, botName) {
  let t = String(text == null ? '' : text).replace(ZERO_WIDTH_RE, '')
  // 名字也要去零宽:学来的名字可能带着它(wecomname 入口已剥,这里再兜一层 —— 正文剥了名字没剥 = 永远匹配不上)
  if (botName) botName = String(botName).replace(ZERO_WIDTH_RE, '')
  // 按名剥要带词边界:「@SintBot2」是另一个成员,不能剥成「2」。边界 = 名字后面不是字母 / 数字 / _ / -
  // (空白、句尾、标点、汉字都算边界 —— 「@小助手帮我看看」这种名字后面直接接汉字的也要剥得掉)
  if (botName) t = t.replace(new RegExp('@' + reEscape(botName) + '(?![A-Za-z0-9_\\-])', 'g'), ' ')
  else t = t.replace(/^(\s*@\S+)+\s*/, ' ') // 「@张三 @SintBot 看看」:开头连着的提及一起剥,免得剥错人
  return t.replace(/[ \t]+/g, ' ').replace(/^ +| +$/gm, '').trim()
}

// 入站帧 ⇒ 对象。平台会把成员输入原样塞进 JSON 字符串,含原始控制字符(U+000B 之类)的帧 JSON.parse 直接抛
// (官方 SDK 曾因此一条消息打死整条连接)。三步:原样解析 → 失败就剔掉控制字符重试(先不碰 \t \n \r:它们在 token 之间
// 是合法空白,直接删会把 `1\n}` 这种粘成坏 JSON)→ 还失败再把 \t \n \r 换成空格重试(串里原始 TAB 同样非法 —— 从表格复制
// 粘贴就带;token 之间换空格无害,串内换空格只丢排版不丢消息)。三次都不行才抛 —— 调用方丢这一帧并记日志,连接不受影响。
function parseFrame(raw) {
  const s = String(raw)
  try { return JSON.parse(s) } catch (e) {
    const cleaned = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    try { if (cleaned !== s) return JSON.parse(cleaned) } catch { /* 再试一次 */ }
    const spaced = cleaned.replace(/[\t\n\r]/g, ' ')
    if (spaced === cleaned) throw e
    return JSON.parse(spaced)
  }
}

// 一条回调 body ⇒ 引擎能吃的形状(media 另给,由调用方决定下不下载)。什么都没有 ⇒ null。
//   返回 { chatId, chatType('single'|'group'), userId, msgId, createTimeMs, text, media:[{kind,url,aeskey,name}] }
//   · text:文本 / 图文混排的文字 / 语音转写(前缀标明)/ 引用(附在末尾)
//   · media:图片 / 文件 / 视频的加密下载坐标(url 五分钟内有效,aeskey 解密)
function normalizeInbound(body, { botName } = {}) {
  if (!body || typeof body !== 'object') return null
  const chatType = body.chattype === 'group' ? 'group' : 'single'
  const userId = (body.from && body.from.userid) || 'unknown'
  const chatId = chatType === 'group' ? body.chatid : userId
  if (!chatId) return null
  const parts = []
  const media = []
  const takeMedia = (kind, obj, name) => { if (obj && obj.url) media.push({ kind, url: obj.url, aeskey: obj.aeskey || null, name: name || null }) }
  const eat = (item) => {
    if (!item || typeof item !== 'object') return
    switch (item.msgtype) {
      case 'text': if (item.text && item.text.content) parts.push(stripMention(item.text.content, botName)); break
      case 'image': takeMedia('image', item.image); break
      case 'file': takeMedia('file', item.file, item.file && item.file.filename); break
      case 'video': takeMedia('video', item.video); break
      case 'voice': if (item.voice && item.voice.content) parts.push('(语音转文字)' + String(item.voice.content).replace(ZERO_WIDTH_RE, '')); break
      case 'mixed': for (const sub of (item.mixed && item.mixed.msg_item) || []) eat(sub); break
      default: break
    }
  }
  eat(body)
  const ownParts = parts.length // 引用之前的片段数:去重键只认本条自己的文字
  // 引用的那条:原文给出来(agent 常被要求「看我引用的这条」);引用里的媒体一并收进 media。
  if (body.quote && typeof body.quote === 'object') {
    const q = body.quote
    const before = parts.length
    const qm = media.length
    eat(q)
    const qText = parts.splice(before).join(' ').trim()
    const qMedia = media.splice(qm)
    if (qText || qMedia.length) parts.push(`「引用:${qText || '(' + qMedia.map((m) => m.kind === 'image' ? '图片' : '文件').join('、') + ')'}」`)
    media.push(...qMedia)
  }
  const text = parts.join('\n').trim()
  if (!text && !media.length) return null
  return {
    chatId,
    chatType,
    userId,
    msgId: body.msgid || `${chatId}:${body.create_time || Date.now()}`,
    createTimeMs: body.create_time ? Number(body.create_time) * 1000 : Date.now(),
    text,
    plain: plainKey(parts.slice(0, ownParts)), // 去重键:只有本条的文字段(不含「引用:…」),空白归一 —— 与轮询侧 wecompoll.plainText 同口径
    media,
  }
}

// ── 纯函数:出站 markdown ──────────────────────────────────────────────────────────

// 企微群里的回复长什么样,全由这一个函数定(v0.11.113 重排;此前只转表格 + 剥 <font>)。企微 aibot markdown 真机实测
// (10-10 / 10-12,docs/WECOM.md):粗体 / 列表 / 行内代码 / 链接 / 引用渲染;**表格与跨行代码块不渲染**(竖线与 ``` 原样
// 露出);HTML 标签一概不认(`<font color="comment">` 曾原样露在群里 —— 10-12 截图实证)。按这些事实逐项降级:
//   · 表格 ⇒ 表头一行加粗,每行一个列表项、单元格用「 · 」连;列数 ≥4 时给每格带上表头名,否则一串数字对不上列
//   · 代码块 ⇒ 去围栏,每行各自包成行内代码(等宽 + 保护 # * 等符号不被当 markdown;空行保留,单行里有反引号的用双反引号包)
//   · 标题 ⇒ 加粗行(聊天气泡里一级标题大得离谱,而回答至多一层结构,加粗足够;围栏内的 # 不动)
//   · HTML 标签(font / b / i / u / s / span / strong / em)⇒ 只留文字;<br> ⇒ 换行
// 顺序有讲究:表格扫描自带围栏识别,先转;再逐行走围栏 —— 围栏内的行包成行内代码后不会再被当标题 / 标签处理。
const INLINE_TAG_RE = /<\/?(?:font|b|i|u|s|span|strong|em)\b[^>]*>/gi
function codeLine(l) {
  if (!l.trim()) return ''
  return l.indexOf('`') === -1 ? '`' + l + '`' : '`` ' + l + ' ``'
}
function mdForWecom(text) {
  const src = String(text == null ? '' : text)
  const lines = []
  for (const seg of scanTables(src)) {
    if (seg.kind === 'text') { lines.push(...seg.text.split('\n')); continue }
    const header = seg.header.map(cleanCell)
    lines.push('**' + header.join(' · ') + '**')
    for (const r of seg.rows) {
      const cells = r.map(cleanCell)
      lines.push('- ' + (header.length >= 4 ? cells.map((c, i) => (i === 0 || !header[i] ? c : header[i] + ' ' + c)).join(' · ') : cells.join(' · ')))
    }
  }
  const out = []
  let fence = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue } // 围栏行本身丢掉(语言名也丢:气泡里没地方放)
    if (fence) { out.push(codeLine(line)); continue }
    let l = line.replace(/<br\s*\/?>/gi, '\n').replace(INLINE_TAG_RE, '')
    l = l.replace(/^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/, (_m, ind, t) => ind + '**' + t.replace(/^\*\*(.*)\*\*$/, '$1') + '**')
    out.push(l)
  }
  return out.join('\n')
}

// 按字节上限切片(UTF-8),尽量在行边界切;单行超长就硬切。空文本 ⇒ []。
function splitMarkdown(text, maxBytes = MD_SAFE_BYTES) {
  const src = String(text == null ? '' : text)
  if (!src) return []
  if (Buffer.byteLength(src) <= maxBytes) return [src]
  // 单行硬切:按码点走(emoji 等代理对不能从中间切开,切开两半都是非法 UTF-16),累计字节到上限为止
  const cutAt = (line) => { let bytes = 0, idx = 0; for (const ch of line) { const b = Buffer.byteLength(ch); if (bytes + b > maxBytes) break; bytes += b; idx += ch.length } return idx }
  const chunks = []
  let cur = ''
  const flush = () => { if (cur) { chunks.push(cur); cur = '' } }
  for (const line of src.split('\n')) {
    let l = line
    while (Buffer.byteLength(l) > maxBytes) { const cut = cutAt(l); flush(); chunks.push(l.slice(0, cut)); l = l.slice(cut) }
    const next = cur ? cur + '\n' + l : l
    if (Buffer.byteLength(next) > maxBytes) { flush(); cur = l } else cur = next
  }
  flush()
  return chunks
}

// ── 纯函数:入站媒体解密 ─────────────────────────────────────────────────────────

// 文档:AES-256-CBC,PKCS#7 填充到 32 字节的倍数,IV = AESKey 前 16 字节;aeskey 与回调加解密的
// EncodingAESKey 同形(43 字符 base64 去掉了「=」)。解不出来就原样返回(宁可给出密文让人排查,也不丢)。
function decodeAesKey(aeskey) {
  const s = String(aeskey || '').trim()
  if (!s) return null
  let key = Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64')
  if (key.length === 32) return key
  // 也可能直接给了 32 字节的十六进制 / 原文:只认长度对的
  if (s.length === 64 && /^[0-9a-f]+$/i.test(s)) return Buffer.from(s, 'hex')
  if (s.length === 32) return Buffer.from(s, 'latin1')
  return key.length >= 32 ? key.subarray(0, 32) : null
}

// 解不出(key 形状不对 / 长度不是 16 的倍数 / 填充不合法)返回 null —— 调用方按「下载失败」处理;
// 不能把密文原样存成 .png 交给 agent(那只会让它对着乱码说「图片损坏」)。
function decryptMedia(buf, aeskey) {
  const key = decodeAesKey(aeskey)
  if (!key || !buf || !buf.length || buf.length % 16 !== 0) return null
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
    d.setAutoPadding(false)
    const out = Buffer.concat([d.update(buf), d.final()])
    const pad = out[out.length - 1]
    // PKCS#7 校验:填充字节必须全等于填充长度(错 key 解出来的尾巴十有八九过不了这关)
    if (!(pad >= 1 && pad <= 32 && pad <= out.length)) return null
    for (let k = out.length - pad; k < out.length; k++) if (out[k] !== pad) return null
    return out.subarray(0, out.length - pad)
  } catch { return null }
}

// 加密(只给单测造数据用,与上面严格互逆)
function encryptMedia(buf, aeskey) {
  const key = decodeAesKey(aeskey)
  const pad = 32 - (buf.length % 32)
  const padded = Buffer.concat([buf, Buffer.alloc(pad, pad)])
  const c = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  c.setAutoPadding(false)
  return Buffer.concat([c.update(padded), c.final()])
}

// 按魔数猜扩展名(解密后的内容);猜不出用原名的扩展名,再不行 .bin
function sniffExt(buf, name) {
  if (buf && buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png'
    if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg'
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif'
    if (buf.length >= 12 && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp'
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return '.pdf'
  }
  const e = name ? path.extname(name) : ''
  return e && e.length <= 8 ? e : '.bin'
}

// 媒体标记:与飞书那条「[图片 message_id=… key=…]」同一用途(让 agent 接得住「我发给你的图」),
// 坐标换成本机路径 —— 企微的下载链接五分钟就失效,不能留给 agent 事后再取,只能到手就落盘。
function mediaMark(kind, p) {
  const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'
  return `[${label} path=${p}]`
}

// ── 流式回复会话(可单测:send / now / 定时器全注入)────────────────────────────────

// 引擎的 StreamingCard 契约:update(全量累计文本) · finish(最终正文, {milestones, footer})。
// 企微流式是「同一 stream.id 全量替换」+「首帧起 10 分钟内必须 finish」+「单帧 ≤ 20480 字节」。sbot 一轮常常超过
// 10 分钟、正文也可能超长 ⇒ **到龄或超长时分段**:把这一段**已经发出去**的内容 finish 定格,再对同一个 req_id 另起一个
// stream.id 续流,只带从断点往后的文字(前缀「(接上条)」)。
// ⚠ 引擎给 update 的是「正文 + 里程碑行」,给 finish 的是剥掉里程碑的正文 —— 两串不同,不能拿前者算出的断点去切后者
//   (审查 H1:那样会把最终答案切在随机位置)。收尾时只有最终正文**确实以定格文本开头**才续断点,否则整段重发。
// 节流:两帧之间至少 throttleMs,窗内只记最后一帧,窗到补发(累计文本幂等,丢中间帧无损)。
function createStreamSession({ send, sendMarkdown, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, throttleMs = 800, rollMs = STREAM_ROLL_MS, maxBytes = MD_SAFE_BYTES, log = () => {}, newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) } = {}) {
  let streamId = null
  let segStart = 0        // 当前段首帧时间
  let offset = 0          // 当前段在(转换后的)累计文本里的起点
  let frozen = ''         // 上一段定格时的全文(= 累计文本的前 offset 个字符)
  let lastSent = ''       // 本段最近一次发出去的全文(转换后)
  let sentInSeg = false   // 本段发过帧没有(没发过的段不需要 finish)
  let pending = null      // 节流窗内挂起的文本
  let timer = null
  let lastSentAt = -Infinity
  let closed = false
  let chain = Promise.resolve()
  let segments = 0
  let terminalFailed = false

  const frame = (content, finish) => {
    const id = streamId
    // 内容空串服务端会拒,占个省略号(首帧往往只有一个换行)
    chain = chain.then(() => send({ msgtype: 'stream', stream: { id, finish, content: content || '…' } })).then((ack) => {
      if (!ack || ack.errcode !== 0) {
        log(`流式帧被拒(${ack && ack.errcode}): ${(ack && ack.errmsg) || ''}`)
        if (finish) terminalFailed = true
        return null
      }
      return ack
    }).catch((e) => {
      log('流式帧发送异常: ' + (e && e.message))
      if (finish) terminalFailed = true
      return null
    })
    return chain
  }
  const open = () => { streamId = newId(); segStart = now(); segments++; sentInSeg = false }
  const segText = (full) => (offset ? '(接上条)' + full.slice(offset) : full.slice(offset))
  const tooBig = (t) => Buffer.byteLength(t) > maxBytes
  // 分段:把本段已发的内容定格(它一定不超长 —— 发之前就截过),从它的末尾另起一段
  const roll = () => { frame(segText(lastSent), true); frozen = lastSent; offset = lastSent.length; open() }

  const push = (raw) => {
    if (closed) return
    const full = mdForWecom(raw)
    if (!streamId) open()
    else if (sentInSeg && (now() - segStart >= rollMs || tooBig(segText(full)))) roll()
    let seg = segText(full)
    if (tooBig(seg)) seg = splitMarkdown(seg, maxBytes)[0] || '…' // 单次更新就超长:先发能放下的前半当预览,收尾会把全文分片发
    lastSent = full; sentInSeg = true; lastSentAt = now()
    frame(seg, false)
  }
  const flush = () => { timer = null; if (pending != null) { const t = pending; pending = null; push(t) } }

  return {
    update(text) {
      if (closed) return
      const t = String(text == null ? '' : text)
      if (t === '') return
      const wait = throttleMs - (now() - lastSentAt)
      if (wait <= 0) { pending = null; push(t); return }
      pending = t
      if (!timer) timer = setTimer(flush, wait)
    },
    async finish(text, opts = {}) {
      if (closed) return null
      closed = true
      if (timer) { clearTimer(timer); timer = null }
      pending = null
      const full = mdForWecom(String(text == null ? '' : text))
      // 续断点的前提:最终正文确实以定格过的文本开头;否则(里程碑行被剥、表格被转……)整段重发,宁可重复不可缺
      let body = !offset ? full : (full.startsWith(frozen) ? (full.length > frozen.length ? '(接上条)' + full.slice(frozen.length) : '') : full)
      // 页脚(耗时 · tokens)做成引用行:企微不认飞书那套 <font color="comment">(10-12 真机原样露出),引用是它能渲染的唯一「次要文字」样式
      if (opts.footer && (body || sentInSeg)) body = (body ? body + '\n\n' : '') + '> ' + String(opts.footer).replace(/\n+/g, ' ')
      if (!body && !sentInSeg) {
        if (!streamId) { open(); await frame('(无内容)', true) } // 一帧都没推过、正文也空:给一句交代,别让人干等
        else await chain // 刚分完段时要等上一段终帧确认,不能凭排队就算成功
        return terminalFailed ? null : 'ok'
      }
      if (!streamId) open()
      const chunks = splitMarkdown(body, maxBytes)
      const first = chunks.shift() || ''
      const finalAck = await frame(first || '(无内容)', true)
      let delivered = !!finalAck && !terminalFailed
      for (const c of chunks) {
        try {
          const ack = await sendMarkdown(c)
          if (typeof ack !== 'string' || !ack) { delivered = false; log('收尾续片未确认') }
        } catch (e) { delivered = false; log('收尾续片发送失败: ' + (e && e.message)) }
      }
      return delivered ? 'ok' : null
    },
    // 给单测与 connHealth 看的内部状态
    _state: () => ({ streamId, offset, segments, closed, pending: pending != null }),
  }
}

// ── 适配器 ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 *   botId / secret   — 机器人 API 配置页的 Bot ID 与长连接 Secret
 *   botName          — 机器人名字(剥 @ 用;不填只剥开头那个 @)
 *   inboxDir         — 入站媒体落盘目录(默认 ~/.sbot/wecom-inbox)
 *   names            — { userid: 显示名 } 手工映射(优先级最高)
 *   cli              — 官方命令行工具可执行名(默认 wecom-cli;搜人解姓名用;没装就只显示 userid)
 *   welcome          — 用户首次进入单聊时回的一句话(空 = 不回)
 *   throttleMs       — 流式帧节流窗(默认 800ms)
 *   pollSec          — 「不 @ 也回复」轮询群历史的间隔秒(默认 0 = 关;开要有命令行工具)
 *   followSec        — 跟进窗口秒(默认 300:被 @ / 开口后这么久内不 @ 的消息也喂;0 = 全喂)
 *   pollChats        — () => 要轮询的群 id 列表(bin 给已绑的企微群;每 tick 现读)
 *   keywords         — 点名词(默认「机器人」「助手」;正文含它或机器人名就喂)
 *   onIssue          — ({issue:'kicked'|'auth-expired'|'tool-gated', detail}) 平台侧要人处理的事(bin 转成运维告警)
 *   gate             — 便宜模型门控 async (chatId, {text, sender, recent}) => bool(规则不放行的消息再问它;不传 = 没有第二道门)
 *   log / onConn     — 日志 / 连接状态变化回调(控制台 SSE)
 *   WebSocket / wsUrl / now / setTimer / clearTimer / exec / fetchBuffer — 测试注入
 */
function createWecomPlatform(o = {}) {
  const { botId, secret } = o
  if (!botId || !secret) throw new Error('wecom: botId and secret required')
  // 机器人名 / 点名词可以给函数(bin 给的是「现读 engine.cfg」):控制台改了名字热生效,不用重启 —— 10-12 用户在控制台改名后
  // 发现要重启才认,而卡上只说过凭据要重启。启动横幅与「已装」日志读一次即可,剥 @ / 点名 / 门控提示词每次现取。
  let learnedName = null // 从群消息的 @ 里学到的名字:配置里没填 / 填错时的依据;控制台「刷新身份」会把它落进配置
  const botNameOf = () => { const v = typeof o.botName === 'function' ? o.botName() : o.botName; return v || learnedName || null }
  // 群消息必 @ 机器人(平台只推这种):正文里恰好只 @ 了一个名字时,那就是它。多个 @(连带别人)不学,免得学成别人
  function learnName(body) {
    if (!body || body.chattype !== 'group') return
    const texts = []
    const eat = (it) => { if (!it) return; if (it.msgtype === 'text' && it.text) texts.push(String(it.text.content || '')); if (it.msgtype === 'mixed') for (const s of (it.mixed && it.mixed.msg_item) || []) eat(s) }
    eat(body)
    const names = [...new Set(texts.flatMap(mentionsOf))]
    if (names.length !== 1) return
    if (learnedName !== names[0]) { learnedName = names[0]; const cfgName = typeof o.botName === 'function' ? o.botName() : o.botName; if (cfgName && cfgName !== learnedName) log(`企业微信:群里 @ 的名字是「${learnedName}」,与配置的「${cfgName}」不一致 —— 剥 @ 按群里的来;到控制台点「刷新身份」可同步`) }
  }
  const keywordsOf = () => { const v = typeof o.keywords === 'function' ? o.keywords() : o.keywords; return Array.isArray(v) ? v : undefined }
  const botName = botNameOf()
  // 配置里写 ~ 很自然(文档示例就是),这里展开;names 用无原型对象,免得 userid 叫 constructor 之类时拿到函数当姓名
  const inboxDir = expandHome(o.inboxDir) || path.join(os.homedir(), '.sbot', 'wecom-inbox')
  const names = Object.assign(Object.create(null), o.names || {})
  const cli = o.cli === false ? null : (o.cli || 'wecom-cli')
  const log = o.log || (() => {})
  const onConn = o.onConn || (() => {})
  const now = o.now || (() => Date.now())
  const setTimer = o.setTimer || setTimeout
  const clearTimer = o.clearTimer || clearTimeout
  const WebSocketImpl = o.WebSocket || require('ws')
  const wsUrl = o.wsUrl || WS_URL
  const exec = o.exec || execFile
  const fetchBuffer = o.fetchBuffer || defaultFetchBuffer
  const throttleMs = Number.isFinite(o.throttleMs) ? o.throttleMs : 800
  // 默认 0 = 关(产品决定「尽量关闭轮询」):平台的设计就是 @ 才答;开了要每 pollSec 秒拉群历史 —— 《企业微信人工智能服务使用规则》
  // 禁自动化抓取与异常频率,且 >10 人企业官方未开放 chat.*(853006),行为会因企业而异。留作小测试群可开的开关
  const pollSec = Number.isFinite(Number(o.pollSec)) && o.pollSec !== undefined && o.pollSec !== null && o.pollSec !== '' ? Number(o.pollSec) : 0
  const followSec = Number.isFinite(Number(o.followSec)) && o.followSec !== undefined && o.followSec !== null && o.followSec !== '' ? Number(o.followSec) : 300
  const recentInbound = new Map() // chatId → [{text,t}] 长连接已投递的 @ 消息(轮询去重用)
  let poll = null

  let ws = null
  let gen = 0                    // 每次建连 +1;旧 socket 的事件按代号丢弃
  let subscribed = false
  let everReady = false
  let stopping = false
  let pingTimer = null, tickTimer = null
  let lastAckAt = 0, lastEventAt = 0
  let kickedAt = 0               // 被另一条连接踢下线的时刻(重连要让一让)
  // 被踢的官方口径是「避免多连接、主备切换」,官方 SDK / 插件被踢后都**不**自动重连;我们给一次机会(60s 后重连一次 —— 对面可能是人手起的调试
  // 连接),10 分钟内第二次被踢就停连并告警:两台机器配了同一个 Bot ID 时自动重连 = 每 60 秒互踢一轮,谁都收不到消息
  const kicks = []
  let halted = false
  const onIssue = (ev) => { try { if (typeof o.onIssue === 'function') o.onIssue(ev) } catch {} }
  let warnedEncUser = false, warnedAuth = -Infinity // -Infinity:首次必报(假时钟从小数起,0 会让「10 分钟一次」的判据把首条压掉)
  // 出站发送在「还没订阅成功」时等一等(最多 SEND_WAIT_MS),不是立刻失败:daemon 一起来就发的升级播报 / 续做告知 /
  // 定时任务直发,比长连接订阅成功早一秒(真机 10-12 11:02:58 播报 → 11:02:59 才订阅)就全部「not connected」丢掉,
  // 而飞书走 HTTP 不受影响 ⇒ 企微群永远收不到升级播报。订阅成功的瞬间把排队的放行;超时才真的放弃(回 null)。
  const AFTER_REPLY_POLL_MS = 4_000 // 机器人答完多久补拉一次群历史(两车道:跟进句通常紧跟在回答后)
  const SEND_WAIT_MS = 30_000
  const subWaiters = []
  const whenSubscribed = (ms) => subscribed ? Promise.resolve(true) : new Promise((resolve) => {
    const w = { done: (ok) => { clearTimer(w.t); const i = subWaiters.indexOf(w); if (i >= 0) subWaiters.splice(i, 1); resolve(ok) }, t: null }
    w.t = setTimer(() => w.done(false), ms); if (w.t && w.t.unref) w.t.unref()
    subWaiters.push(w)
  })
  const releaseWaiters = (ok) => { for (const w of subWaiters.splice(0)) w.done(ok) }
  const waiters = new Map()      // req_id → [resolve…](同一 req_id 多次回复 ⇒ 队列)
  const chatTypes = new Map()    // chatId → 1 单聊 / 2 群(主动推送要带)
  const atSeen = new Set()       // 本进程里真收到过长连接回调(= 有人 @ 过)的会话;轮询到的历史不算 —— 846607 翻人话用
  const nameCache = new Map()    // userId → 显示名
  let cliDead = !cli
  let onMessage = null
  let hooks = {}
  const inbound = new Map()       // chatId → 处理链:同一会话内串行(媒体下载要 await,串行才不会让后到的消息抢先推水位线),会话之间互不等待

  const seq = { n: 0 }
  const rid = (p) => `${p}_${now().toString(36)}_${++seq.n}`

  // 一问一答:按 req_id 配对;没连上 / 超时都 resolve 成 errcode≠0,绝不 reject(调用方按 errcode 判)
  const call = (cmd, body, reqId, timeoutMs = 20_000) => new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve({ errcode: -1, errmsg: 'not connected' })
    const id = reqId || rid(cmd.replace(/^aibot_/, ''))
    let t = null
    const done = (v) => { if (t) clearTimer(t); resolve(v) } // 回包到了就撤超时定时器,别让它们拖着进程 / 假时钟
    if (!waiters.has(id)) waiters.set(id, [])
    waiters.get(id).push(done)
    try { ws.send(JSON.stringify({ cmd, headers: { req_id: id }, body })) } catch (e) { dropWaiter(id, done); return done({ errcode: -1, errmsg: e && e.message }) }
    t = setTimer(() => { if (dropWaiter(id, done)) resolve({ errcode: -1, errmsg: 'timeout' }) }, timeoutMs)
  })
  // 从等待队列摘掉一个 resolver(超时 / 发送失败时用):同一 req_id 可能排着多个回复在等各自的 ack,只摘自己那个
  const dropWaiter = (id, fn) => { const q = waiters.get(id); if (!q) return false; const i = q.indexOf(fn); if (i < 0) return false; q.splice(i, 1); if (!q.length) waiters.delete(id); return true }

  // ── 连接生命周期(看门狗:健康快照 + 卡死重建的退避决策;本文件只喂事件)──────────
  const watchdog = createWatchdog({ now, log, onConn, rebuild: () => connect() })

  function connect() {
    if (stopping) return
    if (halted) { log('企业微信:已因重复被踢停止重连,重启守护进程才会再连'); return }
    const myGen = ++gen
    subscribed = false
    // 被踢后至少让 60s:对面可能是人手起的调试连接,立刻抢回去就是两边互踢
    const wait = kickedAt && now() - kickedAt < 60_000 ? 60_000 - (now() - kickedAt) : 0
    const go = () => {
      if (stopping || myGen !== gen) return
      // 看门狗因「卡在连接态过久」重建时,旧 socket 可能还半开着:先掐掉,免得它之后真连上成了第二条连接把新的踢掉
      if (ws) { try { ws.terminate ? ws.terminate() : ws.close() } catch {} ws = null }
      let sock
      try { sock = new WebSocketImpl(wsUrl) } catch (e) { watchdog.onError(e); return }
      ws = sock
      sock.on('open', async () => {
        if (myGen !== gen) return
        const ack = await call('aibot_subscribe', { bot_id: botId, secret })
        if (myGen !== gen) return
        if (ack.errcode === 0) {
          subscribed = true; lastAckAt = now(); releaseWaiters(true)
          if (everReady) watchdog.onReconnected(); else { everReady = true; watchdog.onReady() }
          log('企业微信长连接已订阅')
        } else {
          log(`企业微信订阅失败(${ack.errcode}): ${ack.errmsg || ''}`)
          watchdog.onError(new Error(`subscribe ${ack.errcode} ${ack.errmsg || ''}`))
          try { sock.terminate ? sock.terminate() : sock.close() } catch {}
        }
      })
      sock.on('message', (buf) => { if (myGen === gen) handleFrame(buf) })
      sock.on('close', (code, reason) => {
        if (myGen !== gen) return
        subscribed = false
        if (stopping) return
        log(`企业微信长连接断开(${code}${reason ? ' ' + String(reason) : ''})`)
        watchdog.onError(new Error(`closed ${code}`))
      })
      sock.on('error', (e) => { if (myGen === gen) log('企业微信长连接错误: ' + (e && e.message)) })
    }
    if (wait > 0) setTimer(go, wait); else go()
  }

  function handleFrame(buf) {
    let f
    try { f = parseFrame(buf) } catch (e) { log('企业微信入站帧解析失败,已丢弃这一帧: ' + (e && e.message)); return }
    if (!f || typeof f !== 'object') return
    const id = f.headers && f.headers.req_id
    if (!f.cmd) {
      // 回包:ping 的只刷判活;其余按 req_id 交给等待者;没 req_id 的错误回包(超长 markdown 那种)只能记日志
      if (id && /^ping_/.test(id)) { lastAckAt = now(); return }
      const q = id && waiters.get(id)
      if (q && q.length) { q.shift()(f); if (!q.length) waiters.delete(id); return }
      if (f.errcode) log(`企业微信回包无人认领(${f.errcode}): ${f.errmsg || ''}`)
      return
    }
    lastEventAt = now(); watchdog.onEvent()
    if (f.cmd === 'aibot_msg_callback') {
      const b = f.body || {}
      const key = b.chattype === 'group' ? (b.chatid || '?') : ((b.from && b.from.userid) || '?')
      const prev = inbound.get(key) || Promise.resolve()
      const next = prev.then(() => onInbound(f)).catch((e) => log('企业微信入站处理异常: ' + (e && e.message)))
      inbound.set(key, next)
      next.then(() => { if (inbound.get(key) === next) inbound.delete(key) })
      return
    }
    if (f.cmd === 'aibot_event_callback') { onEvent(f).catch((e) => log('企业微信事件处理异常: ' + (e && e.message))); return }
  }

  async function onInbound(f) {
    const body = f.body || {}
    learnName(body)
    const norm = normalizeInbound(body, { botName: botNameOf() })
    if (!norm) return
    chatTypes.set(norm.chatId, norm.chatType === 'group' ? 2 : 1); atSeen.add(norm.chatId)
    // 媒体到手就落盘(链接五分钟失效),标记进正文
    const marks = []
    for (let i = 0; i < norm.media.length; i++) {
      const m = norm.media[i]
      try {
        const p = await saveMedia(m, `${norm.msgId}-${i + 1}`)
        marks.push(mediaMark(m.kind, p))
      } catch (e) { log(`企业微信媒体下载失败(${m.kind}): ` + (e && e.message)); marks.push(`[${m.kind === 'image' ? '图片' : '文件'} 下载失败]`) } // 原话只进日志(里面有路径 / 工具名,agent 会复述)
    }
    const text = [norm.text, ...marks].filter(Boolean).join('\n')
    if (!text) return
    // 轮询去重 / 跟进窗口:这条是长连接投递的 @ 消息
    if (norm.chatType === 'group') {
      const arr = recentInbound.get(norm.chatId) || []
      arr.push({ text: norm.plain, t: norm.createTimeMs, userId: norm.userId }); if (arr.length > 30) arr.shift()
      recentInbound.set(norm.chatId, arr)
      if (poll) poll.noteActivity(norm.chatId)
    }
    // 姓名:手工映射 > 缓存 > **首次见到这个人就等一次搜人(最多 NAME_WAIT_MS)**。不能靠启动预热:群历史里的 userid 是工具
    // 那套 woA2… 形态,与长连接给的明文 userid 对不上(10-10 真机),所以唯一能把明文换成姓名的就是按明文搜人。这里 await 不改变
    // 消息顺序 —— 同一会话本来就串行(媒体下载也在等),只是第一条晚几秒;超时就先用账号,搜人结果照样进缓存给下一条。
    // 回调 userid 是密文(woA2… 形态)= 机器人创建者不是超级管理员(官方 101463):搜人与手工映射都对不上,只能靠轮询历史桥接;提醒一次
    if (!warnedEncUser && /^wo[A-Za-z0-9_-]{20,}$/.test(String(norm.userId))) { warnedEncUser = true; log('企业微信:回调里的成员账号是密文形态 —— 机器人创建者不是超级管理员;成员姓名要等群历史对上才显示,建议用超级管理员账号持有机器人') }
    let senderName = names[norm.userId] || nameCache.get(norm.userId)
    if (!senderName && !nameCache.has(norm.userId)) senderName = await warmName(norm.userId)
    senderName = senderName || norm.userId
    const reqId = f.headers && f.headers.req_id
    const msg = {
      chatId: norm.chatId,
      userId: norm.userId,
      senderName,
      text,
      msgId: norm.msgId,
      createTimeMs: norm.createTimeMs,
      replyCtx: { chatId: norm.chatId, chatType: norm.chatType, reqId, reqAt: now() },
    }
    if (!onMessage) return
    Promise.resolve(onMessage(msg)).catch((e) => log('企业微信 onMessage 异常: ' + (e && e.message)))
  }

  async function onEvent(f) {
    const body = f.body || {}
    const ev = body.event || {}
    const reqId = f.headers && f.headers.req_id
    const userId = (body.from && body.from.userid) || 'unknown'
    const chatId = body.chattype === 'group' ? body.chatid : userId
    if (chatId) chatTypes.set(chatId, body.chattype === 'group' ? 2 : 1)
    if (ev.eventtype === 'disconnected_event') {
      const t = now(); kicks.push(t); while (kicks.length && t - kicks[0] > 10 * 60_000) kicks.shift()
      if (kicks.length >= 2) {
        halted = true
        log(`企业微信:10 分钟内第二次被另一条连接踢下线 —— 停止重连(两台机器配了同一个 Bot ID?每台各建各的机器人);重启守护进程才会再连`)
        onIssue({ issue: 'kicked', detail: `kicked ${kicks.length}x in 10min, botId …${String(botId).slice(-6)}` })
        try { if (ws) (ws.terminate ? ws.terminate() : ws.close()) } catch {}
        return
      }
      kickedAt = t
      log('企业微信:另一条连接用同一个机器人登录,本连接被踢下线(60s 后再试一次;10 分钟内再被踢就停连)')
      return
    }
    if (ev.eventtype === 'enter_chat') {
      if (o.welcome) await call('aibot_respond_welcome_msg', { msgtype: 'markdown', markdown: { content: String(o.welcome) } }, reqId, 4_000)
      return
    }
    if (ev.eventtype === 'template_card_event') {
      const tc = ev.template_card_event || {}
      if (!hooks.onCardAction) return
      // 与飞书卡片回调同形:{ messageId, chatId, operator:{userId}, action:{value} };返回 {card} ⇒ 5s 内更新卡片
      let r
      try { r = await hooks.onCardAction({ messageId: body.msgid, chatId, operator: { userId }, action: { value: tc.event_key, taskId: tc.task_id, cardType: tc.card_type, selected: tc.selected_items } }) } catch (e) { log('卡片回调处理异常: ' + (e && e.message)); return }
      if (r && r.card) {
        const card = toTemplateCard(r.card, tc.task_id)
        const ack = await call('aibot_respond_update_msg', { response_type: 'update_template_card', template_card: card }, reqId, 4_500)
        if (ack.errcode) log(`卡片更新被拒(${ack.errcode}): ${ack.errmsg || ''}`)
      }
      return
    }
    if (ev.eventtype === 'feedback_event') { log(`企业微信反馈事件:${userId} type=${ev.feedback_event && ev.feedback_event.type}`); return }
  }

  // 通用卡片形状 {title, desc, buttons:[{text,key,style}], taskId} ⇒ 企微 button_interaction 模板卡;
  // 已经是企微形状(带 card_type)的原样放行。更新卡片时 task_id 必须沿用原卡的(换了 846625)。
  function toTemplateCard(card, taskId) {
    if (card && card.card_type) return taskId && !card.task_id ? { ...card, task_id: taskId } : card
    const c = card || {}
    const out = {
      card_type: 'button_interaction',
      main_title: { title: String(c.title || ' ').slice(0, 64), desc: String(c.desc || '').slice(0, 512) },
      task_id: c.taskId || taskId || rid('task'),
    }
    const btns = Array.isArray(c.buttons) ? c.buttons.slice(0, 6) : []
    out.button_list = btns.length ? btns.map((b, i) => ({ text: String(b.text || '确定').slice(0, 12), key: String(b.key || 'k' + i), style: Number(b.style) || 1 })) : [{ text: '知道了', key: 'ok', style: 4 }]
    if (c.subTitle) out.sub_title_text = String(c.subTitle).slice(0, 512)
    if (c.url) out.card_action = { type: 1, url: String(c.url) }
    return out
  }

  async function saveMedia(m, base) {
    const raw = await fetchBuffer(m.url, { maxBytes: MEDIA_MAX_BYTES, timeoutMs: 30_000 })
    const data = m.aeskey ? decryptMedia(raw, m.aeskey) : raw
    if (!data) throw new Error('解密失败')
    fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 })
    const safeBase = String(base).replace(/[^\w.-]+/g, '_').slice(0, 80)
    const p = path.join(inboxDir, safeBase + sniffExt(data, m.name))
    fs.writeFileSync(p, data, { mode: 0o600 })
    return p
  }

  // 轮询拿到的历史媒体(工具已落盘)⇒ 搬成收件目录里规范命名的文件:`<base><扩展名>`,扩展名先嗅探内容再看原文件名。
  // 工具落的文件在 inboxDir 之外(它自己定的路径)就复制过来再删原件,在里面就原地改名;读不到原件直接抛(调用方记日志、给失败标记)。
  function placePolledMedia(r, base, name) {
    if (!r || !r.path) throw new Error('取媒体没有返回文件')
    const data = fs.readFileSync(r.path)
    fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 })
    const safeBase = String(base).replace(/[^\w.-]+/g, '_').slice(0, 80)
    const dest = path.join(inboxDir, safeBase + sniffExt(data, r.name || name))
    if (path.resolve(r.path) !== dest) {
      fs.writeFileSync(dest, data, { mode: 0o600 })
      try { fs.unlinkSync(r.path) } catch { /* 原件删不掉不算失败,只是收件目录多一份 */ }
    }
    return dest
  }

  // 姓名:官方 CLI `contact users search --keywords <userid>`(以机器人身份代授权人查;明文 userid 能搜中)。
  // 没装 / 没授权 ⇒ 一次 ENOENT / 非零退出后不再试,群里就显示 userid。
  // 返回 Promise<姓名|null>,最多等 NAME_WAIT_MS(走注入时钟,可测);超时先回 null,搜人仍在跑、结果照样进缓存。
  function warmName(userId) {
    if (cliDead) return Promise.resolve(null)
    nameCache.set(userId, null) // 占位:同一人不并发多查
    const lookup = new Promise((resolve) => {
      exec(cli, ['contact', 'users', 'search', '--keywords', userId], { timeout: 8_000, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) {
          if (err.code === 'ENOENT') { cliDead = true; log('企业微信命令行工具未安装,群里显示成员账号而非姓名') }
          else log('企业微信搜人失败(' + userId + '): ' + String((err && err.message) || err).slice(0, 120))
          // 失败也留 null 占位:同一个人不每条消息都再起一次子进程(未授权 / 超时这种状况一会儿不会变)
          nameCache.set(userId, null)
          return resolve(null)
        }
        try {
          const j = JSON.parse(String(stdout || '{}'))
          // 只认精确命中(userid 相等或关键词命中),模糊到别人头上就是张冠李戴
          const u = (j.users || []).find((x) => x && (x.userid === userId || (x.matched_keywords || []).includes(userId)))
          nameCache.set(userId, (u && u.name) || null)
          resolve((u && u.name) || null)
        } catch { nameCache.set(userId, null); resolve(null) }
      })
    })
    let t = null
    const deadline = new Promise((resolve) => { t = setTimer(() => resolve(null), NAME_WAIT_MS) })
    return Promise.race([lookup, deadline]).then((v) => { if (t) clearTimer(t); return v })
  }

  // 心跳 + 判活(一处):每 30s 发 ping;连续 75s 没收到任何 ping 回包就主动掐线 —— 掐线触发 close ⇒ 看门狗退避重建。
  // 不能等 close 事件:真机上服务端静默停投时 TCP 一直 ESTABLISHED,永远不会有 close。
  function pingTick() {
    if (!ws || ws.readyState !== 1 || !subscribed) return
    try { ws.send(JSON.stringify({ cmd: 'ping', headers: { req_id: rid('ping') } })) } catch {}
    if (lastAckAt && now() - lastAckAt > STALE_MS) {
      log(`企业微信长连接 ${Math.round((now() - lastAckAt) / 1000)}s 没有心跳回包,主动掐线重连`)
      try { ws.terminate ? ws.terminate() : ws.close() } catch {}
    }
  }

  // 主动推送要带 chat_type:入站时按 chatId 记过的优先;没见过的按形态猜 —— 群会话 id 以 wr 开头(真机实证),其余当 userid
  const chatTypeOf = (chatId) => chatTypes.get(chatId) || (/^wr/.test(String(chatId)) ? 2 : 1)

  // 两条出站路:respond = 对某条回调的回复(透传 req_id,排队 / 进度 / 正文都走它);send = 主动推送(合成消息、定时任务、告警)。
  // 都按 errcode 判,被拒返回 null —— 这是 Platform 契约里「确认没送到」的信号,调用方据此重试或记账。
  async function sendMarkdown(chatId, content) {
    if (!subscribed && !(await whenSubscribed(SEND_WAIT_MS))) { log(`企业微信发送放弃:等了 ${SEND_WAIT_MS / 1000}s 长连接仍未订阅成功`); return null }
    const ack = await call('aibot_send_msg', { chatid: chatId, chat_type: chatTypeOf(chatId), msgtype: 'markdown', markdown: { content } })
    if (ack.errcode) { log(`企业微信发送被拒(${ack.errcode}): ${ack.errmsg || ''}${pushRejectHint(ack.errcode, chatId)}`); return null }
    return 'ok'
  }
  // 846607 一个码两种人话(官方调研第 5 条):本进程收到过该会话的 @ ⇒ 必是超频(每会话 30 条 / 分、1000 条 / 时);
  // 没收到过 ⇒ 多半是「还没人 @ 过机器人」(主动推送的前提),但「有人 @ 过」是服务端跨重启的事实而 atSeen 重启即空 ——
  // 刚重启后的第一条推送(升级播报)若被拒,也可能是上一进程刚刷过的超频,文案要留这个口子。
  const pushRejectHint = (code, chatId) => code !== 846607 ? '' : (atSeen.has(chatId) ? ' —— 本会话推送超频(每分钟 30 条 / 每小时 1000 条),稍后再发' : ' —— 本次启动后还没收到过这个会话的消息:多半是还没人 @ 过机器人(先 @ 一次);若刚重启且此前聊过,则是推送超频')
  async function respondMarkdown(reqId, content) {
    const ack = await call('aibot_respond_msg', { msgtype: 'markdown', markdown: { content } }, reqId)
    if (ack.errcode) { log(`企业微信回复被拒(${ack.errcode}): ${ack.errmsg || ''}`); return null }
    return 'ok'
  }
  // 回调 req_id 还在可回复窗口内才走回复路,否则走主动推送(合成消息 / 定时任务本来就没有 req_id)
  const canRespond = (ctx) => !!(ctx && ctx.reqId && (!ctx.reqAt || now() - ctx.reqAt < RESPOND_WINDOW_MS))

  // 自描述:引擎据此改写自知清单(命令名 / 没有的能力不教)。core 不认识「企微」,只认这些字段。
  const platform = {
    skillCmd: 'sbot wecom',
    chatLabel: '企业微信群',
    // history 有(走官方 CLI 拉近 7 天群历史);回复 / 编辑 / 撤回 / 表情 / 下载 / 画布 / 生图没有;回复是普通消息不是钉住的卡片;send-msg 渲染 markdown
    // imagen / takeoverCard 翻回 true(P2):生图完成通知与接管入口都已按平台分流(走官方命令行工具,见 bin 的 imagenWorker / cmdBrowser)
    features: { editRecall: false, react: false, download: false, boards: false, imagen: true, takeoverCard: true, cardPinned: false, plainSend: false, mediaMarker: 'path' },

    async start(cb, h = {}) {
      onMessage = cb
      hooks = h || {}
      stopping = false
      connect()
      pingTimer = setInterval(pingTick, PING_MS)
      if (pingTimer.unref) pingTimer.unref()
      tickTimer = setInterval(() => watchdog.tick(), TICK_MS)
      if (tickTimer.unref) tickTimer.unref()
      log('企业微信长连接已启动(心跳 30s · 75s 无回包重连)')
      // 「不 @ 也回复」:有命令行工具且 pollSec > 0 才起;群列表每 tick 现读(跟随热重载)
      if (cli && pollSec > 0 && typeof o.pollChats === 'function') {
        const wcli = createWecomCli({ bin: cli, exec })
        poll = createHistoryPoll({
          chats: o.pollChats,
          // 850003 = 工具的能力授权过期(每 7 天一续,auth show 看不出):进告警群让创建者去点续期链接;其余错误照常只记日志
          // 853006 = 企业规模门控(官方未对本企业开放读群历史,不是配置错):同样进告警群说清;轮询侧自己会暂停半小时再试
          list: (chatId) => wcli.history(chatId).catch((e) => {
            const code = e && String(e.code)
            if ((code === '850003' || code === '853006') && now() - warnedAuth > 10 * 60_000) { warnedAuth = now(); onIssue({ issue: code === '850003' ? 'auth-expired' : 'tool-gated', detail: e.message }) }
            throw e
          }),
          // 历史里的图片 / 文件:工具按 media_id 取内容落到收件目录,再按内容嗅探扩展名、改成与长连接入站同款的文件名
          // (工具落盘的文件名是固定的 msg_media 之类,没有扩展名,agent 用看图工具打开会认不出格式)
          fetchMedia: async (md, base) => placePolledMedia(await wcli.fetchMedia(md.mediaId, inboxDir), base, md.name),
          mark: mediaMark,
          gate: typeof o.gate === 'function' ? o.gate : null, // 第二道门(便宜模型门控),bin 按 wecom.gatekeeper 配置建;没配 = 只有规则那道门
          deliver: (m) => { chatTypes.set(m.chatId, 2); if (onMessage) Promise.resolve(onMessage(m)).catch((e) => log('企业微信 onMessage 异常: ' + (e && e.message))) },
          // 去重命中 = 同一条消息在两边都见到了 ⇒ 顺手把「长连接的明文账号 ↔ 历史里的姓名」记进姓名缓存(两边 userid 不是一个空间,
          // 只有这一刻能对上;零额外调用)。手工 names 仍最高优先;下一条该成员的消息就有姓名了
          wasDelivered: (chatId, text, tMs, meta) => {
            const k = String(text || '').replace(/\s+/g, ' ').trim()
            const hit = (recentInbound.get(chatId) || []).find((r) => r.text === k && Math.abs(r.t - tMs) <= DUP_WINDOW_MS)
            if (hit && meta && meta.userName && hit.userId && nameCache.get(hit.userId) !== meta.userName) { nameCache.set(hit.userId, meta.userName); log(`企业微信:从群历史对上成员姓名 ${hit.userId} → ${meta.userName}`) }
            return !!hit
          },
          stripMention: (t) => stripMention(t, botNameOf()),
          now, setTimer, clearTimer, intervalMs: pollSec * 1000, followMs: followSec * 1000,
          botName: botNameOf, keywords: keywordsOf, log,
        })
        poll.start()
        log(`企业微信「不 @ 也回复」已开:群历史按档拉 —— 刚聊过 8s / 平时 ${pollSec}s / ${Math.round(Math.max(6 * pollSec, 120))}s 没人说话时 ${Math.round(Math.max(6 * pollSec, 120))}s;${followSec > 0 ? `跟进窗口 ${followSec}s` : '不设跟进窗口(全部都喂)'};@ 消息走长连接即时`)
      }
    },

    connHealth() {
      return { ...watchdog.snapshot(), lastAckAt, lastEventAt, subscribed, pingTimeoutSec: Math.round(STALE_MS / 1000), botName: botNameOf(), botNameLearned: learnedName, halted, encryptedUserIds: warnedEncUser }
    },

    async reply(replyCtx, content, opts) {
      // 轮询来的消息走主动推送,推送不会像回复那样自动引用原话 ⇒ 群里分不清机器人在回谁。**最终回答**那次推送开头加一行引用
      // 「回复 某某:原话前 40 字」(v0.11.113 的引用行样式);只认引擎标了 final 的那次 —— 排队 / 切换模型 / 重试这类系统短句不配引用;
      // 同一条消息只引一次。
      let body = content
      if (replyCtx && replyCtx.quote && opts && opts.final && !canRespond(replyCtx) && !replyCtx._quoted) {
        replyCtx._quoted = true
        const q = replyCtx.quote
        const who = (String(q.sender || '').trim() || '群友') + (q.senders > 1 ? ` 等 ${q.senders} 人` : '')
        const more = q.more > 0 ? `(连同前 ${q.more} 条)` : ''
        body = `> 回复 ${who}:${String(q.text || '').replace(/\s+/g, ' ').trim()}${more}\n\n${content}`
      }
      const chunks = splitMarkdown(mdForWecom(body))
      if (!chunks.length) return null
      if (poll && replyCtx && replyCtx.chatId) poll.noteActivity(replyCtx.chatId) // 机器人开口 ⇒ 续跟进窗口 + 热档
      let allConfirmed = true
      for (const c of chunks) {
        const ack = canRespond(replyCtx) ? await respondMarkdown(replyCtx.reqId, c) : await sendMarkdown(replyCtx && replyCtx.chatId, c)
        if (typeof ack !== 'string' || !ack) allConfirmed = false
      }
      if (poll && replyCtx && replyCtx.chatId) poll.kick(replyCtx.chatId, AFTER_REPLY_POLL_MS) // 答完几秒就补拉一次:跟进句通常紧跟在回答后
      return allConfirmed ? 'ok' : null
    },

    async send(chatId, content) {
      const chunks = splitMarkdown(mdForWecom(content))
      if (!chunks.length || !chatId) return null
      if (poll) poll.noteActivity(chatId)
      let allConfirmed = true
      for (const c of chunks) {
        const ack = await sendMarkdown(chatId, c)
        if (typeof ack !== 'string' || !ack) allConfirmed = false
      }
      if (poll) poll.kick(chatId, AFTER_REPLY_POLL_MS)
      return allConfirmed ? 'ok' : null
    },

    // 发一张按钮卡(通用形状见 toTemplateCard);返回 { msgId:null, taskId } —— 企微不回消息 id,按钮事件靠 task_id 对号
    async sendCard(chatId, card) {
      const tc = toTemplateCard(card)
      if (!subscribed && !(await whenSubscribed(SEND_WAIT_MS))) { log(`企业微信发卡放弃:等了 ${SEND_WAIT_MS / 1000}s 长连接仍未订阅成功`); return null }
      const ack = await call('aibot_send_msg', { chatid: chatId, chat_type: chatTypeOf(chatId), msgtype: 'template_card', template_card: tc })
      if (ack.errcode) { log(`企业微信发卡被拒(${ack.errcode}): ${ack.errmsg || ''}`); return null }
      return { msgId: null, cardId: null, taskId: tc.task_id }
    },

    // 流式回复:只有带 req_id 的真实消息才有(合成消息 / 定时任务退回普通回复)
    async createStreamingCard(replyCtx) {
      if (!canRespond(replyCtx)) return null
      const reqId = replyCtx.reqId
      const sess = createStreamSession({
        send: (body) => call('aibot_respond_msg', body, reqId),
        sendMarkdown: (c) => respondMarkdown(reqId, c),
        now, setTimer, clearTimer, throttleMs, log,
      })
      // 流式收尾 = 机器人答完 ⇒ 几秒后补拉一次该群历史(@ 之后的跟进句不用等到下一档)
      const fin = sess.finish
      sess.finish = async (...a) => { const r = await fin(...a); if (poll && replyCtx.chatId) poll.kick(replyCtx.chatId, AFTER_REPLY_POLL_MS); return r }
      return sess
    },

    async stop() {
      stopping = true
      releaseWaiters(false) // 关停时排队的发送别再等了
      if (poll) { try { poll.stop() } catch {} poll = null }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
      try { watchdog.stop() } catch {}
      gen++
      try { if (ws) (ws.terminate ? ws.terminate() : ws.close()) } catch {}
      ws = null
    },

    // 测试钩子
    _internal: { call, chatTypes, nameCache, handleFrame, normalizeInbound, pingTick, poll: () => poll, placePolledMedia },
  }

  return platform
}

// 控制台「绑定群」的候选来源:企微没有「列出机器人所在的群」接口,能拿到的只有**机器人被 @ 过的会话**
// (官方 CLI `message aibot sessions list` 最近 20 个 + `chat groups list` 近 7 天有消息的群,两路合并去重)。
// 所以新群要先在群里 @ 一次机器人才会出现在候选里 —— 控制台文案要把这一步说清。只返回群,单聊不绑项目。
function listWecomSessions({ cli = 'wecom-cli', exec = execFile, now = () => new Date() } = {}) {
  const run = (args) => new Promise((resolve, reject) => {
    exec(cli, args, { timeout: 20_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(new Error('企业微信命令行工具未安装 —— 装好并用机器人凭据授权一次后,这里才能列出群'))
      let j = null
      try { j = JSON.parse(String(stdout || '').trim() || 'null') } catch { /* 下面按失败处理 */ }
      if (j && j.error) return reject(new Error(j.error.message || String(j.error.code || '工具报错')))
      if (!j) return reject(new Error(err ? String((stderr || err.message || '')).trim().slice(0, 200) || '工具没有返回结果' : '工具没有返回可读的结果'))
      resolve(j)
    })
  })
  const fmt = fmtBeijing // 时间字面量按北京(服务端口径),与主机时区无关
  return Promise.all([
    run(['message', 'aibot', 'sessions', 'list']).catch((e) => { throw e }),
    (() => { const end = now(); const begin = new Date(end.getTime() - HISTORY_DAYS * 86400_000); return run(['chat', 'groups', 'list', '--begin-time', fmt(begin), '--end-time', fmt(end)]).catch(() => ({ chats: [] })) })(), // 第二路拿不到不致命;整 7 天会被拒
  ]).then(([ses, grp]) => {
    const out = new Map()
    for (const s of (ses.sessions || [])) if (s && s.chat_type === 'group' && s.chat_id) out.set(s.chat_id, { chatId: s.chat_id, name: s.chat_name || s.chat_id, lastMsgTime: s.last_msg_time || '' })
    for (const c of (grp.chats || [])) if (c && c.chat_id && !out.has(c.chat_id)) out.set(c.chat_id, { chatId: c.chat_id, name: c.chat_name || c.chat_id, lastMsgTime: c.last_msg_time || '' })
    return [...out.values()].sort((a, b) => String(b.lastMsgTime).localeCompare(String(a.lastMsgTime)))
  })
}

// 官方命令行工具当前授权给了哪个机器人:`auth show` 输出是两行纯文本「Status: authorized」「Bot ID: aib…」(不是 JSON)。
// 为什么要查:工具的授权与 daemon 的凭据是两套 —— 授权成另一个机器人时,搜姓名照样能搜到(通讯录是企业级的),但助手发图 /
// 发文件会从**那个**机器人发出、列出的「被 @ 过的群」也是那个机器人的,现象是「图发了群里没看到」。预检要把这事说出来。
function wecomAuthShow({ cli = 'wecom-cli', exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec(cli, ['auth', 'show'], { timeout: 15_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(Object.assign(new Error('企业微信命令行工具未安装'), { code: 'ENOENT' }))
      const text = String(stdout || '') + '\n' + String(stderr || '')
      const st = /Status:\s*(\S+)/i.exec(text), id = /Bot ID:\s*(\S+)/i.exec(text)
      if (!st && !id) return reject(new Error(err ? String(stderr || err.message || '').trim().slice(0, 200) || '工具没有返回授权状态' : '工具没有返回可读的授权状态'))
      resolve({ authorized: !!st && /^authorized$/i.test(st[1]), botId: id ? id[1] : null })
    })
  })
}

// 入站媒体下载:链接五分钟失效、内容加密,只能到手就取;放内存是因为解密要整段做(CBC + 整体填充),且上限 100MB 可控
function defaultFetchBuffer(url, { maxBytes = MEDIA_MAX_BYTES, timeoutMs = 30_000, hops = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = /^https:/i.test(url) ? https : http
    const req = mod.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 2) {
        res.resume()
        return defaultFetchBuffer(new URL(res.headers.location, url).toString(), { maxBytes, timeoutMs, hops: hops + 1 }).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const chunks = []; let size = 0
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(new Error('too large')); return } chunks.push(c) })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout'))) // 空闲超时
    const hard = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs * 2) // 总时长硬上限:慢速滴流不能无限拖(同会话后面的消息都在等它)
    req.on('close', () => clearTimeout(hard))
    req.on('error', reject)
  })
}

// 配置里的 ~ / ~/ 展开成家目录(只认开头的 ~)
function expandHome(p) {
  if (!p || typeof p !== 'string') return null
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

module.exports = {
  createWecomPlatform,
  createStreamSession,
  listWecomSessions,
  wecomAuthShow,
  normalizeInbound,
  stripMention,
  parseFrame,
  mdForWecom,
  splitMarkdown,
  decryptMedia,
  encryptMedia,
  decodeAesKey,
  expandHome,
  sniffExt,
  mediaMark,
  plainKey,
  MD_MAX_BYTES,
  MD_SAFE_BYTES,
  STREAM_ROLL_MS,
  WS_URL,
}
