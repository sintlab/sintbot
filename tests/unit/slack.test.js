// Slack 适配器的纯逻辑 —— 入站文本展开、事件门禁(含三条自我回环防护)、去重表、
// 年龄闸门、出站 payload、以及 Web API 封装的错误/限流处置。
// Socket Mode 那条链路要真凭据 ⇒ 不在这里,交 docs/slack-probe.js(SLACK.md「进度表达」)。
// 对照的实测口径全部在 docs/SLACK.md,注释里的 §x 指它。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  parseText, restoreCommand, localizeCommands, attachmentMarks, shouldHandle, createDedupe, isStale, messagePayload, plainFallback,
  classifyError, createSlackApi, SlackError, MD_LIMIT,
} = require('../../src/platform/slack')

// ── 入站文本(SLACK.md「收消息」)────────────────────────────────────────────────────────────────

test('parseText: 剥掉 @bot、展开人/频道/链接记号', () => {
  const t = parseText('<@UBOT> 看下 <#C123|dev> 里 <@U456> 说的 <https://x.dev/a|这篇> 和 <https://y.dev>', { botUserId: 'UBOT' })
  assert.equal(t, '看下 #dev 里 @U456 说的 [这篇](https://x.dev/a) 和 https://y.dev')
})

test('parseText: 实体解码顺序 —— 先 lt/gt 后 amp,否则 &amp;lt; 会被误解成 <', () => {
  assert.equal(parseText('a &lt; b &amp;&amp; c &gt; d'), 'a < b && c > d')
  assert.equal(parseText('用户真的打了 &amp;lt;'), '用户真的打了 &lt;')
})

test('parseText: ⚠ 换行与代码块必须原样保留(绝不抄 cc-bot 的 sanitize)', () => {
  // 那个 .replace(/[\r\n]/g,' ') 会把喂给 agent 的多行 prompt 毁掉 —— SLACK.md「收消息」 明确列为"搬时必改"
  const src = '帮我改这段:\n```js\nconst a = 1\nconst b = 2\n```\n谢谢'
  assert.equal(parseText(src), src)
  assert.equal(parseText(src).split('\n').length, 6)
})

test('parseText: @here / @channel 与用户组记号', () => {
  assert.equal(parseText('<!here> 注意 <!subteam^S01|@ops>'), '@here 注意 @ops')
})

test('attachmentMarks: 图片/文件转成带 file_id 的标记,agent 顺着它自己去取', () => {
  // ⚠ 不做这层的话,"只发一张图 + 一句话"里的图会被静默丢掉,agent 无从知道有图(飞书 v0.11.7)
  const marks = attachmentMarks([
    { id: 'F1', name: '名单.png', mimetype: 'image/png' },
    { id: 'F2', name: 'build.log', mimetype: 'text/plain' },
    { name: '没有 id 的不算' },
  ])
  assert.deepEqual(marks, ['[图片 名单.png file_id=F1]', '[文件 build.log file_id=F2]'])
  assert.deepEqual(attachmentMarks(undefined), [])
})

test('restoreCommand: `!stop` 还原成 `/stop`,普通感叹号原样放行', () => {
  // ⚠ Slack 把 `/` 开头的输入当自己的斜杠命令吃掉(真机验过)—— 群内控制面只能换前缀进来
  const opt = { commands: ['/stop', '/status', '/new'] }
  assert.equal(restoreCommand('!stop', opt), '/stop')
  assert.equal(restoreCommand('!status 现在怎么样', opt), '/status 现在怎么样')
  assert.equal(restoreCommand('!STOP', opt), '/stop', '识别了就得让它真生效 —— 引擎的 switch 大小写敏感')
  assert.equal(restoreCommand('!Status 看看', opt), '/status 看看', '命令词归一,参数原样')
  // 只还原清单里真有的 —— 否则一句普通话会被引擎回「未知命令」
  assert.equal(restoreCommand('!这个很重要', opt), '!这个很重要')
  assert.equal(restoreCommand('!deploy 上线', opt), '!deploy 上线')
  assert.equal(restoreCommand('stop', opt), 'stop')
  assert.equal(restoreCommand('!stop', { commands: [] }), '!stop', '没注入清单就一律不改写')
})

test('localizeCommands: 引擎文案里的 `/stop` 出站换成 `!stop`,但代码块与路径不动', () => {
  // ⚠ 真机撞见(2026-09-01):v0.11.60 的换模型提示原文是「发『/model 名字』」——
  //   在 Slack 里照做发不出去,群成员试一次不灵就会认为 bot 坏了
  const opt = { commands: ['/model', '/stop', '/status'] }
  assert.equal(localizeCommands('换模型:发「/model 名字」,忙的话先 /stop', opt), '换模型:发「!model 名字」,忙的话先 !stop')
  assert.equal(localizeCommands('文件在 /Users/x/status 里', opt), '文件在 /Users/x/status 里', '路径不是命令')
  assert.equal(localizeCommands('接口 `/status` 返回 200', opt), '接口 `/status` 返回 200', '行内代码整段跳过')
  assert.equal(localizeCommands('```\nGET /status\n```', opt), '```\nGET /status\n```', '代码块整段跳过')
  assert.equal(localizeCommands('/stop', { commands: [], alias: '!' }), '/stop', '没清单就不改写')
  assert.equal(localizeCommands('/stop', { commands: ['/stop'], alias: '/' }), '/stop', '前缀就是 / 时不改写')
})

test('reply 走本地化,而卡片收尾(agent 的答案)不走 —— 答案里的 /status 可能真是路由', async () => {
  const sent = []
  const fetchImpl = async (url, opts) => {
    const b = Object.fromEntries(new URLSearchParams(opts.body))
    sent.push({ m: url.split('/api/')[1], text: b.blocks ? JSON.parse(b.blocks)[0].text : null })
    return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: String(sent.length) + '.0', agent_status: b.status }) }
  }
  const { createSlackPlatform } = require('../../src/platform/slack')
  const plat = createSlackPlatform({ botToken: 'xoxb-t', appToken: 'xapp-t', fetchImpl, commands: ['/stop', '/status'], card: { throttleMs: 1 } })
  await plat.reply({ channel: 'C1' }, '忙的话先发 /stop')
  const card = await plat.createStreamingCard({ channel: 'C1', ts: '1.1', threadTs: '1.1' })
  await card.finish('这个服务的健康检查在 /status,返回 200')
  const posts = sent.filter((x) => x.m === 'chat.postMessage' && x.text)
  assert.equal(posts[0].text, '忙的话先发 !stop', '引擎自己的话:改')
  assert.equal(posts[posts.length - 1].text, '这个服务的健康检查在 /status,返回 200', 'agent 的答案:一个字都不许动')
})

// ── 事件门禁(SLACK.md「收消息」 自我回环防护 + SLACK.md「收消息」 subtype 守卫)──────────────────────────

const MSG = { type: 'message', channel: 'C1', user: 'U1', ts: '1.1', text: 'hi' }

test('shouldHandle: 普通群消息放行', () => {
  assert.equal(shouldHandle(MSG, { botUserId: 'UBOT' }), 'handle')
})

