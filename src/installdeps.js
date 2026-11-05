// 安装向导替新用户装 Claude Code / Codex:`sbot setup` 第 0 步发现没装时问一句,答是就
// `npm i -g <包>`(继承终端,进度看得见)。一键安装脚本(install.sh)装完 sintbot 后也是走这里,
// 装依赖的逻辑只有这一份。
//
// 源的选择:用户自己配过 npm 源(如国内镜像)就照用,不加 --registry;还是官方源时先
// `npm ping` 一下(用 npm 自己的代理配置,和真正安装时走的路一致 —— Node 的 fetch 不读代理),
// 连不上就换 npmmirror,免得国内新用户卡在下载上。
const { spawnSync } = require('node:child_process')
const { resolveSpawn } = require('./agent/winexec')

const OFFICIAL = 'https://registry.npmjs.org/'
const MIRROR = 'https://registry.npmmirror.com/'
const PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' }

const isOfficial = (url) => /^https?:\/\/registry\.npmjs\.org\/?$/i.test(String(url || '').trim())

// 纯函数:已配源 + ping 结果 → 安装时要不要带 --registry、带哪个。
function chooseRegistry(configured, officialReachable) {
  if (configured && !isOfficial(configured)) return { registry: null, reason: 'configured' }
  if (officialReachable) return { registry: null, reason: 'official' }
  return { registry: MIRROR, reason: 'mirror' }
}

// pkg 可以是一个包名,也可以是一组(设计图标库四个包一条命令装齐)
function installArgs(pkg, registry) {
  const packages = [].concat(pkg)
  // Claude's npm package needs both its platform optional dependency and postinstall.
  const native = packages.some((p) => /^@anthropic-ai\/claude-code(?:@|$)/.test(p))
  return ['install', '-g', ...packages, ...(native ? ['--include=optional', '--ignore-scripts=false'] : []), ...(registry ? ['--registry', registry] : [])]
}

// A file (or npm exit 0) is not proof of a working CLI: interrupted extraction
// can leave a placeholder instead of the native binary. Never start a session here.
function probeCli(bin, { name = 'claude', run = spawnSync } = {}) {
  const { file, spawnArgs } = resolveSpawn(bin, ['--version'])
  const r = run(file, spawnArgs, { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  const version = String(r.stdout || '').trim()
  const expected = name === 'claude' ? /\bClaude Code\b/i : /\bcodex(?:-cli)?\b/i
  const ok = r.status === 0 && expected.test(version) && /\b\d+\.\d+\.\d+\b/.test(version)
  return { ok, version: ok ? version : '', error: ok ? '' : String(r.error?.message || r.stderr || r.stdout || `exit ${r.status}${r.signal ? ` (${r.signal})` : ''}`).trim().slice(0, 1000) }
}

function runNpm(args, opts = {}) {
  const { file, spawnArgs } = resolveSpawn('npm', args)
  return spawnSync(file, spawnArgs, { encoding: 'utf8', ...opts })
}

function configuredRegistry(run = runNpm) {
  const r = run(['config', 'get', 'registry'], { timeout: 10_000 })
  return r.status === 0 ? String(r.stdout || '').trim() : ''
}

function pingOfficial(run = runNpm) {
  const r = run(['ping', '--registry', OFFICIAL, '--fetch-timeout=6000', '--fetch-retries=0'], { timeout: 15_000 })
  return r.status === 0
}

function pickRegistry(run = runNpm) {
  const configured = configuredRegistry(run)
  if (configured && !isOfficial(configured)) return chooseRegistry(configured, false)
  return chooseRegistry(configured, pingOfficial(run))
}

function globalPrefix(run = runNpm) {
  const r = run(['prefix', '-g'], { timeout: 10_000 })
  return r.status === 0 ? String(r.stdout || '').trim() : ''
}

// 装一个(name ∈ PACKAGES 的键)。stdio 继承终端;返回 { ok, pkg, registry, code }。
function installGlobal(name, { run = runNpm, log = () => {}, probe = probeCli, bin = name } = {}) {
  const pkg = PACKAGES[name]
  if (!pkg) throw new Error(`unknown package: ${name}`)
  const result = installPackages(pkg, { run, log })
  if (!result.ok) return result
  const verification = probe(bin, { name })
  return { ...result, ok: verification.ok, verification }
}

// 按包名装(一个或一组),选源同上。只给向导装确定的包用(Claude Code / Codex / 设计图标库),不接用户输入的名字
function installPackages(pkg, { run = runNpm, log = () => {} } = {}) {
  const { registry, reason } = pickRegistry(run)
  if (reason === 'mirror') log(`npm 官方源连不上,改用国内镜像 ${MIRROR}`)
  const args = installArgs(pkg, registry)
  log(`$ npm ${args.join(' ')}`)
  const r = run(args, { stdio: 'inherit' })
  return { ok: r.status === 0, pkg, registry, code: r.status }
}

module.exports = { OFFICIAL, MIRROR, PACKAGES, isOfficial, chooseRegistry, installArgs, probeCli, pickRegistry, globalPrefix, installGlobal, installPackages }
