// Shared health check (behind `sbot doctor` + the console health pill). The
// `claude` probe row spawns a binary we intentionally point at a non-existent
// name, so it resolves fast to a fail — we assert on the deterministic rows.
//
// 所有用例都传隔离的 opts.home:浏览器探活读机器级 MCP 配置(~/.claude.json 等),
// 不隔离的话结果会随开发机本地配置漂移。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { checkHealth, whichSync } = require('../../src/health')

const base = () => ({ _path: '/some/config.json', agent: { bin: '__sbot_no_such_bin__', permissionMode: 'dontAsk' }, providers: {}, groups: {} })

// 空 home(无任何 MCP 配置)——大多数用例用它,保证没有 browser: 行混进来
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-health-'))
const check = (cfg) => checkHealth(cfg, { home: emptyHome })

test('whichSync: rejects directories and non-executable placeholders, finds a runnable alternative', { skip: process.platform === 'win32' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-which-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const first = path.join(dir, 'first'); const second = path.join(dir, 'second')
  fs.mkdirSync(first); fs.mkdirSync(second)
  const bad = path.join(first, 'claude'); const good = path.join(second, 'claude')
  fs.writeFileSync(bad, 'echo native binary not installed\n', { mode: 0o644 })
  fs.writeFileSync(good, '#!/bin/sh\necho "2.1.318 (Claude Code)"\n', { mode: 0o755 })
  assert.equal(whichSync(first), null)
  assert.equal(whichSync(bad), null)
  assert.equal(whichSync(good), good, 'control: an executable file is accepted')
  const oldPath = process.env.PATH
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath })
  process.env.PATH = [first, second].join(path.delimiter)
  assert.equal(whichSync('claude'), good)
})

test('health: 配置文件组 / 其他人可读 ⇒ config 行 warn 并给出 chmod 600;0600 ⇒ ok', { skip: process.platform === 'win32' }, async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-health-cfg-')), 'config.json')
  fs.writeFileSync(f, '{}')
  const row = async () => (await check({ ...base(), _path: f })).rows.find((r) => r.label === 'config')
  fs.chmodSync(f, 0o644)
  const loose = await row()
  assert.equal(loose.status, 'warn'); assert.match(loose.detail, /权限 644.*chmod 600/)
  fs.chmodSync(f, 0o600)
  const tight = await row()
  assert.equal(tight.status, 'ok'); assert.equal(tight.detail, f, '对照组:收紧后只报路径')
})

// 造一个带 browserUrl 指向的 home:claude 侧(~/.claude.json)/ codex 侧(config.toml)可选
function mkHome({ claudeUrl, codexUrl } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-health-'))
  if (claudeUrl) fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'chrome-devtools': { command: 'chrome-devtools-mcp', args: [`--browserUrl=${claudeUrl}`, '--screenshotFormat=jpeg'] } },
  }))
  if (codexUrl) {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
      `[mcp_servers.chrome-devtools]\ncommand = "chrome-devtools-mcp"\nargs = ["--browserUrl=${codexUrl}"]\n`)
  }
  return home
}

test('health: 一个聊天平台都没接 ⇒ 挂在 platforms 行,不挂在 feishu 行(没选飞书的人会看糊涂)', async () => {
  for (const cfg of [base(), { ...base(), feishu: {} }]) {
    const rows = (await check(cfg)).rows
    const r = rows.find((x) => /还没接聊天平台/.test(x.detail))
    assert.ok(r, 'no-platform row present')
    assert.equal(r.label, 'platforms')
    assert.equal(r.status, 'warn')
    assert.ok(!rows.some((x) => x.label === 'feishu'), 'no feishu row when feishu is not configured')
  }
})

test('health: returns rows plus fails/warns counts', async () => {
  const h = await check(base())
  assert.ok(Array.isArray(h.rows) && h.rows.length > 0)
  assert.equal(typeof h.fails, 'number')
  assert.equal(typeof h.warns, 'number')
})

test('health: permissionMode !== dontAsk warns', async () => {
  const cfg = base(); cfg.agent.permissionMode = 'default'
  const h = await check(cfg)
  assert.equal(h.rows.find((r) => r.label === 'permissionMode').status, 'warn')
})