test('shouldHandle: ⚠ 回环三防 —— bot_id / 自己 / message_changed 一律丢', () => {
  // ① bot 判定看 bot_id 在不在,不能用 subtype==='bot_message'(那是 classic app)
  assert.equal(shouldHandle({ ...MSG, bot_id: 'B9' }, { botUserId: 'UBOT' }), 'bot-message')
  assert.equal(shouldHandle({ ...MSG, user: 'UBOT' }, { botUserId: 'UBOT' }), 'self')
  // ② chat.update 会把 message_changed 打回给自己:30 分钟任务按 3 秒节流 = 600 条回声
  assert.equal(shouldHandle({ ...MSG, subtype: 'message_changed' }, { botUserId: 'UBOT' }), 'echo-changed')
})

test('shouldHandle: file_share 放行、其它 subtype 丢弃', () => {
  // cc-bot 踩过"带图消息被 subtype 一刀切掉"—— images 那条链路全靠这个放行(SLACK.md「收消息」)
  assert.equal(shouldHandle({ ...MSG, subtype: 'file_share' }, { botUserId: 'UBOT' }), 'handle')
  assert.equal(shouldHandle({ ...MSG, subtype: 'channel_join' }, { botUserId: 'UBOT' }), 'subtype:channel_join')
})

test('shouldHandle: 删除消息走 recall,且用 deleted_ts 不是 ts', () => {
  const del = { type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '9.9', deleted_ts: '1.1' }
  assert.equal(shouldHandle(del, { botUserId: 'UBOT' }), 'recall')
  // ⚠ 自己 chat.delete 也会触发同一个事件 —— 不滤掉就是"撤回即停"自杀(SLACK.md「收消息」)
  assert.equal(shouldHandle(del, { botUserId: 'UBOT', ownTs: new Set(['1.1']) }), 'own-delete')
  assert.equal(shouldHandle({ ...del, deleted_ts: undefined }, {}), 'deleted-no-ts')
})

test('shouldHandle: @ 门禁只管公开频道,DM 永远放行', () => {
  const gate = { botUserId: 'UBOT', onlyWhenMentioned: true }
  assert.equal(shouldHandle(MSG, gate), 'not-mentioned')
  assert.equal(shouldHandle({ ...MSG, text: '<@UBOT> 跑一下' }, gate), 'handle')
  assert.equal(shouldHandle({ ...MSG, channel_type: 'im' }, gate), 'handle')
})

// ── 与引擎的接线面 ───────────────────────────────────────────────────────────────

test('reply 必须认合成消息的 replyCtx.chatId —— 否则定时任务/插话在 Slack 群里静默不回', async () => {
  const { createSlackPlatform } = require('../../src/platform/slack')
  const sent = []
  const fetchImpl = async (url, opts) => {
    const body = Object.fromEntries(new URLSearchParams(opts.body))
    sent.push({ method: url.split('/api/')[1], body })
    return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: '9.9' }) }
  }
  const plat = createSlackPlatform({ botToken: 'xoxb-t', appToken: 'xapp-t', fetchImpl })
  await plat.reply({ chatId: 'C1' }, 'cron 来的')          // 合成消息的写法
  await plat.reply({ channel: 'C2', threadTs: '1.1' }, '真人消息的写法')
  assert.equal(sent[0].body.channel, 'C1')
  assert.equal(sent[1].body.channel, 'C2')
  assert.equal(sent[1].body.thread_ts, '1.1')
})

// ── 去重与年龄闸门(SLACK.md「可靠性」 / SLACK.md「可靠性」)──────────────────────────────────────────

test('createDedupe: 同一个 event_id 只认第一次,过期后重新可见', () => {
  let t = 1000
  const d = createDedupe({ ttlMs: 500, now: () => t })
  assert.equal(d.take('Ev1'), true)
  assert.equal(d.take('Ev1'), false, 'Socket Mode 的重投没有任何标记字段,只能靠它挡')
  t += 600
  assert.equal(d.take('Ev1'), true)
})

test('createDedupe: 没有 id 时宁可重复也不丢;表满按插入序淘汰最旧', () => {
  const d = createDedupe({ max: 3, now: () => 1 })
  assert.equal(d.take(''), true)
  for (const id of ['a', 'b', 'c', 'd']) d.take(id)
  assert.ok(d.size() <= 3)
  assert.equal(d.take('a'), true, '最旧的已被淘汰 ⇒ 重新可见')
  assert.equal(d.take('d'), false, '最新的还在表里')
})

test('isStale: Delayed Events 补投的老消息必须挡在引擎之外', () => {
  const now = () => 1_000_000_000_000
  const secs = (mins) => (now() - mins * 60_000) / 1000
  assert.equal(isStale(secs(5), { now }), false)
  assert.equal(isStale(secs(20), { now }), true, '开了 Delayed Events 会补投 24 小时内的事件')
  assert.equal(isStale(undefined, { now }), false, '没时间戳就别猜')
})

// ── 出站 payload(SLACK.md「进度表达」 移动端推送 / SLACK.md「收消息」 unfurl / SLACK.md「富文本」 上限)────────────────────

test('messagePayload: markdown 走 blocks、顶层 text 永远在 + 关掉 unfurl', () => {
  const p = messagePayload('C1', '**粗体**\n- 一项', { threadTs: '1.1' })
  // ⚠ 不能用 markdown_text —— 它与顶层 text 互斥(真机:markdown_text_conflict),
  //   而 blocks + text 可以共存(实测发得出、渲染正确)
  assert.deepEqual(p.blocks, [{ type: 'markdown', text: '**粗体**\n- 一项' }])
  assert.equal('markdown_text' in p, false)
  assert.ok(p.text, '⚠ 移动端推送只读 message.text —— 空的话"跑完推我一下"就废了')
  assert.equal(p.unfurl_links, false, '⚠ unfurl 是 prompt injection 的数据外泄通道')
  assert.equal(p.unfurl_media, false)
  assert.equal(p.thread_ts, '1.1')
  assert.equal(messagePayload('C1', 'x').thread_ts, undefined)
  const upd = messagePayload('C1', 'x', { ts: '2.2' })
  assert.equal(upd.ts, '2.2')
  assert.equal('unfurl_links' in upd, false, 'chat.update 不收 unfurl 参数,别给参数错误添触发点')
})

test('messagePayload: 超上限自己截断并标注,不交给 Slack 静默吃掉', () => {
  const p = messagePayload('C1', 'a'.repeat(MD_LIMIT + 500))
  assert.ok(p.blocks[0].text.length <= MD_LIMIT)
  assert.match(p.blocks[0].text, /已截断/)
})

test('plainFallback: 推送预览压成单行,代码块折成一个词', () => {
  const s = plainFallback('# 标题\n\n```js\nconst a=1\n```\n- 第一项\n- 第二项')
  assert.equal(s.includes('\n'), false)
  assert.ok(s.includes('[代码]'))
  assert.ok(s.startsWith('标题'))
  assert.ok(plainFallback('x'.repeat(1000)).length <= 300)
})

// ── 错误分类与 API 封装(SLACK.md「可靠性」)────────────────────────────────────────────────────

