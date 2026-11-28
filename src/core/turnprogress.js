'use strict'

// 卡片进度:里程碑 · 「最近在做」· 脉搏文案(纯函数)。
// 发行宿主(v2engine)与卡片收尾共用一份;纯文字平台(Slack)的进度消息(core/plainprogress.js)
// 也用这里的步骤与标题。只做展示,不参与任何收据或效果判定。
// 卡片文案与旧引擎逐字一致,便于逐字对照。

// 长任务的「活着」信号与「做到哪了」。⚠ 只在卡里滚动,不另发消息 —— 群里多一条就是一次刷屏。
const T = {
  // 迟迟没动静时先回一声:填进本来就要建的那张流式卡,答案到了原地替换 —— 不多发消息。
  // 文案过零工具名,且不说「马上/很快」这类无法兑现的承诺。
  // 进度行只留符号、时长和正在做的事(用户 2026-11-25:措辞收短):卡片出现本身就是「已收到」,◐ 就是「在跑」。
  ackWorking: '◐ 处理中…',
  // 「多久没动静」只在**停滞**时才有信息量 ⇒ 超过 cardPulseStaleMs(默认 2 分钟)没动静才追加。
  pulse: (ran, doing, stale) => `◐ ${ran}` + (doing && doing.length ? ` · ${T.pulseDoing(doing)}` : '') + (stale ? ` · ${stale}没动静` : ''),
  // 由工具调用**确定性**推出(describeTool),模型一个字不说也有东西看。
  // 只给文件名不给路径、不给命令内容 —— 群面零机器路径。
  pulseDoing: (list) => list.join(' · '),
  // 纯文字平台(Slack)的进度消息标题:跑的时候写已跑多久(到秒),停滞时补「多久没动静」;
  // 结束时改成怎么收的尾。步数是工具调用次数,与 /status 的「已执行 N 步」同一个数。
  plainWorking: (ran, stale) => `处理中 · ${ran}` + (stale ? ` · ${stale}没动静` : ''),
  plainDone: (steps, ran) => `完成${steps > 0 ? ` · ${steps} 步` : ''} · ${ran}`,
  plainStopped: '已停止',
  plainFailed: '未完成',
}
// 英文会话(`groups[chatId].lang = 'en'`)的同一组卡片文案;键与上面一一对应。
const T_EN = {
  ackWorking: '◐ Working…',
  pulse: (ran, doing, stale) => `◐ ${ran}` + (doing && doing.length ? ` · ${T_EN.pulseDoing(doing)}` : '') + (stale ? ` · quiet for ${stale}` : ''),
  pulseDoing: (list) => list.join(' · '),
  plainWorking: (ran, stale) => `Working on it · ${ran}` + (stale ? ` · quiet for ${stale}` : ''),
  plainDone: (steps, ran) => `Done${steps > 0 ? ` · ${steps} ${steps === 1 ? 'step' : 'steps'}` : ''} · ${ran}`,
  plainStopped: 'Stopped',
  plainFailed: "Didn't finish",
}
const textsFor = (lang) => (lang === 'en' ? T_EN : T)

// 进度消息标题里的耗时:到秒(每次脉搏都在走),一小时以上到分。
function elapsed(ms, lang = 'zh') {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (lang === 'en') return s < 60 ? `${s}s` : m < 60 ? `${m}m ${s % 60}s` : `${h}h ${m % 60}m`
  return s < 60 ? `${s} 秒` : m < 60 ? `${m} 分 ${s % 60} 秒` : `${h} 小时 ${m % 60} 分`
}

