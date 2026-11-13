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
    // Speed: 'fast' only when the group turned Fast on for this turn (the
    // engine clears it for scheduled turns); absent otherwise, so the input
    // shape is unchanged for every group that never used Fast. Idle
    // compaction below never asks for Fast.
    ...(brain && brain.speed === 'fast' ? { speed: 'fast' } : {}),
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

// Idle compaction (ABI 37): the same process-local arguments as a turn on this
// group, minus the prompt, durable hooks and follow-up channel. Tool set, MCP,
// system appendix, model, depth and env must match the turn exactly or the
// session's prompt cache is rewritten.
function prepareC2CompactionInput({ appendSystemPrompt, chatId, group, provider, config, brain = null,
  sessionId, signal, extraEnv, keep, onEvent = () => {}, log = () => {} } = {}) {
  if (typeof appendSystemPrompt !== 'string' || !appendSystemPrompt ||
      typeof chatId !== 'string' || !chatId ||
      !group || typeof group.workdir !== 'string' || !group.workdir ||
      !provider || provider.runner !== 'claude' ||
      !config || !config.agent || typeof config.agent !== 'object' ||
      (brain !== null && (typeof brain !== 'object' || typeof brain.model !== 'string' ||
        typeof brain.effort !== 'string')) ||
      typeof sessionId !== 'string' || !sessionId ||
      !signal || typeof signal.aborted !== 'boolean' ||
      !extraEnv || typeof extraEnv !== 'object' || Array.isArray(extraEnv) ||
      extraEnv.SBOT_CHAT_ID !== chatId ||
      Object.values(extraEnv).some(value => typeof value !== 'string') ||
      typeof keep !== 'string' || !keep ||
      typeof onEvent !== 'function' || typeof log !== 'function') {
    throw new TypeError('C2 compaction input requires an exact process-local session')
  }
  const rawCompact = Number(provider.autocompactTokens) || 0
  const autocompactTokens = rawCompact > 0
    ? Math.min(1_000_000, Math.max(100_000, Math.floor(rawCompact))) : 0
  return {
    bin: config.agent.bin,
    appendSystemPrompt, provider,
    steer: false,
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
    keep,
    log,
    onEvent,
  }
}

module.exports = { prepareC2RunnerInput, prepareC2CompactionInput }
