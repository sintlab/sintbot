'use strict'
// Which model and thinking depth a group uses on one model card (backend).
// This is the single resolver: runner input, card footer, /help · /model ·
// /status, the agent manifest, the console and the activity rows all call it.
//
// Storage: groups[chatId].providerPrefs = { "<card name>": { model?, effort? } },
// kept per backend. A group that moves between backends keeps each backend's
// own choice: a model id from one backend is never passed to another, and
// switching back does not silently fall back to something else.
// A missing entry means "not chosen": the executor picks its own default.
// Legacy groups[chatId].model belongs only to the backend the group was on
// when it was written (group.provider, else defaultProvider).
//
// Only shapes are validated, never an allow list: model ids and depth names
// evolve upstream, and values travel as argv/env entries without a shell.
// A bad shape is treated as unset instead of failing the turn.

const MODEL_RE = /^[\w.\-[\]:/]{1,80}$/
const EFFORT_RE = /^[a-z]{2,16}$/

const isModel = (s) => typeof s === 'string' && MODEL_RE.test(s)
const isEffort = (s) => typeof s === 'string' && EFFORT_RE.test(s)

// Legacy card-level values. Subscription cards no longer carry them after the
// one-time migration; a third-party endpoint keeps its model as connection
// configuration (it has no model list to choose from).
function defaultModel(provider) {
  const p = provider || {}
  return p.model || (p.runner !== 'codex' && p.env && p.env.ANTHROPIC_MODEL) || ''
}

function defaultEffort(provider) {
  const p = provider || {}
  return (p.runner === 'codex' ? p.reasoningEffort : p.env && p.env.CLAUDE_CODE_EFFORT_LEVEL) || ''
}

// One entry → valid fields only; nothing valid ⇒ null.
function cleanPref(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const o = {}
  if (isModel(x.model)) o.model = x.model
  if (isEffort(x.effort)) o.effort = x.effort
  return Object.keys(o).length ? o : null
}

// Whole table: drop bad shapes, empty entries and (when known is given)
// entries for cards that do not exist. An empty table becomes undefined.
function normalizePrefs(prefs, known) {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return undefined
  const out = {}
  for (const [name, v] of Object.entries(prefs)) {
    if (!/^[\w.-]+$/.test(name)) continue
    if (known && !Object.prototype.hasOwnProperty.call(known, name)) continue
    const c = cleanPref(v)
    if (c) out[name] = c
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * @param group     groups[chatId] (may be empty)
 * @param name      the card actually running this turn
 * @param provider  cfg.providers[name]
 * @param opts.defaultProvider top-level defaultProvider, only used to decide
 *   which backend a legacy group.model belongs to
 * @returns {{ model, effort, groupModel, groupEffort, defaultModel, defaultEffort }}
 *   model / effort are effective values ('' = executor default);
 *   groupX are the group's own choices ('' = not chosen).
 */
function groupBrain(group, name, provider, { defaultProvider = '' } = {}) {
  const g = group || {}
  const pref = cleanPref(g.providerPrefs && typeof g.providerPrefs === 'object' ? g.providerPrefs[name] : null) || {}
  const home = g.provider || defaultProvider || ''
  const legacy = (!pref.model && isModel(g.model) && (!home || home === name)) ? g.model : ''
  const groupModel = pref.model || legacy
  const groupEffort = pref.effort || ''
  const dm = defaultModel(provider)
  const de = defaultEffort(provider)
  return { model: groupModel || dm, effort: groupEffort || de, groupModel, groupEffort, defaultModel: dm, defaultEffort: de }
}

// Move legacy group.model under the backend it belonged to (mutates the raw
// group). Every writer that changes group.provider calls this first, so the
// legacy id never attaches itself to the new backend. Returns whether it changed.
function migrateLegacyModel(g, defaultProvider) {
  if (!g || typeof g !== 'object' || g.model === undefined) return false
  const home = g.provider || defaultProvider || ''
  if (home && isModel(g.model)) {
    const prefs = (g.providerPrefs && typeof g.providerPrefs === 'object' && !Array.isArray(g.providerPrefs)) ? g.providerPrefs : {}
    const cur = cleanPref(prefs[home]) || {}
    if (!cur.model) prefs[home] = { ...cur, model: g.model }
    g.providerPrefs = prefs
  }
  delete g.model
  return true
}

// Active groups whose current backend lacks a choice (doctor and console use
// the same rule). A subscription card without a model and any card without a
// depth are listed. Paused groups are skipped.
// Returns [{ chatId, name, provider, lack: ['model' | 'effort'] }].
function missingPicks(cfg) {
  const out = []
  const provs = (cfg && cfg.providers) || {}
  for (const [id, g] of Object.entries((cfg && cfg.groups) || {})) {
    if (!g || typeof g !== 'object' || id === 'oc_example_chat_id' || g.paused === true) continue
    const pn = g.provider || cfg.defaultProvider
    const pv = provs[pn]
    if (!pv) continue
    const b = groupBrain(g, pn, pv, { defaultProvider: cfg.defaultProvider })
    const lack = [!b.model && !pv.baseUrl ? 'model' : '', !b.effort ? 'effort' : ''].filter(Boolean)
    if (lack.length) out.push({ chatId: id, name: g.name || '', provider: pn, lack })
  }
  return out
}

module.exports = { groupBrain, normalizePrefs, cleanPref, migrateLegacyModel, missingPicks, defaultModel, defaultEffort, isModel, isEffort, MODEL_RE, EFFORT_RE }
