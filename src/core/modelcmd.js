'use strict'
// 群命令 /model 的词法。纯函数 —— core 不认 runner 名:哪家有什么型号 / 深度,由 bin 注入的
// modelCatalog 给出形状 { ok, models: [{ id, efforts? }] | null, aliases: [], efforts: [] }(models 为 null = 这家
// 没有可选清单,型号只能在后台改)。
//
// 写法:`/model` 后面的每个词各自**精确**匹配一类(大小写不敏感,顺序随意,每类最多一个):
//   后端(模型卡名)· 深度(档位名)· 型号(目标后端清单里的 id 或别名)。
//   没有「默认」可回(模型卡上不再有默认型号 / 深度,⇒「默认 / default」不再是重置词,当认不出的词整条拒绝。
// ⚠ **不做模糊匹配**(口径):认不出一个词就整条拒绝、一项都不改 —— 换错模型 = 换了花的钱,
//   宁可让人重发一条也不猜;此前「只认第一个词、后面的悄悄扔掉」正是要修的坑(`/model claude sonnet` 丢了 sonnet)。
// 型号可以照显示名打:`/model opus-5.5` · `/model Opus 5.5` · `/model claude-opus-5-5` · `/model GPT-6.1 Terra` 是对应的同一个 ——
//   比对键见 core/modelname.js modelKey(大小写、claude- 前缀、点 / 连字符 / 空格不算),仍是拿清单**逐个精确比对**;
//   两个清单项归一后撞了键 ⇒ 当认不出(不替人挑)。「Opus 5.5」被空格拆成两个词:一个词后面紧跟纯版本号(5.5 / 4.8)
//   或变体((1M) / [1m])就并回一个词。

const { modelKey } = require('./modelname')

// 识别为「深度」这一类的词(能不能用再按目标后端 / 型号查)。Claude Code 的五档 + Codex 服务端认的两档低档。
const EFFORT_WORDS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const VERSION_RE = /^\d+(?:[.-]\d+)*$/
const VARIANT_RE = /^[[(][a-z0-9]+[\])]$/i

// 「Opus 5.5 (1M)」「GPT-6.1 Terra」这类被空格拆开的显示名并回一个词:字母结尾 + 纯版本号 · 数字结尾 + 变体 ·
// 数字结尾 + 纯字母词(Codex 官方名称「GPT-6.1 Terra」照着打被拆成两个词、整条拒绝)。
// 只在型号类的词之间并:后端名 / 深度词不并、也不被并(`/model gpt-6-luna low` 的 low 仍是深度)。
function joinVersionWords(words, isOther) {
  const out = []
  for (const raw of words || []) {
    const w = String(raw || '').trim()
    if (!w) continue
    const prev = out[out.length - 1]
    const glue = prev !== undefined && !isOther(prev) && !isOther(w) && (
      VERSION_RE.test(w) ? /[a-z]$/i.test(prev)
        : VARIANT_RE.test(w) ? /\d$/.test(prev)
          : /^[a-z]+$/i.test(w) && /\d$/.test(prev))
    if (glue) out[out.length - 1] = prev + ' ' + w
    else out.push(w)
  }
  return out
}

/**
 * @param words          命令后面的词
 * @param providerNames  群里可选的模型卡名(没隐藏的)
 * @returns {{ provider?, model?, models?, effort? } | { error: { kind: 'dup', what, a, b } }}
 *   model 原样保留大小写(查清单时再归一成清单里的写法);型号类写了不止一个 ⇒ models(调用方先逐个认,再判重)
 */
function parseModelWords(words, providerNames = []) {
  const names = new Map(providerNames.map((n) => [String(n).toLowerCase(), n]))
  const out = {}
  const isOther = (w) => { const lw = w.toLowerCase(); return names.has(lw) || EFFORT_WORDS.includes(lw) }
  for (const w of joinVersionWords(words, isOther)) {
    const lw = w.toLowerCase()
    if (names.has(lw)) {
      const n = names.get(lw)
      if (out.provider && out.provider !== n) return { error: { kind: 'dup', what: '后端', a: out.provider, b: n } }
      out.provider = n
    } else if (EFFORT_WORDS.includes(lw)) {
      if (out.effort && out.effort !== lw) return { error: { kind: 'dup', what: '深度', a: out.effort, b: lw } }
      out.effort = lw
    } else {
      // 型号这一类先都收下,由调用方按清单逐个认:两个词里有认不出的 ⇒ 报「认不出」(多半是打错 / 隐藏的后端名),
      // 都认得出才报「一次只能选一个型号」—— 否则 `/model claude sonnet`(claude 被隐藏)会得到一句莫名其妙的「写了两个型号」
      const ws = out.models || (out.models = [])
      if (!ws.some((x) => x.toLowerCase() === lw)) ws.push(w)
    }
  }
  if (out.models && out.models.length === 1) { out.model = out.models[0]; delete out.models }
  return out
}

