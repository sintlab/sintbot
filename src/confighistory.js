'use strict'

// Configuration history: a byte-for-byte copy of every configuration the
// service has taken into use (at start and after each online change), kept in
// <data dir>/config-history. Recording hangs on "the service now runs this
// configuration", not on the writers, so the console, chat commands, the
// attach flows and edits made while stopped are all covered.
//
// The copies hold credentials: the directory is 0700 and each file 0600.
// Listing prints which keys changed, never a value.
//
// Restoring is an offline operation. The running service owns the
// configuration (it validates, resets sessions and applies each change in one
// step, and does not watch the file), so a restore takes the writer lock,
// validates the chosen version with the loader the service starts with,
// applies the same settled/session rules as an online change, writes the
// exact bytes, and takes effect at the next start.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { redact } = require('./core/redact')
const { tzParts, isValidTz } = require('./core/time')

const HISTORY_DIR = 'config-history'
const HISTORY_KEEP = 50
const DIR_MODE = 0o700
const FILE_MODE = 0o600
// <UTC date>T<UTC time with milliseconds>Z-<first 12 hex of sha256>: sorting
// by name sorts by time, and the hash answers "same as the latest?" unread.
const ID_RE = /^(\d{8})T(\d{9})Z-([0-9a-f]{12})\.json$/

const historyDir = stateDir => path.join(stateDir, HISTORY_DIR)
const sha12 = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12)

function stamp(ms) {
  const iso = new Date(ms).toISOString() // 2026-01-02T03:04:05.678Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}Z`
}

function idTime(id) {
  const m = ID_RE.exec(`${id}.json`)
  if (!m) return NaN
  const d = m[1], t = m[2]
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8),
    +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6), +t.slice(6, 9))
}

// A real private directory owned by this process; a symlink is refused so a
// copy with credentials never lands somewhere else.
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Configuration history directory is not a real directory')
  if (process.platform !== 'win32' && (st.mode & 0o777) !== DIR_MODE) fs.chmodSync(dir, DIR_MODE)
}

// Exact bytes, written beside the target and renamed over it.
function writeBytes(file, buf, mode) {
  const tmp = path.join(path.dirname(file), `.tmp-${crypto.randomUUID()}`)
  const fd = fs.openSync(tmp, 'wx', mode)
  try {
    fs.writeSync(fd, buf)
    fs.fsyncSync(fd)
    fs.fchmodSync(fd, mode)
  } finally { fs.closeSync(fd) }
  try { fs.renameSync(tmp, file) } catch (error) { try { fs.unlinkSync(tmp) } catch {} ; throw error }
}

// Newest first.
function historyEntries(stateDir) {
  const dir = historyDir(stateDir)
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names.filter(name => ID_RE.test(name)).sort().reverse().map(name => ({
    id: name.slice(0, -5), file: path.join(dir, name), hash: ID_RE.exec(name)[3] }))
}

// Store the configuration file as it is now, unless it equals the latest
// stored version or is not valid JSON (nothing could be restored from it).
// → { saved, id?, reason? }
function snapshotConfig(configFile, { stateDir, keep = HISTORY_KEEP, now = Date.now() } = {}) {
  if (!configFile || !stateDir) return { saved: false, reason: 'no-file' }
  let buf
  try { buf = fs.readFileSync(configFile) } catch { return { saved: false, reason: 'unreadable' } }
  try { JSON.parse(buf.toString('utf8')) } catch { return { saved: false, reason: 'invalid-json' } }
  const hash = sha12(buf)
  const latest = historyEntries(stateDir)[0]
  if (latest && latest.hash === hash) return { saved: false, reason: 'same', id: latest.id }
  const dir = historyDir(stateDir)
  ensureDir(dir)
  // The clock may have stepped back: a new version still sorts after the latest.
  const at = latest && !(now > idTime(latest.id)) ? idTime(latest.id) + 1 : now
  const id = `${stamp(at)}-${hash}`
  writeBytes(path.join(dir, `${id}.json`), buf, FILE_MODE)
  for (const old of historyEntries(stateDir).slice(Math.max(1, keep))) { try { fs.unlinkSync(old.file) } catch {} }
  return { saved: true, id }
}

