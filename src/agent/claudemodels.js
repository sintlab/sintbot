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

// 当前主力档 + 上一代 Opus。刻意不铺满历史版本 —— 它是挑选快捷方式,不是权威清单;
// 4.8 留着是因为它仍在服务且额度池与 Opus 5 分开(operator 点名要能选,2026-08-05)。
// ⚠ id 是不带日期后缀的固定串(`claude-opus-4-8`,不是 `claude-opus-4-8-2026xxxx`)。
const BUILTIN = [
  { id: '', name: '默认(跟随 Claude Code)', note: '推荐 · 不指定型号' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', note: '最强 · 复杂改码 / 长链路' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', note: '上一代 Opus · 额度池独立' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', note: '速度与智能平衡' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', note: '最快最省 · 简单任务' },
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

module.exports = { listModels, mergeModels, parseExtraModels, readExtraModels, BUILTIN }
