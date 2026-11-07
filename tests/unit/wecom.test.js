// 企业微信智能机器人长连接适配器(src/platform/wecom.js)—— 纯函数与协议层单测,零网络。
// 判据来自 2026-10-10 真机实测(docs/WECOM.md):群聊正文带「@机器人」· 流式 10 分钟上限 · markdown 20480 字节 ·
// 回包按 req_id 配对且错误回包可能不带 req_id · text / stream 不能主动推 · TCP 活着不等于订阅活着(ping 回包判活)。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const W = require('../../src/platform/wecom')
const flush = () => new Promise((r) => setImmediate(r))

// ── 入站归一 ─────────────────────────────────────────────────────────────────────

test('stripMention:知道机器人名就按名剥(任意位置),不知道只剥开头那个 @', () => {
  assert.equal(W.stripMention('@SintBot 帮我看下', 'SintBot'), '帮我看下')
  assert.equal(W.stripMention('帮我看下 @SintBot 这个', 'SintBot'), '帮我看下 这个')
  assert.equal(W.stripMention('@SintBot 帮我看下'), '帮我看下')
  assert.equal(W.stripMention('帮我看下 @某人', 'SintBot'), '帮我看下 @某人') // 不是它的 @ 不动
  // 词边界:名字只是前缀的另一个成员不能被剥成「2」;名字后面直接接汉字 / 标点 / 句尾都算边界
  assert.equal(W.stripMention('@SintBot2 看看', 'SintBot'), '@SintBot2 看看')
  assert.equal(W.stripMention('@SintBot_x @SintBot 看看', 'SintBot'), '@SintBot_x 看看')
  assert.equal(W.stripMention('@小助手帮我看看', '小助手'), '帮我看看')
  assert.equal(W.stripMention('@SintBot,看看', 'SintBot'), ',看看')
  assert.equal(W.stripMention('看看 @SintBot', 'SintBot'), '看看')
  assert.equal(W.stripMention('@C.G+Bot 看看', 'C.G+Bot'), '看看') // 名字里的正则元字符按字面匹配
  // 零宽字符(手机端粘贴夹带)一律去掉,知不知道名字都一样
  assert.equal(W.stripMention('@SintBot\u200b 帮我\u200d看下\ufeff', 'SintBot'), '帮我看下')
  assert.equal(W.stripMention('@SintBot 帮我\u2060看下'), '帮我看下')
  assert.equal(W.stripMention('@SintBot\u200b 帮我看下', 'SintBot\u200b'), '帮我看下') // 学来的名字自己带零宽也要剥得掉
})

test('parseFrame:正常帧原样解析;串里夹原始控制字符的帧剔掉再解析;真坏的帧才抛', () => {
  assert.deepEqual(W.parseFrame('{"cmd":"x","body":{"a":1}}'), { cmd: 'x', body: { a: 1 } })
  // 成员输入里的 U+000B / U+0000 被平台原样塞进 JSON 串 ⇒ 标准 JSON.parse 必抛;剔掉后要能解出正文,且 \\n 这种转义不受影响
  const dirty = '{"cmd":"aibot_msg_callback","body":{"text":{"content":"看\u000b看\u0000这个\\n下一行"}}}'
  assert.throws(() => JSON.parse(dirty))
  assert.equal(W.parseFrame(dirty).body.text.content, '看看这个\n下一行')
  assert.equal(W.parseFrame(Buffer.from('{"x":"\u0001y"}')).x, 'y') // Buffer 也认(ws 给的是 Buffer)
  // 串里原始 TAB(从表格粘贴)同样非法:第二步剔控制字符不碰它,第三步换成空格 ⇒ 消息保住、只丢排版
  const tabbed = '{"a":"x\ty"}'
  assert.throws(() => JSON.parse(tabbed))
  assert.equal(W.parseFrame(tabbed).a, 'x y')
  assert.deepEqual(W.parseFrame('{\t"a":\n1\r}'), { a: 1 }) // token 之间的空白本就合法,第一步直接过
  assert.throws(() => W.parseFrame('{not json'), SyntaxError)
  assert.throws(() => W.parseFrame(''), SyntaxError)
})

test('normalizeInbound:群聊文本帧 ⇒ chatId=群 · userId 明文 · 正文剥 @ · 时间按秒转毫秒', () => {
  const body = { msgid: 'm1', chatid: 'wrGROUP', chattype: 'group', from: { userid: 'WangWu' }, msgtype: 'text', create_time: 1791609000, text: { content: '@SintBot Hi' } }
  const n = W.normalizeInbound(body, { botName: 'SintBot' })
  assert.deepEqual({ chatId: n.chatId, chatType: n.chatType, userId: n.userId, text: n.text, msgId: n.msgId, createTimeMs: n.createTimeMs, media: n.media },
    { chatId: 'wrGROUP', chatType: 'group', userId: 'WangWu', text: 'Hi', msgId: 'm1', createTimeMs: 1791609000000, media: [] })
})

test('normalizeInbound:单聊 chatId = 发送者 userid;图文混排收文字 + 图片坐标;引用附在末尾', () => {
  const body = { msgid: 'm2', chattype: 'single', from: { userid: 'U1' }, msgtype: 'mixed', mixed: { msg_item: [{ msgtype: 'text', text: { content: '看这张' } }, { msgtype: 'image', image: { url: 'https://x/1', aeskey: 'k' } }] }, quote: { msgtype: 'text', text: { content: '上一句' } } }
  const n = W.normalizeInbound(body)
  assert.equal(n.chatId, 'U1'); assert.equal(n.chatType, 'single')
  assert.equal(n.text, '看这张\n「引用:上一句」')
  assert.equal(n.plain, '看这张', '去重键不含引用')
  assert.deepEqual(n.media, [{ kind: 'image', url: 'https://x/1', aeskey: 'k', name: null }])
  // 多段文字:正文换行拼、去重键空格拼且归一 —— 与历史接口那边(空格拼)同一串,否则「看这张 [图] 和这张 @SintBot」会被答两遍
  const two = W.normalizeInbound({ chattype: 'group', chatid: 'wrG', from: { userid: 'U1' }, msgtype: 'mixed', mixed: { msg_item: [{ msgtype: 'text', text: { content: '看这张' } }, { msgtype: 'image', image: { url: 'https://x/1' } }, { msgtype: 'text', text: { content: '  和这张  @SintBot' } }] } }, { botName: 'SintBot' })
  assert.equal(two.text, '看这张\n和这张'); assert.equal(two.plain, '看这张 和这张')
  assert.equal(W.plainKey(['a  b', ' c\n d ']), 'a b c d')
})

test('normalizeInbound:语音给转写并标明;只有文件没有文字也成立;什么都没有 ⇒ null', () => {
  assert.equal(W.normalizeInbound({ chattype: 'single', from: { userid: 'U' }, msgtype: 'voice', voice: { content: '明天开会' } }).text, '(语音转文字)明天开会')
  const f = W.normalizeInbound({ chattype: 'single', from: { userid: 'U' }, msgtype: 'file', file: { url: 'https://x/f', aeskey: 'k', filename: 'a.pdf' } })
  assert.equal(f.text, ''); assert.equal(f.media[0].name, 'a.pdf')
  assert.equal(W.normalizeInbound({ chattype: 'group', chatid: 'wr1', from: { userid: 'U' }, msgtype: 'text', text: { content: '@SintBot' } }, { botName: 'SintBot' }), null)
  assert.equal(W.normalizeInbound(null), null)
})

