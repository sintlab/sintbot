'use strict'
// 常驻浏览器的 CDP 客户端(Chrome DevTools Protocol)—— 控制台「接管浏览器」页的底座。
//
// 为什么自己写而不用 chrome-devtools-mcp:MCP 是给 agent 用的工具面(元素 uid、快照),接管页要的是
// **原始画面 + 原始输入** —— 截屏推流(Page.startScreencast)与按坐标的鼠标 / 键盘事件(Input.*),
// 且要在 daemon 进程里长连接、按需 attach 到某个标签页。MCP 没有这两样,也不该有(它面向 agent)。
//
// 传输:HTTP 端点(/json、/json/new …)走 node:http;协议通道走 WebSocket(`ws` 包 —— 飞书 SDK 已带同一份,
// 声明进依赖是为了不靠提升的巧合;Node 18/20 没有全局 WebSocket)。`WebSocketImpl` 可注入 ⇒ 单测用假的。
//
// ⚠ 只连 cfg.browser.cdpUrl(默认本机 9222)。9222 只绑 localhost,但本机任意进程都能经它操控已登录的浏览器
//   (docs/BROWSER.md 安全口径)—— 这里不再加门,门在控制台那层(登录 / 一次性链接)。

const http = require('node:http')

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222'

// —— HTTP 端点 ——
function httpJSON(url, { method = 'GET', timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, timeout: timeoutMs }, (res) => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { b += c })
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`浏览器端点 ${u.pathname} 返回 HTTP ${res.statusCode}`)) // 文案可能原样到接管页 / 群里,不带协议名
        if (!b.trim()) return resolve(null)
        try { resolve(JSON.parse(b)) } catch { resolve(b) } // /json/close 之类返回纯文本
      })
    })
    req.on('timeout', () => req.destroy(new Error('浏览器端点超时')))
    req.on('error', reject)
    req.end()
  })
}

// 浏览器还活着吗:/json/version(Browser 字段形如 "Chrome/152.0.7977.83")
const versionInfo = (cdpUrl = DEFAULT_CDP_URL, opts = {}) => httpJSON(`${cdpUrl}/json/version`, opts)

// 页面型 target 清单(过滤掉 chrome:// / devtools:// / 扩展页这类不是「网页」的东西)
async function listTargets(cdpUrl = DEFAULT_CDP_URL) {
  const all = (await httpJSON(`${cdpUrl}/json`)) || []
  return all
    .filter((t) => t && t.type === 'page' && /^(https?:|about:|file:)/.test(String(t.url || '')))
    .map((t) => ({ id: t.id, title: t.title || '', url: t.url || '', wsUrl: t.webSocketDebuggerUrl || '' }))
}

const newTarget = (cdpUrl, url) => httpJSON(`${cdpUrl}/json/new?${encodeURIComponent(url || 'about:blank')}`, { method: 'PUT' })
const activateTarget = (cdpUrl, id) => httpJSON(`${cdpUrl}/json/activate/${encodeURIComponent(id)}`)
const closeTarget = (cdpUrl, id) => httpJSON(`${cdpUrl}/json/close/${encodeURIComponent(id)}`)

