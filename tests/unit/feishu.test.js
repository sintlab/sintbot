// Feishu adapter pure helpers — text extraction (incl. rich-text links, P1 fix)
// and group @mention gating. The WS/client paths need live creds → not here.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseText, shouldHandleGroup, createCardThrottle, createCardWriter, answerCardElements, assertCardOk, createFeishuPlatform } = require('../../src/platform/feishu')

test('active text send confirms only code zero with a message ID', async () => {
  const responses = [
    { code: 0, data: { message_id: 'accepted-1' } },
    { code: 999, msg: 'rejected', data: { message_id: 'misleading-id' } },
    { code: 0, data: {} },
    { data: { message_id: 'missing-code' } },
  ]
  const sent = [], logs = []
  const client = { im: { message: { create: async (request) => {
    sent.push(request)
    return responses.shift()
  } } } }
  const platform = createFeishuPlatform({ appId: 'fixture', appSecret: 'fixture', client, log: value => logs.push(value) })
  assert.equal(await platform.send('chat-1', 'hello'), 'accepted-1')
  assert.equal(await platform.send('chat-1', 'hello'), null, 'rejected code must override a misleading ID')
  assert.equal(await platform.send('chat-1', 'hello'), null, 'success without an ID is not confirmed')
  assert.equal(await platform.send('chat-1', 'hello'), null, 'missing code is not success')
  assert.equal(sent.length, 4)
  assert.equal(sent.every(request => request.data.receive_id === 'chat-1'), true)
  assert.equal(logs.filter(value => value.includes('send rejected')).length, 3)
})

// ── 回答卡表格精致化(v0.11.5):markdown 表格段 → 原生 table 组件 ──────────────

const RANK_TABLE = [
  '| # | 评论 | 赞 | 作者 | 帖子 |',
  '| --- | --- | --- | --- | --- |',
  '| 1 | 222 | 63 | 小橘子 | 周末去哪儿玩?求推荐几个近郊的露营地,带娃那种 |',
  '| 2 | 172 | 51 | MapleLee | 新手入门,第一台相机买哪款 |',
].join('\n')

test('answerCardElements: 表格段转原生 table,前后文本保留为 markdown 段', () => {
  const els = answerCardElements('查询结果:\n\n' + RANK_TABLE + '\n\n口径说明一行')
  assert.equal(els.length, 4) // 末尾多一个「可复制版」折叠区(v0.11.11)
  assert.deepEqual(els.map((e) => e.tag), ['markdown', 'table', 'markdown', 'collapsible_panel'])
  assert.equal(els[0].content, '查询结果:')
  assert.equal(els[2].content, '口径说明一行')
  const t = els[1]
  assert.equal(t.row_height, 'low') // 紧凑行高(真机拍板的样式 A)
  assert.equal(t.page_size, 10)
  assert.equal(t.header_style.background_style, 'grey')
  assert.equal(t.columns.length, 5)
  assert.equal(t.rows.length, 2)
  assert.deepEqual(t.rows[0].c0, 1) // 数字列 cast Number
  assert.equal(t.rows[1].c3, 'MapleLee')
})

// ── 可复制版折叠区(v0.11.11):把「另发一条纯文本」收进卡片内一个默认收起的面板 ──
// 起因:每个含表格的回答都多一条消息,群里嫌累赘(2026-08-06)。要复制的人展开即得,其余人看不见。

test('answerCardElements: 末尾挂一个默认收起的「可复制版」折叠区,内含 Tab 分隔文本', () => {
  const els = answerCardElements(RANK_TABLE)
  const panel = els[els.length - 1]
  assert.equal(panel.tag, 'collapsible_panel')
  assert.equal(panel.expanded, false, '必须默认收起 —— 展开就等于没解决累赘')
  const code = panel.elements[0].content
  assert.match(code, /^```\n/); assert.match(code, /\n```$/) // 代码块:等宽对齐 + 客户端自带复制
  assert.match(code, /#\t评论\t赞\t作者\t帖子/)              // 内容是 Tab 分隔,粘进表格自动分列
  assert.doesNotMatch(code, /\|\s*评论\s*\|/)                  // 不是原样管道
})

test('answerCardElements: 无表格 ⇒ 仍返回 null(不建折叠区,也不动原 markdown 收尾)', () => {
  assert.equal(answerCardElements('就是一段普通回答,没有表格'), null)
})

test('answerCardElements: 列宽策略 —— 数字列 80px、恰好一个 auto 给最宽文本列、其余固定 px', () => {
  const cols = answerCardElements(RANK_TABLE)[0].columns
  assert.deepEqual(cols.map((c) => c.data_type), ['number', 'number', 'number', 'text', 'text'])
  assert.deepEqual(cols.slice(0, 3).map((c) => c.width), ['80px', '80px', '80px'])
  assert.equal(cols[4].width, 'auto') // 帖子列内容最宽 ⇒ 唯一 auto
  assert.match(cols[3].width, /^\d+px$/) // 作者列钉 px
  // ⚠ 手机端安全不变量(真机踩过:auto/百分比在移动端整列消失)—— 恰好一个 auto,
  // 其余全是 [80,220] 的固定 px,绝无百分比
  const autos = cols.filter((c) => c.width === 'auto')
  assert.equal(autos.length, 1)
  for (const c of cols) {
    if (c.width === 'auto') continue
    const px = Number(c.width.replace('px', ''))
    assert.ok(px >= 80 && px <= 220, c.width)
  }
  // 数字列右对齐、首列(序号)除外
  assert.equal(cols[0].horizontal_align, undefined)
  assert.equal(cols[1].horizontal_align, 'right')
})

test('answerCardElements: 全数字表也有弹性列(最后一列 auto)', () => {
  const els = answerCardElements('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
  const cols = els[0].columns
  assert.deepEqual(cols.map((c) => c.width), ['80px', 'auto'])
})

test('answerCardElements: 含链接/粗体的列走 lark_md 保渲染,纯文本列剥标记', () => {
  const md = '| 名称 | 链接 |\n| --- | --- |\n| **甲** | [帖](https://x.cn/1) |\n| 乙 | [帖2](https://x.cn/2) |'
  const cols = answerCardElements(md)[0].columns
  assert.equal(cols[0].data_type, 'lark_md') // **甲** 含粗体
  assert.equal(cols[1].data_type, 'lark_md')
  const rows = answerCardElements(md)[0].rows
  assert.equal(rows[0].c0, '**甲**') // lark_md 保留原始语法
  assert.match(rows[0].c1, /\[帖\]\(https:\/\/x\.cn\/1\)/)
})

test('answerCardElements: 无表格 / 超过 5 张表 ⇒ null(走 markdown 原样兜底)', () => {
  assert.equal(answerCardElements('普通回答,没有表格'), null)
  assert.equal(answerCardElements(''), null)
  const one = '| a |\n| --- |\n| 1 |\n'
  assert.equal(answerCardElements(Array(6).fill(one).join('\n中间\n')), null)
  // 代码围栏里的竖线不算表格
  assert.equal(answerCardElements('```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```'), null)
})

// 流式卡片节流(v0.7.6)。注入时钟+定时器 ⇒ 时间窗/trailing/收尾全可测,不碰 SDK。
function throttleHarness(intervalMs) {
  let t = 1000
  const sent = []
  const timers = [] // [{at, fn}] — 手动触发,模拟真实 setTimeout
  const th = createCardThrottle({
    intervalMs,
    send: (text) => sent.push(text),
    now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1) },
  })
  return {
    th, sent, timers,
    adv(ms) { // 推进时钟并触发到期定时器
      t += ms
      for (const h of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(h), 1); h.fn() }
    },
  }
}

const post = (content) => ({ message_type: 'post', content: JSON.stringify({ content }) })

test('parseText: plain text strips mention placeholders', () => {
  const m = { message_type: 'text', content: JSON.stringify({ text: '@_user_1 跑下测试' }) }
  assert.equal(parseText(m), '跑下测试')
})

