'use strict'
// 「这张模型卡能选什么」(;两家都改成实时清单)。bin 注入给 engine.modelCatalog,控制台同一份;core 只认返回形状:
//   { ok, models: [{ id, name?, efforts?, defEffort? }] | null, aliases: [], aliasOf?: { 别名: 具体型号 }, efforts: [],
//     recommended: { model, effort }, source: 'live' | 'saved' | 'builtin' }
//   models === null ⇒ 这家没有可选清单(第三方端点):群里只能调深度,型号到后台改 —— 打错一个字下一轮就报错,
//   比让人在群里瞎试更稳。ok === false ⇒ 有清单但这会儿取不到(codex 探测失败、也没存过):型号这一项整条拒绝,不猜。
//
// 清单与名称一律取两家 CLI 的**实时数据**:
//   Codex = app-server model/list(官方显示名 GPT-6.1-Sol、★ 默认型号、各型号支持与默认的深度);
//   Claude 订阅 = Claude Code 初始化握手报的 /model 选单(claudemodels.probeModels:官方显示名、各型号支持的深度、
//     default 指向的推荐型号;别名 opus / sonnet … 打进来存成它此刻指向的具体型号)。
//   都是 10 分钟缓存、过期先给旧的后台再刷(模型卡按钮回调要 3 秒内回包,现场探测要好几秒);每次拿到就存盘(cacheFile),
//   重启后 / 探测失败时先用存盘的(source 'saved')—— 不再退回写死在代码里、早已过时的候选。Claude 从没拿到过才用内置候选。
//   拿到的显示名登记进 core/modelname.js(群里回执、卡片、控制台都按官方名称显示)。
// recommended(没有「模型卡默认」):新绑的群、换到没选过的后端、模型卡「测试」预填 / 兜底用的推荐项 ——
//   Codex = ★ 型号 + 它自带的默认深度;Claude 订阅 = 握手里 default 指向的型号 + xhigh(Claude Code 自己的默认档);
//   第三方 = 型号由模型卡定(空)+ xhigh。只用于预填与迁移,运行时不拿它悄悄兜底。

const fs = require('node:fs')
const path = require('node:path')
const { recommendEffort } = require('./core/modelcmd') // 推荐深度的口径只此一份(engine 的 /model 与模型卡同用)
const { setModelNames } = require('./core/modelname')

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] // Claude Code 的五档(code.claude.com model-config)
// Codex 服务端真正接受的档(与控制台 RE_LEGAL 同一份口径):model/list 会过报(把 ultra 列进去),先过一道
const CODEX_LEGAL = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'] // 只在拿不到实时清单、退回内置候选时用(原样交给 CLI)
const CLAUDE_EFFORT = 'xhigh'
const TTL = 600_000

// DeepSeek exposes its Claude-compatible model as a per-project choice.
function isDeepSeek(p = {}) {
  try { return new URL(p.baseUrl || p.env?.ANTHROPIC_BASE_URL).hostname === 'api.deepseek.com' } catch { return false }
}
function deepSeekCatalog(p) {
  if (!isDeepSeek(p)) return null
  return { ok: true, models: [{ id: 'deepseek-flash[1m]', name: 'DeepSeek Flash (1M)' }],
    aliases: [], efforts: CLAUDE_EFFORTS.slice(), recommended: { model: 'deepseek-flash[1m]', effort: 'max' }, source: 'builtin' }
}