test('health: key 型模型三态 —— 没 key warn;有 key 未验证 warn;验证通过 ok;验证失败在用 fail、没人用 warn;换 key 回到未验证', async () => {
  const verify = require('../../src/core/verify')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-health-v-'))
  const file = path.join(home, '.sbot', 'verify.json')
  const row = async (cfg) => (await checkHealth(cfg, { home })).rows.find((r) => r.label === 'provider:glm')
  assert.equal((await row({ ...base(), providers: { glm: { baseUrl: 'https://x' } } })).status, 'warn')
  const glm = { baseUrl: 'https://x', apiKey: 'k' }
  let r = await row({ ...base(), providers: { glm } })
  assert.equal(r.status, 'warn'); assert.match(r.detail, /还没验证/)
  verify.record(verify.providerFp(glm), true, '', { file })
  r = await row({ ...base(), providers: { glm } })
  assert.equal(r.status, 'ok'); assert.match(r.detail, /能用/)
  verify.record(verify.providerFp(glm), false, 'key 不对', { file })
  r = await row({ ...base(), providers: { glm } })
  assert.equal(r.status, 'warn', '没人用:只提醒'); assert.match(r.detail, /上次验证失败.*key 不对/)
  r = await row({ ...base(), defaultProvider: 'glm', providers: { glm } })
  assert.equal(r.status, 'fail', '默认模型:报错')
  r = await row({ ...base(), defaultProvider: 'glm', providers: { glm: { ...glm, apiKey: 'k2' } } })
  assert.equal(r.status, 'warn'); assert.match(r.detail, /还没验证/)
})

test('health: 飞书 / Slack 行看最近一次预检 —— 失败 fail,通过与未预检都是 ok 但说法不同', async () => {
  const verify = require('../../src/core/verify')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-health-p-'))
  const file = path.join(home, '.sbot', 'verify.json')
  const feishu = { appId: 'cli_a', appSecret: 's' }
  const slack = { botToken: 'xoxb-1', appToken: 'xapp-1' }
  const rows = async () => (await checkHealth({ ...base(), feishu, slack }, { home })).rows
  let rs = await rows()
  assert.match(rs.find((r) => r.label === 'feishu').detail, /还没预检/)
  assert.match(rs.find((r) => r.label === 'slack').detail, /还没预检/)
  verify.recordPrecheck('feishu', feishu, [{ key: 'bot', status: 'fail', label: '凭证 / bot 身份', detail: 'appSecret 不对' }], { file })
  verify.recordPrecheck('slack', slack, [{ key: 'auth', status: 'ok' }, { key: 'socket', status: 'ok' }], { file })
  rs = await rows()
  const fe = rs.find((r) => r.label === 'feishu'); const sl = rs.find((r) => r.label === 'slack')
  assert.equal(fe.status, 'fail'); assert.match(fe.detail, /上次预检失败.*appSecret 不对/)
  assert.equal(sl.status, 'ok'); assert.match(sl.detail, /能用/)
})

test('health: non-loopback provider gets NO router probe row', async () => {
  const h = await check({ ...base(), providers: { glm: { baseUrl: 'https://x', apiKey: 'k' } } })
  assert.equal(h.rows.find((r) => r.label === 'router:glm'), undefined)
})

test('health: loopback (router-backed) provider — down probe is a fail', async () => {
  // Port 1 on loopback is (virtually) never listening -> connection refused -> fail fast.
  const h = await check({ ...base(), providers: { gpt: { baseUrl: 'http://127.0.0.1:1', apiKey: 'k' } } })
  assert.equal(h.rows.find((r) => r.label === 'router:gpt').status, 'fail')
})