test('parseText: post keeps link text AND href (P1 — links must reach the model)', () => {
  const m = post([[{ tag: 'text', text: '看下这个 issue:' }, { tag: 'a', text: '链接', href: 'https://github.com/x/y/issues/1' }]])
  assert.equal(parseText(m), '看下这个 issue: 链接(https://github.com/x/y/issues/1)')
})

test('parseText: post link without text falls back to the bare href', () => {
  const m = post([[{ tag: 'a', href: 'https://example.com/doc' }]])
  assert.equal(parseText(m), 'https://example.com/doc')
})

test('parseText: unsupported message types return null', () => {
  assert.equal(parseText({ message_type: 'image', content: '{}' }), null)
  assert.equal(parseText({ message_type: 'text', content: 'not json' }), null)
})

test('shouldHandleGroup: default gating — no mention/@bot handle, @others-only skip', () => {
  const bot = 'ou_bot'
  const msg = (mentions) => ({ mentions })
  assert.equal(shouldHandleGroup(msg([]), bot, false), true)
  assert.equal(shouldHandleGroup(msg([{ id: { open_id: 'ou_other' } }]), bot, false), false)
  assert.equal(shouldHandleGroup(msg([{ id: { open_id: 'ou_other' } }, { id: { open_id: bot } }]), bot, false), true)
  assert.equal(shouldHandleGroup(msg([]), bot, true), false) // strict mode: only when @bot
})

// ── console chat-management helpers — driven with fake clients ──
const { createChat, fetchChatMembers, addChatMembers, deleteChat } = require('../../src/platform/feishu')

test('createChat: passes member user_id_list at creation', async () => {
  let captured
  const client = { im: { chat: { create: async (o) => { captured = o; return { data: { chat_id: 'oc_new', name: 'X' } } } } } }
  const r = await createChat(client, 'X', '', ['ou_a', 'ou_b'])
  assert.equal(r.chatId, 'oc_new')
  assert.deepEqual(captured.data.user_id_list, ['ou_a', 'ou_b'])
  assert.equal(captured.params.user_id_type, 'open_id')
})

test('createChat: no members ⇒ user_id_list omitted (unchanged shape)', async () => {
  let captured
  const client = { im: { chat: { create: async (o) => { captured = o; return { data: { chat_id: 'oc_new' } } } } } }
  await createChat(client, 'X')
  assert.equal('user_id_list' in captured.data, false)
})

test('fetchChatMembers: paginates and maps to {openId, name}', async () => {
  const pages = [
    { data: { items: [{ member_id: 'ou_1', name: '张三' }], has_more: true, page_token: 't2' } },
    { data: { items: [{ member_id: 'ou_2', name: '李四' }], has_more: false } },
  ]
  let i = 0
  const client = { im: { chatMembers: { get: async () => pages[i++] } } }
  assert.deepEqual(await fetchChatMembers(client, 'oc_x'), [{ openId: 'ou_1', name: '张三' }, { openId: 'ou_2', name: '李四' }])
})

test('addChatMembers: chunks id_list at 50 per call (API cap)', async () => {
  const calls = []
  const client = { im: { chatMembers: { create: async (o) => calls.push(o.data.id_list.length) } } }
  await addChatMembers(client, 'oc_x', Array.from({ length: 120 }, (_, i) => 'ou_' + i))
  assert.deepEqual(calls, [50, 50, 20])
})

test('deleteChat: disbands via im.chat.delete', async () => {
  let captured
  const client = { im: { chat: { delete: async (o) => { captured = o } } } }
  await deleteChat(client, 'oc_kill')
  assert.equal(captured.path.chat_id, 'oc_kill')
})

const { larkErrMsg } = require('../../src/platform/feishu')

