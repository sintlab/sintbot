// `sintbot setup` 的输入一上来就结束(</dev/null、管道、Docker RUN、CI):每一问拿默认值,得能走完。
// 1.0.8 在模型菜单原地空转(默认「1」→ key 为空 → 回菜单),3 分钟写出 18 GB。
// 环境只给临时 HOME 和只有 node 的 PATH:没有 claude / codex、没有模型 key,正好走到那个菜单。
// 1.0.12 起默认流程只问环境和模型:不问是否在中国大陆、代理、聊天平台凭据、项目根目录、绑群(用户 10-28 定,装完在控制台配)。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const BIN = path.join(__dirname, '..', '..', 'bin', 'sbot.js')

function runSetup(lang, extraArgs = [], claudeScript = '') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-setup-eof-'))
  try {
    const home = path.join(tmp, 'home')
    const bin = path.join(tmp, 'bin')
    fs.mkdirSync(home)
    fs.mkdirSync(bin)
    fs.symlinkSync(process.execPath, path.join(bin, 'node'))
    if (claudeScript) fs.writeFileSync(path.join(bin, 'claude'), claudeScript, { mode: 0o755 })
    const cfg = path.join(tmp, 'config.json')
    const r = spawnSync(process.execPath, [BIN, 'setup', '--config', cfg, ...extraArgs], {
      cwd: tmp, input: '', encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: '1', LANG: 'en_US.UTF-8', SINTBOT_LANG: lang },
    })
    const out = (r.stdout || '') + (r.stderr || '')
    const written = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, 'utf8')) : null
    return { r, out, written }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

test('setup with stdin already at EOF finishes on defaults instead of looping', { skip: process.platform === 'win32' }, () => {
  const { r, out, written } = runSetup('zh')
  assert.equal(r.error, undefined, `setup did not finish: ${r.error && r.error.code}\n${out.slice(-2000)}`)
  assert.ok(out.length < 200000, `output kept growing (${out.length} chars)`)
  assert.equal((out.match(/先跳过\(之后在控制台/g) || []).length, 1, 'model menu shown more than once')
  assert.match(out, /稍后自己装/) // 没人回答时不替他装 Claude Code
  assert.doesNotMatch(out, /\$ npm install/) // 也不替他装设计图标库或别的东西
  assert.ok(written, `config not written\n${out.slice(-2000)}`)
  // 默认流程不在终端里要这些
  for (const q of [/中国大陆/, /配置代理/, /飞书 appId/, /接哪个聊天平台/, /项目根目录/, /绑定一个/, /机器人在群里叫什么/]) assert.doesNotMatch(out, q)
  // 1.0.13 起只剩没有模型时的菜单要回答:可选组件、默认模型、试跑都不问
  const asked = out.split('\n').filter((l) => /^(\x1b\[[0-9;]*m)*\?(\x1b\[[0-9;]*m)* /.test(l))
  assert.equal(asked.length, 1, asked.join('\n'))
  assert.match(out, /sintbot service install/)
  assert.match(out, /127\.0\.0\.1:4600/)
  // 示例里的飞书 env: 占位和空代理不写进新配置
  assert.equal(written.feishu, undefined)
  assert.equal(written.proxy, undefined)
})

test('setup speaks English when the locale says so', { skip: process.platform === 'win32' }, () => {
  const { r, out, written } = runSetup('en')
  assert.equal(r.error, undefined, out.slice(-2000))
  assert.ok(written)
  assert.match(out, /Skip for now \(add one later on the console Models page\)/)
  assert.match(out, /Install it later: npm i -g/)
  assert.doesNotMatch(out, /[\u4e00-\u9fff]/, out.split('\n').filter((l) => /[\u4e00-\u9fff]/.test(l)).slice(0, 5).join('\n'))
})

test('setup --full still asks the platform questions', { skip: process.platform === 'win32' }, () => {
  const { r, out } = runSetup('zh', ['--full'])
  assert.equal(r.error, undefined, out.slice(-2000))
  assert.match(out, /接哪个聊天平台|接哪些聊天平台/)
  assert.match(out, /项目根目录/)
  assert.doesNotMatch(out, /这台机器在中国大陆吗/) // --full 也不问地区
})

test('setup verifies a real CLI version instead of accepting an executable placeholder', { skip: process.platform === 'win32' }, () => {
  const bad = runSetup('en', [], '#!/usr/bin/env node\nconsole.log("Error: claude native binary not installed.")\n')
  assert.equal(bad.r.error, undefined)
  assert.match(bad.out, /Claude Code CLI\) is unavailable/)
  assert.match(bad.out, /native binary not installed/)
  assert.doesNotMatch(bad.out, /✓[^\n]*claude/)
  const good = runSetup('en', [], '#!/usr/bin/env node\nif(process.argv.includes("--version")){console.log("2.1.318 (Claude Code)");process.exit(0)}\nprocess.exit(1)\n')
  assert.equal(good.r.error, undefined)
  assert.match(good.out, /✓[^\n]*claude[^\n]*2\.1\.318 \(Claude Code\)/, 'control: a working CLI is accepted')
})
