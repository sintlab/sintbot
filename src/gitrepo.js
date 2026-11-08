// 群项目 ↔ git 远端关联(控制台「仓库地址」字段)。
//
// 场景:项目代码已经在本地 workdir 里,operator 在代码平台上为它新建了一个**空**仓库,
// 填地址是为了之后把本地项目推上去。所以这里**不做 clone** —— 远端没东西可拉。控制台只
// 负责建立关联(git init + remote origin,幂等),真正的 add/commit/push 交给 agent
// (它有 workdir、有判断力,该决定 .gitignore / commit message / 推哪些文件)。
//
// 安全:仓库地址是控制台传来的自由文本,而 git 的部分 transport 会执行命令 ——
// `git ls-remote 'ext::sh -c <任意命令>'` 就是 RCE,`--upload-pack=` 同理。控制台虽已
// 鉴权,仍按 fail-closed 做协议白名单:只放行 SSH 两种写法,其余一律拒。所有 git 调用
// 走 execFile(数组参数、不经 shell),不存在拼接注入。
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// scp 写法: git@host:org/repo.git   ·   URL 写法: ssh://git@host[:port]/org/repo.git
const SSH_SCP = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._~-][A-Za-z0-9._~/-]*$/
const SSH_URL = /^ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+(:\d{1,5})?\/[A-Za-z0-9._~/-]+$/

function validateRepoUrl(url) {
  const u = String(url == null ? '' : url).trim()
  if (!u) return { ok: false, error: '仓库地址为空' }
  // 以 - 开头会被 git 当成选项 —— 挡在正则之前,错误信息才说得清
  if (u.startsWith('-')) return { ok: false, error: '仓库地址不能以 - 开头' }
  if (/^ext::/i.test(u)) return { ok: false, error: '拒绝 ext:: 地址(该 transport 会执行任意命令)' }
  if (/^(file|git):/i.test(u)) return { ok: false, error: '只支持 SSH 地址,不支持 file:// / git:// ' }
  if (/^https?:/i.test(u)) return { ok: false, error: '只支持 SSH 地址 — HTTPS 要把令牌写进 URL 或存明文凭据,易随 git remote -v / 日志泄露' }
  if (!SSH_SCP.test(u) && !SSH_URL.test(u)) {
    return { ok: false, error: '不是合法的 SSH 仓库地址,应形如 git@codeup.aliyun.com:org/repo.git' }
  }
  return { ok: true, url: u }
}

// 只带 git 用得上的 env。BatchMode/GIT_TERMINAL_PROMPT 是硬要求:无头环境下任何交互
// 提示(输密码、确认 host key)都会把请求挂死 —— sbot 的头号纪律是绝不挂起。
function gitEnv() {
  const SAFE = ['PATH', 'PATHEXT', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TEMP', 'TMP']
  const env = {}
  for (const k of SAFE) if (process.env[k] !== undefined) env[k] = process.env[k]
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10'
  return env
}

function git(cwd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, env: gitEnv(), maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = ((stdout || '') + (stderr ? (stdout ? '\n' : '') + stderr : '')).trim()
      resolve({ ok: !err, out, code: err ? (err.code ?? null) : 0 })
    })
  })
}

