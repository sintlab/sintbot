// Claude 模型清单(控制台「模型」下拉用)—— **只在已登录时给**,未登录不列任何型号。
//
// ⚠ 为什么不是「登录后拉官方实时清单」:查过了,三条路都不通(2026-08-03 实测):
//   1. `GET /v1/models` + Claude Code 的登录态 token(Bearer + anthropic-beta: oauth-2025-04-20)
//      —— curl 拿得到 200 与完整清单,但**同样的头从 Node 里发一律 403 `Request not allowed`**
//      (node:https / fetch 都试过,补 accept、换 UA、换 HTTP/1.1 全无效)⇒ 这是按客户端指纹的
//      门禁,不是缺哪个头。它拦的是「登录态 token 被别的程序拿去用」,shell 出 curl 去绕正是
//      它要防的那件事,所以不做。
//   2. `claude` 没有 models 子命令(只有 auth / mcp / plugin / doctor …)。
//   3. `~/.claude.json` 的 `modelAccessCache` 实测是空数组、`orgModelDefaultCache` 是 null
//      —— 不是清单来源。
// 所以清单 = 内置候选 + 本机账号的**额外可选项**(`additionalModelOptionsCache`,CLI 登录后
// 自己写的,合法本地读、best-effort),并在面板里说清「以 Claude Code 里 /model 为准」。
// 想用清单外的型号:面板留了「自定义…」直接填,不受这里限制。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Fallback candidates, used only when the live list from the CLI handshake
// has never been obtained. Names follow core/modelname.js display names.
// Ids carry no date suffix and use hyphens for versions (claude-opus-5-5).
const BUILTIN = [
  { id: '', name: '默认(跟随 Claude Code)', note: '推荐 · 不指定型号' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', note: '最新 Opus · 复杂改码 / 长链路' },
  { id: 'claude-opus-5', name: 'Opus 5', note: '上一代 Opus' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', note: '速度与智能平衡' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', note: '最快最省 · 简单任务' },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', note: '更早一代 Opus · 额度池独立' },
]

// CLI 登录后写在 ~/.claude.json 的账号额外可选模型(本机这台是 Fable 5)。
// 私有字段,形状可能变 ⇒ 全程防御式读取,取不到就当没有。纯函数,便于单测。
function parseExtraModels(rawJson) {
  const arr = rawJson && Array.isArray(rawJson.additionalModelOptionsCache) ? rawJson.additionalModelOptionsCache : []
  return arr
    .filter((x) => x && typeof x.value === 'string' && x.value)
    .map((x) => ({ id: x.value, name: x.label || x.value, note: String(x.description || '').slice(0, 60) }))
}
function readExtraModels(home) {
  try { return parseExtraModels(JSON.parse(fs.readFileSync(path.join(home || os.homedir(), '.claude.json'), 'utf8'))) }
  catch { return [] }
}

// 合并:内置在前,账号额外项去重后追加(同 id 不重复列)。
function mergeModels(extra = []) {
  const out = BUILTIN.slice()
  const seen = new Set(out.map((m) => m.id))
  for (const m of extra) if (m.id && !seen.has(m.id)) { seen.add(m.id); out.push({ ...m, extra: true }) }
  return out
}

// { loggedIn, models, source }。未登录 ⇒ models 为空数组(面板据此整块不显示型号)。
// source: 'account' = 含本机账号的额外可选项 · 'builtin' = 只有内置候选。
function listModels({ loggedIn, home } = {}) {
  if (!loggedIn) return { loggedIn: false, models: [], source: 'none' }
  const extra = readExtraModels(home)
  return { loggedIn: true, models: mergeModels(extra), source: extra.length ? 'account' : 'builtin' }
}

// Live list: Claude Code's own initialize handshake. Start
// `claude -p --input-format stream-json --output-format stream-json`, send one
// control_request { subtype: 'initialize' }; the response's models are the
// CLI's /model menu for this machine and account: official display names,
// descriptions and the depths each model supports. No question is asked and
// no turn starts, so no quota is used, and the login token is never read.
// Only for subscription cards: endpoint/model variables are removed first so a
// third-party endpoint exported in the service shell cannot redirect it.
// Unavailable (signed out, CLI too old, timeout) ⇒ null; callers then use the
// last saved list or the built-in candidates.
function parseInitModels(models) {
  if (!Array.isArray(models)) return null
  const out = [], aliasOf = {}
  let recommended = ''
  const seen = new Set()
  for (const m of models) {
    if (!m || typeof m.value !== 'string' || !m.value) continue
    const id = typeof m.resolvedModel === 'string' && m.resolvedModel ? m.resolvedModel : m.value
    if (m.value === 'default') { recommended = id; continue }
    // An alias (opus → claude-opus-5-5) is stored as the concrete model, so a
    // later CLI upgrade does not silently move the group to another generation.
    if (m.value !== id) aliasOf[m.value] = id
    if (seen.has(id)) continue
    seen.add(id)
    const efforts = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e) => typeof e === 'string') : []
    out.push({ id, name: String(m.displayName || '').trim() || id, note: String(m.description || '').slice(0, 60), efforts, effort: m.supportsEffort !== false })
  }
  if (!out.length) return null
  return { models: out, aliasOf, recommended: recommended || out[0].id }
}

function probeModels(bin = 'claude', { timeoutMs = 20000, cwd = os.tmpdir(), spawnFn = null } = {}) {
  return new Promise((resolve) => {
    const spawn = spawnFn || require('node:child_process').spawn
    const { resolveSpawn } = require('./winexec')
    const env = { ...process.env }
    delete env.ANTHROPIC_BASE_URL; delete env.ANTHROPIC_AUTH_TOKEN; delete env.ANTHROPIC_MODEL; delete env.CLAUDECODE
    let child, buf = '', settled = false, timer = null
    const done = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdin.end() } catch {}
      try { child.kill() } catch {}
      resolve(v)
    }
    try {
      const { file, spawnArgs } = resolveSpawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])
      child = spawn(file, spawnArgs, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch { return resolve(null) }
    timer = setTimeout(() => done(null), timeoutMs)
    if (timer.unref) timer.unref()
    child.on('error', () => done(null))
    child.on('close', () => done(null))
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let o; try { o = JSON.parse(line) } catch { continue }
        if (o && o.type === 'control_response') {
          const r = o.response && (o.response.response || o.response)
          return done(parseInitModels(r && r.models))
        }
      }
    })
    try { child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'sintbot-models', request: { subtype: 'initialize' } }) + '\n') } catch { done(null) }
  })
}

module.exports = { listModels, mergeModels, parseExtraModels, readExtraModels, BUILTIN, parseInitModels, probeModels }
