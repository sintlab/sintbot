// 出网代理(CONNECT 隧道)—— 管的是 **daemon 自己出网**这一层。
//
// 由来(2026-09-01 实测撞出来):
// **Node 的 `fetch`(undici)与 `ws` 都不读 `http_proxy` / `HTTPS_PROXY`**。同一台 Mac、
// 同一个 Clash 系统代理(127.0.0.1:7890):`curl` 通、Chrome 通,而 Node 直连被墙。
// 挂上隧道后 REST 1351ms / WS 1479ms,直连两条都是 12s 超时。
//
// ⚠ **这个洞最贵的地方是错误形态不说人话** ⇒ 极易误读成「平台挂了 / 账号有问题 / token 不对」:
//   · `fetch` → `TypeError: fetch failed`,cause 是 `UND_ERR_CONNECT_TIMEOUT`
//   · `ws`    → **「连上了但一直没 Hello」**,连 error 都不报,就是干等
//   两者都不会说「你没走代理」。所以本模块凡是拒绝出网,都必须**自己把原因说出来**。
// ⚠ 更贵的一层:Clash 一类的 **TUN / 增强模式**接管全部流量时,Node 不配置也能出去 ——
//   于是开发机上「明明是好的」,别人那台不是。**「我这儿是好的」在这条上没有信息量。**
//
// ⚠ `src/config.js` 的 `applyProxyEnv` 只把代理**塞进 env 给 spawn 出去的 agent CLI 继承**
//   (注释原文 "so every spawned `claude` child inherits it")—— **daemon 自己出网不经过它**。
//   飞书 SDK 自带 http 栈所以从没暴露过;是 Slack 适配器用裸 `fetch` + 裸 `new WebSocket()`
//   才把这个洞顶出来。本模块就是补这一层,读的仍是 `applyProxyEnv` 落下的那几个 env 变量
//   ⇒ **配置只有 `cfg.proxy` 一个来源**,daemon 与子进程走同一份,不会各读各的。
//
// ⭐ 零依赖能解:HTTP `CONNECT` + `tls.connect` 包成 `https.Agent` 子类,REST 与 WS
//   **共用同一个 agent**。⇒ `src/design.js`「从参考提炼」段头那条「要支持得引依赖 —— 这是零依赖守则
//   不换的东西」**已被推翻**(要引依赖的是 undici 的 `ProxyAgent`/`setGlobalDispatcher`,
//   那是另一条路)。⚠ REST 必须从 `fetch` 换成 `node:https` —— **`fetch` 没有挂 agent 的口子**。
//
// ⚠ **只支持 `http://` 的代理**(明文 HTTP CONNECT)。`socks5://` / `https://` 一律不认:
//   把 SOCKS 端口当 HTTP 代理发 CONNECT,在 Clash 的 mixed-port 上会**恰好碰对**(同一端口
//   两种协议都收),纯 SOCKS 端口上则是 `socket hang up` 或干挂 —— 又是那种不说人话的错。
//   有的机器 shell 里就配着 `all_proxy=socks5://…`,所以这条不是假想。

const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')

// 与 applyProxyEnv 落下的键一一对应(大小写两套都读:各家工具约定不统一)。
// ⚠ 顺序即优先级 —— 改顺序要同步改所有用到它的地方,不然会出现「这条路通、那条路不通」这种最难查的差异。
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy']

function parseProxyUrl(v) {
  try { return new URL(String(v).trim()) } catch { return null }
}

/**
 * 从 env 读**可用的**代理地址(只认 `http:`);没配、或配的都不是 http 代理,返回 ''。
 * ⚠ 不可用的那种不是静默跳过 —— `proxyWarning()` 会把它说出来,给启动日志/doctor 用。
 */
function proxyFromEnv(env = process.env) {
  for (const k of PROXY_KEYS) {
    const v = env && env[k]
    if (!v || !String(v).trim()) continue
    const u = parseProxyUrl(v)
    if (u && u.protocol === 'http:') return String(v).trim()
  }
  return ''
}