test('larkErrMsg: surfaces the scope hint buried in the axios response body', () => {
  const e = Object.assign(new Error('Request failed with status code 400'), {
    response: { data: { code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:chat, im:chat:delete]…' } },
  })
  const m = larkErrMsg(e)
  assert.match(m, /im:chat/)          // the actionable part reaches the toast
  assert.match(m, /99991672/)         // error code kept for troubleshooting
  assert.doesNotMatch(m, /^Request failed/) // not the useless axios line
})

test('larkErrMsg: plain errors fall back to message / string', () => {
  assert.equal(larkErrMsg(new Error('boom')), 'boom')
  assert.equal(larkErrMsg('raw'), 'raw')
})

// ── precheck + admin-candidate derivation ──────────────────────────
const { feishuPrecheck, fetchAdminCandidates, resolveContactToOpenId, fetchOrgUsers } = require('../../src/platform/feishu')
const larkErr = (code, msg) => Object.assign(new Error('Request failed with status code 400'), { response: { data: { code, msg } } })

// ── 应用身份(控制台「设置 → 飞书应用 · 身份」)──────────────────────────────
// 名称 / 头像 / 状态来自 bot/v3/info(零 scope),描述只在 application/v6(要 scope)。
// 这组测试钉的是:字段映射、两套状态枚举不混用、缺权限**降级但不拖垮**、以及
// 「应用真的没填描述」与「没权限读描述」必须给出不同结论 —— 前者无事可做,后者要去开权限。
const { normalizeBotInfo, normalizeAppInfo, fetchAppIdentity, identityCheck, APP_INFO_SCOPE_HINT } = require('../../src/platform/feishu')

test('normalizeBotInfo: maps bot/v3/info fields; activate_status 2 = 已启用', () => {
  const r = normalizeBotInfo({ bot: { open_id: 'ou_1', app_name: 'SintBot', avatar_url: 'https://x/a.png', activate_status: 2 } })
  assert.deepEqual(r, { openId: 'ou_1', appName: 'SintBot', avatarUrl: 'https://x/a.png', activateStatus: 2, activateText: '已启用', activateOk: true })
})

test('normalizeBotInfo: accepts the data-wrapped shape and a stopped tenant', () => {
  const r = normalizeBotInfo({ data: { bot: { open_id: 'ou_2', app_name: 'X', activate_status: 1 } } })
  assert.equal(r.openId, 'ou_2')
  assert.equal(r.activateText, '已停用')
  assert.equal(r.activateOk, false) // 只有 2 才算跑得起来
})

test('normalizeBotInfo: empty/garbage body ⇒ nulls, never throws', () => {
  for (const raw of [null, {}, { bot: {} }, { data: {} }]) {
    const r = normalizeBotInfo(raw)
    assert.equal(r.openId, null); assert.equal(r.appName, ''); assert.equal(r.activateText, '')
  }
})

test('normalizeAppInfo: reads description + localized name; status enum is the app one (1=已启用)', () => {
  const r = normalizeAppInfo({ data: { app: { app_id: 'cli_1', app_name: '记账助手', description: '群里跑设计与开发', avatar_url: 'https://x/b.png', status: 1 } } })
  assert.equal(r.description, '群里跑设计与开发')
  assert.equal(r.appName, '记账助手')
  assert.equal(r.statusText, '已启用') // app.status 1 = 启用,与 bot 的 activate_status 2 是两套枚举
  assert.equal(r.ok, true)
})

test('normalizeAppInfo: falls back to the i18n entry when top-level name/desc are blank', () => {
  const r = normalizeAppInfo({ app: { app_id: 'cli_2', i18n: [{ i18n_key: 'en_us', name: 'EN', description: 'english' }, { i18n_key: 'zh_cn', name: '中文名', description: '中文描述' }] } }, 'zh_cn')
  assert.equal(r.appName, '中文名')
  assert.equal(r.description, '中文描述')
})

test('normalizeAppInfo: an unrelated body (e.g. the bot probe) is not mistaken for app info', () => {
  assert.equal(normalizeAppInfo({ bot: { open_id: 'ou_1' } }).ok, false)
})

test('fetchAppIdentity: missing scope ⇒ name/avatar still returned, desc degrades to an actionable hint', async () => {
  const client = { request: async ({ url }) => {
    if (url.includes('/bot/v3/info')) return { bot: { open_id: 'ou_1', app_name: 'SintBot', avatar_url: 'https://x/a.png', activate_status: 2 } }
    throw larkErr(99991672, 'Access denied. One of the following scopes is required: [admin:app.info:readonly, application:application:self_manage]')
  } }
  const id = await fetchAppIdentity(client, 'cli_1')
  assert.equal(id.appName, 'SintBot')       // 身份没被描述那半的失败拖垮
  assert.equal(id.avatarUrl, 'https://x/a.png')
  assert.equal(id.activateText, '已启用')
  assert.equal(id.descState, 'scope')
  assert.equal(id.descHint, APP_INFO_SCOPE_HINT)
  assert.match(id.descHint, /self_manage|app\.info/) // 提示里必须点名要开哪个权限
  assert.equal(identityCheck(id).status, 'warn')
})

test('fetchAppIdentity: scope granted ⇒ description read; v6 name wins over bot/v3', async () => {
  const client = { request: async ({ url }) => (url.includes('/bot/v3/info')
    ? { bot: { open_id: 'ou_1', app_name: '旧名', activate_status: 2 } }
    : { data: { app: { app_id: 'cli_1', app_name: '新名', description: '一句话描述', status: 1 } } }) }
  const id = await fetchAppIdentity(client, 'cli_1')
  assert.equal(id.appName, '新名')
  assert.equal(id.description, '一句话描述')
  assert.equal(id.descState, 'ok')
  assert.equal(identityCheck(id).status, 'ok')
})

test('fetchAppIdentity: 描述为空(权限已开)≠ 缺权限 — 结论与提示都不同', async () => {
  const client = { request: async ({ url }) => (url.includes('/bot/v3/info')
    ? { bot: { open_id: 'ou_1', app_name: 'SintBot', activate_status: 2 } }
    : { data: { app: { app_id: 'cli_1', app_name: 'SintBot', description: '', status: 1 } } }) }
  const id = await fetchAppIdentity(client, 'cli_1')
  assert.equal(id.descState, 'ok')                 // 权限是通的,没什么要修
  assert.doesNotMatch(id.descHint, /self_manage/)  // 不能反过来叫人去开一个已经开着的权限
  assert.equal(identityCheck(id).status, 'ok')     // 未填描述不是故障
})

test('fetchAppIdentity: no appId ⇒ skip (不冒充失败), bot half still returned', async () => {
  const client = { request: async () => ({ bot: { open_id: 'ou_1', app_name: 'SintBot', activate_status: 2 } }) }
  const id = await fetchAppIdentity(client, '')
  assert.equal(id.appName, 'SintBot')
  assert.equal(id.descState, 'skip')
  assert.equal(identityCheck(id).status, 'skip')
})

test('fetchAppIdentity: bot half failing propagates (bad creds / no bot capability)', async () => {
  const client = { request: async () => { throw larkErr(11205, 'app do not have bot') } }
  await assert.rejects(() => fetchAppIdentity(client, 'cli_1'))
})

test('feishuPrecheck: all-green when every probe succeeds; captures botOpenId', async () => {
  const client = {
    request: async () => ({ bot: { open_id: 'ou_bot' } }),
    im: { chat: { list: async () => ({ data: { items: [{ chat_id: 'oc_1', name: 'G' }], has_more: false } }) } },
    cardkit: { v1: { card: { create: async () => ({ data: { card_id: 'c1' } }) } } },
    contact: { user: { get: async () => ({ data: { user: { name: 'Bot' } } }), batchGetId: async () => ({ data: { user_list: [] } }), findByDepartment: async () => ({ data: { items: [{ open_id: 'ou_a', name: '王五' }] } }) } },
  }
  const r = await feishuPrecheck(client)
  assert.equal(r.botOpenId, 'ou_bot')
  const by = Object.fromEntries(r.checks.map((c) => [c.key, c.status]))
  // appinfo=skip:没传 appId ⇒ 查不了应用描述,但那不是故障(名称/头像仍来自 bot 那半)
  assert.deepEqual(by, { bot: 'ok', appinfo: 'skip', 'im:chat': 'ok', cardkit: 'ok', contact: 'ok', 'contact-name': 'ok', 'contact-id': 'ok', board: 'ok' })
})

test('feishuPrecheck: 凭证不对(换不到 tenant_access_token)⇒ bot=fail 给核对凭证的提示,其余各项一律「未验」,不假绿', async () => {
  const tokenErr = () => { throw new Error('failed to get tenant_access_token, code: 10003, msg: invalid param') }
  const client = {
    request: async () => tokenErr(),
    im: { chat: { list: async () => tokenErr() } },
    cardkit: { v1: { card: { create: async () => tokenErr() } } },
    contact: { user: { get: async () => tokenErr(), batchGetId: async () => tokenErr(), findByDepartment: async () => tokenErr() } },
  }
  const r = await feishuPrecheck(client)
  assert.equal(r.botOpenId, null)
  const c = Object.fromEntries(r.checks.map((x) => [x.key, x]))
  assert.equal(c.bot.status, 'fail'); assert.match(c.bot.detail, /App ID 与 App Secret/)
  for (const k of ['im:chat', 'cardkit', 'contact', 'contact-name', 'contact-id', 'board']) assert.equal(c[k].status, 'skip', k)
  assert.ok(!r.checks.some((x) => x.status === 'ok'), '凭证不通时不能有任何一项 ✓')
})

test('feishuPrecheck: 11205 ⇒ bot=fail with capability hint; missing scope ⇒ warn (not fail)', async () => {
  const client = {
    request: async () => { throw larkErr(11205, 'app do not have bot') },
    im: { chat: { list: async () => { throw larkErr(99991672, 'Access denied. scope [im:chat]') } } },
    cardkit: { v1: { card: { create: async () => { throw larkErr(99991672, 'permission denied') } } } },
    contact: { user: { get: async () => ({}), batchGetId: async () => { throw larkErr(99991672, 'Access denied scope contact:user.id') } } },
  }
  const r = await feishuPrecheck(client)
  assert.equal(r.botOpenId, null)
  const c = Object.fromEntries(r.checks.map((x) => [x.key, x]))
  assert.equal(c.bot.status, 'fail')
  assert.match(c.bot.detail, /机器人|发布/)          // actionable 11205 fix, not raw axios line
  assert.equal(c['im:chat'].status, 'warn')          // degrades gracefully → warn, not hard blocker
  assert.match(c['im:chat'].detail, /im:chat/)
  assert.equal(c.cardkit.status, 'warn')
  assert.equal(c.contact.status, 'skip')             // no botOpenId ⇒ can't probe contact
  assert.equal(c['contact-id'].status, 'warn')       // missing email-lookup scope ⇒ warn
  assert.equal(c['contact-name'].status, 'skip')     // SDK 无部门成员接口 ⇒ 判不了就说判不了,不假绿
})

// v0.11.49:探针原先只 try/catch 不查 code。cardkit 的业务错误是 **HTTP 200 + code≠0**(SDK 不抛),
// 所以只要飞书对缺权限走的是这条路,doctor 就会报「流式打字机卡片可用」——「假绿」是本项目最贵
// 的一类:真到用的时候卡建不出来,而体检早说过没问题。⚠ 上面那条 11205 用例走的是**抛异常**那条
// 路,它全绿并不能证明这一条 —— 两条路要各有一个用例。
test('feishuPrecheck: cardkit 返 200+code≠0(SDK 不抛)必须报 warn,不许假绿', async () => {
  const client = {
    request: async () => ({ bot: { open_id: 'ou_bot' } }),
    im: { chat: { list: async () => ({ data: { items: [], has_more: false } }) } },
    cardkit: { v1: { card: { create: async () => ({ code: 99991672, msg: 'Access denied. scope [cardkit:card:write]' }) } } },
    contact: { user: { get: async () => ({ data: { user: { name: 'Bot' } } }), batchGetId: async () => ({ data: { user_list: [] } }) } },
  }
  const c = Object.fromEntries((await feishuPrecheck(client)).checks.map((x) => [x.key, x]))
  assert.equal(c.cardkit.status, 'warn', '被拒却报 ok = 假绿')
  assert.match(c.cardkit.detail, /cardkit:card:write/, '要点名该开哪个权限')
  assert.match(c.cardkit.detail, /99991672/, '码要留在提示里,msg 是给人看的、码才查得到文档')
})

// 对照:code=0 仍是 ok —— 上面那条若靠「一律 warn」也能过,这条就是它的分辨力。
test('feishuPrecheck: cardkit code=0 照旧报 ok(新加的门不许误伤正常情形)', async () => {
  const client = {
    request: async () => ({ bot: { open_id: 'ou_bot' } }),
    im: { chat: { list: async () => ({ data: { items: [], has_more: false } }) } },
    cardkit: { v1: { card: { create: async () => ({ code: 0, data: { card_id: 'c1' } }) } } },
    contact: { user: { get: async () => ({ data: { user: { name: 'Bot' } } }), batchGetId: async () => ({ data: { user_list: [] } }) } },
  }
  const c = Object.fromEntries((await feishuPrecheck(client)).checks.map((x) => [x.key, x]))
  assert.equal(c.cardkit.status, 'ok')
})

test('resolveContactToOpenId: an email query → openId via the emails batch', async () => {
  const client = { contact: { user: { batchGetId: async (o) => {
    assert.equal(o.params.user_id_type, 'open_id'); assert.deepEqual(o.data.emails, ['a@b.com']); assert.equal(o.data.mobiles, undefined)
    return { data: { user_list: [{ user_id: 'ou_hit', email: 'a@b.com' }] } }
  } } } }
  assert.deepEqual(await resolveContactToOpenId(client, 'a@b.com'), { openId: 'ou_hit', query: 'a@b.com' })
})

test('resolveContactToOpenId: a non-email query → mobiles batch', async () => {
  let seen
  const client = { contact: { user: { batchGetId: async (o) => { seen = o.data; return { data: { user_list: [{ user_id: 'ou_m' }] } } } } } }
  const r = await resolveContactToOpenId(client, '13800000000')
  assert.deepEqual(seen, { mobiles: ['13800000000'] })
  assert.deepEqual(r, { openId: 'ou_m', query: '13800000000' })
})

test('resolveContactToOpenId: openId null when the contact is not a registered Feishu user', async () => {
  const client = { contact: { user: { batchGetId: async () => ({ data: { user_list: [{ email: 'x@y.com' }] } }) } } }
  assert.deepEqual(await resolveContactToOpenId(client, 'x@y.com'), { openId: null, query: 'x@y.com' })
})

test('fetchAdminCandidates: dedups members across chats and excludes the bot', async () => {
  const membersByChat = {
    oc_1: [{ member_id: 'ou_bot', name: 'Bot' }, { member_id: 'ou_a', name: '王五' }],
    oc_2: [{ member_id: 'ou_a', name: '王五' }, { member_id: 'ou_b', name: '李四' }],
  }
  const client = {
    im: {
      chat: { list: async () => ({ data: { items: [{ chat_id: 'oc_1', name: 'G1' }, { chat_id: 'oc_2', name: 'G2' }], has_more: false } }) },
      chatMembers: { get: async (o) => ({ data: { items: membersByChat[o.path.chat_id], has_more: false } }) },
    },
  }
  assert.deepEqual(await fetchAdminCandidates(client, 'ou_bot'),
    [{ openId: 'ou_a', name: '王五' }, { openId: 'ou_b', name: '李四' }])
})

test('fetchOrgUsers: authorized scope → subtree → find_by_department, dedups, skips unreadable', async () => {
  const usersByDept = { root: [], d1: [{ open_id: 'ou_a', name: 'A' }], d2: [{ open_id: 'ou_a', name: 'dup' }, { open_id: 'ou_b', name: 'B' }], d3: null }
  const client = { contact: {
    scope: { list: async () => ({ data: { department_ids: ['root'], user_ids: [], has_more: false } }) },
    department: { children: async () => ({ data: { items: [{ open_department_id: 'd1' }, { open_department_id: 'd2' }, { open_department_id: 'd3' }], has_more: false } }) },
    user: {
      findByDepartment: async (o) => { const id = o.params.department_id; if (usersByDept[id] === null) throw new Error('no perm'); return { data: { items: usersByDept[id] || [], has_more: false } } },
      batch: async () => ({ data: { items: [] } }),
    },
  } }
  const r = await fetchOrgUsers(client)
  assert.deepEqual(r.users, [{ openId: 'ou_a', name: 'A' }, { openId: 'ou_b', name: 'B' }])
  assert.equal(r.truncated, false)
})

test('fetchOrgUsers: honors the maxUsers cap and flags truncated', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ open_id: 'ou_' + i, name: 'U' + i }))
  const client = { contact: {
    scope: { list: async () => ({ data: { department_ids: ['d1'], user_ids: [], has_more: false } }) },
    department: { children: async () => ({ data: { items: [], has_more: false } }) },
    user: { findByDepartment: async () => ({ data: { items: many, has_more: false } }), batch: async () => ({ data: { items: [] } }) },
  } }
  const r = await fetchOrgUsers(client, { maxUsers: 3 })
  assert.equal(r.users.length, 3)
  assert.equal(r.truncated, true)
})