// ── 出站 markdown ─────────────────────────────────────────────────────────────────

test('mdForWecom:表格改成列表(表头加粗、单元格用 · 连;≥4 列每格带表头名),其余原样', () => {
  const src = '前言\n\n| 列A | 列B |\n|---|---|\n| **1** | `2` |\n\n后记'
  assert.equal(W.mdForWecom(src), '前言\n\n**列A · 列B**\n- 1 · 2\n\n后记')
  assert.equal(W.mdForWecom('没有表格 | 只是竖线'), '没有表格 | 只是竖线')
  assert.equal(W.mdForWecom('| a | b | c | d |\n|-|-|-|-|\n| 甲 | 2 | 3 | 4 |'), '**a · b · c · d**\n- 甲 · b 2 · c 3 · d 4', '宽表每格带表头名,不然一串数字对不上列')
})

test('mdForWecom:HTML 标签只留文字(<font> 页脚 10-12 真机原样露出过)、<br> 转换行、标题改加粗行', () => {
  assert.equal(W.mdForWecom('答案\n<font color="comment">耗时 9 秒 · tokens ↑32.5k ↓44</font>'), '答案\n耗时 9 秒 · tokens ↑32.5k ↓44')
  assert.equal(W.mdForWecom('<b>粗</b> <i>斜</i> <span class="x">跨</span>一<br/>二'), '粗 斜 跨一\n二')
  assert.equal(W.mdForWecom('# 结论\n## **已加粗**\n正文 # 不是标题'), '**结论**\n**已加粗**\n正文 # 不是标题', '已加粗的标题不叠两层星号')
  assert.equal(W.mdForWecom('a < b 且 Map<string, number>'), 'a < b 且 Map<string, number>', '不是标签的尖括号不动')
})

test('mdForWecom:代码块去围栏、每行包成行内代码(等宽 + # * 不被当 markdown);含反引号的行用双反引号;空行保留', () => {
  const src = '看这段:\n```sh\n# install\nnpm i   # 注意\n\necho `x`\n```\n完'
  assert.equal(W.mdForWecom(src), '看这段:\n`# install`\n`npm i   # 注意`\n\n`` echo `x` ``\n完')
  assert.equal(W.mdForWecom('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```'), '`| a | b |`\n`|---|---|`\n`| 1 | 2 |`', '围栏内的竖线不是表格')
  assert.equal(W.mdForWecom('~~~\n<font>x</font>\n~~~'), '`<font>x</font>`', '围栏内的标签原样(那是代码)')
})

test('splitMarkdown:按字节上限在行边界切,单行超长硬切,每片都不超上限', () => {
  const lines = []
  for (let i = 0; i < 200; i++) lines.push(`第 ${i} 行,一些中文内容让字节数涨起来`)
  const text = lines.join('\n')
  const chunks = W.splitMarkdown(text, 2000)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(Buffer.byteLength(c) <= 2000, '超上限:' + Buffer.byteLength(c))
  assert.equal(chunks.join('\n'), text) // 无损
  const long = W.splitMarkdown('x'.repeat(5000), 2000)
  assert.deepEqual(long.map((c) => c.length), [2000, 2000, 1000])
  assert.deepEqual(W.splitMarkdown(''), [])
  // 代理对不能切断:emoji 正好卡在边界上也得整个挪到下一片
  const emo = W.splitMarkdown('a'.repeat(1997) + '😀😀', 2000)
  assert.equal(emo.length, 2); assert.equal(emo[0], 'a'.repeat(1997)); assert.equal(emo[1], '😀😀')
  for (const c of emo) assert.equal(Buffer.from(c, 'utf8').toString('utf8'), c, '每片都是合法 UTF-16')
})

// ── 媒体解密 ─────────────────────────────────────────────────────────────────────

test('decryptMedia:与 encryptMedia 严格互逆(AES-256-CBC · PKCS#7 填到 32 字节倍数 · IV = key 前 16 字节);解不出原样返回', () => {
  const key = Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '') // 43 字符
  const plain = Buffer.from('hello 企业微信 ' + 'z'.repeat(100))
  const enc = W.encryptMedia(plain, key)
  assert.equal(enc.length % 16, 0)
  assert.deepEqual(W.decryptMedia(enc, key), plain)
  assert.equal(W.decryptMedia(Buffer.from('odd'), key), null) // 长度不对 ⇒ 解不出
  const wrong = Buffer.alloc(32, 9).toString('base64').replace(/=+$/, '')
  assert.equal(W.decryptMedia(enc, wrong), null, '错 key 解出来的填充过不了校验')
  assert.equal(W.expandHome('~/.sbot/x'), require('node:path').join(os.homedir(), '.sbot/x')); assert.equal(W.expandHome('/abs'), '/abs')
})

test('sniffExt:按魔数认 png / jpg,认不出用原名扩展名,再不行 .bin', () => {
  assert.equal(W.sniffExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), 'x.dat'), '.png')
  assert.equal(W.sniffExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), null), '.jpg')
  assert.equal(W.sniffExt(Buffer.from('plain text here'), 'a.pdf'), '.pdf')
  assert.equal(W.sniffExt(Buffer.from('plain text here'), null), '.bin')
})

// ── 流式会话 ─────────────────────────────────────────────────────────────────────

function fakeClock() {
  let t = 1000
  const timers = []
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1) },
    advance(ms) { t += ms; for (const h of timers.splice(0)) { if (h.at <= t) h.fn(); else timers.push(h) } },
  }
}

test('流式会话:节流窗内只记最后一帧、窗到补发;finish 带最终全文 + 页脚', async () => {
  const clk = fakeClock()
  const sent = []
  const ses = W.createStreamSession({ send: async (b) => { sent.push(b); return { errcode: 0 } }, sendMarkdown: async () => 'ok', ...clk, throttleMs: 800 })
  ses.update('a'); ses.update('ab'); ses.update('abc')
  await flush()
  assert.equal(sent.length, 1, '首帧立即发')
  assert.equal(sent[0].stream.content, 'a'); assert.equal(sent[0].stream.finish, false)
  clk.advance(800)
  await flush()
  assert.equal(sent.length, 2); assert.equal(sent[1].stream.content, 'abc')
  assert.equal(sent[1].stream.id, sent[0].stream.id, '同一条流')
  assert.equal(await ses.finish('abc 完成', { footer: '12s · 300 tokens' }), 'ok')
  const last = sent[sent.length - 1]
  assert.equal(last.stream.finish, true)
  assert.equal(last.stream.content, 'abc 完成\n\n> 12s · 300 tokens', '页脚是引用行,不带企微不认的 <font>(10-12 真机原样露出过)')
  ses.update('after') // 收尾后不再发
  await flush()
  assert.equal(sent.length, 3)
})