// What differs between two configurations, as key paths only: top-level keys
// (one level into objects), and for each group and model the changed fields.
// → [{ kind: 'top'|'group'|'provider', op: 'add'|'remove'|'change', name, fields }]
function diffConfig(before, after) {
  const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const A = obj(before) || {}, B = obj(after) || {}
  const keys = (x, y) => [...new Set([...Object.keys(x), ...Object.keys(y)])]
  const out = []
  for (const key of keys(A, B)) {
    if (key === 'groups' || key === 'providers' || isDeepStrictEqual(A[key], B[key])) continue
    const x = obj(A[key]), y = obj(B[key])
    if (x && y) {
      for (const sub of keys(x, y)) {
        if (!isDeepStrictEqual(x[sub], y[sub])) out.push({ kind: 'top', op: 'change', name: `${key}.${sub}`, fields: [] })
      }
    } else out.push({ kind: 'top', op: !(key in A) ? 'add' : !(key in B) ? 'remove' : 'change', name: key, fields: [] })
  }
  const keyed = (kind, ao, bo, label) => {
    const x = obj(ao) || {}, y = obj(bo) || {}
    for (const key of keys(x, y)) {
      if (isDeepStrictEqual(x[key], y[key])) continue
      const name = label(obj(y[key]) || obj(x[key]) || {}, key)
      if (!(key in x)) out.push({ kind, op: 'add', name, fields: [] })
      else if (!(key in y)) out.push({ kind, op: 'remove', name, fields: [] })
      else {
        const p = obj(x[key]) || {}, q = obj(y[key]) || {}
        out.push({ kind, op: 'change', name, fields: keys(p, q).filter(field => !isDeepStrictEqual(p[field], q[field])) })
      }
    }
  }
  keyed('group', A.groups, B.groups, (group, key) => typeof group.name === 'string' && group.name ? group.name : key)
  keyed('provider', A.providers, B.providers, (_provider, key) => key)
  return out
}

// One change as text. Names are labels people chose, not credentials, but the
// line still passes the outbound redaction in case one was pasted into a name.
function formatChange(change, lang = 'zh') {
  const zh = lang === 'zh'
  const noun = { top: zh ? '设置' : 'setting', group: zh ? '群' : 'group', provider: zh ? '模型' : 'model' }[change.kind]
  const name = zh ? `${noun}「${change.name}」` : `${noun} "${change.name}"`
  let text
  if (change.kind === 'top') {
    text = change.op === 'add' ? (zh ? `新增设置 ${change.name}` : `added ${change.name}`)
      : change.op === 'remove' ? (zh ? `删除设置 ${change.name}` : `removed ${change.name}`)
        : (zh ? `设置 ${change.name}` : `${change.name}`)
  } else if (change.op === 'add') text = zh ? `新增${name}` : `added ${name}`
  else if (change.op === 'remove') text = zh ? `删除${name}` : `removed ${name}`
  else text = `${name}: ${change.fields.join(zh ? '、' : ', ') || (zh ? '(结构变了)' : '(shape changed)')}`
  return redact(text, { pii: false })
}

const readJSON = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

// Stored versions, newest first, each with what changed since the one before
// it (null for the oldest).
function listConfigHistory({ stateDir } = {}) {
  const list = historyEntries(stateDir)
  const parsed = list.map(entry => readJSON(entry.file))
  return list.map((entry, index) => {
    let size = 0
    try { size = fs.statSync(entry.file).size } catch {}
    return { id: entry.id, at: idTime(entry.id), size,
      changes: index + 1 < list.length ? diffConfig(parsed[index + 1], parsed[index]) : null }
  })
}

// The full id, a time prefix or a hash prefix names a version.
// → { entry } | { error: 'missing-id'|'not-found'|'ambiguous', count? }
function findVersion(stateDir, id) {
  const want = String(id || '').trim().replace(/\.json$/, '')
  if (!want) return { error: 'missing-id' }
  const hits = historyEntries(stateDir).filter(entry =>
    entry.id === want || entry.id.startsWith(want) || entry.hash.startsWith(want))
  if (!hits.length) return { error: 'not-found' }
  const exact = hits.find(entry => entry.id === want)
  if (!exact && hits.length > 1) return { error: 'ambiguous', count: hits.length }
  return { entry: exact || hits[0] }
}

