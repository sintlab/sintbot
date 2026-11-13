'use strict'
// Setup mode: the browser-driven scan-to-connect flow. runConnect itself is
// covered by tests/connect.test.js; here it is replaced by a scripted stand-in
// that writes the same lines runConnect writes.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createSetupServer, createSetupSession, svgOf, probeRunners, setupPage, translateSetupNotice } = require('../src/setupserver')

const CONFIG = '/tmp/sintbot-setup-test/config.json'
const SCAN = 'https://accounts.feishu.cn/scan?token=abc'

// A scripted connect: emits notices, then finishes with the given code. A
// `gate` promise lets a test hold the run open (to cancel it) before it ends.
function scriptedConnect(script) {
  const calls = []
  const fn = async (argv, deps) => {
    calls.push({ argv, deps })
    const say = l => deps.stderr.write(l + '\n')
    const step = script.shift() || { code: 0, lines: [] }
    for (const line of step.lines || []) {
      if (line === SCAN) deps.stdout.write(line + '\n'); else say(line)
    }
    if (step.hold) {
      await new Promise(resolve => { deps.signals.on('SIGINT', resolve); step.hold.then(resolve) })
    }
    if (step.throws) throw step.throws
    return step.code
  }
  return { fn, calls }
}

const request = (addr, method, pathname, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body)
  const req = http.request({ host: '127.0.0.1', port: addr.port, method, path: pathname,
    headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
    let raw = ''
    res.on('data', c => { raw += c }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }))
  })
  req.on('error', reject)
  if (data) req.write(data)
  req.end()
})

test('svgOf renders the scan link as an inline QR without the page chrome', () => {
  const svg = svgOf(SCAN)
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/)
  assert.doesNotMatch(svg, /<html|<script/)
})

test('probeRunners reports which executors answer --version', () => {
  const spawn = (cmd) => ({ status: 0, stdout: cmd === 'claude' ? 'claude 2.1.0' : 'something else' })
  assert.deepEqual(probeRunners(spawn, {}), { codex: false, claude: true }, 'same rule as runConnect: exit 0 and the name on stdout')
  assert.deepEqual(probeRunners(() => { throw new Error('ENOENT') }, {}), { codex: false, claude: false })
})

test('session: inputs become connect flags; the QR appears from stdout; success completes the session', async () => {
  const c = scriptedConnect([{ code: 0, lines: ['正在创建应用…', SCAN, '二维码 300 秒内有效。', '应用 ID：cli_a1b2c3d4e5', '配置已写入 /tmp/sintbot-setup-test/config.json。', '连接完成。'] }])
  const s = createSetupSession({ configFile: CONFIG, dataDir: '/tmp/sintbot-setup-test', home: '/Users/tester', version: '1.4.17',
    runners: { codex: true, claude: true }, connect: c.fn })
  assert.equal(s.state.phase, 'form')
  assert.equal(s.state.defaults.projectsRoot, '/Users/tester/Projects')
  s.start({ name: 'demo', provider: 'claude', basic: true })
  assert.equal(s.state.phase, 'running')
  assert.equal(await s.completed, true)
  assert.equal(s.state.phase, 'done')
  assert.deepEqual(c.calls[0].argv, ['--config', CONFIG, '--no-open', '--data-dir', '/tmp/sintbot-setup-test', '--name', 'demo', '--provider', 'claude', '--basic'])
  assert.equal(c.calls[0].deps.isTTY, false)
  assert.equal(c.calls[0].deps.home, '/Users/tester')
  assert.equal(s.state.qr, null, 'completed sessions stop exposing the QR')
  assert.equal(s.state.appId, 'cli_a1b2c3d4e5')
  assert.ok(s.state.lines.includes('请用手机飞书扫描页面上的二维码。'))
  assert.ok(!s.state.lines.includes(SCAN), 'the raw link is not in the notice list')
  assert.throws(() => s.start({}), /已完成/)
})

