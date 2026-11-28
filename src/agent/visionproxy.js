// Vision strip-proxy — lets a TEXT-ONLY model brain survive image inputs.
//
// The problem: sbot spawns `claude`, which talks DIRECTLY to ANTHROPIC_BASE_URL.
// sbot sits outside that connection, so it can't touch content blocks. When an
// agent turn feeds an image to a text-only provider (a screenshot tool, Read of
// a .png, an MCP image return), the block reaches the model and it 400s:
//   "400 Model only support text input"  — and the whole turn dies.
//
// The fix: interpose a tiny localhost proxy between `claude` and the
// real endpoint. Only engaged when a provider is marked `vision: false`. It
// rewrites the request body — every image content block becomes a text
// placeholder — then pipes the (streaming) response straight back. Everything
// else (auth headers, SSE, other endpoints) passes through verbatim.
//
// Upstream is encoded in the URL path prefix, so ONE proxy serves every group
// concurrently with no shared state:
//   ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/<b64url(realBase)>
// `claude` appends `/v1/messages`; we decode the prefix and forward to
// `<realBase>/v1/messages`. (The existing GLM base already carries a
// `/api/anthropic` path, so a path-prefixed base is a proven shape.)
//
// Zero-dependency `http` — same house style as src/ui/server.js. The proxy is a
// lazy process-lifetime singleton: it starts on the first vision:false turn and
// dies with the process, so it works identically for the daemon and one-shot CLI.

const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')

const IMAGE_PLACEHOLDER = '[image omitted: this model has no vision support]'
const DOC_PLACEHOLDER = '[document omitted: this model has no document input support]'

// Recursively replace every image content block with a text placeholder. Walks
// message content arrays AND nested tool_result content (where tool-returned
// images live). Pure and in-place-free: returns a new payload, mutates nothing
// the caller passed. Non-message bodies (no `messages` array) pass through as-is.
function stripImages(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.messages)) return payload

  let changed = 0
  const sanitizeBlock = (block) => {
    if (!block || typeof block !== 'object') return block
    // document (PDF) blocks 400 a text-only model exactly like images do
    if (block.type === 'image' || block.type === 'document') {
      changed++
      return { type: 'text', text: block.type === 'document' ? DOC_PLACEHOLDER : IMAGE_PLACEHOLDER }
    }
    // tool_result carries its own content array which may hold image blocks.
    if (Array.isArray(block.content)) return { ...block, content: block.content.map(sanitizeBlock) }
    return block
  }

  const messages = payload.messages.map((msg) => {
    if (!msg || !Array.isArray(msg.content)) return msg
    return { ...msg, content: msg.content.map(sanitizeBlock) }
  })

  return { payload: { ...payload, messages }, changed }
}

// Decode the leading path segment (b64url) as the upstream base URL, returning
// { upstreamBase, restPath }. `/aHR0cHM6...==/v1/messages` -> base + '/v1/messages'.
function decodeUpstream(reqUrl) {
  const trimmed = reqUrl.replace(/^\/+/, '')
  const slash = trimmed.indexOf('/')
  const seg = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const restPath = slash === -1 ? '' : trimmed.slice(slash) // includes leading '/'
  let upstreamBase
  try {
    upstreamBase = Buffer.from(seg, 'base64url').toString('utf8')
    // eslint-disable-next-line no-new
    new URL(upstreamBase) // validate
  } catch {
    return null
  }
  return { upstreamBase, restPath }
}

// Encode a real base URL into a proxy base that `claude` will use verbatim.
function proxyBaseFor(port, realBase) {
  return `http://127.0.0.1:${port}/${Buffer.from(realBase, 'utf8').toString('base64url')}`
}

function handleRequest(req, res, onLog) {
  const decoded = decodeUpstream(req.url || '')
  if (!decoded) { res.writeHead(400); res.end('bad upstream'); return }
  const upstream = new URL(decoded.upstreamBase)
  const targetPath = (upstream.pathname.replace(/\/$/, '') || '') + decoded.restPath + (upstream.search || '')

  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('error', () => { try { res.writeHead(502); res.end('read error') } catch {} })
  req.on('end', () => {
    let bodyBuf = Buffer.concat(chunks)

    // Only JSON bodies with a messages array get rewritten; everything else
    // (GET, count_tokens without messages, malformed) forwards untouched.
    if (bodyBuf.length) {
      try {
        const parsed = JSON.parse(bodyBuf.toString('utf8'))
        const stripped = stripImages(parsed)
        if (stripped && stripped.changed) {
          bodyBuf = Buffer.from(JSON.stringify(stripped.payload), 'utf8')
          if (onLog) onLog(`vision-proxy: stripped ${stripped.changed} image block(s) for ${upstream.host}`)
        }
      } catch { /* not JSON — forward the original bytes */ }
    }

    const headers = { ...req.headers }
    delete headers.host
    delete headers['content-length']
    headers['content-length'] = Buffer.byteLength(bodyBuf)

    const client = upstream.protocol === 'http:' ? http : https
    const upReq = client.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443),
        method: req.method,
        path: targetPath,
        headers: { ...headers, host: upstream.host },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers)
        upRes.pipe(res) // stream SSE straight back, unmodified
      }
    )
    upReq.on('error', (e) => { try { res.writeHead(502); res.end('upstream error: ' + e.message) } catch {} })
    upReq.end(bodyBuf)
  })
}

let _server = null
let _startPromise = null

// Start (once) and return the listening port. Loopback-only.
function ensureProxy(onLog) {
  if (_server) return Promise.resolve(_server.address().port)
  if (_startPromise) return _startPromise
  _startPromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handleRequest(req, res, onLog))
    server.on('error', reject)
    server.on('error', () => { _startPromise = null; _server = null }) // a failed start must not cache the rejection forever
    // Don't let the proxy hold the event loop open: the one-shot CLI (`agent run`
    // / `chat`) must still exit once its turn ends. While a turn runs, the child
    // `claude` process keeps the loop alive; unref'ing the server + its (possibly
    // keep-alive) sockets means the proxy never blocks a clean exit afterward. The
    // daemon stays up via its WSClient regardless.
    server.on('connection', (sock) => sock.unref())
    server.listen(0, '127.0.0.1', () => {
      server.unref()
      _server = server
      if (onLog) onLog(`vision-proxy: listening on 127.0.0.1:${server.address().port} (strips images for text-only providers)`)
      resolve(server.address().port)
    })
  })
  return _startPromise
}

function stopProxy() {
  if (_server) { try { _server.close() } catch {} _server = null }
  _startPromise = null
}

module.exports = { stripImages, decodeUpstream, proxyBaseFor, ensureProxy, stopProxy, IMAGE_PLACEHOLDER, DOC_PLACEHOLDER }