test('流式会话:9 分钟到龄 ⇒ 把本段已发出的内容 finish 定格,另起新 stream.id 只续断点之后(「接上条」);收尾同理', async () => {
  const clk = fakeClock()
  const sent = []
  const ses = W.createStreamSession({ send: async (b) => { sent.push(b); return { errcode: 0 } }, sendMarkdown: async () => 'ok', ...clk, throttleMs: 0 })
  ses.update('第一段')
  clk.advance(9 * 60_000 + 1)
  ses.update('第一段第二段')
  await flush()
  assert.deepEqual(sent.map((b) => [b.stream.finish, b.stream.content]), [[false, '第一段'], [true, '第一段'], [false, '(接上条)第二段']], '定格的是已发出的内容,新段立刻续上')
  assert.notEqual(sent[2].stream.id, sent[0].stream.id, '新段新 id')
  await ses.finish('第一段第二段第三段')
  assert.equal(sent[3].stream.content, '(接上条)第二段第三段')
  assert.equal(sent[3].stream.id, sent[2].stream.id); assert.equal(sent[3].stream.finish, true)
  assert.equal(ses._state().segments, 2)
})

test('流式会话:收尾文本不以定格文本开头(引擎剥了里程碑行)⇒ 整段重发,不按错位的断点切', async () => {
  const clk = fakeClock()
  const sent = []
  const ses = W.createStreamSession({ send: async (b) => { sent.push(b); return { errcode: 0 } }, sendMarkdown: async () => 'ok', ...clk, throttleMs: 0 })
  ses.update('▶ 已读 3 个文件\n\n我先看一下代码。')
  clk.advance(9 * 60_000 + 1)
  ses.update('▶ 已读 3 个文件\n\n我先看一下代码。\n\n▶ 已改 2 个文件\n\n结论:第一点。')
  await flush()
  await ses.finish('我先看一下代码。\n\n结论:第一点。第二点。', { footer: '5m · 1k tokens' })
  const last = sent[sent.length - 1]
  assert.equal(last.stream.finish, true)
  assert.equal(last.stream.content, '我先看一下代码。\n\n结论:第一点。第二点。\n\n> 5m · 1k tokens', '最终答案完整,不丢「第二点」')
  assert.doesNotMatch(last.stream.content, /接上条/)
})

test('流式会话:分段后没有新内容的收尾不再发「(无内容)」;从没推过帧的空收尾才给一句交代', async () => {
  const clk = fakeClock()
  const sent = []
  const ses = W.createStreamSession({ send: async (b) => { sent.push(b); return { errcode: 0 } }, sendMarkdown: async () => 'ok', ...clk, throttleMs: 0 })
  ses.update('x'); clk.advance(9 * 60_000 + 1); ses.update('xy'); await flush()
  await ses.finish('xy')
  assert.deepEqual(sent.map((b) => [b.stream.finish, b.stream.content]), [[false, 'x'], [true, 'x'], [false, '(接上条)y'], [true, '(接上条)y']])
  const sent2 = []
  const ses2 = W.createStreamSession({ send: async (b) => { sent2.push(b); return { errcode: 0 } }, sendMarkdown: async () => 'ok', ...fakeClock() })
  await ses2.finish('')
  assert.deepEqual(sent2.map((b) => [b.stream.finish, b.stream.content]), [[true, '(无内容)']])
})

test('流式会话:中途帧超过单帧上限 ⇒ 按大小分段(定格已发的、新段续断点),单次就超长的只发能放下的前半当预览', async () => {
  const clk = fakeClock()
  const sent = []
  const ses = W.createStreamSession({ send: async (b) => { sent.push(b); return { errcode: 0 } }, sendMarkdown: async () => 'ok', ...clk, throttleMs: 0, maxBytes: 100 })
  ses.update('a'.repeat(60)); ses.update('a'.repeat(60) + 'b'.repeat(60)); await flush()
  assert.deepEqual(sent.map((b) => [b.stream.finish, Buffer.byteLength(b.stream.content) <= 100, b.stream.content.slice(0, 5)]), [[false, true, 'aaaaa'], [true, true, 'aaaaa'], [false, true, '(接上条)']])
  assert.equal(sent[2].stream.content, '(接上条)' + 'b'.repeat(60))
  const sent2 = []
  const ses2 = W.createStreamSession({ send: async (b) => { sent2.push(b); return { errcode: 0 } }, sendMarkdown: async () => 'ok', ...fakeClock(), throttleMs: 0, maxBytes: 100 })
  ses2.update('c'.repeat(500)); await flush()
  assert.equal(sent2.length, 1); assert.equal(sent2[0].stream.content.length, 100, '单次超长:预览截到上限')
})

test('流式会话:收尾正文超过单条上限 ⇒ 流里放第一片,其余走普通 markdown 续发', async () => {
  const clk = fakeClock()
  const sent = [], extra = []
  const ses = W.createStreamSession({ send: async (b) => { sent.push(b); return { errcode: 0 } }, sendMarkdown: async (c) => { extra.push(c); return 'ok' }, ...clk })
  const big = Array.from({ length: 1500 }, (_, i) => `行 ${i} 内容内容内容内容`).join('\n')
  assert.ok(Buffer.byteLength(big) > W.MD_SAFE_BYTES)
  assert.equal(await ses.finish(big), 'ok')
  assert.equal(sent.length, 1); assert.equal(sent[0].stream.finish, true)
  assert.ok(extra.length >= 1)
  assert.equal([sent[0].stream.content, ...extra].join('\n'), big)
})

test('流式会话:最终流帧拒绝或缺 ACK 时不能报告已送达', async () => {
  for (const bad of [{ errcode: 420, errmsg: 'rejected' }, null, {}]) {
    const ses = W.createStreamSession({ send: async body => body.stream.finish ? bad : { errcode: 0 },
      sendMarkdown: async () => 'ok', ...fakeClock(), log: () => {} })
    ses.update('处理中')
    await flush()
    assert.equal(await ses.finish('答案'), null)
  }
})

test('流式会话:普通 markdown 续片任一未确认则终结失败', async () => {
  const big = Array.from({ length: 1500 }, (_, i) => `行 ${i} 内容内容内容内容`).join('\n')
  for (const bad of [null, '', undefined]) {
    let continuations = 0
    const ses = W.createStreamSession({ send: async () => ({ errcode: 0 }),
      sendMarkdown: async () => { continuations++; return continuations === 1 ? bad : 'ok' },
      ...fakeClock(), log: () => {} })
    assert.equal(await ses.finish(big), null)
    assert.ok(continuations > 0)
  }
})

test('流式会话:前一段终帧失败时后续成功也不能确认完整答案', async () => {
  const clk = fakeClock()
  let firstId = null
  const ses = W.createStreamSession({ send: async body => {
    firstId ||= body.stream.id
    return body.stream.finish && body.stream.id === firstId ? { errcode: 420 } : { errcode: 0 }
  }, sendMarkdown: async () => 'ok', ...clk, throttleMs: 0, log: () => {} })
  ses.update('第一段')
  clk.advance(9 * 60_000 + 1)
  ses.update('第一段第二段')
  await flush()
  assert.equal(await ses.finish('第一段第二段第三段'), null)
})

// ── 协议层(假 WebSocket)────────────────────────────────────────────────────────

class FakeWs extends EventEmitter {
  constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; FakeWs.last = this; setImmediate(() => { this.readyState = 1; this.emit('open') }) }
  send(s) { this.sent.push(JSON.parse(s)) }
  terminate() { this.readyState = 3; this.emit('close', 1006, '') }
  close() { this.terminate() }
  // 服务端回包 / 推帧
  reply(reqId, extra = {}) { this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok', ...extra })) }
  push(frame) { this.emit('message', JSON.stringify(frame)) }
  lastCmd(cmd) { return [...this.sent].reverse().find((f) => f.cmd === cmd) }
}
function mkPlatform(extra = {}) {
  const logs = []
  const clk = fakeClock()
  const p = W.createWecomPlatform({ botId: 'B', secret: 'S', botName: 'SintBot', cli: false, WebSocket: FakeWs, log: (m) => logs.push(String(m)), ...clk, ...extra })
  return { p, logs, clk }
}

