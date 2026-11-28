'use strict'
// Key-route model providers: Anthropic-compatible endpoints that Claude Code reaches with an API key.
// This list is the single source for every place that needs to know one of them: the console's Add model
// presets, logos and per-group model lists (src/modelcatalog.js), the live model-list probe, the quota line
// (src/usage.js), the terminal wizard (src/setupmodels.js), and the docs table in docs/models.md (checked by
// tests/unit/providers.test.js). Subscription backends (Claude sign-in, Codex) are not listed here.
//
// Adding a provider = one entry below + one logo symbol in console.html's #brand-sprite (or `logo: null` for the
// neutral icon) + English entries for its Chinese strings in the console dictionary. tests/unit/providers.test.js
// walks every entry for the required fields, and fails when a provider name or host is hard-coded elsewhere in src/.
//
// Fields:
//   id         card name the preset fills in, and the stable key of the entry
//   preset     the Add model label (also its dictionary key); name { zh, en } the provider's own name
//   logo       symbol id in #brand-sprite, or null for the neutral icon
//   regions    [{ region, baseUrl, display?, hosts, label?, site?, list[], quota?, legacy? }]: the endpoint to store
//              (display = the form shown wherever the console prints it, when it differs), the hostnames that
//              identify a card of this provider, the wizard's sign-up site, the live model-list URLs
//              ('{base}' = the card's endpoint) and the quota recipe ({ kind, host }; kind = the core usage_parse
//              family). legacy: recognised on existing cards, never offered for a new one.
//   auth       'auth-token' (ANTHROPIC_AUTH_TOKEN, sent as a bearer token; every provider here) | 'api-key'
//   model      recommended main model (a group that has not chosen runs the card's stored model, which a new
//              card takes from here); small = the small / sub-agent model, kept on the card
//   vision     false when the recommended model reads no images (engages the strip proxy)
//   effort     recommended thinking depth for a new group (null = the Claude Code default the catalog uses)
//   env        the card's Claude Code tuning, written as the docs give it (tier mapping, compaction, timeouts)
//   list       { url, read, models: [{ id, label, tier: 'main'|'small', context, vision, efforts?, note?, confirmed? }] }
//              the provider's documented models; confirmed:false = listed by someone else, not on the page read
//   live       optional filter for a live list that carries far more than coding models. drop: regex source of
//              ids never shown. Then either keep: family prefixes allowed (an id is in family p when it is p or starts
//              with p- / p.) with perFamily?: a cap per family in API order; or families: { prefix: rule } in display
//              order, rule = { all: true } (every id of the family) or { generations: N } (only ids whose version,
//              read from the id, is among the N newest the list has; newest first, a -pro variant right after its
//              base; an id with no version is left out), each with drop?: a regex of its own and cap?: a ceiling.
//              Documented models come first in their family. Without live the list is shown whole.
//   test       how the dialog's Verify key checks a key: 'trial' = one short Claude Code turn (the wizard's call)
//   wizard     also offered by the terminal wizard (with keyEnv, billing); docs = listed in docs/models.md
//   bare       listed in the Add model presets and nowhere else: no wizard, no docs, no notices; the page shows its name only
//   recommended  the one start recommended without a subscription: the wizard offers it first (the model
//              library shows only configured cards; it is added from the Add model presets like the rest)

