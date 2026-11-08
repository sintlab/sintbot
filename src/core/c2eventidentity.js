'use strict'

const { createHash } = require('node:crypto')
const { validatePersistentReceipts } = require('./c2persistrelation')

// Identity construction for the prospective durable C2 path. The caller must
// read receipts and callback registrations from the single durable authority;
// this module cannot turn an in-memory or synthetic source into one.
const RECEIPT_ID = /^[0-9a-f]{32}$/
const DOMAINS = new Set(['queue', 'lifecycle', 'recovery', 'failover', 'steer',
  'slots', 'turn', 'terminal', 'handoff', 'atomicHandoff', 'intake', 'session',
  'outbound'])
const KIND = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const GENERATION = /^[0-9a-f]{32}$/
const MAX_ORDINAL = 65_535

function checkId(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`invalid C2 ${label}`)
  return value
}

function checkDomainKind(domain, kind, ordinal) {
  if (!DOMAINS.has(domain)) throw new TypeError('invalid C2 event domain')
  checkId(kind, KIND, 'event kind')
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > MAX_ORDINAL) {
    throw new TypeError('invalid C2 event ordinal')
  }
}

function fingerprint(label, parts) {
  const hash = createHash('sha256').update(`sintbot-c2-${label}-v1\0`)
  for (const part of parts) {
    const bytes = Buffer.from(String(part), 'utf8')
    hash.update(String(bytes.length)).update(':').update(bytes)
  }
  return hash.digest('hex')
}

function durableReceipt(receiptId, lookupReceipt) {
  checkId(receiptId, RECEIPT_ID, 'receipt ID')
  if (typeof lookupReceipt !== 'function') throw new TypeError('durable C2 receipt lookup required')
  const receipt = lookupReceipt(receiptId)
  validatePersistentReceipts({ pending: [receipt], completed: [] })
  if (receipt.id !== receiptId || /^local:/i.test(receipt.sourceId) ||
      Buffer.byteLength(receipt.sourceId) > 256 || Buffer.byteLength(receipt.chatId) > 256) {
    throw new Error('C2 event lacks a durable source receipt')
  }
  return receipt
}

function platformMessageEventId({ receiptId, domain, kind, ordinal = 0, lookupReceipt } = {}) {
  checkDomainKind(domain, kind, ordinal)
  const receipt = durableReceipt(receiptId, lookupReceipt)
  if (receipt.source !== 'message') throw new Error('C2 platform event needs a message receipt')
  return `sbot-c2-event-v1:${fingerprint('platform-event',
    [receipt.source, receipt.chatId, receipt.sourceId, domain, kind, ordinal])}`
}

function callbackRegistrationId({ receiptId, generation, domain, kind, ordinal = 0 } = {}) {
  checkId(receiptId, RECEIPT_ID, 'receipt ID')
  checkId(generation, GENERATION, 'turn generation')
  checkDomainKind(domain, kind, ordinal)
  return `sbot-c2-registration-v1:${fingerprint('callback-registration',
    [receiptId, generation, domain, kind, ordinal])}`
}

function callbackEventId({ receiptId, generation, domain, kind, ordinal = 0,
  lookupReceipt, lookupRegistration } = {}) {
  const receipt = durableReceipt(receiptId, lookupReceipt)
  const registrationId = callbackRegistrationId({ receiptId, generation, domain, kind, ordinal })
  if (typeof lookupRegistration !== 'function') throw new TypeError('durable C2 registration lookup required')
  const registration = lookupRegistration(registrationId)
  const expectedKeys = new Set(['id', 'receiptId', 'generation', 'domain', 'kind', 'ordinal', 'registeredAt'])
  if (!registration || typeof registration !== 'object' || Array.isArray(registration) ||
      Object.getPrototypeOf(registration) !== Object.prototype ||
      Reflect.ownKeys(registration).length !== expectedKeys.size ||
      Reflect.ownKeys(registration).some(key => typeof key !== 'string' || !expectedKeys.has(key) ||
        !Object.getOwnPropertyDescriptor(registration, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(registration, key), 'value')) ||
      registration.id !== registrationId || registration.receiptId !== receiptId ||
      registration.generation !== generation || registration.domain !== domain ||
      registration.kind !== kind || registration.ordinal !== ordinal ||
      !Number.isSafeInteger(registration.registeredAt) || registration.registeredAt <= 0) {
    throw new Error('C2 callback identity was not durably registered')
  }
  return `sbot-c2-event-v1:${fingerprint('callback-event',
    [receipt.id, generation, domain, kind, ordinal])}`
}

module.exports = { platformMessageEventId, callbackRegistrationId, callbackEventId }
