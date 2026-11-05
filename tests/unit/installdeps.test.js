// installdeps — 安装向导替新用户装 claude / codex 时的选源与参数。npm 调用全部注入假的 run,
// 不联网、不真装;真装在新机器上手动验(docs/zh-CN/install.md「一键安装」)。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const d = require('../../src/installdeps')

// 假 npm:按子命令返回预设结果,并记下每次调用的参数
function fakeNpm({ registry = 'https://registry.npmjs.org/', ping = true, install = 0 } = {}) {
  const calls = []
  const run = (args, opts) => {
    calls.push({ args, opts })
    if (args[0] === 'config') return { status: 0, stdout: registry + '\n' }
    if (args[0] === 'ping') return { status: ping ? 0 : 1, stdout: '' }
    if (args[0] === 'prefix') return { status: 0, stdout: '/opt/npm-global\n' }
    if (args[0] === 'install') return { status: install }
    return { status: 1 }
  }
  const probe = () => ({ ok: true, version: '2.1.318 (Claude Code)', error: '' })
  return { run, calls, probe }
}

test('isOfficial: only registry.npmjs.org counts, with or without trailing slash', () => {
  assert.equal(d.isOfficial('https://registry.npmjs.org/'), true)
  assert.equal(d.isOfficial('https://registry.npmjs.org'), true)
  assert.equal(d.isOfficial('https://registry.npmmirror.com/'), false)
  assert.equal(d.isOfficial(''), false)
})

test('chooseRegistry: a user-configured mirror is kept as is (no --registry)', () => {
  assert.deepEqual(d.chooseRegistry('https://registry.npmmirror.com/', false), { registry: null, reason: 'configured' })
})

test('chooseRegistry: official reachable → no flag; unreachable → npmmirror', () => {
  assert.deepEqual(d.chooseRegistry('https://registry.npmjs.org/', true), { registry: null, reason: 'official' })
  assert.deepEqual(d.chooseRegistry('https://registry.npmjs.org/', false), { registry: d.MIRROR, reason: 'mirror' })
})

test('installArgs: global install, --registry only when given', () => {
  assert.deepEqual(d.installArgs('@anthropic-ai/claude-code', null), ['install', '-g', '@anthropic-ai/claude-code', '--include=optional', '--ignore-scripts=false'])
  assert.deepEqual(d.installArgs('@anthropic-ai/claude-code@2.1.318', d.MIRROR), ['install', '-g', '@anthropic-ai/claude-code@2.1.318', '--include=optional', '--ignore-scripts=false', '--registry', d.MIRROR])
  assert.deepEqual(d.installArgs('@openai/codex', d.MIRROR), ['install', '-g', '@openai/codex', '--registry', d.MIRROR])
  assert.deepEqual(d.installArgs(['a', 'b'], d.MIRROR), ['install', '-g', 'a', 'b', '--registry', d.MIRROR])
})

test('pickRegistry: configured mirror skips the ping entirely', () => {
  const npm = fakeNpm({ registry: 'https://registry.npmmirror.com/' })
  assert.equal(d.pickRegistry(npm.run).reason, 'configured')
  assert.equal(npm.calls.some((c) => c.args[0] === 'ping'), false)
})

test('pickRegistry: pings the official registry with a short fetch timeout', () => {
  const npm = fakeNpm({ ping: false })
  assert.equal(d.pickRegistry(npm.run).registry, d.MIRROR)
  const ping = npm.calls.find((c) => c.args[0] === 'ping')
  assert.ok(ping.args.includes(d.OFFICIAL))
  assert.ok(ping.args.includes('--fetch-retries=0'))
})

test('installGlobal: installs the right package, inherits the terminal, reports the mirror switch', () => {
  const npm = fakeNpm({ ping: false })
  const logs = []
  const r = d.installGlobal('claude', { run: npm.run, probe: npm.probe, log: (l) => logs.push(l) })
  assert.equal(r.ok, true)
  assert.equal(r.pkg, '@anthropic-ai/claude-code')
  assert.equal(r.registry, d.MIRROR)
  const inst = npm.calls.find((c) => c.args[0] === 'install')
  assert.deepEqual(inst.args, ['install', '-g', '@anthropic-ai/claude-code', '--include=optional', '--ignore-scripts=false', '--registry', d.MIRROR])
  assert.equal(inst.opts.stdio, 'inherit')
  assert.ok(logs.some((l) => l.includes('国内镜像')))
})

test('installGlobal: a failed npm install comes back as ok:false with the exit code', () => {
  const npm = fakeNpm({ install: 243 })
  const r = d.installGlobal('codex', { run: npm.run, probe: () => assert.fail('must not probe a failed install') })
  assert.equal(r.ok, false)
  assert.equal(r.code, 243)
  assert.equal(r.pkg, '@openai/codex')
})

test('installGlobal: unknown package name throws instead of installing something arbitrary', () => {
  assert.throws(() => d.installGlobal('left-pad', { run: fakeNpm().run }), /unknown package/)
})

test('installPackages: the design icon libraries go in one npm install, same registry choice', () => {
  const npm = fakeNpm({ ping: true })
  const pkgs = Object.values(require('../../src/design').ICON_LIBS).map((l) => l.pkg)
  const r = d.installPackages(pkgs, { run: npm.run })
  assert.equal(r.ok, true)
  const inst = npm.calls.filter((c) => c.args[0] === 'install')
  assert.equal(inst.length, 1)
  assert.deepEqual(inst[0].args, ['install', '-g', 'lucide-static', '@tabler/icons', '@phosphor-icons/core', 'pixelarticons'])
  assert.equal(inst[0].opts.stdio, 'inherit')
})

test('globalPrefix: trimmed npm prefix -g', () => {
  assert.equal(d.globalPrefix(fakeNpm().run), '/opt/npm-global')
})

test('installGlobal: npm exit 0 is a failure when the installed CLI cannot run', () => {
  const npm = fakeNpm()
  const probe = (bin, opts) => {
    assert.equal(bin, '/custom/claude')
    assert.equal(opts.name, 'claude')
    return { ok: false, version: '', error: 'EACCES' }
  }
  const r = d.installGlobal('claude', { run: npm.run, probe, bin: '/custom/claude' })
  assert.equal(r.code, 0, 'npm itself succeeded')
  assert.equal(r.ok, false, 'a broken CLI must not be reported as installed')
  assert.equal(r.verification.error, 'EACCES')
})

test('probeCli: validates version output and rejects placeholders, permission errors and timeouts', () => {
  const check = (result) => d.probeCli('claude', { run: (file, args, opts) => {
    assert.deepEqual(args.slice(-1), ['--version'])
    assert.equal(opts.timeout, 15_000)
    assert.equal(opts.encoding, 'utf8')
    return result
  } })
  assert.equal(check({ status: 0, stdout: '2.1.318 (Claude Code)\n' }).ok, true)
  assert.equal(check({ status: 0, stdout: 'Error: claude native binary not installed.' }).ok, false)
  assert.equal(check({ status: 1, stdout: '2.1.318 (Claude Code)' }).ok, false)
  assert.equal(check({ status: null, error: new Error('spawn EACCES') }).error, 'spawn EACCES')
  assert.equal(check({ status: null, error: new Error('spawn ETIMEDOUT') }).ok, false)
  assert.equal(d.probeCli('codex', { name: 'codex', run: () => ({ status: 0, stdout: 'codex-cli 0.164.0\n' }) }).ok, true)
})