test('fetchOrgUsers: folds in directly-authorized users (scope user_ids) via user.batch', async () => {
  const client = { contact: {
    scope: { list: async () => ({ data: { department_ids: [], user_ids: ['ou_direct'], has_more: false } }) },
    department: { children: async () => ({ data: { items: [], has_more: false } }) },
    user: {
      findByDepartment: async () => ({ data: { items: [], has_more: false } }),
      batch: async (o) => { assert.deepEqual(o.params.user_ids, ['ou_direct']); return { data: { items: [{ open_id: 'ou_direct', name: '直属' }] } } },
    },
  } }
  assert.deepEqual((await fetchOrgUsers(client)).users, [{ openId: 'ou_direct', name: '直属' }])
})

// ── Base skill: read/manage group messages (history/reply/edit/recall/download/react) ──
const { fetchChatHistory, replyMessage, editMessage, recallMessage, downloadResource, reactMessage, normalizeEmoji } = require('../../src/platform/feishu')

test('fetchChatHistory: maps list items to structured records; image body → null text', async () => {
  let captured
  const client = { im: { message: { list: async (o) => { captured = o; return { data: { items: [
    { message_id: 'om_1', sender: { id: 'ou_a', sender_type: 'user' }, create_time: '1700000000000', msg_type: 'text', body: { content: JSON.stringify({ text: 'hi' }) } },
    { message_id: 'om_2', sender: { id: 'cli_bot', sender_type: 'app' }, create_time: '1700000001000', msg_type: 'image', body: { content: '{}' } },
    // @ 了别人(真机上 16% 的真人消息是这种,按设计不触发轮次)—— id 可能是字符串也可能是对象,两种都要认
    { message_id: 'om_3', sender: { id: 'ou_a', sender_type: 'user' }, create_time: '1700000002000', msg_type: 'text', body: { content: JSON.stringify({ text: '@_user_1 看一下' }) },
      mentions: [{ key: '@_user_1', id: 'ou_lilei', id_type: 'open_id', name: '李雷' }, { key: '@_user_2', id: { open_id: 'ou_bot' }, name: 'SintBot' }] },
  ] } } } } } }
  const r = await fetchChatHistory(client, 'oc_x', 5)
  assert.equal(captured.params.container_id_type, 'chat')
  assert.equal(captured.params.container_id, 'oc_x')
  assert.equal(captured.params.page_size, 5)
  assert.deepEqual(r[0], { msgId: 'om_1', senderId: 'ou_a', senderType: 'user', createTimeMs: 1700000000000, msgType: 'text', text: 'hi', mentions: [] })
  assert.equal(r[1].text, null) // non-text (image) → parseText returns null
  assert.equal(r[1].senderType, 'app')
  assert.deepEqual(r[2].mentions, [{ id: 'ou_lilei', name: '李雷' }, { id: 'ou_bot', name: 'SintBot' }], 'mentions 带出来:字符串 id 与 {open_id} 对象都认')
  assert.equal(r[2].text, '看一下', '⚠ 对照组:parseText 一个字都没动 —— 正文里的占位符照旧抹掉(实时收信那条路也用它)')
})