async function startAndSubscribe(p, onMessage = () => {}, hooks = {}) {
  await p.start(onMessage, hooks)
  await flush()
  const ws = FakeWs.last
  const sub = ws.lastCmd('aibot_subscribe')
  assert.deepEqual(sub.body, { bot_id: 'B', secret: 'S' })
  ws.reply(sub.headers.req_id)
  await flush()
  return ws
}

test('协议:连上即 subscribe,ack 0 ⇒ connected;群聊回调 ⇒ onMessage 带 chatId / 明文 userid / reqId;回复透传同一 req_id', async () => {
  const { p } = mkPlatform()
  const got = []
  const ws = await startAndSubscribe(p, (m) => got.push(m))
  assert.equal(p.connHealth().state, 'connected')
  ws.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'R1' }, body: { msgid: 'm1', chatid: 'wrG', chattype: 'group', from: { userid: 'WangWu' }, msgtype: 'text', create_time: 1791609000, text: { content: '@SintBot 查一下' } } })
  await flush(); await flush()
  assert.equal(got.length, 1)
  assert.equal(got[0].chatId, 'wrG'); assert.equal(got[0].userId, 'WangWu'); assert.equal(got[0].senderName, 'WangWu'); assert.equal(got[0].text, '查一下')
  assert.equal(got[0].replyCtx.reqId, 'R1')
  const pr = p.reply(got[0].replyCtx, '**好的**')
  await flush()
  const f = ws.lastCmd('aibot_respond_msg')
  assert.equal(f.headers.req_id, 'R1'); assert.equal(f.body.msgtype, 'markdown'); assert.equal(f.body.markdown.content, '**好的**')
  ws.reply('R1'); assert.equal(await pr, 'ok')
  await p.stop()
})

test('协议:主动推送带 chat_type(群 2 / 单聊 1,从入站学到);被拒 ⇒ 返回 null;没 req_id 的回复上下文走推送', async () => {
  const { p, logs } = mkPlatform()
  const ws = await startAndSubscribe(p)
  ws.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'R2' }, body: { msgid: 'm', chattype: 'single', from: { userid: 'U1' }, msgtype: 'text', text: { content: 'hi' } } })
  await flush(); await flush()
  const pr = p.send('U1', '推一条')
  await flush()
  let f = ws.lastCmd('aibot_send_msg')
  assert.equal(f.body.chat_type, 1); assert.equal(f.body.chatid, 'U1')
  ws.reply(f.headers.req_id); assert.equal(await pr, 'ok')
  const pr2 = p.send('wrNEW', 'x')
  await flush()
  f = ws.lastCmd('aibot_send_msg'); assert.equal(f.body.chat_type, 2, '没见过的 wr 开头按群')
  ws.reply(f.headers.req_id, { errcode: 40008, errmsg: 'invalid message type' })
  assert.equal(await pr2, null)
  assert.ok(logs.some((l) => /40008/.test(l)))
  const pr3 = p.reply({ chatId: 'wrNEW' }, '合成消息的回复')
  await flush()
  f = ws.lastCmd('aibot_send_msg'); assert.equal(f.body.markdown.content, '合成消息的回复')
  ws.reply(f.headers.req_id); await pr3
  await p.stop()
})

test('协议:表格转文本 + 超长切片在 send 这条路生效(多片依次发、逐片等 ack)', async () => {
  const { p } = mkPlatform()
  const ws = await startAndSubscribe(p)
  const big = '| a | b |\n|---|---|\n| 1 | 2 |\n' + 'x'.repeat(W.MD_SAFE_BYTES + 10)
  const pr = p.send('wrG', big)
  const replied = new Set()
  const contents = []
  for (let i = 0; i < 6; i++) { // 逐片回 ack,直到没有新帧
    await flush()
    const f = ws.sent.filter((x) => x.cmd === 'aibot_send_msg' && !replied.has(x.headers.req_id))
    if (!f.length) break
    for (const x of f) { replied.add(x.headers.req_id); contents.push(x.body.markdown.content); ws.reply(x.headers.req_id) }
  }
  assert.equal(await pr, 'ok')
  assert.equal(contents.length, 3, '表格一片 + 超长行硬切两片')
  assert.equal(contents[0], '**a · b**\n- 1 · 2')
  for (const c of contents) assert.ok(Buffer.byteLength(c) <= W.MD_SAFE_BYTES)
  await p.stop()
})

test('协议:回复和主动推送的前片被拒时，后片成功也不确认整条正文', async () => {
  const big = 'x'.repeat(W.MD_SAFE_BYTES + 10)
  for (const mode of ['reply', 'fallback', 'send']) {
    const { p } = mkPlatform()
    const ws = await startAndSubscribe(p)
    const cmd = mode === 'reply' ? 'aibot_respond_msg' : 'aibot_send_msg'
    const pending = mode === 'reply'
      ? p.reply({ chatId: 'wrG', reqId: 'R', reqAt: 1000 }, big)
      : mode === 'fallback' ? p.reply({ chatId: 'wrG' }, big) : p.send('wrG', big)
    for (let i = 0; i < 2; i++) {
      await flush()
      const frames = ws.sent.filter(frame => frame.cmd === cmd)
      assert.equal(frames.length, i + 1, `${mode}: each part waits for its ACK`)
      ws.reply(frames[i].headers.req_id, i === 0 ? { errcode: 40008, errmsg: 'rejected' } : {})
    }
    assert.equal(await pending, null, `${mode}: a later successful part cannot hide the rejection`)
    await p.stop()
  }
})

test('协议:错误回包不带 req_id 只记日志、不卡住任何等待者(对照:正常回包仍按 req_id 送达)', async () => {
  const { p, logs } = mkPlatform()
  const ws = await startAndSubscribe(p)
  const pr = p.send('wrG', '一条') // 先挂一个等待者
  await flush()
  ws.push({ errcode: 40058, errmsg: 'body.markdown.content exceed max length 20480' }) // 无 headers 的错误回包
  await flush()
  assert.ok(logs.some((l) => /40058/.test(l)))
  const f = ws.lastCmd('aibot_send_msg')
  ws.reply(f.headers.req_id) // 它自己的 ack 到了才 resolve
  assert.equal(await pr, 'ok')
  await p.stop()
})

test('协议:卡片按钮事件 ⇒ hooks.onCardAction;返回 {card} ⇒ 5s 内用原 task_id 更新卡片', async () => {
  const { p } = mkPlatform()
  const seen = []
  const ws = await startAndSubscribe(p, () => {}, { onCardAction: (e) => { seen.push(e); return { card: { title: '已处理', buttons: [{ text: '好', key: 'ok' }] } } } })
  ws.push({ cmd: 'aibot_event_callback', headers: { req_id: 'E1' }, body: { msgid: 'x', chatid: 'wrG', chattype: 'group', from: { userid: 'WangWu' }, msgtype: 'event', event: { eventtype: 'template_card_event', template_card_event: { card_type: 'button_interaction', event_key: 'ok', task_id: 'T9' } } } })
  await flush(); await flush()
  assert.equal(seen.length, 1); assert.equal(seen[0].action.value, 'ok'); assert.equal(seen[0].operator.userId, 'WangWu'); assert.equal(seen[0].chatId, 'wrG')
  const f = ws.lastCmd('aibot_respond_update_msg')
  assert.equal(f.headers.req_id, 'E1'); assert.equal(f.body.response_type, 'update_template_card')
  assert.equal(f.body.template_card.task_id, 'T9', '更新必须沿用原卡 task_id(换了 846625)')
  assert.equal(f.body.template_card.main_title.title, '已处理')
  await p.stop()
})

