// 有国际站的厂商(智谱 / MiniMax):向导不问「在不在中国大陆」(1.0.12 起),先试一个站,认证失败自动换另一个站再试。
// 用一个假的 claude:只有连中国站(api.minimaxi.com)才答得上,别的站一律 401。时区设成纽约 ⇒ 先试国际站 ⇒ 被拒 ⇒ 换中国站跑通。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const BIN = path.join(__dirname, '..', '..', 'bin', 'sbot.js')

const FAKE_CLAUDE = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('2.1.318 (Claude Code)'); process.exit(0) }
if (args.includes('auth')) process.exit(1)
const url = process.env.ANTHROPIC_BASE_URL || ''
const ok = url.includes('api.minimaxi.com')
process.stdout.write(JSON.stringify({ type: 'result', subtype: ok ? 'success' : 'error', is_error: !ok, session_id: 's', result: ok ? 'ready' : 'API Error: 401 invalid api key', usage: {} }) + '\\n')
`

test('setup finds the right site for a MiniMax key by trying both, without asking where you are', { skip: process.platform === 'win32', timeout: 60000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-setup-site-'))
  try {
    const home = path.join(tmp, 'home')
    const bin = path.join(tmp, 'bin')
    fs.mkdirSync(home)
    fs.mkdirSync(bin)
    fs.symlinkSync(process.execPath, path.join(bin, 'node'))
    fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 })
    // 设计图标库放一份假的:CI 机器上没装,向导会多问一句「现在安装?」,下面按顺序给的回答就错位了
    const icons = path.join(tmp, 'icons')
    for (const def of Object.values(require('../../src/design').ICON_LIBS)) fs.mkdirSync(path.join(icons, def.pkg), { recursive: true })
    const cfg = path.join(tmp, 'config.json')
    fs.writeFileSync(cfg, JSON.stringify({ agent: { bin: 'claude' }, providers: { claude: {} }, defaultProvider: 'claude', groups: {}, design: { iconsDir: icons } }), { mode: 0o600 })
    // 回答:菜单选 2(别家)· 选 2(MiniMax)· 粘贴 key(codex 没装不再问)
    const r = spawnSync(process.execPath, [BIN, 'setup', '--config', cfg], {
      cwd: tmp, input: '2\n2\nsk-test-key\n', encoding: 'utf8', timeout: 50000,
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: '1', SINTBOT_LANG: 'zh', TZ: 'America/New_York' },
    })
    const out = (r.stdout || '') + (r.stderr || '')
    assert.equal(r.error, undefined, out.slice(-2000))
    assert.doesNotMatch(out, /中国大陆|哪个站开的/)
    const tries = out.match(/用 MiniMax\((api\.[^)]+)\) 试跑一轮/g) || []
    assert.deepEqual(tries, ['用 MiniMax(api.minimax.io) 试跑一轮', '用 MiniMax(api.minimaxi.com) 试跑一轮'], out.slice(-2000))
    assert.match(out, /MiniMax · \S+ 能用/)
    const written = JSON.parse(fs.readFileSync(cfg, 'utf8'))
    assert.match(written.providers.minimax.baseUrl, /api\.minimaxi\.com/)
    assert.equal(written.defaultProvider, 'minimax')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
