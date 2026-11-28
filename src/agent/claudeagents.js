'use strict'
// Who is working in a Claude Code turn (display only).
//
// The main agent may hand parts of a task to subagents. Claude Code reports
// each one on its output stream: a `task_started` system event when it
// begins, `task_updated` and `task_notification` when it ends, and the result
// of the tool call that started it going back to the agent that called it.
// What these mean (which events start and end a subagent, who hangs under
// whom) is the binary core's decision (agents_step, ABI 45); this module only
// copies the fields of each event to the core, keeps the state it returns for
// the length of the turn, and reads the two things the stream does not carry.
//
// Model and thinking depth: a first-level subagent's replies name their model
// but not the depth, and a second-level subagent's replies never reach the
// stream at all. Every subagent has a record of its own next to the session:
//   <config dir>/projects/<working directory, rewritten>/<session id>/subagents/agent-<task id>.jsonl
// with an `api-request` line written before each request (params.model,
// params.output_config.effort) and an `assistant` line for each reply. A
// record that cannot be found or read just leaves the label off the row.
//
// Nothing here may cost the turn: every failure ends the tracking for this
// turn with one log line, and the turn goes on as if it had no subagents.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { agentsStep } = require('./privatecore')

const TAIL_BYTES = 64 * 1024 // model and depth do not change in a subagent's life: the newest line is enough
const HEAD_BYTES = 256 * 1024 // a tail filled by one huge tool result: look for the first line instead
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/ // ids come from the executor's output; fix their shape before building a path
const PROBE_TRIES = 6
const TASK_SUBTYPES = new Set(['task_started', 'task_updated', 'task_notification'])

// Claude Code names a project directory after the working directory with
// every character that is not a letter or digit replaced by a dash.
const projectDirName = (cwd) => String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-')

function configDirOf(env = process.env) {
  return (env && env.CLAUDE_CONFIG_DIR) || path.join((env && (env.HOME || env.USERPROFILE)) || os.homedir(), '.claude')
}

// Candidate paths: the working directory as Claude Code records it (symbolic
// links resolved, so /tmp is /private/tmp on macOS), then as given.
function agentLogPaths({ configDir, cwd, sessionId, agentId } = {}) {
  if (!ID_RE.test(String(sessionId || '')) || !ID_RE.test(String(agentId || '')) || !cwd) return []
  const dirs = []
  try { dirs.push(fs.realpathSync(cwd)) } catch { /* the directory is gone: use it as given */ }
  if (!dirs.includes(cwd)) dirs.push(cwd)
  return dirs.map((dir) => path.join(configDir || configDirOf(), 'projects', projectDirName(dir), String(sessionId),
    'subagents', `agent-${agentId}.jsonl`))
}

const str = (value) => (typeof value === 'string' && value ? value : undefined)

// One line of a record: the model and depth it names, or null for any other
// line, a line that does not parse, or a reply made up locally.
function runtimeOf(line) {
  const isRequest = line.includes('"type":"api-request"')
  if (!isRequest && !line.includes('"type":"assistant"')) return null
  let entry
  try { entry = JSON.parse(line) } catch { return null }
  if (!entry || typeof entry !== 'object') return null
  let model, effort
  if (entry.type === 'api-request') {
    // Only the subagent's own loop; a side request may use another model.
    if (typeof entry.querySource === 'string' && !entry.querySource.startsWith('agent')) return null
    model = str(entry.params && entry.params.model)
    effort = str(entry.params && entry.params.output_config && entry.params.output_config.effort)
  } else if (entry.type === 'assistant') {
    model = str(entry.requestedModel) || str(entry.message && entry.message.model)
    if (model === '<synthetic>') return null
    effort = str(entry.effort)
  } else return null
  return model || effort ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } : null
}

async function readSlice(file, fromEnd, bytes) {
  const handle = await fs.promises.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, fromEnd ? size - length : 0)
    return buffer.toString('utf8')
  } finally { await handle.close() }
}

// One record: { model?, effort? }, or {} when nothing is there yet or it cannot be read.
async function readAgentRuntime(file) {
  try {
    const tail = (await readSlice(file, true, TAIL_BYTES)).split('\n')
    for (let i = tail.length - 1; i >= 0; i--) { const found = runtimeOf(tail[i]); if (found) return found }
    for (const line of (await readSlice(file, false, HEAD_BYTES)).split('\n')) { const found = runtimeOf(line); if (found) return found }
  } catch { /* unreadable means unknown */ }
  return {}
}