test('classifyError: 四类处置各就各位', () => {
  assert.equal(classifyError('token_revoked'), 'fatal')        // 停止一切重试并告警
  assert.equal(classifyError('edit_window_closed'), 'degrade') // 改发新消息,切换指针
  assert.equal(classifyError('ratelimited'), 'retryable')
  assert.equal(classifyError('not_in_channel'), 'channel')     // 从路由表摘掉该群
  assert.equal(classifyError('msg_too_long'), 'content')
  assert.equal(classifyError('something_new'), 'other')
})

function mockFetch(responses) {
  const calls = []
  const q = [...responses]
  const f = async (url, opts) => {
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(opts.body)), auth: opts.headers.Authorization, ctype: opts.headers['Content-Type'] })
    const r = q.shift()
    if (!r) throw new Error('mock fetch: 调用次数超出预设')
    if (r.throw) throw new Error(r.throw)
    return {
      status: r.status || 200,
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] || null },
      json: async () => r.json,
    }
  }
  return { f, calls }
}

test('createSlackApi: ⚠⚠ 出站必须 form 编码 —— JSON body 会被读类方法静默忽略', async () => {
  // 2026-09-01 真机:users.list {limit:2} 走 JSON 返回 8 个人且 ok:true(参数被吞),
  // users.info 走 JSON 报 user_not_found(不是没这个人,是参数没被读到)。
  const { f, calls } = mockFetch([{ json: { ok: true, ts: '1.1' } }])
  const call = createSlackApi('xoxb-t', { fetchImpl: f })
  await call('chat.postMessage', messagePayload('C1', '**粗体**'))
  assert.equal(calls[0].ctype, 'application/x-www-form-urlencoded', '⚠ 别带 charset —— 会招来 superfluous_charset warning,把真警告淹掉')
  assert.equal(calls[0].body.channel, 'C1')
  assert.equal(JSON.parse(calls[0].body.blocks)[0].type, 'markdown', '嵌套值按 form 约定序列化成 JSON 字符串')
  assert.ok(calls[0].body.text, '顶层 text 一起发出去(移动端推送读它)')
})

test('createSlackApi: ⚠ ok:false 必须抛 —— 不抛就是 v0.11.48 那次事故的形状', async () => {
  const { f } = mockFetch([{ json: { ok: false, error: 'not_in_channel' } }])
  const call = createSlackApi('xoxb-t', { fetchImpl: f })
  await assert.rejects(() => call('chat.postMessage', { channel: 'C1' }), (e) => {
    assert.ok(e instanceof SlackError)
    assert.equal(e.code, 'not_in_channel')
    assert.equal(e.kind, 'channel')
    return true
  })
})

test('createSlackApi: 业务错误只抛一次,不进重试循环', async () => {
  const { f, calls } = mockFetch([{ json: { ok: false, error: 'channel_not_found' } }])
  const call = createSlackApi('xoxb-t', { fetchImpl: f })
  await assert.rejects(() => call('chat.postMessage', {}, { retries: 3 }))
  assert.equal(calls.length, 1, '重试也不会变对,重试只会浪费配额')
})

test('createSlackApi: 429 按 Retry-After 等一次再发,不硬顶', async () => {
  const waits = []
  const { f, calls } = mockFetch([
    { status: 429, headers: { 'retry-after': '2' }, json: {} },
    { json: { ok: true, ts: '1.1' } },
  ])
  const call = createSlackApi('xoxb-t', { fetchImpl: f, sleepImpl: async (ms) => { waits.push(ms) } })
  const r = await call('chat.postMessage', { channel: 'C1' })
  assert.equal(r.ts, '1.1')
  assert.deepEqual(waits, [2000], '⚠ 超限后硬发,官方警告 app 有被永久停用的风险')
  assert.equal(calls.length, 2)
})

test('createSlackApi: 重试预算有界 —— 绝不是 SDK 默认的「10 次 / 30 分钟」', async () => {
  const waits = []
  const { f } = mockFetch(Array.from({ length: 6 }, () => ({ status: 429, headers: { 'retry-after': '30' }, json: {} })))
  const call = createSlackApi('xoxb-t', { fetchImpl: f, sleepImpl: async (ms) => { waits.push(ms) }, retryCapMs: 10_000 })
  await assert.rejects(() => call('chat.update', {}), (e) => e.code === 'ratelimited')
  const total = waits.reduce((a, b) => a + b, 0)
  assert.ok(total <= 10_000, `总等待 ${total}ms 必须落在预算内 —— 进度更新卡在重试队列里就是冻住`)
})

test('createSlackApi: 5xx 退避重试后成功;warning 一律上报', async () => {
  const logs = []
  const { f, calls } = mockFetch([
    { status: 503, json: {} },
    { json: { ok: true, ts: '1.1', response_metadata: { warnings: ['message_truncated'] } } },
  ])
  const call = createSlackApi('xoxb-t', { fetchImpl: f, sleepImpl: async () => {}, log: (m) => logs.push(m) })
  await call('chat.postMessage', {})
  assert.equal(calls.length, 2)
  // SLACK.md「静默失败」:那张静默失败表里近一半只在 warning 字段里露头,不看就等于没发生
  assert.ok(logs.some((l) => l.includes('warning') && l.includes('message_truncated')))
})

test('createSlackApi: app-level token 走 tokenOverride(apps.connections.open 专用)', async () => {
  const { f, calls } = mockFetch([{ json: { ok: true, url: 'wss://x' } }])
  const call = createSlackApi('xoxb-bot', { fetchImpl: f })
  await call('apps.connections.open', {}, { tokenOverride: 'xapp-a' })
  assert.equal(calls[0].auth, 'Bearer xapp-a', '⚠ 必须放 header —— 做 POST 参数会报错(实测)')
  assert.match(calls[0].ctype, /x-www-form-urlencoded/)
})

test('createSlackApi: 网络错误重试到头后归一成 request_timeout', async () => {
  const { f, calls } = mockFetch([{ throw: 'ECONNRESET' }, { throw: 'ECONNRESET' }])
  const call = createSlackApi('xoxb-t', { fetchImpl: f, sleepImpl: async () => {} })
  await assert.rejects(() => call('auth.test', {}, { retries: 1 }), (e) => e.code === 'request_timeout' && e.kind === 'retryable')
  assert.equal(calls.length, 2)
})

// ── 控制台助手(「Slack 应用」卡与绑群下拉的数据源)──────────────────────────────

function mockJson(map) {
  // map: method -> { json, scopes? }
  return async (url, opts) => {
    const m = url.split('/api/')[1]
    const hit = typeof map[m] === 'function' ? map[m](Object.fromEntries(new URLSearchParams(opts.body))) : map[m]
    if (!hit) throw new Error('mock 未预设: ' + m)
    return { status: 200, headers: { get: (k) => (k.toLowerCase() === 'x-oauth-scopes' ? hit.scopes || '' : null) }, json: async () => hit.json }
  }
}

