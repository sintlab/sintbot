// 数据目录收紧:daemon 的状态目录(~/.sbot)里有群聊正文(turns.jsonl)、登录与操作审计(audit.jsonl)、
// 反馈本、被打断请求的原文、日志和控制台会话令牌。默认 755 / 644 的权限下,同一台机器上的其他系统用户
// (多见于 Linux 服务器)都能读到。
//
// 目录收成 700 就足以把别的用户挡在门外;顶层文件和 logs/ 里的文件再收成 600,目录权限被改回去时仍有一层。
// 新文件由各写入方自己带 0o600 创建,这里负责把旧版本留下的文件收紧,每次启动跑一遍。
// 只动这一个目录,不碰项目目录;符号链接不跟(lstat),免得改到目录外的东西;Windows 没有这套权限位,跳过。

const fs = require('node:fs')
const path = require('node:path')

const DIR_MODE = 0o700
const FILE_MODE = 0o600

// → 收紧过的路径列表(本来就严的不算)
function secureDataDir(dir, { platform = process.platform } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  if (platform === 'win32') return []
  const changed = []
  const tighten = (p, mode) => {
    let st
    try { st = fs.lstatSync(p) } catch { return }
    if (st.isSymbolicLink() || (st.mode & 0o777 & ~mode) === 0) return
    try { fs.chmodSync(p, mode); changed.push(p) } catch { /* 别人的文件改不动:不阻断启动 */ }
  }
  const files = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(d, e.name)) } catch { return [] } }
  tighten(dir, DIR_MODE)
  for (const f of files(dir)) tighten(f, FILE_MODE)
  const logs = path.join(dir, 'logs')
  tighten(logs, DIR_MODE)
  for (const f of files(logs)) tighten(f, FILE_MODE)
  return changed
}

module.exports = { secureDataDir, DIR_MODE, FILE_MODE }
