'use strict'

const { createHash } = require('node:crypto')
const { taskId } = require('./enginecheckpoint')
const { validatePersistentReceipts } = require('./c2persistrelation')

// Durable identity for the synthetic intake sources (operator console, board
// confirmation). A platform message carries its own stable ID; these sources
// do not, and `newSourceId()` deliberately mints a process-local `local:` ID
// that the durable C2 path refuses. This module derives an ID **only** from
// anchors that survive a restart:
//
//   - the platform message the console line was actually posted as, or an
//     operator-supplied idempotency key for a silent injection;
//   - the board broadcast message plus the annotation digest of that round.
//
// Nothing here invents an identity from wall-clock time: a crash before the
// first durable receipt would then replay as a *different* job, which is the
// exact duplicate this contract exists to prevent. When no durable anchor
// exists the builder throws, and the caller must leave the receipt fields
// unset so the durable path keeps refusing the source instead of silently
// accepting an unreplayable one.
//
// No instruction text enters the ID: only bounded anchor IDs and a digest of
// the already-broadcast annotation list.

const HEX32 = /^[0-9a-f]{32}$/
const CHAT_ID = /^[A-Za-z0-9_:.-]{1,128}$/
const ANCHOR_ID = /^[A-Za-z0-9_:.-]{1,160}$/
const BOARD_KINDS = new Set(['apply', 'sync'])
const MAX_DIGEST_LINES = 512
const MAX_DIGEST_BYTES = 64 * 1024

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new TypeError(`${label} must be a plain data object`)
  }
  return value
}

function text(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`C2 synthetic ${label} invalid`)
  }
  return value
}

function fingerprint(parts) {
  const hash = createHash('sha256').update('sintbot-c2-synthetic-source-v1\0')
  for (const part of parts) {
    const bytes = Buffer.from(String(part), 'utf8')
    hash.update(String(bytes.length)).update(':').update(bytes).update('\0')
  }
  return hash.digest('hex').slice(0, 32)
}

function digestFingerprint(lines) {
  if (!Array.isArray(lines) || lines.length > MAX_DIGEST_LINES ||
      Reflect.ownKeys(lines).length !== lines.length + 1 ||
      lines.some(line => typeof line !== 'string')) {
    throw new TypeError('C2 synthetic board digest invalid')
  }
  const joined = lines.join('\n')
  if (Buffer.byteLength(joined) > MAX_DIGEST_BYTES) {
    throw new TypeError('C2 synthetic board digest too large')
  }
  return fingerprint(['digest', String(lines.length), joined])
}

// `console` with a visible line: the posted platform message is the anchor,
// so a replayed injection resolves to the same receipt as the first one.
// `console` silent injection: only an operator idempotency key can stand in;
// the console client mints it per submit, so its own retry deduplicates.
function consoleSourceId(descriptor) {
  const chatId = text(descriptor.chatId, CHAT_ID, 'chat ID')
  const shown = descriptor.shownMessageId
  const request = descriptor.requestId
  if (shown !== undefined && shown !== null) {
    if (request !== undefined && request !== null) {
      throw new TypeError('C2 synthetic console source takes one anchor')
    }
    text(shown, ANCHOR_ID, 'console anchor')
    return `console:shown:${fingerprint(['console-shown', chatId, shown])}`
  }
  text(request, HEX32, 'console request key')
  return `console:request:${fingerprint(['console-request', chatId, request])}`
}

// `board`: the confirmation consumes one broadcast notice, and the round's
// work is exactly the digest that notice published. Both are durable, so a
// replay of the same confirmation maps onto the same receipt.
function boardSourceId(descriptor) {
  const chatId = text(descriptor.chatId, CHAT_ID, 'chat ID')
  const notice = text(descriptor.noticeMessageId, ANCHOR_ID, 'board anchor')
  if (!BOARD_KINDS.has(descriptor.boardKind)) {
    throw new TypeError('C2 synthetic board kind invalid')
  }
  const digest = digestFingerprint(descriptor.digestLines ?? [])
  return `board:${descriptor.boardKind}:${fingerprint(['board', chatId, notice,
    descriptor.boardKind, digest])}`
}

const BUILDERS = { console: consoleSourceId, board: boardSourceId }

// Returns `{ source, sourceId }` for a synthetic intake, or throws when the
// descriptor has no durable anchor. Callers must not substitute a fallback
// ID of their own: a non-durable source has to stay visibly non-durable.
function syntheticSource(descriptor) {
  plain(descriptor, 'C2 synthetic source descriptor')
  const build = Object.hasOwn(BUILDERS, descriptor.kind) ? BUILDERS[descriptor.kind] : null
  if (!build) throw new TypeError('C2 synthetic source kind unknown')
  const sourceId = build(descriptor)
  if (/^local:/i.test(sourceId) || Buffer.byteLength(sourceId) > 256) {
    throw new Error('C2 synthetic source ID is not durable')
  }
  return Object.freeze({ source: descriptor.kind, sourceId })
}

// The full pending-receipt shape for a synthetic intake. Validated with the
// same rules the durable journal applies, so an invalid identity fails here
// rather than at commit time.
function syntheticReceipt(descriptor, { acceptedAt, quiet } = {}) {
  const { source, sourceId } = syntheticSource(descriptor)
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt <= 0) {
    throw new TypeError('C2 synthetic receipt acceptedAt invalid')
  }
  if (typeof quiet !== 'boolean') throw new TypeError('C2 synthetic receipt quiet flag invalid')
  const chatId = descriptor.chatId
  const receipt = { id: taskId({ source, chatId, sourceId }), chatId, source, sourceId,
    acceptedAt, quiet }
  validatePersistentReceipts({ pending: [receipt], completed: [] })
  return Object.freeze(receipt)
}

// Direct cron effects have no model turn and therefore no turn receipt. This
// is the explicit disposition boundary for them, not a claim of idempotency.
//
//   do  → compensated: a durably qualified occurrence may be redispatched
//         after a restart (see crononce.eligibleForRecovery).
//   say → one outward text. cronfire re-sends only when the platform has
//         *confirmed* non-delivery, at most four times, from in-process
//         timers. An ambiguous outcome is never retried, and a restart drops
//         the pending ladder: whatever was in flight is an operator call.
//   run → a shell command whose side effects live outside sbot. Never
//         rerun automatically, not even after a crash mid-run.
const DIRECT_EFFECT_POLICY = Object.freeze({
  do: Object.freeze({ automatic: true, trigger: 'durable-eligibility',
    maxAttempts: 1, restartDisposition: 'compensate' }),
  say: Object.freeze({ automatic: true, trigger: 'confirmed-not-delivered',
    maxAttempts: 4, restartDisposition: 'manual' }),
  run: Object.freeze({ automatic: false, trigger: 'none',
    maxAttempts: 1, restartDisposition: 'manual' }),
})

function directEffectPolicy(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(DIRECT_EFFECT_POLICY, kind)) {
    throw new TypeError('C2 direct effect kind unknown')
  }
  return DIRECT_EFFECT_POLICY[kind]
}

module.exports = { syntheticSource, syntheticReceipt, directEffectPolicy,
  DIRECT_EFFECT_POLICY }