test('slackPrecheck: 缺必需 scope 要报 fail,并说清「改完要重装才生效」', async () => {
  const { slackPrecheck } = require('../../src/platform/slack')
  const fetchImpl = mockJson({
    'auth.test': { json: { ok: true, user: 'sintbot', user_id: 'U1', team: 'Acme', team_id: 'T1' }, scopes: 'chat:write,channels:read' },
    'apps.connections.open': { json: { ok: true, url: 'wss://x' } },
    'users.conversations': { json: { ok: true, channels: [] } },
  })
  const r = await slackPrecheck('xoxb-t', 'xapp-t', { fetchImpl })
  const byKey = Object.fromEntries(r.checks.map((c) => [c.key, c]))
  assert.equal(byKey.scopes.status, 'fail')
  assert.match(byKey.scopes.detail, /channels:history/)
  assert.match(byKey.scopes.detail, /重新安装/, '缺 scope 最贵的地方是改完不重装 = 事件静默不来')
  assert.equal(byKey.socket.status, 'ok')
  // 一个频道都没加入 ⇒ 收不到任何消息,必须当场说出下一步
  assert.equal(byKey.channels.status, 'warn')
  assert.match(byKey.channels.detail, /invite/)
})

test('slackPrecheck: 凭据不对就地收工,不再拿坏 token 去撞后面几条', async () => {
  const { slackPrecheck } = require('../../src/platform/slack')
  const fetchImpl = mockJson({ 'auth.test': { json: { ok: false, error: 'invalid_auth' } } })
  const r = await slackPrecheck('xoxb-bad', 'xapp-t', { fetchImpl })
  assert.equal(r.checks.length, 1)
  assert.equal(r.checks[0].status, 'fail')
  assert.match(r.checks[0].detail, /重新安装/)
})

test('slackHint: 错误码翻成「哪里不对 + 怎么修」,末尾留原始码;认不出的原样给码', () => {
  const { slackHint, SlackError } = require('../../src/platform/slack')
  assert.match(slackHint(new SlackError('invalid_auth', 'auth.test')), /无效或已撤销.*重新安装.*\[invalid_auth\]/)
  assert.match(slackHint(new SlackError('token_revoked', 'auth.test')), /重新安装/)
  const scope = slackHint(new SlackError('missing_scope', 'users.conversations', { needed: 'groups:read' }))
  assert.match(scope, /缺权限 groups:read/)
  assert.match(scope, /重新安装/, '改了权限不重装 = 照样缺')
  assert.match(slackHint(new SlackError('missing_scope', 'x')), /^缺权限 —— /, '没带 needed 也要读得通')
  assert.match(slackHint(new SlackError('request_timeout', 'x', { cause: 'fetch failed' })), /代理.*\[fetch failed\]/)
  assert.match(slackHint(new SlackError('ratelimited', 'x')), /限流/)
  assert.equal(slackHint(new SlackError('weird_new_code', 'x')), 'weird_new_code')
  assert.equal(slackHint(new Error('boom')), 'boom')
})

test('slackPrecheck: 频道列表拉不到时,warn 行给的是可操作的话而不是裸错误码', async () => {
  const { slackPrecheck } = require('../../src/platform/slack')
  const fetchImpl = mockJson({
    'auth.test': { json: { ok: true, user: 'sintbot', user_id: 'U1', team: 'Acme', team_id: 'T1' }, scopes: 'chat:write,channels:history,channels:read,app_mentions:read' },
    'apps.connections.open': { json: { ok: true, url: 'wss://x' } },
    'users.conversations': { json: { ok: false, error: 'missing_scope', needed: 'groups:read' } },
  })
  const r = await slackPrecheck('xoxb-t', 'xapp-t', { fetchImpl })
  const ch = r.checks.find((c) => c.key === 'channels')
  assert.equal(ch.status, 'warn')
  assert.match(ch.detail, /缺权限 groups:read.*重新安装/)
})

test('fetchSlackChannels: 走 cursor 分页,且只列频道不列 DM', async () => {
  const { fetchSlackChannels } = require('../../src/platform/slack')
  const seen = []
  const fetchImpl = mockJson({
    'users.conversations': (body) => {
      seen.push(body)
      return body.cursor
        ? { json: { ok: true, channels: [{ id: 'C2', name: 'ops', is_private: true }] } }
        : { json: { ok: true, channels: [{ id: 'C1', name: 'dev', num_members: 3 }], response_metadata: { next_cursor: 'NEXT' } } }
    },
  })
  const list = await fetchSlackChannels('xoxb-t', { fetchImpl })
  assert.deepEqual(list.map((c) => c.id), ['C1', 'C2'])
  assert.equal(list[1].isPrivate, true)
  // ⚠ 这两条都是「不写就静默失效」:types 不给全 = 私有频道整体缺席;
  //   不走 cursor = 某页回得少但还有下一页(服务端过滤在分页之后)
  assert.match(seen[0].types, /private_channel/)
  assert.equal(seen[0].types.includes('im'), false, 'DM 不列 —— mpim:history 并不蕴含 mpim:read(真机实证)')
  assert.equal(seen[1].cursor, 'NEXT')
})

// ── 进度表达(第 2 步;docs/SLACK.md「进度表达」)────────────────────────────

test('createProgressThrottle: 窗口内只留最后一帧,内容没变整帧跳过', async () => {
  const { createProgressThrottle } = require('../../src/platform/slack')
  const sent = []
  let t = 0
  const timers = []
  const th = createProgressThrottle({
    intervalMs: 1000, send: async (x) => { sent.push(x) }, now: () => t,
    setTimer: (fn, ms) => { const id = timers.length; timers.push({ fn, at: t + ms }); return id },
    clearTimer: (id) => { if (timers[id]) timers[id] = null },
  })
  const run = async () => { for (const x of timers.splice(0)) if (x) await x.fn() }
  th.update('第一帧'); th.update('第二帧'); th.update('第三帧')
  await run()
  assert.deepEqual(sent, ['第三帧'], '⚠ 进度是全量重写,中间帧丢了无所谓 —— 但配额是整个 app 共享的')
  t += 2000
  th.update('第三帧'); await run()
  assert.deepEqual(sent, ['第三帧'], '没变就别发 —— 一次白发也是一次 Tier 3 配额')
})

test('createProgressThrottle: 撞到限流自动把间隔翻倍(封顶 60s)', async () => {
  const { createProgressThrottle } = require('../../src/platform/slack')
  let t = 0
  const timers = []
  const logs = []
  const th = createProgressThrottle({
    intervalMs: 20_000, now: () => t, log: (m) => logs.push(m),
    send: async () => { const e = new Error('x'); e.code = 'ratelimited'; throw e },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1 },
    clearTimer: () => {},
  })
  th.update('a'); await timers.pop().fn()
  assert.equal(th.intervalMs, 40_000)
  assert.match(logs[0], /限流/)
  // ⚠ 官方警告:超限后继续硬发,app 有被永久停用的风险
  for (let i = 0; i < 5; i++) { t += 100_000; th.update('x' + i); const j = timers.pop(); if (j) await j.fn() }
  assert.equal(th.intervalMs, 60_000, '封顶 60s')
})