test('接线:bin 里用到的 feishu 导出,require 解构里必须都有 —— v0.11.68 漏了 historyAtMark,生产机上 history 当场崩', () => {
  // ⚠ 「判断写在调用方,单测只测得到纯函数」那一族:node --check 只查语法,ReferenceError 要跑到那一行才炸。
  //   这条把「bin 调用了 X」与「bin 导入了 X」钉在一起 —— 对 feishu.js 的每个导出都查,不只这一个。
  const fs = require('node:fs'), path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'bin', 'sbot.js'), 'utf8')
  const m = /const \{([^}]+)\} = require\('\.\.\/src\/platform\/feishu(?:\.js)?'\)/.exec(src)
  assert.ok(m, '没扫到 bin 对 feishu 的 require 解构')
  const imported = new Set(m[1].split(',').map((s) => s.trim().split(/\s*:\s*/).pop()).filter(Boolean))
  const exported = Object.keys(require('../../src/platform/feishu.js'))
  const missing = exported.filter((name) => !imported.has(name) && new RegExp('(?<![\\w.$])' + name + '\\s*\\(').test(src))
  assert.deepEqual(missing, [], 'bin 里调用了但没导入(会在运行时 ReferenceError):' + missing.join(', '))
  assert.ok(imported.has('historyAtMark') && imported.size > 20, '对照组:解构真扫到了,且含这次漏的那个')
})

test('historyAtMark: @bot / @别人未@bot / 都@ / 没@;bot id 是占位符时只列名字', () => {
  const { historyAtMark } = require('../../src/platform/feishu.js')
  assert.equal(historyAtMark([], 'ou_bot'), '', '没 @ 任何人 ⇒ 空')
  assert.equal(historyAtMark([{ id: 'ou_lilei', name: '李雷' }], 'ou_bot'), ' →@李雷·未@bot', '⭐ 这正是要分开的那种:@了别人、没@bot')
  assert.equal(historyAtMark([{ id: 'ou_bot', name: 'SintBot' }], 'ou_bot'), ' →@bot')
  assert.equal(historyAtMark([{ id: 'ou_bot', name: 'SintBot' }, { id: 'ou_lilei', name: '李雷' }], 'ou_bot'), ' →@bot·李雷')
  assert.equal(historyAtMark([{ id: 'ou_lilei', name: '' }], 'ou_bot'), ' →@ou_lilei…·未@bot', '没名字就给 id 前缀')
  assert.equal(historyAtMark([{ id: 'ou_bot', name: 'SintBot' }], 'ou_xPLACEHOLDER'), ' →@SintBot·未@bot', 'bot id 是占位符 ⇒ 不判 bot,只列名字(别把「不知道」说成「没@」以外的东西)')
})

test('fetchChatHistory: clamps N into [1,50]; 0/blank → default 20', async () => {
  let size
  const client = { im: { message: { list: async (o) => { size = o.params.page_size; return { data: { items: [] } } } } } }
  await fetchChatHistory(client, 'oc_x', 999); assert.equal(size, 50)
  await fetchChatHistory(client, 'oc_x', 0); assert.equal(size, 20)
  await fetchChatHistory(client, 'oc_x', -3); assert.equal(size, 1)
})

test('reply/edit/recall/react hit the right message APIs with the right shape', async () => {
  const calls = []
  const client = { im: {
    message: { reply: async (o) => calls.push(['reply', o]), update: async (o) => calls.push(['update', o]), delete: async (o) => calls.push(['delete', o]) },
    messageReaction: { create: async (o) => calls.push(['react', o]) },
  } }
  await replyMessage(client, 'om_1', 'hi')
  await editMessage(client, 'om_1', 'edited')
  await recallMessage(client, 'om_1')
  await reactMessage(client, 'om_1', '👍')
  assert.deepEqual(calls[0][1].path, { message_id: 'om_1' }); assert.equal(JSON.parse(calls[0][1].data.content).text, 'hi')
  assert.equal(calls[1][0], 'update'); assert.equal(JSON.parse(calls[1][1].data.content).text, 'edited')
  assert.equal(calls[2][0], 'delete'); assert.deepEqual(calls[2][1].path, { message_id: 'om_1' })
  assert.equal(calls[3][1].data.reaction_type.emoji_type, 'THUMBSUP') // 👍 alias → enum
})

test('normalizeEmoji: aliases map; otherwise upper-cased', () => {
  assert.equal(normalizeEmoji('👍'), 'THUMBSUP')
  assert.equal(normalizeEmoji('赞'), 'THUMBSUP')
  assert.equal(normalizeEmoji('heart'), 'HEART')   // not an alias → upper-cased
  assert.equal(normalizeEmoji('THUMBSUP'), 'THUMBSUP')
})

test('downloadResource: streams to the fenced path via SDK writeFile', async () => {
  let getArgs, wrote
  const client = { im: { messageResource: { get: async (o) => { getArgs = o; return { writeFile: async (p) => { wrote = p } } } } } }
  await downloadResource(client, 'om_1', 'file_v2_x', 'image', '/proj/pic.png')
  assert.deepEqual(getArgs.path, { message_id: 'om_1', file_key: 'file_v2_x' })
  assert.equal(getArgs.params.type, 'image')
  assert.equal(wrote, '/proj/pic.png')
})

test('downloadResource: throws when the SDK returns no stream', async () => {
  const client = { im: { messageResource: { get: async () => ({}) } } }
  await assert.rejects(() => downloadResource(client, 'om_1', 'k', 'file', '/x'), /未返回资源流/)
})

// ── 流式卡片节流(v0.7.6):砍 cardElement.content 调用数,累积文本丢中间帧无损 ──

test('cardThrottle: intervalMs=0 ⇒ 逐帧推(旧行为不变)', () => {
  const { th, sent } = throttleHarness(0)
  th.push('a'); th.push('ab'); th.push('abc')
  assert.deepEqual(sent, ['a', 'ab', 'abc'])
})

test('cardThrottle: 首帧不等待(首字尽快落地)', () => {
  const { th, sent } = throttleHarness(1500)
  th.push('a')
  assert.deepEqual(sent, ['a'])
})

test('cardThrottle: 窗内多帧只在窗到时补发最后一帧(trailing)', () => {
  const { th, sent, adv } = throttleHarness(1500)
  th.push('a')            // 首帧立即
  adv(100); th.push('ab') // 窗内 → 攒着
  adv(100); th.push('abc')
  assert.deepEqual(sent, ['a'], '窗内不再推')
  adv(1400)               // 窗到 → trailing 补最后一帧,中间的 'ab' 被丢弃(无损)
  assert.deepEqual(sent, ['a', 'abc'])
})

test('cardThrottle: 窗过后的更新立即推,不必等下一个 tick', () => {
  const { th, sent, adv } = throttleHarness(1500)
  th.push('a')
  adv(2000)
  th.push('ab')
  assert.deepEqual(sent, ['a', 'ab'])
})

