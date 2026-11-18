'use strict'

// Whether the console's public address (ui.publicUrl) comes back to this very
// process. The public address is only a way into the console from outside (the
// Feishu login); no group depends on it. So a failed check changes one thing:
// the console shows a notice. It never touches a group, a journal or the
// service health.
//
// Proof of reaching this process, not just some server: every console response
// carries a random per-process id (HEADER), and the check asks the public
// address for a small page and compares that header. A proxy or tunnel host
// that answers by itself (a 502 while the tunnel is down) has no such header.
const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')

const HEADER = 'x-sintbot-instance'
const PROBE_PATH = '/api/state' // answered 401 without a token: small, no side effects

function probeOnce(base, { instanceId, timeoutMs, request }) {
  return new Promise((resolve) => {
    let done = false, req = null, timer = null
    const finish = (result) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { if (req) req.destroy() } catch {}
      resolve(result)
    }
    let target
    try { target = new URL(PROBE_PATH, base) } catch { return finish({ ok: false, reason: 'invalid' }) }
    const send = request || (target.protocol === 'http:' ? http.request : https.request)
    // An overall deadline: the socket timeout alone does not bound a slow TLS
    // handshake that keeps trickling bytes.
    timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      req = send(target, { method: 'GET', timeout: timeoutMs, headers: { 'cache-control': 'no-cache' } }, (res) => {
        const own = res.headers && res.headers[HEADER] === instanceId
        try { res.resume() } catch {}
        finish(own ? { ok: true, code: res.statusCode } : { ok: false, reason: 'elsewhere', code: res.statusCode })
      })
      req.on('timeout', () => finish({ ok: false, reason: 'timeout' }))
      req.on('error', () => finish({ ok: false, reason: 'error' }))
      req.end()
    } catch { finish({ ok: false, reason: 'error' }) }
  })
}

function createPublicReach({ getUrl, intervalMs = 5 * 60 * 1000, firstDelayMs = 15 * 1000, timeoutMs = 8000,
  now = Date.now, request = null, instanceId = crypto.randomBytes(12).toString('hex'), log = () => {} } = {}) {
  if (typeof getUrl !== 'function') throw new TypeError('createPublicReach needs getUrl')
  let last = null // { url, ok, reason, code, checkedAt }
  let running = null
  let first = null, every = null
  const urlNow = () => { try { return String(getUrl() || '') } catch { return '' } }

  function status() {
    const url = urlNow()
    if (!url) return { state: 'off', url: '' }
    if (!last || last.url !== url) return { state: 'unknown', url }
    return { state: last.ok ? 'ok' : 'down', url, reason: last.ok ? '' : last.reason, code: last.code || 0, checkedAt: last.checkedAt }
  }

  function check() {
    if (running) return running
    const url = urlNow()
    if (!url) { last = null; return Promise.resolve(status()) }
    running = probeOnce(url, { instanceId, timeoutMs, request })
      .then((r) => {
        const was = last && last.url === url ? last.ok : null
        last = { url, ok: r.ok, reason: r.reason || '', code: r.code || 0, checkedAt: now() }
        if (was !== r.ok) log(r.ok ? `public address ${url} reaches this console`
          : `public address ${url} does not reach this console (${r.reason}${r.code ? ' ' + r.code : ''}); groups are not affected`)
        return status()
      })
      .catch(() => status())
      .finally(() => { running = null })
    return running
  }

  function start() {
    if (first || every) return
    first = setTimeout(() => { first = null; check() }, firstDelayMs)
    every = setInterval(() => { check() }, intervalMs)
    for (const t of [first, every]) if (t && typeof t.unref === 'function') t.unref()
  }

  function stop() {
    if (first) clearTimeout(first)
    if (every) clearInterval(every)
    first = every = null
  }

  return { instanceId, header: HEADER, status, check, start, stop }
}

module.exports = { createPublicReach, probeOnce, HEADER, PROBE_PATH }