async function agentRuntime(location) {
  for (const file of agentLogPaths(location)) {
    const found = await readAgentRuntime(file)
    if (found.model || found.effort) return found
  }
  return {}
}

const orNull = (value) => (typeof value === 'string' ? value : null)
// A subagent's title is shown in the running reply and in /status, shortened
// on the way. Secrets and paths are taken out while it is still whole: a
// shortened secret no longer looks like one, and a shortened path still names
// what lies under it.
//
// A path is replaced whole by one neutral label, wherever it starts: every
// name under a home folder can be a private project, and a mounted volume
// (/Volumes/Work/Vault) is no less private than a home. A path here is an
// absolute one at least two names deep (a lone `/status` stays), one under a
// home folder (~/a, ~name/a), one on a drive (C:\a, C:/a) or a file:// address.
// Names may hold spaces: a quoted path ("…", '…', `…`, 「…」, “…”) is replaced
// up to its closing quote, a space escaped the shell way (My\ File.md) belongs
// to the name, a folder name under a home, a volume or a drive may hold single
// spaces (/Volumes/My Drive/Clients), and a bare last name runs on over a few
// words to a file name (/Volumes/Work/Private Design.md). Punctuation right
// after a path stays outside the label. Relative names (src/a.js), fractions
// and web addresses are left as they are.
const { redact } = require('../core/redact')
const PATH_LABEL = '‹path›'
const STOP = "\\s/\\\\'\"`，。；：、！？「」『』（）《》“”‘’"
// One name: a backslash before any character but a slash keeps that character
// in the name (`My\ File.md`). On a drive the backslash parts names instead.
const NAME = `(?:[^${STOP}]|\\\\[^\\n/])+`
const DRIVE_NAME = `[^${STOP}]+`
// Under a home or a volume a folder name may hold single spaces when another
// name follows it, unless it starts with a file name (a.js to src/b.js).
const NAME_SPACED = `(?:[^${STOP}.]+(?: ${NAME})+(?=/)|${NAME})`
// A bare last name runs on over up to five words when the last of them is a
// file name (Private Design.md, Q4.2026 Budget.pdf), across one space or more;
// words never take sentence marks, so `notes, then a.md` stops at the comma.
// A first word that is itself a file name runs on too (a.md and b.md goes
// whole): masking a word too many is the safe side.
const WORD = `[^${STOP},;:!?()\\[\\]]+`
const SPACED_FILE = `(?<=[/\\\\][^${STOP},;:!?()\\[\\]]+)(?: +${WORD}){0,4}? +${WORD}\\.[A-Za-z][A-Za-z0-9]{0,7}` +
  `(?=[,.;:!?)\\]]*(?:[${STOP}]|$))`
const PATH_IN_TITLE = new RegExp("(?<![\\w.~/\\\\-])(?:file://)?(?:" +
  `/(?:Users|home|Volumes)(?:/${NAME_SPACED})+` +
  `|/${NAME}(?:/${NAME})+` +
  `|~[\\w.-]*(?:/${NAME_SPACED})+` +
  `|[A-Za-z]:[\\\\/]${DRIVE_NAME}(?:(?: ${DRIVE_NAME})*[\\\\/]${DRIVE_NAME})*)(?:${SPACED_FILE})?`, 'g')
// Quoted: what opens like a path (two names deep, under a home, on a drive)
// is a path up to the closing quote, spaces and all. A quote right after a
// letter is an apostrophe (Bob's), not an opening.
const QUOTED_PATHS = ['""', "''", '``', '「」', '『』', '“”', '‘’'].map(([open, close]) => new RegExp(
  `(?<!\\w)${open}(?=(?:file://)?(?:/[^/\\n${close}]+/|~[\\w.-]*/|[A-Za-z]:[\\\\/]))[^\\n${close}]{1,512}${close}`, 'g'))
const TRAILING_MARKS = /[,.;:!?)\]]+$/
const maskPaths = (text) => QUOTED_PATHS
  .reduce((out, quoted) => out.replace(quoted, found => found[0] + PATH_LABEL + found[found.length - 1]), text)
  .replace(PATH_IN_TITLE, found => PATH_LABEL + (found.match(TRAILING_MARKS)?.[0] || ''))
// The core keeps a few dozen characters of a title, so only its start is
// read: the quoted-path rules above look ahead to a closing mark, and a long
// title full of unclosed quotes would otherwise take seconds.
const TITLE_READ = 2048
const titleOf = (value) => (typeof value === 'string' ? maskPaths(redact(value.slice(0, TITLE_READ))) : null)

