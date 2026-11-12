'use strict'

// `sintbot connect` end to end against the real binary core, with every
// network, process and prompt dependency injected. No Feishu call is made.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { runConnect } = require('../src/connect')
const core = require('../src/agent/privatecore')
const c2install = require('../src/c2install')

const APP = { client_id: 'cli_a1b2c3d4e5', client_secret: 'not-a-real-secret', user_info: { open_id: 'ou_admin0001' } }
const larkError = (code, msg, status = 400) => Object.assign(new Error(`Request failed with status code ${status}`),
  { response: { status, data: { code, msg } } })
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A client the real feishu.js helpers can drive: every call is recorded.
// `botInfo` may be a function of the call count to script a changing app.
function fakeClient({ botInfo, fail = {}, versions = [{ version_id: 'v1', status: 2 }], chatCreate } = {}) {
  const calls = []
  const record = (name, arg) => { calls.push({ name, ...arg }) }
  const ok = data => ({ code: 0, msg: 'success', data })
  let botCalls = 0
  const client = {
    calls,
    request: async ({ method, url, data, params }) => {
      record(`${method} ${url}`, { data, params })
      if (fail[`${method} ${url}`]) throw fail[`${method} ${url}`]
      if (url === '/open-apis/bot/v3/info') {
        botCalls++
        const bot = typeof botInfo === 'function' ? botInfo(botCalls) : botInfo
        return { code: 0, bot: bot || { open_id: 'ou_bot0001', app_name: 'SintBot', activate_status: 2 } }
      }
      if (/\/application\/v6\/applications\/[^/]+$/.test(url)) return ok({ app: { app_id: APP.client_id, app_name: 'SintBot', status: 1 } })
      if (/app_versions$/.test(url)) return ok({ items: typeof versions === 'function' ? versions() : versions })
      if (/\/board\//.test(url)) throw larkError(2890003, 'record missing', 404)
      return ok({})
    },
    im: {
      chat: {
        list: async () => ok({ items: [], has_more: false }),
        create: async ({ data }) => { record('im.chat.create', { data }); if (chatCreate) return chatCreate(data); return ok({ chat_id: 'oc_connect0001', name: data.name }) },
      },
      chatMembers: { get: async () => ok({ items: [], has_more: false }) },
      message: { create: async ({ data }) => { record('im.message.create', { data }); return ok({ message_id: 'om_1' }) } },
    },
    cardkit: { v1: { card: { create: async () => ok({ card_id: 'card_1' }) } } },
    contact: { user: {
      get: async ({ path: p }) => ok({ user: { name: p.user_id === APP.user_info.open_id ? '张三' : 'bot' } }),
      findByDepartment: async () => ok({ items: [{ name: '张三' }] }),
      batchGetId: async () => ok({ user_list: [] }),
    } },
  }
  return client
}

function harness(t, { client = fakeClient(), registerApp, runners = { codex: true, claude: false }, onQR } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sintbot-connect-home-'))
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sintbot-connect-tmp-'))
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(tmpdir, { recursive: true, force: true }) })
  const out = { stdout: '', stderr: '' }
  const opened = []
  const inits = []
  const handlers = new Map()
  let clock = Date.now()
  const h = {
    home, tmpdir, out, opened, inits, client, handlers, scans: 0,
    configPath: path.join(home, '.sbot', 'config.json'), workdir: path.join(home, 'Projects', 'sintbot'),
    signal: name => { for (const fn of handlers.get(name) || []) fn() },
  }
  h.deps = {
    registerApp: registerApp || (async options => {
      h.scans++
      options.onQRCodeReady({ url: 'https://accounts.feishu.cn/oauth/v1/app/registration?user_code=TEST&from=sdk', expireIn: 600 })
      options.onStatusChange({ status: 'polling' })
      options.onStatusChange({ status: 'polling' })
      onQR?.(options)
      return APP
    }),
    feishuClient: () => client,
    initializeInstallation: (file, options) => { inits.push({ file, options }); return c2install.initializeInstallation(file, options) },
    spawn: (cmd, args) => { opened.push({ cmd, args, existed: fs.existsSync(args[0]) }); return { on() {}, unref() {} } },
    spawnSync: cmd => runners[cmd] ? { status: 0, stdout: `${cmd}-cli 1.0.0` } : { status: 1, stdout: '' },
    fs, now: () => clock, sleep: async ms => { clock += ms },
    stdout: { write: s => { out.stdout += s } }, stderr: { write: s => { out.stderr += s } },
    env: {}, home, tmpdir, userName: 'tester', isTTY: false, version: '1.4.16',
    signals: {
      on: (name, fn) => { handlers.set(name, [...(handlers.get(name) || []), fn]) },
      off: (name, fn) => { handlers.set(name, (handlers.get(name) || []).filter(f => f !== fn)) },
    },
  }
  return h
}