test('session: a failed group creation waits for a hand-made group and resumes with --app-id and --chat', async () => {
  const c = scriptedConnect([
    { code: 1, lines: [SCAN, '应用 ID：cli_a1b2c3d4e5', '自动建群失败（code 232043）。请在飞书手动建群并把机器人拉进去，复制群 ID（oc_…），然后执行 sintbot connect --app-id cli_a1b2c3d4e5 --chat <oc_…>'] },
    { code: 0, lines: ['使用你提供的群。', '连接完成。'] },
  ])
  const s = createSetupSession({ configFile: CONFIG, home: '/Users/tester', version: '1.4.17', runners: { claude: true, codex: false }, connect: c.fn })
  s.start({ workdir: '/Users/tester/Projects/demo' })
  await s.wait()
  assert.equal(s.state.phase, 'waitingChat')
  assert.match(s.state.notice, /自动建群失败/)
  assert.throws(() => s.start({ chatId: 'bad' }), /oc_/)
  s.start({ workdir: '/Users/tester/Projects/demo', chatId: 'oc_handmade01' })
  await s.completed
  assert.equal(s.state.phase, 'done')
  const argv = c.calls[1].argv
  assert.ok(argv.includes('--app-id') && argv[argv.indexOf('--app-id') + 1] === 'cli_a1b2c3d4e5')
  assert.ok(argv.includes('--chat') && argv[argv.indexOf('--chat') + 1] === 'oc_handmade01')
  assert.ok(argv.includes('--workdir'))
})

test('session: other failures end in "failed" with the last notice; reset returns to the form; thrown errors are shown', async () => {
  const c = scriptedConnect([{ code: 1, lines: ['你的飞书账号没有组织，无法创建应用。'] }, { throws: new Error('--workdir must be an existing directory') }])
  const s = createSetupSession({ configFile: CONFIG, home: '/Users/tester', version: '1.4.17', runners: { claude: true, codex: false }, connect: c.fn })
  s.start({}); await s.wait()
  assert.equal(s.state.phase, 'failed')
  assert.match(s.state.notice, /没有组织/)
  assert.equal(s.reset(), true)
  assert.equal(s.state.phase, 'form')
  s.start({ workdir: '/nope' }); await s.wait()
  assert.equal(s.state.phase, 'failed')
  assert.match(s.state.notice, /existing directory/)
})

test('session: validation rejects bad names, relative paths and unknown executors before any scan', () => {
  const c = scriptedConnect([])
  const s = createSetupSession({ configFile: CONFIG, home: '/Users/tester', version: '1.4.17', runners: { claude: true, codex: false }, connect: c.fn })
  assert.throws(() => s.start({ name: '../x' }), /项目名/)
  assert.throws(() => s.start({ workdir: 'relative/dir' }), /绝对路径/)
  assert.throws(() => s.start({ provider: 'gpt' }), /执行器/)
  assert.throws(() => s.start({ appId: 'nope' }), /cli_/)
  assert.equal(c.calls.length, 0)
})

test('session: cancel signals the running connect like Ctrl-C', async () => {
  const hold = new Promise(() => {})
  const c = scriptedConnect([{ code: 1, lines: [SCAN], hold }])
  const s = createSetupSession({ configFile: CONFIG, home: '/Users/tester', version: '1.4.17', runners: { claude: true, codex: false }, connect: c.fn })
  s.start({})
  await new Promise(r => setImmediate(r))
  assert.equal(s.cancel(), true)
  await s.wait()
  assert.equal(s.state.phase, 'failed')
  assert.equal(s.cancel(), false)
})

