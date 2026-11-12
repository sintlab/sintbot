'use strict'

// Environment conflicts (2026-11-12, cc-switch takeaways B5): things outside
// SintBot's configuration that can silently reroute the Claude / Codex CLI —
// daemon env (`ANTHROPIC_*`, `CLAUDE_CODE_*`, `AWS_*`, `VERTEX_*`, `OPENAI_*`),
// `~/.claude/settings.json` (`env`, top-level `model` …) and `~/.codex/config.toml`
// (`model_provider`, `[model_providers.*]`). The host only gathers the inputs; the
// rule set lives in the binary core (`env_conflicts`, ABI 36) and it returns key
// names only — values never leave the process. Warn-only: `buildEnv` keeps clearing
// exactly what it cleared before.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { envConflicts } = require('./privatecore')

// JSON file → parsed object; missing / invalid / not an object ⇒ null.
function readClaudeSettings(home, readFile) {
  try {
    const j = JSON.parse(String(readFile(path.join(home, '.claude', 'settings.json'), 'utf8')))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null
  } catch { return null }
}

// TOML text as-is (the core matches lines; no TOML parser); missing ⇒ null.
function readCodexConfig(home, readFile) {
  try { return String(readFile(path.join(home, '.codex', 'config.toml'), 'utf8')) } catch { return null }
}

// Only string-valued entries travel to the core (process.env can hold undefined).
const snapshotEnv = (env) => Object.fromEntries(Object.entries(env || {}).filter(([, v]) => typeof v === 'string'))

// → [{ where: 'env'|'claude-settings'|'codex-config', key, reason }]. `provider` is a
// resolved provider ({ baseUrl, apiKey }) or an explicit { baseUrl, hasApiKey }.
function collectEnvConflicts({ runner = 'claude', provider = {}, env = process.env, home = os.homedir(), readFile = fs.readFileSync } = {}) {
  const p = provider || {}
  const input = {
    runner: runner === 'codex' ? 'codex' : 'claude',
    provider: { baseUrl: p.baseUrl || null, hasApiKey: typeof p.hasApiKey === 'boolean' ? p.hasApiKey : !!p.apiKey },
    env: snapshotEnv(env),
    claudeSettings: readClaudeSettings(home, readFile),
    codexConfig: readCodexConfig(home, readFile),
  }
  return envConflicts(input).warnings.map((w) => ({ where: w.where, key: w.key, reason: w.reason }))
}

// Preflight / log line: `<key> — <reason>`; never a value.
const describeWarning = (w) => `${w.key} — ${w.reason}`

// `sintbot start --preflight`: one line per key for each provider an active route
// uses. The snapshot is this process's environment — a launchd job inherits a
// different one, so the block is prefixed with that caveat. Never fatal.
const PREFLIGHT_SCOPE_LINE = 'preflight · 环境冲突检查基于当前终端环境(launchd 任务的环境可能不同)\n'
function reportEnvConflicts({ cfg, routes } = {}, write = (message) => process.stderr.write(message), { collect = collectEnvConflicts } = {}) {
  const seen = new Set()
  let prefixed = false
  for (const route of routes || []) {
    if (!route || route.paused) continue
    const name = route.group?.provider || cfg?.defaultProvider || ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    if (!prefixed) { prefixed = true; write(PREFLIGHT_SCOPE_LINE) }
    try {
      for (const warning of collect({ runner: route.provider?.runner, provider: route.provider })) {
        write(`preflight · ${name}: ${describeWarning(warning)}\n`)
      }
    } catch (error) {
      write(`preflight · ${name}: environment check skipped (${error?.message || String(error)})\n`)
    }
  }
  return [...seen]
}

module.exports = { collectEnvConflicts, describeWarning, reportEnvConflicts, PREFLIGHT_SCOPE_LINE }