// 把 git/ssh 的英文错误翻成 operator 能照着做的一句话。凭据/主机密钥是这条链路最常见的两种挂法。
function humanizeGitError(out) {
  const s = String(out || '')
  if (/Permission denied \(publickey|Permission denied, please try again/i.test(s)) {
    // ssh 对「有 key 但没被接受」和「压根没有 key 可提供」返回同一句 Permission denied (publickey),
    // 但两者修法完全不同 ⇒ 两种都点出来,别让人以为一定是加错了账号。
    return '凭据不通:这台机器没有能被该主机接受的 SSH key — 可能是①这台机器上还没配 key(~/.ssh 里没有对应私钥,或 ~/.ssh/config 没指向它),或②公钥没加到对应账号 / 该账号对本仓库无权限'
  }
  if (/Host key verification failed|No ED25519 host key is known|authenticity of host/i.test(s)) {
    return '主机密钥未预置:在该机器上先跑 ssh-keyscan <host> >> ~/.ssh/known_hosts(无头环境无法交互确认)'
  }
  if (/Repository path not found|repository .* not found|does not appear to be a git repository|找不到代码库/i.test(s)) {
    return '仓库不存在,或当前凭据对它无权限(远端对无权限的库通常也报「找不到」)'
  }
  if (/Could not resolve hostname|Name or service not known/i.test(s)) return '域名解析失败:检查网络 / 代理设置'
  if (/Connection timed out|Operation timed out|timed out/i.test(s)) return '连接超时:检查网络 / 防火墙,或该主机的 SSH 端口不通'
  if (/Connection refused/i.test(s)) return '连接被拒:该主机的 SSH 端口不可达'
  return s.split('\n').filter(Boolean).slice(-2).join(' · ') || '未知错误'
}

// 路径比对一律过 realpath:git 的 --show-toplevel 返回**解析过符号链接**的真实路径,而
// 配置里的 workdir 常是带软链的写法(macOS 的 /var→/private/var、或 ~/Projects 是软链)。
// 直接 resolve 比对会把「本目录自己的仓库」误判成「嵌套在别人的仓库里」。
const realpath = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

// workdir 的 git 现状:是不是仓库、origin 指向哪、当前分支(空仓库也能拿到)。
async function repoStatus(workdir) {
  if (!workdir || !fs.existsSync(workdir)) return { isRepo: false, origin: '', branch: '' }
  // --git-dir 存在 ≠ 就是本目录的仓库(可能是父目录的);用 rev-parse 拿顶层再比对
  const top = await git(workdir, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return { isRepo: false, origin: '', branch: '' }
  const isSelf = realpath(top.out) === realpath(workdir)
  if (!isSelf) return { isRepo: false, origin: '', branch: '', nestedIn: top.out }
  const o = await git(workdir, ['remote', 'get-url', 'origin'])
  const b = await git(workdir, ['symbolic-ref', '--short', 'HEAD']) // 空仓库(无 commit)也返回默认分支名
  return { isRepo: true, origin: o.ok ? o.out : '', branch: b.ok ? b.out : '' }
}

// 建立关联(幂等):不是仓库就 git init,然后 origin add/set-url。
// 分支不指定 —— 跟随该机器的 init.defaultBranch,不替 operator 拍板 main/master。
async function linkRepo(workdir, url) {
  const v = validateRepoUrl(url)
  if (!v.ok) return v
  if (!workdir || !fs.existsSync(workdir)) return { ok: false, error: `workdir 不存在: ${workdir}` }
  let st = await repoStatus(workdir)
  if (st.nestedIn) return { ok: false, error: `该目录在另一个 git 仓库内(${st.nestedIn}),拒绝在此 git init` }
  let initialized = false
  if (!st.isRepo) {
    const r = await git(workdir, ['init'])
    if (!r.ok) return { ok: false, error: 'git init 失败:' + humanizeGitError(r.out) }
    initialized = true
    st = await repoStatus(workdir)
  }
  const r2 = st.origin
    ? await git(workdir, ['remote', 'set-url', 'origin', v.url])
    : await git(workdir, ['remote', 'add', 'origin', v.url])
  if (!r2.ok) return { ok: false, error: '设置 origin 失败:' + humanizeGitError(r2.out) }
  const after = await repoStatus(workdir)
  return { ok: true, url: v.url, initialized, replaced: !!st.origin && st.origin !== v.url, branch: after.branch }
}

// —— 轻量状态(纯 fs,不 spawn git)——
// 群卡右上角的「仓库 ✓」标签要反映**真实**关联,不能只回显配置里的字符串(origin 被手改/删掉时
// 标签还绿着 = 骗人)。但 buildState 每个 API 响应都跑一遍、per-group spawn git 扛不住,所以
// 这里直接读 .git/config —— 一次小文件读,和 existsSync 同量级。
function readOriginFromGitConfig(workdir) {
  try {
    const gitPath = path.join(workdir, '.git')
    const st = fs.statSync(gitPath)
    if (!st.isDirectory()) return null // .git 是文件(worktree/submodule)—— 少见,不猜,交给慢路径
    const text = fs.readFileSync(path.join(gitPath, 'config'), 'utf8')
    const sec = text.match(/\[remote\s+"origin"\][^[]*/) // 该 section 到下一个 [ 之前
    if (!sec) return ''
    const u = sec[0].match(/^\s*url\s*=\s*(.+)$/m)
    return u ? u[1].trim() : ''
  } catch { return null } // 不是仓库 / 读不动
}

// '' = 没配仓库(不显示标签) · ok = origin 与配置一致 · missing = 已不是 git 仓库 · drift = origin 对不上
function quickLinkState(workdir, configuredRepo) {
  if (!configuredRepo) return ''
  const origin = readOriginFromGitConfig(workdir)
  if (origin === null) return 'missing'
  return origin === configuredRepo ? 'ok' : 'drift'
}

// 连通性 + 权限探测:ls-remote 不落地任何东西,是最轻的「这把凭据能不能用」的问法。
async function testRemote(url) {
  const v = validateRepoUrl(url)
  if (!v.ok) return v
  const r = await git(process.cwd(), ['ls-remote', '--heads', v.url], 25000)
  if (!r.ok) return { ok: false, error: humanizeGitError(r.out) }
  const branches = r.out.split('\n').filter((l) => /refs\/heads\//.test(l)).length
  return { ok: true, branches, empty: branches === 0 }
}

module.exports = { validateRepoUrl, repoStatus, linkRepo, testRemote, humanizeGitError, readOriginFromGitConfig, quickLinkState }