// What one line of the executor's output says about subagents, as the event
// the core takes, or null when the line says nothing about them. Only the
// named fields are copied; no message text crosses over.
function agentEventOf(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.type === 'system' && TASK_SUBTYPES.has(raw.subtype) && typeof raw.task_id === 'string') {
    return { type: 'task', subtype: raw.subtype, taskId: raw.task_id, taskType: orNull(raw.task_type),
      subagentType: orNull(raw.subagent_type), description: titleOf(raw.description),
      spawnDepth: Number.isFinite(raw.spawn_depth) ? raw.spawn_depth : null,
      parentTaskId: orNull(raw.parent_task_id), toolUseId: orNull(raw.tool_use_id),
      status: orNull(raw.status), patchStatus: orNull(raw.patch && raw.patch.status) }
  }
  if (raw.type === 'user') {
    const blocks = raw.message && Array.isArray(raw.message.content) ? raw.message.content : []
    const ids = blocks.filter((block) => block && block.type === 'tool_result' && typeof block.tool_use_id === 'string')
      .map((block) => block.tool_use_id)
    return ids.length ? { type: 'results', parentToolUseId: orNull(raw.parent_tool_use_id), toolUseIds: ids } : null
  }
  if (raw.type === 'assistant') {
    const model = raw.message && typeof raw.message.model === 'string' ? raw.message.model : null
    return model ? { type: 'reply', sub: !!raw.parent_tool_use_id, agentId: orNull(raw.agent_id), model } : null
  }
  return null
}

// One turn's tracker. `onChange(state)` is called with the core's state each
// time the rows may differ; `locate()` answers where this turn's records are
// ({ configDir, cwd, sessionId }) at the moment a record is read.
function createAgentsTracker({ onChange, locate, log = () => {}, now = Date.now, probeMs = 1500,
  step = agentsStep, read = agentRuntime } = {}) {
  let state = null
  let closed = false
  let mainModel = ''
  const probes = new Map() // task id → timer of the next read of its record
  const stopProbe = (id) => { const timer = probes.get(id); if (timer) clearTimeout(timer); probes.delete(id) }
  const fail = (error) => {
    if (closed) return
    closed = true
    for (const timer of probes.values()) clearTimeout(timer)
    probes.clear()
    try { log('who is working is not shown for the rest of this turn: ' + ((error && error.message) || error)) } catch {}
  }
  const apply = (event) => {
    if (closed) return
    try {
      const out = step({ state, now: now(), event })
      state = out.state
      for (const id of out.started) probe(id, 0)
      for (const id of out.ended) stopProbe(id)
      if (out.changed && onChange) onChange(state)
    } catch (error) { fail(error) }
  }
  // The first read comes shortly after the start (the request line is written
  // before the first reply), later ones twice as far apart, until both the
  // model and the depth are known, the subagent ends or the turn is over.
  const probe = (id, tries) => {
    if (closed || tries >= PROBE_TRIES || !(probeMs > 0)) { probes.delete(id); return }
    const timer = setTimeout(() => {
      if (closed || probes.get(id) !== timer) return
      let where
      try { where = locate() } catch { where = null }
      Promise.resolve(where ? read({ ...where, agentId: id }) : {}).then((found) => {
        if (closed || probes.get(id) !== timer) return
        if (found && (found.model || found.effort)) {
          apply({ type: 'info', id, model: found.model || null, effort: found.effort || null })
        }
        if (closed || probes.get(id) !== timer) return
        if (found && found.model && found.effort) probes.delete(id)
        else probe(id, tries + 1)
      }).catch(() => { probes.delete(id) })
    }, tries === 0 ? probeMs : probeMs * 2)
    if (timer.unref) timer.unref()
    probes.set(id, timer)
  }
  return {
    // One parsed line of the executor's output.
    observe(raw) {
      if (closed) return
      let event
      try { event = agentEventOf(raw) } catch (error) { fail(error); return }
      if (!event) return
      // Nothing to hand back and nobody to label until a subagent exists;
      // the main agent's model is reported once per change.
      if (event.type === 'results' && !(state && state.tools.length)) return
      if (event.type === 'reply') {
        if (event.sub) { if (!(state && state.agents.length)) return } else if (event.model === mainModel) return
        if (!event.sub) mainModel = event.model
      }
      apply(event)
    },
    state: () => state,
    dispose() {
      closed = true
      for (const timer of probes.values()) clearTimeout(timer)
      probes.clear()
    },
  }
}

module.exports = { createAgentsTracker, agentEventOf, agentRuntime, readAgentRuntime, agentLogPaths, runtimeOf,
  projectDirName, configDirOf }