/**
 * env 里有代理变量、但本模块用不了时,给一句能照做的话;正常情况返回 ''。
 * 典型:`all_proxy=socks5://127.0.0.1:7890` —— shell 里常有,而我们只会发 HTTP CONNECT。
 */
function proxyWarning(env = process.env) {
  if (proxyFromEnv(env)) return ''
  for (const k of PROXY_KEYS) {
    const v = env && env[k]
    if (!v || !String(v).trim()) continue
    const u = parseProxyUrl(v)
    const scheme = u ? u.protocol.replace(':', '') : '(无法解析)'
    return `环境变量 ${k}=${describeUrl(v)} 不是 http 代理(${scheme}),出网会直连。`
      + `要走代理请在配置 proxy.http 里填 http:// 地址(Clash 的 mixed-port 同一端口也收 http)`
  }
  return ''
}

function noProxyFromEnv(env = process.env) {
  for (const k of NO_PROXY_KEYS) {
    const v = env && env[k]
    if (v && String(v).trim()) return String(v).trim()
  }
  return ''
}

/**
 * NO_PROXY 匹配。⚠ 必须实现:`applyProxyEnv` 会把 `deriveNoProxy` 生成的国内端点写进
 * NO_PROXY 给子进程用,daemon 这层不认的话,**同一份配置在父子进程里含义不同** ——
 * 那种不一致平时无声,出事时最难查。
 *
 * 口径(与 curl 对齐的那部分):`*` 全绕过 · `.example.com` / `*.example.com` 后缀 ·
 * `example.com` 精确且蕴含子域 · 条目可带端口(忽略:只按主机名分流)· 逗号或空白分隔。
 * ⚠ **IP 地址只做精确匹配**:`10.0.0.1` 不该被条目 `1` 或 `0.0.1` 按"后缀"命中 —— 域名的
 *   后缀是层级,IP 的后缀什么都不是。IPv6 条目按字面比(带不带方括号都认),不做 CIDR。
 */
function shouldBypass(hostname, noProxy) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return false
  const hostIsIp = net.isIP(host) !== 0
  const list = String(noProxy || '').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  for (const raw of list) {
    if (raw === '*') return true
    const entry = stripEntryPort(raw).replace(/^\*/, '').replace(/\.$/, '')
    if (!entry) continue
    if (hostIsIp || net.isIP(entry.replace(/^\./, '')) !== 0) {
      // 任一侧是 IP ⇒ 只认精确相等(去掉前导点后比)
      if (host === entry.replace(/^\./, '')) return true
      continue
    }
    if (entry.startsWith('.')) { if (host === entry.slice(1) || host.endsWith(entry)) return true }
    else if (host === entry || host.endsWith('.' + entry)) return true
  }
  return false
}

// 条目里的端口:`host:8080` 剥掉,`[::1]:8080` 剥掉,而裸 IPv6 `::1` **不能**被当成"host + 端口 1"。
function stripEntryPort(raw) {
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(raw)
  if (m) return m[1]
  if ((raw.match(/:/g) || []).length > 1) return raw // 多个冒号 = 裸 IPv6 字面量
  return raw.replace(/:\d+$/, '')
}

// 透传给 tls.connect 的信任类选项(agent 层给的 ca / rejectUnauthorized 等不该被隧道吞掉;
// 其余如 host/port/path/agent/headers 是 http 层的,tls.connect 不认或会误解)。
const TLS_PASSTHROUGH = ['ca', 'cert', 'key', 'pfx', 'passphrase', 'rejectUnauthorized', 'checkServerIdentity',
  'ALPNProtocols', 'minVersion', 'maxVersion', 'ciphers', 'secureContext', 'secureProtocol', 'crl', 'ecdhCurve']

/**
 * CONNECT 隧道 agent。REST(node:https)与 WS(ws 的 `{ agent }`)共用同一个实例 ——
 * 共用不只是省事:两条链路走同一个代理、同一套 keepAlive,出问题时排查面才是一个。
 *
 * `createConnection` 用回调式签名 —— Node 18.17 / 20 / 22 的 `_http_agent.js` 都是
 * `const s = this.createConnection(options, oncreate); if (s) oncreate(null, s)`,两种形态都认。
 */
