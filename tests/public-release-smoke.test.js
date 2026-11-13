'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const entry = path.join(root, 'bin/sintbot-v2.js')
const loader = path.join(root, 'src/agent/privatecore.js')
const binary = path.join(root, 'src/agent/privatecore.wasm')

function run(args, options = {}) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name === 'SBOT_CONFIG' || name.startsWith('SBOT_C2_')) delete env[name]
  }
  return spawnSync(process.execPath, args, {
    cwd: root, env, encoding: 'utf8', timeout: 15_000, ...options,
  })
}

test('installed entry reports this release and its supported commands', () => {
  const pkg = require('../package.json')
  assert.equal(pkg.version, '1.4.21')
  assert.equal(pkg.bin.sintbot, 'bin/sintbot-v2.js')
  assert.equal(pkg.bin.sbot, pkg.bin.sintbot)
  const version = run([entry, '--version'])
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.trim(), pkg.version)
  const help = run([entry, '--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /sintbot init/)
  assert.match(help.stdout, /sintbot start/)
  assert.match(help.stdout, /sintbot connect/)
  const connectHelp = run([entry, 'connect', '--help'])
  assert.equal(connectHelp.status, 0, connectHelp.stderr)
  assert.match(connectHelp.stdout, /sintbot connect \[--config/)
})

test('connect is an operator command, not an action of the agent-facing feishu skill', () => {
  const result = run([entry, 'feishu', 'connect'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unknown feishu action/)
  assert.doesNotMatch(result.stdout + result.stderr, /accounts\.feishu\.cn/)
})

test('unsupported legacy commands fail instead of invoking an old engine', () => {
  for (const command of ['chat', 'ui', 'service', 'agent']) {
    const result = run([entry, command])
    assert.notEqual(result.status, 0, command)
    assert.match(result.stderr, /unavailable|unsupported|not supported/i)
  }
  for (const file of ['bin/sbot.js', 'src/core/engine.js', 'src/core/failover.js', 'tests/oracle']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file)
  }
})

test('the actual binary core loads in a fresh process', () => {
  assert.ok(fs.statSync(binary).size > 0)
  const result = run(['-e', 'require(process.argv[1]); process.stdout.write("CORE_LOADED")', loader])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'CORE_LOADED')
})

test('a missing or changed core fails without a JavaScript fallback', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sintbot-public-core-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const copy = path.join(dir, 'privatecore.js')
  fs.copyFileSync(loader, copy)
  const missing = run(['-e', 'require(process.argv[1])', copy])
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /binary core is missing or unreadable/)
  const changed = Buffer.from(fs.readFileSync(binary))
  changed[changed.length - 1] ^= 1
  fs.writeFileSync(path.join(dir, 'privatecore.wasm'), changed)
  const mismatch = run(['-e', 'require(process.argv[1])', copy])
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /binary core does not match its loader/)
})

test('the package ships its declared files and no private development sources', () => {
  const pkg = require('../package.json')
  assert.equal(pkg.private, false)
  for (const file of pkg.files) assert.ok(fs.existsSync(path.join(root, file)), file)
  for (const file of pkg.files) {
    assert.doesNotMatch(file, /\.(map|rs)$|(^|\/)(Cargo\.toml|tests?)\//, file)
  }
  for (const required of ['src/c2multigroupservice.js', 'src/c2console.js', 'src/c2incident.js', 'src/c2updater.js', 'src/c2upgradeswitch.js', 'src/ui/console.html']) {
    assert.ok(pkg.files.includes(required), required)
  }
})
