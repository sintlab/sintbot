'use strict'

// Console display only. Official limits and active executor windows are
// separate values; neither changes the server-side capacity of a model.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Verified against each model's OpenAI model details page under
// https://developers.openai.com/api/docs/models/<id> (2026-11-11).
// API limits are distinct from the smaller active Codex CLI windows.
const OPENAI_API_WINDOWS = new Map([
  'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol',
  'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
].map(id => [id, 1_050_000]))

// https://platform.claude.com/docs/en/build-with-claude/context-windows
const CLAUDE_WINDOWS = new Map([
  ['claude-opus-5-5', 1_000_000],
  ['claude-opus-5', 1_000_000],
  ['claude-opus-4-8', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-haiku-4-5', 200_000],
  ['claude-fable-5-1', 1_000_000],
  ['claude-fable-5-1[1m]', 1_000_000],
  ['claude-fable-5-2', 1_000_000],
])

function codexCatalogWindows(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  let catalog
  try { catalog = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8')) } catch { return new Map() }
  const fetchedAt = Date.parse(catalog.fetched_at)
  if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > 30 * 86400_000 || fetchedAt > Date.now() + 86400_000) return new Map()
  const windows = new Map()
  for (const model of Array.isArray(catalog.models) ? catalog.models : []) {
    const id = model.slug || model.model || model.id
    const full = model.context_window
    const percent = model.effective_context_window_percent
    if (typeof id !== 'string' || !Number.isSafeInteger(full) || full <= 0 ||
        (percent != null && (!Number.isSafeInteger(percent) || percent < 1 || percent > 100))) continue
    windows.set(id, { tokens: full, usableTokens: Math.floor(full * (percent || 100) / 100) })
  }
  return windows
}

function windowForProvider(provider, reported, codexWindows) {
  const model = provider.model || provider.env?.ANTHROPIC_MODEL || ''
  const catalog = provider.runner === 'codex' ? codexWindows.get(model) : null
  const gateway = provider.baseUrl || provider.env?.ANTHROPIC_BASE_URL
  const official = provider.runner === 'codex' ? OPENAI_API_WINDOWS.get(model)
    : gateway ? null : CLAUDE_WINDOWS.get(model)
  // The catalog's context_window is the supported maximum. Runtime reports
  // may instead contain its effective (reserved) portion.
  if (catalog && (!Number.isSafeInteger(reported) || reported <= 0 ||
      reported === catalog.tokens || reported === catalog.usableTokens)) return {
    tokens: official || catalog.tokens, activeTokens: catalog.tokens,
    usableTokens: catalog.usableTokens,
    source: official ? 'official' : 'catalog',
  }
  if (Number.isSafeInteger(reported) && reported > 0) return {
    tokens: official || reported, activeTokens: reported, source: official ? 'official' : 'reported',
  }
  if (provider.runner === 'codex') {
    return official ? { tokens: official, source: 'official' } : { tokens: null, source: 'unknown' }
  }
  // Known official model IDs only. A gateway or an unspecified default may use
  // a different limit, so those need a real turn report instead of a guess.
  return official ? { tokens: official, source: 'official' } : { tokens: null, source: 'unknown' }
}

module.exports = { codexCatalogWindows, windowForProvider }
