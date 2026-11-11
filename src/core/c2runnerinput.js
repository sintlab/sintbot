'use strict'
const { followupEnabled } = require('../agent/privatecore')

// Assemble the same user-facing runner inputs as Engine._runTurn after the
// host has prepared its timestamped prompt and manifest. This only assembles
// process-local arguments. It neither starts a child nor persists text,
// credentials, callback handles, or environment values.
function prepareC2RunnerInput({ prompt, appendSystemPrompt, msg, group, provider,
  config, brain = null, sessionId = null, signal, extraEnv, onTurnAccepted, onSpawnFailed, onDurableEvent,
  onEvent = () => {}, onSteerReady, onSteerLanded, log = () => {} } = {}) {
  if (typeof prompt !== 'string' || !prompt ||
      typeof appendSystemPrompt !== 'string' || !appendSystemPrompt ||
      !msg || typeof msg.chatId !== 'string' || !msg.chatId ||
      !group || typeof group.workdir !== 'string' || !group.workdir ||
      !provider || !['claude', 'codex'].includes(provider.runner) ||
      !config || !config.agent || typeof config.agent !== 'object' ||
      (brain !== null && (typeof brain !== 'object' || typeof brain.model !== 'string' ||
        typeof brain.effort !== 'string')) ||
      (sessionId !== null && (typeof sessionId !== 'string' || !sessionId)) ||
      !signal || typeof signal.aborted !== 'boolean' ||
      !extraEnv || typeof extraEnv !== 'object' || Array.isArray(extraEnv) ||
      extraEnv.SBOT_CHAT_ID !== msg.chatId ||
      Object.values(extraEnv).some(value => typeof value !== 'string') ||
      typeof onTurnAccepted !== 'function' ||
      (onSpawnFailed !== undefined && typeof onSpawnFailed !== 'function') ||
      typeof onDurableEvent !== 'function' ||
      typeof onEvent !== 'function' || typeof log !== 'function') {
    throw new TypeError('C2 runner input requires an exact process-local turn')
  }
  const isCodex = provider.runner === 'codex'
  const enabled = followupEnabled(group, provider.runner)
  const codexSteer = isCodex && enabled
  if ((onSteerReady !== undefined && typeof onSteerReady !== 'function') ||
      (onSteerLanded !== undefined && typeof onSteerLanded !== 'function') ||
      (enabled && (typeof onSteerReady !== 'function' ||
        typeof onSteerLanded !== 'function'))) {
    throw new TypeError('C2 follow-up needs durable control callbacks')
  }
  // Model settings are resolved once at the configuration boundary.
  // Missing or zero leaves compaction to the executor.
  const rawCompact = Number(provider.autocompactTokens) || 0
  const autocompactTokens = rawCompact > 0
    ? Math.min(1_000_000, Math.max(100_000, Math.floor(rawCompact))) : 0
  return {
    bin: config.agent.bin,
    prompt, appendSystemPrompt, provider,
    codexApp: isCodex && group.codexApp === true,
    codexSteer,
    steer: !isCodex && enabled,
    codexProjectDocFallback: isCodex && group.codexProjectDocFallback === true,
    onSteerReady, onSteerLanded,
    // The group's model and depth on this backend (core/brain.js); empty
    // leaves the choice to the executor.
    model: brain ? brain.model || undefined : group.model,
    effort: brain ? brain.effort : '',
    workdir: group.workdir,
    sessionId,
    permissionMode: group.permissionMode || 'dontAsk',
    autocompactTokens,
    allowedTools: group.allowedTools,
    disallowedTools: group.disallowedTools,
    plugins: group.plugins,
    signal,
    extraEnv: { ...extraEnv },
    log,
    onEvent,
    onDurableEvent,
    onTurnAccepted,
    onSpawnFailed,
  }
}

module.exports = { prepareC2RunnerInput }
