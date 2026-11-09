'use strict'

// 卡片进度:里程碑 · 「最近在做」· 脉搏文案(纯函数)。
// 发行宿主(v2engine)与卡片收尾共用一份。只做展示,不参与任何收据或效果判定。
// 卡片文案与旧引擎逐字一致,便于逐字对照。

// 长任务的「活着」信号与「做到哪了」。⚠ 只在卡里滚动,不另发消息 —— 群里多一条就是一次刷屏。
const T = {
  // 迟迟没动静时先回一声:填进本来就要建的那张流式卡,答案到了原地替换 —— 不多发消息。
  // 文案过零工具名,且不说「马上/很快」这类无法兑现的承诺。
  ackWorking: '⏳ 已收到,正在处理…',
  // 「最近动静」只在**停滞**时才有信息量 ⇒ 超过 cardPulseStaleMs(默认 2 分钟)没动静才追加。
  // 还没调过任何工具时退回「处理中 · 已跑」。
  pulse: (ran, doing, stale) => (doing && doing.length ? `⏳ 已跑 ${ran} · ${T.pulseDoing(doing)}` : `⏳ 处理中 · 已跑 ${ran}`) + (stale ? ` · 最近动静 ${stale}前` : ''),
  // 由工具调用**确定性**推出(describeTool),模型一个字不说也有东西看。脉搏与 /status 共用。
  // 只给文件名不给路径、不给命令内容 —— 群面零机器路径。
  pulseDoing: (list) => `最近在做:${list.join(' · ')}`,
}

// 脉搏「已跑多久」:分钟粒度够用(卡片底部那行的耗时另算到秒)。
function humanDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
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
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''
function describeTool(name, input = {}) {
  const n = String(name || '')
  const inp = input && typeof input === 'object' ? input : {}
  const file = baseName(inp.file_path || inp.path || inp.notebook_path)
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
function autoMilestone(name, input = {}) {
  const n = String(name || '')
  const inp = input && typeof input === 'object' ? input : {}
  // 路径里带 shell 变量(`$OUT`)或命令替换 ⇒ 名字解不出来,只报动作不报名
  const fileMs = (verb, raw) => { const p = unquote(raw); const f = baseName(p); return f && !TMP_PATH_RE.test(p) && !/[$`]/.test(p) ? `${verb} ${f}` : null }
  const target = inp.file_path || inp.path || inp.notebook_path
  switch (n) {
    case 'Write': return fileMs('写了', target)
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return fileMs('改了', target)
    case 'Bash': break
    default: return null
  }
  const cmd = String(inp.command || '')
  const grab = (re) => { const m = re.exec(cmd); return m ? m[1] : '' }
  let a
  // 平台基础技能的命令名不写死(sbot feishu / sbot wecom …):里程碑只认动作名
  if ((a = grab(new RegExp('\\bsbot\\s+[a-z]+\\s+send-file\\s+' + SH_ARG)))) return fileMs('已发文件', a) || '已发文件到群'
  if ((a = grab(new RegExp('\\bsbot\\s+[a-z]+\\s+send-image\\s+' + SH_ARG)))) return fileMs('已发图片', a) || '已发图片到群'
  if (/\bsbot\s+[a-z]+\s+send-notice\b/.test(cmd)) return '已发通知到群'
  if (/\bsbot\s+[a-z]+\s+send-msg\b/.test(cmd)) return '已发消息到群'
  if (/\bsbot\s+feishu\s+board-add-(?:image|diagram|nodes)\b/.test(cmd)) return '已上画布'
  if (/\bsbot\s+imagen\s/.test(cmd) && /--out\b/.test(cmd)) return '已提交生图'
  if (/\bsbot\s+preview\s+start\b/.test(cmd)) return '已开预览'
  if (/\bgit\s+(?:-C\s+\S+\s+)?push\b/.test(cmd)) return '已推送远端'
  if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd)) return '已提交代码'
  if ((a = grab(new RegExp('--print-to-pdf=' + SH_ARG)))) return fileMs('已出 PDF', a) || '已出 PDF'
  if (/--print-to-pdf\b/.test(cmd)) return '已出 PDF'
  if ((a = grab(new RegExp('(?:^|[\\s;&|(])cat\\s*>{1,2}\\s*' + SH_ARG)))) return fileMs('写了', a)
  return null
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

module.exports = { T, humanDur, MILESTONE_MAX, milestonesOf, renderMilestones,
  stripMilestones, describeTool, autoMilestone, pushDoing }