const tree = dir => fs.readdirSync(dir, { recursive: true }).sort()
const writeConfig = (h, raw) => { fs.mkdirSync(path.dirname(h.configPath), { recursive: true }); fs.writeFileSync(h.configPath, JSON.stringify(raw)) }
const expectedConfig = (h, chatId = 'oc_connect0001') => core.connectConfig({ appId: APP.client_id, appSecret: APP.client_secret,
  botOpenId: 'ou_bot0001', adminOpenId: APP.user_info.open_id, chatId, workdir: h.workdir, home: h.home,
  provider: 'codex', runners: { codex: true, claude: false } })
const nothingWritten = h => {
  assert.equal(fs.existsSync(h.configPath), false)
  assert.equal(fs.existsSync(path.join(h.home, 'Projects')), false)
  assert.deepEqual(fs.readdirSync(h.tmpdir), [])
}

test('connect refuses an existing Feishu configuration and touches nothing', async t => {
  const h = harness(t)
  writeConfig(h, { feishu: { appId: 'cli_existing', appSecret: 'x' }, groups: {} })
  const before = tree(h.home)
  await assert.rejects(runConnect([], h.deps), /already holds a Feishu app.*--app-id/)
  assert.equal(h.scans, 0)
  assert.deepEqual(tree(h.home), before)
  assert.deepEqual(fs.readdirSync(h.tmpdir), [])
})

test('--app-id may only finish an attempt for that app without groups', async t => {
  const other = harness(t)
  writeConfig(other, { feishu: { appId: 'cli_other00001', appSecret: 'x' }, groups: {} })
  await assert.rejects(runConnect(['--app-id', APP.client_id], other.deps), /different Feishu app \(cli_other00001\).*--app-id cli_other00001/)
  assert.equal(other.scans, 0)

  const bound = harness(t)
  writeConfig(bound, { feishu: { appId: APP.client_id, appSecret: 'x' }, groups: { oc_bound: { platform: 'feishu', workdir: '/tmp' } } })
  await assert.rejects(runConnect(['--app-id', APP.client_id], bound.deps), /already binds 1 group\(s\); connect never replaces/)
  assert.equal(bound.scans, 0)

  const retry = harness(t, { onQR: options => { retry.scan = options } })
  writeConfig(retry, { feishu: { appId: APP.client_id, appSecret: 'x' }, groups: {} })
  assert.equal(await runConnect(['--app-id', APP.client_id], retry.deps), 0, retry.out.stderr)
  assert.equal(retry.scans, 1)
  assert.equal(retry.scan.appId, APP.client_id)
  assert.equal('createOnly' in retry.scan, false)
  assert.deepEqual(JSON.parse(fs.readFileSync(retry.configPath, 'utf8')), expectedConfig(retry).config)
})

test('connect refuses while the service lock exists', async t => {
  const h = harness(t)
  fs.mkdirSync(path.join(h.home, '.sbot'), { recursive: true })
  fs.writeFileSync(path.join(h.home, '.sbot', 'daemon.lock'), '123')
  const before = tree(h.home)
  await assert.rejects(runConnect([], h.deps), /daemon\.lock/)
  assert.equal(h.scans, 0)
  assert.deepEqual(tree(h.home), before)
})

test('existing journals or state refuse before any scan', async t => {
  for (const name of ['c2-v2.log', 'c2-v2-group-abc.log', 'state.json', 'c2-groups.json']) {
    const h = harness(t)
    fs.mkdirSync(path.join(h.home, '.sbot'), { recursive: true })
    fs.writeFileSync(path.join(h.home, '.sbot', name), '')
    await assert.rejects(runConnect([], h.deps), /existing journal requires review/, name)
    assert.equal(h.scans, 0, name)
  }
})

