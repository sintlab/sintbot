'use strict'
// The single change logic for a group's backend · model · thinking depth.
// The console group card, the chat /model command and the Feishu model card
// all call applyBrainChange, so "did the backend change / only the model /
// only the depth / nothing" is decided in one place.
//
// Pure: mutates the given raw configuration object; the caller writes it
// through the configuration writer (which validates, resets sessions when the
// backend changes, replaces the file atomically and applies it).

const brainMod = require('./core/brain')
const { DEFAULTS } = require('./config')

/**
 * @param raw     configuration object (mutated)
 * @param chatId
 * @param change  { provider?, model?, effort? }
 *   provider: switch backend (omitted = keep); model / effort: string choice
 *   ('' = clear), omitted = keep. Choices go to the target backend's entry.
 * @returns { error } | { before, after, switching, target, home, modelChanged, effortChanged, changed }
 *   error ∈ 'no-group' | 'unknown-provider' | 'bad-model' | 'bad-effort'
 */
function applyBrainChange(raw, chatId, change = {}) {
  const { provider, model, effort } = change
  const g = raw && raw.groups && raw.groups[chatId]
  if (!g) return { error: 'no-group' }
  if (provider !== undefined && !(raw.providers || {})[provider]) return { error: 'unknown-provider' }
  if (model !== undefined && model !== '' && !brainMod.isModel(model)) return { error: 'bad-model' }
  if (effort !== undefined && effort !== '' && !brainMod.isEffort(effort)) return { error: 'bad-effort' }
  const defName = raw.defaultProvider || DEFAULTS.defaultProvider
  const provAll = { ...DEFAULTS.providers, ...(raw.providers || {}) }
  const home = g.provider || defName
  const before = brainMod.groupBrain(g, home, provAll[home], { defaultProvider: defName })
  // Legacy group.model first moves under its own backend, then the backend may change.
  brainMod.migrateLegacyModel(g, defName)
  const switching = provider !== undefined && provider !== home
  const target = provider || home
  if (model !== undefined || effort !== undefined) {
    const prefs = (g.providerPrefs && typeof g.providerPrefs === 'object' && !Array.isArray(g.providerPrefs)) ? g.providerPrefs : {}
    const cur = { ...(brainMod.cleanPref(prefs[target]) || {}) }
    if (model !== undefined) { if (model) cur.model = model; else delete cur.model }
    if (effort !== undefined) { if (effort) cur.effort = effort; else delete cur.effort }
    if (Object.keys(cur).length) prefs[target] = cur; else delete prefs[target]
    g.providerPrefs = prefs
  }
  const np = brainMod.normalizePrefs(g.providerPrefs)
  if (np) g.providerPrefs = np; else delete g.providerPrefs
  if (switching) g.provider = provider
  const after = brainMod.groupBrain(g, target, provAll[target], { defaultProvider: defName })
  const modelChanged = !switching && before.model !== after.model
  const effortChanged = !switching && before.effort !== after.effort
  return { before, after, switching, target, home, modelChanged, effortChanged,
    changed: switching || modelChanged || effortChanged }
}

// One audit row (console, chat command and card share the shape; source tells which).
function auditRow(chatId, r, { source, by }) {
  const pick = (b) => ({ model: b.model || '', effort: b.effort || '' })
  return { kind: 'group-model', chatId, source, by: by || '', from: { provider: r.home, ...pick(r.before) },
    to: { provider: r.target, ...pick(r.after) }, switching: r.switching, modelChanged: r.modelChanged,
    effortChanged: r.effortChanged, ts: Date.now() }
}

// Card-level values that move into groups: subscription cards give up model
// and depth; a third-party endpoint keeps its model (connection setting) and
// gives up depth only.
function movable(p) {
  return { model: p && !p.baseUrl ? brainMod.defaultModel(p) : '', effort: p ? brainMod.defaultEffort(p) : '' }
}

/**
 * Migration step one (additive, before the service starts): every group gets,
 * on every visible card (and its current card even when hidden), the card's
 * current default for any item it has not chosen. Card values stay in place,
 * so an older version that ignores providerPrefs behaves exactly as before.
 * Idempotent. Mutates raw. @returns {{ changed, groups: string[] }}
 */
function fillGroupPicks(raw) {
  const out = { changed: false, groups: [] }
  if (!raw || typeof raw !== 'object') return out
  const provs = (raw.providers && typeof raw.providers === 'object') ? raw.providers : {}
  const defName = raw.defaultProvider || DEFAULTS.defaultProvider
  const provAll = { ...DEFAULTS.providers, ...provs }
  const withDefaults = Object.keys(provs).filter((n) => { const d = movable(provs[n]); return !!(d.model || d.effort) })
  for (const [id, g] of Object.entries(raw.groups || {})) {
    if (!g || typeof g !== 'object' || Array.isArray(g) || id === 'oc_example_chat_id') continue
    let touched = brainMod.migrateLegacyModel(g, defName)
    if (withDefaults.length) {
      const home = g.provider || defName
      const prefs = (g.providerPrefs && typeof g.providerPrefs === 'object' && !Array.isArray(g.providerPrefs)) ? g.providerPrefs : {}
      const names = new Set([home, ...Object.keys(prefs)])
      for (const n of Object.keys(provAll)) if (provAll[n] && !provAll[n].hidden) names.add(n)
      for (const n of names) {
        if (!withDefaults.includes(n)) continue
        const d = movable(provs[n])
        const cur = { ...(brainMod.cleanPref(prefs[n]) || {}) }
        if (!cur.model && d.model) { cur.model = d.model; touched = true }
        if (!cur.effort && d.effort) { cur.effort = d.effort; touched = true }
        if (Object.keys(cur).length) prefs[n] = cur
      }
      const np = brainMod.normalizePrefs(prefs)
      if (np) g.providerPrefs = np; else delete g.providerPrefs
    }
    if (touched) out.groups.push(id)
  }
  out.changed = out.groups.length > 0
  return out
}

/**
 * Migration step two (after every group connected): remove the card-level
 * values that step one copied into the groups. Effective values do not change
 * for any group whose picks were filled. Idempotent. Mutates raw.
 * @returns {{ changed, providers: string[] }}
 */
function stripCardDefaults(raw) {
  const out = { changed: false, providers: [] }
  const provs = raw && raw.providers && typeof raw.providers === 'object' ? raw.providers : {}
  for (const [n, p] of Object.entries(provs)) {
    if (!p || typeof p !== 'object') continue
    const d = movable(p)
    if (!d.model && !d.effort) continue
    if (!p.baseUrl) {
      delete p.model
      if (p.runner !== 'codex' && p.env) delete p.env.ANTHROPIC_MODEL
    }
    delete p.reasoningEffort
    if (p.env) { delete p.env.CLAUDE_CODE_EFFORT_LEVEL; if (!Object.keys(p.env).length) delete p.env }
    out.providers.push(n)
  }
  out.changed = out.providers.length > 0
  return out
}

module.exports = { applyBrainChange, auditRow, fillGroupPicks, stripCardDefaults }
