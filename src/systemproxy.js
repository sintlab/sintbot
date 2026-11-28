'use strict'
// What this Mac's system settings say about languages and proxies, as read:
// the preferred languages (AppleLanguages) and the system proxy settings
// (scutil --proxy). Reading only. Whether any of it is used, offered or
// mentioned is decided by the built-in core from these facts.
//
// Both commands are fixed system paths with fixed arguments and a short time
// limit; a command that fails, times out or prints something unreadable reads
// as "nothing known" (no languages, no settings), never as an error.
const { spawnSync } = require('node:child_process')

const SCUTIL = '/usr/sbin/scutil'
const DEFAULTS = '/usr/bin/defaults'
const TIMEOUT_MS = 2000
const CACHE_MS = 15_000

function run(command, args, spawn = spawnSync) {
  try {
    const out = spawn(command, args, { encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
    return out && out.status === 0 && typeof out.stdout === 'string' ? out.stdout : ''
  } catch { return '' }
}

// `defaults read -g AppleLanguages` prints a parenthesised list, one language
// per line, quoted when it holds a hyphen.
function parseLanguages(text) {
  const list = []
  for (const raw of String(text || '').split('\n')) {
    const item = raw.trim().replace(/,$/, '').replace(/^"(.*)"$/, '$1').trim()
    if (!item || item === '(' || item === ')') continue
    if (/^[A-Za-z0-9_-]{1,40}$/.test(item)) list.push(item)
  }
  return list
}

// `scutil --proxy` prints one `Key : value` per line; nested lists (the
// exceptions) are skipped. Returns null when nothing could be read.
function parseSystemProxy(text) {
  const top = {}
  let depth = 0
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (line.endsWith('{')) { depth += 1; if (depth > 1) continue }
    if (line === '}') { depth -= 1; continue }
    if (depth !== 1) continue
    const match = /^([A-Za-z]+) : (.*)$/.exec(line)
    if (match && !match[2].endsWith('{')) top[match[1]] = match[2].trim()
  }
  if (!Object.keys(top).length && !/<dictionary>/.test(String(text || ''))) return null
  const on = key => top[key] === '1'
  const entry = prefix => ({ enabled: on(`${prefix}Enable`), host: top[`${prefix}Proxy`] || '',
    port: /^\d{1,5}$/.test(top[`${prefix}Port`] || '') ? Number(top[`${prefix}Port`]) : 0 })
  return { https: entry('HTTPS'), http: entry('HTTP'),
    pac: on('ProxyAutoConfigEnable') || on('ProxyAutoDiscoveryEnable'),
    socks: on('SOCKSEnable'),
    // A proxy that asks for a user name: its password is in the keychain.
    auth: !!(top.HTTPSUser || top.HTTPUser) }
}

let cached = null

// { languages: [...], system: {...} | null }. Off macOS there is nothing to read.
function readSystemFacts({ spawn = spawnSync, platform = process.platform, now = Date.now, fresh = false, maxAgeMs = CACHE_MS } = {}) {
  if (platform !== 'darwin') return { languages: [], system: null }
  const custom = spawn !== spawnSync
  if (!custom && !fresh && cached && now() - cached.at < maxAgeMs) return cached.facts
  const facts = { languages: parseLanguages(run(DEFAULTS, ['read', '-g', 'AppleLanguages'], spawn)),
    system: parseSystemProxy(run(SCUTIL, ['--proxy'], spawn)) }
  if (!custom) cached = { at: now(), facts }
  return facts
}

module.exports = { readSystemFacts, parseLanguages, parseSystemProxy }