test('a scan that never completes leaves no files behind', async t => {
  const h = harness(t, { registerApp: async options => {
    options.onQRCodeReady({ url: 'https://accounts.feishu.cn/oauth/v1/app/registration?user_code=TEST', expireIn: 600 })
    throw Object.assign(new Error('getaddrinfo ENOTFOUND accounts.feishu.cn'), { code: 'ENOTFOUND' })
  } })
  await assert.rejects(runConnect([], h.deps), /Feishu scan did not complete/)
  assert.equal(h.opened.length, 1)
  assert.equal(h.opened[0].existed, true)
  nothingWritten(h)
})

test('SIGINT during the scan aborts the registration, removes the page and exits 130', async t => {
  const h = harness(t, { registerApp: options => new Promise((resolve, reject) => {
    options.onQRCodeReady({ url: 'https://accounts.feishu.cn/oauth/v1/app/registration?user_code=TEST', expireIn: 600 })
    options.signal.addEventListener('abort', () => reject({ code: 'abort', description: 'Registration was aborted' }), { once: true })
    setImmediate(() => h.signal('SIGINT'))
  }) })
  assert.equal(await runConnect([], h.deps), 130)
  nothingWritten(h)
  assert.deepEqual([...h.handlers.values()].flat(), [])
})

test('happy path writes exactly the core configuration, the README, the group and the journal', async t => {
  const h = harness(t)
  const code = await runConnect(['--data-dir', path.join(h.home, '.sbot')], h.deps)
  assert.equal(code, 0, h.out.stderr)
  const expected = expectedConfig(h)
  assert.deepEqual(JSON.parse(fs.readFileSync(h.configPath, 'utf8')), expected.config)
  assert.equal(fs.statSync(h.configPath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(h.home, '.sbot')).mode & 0o777, 0o700)
  assert.equal(fs.readFileSync(path.join(h.workdir, 'README.md'), 'utf8'), expected.readme)
  const chat = h.client.calls.find(c => c.name === 'im.chat.create')
  assert.deepEqual(chat.data.user_id_list, [APP.user_info.open_id])
  assert.equal(chat.data.name, core.connectManifest(false, '张三', '1.4.16').appPreset.name)
  const welcome = h.client.calls.find(c => c.name === 'im.message.create')
  assert.equal(welcome.data.receive_id, 'oc_connect0001')
  assert.match(JSON.parse(welcome.data.content).text, new RegExp(escapeRe(h.workdir)))
  const scope = h.client.calls.find(c => c.name === `PATCH /open-apis/application/v7/applications/${APP.client_id}/config`)
  assert.deepEqual(scope.data, { contacts: { contacts_range_type: 'all' }, visibility: { is_visible_to_all: true } })
  const publish = h.client.calls.find(c => c.name === `POST /open-apis/application/v7/applications/${APP.client_id}/publish`)
  assert.equal(publish.data.mobile_default_ability, 'bot')
  assert.equal(publish.data.pc_default_ability, 'bot')
  assert.equal(h.inits.length, 1)
  assert.equal(h.inits[0].file, h.configPath)
  assert.ok(fs.existsSync(path.join(h.home, '.sbot', 'c2-v2.log')))
  assert.ok(fs.existsSync(path.join(h.home, '.sbot', 'c2-groups.json')))
  assert.equal(h.opened.length, 1)
  assert.equal(h.opened[0].cmd, 'open')
  assert.equal(h.opened[0].existed, true)
  assert.deepEqual(fs.readdirSync(h.tmpdir), [])
  assert.match(h.out.stdout, /^https:\/\/accounts\.feishu\.cn\//m)
  assert.match(h.out.stdout, /sintbot start --config .* --data-dir .* --ui\n$/)
  assert.match(h.out.stderr, new RegExp(`^应用 ID：${APP.client_id}$`, 'm'))
  assert.equal(h.out.stderr.split('等待扫码…').length, 2)
  assert.doesNotMatch(h.out.stdout + h.out.stderr, new RegExp(APP.client_secret))
})

test('--basic skips the scope and publish calls and drops the patch scope from the scan', async t => {
  const h = harness(t, { onQR: options => { h.scan = options } })
  const code = await runConnect(['--basic', '--no-open'], h.deps)
  assert.equal(code, 0, h.out.stderr)
  assert.equal(h.client.calls.some(c => /\/application\/v7\//.test(c.name)), false)
  assert.equal(h.opened.length, 0)
  assert.equal(h.scan.createOnly, true)
  assert.ok(!h.scan.addons.scopes.tenant.includes('application:application:patch'))
  assert.deepEqual(h.scan.addons.events, { items: { tenant: ['im.message.receive_v1', 'im.message.recalled_v1'] } })
  assert.deepEqual(h.scan.addons.callbacks, { items: ['card.action.trigger'] })
  assert.equal(h.scan.addons.preset, false)
  assert.deepEqual(JSON.parse(fs.readFileSync(h.configPath, 'utf8')).providers, { codex: { runner: 'codex' } })
})

test('--chat binds the given group without creating one', async t => {
  const h = harness(t)
  assert.equal(await runConnect(['--chat', 'oc_given0001'], h.deps), 0, h.out.stderr)
  assert.equal(h.client.calls.some(c => c.name === 'im.chat.create'), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(h.configPath, 'utf8')), expectedConfig(h, 'oc_given0001').config)
  assert.match(h.out.stderr, new RegExp(core.connectPlan('chat', { observed: { appId: APP.client_id, chatId: 'oc_given0001' } }).notice))
  assert.equal(h.client.calls.find(c => c.name === 'im.message.create').data.receive_id, 'oc_given0001')
  await assert.rejects(runConnect(['--chat', 'nope'], harness(t).deps), /--chat must be a Feishu group id/)
})

test('a group that cannot be created stops with the resume recipe and leaves no file or folder', async t => {
  const client = fakeClient({ chatCreate: () => { throw larkError(232043, 'visibility') } })
  const h = harness(t, { client })
  assert.equal(await runConnect([], h.deps), 1)
  assert.match(h.out.stderr, new RegExp(escapeRe(core.connectPlan('chat', { code: 232043, msg: 'visibility', observed: { appId: APP.client_id, chatId: null } }).notice)))
  assert.match(h.out.stderr, new RegExp(`--app-id ${APP.client_id} --chat`))
  nothingWritten(h)
  assert.equal(h.inits.length, 0)
})

test('a personal-identity token error (21001) stops before any file exists', async t => {
  // The SDK raises the token failure as a plain Error without a response body.
  const client = fakeClient({ fail: { 'GET /open-apis/bot/v3/info': new Error('failed to get tenant_access_token, code: 21001, msg: tenant has no permission') } })
  const h = harness(t, { client })
  assert.equal(await runConnect([], h.deps), 1)
  assert.match(h.out.stderr, new RegExp(core.connectPlan('token', { code: 21001, msg: 'x' }).notice))
  assert.match(h.out.stderr, new RegExp(`^应用 ID：${APP.client_id}$`, 'm'))
  nothingWritten(h)
  assert.equal(h.client.calls.some(c => c.name === 'im.chat.create'), false)
})

test('a failed precheck stops before any file exists', async t => {
  const client = fakeClient({ botInfo: { app_name: 'SintBot', activate_status: 2 } })
  const h = harness(t, { client })
  assert.equal(await runConnect([], h.deps), 1)
  assert.match(h.out.stderr, /自检未通过/)
  nothingWritten(h)
})

test('a pending review waits with one notice until the app is enabled', async t => {
  const client = fakeClient({ botInfo: n => ({ open_id: 'ou_bot0001', app_name: 'SintBot', activate_status: n < 4 ? 3 : 2 }),
    versions: [{ version_id: 'v1', status: 1 }] })
  const h = harness(t, { client })
  const slept = []
  const sleep = h.deps.sleep
  h.deps.sleep = async ms => { slept.push(ms); await sleep(ms) }
  assert.equal(await runConnect([], h.deps), 0, h.out.stderr)
  const waiting = core.connectPlan('app', { observed: { enabled: false, pendingReview: true, waitedMs: 0 } })
  assert.deepEqual(slept.filter(ms => ms === waiting.retryAfterMs), [waiting.retryAfterMs, waiting.retryAfterMs, waiting.retryAfterMs])
  assert.equal(h.out.stderr.split(waiting.notice).length, 2)
  assert.match(h.out.stderr, new RegExp(core.connectPlan('app', { observed: { enabled: true, pendingReview: false, waitedMs: 0 } }).notice))
})

test('a non-empty default project folder is refused before the scan', async t => {
  const h = harness(t)
  fs.mkdirSync(h.workdir, { recursive: true })
  fs.writeFileSync(path.join(h.workdir, 'keep.txt'), 'x')
  assert.equal(await runConnect([], h.deps), 1)
  assert.equal(h.scans, 0)
  assert.match(h.out.stderr, /已存在且非空/)
  assert.equal(fs.existsSync(h.configPath), false)
})

test('--workdir pointing at the home directory through a link is refused before the scan', async t => {
  const h = harness(t)
  const link = path.join(h.home, 'work')
  fs.symlinkSync(h.home, link)
  assert.equal(await runConnect(['--workdir', link], h.deps), 1)
  assert.equal(h.scans, 0)
  assert.match(h.out.stderr, /是整个家目录/)
  assert.equal(fs.existsSync(h.configPath), false)
})

test('a configuration that cannot be written removes the folder it just created', async t => {
  const h = harness(t)
  const configDir = path.dirname(h.configPath)
  h.deps.fs = { ...fs, mkdirSync: (p, options) => {
    if (p === configDir) throw Object.assign(new Error(`EACCES: permission denied, mkdir '${p}'`), { code: 'EACCES' })
    return fs.mkdirSync(p, options)
  } }
  assert.equal(await runConnect([], h.deps), 1)
  assert.match(h.out.stderr, /写入 .*失败.*EACCES/)
  assert.equal(fs.existsSync(h.workdir), false)
  assert.equal(fs.existsSync(h.configPath), false)
  assert.equal(h.inits.length, 0)
})

test('an initialization failure keeps the written configuration and reports the core notice', async t => {
  const h = harness(t)
  h.deps.initializeInstallation = () => { throw new Error('Journal already exists; initialization never overwrites or migrates existing state') }
  assert.equal(await runConnect([], h.deps), 1)
  assert.match(h.out.stderr, new RegExp(escapeRe(core.connectPlan('init', { code: 1, msg: 'Journal already exists; initialization never overwrites or migrates existing state' }).notice)))
  assert.deepEqual(JSON.parse(fs.readFileSync(h.configPath, 'utf8')), expectedConfig(h).config)
  assert.equal(fs.existsSync(path.join(h.home, '.sbot', 'c2-v2.log')), false)
  assert.doesNotMatch(h.out.stdout, /sintbot start/)
})

test('custom data directory is carried into the displayed startup command without shell expansion', async t => {
  const h = harness(t)
  const dataDir = path.join(h.home, "data $(printf expanded) 'literal'")
  const configPath = path.join(h.home, "config $(printf expanded) 'literal'", 'config.json')
  assert.equal(await runConnect(['--config', configPath, '--data-dir', dataDir], h.deps), 0, h.out.stderr)
  const command = h.out.stdout.trim().split('\n').at(-1)
  const parsed = spawnSync('/bin/sh', ['-c', 'set -- ' + command + '; printf "%s\\n" "$@"'], { encoding: 'utf8' })
  assert.equal(parsed.status, 0, parsed.stderr)
  assert.deepEqual(parsed.stdout.trim().split('\n'), ['sintbot', 'start', '--config', configPath, '--data-dir', dataDir, '--ui'])
  assert.equal(h.inits[0].options.dataDir, dataDir)
})

test('a custom configuration location preserves existing parent directory permissions', async t => {
  const h = harness(t)
  const parent = path.join(h.home, 'shared-project'); fs.mkdirSync(parent, { mode: 0o755 })
  const configPath = path.join(parent, 'sintbot.json')
  assert.equal(await runConnect(['--config', configPath], h.deps), 0, h.out.stderr)
  assert.equal(fs.statSync(parent).mode & 0o777, 0o755)
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600)
})
