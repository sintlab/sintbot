'use strict'
// 控制台「接管浏览器」的一次性链接(纯逻辑,可测)。
//
// 场景:群 agent 撞到登录墙 / 验证码 / 扫码,自己做不了 ⇒ 它在群里发一条链接,群成员在手机上打开就能
// 直接操作 bot 的浏览器(登录态落在 bot 这边,以后它自己接着干)。群成员多半不是控制台管理员,所以
// 链接本身就是门票 —— 由此三条硬约束:
//   · **只能打开一次**:第一次打开换成一枚会话 cookie,链接立刻作废;被转发的人拿到的是一张已用过的票。
//   · **短命**:默认 10 分钟(cfg.browser.takeoverMinutes 可调),会话与链接同一到期时刻,不滑动续期。
//   · **只开这一扇门**:cookie 只对接管页与它的接口有效,控制台其它 /api/* 一律不认(server 那层裁决)。
// 谁能签票:控制台管理员(已登录)与本机环回上的进程(群 agent 跑 `sbot browser link`)。接管者自己不能再签。

const crypto = require('node:crypto')

const COOKIE = 'sbot-takeover'
const DEFAULT_TTL_MS = 10 * 60_000 // 够人从群里点开、登录、过一个验证码;再长就是给转发的人留窗口
const MIN_TTL_MS = 60_000           // 少于 1 分钟,人还没点开就过期了
const MAX_TTL_MS = 60 * 60_000      // 最多 1 小时:超过这个时长的「接管」应该去控制台用管理员身份做
const MAX_UNUSED = 50               // 没用过的票封顶:本机任何进程都能签票,不封顶就是一个内存黑洞;超了丢最老的

const rand = () => crypto.randomBytes(16).toString('hex')