// 脉搏「已跑多久」:分钟粒度够用(卡片底部那行的耗时另算到秒)。
function humanDur(ms, lang = 'zh') {
  const s = Math.max(0, Math.round(ms / 1000))
  if (lang === 'en') {
    if (s < 60) return `${s} s`
    const mins = Math.floor(s / 60)
    if (mins < 60) return `${mins} min`
    const hrs = Math.floor(mins / 60)
    return mins % 60 ? `${hrs} h ${mins % 60} min` : `${hrs} h`
  }
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`
}

// ── 里程碑与「最近在做」─────────────────────────────────────────────────────
// 模型每完成一个阶段输出一行 `>> …`,引擎认它 —— 跑的时候随打字机进卡(显示成 ▶),收尾收进卡片
// 折叠区,不再被「只留最后一段」丢掉。判据收在这里,不散在三处(打字机 / 脉搏 / 收尾)。
const MILESTONE_MAX = 12
const MILESTONE_RE = /^>>\s*(.*\S)\s*$/
// 逐行扫、跳过代码围栏 —— shell 的 `>> file` 与 Python 的 `>>>` 都可能出现在代码块里。
function scanMilestoneLines(text, onLine) {
  let fence = false
  for (const line of String(text || '').split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; onLine(line, null); continue }
    const m = fence ? null : MILESTONE_RE.exec(line)
    onLine(line, m ? m[1] : null)
  }
}
// 本轮全部里程碑(去重、封顶),从流式全量文本里取 —— 中途说的与收尾说的都算。
function milestonesOf(text) {
  const out = []
  scanMilestoneLines(text, (_l, m) => { if (m && !out.includes(m) && out.length < MILESTONE_MAX) out.push(m) })
  return out
}
// 打字机 / 脉搏用:`>> ` 原地换成 ▶(不换的话 markdown 会把 `>>` 渲染成嵌套引用)。
function renderMilestones(text) {
  const lines = []
  scanMilestoneLines(text, (l, m) => lines.push(m == null ? l : '▶ ' + m))
  return lines.join('\n')
}
// 收尾用:正文里的里程碑行剔掉(它们进折叠区),只剩答案。
function stripMilestones(text) {
  const lines = []
  scanMilestoneLines(text, (l, m) => { if (m == null) lines.push(l) })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
// 「最近在做」:一次工具调用 → 一句人话。只给文件名不给路径(群面零机器路径);命令内容不给
// (那是 agent 写的,可能带机器路径);插件按名字;认不出的返回 null,不拿框架里的工具名去凑数。
// codex 的工具名经 codexcode 映射后与 claude 同形(Bash / Write / MCP)。
// 英文会话(lang = 'en')同一张表的英文说法:reading a.js · running a command(/status 的 Recently 一行)。
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''
function describeToolEn(n, inp, file) {
  const withFile = (verb) => (file ? `${verb} ${file}` : `${verb} a file`)
  const mcp = /^mcp__(.+?)__/.exec(n)
  if (mcp) return `using plugin ${mcp[1]}`
  switch (n) {
    case 'Read': return withFile('reading')
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return withFile('editing')
    case 'Write': return withFile('writing')
    case 'Delete': return withFile('deleting')
    case 'Bash': return 'running a command'
    case 'Glob': case 'Grep': case 'FileSearch': return 'searching the code'
    case 'WebFetch': case 'WebSearch': return 'looking things up on the web'
    case 'Task': case 'Agent': return 'running a subtask'
    case 'MCP': return `using a plugin${inp.server ? ' ' + baseName(inp.server) : ''}`
    default: return null
  }
}
function describeTool(name, input = {}, lang = 'zh') {
  const n = String(name || '')
  const inp = input && typeof input === 'object' ? input : {}
  const file = baseName(inp.file_path || inp.path || inp.notebook_path)
  if (lang === 'en') return describeToolEn(n, inp, file)
  const withFile = (verb) => (file ? `${verb} ${file}` : `${verb}文件`)
  const mcp = /^mcp__(.+?)__/.exec(n)
  if (mcp) return `用插件 ${mcp[1]}`
  switch (n) {
    case 'Read': return withFile('看')
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return withFile('改')
    case 'Write': return withFile('写')
    case 'Delete': return withFile('删')
    case 'Bash': return '跑命令'
    case 'Glob': case 'Grep': case 'FileSearch': return '搜代码'
    case 'WebFetch': case 'WebSearch': return '查网页'
    case 'Task': case 'Agent': return '派子任务'
    case 'MCP': return `用插件${inp.server ? ' ' + baseName(inp.server) : ''}`
    default: return null
  }
}
// ── 确定性里程碑 ──────────────────────────────────────────────────────────────
// 「最近在做」只滚最近 3 条,回答的是「还活着吗」;这里回答「做到哪了」:从工具调用里只认**交付类**
// 动作(写 / 改文件 · 发到群 · 上画布 / 生图 / 预览 · git 提交推送 · 出 PDF),累积、去重、封顶,
// 与模型自己的 `>> ` 行并排进卡、收尾同进折叠区。只给文件名不给路径,临时目录里的脚本不算
// (那是它写给自己用的),命令内容不给 —— 群面零机器路径。一次 Bash 只记最重的一条。
const TMP_PATH_RE = /^(?:\/private)?\/tmp\/|^\/var\/folders\/|^\$TMPDIR|^%TEMP%|\\Temp\\/i
const unquote = (s) => String(s || '').trim().replace(/^(["'])(.*)\1$/, '$2')
const SH_ARG = '("[^"]+"|\'[^\']+\'|[^\\s;|&<>]+)'
// 给人看的字按会话语言取(lang = 'en' 是英文会话);判据只有一套。
const MILESTONE_WORDS = {
  zh: { wrote: '写了', edited: '改了', sentFile: '已发文件', sentFileChat: '已发文件到群', sentImage: '已发图片', sentImageChat: '已发图片到群',
    sentNotice: '已发通知到群', sentMsg: '已发消息到群', board: '已上画布', imagen: '已提交生图', preview: '已开预览',
    pushed: '已推送远端', committed: '已提交代码', pdf: '已出 PDF' },
  en: { wrote: 'Wrote', edited: 'Edited', sentFile: 'Sent file', sentFileChat: 'Sent a file to the chat', sentImage: 'Sent image', sentImageChat: 'Sent an image to the chat',
    sentNotice: 'Sent a notice to the chat', sentMsg: 'Sent a message to the chat', board: 'Added to the board', imagen: 'Requested an image', preview: 'Started a preview',
    pushed: 'Pushed to the remote', committed: 'Committed code', pdf: 'Made PDF' },
}
function autoMilestone(name, input = {}, lang = 'zh') {
  const W = lang === 'en' ? MILESTONE_WORDS.en : MILESTONE_WORDS.zh
  const n = String(name || '')
  const inp = input && typeof input === 'object' ? input : {}
  // 路径里带 shell 变量(`$OUT`)或命令替换 ⇒ 名字解不出来,只报动作不报名
  const fileMs = (verb, raw) => { const p = unquote(raw); const f = baseName(p); return f && !TMP_PATH_RE.test(p) && !/[$`]/.test(p) ? `${verb} ${f}` : null }
  const target = inp.file_path || inp.path || inp.notebook_path
  switch (n) {
    case 'Write': return fileMs(W.wrote, target)
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return fileMs(W.edited, target)
    case 'Bash': break
    default: return null
  }
  const cmd = String(inp.command || '')
  const grab = (re) => { const m = re.exec(cmd); return m ? m[1] : '' }
  let a
  // 平台基础技能的命令名不写死(sbot feishu / sbot wecom …):里程碑只认动作名
  // The release entry runs as `'<node>' '<…>/sintbot-v2.js' feishu send-file …`,
  // an older one as `sbot feishu …`: both name the skill the same way.
  const SKILL = "(?:\\bsbot|\\bsintbot(?:-v2\\.js)?['\"]?)\\s+[a-z]+\\s+"
  if ((a = grab(new RegExp(SKILL + 'send-file\\s+' + SH_ARG)))) return fileMs(W.sentFile, a) || W.sentFileChat
  if ((a = grab(new RegExp(SKILL + 'send-image\\s+' + SH_ARG)))) return fileMs(W.sentImage, a) || W.sentImageChat
  if (new RegExp(SKILL + 'send-notice\\b').test(cmd)) return W.sentNotice
  if (new RegExp(SKILL + 'send-msg\\b').test(cmd)) return W.sentMsg
  if (/\bsbot\s+feishu\s+board-add-(?:image|diagram|nodes)\b/.test(cmd)) return W.board
  if (/\bsbot\s+imagen\s/.test(cmd) && /--out\b/.test(cmd)) return W.imagen
  if (/\bsbot\s+preview\s+start\b/.test(cmd)) return W.preview
  if (/\bgit\s+(?:-C\s+\S+\s+)?push\b/.test(cmd)) return W.pushed
  if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd)) return W.committed
  if ((a = grab(new RegExp('--print-to-pdf=' + SH_ARG)))) return fileMs(W.pdf, a) || W.pdf
  if (/--print-to-pdf\b/.test(cmd)) return W.pdf
  if ((a = grab(new RegExp('(?:^|[\\s;&|(])cat\\s*>{1,2}\\s*' + SH_ARG)))) return fileMs(W.wrote, a)
  return null
}
// ── 谁在干活 ────────────────────────────────────────────────────────────────
// 运行中的回复在脉搏行下面列出主代理和每个在跑的子代理:
//   ● Main [Opus 5.5·XHigh]
//   ├ Sub [Sonnet 5.5·XHigh] 核对文档状态说法 · 3 分钟
//   │ └ Sub [Haiku 5.5·Med] 找调用方 · 20 秒
//   └ Sub [Opus 5.5·XHigh] 对比两版接口 · 12 秒
// 有哪些行、谁挂在谁下面、行首画什么、深度怎么写,是内置核心给的(agents_view);这里只把一行拼成字:
// 型号换成显示名(name 由调用方给,与页脚同一张名字表),耗时按会话语言。型号与深度都还不知道就不带方括号。
function agentRowText(row, { lang = 'zh', name = (id) => id } = {}) {
  const model = row.model ? String(name(row.model, lang) || '').replace(/[\x00-\x1f\x7f[\]]/g, '').replace(/\s+/g, ' ').trim() : ''
  const parts = [model, row.effort, row.speed === 'fast' ? 'Fast' : ''].filter(Boolean)
  return `${row.lead} ${row.role === 'main' ? 'Main' : 'Sub'}` + (parts.length ? ` [${parts.join('·')}]` : '') +
    (row.title ? ` ${row.title}` : '') + (row.ms == null ? '' : ` · ${humanDur(row.ms, lang)}`)
}

// 最多留 3 条、去重、最新在最后(脉搏与 /status 共用同一个列表)。
function pushDoing(list, d) {
  if (!d) return list
  const i = list.indexOf(d)
  if (i >= 0) list.splice(i, 1)
  list.push(d)
  while (list.length > 3) list.shift()
  return list
}

module.exports = { T, T_EN, textsFor, humanDur, elapsed, MILESTONE_MAX, milestonesOf, renderMilestones,
  stripMilestones, describeTool, autoMilestone, pushDoing, agentRowText }