const PROVIDERS = Object.freeze([
  {
    id: 'deepseek',
    preset: 'DeepSeek (deepseek)',
    name: { zh: 'DeepSeek', en: 'DeepSeek' },
    logo: 'b-deepseek',
    regions: [{ region: 'cn', baseUrl: 'https://api.deepseek.com/anthropic', hosts: ['api.deepseek.com'],
      site: 'https://platform.deepseek.com',
      list: ['{base}/v1/models', 'https://api.deepseek.com/models'], quota: { kind: 'deepseek', host: 'https://api.deepseek.com' } }],
    auth: 'auth-token',
    keyEnv: 'DEEPSEEK_API_KEY',
    billing: { zh: '按量付费', en: 'pay as you go' },
    model: 'deepseek-flash[1m]', small: 'deepseek-flash', vision: true, effort: 'max',
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash', CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432' },
    list: { url: 'https://api-docs.deepseek.com/quick_start/pricing', read: '2026-11-20', models: [
      { id: 'deepseek-flash[1m]', label: 'DeepSeek Flash (1M)', tier: 'main', context: 1_000_000, vision: true },
      { id: 'deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro (1M)', tier: 'main', context: 1_000_000, vision: false, note: 'reads no images' },
      { id: 'deepseek-flash', label: 'DeepSeek Flash', tier: 'small', context: 1_000_000, vision: true },
    ] },
    test: 'trial', wizard: true, docs: true, recommended: true,
  },
  {
    id: 'glm',
    preset: '智谱 GLM (glm)',
    name: { zh: '智谱 GLM', en: 'Zhipu GLM' },
    logo: 'b-zhipu',
    regions: [
      { region: 'cn', baseUrl: 'https://open.bigmodel.cn/api/anthropic', hosts: ['open.bigmodel.cn'],
        site: 'https://open.bigmodel.cn',
        list: ['https://open.bigmodel.cn/api/paas/v4/models'], quota: { kind: 'glm', host: 'https://open.bigmodel.cn' } },
      { region: 'intl', baseUrl: 'https://api.z.ai/api/anthropic', hosts: ['api.z.ai'], label: { zh: 'Z.ai', en: 'Z.ai' },
        site: 'https://z.ai',
        list: ['https://api.z.ai/api/paas/v4/models'], quota: { kind: 'glm', host: 'https://api.z.ai' } },
    ],
    auth: 'auth-token',
    keyEnv: 'ZHIPU_API_KEY',
    billing: { zh: '按量或包月 GLM Coding Plan', en: 'pay as you go or the monthly GLM Coding Plan' },
    model: 'glm-5.3[1m]', small: 'glm-5.3-flash[1m]', vision: false, effort: null,
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
      CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.3-flash[1m]', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', API_TIMEOUT_MS: '3000000' },
    list: { url: 'https://docs.bigmodel.cn/cn/coding-plan/overview', read: '2026-11-20', models: [
      { id: 'glm-5.3[1m]', label: 'GLM-5.3 (1M)', tier: 'main', context: 1_000_000, vision: false, note: 'text only' },
      { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3-Flash (1M)', tier: 'main', context: 1_000_000, vision: true },
      { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3-Flash (1M)', tier: 'small', context: 1_000_000, vision: true },
    ] },
    test: 'trial', wizard: true, docs: true,
  },
  {
    id: 'kimi',
    preset: 'Kimi (kimi)',
    name: { zh: 'Kimi', en: 'Kimi' },
    logo: 'b-kimi',
    regions: [
      { region: 'cn', baseUrl: 'https://api.moonshot.cn/anthropic', hosts: ['api.moonshot.cn'],
        site: 'https://platform.kimi.com', list: ['https://api.moonshot.cn/v1/models'], quota: null },
      { region: 'intl', baseUrl: 'https://api.moonshot.ai/anthropic', hosts: ['api.moonshot.ai'], label: { zh: 'Kimi 国际站', en: 'Kimi (international)' },
        site: 'https://platform.kimi.ai', list: ['https://api.moonshot.ai/v1/models'], quota: null },
    ],
    auth: 'auth-token',
    keyEnv: 'MOONSHOT_API_KEY',
    billing: { zh: '按量付费', en: 'pay as you go' },
    model: 'kimi-k3[1m]', small: 'kimi-k3[1m]', vision: true, effort: 'max',
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k3[1m]',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'kimi-k3[1m]', CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k3[1m]', CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
    list: { url: 'https://platform.kimi.com/docs/api/models-overview', read: '2026-11-20', models: [
      { id: 'kimi-k3[1m]', label: 'Kimi K3 (1M)', tier: 'main', context: 1_000_000, vision: true, efforts: ['low', 'high', 'max'] },
      { id: 'kimi-k3.1-pro[1m]', label: 'Kimi K3.1 Pro (1M)', tier: 'main', context: 1_000_000, vision: true, efforts: ['low', 'high', 'max'], confirmed: false, note: 'the Claude Code page names only kimi-k3[1m]' },
      { id: 'kimi-k3.1-pro-highspeed[1m]', label: 'Kimi K3.1 Pro Highspeed (1M)', tier: 'main', context: 1_000_000, vision: true, efforts: ['low', 'high', 'max'], confirmed: false, note: 'the Claude Code page names only kimi-k3[1m]' },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', tier: 'main', context: 256_000, vision: null, efforts: [], confirmed: false, note: 'no reasoning_effort; image input not stated' },
      { id: 'kimi-k3[1m]', label: 'Kimi K3 (1M)', tier: 'small', context: 1_000_000, vision: true },
    ] },
    test: 'trial', wizard: true, docs: true,
  },
  {
    id: 'minimax',
    preset: 'MiniMax (minimax)',
    name: { zh: 'MiniMax', en: 'MiniMax' },
    logo: 'b-minimax',
    regions: [
      { region: 'cn', baseUrl: 'https://api.minimax.cn/anthropic', hosts: ['api.minimax.cn'],
        site: 'https://platform.minimax.cn',
        list: ['{base}/v1/models'], quota: { kind: 'minimax', host: 'https://api.minimax.cn' } },
      // The older mainland guide's endpoint: cards configured with it keep their quota line on its own host.
      { region: 'cn', baseUrl: 'https://api.minimaxi.com/anthropic', hosts: ['api.minimaxi.com'], legacy: true,
        site: 'https://platform.minimax.cn', list: ['{base}/v1/models'], quota: { kind: 'minimax', host: 'https://api.minimaxi.com' } },
      { region: 'intl', baseUrl: 'https://api.minimax.io/anthropic', hosts: ['api.minimax.io'], label: { zh: 'MiniMax 国际站', en: 'MiniMax (international)' },
        site: 'https://platform.minimax.io',
        list: ['{base}/v1/models'], quota: { kind: 'minimax', host: 'https://api.minimax.io' } },
    ],
    auth: 'auth-token',
    keyEnv: 'MINIMAX_API_KEY',
    billing: { zh: '按量或包月 Token Plan', en: 'pay as you go or the monthly Token Plan' },
    model: 'MiniMax-M3.1-Flash[1m]', small: 'MiniMax-M3.1-Flash[1m]', vision: true, effort: 'max',
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3.1-Flash[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3.1-Flash[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3.1-Flash[1m]',
      CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '524288', API_TIMEOUT_MS: '3000000' },
    list: { url: 'https://platform.minimax.cn/docs/api-reference/text-anthropic-api', read: '2026-11-20', models: [
      { id: 'MiniMax-M3.1-Flash[1m]', label: 'MiniMax-M3.1-Flash (1M)', tier: 'main', context: 1_000_000, vision: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'MiniMax-M3[1m]', label: 'MiniMax-M3 (1M)', tier: 'main', context: 1_000_000, vision: true, efforts: [], note: 'thinking depth applies to M3.1-Flash only' },
      // Listed for the Anthropic-compatible API by the 11-20 check; the Anthropic API page read the same day
      // names only M3.1-Flash and M3 ("other models: use the standard MiniMax API").
      ...['MiniMax-M3.1-Flash-Preview', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2']
        .map((id) => ({ id, label: id, tier: 'main', context: null, vision: null, confirmed: false, note: 'not on the Anthropic API page read 11-20' })),
      { id: 'MiniMax-M3.1-Flash[1m]', label: 'MiniMax-M3.1-Flash (1M)', tier: 'small', context: 1_000_000, vision: true },
    ] },
    test: 'trial', wizard: true, docs: true,
  },
  {
    // Listed in the Add model presets only (user, 11-20): its name and nothing else.
    id: 'modelfold',
    preset: 'ModelFold (modelfold)',
    name: { zh: 'ModelFold', en: 'ModelFold' },
    logo: null,
    regions: [{ region: 'intl', baseUrl: 'https://modelfold.ai/p/sintbot/anthropic', display: 'https://modelfold.ai/anthropic', hosts: ['modelfold.ai'], list: ['{base}/v1/models'], quota: { kind: 'modelfold', host: 'https://modelfold.ai' } }],
    auth: 'auth-token',
    model: 'claude-sonnet-5-5', small: 'claude-haiku-5-5', vision: true, effort: null,
    // All four model variables: background tasks ask for the Haiku tier and fail without it.
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5' },
    // Its live list has some 340 entries of every kind. Shown (user, 11-20): the whole Claude family, then the main GPT
    // and Gemini models = their two newest generations in the list, without the small, audio, open-weight, codex,
    // preview and compatibility variants, at most 8 each. The generic drop pattern applies to all three.
    live: { drop: 'audio|guard|safeguard|search|summarize|extract|apply|-free$|tts|mt2|omni|vision-exp|realtime|embed|rerank|moderation',
      families: {
        claude: { all: true },
        gpt: { generations: 2, drop: 'mini|nano|audio|oss|codex|realtime|search|safeguard|^gpt-3-5|^gpt-4o?\\b', cap: 8 },
        gemini: { generations: 2, drop: 'openai|lite|preview|flash-lite', cap: 8 },
      } },
    // Tested 2026-11-20: claude-sonnet-5-5 (main, a real Claude Code turn) and claude-haiku-5-5 (small and sub-agent, a
    // bearer /v1/messages call). The other documented ids are not tested yet. The tested two come first.
    list: { url: 'https://modelfold.ai/llms.txt', read: '2026-11-20', models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'main', context: null, vision: true, note: 'tested 2026-11-20' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tier: 'small', context: null, vision: true, note: 'tested 2026-11-20' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'main', context: null, vision: true, note: 'not tested yet' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'main', context: null, vision: true, note: 'not tested yet' },
      { id: 'claude-opus-5', label: 'Claude Opus 5', tier: 'main', context: null, vision: true, note: 'not tested yet' },
    ] },
    test: 'trial', wizard: false, docs: false, bare: true,
  },
].map(deepFreeze))

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v) }
  return o
}

