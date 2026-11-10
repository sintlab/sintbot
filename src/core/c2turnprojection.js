'use strict'

// The three runners expose normalized events only after the child has acted.
// This process-local projection preserves the legacy terminal text semantics;
// it is not a pre-tool execution barrier or a persisted model transcript.
const RECEIPT_ID = /^[0-9a-f]{32}$/
const NO_REPLY = 'NO_REPLY'
const { isDeepStrictEqual } = require('node:util')

function createC2TurnProjection({ receiptId, turnToken, quiet, resumed = false,
  freshRetried = false, batchReceiptIds, requireResult = false } = {}) {
  if (!RECEIPT_ID.test(receiptId || '') ||
      !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
      typeof quiet !== 'boolean' || typeof resumed !== 'boolean' ||
      typeof freshRetried !== 'boolean' || typeof requireResult !== 'boolean') {
    throw new TypeError('C2 projection needs a typed running receipt')
  }
  if (batchReceiptIds !== undefined &&
      (!Array.isArray(batchReceiptIds) || batchReceiptIds.length < 2 ||
        new Set(batchReceiptIds).size !== batchReceiptIds.length ||
        !batchReceiptIds.includes(receiptId) ||
        batchReceiptIds.some(id => !RECEIPT_ID.test(id)))) {
    throw new TypeError('C2 projection needs an exact batch receipt cohort')
  }
  let bufferText = ''
  let answerText = ''
  let fullText = ''
  let sessionId = null
  let contextTokens = 0
  let observedResult = null
  let assistantEvents = 0
  let completed = false
  const toolCounts = new Map()

  const append = (prior, part) => {
    const milestone = /^>>/.test(part)
    const separator = prior && !prior.endsWith('\n') && !part.startsWith('\n') &&
      (milestone || /(^|\n)>>[^\n]*$/.test(prior)) ? '\n' : ''
    return prior + separator + part
  }

  function accept(event) {
    if (completed || observedResult) throw new Error('C2 projection event after result')
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        typeof event.type !== 'string') {
      throw new TypeError('C2 projection event invalid')
    }
    if (event.sessionId !== undefined && event.sessionId !== null) {
      if (typeof event.sessionId !== 'string' || !event.sessionId) {
        throw new TypeError('C2 projection session invalid')
      }
      sessionId = event.sessionId
    }
    if (event.type === 'assistant') {
      assistantEvents++
      if (event.contextTokens !== undefined) {
        if (!Number.isFinite(event.contextTokens) || event.contextTokens < 0) {
          throw new TypeError('C2 projection context usage invalid')
        }
        contextTokens = event.contextTokens
      }
      if (event.text !== undefined && typeof event.text !== 'string') {
        throw new TypeError('C2 projection assistant text invalid')
      }
      const tools = event.tools === undefined ? [] : event.tools
      if (!Array.isArray(tools) || tools.some(tool => !tool ||
          typeof tool.name !== 'string' || !tool.name)) {
        throw new TypeError('C2 projection tool names invalid')
      }
      if (event.text) {
        fullText = append(fullText, event.text)
        bufferText = append(bufferText, event.text)
        answerText = append(answerText, event.text)
      }
      for (const tool of tools) {
        toolCounts.set(tool.name, (toolCounts.get(tool.name) || 0) + 1)
      }
      // Claude can report text and tool use in one assistant event. Text before
      // the tool is progress, while the final answer begins after that tool.
      if (tools.length) answerText = ''
    } else if (event.type === 'result') {
      if (event.text !== undefined && typeof event.text !== 'string') {
        throw new TypeError('C2 projection result text invalid')
      }
      observedResult = { text: event.text || '', subtype: event.subtype,
        isError: !!event.isError, sessionMissing: !!event.sessionMissing,
        transientKind: event.transientKind, quota: event.quota || null,
        usage: event.usage || null,
        usageCumulative: event.usageCumulative === true }
    } else if (event.type === 'tool_result') {
      // Codex exec emits item.completed(command_execution) as a tool_result.
      // The output is evidence of tool completion, never assistant answer text.
      const results = event.results
      if (!Array.isArray(results) || results.length !== 1 ||
          !results[0] || results[0].type !== 'tool_result' ||
          typeof results[0].content !== 'string' ||
          typeof results[0].is_error !== 'boolean') {
        throw new TypeError('C2 projection tool result invalid')
      }
    } else if (event.type !== 'system' && event.type !== 'user') {
      throw new TypeError('C2 projection event type unknown')
    }
  }

  function complete({ runnerResult, outputTokens, resumedSessionCurrent = false } = {}) {
    if (completed) throw new Error('C2 projection already completed')
    if (!runnerResult || typeof runnerResult !== 'object' ||
        Array.isArray(runnerResult) || typeof runnerResult.aborted !== 'boolean' ||
        !Number.isFinite(outputTokens) || outputTokens < 0 ||
        typeof resumedSessionCurrent !== 'boolean') {
      throw new TypeError('C2 projection needs closed runner and settled output usage')
    }
    const result = runnerResult.result
    if (result != null && (!result || typeof result !== 'object' ||
        Array.isArray(result) || result.type !== 'result')) {
      throw new TypeError('C2 projection closed runner result invalid')
    }
    if (!!result !== !!observedResult ||
        (result && ((result.text || '') !== observedResult.text ||
          result.subtype !== observedResult.subtype ||
          !!result.isError !== observedResult.isError ||
          !!result.sessionMissing !== observedResult.sessionMissing ||
          result.transientKind !== observedResult.transientKind ||
          !!result.quota !== !!observedResult.quota ||
          !isDeepStrictEqual(result.usage || null, observedResult.usage) ||
          (result.usageCumulative === true) !== observedResult.usageCumulative))) {
      throw new Error('C2 projection closed runner differs from observed result')
    }
    if (runnerResult.sessionId != null &&
        (typeof runnerResult.sessionId !== 'string' || !runnerResult.sessionId)) {
      throw new TypeError('C2 projection closed session invalid')
    }
    if (runnerResult.sessionId && sessionId && runnerResult.sessionId !== sessionId) {
      throw new Error('C2 projection closed session differs from events')
    }
    if (resumedSessionCurrent && (!runnerResult.aborted || !resumed)) {
      throw new TypeError('C2 projection current resumed session requires abort')
    }
    completed = true
    const runnerExit = requireResult && !observedResult && !runnerResult.aborted
    const resultText = observedResult?.text || ''
    const payload = Object.freeze({
      type: 'finalizeEffectCommit', receiptId, turnToken, quiet,
      source: observedResult ? 'result' : runnerExit ? 'runner-exit' : 'close',
      aborted: runnerResult.aborted,
      isError: observedResult?.isError || false,
      resumed, sessionMissing: observedResult?.sessionMissing || false,
      freshRetried, resumedSessionCurrent,
      transientNetwork: observedResult?.transientKind === 'network',
      hasQuota: !!observedResult?.quota,
      toolsCount: toolCounts.size, outputTokens,
      resultText, bufferText, answerText,
      ...(batchReceiptIds ? { batchReceiptIds: Object.freeze([...batchReceiptIds]),
        replyTargetReceiptId: receiptId } : {}),
    })
    const tools = Object.freeze([...toolCounts].map(([name, count]) => Object.freeze({ name, count })))
    const display = Object.freeze({
      resultText, bufferText, answerText, fullText,
      finalAnswer: (answerText.trim() ? answerText : bufferText) || resultText,
      silent: quiet || !runnerExit && (resultText.trim() === NO_REPLY ||
        (!resultText.trim() && bufferText.trim() === NO_REPLY)),
      assistantEvents, tools,
      // A crashed process may never have flushed its new session. Retain the
      // previously stored session; never publish an unproven new session ID.
      sessionId: runnerExit ? null : runnerResult.sessionId || sessionId,
      contextTokens,
      usage: result?.usage || null,
      usageCumulative: result?.usageCumulative === true,
      result: result || null,
    })
    return Object.freeze({ payload, display })
  }

  // Read-only, process-local text for streaming; raw content is never a
  // reducer event or journal field.
  const streamSnapshot = () => Object.freeze({ bufferText, assistantEvents })
  return Object.freeze({ accept, complete, streamSnapshot })
}

module.exports = { createC2TurnProjection }