// —— 协议会话 ——
// 一个 target 一条 ws。call() 按 id 配对回包;on() 收事件(Page.screencastFrame 之类)。
// 超时 / 断线时把所有挂着的 call 一起拒掉,调用方不会悬着。
class CdpSession {
  constructor(wsUrl, { WebSocketImpl = null, timeoutMs = 15000 } = {}) {
    this.wsUrl = wsUrl
    this.WebSocketImpl = WebSocketImpl || require('ws')
    this.timeoutMs = timeoutMs
    this.ws = null
    this.connected = false
    this._id = 0
    this._pending = new Map() // id -> { resolve, reject, timer }
    this._handlers = new Map() // method -> Set(fn)
    this._onClose = new Set()
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.wsUrl)
      this.ws = ws
      const fail = (e) => { if (!this.connected) reject(e instanceof Error ? e : new Error(String(e && e.message || e || '连不上浏览器'))) }
      ws.on('open', () => { this.connected = true; resolve(this) })
      ws.on('error', (e) => { fail(e); this._failAll(e) })
      ws.on('close', () => { this.connected = false; this._failAll(new Error('浏览器连接已断开')); for (const fn of this._onClose) { try { fn() } catch {} } })
      ws.on('message', (data) => this._onMessage(data))
    })
  }

  _onMessage(data) {
    let m
    try { m = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) } catch { return }
    if (m.id != null && this._pending.has(m.id)) {
      const p = this._pending.get(m.id); this._pending.delete(m.id); clearTimeout(p.timer)
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message || JSON.stringify(m.error)}`))
      else p.resolve(m.result || {})
      return
    }
    if (m.method) {
      const hs = this._handlers.get(m.method)
      if (hs) for (const fn of hs) { try { fn(m.params || {}) } catch (e) { /* 单个处理器出错不影响别的 */ } }
    }
  }

  _failAll(e) {
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(e) }
    this._pending.clear()
  }

  call(method, params = {}) {
    if (!this.connected || !this.ws) return Promise.reject(new Error('浏览器连接未就绪'))
    const id = ++this._id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this._pending.delete(id)) reject(new Error(`${method} 超时`)) }, this.timeoutMs)
      this._pending.set(id, { resolve, reject, timer, method })
      try { this.ws.send(JSON.stringify({ id, method, params })) } catch (e) { this._pending.delete(id); clearTimeout(timer); reject(e) }
    })
  }

  on(method, fn) { if (!this._handlers.has(method)) this._handlers.set(method, new Set()); this._handlers.get(method).add(fn); return () => this.off(method, fn) }
  off(method, fn) { const hs = this._handlers.get(method); if (hs) hs.delete(fn) }
  onClose(fn) { this._onClose.add(fn); return () => this._onClose.delete(fn) }

  close() { this.connected = false; try { this.ws && this.ws.close() } catch {} ; this._failAll(new Error('已关闭')) }
}

// —— 截屏推流 ——
// 帧只在页面重绘时才来(静止页面零流量),所以开流后先补一张 captureScreenshot 当首帧,免得人盯着空白。
// ack 放在 onFrame 之后:消费方(SSE 写入)慢了,浏览器就攒着不发下一帧 —— 天然背压,不用自己丢帧。
// 默认值的来由(2026-09-10 真机实测,手机尺寸):640 宽 / 45 质量一帧约 12 KB;everyNthFrame=2 把不限速时的 ~28 fps 压到一半,
// 再由「onFrame 完成后才 ack」的背压按链路自然降到几帧每秒 —— 画面够顺、公网隧道与手机流量都扛得住。
async function startScreencast(session, { maxWidth = 640, maxHeight = 1280, quality = 45, everyNthFrame = 2 } = {}, onFrame) {
  await session.call('Page.enable')
  const off = session.on('Page.screencastFrame', async (p) => {
    try { await onFrame({ data: p.data, meta: p.metadata || {}, sessionId: p.sessionId }) } catch {}
    try { await session.call('Page.screencastFrameAck', { sessionId: p.sessionId }) } catch {}
  })
  await session.call('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame })
  try { await seedFrame(session, { maxWidth, maxHeight, quality }, onFrame) } catch { /* 首帧补不上就等真帧 */ }
  return async () => { off(); try { await session.call('Page.stopScreencast') } catch {} }
}

// 补一张首帧(开流时、以及后来才加入同一路推流的订阅者)。
// ⚠ 首帧必须与推流帧同尺寸:captureScreenshot 默认按视口原尺寸出图,而推流帧被 maxWidth/maxHeight 缩过 ——
//   两者不一致时,接管页在第二帧到来那一刻画面会跳一下,手指正按着的位置就漂了(2026-09-10 真机:拖滑块位移 0)。
//   先读视口尺寸,按同样的比例给截图加 clip.scale。
async function seedFrame(session, { maxWidth = 640, maxHeight = 1280, quality = 45 } = {}, onFrame) {
  const lm = await session.call('Page.getLayoutMetrics')
  const vv = (lm && (lm.cssVisualViewport || lm.visualViewport)) || {}
  const cw = vv.clientWidth || 0, ch = vv.clientHeight || 0
  const scale = cw > 0 && ch > 0 ? Math.min(1, maxWidth / cw, maxHeight / ch) : 1
  const params = { format: 'jpeg', quality }
  if (cw > 0 && ch > 0) params.clip = { x: 0, y: 0, width: cw, height: ch, scale }
  const shot = await session.call('Page.captureScreenshot', params)
  await onFrame({ data: shot.data, meta: { deviceWidth: cw, deviceHeight: ch, seed: true }, sessionId: null })
}

// 给 CLI 用:截某个标签页一张缩略图(接管卡片上的「卡在哪个页面」)。连一次、截一张、关掉;失败抛错由调用方决定要不要图。
async function captureTarget(cdpUrl, targetId, { maxWidth = 640, quality = 60, WebSocketImpl = null } = {}) {
  const targets = await listTargets(cdpUrl)
  const t = targets.find((x) => x.id === targetId)
  if (!t) throw new Error('这个标签页已经不在了')
  const session = new CdpSession(t.wsUrl, { WebSocketImpl })
  await session.connect()
  try {
    let data = null
    await seedFrame(session, { maxWidth, maxHeight: maxWidth * 2, quality }, (f) => { data = f.data })
    return { data, title: t.title, url: t.url }
  } finally { session.close() }
}

// —— 输入:接管页发来的事件 → CDP 调用(纯函数,可测)——
// 坐标一律是页面 CSS 像素(接管页按帧的 deviceWidth/Height 换算好再发),这里只做校验与翻译。
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
}
// 一次插入的文本上限:验证码 / 账号 / 一段地址都远小于此;更长的多半是误粘贴(整页文本),不该一股脑塞进输入框
const MAX_TEXT = 4000
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null)

// 非文本键必须带 windowsVirtualKeyCode:CDP 只凭 key/code 不会触发页面里按键盘码判断的逻辑(表单的 Enter 提交、退格删字)—— 与 puppeteer 的键表同款。
// 坐标上限 20000 / 滚轮上限 5000:视口再大也到不了的值,只用来拦明显的垃圾输入(NaN、负数、乱填),不是精确边界。
// 一个接管页事件 → 若干 { method, params };不认识 / 不合法 ⇒ null(调用方跳过,不报错,免得一个坏事件卡住整批)
function inputToCdp(ev) {
  if (!ev || typeof ev !== 'object') return null
  const t = ev.t
  if (t === 'text') {
    const text = String(ev.text == null ? '' : ev.text)
    if (!text || text.length > MAX_TEXT) return null
    return [{ method: 'Input.insertText', params: { text } }]
  }
  if (t === 'key') {
    const k = Object.prototype.hasOwnProperty.call(KEYS, String(ev.key)) ? KEYS[ev.key] : null // hasOwn:'__proto__' 之类的键名不能摸到原型
    if (!k) return null
    const mods = (ev.shift ? 8 : 0) | (ev.ctrl ? 2 : 0) | (ev.alt ? 1 : 0) | (ev.meta ? 4 : 0)
    // Enter 的 text 让输入框真的换行 / 提交:keyDown 带 text 才触发 keypress 语义(与 puppeteer 同款)
    const down = { type: k.text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: mods }
    if (k.text) down.text = k.text
    return [{ method: 'Input.dispatchKeyEvent', params: down }, { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: mods } }]
  }
  const x = num(ev.x), y = num(ev.y)
  if (x == null || y == null || x < 0 || y < 0 || x > 20000 || y > 20000) return null
  if (t === 'move') return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: ev.down ? 'left' : 'none', buttons: ev.down ? 1 : 0 } }]
  if (t === 'down') return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 } }]
  if (t === 'up') return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 } }]
  if (t === 'tap') return [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'none', buttons: 0 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 } },
  ]
  if (t === 'wheel') {
    const dx = num(ev.dx) || 0, dy = num(ev.dy) || 0
    if (Math.abs(dx) > 5000 || Math.abs(dy) > 5000) return null
    return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy } }]
  }
  return null
}

// 一批事件按序下发;坏事件跳过(计入 skipped),CDP 报错(页面正在导航之类)记下继续,不中断整批。
// 超过 max 时只丢 move / wheel(丢掉中间几步无伤),**down / up / key / text 一个都不能丢** —— 丢了 up 鼠标就卡在按下态
// (对抗审查 🟡7);丢了多少报 dropped,让页面知道。
function trimEvents(events, max) {
  const list = Array.isArray(events) ? events : []
  if (list.length <= max) return { list, dropped: 0 }
  const must = list.filter((e) => e && e.t !== 'move' && e.t !== 'wheel')
  const room = Math.max(0, max - must.length)
  const soft = list.filter((e) => e && (e.t === 'move' || e.t === 'wheel'))
  const keepSoft = new Set(soft.slice(soft.length - room)) // 留最近的几步,老的丢
  const out = list.filter((e) => e && (e.t !== 'move' && e.t !== 'wheel' ? true : keepSoft.has(e))).slice(0, Math.max(max, must.length))
  return { list: out, dropped: list.length - out.length }
}
async function dispatchInputs(session, events, { max = 200 } = {}) {
  const { list, dropped } = trimEvents(events, max)
  let sent = 0, skipped = 0, failed = 0
  for (const ev of list) {
    const calls = inputToCdp(ev)
    if (!calls) { skipped++; continue }
    for (const c of calls) { try { await session.call(c.method, c.params); sent++ } catch { failed++ } }
  }
  return { sent, skipped, failed, dropped }
}

// 接管页 → 页面坐标:帧图片的像素坐标按帧元数据里的视口尺寸(CSS px)线性换算;越界夹回
function pointerToCss({ px, py, imgW, imgH, cssW, cssH }) {
  if (!(imgW > 0) || !(imgH > 0) || !(cssW > 0) || !(cssH > 0)) return null
  const x = Math.min(cssW, Math.max(0, (px / imgW) * cssW))
  const y = Math.min(cssH, Math.max(0, (py / imgH) * cssH))
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
}

module.exports = { DEFAULT_CDP_URL, httpJSON, versionInfo, listTargets, newTarget, activateTarget, closeTarget, CdpSession, startScreencast, seedFrame, captureTarget, inputToCdp, dispatchInputs, trimEvents, pointerToCss, KEYS, MAX_TEXT }