test('cardThrottle: 挂起帧只排一个定时器(不堆积)', () => {
  const { th, timers, adv } = throttleHarness(1500)
  th.push('a')
  adv(10); th.push('ab'); th.push('abc'); th.push('abcd')
  assert.equal(timers.length, 1)
})

test('cardThrottle: drain 交出未推文本并取消定时器(finish 兜底的尾巴)', () => {
  const { th, sent, timers, adv } = throttleHarness(1500)
  th.push('a')
  adv(10); th.push('ab')
  assert.equal(th.drain(), 'ab', '未推的尾巴交给 finish')
  assert.equal(timers.length, 0, '定时器已取消')
  adv(5000)
  assert.deepEqual(sent, ['a'], 'drain 后定时器不再触发')
})

test('cardThrottle: 全部推完时 drain 返回 null(finish 不重复推)', () => {
  const { th, adv } = throttleHarness(1500)
  th.push('a')
  adv(2000)
  assert.equal(th.drain(), null)
})

// ⚠ 配额账已经不在这儿了(v0.11.49 收进写入器,那边才数得到降级后的整卡更新与收尾那次)。
// 节流器只回答一件事:攒了几帧、最后落地的是不是最新那帧。
test('cardThrottle: lastSent 是最新那帧,窗内多帧只落一次', () => {
  const { th, sent, adv } = throttleHarness(1500)
  th.push('a')
  adv(50); th.push('ab')
  adv(50); th.push('abc')
  adv(1500)
  assert.equal(th.lastSent(), 'abc')
  assert.deepEqual(sent, ['a', 'abc'], '3 次 update 只落 2 次派发')
})

// ── 附件标记(v0.12.0):图片/文件消息不再丢弃,转成带下载坐标的文本标记 ──

test('parseText: 纯图片消息 → [图片 …] 标记(带 message_id 与 key)', () => {
  const t = parseText({ message_type: 'image', message_id: 'om_1', content: JSON.stringify({ image_key: 'img_v2_abc' }) })
  assert.equal(t, '[图片 message_id=om_1 key=img_v2_abc]')
})

test('parseText: 文件消息 → [文件 名字 …] 标记;坏内容仍 null', () => {
  const t = parseText({ message_type: 'file', message_id: 'om_2', content: JSON.stringify({ file_key: 'file_x', file_name: '报表.xlsx' }) })
  assert.equal(t, '[文件 报表.xlsx message_id=om_2 key=file_x]')
  assert.equal(parseText({ message_type: 'image', message_id: 'om_3', content: '{}' }), null) // 没 key 的按无内容
})

test('parseText: 富文本(post)里的图与文字一起到,顺序保留', () => {
  const content = JSON.stringify({ content: [[{ tag: 'text', text: '看这张截图' }, { tag: 'img', image_key: 'img_p1' }, { tag: 'text', text: '右上角报错' }]] })
  const t = parseText({ message_type: 'post', message_id: 'om_4', content })
  assert.equal(t, '看这张截图 [图片 message_id=om_4 key=img_p1] 右上角报错')
})

test('parseText: 表情包等其它类型仍不进轮(null);text/link 行为零回归', () => {
  assert.equal(parseText({ message_type: 'sticker', message_id: 'om_5', content: JSON.stringify({ file_key: 'stk' }) }), null)
  assert.equal(parseText({ message_type: 'text', message_id: 'om_6', content: JSON.stringify({ text: 'hi @_user_1 there' }) }), 'hi there')
})

// ── 卡片写入器:流式 10 分钟窗口(v0.11.48)────────────────────────────────────
// 背景:飞书的流式更新模式**开启后 10 分钟自动关闭**,之后 cardElement.content 一律回
// 300309,而 SDK 对业务错误(HTTP 200 + code≠0)**不抛** ⇒ 推送静默失败、引擎当答案已送达。
// 2026-08-21 DemoApp 实测:24 分钟的一轮,群里那张卡停在第 10 分钟的脉搏上,活白干,
// 而日志/账本/控制台三处都写着 ok。下面每条都对着这次事故的一个环节。

function writerHarness({
  intervalMs = 0, streamWindowMs = 9 * 60 * 1000,
  pushReply = () => ({ code: 0 }), updateReply = () => ({ code: 0 }), settingsReply = () => ({ code: 0 }),
} = {}) {
  let t = 1_000_000
  const calls = [] // 每次 API 调用记一条,用它区分「走的哪条路」
  const logs = []
  const client = {
    cardkit: {
      v1: {
        cardElement: { content: async ({ data }) => { calls.push({ api: 'push', seq: data.sequence, body: data.content }); return pushReply(data) } },
        card: {
          update: async ({ data }) => { calls.push({ api: 'full', seq: data.sequence, body: JSON.parse(data.card.data).body.elements }); return updateReply(data) },
          settings: async ({ data }) => { calls.push({ api: 'settings', seq: data.sequence }); return settingsReply(data) },
        },
      },
    },
  }
  const w = createCardWriter({
    client, cardId: 'c1', log: (m) => logs.push(m), now: () => t,
    throttleMs: intervalMs, streamWindowMs,
    setTimer: (fn) => ({ fn }), clearTimer: () => {},
  })
  return { w, calls, logs, adv(ms) { t += ms }, apis: () => calls.map((c) => c.api) }
}

test('cardWriter: 流式窗口内 update 走流式推送(打字机动画保住)', async () => {
  const h = writerHarness()
  h.w.update('abc')
  await h.w.settle()
  assert.deepEqual(h.apis(), ['push'])
  assert.equal(h.calls[0].body, 'abc')
})

test('cardWriter: 跨过流式窗口后 update 改走整卡更新,不再调已失效的流式接口', async () => {
  const h = writerHarness()
  h.w.update('a'); await h.w.settle()
  h.adv(9 * 60 * 1000) // 越过窗口
  h.w.update('ab'); await h.w.settle()
  assert.deepEqual(h.apis(), ['push', 'full'], '第二帧必须改道')
  assert.equal(h.calls[1].body[0].content, 'ab', '正文照样落地')
})

test('cardWriter: 流式被 300309 拒 ⇒ 当场降级整卡更新,那一帧不丢', async () => {
  let n = 0
  const h = writerHarness({ pushReply: () => (++n === 1 ? { code: 0 } : { code: 300309, msg: 'ErrMsg: streaming mode is closed; ' }) })
  h.w.update('a'); await h.w.settle()
  h.w.update('ab'); await h.w.settle()
  assert.deepEqual(h.apis(), ['push', 'push', 'full'])
  assert.equal(h.calls[2].body[0].content, 'ab', '被拒的那一帧改由整卡更新落地')
  h.w.update('abc'); await h.w.settle()
  assert.deepEqual(h.apis(), ['push', 'push', 'full', 'full'], '降级之后不再白试流式')
})

// ⚠ 撞线那一刻回的是 200850,之后才一直是 300309(真机 12 分钟探针实测,两个码都出现过)。
// 只认 300309 的话,恰好撞线的那一帧会被当成真错误抛掉 —— 丢的正好是「刚过 10 分钟」那一帧。
test('cardWriter: 流式回 200850(撞线那一刻的超时码)同样降级,不当成真错误', async () => {
  let n = 0
  const h = writerHarness({ pushReply: () => (++n === 1 ? { code: 0 } : { code: 200850, msg: 'ErrMsg: card streaming timeout; ' }) })
  h.w.update('a'); await h.w.settle()
  h.w.update('ab'); await h.w.settle()
  assert.deepEqual(h.apis(), ['push', 'push', 'full'])
  assert.equal(h.calls[2].body[0].content, 'ab', '撞线那一帧必须由整卡更新补上')
  assert.ok(!h.logs.some((l) => /card op error/.test(l)), '这是到期不是故障,不该记成错误:' + JSON.stringify(h.logs))
})