const hostOf = (url) => { try { return new URL(String(url || '')).hostname.toLowerCase() } catch { return '' } }

// The entry and region a stored endpoint belongs to (exact hostname match), or null.
function forBase(baseUrl) {
  const host = hostOf(baseUrl)
  if (!host) return null
  for (const entry of PROVIDERS) for (const region of entry.regions) if (region.hosts.includes(host)) return { entry, region }
  return null
}
// A model card's provider: by its endpoint (baseUrl, or one set in its env), never by the card's name.
const forCard = (p) => (p && p.runner !== 'codex' ? forBase(p.baseUrl || (p.env && p.env.ANTHROPIC_BASE_URL)) : null)
const byId = (id) => PROVIDERS.find((e) => e.id === id) || null
const primary = (entry) => entry.regions.find((r) => !r.legacy)

// The documented models of one tier (main = what a group picks; small = the card's small / sub-agent model).
const modelsOf = (entry, tier = 'main') => entry.list.models.filter((m) => m.tier === tier)

// The form of a stored endpoint the console shows: a region's display URL replaces its stored prefix
// (the stored URL keeps it); any other endpoint is shown as stored.
function displayBase(baseUrl) {
  const url = String(baseUrl || '')
  const hit = forBase(url)
  const r = hit && hit.region
  return r && r.display && url.startsWith(r.baseUrl) ? r.display + url.slice(r.baseUrl.length) : url
}

