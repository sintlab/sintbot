// 单实例锁:同一个状态目录只许一个 daemon。
//
// 为什么:两个 daemon 共用 ~/.sbot/state.json 会互相覆盖会话与水位线,而且抢同一个平台的消息 ——
// 飞书 / Slack 的长连接把每条消息随机分给其中一个,企业微信新连接踢旧连接、10 分钟内被踢两次就停连。
// 有了 `sbot service` 之后「终端里开着一个、服务又起一个」很常见,这把锁只防这种误操作,不限制管理员。
//
// 锁 = 状态目录里的 daemon.lock,内容是持有者 pid。启动时独占创建(wx);已存在就看那个 pid:
// 还活着且确实是 sbot ⇒ 拒绝启动;不在了(上次崩了没删 / 重启后 pid 被别的进程复用)⇒ 删掉重抢。
// 退出时只删自己写的那一把。

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// pid 还活着,且(能查命令行的平台上)命令行里有 sbot / sintbot —— 防 pid 被无关进程复用后误拦
function defaultIsSbot(pid) {
  try { process.kill(pid, 0) } catch (e) { if (e.code !== 'EPERM') return { alive: false } }
  if (process.platform === 'win32') return { alive: true, cmd: '' }
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return { alive: /\b(sbot|sintbot)\b/.test(cmd), cmd }
  } catch { return { alive: false } }
}

// → { ok: true, release } | { ok: false, holder, cmd }
function acquire(lockPath, { pid = process.pid, isSbot = defaultIsSbot } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, String(pid)); fs.closeSync(fd)
      const release = () => {
        try { if (fs.readFileSync(lockPath, 'utf8').trim() === String(pid)) fs.unlinkSync(lockPath) } catch { /* 已经没了 */ }
      }
      return { ok: true, release }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    let holder = NaN
    try { holder = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10) } catch { /* 刚被删 ⇒ 重抢 */ }
    if (holder && holder !== pid) {
      const h = isSbot(holder)
      if (h.alive) return { ok: false, holder, cmd: h.cmd || '' }
    }
    try { fs.unlinkSync(lockPath) } catch { /* 被别人先删了也行,下一轮 wx 定胜负 */ }
  }
  return { ok: false, holder: null, cmd: '' } // 两轮都没抢到:有另一个进程同时在抢
}

module.exports = { acquire }