test('cardWriter: 流式回其它错误码 ⇒ 记进日志,绝不静默当成功(这次事故的根因之一)', async () => {
  const h = writerHarness({ pushReply: () => ({ code: 99991400, msg: 'too many request' }) })
  h.w.update('a')
  await h.w.settle()
  assert.ok(h.logs.some((l) => /card op error/.test(l) && /99991400|too many request/.test(l)), '错误必须出现在日志里:' + JSON.stringify(h.logs))
  assert.deepEqual(h.apis(), ['push'], '只有 300309 才降级,其它错误不改道')
})

test('cardWriter: finish 的最终正文走整卡更新 —— 长任务的答案原先就丢在流式那条路上', async () => {
  const h = writerHarness()
  h.w.update('写到一半'); await h.w.settle()
  assert.equal(await h.w.finish('完整答案'), true, '最终正文得到明确确认')
  assert.deepEqual(h.apis(), ['push', 'full'])
  assert.equal(h.calls[1].body[0].content, '完整答案')
})

test('cardWriter: 最终整卡更新被业务拒绝时不得确认终结', async () => {
  const h = writerHarness({ updateReply: () => ({ code: 9499, msg: 'bad card json' }) })
  assert.equal(await h.w.finish('最终答案'), null)
  assert.equal(await h.w.finish('最终答案'), null, '重复收尾不能把失败改报成功')
  assert.deepEqual(h.apis(), ['full'])
  assert.ok(h.logs.some((line) => /card op error/.test(line) && /9499/.test(line)))
})

test('cardWriter: 最终更新缺少明确 code=0 时不得确认终结', async () => {
  const h = writerHarness({ updateReply: () => ({}) })
  assert.equal(await h.w.finish('最终答案'), null)
  assert.deepEqual(h.apis(), ['full'])
})

test('cardWriter: 流式帧被拒后同文收尾仍须整卡落地', async () => {
  const h = writerHarness({ pushReply: () => ({ code: 99991400, msg: 'too many request' }) })
  h.w.update('最终答案'); await h.w.settle()
  assert.equal(await h.w.finish('最终答案'), true)
  assert.deepEqual(h.apis(), ['push', 'full'], '已派发但未确认的流式帧不能跳过终结写入')
  assert.equal(h.calls[1].body[0].content, '最终答案')
})

test('cardWriter: finish 跨过窗口后照样把答案落地(整卡更新不受 10 分钟限制)', async () => {
  const h = writerHarness()
  h.w.update('进度'); await h.w.settle()
  h.adv(24 * 60 * 1000) // 24 分钟的一轮,正是事故现场那一轮的时长
  await h.w.finish('这一轮的结论')
  assert.equal(h.calls.at(-1).api, 'full')
  assert.equal(h.calls.at(-1).body[0].content, '这一轮的结论')
  assert.ok(!h.apis().slice(1).includes('push'), '窗口外一次流式都不该再调')
})

test('cardWriter: finish 无新正文 ⇒ 只关流式,绝不拿空正文把卡刷空', async () => {
  const h = writerHarness()
  h.w.update('已收到,正在处理…'); await h.w.settle()
  assert.equal(await h.w.finish('已收到,正在处理…'), true) // 与最后一帧相同,已确认的正文仍可确认终结
  assert.deepEqual(h.apis(), ['push', 'settings'])
})

test('cardWriter: 关流式被拒时不得把已确认正文误作已收尾', async () => {
  const h = writerHarness({ settingsReply: () => ({ code: 9499, msg: 'permission denied' }) })
  h.w.update('最终答案'); await h.w.settle()
  assert.equal(await h.w.finish('最终答案'), null)
  assert.deepEqual(h.apis(), ['push', 'settings'])
})

test('cardWriter: finish 空文本 ⇒ 不写正文(ack 后转静默那条路)', async () => {
  const h = writerHarness()
  h.w.update('ack'); await h.w.settle()
  await h.w.finish('')
  assert.deepEqual(h.apis(), ['push', 'settings'])
})

test('cardWriter: 关流式时服务端已自动关闭(300309)不算错误', async () => {
  const h = writerHarness({ settingsReply: () => ({ code: 300309, msg: 'streaming mode is closed' }) })
  h.w.update('a'); await h.w.settle()
  await h.w.finish('a')
  assert.deepEqual(h.apis(), ['push', 'settings'])
  assert.ok(!h.logs.some((l) => /card op error/.test(l)), '自动关闭是既成事实,不该报错:' + JSON.stringify(h.logs))
})

// 序号由一个分配器统一发,流式与整卡更新混用同一张卡也必须严格递增 —— 倒退会被服务端
// 以 300317 拒掉(真机实测),而被拒的那一帧就是丢掉的那一帧。
// ⚠ 必须有**两帧流式**:只推一帧时,把序号写死成常量也照样「递增」,那样的断言等于没写。
test('cardWriter: 流式与整卡更新混用同一张卡,序号严格递增', async () => {
  const h = writerHarness()
  h.w.update('a'); await h.w.settle()
  h.w.update('ab'); await h.w.settle()
  h.adv(9 * 60 * 1000)
  h.w.update('abc'); await h.w.settle()
  await h.w.finish('abcd')
  const seqs = h.calls.map((c) => c.seq)
  assert.equal(seqs.length, 4)
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], '序号必须递增,实际:' + seqs.join(','))
})

test('cardWriter: finish 含表格 ⇒ 整卡更新用原生 table 元素', async () => {
  const h = writerHarness()
  await h.w.finish('查询结果:\n\n' + RANK_TABLE, { buildElements: answerCardElements })
  assert.deepEqual(h.apis(), ['full'])
  assert.ok(h.calls[0].body.some((e) => e.tag === 'table'), '表格该被渲染成原生组件')
})

test('cardWriter: 表格整卡更新被拒 ⇒ 退回 markdown 整卡更新,内容一个字不丢', async () => {
  let n = 0
  const h = writerHarness({ updateReply: () => (++n === 1 ? { code: 9499, msg: 'bad card json' } : { code: 0 }) })
  const text = '查询结果:\n\n' + RANK_TABLE
  await h.w.finish(text, { buildElements: answerCardElements })
  assert.deepEqual(h.apis(), ['full', 'full'])
  assert.equal(h.calls[1].body[0].content, text, '退回时正文原样落地')
  assert.ok(h.logs.some((l) => /table render fallback/.test(l)))
})

test('cardWriter: 表格和 markdown 两次终结更新都被拒时不得确认', async () => {
  const h = writerHarness({ updateReply: () => ({ code: 9499, msg: 'bad card json' }) })
  assert.equal(await h.w.finish('查询结果:\n\n' + RANK_TABLE, { buildElements: answerCardElements }), null)
  assert.deepEqual(h.apis(), ['full', 'full'])
})

test('cardWriter: markClosed 之后 update 不再受理(recall 先断写入再删消息)', async () => {
  const h = writerHarness()
  h.w.markClosed()
  h.w.update('晚到的一帧')
  await h.w.settle()
  assert.deepEqual(h.apis(), [], '撤回后不许再有任何写入打回来')
})

// 「已收尾」与「已冻结」必须是两件事:撤回失败时,调用方要退一句中性收尾(engine 的
// dropAckCard)。合成一个标记 ⇒ finish 空转 ⇒ 那张卡永远晾在「处理中」。
test('cardWriter: 冻结之后 finish 仍收得了尾 —— 撤不掉时才退得出中性句', async () => {
  const h = writerHarness()
  h.w.update('已收到,正在处理…'); await h.w.settle()
  h.w.markClosed()                       // recall 开始
  h.w.update('晚到的一帧'); await h.w.settle()
  assert.deepEqual(h.apis(), ['push'], '冻结后不再有新的流式帧')
  await h.w.finish('这条已经处理完了')      // recall 失败 ⇒ 退中性收尾
  assert.equal(h.calls.at(-1).api, 'full')
  assert.equal(h.calls.at(-1).body[0].content, '这条已经处理完了', '冻结不该把收尾一起封死')
})