test('协议:sendCard 通用形状 ⇒ button_interaction;createStreamingCard 只对带 req_id 的消息给', async () => {
  const { p } = mkPlatform()
  const ws = await startAndSubscribe(p)
  const pr = p.sendCard('wrG', { title: '接管', desc: '点一下', buttons: [{ text: '开始', key: 'go', style: 1 }] })
  await flush()
  const f = ws.lastCmd('aibot_send_msg')
  assert.equal(f.body.msgtype, 'template_card'); assert.equal(f.body.template_card.card_type, 'button_interaction'); assert.equal(f.body.template_card.button_list[0].key, 'go')
  ws.reply(f.headers.req_id); const r = await pr; assert.ok(r && r.taskId)
  assert.equal(await p.createStreamingCard({ chatId: 'wrG' }), null)
  assert.ok(await p.createStreamingCard({ chatId: 'wrG', reqId: 'R', reqAt: p.connHealth().lastAckAt }))
  await p.stop()
})

test('协议:ping 回包刷判活;75s 没回包 ⇒ 心跳 tick 主动掐线 ⇒ 看门狗重建新连接并重新订阅', async () => {
  const { p, clk, logs } = mkPlatform()
  const ws1 = await startAndSubscribe(p)
  assert.equal(p.connHealth().subscribed, true)
  // 对照:回包及时时 tick 只发 ping、不掐线
  clk.advance(30_000); p._internal.pingTick(); await flush()
  const ping = ws1.lastCmd('ping'); assert.ok(ping, 'tick 发了 ping')
  ws1.reply(ping.headers.req_id); await flush()
  assert.equal(FakeWs.last, ws1, '有回包就不掐')
  // 服务端静默:再过 80s 没有任何回包
  clk.advance(80_000); p._internal.pingTick(); await flush(); await flush()
  assert.ok(logs.some((l) => /没有心跳回包/.test(l)), logs.join('\n'))
  const ws2 = FakeWs.last
  assert.notEqual(ws2, ws1, '掐线后看门狗立刻重建了一条新连接')
  const sub = ws2.lastCmd('aibot_subscribe'); assert.ok(sub)
  ws2.reply(sub.headers.req_id); await flush()
  assert.equal(p.connHealth().state, 'connected')
  await p.stop()
})

test('协议:入站媒体到手就落盘(解密 + 按魔数定扩展名),正文带本机路径标记;入站串行不乱序', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-inbox-'))
  const key = Buffer.alloc(32, 3).toString('base64').replace(/=+$/, '')
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)])
  const enc = W.encryptMedia(png, key)
  let delay = 30
  const fetchBuffer = (url) => new Promise((r) => setTimeout(() => r(enc), delay))
  const got = []
  const { p } = mkPlatform({ inboxDir: dir, fetchBuffer })
  const ws = await startAndSubscribe(p, (m) => got.push(m))
  ws.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'A' }, body: { msgid: 'img1', chattype: 'single', from: { userid: 'U' }, msgtype: 'image', image: { url: 'https://x/i', aeskey: key } } })
  ws.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'B' }, body: { msgid: 'txt2', chattype: 'single', from: { userid: 'U' }, msgtype: 'text', text: { content: '后到的文字' } } })
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(got.length, 2)
  assert.equal(got[0].msgId, 'img1', '先到的先进引擎,哪怕它要下载')
  const m = got[0].text.match(/^\[图片 path=(.+)\]$/)
  assert.ok(m, got[0].text)
  assert.ok(m[1].endsWith('.png'))
  assert.deepEqual(fs.readFileSync(m[1]), png)
  assert.equal(got[1].text, '后到的文字')
  // 另一个会话不被这个会话的下载拖住
  delay = 300
  ws.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'C' }, body: { msgid: 'img3', chattype: 'single', from: { userid: 'U' }, msgtype: 'image', image: { url: 'https://x/j', aeskey: key } } })
  ws.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'D' }, body: { msgid: 'txt4', chattype: 'group', chatid: 'wrOther', from: { userid: 'V' }, msgtype: 'text', text: { content: '@x 别的群' } } })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(got.length, 3); assert.equal(got[2].msgId, 'txt4', '别的会话先到先处理,不等 U 的下载')
  await new Promise((r) => setTimeout(r, 320))
  assert.equal(got.length, 4); assert.equal(got[3].msgId, 'img3')
  await p.stop()
})

test('协议:发送者姓名 — 手工映射优先;命令行工具搜到的首条即用并进缓存;ENOENT 后不再查', async () => {
  const calls = []
  const exec = (bin, args, opts, cb) => { calls.push(args); setImmediate(() => cb(null, JSON.stringify({ users: [{ userid: 'woA2x', name: '王五', matched_keywords: [args[4]] }] }))) }
  const got = []
  const { p } = mkPlatform({ cli: 'wecom-cli', exec, names: { Boss: '老板' } })
  const ws = await startAndSubscribe(p, (m) => got.push(m))
  const frame = (uid, rid) => ({ cmd: 'aibot_msg_callback', headers: { req_id: rid }, body: { msgid: rid, chattype: 'single', from: { userid: uid }, msgtype: 'text', text: { content: 'x' } } })
  ws.push(frame('Boss', 'r1')); ws.push(frame('WangWu', 'r2'))
  await flush(); await flush(); await flush()
  ws.push(frame('WangWu', 'r3'))
  await flush(); await flush()
  assert.deepEqual(got.map((m) => m.senderName), ['老板', '王五', '王五'], '手工映射优先;首条等搜人回来就是姓名')
  assert.equal(calls.length, 1, '同一人只查一次')
  await p.stop()
  // ENOENT:工具没装 ⇒ 之后一次都不再起子进程
  const calls2 = []
  const exec2 = (bin, args, opts, cb) => { calls2.push(1); setImmediate(() => cb(Object.assign(new Error('nf'), { code: 'ENOENT' }))) }
  const got2 = []
  const { p: p2, logs } = mkPlatform({ cli: 'wecom-cli', exec: exec2 })
  const ws2 = await startAndSubscribe(p2, (m) => got2.push(m))
  ws2.push(frame('A', 'q1')); await flush(); await flush(); ws2.push(frame('B', 'q2')); await flush(); await flush()
  assert.equal(calls2.length, 1); assert.ok(logs.some((l) => /未安装/.test(l)))
  await p2.stop()
})

test('协议:被另一条连接踢下线 ⇒ 记日志并在重连前让 60s', async () => {
  const { p, logs, clk } = mkPlatform()
  const ws = await startAndSubscribe(p)
  ws.push({ cmd: 'aibot_event_callback', headers: { req_id: 'D' }, body: { msgtype: 'event', event: { eventtype: 'disconnected_event' } } })
  await flush()
  assert.ok(logs.some((l) => /踢下线/.test(l)))
  ws.terminate(); await flush(); await flush()
  assert.equal(FakeWs.last, ws, '60s 内不重建')
  clk.advance(61_000)
  await flush(); await flush()
  assert.notEqual(FakeWs.last, ws, '让完 60s 才重建(对照:重连本身是通的)')
  await p.stop()
})