test('health: loopback (router-backed) provider — up probe is ok', async () => {
  const srv = net.createServer()
  await new Promise((res) => srv.listen(0, '127.0.0.1', res))
  const port = srv.address().port
  try {
    const h = await check({ ...base(), providers: { gpt: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k' } } })
    assert.equal(h.rows.find((r) => r.label === 'router:gpt').status, 'ok')
  } finally {
    await new Promise((res) => srv.close(res))
  }
})

test('health: 飞书没填 botOpenId ⇒ 按门控模式说清后果(默认:@别人也接;只在 @ 时回复:一条都不回)', async () => {
  const row = async (f) => (await check({ ...base(), feishu: { appId: 'cli_x', appSecret: 's', ...f } })).rows.find((r) => r.label === 'feishu.botOpenId')
  const loose = await row({})
  assert.equal(loose.status, 'warn'); assert.match(loose.detail, /@ 别人的消息也会接/)
  assert.match((await row({ onlyWhenMentioned: true })).detail, /一条都不会回/)
  assert.equal(await row({ botOpenId: 'ou_real' }), undefined)
})

test('health: feishu with appId but missing appSecret is a fail', async () => {
  const h = await check({ ...base(), feishu: { appId: 'cli_x' } })
  assert.equal(h.rows.find((r) => r.label === 'feishu').status, 'fail')
})

test('health: example placeholder group warns (not fail)', async () => {
  const h = await check({ ...base(), groups: { oc_example_chat_id: { workdir: '/abs/path/to/x' } } })
  const row = h.rows.find((r) => r.label.startsWith('group:'))
  assert.equal(row.status, 'warn')
})

// ── 常驻浏览器探活(chrome-devtools MCP --browserUrl)──────────────────────────

test('health: 没配置 browserUrl 时无 browser: 行', async () => {
  const h = await check(base())
  assert.equal(h.rows.find((r) => r.label.startsWith('browser:')), undefined)
})

test('health: browserUrl 指向的浏览器没起 → fail(轮中才失败的坑提前报)', async () => {
  const h = await checkHealth(base(), { home: mkHome({ claudeUrl: 'http://127.0.0.1:1' }) })
  const row = h.rows.find((r) => r.label === 'browser:chrome-devtools')
  assert.equal(row.status, 'fail')
  assert.match(row.detail, /不可达/)
})

test('health: browserUrl 在听 → ok;两侧指同一实例合并成一行(来源并列)', async () => {
  const srv = net.createServer()
  await new Promise((res) => srv.listen(0, '127.0.0.1', res))
  const url = `http://127.0.0.1:${srv.address().port}`
  try {
    const h = await checkHealth(base(), { home: mkHome({ claudeUrl: url, codexUrl: url }) })
    const rows = h.rows.filter((r) => r.label.startsWith('browser:'))
    assert.equal(rows.length, 1) // 同 url 去重
    assert.equal(rows[0].status, 'ok')
    assert.match(rows[0].detail, /用户级\+codex/)
  } finally {
    await new Promise((res) => srv.close(res))
  }
})

// ── MCP 可达性(勾进群却连不上的插件,每一轮 spawn 都在替它付一次启动失败)────────
// 探针全部注入 ⇒ 零网络。TTL 缓存是模块级的,各用例用不同的服务名/目标互不串味。

// 只写 ~/.claude.json 的 mcpServers(不带 --browserUrl,免得混进 browser: 行)
function mcpHome(servers) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-health-mcp-'))
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: servers }))
  return home
}
const stubProbe = (tcpTable = {}, execTable = {}) => ({
  force: true, // 用例之间不共享结论
  tcp: async (host, port) => tcpTable[`${host}:${port}`] || { ok: false, code: 'ECONNREFUSED' },
  exec: (cmd) => execTable[cmd] || { ok: false, code: 'ENOENT', path: cmd },
})

test('health: 库里没有 MCP 时不出 mcp: 行', async () => {
  const h = await check(base())
  assert.equal(h.rows.find((r) => r.label.startsWith('mcp:')), undefined)
})

// ⚠ 连不上是 **warn 不是 fail** —— 库里躺着的多半是 operator 别的项目才起的服务,
//   没起是常态,不该让整机体检变红。
test('health: 本机 MCP 连不上 → warn(不是 fail),并说清会跳过注入', async () => {
  const h = await checkHealth(base(), {
    home: mcpHome({ hfusion: { type: 'http', url: 'http://127.0.0.1:27182/mcp' } }),
    mcpProbe: stubProbe(),
  })
  const row = h.rows.find((r) => r.label === 'mcp:hfusion')
  assert.equal(row.status, 'warn')
  // 一条 mcp: 行都不许是 fail(base() 里那条 claude fail 是这个夹具自带的,与本条无关)
  assert.deepEqual(h.rows.filter((r) => r.label.startsWith('mcp:') && r.status === 'fail'), [])
  assert.match(row.detail, /连不上/)
  assert.match(row.detail, /跳过注入/)
})

// 「有没有群勾着它」才是「是不是正在每轮烧钱」的判据 —— 光说连不上不够。
test('health: 连不上的 MCP 报出勾选它的群数', async () => {
  const opts = { home: mcpHome({ hcount: { type: 'http', url: 'http://127.0.0.1:27183/mcp' } }), mcpProbe: stubProbe() }
  const none = await checkHealth(base(), opts)
  assert.match(none.rows.find((r) => r.label === 'mcp:hcount').detail, /当前没有群勾选/)
  const used = await checkHealth({ ...base(), groups: { oc_a: { workdir: '/x', plugins: { mcp: ['hcount'] } } } }, opts)
  assert.match(used.rows.find((r) => r.label === 'mcp:hcount').detail, /1 个群勾着它/)
})