function createModelCatalog({ codexstatus, claudemodels, claudeBin = 'claude', cacheFile = null, now = () => Date.now(), log = () => {} } = {}) {
  const live = { codex: null, claude: null } // { at, data }
  const inflight = { codex: null, claude: null }
  const fetchers = {
    codex: async () => { const l = await codexstatus.listModels('codex'); return Array.isArray(l) && l.length ? l : null },
    claude: async () => (claudemodels && typeof claudemodels.probeModels === 'function' ? claudemodels.probeModels(claudeBin) : null),
  }
  const register = (kind, data) => {
    try {
      if (kind === 'codex') setModelNames(data.map((m) => ({ id: m.model, name: m.name })))
      else setModelNames(data.models)
    } catch { /* 名称登记失败只影响显示 */ }
  }
  // 存盘的上次结果:at 记 0 ⇒ 第一次用到就后台再刷一次
  if (cacheFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      for (const k of ['codex', 'claude']) if (saved && saved[k] && saved[k].data) { live[k] = { at: 0, data: saved[k].data, saved: true }; register(k, saved[k].data) }
    } catch { /* 没有 / 坏了就当没有 */ }
  }
  const persist = () => {
    if (!cacheFile) return
    try {
      const out = {}
      for (const k of ['codex', 'claude']) if (live[k]) out[k] = { at: live[k].at || now(), data: live[k].data }
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      const tmp = cacheFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(out))
      fs.renameSync(tmp, cacheFile)
    } catch (e) { log('可选型号存盘失败: ' + (e && e.message)) }
  }
  const refresh = (kind) => {
    if (!inflight[kind]) {
      inflight[kind] = Promise.resolve().then(() => fetchers[kind]()).catch(() => null)
        .then((data) => {
          if (data) { live[kind] = { at: now(), data }; register(kind, data); persist() }
          else log(`${kind === 'codex' ? 'codex' : 'Claude'} 可选型号探测失败 —— 沿用上次结果(如有)`)
        })
        .finally(() => { inflight[kind] = null })
    }
    return inflight[kind]
  }
  // 有结果就先用、过期了后台再刷;从没取到过(也没存盘)才等这一次
  async function get(kind) {
    const c = live[kind]
    if (c) { if (now() - c.at >= TTL) refresh(kind); return c.data }
    await refresh(kind)
    return live[kind] ? live[kind].data : null
  }
  const sourceOf = (kind) => (live[kind] && live[kind].saved && !live[kind].at ? 'saved' : 'live')

  async function catalog(name, provider) {
    const p = provider || {}
    if (p.runner === 'codex') {
      const list = await get('codex')
      if (!list) return { ok: false, models: [], aliases: [], efforts: CODEX_LEGAL.slice(1), recommended: { model: '', effort: '' } }
      const models = list.map((m) => ({
        id: m.model,
        ...(m.name ? { name: m.name } : {}),
        efforts: (m.efforts || []).filter((e) => CODEX_LEGAL.includes(e)),
        ...(m.defEffort && CODEX_LEGAL.includes(m.defEffort) ? { defEffort: m.defEffort } : {}),
      }))
      const star = list.find((m) => m.isDefault) || list[0]
      const cat = { ok: true, models, aliases: [], efforts: CODEX_LEGAL.slice(1), source: sourceOf('codex') }
      cat.recommended = { model: star.model, effort: '' }
      cat.recommended.effort = recommendEffort(cat, star.model)
      return cat
    }
    if (isDeepSeek(p)) return deepSeekCatalog(p)
    if (!p.baseUrl) {
      const d = await get('claude')
      if (d && Array.isArray(d.models) && d.models.length) {
        const models = d.models.map((m) => ({ id: m.id, name: m.name, ...(m.effort !== false && m.efforts && m.efforts.length ? { efforts: m.efforts.slice() } : {}) }))
        const cat = { ok: true, models, aliases: [], aliasOf: { ...(d.aliasOf || {}) }, efforts: CLAUDE_EFFORTS.slice(), source: sourceOf('claude') }
        cat.recommended = { model: d.recommended || models[0].id, effort: CLAUDE_EFFORT }
        cat.recommended.effort = recommendEffort(cat, cat.recommended.model) // xhigh 不在这型号的档里才换
        return cat
      }
      // 从没拿到过实时清单(没登录 / CLI 太老 / 超时)⇒ 内置候选 + 本机账号额外项 + 官方别名
      let ids = []
      try { ids = claudemodels.mergeModels(claudemodels.readExtraModels()).map((m) => m.id).filter(Boolean) } catch { ids = claudemodels.BUILTIN.map((m) => m.id).filter(Boolean) }
      return { ok: true, models: ids.map((id) => ({ id })), aliases: CLAUDE_ALIASES.slice(), efforts: CLAUDE_EFFORTS.slice(), recommended: { model: ids[0] || '', effort: CLAUDE_EFFORT }, source: 'builtin' }
    }
    return { ok: true, models: null, aliases: [], efforts: CLAUDE_EFFORTS.slice(), recommended: { model: '', effort: CLAUDE_EFFORT } }
  }
  // 守护进程启动时预热(有哪家的卡才探哪家):第一张模型卡 / 第一次打开群卡就不用等探测
  catalog.warm = (kinds = ['codex']) => Promise.all(kinds.filter((k) => fetchers[k]).map((k) => refresh(k)))
  // 原始清单(控制台 /api/codex/models · /api/claude/models 用:要 isDefault / 说明这些字段)+ 它是不是实时的
  catalog.raw = async (kind) => ({ data: fetchers[kind] ? await get(kind) : null, source: live[kind] ? sourceOf(kind) : 'none' })
  return catalog
}

module.exports = { isDeepSeek, deepSeekCatalog, createModelCatalog, CLAUDE_EFFORTS, CODEX_LEGAL, CLAUDE_ALIASES }
