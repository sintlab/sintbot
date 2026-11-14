'use strict'
// Scan to create a WeCom smart bot. WeCom issues a scan session; the QR code
// carries its auth link, and once the phone confirms, the result returns the
// new bot's ID and secret. This module only performs that HTTP exchange. The
// credentials it returns stay in the caller's memory until the core builds
// the configuration; the session code and the secret are never logged,
// echoed in notices or put into error messages.
//
// The endpoints have no public documentation (WeCom's own CLI and several
// installers use them), so the source and URLs are kept here in one place.
const https = require('node:https')

const WECOM_SCAN = Object.freeze({
  source: 'sintbot',
  generateUrl: 'https://work.weixin.qq.com/ai/qc/generate',
  queryUrl: 'https://work.weixin.qq.com/ai/qc/query_result',
  // WeCom's own scan page for a session (?source=…&scode=…); not shown, since
  // its link would expose the session code.
  pageUrl: 'https://work.weixin.qq.com/ai/qc/gen',
  intervalMs: 3000,
  timeoutMs: 300000,
  rounds: 3,
})
// Statuses that end a session early; anything else but success keeps waiting.
const EXPIRED_STATUSES = new Set(['expired', 'expire', 'timeout'])
const EXPIRED = 'WECOM_SCAN_EXPIRED'
const MAX_POLL_ERRORS = 3
const RESPONSE_LIMIT = 64 * 1024

const NOTICES = Object.freeze({
  scan: '请用手机企业微信扫码，按提示创建机器人。',
  renewed: '二维码已过期，已换一张新的。',
  botReady: '机器人已创建。在企业微信里给它发一句话（单聊，或在群里 @它）即可完成接入。',
})
const ERRORS = Object.freeze({
  request: '无法申请企业微信二维码，请检查网络后重试',
  query: '查询扫码结果失败，请检查网络后重试',
  noBot: '扫码已完成，但企业微信没有返回机器人信息，请重试',
  expired: '二维码已过期，请重试',
  cancelled: '已取消接入',
})

function platCode(platform = process.platform) {
  return { darwin: 1, win32: 2, linux: 3 }[platform] || 0
}

const failure = (key, code) => Object.assign(new Error(ERRORS[key]), code ? { code } : {})
const cancelled = () => failure('cancelled', 'ABORT_ERR')

// Direct HTTPS GET of a small JSON body. Errors carry no URL: the query URL
// contains the session code.
function httpsGetJson(url, { signal, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let req
    try {
      req = https.get(url, { signal, timeout: timeoutMs, headers: { accept: 'application/json' } }, res => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
        let raw = '', size = 0
        res.setEncoding('utf8')
        res.on('data', chunk => {
          size += Buffer.byteLength(chunk)
          if (size > RESPONSE_LIMIT) req.destroy(new Error('response too large'))
          else raw += chunk
        })
        res.on('end', () => { try { resolve(JSON.parse(raw)) } catch { reject(new Error('invalid JSON')) } })
        res.on('error', () => reject(new Error('response failed')))
      })
    } catch { return reject(new Error('request failed')) }
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', error => reject(new Error(error?.code || 'request failed')))
  })
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled())
    const onAbort = () => { clearTimeout(timer); reject(cancelled()) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Opens one scan session: { scode, authUrl }. The QR code shows authUrl.
async function requestWecomScan({ source = WECOM_SCAN.source, plat = platCode(), get = httpsGetJson, signal } = {}) {
  if (signal?.aborted) throw cancelled()
  const url = `${WECOM_SCAN.generateUrl}?source=${encodeURIComponent(source)}&plat=${encodeURIComponent(plat)}`
  let body
  try { body = await get(url, { signal }) } catch {
    if (signal?.aborted) throw cancelled()
    throw failure('request')
  }
  if (signal?.aborted) throw cancelled()
  const scode = body?.data?.scode, authUrl = body?.data?.auth_url
  if (typeof scode !== 'string' || !scode.trim() || typeof authUrl !== 'string' || !/^https?:\/\/\S+$/.test(authUrl) || authUrl.length > 1024) {
    throw failure('request')
  }
  return { scode: scode.trim(), authUrl }
}

// Polls one session until the bot is created ({ botId, secret }), the
// session expires (error code WECOM_SCAN_EXPIRED), it is cancelled, or the
// result cannot be read several times in a row.
async function waitWecomScan({ scode, signal, intervalMs = WECOM_SCAN.intervalMs, timeoutMs = WECOM_SCAN.timeoutMs,
  get = httpsGetJson, sleep = abortableSleep, now = Date.now } = {}) {
  if (typeof scode !== 'string' || !scode) throw failure('request')
  const url = `${WECOM_SCAN.queryUrl}?scode=${encodeURIComponent(scode)}`
  const until = now() + timeoutMs
  let errors = 0
  for (;;) {
    if (signal?.aborted) throw cancelled()
    let data = null
    try {
      const body = await get(url, { signal })
      if (!body || typeof body.data !== 'object' || body.data === null) throw new Error('no data')
      data = body.data
      errors = 0
    } catch {
      if (signal?.aborted) throw cancelled()
      if (++errors >= MAX_POLL_ERRORS) throw failure('query')
    }
    if (signal?.aborted) throw cancelled()
    if (data?.status === 'success') {
      const botId = data.bot_info?.botid, secret = data.bot_info?.secret
      if (typeof botId !== 'string' || !botId.trim() || typeof secret !== 'string' || !secret.trim()) throw failure('noBot')
      return { botId: botId.trim(), secret: secret.trim() }
    }
    if (EXPIRED_STATUSES.has(data?.status) || now() >= until) throw failure('expired', EXPIRED)
    await sleep(intervalMs, signal)
  }
}

// Shows a QR code (onQr receives the auth link) and renews an expired one,
// up to `rounds` codes in total.
async function provisionWecomBot({ signal, onQr = () => {}, onNotice = () => {}, rounds = WECOM_SCAN.rounds,
  source, plat, get, sleep, now, intervalMs, timeoutMs } = {}) {
  for (let round = 1; ; round++) {
    const { scode, authUrl } = await requestWecomScan({ source, plat, get, signal })
    onQr(authUrl, { round, rounds })
    onNotice(round === 1 ? NOTICES.scan : NOTICES.renewed)
    try {
      return await waitWecomScan({ scode, signal, get, sleep, now, intervalMs, timeoutMs })
    } catch (error) {
      if (error?.code !== EXPIRED || round >= rounds) throw error
    }
  }
}

module.exports = { WECOM_SCAN, WECOM_SCAN_NOTICES: NOTICES, WECOM_SCAN_ERRORS: ERRORS, EXPIRED_CODE: EXPIRED,
  platCode, httpsGetJson, requestWecomScan, waitWecomScan, provisionWecomBot }