// 没配过插件的群是「默认加载」,不经过跳过机制 —— 对它们说「会跳过」是假话(审查逮到的说做不一致)。
test('health: 连不上的 MCP 对「默认加载」的群另说一句,不冒充会跳过', async () => {
  const opts = { home: mcpHome({ hdef: { type: 'http', url: 'http://127.0.0.1:27184/mcp' } }), mcpProbe: stubProbe() }
  const mixed = await checkHealth({ ...base(), groups: {
    oc_a: { workdir: '/x', provider: 'glm' },                          // 没配过插件 ⇒ 默认加载全部
    oc_b: { workdir: '/y', plugins: { mcp: ['hdef'] } },               // 勾过 ⇒ 会跳过
    oc_example_chat_id: { workdir: '/abs/path/to/x' },                 // 示例占位不算
  } }, opts)
  const d = mixed.rows.find((r) => r.label === 'mcp:hdef').detail
  assert.match(d, /1 个群勾着它/)
  assert.match(d, /另有 1 个群没配过插件/)
  assert.match(d, /不会跳过/)
  // 对照组:所有群都配过插件 ⇒ 那句不出现
  const all = await checkHealth({ ...base(), groups: { oc_b: { workdir: '/y', plugins: { mcp: ['hdef'] } } } }, opts)
  assert.doesNotMatch(all.rows.find((r) => r.label === 'mcp:hdef').detail, /没配过插件/)
})

test('health: stdio MCP 的可执行文件不在 → warn', async () => {
  const h = await checkHealth(base(), {
    home: mcpHome({ hstdio: { type: 'stdio', command: '/no/such/hstdio-mcp' } }),
    mcpProbe: stubProbe(),
  })
  const row = h.rows.find((r) => r.label === 'mcp:hstdio')
  assert.equal(row.status, 'warn')
  assert.match(row.detail, /找不到/)
})

test('health: 可达的 MCP 是 ok', async () => {
  const h = await checkHealth(base(), {
    home: mcpHome({ hok: { type: 'stdio', command: '/usr/local/bin/hok-mcp' } }),
    mcpProbe: stubProbe({}, { '/usr/local/bin/hok-mcp': { ok: true, path: '/usr/local/bin/hok-mcp' } }),
  })
  assert.equal(h.rows.find((r) => r.label === 'mcp:hok').status, 'ok')
})

// ⚠ 公网直连没通只算「没确认」:daemon 自己出网不走代理(src/core/proxy.js 那条),
//   而 agent 是 spawn 出去继承代理 env 的子进程 —— 不能拿本进程的直连结果替它下结论。
test('health: 公网 MCP 直连没通 → warn,但措辞是「无法确认」且明说仍会注入', async () => {
  const h = await checkHealth(base(), {
    home: mcpHome({ hfar: { type: 'http', url: 'https://mcp.example.com/mcp' } }),
    mcpProbe: stubProbe(),
  })
  const row = h.rows.find((r) => r.label === 'mcp:hfar')
  assert.equal(row.status, 'warn')
  assert.match(row.detail, /无法确认可达/)
  assert.match(row.detail, /仍会照常注入/)
  assert.doesNotMatch(row.detail, /跳过注入/) // 反过来的结论必须长得不一样
})

test('health: 判不了的 MCP 形态不占体检行', async () => {
  const h = await checkHealth(base(), {
    home: mcpHome({ hrel: { command: './bin/hrel-mcp' } }),
    mcpProbe: stubProbe(),
  })
  assert.equal(h.rows.find((r) => r.label === 'mcp:hrel'), undefined)
})

// ── 项目根目录围栏(src/projectsroot.js)在 doctor 里的三行 ──────────────────────
test('health: projectsRoots 行 —— 根都在是 ok;配置指定的根不存在 fail;默认根不存在只 warn;被忽略的配置值单独 warn', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-hroot-'))
  const ok = await check({ ...base(), _projectsRoots: { roots: [root], dropped: [], fromConfig: true } })
  const okRow = ok.rows.find((r) => r.label === 'projectsRoots')
  assert.equal(okRow.status, 'ok'); assert.equal(okRow.detail, root)
  const miss = await check({ ...base(), _projectsRoots: { roots: ['/no/such/root-sbot'], dropped: [], fromConfig: true } })
  assert.equal(miss.rows.find((r) => r.label === 'projectsRoots').status, 'fail')
  const dflt = await check({ ...base(), _projectsRoots: { roots: ['/no/such/root-sbot'], dropped: [], fromConfig: false } })
  const dRow = dflt.rows.find((r) => r.label === 'projectsRoots')
  assert.equal(dRow.status, 'warn'); assert.match(dRow.detail, /自动创建/)
  const dropped = await check({ ...base(), _projectsRoots: { roots: [root], dropped: [{ value: '/', why: '是文件系统根目录' }], fromConfig: true } })
  const rows = dropped.rows.filter((r) => r.label === 'projectsRoots')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].status, 'warn'); assert.match(rows[0].detail, /已忽略 \/(.*)是文件系统根目录/)
})