// 词 → 清单里的规范写法(id 或别名);认不出 ⇒ null。先原样比(大小写不敏感),再按比对键比 —— 键撞了不止一项 ⇒ null(不替人挑)。
// 实时清单带 aliasOf(opus → claude-opus-5-5)⇒ 别名认成它此刻指向的**具体型号**存下(钉住,CLI 升级不悄悄换代);
//   官方显示名(「GPT-6.1 Terra」)也参与比对键 —— 照卡上 / 控制台看到的名字打就认。
function resolveModel(word, cat) {
  if (!word || !cat) return null
  const lw = String(word).toLowerCase()
  const models = (cat.models || []).map((m) => ({ id: String(m.id), name: m.name ? String(m.name) : '' }))
  const ids = [...models.map((m) => m.id), ...(cat.aliases || []).map(String)]
  const hit = ids.find((x) => x.toLowerCase() === lw)
  if (hit) return hit
  const aliasOf = cat.aliasOf && typeof cat.aliasOf === 'object' ? cat.aliasOf : {} // 别名走下面的比对键(大小写不敏感,与原样比等价)
  const k = modelKey(word)
  if (!k) return null
  const keyed = new Set(ids.filter((x) => modelKey(x) === k))
  for (const m of models) if (m.name && modelKey(m.name) === k) keyed.add(m.id)
  for (const a of Object.keys(aliasOf)) if (modelKey(a) === k && ids.includes(aliasOf[a])) keyed.add(aliasOf[a])
  return keyed.size === 1 ? [...keyed][0] : null
}

// 这家(某型号下)能选的深度:清单里该型号自带档位就用它的,否则用这家的通用档位
function effortsFor(cat, modelId) {
  const m = cat && modelId ? (cat.models || []).find((x) => x.id === modelId) : null
  return (m && Array.isArray(m.efforts) && m.efforts.length) ? m.efforts : ((cat && cat.efforts) || [])
}

// 群里列给人看的型号:别名在前(短、好打),再列完整 id
function modelChoices(cat) {
  if (!cat || !Array.isArray(cat.models)) return []
  return [...(cat.aliases || []), ...cat.models.map((m) => m.id)]
}

// 某型号的推荐深度:清单里它自带默认档(Codex defaultReasoningEffort)就用它的;否则这家的推荐档
// (cat.recommended.effort,Claude 系 xhigh);都不在这型号可选的档里 ⇒ high ⇒ 第一档。没有清单 ⇒ ''。
function recommendEffort(cat, modelId) {
  if (!cat) return ''
  const list = effortsFor(cat, modelId)
  const m = modelId && Array.isArray(cat.models) ? cat.models.find((x) => x.id === modelId) : null
  for (const e of [m && m.defEffort, cat.recommended && cat.recommended.effort, 'high']) if (e && list.includes(e)) return e
  return list[0] || ''
}

// 补齐本群在目标后端上缺的选择(;群里 /model、模型卡、控制台群卡同一份)。没有「默认」之后,缺项不再静静跟随模型卡:
//   换后端且那一家**实际生效的**型号是空的(没选过、也没有迁移前遗留的卡上默认;第三方除外)⇒ 推荐型号;
//   换后端 / 换型号时实际生效的深度是空的、或新型号没有这一档 ⇒ 这型号的推荐档。
//   只调深度不补型号(补了就换脑、开新对话,与「只调深度接着聊」冲突)。返回 { model, effort, filled: ['型号','深度'] }。
function fillPicks({ switching = false, model, effort, currentModel = '', currentEffort = '', third = false, cat = null } = {}) {
  const filled = []
  const rec = cat && cat.ok !== false && cat.recommended ? cat.recommended : null
  if (switching && model === undefined && !currentModel && !third && rec && rec.model) { model = rec.model; filled.push('型号') }
  const next = model === undefined ? currentModel : model
  if (effort === undefined && cat && cat.ok !== false && (switching || model !== undefined)) {
    const effs = effortsFor(cat, next)
    if (!currentEffort || (effs.length && !effs.includes(currentEffort))) {
      const e = recommendEffort(cat, next)
      if (e && e !== currentEffort) { effort = e; if (!currentEffort) filled.push('深度') }
    }
  }
  return { model, effort, filled }
}

module.exports = { parseModelWords, resolveModel, effortsFor, modelChoices, recommendEffort, fillPicks, EFFORT_WORDS }
