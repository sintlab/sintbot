// Runner dispatch — selects the AgentRunner by provider so the rest of SintBot calls one
// `runTurn`. Codex uses App Server by default and `codex exec` when the group
// explicitly disables busy follow-up; all other providers use Claude Code. The caller's `bin` is
// the Claude bin (cfg.agent.bin) — override it when routing to Codex.

const claudeAgent = require('./claudecode')
const codexAgent = require('./codexcode')
const codexApp = require('./codexapp')
const { routeBackend } = require('./privatecore')

function runTurn(opts) {
  // One-off console trials use the same model settings as group turns.
  // Explicit turn values (including zero) remain authoritative.
  const compact = Number(opts.autocompactTokens ?? opts.provider?.autocompactTokens) || 0
  opts = { ...opts, autocompactTokens: compact > 0
    ? Math.min(1_000_000, Math.max(100_000, Math.floor(compact))) : 0 }
  const route = routeBackend(opts && opts.provider && opts.provider.runner, opts && opts.codexApp, opts && opts.codexSteer, opts && opts.codexProjectDocFallback)
  if (route !== 'claude') {
    const codexOpts = { ...opts, bin: (opts.provider && opts.provider.bin) || 'codex' }
    return route === 'codex-app' ? codexApp.runTurn(codexOpts) : codexAgent.runTurn(codexOpts)
  }
  return claudeAgent.runTurn(opts)
}

// 空闲整理只有 Claude 路线有(无头 /compact);GPT ⇒ null = 不支持,引擎只在轮内压缩。
function compactSession(opts) {
  const route = routeBackend(opts && opts.provider && opts.provider.runner, opts && opts.codexApp, opts && opts.codexSteer, opts && opts.codexProjectDocFallback)
  if (route !== 'claude') return null
  const compact = Number(opts.autocompactTokens ?? opts.provider?.autocompactTokens) || 0
  return claudeAgent.compactSession({ ...opts, autocompactTokens: compact > 0 ? Math.min(1_000_000, Math.max(100_000, Math.floor(compact))) : 0 })
}

// Whether a model card's turns run on the machine's own sign-in (Codex or
// Claude Code) rather than a key, judged the way each runner builds its child.
// Both Codex runners read no credential from the card and drop OPENAI_API_KEY,
// so a Codex card always runs on the Codex sign-in. A Claude Code child runs
// on a key when its environment ends up with an endpoint or a token: the
// card's own, or the service's ANTHROPIC_API_KEY that it lets through.
function runsOnSignIn(provider) {
  if (!provider || typeof provider !== 'object') return false
  if (provider.runner === 'codex') return true
  const env = claudeAgent.buildEnv(provider)
  const set = value => typeof value === 'string' && !!value.trim()
  return !set(env.ANTHROPIC_BASE_URL) && !set(env.ANTHROPIC_AUTH_TOKEN) && !set(env.ANTHROPIC_API_KEY)
}

// Whether a Claude Code card that runs on a key runs on the service's own
// ANTHROPIC_API_KEY: the card gives no endpoint, token or key of its own, so
// its child keeps the one in the service's environment. A notice about a
// refused or used-up key then names that key, not the card's.
function runsOnServiceKey(provider) {
  if (!provider || typeof provider !== 'object' || provider.runner === 'codex') return false
  const env = claudeAgent.buildEnv(provider)
  const set = value => typeof value === 'string' && !!value.trim()
  return !set(env.ANTHROPIC_BASE_URL) && !set(env.ANTHROPIC_AUTH_TOKEN) && set(env.ANTHROPIC_API_KEY) &&
    !set(provider.env?.ANTHROPIC_API_KEY)
}

const isClosedRunnerResult = value => [claudeAgent, codexAgent, codexApp].some(agent => agent.isClosedRunnerResult(value))
const isClosedRunnerError = value => [claudeAgent, codexAgent, codexApp].some(agent => agent.isClosedRunnerError(value))
module.exports = { runTurn, compactSession, probeVersion: claudeAgent.probeVersion, isClosedRunnerResult, isClosedRunnerError, runsOnSignIn, runsOnServiceKey }