// Quota recipe for a stored endpoint: { kind, host } | null.
function quotaFor(baseUrl) {
  const hit = forBase(baseUrl)
  return hit && hit.region.quota ? hit.region.quota : null
}

// ── live model lists ──
// The list URLs to try for an endpoint: the region's own routes, or `{base}/v1/models` for an unknown endpoint.
function listUrls(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return []
  const hit = forBase(base)
  const routes = hit ? hit.region.list : ['{base}/v1/models']
  return [...new Set(routes.map((r) => r.replace('{base}', base)))]
}
// `{ data: [{ id }] }` (OpenAI / Anthropic style), `{ models: [{ id | name }] }`, or a bare array; strings or objects.
// Anything else (an error body, HTML) is no list. Ids are trimmed, deduplicated, kept in the order given.
function normaliseModelList(body) {
  let arr = null
  if (Array.isArray(body)) arr = body
  else if (body && typeof body === 'object') arr = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null
  if (!arr) return []
  const ids = []
  for (const x of arr) {
    const id = typeof x === 'string' ? x : x && typeof x === 'object' ? (typeof x.id === 'string' ? x.id : typeof x.name === 'string' ? x.name : '') : ''
    const t = id.trim()
    if (t && t.length <= 200 && !/\s/.test(t) && !ids.includes(t)) ids.push(t)
  }
  return ids
}
// The display names a list gives (`display_name`, or `name` next to an `id`): { id: name } where they differ.
function modelNamesOf(body) {
  const arr = Array.isArray(body) ? body : body && typeof body === 'object' ? (Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []) : []
  const out = {}
  for (const x of arr) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string') continue
    const n = typeof x.display_name === 'string' ? x.display_name : typeof x.name === 'string' ? x.name : ''
    if (n.trim() && n.trim() !== x.id.trim() && n.length <= 60) out[x.id.trim()] = n.trim()
  }
  return out
}
// One GET of every list URL with the key (Authorization: Bearer first, x-api-key second), 8 s each.
// → { ok: true, ids, names, url } | { ok: false, reason: 'auth' | 'none' | 'network' }. The key and the response
// body are never logged or returned.
async function probeModels({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const key = String(apiKey || '')
  if (!key) return { ok: false, reason: 'auth' }
  let reason = 'none'
  for (const url of listUrls(baseUrl)) {
    for (const headers of [{ Authorization: `Bearer ${key}` }, { 'x-api-key': key }]) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const r = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal: ac.signal })
        const text = await r.text()
        if (r.status === 401 || r.status === 403) { reason = 'auth'; continue }
        if (r.status !== 200) break // another header will not change a missing route
        let body = null
        try { body = JSON.parse(text) } catch { body = null }
        const ids = normaliseModelList(body)
        if (ids.length) return { ok: true, ids, names: modelNamesOf(body), url }
        break
      } catch { if (reason === 'none') reason = 'network' } finally { clearTimeout(timer) }
    }
  }
  return { ok: false, reason }
}