test('health: 越界的既有绑定 warn 而不是 fail(照常运行,但要出声);根内的绑定 ok', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-hroot-'))
  const inside = path.join(root, 'p'); fs.mkdirSync(inside)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-hout-'))
  const h = await check({ ...base(), _projectsRoots: { roots: [root], dropped: [], fromConfig: true }, groups: { oc_in: { workdir: inside }, oc_out: { workdir: outside } } })
  const rIn = h.rows.find((r) => r.label === 'group:…' + 'oc_in'.slice(-8)), rOut = h.rows.find((r) => r.label === 'group:…' + 'oc_out'.slice(-8))
  assert.equal(rIn.status, 'ok'); assert.equal(rIn.detail, inside)
  assert.equal(rOut.status, 'warn'); assert.match(rOut.detail, /项目根目录之外/)
})

// 遗留进程行(v0.11.108):有 ⇒ warn 且点名最老的;无 ⇒ ok;平台不支持 ⇒ 一行不占。
// 注入 opts.leftover —— 真 ps 在开发机上结果会随机器状态漂。
test('health: leftover 行三态', async () => {
  const some = await checkHealth(base(), { home: emptyHome, leftover: async () => ({ supported: true, rows: [{ pid: 4914, ageSec: 35 * 86400, age: '35 天', summary: 'until node -e …; do sleep 5; done' }] }) })
  const r = some.rows.find((x) => x.label === 'leftover')
  assert.equal(r.status, 'warn')
  assert.match(r.detail, /1 个后台进程/); assert.match(r.detail, /35 天/)
  const none = await checkHealth(base(), { home: emptyHome, leftover: async () => ({ supported: true, rows: [] }) })
  assert.equal(none.rows.find((x) => x.label === 'leftover').status, 'ok')
  const win = await checkHealth(base(), { home: emptyHome, leftover: async () => ({ supported: false, rows: [] }) })
  assert.equal(win.rows.find((x) => x.label === 'leftover'), undefined)
  // 探针炸了不许拖垮整张体检
  const boom = await checkHealth(base(), { home: emptyHome, leftover: async () => { throw new Error('x') } })
  assert.ok(Array.isArray(boom.rows) && boom.rows.length > 0)
})

// 运维告警群(alerts.chatId,src/core/opsalert.js):没配 ok 但说清后果;配了 ok;配到绑定群上 warn(助手会在里面干活)。
test('health: alerts 行三态', async () => {
  const none = await check(base())
  const r0 = none.rows.find((x) => x.label === 'alerts')
  assert.equal(r0.status, 'ok'); assert.match(r0.detail, /未配运维告警群/); assert.match(r0.detail, /只会在出事的群里说/)
  const ok = await check({ ...base(), alerts: { chatId: 'oc_alerts' } })
  assert.equal(ok.rows.find((x) => x.label === 'alerts').status, 'ok')
  assert.match(ok.rows.find((x) => x.label === 'alerts').detail, /已配/)
  assert.match(ok.rows.find((x) => x.label === 'alerts').detail, /平台连接中断/, '文案要说清连接中断也会报到那里(v0.11.110 后加的告警种类)')
  const bound = await check({ ...base(), alerts: { chatId: 'oc_alerts' }, groups: { oc_alerts: { workdir: '/x' } } })
  assert.equal(bound.rows.find((x) => x.label === 'alerts').status, 'warn')
  assert.match(bound.rows.find((x) => x.label === 'alerts').detail, /保持未绑定/)
  // 空串 = 没配
  assert.match((await check({ ...base(), alerts: { chatId: '  ' } })).rows.find((x) => x.label === 'alerts').detail, /未配/)
  // 告警群是企微群(id 形态 / 只配企微)⇒ 提醒要先 @ 过机器人(主动推送的前提);飞书群不提
  const we = await check({ ...base(), wecom: { botId: 'aibX', secret: 's' }, alerts: { chatId: 'wrALERT12345678' } })
  assert.match(we.rows.find((x) => x.label === 'alerts').detail, /先在群里 @ 过机器人/)
  assert.ok(!/@ 过机器人/.test((await check({ ...base(), feishu: { appId: 'cli_x', appSecret: 's' }, alerts: { chatId: 'oc_alert' } })).rows.find((x) => x.label === 'alerts').detail))
})

