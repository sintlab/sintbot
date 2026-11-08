'use strict'
// 控制台「接管浏览器」的接口面(/api/browser/*)—— 与 server.js 的路由分开放,server 只做鉴权裁决与页面分发。
//
// 一屏:
//   GET  /api/browser/targets            bot 浏览器现有标签页(+ 浏览器活着没有);持票绑定了标签页的人只看到那一页
//   POST /api/browser/targets {url}      新开一个标签页(管理员 / 本机;持票的人不许 —— 票不是「随便开网页」的许可)
//   POST /api/browser/targets/activate   把某个标签页切到前台(机器旁边的人看得到)
//   POST /api/browser/link {minutes,tab} 签一条一次性接管链接(管理员或本机环回;可用 tab 把票绑在某个标签页上)
//   POST /api/browser/link/attach {id,card} 给票挂上群里那张卡(cardId / chatId / 标题):兑换 / 过期时 daemon 翻卡
//   POST /api/browser/claim {k}          用票换 cookie(页面上点「开始接管」才调;票走 URL 片段 ⇒ 不进任何服务端日志)
//   GET  /api/browser/stream?id=&w=&q=   截屏推流(SSE 形状,用 fetch 流式读 —— 令牌走请求头,不进 URL)
//   POST /api/browser/input {id,events}  鼠标 / 键盘事件按序下发
//   POST /api/browser/end                接管者主动结束(会话作废、cookie 清掉)
//
// 与浏览器之间:每个标签页**一条** CDP 会话 + **一路**截屏推流,看的人是订阅者(fan-out):首个订阅者开流、最后一个走了才停流,
// 一帧要等所有订阅者都写完才 ack(背压按最慢的那个人算)—— 否则两人同看,一人离开另一人画面就冻住(对抗审查 🟡2)。
// 没人看也没人输入 30 秒后关会话。浏览器没起来 / 标签页关了 ⇒ 接口回 ok:false + 一句人话,页面照常显示,不炸。
// 审计:签票、用票、每次推流结束(帧数 / 秒数 / 输入次数)各一条进 ~/.sbot/audit.jsonl;帧内容与输入内容不落盘。

const IDLE_CLOSE_MS = 30_000 // 没人看也没人输入 30 秒才关 CDP 会话:切标签页 / 断线重连都在这窗口内,免得反复建连
const MAX_EVENTS = 200 // 一次输入请求最多 200 个事件:接管页 33ms 合并一次移动,正常一批只有几条;更多的是失控重放