test('session: cancel reports false when the run has no signal handler yet, and never pretends', async () => {
  let release
  const c = { fn: async () => { await new Promise(r => { release = r }); return 1 } } // registers no handler at all
  const s = createSetupSession({ configFile: CONFIG, home: '/Users/tester', version: '1.4.17', runners: { claude: true, codex: false }, connect: c.fn })
  s.start({})
  await new Promise(r => setImmediate(r))
  assert.equal(s.cancel(), false)
  assert.ok(!s.state.lines.some(l => /取消/.test(l)))
  release(); await s.wait()
})

test('session: a retry after any failure reuses the app from the first scan; a reload-resume keeps the first run\'s directory and options', async () => {
  const c = scriptedConnect([
    { code: 1, lines: [SCAN, '应用 ID：cli_first00001', '自检失败（code 99991663）。请处理后重跑 sintbot connect --app-id cli_first00001'] },
    { code: 1, lines: ['应用 ID：cli_first00001', '自动建群失败（code 232043）。请在飞书手动建群并把机器人拉进去，复制群 ID（oc_…），然后执行 sintbot connect --app-id cli_first00001 --chat <oc_…>'] },
    { code: 0, lines: ['使用你提供的群。'] },
  ])
  const s = createSetupSession({ configFile: CONFIG, home: '/Users/tester', version: '1.4.17', runners: { claude: true, codex: true }, connect: c.fn })
  s.start({ workdir: '/Users/tester/Projects/app', provider: 'codex', basic: true }); await s.wait()
  assert.equal(s.state.phase, 'failed')
  s.start({ workdir: '/Users/tester/Projects/app', provider: 'codex', basic: true }); await s.wait()
  assert.ok(c.calls[1].argv.includes('--app-id') && c.calls[1].argv[c.calls[1].argv.indexOf('--app-id') + 1] === 'cli_first00001', 'retry reuses the app')
  assert.equal(s.state.phase, 'waitingChat')
  // The page was reloaded: only the group id comes back.
  s.start({ chatId: 'oc_byhand0001' }); await s.completed
  const argv = c.calls[2].argv
  assert.ok(argv.includes('--workdir') && argv[argv.indexOf('--workdir') + 1] === '/Users/tester/Projects/app')
  assert.ok(argv.includes('--provider') && argv[argv.indexOf('--provider') + 1] === 'codex')
  assert.ok(argv.includes('--basic'))
  assert.ok(argv.includes('--chat'))
})

test('session: when only the journals failed, retry runs the initialization alone and the final stdout notice is shown', async () => {
  const c = scriptedConnect([{ code: 1, lines: ['应用 ID：cli_first00001', '配置已写入 /tmp/x/config.json。', '初始化失败（EACCES）。配置已写好，可手动执行 sintbot init 重试。'] }])
  const inits = []
  const s = createSetupSession({ configFile: CONFIG, dataDir: '/tmp/x', home: '/Users/tester', version: '1.4.17', runners: { claude: true, codex: false }, connect: c.fn,
    initialize: (file, options) => { inits.push({ file, options }); if (inits.length === 1) throw new Error('still EACCES') } })
  s.start({}); await s.wait()
  assert.equal(s.state.phase, 'failed'); assert.equal(s.state.initOnly, true)
  s.start({}); await s.wait()
  assert.equal(s.state.phase, 'failed'); assert.match(s.state.notice, /still EACCES/)
  s.start({}); await s.completed
  assert.equal(s.state.phase, 'done')
  assert.deepEqual(inits.map(i => i.file), [CONFIG, CONFIG]); assert.equal(inits[0].options.dataDir, '/tmp/x')
  assert.equal(c.calls.length, 1, 'no second scan')

  const d = { fn: async (argv, deps) => { deps.stdout.write(SCAN + '\n'); deps.stdout.write('连接完成，去飞书群里 @机器人 试试吧。\n"$HOME/.local/share/sintbot/bin/sintbot" start --config \'/x\' --data-dir \'/y\' --ui\n'); return 0 } }
  const t = createSetupSession({ configFile: CONFIG, home: '/Users/tester', version: '1.4.17', runners: { claude: true, codex: false }, connect: d.fn })
  t.start({}); await t.completed
  assert.ok(t.state.lines.includes('连接完成，去飞书群里 @机器人 试试吧。'))
  assert.ok(!t.state.lines.some(l => /start --config/.test(l)))
  assert.equal(t.state.scanUrl, undefined, 'the raw scan link is not exposed')
})