// 企业微信平台行(双平台并存):配了哪个就报哪个 —— 只配企微时 wecom ok + 命令行工具一行(装没装只降级,warn),飞书不占行;
// 企微块缺项 fail;两个都配两行都 ok;顶层 platform 字段废弃 ⇒ warn 一句;群标成没配的平台 ⇒ warn 收不到消息。
test('health: 平台行按配置分别报,废弃字段提一句', async () => {
  const on = await check({ ...base(), wecom: { botId: 'aibX', secret: 's' } })
  const w = on.rows.find((x) => x.label === 'wecom')
  assert.equal(w.status, 'ok'); assert.match(w.detail, /长连接/)
  assert.equal(on.rows.find((x) => x.label === 'feishu'), undefined, '只配企微时飞书不占行')
  const cli = on.rows.find((x) => x.label === 'wecom.cli')
  assert.ok(cli && ['ok', 'warn'].includes(cli.status))
  assert.match(cli.detail, /命令行工具/); assert.ok(!/sbot|wecom-cli/.test(cli.detail), '控制台可见文案里不出现工具名(对照:上一行证明读到了文案)')
  // 「不 @ 也回复」口径行:默认开(20s · 300s);pollSec 0 ⇒ 关;followSec 0 ⇒ 警告全喂;cli:false 不占行
  const poll = on.rows.find((x) => x.label === 'wecom.poll'); assert.equal(poll.status, 'ok'); assert.match(poll.detail, /关\(默认\)/, '默认关(10-12 拍板)')
  assert.match((await check({ ...base(), wecom: { botId: 'aibX', secret: 's', pollSec: 20 } })).rows.find((x) => x.label === 'wecom.poll').detail, /每 20s.*300s 内/)
  assert.match((await check({ ...base(), wecom: { botId: 'aibX', secret: 's', pollSec: 20, followSec: 0 } })).rows.find((x) => x.label === 'wecom.poll').detail, /很烧额度/)
  assert.equal((await check({ ...base(), wecom: { botId: 'aibX', secret: 's', cli: false } })).rows.find((x) => x.label === 'wecom.poll'), undefined)
  const missing = await check({ ...base(), wecom: { botId: 'aibX' } })
  assert.equal(missing.rows.find((x) => x.label === 'wecom').status, 'fail')
  assert.match(missing.rows.find((x) => x.label === 'wecom').detail, /secret/)
  assert.ok(missing.rows.find((x) => x.label === 'platforms'), '企微没配齐 ⇒ 照常提「还没接聊天平台」(挂在 platforms 行)')
  const both = await check({ ...base(), feishu: { appId: 'cli_x', appSecret: 's', botOpenId: 'ou_x' }, wecom: { botId: 'aibX', secret: 's' } })
  assert.equal(both.rows.find((x) => x.label === 'feishu').status, 'ok'); assert.equal(both.rows.find((x) => x.label === 'wecom').status, 'ok')
  const dep = await check({ ...base(), _deprecatedPlatform: 'wecom', wecom: { botId: 'aibX', secret: 's' } })
  assert.equal(dep.rows.find((x) => x.label === 'platform').status, 'warn'); assert.match(dep.rows.find((x) => x.label === 'platform').detail, /废弃/)
  assert.equal(on.rows.find((x) => x.label === 'platform'), undefined, '对照:没写废弃字段就没这行')
  // 群标成企微却没配企微 ⇒ warn 说收不到;ambiguous ⇒ warn 让人补字段;两个都配且有推断 ⇒ ok 级提示
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-h-'))
  const stray = await check({ ...base(), feishu: { appId: 'cli_x', appSecret: 's' }, groups: { oc_1234567890: { workdir: dir, platform: 'wecom' } } })
  const gr = stray.rows.find((x) => x.label.startsWith('group:'))
  assert.equal(gr.status, 'warn'); assert.match(gr.detail, /没配企业微信机器人/)
  const amb = await check({ ...base(), feishu: { appId: 'cli_x', appSecret: 's' }, wecom: { botId: 'aibX', secret: 's' }, groups: { oc_1234567890: { workdir: dir, platform: 'feishu' } }, _groupPlatform: { inferred: [], ambiguous: ['WangWu'], invalid: [] } })
  assert.equal(amb.rows.find((x) => x.label === 'groups.platform').status, 'warn'); assert.match(amb.rows.find((x) => x.label === 'groups.platform').detail, /判不出/)
  const inf = await check({ ...base(), feishu: { appId: 'cli_x', appSecret: 's' }, wecom: { botId: 'aibX', secret: 's' }, groups: {}, _groupPlatform: { inferred: ['oc_1'], ambiguous: [], invalid: [] } })
  assert.equal(inf.rows.find((x) => x.label === 'groups.platform').status, 'ok')
  // 一个平台都没配(开发机)时群行不报「没配 X」—— 否则盖掉「项目目录不存在」的 fail
  const none = await check({ ...base(), groups: { oc_1234567890: { workdir: '/nope/missing', platform: 'feishu' } } })
  assert.equal(none.rows.find((x) => x.label.startsWith('group:')).status, 'fail'); assert.match(none.rows.find((x) => x.label.startsWith('group:')).detail, /不存在/)
  const feOnly = await check({ ...base(), feishu: { appId: 'cli_x', appSecret: 's' }, groups: {}, _groupPlatform: { inferred: ['oc_1'], ambiguous: [], invalid: [] } })
  assert.equal(feOnly.rows.find((x) => x.label === 'groups.platform'), undefined, '只配一个平台时推断是理所当然的,不占行(现有两台 doctor 零变化)')
})