// ── 配额账(v0.11.49):`card ops` 那行注释写着「配额账可实测」,原先它对不上账 ──────
// 原实现报的是节流器的**派发次数**、且打在收尾操作**之前** ⇒ 降级后的整卡更新混在「content
// push(es)」里、收尾自己那一次调用完全在账外。飞书租户级 100 万次/月是硬上限,这行是唯一的
// 实测入口,它报不准 = 那句注释是假的。
const cardOpsLine = (h) => h.logs.find((l) => /^card ops:/.test(l))

test('cardWriter: card ops 报的是真实调用次数 —— 降级后的整卡更新与收尾那次都在账内', async () => {
  const h = writerHarness()
  h.w.update('a'); await h.w.settle()        // 1 × 流式
  h.adv(9 * 60 * 1000)
  h.w.update('ab'); await h.w.settle()       // 1 × 整卡(跨窗降级)
  await h.w.finish('答案')                    // 1 × 整卡(收尾)
  assert.deepEqual(h.apis(), ['push', 'full', 'full'], '前提:真实调用就是这三次')
  const line = cardOpsLine(h)
  assert.ok(line, 'card ops 那行必须打出来:' + JSON.stringify(h.logs))
  assert.match(line, /3 次调用/, '总数要等于真实调用数(原实现报 2)')
  assert.match(line, /流式 1 · 整卡 2 · 关流式 0/, '三条路各报各的,混成一个数就看不出降级')
})

test('cardWriter: 只关流式那条路也记账(收尾不写正文 ≠ 不花配额)', async () => {
  const h = writerHarness()
  h.w.update('已收到,正在处理…'); await h.w.settle()
  await h.w.finish('已收到,正在处理…')
  assert.deepEqual(h.apis(), ['push', 'settings'])
  assert.match(cardOpsLine(h), /2 次调用\(流式 1 · 整卡 0 · 关流式 1\)/)
})

// ⚠ 记的是**调用次数**不是成功次数:被拒的请求同样发出去过。这条也是「fulls++ 摆在 await
// 之前还是之后」唯一能分辨的实验 —— 摆在之后,被拒的那次就漏了。
test('cardWriter: 被拒的调用照样进账 —— 表格被拒后退 markdown,账上是两次整卡更新', async () => {
  let n = 0
  const h = writerHarness({ updateReply: () => (++n === 1 ? { code: 9499, msg: 'bad card json' } : { code: 0 }) })
  await h.w.finish('查询结果:\n\n' + RANK_TABLE, { buildElements: answerCardElements })
  assert.equal(h.calls.filter((c) => c.api === 'full').length, 2, '前提:真的调了两次')
  assert.match(cardOpsLine(h), /2 次调用\(流式 0 · 整卡 2 · 关流式 0\)/)
})

// ── assertCardOk 的报错形态 ───────────────────────────────────────────────────
// msg 是给人看的,**码**才是能查文档、能和真机探针对上的那个东西(larkErrMsg 同形)。
test('assertCardOk: 被拒时报错带上错误码与来源动作;code=0 是空操作', () => {
  assert.throws(
    () => assertCardOk({ code: 300309, msg: 'ErrMsg: streaming mode is closed; ' }, '流式推送'),
    (e) => /^流式推送被拒:/.test(e.message) && /streaming mode is closed/.test(e.message)
        && /\[code 300309\]/.test(e.message) && !/ErrMsg|;/.test(e.message) && e.code === 300309,
  )
  assert.throws(() => assertCardOk({ code: 9499 }, '建卡'), /建卡被拒:\[code 9499\]/) // 没 msg 也得留下码
  const r = { code: 0, data: { card_id: 'c1' } }
  assert.equal(assertCardOk(r, '建卡'), r, 'code=0 原样返回 ⇒ 可以直接套在调用外面')
  assert.equal(assertCardOk(undefined), undefined) // SDK 偶尔返空,不该在这里炸
})

test('feishuPrecheck: 成员名字为空 ⇒ contact-name=warn(缺 contact:user.base:readonly,不许假绿)', async () => {
  const client = {
    request: async () => ({ bot: { open_id: 'ou_bot' } }),
    im: { chat: { list: async () => ({ data: { items: [], has_more: false } }) } },
    cardkit: { v1: { card: { create: async () => ({ data: { card_id: 'c1' } }) } } },
    contact: { user: { get: async () => ({}), batchGetId: async () => ({ data: { user_list: [] } }), findByDepartment: async () => ({ data: { items: [{ open_id: 'ou_a' }] } }) } },
  }
  const c = Object.fromEntries((await feishuPrecheck(client)).checks.map((x) => [x.key, x]))
  assert.equal(c['contact-name'].status, 'warn')
  assert.match(c['contact-name'].detail, /contact:user\.base:readonly/)
})

// 「过程」折叠区(v0.11.93):引擎认出的 `>> ` 里程碑收尾时交到这里,默认收起 —— 卡片仍只露答案。
test('answerCardElements: 里程碑折叠区 —— 无表格也出元素;表格照旧多挂一个;空数组零变化', () => {
  const els = answerCardElements('✅ 做好了', { milestones: ['登录弹层做完', '设置页截图已发'] })
  assert.deepEqual(els.map((e) => e.tag), ['markdown', 'collapsible_panel'])
  assert.equal(els[0].content, '✅ 做好了')
  assert.equal(els[1].expanded, false)
  assert.match(els[1].header.title.content, /过程\(2 步\)/)
  assert.equal(els[1].elements[0].content, '▶ 登录弹层做完\n▶ 设置页截图已发')
  const withTable = answerCardElements(RANK_TABLE, { milestones: ['a'] })
  assert.deepEqual(withTable.map((e) => e.tag), ['table', 'collapsible_panel', 'collapsible_panel'])
  assert.equal(answerCardElements('纯文本', { milestones: [] }), null)
  assert.equal(answerCardElements('纯文本'), null) // 对照组:老调用零变化
})

// ── 卡片底部小字:耗时与 tokens(2026-09-16 用户提,位置 = 「过程」之下、整卡最底)──────────
test('answerCardElements: 有 footer ⇒ 普通回答也出元素序列,末尾是一行灰色小字', () => {
  const els = answerCardElements('就是一段普通回答,没有表格', { footer: '耗时 3 秒 · tokens ↑1.2k ↓50' })
  assert.ok(Array.isArray(els) && els.length === 2, JSON.stringify(els))
  assert.deepEqual(els[0], { tag: 'markdown', content: '就是一段普通回答,没有表格' })
  assert.equal(els[1].tag, 'markdown')
  assert.equal(els[1].text_size, 'notation')                       // 小字形状与生图 / 接管卡同款
  assert.equal(els[1].text_align, 'right')                         // 右下角:靠右对齐
  assert.match(els[1].content, /^<font color='grey'>耗时 3 秒 · tokens ↑1\.2k ↓50<\/font>$/)
})

test('answerCardElements: footer 排在「过程」折叠区之下 —— 正文 → 可复制版 → 过程 → 小字', () => {
  const els = answerCardElements(RANK_TABLE, { milestones: ['查了数据', '核对口径'], footer: '耗时 12 秒' })
  const tags = els.map((e) => e.tag)
  assert.deepEqual(tags.slice(-3), ['collapsible_panel', 'collapsible_panel', 'markdown'])
  assert.match(els[els.length - 2].header.title.content, /过程/)   // 倒数第二个是「过程」
  assert.match(els[els.length - 1].content, /耗时 12 秒/)           // 最后一个是小字
})

test('answerCardElements: footer 为空白 ⇒ 与没给一样(无表格无里程碑仍返回 null)', () => {
  assert.equal(answerCardElements('普通回答', { footer: '   ' }), null)
  assert.equal(answerCardElements('普通回答', { footer: '' }), null)
})
