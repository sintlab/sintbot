'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { collectEnvConflicts, describeWarning, reportEnvConflicts, PREFLIGHT_SCOPE_LINE } = require('../src/agent/envconflicts')

const HOME = '/tmp/sintbot-envconflicts-home'
const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
const files = (map) => (p) => (Object.hasOwn(map, p) ? map[p] : enoent())
const SETTINGS = `${HOME}/.claude/settings.json`, CODEX = `${HOME}/.codex/config.toml`

test('missing settings.json and config.toml still run and yield an array', () => {
  const w = collectEnvConflicts({ runner: 'claude', provider: {}, env: { PATH: '/usr/bin', HOME }, home: HOME, readFile: enoent })
  assert.deepEqual(w, [])
})

test('daemon env warnings pass through from the core with where/key/reason, keyed on runner and api key', () => {
  const env = { AWS_PROFILE: 'aws-secret-value', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'sk-secret-value', OPENAI_API_KEY: 'oa-secret-value', PATH: '/usr/bin' }
  const sub = collectEnvConflicts({ runner: 'claude', provider: { baseUrl: null, apiKey: '' }, env, home: HOME, readFile: enoent })
  const keys = sub.map((w) => w.key).sort()
  assert.deepEqual(keys, ['AWS_PROFILE', 'CLAUDE_CODE_USE_BEDROCK'])
  for (const w of sub) { assert.equal(w.where, 'env'); assert.equal(typeof w.reason, 'string'); assert.ok(w.reason) }
  const keyed = collectEnvConflicts({ runner: 'claude', provider: { baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'glm-secret' }, env, home: HOME, readFile: enoent })
  assert.ok(keyed.some((w) => w.key === 'ANTHROPIC_API_KEY'))
  const codex = collectEnvConflicts({ runner: 'codex', provider: {}, env, home: HOME, readFile: enoent })
  assert.deepEqual(codex.map((w) => w.key), ['OPENAI_API_KEY'])
})

test('settings.json env/model and config.toml model_provider are reported by file, never by value', () => {
  const readFile = files({
    [SETTINGS]: JSON.stringify({ model: 'opus-secret-model', env: { ANTHROPIC_BASE_URL: 'https://secret.example' } }),
    [CODEX]: 'model = "gpt-5"\nmodel_provider = "zai-secret"\n[model_providers.zai]\nbase_url = "https://secret-codex.example"\n' })
  const claude = collectEnvConflicts({ runner: 'claude', provider: {}, env: {}, home: HOME, readFile })
  assert.deepEqual(claude.map((w) => [w.where, w.key]).sort(), [['claude-settings', 'ANTHROPIC_BASE_URL'], ['claude-settings', 'model']])
  const codex = collectEnvConflicts({ runner: 'codex', provider: {}, env: {}, home: HOME, readFile })
  assert.ok(codex.some((w) => w.where === 'codex-config' && w.key === 'model_provider'))
  assert.ok(codex.some((w) => w.where === 'codex-config' && w.key === 'model_providers.zai'))
  const text = JSON.stringify([...claude, ...codex]) + claude.map(describeWarning).join('\n')
  for (const secret of ['secret.example', 'opus-secret-model', 'zai-secret', 'secret-codex.example']) assert.ok(!text.includes(secret), secret)
})

test('invalid settings.json is tolerated; non-string env values are ignored; describeWarning is key — reason', () => {
  const readFile = files({ [SETTINGS]: '{not json' })
  const w = collectEnvConflicts({ runner: 'claude', provider: {}, env: { AWS_REGION: 'r', UNDEF: undefined }, home: HOME, readFile })
  assert.deepEqual(w.map((x) => x.key), ['AWS_REGION'])
  assert.match(describeWarning(w[0]), /^AWS_REGION — .+/)
})

test('reportEnvConflicts: scope line first, one block per distinct active provider, paused routes skipped, failures non-fatal', () => {
  const out = []
  const write = (m) => out.push(m)
  const calls = []
  const collect = ({ runner, provider }) => {
    calls.push([runner, provider && provider.baseUrl])
    if (runner === 'codex') throw new Error('core unavailable')
    return [{ where: 'env', key: 'AWS_PROFILE', reason: 'r1' }, { where: 'claude-settings', key: 'model', reason: 'r2' }]
  }
  const glm = { runner: 'claude', baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'secret' }
  const routes = [
    { paused: false, group: { provider: 'glm' }, provider: glm },
    { paused: false, group: { provider: 'glm' }, provider: glm },
    { paused: false, group: {}, provider: { runner: 'codex' } },
    { paused: true, group: { provider: 'off' }, provider: { runner: 'claude' } }]
  const seen = reportEnvConflicts({ cfg: { defaultProvider: 'cx' }, routes }, write, { collect })
  assert.deepEqual(seen, ['glm', 'cx'])
  assert.deepEqual(out, [
    PREFLIGHT_SCOPE_LINE,
    'preflight · glm: AWS_PROFILE — r1\n',
    'preflight · glm: model — r2\n',
    'preflight · cx: environment check skipped (core unavailable)\n'])
  assert.match(PREFLIGHT_SCOPE_LINE, /^preflight · 环境冲突检查基于当前终端环境/)
  assert.deepEqual(calls, [['claude', glm.baseUrl], ['codex', undefined]])
  assert.ok(!out.join('').includes('secret'))
  const empty = []
  assert.deepEqual(reportEnvConflicts({ cfg: {}, routes: [] }, (m) => empty.push(m), { collect }), [])
  assert.deepEqual(empty, [], 'nothing to check → no scope line either')
  assert.deepEqual(reportEnvConflicts(undefined, (m) => empty.push(m), { collect }), [])
})
