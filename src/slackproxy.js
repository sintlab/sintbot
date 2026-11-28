'use strict'
// The proxy Slack onboarding goes through. On mainland-China networks a first
// setup often works only because the terminal exports a proxy, while the
// service started later by launchd or the desktop app has no such variables.
// So the setup page shows the proxy found here, lets the person keep, change
// or clear it, checks both tokens through exactly that choice, and the core
// saves it with the connection as the service-wide `proxy`: the model tools
// and the other platforms use it too, minus the exceptions saved with it.
//
// A proxy URL may carry a user name and password. They leave this module only
// as the URL handed to the tunnel and to the core's configuration; whatever is
// shown on a page or written to a log is masked.
const core = require('./agent/privatecore')
const { proxyFromEnv, noProxyFromEnv, TunnelAgent, createProxyFetch, resetProxy } = require('./core/proxy')
const { deriveNoProxy } = require('./config')

const MASK = '***'
// Same order as the tunnel's own reading of the environment.
const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
const ALL_KEYS = [...ENV_KEYS, 'NO_PROXY', 'no_proxy']
const MASK_MOVED = '代理地址里的 *** 只代表原来那个代理的用户名和密码；换了代理地址，请重新填写用户名和密码。'

const parse = value => { try { return new URL(String(value).trim()) } catch { return null } }
const MASKED = /\*\*\*(?::\*\*\*)?@/

// The proxy as it may be shown: everything before the last @ (after a scheme,
// if there is one) becomes *** or ***:***, however the string parses. A proxy
// written without a scheme (user:pass@host:port) parses as a URL whose scheme
// is the user name, so a URL parser cannot be trusted to find it.
function maskProxy(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const at = text.lastIndexOf('@')
  if (at < 0) return text
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(text)
  const start = scheme && scheme[0].length <= at ? scheme[0].length : 0
  const userinfo = text.slice(start, at)
  const rest = text.slice(at + 1).replace(/^([^/?#]*)\/$/, '$1')
  return `${text.slice(0, start)}${MASK}${userinfo.includes(':') ? ':' + MASK : ''}@${rest}`
}

// The proxy this process would use, masked for the page. A proxy variable the
// tunnel cannot use (typically socks5://) is named, masked, so the page can
// say so.
function detectSlackProxy(env = process.env) {
  const url = proxyFromEnv(env)
  if (url) return { shown: maskProxy(url), unusable: '' }
  for (const key of ENV_KEYS) {
    const value = env && env[key]
    if (value && String(value).trim()) return { shown: '', unusable: maskProxy(String(value)) }
  }
  return { shown: '', unusable: '' }
}

// What the setup page's proxy line shows: on which platforms it appears and
// what it is prefilled with, as the built-in core decides from what is read
// here (the terminal's proxy variables, the system's languages and proxy
// settings). `url` is the proxy itself and stays in this process; the page
// gets `shown`, masked. `unusable` is a terminal proxy the tunnel cannot use,
// masked, for the page's note.
function setupProxyOffer(env = process.env, facts = null) {
  const read = facts || require('./systemproxy').readSystemFacts()
  const found = detectSlackProxy(env)
  const plan = core.connectPlan('proxy-offer', { observed: { languages: read.languages || [],
    terminal: proxyFromEnv(env), terminalUnusable: !!found.unusable, system: read.system || null } })
  const { platforms, url, source, note } = plan.offer
  return { platforms, url, shown: maskProxy(url), source, note, unusable: found.unusable }
}

// A value sent back from a page. A masked user name or password (***) stands
// for the original's own, but only on the very same proxy (scheme, host and
// port): credentials never follow a changed address. Unmasked, it is used as
// typed.
function restoreMaskedProxy(value, original) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!MASKED.test(text)) return text
  const before = typeof original === 'string' ? original.trim() : ''
  if (before && maskProxy(before) === text) return before
  const u = parse(text), o = parse(before)
  if (!u || !o || !o.username || u.protocol !== o.protocol || u.host !== o.host) throw new Error(MASK_MOVED)
  // A kept password belongs to its own user name.
  if (u.password === MASK && u.username !== MASK && u.username !== o.username) throw new Error(MASK_MOVED)
  if (u.username === MASK) u.username = o.username
  if (u.password === MASK) u.password = o.password
  return u.href.replace(/\/$/, '')
}

// The proxy to save with a Slack connection, and the exceptions saved with
// it, as the built-in core decides them from what is observed here: the
// chosen proxy (empty for none), the model endpoint hosts, the terminal's
// NO_PROXY and the installation's saved proxy, which is kept. Returns
// { url, noProxy } (url empty: no proxy is saved); a proxy the tunnel cannot
// carry is refused with the core's sentence.
function slackProxyChoice(url, { env = process.env, providers = {}, saved = null } = {}) {
  const plan = core.connectPlan('slack-proxy', { observed: { proxy: typeof url === 'string' ? url : '',
    endpointHosts: deriveNoProxy(providers), terminalNoProxy: noProxyFromEnv(env), ...(saved != null ? { saved } : {}) } })
  if (plan.verdict !== 'ok') throw new Error(plan.notice)
  return { url: plan.proxy.url, noProxy: plan.proxy.noProxy }
}

// What the page sent back, as the proxy to use: masked credentials restored
// here, everything else decided by slackProxyChoice. Empty means a direct
// connection.
function resolveSlackProxy(value, env = process.env, providers = {}) {
  return slackProxyChoice(restoreMaskedProxy(value, proxyFromEnv(env)), { env, providers })
}

// The fetch and socket agent for one onboarding run: through the chosen proxy,
// or direct when none was chosen (even if this process has one in its
// environment, because the service started later will not).
function slackNet({ url = '', noProxy = '' } = {}) {
  if (!url) return { fetchImpl: (...args) => fetch(...args), agent: null, close() {} }
  const agent = new TunnelAgent(url)
  return { fetchImpl: createProxyFetch(url, { noProxy, agent }), agent,
    close() { try { agent.destroy() } catch {} } }
}

// Setup and the service run in one process. After an explicit choice on the
// setup page (a proxy, or none), the service must follow what was saved, not
// the terminal's proxy variables, which `applyProxyEnv` never overrides. So
// they are dropped here and the saved configuration fills them in again.
// Without such a choice nothing changes.
function followSetupProxyChoice(chosen, env = process.env) {
  if (chosen !== true) return false
  for (const key of ALL_KEYS) delete env[key]
  resetProxy()
  return true
}

module.exports = { maskProxy, detectSlackProxy, setupProxyOffer, restoreMaskedProxy, slackProxyChoice, resolveSlackProxy, slackNet,
  followSetupProxyChoice, SLACK_PROXY_MASK_MOVED: MASK_MOVED }
