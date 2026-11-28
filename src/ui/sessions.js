'use strict'
// 控制台登录会话:落盘 + 过期 + 可按条件吊销,守护进程重启不再把人登出。
//
// 此前会话令牌只在内存 Set 里,每次发版重启都要重输密码 —— 那是「两道密码」体验里最频繁的一次输入。
// 这里改成:令牌 → { exp, via, who, ip, at, …身份线索 } 存 JSON(权限 0600,原子写),默认 30 天固定有效期
// (不滑动:拿到令牌的人最多用 30 天,登出即失效)。文件读坏就当空(登录一次就恢复,不阻断)。
// 与密码 / 飞书登录两条路无关 —— 谁签发都进这里,鉴权只问 has(token)。
//
// ⚠ 落盘带来一个新义务:会话活得比进程久,**名单里删掉的人、换过的密码**必须能让旧会话立刻失效,
//    否则被删的人最多还能再遥控这台机器 30 天(对抗审查 🔴)。所以每条会话记着签发时的身份线索
//    (飞书:openId;密码:当时密码 hash 的前缀),由 server 在配置变化时调 revokeWhere 对齐。

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const DEFAULT_TTL_MS = 30 * 24 * 3600_000

function createSessionStore({ file, ttlMs = DEFAULT_TTL_MS, now = Date.now, log = () => {} } = {}) {
  const map = new Map() // token -> meta

  const prune = () => { const t = now(); for (const [k, m] of map) if (!m || !(m.exp > t)) map.delete(k) }
  const persist = () => {
    if (!file) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, tokens: Object.fromEntries(map) }, null, 1) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (e) { log(`ui sessions: 写不进 ${path.basename(file)}(${e.message})—— 会话只在内存里,重启后要重新登录`) }
  }
  const load = () => {
    map.clear()
    if (!file || !fs.existsSync(file)) return
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      const toks = j && j.tokens && typeof j.tokens === 'object' ? j.tokens : {}
      // 文件虽是 0600、我们自己写的,但曾被手改 / 写坏过的可能永远存在:只认形状合法的令牌与带过期时间的项,其余当没有
      for (const [k, m] of Object.entries(toks)) if (/^[0-9a-f]{16,128}$/.test(k) && m && typeof m.exp === 'number') map.set(k, m)
      prune()
    } catch (e) { log(`ui sessions: ${path.basename(file)} 读不出来(${e.message}),按没有会话处理`) }
  }
  load()

  return {
    // 签发:via = 'password' | 'feishu';who = 展示名;ip = TCP 对端;其余字段(openId / authRef / xff)原样存,
    // 供吊销与审计用 —— 只存字符串,不存令牌以外的任何秘密。
    add({ via = 'password', who = '', ip = '', ...extra } = {}) {
      prune()
      const token = crypto.randomBytes(24).toString('hex')
      const meta = { exp: now() + ttlMs, via, who: String(who || ''), ip: String(ip || ''), at: now() }
      for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') meta[k] = String(v)
      map.set(token, meta)
      persist(); return token
    },
    // 读路径上也会写盘:撞见过期项就顺手删并落盘 —— 没有定时清理器,读到就是唯一的清理时机
    has(token) {
      if (!token || !map.has(token)) return false
      const m = map.get(token)
      if (!(m && m.exp > now())) { map.delete(token); persist(); return false }
      return true
    },
    get(token) { return this.has(token) ? { ...map.get(token) } : null },
    remove(token) { if (map.delete(token)) persist() },
    // 按条件吊销(名单删人 / 换密码时由 server 调),返回吊销条数;一条都没吊销就不写盘
    revokeWhere(pred) {
      let n = 0
      for (const [k, m] of map) if (pred({ ...m })) { map.delete(k); n++ }
      if (n) persist()
      return n
    },
    // 全部吊销(「退出所有设备」)
    clear() { const n = map.size; map.clear(); persist(); return n },
    get size() { prune(); return map.size },
  }
}

module.exports = { createSessionStore, DEFAULT_TTL_MS }
