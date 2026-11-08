'use strict'

// Admission boundary for a reviewed legacy cut. This never settles an old
// receipt or replays an effect; it only verifies immutable migration evidence
// and excludes pre-cut platform messages before durable receipt admission.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const SHA = /^[a-f0-9]{64}$/
const CHAT = /^oc_[A-Za-z0-9_-]{1,124}$/
const SOURCE = /^om_[A-Za-z0-9_-]{1,124}$/
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = () => { throw new Error('C2 migration evidence or admission fence differs; preserve all authorities') }
function readPrivate(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
      process.platform !== 'win32' && (stat.mode & 0o077)) fail()
  return fs.readFileSync(file)
}
function loadC2MigrationFence({ stateDir, routes } = {}) {
  if (!path.isAbsolute(stateDir || '') || !Array.isArray(routes) || !routes.length) fail()
  const mappingFile = path.join(stateDir, 'c2-groups.json')
  const fenceFile = path.join(stateDir, 'c2-migration.json')
  let mapping
  if (fs.existsSync(mappingFile)) mapping = JSON.parse(readPrivate(mappingFile))
  const expectedHash = mapping?.migrationSha256
  if (expectedHash === undefined && !fs.existsSync(fenceFile) &&
      !fs.existsSync(path.join(stateDir, 'legacy-evidence'))) return null
  if (!SHA.test(expectedHash || '')) fail()
  const bytes = readPrivate(fenceFile)
  if (sha(bytes) !== expectedHash) fail()
  const fence = JSON.parse(bytes)
  const expectedGroups = routes.map(route => ({ chatId: route.chatId, journal: path.basename(route.file) }))
    .sort((a, b) => a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0)
  // Groups bound after the cut extend the mapping; every migrated group must
  // keep its exact journal, and an added group must have no legacy state.
  const fenced = Array.isArray(fence.groups) ? fence.groups : []
  const expectedById = new Map(expectedGroups.map(group => [group.chatId, group]))
  if (mapping.version !== 1 || fence.schema !== 'sbot-c2-legacy-migration-v1' ||
      !fenced.length || new Set(fenced.map(group => group?.chatId)).size !== fenced.length ||
      fenced.some(group => !isDeepStrictEqual(expectedById.get(group?.chatId), group)) ||
      !isDeepStrictEqual(mapping.groups, expectedGroups) ||
      !Number.isSafeInteger(fence.createdAt) || fence.createdAt <= 0 ||
      !Array.isArray(fence.evidence) || !fence.evidence.length ||
      !Array.isArray(fence.fences) || fence.fences.length !== fenced.length) fail()
  const evidenceDir = path.join(stateDir, 'legacy-evidence')
  const dirStat = fs.lstatSync(evidenceDir)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() ||
      typeof process.getuid === 'function' && dirStat.uid !== process.getuid() ||
      process.platform !== 'win32' && (dirStat.mode & 0o077)) fail()
  const names = new Set()
  for (const item of fence.evidence) {
    if (!item || typeof item.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/.test(item.file) ||
        !SHA.test(item.sha256 || '') || names.has(item.file)) fail()
    names.add(item.file)
    if (sha(readPrivate(path.join(evidenceDir, item.file))) !== item.sha256) fail()
  }
  for (const required of ['state-before.json', 'config-before.json', 'service-before.plist', 'review.json']) {
    if (!names.has(required)) fail()
  }
  const legacy = JSON.parse(readPrivate(path.join(evidenceDir, 'state-before.json')))
  const watermarks = new Map(), excluded = new Map()
  for (const item of fence.fences) {
    if (!item || !CHAT.test(item.chatId || '') || watermarks.has(item.chatId) ||
        !fenced.some(group => group.chatId === item.chatId) ||
        !Number.isSafeInteger(item.watermark) || item.watermark < 0 ||
        item.watermark !== (legacy.groups?.[item.chatId]?.watermark || 0) ||
        !Array.isArray(item.sourceIds) || item.sourceIds.length > 100_000 ||
        item.sourceIds.some(id => !SOURCE.test(id)) || new Set(item.sourceIds).size !== item.sourceIds.length) fail()
    watermarks.set(item.chatId, item.watermark)
    excluded.set(item.chatId, new Set(item.sourceIds))
  }
  for (const group of expectedGroups) {
    if (!watermarks.has(group.chatId) && legacy.groups?.[group.chatId] !== undefined) fail()
  }
  return Object.freeze({
    sourceIds: Object.freeze([...new Set(fence.fences.flatMap(item => item.sourceIds))]),
    watermarks: Object.freeze(Object.fromEntries(watermarks)),
    rejects(message) {
      if (!watermarks.has(message?.chatId)) return false
      if (excluded.get(message.chatId).has(message.msgId)) return true
      return !Number.isSafeInteger(message.createTimeMs) || message.createTimeMs <= watermarks.get(message.chatId)
    },
  })
}
// A group bound online after a reviewed cut must not carry legacy state:
// its old messages would have no admission fence.
function assertNoLegacyGroupState({ stateDir, chatId } = {}) {
  if (!path.isAbsolute(stateDir || '') || !CHAT.test(chatId || '')) fail()
  const file = path.join(stateDir, 'legacy-evidence', 'state-before.json')
  if (!fs.existsSync(path.join(stateDir, 'c2-migration.json')) && !fs.existsSync(file)) return true
  const legacy = JSON.parse(readPrivate(file))
  if (legacy.groups?.[chatId] !== undefined) {
    throw new Error('This group has legacy history; review its migration before binding it again')
  }
  return true
}
module.exports = { loadC2MigrationFence, assertNoLegacyGroupState }