function createBrowserRoutes({ readRaw, audit, log = () => {}, cdp = require('../cdp'), takeover, sendJSON, body, publicBase = () => '', lanBase = () => '', localBase = () => '', secureFor = () => false } = {}) {
  const registry = new Map() // targetId -> { session, target, refs, idle, cast: null | { subs:Set, stop, params } }
  const pendingAcquire = new Map() // targetId -> Promise(entry):两个人同时点同一标签页,只建一条会话(对抗审查 🟡2)
  const inputCount = new Map() // `${who}|${sid}|${targetId}` -> n(推流结束时随审计带走)
  const sidStreams = new Map() // 接管会话 sid -> Set<结束这路推流的函数>:会话作废 / 到期时把它的推流一起断掉

  const cfgBrowser = () => { try { return (readRaw().browser || {}) } catch { return {} } }
  const cdpUrl = () => String(cfgBrowser().cdpUrl || cdp.DEFAULT_CDP_URL).replace(/\/+$/, '')
  const ttlMs = () => { const m = Number(cfgBrowser().takeoverMinutes); return m > 0 ? m * 60_000 : takeover.DEFAULT_TTL_MS }
  // 到页面 / 群里的错误一律说人话:连不上是最常见的一种;其余原样给一句短的,但不带协议名与端点路径(cdp.js 已按此措辞)
  const human = (e) => { const m = String((e && e.message) || e || ''); if (/ECONNREFUSED|超时|ETIMEDOUT/.test(m)) return '浏览器没连上(它可能没启动)'; return m ? `浏览器出错了:${m.slice(0, 120)}` : '浏览器出错了' }

  async function acquire(id) {
    const e = registry.get(id)
    if (e && e.session.connected) { e.refs++; if (e.idle) { clearTimeout(e.idle); e.idle = null }; return e }
    if (pendingAcquire.has(id)) { const entry = await pendingAcquire.get(id); entry.refs++; return entry }
    const p = (async () => {
      const targets = await cdp.listTargets(cdpUrl())
      const t = targets.find((x) => x.id === id)
      if (!t) throw new Error('这个标签页已经不在了')
      const session = new cdp.CdpSession(t.wsUrl)
      await session.connect()
      const entry = { session, refs: 1, idle: null, target: t, cast: null }
      registry.set(id, entry)
      session.onClose(() => { if (registry.get(id) === entry) registry.delete(id); if (entry.cast) for (const s of entry.cast.subs) { try { s.end() } catch {} } })
      return entry
    })()
    pendingAcquire.set(id, p)
    try { return await p } finally { pendingAcquire.delete(id) }
  }
  function release(id) {
    const e = registry.get(id); if (!e) return
    e.refs = Math.max(0, e.refs - 1)
    if (e.refs === 0 && !e.idle) e.idle = setTimeout(() => { registry.delete(id); e.session.close() }, IDLE_CLOSE_MS).unref()
  }

  // 订阅推流:首个订阅者开流(参数取他的),后来的先补一张按自己尺寸缩的首帧再一起收;最后一个走了才停流。
  async function subscribe(entry, sub, params) {
    if (!entry.cast) {
      const cast = { subs: new Set([sub]), params, stop: async () => {} }
      entry.cast = cast
      // 一帧要等**所有**订阅者写完才 ack(startScreencast 在 onFrame 之后才 ack)—— 慢的那个人决定帧率,谁都不会被丢下
      cast.stop = await cdp.startScreencast(entry.session, params, async (f) => { await Promise.all([...cast.subs].map((s) => s.write(f))) })
      return
    }
    entry.cast.subs.add(sub)
    try { await cdp.seedFrame(entry.session, params, (f) => sub.write(f)) } catch { /* 补不上就等真帧 */ }
  }
  async function unsubscribe(entry, sub) {
    const cast = entry.cast; if (!cast) return
    cast.subs.delete(sub)
    if (cast.subs.size === 0) { entry.cast = null; try { await cast.stop() } catch {} }
  }

  // ctx:{ p, authedAdmin, takeoverSid, takeoverTarget, takeoverExp, localMint, ip, xff }。返回 true = 已处理
  async function handle(req, res, url, ctx) {
    const { p } = ctx
    // sendJSON 不返回值,这里统一回 true 表示「已处理」—— 否则 server 会继续往下匹配,最后撞出 headers already sent
    const json = (code, obj) => { sendJSON(res, code, obj); return true }
    const who = ctx.authedAdmin ? 'admin' : (ctx.takeoverSid ? 'takeover' : (ctx.localMint ? 'local' : ''))
    const isTakeover = who === 'takeover'
    const bound = isTakeover ? String(ctx.takeoverTarget || '') : ''
    // 持票绑定了标签页的人,只能碰那一页(对抗审查 🟡8:票的权限面不该比「登这一个站」大)
    const denyOther = (id) => bound && String(id) !== bound

    if (p === '/api/browser/targets' && req.method === 'GET') {
      try {
        const [v, targets] = await Promise.all([cdp.versionInfo(cdpUrl()), cdp.listTargets(cdpUrl())])
        const list = (bound ? targets.filter((t) => t.id === bound) : targets).map((t) => ({ id: t.id, title: t.title, url: t.url }))
        return json(200, { ok: true, browser: (v && v.Browser) || '', targets: list, mode: who, bound: bound || null })
      } catch (e) { return json(200, { ok: false, error: human(e), targets: [], mode: who, bound: bound || null }) }
    }
    if (p === '/api/browser/targets' && req.method === 'POST') {
      if (isTakeover) return json(403, { error: '接管链接只能操作机器人已经打开的页面,不能新开网址' })
      const { url: u } = await body(req)
      const target = String(u || '').trim()
      if (!/^(https?:\/\/|about:blank$)/i.test(target)) return json(400, { error: '要打开的地址得是 http(s):// 开头' })
      try { const t = await cdp.newTarget(cdpUrl(), target); return json(200, { ok: true, id: t && t.id, url: t && t.url }) }
      catch (e) { return json(502, { error: human(e) }) }
    }
    if (p === '/api/browser/targets/activate' && req.method === 'POST') {
      const { id } = await body(req)
      if (!id) return json(400, { error: '缺 id' })
      if (denyOther(id)) return json(403, { error: '这条接管链接只对应一个页面' })
      try { await cdp.activateTarget(cdpUrl(), String(id)); return json(200, { ok: true }) }
      catch (e) { return json(502, { error: human(e) }) }
    }
    if (p === '/api/browser/link' && req.method === 'POST') {
      // 谁能签:管理员(已登录)或本机环回(群 agent)。接管者自己(只有 cookie)到不了这里 —— server 的门只给 /api/browser/link 放行前两种
      if (!ctx.authedAdmin && !ctx.localMint) return json(403, { error: '只有管理员或本机能生成接管链接' })
      const { minutes, tab } = await body(req)
      const ttl = Number(minutes) > 0 ? Number(minutes) * 60_000 : ttlMs()
      // tab:网址 / 标题片段 ⇒ 把票绑在那个标签页上(agent 知道自己卡在哪个页面,不知道 id)。给了却没匹配上要说清,别静默签一张全开的票
      let targetId = ''; let hit = null
      const want = String(tab || '').trim().toLowerCase()
      if (want) {
        let targets; try { targets = await cdp.listTargets(cdpUrl()) } catch (e) { return json(502, { error: human(e) }) }
        // id 比较也走小写:want 已经小写化,而 Chrome 的标签页 id 是大写十六进制 —— 严格相等等于按 id 永远绑不上(2026-09-15 实测只能用网址片段)
        hit = targets.find((t) => String(t.id).toLowerCase() === want) || targets.find((t) => `${t.url} ${t.title}`.toLowerCase().includes(want))
        if (!hit) return json(400, { error: `浏览器里没有匹配「${String(tab).slice(0, 60)}」的标签页` })
        targetId = hit.id
      }
      const m = takeover.mint({ by: who, ttl, targetId })
      // 链接的根:公网 > 局域网 > 只绑本机时退成 127.0.0.1(那条链接只有这台电脑自己打得开 —— 要说清,别让 agent 把死链接发进群)
      const reach = publicBase() ? 'public' : (lanBase() ? 'lan' : 'local')
      const base = publicBase() || lanBase() || localBase()
      if (!base) return json(500, { error: '算不出控制台地址' })
      audit.append({ kind: 'takeover-mint', by: who, ip: ctx.ip, exp: m.exp, target: targetId || null, reach, ts: Date.now() })
      return json(200, { ok: true, id: m.id, url: takeover.takeoverUrl(base, m.token), exp: m.exp, minutes: Math.round(m.ttlMs / 60_000), public: reach === 'public', reach, target: targetId || null, pageTitle: hit ? hit.title : '', pageUrl: hit ? hit.url : '' })
    }
    if (p === '/api/browser/link/attach' && req.method === 'POST') {
      if (!ctx.authedAdmin && !ctx.localMint) return json(403, { error: '只有管理员或本机能操作' })
      const { id, card } = await body(req)
      if (!id || !card || typeof card !== 'object') return json(400, { error: '缺 id 或 card' })
      const ok = takeover.attach(String(id), { cardId: String(card.cardId || ''), chatId: String(card.chatId || ''), pageTitle: String(card.pageTitle || ''), pageUrl: String(card.pageUrl || ''), minutes: Number(card.minutes) || 10 })
      return json(ok ? 200 : 404, ok ? { ok: true } : { error: '这张票不存在或已经用掉了' })
    }
    if (p === '/api/browser/claim' && req.method === 'POST') {
      // 票换 cookie。只有页面上点了「开始接管」才会到这里 —— 链接预览 / 安全扫描那种裸 GET 抓不走票(对抗审查 🟡6)
      const { k } = await body(req)
      const got = takeover.consume(String(k || ''), { ip: ctx.ip })
      audit.append({ kind: 'takeover-use', ok: !!got, ip: ctx.ip, xff: ctx.xff, ts: Date.now() })
      if (!got) return json(410, { error: '这条接管链接已失效 —— 它只能用一次,而且只在发出后的几分钟内有效。请让机器人重新发一条。' })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': takeover.setCookieHeader(got.sid, { maxAgeSec: (got.exp - Date.now()) / 1000, secure: secureFor(req) }), 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, exp: got.exp, target: got.targetId || null })); return true
    }
    if (p === '/api/browser/stream' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') || '')
      if (!id) return json(400, { error: '缺 id' })
      if (denyOther(id)) return json(403, { error: '这条接管链接只对应一个页面' })
      // 宽度 240~1600 / 质量 20~90:下限保证还看得清,上限挡住把画面调成 4K 原图那种能把隧道塞死的请求
      const w = Math.min(1600, Math.max(240, Number(url.searchParams.get('w')) || 640))
      const q = Math.min(90, Math.max(20, Number(url.searchParams.get('q')) || 45))
      const t0 = Date.now(); let frames = 0; let closed = false; let started = false
      const sub = {
        // 写不动就等 drain 再回;socket 已销毁则立刻回(否则一帧 base64 挂在 promise 上永远不放)
        write: (f) => new Promise((resolve) => {
          if (res.destroyed || closed) return resolve()
          frames++
          const ok = res.write(`event: frame\ndata: ${JSON.stringify({ b64: f.data, w: f.meta.deviceWidth || 0, h: f.meta.deviceHeight || 0, seed: !!f.meta.seed })}\n\n`)
          if (ok) return resolve()
          const done = () => { res.off('drain', done); res.off('close', done); resolve() }
          res.on('drain', done); res.on('close', done)
        }),
        end: () => { try { res.end() } catch {} },
      }
      // 接管者的推流跟着会话走:自己点「结束」/ 管理员「退出所有设备」/ 到期 ⇒ 推流当场断,页面重连撞 401 才翻成「已到期」。
      // 不断的话会话作废了画面还在流 —— 输入早已 401,但一张 10 分钟的票能一直看下去(真机:服务端结束后页面仍停在接管态)
      // ⚠ 要在 acquire 之前登记:CDP 忙时(agent 正在同一标签页截图)建会话能等好几秒,这窗口里收到「结束」却没人能断它 ⇒ 之后照流到票到期(真机撞过)
      let expTimer = null
      if (ctx.takeoverSid) {
        if (!sidStreams.has(ctx.takeoverSid)) sidStreams.set(ctx.takeoverSid, new Set())
        sidStreams.get(ctx.takeoverSid).add(sub.end)
        if (ctx.takeoverExp > 0) expTimer = setTimeout(sub.end, Math.max(0, ctx.takeoverExp - Date.now())).unref()
      }
      const unlist = () => { if (expTimer) clearTimeout(expTimer); if (ctx.takeoverSid && sidStreams.has(ctx.takeoverSid)) { const s = sidStreams.get(ctx.takeoverSid); s.delete(sub.end); if (!s.size) sidStreams.delete(ctx.takeoverSid) } }
      let entry
      try { entry = await acquire(id) } catch (e) { unlist(); return res.writableEnded ? true : json(502, { error: human(e) }) }
      // 建会话期间这一路已经被结束(会话作废)或客户端走了 ⇒ close 事件早发过、finish 还没挂 ⇒ 这里自己放掉引用,否则这条 CDP 会话永远不闲置关闭
      if (res.writableEnded || res.destroyed) { unlist(); release(id); return true }
      // ⚠ 拿到会话就先挂 close:开流那几百毫秒里客户端掐断,晚挂的话这一路永远不释放(对抗审查 🟡1)
      const writeEv = (ev, obj) => { if (!res.destroyed && !closed) { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`) } catch {} } }
      const offNav = entry.session.on('Page.frameNavigated', (pr) => { const f = pr && pr.frame; if (f && !f.parentId) writeEv('meta', { id, url: f.url || '' }) })
      const finish = async () => {
        if (closed) return; closed = true
        offNav(); unlist()
        if (started) { try { await unsubscribe(entry, sub) } catch {} }
        release(id)
        const key = `${who}|${ctx.takeoverSid || ''}|${id}`; const inputs = inputCount.get(key) || 0; inputCount.delete(key)
        audit.append({ kind: 'takeover-stream', by: who, target: id, url: entry.target.url, frames, inputs, secs: Math.round((Date.now() - t0) / 1000), ip: ctx.ip, ts: Date.now() })
      }
      req.on('close', finish)
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      writeEv('meta', { id, url: entry.target.url, title: entry.target.title, mode: who })
      try {
        await subscribe(entry, sub, { maxWidth: w, quality: q })
        started = true
      } catch (e) { writeEv('error', { error: human(e) }); sub.end() }
      // 开流期间客户端已经走了 ⇒ close 事件早就发过、那时 started 还是 false ⇒ 这里补一次退订
      if (closed && started) { try { await unsubscribe(entry, sub) } catch {} }
      return true
    }
    if (p === '/api/browser/input' && req.method === 'POST') {
      const { id, events } = await body(req)
      if (!id) return json(400, { error: '缺 id' })
      if (denyOther(id)) return json(403, { error: '这条接管链接只对应一个页面' })
      if (!Array.isArray(events) || !events.length) return json(400, { error: '缺 events' })
      let entry
      try { entry = await acquire(String(id)) } catch (e) { return json(502, { error: human(e) }) }
      try {
        const r = await cdp.dispatchInputs(entry.session, events, { max: MAX_EVENTS })
        const key = `${who}|${ctx.takeoverSid || ''}|${id}`; inputCount.set(key, (inputCount.get(key) || 0) + r.sent)
        return json(200, { ok: true, ...r })
      } finally { release(String(id)) }
    }
    if (p === '/api/browser/end' && req.method === 'POST') {
      if (ctx.takeoverSid) { takeover.revokeSession(ctx.takeoverSid); endTakeoverStreams(ctx.takeoverSid); audit.append({ kind: 'takeover-end', ip: ctx.ip, ts: Date.now() }) }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': takeover.clearCookieHeader({ secure: secureFor(req) }) })
      res.end(JSON.stringify({ ok: true })); return true
    }
    return false
  }

  // 断掉接管者的推流:指定 sid 只断它的;不指定 = 全部(「退出所有设备」)。管理员自己的推流不在这张表里,不受影响
  function endTakeoverStreams(sid = '') { let n = 0; for (const [k, s] of sidStreams) { if (sid && k !== sid) continue; for (const end of [...s]) { n++; try { end() } catch {} } } return n }

  function close() { for (const [id, e] of registry) { try { if (e.idle) clearTimeout(e.idle); e.session.close() } catch {} registry.delete(id) } }

  return { handle, close, endTakeoverStreams, cdpUrl, _registry: registry }
}

module.exports = { createBrowserRoutes, IDLE_CLOSE_MS, MAX_EVENTS }