function cardMock(handler) {
  const calls = []
  const f = async (url, opts) => {
    const method = url.split('/api/')[1]
    const body = Object.fromEntries(new URLSearchParams(opts.body))
    calls.push({ method, body })
    const j = handler(method, body, calls) || { ok: true, ts: String(calls.length) + '.0' }
    return { status: 200, headers: { get: () => null }, json: async () => j }
  }
  return { f, calls }
}
const CTX = { channel: 'C1', ts: '100.1', threadTs: '100.1', userId: 'U9' }
const mk = (fetchImpl) => require('../../src/platform/slack').createSlackPlatform({ botToken: 'xoxb-t', appToken: 'xapp-t', fetchImpl, card: { throttleMs: 1 } })

test('createStreamingCard: 建进度消息挂线程 + 拿原生 Working…(带发起人)', async () => {
  const { f, calls } = cardMock(() => ({ ok: true, ts: '200.2', agent_status: 'processing' }))
  const card = await mk(f).createStreamingCard(CTX)
  assert.ok(card, '建不出来才返回 null(引擎会退回纯文本)')
  const post = calls.find((c) => c.method === 'chat.postMessage')
  assert.equal(post.body.thread_ts, '100.1', '⚠ 频道内的原生会话必须挂线程')
  const st = calls.find((c) => c.method === 'agents.sessions.setStatus')
  assert.equal(st.body.status, 'processing')
  assert.equal(st.body.initiator_user_id, 'U9', '只在会话首次创建时生效,之后静默忽略')
  assert.ok(calls.some((c) => c.method === 'reactions.add' && c.body.timestamp === '100.1'), '⏳ 打在用户那条消息上')
})

test('createStreamingCard: finish —— 最终答案**独立发**,进度消息随后功成身退,状态必转 active', async () => {
  const { f: f2, calls: c2 } = cardMock((m, b, all) => {
    if (m === 'chat.postMessage') return { ok: true, ts: all.filter((x) => x.method === 'chat.postMessage').length === 1 ? '200.2' : '300.3' }
    return { ok: true, agent_status: b.status }
  })
  const card = await mk(f2).createStreamingCard(CTX)
  const answerTs = await card.finish('最终答案')
  const posts = c2.filter((c) => c.method === 'chat.postMessage')
  assert.equal(posts.length, 2, '⚠ 铁律:答案必须独立 postMessage —— 进度可以丢,答案不能丢')
  assert.equal(posts[1].body.thread_ts, '100.1')
  assert.equal(JSON.parse(posts[1].body.blocks)[0].text, '最终答案')
  assert.equal(answerTs, '300.3')
  const del = c2.find((c) => c.method === 'chat.delete')
  assert.equal(del.body.ts, '200.2', '答案落地后进度消息才删 —— 反过来就是发失败两头都丢')
  const last = c2.filter((c) => c.method === 'agents.sessions.setStatus').pop()
  assert.equal(last.body.status, 'active', '⚠ 不显式转就一直转圈到 1 小时超时,而答案其实早发了')
  assert.ok(c2.some((c) => c.method === 'reactions.add' && c.body.name === 'white_check_mark'))
})

test('createStreamingCard: 独立那条发不出去时,答案退回写进进度消息(绝不烂在半路)', async () => {
  const logs = []
  const { f, calls } = cardMock((m, b, all) => {
    if (m === 'chat.postMessage') return all.filter((x) => x.method === 'chat.postMessage').length === 1 ? { ok: true, ts: '200.2' } : { ok: false, error: 'ratelimited' }
    return { ok: true, agent_status: b.status }
  })
  const plat = require('../../src/platform/slack').createSlackPlatform({ botToken: 'xoxb-t', appToken: 'xapp-t', fetchImpl: f, card: { throttleMs: 1 }, log: (m) => logs.push(m) })
  const card = await plat.createStreamingCard(CTX)
  const ts = await card.finish('答案')
  assert.equal(ts, '200.2', '进度消息确认写成答案后返回其原有 ts')
  const upd = calls.filter((c) => c.method === 'chat.update').pop()
  assert.equal(JSON.parse(upd.body.blocks)[0].text, '答案', '退而求其次:至少让答案留在进度消息里')
  assert.equal(calls.some((c) => c.method === 'chat.delete'), false, '答案没落地就绝不删进度消息')
  assert.equal(calls.filter((c) => c.method === 'agents.sessions.setStatus').pop().body.status, 'active')
})

test('createStreamingCard: 独立发送和进度写入都被拒时不报告已送达', async () => {
  const { f, calls } = cardMock((method, _body, all) => {
    if (method === 'chat.postMessage') return all.filter((c) => c.method === method).length === 1
      ? { ok: true, ts: '200.2' } : { ok: false, error: 'ratelimited' }
    if (method === 'chat.update') return { ok: false, error: 'channel_not_found' }
    return { ok: true, agent_status: 'active' }
  })
  const card = await mk(f).createStreamingCard(CTX)
  assert.equal(await card.finish('答案'), null)
  assert.equal(calls.filter((c) => c.method === 'chat.update').length, 1)
  assert.equal(calls.some((c) => c.method === 'chat.delete'), false)
})

test('createStreamingCard: 原生状态不可用只降级,不影响这一轮,且不再反复去撞', async () => {
  const logs = []
  const { f, calls } = cardMock((m) => (m === 'agents.sessions.setStatus' ? { ok: false, error: 'not_authorized' } : { ok: true, ts: '200.2' }))
  const plat = require('../../src/platform/slack').createSlackPlatform({ botToken: 'xoxb-t', appToken: 'xapp-t', fetchImpl: f, card: { throttleMs: 1 }, log: (m) => logs.push(m) })
  const card = await plat.createStreamingCard(CTX)
  assert.ok(card, '拿不到 Working… 也要照常给进度消息')
  await card.finish('答案')
  assert.equal(calls.filter((c) => c.method === 'agents.sessions.setStatus').length, 1, '撞过一次就别再撞')
  assert.match(logs.join(' '), /agent_view/, '要说清多半是哪里没开、怎么修')
})

test('createStreamingCard: recall 撤掉进度消息(ack 后转静默,群里不留痕)', async () => {
  const { f, calls } = cardMock((m, b) => (m === 'agents.sessions.setStatus' ? { ok: true, agent_status: b.status } : { ok: true, ts: '200.2' }))
  const card = await mk(f).createStreamingCard(CTX)
  assert.equal(await card.recall(), true)
  assert.equal(calls.find((c) => c.method === 'chat.delete').body.ts, '200.2')
  assert.equal(calls.filter((c) => c.method === 'agents.sessions.setStatus').pop().body.status, 'active')
  // 撤回之后再 update / finish 都不该再动群里
  const n = calls.length
  card.update('多余的一帧'); await new Promise((r) => setTimeout(r, 20))
  assert.equal(calls.length, n, '关掉之后不能再刷')
})

// ── 出网代理接线(src/core/proxy.js)──────────────────────
// ⚠ 上面所有用例都注了 `fetchImpl` ⇒ **它们一条都证明不了默认实现走没走代理**,
//   而"默认实现"恰恰就是这个洞本身(适配器原先是裸 `fetch` + 裸 `new WebSocket(url)`)。
//   下面两条专门钉默认路径。