// What a group picks from before any live list: the documented models, the recommended one first, then the small
// one when it is not also a main model, then the other main ones.
function choicesOf(entry) {
  if (!entry) return []
  const plain = (id) => id.replace(/\[\w+\]$/, '')
  const main = modelsOf(entry)
  const small = modelsOf(entry, 'small').filter((s) => !main.some((m) => plain(m.id) === plain(s.id)))
  return [...main.filter((m) => m.id === entry.model), ...small, ...main.filter((m) => m.id !== entry.model)]
}
// The family an id belongs to under an entry's live filter: the longest kept prefix it matches, or ''.
function familyOf(entry, id) {
  const live = entry && entry.live
  const keep = (live && (live.families ? Object.keys(live.families) : live.keep)) || []
  return keep.filter((p) => id === p || id.startsWith(p + '-') || id.startsWith(p + '.')).sort((a, b) => b.length - a.length)[0] || ''
}
// The group card's model list for a live probe. Documented models the live list has come first (the
// recommended one, the small one when it is not also a main model, then the other main ones), with their
// metadata and documented id (`[1m]` included); then the other live ids in API order, labelled with the list's
// display name where it differs. An entry's `live` filter keeps only its families, drops its never-shown ids
// and caps each family when it sets a cap; without one every live id is listed.
// The version an id carries after its family prefix: gpt-6-2-sol → [6, 2], gemini-3.1-pro → [3, 1],
// gemini-4-argon → [4, 0]; null when the id names none (gpt-audio, gpt-4o).
function versionOf(family, id) {
  const m = /^(\d+)(?:[-.](\d+))?(?=[-.]|$)/.exec(id.slice(family.length + 1))
  return m ? [Number(m[1]), m[2] === undefined ? 0 : Number(m[2])] : null
}
// One family's live ids under a { generations } rule: the newest N versions present, newest first, each version in
// API order with a -pro variant right after its base id.
function newestGenerations(family, ids, n) {
  const withV = ids.map((id) => ({ id, v: versionOf(family, id) })).filter((x) => x.v)
  const key = (v) => v[0] * 1000 + v[1]
  const kept = [...new Set(withV.map((x) => key(x.v)))].sort((a, b) => b - a).slice(0, n)
  const out = []
  for (const k of kept) {
    const same = withV.filter((x) => key(x.v) === k).map((x) => x.id)
    for (const id of same) {
      if (out.includes(id)) continue
      if (id.endsWith('-pro') && same.includes(id.slice(0, -4))) continue // placed after its base
      out.push(id)
      if (same.includes(id + '-pro') && !out.includes(id + '-pro')) out.push(id + '-pro')
    }
  }
  return out
}
function mergeLive(entry, ids, names = {}) {
  const plain = (id) => id.replace(/\[\w+\]$/, '')
  const lead = choicesOf(entry)
  if (entry && entry.live && entry.live.families) return mergeFamilies(entry, ids, names, lead)
  const live = new Set(ids)
  const used = new Set()
  const out = []
  for (const d of lead) {
    const hit = live.has(d.id) ? d.id : live.has(plain(d.id)) ? plain(d.id) : ''
    if (!hit || out.some((x) => x.id === d.id)) continue
    used.add(hit); out.push({ ...d })
  }
  const f = entry && entry.live ? entry.live : null
  const drop = f && f.drop ? new RegExp(f.drop, 'i') : null
  const perFamily = f && Number.isSafeInteger(f.perFamily) && f.perFamily > 0 ? f.perFamily : Infinity
  const count = {}
  if (f) for (const m of out) { const fam = familyOf(entry, plain(m.id)); if (fam) count[fam] = (count[fam] || 0) + 1 }
  for (const id of ids) {
    if (used.has(id) || out.some((x) => x.id === id)) continue
    let family = ''
    if (f) {
      family = familyOf(entry, id)
      if (!family || (drop && drop.test(id)) || (count[family] || 0) >= perFamily) continue
      count[family] = (count[family] || 0) + 1
    }
    out.push({ id, label: names[id] || id, ...(family ? { family } : {}) })
  }
  if (f) for (const m of out) if (!m.family) { const fam = familyOf(entry, plain(m.id)); if (fam) m.family = fam }
  return out
}

