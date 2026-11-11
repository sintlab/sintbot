'use strict'
// 型号的显示名与输入比对。**只管给人看与人怎么打**:配置里存的、传给 CLI 的、账本 / 审计 / 日志 / 自知清单里写的
// 一律仍是正式 id(`claude-opus-5-5`)—— 正式 id 不能省 `claude-`、版本号是连字符不是点,写成 `opus-5.5` 交给 CLI 不保证认。
//
// 显示规则统一一种短写法:
//   claude-<家族>-<主版本>[-<次版本>][-<日期>][[变体]] → 「Opus 5.5」;日期后缀不显示;变体 [1m] → 「Fable 5.1 (1M)」
//   Claude Code 官方别名 opus / sonnet / haiku(指向当前最新)→「Opus(最新)」
//   deepseek / GLM / MiniMax 同一规则;GPT 等其余原样(本来就短)
// ⚠ 控制台同一份:server 把 modelDisplayName.toString() 注入 console.html(占位 /*__SBOT_MODELNAME__*/)⇒ 这个函数必须**自包含**
//   (不引用模块里别的变量 / 函数),改它时单测会在注入后的页面里再跑一遍同一组例子。

function modelDisplayName(id) {
  const raw = String(id == null ? '' : id).trim()
  if (!raw) return ''
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
  const title = (s) => s.split('-').map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(' ')
  const vt = (v) => (v ? ' (' + v.toUpperCase() + ')' : '')
  const al = raw.match(/^(opus|sonnet|haiku)$/i)
  if (al) return cap(al[1]) + '(最新)'
  // 次版本最多 3 位且后面不再跟数字:带日期的老 id(claude-sonnet-4-20250514)不会被读成 4.20250514
  const cm = raw.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,3})(?!\d))?(?:-\d{4,})?(?:\[(\w+)\])?$/i)
  if (cm) return cap(cm[1]) + ' ' + cm[2] + (cm[3] ? '.' + cm[3] : '') + vt(cm[4])
  const dm = raw.match(/^deepseek-(v\d+(?:-\w+)?|chat|reasoner)(?:\[(\w+)\])?$/i)
  if (dm) return 'DeepSeek ' + title(dm[1]) + vt(dm[2])
  const gm = raw.match(/^(glm|chatglm)[-_]([\w.]+(?:-\w+)?)(?:\[(\w+)\])?$/i)
  if (gm) return (gm[1].toLowerCase() === 'chatglm' ? 'ChatGLM' : 'GLM') + ' ' + title(gm[2]) + vt(gm[3])
  const mm = raw.match(/^(MiniMax|abab)(?:-(\w[\w.-]*))?(?:\[(\w+)\])?$/)
  if (mm) return (mm[1] === 'abab' ? 'ABAB' : 'MiniMax') + (mm[2] ? ' ' + title(mm[2]) : '') + vt(mm[3])
  return raw
}

// 输入比对键:大小写、开头的 claude-、点 / 连字符 / 空格都不算;结尾的变体 [1m] / (1M) 单独保留(有没有 1M 是两个型号)。
//   claude-opus-5-5 · opus-5.5 · opus5.5 · Opus 5.5 → opus55;claude-fable-5-1[1m] · Fable 5.1 (1M) → fable51[1m]
//   显示名「Opus(最新)」里的中文括注不是变体 ⇒ 去掉后就是别名 opus。
function modelKey(s) {
  let t = String(s == null ? '' : s).trim().toLowerCase()
  let v = ''
  const vm = t.match(/\s*[[(]\s*([a-z0-9]+)\s*[\])]\s*$/)
  if (vm) { v = vm[1]; t = t.slice(0, vm.index) }
  t = t.replace(/^claude[-_\s]+/, '').replace(/[^a-z0-9]/g, '')
  return t ? t + (v ? '[' + v + ']' : '') : ''
}

// 官方显示名登记:两家 CLI 的实时清单拿到就登记(src/modelcatalog.js)—— 有登记的按官方名称显示
// (Claude「Opus 5.5」、Codex「GPT-6.1-Sol」),没登记的(第三方、清单外的老型号)再按上面的规则拼。
// 进程内一份:守护进程里引擎与控制台同进程,共用;控制台页面拿 /api/state 的 modelNames。
const NAMES = new Map()
function setModelNames(list) {
  for (const x of list || []) {
    const id = x && String(x.id || '').trim()
    const name = x && String(x.name || '').trim()
    if (id && name && name.length <= 60) NAMES.set(id, name)
  }
}
function modelName(id) {
  const k = String(id == null ? '' : id).trim()
  return (k && NAMES.get(k)) || modelDisplayName(k)
}
const knownModelNames = () => Object.fromEntries(NAMES)

module.exports = { modelDisplayName, modelKey, modelName, setModelNames, knownModelNames }
