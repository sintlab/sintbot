'use strict'

// What an executor reported before its own turn started, reduced to the facts
// the core's unfinished_step ("prestart", ABI 40) reads: a short excerpt with
// secrets, home paths and line breaks taken out, and the errtag class. Shared
// by the Codex exec and Claude Code runners for their logs, errors and the
// engine hook. Never the full text.
const { redact } = require('../core/redact')
const { tagError } = require('./errtag')

const EXCERPT_CHARS = 160
const HOME_PATH = /(?:\/Users|\/home|[A-Za-z]:\\Users)[\\/][^\s\\/'"]+/g

function excerptOf(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const clean = redact(text).replace(HOME_PATH, '~').replace(/\s+/g, ' ').trim()
  return clean.length > EXCERPT_CHARS ? `${clean.slice(0, EXCERPT_CHARS)}…` : clean
}

// The errtag class in the core's prestart vocabulary, or null.
function tagOf(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const tagged = tagError({}, text)
  return tagged.quota ? (tagged.quota.kind === 'account' ? 'account' : 'quota')
    : tagged.sessionMissing ? 'sessionMissing' : tagged.transient ? 'transient' : null
}

const word = value => typeof value === 'string' && value ? value.slice(0, 40) : null

module.exports = { excerptOf, tagOf, word, EXCERPT_CHARS }