test('server: serves the page locally, exposes state, starts and completes over HTTP, refuses foreign origins and non-JSON', async t => {
  const c = scriptedConnect([{ code: 0, lines: [SCAN, '应用 ID：cli_a1b2c3d4e5', '连接完成。'] }])
  const srv = createSetupServer({ configFile: CONFIG, home: '/Users/tester', version: '1.4.17', runners: { claude: true, codex: false }, connect: c.fn, port: 0 })
  const addr = await srv.listen()
  t.after(() => srv.close())
  const page = await request(addr, 'GET', '/')
  assert.equal(page.status, 200)
  assert.match(page.body, /连接你的项目/)
  assert.match(page.body, /1\.4\.17/)
  const state = JSON.parse((await request(addr, 'GET', '/api/setup/state')).body)
  assert.equal(state.phase, 'form')
  assert.deepEqual(state.runners, { claude: true, codex: false })
  assert.equal((await request(addr, 'POST', '/api/setup/start', { name: 'x' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await request(addr, 'POST', '/api/setup/start', { name: 'x' }, { origin: 'http://localhost:3000' })).status, 403, 'another local port is another app')
  assert.equal((await request(addr, 'GET', '/api/setup/state', undefined, { host: 'evil.example:4600' })).status, 403, 'no DNS rebinding')
  assert.equal((await request(addr, 'GET', '/api/setup/state', undefined, { host: `localhost:${addr.port}` })).status, 200)
  const malformed = await new Promise(resolve => {
    const net = require('node:net'); const sock = net.connect(addr.port, '127.0.0.1', () => sock.write('GET //[ HTTP/1.1\r\nHost: 127.0.0.1:' + addr.port + '\r\n\r\n'))
    let raw = ''; sock.on('data', c => { raw += c }); sock.on('close', () => resolve(raw)); sock.on('error', () => resolve(raw)); setTimeout(() => sock.destroy(), 1500)
  })
  assert.match(malformed, /^HTTP\/1\.1 400/)
  const big = await request(addr, 'POST', '/api/setup/start', { name: 'x'.repeat(20000) }, { origin: `http://127.0.0.1:${addr.port}` })
  assert.equal(big.status, 413)
  const notJson = await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: addr.port, method: 'POST', path: '/api/setup/start', headers: { 'content-type': 'text/plain' } }, res => resolve(res.statusCode))
    req.end('x')
  })
  assert.equal(notJson, 415)
  const started = await request(addr, 'POST', '/api/setup/start', { name: 'demo' }, { origin: `http://127.0.0.1:${addr.port}` })
  assert.equal(started.status, 200)
  assert.equal(await srv.completed, true)
  const done = JSON.parse((await request(addr, 'GET', '/api/setup/state')).body)
  assert.equal(done.phase, 'done')
  assert.equal(done.appId, 'cli_a1b2c3d4e5')
  assert.equal((await request(addr, 'GET', '/anything')).status, 302)
})

test('server: only binds to this Mac', () => {
  assert.throws(() => createSetupServer({ configFile: CONFIG, home: '/x', runners: {}, connect: async () => 0, host: '0.0.0.0', port: 0 }), /this Mac/)
})