class TunnelAgent extends https.Agent {
  // `httpImpl` 只为单测留的注入口 —— 隧道的成功路径要真 TLS,测不了;而**出错路径才是要害**
  // (407 / 代理没起来 / 代理收了 TCP 却不回 CONNECT),那几条必须测得到,否则又回到
  // "报一个指不到这里的错"。
  constructor(proxyUrl, { httpImpl = http, connectTimeoutMs = 15_000, ...opts } = {}) {
    super({ keepAlive: true, ...opts })
    const u = parseProxyUrl(proxyUrl)
    if (!u) throw new TypeError(`代理地址无法解析: ${describeUrl(proxyUrl)}`)
    if (u.protocol !== 'http:') {
      throw new TypeError(`只支持 http:// 的代理,拿到的是 ${u.protocol}//…(${describeUrl(proxyUrl)})—— socks5/https 代理这里发不了 CONNECT`)
    }
    this.proxy = u
    this.proxyUrl = String(proxyUrl).trim()
    this._http = httpImpl
    this.connectTimeoutMs = connectTimeoutMs
    // 认证头算一次:CONNECT 与明文绝对 URI 两条路都要带,各算一份必漂移
    this.proxyAuth = u.username
      ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64')
      : ''
  }

  createConnection(options, cb) {
    const host = String(options.host || '')
    const target = `${host.includes(':') ? `[${host}]` : host}:${options.port || 443}` // IPv6 目标要带括号
    const headers = { Host: target }
    if (this.proxyAuth) headers['Proxy-Authorization'] = this.proxyAuth
    const req = this._http.request({
      host: this.proxy.hostname,
      port: this.proxy.port || 80,
      method: 'CONNECT',
      path: target,
      headers,
      agent: false,
    })
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        // ⚠ 407 = 代理要认证但 URL 里没带凭据。非 200 一律当隧道没建起来、**不硬往下走**:
        //   往下走的话 TLS 握手会在代理返回的错误页上失败,报出来的是一个指不到这里的密码学错误。
        return cb(new Error(`代理 CONNECT ${target} → ${res.statusCode} ${res.statusMessage || ''}`.trim()))
      }
      const tlsOpts = { socket, servername: options.servername || host }
      for (const k of TLS_PASSTHROUGH) if (options[k] !== undefined) tlsOpts[k] = options[k]
      const sock = tls.connect(tlsOpts, () => cb(null, sock))
      sock.once('error', cb)
    })
    req.once('error', (e) => cb(new Error(`连不上代理 ${this.proxy.origin}: ${e.message}`)))
    // ⚠ CONNECT 自己要有超时:代理端口通、但那头根本不是 HTTP 代理(配错端口指到别的服务)时,
    //   TCP 建得起来、CONNECT 永远没有回应。外层请求的 AbortSignal 触发 destroy 时,这个
    //   挂着的 CONNECT 请求并不随之收掉 —— 每次超时就泄一条 TCP(reviewer 用黑洞代理复现过:
    //   3 次超时 = 代理侧 3 条连接全留着)。15s 与探针的 20s 同量级。
    if (this.connectTimeoutMs > 0) {
      req.setTimeout(this.connectTimeoutMs, () => req.destroy(new Error(`CONNECT ${this.connectTimeoutMs / 1000}s 没有回应 —— 那个端口多半不是 HTTP 代理`)))
    }
    req.end()
  }
}

// ── fetch 形状的响应(只实现调用方真用到的那几个成员)──────────────────────────────
// ⚠ 刻意不做成"完整的 Response 垫片":假装完整反而会让某天用到未实现成员的人拿到
//   `undefined` 而不是报错。用到什么补什么,缺的当场就炸得出来。
function makeResponse(status, rawHeaders, buf, url, flags = null) {
  const lower = new Map()
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    lower.set(String(k).toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v))
  }
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (lower.has(String(n).toLowerCase()) ? lower.get(String(n).toLowerCase()) : null) },
    async text() { return buf.toString('utf8') },
    async json() { return JSON.parse(buf.toString('utf8')) },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) },
    ...(flags || {}),
  }
}

