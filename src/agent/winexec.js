// Shared Windows executable resolution for spawning agent CLIs (claude, codex).
//
// npm-installed CLIs on Windows are `.cmd` batch shims that Node's spawn() (no
// shell) cannot execute directly — you get ENOENT even though the command works in
// the terminal. And a bare extensionless file on PATH is npm's POSIX shell shim,
// which Windows' CreateProcess also can't run. So: resolve to a *runnable* file
// honouring PATHEXT (native .exe preferred over an npm .cmd shim), and run a
// .cmd/.bat through cmd.exe with an ARGV array (NOT shell:true — Node still quotes
// each arg, and callers feed the prompt via stdin, dodging cmd.exe metacharacter
// mangling). POSIX: pure passthrough, so the Mac/Linux path is byte-for-byte the
// same as calling the bin directly.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const IS_WIN = process.platform === 'win32'

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

// nvm 把每个 node 版本各装一套,bin 目录名里带版本号;新到旧排,先试最近装的那套
function nvmBinDirs(home) {
  const root = path.join(home, '.nvm', 'versions', 'node')
  try { return fs.readdirSync(root).sort().reverse().map((v) => path.join(root, v, 'bin')) } catch { return [] }
}

// 配置钉死的绝对路径指空时,找**同一个程序**的另一份 —— 不切模型、不清会话、不报错。
// 典型情况:CLI 自更新把新版装进 nvm 前缀、homebrew 那份被清掉,配置钉的路径指空
// ⇒ 每轮都失败,而新版明明就在 ~/.nvm/…/bin 里。候选顺序 = PATH 各目录 → 原生安装器 ~/.local/bin →
// homebrew / usr-local → nvm 各版本。只管「绝对路径且文件不在」;裸名字照旧交给 PATH。
// 返回 { bin, fallback }:fallback 非空 = 这次用的不是配置那条,调用方记一行日志让人去改配置。
const FIXED_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] // 两个常见全局前缀;单测把它换成空,免得本机真实安装混进沙箱
function locateBin(bin, { fixedDirs = FIXED_DIRS } = {}) {
  if (!bin || !path.isAbsolute(bin) || isFile(bin)) return { bin, fallback: null }
  const home = os.homedir()
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), ...fixedDirs, ...nvmBinDirs(home)]
  const name = path.basename(bin)
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, name)
    if (p !== bin && isFile(p)) return { bin: p, fallback: p }
  }
  return { bin, fallback: null }
}

function resolveSpawn(bin, args) {
  const loc = locateBin(bin) // 所有起 agent 进程的地方(轮次 / 旗子探针 / 版本探针 / 登录态探针)都经这里,一处兜底全覆盖
  bin = loc.bin
  if (!IS_WIN) return { file: bin, spawnArgs: args, fallback: loc.fallback }
  const resolved = resolveWinExecutable(bin)
  if (!resolved) return { file: bin, spawnArgs: args, fallback: loc.fallback } // not found → let ENOENT surface with the caller's hint
  const ext = path.extname(resolved).toLowerCase()
  if (ext === '.cmd' || ext === '.bat') {
    return { file: process.env.ComSpec || 'cmd.exe', spawnArgs: ['/d', '/s', '/c', resolved, ...args], fallback: loc.fallback }
  }
  return { file: resolved, spawnArgs: args, fallback: loc.fallback } // real .exe → spawn directly, cleanest
}

// A minimal `where`: resolve a bare command against PATH + PATHEXT. PATHEXT order
// (.EXE before .CMD) means a native <bin>.exe is preferred over an npm .cmd shim.
function resolveWinExecutable(bin) {
  const tryFile = (p) => { try { return fs.statSync(p).isFile() ? p : null } catch { return null } }
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  // Resolve one path to a *runnable* file: honour an explicit extension, else try
  // each PATHEXT. NEVER match a bare extensionless file — on PATH that's npm's POSIX
  // shell shim (a file literally named `claude`/`codex`), which Windows' CreateProcess
  // cannot execute; its runnable sibling is `<bin>.cmd`/`.exe`.
  const runnable = (p) => (path.extname(p) ? tryFile(p) : null) || exts.map((e) => tryFile(p + e)).find(Boolean) || null

  if (bin.includes('/') || bin.includes('\\') || path.extname(bin)) return runnable(bin)

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const hit = runnable(path.join(dir, bin))
    if (hit) return hit
  }
  return null
}

module.exports = { IS_WIN, resolveSpawn, resolveWinExecutable, locateBin }
