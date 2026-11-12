'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { providerUsage, createUsageProbe, LAST_GOOD_TTL_MS } = require('../src/usage')
const { QUOTA_SEP } = require('../src/agent/claudeusage')

const NOW = 1731400000000
const H = 3600e3, D = 864e5
const res = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
// routes: [[urlFragment, response | () => response | Error]]; records every call (url + headers).
function fakeFetch(routes) {
  const calls = []
  const f = async (url, opts) => {
    calls.push({ url, headers: opts.headers })
    const hit = routes.find(([m]) => url.includes(m))
    if (!hit) throw new Error('unexpected ' + url)
    const r = typeof hit[1] === 'function' ? hit[1]() : hit[1]
    if (r instanceof Error) throw r
    return r
  }
  f.calls = calls
  return f
}
const glmQuota = { success: true, data: { level: 'pro', limits: [
  { unit: 3, percentage: 42, nextResetTime: NOW + H }, { unit: 6, percentage: 10, nextResetTime: NOW + 5 * D }] } }
const mmPlan = (weekly) => ({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_status: 1,
  current_interval_remaining_percent: 58, end_time: NOW + H, ...(weekly ? { current_weekly_status: 1, current_weekly_remaining_percent: 90, weekly_end_time: NOW + 5 * D } : {}) }] })
const io = (fetchImpl, now = () => NOW) => ({ fetchImpl, now })

test('GLM: quota endpoint first, raw key header, windows rendered as used %', async () => {
  const f = fakeFetch([['/api/monitor/usage/quota/limit', res(200, glmQuota)]])
  const v = await providerUsage({ baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'glm-key-a' }, io(f))
  assert.deepEqual(v, { label: '额度', value: `5h:42% (1h)${QUOTA_SEP}7d:10% (5d)` })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
  assert.equal(f.calls[0].headers.Authorization, 'glm-key-a')
  assert.equal(f.calls[0].headers['Accept-Language'], 'en-US,en')
})

test('GLM: no coding plan falls back to the balance endpoint (Bearer) and renders ¥', async () => {
  const f = fakeFetch([
    ['/api/monitor/usage/quota/limit', res(200, { success: false, msg: '用户不存在coding plan' })],
    ['/api/biz/account/query-customer-account-report', res(200, { code: 200, data: { availableBalance: 12.5 } })]])
  const v = await providerUsage({ baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'glm-key-b' }, io(f))
  assert.deepEqual(v, { label: '余额', value: '¥12.50' })
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].url, 'https://api.z.ai/api/biz/account/query-customer-account-report')
  assert.equal(f.calls[1].headers.Authorization, 'Bearer glm-key-b')
})

test('MiniMax: coding_plan/remains with session + weekly windows', async () => {
  const f = fakeFetch([['/v1/api/openplatform/coding_plan/remains', res(200, mmPlan(true))]])
  const v = await providerUsage({ baseUrl: 'https://api.minimaxi.com/anthropic', apiKey: 'mm-key-a' }, io(f))
  assert.deepEqual(v, { label: '额度', value: `5h:42% (1h)${QUOTA_SEP}7d:10% (5d)` })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains')
  assert.equal(f.calls[0].headers.Authorization, 'Bearer mm-key-a')
})

test('MiniMax: malformed coding_plan answer falls back to the legacy token_plan endpoint', async () => {
  const f = fakeFetch([
    ['/v1/api/openplatform/coding_plan/remains', res(404, 'not found')],
    ['/v1/token_plan/remains', res(200, mmPlan(false))]])
  const v = await providerUsage({ baseUrl: 'https://api.minimax.io/anthropic', apiKey: 'mm-key-b' }, io(f))
  assert.deepEqual(v, { label: '额度', value: '5h:42% (1h)' })
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].url, 'https://api.minimax.io/v1/token_plan/remains')
})