test('协议:首次见到某人等一次搜人(走注入时钟,最多 5s)—— 首条就显示姓名;超时先用账号、结果仍进缓存', async () => {
  // 搜人回包延迟由测试控制:cb 收进队列,手动触发
  const pending = []
  const exec = (bin, args, opts, cb) => { pending.push(() => cb(null, JSON.stringify({ users: [{ userid: 'woA2x', name: '王五', matched_keywords: [args[4]] }] }))) }
  const got = []
  const { p, clk } = mkPlatform({ cli: 'wecom-cli', exec })
  const ws = await startAndSubscribe(p, (m) => got.push(m))
  const frame = (uid, rid) => ({ cmd: 'aibot_msg_callback', headers: { req_id: rid }, body: { msgid: rid, chatid: 'wrGROUP1', chattype: 'group', from: { userid: uid }, msgtype: 'text', text: { content: '@SintBot x' } } })
  ws.push(frame('WangWu', 'r1')); await flush(); await flush()
  assert.equal(got.length, 0, '搜人没回来之前消息还没投递'); assert.equal(pending.length, 1)
  pending.shift()(); await flush(); await flush(); await flush()
  assert.equal(got.length, 1); assert.equal(got[0].senderName, '王五', '首条就是姓名')
  ws.push(frame('WangWu', 'r2')); await flush(); await flush()
  assert.equal(got[1].senderName, '王五'); assert.equal(pending.length, 0, '缓存命中不再搜')
  // 另一个人:搜人迟迟不回 ⇒ 5s 到点先用账号投递;之后回包进缓存,下一条用姓名
  ws.push(frame('Slow', 'r3')); await flush(); await flush()
  assert.equal(got.length, 2)
  clk.advance(5_001); await flush(); await flush(); await flush()
  assert.equal(got.length, 3); assert.equal(got[2].senderName, 'Slow', '超时先用账号')
  pending.shift()(); await flush(); await flush()
  ws.push(frame('Slow', 'r4')); await flush(); await flush()
  assert.equal(got[3].senderName, '王五', '迟到的结果进了缓存')
  await p.stop()
})

test('自描述:生图与接管入口已按平台分流 ⇒ features 里不再标 false', () => {
  const { p } = mkPlatform()
  assert.equal(p.features.imagen, true); assert.equal(p.features.takeoverCard, true)
  assert.equal(p.features.boards, false, '对照:画布仍没有')
})

test('协议:「不 @ 也回复」—— 有工具且 pollSec>0 才起轮询;轮询来的消息进 onMessage(无 req_id),回复走主动推送;@ 过的消息不重复;stop 停轮询', async () => {
  const calls = []
  // 历史里的时间也按假时钟造(基线之后的消息要比基线晚,字面量比较)
  let history = [{ userid: 'woA2u', user_name: '王五', send_time: '1970-01-01 08:00:00', msg_type: 'text', text: { content: '@SintBot start test' } }]
  const exec = (bin, args, opts, cb) => { calls.push(args.join(' ')); setImmediate(() => cb(null, JSON.stringify(/chat messages list/.test(args.join(' ')) ? { messages: history } : { users: [{ userid: 'woA2u', name: '王五', matched_keywords: [args[4]] }] }))) }
  const got = []
  const { p, logs, clk } = mkPlatform({ cli: 'wecom-cli', exec, pollSec: 20, followSec: 300, pollChats: () => ['wrGROUP1'] })
  const ws = await startAndSubscribe(p, (m) => got.push(m))
  assert.ok(logs.some((l) => /不 @ 也回复.*平时 20s.*@ 消息走长连接即时/.test(l)), '启动日志说清分档与两车道')
  // ⚠ 假时钟从 1000ms 起算,所有时间都按它造(轮询的跟进窗口、去重窗口都拿注入的 now 比)
  const { fmtBeijing } = require('../../src/platform/wecomcli')
  clk.advance(0); await flush(); await flush(); await flush() // 第一轮(timer 0):只建基线
  // 长连接来一条 @(真人 @)⇒ 引擎收到;随后轮询读到同一条 ⇒ 不重复
  const t2 = Math.floor(clk.now() / 1000)
  ws.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { msgid: 'r1', chatid: 'wrGROUP1', chattype: 'group', from: { userid: 'WangWu' }, msgtype: 'text', create_time: t2, text: { content: '@SintBot 现在几点' } } })
  await flush(); await flush(); await flush(); await flush()
  assert.equal(got.length, 1); assert.equal(got[0].replyCtx.reqId, 'r1')
  history = [...history, { userid: 'woA2u', user_name: '王五', send_time: fmtBeijing(new Date(t2 * 1000)), msg_type: 'text', text: { content: '@SintBot 现在几点' } }, { userid: 'woA2u', user_name: '王五', send_time: fmtBeijing(new Date(t2 * 1000 + 5000)), msg_type: 'text', text: { content: '那几分呢' } }]
  clk.advance(20_001); await flush(); await flush(); await flush(); await flush()
  assert.equal(got.length, 2, '@ 的那条长连接已投递不重复;跟进窗口内的「那几分呢」喂了')
  assert.equal(got[1].text, '那几分呢'); assert.equal(got[1].senderName, '王五'); assert.equal(got[1].replyCtx.reqId, undefined)
  // 回复它:没有 req_id ⇒ 走主动推送 aibot_send_msg(群)
  const pr = p.reply(got[1].replyCtx, '十六点零五')
  await flush()
  const sent = ws.lastCmd('aibot_send_msg'); assert.equal(sent.body.chatid, 'wrGROUP1'); assert.equal(sent.body.chat_type, 2); assert.match(sent.body.markdown.content, /十六点零五/)
  ws.reply(sent.headers.req_id); await pr
  assert.equal(await p.createStreamingCard(got[1].replyCtx), null, '轮询消息没有流式')
  await p.stop(); assert.equal(p._internal.poll(), null)
  // 对照:pollSec 0 / 没工具 ⇒ 不起
  const { p: p0, logs: l0 } = mkPlatform({ cli: 'wecom-cli', exec, pollSec: 0, pollChats: () => ['wrGROUP1'] })
  await startAndSubscribe(p0); assert.ok(!l0.some((l) => /不 @ 也回复/.test(l))); await p0.stop()
})