// onClaimed / onExpired / onEnded:票挂了元数据(群里那张卡的 cardId)时,兑换 / 没人来过期 / 会话结束各回调一次 —— daemon 拿它把卡翻成
// 「正在接管中」/「已过期」/「接管已结束」。⚠ 结束那条是真机补的:v0.11.87 群里点了「结束接管」,卡还挂着「正在接管中」
function createTakeoverStore({ ttlMs = DEFAULT_TTL_MS, now = Date.now, onClaimed = null, onExpired = null, onEnded = null } = {}) {
  const links = new Map()    // token -> { id, exp, at, by, usedAt, sid, targetId, meta, timer }
  const byId = new Map()     // id -> token(id 不是秘密,给 attach 用)
  const sessions = new Map() // sid -> { exp, at, token, ip, targetId, meta, timer }
  // 会话结束的唯一出口:主动结束(ended)/ 到期(expired)都走这里 ⇒ 每个会话只回调一次
  const endSession = (sid, reason) => {
    const s = sessions.get(sid); if (!s) return false
    sessions.delete(sid); if (s.timer) clearTimeout(s.timer)
    if (s.meta && onEnded) { try { onEnded(s.meta, { reason }) } catch {} }
    return true
  }
  const prune = () => {
    const t = now()
    for (const [k, v] of links) if (!(v.exp > t)) links.delete(k)
    for (const [k, v] of sessions) if (!(v.exp > t)) endSession(k, 'expired')
  }
  return {
    // 签一张票。ttl 越界收编回 [1, 60] 分钟(不报错:签票方多半是 agent,报错它只会换个数再来)
    // targetId:把票绑在某个标签页上,持票人只能碰那一页(不给 = 全部标签页)
    mint({ by = '', ttl = ttlMs, targetId = '' } = {}) {
      prune()
      const unused = [...links.entries()].filter(([, l]) => !l.usedAt)
      for (const [k] of unused.slice(0, Math.max(0, unused.length - MAX_UNUSED + 1))) links.delete(k)
      const life = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(ttl) || ttlMs))
      const token = rand(); const id = rand().slice(0, 12); const at = now()
      const link = { id, exp: at + life, at, by: String(by || ''), usedAt: null, sid: null, targetId: String(targetId || ''), meta: null, timer: null }
      links.set(token, link); byId.set(id, token)
      // 过期回调:只对挂了元数据且没被兑换的票(群里有张卡等着翻成「已过期」);daemon 重启定时器就没了,可接受
      if (onExpired) { link.timer = setTimeout(() => { const l = links.get(token); if (l && !l.usedAt && l.meta) { try { onExpired(l.meta) } catch {} } }, life); if (link.timer.unref) link.timer.unref() }
      return { token, id, exp: at + life, ttlMs: life, targetId: String(targetId || '') }
    },
    // 用票换会话:过期 / 用过 / 不存在 ⇒ null。同一张票第二次来,哪怕是同一个人也不再放行(单次即用完)
    consume(token, { ip = '' } = {}) {
      prune()
      const l = links.get(String(token || ''))
      if (!l || l.usedAt) return null
      const sid = rand(); const at = now()
      l.usedAt = at; l.sid = sid
      if (l.timer) clearTimeout(l.timer)
      const s = { exp: l.exp, at, token: String(token), ip: String(ip || ''), targetId: l.targetId || '', meta: l.meta, timer: null }
      sessions.set(sid, s)
      // 到点没人主动结束 ⇒ 也算结束(人来过,卡翻「已结束」而不是「已过期」);prune 是懒的,靠这个定时器按时翻
      if (l.meta && onEnded) { s.timer = setTimeout(() => endSession(sid, 'expired'), Math.max(0, l.exp - now())); if (s.timer.unref) s.timer.unref() }
      if (l.meta && onClaimed) { try { onClaimed(l.meta) } catch {} }
      return { sid, exp: l.exp, targetId: l.targetId || '', meta: l.meta }
    },
    // 给票挂元数据(群里那张卡):按 id 找,票本身不用再传回来
    attach(id, meta) { const tok = byId.get(String(id || '')); const l = tok && links.get(tok); if (!l || l.usedAt) return false; l.meta = meta || null; return true },
    hasSession(sid) { prune(); return sessions.has(String(sid || '')) },
    session(sid) { prune(); return sessions.get(String(sid || '')) || null },
    revokeSession(sid) { return endSession(String(sid || ''), 'ended') },
    revokeAll() { const n = sessions.size + links.size; for (const k of [...sessions.keys()]) endSession(k, 'ended'); for (const l of links.values()) if (l.timer) clearTimeout(l.timer); links.clear(); return n },
    // 群里还挂着、没人来认领的票(控制台「需要你处理」用):只算挂了群卡的票 —— 那是 agent 在群里求助;
    // 管理员自己在控制台签的没有卡,不算。只给元数据,不给令牌。
    pending() {
      prune()
      return [...links.values()].filter((l) => !l.usedAt && l.meta && l.meta.chatId)
        .map((l) => ({ id: l.id, at: l.at, exp: l.exp, chatId: l.meta.chatId, pageTitle: l.meta.pageTitle || '', pageUrl: l.meta.pageUrl || '' }))
    },
    // 摘要(测试与排障用,不暴露令牌本身)
    stats() { prune(); return { links: links.size, unused: [...links.values()].filter((l) => !l.usedAt).length, sessions: sessions.size } },
  }
}

// —— cookie ——
function cookieValue(header, name = COOKIE) {
  const h = String(header || '')
  for (const part of h.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()) } catch { return '' } } // 畸形 cookie 不能把整站打成 500(对抗审查 🟡5)
  }
  return ''
}
// HttpOnly:页面脚本拿不到,只随请求走;SameSite=Lax:别的站点发不了带它的跨站 POST;经 https 反代时加 Secure
function setCookieHeader(sid, { maxAgeSec = 600, secure = false } = {}) {
  return `${COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}${secure ? '; Secure' : ''}`
}
const clearCookieHeader = ({ secure = false } = {}) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`

// 链接形状:<控制台根>/browser#k=<票>。票放在 URL 片段里:浏览器不会把它发给服务器 ⇒ 不进 nginx 访问日志、不被链接预览 / 安全扫描的裸 GET
// 拿走;页面脚本读片段后由人点「开始接管」再 POST 兑换。根优先公网地址(群成员出了局域网也打得开),没配就退局域网地址
const takeoverUrl = (base, token) => `${String(base || '').replace(/\/+$/, '')}/browser#k=${encodeURIComponent(token)}`

module.exports = { COOKIE, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS, MAX_UNUSED, createTakeoverStore, cookieValue, setCookieHeader, clearCookieHeader, takeoverUrl }