function bodyToBuffer(body) {
  if (body === undefined || body === null) return null
  if (Buffer.isBuffer(body)) return body
  // URLSearchParams(出站一律 form 编码,见 docs/SLACK.md「静默失败」)与普通字符串都走这里
  return Buffer.from(typeof body === 'string' ? body : String(body), 'utf8')
}

// `init.headers` 三种形态都认:普通对象 / `Headers` 实例 / `[k,v]` 数组。
// ⚠ `{...new Headers()}` 会得到 `{}` —— 头**静默全丢**,请求照发、只是没了 Authorization。
function normalizeHeaders(h) {
  if (!h) return {}
  if (typeof h.forEach === 'function' && !Array.isArray(h)) { const o = {}; h.forEach((v, k) => { o[k] = v }); return o }
  if (Array.isArray(h)) return Object.fromEntries(h)
  return { ...h }
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
const REDIRECT_MAX = 20 // 与 fetch 对齐

/**
 * 造一个 fetch 形状、但底层走 `node:https` + 隧道 agent 的函数。
 *
 * ⭐ **做成 fetch 形状是关键的架构选择**:适配器里每一处出网都已经有 `fetchImpl` 注入口
 *   (30 个零网络单测靠的就是它)⇒ 只换默认实现,调用点与测试一行都不用动。
 *
 * @param {string} proxyUrl 代理地址;传空则所有请求直连(等价于不挂隧道)
 */
function createProxyFetch(proxyUrl, { noProxy = '', agent: injectedAgent = null, httpsImpl = https, httpImpl = http } = {}) {
  const agent = proxyUrl ? (injectedAgent || new TunnelAgent(proxyUrl)) : null

  return function proxiedFetch(url, init = {}) {
    return request(String(url), init, 0)
  }

  function request(url, init, depth) {
    return new Promise((resolve, reject) => {
      // ⚠ 重定向环在 Slack 的下载链路上真实存在过(凭据无效时它用 200 + 登录页表达,但网关
      //   抖动时也见过 302 打转)—— 不设限就是静默挂死。
      if (depth > REDIRECT_MAX) return reject(new Error(`重定向超过 ${REDIRECT_MAX} 跳: ` + url))
      const signal = init.signal
      // ⚠ 已经取消的 signal:**在创建请求之前**就拒 —— 不是"创建了再 destroy"。
      //   后者会先把 CONNECT + TLS 整条隧道建起来(reviewer 现场:能走到 onSocketNT 说明隧道
      //   已完整建好),然后 Node 在 socket 分配时无条件 emit 'error'('socket hang up');
      //   而那时 `req.on('error')` 还没挂 ⇒ **未捕获异常,daemon 整个崩**。
      if (signal && signal.aborted) return reject(abortError(signal))
      let u
      try { u = new URL(url) } catch { return reject(new TypeError('无效的 URL: ' + url)) }

      const isHttps = u.protocol === 'https:'
      if (!isHttps && u.protocol !== 'http:') return reject(new TypeError('不支持的协议: ' + u.protocol))

      const bypass = !agent || shouldBypass(u.hostname, noProxy)
      const headers = normalizeHeaders(init.headers)
      const method = String(init.method || 'GET').toUpperCase()
      const buf = bodyToBuffer(init.body)
      if (buf && headers['Content-Length'] === undefined && headers['content-length'] === undefined) {
        headers['Content-Length'] = String(buf.length)
      }

      // http:(明文)走代理是**绝对形式 URI**,不是 CONNECT —— 两者搞混的表现是代理回 400。
      // 这条链路上目前没有明文目标(Slack/Discord 都是 https),留着是为了不留一个静默直连的口子。
      const viaAbsolute = !isHttps && !bypass
      const lib = isHttps ? httpsImpl : httpImpl
      const opts = viaAbsolute
        ? { host: agent.proxy.hostname, port: agent.proxy.port || 80, method, path: u.toString(), headers: { ...headers, Host: u.host, ...(agent.proxyAuth ? { 'Proxy-Authorization': agent.proxyAuth } : {}) }, agent: false }
        : { host: u.hostname, port: u.port || (isHttps ? 443 : 80), method, path: u.pathname + u.search, headers, agent: bypass ? undefined : agent }

      const viaProxy = !bypass && !!agent
      const wrap = (e) => (viaProxy ? new Error(`${e.message}(经代理 ${agent.proxy.origin})`) : e)

      const req = lib.request(opts, (res) => {
        const status = res.statusCode
        const loc = res.headers && res.headers.location
        const mode = init.redirect || 'follow' // fetch 的默认就是 follow
        if (loc && REDIRECT_CODES.has(status) && mode !== 'manual') {
          res.resume() // 必须排干,否则 keepAlive 的连接不会被释放
          if (mode === 'error') return reject(new Error(`redirect:'error' 而对端回了 ${status} → ${loc}`))
          let next
          try { next = new URL(loc, u).toString() } catch { return reject(new Error('重定向地址无法解析: ' + loc)) }
          const nextInit = { ...init, headers: { ...headers } }
          // ⚠ **跨源必须摘掉 Authorization** —— 与 fetch 同口径。Slack 的文件下载正是
          //   `files.slack.com` → 签名 CDN 地址这种跳法,带着 `xoxb-` 跳过去就是把 bot token
          //   送给第三方主机。签名已经在 URL 里,摘掉不影响下载。
          if (new URL(next).origin !== u.origin) {
            for (const k of Object.keys(nextInit.headers)) {
              if (/^(authorization|cookie|proxy-authorization)$/i.test(k)) delete nextInit.headers[k]
            }
          }
          // 303(除 GET/HEAD 外),以及 301/302 上的 POST:按 fetch 口径降级成 GET 且丢掉 body
          const toGet = (status === 303 && method !== 'GET' && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')
          if (toGet) {
            nextInit.method = 'GET'
            delete nextInit.body
            for (const k of Object.keys(nextInit.headers)) {
              // body 没了,描述 body 的头也得跟着走 —— 留着 Content-Length 对端会一直等一个不会来的 body
              if (/^(content-length|content-type|content-encoding|content-language|content-location)$/i.test(k)) delete nextInit.headers[k]
            }
          }
          return resolve(request(next, nextInit, depth + 1))
        }
        // init.maxBytes(非标准,fetch 会忽略它):响应体边收边数,到线就**截断**并断开 —— 这条路把整个响应
        // 攒进内存,不封顶的话一个几百 MB 的响应就能把 daemon 撑爆(风格提炼会替人去拉任意公网页面)。
        // 截断而不是报错:要的往往只是开头(HTML 的 <head> 里就是全部样式表链接)。响应带 capped / truncated 两个标记。
        const chunks = []
        let got = 0
        const cap = Number(init.maxBytes) > 0 ? Number(init.maxBytes) : 0
        const flags = cap ? { capped: true, truncated: false } : null
        res.on('data', (c) => {
          if (flags && flags.truncated) return
          if (cap && got + c.length > cap) {
            chunks.push(c.subarray(0, cap - got)); got = cap; flags.truncated = true
            try { res.destroy() } catch {}
            return resolve(makeResponse(status, res.headers, Buffer.concat(chunks), u.toString(), flags))
          }
          got += c.length
          chunks.push(c)
        })
        res.on('end', () => resolve(makeResponse(status, res.headers, Buffer.concat(chunks), u.toString(), flags)))
        res.on('error', (e) => reject(wrap(e))) // 半截响应 / 中途断线走这条,也得点名代理
      })

      // 调用方给的是 `AbortSignal.timeout(...)`(适配器那层已有超时口径)⇒ 这里只负责响应它,
      // 不自己再叠一个:两层超时会让"到底谁掐的"变成一个查不清的问题。
      // ⚠ 监听器要在请求结束时**摘掉**:`AbortSignal.timeout` 的信号一旦挂上监听器就被 Node 钉住
      //   (gcPersistentSignals)直到计时到点 —— 不摘,每次调用后 req→res→body 都被钉整整 timeoutMs;
      //   长寿的 signal(复用一个 AbortController)上则只增不减。
      const onAbort = () => { req.destroy(); reject(abortError(signal)) }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
        req.once('close', () => signal.removeEventListener('abort', onAbort))
      }
      // ⚠ 这条 message 是本模块存在的理由的一半:直连超时的原始报错完全指不到"没走代理"。
      req.on('error', (e) => reject(wrap(e)))
      if (buf) req.write(buf)
      req.end()
    })
  }
}

function abortError(signal) {
  const e = new Error((signal && signal.reason && signal.reason.message) || 'aborted')
  e.name = (signal && signal.reason && signal.reason.name) || 'AbortError'
  return e
}

// ── 模块级单例(进程内共用一个 agent / 一个 fetch)────────────────────────────────
// ⚠ 惰性 + 可重置:`applyProxyEnv` 在 `loadConfig` 之后才写 env,而本模块可能在那之前
//   就被 require 进来 ⇒ **不能在 require 时就定形**。
// ⚠ 但**别指望热重载会换代理**:`applyProxyEnv` 只在 env 里没有时才写(不覆盖 shell 已有值),
//   改了配置里的 proxy,env 不变、这里的 key 也就不变。要换代理得重启 daemon。`resetProxy()`
//   是给测试和显式调用留的,不是热重载钩子。
let cached = null
let cachedKey = null

/**
 * 取一个代理感知的 fetch;**没配代理时返回 null**(调用方回落到全局 fetch)。
 * ⭐ 返回 null 而不是"透明直连的包装" —— 没配代理的绝大多数机器上,行为与改动前逐字节相同,
 *   这条改动的风险面因此只覆盖"真的配了代理"的那部分。
 */
function getProxyFetch(env = process.env) {
  const p = proxyFromEnv(env)
  if (!p) return null
  ensure(env, p)
  return cached.fetch
}

/** 取共用的隧道 agent(给 `ws` 的 `{ agent }` 用);没配代理返回 null。 */
function getProxyAgent(env = process.env) {
  const p = proxyFromEnv(env)
  if (!p) return null
  ensure(env, p)
  return cached.agent
}

function ensure(env, p) {
  const np = noProxyFromEnv(env)
  const key = p + '|' + np
  if (cached && cachedKey === key) return
  // 换了就先关旧 agent 的 keepAlive 连接再换新的,否则每换一次泄一批 socket。
  // (在途 REST 会被打成 aborted,createSlackApi 的重试吸收得住;已升级的 WS 早被 Node 从
  //   agent 上摘走 —— 不受影响,但也就意味着它会走旧隧道直到自然重连。)
  resetProxy()
  const agent = new TunnelAgent(p)
  cached = { agent, fetch: createProxyFetch(p, { noProxy: np, agent }) }
  cachedKey = key
}

/** 丢弃单例(测试 / 显式重建)。 */
function resetProxy() {
  if (cached && cached.agent && cached.agent.destroy) { try { cached.agent.destroy() } catch { /* 已经关了 */ } }
  cached = null
  cachedKey = null
}

/** 把代理 URL 变成可进日志的样子。⚠ 不打印凭据:URL 里可能带用户名密码。 */
function describeUrl(v) {
  const u = parseProxyUrl(v)
  if (!u) return '(无法解析)'
  return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}${u.username ? '(带认证)' : ''}`
}

/** 给 doctor / 启动日志用的一句话描述;没配可用代理返回 ''。 */
function proxyDescribe(env = process.env) {
  const p = proxyFromEnv(env)
  return p ? describeUrl(p) : ''
}

module.exports = {
  PROXY_ENV_KEYS: [...PROXY_KEYS, ...NO_PROXY_KEYS],
  proxyFromEnv, noProxyFromEnv, proxyWarning, shouldBypass,
  TunnelAgent, createProxyFetch,
  getProxyFetch, getProxyAgent, resetProxy, proxyDescribe,
}
