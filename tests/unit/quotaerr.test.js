// 额度 / 账号类错误判据(src/agent/quotaerr.js)+ 重置时刻解析(src/core/quotaerr.js)。
// 夹具全部是真机原话(2026-09-25 OAuth 过期 6 轮 · 09-27 账号 on hold · 09-28 codex 用量上限 · 09-30 / 10-05 claude 周上限)。
const test = require('node:test')
const assert = require('node:assert')
const { classifyQuota } = require('../../src/agent/quotaerr')
const { parseResetAt } = require('../../src/core/quotaerr')

const CLAUDE_WEEKLY = "You've hit your weekly limit · resets Oct 1 at 9am (Asia/Shanghai)"
const CODEX_USAGE = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:30 PM."
const ON_HOLD = "Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted"
const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed'
// 真实案例:两台共用一份凭据各自刷新(refresh token 会轮换)⇒ 服务端整族吊销;turn.failed 原话与 stderr 原话各一句
const REVOKED_TURN = 'workspace routing discovery unauthorized (401)'
const REVOKED_STDERR = 'unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request, url: https://chatgpt.com/backend-api/codex/models?client_version=0.162.0, auth error: 401, auth error code: token_revoked'

test('quotaerr: 额度用尽 ⇒ quota(能分出窗口就分);账号 / 登录态 ⇒ account', () => {
  assert.deepEqual(classifyQuota(CLAUDE_WEEKLY), { kind: 'quota', window: 'weekly' })
  assert.deepEqual(classifyQuota(CODEX_USAGE), { kind: 'quota', window: null })
  assert.deepEqual(classifyQuota("You've hit your session limit · resets 3pm"), { kind: 'quota', window: 'session' })
  assert.deepEqual(classifyQuota('usage_limit_reached'), { kind: 'quota', window: null })
  assert.deepEqual(classifyQuota(ON_HOLD), { kind: 'account', window: null })
  assert.deepEqual(classifyQuota(OAUTH), { kind: 'account', window: null })
  // 账本里 turnErrText 会带 subtype 前缀,照样认
  assert.equal(classifyQuota('error_during_execution: ' + OAUTH).kind, 'account')
  // 登录态被服务端吊销(真实案例):turn.failed 原话 · 重连中的 error 事件原话 · stderr 原话,三种拼法都算账号类
  assert.deepEqual(classifyQuota(REVOKED_TURN), { kind: 'account', window: null })
  assert.deepEqual(classifyQuota('Reconnecting... 2/5 (' + REVOKED_TURN + ')'), { kind: 'account', window: null })
  assert.deepEqual(classifyQuota(REVOKED_STDERR), { kind: 'account', window: null })
})

test('quotaerr: 瞬时错 / 普通报错 / 裸数字 / 正文里顺口提到 limit 都不算(宁漏不误)', () => {
  for (const s of [
    'Selected model is at capacity. Please try a different model.',
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'Rate limit reached for gpt-x, please retry after 20s', // 限流是瞬时错,不是额度
    'exit code 403', 'the limit of this array is 10', 'ENOENT ./x.js', '', null, undefined,
    'HTTP 401', 'status 401', 'unauthorized access to /etc/shadow', // 裸数字 / 裸 unauthorized 不认,要两样同时出现
  ]) assert.equal(classifyQuota(s), null, `不该判为额度 / 账号类:${s}`)
})

test('parseResetAt: 带月日 + 时区的原话 ⇒ 那个时区的那一刻', () => {
  const now = Date.parse('2026-09-30T00:17:47+08:00')
  assert.equal(parseResetAt(CLAUDE_WEEKLY, { now }), Date.parse('2026-10-01T09:00:00+08:00'))
  // 原话带的时区优先于产品时区
  assert.equal(parseResetAt('resets Oct 1 at 9am (America/New_York)', { now, tz: 'Asia/Shanghai' }), Date.parse('2026-10-01T09:00:00-04:00'))
  // 跨年:12 月 31 日说「resets Jan 1 at 9am」⇒ 明年
  const dec = Date.parse('2026-12-31T20:00:00+08:00')
  assert.equal(parseResetAt('resets Jan 1 at 9am (Asia/Shanghai)', { now: dec }), Date.parse('2027-01-01T09:00:00+08:00'))
})

test('parseResetAt: 只有时刻 ⇒ 按产品时区取下一次到达;已过就算明天', () => {
  const now = Date.parse('2026-09-28T11:22:34+08:00')
  assert.equal(parseResetAt(CODEX_USAGE, { now }), Date.parse('2026-09-28T14:30:00+08:00'))
  assert.equal(parseResetAt('try again at 9am', { now }), Date.parse('2026-09-29T09:00:00+08:00')) // 今天 9 点已过
  assert.equal(parseResetAt('resets 12pm', { now }), Date.parse('2026-09-28T12:00:00+08:00'))
  assert.equal(parseResetAt('resets 12am', { now }), Date.parse('2026-09-29T00:00:00+08:00'))
  // 换产品时区,算出来的绝对时刻跟着变
  assert.equal(parseResetAt('try again at 2:30 PM', { now, tz: 'America/New_York' }), Date.parse('2026-09-28T14:30:00-04:00'))
})

test('parseResetAt: 解不出就 null,绝不编一个', () => {
  const now = Date.parse('2026-09-28T11:22:34+08:00')
  for (const s of [ON_HOLD, OAUTH, REVOKED_TURN, 'resets 9', 'resets soon', 'try again later', '', null]) assert.equal(parseResetAt(s, { now }), null, `不该解出时刻:${s}`)
  assert.equal(parseResetAt('resets at 25pm', { now }), null)
})

test('parseResetAt: 解出的时刻距今超过 8 天 ⇒ 视为解错,返回 null(订阅窗口最长一周;典型是把去年的「Oct 1」推到了明年)', () => {
  const now = Date.parse('2026-10-08T10:00:00+08:00')
  assert.equal(parseResetAt('resets Oct 1 at 9am (Asia/Shanghai)', { now }), null)
  assert.equal(parseResetAt('resets Oct 15 at 9am (Asia/Shanghai)', { now }), Date.parse('2026-10-15T09:00:00+08:00'), '7 天内照解')
  assert.equal(parseResetAt('resets Oct 17 at 9am (Asia/Shanghai)', { now }), null, '9 天就不信')
})