test('placePolledMedia:工具落盘的无扩展名文件 ⇒ 按内容嗅探扩展名搬进收件目录并删原件;已在目录里就原地改名;读不到原件抛', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-inbox-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-cli-out-'))
  const { p } = mkPlatform({ inboxDir: inbox })
  const place = p._internal.placePolledMedia
  // 外面的 PNG(文件名 msg_media 没扩展名)⇒ inbox/poll-x-1.png,原件删掉
  const src = path.join(outside, 'msg_media'); fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
  const dest = place({ path: src, name: null }, 'poll-20261010160020-abc-1', null)
  assert.equal(dest, path.join(inbox, 'poll-20261010160020-abc-1.png')); assert.ok(fs.existsSync(dest)); assert.ok(!fs.existsSync(src), '原件已删')
  assert.equal((fs.statSync(dest).mode & 0o777), 0o600)
  // 嗅不出的内容按原文件名的扩展名;base 里的怪字符洗掉
  const src2 = path.join(outside, 'msg_media'); fs.writeFileSync(src2, 'plain text')
  assert.equal(place({ path: src2, name: 'b.xlsx' }, 'poll/odd name', null), path.join(inbox, 'poll_odd_name.xlsx'))
  // 已在收件目录且名字就是目标 ⇒ 原地不动
  const same = path.join(inbox, 'keep.bin'); fs.writeFileSync(same, 'zz')
  assert.equal(place({ path: same, name: null }, 'keep', null), same); assert.ok(fs.existsSync(same))
  assert.throws(() => place({ path: path.join(outside, 'nope') }, 'x', null), /ENOENT/)
  assert.throws(() => place(null, 'x', null), /没有返回文件/)
  fs.rmSync(inbox, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true })
})

test('wecomAuthShow:两行纯文本解析 —— authorized + Bot ID;未授权;ENOENT 带 code;读不出就拒', async () => {
  const mk = (out, err) => (b, a, o, cb) => { assert.deepEqual(a, ['auth', 'show']); setImmediate(() => cb(err || null, out, '')) }
  assert.deepEqual(await W.wecomAuthShow({ cli: 'x', exec: mk('Status: authorized\nBot ID: aibDemo\n') }), { authorized: true, botId: 'aibDemo' })
  assert.deepEqual(await W.wecomAuthShow({ cli: 'x', exec: mk('Status: unauthorized\n') }), { authorized: false, botId: null })
  await assert.rejects(W.wecomAuthShow({ cli: 'x', exec: mk('', Object.assign(new Error('nf'), { code: 'ENOENT' })) }), (e) => e.code === 'ENOENT')
  await assert.rejects(W.wecomAuthShow({ cli: 'x', exec: mk('{"garbage":1}') }), /授权状态/)
})

test('长连接现学机器人名:配置没填时按群消息里唯一的 @ 学、剥 @ 立刻按它来;多个 @ 不学;配置填了且不一致 ⇒ 记一行日志、剥 @ 按群里的', async () => {
  const seen = []
  const { p, logs } = mkPlatform({ botName: undefined })
  await startAndSubscribe(p, (m) => seen.push(m))
  const frame = (content, extra = {}) => JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r' + seen.length }, body: { chattype: 'group', chatid: 'wrG', from: { userid: 'U1' }, msgid: 'm' + seen.length, create_time: 1700000000, msgtype: 'text', text: { content }, ...extra } })
  assert.equal(p.connHealth().botName, null)
  p._internal.handleFrame(frame('@张三 @SintBot 看看')); await flush(); await flush()
  assert.equal(p.connHealth().botNameLearned, null, '两个 @ 分不清是谁,不学'); assert.equal(seen[0].text, '@张三 @SintBot 看看'.replace(/^(\s*@\S+)+\s*/, '').trim() || seen[0].text)
  p._internal.handleFrame(frame('@SintBot 现在几点')); await flush(); await flush()
  assert.equal(p.connHealth().botNameLearned, 'SintBot'); assert.equal(p.connHealth().botName, 'SintBot'); assert.equal(seen[1].text, '现在几点', '学到就按它剥')
  p._internal.handleFrame(frame('帮我看看 @SintBot 这个')); await flush(); await flush(); assert.equal(seen[2].text, '帮我看看 这个', '任意位置都剥')
  await p.stop()
  // 配置填了错名:群里 @ 的不一样 ⇒ 日志一行,剥 @ 按配置(配置优先)—— 控制台刷新身份后才同步
  const q = mkPlatform({ botName: 'SintBot-Ops' }); const seen2 = []
  await startAndSubscribe(q.p, (m) => seen2.push(m))
  q.p._internal.handleFrame(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'x' }, body: { chattype: 'group', chatid: 'wrG', from: { userid: 'U1' }, msgid: 'mx', create_time: 1700000000, msgtype: 'text', text: { content: '@SintBot 几点' } } })); await flush(); await flush()
  assert.ok(q.logs.some((l) => /群里 @ 的名字是「SintBot」,与配置的「SintBot-Ops」不一致/.test(l)), q.logs.join('\n'))
  assert.equal(q.p.connHealth().botName, 'SintBot-Ops'); assert.equal(q.p.connHealth().botNameLearned, 'SintBot')
  await q.p.stop()
})

test('出站发送等订阅:连接刚起还没订阅成功时 send 不立刻失败,订阅成功瞬间放行;超时才回 null;stop 时排队的放弃', async () => {
  const { p, logs, clk } = mkPlatform()
  await p.start(() => {}); await flush() // 已 open、已发 subscribe,但还没 ack
  const ws = FakeWs.last; const sub = ws.lastCmd('aibot_subscribe')
  let done = null; const pr = p.send('wrG', '🚀 已升级').then((r) => { done = r; return r })
  await flush(); assert.equal(done, null); assert.equal(ws.lastCmd('aibot_send_msg'), undefined, '订阅前不发')
  ws.reply(sub.headers.req_id); await flush(); await flush()
  const sm = ws.lastCmd('aibot_send_msg'); assert.ok(sm, '订阅成功后立刻发出'); assert.match(sm.body.markdown.content, /已升级/)
  ws.reply(sm.headers.req_id); await pr; await flush()
  // 超时:新建一个一直不 ack 订阅的实例
  const q = mkPlatform(); await q.p.start(() => {}); await flush()
  let r2 = 'pending'; const pr2 = q.p.send('wrG', 'x').then((r) => { r2 = r })
  await flush(); assert.equal(r2, 'pending')
  q.clk.advance(31_000); await flush(); await pr2
  assert.equal(r2, null); assert.ok(q.logs.some((l) => /发送放弃:等了 30s/.test(l)), q.logs.join('\n'))
  // stop:排队的立刻放弃
  const z = mkPlatform(); await z.p.start(() => {}); await flush()
  let r3 = 'pending'; const pr3 = z.p.send('wrG', 'y').then((r) => { r3 = r }); await flush()
  await z.p.stop(); await pr3; assert.equal(r3, null)
  await p.stop(); await q.p.stop()
})

test('被踢:第一次 60s 后重连一次;10 分钟内第二次 ⇒ 停连、onIssue(kicked)、connHealth.halted;重启前不再连', async () => {
  const issues = []
  const { p, logs, clk } = mkPlatform({ onIssue: (e) => issues.push(e) })
  const ws1 = await startAndSubscribe(p)
  const kick = (ws) => { ws.emit('message', JSON.stringify({ cmd: 'aibot_event_callback', headers: { req_id: 'e' }, body: { chattype: 'single', from: { userid: 'U' }, event: { eventtype: 'disconnected_event' } } })) }
  kick(ws1); await flush()
  assert.ok(logs.some((l) => /60s 后再试一次/.test(l))); assert.equal(issues.length, 0); assert.equal(p.connHealth().halted, false)
  // 服务端随后关掉旧连接 ⇒ 看门狗重建,但要让 60s
  ws1.terminate(); await flush(); clk.advance(61_000); await flush(); await flush(); await flush()
  const ws2 = FakeWs.last; assert.notEqual(ws2, ws1, '60s 后重连了一次')
  const sub = ws2.lastCmd('aibot_subscribe'); if (sub) { ws2.reply(sub.headers.req_id); await flush() }
  clk.advance(2 * 60_000)
  kick(ws2); await flush(); await flush()
  assert.equal(issues.length, 1); assert.equal(issues[0].issue, 'kicked'); assert.equal(p.connHealth().halted, true)
  assert.ok(logs.some((l) => /第二次被另一条连接踢下线 —— 停止重连/.test(l)))
  const n = logs.length; clk.advance(5 * 60_000); await flush(); await flush()
  assert.equal(FakeWs.last, ws2, '停连后看门狗不再新建连接'); assert.ok(logs.slice(n).every((l) => !/已订阅/.test(l)))
  await p.stop()
})