test('health: wecom.gate —— 配了便宜模型门控:指的模型有 baseUrl+apiKey 才 ok;没 key / codex / 不存在 ⇒ warn 说清为什么;没配不占行;轮询关着也不占行', async () => {
  const w = { botId: 'aibX', secret: 's', pollSec: 20 } // 轮询默认关(10-12),门控行只在开着时出现
  const rows = async (cfg) => (await check(cfg)).rows
  assert.equal((await rows({ ...base(), wecom: w })).find((x) => x.label === 'wecom.gate'), undefined)
  let r = (await rows({ ...base(), providers: { deepseek: { baseUrl: 'https://d', apiKey: 'k', model: 'v4' } }, wecom: { ...w, gatekeeper: 'deepseek' } })).find((x) => x.label === 'wecom.gate')
  assert.equal(r.status, 'ok'); assert.match(r.detail, /便宜模型门控:deepseek — /)
  r = (await rows({ ...base(), providers: { deepseek: { baseUrl: 'https://d', apiKey: 'k' } }, wecom: { ...w, gatekeeper: { provider: 'deepseek', model: 'flash' } } })).find((x) => x.label === 'wecom.gate')
  assert.match(r.detail, /deepseek\(flash\)/)
  r = (await rows({ ...base(), providers: { claude: {} }, wecom: { ...w, gatekeeper: 'claude' } })).find((x) => x.label === 'wecom.gate')
  assert.equal(r.status, 'warn'); assert.match(r.detail, /没有配 baseUrl \+ apiKey/); assert.match(r.detail, /一律不答/)
  r = (await rows({ ...base(), providers: { codex: { runner: 'codex' } }, wecom: { ...w, gatekeeper: 'codex' } })).find((x) => x.label === 'wecom.gate')
  assert.equal(r.status, 'warn'); assert.match(r.detail, /不是这套消息协议/)
  r = (await rows({ ...base(), wecom: { ...w, gatekeeper: 'ghost' } })).find((x) => x.label === 'wecom.gate')
  assert.equal(r.status, 'warn'); assert.match(r.detail, /没有叫「ghost」/)
  r = (await rows({ ...base(), providers: { deepseek: { baseUrl: 'https://d', apiKey: 'k' } }, wecom: { ...w, gatekeeper: 'deepseek' } })).find((x) => x.label === 'wecom.gate')
  assert.equal(r.status, 'warn'); assert.match(r.detail, /没有型号名/, 'provider 没写 model 且门控没指定 ⇒ 每次请求都会失败,doctor 必须提前说')
  for (const x of (await rows({ ...base(), providers: { deepseek: { baseUrl: 'https://d', apiKey: 'k', model: 'v4' } }, wecom: { ...w, gatekeeper: 'deepseek' } })).filter((x) => /^wecom/.test(x.label))) assert.ok(!/sbot|wecom-cli/.test(x.detail), x.label + ' 零工具名(对照:' + x.detail.slice(0, 12) + ')')
  assert.equal((await rows({ ...base(), providers: { deepseek: { baseUrl: 'https://d', apiKey: 'k' } }, wecom: { ...w, gatekeeper: 'deepseek', pollSec: 0 } })).find((x) => x.label === 'wecom.gate'), undefined, '轮询关着门控无意义,不占行')
})