// The families form: per family in the entry's order, its documented models first, then the ids its rule keeps.
function mergeFamilies(entry, ids, names, lead) {
  const plain = (id) => id.replace(/\[\w+\]$/, '')
  const live = entry.live
  const drop = live.drop ? new RegExp(live.drop, 'i') : null
  const out = []
  for (const [family, rule] of Object.entries(live.families)) {
    const docs = lead.filter((d) => familyOf(entry, plain(d.id)) === family && (ids.includes(d.id) || ids.includes(plain(d.id))))
    const own = rule.drop ? new RegExp(rule.drop, 'i') : null
    const taken = new Set(docs.flatMap((d) => [d.id, plain(d.id)]))
    const pool = ids.filter((id) => familyOf(entry, id) === family && !taken.has(id) && !(drop && drop.test(id)) && !(own && own.test(id)))
    const picked = rule.all ? pool : Number.isSafeInteger(rule.generations) && rule.generations > 0 ? newestGenerations(family, pool, rule.generations) : []
    const cap = Number.isSafeInteger(rule.cap) && rule.cap > 0 ? rule.cap : Infinity
    const items = [...docs.map((d) => ({ ...d, family })), ...picked.map((id) => ({ id, label: names[id] || id, family }))]
    out.push(...items.slice(0, Math.max(cap, docs.length)))
  }
  return out
}

// ── consumers ──
// What the console page needs (injected into console.html at serve time; no secrets, no list URLs).
function clientView() {
  return PROVIDERS.map((e) => {
    const p = primary(e)
    return { id: e.id, preset: e.preset, name: e.name, logo: e.logo, baseUrl: p.baseUrl,
      displays: e.regions.filter((r) => r.display).map((r) => [r.baseUrl, r.display]),
      hosts: [...new Set(e.regions.flatMap((r) => r.hosts))], bare: !!e.bare,
      model: e.model, small: e.small, vision: e.vision, effort: e.effort, env: { ...e.env }, recommended: !!e.recommended,
      models: choicesOf(e).map((m) => ({ id: m.id, label: m.label })) }
  })
}
// The terminal wizard's provider info (src/setupmodels.js PROVIDER_INFO shape), in registry order.
function wizardInfo() {
  const out = {}
  for (const e of PROVIDERS.filter((x) => x.wizard)) {
    const p = primary(e)
    const intl = e.regions.find((r) => r.region === 'intl' && !r.legacy)
    out[e.id] = { label: e.name.zh, site: p.site, billing: e.billing.zh, en: { label: e.name.en, billing: e.billing.en },
      ...(intl ? { intl: { label: intl.label.zh, site: intl.site, baseUrl: intl.baseUrl, en: { label: intl.label.en } } } : {}) }
  }
  return out
}

module.exports = { PROVIDERS, forBase, forCard, byId, primary, modelsOf, displayBase, quotaFor, listUrls, normaliseModelList, modelNamesOf, probeModels, mergeLive, familyOf, choicesOf, versionOf, clientView, wizardInfo, hostOf }