test('⭐ 不注 fetchImpl 时,配了代理就必须走隧道(否则就是那个洞本身)', async () => {
  const { resetProxy } = require('../../src/core/proxy')
  const saved = process.env.HTTPS_PROXY
  // 指向一个**必然连不上**的本地端口:要的就是"连不上代理"这句错误 —— 它只可能来自隧道,
  // 直连 slack.com 报的是完全不同的话。⇒ 这条一旦回落成裸 fetch 就会红。
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
  resetProxy()
  try {
    const call = createSlackApi('xoxb-t', { timeoutMs: 2000 })
    await assert.rejects(() => call('auth.test', {}, { retries: 0 }), (e) => {
      assert.ok(e instanceof SlackError)
      assert.equal(e.code, 'request_timeout')
      // 原因落在 payload.cause 里(SlackError 的 message 只有 code)
      assert.match(String(e.payload && e.payload.cause), /连不上代理 http:\/\/127\.0\.0\.1:1/)
      return true
    })
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = saved
    resetProxy()
  }
})

// 漂移守卫(同 engine.test.js 那条 SLASH_COMMANDS 的做法):直接从源码里找回落写法。
// ⚠ 光靠上面那条行为测试挡不住 **WS** 那一侧 —— 它要真连才走得到,单测里够不着;
//   而 ws 不走代理的表现是"连上了但一直没 Hello",最不像故障的一种故障。
test('漂移守卫:适配器里不许再出现裸 fetch / 不挂 agent 的 WebSocket', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../src/platform/slack.js'), 'utf8')
  // ⚠ 先剥掉行尾注释再判,否则 `const x = fetch(url) // 临时` 这种会因为行里有 // 而被放过
  //   (变异检验时逮到的盲区:守卫自己也要有对照组)。
  const bare = src.split('\n')
    .map((l, i) => [i + 1, l.trim().startsWith('//') || l.trim().startsWith('*') ? '' : l.replace(/\/\/.*$/, '')])
    .filter(([, l]) => /(^|[^.\w])fetch\s*\(/.test(l) && !/getProxyFetch|netFetch|fetchImpl/.test(l))
  assert.deepEqual(bare, [], '裸 fetch 不读 http_proxy ⇒ 墙内机器上整条跑不起来,要走 netFetch')
  const ws = src.split('\n').filter((l) => /new WebSocket\(/.test(l) && !/agent/.test(l))
  assert.deepEqual(ws, [], 'new WebSocket 必须带 { agent } —— 不带就是"连上了但没 Hello"')
})

// ── 群内控制按钮(Block Kit)────────────────────────────────────────────────────────
// ⭐ 为什么这条入口存在:Slack 吃掉 `/` 开头的输入,而**注册的斜杠命令在线程里根本调不出来**
//   (官方明文)—— 偏偏进度消息与答案全挂在线程里。⇒ 按钮是线程里唯一免教学的控制入口。

const { controlActions, actionsBlock, actionMessage, CONTROL_BUTTONS } = require('../../src/platform/slack')

test('controlActions: 清单从引擎的 SLASH_COMMANDS 过一遍,引擎没有的命令不出按钮', () => {
  const all = controlActions(['/stop', '/skip', '/status', '/help'])
  assert.deepEqual(all.map((b) => b.cmd), ['/stop', '/skip', '/status'])
  // ⚠ 这条是漂移守卫:哪天引擎去掉 /skip,这里必须跟着少一个按钮 ——
  //   否则留下的是一个按下去回「未知命令」的按钮,比没有按钮更糟。
  assert.deepEqual(controlActions(['/stop', '/status']).map((b) => b.cmd), ['/stop', '/status'])
  assert.deepEqual(controlActions([]), [])
})

test('controlActions: ⚠ 故意不含 /new —— 按钮点一下就生效,没有回头路', () => {
  assert.equal(CONTROL_BUTTONS.some((b) => b.cmd === '/new'), false, '清会话那个必须留给要手打的 !new')
})

test('actionsBlock: action_id 由命令派生且稳定 · 只有停止是 danger 且带 confirm', () => {
  const b = actionsBlock(controlActions(['/stop', '/skip', '/status']))
  assert.equal(b.type, 'actions')
  assert.equal(b.block_id, 'sint_controls', '前缀稳定:actionMessage 回来时按它认「是不是我们的按钮」')
  assert.deepEqual(b.elements.map((e) => e.action_id), ['sint_stop', 'sint_skip', 'sint_status'])
  assert.deepEqual(b.elements.map((e) => e.value), ['/stop', '/skip', '/status'])
  const [stop, skip] = b.elements
  assert.equal(stop.style, 'danger')
  // 真机上出过「跑了 42 分钟、离收尾只差一步却被 /stop 掐掉」—— 那次代价就是没有这道确认
  assert.equal(stop.confirm.confirm.text, '停止')
  assert.equal(skip.confirm, undefined, '只有破坏性那个要拦一道,每个都弹确认等于没有确认')
  assert.equal(actionsBlock([]), null)
  assert.equal(actionsBlock(null), null)
})

test('⭐ messagePayload 不传 actions 时,输出与从前逐字节相同', () => {
  const p = messagePayload('C1', '正文')
  assert.equal(p.blocks.length, 1, '出站正文是全链路最热的一段,加个可选参数不该让每条消息都变形')
  assert.equal(p.blocks[0].type, 'markdown')
  assert.equal(Object.prototype.hasOwnProperty.call(p, 'attachments'), false)
})

test('messagePayload 带 actions:正文块在前、按钮块追加在后', () => {
  const p = messagePayload('C1', '正文', { actions: controlActions(['/stop']) })
  assert.equal(p.blocks.length, 2)
  assert.equal(p.blocks[0].type, 'markdown')
  assert.equal(p.blocks[0].text, '正文', '加按钮不该动正文')
  assert.equal(p.blocks[1].type, 'actions')
})

test('进度消息挂按钮,且**每一帧 update 都要重新带上**(chat.update 是整条替换)', async () => {
  const { f, calls } = cardMock(() => ({ ok: true, ts: '200.2' }))
  const plat = require('../../src/platform/slack').createSlackPlatform({
    botToken: 'xoxb-t', appToken: 'xapp-t', fetchImpl: f, card: { throttleMs: 1 },
    commands: ['/stop', '/skip', '/status'],
  })
  const card = await plat.createStreamingCard(CTX)
  const post = calls.find((c) => c.method === 'chat.postMessage')
  const blocks = JSON.parse(post.body.blocks)
  assert.equal(blocks[1].type, 'actions', '进度消息一建出来就该有按钮')

  card.update('跑到一半了')
  await new Promise((r) => setTimeout(r, 30))
  const upd = calls.filter((c) => c.method === 'chat.update')
  assert.ok(upd.length >= 1, '至少刷过一帧')
  // ⚠ 少传 blocks 就等于把按钮删了(同「只传 text 会静默清空 blocks」那条的形状)
  assert.equal(JSON.parse(upd[upd.length - 1].body.blocks)[1].type, 'actions', '每帧都要重新带上按钮')
})

test('⚠ 答案落进进度消息的兜底路径**不带按钮** —— 轮次结束了,能点的停止就是骗人', async () => {
  // 让独立发送失败(postMessage 不给 ts)⇒ 走 finish 的兜底分支
  const { f, calls } = cardMock((m, b, all) => {
    if (m === 'chat.postMessage') return all.filter((c) => c.method === 'chat.postMessage').length > 1 ? { ok: true } : { ok: true, ts: '200.2' }
    return { ok: true, ts: '200.2' }
  })
  const plat = require('../../src/platform/slack').createSlackPlatform({
    botToken: 'xoxb-t', appToken: 'xapp-t', fetchImpl: f, card: { throttleMs: 1 },
    commands: ['/stop', '/skip', '/status'],
  })
  const card = await plat.createStreamingCard(CTX)
  await card.finish('这是答案')
  const last = calls.filter((c) => c.method === 'chat.update').pop()
  assert.ok(last, '兜底路径必须走 chat.update')
  assert.equal(JSON.parse(last.body.blocks).length, 1, '只剩正文块,按钮要被整条替换抹掉')
})

// ── 按钮点回来(actionMessage 纯函数)──────────────────────────────────────────────

// ⚠ 真实载荷里 user.name 与 user.username **都是 handle**(不是显示名),真名要靠 users.info 缓存
const ACTION = {
  type: 'block_actions',
  user: { id: 'U9', username: 'xiaowang', name: 'xiaowang', team_id: 'T0' },
  channel: { id: 'C1' },
  message: { ts: '200.2', thread_ts: '100.1' },
  container: { type: 'message', message_ts: '200.2', thread_ts: '100.1', channel_id: 'C1' },
  trigger_id: 'T1',
  actions: [{ action_id: 'sint_stop', block_id: 'sint_controls', value: '/stop', action_ts: '1725000000.111' }],
}
const CMDS = ['/stop', '/skip', '/status']

test('actionMessage: 点击 → 引擎消息,回执挂回按钮所在的线程', () => {
  const m = actionMessage(ACTION, { commands: CMDS, now: () => 1725000001000, nameOf: (id) => (id === 'U9' ? '小王' : null) })
  assert.equal(m.text, '/stop')
  assert.equal(m.chatId, 'C1')
  assert.equal(m.senderName, '小王', '名字与消息路径同源(users.info 缓存),否则同一个人发消息叫小王、点按钮叫 xiaowang')
  assert.equal(actionMessage(ACTION, { commands: CMDS }).senderName, 'xiaowang', '缓存没命中才退到 handle')
  assert.equal(m.replyCtx.threadTs, '100.1', '⭐ 点击只有点的人看得见,回执必须落回线程')
  assert.equal(m.wantsAck, false)
})

// ⚠ v0.11.12 血教训:载荷里没有平台 ts,只有本机时钟;拿它推水位线,主机钟快 N 秒
//   就等于开了个 N 秒黑洞把真人消息静默吞掉。
test('actionMessage: synthetic 必须为 true(载荷没有平台 ts,不能拿本机钟推水位线)', () => {
  assert.equal(actionMessage(ACTION, { commands: CMDS }).synthetic, true)
})

// ⚠ 这条是安全项:载荷是外部输入。
test('⭐ actionMessage: 只认引擎认得的命令 —— 伪造的 value 一律丢弃', () => {
  const forged = { ...ACTION, actions: [{ value: '/rm-rf', action_ts: '1.1' }] }
  assert.equal(actionMessage(forged, { commands: CMDS }), null, '别人 app 的按钮或伪造 value 不该喂进引擎')
  assert.equal(actionMessage({ ...ACTION, actions: [{ value: '' }] }, { commands: CMDS }), null)
  assert.equal(actionMessage({ ...ACTION, actions: [] }, { commands: CMDS }), null)
  assert.equal(actionMessage(ACTION, { commands: [] }), null, '引擎没这个命令就不该受理')
  assert.equal(actionMessage({ ...ACTION, type: 'view_submission' }, { commands: CMDS }), null)
  assert.equal(actionMessage({ ...ACTION, channel: null }, { commands: CMDS }), null)
  assert.equal(actionMessage(null, { commands: CMDS }), null)
})

test('actionMessage: 去重键取 action_ts 而不是 trigger_id(重投时后者会变)', () => {
  const a = actionMessage(ACTION, { commands: CMDS })
  const redelivered = { ...ACTION, trigger_id: 'T2-换了一个' }
  assert.equal(actionMessage(redelivered, { commands: CMDS }).msgId, a.msgId, '同一次点击重投必须认得出是同一下')
  assert.equal(a.msgId, 'action:1725000000.111')
})

// ── App Home 主页(SLACK.md「群内控制面」 第三层)────────────────────────────────────────────────

const { homeView } = require('../../src/platform/slack')

test('homeView: 讲三个入口,并说清为什么不是 `/`', () => {
  const v = homeView({ alias: '!', umbrella: '/sint' })
  assert.equal(v.type, 'home')
  const text = JSON.stringify(v)
  assert.match(text, /线程/, '线程里没法用斜杠命令 —— 这正是按钮存在的理由,主页要说')
  assert.match(text, /!status/)
  assert.match(text, /\/sint/)
  assert.match(text, /被 Slack 自己吃掉/, '不解释原因的话,人只会觉得这产品的命令很怪')
})

// ⭐ 这条是漂移守卫:命令表的单一事实源在引擎的 helpText(),抄一份到这里必然漂移,
//   而且 App Home 是**按人**发布的、那张表是**按群**算的(权限/模型/画布都不同)——
//   真放进来,只能对一个群是准的。
test('⭐ homeView 不复制命令表,只指向 !help(表是按群算的,主页是按人发的)', () => {
  const text = JSON.stringify(homeView({}))
  assert.match(text, /!help/, '要给出去哪儿看按群算的那份')
  for (const desc of ['排队几条', '忘掉之前聊的', '额度与当前会话规模']) {
    assert.equal(text.includes(desc), false, `命令说明只能有一处事实源(engine.helpText),不许抄进主页:${desc}`)
  }
})

test('homeView: 前缀与总入口跟着配置走(两者都做成了配置项,随时可能被别的 app 抢名)', () => {
  const text = JSON.stringify(homeView({ alias: '#', umbrella: '/sint' }))
  assert.match(text, /#status/)
  assert.match(text, /\/sint/)
  assert.equal(text.includes('!status'), false)
})

// ⚠ app_home_opened **两个页签都会发**(Messages 也算)—— 不筛就是每次有人点开 DM
//   都白打一次 views.publish。这个筛子在帧处理层单测够不着,故抽成纯函数钉住。
test('shouldPublishHome: 只认 home 页签,Messages 页签一律不发布', () => {
  const { shouldPublishHome } = require('../../src/platform/slack')
  assert.equal(shouldPublishHome({ type: 'app_home_opened', tab: 'home', user: 'U1' }), true)
  assert.equal(shouldPublishHome({ type: 'app_home_opened', tab: 'messages', user: 'U1' }), false)
  assert.equal(shouldPublishHome({ type: 'app_home_opened', user: 'U1' }), false, '没有 tab 字段时也不发')
  assert.equal(shouldPublishHome({ type: 'app_home_opened', tab: 'home' }), false, '没有 user 就没得发')
  assert.equal(shouldPublishHome({ type: 'message', tab: 'home', user: 'U1' }), false)
  assert.equal(shouldPublishHome(null), false)
})

// ── reviewer 逮到的三个洞:反向漂移 · Block Kit 上限 · 零工具名 ──────────────────────

// ⭐ 反向守卫。controlActions 是个过滤器:引擎把 /skip 改名成 /next,按钮就**静默少一个**,
//   而上面那条测试用的是手写清单,永远绿。这条拿引擎真实导出的 SLASH_COMMANDS 比。
test('⭐ 反向漂移守卫:CONTROL_BUTTONS 里的每个命令都必须仍在引擎的 SLASH_COMMANDS 里', () => {
  const { SLASH_COMMANDS } = require('../../src/core/engine')
  for (const b of CONTROL_BUTTONS) {
    assert.ok(SLASH_COMMANDS.includes(b.cmd), `引擎已没有 ${b.cmd},按钮会静默消失 —— 要么改按钮要么改引擎`)
  }
  assert.deepEqual(controlActions(SLASH_COMMANDS).map((b) => b.cmd), CONTROL_BUTTONS.map((b) => b.cmd), '按真实清单过滤后一个都不该少')
})

// Block Kit 的硬上限(官方 button-element / confirmation-dialog-object / actions-block)。
// 日后改长文案在真机上撞 invalid_blocks 时,错误分类只记日志、进度消息建不出来 ⇒ 按钮整层失效。
test('Block Kit 上限:按钮文字 ≤75 · confirm 100/300/30/30 · id ≤255 · 元素 ≤25', () => {
  const b = actionsBlock(controlActions(['/stop', '/skip', '/status']))
  assert.ok(b.block_id.length <= 255)
  assert.ok(b.elements.length <= 25)
  for (const e of b.elements) {
    assert.ok(e.text.text.length <= 75, e.action_id)
    assert.ok(e.action_id.length <= 255)
    assert.ok(String(e.value).length <= 2000)
    if (e.confirm) {
      assert.ok(e.confirm.title.text.length <= 100)
      assert.ok(e.confirm.text.text.length <= 300)
      assert.ok(e.confirm.confirm.text.length <= 30)
      assert.ok(e.confirm.deny.text.length <= 30)
    }
  }
})

// 用户面零工具名(CONTRIBUTING.md):按钮文案、confirm 文案、主页文案都是群成员看得见的。
test('零工具名:按钮/confirm/主页文案里不出现 sbot、CLI 命令名、机器路径', () => {
  const visible = JSON.stringify([
    CONTROL_BUTTONS.map((b) => [b.label, b.confirm]),
    homeView({ alias: '!', umbrella: '/sint' }),
  ])
  assert.doesNotMatch(visible, /sbot/i)
  assert.doesNotMatch(visible, /~\/\.|\/Users\/|\/home\//)
  assert.doesNotMatch(visible, /node bin\//)
  // 对照组:上面的判据要真的在看东西
  assert.match(visible, /停止/)
})

// ── actionMessage 的对照组与两道校验 ────────────────────────────────────────────

test('actionMessage: 顶层消息(没有 thread_ts)⇒ 回执发频道,不拿 ts 冒充线程', () => {
  // 合成轮的进度消息发在频道顶层;若拿它的 ts 当线程,回执会挂在 finish 时就被删掉的消息下面
  const top = { ...ACTION, message: { ts: '200.2' } }
  assert.equal(actionMessage(top, { commands: CMDS }).replyCtx.threadTs, null)
  assert.equal(actionMessage({ ...ACTION, message: undefined }, { commands: CMDS }).replyCtx.threadTs, null, 'message 缺席也不许抛')
})

test('⭐ actionMessage: action_id 不带我们的前缀 ⇒ 丢弃(value 恰好也叫 /stop 的别家按钮不该被当真)', () => {
  const foreign = { ...ACTION, actions: [{ action_id: 'other_app_stop', value: '/stop', action_ts: '1.1' }] }
  assert.equal(actionMessage(foreign, { commands: CMDS }), null)
  const noId = { ...ACTION, actions: [{ value: '/stop', action_ts: '1.1' }] }
  assert.equal(actionMessage(noId, { commands: CMDS }), null)
  // 对照组:前缀对、value 对 ⇒ 受理
  assert.ok(actionMessage(ACTION, { commands: CMDS }))
})

// 多平台同进程(10-13 起挂 multi.js):凭据错了只停 Slack 这一路,start 不抛 —— 抛了整个 daemon 起不来,飞书 / 企微的群全跟着停。
// 失败态要报得出去:connHealth 是 failed 且带原因,onConn 收到一次 failed(运维告警的断线观察靠它);也不再去开长连接。
test('start: auth.test 致命凭据错误 ⇒ 不抛、停在 failed 并报出去,不再开长连接', async () => {
  const called = []
  const base = mockJson({ 'auth.test': { json: { ok: false, error: 'invalid_auth' } } })
  const fetchImpl = async (url, opts) => { called.push(url.split('/api/')[1]); return base(url, opts) }
  const conns = []
  const plat = require('../../src/platform/slack').createSlackPlatform({ botToken: 'xoxb-bad', appToken: 'xapp-t', fetchImpl, onConn: (h) => conns.push(h), log: () => {} })
  await plat.start(() => {}, {}) // 不抛就是对的
  const h = plat.connHealth()
  assert.equal(h.state, 'failed'); assert.match(h.lastError, /invalid_auth/); assert.equal(h.fatal, 'invalid_auth')
  assert.equal(conns.length, 1); assert.equal(conns[0].state, 'failed')
  assert.deepEqual(called, ['auth.test'], '凭据错了就别再去开 Socket Mode')
  await plat.stop()
  // 对照组:凭据没问题时 start 会接着去开长连接(证明上面「没开」不是因为根本走不到那一步)
  const called2 = []
  const ok = mockJson({ 'auth.test': { json: { ok: true, user_id: 'UBOT', user: 'bot', team: 't' } }, 'apps.connections.open': { json: { ok: false, error: 'internal_error' } } })
  const plat2 = require('../../src/platform/slack').createSlackPlatform({ botToken: 'xoxb-t', appToken: 'xapp-t', fetchImpl: async (u, o) => { called2.push(u.split('/api/')[1]); return ok(u, o) }, log: () => {} })
  await plat2.start(() => {}, {})
  await plat2.stop()
  assert.ok(called2.includes('apps.connections.open'), '对照:好凭据会去开长连接')
})

test('slack manifest:注册了斜杠命令就必须带 commands 权限 —— 少了它 Slack 直接拒收这份 manifest', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const text = fs.readFileSync(path.join(__dirname, '../../docs/slack-app-manifest.yaml'), 'utf8')
  const live = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.match(live, /^\s*slash_commands:/m)
  const bot = live.split(/^\s*bot:\s*$/m)[1].split(/^settings:/m)[0]
  const scopes = bot.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())
  assert.ok(scopes.includes('commands'), 'bot scopes 里没有 commands')
})