// Slack 平台行:与企微同口径 —— 只配 Slack 时 slack ok、飞书不占行;块缺项 fail;群标成 slack 却没配 Slack ⇒ warn 收不到消息。
test('health: Slack 平台行与群行', async () => {
  const on = await check({ ...base(), slack: { botToken: 'xoxb-1', appToken: 'xapp-1', identity: { botName: 'SintBot' } } })
  const s = on.rows.find((x) => x.label === 'slack')
  assert.equal(s.status, 'ok'); assert.match(s.detail, /Socket Mode/); assert.match(s.detail, /SintBot/)
  assert.equal(on.rows.find((x) => x.label === 'feishu'), undefined, '只配 Slack 时飞书不占行')
  const miss = (await check({ ...base(), slack: { botToken: 'xoxb-1' } })).rows.find((x) => x.label === 'slack')
  assert.equal(miss.status, 'fail'); assert.match(miss.detail, /缺 slack\.appToken/)
  // 对照组:没写 slack 块就不占行
  assert.equal((await check({ ...base(), feishu: { appId: 'cli_x', appSecret: 's' } })).rows.find((x) => x.label === 'slack'), undefined)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-health-sl-'))
  const g = await check({ ...base(), feishu: { appId: 'cli_x', appSecret: 's' }, groups: { C0TESTCHAN1: { workdir: dir, platform: 'slack' } } })
  const row = g.rows.find((x) => x.label === 'group:…TESTCHAN1' || x.label === 'group:…ESTCHAN1')
  assert.ok(row, '群行在'); assert.equal(row.status, 'warn'); assert.match(row.detail, /标为Slack群,但没配Slack 应用/)
})

test('health: codex 登录态 —— 没登录 ⇒ provider 行 warn 给出 codex login,指向它的备用模型行也 warn;已登录 ⇒ 都 ok;探不出来 ⇒ 未验证', async () => {
  const cfg = () => ({ ...base(), providers: { claude: { fallback: 'codex' }, codex: { runner: 'codex' } } })
  const rows = async (s) => (await checkHealth(cfg(), { home: emptyHome, codexLogin: async () => s })).rows
  const pick = (rs, label) => rs.find((r) => r.label === label)

  let rs = await rows({ ok: true, loggedIn: false, mode: '' })
  assert.equal(pick(rs, 'provider:codex').status, 'warn'); assert.match(pick(rs, 'provider:codex').detail, /codex login/)
  assert.equal(pick(rs, 'fallback:claude').status, 'warn'); assert.match(pick(rs, 'fallback:claude').detail, /切不过去/)

  rs = await rows({ ok: true, loggedIn: true, mode: 'chatgpt' })
  assert.equal(pick(rs, 'provider:codex').status, 'ok'); assert.equal(pick(rs, 'provider:codex').detail, 'codex 订阅已登录')
  assert.equal(pick(rs, 'fallback:claude').status, 'ok')

  rs = await rows({ ok: false, error: 'timeout' })
  assert.equal(pick(rs, 'provider:codex').status, 'ok'); assert.match(pick(rs, 'provider:codex').detail, /未验证/)
  assert.equal(pick(rs, 'fallback:claude').status, 'ok', '探不出来不算没登录')
})

test('health: codex 登录态只探一次 —— provider 行和备用模型行共用', async () => {
  let n = 0
  const cfg = { ...base(), providers: { claude: { fallback: 'codex' }, codex: { runner: 'codex' } } }
  await checkHealth(cfg, { home: emptyHome, codexLogin: async () => { n++; return { ok: true, loggedIn: true } } })
  assert.equal(n, 1)
})

test('health: Claude 没登录 —— 有人用(默认 / 群选了 / 是备用)⇒ fail;没人用 ⇒ 只 warn(只用 DeepSeek 的新手)', async () => {
  const out = async () => ({ ok: true, loggedIn: false })
  const row = async (cfg) => (await checkHealth(cfg, { home: emptyHome, claudeLogin: out })).rows.find((r) => r.label === 'provider:claude')
  const ds = { baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-x' }

  let r = await row({ ...base(), defaultProvider: 'claude', providers: { claude: {}, deepseek: ds } })
  assert.equal(r.status, 'fail'); assert.match(r.detail, /claude auth login/)

  r = await row({ ...base(), defaultProvider: 'deepseek', providers: { claude: {}, deepseek: ds } })
  assert.equal(r.status, 'warn'); assert.match(r.detail, /没有群在用/)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-health-cl-'))
  r = await row({ ...base(), defaultProvider: 'deepseek', providers: { claude: {}, deepseek: ds }, groups: { oc_g1: { workdir: dir, provider: 'claude' } } })
  assert.equal(r.status, 'fail', '有群选了 claude')

  r = await row({ ...base(), defaultProvider: 'deepseek', providers: { claude: {}, deepseek: { ...ds, fallback: 'claude' } } })
  assert.equal(r.status, 'fail', '是别人的备用')

  r = (await checkHealth({ ...base(), defaultProvider: 'deepseek', providers: { claude: {}, deepseek: ds } }, { home: emptyHome, claudeLogin: async () => ({ ok: true, loggedIn: true, plan: 'max' }) })).rows.find((x) => x.label === 'provider:claude')
  assert.equal(r.status, 'ok')
})
