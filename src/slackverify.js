'use strict'
// Slack onboarding checks. Slack has no scan-to-create flow: the person creates
// their own app from a prefilled manifest link and pastes two tokens. This
// module makes the network calls for each pasted token; the built-in core
// decides the verdict and owns every sentence. A token value is never handed
// to the core or returned: only its prefix and the app ID embedded in it.
const core = require('./agent/privatecore')
const { createSlackApi } = require('./platform/slack')

// The non-secret head of a token: its kind marker only.
function tokenPrefix(token) {
  const m = /^(xoxe\.xox[a-z]-|xoxe\.|xox[a-z]-|xapp-)/.exec(typeof token === 'string' ? token.trim() : '')
  if (m) return m[1]
  return typeof token === 'string' && token.trim() ? 'other' : ''
}
// xapp-<version>-<app id>-<number>-<secret>
function appIdOfAppToken(token) {
  const m = /^xapp-\d+-(A[A-Z0-9]{8,19})-/.exec(typeof token === 'string' ? token.trim() : '')
  return m ? m[1] : ''
}
const codeOf = error => (error && typeof error.code === 'string' && error.code) || 'request_timeout'
// Slack was not reached at all (timeout, DNS, refused, a proxy that does not
// answer): the page then points at its proxy field. Refusals by Slack are not.
const unreached = code => code === 'request_timeout'

// The pages of one app's settings, for the step-by-step links.
function slackAppLinks(appId) {
  if (!/^A[A-Z0-9]{8,19}$/.test(appId || '')) return null
  const base = `https://api.slack.com/apps/${appId}`
  // `install` is the OAuth & Permissions page: it holds both the Install to
  // Workspace button and, once installed, the Bot User OAuth Token.
  return { general: `${base}/general`, install: `${base}/oauth`, manifest: `${base}/app-manifest` }
}

// Step 1: the app-level token. Opening a connection URL is the only way to
// check it; the URL is discarded and no socket is opened.
async function verifySlackAppToken(appToken, { fetchImpl = null } = {}) {
  const token = typeof appToken === 'string' ? appToken.trim() : ''
  const observed = { appTokenPrefix: tokenPrefix(token), appId: appIdOfAppToken(token), socketOk: false, socketError: '' }
  if (observed.appTokenPrefix === 'xapp-') {
    try {
      const call = createSlackApi(token, { fetchImpl, timeoutMs: 12_000 })
      const response = await call('apps.connections.open', {}, { retries: 0 })
      observed.socketOk = typeof response?.url === 'string' && /^wss?:\/\//.test(response.url)
      if (!observed.socketOk) observed.socketError = 'invalid_response'
    } catch (error) { observed.socketError = codeOf(error) }
  }
  const plan = core.connectPlan('slack-app-token', { observed })
  return { ok: plan.verdict === 'ok', verdict: plan.verdict, notice: plan.notice,
    network: plan.verdict !== 'ok' && unreached(observed.socketError),
    appId: plan.verdict === 'ok' ? observed.appId : '', links: plan.verdict === 'ok' ? slackAppLinks(observed.appId) : null }
}

// Step 2: the bot token. auth.test proves it and names the workspace; the
// granted scopes come from its response header (Slack has no call for them);
// bots.info names the app it belongs to, so a token copied from another app
// is caught here instead of as messages that never arrive.
async function verifySlackBotToken(botToken, { appId = '', fetchImpl = null } = {}) {
  const token = typeof botToken === 'string' ? botToken.trim() : ''
  const observed = { botTokenPrefix: tokenPrefix(token), authOk: false, authError: '', appId: appId || '',
    botAppId: '', team: '', scopes: [] }
  let identity = null
  if (observed.botTokenPrefix === 'xoxb-') {
    const call = createSlackApi(token, { fetchImpl, timeoutMs: 12_000 })
    try {
      const me = await call('auth.test', {}, { retries: 0, onHeaders: headers => {
        observed.scopes = String(headers?.get?.('x-oauth-scopes') || '').split(',').map(scope => scope.trim()).filter(Boolean)
      } })
      observed.authOk = true
      observed.team = typeof me.team === 'string' ? me.team : ''
      identity = { team: observed.team, teamId: me.team_id || '', botUserId: me.user_id || '', botName: me.user || '',
        botId: me.bot_id || '', url: typeof me.url === 'string' ? me.url : '' }
    } catch (error) { observed.authError = codeOf(error) }
    if (identity?.botId) {
      // Best effort: without users:read this call is refused and the app
      // identity simply stays unchecked.
      try {
        const info = await call('bots.info', { bot: identity.botId }, { retries: 0 })
        if (typeof info?.bot?.app_id === 'string') observed.botAppId = info.bot.app_id
      } catch {}
    }
  }
  const plan = core.connectPlan('slack-bot-token', { observed })
  const ok = plan.verdict === 'ok' || plan.verdict === 'warn'
  return { ok, verdict: plan.verdict, notice: plan.notice, network: !ok && unreached(observed.authError),
    identity: ok && identity ? { team: identity.team, teamId: identity.teamId, botUserId: identity.botUserId,
      botName: identity.botName, appId: observed.botAppId || observed.appId || '', url: identity.url } : null }
}

// Where the person opens the conversation with the bot they just installed.
function slackOpenLinks(identity) {
  if (!identity || !/^T[A-Z0-9]{2,19}$/.test(identity.teamId || '') || !/^A[A-Z0-9]{8,19}$/.test(identity.appId || '')) return null
  return { app: `slack://app?team=${identity.teamId}&id=${identity.appId}&tab=messages`,
    web: `https://slack.com/app_redirect?app=${identity.appId}&team=${identity.teamId}` }
}

module.exports = { verifySlackAppToken, verifySlackBotToken, slackAppLinks, slackOpenLinks, tokenPrefix, appIdOfAppToken }