test('姓名桥接:长连接消息与轮询历史对上时,把明文账号 ↔ 姓名记进缓存,下一条就显示姓名;密文账号形态只提醒一次', async () => {
  const seen = []; const calls = []
  let history = []
  const { p, logs, clk } = mkPlatform({ cli: 'fake-cli', pollSec: 1, pollChats: () => ['wrG'], exec: (b, a, o, cb) => { calls.push(a.join(' ')); setImmediate(() => cb(null, JSON.stringify({ messages: history }), '')) } })
  // 注意:cli 走 exec 注入;搜人(contact users search)也会经同一个 exec,返回空 ⇒ 名字先是账号
  await startAndSubscribe(p, (m) => seen.push(m))
  const frame = (userid, content, ts) => JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r' + seen.length }, body: { chattype: 'group', chatid: 'wrG', from: { userid }, msgid: 'm' + seen.length, create_time: ts, msgtype: 'text', text: { content } } })
  const T0 = Math.floor(clk.now() / 1000)
  p._internal.handleFrame(frame('WangWu', '@SintBot 现在几点', T0)); await flush(); await flush(); await flush()
  assert.equal(seen[0].senderName, 'WangWu', '第一条还不知道姓名(搜人没结果)')
  // 轮询第一轮建基线(空),第二轮历史里出现同一条:userid 密文 + user_name
  const lit = (ms) => { const d = new Date(ms); const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d); const g = Object.fromEntries(f.map((x) => [x.type, x.value])); return `${g.year}-${g.month}-${g.day} ${g.hour}:${g.minute}:${g.second}` }
  await p._internal.poll().tick(); // 基线
  history = [{ userid: 'woA2ENC', user_name: '王五', send_time: lit(T0 * 1000), msg_type: 'text', text: { content: '@SintBot 现在几点' } }]
  await p._internal.poll().tick()
  assert.ok(logs.some((l) => /从群历史对上成员姓名 WangWu → 王五/.test(l)), logs.join('\n'))
  assert.equal(seen.length, 1, '对上的那条不重复投递')
  p._internal.handleFrame(frame('WangWu', '@SintBot 再说一遍', T0 + 5)); await flush(); await flush()
  assert.equal(seen[1].senderName, '王五', '下一条直接显示姓名')
  // 密文账号形态提醒一次
  p._internal.handleFrame(frame('woDemoUser000000000000000000001', '@SintBot hi', T0 + 9)); await flush(); await flush()
  p._internal.handleFrame(frame('woDemoUser000000000000000000001', '@SintBot hi2', T0 + 10)); await flush(); await flush()
  assert.equal(logs.filter((l) => /密文形态/.test(l)).length, 1); assert.equal(p.connHealth().encryptedUserIds, true)
  await p.stop()
})

test('轮询撞到 850003(工具能力授权过期)⇒ onIssue(auth-expired) 10 分钟一次;其它错误只记日志', async () => {
  const issues = []
  let code = 850003
  const { p, logs, clk } = mkPlatform({ cli: 'fake-cli', pollSec: 1, pollChats: () => ['wrG'], onIssue: (e) => issues.push(e), exec: (b, a, o, cb) => setImmediate(() => cb(null, JSON.stringify({ error: { code, message: 'x', help_message: 'https://renew' } }), '')) })
  await startAndSubscribe(p)
  // 需要一个已绑群:pollChats 注入
  const poll = p._internal.poll(); assert.ok(poll)
  await poll.tick(); await poll.tick()
  assert.ok(issues.length >= 1 && issues.every((i) => i.issue === 'auth-expired'), JSON.stringify(issues)); assert.equal(issues.length, 1, '10 分钟内只报一次')
  assert.ok(logs.some((l) => /授权已过期/.test(l)))
  code = 40058; await poll.tick(); assert.equal(issues.length, 1)
  await p.stop()
})

// ── 两车道(v0.11.115):轮询来的消息走推送时开头引用原话(只引一次);@ 的回复路不引 ──────────────
test('协议:replyCtx.quote 的推送回复开头加一行「> 回复 某某:原话」,同一条消息只引一次;有 req_id 的回复路不引', async () => {
  const { p, clk } = mkPlatform()
  const ws = await startAndSubscribe(p)
  const ctx = { chatId: 'wrG', chatType: 'group', quote: { sender: '王五', text: '那个  报表再发一份' } }
  const pr0 = p.reply(ctx, '⏳ 模型已切换')
  await flush()
  let f = ws.lastCmd('aibot_send_msg')
  assert.equal(f.body.markdown.content, '⏳ 模型已切换', '没标 final 的系统短句不配引用')
  ws.reply(f.headers.req_id); await pr0
  const pr = p.reply(ctx, '好的,已发', { final: true })
  await flush()
  f = ws.lastCmd('aibot_send_msg')
  assert.equal(f.body.markdown.content, '> 回复 王五:那个 报表再发一份\n\n好的,已发', '最终回答:引用行 + 空行 + 正文;原话里的多余空白归一')
  ws.reply(f.headers.req_id); await pr
  const pr2 = p.reply(ctx, '补一句', { final: true })
  await flush()
  f = ws.lastCmd('aibot_send_msg'); assert.equal(f.body.markdown.content, '补一句', '同一条消息只引一次')
  ws.reply(f.headers.req_id); await pr2
  // 攒批:末条之前还有几条、几个人在说,引用行要说出来 —— 群里才看得出这一条回了好几句
  const pr4 = p.reply({ chatId: 'wrG', chatType: 'group', quote: { sender: '甲', text: '那个报表再发一份', more: 2, senders: 2 } }, '发了', { final: true })
  await flush()
  f = ws.lastCmd('aibot_send_msg'); assert.equal(f.body.markdown.content, '> 回复 甲 等 2 人:那个报表再发一份(连同前 2 条)\n\n发了')
  ws.reply(f.headers.req_id); await pr4
  // 对照:有 req_id(长连接 @ 来的)走回复路,quote 即便带着也不引 —— 平台回复本就自动引用触发消息
  ws.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'R9' }, body: { msgid: 'm9', chatid: 'wrG', chattype: 'group', from: { userid: 'U' }, msgtype: 'text', create_time: 1791609000, text: { content: '@SintBot 看看' } } })
  await flush(); await flush()
  const pr3 = p.reply({ chatId: 'wrG', chatType: 'group', reqId: 'R9', reqAt: clk.now(), quote: { sender: 'U', text: '看看' } }, '看了', { final: true })
  await flush()
  f = ws.lastCmd('aibot_respond_msg'); assert.equal(f.body.markdown.content, '看了')
  ws.reply('R9'); await pr3
  await p.stop()
})