function localTime(ms, tz) {
  let zone = tz
  if (!isValidTz(zone)) { try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { zone = undefined } }
  const p = tzParts(ms, zone)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

// Put a stored version back as the configuration, with the service stopped.
//   - the writer lock is held for the whole operation (a running service refuses it);
//   - the version must load with the same loader the service starts with;
//   - a group whose settings change must have a settled journal, and a group
//     whose backend, project or session environment changes gets a fresh
//     session before the file is replaced, as with an online change;
//   - the current file is stored first, so the restore can be undone.
// Journals are only read. → { ok: true, id, same, changes, resets } |
// { ok: false, error, detail?, count?, chatId?, name? }
function restoreConfig(id, configFile, { stateDir, now = Date.now(),
  acquireLock = require('./core/instancelock').acquire,
  loadFromRaw = require('./c2install').loadInstallationFromRaw,
  assertSettled = defaultAssertSettled,
  openStore = file => new (require('./core/store').StateStore)(file) } = {}) {
  const found = findVersion(stateDir, id)
  if (found.error) return { ok: false, error: found.error, count: found.count }
  const lock = acquireLock(path.join(stateDir, 'daemon.lock'))
  if (!lock?.ok) return { ok: false, error: 'running' }
  try {
    const { RESET_KEYS, GLOBAL_TASK_KEYS, sessionIdentity } = require('./c2configcontrol')
    const target = fs.readFileSync(found.entry.file)
    let targetRaw
    try { targetRaw = JSON.parse(target.toString('utf8')) } catch { return { ok: false, error: 'invalid-version' } }
    const load = raw => loadFromRaw(structuredClone(raw), configFile, { dataDir: stateDir, allowAddedGroups: true })
    let next
    try { next = load(targetRaw) } catch (error) {
      return { ok: false, error: 'rejected', detail: error?.message || String(error) }
    }
    let current = null
    try { current = fs.readFileSync(configFile) } catch {}
    if (current && current.equals(target)) return { ok: true, id: found.entry.id, same: true, changes: [], resets: [] }
    const currentRaw = current ? (() => { try { return JSON.parse(current.toString('utf8')) } catch { return null } })() : null
    // What the sessions on disk belong to: the current file when it loads,
    // otherwise the latest version the service is known to have run.
    let base = null
    if (currentRaw) { try { base = load(currentRaw) } catch {} }
    if (!base) {
      const latest = historyEntries(stateDir)[0]
      const raw = latest && readJSON(latest.file)
      if (raw) { try { base = load(raw) } catch {} }
    }
    const stateFile = path.join(stateDir, 'state.json')
    const store = fs.existsSync(stateFile) ? openStore(stateFile) : null
    const effective = (chatId, group, cfg) => store?.getProvider?.(chatId) || group.provider || cfg.defaultProvider
    const global = !base || GLOBAL_TASK_KEYS.some(key => !isDeepStrictEqual(base.cfg[key], next.cfg[key]))
    const resets = []
    for (const route of next.routes) {
      if (!fs.existsSync(route.file)) continue // registered with an empty journal at the next start
      const before = base?.routes.find(item => item.chatId === route.chatId)
      const moved = !before ||
        RESET_KEYS.some(key => !isDeepStrictEqual(before.group[key], route.group[key])) ||
        !isDeepStrictEqual(
          sessionIdentity(base.cfg.providers?.[effective(route.chatId, before.group, base.cfg)]),
          sessionIdentity(next.cfg.providers?.[effective(route.chatId, route.group, next.cfg)]))
      if (!global && !moved && isDeepStrictEqual(before.group, route.group)) continue
      try { assertSettled(route) } catch (error) {
        return { ok: false, error: 'unsettled', chatId: route.chatId,
          name: route.group?.name || route.chatId, detail: error?.message || String(error) }
      }
      if (moved) resets.push(route.chatId)
    }
    // Keep what is being replaced: a valid file as a version, anything else
    // (hand-edited into invalid JSON) beside the versions, unlisted.
    const saved = snapshotConfig(configFile, { stateDir, now })
    if (current && saved.reason === 'invalid-json') {
      ensureDir(historyDir(stateDir))
      writeBytes(path.join(historyDir(stateDir), `${stamp(now)}-${sha12(current)}.invalid`), current, FILE_MODE)
    }
    // No session state file means no session to carry over.
    if (store) for (const chatId of resets) store.resetGroupSession(chatId)
    let mode = FILE_MODE
    try { mode = fs.statSync(configFile).mode & 0o777 } catch {}
    writeBytes(configFile, target, mode)
    return { ok: true, id: found.entry.id, same: false, changes: diffConfig(currentRaw, targetRaw), resets }
  } finally { lock.release() }
}

function defaultAssertSettled(route) {
  const { VALIDATORS, assertJournalScope } = require('./c2install')
  const { C2DurableJournal } = require('./core/c2durablejournal')
  assertJournalScope(C2DurableJournal.open(route.file, VALIDATORS), route.chatId, { requireSettled: true })
}

// `sintbot config history|restore`. → exit code
function runConfigCommand(args, { out = text => process.stdout.write(text),
  err = text => process.stderr.write(text), lang = require('./clilang').cliLang(), env = process.env, deps = {} } = {}) {
  const { parseArgs } = require('node:util')
  const { installationStateDir } = require('./c2install')
  const tr = (zh, en) => lang === 'zh' ? zh : en
  const usage = tr(
    '用法: sintbot config history [--limit <数量>] [--data-dir <绝对路径>]\n' +
    '      sintbot config restore <版本> [--config <绝对路径>] [--data-dir <绝对路径>]\n' +
    '服务每次启用一份新配置（启动时、在线修改后）都会原样存一份，保留最近 50 份。\n' +
    'history 列出每个版本相对上一版改了哪些项（只列名称，不显示内容）。\n' +
    'restore 须先停止服务：先存下当前这份，再把选中的版本原样写回，下次启动生效；\n' +
    '版本可写完整编号、时间前缀或末尾哈希的前几位。\n',
    'Usage: sintbot config history [--limit <n>] [--data-dir <absolute path>]\n' +
    '       sintbot config restore <version> [--config <absolute path>] [--data-dir <absolute path>]\n' +
    'The service stores every configuration it takes into use (at start and after an online change), keeping the latest 50.\n' +
    'history lists what changed in each version (names only, never values).\n' +
    'restore needs the service stopped: it stores the current file, writes the chosen version back byte for byte,\n' +
    'and takes effect at the next start. A version is its full id, a time prefix or the first characters of its hash.\n')
  const [action, ...rest] = args
  if (!action || args.some(arg => arg === '--help' || arg === '-h')) { out(usage); return 0 }
  if (!['history', 'restore'].includes(action)) { err(usage); return 1 }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    config: { type: 'string' }, 'data-dir': { type: 'string' }, limit: { type: 'string' } } })
  const stateDir = installationStateDir(values['data-dir'])
  const configFile = path.resolve(values.config || env.SBOT_CONFIG || path.join(stateDir, 'config.json'))
  const tz = readJSON(configFile)?.timezone
  const describe = changes => changes.map(change => formatChange(change, lang)).join(' · ')
  if (action === 'history') {
    if (positionals.length) { err(usage); return 1 }
    const limit = Math.max(1, Math.min(HISTORY_KEEP, Number(values.limit) || 20))
    const list = listConfigHistory({ stateDir }).slice(0, limit)
    if (!list.length) {
      out(tr('还没有配置历史；服务启动或配置变化时才会存。\n', 'No configuration history yet; a version is stored when the service starts or its configuration changes.\n'))
      return 0
    }
    for (const entry of list) {
      const what = entry.changes === null ? tr('(最早一份)', '(oldest)')
        : entry.changes.length ? describe(entry.changes) : tr('(仅格式或顺序变化)', '(formatting or order only)')
      out(`${entry.id}  ${localTime(entry.at, tz)}  ${(entry.size / 1024).toFixed(1)} KB  ${what}\n`)
    }
    return 0
  }
  if (positionals.length !== 1) { err(usage); return 1 }
  const result = restoreConfig(positionals[0], configFile, { stateDir, ...deps })
  if (!result.ok) {
    const shown = redact(String(result.detail || ''), { pii: false })
    err('sintbot: ' + ({
      'missing-id': tr('要给版本编号（见 sintbot config history）', 'Name a version (see sintbot config history)'),
      'not-found': tr(`历史里没有「${positionals[0]}」`, `No version matches "${positionals[0]}"`),
      ambiguous: tr(`「${positionals[0]}」对上了 ${result.count} 个版本，写全一点`, `"${positionals[0]}" matches ${result.count} versions; write more of it`),
      running: tr('服务正在运行；先停止服务再还原，还原后重新启动', 'The service is running; stop it before restoring, then start it again'),
      'invalid-version': tr('这个版本的文件已损坏，无法还原', 'That stored version is damaged and cannot be restored'),
      rejected: tr(`这个版本与当前安装对不上，未做任何改动：${shown}`, `That version does not fit this installation; nothing was changed: ${shown}`),
      unsettled: tr(`「${result.name}」有未结束的任务或未结的记录，而这次还原会改动它的设置；未做任何改动。先启动服务让它处理完，再停止后还原`,
        `"${result.name}" has unfinished work and this restore would change its settings; nothing was changed. Start the service, let it settle, stop it and restore again`),
    }[result.error] || result.error) + '\n')
    return 1
  }
  if (result.same) {
    out(tr(`当前配置已经是 ${result.id}，未做改动。\n`, `The configuration already is ${result.id}; nothing was changed.\n`))
    return 0
  }
  out(tr(`已还原为 ${result.id}`, `Restored ${result.id}`) +
    (result.changes.length ? tr(`，相对还原前：${describe(result.changes)}`, `; compared with before: ${describe(result.changes)}`) : '') + '\n')
  if (result.resets.length) {
    out(tr(`${result.resets.length} 个群的模型后端或项目随之改变，已为它们开启新会话。\n`,
      `${result.resets.length} group(s) changed backend or project and start a new session.\n`))
  }
  out(tr('还原前的那份已存进历史，可再次还原撤销。启动服务后生效。\n',
    'The replaced file was stored as a version, so this can be undone. It takes effect when the service starts.\n'))
  return 0
}

module.exports = { HISTORY_DIR, HISTORY_KEEP, historyDir, snapshotConfig, listConfigHistory, diffConfig,
  formatChange, findVersion, restoreConfig, runConfigCommand }