test('page: emitted script parses, translations cover core steps, and version cannot inject HTML', () => {
  const html = setupPage({ version: '<script>unsafe</script>' })
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.equal(scripts.length, 1)
  assert.doesNotThrow(() => new (require('node:vm').Script)(scripts[0][1]))
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/)
  assert.match(html, /data-sintbot-setup="true"/)
  assert.match(html, /id="language"/)
  const core = require('../src/agent/privatecore')
  const samples = [core.connectManifest(false, 'tester', '1').hint,
    ...['token','app','precheck','scope','publish','dir','chat','config','init'].flatMap(step => [
      core.connectPlan(step, { observed: { enabled: true, workdir: '/tmp/project', configPath: '/tmp/config.json' } }).notice,
      core.connectPlan(step, { code: 232043, msg: '权限不足', observed: { appId: 'cli_demo000001' } }).notice,
    ]),
    core.connectPlan('token', { code: 21001 }).notice,
    core.connectPlan('publish', { code: 210304 }).notice,
    core.connectPlan('app', { observed: { pendingReview: true, waitedMs: 100 } }).notice,
    core.connectPlan('precheck', { observed: { checks: [{ status: 'fail', label: '机器人', detail: '权限缺失' }] } }).notice,
    '初始化失败（EACCES）。配置已写好，可手动执行 sintbot init 重试。', '已取消，没有写入任何文件。',
    '二维码 300 秒内有效。', '应用 ID：cli_demo000001',
  ]
  for (const notice of samples) {
    const translated = translateSetupNotice(notice, 'en')
    assert.ok(translated.length > 5, notice)
    assert.doesNotMatch(translated, /[\u3400-\u9fff]/, notice)
  }
  assert.match(translateSetupNotice('自动建群失败（code 232043：权限不足）。', 'en'), /232043/)
  assert.match(translateSetupNotice('配置已写入 /tmp/config.json。', 'en'), /config.json/)
})

test('session: confirmed group survives a cancellation and is reused without creating another group', async () => {
  const calls = []
  const connect = async (argv, deps) => {
    calls.push(argv)
    deps.stderr.write('应用 ID：cli_group00001\n')
    if (calls.length === 1) { deps.onGroupReady({ appId: 'cli_group00001', chatId: 'oc_created0001' }); return 130 }
    return 0
  }
  const s = createSetupSession({ configFile: CONFIG, home: '/tmp/setup-home', runners: { codex: true }, connect })
  s.start({ name: 'demo' }); await s.wait()
  assert.equal(s.state.chatId, 'oc_created0001')
  s.reset(); s.start({ name: 'demo' }); await s.completed
  assert.equal(calls[1][calls[1].indexOf('--chat') + 1], 'oc_created0001')
  assert.equal(calls[1][calls[1].indexOf('--app-id') + 1], 'cli_group00001')
})

test('server: an HTTPS origin is not the same origin as the local HTTP listener', async t => {
  const srv = createSetupServer({ configFile: CONFIG, home: '/tmp/setup-home', runners: {}, connect: async () => 1, port: 0 })
  const addr = await srv.listen(); t.after(() => srv.close())
  assert.equal((await request(addr, 'GET', '/api/setup/state', undefined, { origin: `https://127.0.0.1:${addr.port}` })).status, 403)
})


test('session exposes confirmed model defaults before a scan and retains them on completion', async () => {
  let scanned = false
  const expected = { provider: 'codex', model: 'gpt-fixture-live', effort: 'low', name: 'Fixture Live', source: 'live' }
  const connect = async (argv, deps) => {
    deps.onModelDefaults(expected)
    assert.deepEqual(s.state.modelDefaults, expected)
    assert.equal(scanned, false)
    scanned = true
    return 0
  }
  const s = createSetupSession({ configFile: CONFIG, home: '/tmp/setup-home', runners: { codex: true }, connect })
  s.start({}); await s.completed
  assert.deepEqual(s.snapshot().modelDefaults, expected)
  const page = setupPage()
  assert.match(page, /id="modelDefaults"/)
  assert.match(page, /live recommended model and thinking depth/)
  assert.match(translateSetupNotice('新群默认：Fixture Live · low。接入后可在控制台修改。', 'en'), /Fixture Live.*low/)
})
