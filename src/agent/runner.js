// Runner dispatch — selects the AgentRunner by provider so the rest of SintBot calls one
// `runTurn`. Codex uses App Server by default and `codex exec` when the group
// explicitly disables busy follow-up; all other providers use Claude Code. The caller's `bin` is
// the Claude bin (cfg.agent.bin) — override it when routing to Codex.

const claudeAgent = require('./claudecode')
const codexAgent = require('./codexcode')
const codexApp = require('./codexapp')
const { routeBackend } = require('./privatecore')

function runTurn(opts) {
  const route = routeBackend(opts && opts.provider && opts.provider.runner, opts && opts.codexApp, opts && opts.codexSteer, opts && opts.codexProjectDocFallback)
  if (route !== 'claude') {
    const codexOpts = { ...opts, bin: (opts.provider && opts.provider.bin) || 'codex' }
    return route === 'codex-app' ? codexApp.runTurn(codexOpts) : codexAgent.runTurn(codexOpts)
  }
  return claudeAgent.runTurn(opts)
}

const isClosedRunnerResult = value => [claudeAgent, codexAgent, codexApp].some(agent => agent.isClosedRunnerResult(value))
const isClosedRunnerError = value => [claudeAgent, codexAgent, codexApp].some(agent => agent.isClosedRunnerError(value))
module.exports = { runTurn, probeVersion: claudeAgent.probeVersion, isClosedRunnerResult, isClosedRunnerError }