test('DeepSeek: balance', async () => {
  const f = fakeFetch([['api.deepseek.com/user/balance', res(200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.50' }] })]])
  const v = await providerUsage({ baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'ds-key-a' }, io(f))
  assert.deepEqual(v, { label: '余额', value: '¥12.50' })
  assert.equal(f.calls[0].headers.Authorization, 'Bearer ds-key-a')
})

test('401 shows 凭据失效 instead of a blank row', async () => {
  const f = fakeFetch([['/v1/api/openplatform/coding_plan/remains', res(401, { base_resp: { status_code: 1004, status_msg: 'unauthorized' } })]])
  const v = await providerUsage({ baseUrl: 'https://api.minimax.io/anthropic', apiKey: 'mm-key-401' }, io(f))
  assert.deepEqual(v, { label: '额度', value: '凭据失效' })
  assert.equal(f.calls.length, 1)
  const g = fakeFetch([['/api/monitor/usage/quota/limit', res(401, {})], ['/api/biz/account/query-customer-account-report', res(401, {})]])
  assert.deepEqual(await providerUsage({ baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'glm-key-c' }, io(g)), { label: '额度', value: '凭据失效' })
  assert.equal(g.calls.length, 2)
})

test('503 keeps the last good value for 10 minutes, then null; network errors count as transient', async () => {
  let t = NOW
  let fail = false
  const f = fakeFetch([['/v1/api/openplatform/coding_plan/remains', () => (fail ? res(503, 'upstream') : res(200, mmPlan(false)))]])
  const p = { baseUrl: 'https://api.minimax.io/anthropic', apiKey: 'mm-key-c' }
  const good = await providerUsage(p, io(f, () => t))
  assert.equal(good.value, '5h:42% (1h)')
  fail = true
  t = NOW + 5 * 60_000
  assert.deepEqual(await providerUsage(p, io(f, () => t)), good)
  t = NOW + LAST_GOOD_TTL_MS + 1
  assert.equal(await providerUsage(p, io(f, () => t)), null)
  // network error (fetch throws) → status null → transient → nothing left to keep
  const dead = fakeFetch([['/v1/api/openplatform/coding_plan/remains', new Error('ECONNRESET')]])
  assert.equal(await providerUsage(p, io(dead, () => t)), null)
})

test('malformed body → null', async () => {
  const f = fakeFetch([['api.deepseek.com/user/balance', res(200, '<html>oops</html>')]])
  assert.equal(await providerUsage({ baseUrl: 'https://api.deepseek.com', apiKey: 'ds-key-b' }, io(f)), null)
})

test('last-good is per key: key A seeded, key B 503 at the same base and time → null, A still served', async () => {
  const base = 'https://api.minimax.io/anthropic'
  const ok = fakeFetch([['/v1/api/openplatform/coding_plan/remains', res(200, mmPlan(false))]])
  const a = await providerUsage({ baseUrl: base, apiKey: 'mm-key-A' }, io(ok))
  assert.equal(a.value, '5h:42% (1h)')
  const down = fakeFetch([['/v1/api/openplatform/coding_plan/remains', res(503, '')]])
  assert.equal(await providerUsage({ baseUrl: base, apiKey: 'mm-key-B' }, io(down)), null)
  assert.deepEqual(await providerUsage({ baseUrl: base, apiKey: 'mm-key-A' }, io(down)), a)
})

test('GLM: credentials on the quota endpoint still asks balance; 凭据失效 only when both agree', async () => {
  const balanceOk = ['/api/biz/account/query-customer-account-report', res(200, { code: 200, data: { availableBalance: 3 } })]
  const quota401 = ['/api/monitor/usage/quota/limit', res(401, { success: false, msg: 'unauthorized' })]
  const p = (k) => ({ baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: k })
  let f = fakeFetch([quota401, balanceOk])
  assert.deepEqual(await providerUsage(p('glm-key-d'), io(f)), { label: '余额', value: '¥3.00' })
  assert.equal(f.calls.length, 2)
  f = fakeFetch([quota401, ['/api/biz/account/query-customer-account-report', res(403, { code: 403 })]])
  assert.deepEqual(await providerUsage(p('glm-key-e'), io(f)), { label: '额度', value: '凭据失效' })
  f = fakeFetch([quota401, ['/api/biz/account/query-customer-account-report', res(200, { code: 1001, msg: 'no' })]])
  assert.equal(await providerUsage(p('glm-key-f'), io(f)), null, 'quota credentials + balance malformed → nothing claimed')
  // transient on quota also tries balance; a 401 there alone is not a verdict → transient keeps the last good value
  let t = NOW
  f = fakeFetch([['/api/monitor/usage/quota/limit', res(200, glmQuota)]])
  const good = await providerUsage(p('glm-key-g'), io(f, () => t))
  t = NOW + 60_000
  f = fakeFetch([['/api/monitor/usage/quota/limit', res(503, '')], ['/api/biz/account/query-customer-account-report', res(401, {})]])
  assert.deepEqual(await providerUsage(p('glm-key-g'), io(f, () => t)), good)
  assert.equal(f.calls.length, 2)
})

test('createUsageProbe keeps its { supported, value } contract on top of providerUsage', async () => {
  const probe = createUsageProbe({ probe: async () => ({ label: '额度', value: '5h:1%' }), now: () => NOW })
  assert.deepEqual(await probe('glm', { baseUrl: 'https://open.bigmodel.cn', apiKey: 'k' }), { supported: true, value: '额度 5h:1%' })
  assert.deepEqual(await probe('volc', { baseUrl: 'https://ark.cn-beijing.volces.com', apiKey: 'k' }), { supported: false, value: null })
})
