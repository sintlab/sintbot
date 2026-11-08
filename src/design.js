// 设计风格档 —— 群设计工作流的「风格」持久层(项目根 `DESIGN.md`)。
//
// 为什么要落成文件:一次设计任务里风格(色板/字体/版式/禁忌)是**跨轮跨任务复用**的东西,
// 靠对话记忆维持必然漂移;写进项目目录后,agent 每次出图前读一遍风格才稳得住,还能随项目
// 进 git 跟着演进。格式取通用写法:YAML front matter 放 tokens(colors/typography 等,机器读)
// + Markdown 正文写氛围、版式规则与 Do's and Don'ts(模型读)。
//
// ⚠ 本模块最要紧的一件事是 isStyleDoc「认帧」:很多项目根目录的 DESIGN.md 是**架构设计文档**
// (sbot 自己的仓库就是),把它当风格档覆盖掉就是数据事故 —— 故落盘目标一律先认帧再定,
// 认不出就退一层到 design/DESIGN.md,绝不硬写。
//
// 本文件只放纯逻辑(元信息解析 / 风格档判别 / 预设合并 / 落盘裁决 / 主色统计),CLI 接线在 bin。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 预设的两个来源。放这里而不是 bin:控制台也要列风格库,「CLI 与控制台同源」的纪律要求
// 目录口径只有一处 —— 两边各写一份 path.join,迟早有一处漏跟。
const BUILTIN_STYLES_DIR = path.join(__dirname, '..', 'assets', 'design-styles') // 随包安装(package.json files 含 assets/)
const userStylesDir = () => path.join(os.homedir(), '.sbot', 'design-styles') // 用户自定义,同 slug 覆盖内置

const DEFAULT_STYLE_REL = 'DESIGN.md'
const FALLBACK_STYLE_REL = path.join('design', 'DESIGN.md') // 根被架构文档占用时的落点

// front matter 行数组(不含围栏);首行不是 `---` 或围栏未闭合 ⇒ null(半截文件不当风格档,
// 认帧宁可漏认不可错认 —— 错认的代价是覆盖掉别人的文档)。
function _frontMatter(text) {
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/) // 去 BOM,否则首行认不出围栏
  if (lines[0].trim() !== '---') return null
  const out = []
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return out
    out.push(lines[i])
  }
  return null
}

// 值可能带引号(YAML 里含 `:` `#` 的值必须引起来),去掉成对的首尾引号即可 —— 这里不做
// 完整 YAML 解析:只取两个展示字段,复杂结构(嵌套 tokens)交给读文件的模型自己看。
function _unquote(v) {
  const s = String(v).trim()
  const m = /^(['"])([\s\S]*)\1$/.exec(s)
  return m ? m[2] : s
}

// 预设/风格档的展示元信息。缺字段给 ''(调用方决定怎么兜底,避免这里编内容)。
function parseStyleMeta(text) {
  const fm = _frontMatter(text) || []
  const out = { name: '', description: '', suits: '', platform: '', nameEn: '', descriptionEn: '' }
  for (const line of fm) {
    // suits(v0.9.5)= 适用场景标签。风格库涨到二十几种之后,agent 只看名字和一句话
    // 根本挑不准 —— 它得先知道「这套适合做什么」才筛得出该给用户看哪几个。
    // platform(v0.11.22)= **载体**,与 suits 是两个轴:suits 答「做什么」(内容阅读 /
    // 品牌门面…),platform 答「在哪儿看」(小程序 / 后台网站…)。一个小程序也可以是内容
    // 阅读向,两者不互斥,混进一张词表日后必然筛别扭。**留空 = 载体无关**,这是常态 ——
    // 内置那批(瑞士网格、新中式…)本来就不挑载体,一个都不用补标;只有明确绑死某个载体
    // 的档(某项目的小程序档 / 后台档)才写,那时它是**真信息**而不是凑出来的标签。
    // name_en / description_en = 控制台英文界面用的名字与一句话(内置预设都写了;自建档可不写,不写就显示原文)。
    // 只给人看:agent 挑风格、出图照旧读中文那两行。
    const m = /^(name|description|suits|platform|name_en|description_en):\s*(.*)$/.exec(line) // 行首=顶层键;缩进的同名子键不算
    const k = m && ({ name_en: 'nameEn', description_en: 'descriptionEn' }[m[1]] || m[1])
    if (m && !out[k]) out[k] = _unquote(m[2])
  }
  return out
}

// 是不是「设计风格档」= 开头有 front matter 且里面有顶层 `colors:`。判据挑 colors 是因为
// 色板是风格档的必备 token,而架构文档的 front matter(若有)不会有它 —— 这是区分同名
// DESIGN.md 的唯一自动信号。
function isStyleDoc(text) {
  const fm = _frontMatter(text)
  return !!fm && fm.some((l) => /^colors:/.test(l))
}

// 落盘裁决专用的读:**只有 ENOENT 才算「不存在」**。EACCES/EISDIR 等一律抛错拒绝继续 ——
// 「读不出内容」不等于「没有内容」,把不可读的根 DESIGN.md 当干净目标写下去,正是本模块
// 立誓要防的那种事故(fail-closed:认不出就不动手)。
function _readFileOrNull(abs) {
  try { return fs.readFileSync(abs, 'utf8') } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw new Error(`读不了 ${abs}(${(e && e.code) || (e && e.message)})—— 无法判断它是不是风格档,不敢写;请检查权限/路径后重试`)
  }
}

// 预设文件的读:损坏/不可读的单个预设跳过即可(列清单不是安全关口,不该因一个坏文件整体失败)
function _readPresetOrNull(abs) {
  try { return fs.readFileSync(abs, 'utf8') } catch { return null }
}

// 预设清单:内置目录(随包安装)+ 用户目录(~/.sbot/design-styles),同 slug 用户级覆盖内置
// (改一份自己的同名预设即可顶掉内置,不用改包内文件)。目录不存在/读不动一律当空,不报错。
// 故意**不**按 isStyleDoc 过滤:预设内容由另一路维护,格式偏差在这里会变成「一个都列不出」
// 的静默失败,不如照列 —— 真写坏了 use 之后人能一眼看见。
function listStyles({ builtinDir, userDir } = {}) {
  const byslug = new Map()
  for (const [dir, source] of [[builtinDir, 'builtin'], [userDir, 'user']]) {
    if (!dir) continue
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const file = path.join(dir, name)
      const text = _readPresetOrNull(file)
      if (text == null) continue
      const slug = name.slice(0, -3)
      const meta = parseStyleMeta(text)
      // name 缺失退回 slug:列表要能读,不能出现空白列(path 供调用方直接读全文,免得再拼一次)
      byslug.set(slug, { slug, name: meta.name || slug, description: meta.description, suits: meta.suits, platform: meta.platform, source, path: file })
    }
  }
  // 次序 = **自定义在前**,组内按 slug。内置十几种,operator 自己建的那两三套若按字母混在中间
  // 就得逐个找 —— 而它们恰恰是他最常用的(自己配的品牌款、从参考提炼的那份)。
  // ⚠ 排序只在这一处:两个消费者共用它 —— 控制台风格库(按 source 切成两块渲染)与 CLI
  //   `design styles`(先按场景分组,这条定的是组内先后)。各写一份次序必漂移。
  const rank = (s) => (s.source === 'user' ? 0 : 1)
  return [...byslug.values()].sort((a, b) => rank(a) - rank(b) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
}

// 项目当前的风格档绝对路径(没有则 null)。**根与降级点都要过 isStyleDoc** —— 它的返回值
// 会被喂给生图后端当风格依据,拿一份架构文档去当风格档只会把画面带偏;与 resolveStyleTarget
// 认的是同一套帧,两者永远看的是同一个文件。读不动(权限等)在这里按「没有」处理并继续:
// 这是可选增强不是安全关口,不该让一个读不了的文件把生图整条链堵死(裁决那侧仍 fail-closed)。
function findStyleDoc({ cwd, readFile = _readFileOrNull } = {}) {
  const root = path.resolve(cwd || process.cwd())
  for (const rel of [DEFAULT_STYLE_REL, FALLBACK_STYLE_REL]) {
    const abs = path.join(root, rel)
    let text = null
    try { text = readFile(abs) } catch { continue }
    if (text != null && isStyleDoc(text)) return abs
  }
  return null
}

// 落盘目标裁决(不写盘,只裁决):返回 { path 绝对路径, note 说明 } 或抛中文错误。
// readFile 注入(默认读真实文件系统)⇒ 纯逻辑可单测。三条铁律:
//   ① **--force 只覆盖风格档**(isStyleDoc 为真)。非风格档一律拒 —— force 的语义是「这份风格档
//      我要换掉」,不是「清掉挡路的文件」;群 agent 在只读档也能跑本命令,不能留下「拿 --force
//      写任意路径」的覆盖通道。
//   ② --out 只收 cwd 内的相对 `.md` 路径(围栏 + 扩展名):风格档就是 Markdown,限死扩展名等于
//      把「覆盖 src/app.js」这类玩法从入口挡掉。
//   ③ 默认落点顺序 = 根 DESIGN.md → design/DESIGN.md,**已有风格档在哪就认哪**(不在根另立第二份:
//      旧档会成孤儿,而 findStyleDoc 只认第一份 ⇒ 之后改的和生图读的就不是同一个文件了)。
// ── 一个项目多份风格档(v0.11.22)────────────────────────────────────────────
// 此前一个项目只认一份。而一个项目常常同时有两块面(某项目:小程序 + 后台网站),它们的
// 圆角尺度、间距、正文字号、层级表达**没有一项相同** —— 压成一份档,数出来的众数不属于
// 任何一块,对两边都不准(实测过一份提炼出来的风格档:品牌绿被降级成「次要信息」)。
// 形态:`design/styles/<用途>.md`,每份靠 front matter 的 platform 说明自己管哪块。
// ⚠ 老位置(根 DESIGN.md / design/DESIGN.md)**仍然认**,存量项目零迁移 —— 它排在列表最前,
//   语义是「没指名道姓时就用它」。
const STYLES_DIR_REL = path.join('design', 'styles')
// ⚠ 这个上限**只作用于控制台那条路**(projectStyleCards):每份档背一张图元表,而群卡挂在
// /api/state 上、每个绑定群都下发一份,份数多了会撑爆心跳。**findStyleDocs 本身不截断** ——
// 它是清单与 CLI 吃的那条路,少列一份就等于告诉 agent「这个项目只有这些档」,而那是假话
// (静默截断被读成「已覆盖全部」,是本仓库反复踩过的那类)。
const MAX_PROJECT_STYLE_CARDS = 8
// 载体词 → 固定 ASCII 文件名。**文件名不用中文**:这些档要跟着项目进 git、跨 mac/Windows 同步,
// 中文文件名在那条路上迟早出事(编码、大小写、CI 容器 locale)。
const PLATFORM_SLUG = { 小程序: 'miniprogram', 后台网站: 'admin', 网页前台: 'web', '移动 App': 'app', 印刷物料: 'print' }

function _readDirOrNull(dir) {
  try { return fs.readdirSync(dir) } catch { return null }
}

function findStyleDocs({ cwd, readFile = _readFileOrNull, readDir = _readDirOrNull } = {}) {
  const root = path.resolve(cwd || process.cwd())
  const out = []
  const add = (abs, text) => {
    const meta = parseStyleMeta(text)
    out.push({ abs, rel: path.relative(root, abs), name: meta.name || path.basename(abs, '.md'), platform: meta.platform, suits: meta.suits })
  }
  const legacy = findStyleDoc({ cwd: root, readFile })
  if (legacy) { const t = readFile(legacy); if (t != null) add(legacy, t) }
  for (const name of (readDir(path.join(root, STYLES_DIR_REL)) || []).slice().sort()) {
    if (!name.endsWith('.md')) continue
    const abs = path.join(root, STYLES_DIR_REL, name)
    if (out.some((o) => o.abs === abs)) continue
    let text = null
    try { text = readFile(abs) } catch { continue }
    // 这里**按 isStyleDoc 过滤**(与 listStyles 的取舍相反):design/styles/ 是我们自己定义的
    // 位置,里面混进的非风格档喂给生图后端只会把画面带偏 —— 宁可不列。
    if (text != null && isStyleDoc(text)) add(abs, text)
  }
  return out
}

// 「这次用哪份风格档」的匹配(v0.11.22)。认三种写法:载体词(小程序)· 文件名(admin / admin.md)
// · 档里的 name。**没指名时不猜**:返回列表第一份(= 老位置那份通用档;没有则 design/styles 里
// 排第一的),而调用方必须把「这次用的是哪份」如实说出来 —— 悄悄挑一份是「做了 A 让人以为做了 B」。
function pickStyleDoc(docs, want) {
  const list = Array.isArray(docs) ? docs : []
  const w = String(want == null ? '' : want).trim()
  if (!w) return list[0] || null
  const lw = w.toLowerCase().replace(/\.md$/, '')
  const base = (d) => path.basename(String(d.rel || d.abs || ''), '.md').toLowerCase()
  // platform 可能是多值串(「小程序 · 后台网站」)⇒ 按分隔符拆开逐个比,别只认全等:
  // 一份档标了两个载体时,指名其中一个必须命中,否则就是「明明标了却说没有」
  const plats = (d) => String(d.platform || '').split('·').map((x) => x.trim()).filter(Boolean)
  return list.find((d) => plats(d).includes(w))
    || list.find((d) => base(d) === lw)
    || list.find((d) => String(d.name || '').toLowerCase() === lw)
    || (PLATFORM_SLUG[w] ? list.find((d) => base(d) === PLATFORM_SLUG[w]) : null)
    || null
}

// `--as <用途>` → 落到哪个文件 + 该写什么 platform。载体词走固定映射,其余按 slug 白名单收
// (`--as landing-2026` 这类自由用途名也允许 —— 一个项目的分面不见得都能落进那五个载体词)。
function resolveStyleAs(as) {
  const s = String(as == null ? '' : as).trim()
  if (!s) return null
  if (PLATFORM_SLUG[s]) return { slug: PLATFORM_SLUG[s], platform: s }
  if (!SLUG_RE.test(s)) {
    throw new Error(`--as 只能是载体词(${PLATFORM_WORDS.join(' / ')}),或一个小写英文用途名(如 landing-2026):${s}`)
  }
  return { slug: s, platform: '' }
}

// 往一份档里写 platform(与 withStyleName 同一套 front matter 改写手法)。
function withStylePlatform(text, platform) {
  const src = String(text == null ? '' : text)
  const p = _oneline(platform, 60)
  if (!p || !_frontMatter(src)) return src
  const lines = src.replace(/^\uFEFF/, '').split(/\r?\n/)
  let end = -1
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break }
  if (end < 0) return src
  for (let i = 1; i < end; i++) if (/^platform:\s*/.test(lines[i])) { lines[i] = 'platform: ' + _yq(p); return lines.join('\n') }
  lines.splice(1, 0, 'platform: ' + _yq(p))
  return lines.join('\n')
}

function resolveStyleTarget({ cwd, out, force = false, as = null, readFile = _readFileOrNull } = {}) {
  // `--as` 直接定文件名,不参与「根 DESIGN.md 可能是架构文档」那套降级裁决(design/styles/
  // 是我们自己的位置,不会撞上别人的文档);但**已存在时仍要 --force**,同一条不覆盖纪律。
  if (as) {
    const a = resolveStyleAs(as)
    const abs = path.join(path.resolve(cwd || process.cwd()), STYLES_DIR_REL, a.slug + '.md')
    let text = null
    try { text = readFile(abs) } catch { text = null }
    if (text != null) {
      if (!isStyleDoc(text)) throw new Error(`${path.join(STYLES_DIR_REL, a.slug + '.md')} 已经存在、而且不是风格档 —— 换个用途名,或先把它挪走`)
      if (!force) throw new Error(`${path.join(STYLES_DIR_REL, a.slug + '.md')} 已经有一份风格档了 —— 要覆盖请加 --force`)
    }
    return { path: abs, note: text != null ? '覆盖了这个用途下原有的风格档' : '', platform: a.platform }
  }
  return _resolveSingleStyleTarget({ cwd, out, force, readFile })
}

function _resolveSingleStyleTarget({ cwd, out, force = false, readFile = _readFileOrNull } = {}) {
  const root = path.resolve(cwd || process.cwd())
  // 已存在的落点统一判定:是风格档 ⇒ 要 --force;不是 ⇒ 一律拒(force 也不行)
  const judgeExisting = (rel, abs, text, note) => {
    if (!isStyleDoc(text)) throw new Error(`${rel} 已存在且不是风格档(front matter 里没有 colors)—— 不覆盖别的文档;换个落点:sbot design use <slug> --out <相对路径.md>`)
    if (!force) throw new Error(`${rel} 已有风格档 —— 确认要覆盖再加 --force`)
    return { path: abs, note: note ? note + ';覆盖已有风格档' : '覆盖已有风格档' }
  }
  if (out) {
    const rel = String(out)
    if (path.isAbsolute(rel)) throw new Error('--out 只接受项目目录内的相对路径,拒绝绝对路径:' + rel)
    if (rel.split(/[\\/]/).includes('..')) throw new Error("--out 路径不得包含 '..':" + rel)
    if (!/\.md$/i.test(rel)) throw new Error('--out 只能写 .md 文件(风格档是 Markdown):' + rel)
    const abs = path.resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('--out 路径超出项目目录:' + rel)
    const text = readFile(abs)
    if (text == null) return { path: abs, note: '' }
    return judgeExisting(rel, abs, text, '')
  }
  const rootAbs = path.join(root, DEFAULT_STYLE_REL)
  const fbAbs = path.join(root, FALLBACK_STYLE_REL)
  const rootText = readFile(rootAbs)
  if (rootText == null) {
    // 根空着,但降级点已有风格档 ⇒ 沿用它(见铁律③:别在根另立第二份把旧档甩成孤儿)
    const fbText = readFile(fbAbs)
    if (fbText != null && isStyleDoc(fbText)) return judgeExisting(FALLBACK_STYLE_REL, fbAbs, fbText, `沿用既有风格档位置 ${FALLBACK_STYLE_REL}`)
    return { path: rootAbs, note: '' }
  }
  if (isStyleDoc(rootText)) return judgeExisting(DEFAULT_STYLE_REL, rootAbs, rootText, '')
  // 根是架构设计文档(sbot 自己的仓库就是这样)—— 不动它,风格档退一层
  const note = `项目根 ${DEFAULT_STYLE_REL} 是架构文档(front matter 里没有 colors),不动它 —— 风格档改放 ${FALLBACK_STYLE_REL}`
  const fbText = readFile(fbAbs)
  if (fbText == null) return { path: fbAbs, note }
  return judgeExisting(FALLBACK_STYLE_REL, fbAbs, fbText, note)
}

// ── 参考图主色统计 ───────────────────────────────────────────────────────────
// 用途:用户丢一张参考图,从中提出色板写进风格档的 colors tokens(文本模型也用得上 ——
// 它看不见图,但拿得到这组十六进制)。零依赖:入参是解好的 RGBA 平面(PNG 解码在 board.js)。
const MAX_SAMPLES = 200_000 // 采样上限:大图逐像素统计慢且无必要,20 万点的分布已经很稳

function _hex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('').toUpperCase()
}

// 主色统计:stride 采样 → 每通道右移 4 位分桶(16³=4096 桶,近似色并成一档)→ 桶内取**均值色**
// (桶心会整体偏暗,均值才是这片颜色的真实代表)→ 近白/近黑/低饱和归 neutrals(底色与文字色,
// 否则任何截图的「主色」都是白底)→ 其余按占比取前 n。share = 占有效采样点(α≥128)的比例。
function extractPalette(px, width, height, { n = 6 } = {}) {
  const w = width | 0
  const total = Math.max(0, w * (height | 0))
  let step = Math.max(1, Math.ceil(total / MAX_SAMPLES))
  // ⚠ 线性跨步与行宽有公因子时会**整列漏采**(600 宽 step 2 ⇒ 只采偶数列,一条 1px 竖条纹的
  // 界面截图能被采成纯色)。与宽互素后每行的采样列都不同,扫完全图 ⇒ 无系统性偏置。
  while (step > 1 && w > 0 && w % step === 0) step++
  const buckets = new Map()
  let sampled = 0
  for (let i = 0; i < total; i += step) {
    const o = i * 4
    if (o + 3 >= px.length) break // 平面比声明的尺寸短:按已有数据算,不崩
    if (px[o + 3] < 128) continue // 透明/半透明像素不参与:那是背板不是画面
    const r = px[o]; const g = px[o + 1]; const b = px[o + 2]
    sampled++
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    let e = buckets.get(key)
    if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, e) }
    e.n++; e.r += r; e.g += g; e.b += b
  }
  const colors = []; const neutrals = []
  for (const e of buckets.values()) {
    const r = Math.round(e.r / e.n); const g = Math.round(e.g / e.n); const b = Math.round(e.b / e.n)
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b)
    const item = { hex: _hex(r, g, b), share: sampled ? e.n / sampled : 0 }
    if (mn >= 240 || mx <= 24 || mx - mn <= 14) neutrals.push(item)
    else colors.push(item)
  }
  const byShare = (a, b) => b.share - a.share
  return { colors: colors.sort(byShare).slice(0, n), neutrals: neutrals.sort(byShare).slice(0, n) }
}

// ── 风格可视化:tokens → 图标 ─────────────────────────────────────────────────
// 为什么要图标:8 种预设此前只有名字和一句话,「瑞士网格」和「新中式」在文字上都是「浅底深字
// 一点强调色」—— 选风格这件事本来就该看,看不见就只能靠想象。图标**全部由 front matter 的
// tokens 派生**(改了色板/圆角,图标当场跟着变),所以它不是插图而是这份风格档的一面镜子:
// 图标和实际产出对不上,说明风格档本身写歪了。
//
// 构图 = 微缩界面预览(参照 Stitch / Claude Design 的风格卡):底色 + 标题块 + 正文线 + 分隔线
// + 强调按钮 + 底部色板条。比纯色板条多出的信息是**关系** —— 文字与底的对比、强调色的用量、
// 圆角的性格。
//
// 两端共用一份几何(swatchLayout 出图元表):控制台拿它画 SVG,群图拿它光栅成 PNG。布局只写一
// 遍,两边永远同步 —— 若各写各的,改一处必然漏另一处,而「两个图标长得不一样」这种 bug 没人报。

// front matter 的完整 tokens(极简 YAML 子集:按缩进建树、标量去引号)。
// 与 parseStyleMeta 分开而不是替换它:后者是 listStyles 与 isStyleDoc 那条链上的东西,
// 「只取两个展示字段」是它的契约,不该为了出图标去动一个安全关口附近的函数。
// 不吃的语法(数组续行、多行标量、锚点)整行跳过 —— 风格档是给人写的 Markdown 元信息,
// 不是配置文件;解析不了的部分不影响出图,不该整体失败。
// ⚠ 唯一出口:先按原样建树,再把顶层 `fonts` 段合成到各档 `fontFamily`(applyFontsSegment,v0.11.68)。
//   挂在这里而不是让八个消费者各自去读 fonts 段 —— 「同一份策略多个消费者各读各的」是本项目栽过
//   最多次的形状。老写法(每档一条完整 fontFamily)的档经过这里**逐字节不变**(合成只在缺 fontFamily 时发生)。
function parseStyleTokens(text) { return applyFontsSegment(_parseStyleTokensRaw(text)) }
function _parseStyleTokensRaw(text) {
  const fm = _frontMatter(text)
  if (!fm) return {}
  const root = {}
  const stack = [{ indent: -1, obj: root }]
  for (const raw of fm) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const m = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw)
    if (!m) continue
    const indent = m[1].length
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].obj
    const val = m[3].trim()
    if (val === '') {
      const child = {}
      parent[m[2]] = child
      stack.push({ indent, obj: child })
    } else {
      parent[m[2]] = _unquote(val)
    }
  }
  return root
}

function _normHex(v) {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(v == null ? '' : v).trim())
  if (!m) return null
  const h = m[1]
  return '#' + (h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h).toUpperCase()
}
function _rgb(hex) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] }
// WCAG 相对亮度(不是简单的 (r+g+b)/3):#F2B705 这类亮黄的感知亮度远高于同均值的蓝,
// 用感知量才判得对「谁是底色、谁跟底色对比够」。
function _lum(c) {
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}
function _contrast(a, b) { const la = _lum(a); const lb = _lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05) }
function _chroma(c) { return (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255 }
function _mix(a, b, t) { return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) }

// 角色词表。**整键名相等才算命中**,不做子串匹配 —— riso-print 的 `ink-blue` / `ink-black`
// 一旦按子串认,第一个碰上的 ink-blue 就成了文字色,整张图标全错。认不出的键交给下面的
// 启发式(它对 riso 恰好判出 ink-black 当文字、ink-orange 当强调,比错认的子串规则更准)。
// ── 三样「有预览通道」的属性(v0.11.22)──────────────────────────────────────
// ⭐ 它们一律走 front matter 的**顶层独立段**(gradient / elevation / status),**绝不进 colors 段**。
// 理由是硬的:styleRoles 只扫 colors 的直接子键,一旦把 success/warning/danger 写进 colors,
// 「整键名命中」的词表外颜色就会参与角色兜底 —— 危险红彩度最高,当场抢走 accent,而作者
// 点的强调色被挤成配角(v0.9.2 那个坑的同款,alt-N 前缀已为此吃过一次亏)。
// 选这三样而不是别的:每一样都能在右侧微缩预览上看出变化(按钮填充 / 卡片投影 / 色板条),
// 而**能被看见**正是这张表单存在的理由。看不见的属性(单位基准、组件基座)不进表单。
const ELEV_LEVELS = {
  none: { id: 'none', label: '无', off: 0, alpha: 0, tint: false, note: '不投影 —— 分区靠一条线或一段留白' },
  flat: { id: 'flat', label: '轻', off: 2, alpha: 0.06, tint: false, note: '极浅的一层,只把卡片从底色上托起来' },
  soft: { id: 'soft', label: '明显', off: 4, alpha: 0.13, tint: false, note: '看得见的投影,卡片是独立的一层' },
  color: { id: 'color', label: '彩色', off: 4, alpha: 0.3, tint: true, note: '投影染强调色 —— 按钮与卡片像在发光' },
}
const STATUS_KEYS = ['success', 'warning', 'danger']
const STATUS_LABELS = { success: '成功', warning: '警告', danger: '危险' }
const GRADIENT_ANGLE = 135 // 表单不给角度旋钮:135° 是界面渐变的事实默认(左上→右下),多一个旋钮换不来信息

const ROLE_KEYS = {
  bg: ['bg', 'background', 'paper', 'canvas', 'base', 'cream', 'neutral', 'page', 'ground', 'sand', 'shell'],
  ink: ['ink', 'text', 'fg', 'foreground', 'type', 'body', 'copy'],
  accent: ['accent', 'highlight', 'brand', 'pop', 'signal'],
  muted: ['muted', 'secondary', 'subtle', 'caption', 'meta', 'dim'],
  line: ['line', 'border', 'divider', 'rule', 'hairline', 'stroke'],
}

// colors tokens → 图标要用的五个角色 + 完整色板。三步:①整键名命中词表 ②`primary` 二义消解
// ③剩下的按亮度/彩度启发式补齐。为什么必须有 ②③:8 个内置预设的键名**没有一个是统一的**
// (primary/neutral/line · paper/ink/muted · bg/surface/warn · cream/blue/yellow/red),用户自己
// 写的更没谱 —— 图标要对所有风格档都画得出来,就不能要求作者按某套键名写。
// 返回 null 表示一个合法颜色都没有(调用方决定怎么兜底,这里不编颜色)。
function styleRoles(colors, { fromExtract = false } = {}) {
  const entries = []
  for (const [k, v] of Object.entries(colors || {})) {
    if (v && typeof v === 'object') continue // 嵌套子段不是颜色
    const hex = _normHex(v)
    if (hex) entries.push({ key: String(k), norm: String(k).toLowerCase().replace(/[\s_]+/g, '-'), hex, rgb: _rgb(hex) })
  }
  if (!entries.length) return null
  const roles = {}
  const taken = new Set()
  const claim = (role, e) => { if (!e || roles[role] || taken.has(e.key)) return; roles[role] = e.hex; taken.add(e.key) }
  const free = () => entries.filter((e) => !taken.has(e.key))
  const pickBy = (pool, score) => (pool.length ? pool.reduce((a, b) => (score(b) > score(a) ? b : a)) : null)

  for (const [role, names] of Object.entries(ROLE_KEYS)) claim(role, entries.find((e) => names.includes(e.norm) && !taken.has(e.key)))
  // `primary` 两个意思:有独立 bg 键时它是主文字色(瑞士网格的 neutral+primary、科技深色的
  // bg+primary 都是这个用法),否则它是品牌强调色。按上下文判,别一刀切。
  const primary = entries.find((e) => e.norm === 'primary' && !taken.has(e.key))
  if (primary) { if (!roles.ink && roles.bg) claim('ink', primary); else if (!roles.accent) claim('accent', primary) }

  if (!roles.bg) {
    // 有浅色 ⇒ 最浅的当底;全是深色 ⇒ 深色风格,最深的当底。别取「中间那个」——
    // 底色的定义就是极端值,取中间会让文字和底都挤在一起,图标糊成一片。
    const pool = free().length ? free() : entries
    const light = pool.filter((e) => _lum(e.rgb) > 0.55)
    claim('bg', light.length ? pickBy(light, (e) => _lum(e.rgb)) : pickBy(pool, (e) => -_lum(e.rgb)))
  }
  const bg = _rgb(roles.bg)
  if (!roles.ink) {
    const pool = free().length ? free() : entries.filter((e) => e.hex !== roles.bg)
    // 从参考提炼(fromExtract):传进来的顺序就是频次 ⇒ 先取「对比够当正文(≥7)里用得最多的」——
    // 只看对比的话纯黑总会赢,哪怕站点正文其实是 #1F2329(飞书实测)。风格档自己的色板照旧按对比挑。
    const pick = (fromExtract && pool.find((e) => _contrast(e.rgb, bg) >= 7)) || pickBy(pool, (e) => _contrast(e.rgb, bg))
    claim('ink', pick)
    if (!roles.ink) roles.ink = _hex(...(_lum(bg) > 0.5 ? [17, 17, 17] : [240, 240, 240])) // 只有一个颜色:黑白兜底
  }
  const ink = _rgb(roles.ink)
  if (!roles.accent) {
    // 强调色 = 最鲜艳的那个。彩度门槛挡掉纯灰(灰色当强调块等于没强调),够不着门槛就退回
    // 「对比最强的剩余色」,再不行就用文字色(宁可朴素也不能画个看不见的块)。
    const pool = free().filter((e) => _chroma(e.rgb) > 0.08)
    // 从参考提炼:彩色里**用得最多**的那个,不是最鲜艳的 —— 一处点缀的亮金会顶掉站点到处在用的品牌铜色(sintbot.com 实测)
    claim('accent', (fromExtract ? pool[0] : pickBy(pool, (e) => _chroma(e.rgb))) || pickBy(free(), (e) => _contrast(e.rgb, bg)))
    if (!roles.accent) roles.accent = roles.ink
  }
  if (!roles.muted) {
    if (fromExtract) {
      // 从参考提炼:次要色 = 底与正文之间那一档灰 —— 对比够读(≥2.5)又明显弱于正文(不到正文的六成)。
      // 不取对比最强的剩余色:参考站点的白色描边 / 高光会因此当选,「次要信息」比正文还亮。
      // 候选按传入顺序取第一个(提炼传进来的顺序就是频次)。风格档自己的色板不走这条:
      // 「几何构成」拿蓝当次要色是设计意图,不能按灰阶规则改掉。
      const inkC = _contrast(ink, bg)
      claim('muted', free().find((e) => _chroma(e.rgb) <= 0.08 && _contrast(e.rgb, bg) >= 2.5 && _contrast(e.rgb, bg) < inkC * 0.6))
    } else claim('muted', pickBy(free(), (e) => _contrast(e.rgb, bg)))
    if (!roles.muted) roles.muted = _hex(..._mix(bg, ink, 0.55))
  }
  if (!roles.line) {
    // 分隔线是最轻的那道:剩余色里对比最低的,且不能重到像正文(≥4 就不是线了,是块)。
    claim('line', pickBy(free().filter((e) => _contrast(e.rgb, bg) < 4), (e) => -_contrast(e.rgb, bg)))
    if (!roles.line) roles.line = _hex(..._mix(bg, ink, 0.14))
  }
  return {
    bg: roles.bg, ink: roles.ink, accent: roles.accent, muted: roles.muted, line: roles.line,
    palette: entries.map((e) => ({ key: e.key, hex: e.hex })),
    dark: _lum(bg) < 0.4,
  }
}

function _pxNum(v) {
  const m = /^(-?\d+(?:\.\d+)?)/.exec(String(v == null ? '' : v).trim())
  return m ? parseFloat(m[1]) : null
}

const PILL = 9999 // 「全圆角」哨兵:渲染时按 min(w,h)/2 收敛成胶囊

// typography 段里的「标题块」与「正文块」。headline/body 是本模块自己写档时用的键名;
// 别人手写的档未必这么叫 —— 认不出时退回「第一个子对象」当标题块。**只此一份实现**:
// 出图(swatchSpec)与回收表单(_extraTokensFromDoc)必须看同一个块,各写一份迟早分叉。
function _typoOf(tokens) {
  const typo = tokens && typeof tokens.typography === 'object' && tokens.typography ? tokens.typography : {}
  const head = (typo.headline && typeof typo.headline === 'object' ? typo.headline
    : Object.values(typo).find((v) => v && typeof v === 'object')) || {}
  const body = (typo.body && typeof typo.body === 'object') ? typo.body : {}
  return { typo, head, body }
}

// 一份风格档 → 画图标要的一切(颜色角色 + 圆角 + 间距 + 字重 + 字体族)。
// 拿 text 而不是拿路径:listStyles 已经读过一次文件,项目风格档也是现成的字符串,
// 让本函数再去碰文件系统只会多一条出错路径。
function swatchSpec(text, extra = {}) {
  const t = parseStyleTokens(text)
  const meta = parseStyleMeta(text) // 与列表显示同源,免得图标标题和列表标题不一致
  const roles = styleRoles(t.colors || {})
  const { typo, head, body: bodyT } = _typoOf(t)
  const stacks = Object.values(typo).filter((v) => v && typeof v === 'object').map((v) => String(v.fontFamily || '')).join(' , ')
  const fontStack = String(head.fontFamily || '')
  const weightRaw = _pxNum(head.fontWeight)
  // 标题/正文**字号反差比**(v0.9.5)。这是预览图唯一的**连续量**通道 —— 8 个内置预设
  // 落在 1.50~3.29,几乎两两不同;而此前当主信号的 fontWeight 只有 500/600/700 三档,
  // 换算成条高极差仅 2.2px,在缩略图上根本分不出。缺 fontSize 的档退回 null,由 layout
  // 那侧按字重兜底 —— **不替作者假设一个字号**。
  const hSize = _pxNum(head.fontSize)
  const bSize = _pxNum(bodyT.fontSize)
  const titleScale = hSize && bSize && bSize > 0 ? hSize / bSize : null
  // 字距:em 与 px 都收(px 按 16 折算),用于把标题条切成几段 —— 宽字距的风格看起来更松。
  const tracking = _emNum(head.letterSpacing)
  // 圆角:取常规档里最大的(它代表这个风格「最圆能到多圆」)。999/full 是胶囊语义,不能参与
  // 取最大 —— 否则圆融亲和有个 full:999 就整张图标变胶囊,而它真正的性格是 12/20 的柔圆。
  // 全档都是胶囊才用哨兵;rounded 段整个缺失 ⇒ 0,不替作者假设一个「温和默认值」。
  const rvals = Object.values(t.rounded && typeof t.rounded === 'object' ? t.rounded : {}).map(_pxNum).filter((n) => n != null && n >= 0)
  const normal = rvals.filter((n) => n < 100)
  return {
    name: meta.name || '',
    description: meta.description || '',
    roles: roles || null,
    radius: normal.length ? Math.max(...normal) : (rvals.length ? PILL : 0),
    // rounded 里有胶囊档(full/pill ≥100)⇒ **按钮**画成胶囊。胶囊值不参与"取最大"是对的
    // (否则圆融亲和一个 full:999 会让整张图变胶囊),但它本来就是给按钮与标签的语义 ——
    // 酸性荧光的规矩正是"容器直角、按钮胶囊",不认这一档就把它画成了纯直角。
    // ⚠ 只认键名 full/pill —— `circle: 999` 是**正圆**语义(徽章、图标底),不是胶囊按钮。
    // 只看数值会把装饰艺术、构成主义、热带现代的按钮全画成胶囊,与它们的直角性格相反。
    pill: Object.entries((t.rounded && typeof t.rounded === 'object') ? t.rounded : {})
      .some(([k, v]) => /^(full|pill)$/i.test(k) && (_pxNum(v) || 0) >= 100),
    unit: _pxNum(t.spacing && typeof t.spacing === 'object' ? t.spacing.unit : null) || 8,
    headlineWeight: weightRaw != null ? Math.max(100, Math.min(900, weightRaw)) : 400,
    // 'Noto Sans SC, sans-serif' 里也含 "serif" 子串 —— 先剜掉 sans-serif 再判,否则全判成衬线
    serif: /serif/i.test(fontStack.replace(/sans[-\s]?serif/gi, '')),
    mono: /mono/i.test(stacks),
    fontStack,
    titleScale,
    tracking,
    // 描边(v0.9.5):8 个内置预设有 6 个不同取值(0/1/1.5/2/3px)—— **方差最大的通道**,
    // 且是轮廓级低频信号,缩到群卡 58px 仍分得出。缺省 1px(与旧行为一致,不改动老档观感)。
    border: {
      width: _pxNum(t.border && t.border.width) != null ? Math.max(0, Math.min(6, _pxNum(t.border.width))) : 1,
      double: String((t.border && t.border.style) || '') === 'double', // 书籍式双线版框(新中式)
    },
    // 图片处理(v0.9.5)。**此前 8 张卡全是"文字页"** —— 而这个产品的主产出是图,
    // 预览图里却完全没有"这个风格的图长什么样"。ratio 定形状、treatment 定填充、
    // crop 定出血。缺省 null ⇒ 不画图块(老档观感不变,不替作者假设)。
    imagery: t.imagery && typeof t.imagery === 'object' ? {
      ratio: _ratioNum(t.imagery.ratio),
      treatment: String(t.imagery.treatment || 'none'),
      crop: String(t.imagery.crop || 'hard'),
    } : null,
    // ── 三样新通道(v0.11.22)。**一律缺省 null / []** —— 没写就走老路,既有 16 种内置预设
    //    的图元表逐字节不变(几何指纹回归测试盯着这条)。不替作者假设任何一样。
    gradient: _gradientOf(t.gradient),
    elevation: _elevOf(t.elevation),
    status: _statusOf(t.status),
    ...extra,
  }
}

// gradient 段 → {from,to,angle};两端色缺一不可(只有一端的渐变不是渐变),认不出即 null。
function _gradientOf(g) {
  if (!g || typeof g !== 'object') return null
  const from = _normHex(g.from)
  const to = _normHex(g.to)
  if (!from || !to || from === to) return null // 两端同色 = 纯色,别画一层假渐变
  const a = _pxNum(g.angle)
  return { from, to, angle: a == null ? GRADIENT_ANGLE : a }
}
// elevation 段 → 档位。认 level 名(none/flat/soft/color);别人手写的档里若只有 shadow 字符串,
// 按「有投影」退到 soft —— 读不出档位不等于没有投影,退到「没有」会把作者写的那层抹掉。
function _elevOf(e) {
  if (!e || typeof e !== 'object') return null
  const lv = String(e.level || '').trim().toLowerCase()
  if (ELEV_LEVELS[lv]) return ELEV_LEVELS[lv]
  if (String(e.shadow || '').trim()) return ELEV_LEVELS.soft
  return null
}
// status 段 → [{key,hex}](固定三槽,按 STATUS_KEYS 顺序;认不出的槽跳过)。
// **不做兜底补齐**:只写了 danger 的档就只有 danger —— 编另外两个等于替作者决定语义色。
function _statusOf(s) {
  if (!s || typeof s !== 'object') return []
  const out = []
  for (const k of STATUS_KEYS) {
    const hex = _normHex(s[k])
    if (hex) out.push({ key: k, hex })
  }
  return out
}

// "16:9" / "4:5" / "1.5" → 宽高比数值;认不出返回 1(方形,最中性的假设)
function _ratioNum(v) {
  const s = String(v == null ? '' : v).trim()
  const m = /^(\d*\.?\d+)\s*[:/]\s*(\d*\.?\d+)$/.exec(s)
  if (m) { const a = parseFloat(m[1]); const b = parseFloat(m[2]); return b > 0 ? a / b : 1 }
  const n = parseFloat(s)
  return Number.isFinite(n) && n > 0 ? n : 1
}

// letterSpacing → em 数(px 按 16px 正文折算)。返回 0 表示"没写或写不出数"。
function _emNum(v) {
  const s = String(v == null ? '' : v).trim()
  const m = /^(-?\d*\.?\d+)\s*(em|rem|px)?$/.exec(s)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return 0
  return m[2] === 'px' ? n / 16 : n
}

// ── 图元布局(两端共用)────────────────────────────────────────────────────────
// 输出与渲染无关的图元表:{rects, digits}。坐标是卡片局部坐标(左上原点),渲染方自己加偏移。
const CARD_W = 260
const CARD_H = 232
const MOCK_VIEW_W = 375 // 图标模拟的「界面宽度」:token 里的 20px 圆角是按真实界面写的,
// 缩进 224px 宽的卡片必须等比缩,否则大圆角风格在小图标上会圆得离谱。

// 构图(自上而下):标题两条(ink,粗细按字重)→ 分隔线(line 色唯一露脸处)→ 正文三条
// (muted)→ 大段留白 → 强调按钮(圆角按 rounded)→ 色板 chips。**克制是刻意的**:元素越少,
// 每个元素承载的信号越清楚 —— 底调 / 文字对比 / 强调色用量 / 圆角性格 / 行距疏密,一样一处。
// `chrome`(v0.9.5 实验):把整张卡做成一块**微缩界面** —— 顶栏与底栏是「地」不是内容,
// 中间被两条带夹出来反而更空。参照 Chrome 的 mini_new_tab_page.svg 与 vscodethemes 的
// 合成缩略图:业界凡是"必须批量生成主题缩略图"的场合走的都是这条路,而不是画抽象色块。
// 附带收益:`line` 色从只露 1 条变成露 3 处(两条发丝线 + 描边次按钮),色相才读得出。
function swatchLayout(spec, { w = CARD_W, h = CARD_H, index = 0, chrome = false } = {}) {
  const r0 = spec && spec.roles
  // 没有可用色板(风格档没写 colors,或写坏了)⇒ 画一张明白的空卡,别猜颜色。
  const R = r0 || { bg: '#FFFFFF', ink: '#9AA0A6', accent: '#C9CDD2', muted: '#C9CDD2', line: '#E4E6EA', palette: [], dark: false }
  const bgRgb = _rgb(R.bg)
  const inkRgb = _rgb(R.ink)
  // 投影档位(v0.11.22):**缺省(档里没写 elevation)= 老行为逐字节不变** —— 偏移 3、6% 中性黑。
  // 这条缺省不是懒,是回归纪律:16 种内置预设一个都没写 elevation,变了默认它们的图元表全变。
  const EV = spec.elevation
  const SH = EV ? EV.off : 3 // 硬阴影偏移:卡片本体让出这么多,阴影补上 ⇒ 合起来正好铺满 w×h
  const pad = 18
  const x0 = pad
  const cw = w - SH - pad * 2 // 按卡片本体宽算,不是整幅宽 —— 否则右边距少掉 SH,内容看着偏右
  const k = cw / MOCK_VIEW_W
  const rad = (spec.radius === PILL ? PILL : spec.radius * k)
  const cardR = Math.max(0, Math.min(rad, 16)) // 卡片自己的圆角也按风格走:瑞士网格硬边、圆融柔角
  const gapY = Math.max(6, Math.min(14, spec.unit * k * 1.5))
  const rects = []
  const digits = []
  // grad(v0.11.22)= 可选的第二端色:有它就是线性渐变填充,fill 是起点色。**加在 rect 契约上
  // 而不是拆成 N 条竖切片** —— 切片在圆角按钮上会把边缘切出台阶,而且几何图元数会随渐变暴涨;
  // 两端各多认一个字段(SVG 出 linearGradient、光栅逐像素插值)比这便宜得多。
  const put = (x, y, rw, rh, rr, fill, grad) => {
    if (rw > 0.5 && rh > 0.5) rects.push(grad ? { x, y, w: rw, h: rh, r: Math.max(0, rr), fill, grad } : { x, y, w: rw, h: rh, r: Math.max(0, rr), fill })
  }
  // 描边**恒中性**(bg↔ink 混),刻意不用作者的 line —— line 可能是高彩度(riso 的粉、几何构成
  // 的红),拿它围一整圈会盖过卡内的设计本身,一排候选像糖果盒;line 色在卡内分隔线处露脸。
  const edge = _hex(..._mix(bgRgb, inkRgb, 0.18))

  // 硬阴影(不做模糊:光栅模糊贵,而实心投影本身就是种设计语言,不违和)。卡片让出 SH,
  // 阴影偏 SH ⇒ 两者合起来正好铺满 w×h,**所有图元都留在 0..w / 0..h 内** —— SVG 那侧靠
  // viewBox 裁切,任何越界图元会被直接切掉(单测钉住这条不变量)。
  // 彩色档把投影染成强调色(某项目小程序真机就是这个写法:金按钮下压一层 25% 的金)。
  // 中性档恒黑 —— 它表达的是「有一层」,不是「有个颜色」。
  if (SH > 0) {
    const shRgb = EV && EV.tint ? _rgb(R.accent) : [0, 0, 0]
    const shA = EV ? EV.alpha : 16 / 255 // 缺省 = 原来那个 '#00000010'
    put(SH, SH, w - SH, h - SH, cardR, _hex(...shRgb) + Math.round(Math.max(0, Math.min(1, shA)) * 255).toString(16).padStart(2, '0').toUpperCase())
  }
  // 卡片:描边 + bg 内芯(描边用两个矩形叠,省一套描边渲染逻辑)。
  // **粗细按风格走**(v0.9.5):几何构成 3px 粗黑边 / 瑞士网格 1px / riso 0(无边)。
  // ⚠ 颜色恒中性不变 —— 用作者的 `line` 会让 riso 的粉、几何构成的红围一整圈,
  //   盖过卡内设计本身,一排候选看着像糖果盒(v0.9.2 已为此把描边改中性,别退回去)。
  const bw = spec.border ? spec.border.width : 1
  put(0, 0, w - SH, h - SH, cardR, bw > 0 ? edge : R.bg)
  put(bw, bw, w - SH - bw * 2, h - SH - bw * 2, Math.max(0, cardR - bw), R.bg)
  // 双线版框(新中式的书籍版式):内芯里再落一圈细线,与外框留出气口
  if (spec.border && spec.border.double) {
    const g = 3
    put(bw + g, bw + g, w - SH - (bw + g) * 2, h - SH - (bw + g) * 2, Math.max(0, cardR - bw - g), edge)
    put(bw + g + 1, bw + g + 1, w - SH - (bw + g + 1) * 2, h - SH - (bw + g + 1) * 2, Math.max(0, cardR - bw - g - 1), R.bg)
  }
  const cardH2 = h - SH // 卡片本体的下沿(阴影占掉 SH)

  // ── 微缩界面的「地」:顶栏 + 底栏(chrome 模式)──────────────────────────────
  // 它们**不是内容**,所以中间区被两条带夹出来反而更空;同时把 line 色从只露 1 条
  // 提到露 3 处(两条发丝线 + 下面的描边次按钮),色相才读得出来。
  const barH = chrome ? 30 : 0
  if (chrome) {
    const surf = _hex(..._mix(bgRgb, inkRgb, R.dark ? 0.09 : 0.055))
    const ix = bw
    const iw = w - SH - bw * 2
    const br = Math.max(0, cardR - bw)
    put(ix, bw, iw, barH, br, surf) // 顶栏:上两角跟卡片圆角
    put(ix, bw + barH / 2, iw, barH / 2, 0, surf) // 下半补方角
    put(ix, bw + barH, iw, 1, 0, R.line) // 发丝线 ①
    put(ix, cardH2 - bw - barH, iw, barH, br, surf) // 底栏
    put(ix, cardH2 - bw - barH, iw, barH / 2, 0, surf) // 上半补方角
    put(ix, cardH2 - bw - barH, iw, 1, 0, R.line) // 发丝线 ②
    // 顶栏里三个小方块(标签/图标位):让这条带读作「界面」而不是一条色带
    const tabC = _hex(..._mix(bgRgb, inkRgb, 0.34))
    for (let i = 0; i < 3; i++) put(x0 + i * 13, bw + barH / 2 - 3, 8, 6, Math.min(rad, 3), tabC)
  }

  // ── 上半:标题 → 分隔线 → 正文(固定 3 条,行距随 unit —— 疏密即留白性格,行数不减) ──
  // 条高按**字号反差比**(v0.9.5):唯一的连续量通道,8 个预设落在 1.50~3.29 几乎两两不同。
  // 缺 fontSize 的档退回旧的字重派生(400→7 / 700→10.3),不替作者假设字号。
  const hh = spec.titleScale
    ? Math.max(6, Math.min(15, 4 * spec.titleScale))
    : 7 + Math.max(0, (spec.headlineWeight - 400)) / 100 * 1.1
  // 标题条:字距宽 ⇒ 切成几段(段间隙就是"松");衬线 ⇒ 整条首尾各立一道字脚。
  // ⚠ 字脚是**近似**不是真信号 —— 类型样本传统里衬线只能靠字形辨认,条形上没有成例;
  //   这里取"端部加重"这个最弱可辨的表达,配合控制台那侧的「衬线」文字标签一起读。
  const tr = spec.tracking || 0
  const putTitle = (x, y, totalW, h) => {
    const segs = tr > 0.04 ? 4 : 1
    const gap = segs > 1 ? Math.max(1.5, h * tr * 4) : 0
    const segW = (totalW - gap * (segs - 1)) / segs
    // ⚠ 圆角上限取 h/3 而不是 h/2:h/2 会让大圆角风格(千禧未来 rounded 12)的标题条**完全胶囊化**,
    // 再叠上字距切段就成了一串药丸,读起来不像文字了。圆角性格该由**按钮和卡片**表达(那才是真实
    // 界面里圆角体现的地方),标题条只做微弱暗示 —— 文字行本来也不是胶囊。
    for (let i = 0; i < segs; i++) put(x + i * (segW + gap), y, segW, h, Math.min(rad, h / 3), R.ink)
    if (spec.serif) {
      const t = 1.5
      const o = Math.min(h * 0.4, y * 2) // 别越出卡片上沿(图元全在 0..h 内是有单测的不变量)
      put(x, y - o / 2, t, h + o, 0, R.ink)
      put(x + totalW - t, y - o / 2, t, h + o, 0, R.ink)
    }
  }
  let y = chrome ? bw + barH + 11 : pad + 2 // chrome 模式从顶栏下方起
  putTitle(x0, y, cw * 0.62, hh)
  y += hh + 6
  putTitle(x0, y, cw * 0.38, hh)
  y += hh + gapY * 1.5
  const ruleY = y // 记下分隔线位置:图块要跟它对齐(见下)
  put(x0, y, cw, 1.5, 0, R.line) // 编辑排版式的标题下划线 —— line 色的唯一整条露脸
  y += gapY * 1.4
  const bodyH = 4
  // 正文条:排版里有等宽字族 ⇒ 切成等长分段(格子感)。
  // ⚠ 语义要说准:`mono` 扫的是**全部** typography 段,所以它表示"这个风格用等宽字"
  //   (tech-dark 的数值、riso 与新粗野的小标签都是签名细节),**不是**"正文是等宽的" ——
  //   实际上 9 个预设里没有一个 body 用等宽。改成只看 body 会让这条通道 0/9 全灭,
  //   所以保留全扫,但它和 serif 字脚一样是**近似表达**,不是精确映射。
  // 圆角去掉 —— 4px 高的条上 2px 圆角完全看不见,是个"看似有区别其实没有"的假信号。
  // 图块(v0.9.5):放正文右侧图文混排 —— 不动"正文恒 3 条、行距随 unit"这条(它是表达
  // 留白性格的唯一信号,有单测钉着)。**面积恒定、形状随 ratio** ⇒ 16:9 扁、1:1 方、4:5 竖,
  // 三种一眼分得出,而占版面积一样、不会因为竖图把布局撑坏。
  const img = spec.imagery
  let imgW = 0
  if (img) {
    // 面积恒定 ⇒ 形状随 ratio 变而占版一致。**刻意压小**:图块是"这个风格的图长什么样"
    // 的示意,不是主角 —— 大了会把正文条挤成短横杠,整张卡的阅读顺序也跟着乱。
    const area = 2100
    imgW = Math.max(32, Math.min(cw * 0.3, Math.sqrt(area * img.ratio)))
    const imgH = Math.max(24, Math.min(70, area / imgW))
    // full-bleed:右边缘顶到卡片外沿(出血);其余留在内容区里
    const ix = img.crop === 'full-bleed' ? w - SH - bw - imgW : x0 + cw - imgW
    const ir = img.crop === 'rounded' ? Math.min(rad, 10) : 0
    // **顶边与分隔线对齐**(而不是与正文首行齐)——两者连成一条横贯的视觉线,右下角
    // 不再留出那个不整齐的缺口;图块顺势往下延伸,顺带填掉一点过大的中部留白。
    const y = ruleY + 5
    const px = (a, b, c, d, f, al) => put(a, b, c, d, ir, al == null ? f : _hex(..._mix(bgRgb, _rgb(f), al)))
    px(ix, y, imgW, imgH, R.muted, 0.55) // 底板:所有 treatment 共用
    const acc = R.accent
    const t2 = (R.palette.find((p) => p.hex !== R.bg && p.hex !== R.ink && p.hex !== acc) || { hex: R.ink }).hex
    if (img.treatment === 'duotone') {
      // 双色对半:上下两块,是 riso/几何构成那种平涂双色制版的直译
      put(ix, y, imgW, imgH / 2, ir, acc)
      put(ix, y + imgH / 2, imgW, imgH / 2, ir, t2)
    } else if (img.treatment === 'grayscale') {
      // 灰阶:三条明度递减的横带(黑白照片的调子)
      for (let i = 0; i < 3; i++) put(ix, y + (imgH / 3) * i, imgW, imgH / 3, ir, _hex(..._mix(bgRgb, inkRgb, 0.25 + i * 0.22)))
    } else if (img.treatment === 'halftone') {
      // 网点:小方点阵 —— riso 孔版的签名,而且纯矩形是**同构**表达不是近似
      const step = 5
      for (let gy = y + 3; gy < y + imgH - 2; gy += step) for (let gx = ix + 3; gx < ix + imgW - 2; gx += step) put(gx, gy, 2.2, 2.2, 1.1, acc)
    } else if (img.treatment === 'watercolor') {
      // 水彩:几块低透明度错落色斑,边缘不齐
      px(ix + 2, y + 2, imgW * 0.7, imgH * 0.6, acc, 0.5)
      px(ix + imgW * 0.22, y + imgH * 0.3, imgW * 0.7, imgH * 0.6, t2, 0.42)
    } else px(ix, y, imgW, imgH, acc, 0.28) // none:单色块
    imgW += 12 // 让出与正文的间距
  }
  // 正文可用宽度:图块再宽也要给正文留够 —— 正文条缩成短横杠就读不出"行长与疏密"了
  const textW = Math.max(cw * 0.56, cw - imgW)
  for (const r of [0.92, 0.7, 0.46]) {
    const lw = textW * r
    if (spec.mono) {
      const seg = 7
      const g = 2.5
      for (let sx = 0; sx < lw; sx += seg + g) put(x0 + sx, y, Math.min(seg, lw - sx), bodyH, 0, R.muted)
    } else put(x0, y, lw, bodyH, 0, R.muted)
    y += bodyH + gapY
  }

  // ── 下半(自底部锚定;与上半之间的空白就是这个风格敢不敢留白):chips ↑ 按钮 ──
  // 色板 chips:小方片替代整宽色条 —— 色条铺满一行像钢琴键,重得压住整张卡;chips 只陈述
  // 「有哪些颜色」。每片下垫 1px 描边底 ⇒ 与底色同色的那片也有轮廓(不垫会隐形,实测中招)。
  const pal0 = R.palette.length ? R.palette : [{ hex: R.ink }, { hex: R.accent }]
  const st = spec.status || []
  // 片宽/间距自适应(v0.11.22 顺手修的既有缺陷):此前写死 16/5 ⇒ **12 片起真的画到卡片外面**
  // (实测 12 片最右边缘 265 > 卡宽 260,SVG 那侧被 viewBox 裁掉、光栅那侧直接越界;20 片裁掉 18 个
  // 图元)。10–11 片虽不越界,但已吃掉右侧留白、视觉上贴边(某项目那份 5 角色 + 6 补充色 = 11 片
  // 正是这一档)。**本版加了状态色后更容易撞** —— 同一份档就是 11+3=14 片,妥妥越界。
  // 先压间距、再压片宽,下限 6px —— 再小色相就读不出来了。
  const nAll = pal0.length + st.length
  const sepW = st.length ? 8 : 0 // 状态色与色板之间留一道气口:它们是两组不同的东西
  const fits = (c, g) => nAll * c + (nAll - 1) * g + sepW <= cw
  let chip = 16
  let cgap = 5
  if (!fits(chip, cgap)) {
    cgap = 2
    if (!fits(chip, cgap)) chip = Math.max(6, (cw - sepW - (nAll - 1) * cgap) / nAll)
  }
  const chipR = Math.min(rad, 4)
  // chrome 模式:chips 落进底栏(有了「页脚」这个理由,不再像浮在空中的一排色块)
  const chipsY = chrome ? cardH2 - bw - barH + (barH - chip) / 2 : cardH2 - pad - chip
  // 色板上方一条发丝线:给 chips 一个「页脚」的归属(否则它像浮在空中的一排色块)。
  // 这是从微缩界面那版里摘出来的唯一一点好处 —— 那版的窗口壳隐喻对海报向风格是错的
  // (瑞士网格是招贴、riso 是印刷品),但"色板归底部"这条与风格类型无关,单独留下。
  // 顺带让 line 色多露一次脸(此前只有标题下那一条)。
  if (!chrome) put(x0, chipsY - 11, cw, 1, 0, R.line)
  let cx = x0
  for (const c of pal0) {
    put(cx, chipsY, chip, chip, chipR, edge)
    put(cx + 1, chipsY + 1, chip - 2, chip - 2, Math.max(0, chipR - 1), c.hex)
    cx += chip + cgap
  }
  // 状态色画成**圆点**而不是方片:它们是语义槽(成功/警告/危险),不是这套风格色板的成员 ——
  // 形状不同才不会被读成「这套风格有十几个颜色」。同序号牌的道理:功能标记不跟着风格圆角走。
  if (st.length) {
    cx += sepW - cgap
    for (const s of st) {
      put(cx, chipsY, chip, chip, chip / 2, edge)
      put(cx + 1, chipsY + 1, chip - 2, chip - 2, (chip - 2) / 2, s.hex)
      cx += chip + cgap
    }
  }
  // 强调按钮(圆角是这个风格的签名:0 / 12 / 胶囊)+ 一条底色的「按钮文字」
  const btnH = 26
  const btnW = cw * 0.42
  const btnY = chrome ? cardH2 - bw - barH - 15 - btnH : chipsY - 16 - btnH
  // 渐变落在按钮上(v0.11.22)—— 界面里渐变最常出现的地方就是主按钮与头图,而按钮是这张
  // 预览图上唯一的大块强调色,变化一眼可见。缺省无渐变 ⇒ 与老图逐字节相同。
  const G = spec.gradient
  put(x0, btnY, btnW, btnH, spec.pill ? btnH / 2 : Math.min(rad, btnH / 2),
    G ? G.from : R.accent, G ? { to: G.to, angle: G.angle } : null)
  const onAccent = _contrast(_rgb(R.accent), bgRgb) >= 2.2 ? R.bg : R.ink // 强调色浅时底色文字看不见
  put(x0 + btnW * 0.28, btnY + btnH / 2 - 1.5, btnW * 0.44, 3, Math.min(rad, 1.5), onAccent)

  // 序号(只有群里的多候选对比图用:图上有 1234,消息里才好说「第 2 个」)。小而安静 ——
  // 它是功能标记不是设计元素,大了会比风格本身还抢(CLI 上限 4 ⇒ 恒单个数字)。
  if (index > 0) {
    // 多位数(全库网格出到 16)。⚠ 此前只取 `String(index)[0]` —— 上限 4 时无所谓,
    // 一上两位数就会把 16 画成「1」、13 画成「1」,两张卡的序号牌一模一样。
    const str = String(index)
    const s = 2
    const dw = 5 * s
    const dh = 7 * s
    const dgap = s
    const numW = str.length * dw + (str.length - 1) * dgap
    const bs = 22
    const bw2 = Math.max(bs, numW + 10) // 牌子按位数加宽,高度不变(它是标记不是元素)
    const bx = w - SH - pad - bw2
    put(bx, pad, bw2, bs, Math.min(rad, bs / 2), R.accent)
    for (let i = 0; i < str.length; i++) {
      digits.push({ d: str[i], x: bx + (bw2 - numW) / 2 + i * (dw + dgap), y: pad + (bs - dh) / 2, s, fill: onAccent })
    }
  }
  return { w, h, rects, digits, empty: !r0 }
}

// ── 光栅化(群图走这条;控制台拿同一份 layout 画 SVG)────────────────────────────
const DIGIT_GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
}

// 图元的填充色:除了色板里的 6 位 hex,布局还会用 8 位 hex(#RRGGBBAA)画半透明硬阴影。
// SVG 那侧浏览器原生就认 8 位,光栅这侧要自己把 α 折进覆盖率。
function _fillColor(v) {
  const s = String(v == null ? '' : v).trim()
  const m8 = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(s)
  if (m8) return { rgb: _rgb('#' + m8[1]), a: parseInt(m8[2], 16) / 255 }
  return { rgb: _rgb(_normHex(s) || '#000000'), a: 1 }
}

// 圆角矩形填充,角落按覆盖率混色(不抗锯齿的话 20px 圆角会是一圈可见的台阶 —— 一张
// 「设计风格」图标自己糙着,说服力就没了)。px 是 RGBA 平面,α 恒 255(图标不透明)。
// 渐变里某一点的插值位置 t∈[0,1]。角度按 **CSS 口径**(0deg 自下而上、90deg 自左向右),
// 与 SVG 那侧用同一个向量公式 ⇒ 控制台的 SVG 和群里的 PNG 渐变方向一致。
// 归一化在矩形自身的单位方框里做(不是 CSS 那套精确的渐变线长度)—— 缩略图上肉眼等价,
// 而两端各写一份精确实现才是真风险。
function _gradVec(angle) {
  const a = (Number(angle) || 0) * Math.PI / 180
  return { dx: Math.sin(a), dy: -Math.cos(a) } // y 向下为正,与光栅/SVG 坐标系一致
}
function _fillRoundRect(px, W, H, x, y, w, h, r, rgb, alpha = 1, grad = null) {
  const x1 = x + w; const y1 = y + h
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  const ix0 = Math.max(0, Math.floor(x)); const iy0 = Math.max(0, Math.floor(y))
  const ix1 = Math.min(W - 1, Math.ceil(x1)); const iy1 = Math.min(H - 1, Math.ceil(y1))
  for (let py = iy0; py <= iy1; py++) {
    const cy = py + 0.5
    for (let pxi = ix0; pxi <= ix1; pxi++) {
      const cx = pxi + 0.5
      // 矩形本体覆盖率(边缘半像素也算,免得非整数坐标处出现硬缝)
      let cov = Math.max(0, Math.min(cx + 0.5, x1) - Math.max(cx - 0.5, x)) * Math.max(0, Math.min(cy + 0.5, y1) - Math.max(cy - 0.5, y))
      if (cov <= 0) continue
      if (rr > 0) {
        // 四个角:落在圆心「外侧象限」的像素按到圆心的距离收覆盖率
        const qx = cx < x + rr ? x + rr : (cx > x1 - rr ? x1 - rr : null)
        const qy = cy < y + rr ? y + rr : (cy > y1 - rr ? y1 - rr : null)
        if (qx != null && qy != null) {
          const d = Math.hypot(cx - qx, cy - qy)
          cov *= Math.max(0, Math.min(1, rr + 0.5 - d))
        }
      }
      cov *= alpha
      if (cov <= 0) continue
      let c0 = rgb
      if (grad) {
        // 逐像素插值:t 沿角度方向在本矩形的单位方框内归一
        const t = Math.max(0, Math.min(1, ((cx - x) / (w || 1) - 0.5) * grad.vec.dx + ((cy - y) / (h || 1) - 0.5) * grad.vec.dy + 0.5))
        c0 = _mix(rgb, grad.rgb, t)
      }
      const o = (py * W + pxi) * 4
      px[o] = Math.round(px[o] + (c0[0] - px[o]) * cov)
      px[o + 1] = Math.round(px[o + 1] + (c0[1] - px[o + 1]) * cov)
      px[o + 2] = Math.round(px[o + 2] + (c0[2] - px[o + 2]) * cov)
      px[o + 3] = 255
    }
  }
}

// 一张或多张风格卡并排 → RGBA 平面。PNG 编码不在这里(与 extract-colors 同一分工:本模块
// 只碰解好的平面,编解码住 board.js,bin 接线)。
// `cols`(v0.10.1):多行网格。**候选对比与全库浏览是两个场景** —— 前者 2-4 张并排、
// 每张 260px 看得清细节(网点/字脚/双线),后者要的是"一眼看完有哪些",宁可小也要全。
// cols 缺省 = 单行(旧行为不变)。
function renderSwatchSheet(specs, { cardW = CARD_W, cardH = CARD_H, gap = 18, pad = 20, sheetBg = '#FFFFFF', numbered = null, chrome = false, cols = 0 } = {}) {
  const list = (Array.isArray(specs) ? specs : [specs]).filter(Boolean)
  if (!list.length) throw new Error('renderSwatchSheet:至少要一个风格 spec')
  const n = list.length
  const nc = cols > 0 ? Math.min(cols, n) : n
  const nr = Math.ceil(n / nc)
  const width = Math.round(pad * 2 + nc * cardW + (nc - 1) * gap)
  const height = Math.round(pad * 2 + nr * cardH + (nr - 1) * gap)
  const px = Buffer.alloc(width * height * 4)
  const sheet = _rgb(_normHex(sheetBg) || '#FFFFFF')
  for (let i = 0; i < width * height; i++) { px[i * 4] = sheet[0]; px[i * 4 + 1] = sheet[1]; px[i * 4 + 2] = sheet[2]; px[i * 4 + 3] = 255 }
  // 单张时不编号(没有「第几个」可言);多张默认编号,调用方可显式关掉
  const wantNum = numbered == null ? n > 1 : !!numbered
  list.forEach((spec, i) => {
    const ox = pad + (i % nc) * (cardW + gap)
    const oy = pad + Math.floor(i / nc) * (cardH + gap)
    const lay = swatchLayout(spec, { w: cardW, h: cardH, index: wantNum ? i + 1 : 0, chrome })
    for (const s of lay.rects) {
      const f = _fillColor(s.fill)
      const g = s.grad ? { rgb: _fillColor(s.grad.to).rgb, vec: _gradVec(s.grad.angle) } : null
      _fillRoundRect(px, width, height, ox + s.x, oy + s.y, s.w, s.h, s.r, f.rgb, f.a, g)
    }
    for (const d of lay.digits) {
      const g = DIGIT_GLYPHS[d.d]
      if (!g) continue
      const f = _fillColor(d.fill)
      for (let ry = 0; ry < 7; ry++) {
        for (let rx = 0; rx < 5; rx++) {
          if (g[ry][rx] !== '1') continue
          _fillRoundRect(px, width, height, ox + d.x + rx * d.s, oy + d.y + ry * d.s, d.s, d.s, 0, f.rgb, f.a)
        }
      }
    }
  })
  return { px, width, height }
}

// ── 角色判定的自查输出(swatch stdout;v0.9.3)──────────────────────────────────
// 真机(2026-07-31):用户说「主色改靛蓝」,agent 把 `blue` 的色值换成靛蓝、图也重画了,可按钮
// 还是黄的 —— 几何构成的 blue/yellow/red 都不在 ROLE_KEYS 词表,只能退回「挑彩度最高的」,
// 黄恒胜。它却在群里断言「靛蓝将承担主要视觉面积」,与图恰好相反。
// v0.9.2 把图设计成一道自检(图与产出对不上 ⇒ 风格档写歪了),但那要求 agent 主动去看图核对
// (它有识图能力也没做)。**把判定直接打成文字,自检就降成「读一行」** —— 且对没有识图能力的
// 模型同样成立,与 extract-colors「看不见就读数据」是同一条思路。
// 放在 design.js 而非 bin:措辞是这次修复的主体,要能被单测钉住(同 preview.buildStartedText)。
function swatchRoleReport(specs, { numbered = false } = {}) {
  return (Array.isArray(specs) ? specs : []).map((s, i) => {
    const head = numbered ? `  ${i + 1}. ` : '  '
    if (!s || !s.roles) return head + '(色板缺失或写坏 —— 这张画成了灰色空卡)'
    // 兜底混出来的色(muted/line 无色可用时按 bg↔ink 混)不在 palette 里 ⇒ 无键名,照实留空
    const keyOf = (hex) => { const p = (s.roles.palette || []).find((x) => x.hex === hex); return p ? `(${p.key})` : '' }
    const one = (label, hex) => `${label} ${hex}${keyOf(hex)}`
    return head + [one('底色', s.roles.bg), one('文字', s.roles.ink), one('强调', s.roles.accent), one('次要', s.roles.muted)].join(' · ')
  }).join('\n')
}

// 跟在报告后面的那段教学。**「改色值没用」这句是重点** —— 不写清楚,agent 会反复改色值,
// 每次都看见图没按它预期变,然后要么归因错要么干脆不提。
const SWATCH_ROLE_HINT = '⚠ 「强调」= 图上按钮那块的颜色,也是设计里最显眼的那个。**它若不是你想要的主色,改色值没用**\n'
  + '  —— 角色是按**键名**判的(accent/brand/highlight/pop 这类直接命中),键名认不出时(blue/red 这种\n'
  + '  颜色名)才退回「挑彩度最高的」,所以同档里更鲜艳的那个会一直赢。要指定主色:把 front matter\n'
  + '  里那个键改名为 `accent`,别只改色值。\n'

// 两个来源合并后的预设清单(CLI 与控制台共用同一口径)
function allStyles() { return listStyles({ builtinDir: BUILTIN_STYLES_DIR, userDir: userStylesDir() }) }

// 风格档里与图标有关的那几项 → 控制台只读摘要(null = 这份档没写过图标画法)。
// ⚠ **只报「怎么画它」,不报「图形从哪来」**(2026-08-25 结构纠正):图标库与设计风格平级,
//   哪套系统是**项目**的选择、住在 design/icons.md,不是这份风格档的属性 —— 在风格卡上标
//   「图标 tabler」会让人以为换风格就换图标,而那正是要拆开的那个绑定。
function iconSummary(tokens) {
  const s = iconSpec(tokens)
  if (!s) return null
  return {
    style: s.style,                                  // outlined | filled
    strokeWidth: s.strokeWidth,
    linecap: s.linecap,
    sizes: Object.keys(s.size || {}).length,
  }
}

// 项目的图标口径 → 控制台群卡那一行(没有则 null)。与风格档那几行平级。
// ⚠ 库没装时**如实标未安装**,不空着:图标这一维是唯一有外部依赖的(几个包合计约 160MB,不随包分发),
//   空白会被读成「没选」,而那是两码事(教训:「没找到」和「根本没扫」看起来一模一样)。
function projectIconCard(cwd, { roots = null } = {}) {
  const doc = findIconsDoc({ cwd })
  if (!doc) return null
  const sys = iconSystemOf(doc.system) || null
  const r = roots || iconRoots({})
  return {
    rel: doc.rel,
    system: doc.system,
    label: sys ? sys.label : doc.system,
    known: !!sys,                                    // 认不出的系统名(手改坏了)也要如实说
    library: sys ? sys.library : null,
    fallbackLibrary: doc.fallbackLibrary === undefined ? (sys ? sys.fallbackLibrary : null) : doc.fallbackLibrary,
    // 档里写了个认不出的兜底库名 ⇒ 界面要标出来:它现在等于没兜底,而不是「去那家兜底」
    fallbackUnknown: doc.fallbackUnknown || null,
    // 图标档里声明的形态。⚠ 这是**这份档说了什么**,不是「最终生效的是什么」——
    // 风格档的 icons.style 优先(见 iconSpec),而那份数据界面上另有来源;
    // 在这里替它算出「生效值」会造出第二个权威,两处迟早对不上。
    style: doc.style || null,
    styleUnknown: doc.styleUnknown || null,
    styles: sys ? sys.styles : [],
    semantics: sys ? Object.keys(sys.semantics).length : 0,
    assets: doc.assets.join(' , '),
    installed: !!(sys && r[sys.library]),
  }
}

// 控制台要的一份完整卡片数据。**layout 在服务端算好随 JSON 下发**,前端只把 rects 映射成
// <rect> —— 布局逻辑因此只有一份:若让浏览器自己再实现一遍,群里那张 PNG 和控制台的图标
// 迟早长得不一样,而这种不一致没人会当 bug 报。
// withForm=false ⇒ 卡里不带表单六项。给 /api/state 那条 15s 心跳用(见 projectStyleCard):
// 群卡上根本没有「复制为新款」入口,每个绑定群都背一份整表单是白扛的字节。
function styleCard(text, extra = {}, { withForm = true } = {}) {
  const spec = swatchSpec(text)
  const meta = parseStyleMeta(text)
  const cjkTokens = parseStyleTokens(text)
  const cjkKinds = styleCjkKinds(cjkTokens)
  const card = {
    name: spec.name,
    description: spec.description,
    // 两个轴都随卡片下发:风格库要按它们标标签,群卡(withForm:false 那条)要靠 platform
    // 说清「这份管哪块」—— 一个项目多份档时,这是唯一能把它们分开的字段。
    suits: meta.suits,
    platform: meta.platform,
    nameEn: meta.nameEn,             // 英文界面用(前端登记进翻译表,中英切换两个方向都走那一套)
    descriptionEn: meta.descriptionEn,
    serif: spec.serif,
    mono: spec.mono,
    cjkKinds: cjkKinds, // 这套中文走哪一路(16 套现在不是同一条栈)
    // ⚠ **值不值得标是策略,归服务端裁**(同 roles 那条纪律):黑体是压倒性的常态
    // ——18 张卡里 12 张纯黑体 ⇒ 标了就是噪音,而这块自己的规矩写着「常态不用说,
    // 例外才值得标」(见 console.html 的 feat())。让前端判,等于把那个词
    // 抄一份到前端,而它的权威在 CJK_KIND_RE,就在这个文件里。
    // ⚠ v0.11.65 是两态,把「走黑体」和「压根没写中文族」合成了同一个「不标」——
    //   两种不同状态给同一个信号,正是 status:ok 那条教训的同族。现在三态。
    cjkState: cjkCardState(cjkTokens),
    fontStack: spec.fontStack,
    dark: !!(spec.roles && spec.roles.dark),
    radius: spec.radius,
    weight: spec.headlineWeight,
    palette: spec.roles ? spec.roles.palette : [],
    // 角色四色 + 表单六项(v0.11.21「复制为新款」):**服务端算好随卡片下发**。
    // 与 layout 同一条纪律 —— 角色判定(键名词表 + 亮度/彩度启发式)只该有一份实现,
    // 让前端从 palette 自己推,迟早推出与图标不一致的四个色。
    roles: spec.roles ? { bg: spec.roles.bg, ink: spec.roles.ink, accent: spec.roles.accent, muted: spec.roles.muted } : null,
    // 图标画法那几项**只读随卡下发**。⚠ v0.11.52 这里下发的是「用哪个图标库」,2026-08-25 拿掉了 ——
    //   **图标库与设计风格平级**,用哪套是项目的选择(design/icons.md),不是这份风格档的属性;
    //   在风格卡上标「图标 tabler」会让人以为换风格就换图标,而那正是要拆开的绑定。
    //   现在只剩「怎么画它」(线性/实心 · 描边 · 端点 · 尺寸档数),那确实是风格的事。
    // ⚠ **只读,不进表单**:表单一旦部分管这个段,重新 compose 出的新档就「已有该段」,
    //   `withKeptSections` 便不再带回旧值 ⇒ size 等子键被静默删掉。要可编辑,得先把那处合并
    //   从**整段级**改成**子键级**。这坑正是当初逼出 withKeptSections 的形状。
    icons: iconSummary(parseStyleTokens(text)),
  }
  // 复用上面这份 spec —— styleFormFromDoc(text) 会把 swatchSpec 整个再跑一遍
  // (parseStyleTokens + parseStyleMeta + styleRoles),而结果与手里这份逐字节相同。
  if (withForm) card.form = _styleFormFrom(spec, meta, parseStyleTokens(text))
  card.layout = swatchLayout(spec)
  return { ...card, ...extra }
}

// 某个项目目录当前用的风格档 → 控制台群卡那一行(没有则 null)。与 findStyleDoc 同一套认帧。
// 读不动一律当「没有」:每个 /api/state 都会跑这个,一个权限不对的文件不该把控制台状态接口打挂
// (这是展示增强,不是安全关口 —— 落盘裁决那侧仍然 fail-closed)。
// 某个项目现有的**全部**风格档 → 群卡那几行(v0.11.22)。读不动一律跳过并继续:
// 每个 /api/state 都会跑一遍,一个权限不对的文件不该把控制台状态接口打挂。
function projectStyleCards(workdir) {
  if (!workdir) return []
  let docs = []
  try { docs = findStyleDocs({ cwd: workdir }) } catch { return [] }
  const out = []
  for (const d of docs.slice(0, MAX_PROJECT_STYLE_CARDS)) {
    try { out.push(styleCard(fs.readFileSync(d.abs, 'utf8'), { rel: d.rel, platform: d.platform }, { withForm: false })) } catch { /* 单份读不动就跳过 */ }
  }
  return out
}

function projectStyleCard(workdir) {
  if (!workdir) return null
  try {
    const abs = findStyleDoc({ cwd: workdir })
    if (!abs) return null
    // 不带 form:这张卡挂在 /api/state 上,每 15s 随每个绑定群下发一次;群卡只用得到
    // 名字/描述/图元,收录弹窗也只读 name。表单六项是风格库那张卡的事。
    return styleCard(fs.readFileSync(abs, 'utf8'), { rel: path.relative(workdir, abs) }, { withForm: false })
  } catch { return null }
}

// ── 自定义风格:表单 → 标准风格档(v0.11.21)──────────────────────────────────
// 为什么是「创建」而不是「导入」:operator 手里有品牌色值和对气质的直觉,**没有**一份现成的
// 规范 markdown —— front matter + prose 那套格式是本系统的实现细节,不该要求人手写 YAML。
// 所以入口是一张表单:六项定调 → 这里编译成一份合规风格档。
//
// ⭐ 最要紧的一条设计:生成的档**永远用四个语义键名**(bg/ink/accent/muted)。ROLE_KEYS 整键名
// 直接命中 ⇒ 「强调色」就是用户在表单里点的那个,不会退回「挑彩度最高的」。真机踩过的坑正相反:
// 键名叫 blue/yellow 时改色值改不动角色归属,按钮恒是最鲜艳那个(见 SWATCH_ROLE_HINT)。
//
// 分工边界:表单只管 tokens 定调;prose 这里只出**模板占位**(能从 tokens 填实的填实),
// 「一个具体参照胜过一堆形容词」那层深化交给群里对话迭代 —— 控制台不内嵌模型调用。

const SCENE_WORDS = ['内容阅读', '品牌门面', '工具产品', '活动推广', '生图插画'] // 与内置预设的 suits 同词表
// 载体词表(v0.11.22)。与 SCENE_WORDS 是**两个轴**,理由见 parseStyleMeta 的注释。
// 五档按「同一套设计要重画一遍」来分:换载体就要换单位、换圆角尺度、换组件基座的,才配单独一档
// —— 小程序(rpx/750 设计稿/原生组件)与后台网站(px·rem/桌面容器/组件库)差得最远,
// 真机取证:某项目同一个品牌下这两块的圆角、间距、正文字号、层级表达没有一项相同。
const PLATFORM_WORDS = ['小程序', '后台网站', '网页前台', '移动 App', '印刷物料']
// 画布口径:只在标了载体时写进档的 Layout 段。**这是这份档最先被用到的一个数** ——
// 出图/做原型第一件事就是定画布,写死在档里比每次问一遍便宜。可改(它是骨架不是铁律)。
const PLATFORM_CANVAS = {
  小程序: '750rpx 设计稿(逻辑宽 375px),安全区避让底部 tab',
  后台网站: '桌面 1280–1440px 容器,侧栏 + 主区两栏',
  网页前台: '桌面 1440px 与移动 375px 两档,断点 768 / 1024',
  '移动 App': '375px 逻辑宽,切图 @2x/@3x',
  印刷物料: '毫米制,出血 3mm、安全边距 5mm',
}
const COLOR_KEYS = ['bg', 'ink', 'accent', 'muted']
const COLOR_LABELS = { bg: '底色', ink: '文字', accent: '强调', muted: '次要' }

// ── 补充色(v0.11.21)────────────────────────────────────────────────────────
// 四角色之外的高频色也值得留在档里(参考站点的第二强调、图表色、状态色),但它们**不许参与
// 角色判定** —— 键名走 `alt-1…alt-N`,而 alt 不在 ROLE_KEYS 的任何一档词表里,整键名命不中,
// 于是四角色永远还是 bg/ink/accent/muted 那四个。⚠ 改这个前缀前先回头看 ROLE_KEYS:
// 起个叫 `brand-2` / `secondary-1` 的名字就会当场抢走 accent / muted。
const EXTRA_COLOR_PREFIX = 'alt-'
const EXTRA_COLOR_MAX = 6        // 再多就不是「补充」而是另一套色板了,预览色板条也排不下
const EXTRA_COLOR_POOL = 16      // 并档时先看这么多档,再从里面挑补充色
const EXTRA_COLOR_MIN_COUNT = 2  // 只出现一次的是一次性用法,不算这套设计的色板

// 圆角四档。**每档都要在预览图上一眼可分**,所以取值不是「好看的数」而是拉得开的数:
// 卡片圆角 = radius×k(k≈0.59)后 clamp 16,按钮圆角 = min(radius×k, 13)。
// 胶囊档必须同时给一个 <100 的常规档 —— 全是 ≥100 时 swatchSpec 会退到 PILL 哨兵,
// 整张图标(卡片、色块、标题条)一起胶囊化,而胶囊本来只是**按钮**的语义。
const ROUND_LEVELS = {
  sharp: { id: 'sharp', label: '直角', rounded: { none: '0px' }, note: '圆角恒 0 —— 秩序感来自对齐,不来自弧度' },
  subtle: { id: 'subtle', label: '微圆', rounded: { sm: '4px', md: '6px' }, note: '6px 以内的收边 —— 只为去掉扎手感,不表达亲和' },
  soft: { id: 'soft', label: '柔圆', rounded: { md: '12px', lg: '18px' }, note: '12–18px 的柔角 —— 容器与图片都圆,气质偏亲和' },
  pill: { id: 'pill', label: '胶囊', rounded: { md: '8px', full: '999px' }, note: '容器微圆、按钮与标签走整胶囊(999px)' },
}
// 标题字重三档。字号一并给(headline/body 都有 fontSize ⇒ titleScale 这条**连续量**通道才有值):
// 32/40/48 对 16 = 2.0/2.5/3.0,预览图的标题条高随之 8/10/12px,三档肉眼分得出。
const WEIGHT_LEVELS = {
  light: { id: 'light', label: '轻', fontWeight: 500, headlineSize: 32, note: '标题与正文只差字号,不靠加粗喊' },
  // ⚠ 600 不是 650:650 不在九档标准字重里 —— 拉丁 Inter 是可变字体、真渲染得出 650,而中文
  //   静态族只有九档(苹方最重到 Semibold 600)⇒ 汉字走合成伪粗,**同一行里拉丁真粗、汉字假粗**。
  //   分档不受影响(quantizeWeight ≤550 轻 / ≤700 中),预览三档的区分度靠 fontSize 不靠字重。
  medium: { id: 'medium', label: '中', fontWeight: 600, headlineSize: 40, note: '标题略重于正文,层级清楚但不压迫' },
  heavy: { id: 'heavy', label: '重', fontWeight: 800, headlineSize: 48, note: '标题很重很大,第一视线由它独占' },
}
const BODY_SIZE = 16

// ── 字体栈:恒定一套,表单不再让人选 ────────────────────────────────────────
// ⚠ **产品决定去掉表单里的整个「字体」栏**(含衬线/等宽两个勾),理由:中文字体
//   是低频决定,占着表单一格不值;要换字体在群里说一句更省事。生成的档因此恒定用这一套。
// ⚠ **系统字体优先**:mac 苹方 / win 雅黑都自带,一个字节不用下载。原先每档只挂一个
//   `'Noto Sans SC'`,而它是 webfont —— 真实项目 439 个文件里 `@font-face` 命中 0 个 ⇒
//   根本没加载 ⇒ Windows 掉到浏览器默认(常是宋体),那就是用户报的「丑」。
// ⚠ 思源两族保留在**栈尾**:项目真引入了 webfont 时它仍生效,不堵死「跨平台完全一致」那条路。
// ⚠ **手写的内置档不受此限** —— 新中式该用宋体、precision-mono 该用等宽,那是它们的设计身份;
//   这里管的只是**表单生成**出来的档。
const LATIN_SANS = "'Inter', 'Helvetica Neue'"
// ⚠ 顺序**与控制台自己那条 `--sans` 逐字一致**(2026-09-02 用户指定):思源系排在雅黑**之前**。
//   我原先按「系统自带优先、不下载」把思源排到最后 —— 那条逻辑用错了地方:思源装了就比雅黑
//   好看,没装时它本来也不生效,**排前面没有任何代价**。
const CJK_SYSTEM_FIRST = ['PingFang SC', 'Hiragino Sans GB', 'Source Han Sans SC', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei']
const GENERIC_WORDS = ['sans-serif', 'serif', 'monospace', 'ui-monospace', 'cursive', 'system-ui', 'ui-sans-serif', 'ui-serif']
const _q = (f) => (/^[A-Za-z][A-Za-z0-9-]*$/.test(f) ? f : `'${f.replace(/'/g, '')}'`)
function _stackFamilies(stack) {
  return String(stack || '').split(',').map((x) => x.replace(/['"]/g, '').trim()).filter(Boolean)
}
function fontStack(latin, cjkFamilies, generic) {
  return [latin, ...(cjkFamilies || []).map(_q), generic].filter(Boolean).join(', ')
}
const SANS_STACK = fontStack(LATIN_SANS, CJK_SYSTEM_FIRST, 'sans-serif')
// ⚠ 表单里连**那行只读说明**也不要了(2026-09-02 产品决定,继 v0.11.64 去掉选项之后)。
//   曾有个 `defaultFontHint()` 给它供数,已随说明一起删 —— 留个没人消费的字段,就是下一次
//   「两处各写一份」的种子。**要看一份档的中文走哪一路,看风格卡上那枚 chip**(styleCjkKinds),
//   它逐档为真;而全局说一句「中文用系统黑体」对库里那 5 份宋体标题档是错的。
// 一份档用的是哪一路中文字体(黑体/宋体/圆体/手写)。⚠ 一份档可能混用(编辑风是标题衬线、
// 正文无衬线)⇒ 返回**出现过的所有类别**,别只报一个把另一半藏起来。
const CJK_KIND_RE = [['宋体', /Songti|SimSun|Noto Serif|Source Han Serif|宋体/i], ['圆体', /Yuanti|圆体/i],
  ['手写', /Xiaolai|小赖|Caveat/i], ['黑体', /PingFang|Hiragino|Microsoft YaHei|Noto Sans|Source Han Sans|苹方|雅黑|黑体/i]]
// 中文那一路的**常态**。风格卡只标例外(styleCard 的 cjkState)—— 实测 18 张卡里 12 张
// 是纯黑体,标了它等于给三分之二的卡片贴同一个词,而真正该被一眼看见的是那 6 张不走黑体的。
const CJK_KIND_DEFAULT = '黑体'
// 风格卡上那枚中文标签的三态裁决(**唯一**裁决处,前端只消费):
//   'exception' 不走黑体(宋体/圆体/手写)⇒ 标出来 · 'default' 走黑体 ⇒ 常态不标 ·
//   'missing'   声明了字体却一个中文族都没有 ⇒ 标「中文未声明」。
// ⚠ 'missing' 只在**确实声明过 fontFamily** 时成立 —— 一份连字体都没写的档,「中文未声明」
//   是句废话;与 design doctor ④ 同口径(它也只看有 fontFamily 的档位)。
// ⚠ 判的是整份档的汇总,不是逐档位:headline 有中文而 label 没有 ⇒ 这里算「走黑体」,
//   逐档位那一层交给 doctor ④ —— 卡片是挑档用的,不是体检报告。
function cjkCardState(tokens) {
  const kinds = styleCjkKinds(tokens)
  if (kinds.length) return kinds.some((k) => k !== CJK_KIND_DEFAULT) ? 'exception' : 'default'
  const anyFF = Object.values((tokens && tokens.typography) || {}).some((v) => v && typeof v === 'object' && v.fontFamily)
  return anyFF ? 'missing' : 'default'
}

// ── 顶层 `fonts` 段(v0.11.68):字体身份与中文兜底分开 ──────────────────────────────
// 由来:一条 fontFamily 栈里挤着两件不同的事 —— **拉丁族**(风格身份,每份该不同)和**中文族**
// (兜底基础设施,16 份逐字相同)。后果全是结构性的:中文栈改一次 = 改 16 份 × 3~4 档 ≈ 50+ 处
// (v0.11.63/64 就是这么干的,还得靠单测钉「三处同源」);「缺中文兜底」要逐档查同一件事;
// 表单给不了字体身份(生成器三档恒 Inter)。⇒ 拆开:
//   fonts:                         # 档级默认
//     latin: "'Canela', 'Playfair Display'"
//     cjk: serif                   # 中文那一路的**档位**(sans / serif / rounded / hand),不是自由栈
//   typography:
//     headline: { fontSize: "56px" }          # 不写 fontFamily ⇒ 由 fonts 合成
//     body:     { latin: "'Neue Haas Grotesk'", cjk: sans, fontSize: "17px" }   # 档位级覆盖
//     data:     { latin: "'Geist Mono'", generic: monospace }                   # 尾巴的通用族可显式给
// ⚠ 档位制不做自由栈:扫描 16 份内置档,中文序列**正好四种**、与 cjkKinds 四类一一对应 ——
//   这就是「一致性由取得到正确的东西保证」:写 `cjk: serif` 一定拿到那条打磨过的宋体栈。
// ⚠ 老写法(每档一条完整 fontFamily)**继续认且优先**:有 fontFamily 的档位一个字不动 —— 它既是
//   兼容层,也是逃生口(日文栈这类四档位表达不了的照旧逐字写)。
// ⚠ `sans` 那条**就是** CJK_SYSTEM_FIRST 同一个数组(不是抄一份)—— 生成器 / 内置档 / 控制台
//   「三处同源」那条单测从此钉的是同一个对象。
const CJK_STACKS = {
  sans: CJK_SYSTEM_FIRST,
  serif: ['Source Han Serif SC', 'Noto Serif SC', 'Songti SC', 'PingFang SC', 'Microsoft YaHei'],
  rounded: ['Yuanti SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei'],
  hand: ['Xiaolai', ...CJK_SYSTEM_FIRST],
}
const CJK_KIND_OF_STACK = { sans: '黑体', serif: '宋体', rounded: '圆体', hand: '手写' }
const CJK_STACK_DEFAULT = 'sans'
// 尾巴的通用族:显式 `generic` 优先;否则拉丁族名里带 mono ⇒ monospace,宋体 ⇒ serif,手写 ⇒ cursive,其余 sans-serif
function _inferGeneric(latin, cjk) {
  if (/mono/i.test(String(latin || ''))) return 'monospace'
  if (cjk === 'serif') return 'serif'
  if (cjk === 'hand') return 'cursive'
  return 'sans-serif'
}
// 一档的合成结果(字符串栈)。tokens 已是建好的树;slot 缺 fontFamily 且档里有 fonts 段或档位有
// latin/cjk/generic 时才合成,否则返回原值(可能是 undefined)—— 老档因此逐字节不变。
function resolveFontFamily(tokens, slotName) {
  const typo = (tokens && tokens.typography) || {}
  const v = typo[slotName]
  if (!v || typeof v !== 'object') return undefined
  if (v.fontFamily) return String(v.fontFamily)
  const F = (tokens && typeof tokens.fonts === 'object' && tokens.fonts) || null
  if (!F && v.latin == null && v.cjk == null && v.generic == null) return undefined
  const latin = String(v.latin != null ? v.latin : (F && F.latin != null ? F.latin : '')).trim()
  const cjkKey = String(v.cjk != null ? v.cjk : (F && F.cjk != null ? F.cjk : CJK_STACK_DEFAULT)).trim().toLowerCase()
  const cjkStack = CJK_STACKS[cjkKey] || CJK_STACKS[CJK_STACK_DEFAULT]   // 认不出的档位退回黑体,doctor 会报
  const generic = String(v.generic != null ? v.generic : (F && F.generic != null ? F.generic : _inferGeneric(latin, cjkKey))).trim()
  return fontStack(latin || null, cjkStack, generic || null)
}
function applyFontsSegment(tokens) {
  const typo = tokens && tokens.typography
  if (!typo || typeof typo !== 'object') return tokens
  for (const slot of Object.keys(typo)) {
    const v = typo[slot]
    if (!v || typeof v !== 'object' || v.fontFamily) continue
    const ff = resolveFontFamily(tokens, slot)
    if (ff) v.fontFamily = ff
  }
  return tokens
}
// 档里声明的中文档位有没有写错(fonts.cjk 或档位 cjk 不在四档里)—— 给 doctor 用
function fontsKindIssues(tokens) {
  const out = []
  const chk = (where, k) => { if (k != null && !CJK_STACKS[String(k).trim().toLowerCase()]) out.push({ where, value: String(k) }) }
  if (tokens && tokens.fonts && typeof tokens.fonts === 'object') chk('fonts', tokens.fonts.cjk)
  for (const [slot, v] of Object.entries((tokens && tokens.typography) || {})) if (v && typeof v === 'object') chk(slot, v.cjk)
  return out
}
function styleCjkKinds(tokens) {
  const out = []
  for (const v of Object.values((tokens && tokens.typography) || {})) {
    for (const fam of _stackFamilies(v && v.fontFamily)) {
      const hit = CJK_KIND_RE.find(([, re]) => re.test(fam))
      if (hit && !out.includes(hit[0])) out.push(hit[0])
    }
  }
  // 手写只是某一档的点缀,不该排在主字体前面;按「宋体/圆体/黑体 → 手写」定序
  return out.sort((a, b) => (a === '手写' ? 1 : 0) - (b === '手写' ? 1 : 0))
}

const DEFAULT_FORM_COLORS = { bg: '#FFFFFF', ink: '#1A1D24', accent: '#6D28D9', muted: '#6B7280' }
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
const SLUG_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i // Windows 保留设备名

// 文件系统报错 → 中文人话,**且不带绝对路径**:这些消息会原样进控制台 toast,而控制台
// 不展示机器内部路径。优先认 e.code(EACCES/ENOSPC 这类跨平台稳定),认不出才退回原文。
function _fsHuman(e, what) {
  const code = (e && e.code) || ''
  const why = code === 'EACCES' || code === 'EPERM' ? '没有写入权限'
    : code === 'ENOSPC' ? '磁盘没有空间了'
      : code === 'EROFS' ? '这个位置是只读的'
        : (code === 'EISDIR' || code === 'ENOTDIR' || code === 'ENOTEMPTY' || code === 'EEXIST') ? '风格库里那个名字已经被别的东西占住了'
          : (code === 'EMFILE' || code === 'ENFILE') ? '系统同时打开的文件太多了,过一会儿再试'
            : code || (e && e.message) || '未知原因'
  return new Error(what + ' —— ' + why)
}

// 单行化:name/description 会被写进 YAML 的双引号里,而 _unquote 那侧**不做转义还原** ——
// 所以引号和反斜杠不是转义而是**剔除**,换行折成空格。宁可少一个引号,也不要写出一份
// 自己解析不回来的 front matter。
function _oneline(v, max = 120) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/["\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}
const _yq = (s) => '"' + _oneline(s, 200) + '"'

// 表单归一(宽松):认不出的值一律退回默认,**不抛错** —— 这条路要给实时预览用,
// 半填的表单必须也能出图(边填边看才是这张表单的意义)。
function normalizeStyleForm(form) {
  const f = form && typeof form === 'object' ? form : {}
  const raw = f.colors && typeof f.colors === 'object' ? f.colors : {}
  const colors = {}
  for (const k of COLOR_KEYS) colors[k] = _normHex(raw[k]) || DEFAULT_FORM_COLORS[k]
  // 词表两把尺同一套写法:收数组也收「A · B」串(前者来自表单,后者是从档里读回来的),
  // 按词表顺序输出 ⇒ 顺带去重、顺带把认不出的词丢掉
  const pick = (raw, words) => {
    const arr = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split('·')
    return words.filter((w) => arr.some((x) => String(x).trim() === w))
  }
  return {
    name: _oneline(f.name, 60),
    description: _oneline(f.description, 120),
    suits: pick(f.suits, SCENE_WORDS),
    platforms: pick(f.platforms, PLATFORM_WORDS),
    colors,
    extraColors: _normExtraColors(f.extraColors, colors),
    extraTokens: _normExtraTokens(f.extraTokens),
    rounded: ROUND_LEVELS[f.rounded] ? f.rounded : 'subtle',
    weight: WEIGHT_LEVELS[f.weight] ? f.weight : 'medium',
    // 三样新属性(v0.11.22)。空/认不出 ⇒ 关掉那一样,**不编内容**:
    // gradientTo 空 = 纯色强调;statusColors 空 = 这套没定语义色(而不是「用通用的绿黄红」)。
    // 投影是唯一有默认档的一样 —— 「有没有层」这件事没法弃权,总要画成某个样子。
    gradientTo: _normHex(f.gradientTo) || '',
    elevation: ELEV_LEVELS[f.elevation] ? f.elevation : 'flat',
    statusColors: _normStatus(f.statusColors),
  }
}

// 状态色归一:三槽各自认 hex,一个都不剩就返回 null(= 这套风格没定状态色)。
function _normStatus(raw) {
  const src = raw && typeof raw === 'object' ? raw : null
  if (!src) return null
  const out = {}
  for (const k of STATUS_KEYS) {
    const hex = _normHex(src[k])
    if (hex) out[k] = hex
  }
  return Object.keys(out).length ? out : null
}

// 补充色归一:认 `"#RGB"` 也认 `{hex}`(前端传前者,提炼结果是后者);去重、剔掉与四角色
// 撞车的、封顶 EXTRA_COLOR_MAX。宽松口径 —— 坏值丢掉不抛错(实时预览要吃得下半填的表单)。
function _normExtraColors(list, colors) {
  const out = []
  for (const v of (Array.isArray(list) ? list : [])) {
    const hex = _normHex(v && typeof v === 'object' ? v.hex : v)
    if (!hex || out.includes(hex)) continue
    if (colors && COLOR_KEYS.some((k) => colors[k] === hex)) continue // 已经是某个角色了,不再重复写一遍
    out.push(hex)
    if (out.length >= EXTRA_COLOR_MAX) break
  }
  return out
}

// ── 更多属性(v0.11.21):字距 / 描边 / 间距单位 / 标题正文字号 / 行高 ──────────
// 每项都可缺席,**缺席就不写进档**(模板里那几行原样保留)。范围是提炼器与表单共用的一把尺:
// 归一时越界即丢弃(宽松,给预览用),校验时越界即报错(严格,给落盘与直打 API 用)。
const EXTRA_TOKEN_SPEC = {
  letterSpacing: { label: '字距', unit: 'em', min: -0.05, max: 0.3 },
  borderWidth: { label: '描边粗细', unit: 'px', min: 0, max: 6 },
  spacingUnit: { label: '间距单位', unit: 'px', min: 1, max: 64 },
  headlineSize: { label: '标题字号', unit: 'px', min: 24, max: 200 },
  bodySize: { label: '正文字号', unit: 'px', min: 14, max: 18 },
  lineHeight: { label: '正文行高', unit: '', min: 1.1, max: 2.2 },
}
const EXTRA_TOKEN_KEYS = Object.keys(EXTRA_TOKEN_SPEC)
function _numOrNull(v) {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}
function _normExtraTokens(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const k of EXTRA_TOKEN_KEYS) {
    const n = _numOrNull(src[k])
    if (n == null) continue
    const s = EXTRA_TOKEN_SPEC[k]
    if (n < s.min || n > s.max) continue
    // 四位小数归一。**落盘那一刻的失真挡在这里**:`1e-7` 是合法的 JS 数、也在字距的范围内,
    // 但拼进档里就是 `letterSpacing: "1e-7em"`,而读回来的 _emNum/_pxNum 只认十进制小数 ——
    // 于是这一项在档里存在、却永远读不出来(表单里它消失了,档里那行还在)。四位对这五项
    // 都够用(字距 0.0625em = 1px/16 也只有四位),取整后至少是一个能原样往返的数。
    out[k] = Number(n.toFixed(4))
  }
  // 字号是**成对**的:只有一个的话反差比无从算起,写进档只会让预览按一个假比例出图
  if ((out.headlineSize == null) !== (out.bodySize == null)) { delete out.headlineSize; delete out.bodySize }
  return out
}

// 落盘前的严格校验(与上面那条宽松归一分开:预览要宽松、保存要挑剔)。错误全中文人话。
function validateStyleForm(form) {
  const f = form && typeof form === 'object' ? form : {}
  if (!_oneline(f.name, 60)) throw new Error('风格名称必填 —— 它是这套风格在库里显示的名字')
  const raw = f.colors && typeof f.colors === 'object' ? f.colors : {}
  for (const k of COLOR_KEYS) {
    if (!_normHex(raw[k])) throw new Error(`${COLOR_LABELS[k]}不是合法的颜色值(要写成 #RRGGBB):${raw[k] == null || raw[k] === '' ? '(空)' : String(raw[k])}`)
  }
  if (f.rounded != null && f.rounded !== '' && !ROUND_LEVELS[f.rounded]) throw new Error('圆角档位无效 —— 只能是直角 / 微圆 / 柔圆 / 胶囊')
  if (f.weight != null && f.weight !== '' && !WEIGHT_LEVELS[f.weight]) throw new Error('标题字重档位无效 —— 只能是轻 / 中 / 重')
  for (const s of (Array.isArray(f.suits) ? f.suits : [])) {
    if (!SCENE_WORDS.includes(String(s).trim())) throw new Error(`适用场景「${String(s).trim()}」不在词表里 —— 挑不到它就等于没标`)
  }
  for (const s of (Array.isArray(f.platforms) ? f.platforms : [])) {
    if (!PLATFORM_WORDS.includes(String(s).trim())) throw new Error(`载体「${String(s).trim()}」不在词表里 —— 挑不到它就等于没标`)
  }
  // 补充色与更多属性:归一那侧是「坏值丢掉」,这里必须是「坏值报错」—— 控制台之外还有直打
  // 接口这条路,静默丢掉就等于用户以为存进去了、其实没有。
  const ex = f.extraColors
  if (ex != null && !Array.isArray(ex)) throw new Error('补充色要给一组颜色值')
  if (Array.isArray(ex)) {
    if (ex.length > EXTRA_COLOR_MAX) throw new Error(`补充色最多 ${EXTRA_COLOR_MAX} 个 —— 再多就不是补充,而是另起一套色板了:现在有 ${ex.length} 个`)
    for (const v of ex) {
      const hex = v && typeof v === 'object' ? v.hex : v
      if (!_normHex(hex)) throw new Error(`补充色不是合法的颜色值(要写成 #RRGGBB):${hex == null || hex === '' ? '(空)' : String(hex)}`)
    }
  }
  // 三样新属性同一条纪律:归一那侧「坏值丢掉」(预览要吃得下半填的表单),这里「坏值报错」——
  // 控制台之外还有直打接口这条路,静默丢掉就等于用户以为存进去了、其实没有。
  if (f.gradientTo != null && f.gradientTo !== '') {
    const g = _normHex(f.gradientTo)
    if (!g) throw new Error(`渐变的第二个颜色值不合法(要写成 #RRGGBB):${String(f.gradientTo)}`)
    // 两端同色不是渐变而是纯色 —— 存下去图上什么都不会变,却让人以为「我开了渐变」
    if (g === _normHex(raw.accent)) throw new Error('渐变的第二个色和强调色是同一个 —— 那是纯色,不是渐变')
  }
  if (f.elevation != null && f.elevation !== '' && !ELEV_LEVELS[f.elevation]) throw new Error('投影档位无效 —— 只能是无 / 轻 / 明显 / 彩色')
  const sc = f.statusColors
  if (sc != null && (typeof sc !== 'object' || Array.isArray(sc))) throw new Error('状态色要给一个对象(成功 / 警告 / 危险)')
  if (sc && typeof sc === 'object' && !Array.isArray(sc)) {
    for (const k of STATUS_KEYS) {
      if (sc[k] == null || sc[k] === '') continue
      if (!_normHex(sc[k])) throw new Error(`${STATUS_LABELS[k]}色不是合法的颜色值(要写成 #RRGGBB):${String(sc[k])}`)
    }
  }
  const xt = f.extraTokens
  if (xt != null && (typeof xt !== 'object' || Array.isArray(xt))) throw new Error('这几项设定要给一个对象(字距 / 描边 / 间距 / 字号 / 行高)')
  if (xt && typeof xt === 'object' && !Array.isArray(xt)) {
    for (const k of EXTRA_TOKEN_KEYS) {
      if (xt[k] == null || xt[k] === '') continue
      const s = EXTRA_TOKEN_SPEC[k]
      const n = _numOrNull(xt[k])
      if (n == null) throw new Error(`${s.label}不是一个数:${String(xt[k])}`)
      if (n < s.min || n > s.max) throw new Error(`${s.label}超出可写的范围(${s.min} ~ ${s.max}${s.unit}):${n}${s.unit}`)
    }
    const hasH = xt.headlineSize != null && xt.headlineSize !== ''
    const hasB = xt.bodySize != null && xt.bodySize !== ''
    if (hasH !== hasB) throw new Error('标题字号与正文字号要么都给、要么都不给 —— 只给一个,标题与正文的反差比无从算起')
  }
  return normalizeStyleForm(f)
}

// ── 修改已有的自定义风格(v0.11.23)────────────────────────────────────────────
// 表单只管 tokens,正文归群里对话迭代 ⇒ 「修改」时正文怎么办是个真取舍:
//   · 整份重生成 ⇒ 手写的细则(Do's/Don'ts、具体参照)当场没了
//   · 原样保留   ⇒ 正文里那些**从 tokens 填实的事实行**(色值、圆角性格、投影值)会过时
// ⚠ 本来想自动判「正文是不是还是生成的骨架」,实测**判不了**:旧版本生成的档(v0.11.21 的
//   Elevation 段还是「待补」)与当前模板天然不同,会被一律误判成「手改过」而永久冻住正文。
// ⇒ 交给人选,默认走不丢东西的那边(保留),要刷新骨架自己勾。
function styleProse(text) {
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0].trim() !== '---') return ''
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') return lines.slice(i + 1).join('\n')
  return ''
}

// 新档的 front matter + 旧档的正文。旧档没有正文(或不是风格档)就原样返回新档。
function withStyleProse(newDoc, oldDoc) {
  const keep = styleProse(oldDoc)
  if (!keep) return String(newDoc == null ? '' : newDoc)
  const lines = String(newDoc == null ? '' : newDoc).split(/\r?\n/)
  if (lines[0].trim() !== '---') return String(newDoc == null ? '' : newDoc)
  for (let i = 1; i < lines.length; i++) {
    // ⚠ 必须补回那个连接换行:`a.join('\n') + b.join('\n')` 不是 split 的逆运算,
    //   少了它会把正文开头的空行吃掉一个(单测钉着「正文逐字节相同」)
    if (lines[i].trim() === '---') return lines.slice(0, i + 1).join('\n') + '\n' + keep
  }
  return String(newDoc == null ? '' : newDoc)
}

// 新档 + 旧档里「表单管不到」的 front matter 段(整段带子键)。
// ⚠ 由来:控制台「修改风格」是 doc → 表单 → 重新 compose 的往返,而表单只认它管的那几段
// ⇒ `icons` 这类段会被**整段静默冲掉**(真机审出来的:改个强调色,图标声明就没了,还没人知道)。
// 与 v0.11.23「正文默认逐字节保留」同一条道理,故做成**通用**的:凡旧档有、新档没有的顶层段
// 一律带过去 —— 下一个新段才不会重犯这个坑。反过来,新档已有的段绝不被旧值盖回去(否则改不动)。
function withKeptSections(newDoc, oldDoc) {
  const nDoc = String(newDoc == null ? '' : newDoc)
  const oldFm = _frontMatter(oldDoc)
  const newFm = _frontMatter(nDoc)
  if (!oldFm || !newFm) return nDoc
  const topKeys = (fm) => fm.filter((l) => /^[A-Za-z0-9_-]+:/.test(l)).map((l) => l.split(':')[0])
  const have = topKeys(newFm)
  const blocks = []
  for (let i = 0; i < oldFm.length; i++) {
    const m = /^([A-Za-z0-9_-]+):/.exec(oldFm[i])
    if (!m) continue
    if (have.includes(m[1])) continue
    const block = [oldFm[i]]
    while (i + 1 < oldFm.length && !/^[A-Za-z0-9_-]+:/.test(oldFm[i + 1])) block.push(oldFm[++i])
    blocks.push(block.join('\n'))
  }
  if (!blocks.length) return nDoc
  const lines = nDoc.split(/\r?\n/)
  if (lines[0].trim() !== '---') return nDoc
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(0, i).concat(blocks, lines.slice(i)).join('\n')
  }
  return nDoc
}

// 标识 = 存盘文件名。白名单而不是黑名单:这个串会被拼进路径,`..` 与分隔符必须**从形状上**
// 就进不来,而不是靠一条条排查。
function validateStyleSlug(slug) {
  const s = String(slug == null ? '' : slug).trim()
  if (!s) throw new Error('标识必填 —— 它是这套风格在库里的唯一名字')
  if (!SLUG_RE.test(s)) throw new Error('标识只能用小写字母、数字和连字符,首位是字母或数字,最长 41 位:' + s)
  // Windows 的设备名:`con.md` / `nul.md` 这些在那边根本建不出文件(建了也不是文件),
  // 而风格档要跨机同步。形状合法但注定落不了盘,不如在这里就说清楚。
  if (SLUG_RESERVED.test(s)) throw new Error('这个名字在某些系统上是保留字,换一个:' + s)
  return s
}

// 名称 → 建议标识。只在名称是 ASCII 时给得出(中文名转不出有意义的拼写,硬转成拼音不在本模块职责内)
function suggestSlug(name) {
  const s = String(name == null ? '' : name).trim().toLowerCase()
  if (!/^[\x20-\x7e]+$/.test(s)) return ''
  const out = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41).replace(/-+$/, '')
  return SLUG_RE.test(out) ? out : ''
}

// 表单 → 一份合规风格档。front matter 走四语义键 + typography/rounded/spacing/border;
// 正文按官方八段固定序出模板:**能从 tokens 填实的填实**(色彩段写死四个 hex 与用途、字体段
// 写死字号字重、形状段写死圆角性格),填不实的留「待补:」并附一句该写什么 —— 空标题比
// 带提示的空标题更容易被忽略,而这份档的下一站就是群里让它按骨架补细则。
function composeStyleDoc(form) {
  const f = normalizeStyleForm(form)
  const R = ROUND_LEVELS[f.rounded]
  const W = WEIGHT_LEVELS[f.weight]
  // 提炼带回来的那几项**只覆盖它提到的键**,其余一律走模板原值 —— 缺席不是「默认 0」,
  // 而是「这份参考里读不出来」,那就该保持模板的样子。
  const X = f.extraTokens || {}
  const headSize = X.headlineSize != null ? X.headlineSize : W.headlineSize
  const bodySize = X.bodySize != null ? X.bodySize : BODY_SIZE
  const bodyLh = X.lineHeight != null ? X.lineHeight : 1.65
  const borderW = X.borderWidth != null ? X.borderWidth : 1
  const unit = X.spacingUnit != null ? X.spacingUnit : 8
  const track = X.letterSpacing != null ? X.letterSpacing : null
  const scale = (headSize / bodySize).toFixed(2).replace(/\.?0+$/, '')
  const C = f.colors
  // 分割线色 = 底色与文字色之间那道最轻的分界(深底浅底自动跟着走)。**显式写进档**,
  // 不留给 styleRoles 兜底:它的兜底是「从没被认领的色里挑对比最低的那个」,而补充色恰好
  // 就是那批没被认领的 —— 六个补充色一带,分割线当场被抢成其中最淡的那个(实测变纯黄)。
  // 本模块生成的档因此**五个角色全显式**,alt-N 永远只是色板成员、抢不走任何角色。
  const lineHex = _hex(..._mix(_rgb(C.bg), _rgb(C.ink), 0.14))
  // 投影:档位 → 一条能直接抄进 CSS 的 shadow 值(彩色档染强调色)。**写实值而不是只写档位名**
  // —— 这份档的下一站是让 agent 照着出图/写码,「soft」三个字它照不出来。
  const EVL = ELEV_LEVELS[f.elevation] || ELEV_LEVELS.flat
  const shRgb = EVL.tint ? _rgb(C.accent) : [0, 0, 0]
  const shadowCss = EVL.off > 0
    ? `0 ${EVL.off}px ${EVL.off * 4}px rgba(${shRgb[0]}, ${shRgb[1]}, ${shRgb[2]}, ${EVL.alpha})`
    : 'none'
  const fm = ['---', 'name: ' + _yq(f.name || '未命名风格')]
  if (f.description) fm.push('description: ' + _yq(f.description))
  if (f.suits.length) fm.push('suits: ' + _yq(f.suits.join(' · ')))
  if (f.platforms.length) fm.push('platform: ' + _yq(f.platforms.join(' · ')))
  fm.push('colors:')
  for (const k of COLOR_KEYS) fm.push(`  ${k}: "${C[k]}"`)
  fm.push(`  line: "${lineHex}"`) // 第五个语义键,见上面 lineHex 那段
  // 补充色排在五个角色之后,键名 alt-N ⇒ 抢不走角色,但进得了预览的色板条
  f.extraColors.forEach((hex, i) => fm.push(`  ${EXTRA_COLOR_PREFIX}${i + 1}: "${hex}"`))
  // 字体走顶层 fonts 段(v0.11.68):拉丁族一处、中文档位一处,各档不再逐条写整栈 —— 解析时合成,
  // 合成结果与旧写法逐字相同(单测钉住)。将来表单配拉丁族,改的就是这一行。
  // 正文里给 agent 看的那三行仍写**合成后的整栈**(它照着写 CSS,给档位名它照不出来)。
  const headFont = SANS_STACK, bodyFont = SANS_STACK, labelFont = SANS_STACK
  fm.push('fonts:', `  latin: "${LATIN_SANS}"`, `  cjk: ${CJK_STACK_DEFAULT}`)
  fm.push('typography:')
  fm.push('  headline:', `    fontSize: "${headSize}px"`, `    fontWeight: ${W.fontWeight}`, '    lineHeight: 1.2')
  if (track != null) fm.push(`    letterSpacing: "${track}em"`)
  fm.push('  body:', `    fontSize: "${bodySize}px"`, '    fontWeight: 400', `    lineHeight: ${bodyLh}`, '    measure: "62ch"')
  fm.push('  label:', '    fontSize: "12px"', '    fontWeight: 500', '    letterSpacing: "0.06em"')
  fm.push('rounded:')
  for (const [k, v] of Object.entries(R.rounded)) fm.push(`  ${k}: ${v}`)
  fm.push('spacing:', `  unit: ${unit}px`)
  fm.push('border:', `  width: ${borderW}px`, '  style: solid')
  // ── 三样新属性(v0.11.22):顶层独立段,**不进 colors** ⇒ 抢不走五个角色(见 ELEV_LEVELS 处注释)
  if (f.gradientTo) fm.push('gradient:', `  from: "${C.accent}"`, `  to: "${f.gradientTo}"`, `  angle: ${GRADIENT_ANGLE}`)
  fm.push('elevation:', `  level: ${EVL.id}`, `  shadow: "${shadowCss}"`)
  if (f.statusColors) {
    fm.push('status:')
    for (const k of STATUS_KEYS) if (f.statusColors[k]) fm.push(`  ${k}: "${f.statusColors[k]}"`)
  }
  fm.push('---', '', '')

  const prose = [
    '## Overview',
    '',
    `${f.name || '未命名风格'}${f.description ? '——' + f.description : ''}`,
    '',
    '待补:**一个具体参照胜过一堆形容词**。写下这套风格最像什么(某本杂志的内页、某个年代的招贴、',
    '某个产品的界面),以及它想给人的第一感觉。参照越具体,出图越稳;堆「现代、简洁、高级」没有用。',
    '',
    '## Colors',
    '',
    `- **bg ${C.bg}**:底色。整版的地,占面积最大的那个色。`,
    `- **ink ${C.ink}**:文字与主要图形色,承担绝大部分可读内容。`,
    `- **accent ${C.accent}**:唯一的强调色 —— 按钮、关键数字、要被第一眼看到的地方。`,
    `- **muted ${C.muted}**:次要信息(注释、说明、时间戳)。`,
    `- **line ${lineHex}**:分割线与描边 —— 底色与文字色之间最轻的那道分界,自己不承载信息。`,
    ...f.extraColors.map((hex, i) => `- **${EXTRA_COLOR_PREFIX}${i + 1} ${hex}**:补充色 —— 从参考里带回来的,用途待定。`),
    ...(f.gradientTo ? ['', `渐变:${C.accent} → ${f.gradientTo}(${GRADIENT_ANGLE}°)。只用在主按钮与头图这类大块强调上,正文与图标一律纯色。`] : []),
    ...(f.statusColors ? ['', '状态色(只表达语义,不参与视觉风格,别拿它们当装饰色):',
      ...STATUS_KEYS.filter((k) => f.statusColors[k]).map((k) => `- **${k} ${f.statusColors[k]}**:${STATUS_LABELS[k]}。`)] : []),
    '',
    '待补:每个色在什么场合用、用多少(强调色一屏最多出现几处?),以及**不许**出现的颜色。',
    ...(f.extraColors.length ? ['补充色尤其要写:它们各自代表什么(图表?状态?第二强调?),不写就等于放着不用。'] : []),
    '',
    '## Typography',
    '',
    `- 标题:${headFont} · ${headSize}px / 字重 ${W.fontWeight}${track != null ? ` / 字距 ${track}em` : ''}。${W.note}。`,
    `- 正文:${bodyFont} · ${bodySize}px / 行高 ${bodyLh} / 行长 62 字符以内。`,
    `- 标签小字:${labelFont} · 12px / 字距 0.06em。`,
    '- 中文用各平台自带的黑体(mac 苹方 / win 雅黑),一个字节不用下载;思源两族排在栈尾,项目真引入了 webfont 时仍生效。拉丁族在前、中文族在后 —— 反过来拉丁字母会用中文字体里的字形。',
    `- 层级只靠字号与字重拉开(标题与正文 ${scale} 倍反差),不靠颜色、不靠斜体。`,
    '',
    '待补:中英混排怎么处理、数字用不用等宽、标题最多允许几行。',
    '',
    '## Layout',
    '',
    `- 基础间距单位 ${unit}px,所有间距取它的整数倍。`,
    // 画布口径只在标了载体时写:出图/做原型第一件事就是定画布,写死在档里比每次问一遍便宜。
    // 没标载体的档不写 —— 它本来就不挑载体,替它假设一个画布反而是硬凑。
    ...f.platforms.filter((p) => PLATFORM_CANVAS[p]).map((p) => `- 画布(${p}):${PLATFORM_CANVAS[p]}。`),
    '',
    '待补:栏数与栅格(海报几列 / 界面几列)、留白占版面的比例、对齐方式(齐左还是居中)。',
    '',
    '## Elevation & Depth',
    '',
    // 这一段此前整段「待补」,而**含糊不写,出图时就会随机长出卡片和投影** —— 现在表单里
    // 有了档位,它就能写实:值直接可抄进 CSS,agent 不用猜。
    EVL.off > 0
      ? `- 层级:${EVL.label} —— ${EVL.note}。投影值 \`${shadowCss}\`,全局只此一档,别自创第二种。`
      : `- 层级:只有一层 —— ${EVL.note}。**不许出现投影**,要分区就用 ${lineHex} 的线或一段留白。`,
    '',
    '待补:除了投影,还靠什么表达层级(底色深浅?描边?)—— 只有一层就直说「没有别的」。',
    '',
    '## Shapes',
    '',
    `- 圆角:${R.label} —— ${R.note}。`,
    borderW > 0 ? `- 描边:${borderW}px 实线。` : '- 描边:不描边 —— 分区靠底色深浅与留白,不靠线。',
    '',
    '待补:允许出现哪些形状、线条有几种(实线/虚线/粗细)、图片怎么裁(方形/出血/圆角)。',
    '',
    '## Components',
    '',
    '待补:按钮(主 / 次)、输入框、标签这三样的具体规格 —— 高度、内边距、底色与文字色、',
    'hover 时变什么(换色还是加深)。写死一次,之后所有图都照它画。',
    '',
    "## Do's and Don'ts",
    '',
    '- Do:待补 —— 这套风格最该坚持的两三件事。',
    "- Don't:待补 —— **写具体**。「不要太花」等于没写;「不要出现第二种强调色」「不要用斜体导语」才拦得住。",
    '',
  ]
  return fm.join('\n') + prose.join('\n')
}

// 圆角/字重的反向量化(「复制为新款」与「从参考提炼」都要把连续量落回档位)
function quantizeRounded(radius, pill) {
  if (pill) return 'pill'
  const r = Number(radius) || 0
  if (r >= 100) return 'pill' // 只有胶囊档、没有常规档的老风格档
  if (r <= 2) return 'sharp'
  if (r <= 10) return 'subtle'
  return 'soft'
}
function quantizeWeight(w) {
  const n = Number(w) || 400
  if (n <= 550) return 'light'
  if (n <= 700) return 'medium'
  return 'heavy'
}

// alt-N 的键名形状。**模块级**:此前现编在 filter 回调里,每个候选色都要新建一个 RegExp
// 对象,而这个形状从头到尾是常量。
const ALT_KEY_RE = new RegExp('^' + EXTRA_COLOR_PREFIX + '\\d+$', 'i')

// 档里的 tokens → 表单的「更多属性」五项(形状与 deriveExtraTokens 的输出一致)。
// 判据 = **只回收「与模板会写下的那个值不同」的项**。理由:composeStyleDoc 对每一份档都会
// 写下 spacing.unit / border.width / 字号对 / 行高 —— 那是模板骨架而不是作者的决定,照单
// 全收就等于把模板默认值当成「从这份档里提炼所得」交出去,证据区还会多出一行「还读到 ·
// 描边 1px · 间距 8px 网格」,而那句话是假的:没有人读到过它。
// 字距是唯一的例外 —— 模板不给就整行不写,所以「这一行存在」本身就是作者写过的证据,
// 值等于多少都收(`0em` 是「这套风格不加字距」这个真设定)。
// ⚠ 代价明写在这里:作者真把描边设成 1px(= 模板默认)时这一项回收不回来。档不会因此
//   变样(再存一次仍是 1px),丢的只是表单里那一个已填的数 —— 而档里本来就区分不出
//   「模板写的 1px」与「作者写的 1px」,这是这份格式下能做到的最好一档。
function _extraTokensFromDoc(tokens, weight) {
  const t = tokens && typeof tokens === 'object' ? tokens : {}
  const { head, body } = _typoOf(t)
  const out = {}
  if (head.letterSpacing != null) out.letterSpacing = _emNum(head.letterSpacing)
  const bw = _pxNum(t.border && typeof t.border === 'object' ? t.border.width : null)
  if (bw != null && bw !== 1) out.borderWidth = bw
  const unit = _pxNum(t.spacing && typeof t.spacing === 'object' ? t.spacing.unit : null)
  if (unit != null && unit !== 8) out.spacingUnit = unit
  const lh = _pxNum(body.lineHeight) // 无单位数,_pxNum 取前导数字 ⇒ 同样读得出
  if (lh != null && lh !== 1.65) out.lineHeight = lh
  // 字号是成对项:两个都在、且不是「档位默认那对」才算作者写的(_normExtraTokens 那侧还会
  // 再把落单的一个丢掉,这里只管「是不是模板原样」)
  const hs = _pxNum(head.fontSize)
  const bs = _pxNum(body.fontSize)
  const W = WEIGHT_LEVELS[weight] || WEIGHT_LEVELS.medium
  if (hs != null && bs != null && !(hs === W.headlineSize && bs === BODY_SIZE)) { out.headlineSize = hs; out.bodySize = bs }
  return out
}

// 任意一份风格档 → 本表单的各项(「复制为新款」的预填数据)。**角色四色从 styleRoles 出**,
// 不让前端自己从 palette 里推 —— 那套判定(键名词表 + 亮度/彩度启发式)只该有一份实现。
function styleFormFromDoc(text) { return _styleFormFrom(swatchSpec(text), parseStyleMeta(text), parseStyleTokens(text)) }
// 拿**算好的** spec + meta,不再自己去解析 —— styleCard 手里已经有一份 spec,让它复用。
// tokens 是第三样必须带的:字号对与行高只在 typography 段里,spec 那侧只留下了比值。
function _styleFormFrom(spec, meta, tokens) {
  const r = spec.roles
  const weight = quantizeWeight(spec.headlineWeight)
  return normalizeStyleForm({
    name: meta.name,
    description: meta.description,
    suits: meta.suits,      // 「A · B」串,normalizeStyleForm 的 pick 两种形状都收
    platforms: meta.platform,
    colors: r ? { bg: r.bg, ink: r.ink, accent: r.accent, muted: r.muted } : null,
    // 补充色照原样带回表单 —— 「复制为新款」若把它们丢了,复制出来的那套就少了半张色板。
    // 只认 alt-N 键(那是本模块自己写下的记号);别人手写的档里其它键名不当补充色抓过来。
    extraColors: r ? r.palette.filter((p) => ALT_KEY_RE.test(p.key)).map((p) => p.hex) : [],
    // 更多属性同理:丢了它们,「复制为新款」复制出来的那套字距/描边/间距/字号全退回模板值
    extraTokens: _extraTokensFromDoc(tokens, weight),
    rounded: quantizeRounded(spec.radius, spec.pill),
    weight,
    // 三样新属性同样要回收 —— 丢了它们,「复制为新款」复制出来的那套会悄悄退回纯色按钮、
    // 默认投影、没有状态色,而人以为自己只是换了个色。
    gradientTo: spec.gradient ? spec.gradient.to : '',
    elevation: spec.elevation ? spec.elevation.id : 'flat',
    statusColors: (spec.status || []).length
      ? Object.fromEntries(spec.status.map((s) => [s.key, s.hex]))
      : null,
  })
}

// front matter 里的 name 换一个(「收录群里那份进全局库」时可改名,正文与其余 tokens 原样保留)
function withStyleName(text, name) {
  const src = String(text == null ? '' : text)
  const nm = _oneline(name, 60)
  if (!nm || !_frontMatter(src)) return src
  const lines = src.replace(/^\uFEFF/, '').split(/\r?\n/)
  let end = -1
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break }
  if (end < 0) return src
  for (let i = 1; i < end; i++) if (/^name:\s*/.test(lines[i])) { lines[i] = 'name: ' + _yq(nm); return lines.join('\n') }
  lines.splice(1, 0, 'name: ' + _yq(nm))
  return lines.join('\n')
}

// 落盘:原子写(tmp + rename)到用户目录。三条语义:
//   ① 同 slug 已有自定义 ⇒ 冲突,要 overwrite 才覆盖(err.code='CONFLICT',调用方翻 409)
//   ② 与内置同名不算冲突,但要如实告知「遮蔽了内置的那套」—— 删掉它就回归内置
//   ③ 写之前先 isStyleDoc 认帧:编译出来的东西若不是风格档,一个字节都不落
function saveUserStyle(slug, text, { dir = userStylesDir(), builtinDir = BUILTIN_STYLES_DIR, overwrite = false } = {}) {
  const s = validateStyleSlug(slug)
  const bodyText = String(text == null ? '' : text)
  if (!isStyleDoc(bodyText)) throw new Error('要存的内容不是风格档(front matter 里没有 colors)—— 已中止,没有写入任何文件')
  const file = path.join(dir, s + '.md')
  let existed = true
  try { fs.accessSync(file) } catch { existed = false }
  if (existed && !overwrite) {
    const e = new Error(`风格库里已经有「${s}」了 —— 勾上「覆盖同名」再保存,或换一个标识`)
    e.code = 'CONFLICT'
    throw e
  }
  let shadowed = false
  try { fs.accessSync(path.join(builtinDir, s + '.md')); shadowed = true } catch { shadowed = false }
  // 点开头 + .tmp 后缀:listStyles 只收 `.md`,半截文件在任何时刻都不会被列出来
  const tmpFile = path.join(dir, '.' + s + '.' + process.pid + '.tmp')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmpFile, bodyText)
    fs.renameSync(tmpFile, file)
  } catch (e) {
    throw _fsHuman(e, `存不进风格库(「${s}」)`)
  } finally {
    // rename 成功时它已经不在了(ENOENT 是预期);失败时**必须**清掉,否则每失败一次
    // 就在库目录里留一片半截文件,下次同名再写还会被同一个 pid 名字撞上。
    try { fs.unlinkSync(tmpFile) } catch { /* 清残片本身失败无从补救,也不该盖住真正的错 */ }
  }
  return { path: file, replaced: existed, shadowed }
}

// 只删用户目录里的那份 —— 内置的删不掉(也不该删)。删掉一个遮蔽内置的同名 ⇒ 回归内置。
function deleteUserStyle(slug, { dir = userStylesDir(), builtinDir = BUILTIN_STYLES_DIR } = {}) {
  const s = validateStyleSlug(slug)
  try { fs.unlinkSync(path.join(dir, s + '.md')) } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error(`风格库里没有自己建的「${s}」—— 内置的那些删不掉,也不需要删`)
    throw _fsHuman(e, `删不掉「${s}」`)
  }
  let revertedToBuiltin = false
  try { fs.accessSync(path.join(builtinDir, s + '.md')); revertedToBuiltin = true } catch { revertedToBuiltin = false }
  return { removed: true, revertedToBuiltin }
}

// ── 从参考提炼(确定性提取器,不过模型)────────────────────────────────────────
// 定位要说清楚:这是**起点**不是成品 —— 抓 CSS 里的色值/字族/圆角按频次排序,喂给 styleRoles
// 推四角色回填表单,用户再手调。深度提炼(读懂气质、写 prose)是群里对话那条路的事。
// 出网走配置里的代理(core/proxy 的隧道 fetch,与 Slack 适配器同一份):Node 的全局 fetch 不读
//   HTTP_PROXY 一类环境变量,墙内机器直连海外站点是 8 秒超时(实测 sintbot.com:直连超时,走代理 1.7s)。
//   没配代理才退回全局 fetch。
const MAX_CSS_CHARS = 512 * 1024
const EXTRACT_MAX_SHEETS = 6
const EXTRACT_TIMEOUT_MS = 8000
const EXTRACT_WALL_MS = 10_000 // 整次提炼的总墙钟(抓取 + 解析),两条入口共用
const EXTRACT_MAX_HOPS = 3     // 手动跟跳的上限
const LINK_TAG_MAX = 4096      // 单个 <link> 标签的长度上限(真的连 200 字节都到不了)

// 总墙钟。**必须有**:这两条入口都在 daemon 进程里同步跑解析,一次病态输入卡住的不是
// 「提炼」这一个功能,而是整个守护进程(群里所有消息一起停)。返回一个 tick 函数,在
// 逐文件/逐样式表的循环里点一下 —— 粒度到单份文件足够了,单份已被 512KB 封顶。
function _wallClock(ms, now = Date.now) {
  const at = now() + ms
  return () => {
    if (now() <= at) return
    const e = new Error(`这次提炼花的时间太长了(超过 ${Math.round(ms / 1000)} 秒)—— 参考太大了,换一个更小的页面或目录,或者把它发到群里让它慢慢看`)
    e.code = 'EXTRACT_GUARD'
    throw e
  }
}
const _noTick = () => {}

// 剥掉 /* … */ 注释。**手写扫描,不用正则**:懒量词那版 `/\/\*[\s\S]*?\*\//g` 在「大量未闭合
// /*」的输入上是 O(N²)(每个 `/*` 都要往后扫到结尾才发现没有 `*/`,再回头从下一个位置重来),
// 512KB 的病态 CSS 实测十秒起;extractFromDir 一次吃 200 份文件 ⇒ 半小时冻死同进程的 daemon。
// 非回溯的「展开循环」正则也不保险(引擎不一定看得出 `[^*]*` 后面接 `\*` 无需回溯),
// indexOf 扫一遍才是从形状上就 O(N) 的写法。
// 未闭合的 `/*` 之后整段算注释 —— 与浏览器同判(旧的正则版会把它整段当有效 CSS 读回来)。
function stripCssComments(src) {
  const s = String(src == null ? '' : src)
  let out = ''
  let i = 0
  for (;;) {
    const a = s.indexOf('/*', i)
    if (a < 0) { out += s.slice(i); break }
    out += s.slice(i, a)
    const b = s.indexOf('*/', a + 2)
    if (b < 0) break
    i = b + 2
  }
  return out
}

// 规则块切分 → [{ sel, body, at }]。单趟 indexOf 扫描(O(N)),不走正则 —— 原来那条
// `([^{}]{0,400})\{([^{}]{0,4000})\}` 对超过 4000 字的声明体整块跳过,而大站的 :root 变量块动辄上万字
// (飞书、Tailwind 主题),根规则上的声明就这样一个都看不见。@media / @supports 这类分组只是往里走一层;
// 声明体里再出现 `{`(CSS 嵌套写法)就整块跳到它真正闭合的地方。
const ROOT_SEL = /(^|,)\s*(html|body|:root|page)\s*(,|$)/i
const DARK_SEL = /dark|night/i
function _cssRules(src, tick = _noTick) {
  const out = []
  let i = 0
  while (i < src.length) {
    if ((out.length & 255) === 0) tick()
    const ob = src.indexOf('{', i)
    if (ob < 0) break
    let sel = src.slice(i, ob)
    sel = sel.slice(Math.max(sel.lastIndexOf('}'), sel.lastIndexOf(';')) + 1).trim()
    if (sel.startsWith('@')) { i = ob + 1; continue } // 分组 at-rule:往里走一层
    const cb = src.indexOf('}', ob + 1)
    if (cb < 0) break
    const inner = src.indexOf('{', ob + 1)
    if (inner >= 0 && inner < cb) {
      let depth = 1
      let j = ob + 1
      while (j < src.length && depth > 0) { const c = src.charCodeAt(j); if (c === 123) depth++; else if (c === 125) depth--; j++ }
      i = j
      continue
    }
    out.push({ sel: sel.slice(-400), body: src.slice(ob + 1, cb), at: ob })
    i = cb + 1
  }
  return out
}

// 自定义属性表:`--brand-bg: #0F1117` 这类定义按出处分三档,同名取档位最靠前的那一份(同档先到先得):
//   0 = 根规则(:root / html / body / page),且不在夜间媒体查询里 —— 站点的默认主题
//   1 = 其他普通规则
//   2 = 夜间主题(选择器带 dark / night,或在 prefers-color-scheme: dark 里)
// 不收这张表,`:root{--bg:#0F1117} body{background:var(--bg)}`(深色站的主流写法)的底色一个都记不到;
// 只按先到先得的话,飞书把 `:root[data-ud-theme-mode=dark]{--bg-body:…}` 写在默认主题前面,白底站的底色就成了夜间色。
function _rankCssVars(rules, inDark, into = new Map()) {
  for (const r of rules) {
    if (r.body.indexOf('--') < 0) continue
    const rank = (DARK_SEL.test(r.sel) || inDark(r.at)) ? 2 : ROOT_SEL.test(r.sel) ? 0 : 1
    for (const m of r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]{1,200})/g)) {
      const k = m[1].toLowerCase()
      const cur = into.get(k)
      if (!cur || rank < cur.rank) into.set(k, { v: m[2].trim(), rank })
    }
  }
  return into
}
// 值里的 var(--x) 展开。depth 封顶 4:自定义属性允许互相引用,`--a:var(--b); --b:var(--a)`
// 不封顶就是死循环;四层覆盖「语义变量 → 主题变量 → 色板变量」这类真实链路(飞书:--bg-body → --N00 → #fff)。
function _resolveCssVars(val, vars, depth = 0) {
  const s = String(val == null ? '' : val)
  if (depth >= 4 || !/var\(/i.test(s)) return s
  const next = s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/gi,
    (all, name, fb) => { const v = vars.get(name.toLowerCase()); return v != null ? v : (fb == null ? '' : fb) })
  return next === s ? s : _resolveCssVars(next, vars, depth + 1)
}

function _clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))) }
function _hslToHex(h, s, l) {
  const hh = ((Number(h) % 360) + 360) % 360
  const ss = Math.max(0, Math.min(1, Number(s) / 100))
  const ll = Math.max(0, Math.min(1, Number(l) / 100))
  const c = (1 - Math.abs(2 * ll - 1)) * ss
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = ll - c / 2
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hh / 60) % 6]
  return _hex(_clamp255((seg[0] + m) * 255), _clamp255((seg[1] + m) * 255), _clamp255((seg[2] + m) * 255))
}

// oklch() → #RRGGBB(v0.11.22)。**不是可选项**:Tailwind v4 与 shadcn/ui 现在默认就把整套主题
// 写成 oklch,不认它的话,一个现代后台的底色/主色一个都读不到 —— 提炼出来的是散落在别处的
// 边框灰(某项目后台实测:底色被判成 #CCCCCC,而真底色是 oklch(0.97 0.002 100))。
// OKLab → 线性 sRGB → gamma 编码,系数取自 Björn Ottosson 的公开推导。超出色域的分量直接
// 截断到 0..1(与浏览器的朴素做法一致;做 gamut mapping 属过度工程,这里只是统计取色)。
function _oklchToHex(L, C, H) {
  const l0 = Number(L)
  const c0 = Number(C)
  const h0 = (Number(H) || 0) * Math.PI / 180
  if (!Number.isFinite(l0) || !Number.isFinite(c0)) return null
  const a = c0 * Math.cos(h0)
  const b = c0 * Math.sin(h0)
  const l_ = l0 + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l0 - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l0 - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
  const enc = lin.map((v) => {
    const x = Math.max(0, Math.min(1, v))
    return _clamp255(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055))
  })
  return _hex(enc[0], enc[1], enc[2])
}

// 一段文本里的颜色字面量 → 归一后的 #RRGGBB 数组(按出现顺序,允许重复 —— 频次就是从这来的)。
// 近乎全透明的色不算(alpha < minAlpha,默认 0.1):它是「没有颜色」的写法,不是一个色。
// 统计色板时门槛要更高(见 PALETTE_MIN_ALPHA);投影、渐变照旧用默认值 —— 投影本来就是半透明的。
function colorLiterals(text, { minAlpha = 0.1 } = {}) {
  const src = String(text == null ? '' : text)
  const out = []
  // 长度优先匹配 + \b:`#1234567890` 这种既不是 8 位也不是 6 位的串整体不认,避免截出假色
  for (const m of src.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const h = m[1]
    if (h.length === 8 && parseInt(h.slice(6), 16) / 255 < minAlpha) continue
    const hex = _normHex('#' + (h.length === 8 ? h.slice(0, 6) : h))
    if (hex) out.push(hex)
  }
  for (const m of src.matchAll(/\brgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.%]+))?\s*\)/gi)) {
    if (m[4] != null && _alphaNum(m[4]) < minAlpha) continue
    out.push(_hex(_clamp255(+m[1]), _clamp255(+m[2]), _clamp255(+m[3])))
  }
  for (const m of src.matchAll(/\bhsla?\(\s*([\d.-]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[,/]\s*([\d.%]+))?\s*\)/gi)) {
    if (m[4] != null && _alphaNum(m[4]) < minAlpha) continue
    out.push(_hslToHex(m[1], m[2], m[3]))
  }
  // oklch(L C H) —— L 收小数也收百分比,H 可带 deg,可选 `/ alpha`。色相缺省 0(灰阶写法)。
  for (const m of src.matchAll(/\boklch\(\s*([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,]+([\d.-]+)(?:deg)?)?\s*(?:\/\s*([\d.%]+))?\s*\)/gi)) {
    if (m[4] != null && _alphaNum(m[4]) < minAlpha) continue
    const L = m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1])
    const C = m[2].endsWith('%') ? parseFloat(m[2]) * 0.004 : parseFloat(m[2]) // 百分比口径:100% = 0.4
    const hex = _oklchToHex(L, C, m[3] == null ? 0 : m[3])
    if (hex) out.push(hex)
  }
  return out
}
function _alphaNum(v) {
  const s = String(v).trim()
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return 1
  return s.endsWith('%') ? n / 100 : n
}

// ── 更多属性的收集(v0.11.21)──────────────────────────────────────────────────
// 字距 / 描边 / 间距网格 / 字号 / 行高:与颜色**同一条管线**(先展 var(),再按频次记账)。
// 纪律只有一条 —— **提不出就省略**。风格档里的每一行都会被当成作者的决定,凭空补上的那行
// 没人知道它是猜的;宁可少写一个键,也不写一个编出来的默认值。
const TRACK_MIN = -0.05 // 字距下界(em):再负是挤字的补救,不是这套风格的性格
const TRACK_MAX = 0.3   // 上界:再宽属于标志性排版,不该当通用设定抄回来
const BORDER_MAX = 6    // 描边上界(与 swatchSpec 那侧的 clamp 同口径)
const LH_MIN = 1.1
const LH_MAX = 2.2
const BODY_SIZE_MIN = 14
const BODY_SIZE_MAX = 18
const HEAD_SIZE_MIN = 24
const GRID_MIN_SAMPLES = 4 // 少于 4 个间距值不下结论 —— 一两个 16px 说明不了这是不是网格
const GRID_RATIO = 0.7
const SPACE_PROP = /^(margin|padding)(-(top|right|bottom|left))?$/
// 色板只认 alpha ≥ 0.5 的色:`rgba(255,255,255,.1)` 那类是描边与叠层,不该算进色板。
// 记进频次的话,深色站的白色描边会当选「次要文字色」(实测 sintbot.com:次要色判成纯白)。
const PALETTE_MIN_ALPHA = 0.5
// 变量名在说「这是页面的底色 / 文字色」:**以 bg / background / text / ink 收尾**,且不带组件或状态词。
// 只要名字里带 background 就算的话,`--globalnav-background-opened-dark` 这种导航栏夜间色会被当成
// 整页底色(实测 apple.com.cn:白底站被判成深色)。
const ROOT_VAR_SKIP = /(dark|night|invers|invert|overlay|hover|active|focus|opened|selected|disabled|nav|header|footer|menu|button|btn|card|modal|dialog|popover|tooltip|input|code|badge|tag|chip|banner|toast)/
// 命名形状:可带一段 ≤4 字母的厂商前缀(`sk-`)+ 页面级修饰词(page/body/app/color…)+ bg/text 本体 + 可选的
// default/primary 一类后缀。`--first-screen-bg`(飞书首屏区块的浅蓝)这种区块名不算,否则整页底色判成浅蓝。
const ROOT_VAR_WORDS = '(?:(?:color|colors|page|body|app|site|main|global|base|theme|default)-)*'
const ROOT_BG_VAR = new RegExp(`^(?:[a-z0-9]{1,4}-)?${ROOT_VAR_WORDS}(?:bg|background)(?:-colou?r)?(?:-(?:body|page|base|default|primary|main))?$`)
const ROOT_INK_VAR = new RegExp(`^(?:[a-z0-9]{1,4}-)?${ROOT_VAR_WORDS}(?:ink|text|fg|foreground)(?:-colou?r)?(?:-(?:body|page|base|default|primary|main|title))?$`)

// 圆角值 → px。rpx 按 750 设计稿折半(小程序),rem/em 按 16px 折算(Tailwind 的 rounded-lg 就是 0.5rem);
// 裸数字按 px(JS 主题对象的写法)。认不出(calc()、关键字)⇒ null,当没写。
function _radiusPx(v) {
  const m = /^(-?\d*\.?\d+)(px|rpx|rem|em)?(?![\w.])/i.exec(String(v == null ? '' : v).trim())
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  const u = (m[2] || '').toLowerCase()
  return u === 'rpx' ? n / 2 : (u === 'rem' || u === 'em') ? n * 16 : n
}
// `@media (prefers-color-scheme: dark) { … }` 块的区间。这些块里的 html/body/:root 声明是**夜间主题**,
// 不是站点的底色;不剔掉的话,一个支持深色模式的浅色站会两边各记一份、谁赢看运气。
// 花括号配对是单趟扫描(每个块只扫自己那一段),不走正则回溯。
function _darkMediaRanges(src) {
  const out = []
  for (const m of src.matchAll(/@media[^{};]{0,200}prefers-color-scheme\s*:\s*dark[^{};]{0,200}\{/gi)) {
    let depth = 1
    let i = m.index + m[0].length
    while (i < src.length && depth > 0) { const c = src.charCodeAt(i); if (c === 123) depth++; else if (c === 125) depth--; i++ }
    out.push([m.index, i])
  }
  return out
}

// 只认写死 px 的长度(裸 0 也算 —— `margin:0` 与单位无关)。`1.5rem` 在这里是**读不出 px 数**的:
// 要折算就得先假设根字号,而那正是「不替作者假设」的反面。认不出 ⇒ 当没写。
function _pxOnly(v) {
  const m = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(String(v == null ? '' : v).trim())
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  return m[2] || n === 0 ? n : null
}
// 简写值里第一个能读成 px 的词:`1px solid #ccc` → 1;`none` / `medium solid` → null(当没写)
function _firstPx(val) {
  for (const tok of String(val == null ? '' : val).trim().split(/\s+/)) {
    const n = _pxOnly(tok)
    if (n != null) return n
  }
  return null
}

// 一批 CSS/源码文本 → 候选统计。两遍扫:
//   ① 全文颜色字面量各计 1 次 —— SCSS 变量、tailwind 配置、JS 主题对象都只有这条路吃得到
//   ② 规则块里 html/body/:root/* 的背景与自定义属性额外加权 —— 「谁是底色」的唯一硬信号,
//      不加权的话任何站点的第一名都是正文黑
function parseCssCandidates(texts, { rootWeight = 6, tick = _noTick } = {}) {
  const colors = new Map()
  const fonts = new Map()
  const radii = []
  // 下面这五项与颜色相反:它们散落在**所有**规则里(按钮的描边、卡片的内距、标题的字距),
  // 只看 html/body/:root 等于一个都收不到,所以全量记账、事后按频次裁决。
  const tracking = new Map()    // em 数 → 次数
  const borders = new Map()     // px → 次数
  const fontSizes = new Map()   // px → 次数
  const lineHeights = new Map() // 无单位数 → 次数
  const spacings = []           // margin/padding 的每个 px 值(网格判定用原始序列,不去重)
  // 底色与文字色**单独记账**:光靠加权喂不进 styleRoles(它只看到一串 hex,看不到权重),
  // 于是一个深色站点的白色正文照样会因为「最浅」当选底色。记下来后按 `bg`/`ink` 键名交给它,
  // ROLE_KEYS 整键名直接命中 —— 这是把「站点自己声明的底色」变成硬信号的唯一办法。
  const bgHits = new Map()
  const inkHits = new Map()
  // 三样新属性的记账(v0.11.22)
  const gradients = new Map()   // "from>to@angle" → 次数
  const shadows = { n: 0, tinted: 0, maxAlpha: 0 }
  const statusHits = { success: new Map(), warning: new Map(), danger: new Map() }
  const bump = (map, hex, w) => { const e = map.get(hex) || { hex, count: 0, weight: 0 }; e.count++; e.weight += w; map.set(hex, e) }
  const bumpN = (map, k) => map.set(k, (map.get(k) || 0) + 1)
  // 每份文本先切好规则块与夜间区间,两遍都用
  const docs = (Array.isArray(texts) ? texts : [texts]).map((raw) => {
    tick()
    const src = stripCssComments(String(raw == null ? '' : raw).slice(0, MAX_CSS_CHARS))
    const dark = _darkMediaRanges(src)
    return { src, rules: _cssRules(src, tick), inDark: (at) => dark.some(([a, b]) => at >= a && at < b) }
  })
  // 变量表**跨文件**收(站点常把 token 定义在一份样式表、用在另一份里),出处分档见 _rankCssVars
  const ranked = new Map()
  for (const d of docs) _rankCssVars(d.rules, d.inDark, ranked)
  const vars = new Map([...ranked].map(([k, o]) => [k, o.v]))
  for (const { src, rules, inDark } of docs) {
    tick()
    for (const hex of colorLiterals(src, { minAlpha: PALETTE_MIN_ALPHA })) bump(colors, hex, 1)
    for (const r of rules) {
      // ⚠ 不认 `*`:`*,*::before{...}` 那类 reset 是**全局重置**,不是站点在声明自己的底色。
      // 认它的话,任何引了 normalize/reset 的站点底色都会被判成 reset 里那个值(通常是继承用的
      // transparent 或纯黑),而这些站点恰恰是最常见的那种。
      // `page` 是小程序的根(相当于 body):飞书风格的 `page{background:#F7F8FA}` 就写在这儿
      const isRoot = ROOT_SEL.test(r.sel) && !inDark(r.at)
      for (const d of r.body.split(';')) {
        if (isRoot) {
          const mm = /^\s*(--[\w-]+|background(?:-color)?|color)\s*:\s*([\s\S]+)$/i.exec(d)
          if (mm) {
            const found = colorLiterals(_resolveCssVars(mm[2], vars), { minAlpha: PALETTE_MIN_ALPHA })
            for (const hex of found) bump(colors, hex, rootWeight)
            const prop = mm[1].toLowerCase()
            if (/^background/.test(prop)) for (const hex of found) bump(bgHits, hex, rootWeight)
            else if (prop === 'color') for (const hex of found) bump(inkHits, hex, rootWeight)
            else if (prop.startsWith('--')) {
              // 变量名本身就是一句声明:`--bg` / `--page-background` = 作者在说「这是底色」,
              // 比任何亮度启发式都硬。它被用在哪儿由上面两条各自记账,这里只认名字(口径见 ROOT_BG_VAR)。
              // 只算一票(权重 1):打包进来的组件库也会在 :root 上定义 `--color-text-primary` 一类变量
              // (飞书实测:markdown 组件的 #222),html/body 上真写的那条声明(权重 rootWeight)必须压得过它们。
              const vn = prop.slice(2)
              if (!ROOT_VAR_SKIP.test(vn)) {
                if (ROOT_BG_VAR.test(vn)) for (const hex of found) bump(bgHits, hex, 1)
                else if (ROOT_INK_VAR.test(vn)) for (const hex of found) bump(inkHits, hex, 1)
              }
            }
          }
        }
        // 字距 / 描边 / 间距 / 字号 / 行高:**每条规则都收**(见上面那段收集器说明)。
        // 值同样先展 var() —— `padding: var(--space-3)` 这种写法不展开就一个数都读不到。
        const dm = /^\s*([a-zA-Z-]+)\s*:\s*([\s\S]{1,200})$/.exec(d)
        if (!dm) continue
        const prop = dm[1].toLowerCase()
        if (prop.startsWith('--')) continue // 自定义属性是**定义**不是使用,记进频次会把一次声明当成一次采用
        if (!/^(letter-spacing|border|border-width|font-size|line-height|margin|padding)/.test(prop)) continue
        const val = _resolveCssVars(dm[2], vars).trim()
        if (prop === 'letter-spacing') {
          const em = _emNum(val)
          // 0 不算「字距设定」—— 它是"没有字距"的写法(letter-spacing:normal 同理,_emNum 也回 0)
          if (em && em >= TRACK_MIN && em <= TRACK_MAX) bumpN(tracking, Math.round(em * 1000) / 1000)
        } else if (prop === 'border' || prop === 'border-width') {
          const n = _firstPx(val)
          if (n != null && n >= 0 && n <= BORDER_MAX) bumpN(borders, n)
        } else if (prop === 'font-size') {
          const n = _pxOnly(val)
          if (n != null && n > 0) bumpN(fontSizes, n)
        } else if (prop === 'line-height') {
          // 只认**无单位**:`line-height:24px` 与 `150%` 都要先知道字号才有意义,而风格档里
          // 这一项写的就是倍数。认不出就当没写。
          const n = /^\d*\.?\d+$/.test(val) ? parseFloat(val) : null
          if (n != null && n >= LH_MIN && n <= LH_MAX) bumpN(lineHeights, n)
        } else if (SPACE_PROP.test(prop)) {
          for (const tok of val.split(/\s+/)) {
            const n = _pxOnly(tok)
            // 0 不进网格统计:它对 4 和 8 都整除,一句 `margin:0 auto` 就能把任何站点判成 8px 网格
            if (n != null && n !== 0) spacings.push(Math.abs(n))
          }
        }
      }
    }
    // 字体族分两条正则,**不合并** —— 两种写法的边界完全不同:
    //   CSS  `font-family: 'Inter', sans-serif;`  值一直到分号/花括号,引号本来就不成对,整串照收
    //   JS   `fontFamily: "Inter, sans-serif",`   值到闭合引号为止,再往后是同一个对象的下一个键
    // 合成一条的话必有一种被切错(实测:JS 那条会把后面的 colors 段一起吞进字体名)。
    // 图标字体(iconfont / Font Awesome / Material Icons)不是这套设计的文字字体 —— B 站实测排第一的是 iconfont
    const addFont = (stack) => { const s = String(stack || '').trim(); if (s && !/icon|awesome|glyph/i.test(s.split(',')[0])) fonts.set(s, (fonts.get(s) || 0) + 1) }
    // 值先展 var():`font-family: var(--f-display)` 不展开,证据里就只剩一个变量名,衬线也认不出来
    for (const m of src.matchAll(/font-family\s*:\s*([^;}\n]{2,220})/gi)) addFont(_resolveCssVars(m[1], vars).replace(/[,;]\s*$/, ''))
    for (const m of src.matchAll(/["']?fontFamily["']?\s*:\s*(?:"([^"\n]{1,200})"|'([^'\n]{1,200})')/g)) addFont(m[1] != null ? m[1] : m[2])
    // ── 渐变 / 投影 / 状态色(v0.11.22)。都用**有界**量词、不用懒量词 —— 见 stripCssComments
    //    那段:这条管线一次吃 200 份文件,一个 O(N²) 的正则就能把同进程的 daemon 冻死。
    // 渐变:取首尾两色 + 角度。某项目小程序 213 处 linear-gradient,那就是它的性格,
    // 提不到等于把这套设计最显眼的一样丢了。
    for (const m of src.matchAll(/linear-gradient\(([^()]{0,200}(?:\([^()]{0,80}\)[^()]{0,200}){0,6})\)/gi)) {
      const body = _resolveCssVars(m[1], vars)
      const cs = colorLiterals(body)
      if (cs.length < 2 || cs[0] === cs[cs.length - 1]) continue // 两端同色不是渐变
      const ang = /(-?\d+(?:\.\d+)?)deg/.exec(body)
      bumpN(gradients, `${cs[0]}>${cs[cs.length - 1]}@${ang ? Math.round(+ang[1]) : GRADIENT_ANGLE}`)
    }
    // 投影:只问「有没有」与「是不是彩色」。inset 不算 —— 内阴影表达的是凹陷,不是「浮起一层」。
    for (const m of src.matchAll(/box-shadow\s*:\s*([^;{}]{1,200})/gi)) {
      const v = _resolveCssVars(m[1], vars).trim()
      if (/^(none|inset)/i.test(v)) continue
      shadows.n++
      const cs = colorLiterals(v)
      if (cs.some((h) => _chroma(_rgb(h)) > 0.12)) shadows.tinted++
      for (const a of v.matchAll(/rgba?\([^()]{0,60}[,/]\s*([\d.]+)\s*\)/gi)) shadows.maxAlpha = Math.max(shadows.maxAlpha, _alphaNum(a[1]))
    }
    // 状态色:**靠变量名的语义认,不靠颜色本身** —— 红不一定是危险色(它可能就是品牌色)。
    // 认不出就一个都不写:「这套没定状态色」是个真结论,补一组通用绿黄红反而把它抹掉。
    for (const [k, v] of vars) {
      const hex = colorLiterals(_resolveCssVars(v, vars))[0]
      if (!hex) continue
      const slot = /(success|positive|-ok\b|\bok-)/.test(k) ? 'success'
        : /(warn|caution|pending)/.test(k) ? 'warning'
          : /(danger|destructive|error|fail|critical)/.test(k) ? 'danger' : null
      if (slot) bumpN(statusHits[slot], hex)
    }
    for (const m of src.matchAll(/border-?radius\s*[:=]\s*([^;}\n]{1,60})/gi)) {
      const v = _resolveCssVars(m[1].trim().replace(/^["']|["'],?$/g, '').trim(), vars).trim() // JS 写法的值带引号,先脱壳再判
      // 百分比是**正圆**语义(头像、徽章),不是胶囊按钮 —— 混进来会把任何有头像的站点判成胶囊风
      if (/%/.test(v)) continue
      const n = _radiusPx(v)
      if (n != null && n >= 0) radii.push(n)
    }
  }
  const rank = (m) => [...m.values()].sort((a, b) => b.weight - a.weight || b.count - a.count || (a.hex < b.hex ? -1 : 1))
  // 数值频次表:次数降序,同次数取小值 —— 排序必须**全序**,否则同一份 CSS 两次提炼给出不同答案
  const rankNum = (m) => [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value - b.value)
  const bgs = rank(bgHits)
  const inks = rank(inkHits)
  return {
    colors: rank(colors),
    fonts: [...fonts.entries()].map(([stack, count]) => ({ stack, count })).sort((a, b) => b.count - a.count || (a.stack < b.stack ? -1 : 1)),
    radii,
    rootBg: bgs.length ? bgs[0].hex : null,
    rootInk: inks.length ? inks[0].hex : null,
    tracking: rankNum(tracking),
    borders: rankNum(borders),
    fontSizes: rankNum(fontSizes),
    lineHeights: rankNum(lineHeights),
    spacings,
    gradients: [...gradients.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1)),
    shadows,
    status: Object.fromEntries(STATUS_KEYS.map((k) => {
      const top = [...statusHits[k].entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
      return [k, top ? top[0] : null]
    })),
  }
}

// 候选统计 → 三样新属性(v0.11.22)。与 deriveExtraTokens 同一条纪律:**提不出就不写**。
// 渐变的 from 恒是强调色(表单模型如此),所以从提到的那条渐变里取**离强调色更远**的一端当 to ——
// 站点写的是「深绿→绿」而强调色被判成绿时,该带回来的显然是那个深绿。
function deriveStyleTraits(cand, accent) {
  const out = {}
  const c = cand || {}
  const g = (c.gradients || [])[0]
  if (g) {
    const m = /^(#[0-9A-F]{6})>(#[0-9A-F]{6})@(-?\d+)$/.exec(g.key)
    if (m) {
      const acc = _normHex(accent)
      const dist = (h) => (acc ? Math.abs(_lum(_rgb(h)) - _lum(_rgb(acc))) : 0)
      out.gradientTo = !acc || dist(m[2]) >= dist(m[1]) ? m[2] : m[1]
      if (out.gradientTo === acc) delete out.gradientTo // 两端同色不是渐变
    }
  }
  const sh = c.shadows
  if (sh && typeof sh.n === 'number') {
    // 彩色投影占四分之一以上就算这套的性格是「发光」;否则按最大 alpha 分轻重。
    // 一处 box-shadow 都没有是**真结论**(瑞士网格那种靠线与留白分区的设计)⇒ none。
    out.elevation = sh.n === 0 ? 'none'
      : sh.tinted / sh.n >= 0.25 ? 'color'
        : sh.maxAlpha > 0 && sh.maxAlpha < 0.1 ? 'flat' : 'soft'
  }
  const st = {}
  for (const k of STATUS_KEYS) if (c.status && c.status[k]) st[k] = c.status[k]
  if (Object.keys(st).length) out.statusColors = st
  return out
}

// 间距网格:≥70% 的间距值能被 8 整除 ⇒ 8px 网格;否则试 4px;都不满足 ⇒ **不写**
// (「这套设计没有统一网格」是一个真结论,编一个 8px 上去反而把它抹掉了)。
function _gridUnit(list) {
  const vals = (list || []).filter((n) => Number.isFinite(n) && n > 0)
  if (vals.length < GRID_MIN_SAMPLES) return null
  const share = (k) => vals.filter((n) => Number.isInteger(n / k)).length / vals.length
  if (share(8) >= GRID_RATIO) return 8
  if (share(4) >= GRID_RATIO) return 4
  return null
}

// 候选统计 → 可以直接写进风格档的那几个 token。**每一项提不出就省略**,返回的对象里
// 只有真读到的键。字号是唯一的成对项:正文与标题缺一个,反差比就无从算起,所以一起省。
function deriveExtraTokens(cand) {
  const out = {}
  const c = cand || {}
  const top = (list) => (Array.isArray(list) && list.length ? list[0].value : null)
  const ls = top(c.tracking); if (ls != null) out.letterSpacing = ls
  const bw = top(c.borders); if (bw != null) out.borderWidth = bw
  const unit = _gridUnit(c.spacings); if (unit != null) out.spacingUnit = unit
  const lh = top(c.lineHeights); if (lh != null) out.lineHeight = lh
  // 频次表已按「次数降序」排好 ⇒ 各区间里 find 到的第一个就是该区间的最高频
  const sizes = Array.isArray(c.fontSizes) ? c.fontSizes : []
  const body = sizes.find((e) => e.value >= BODY_SIZE_MIN && e.value <= BODY_SIZE_MAX)
  const head = sizes.find((e) => e.value >= HEAD_SIZE_MIN)
  if (body && head) { out.headlineSize = head.value; out.bodySize = body.value }
  return out
}

// 事实性描述建议(v0.11.21)。**零气质词** —— 「高级」「克制」「有呼吸感」那类判断是群里
// 对话的事;这里只把读到的事实拼成一句:深浅、衬线、圆角、主色、出处。每段有则拼、无则省,
// 一段都拼不出就回空串(空串 ⇒ 前端什么都不填,而不是填一句「未知风格」)。
function describeExtract({ dark = null, serif = false, mono = false, radius = null, pill = false, bg = null, accent = null, origin = '' } = {}) {
  const parts = []
  if (dark != null) parts.push(dark ? '深色底' : '浅色底')
  if (serif) parts.push('衬线标题')
  if (mono) parts.push('等宽小字')
  if (pill) parts.push('胶囊圆角')
  else if (radius != null) parts.push('圆角 ' + (Math.round(radius * 100) / 100) + 'px')
  if (bg) parts.push('底色 ' + bg)
  if (accent && accent !== bg) parts.push('强调色 ' + accent)
  if (!parts.length) return ''
  const o = _oneline(origin, 60)
  return parts.join(' · ') + (o ? '(提自 ' + o + ')' : '')
}

// 近似色并档:同一套设计里 #FAFAFA 与 #F9F9F9 是同一个意图,分成两档会挤掉真正的第二色。
// 阈值取每通道 ≤12(与 extractPalette 的 4 位分桶同量级)。
function dedupeColors(list, n = 6) {
  const out = []
  for (const c of list) {
    const rgb = _rgb(c.hex)
    const near = out.find((o) => { const q = _rgb(o.hex); return Math.max(Math.abs(q[0] - rgb[0]), Math.abs(q[1] - rgb[1]), Math.abs(q[2] - rgb[2])) <= 12 })
    if (near) { near.count += c.count; near.weight += c.weight; continue }
    out.push({ hex: c.hex, count: c.count, weight: c.weight })
    if (out.length >= n) break
  }
  return out
}

function _roundedFromRadii(radii) {
  const list = (radii || []).filter((n) => Number.isFinite(n))
  if (!list.length) return null
  if (list.some((n) => n >= 100)) return 'pill'
  return quantizeRounded(Math.max(...list), false)
}

// 候选文本 → { form 候选, evidence 证据摘要, suggest 建议 }。证据是**必须回的**:提炼是猜,
// 用户得看见它凭什么这么猜(哪几个色、出现多少次、什么字族、多大圆角),才知道该改哪一项。
// suggest 是**候选而非结论**:描述句只在描述框空着时自动填,补充色可逐个勾掉 —— 这两样都
// 可能与作者心里那套不合,所以给的是可否决的建议,不是直接写死进表单。
function extractFormFromTexts(texts, { name = '', description = '', origin = '', tick = _noTick } = {}) {
  const cand = parseCssCandidates(texts, { tick })
  // 先并到 16 档再切前 6:同一意图的近似色在更长的名单里才并得干净(并档只累加频次、不改顺序,
  // 所以前 6 个 hex 与直接并到 6 档时逐字节相同 —— 变的只是它们的计数更准)。
  const wide = dedupeColors(cand.colors, EXTRA_COLOR_POOL)
  const top = wide.slice(0, 6)
  // 键名策略两半:站点**自己声明**的 html/body 底色与文字色按 `bg`/`ink` 交出去(硬信号,
  // 整键名直接命中);其余一律用无意义的 c1..cn —— 让 styleRoles 走亮度/彩度启发式,而不是
  // 被参考站点里碰巧叫 `accent`/`primary` 的变量名带偏(我们信频次与感知量,不信别人的命名)。
  const named = {}
  if (cand.rootBg) named.bg = cand.rootBg
  if (cand.rootInk && cand.rootInk !== cand.rootBg) named.ink = cand.rootInk
  const claimed = new Set(Object.values(named))
  let ci = 0
  for (const c of top) { if (claimed.has(c.hex)) continue; named['c' + (++ci)] = c.hex }
  const roles = Object.keys(named).length ? styleRoles(named, { fromExtract: true }) : null
  const fontsJoined = cand.fonts.map((f) => f.stack).join(' , ')
  const serif = /serif/i.test(fontsJoined.replace(/sans[-\s]?serif/gi, ''))
  const mono = /mono/i.test(fontsJoined) // 证据:样式里出现过等宽族(事实,照实报)
  // 描述句里的「等宽小字」是在说这套设计的性格,要按字体声明的**占比**判 —— 几乎每个站都给 code
  // 配了等宽族,出现过就算的话人人都是「等宽小字」。首个族是等宽的声明占到四分之一、且不止一处才算。
  const monoN = cand.fonts.filter((f) => /mono|courier|consolas|menlo/i.test(String(f.stack).split(',')[0])).reduce((n, f) => n + f.count, 0)
  const fontN = cand.fonts.reduce((n, f) => n + f.count, 0)
  const monoStyle = monoN >= 2 && monoN / fontN >= 0.25
  const rounded = _roundedFromRadii(cand.radii)
  const form = normalizeStyleForm({
    name,
    description,
    colors: roles ? { bg: roles.bg, ink: roles.ink, accent: roles.accent, muted: roles.muted } : null,
    rounded: rounded || 'subtle',
    weight: 'medium',
    serif,
    mono,
  })
  // 补充色:四角色之外还在反复出现的那些。**只提名单,不动四角色** —— 角色是 styleRoles 判定
  // 或用户点定的,补充色进档时走 alt-N 键名(刻意不在 ROLE_KEYS 词表里,抢不走角色)。
  // 只出现过一次的色是一次性用法(某个图标、某段渐变),不算这套设计的色板。
  const roleHexes = new Set(roles ? [roles.bg, roles.ink, roles.accent, roles.muted] : [])
  const extraColors = wide
    .filter((c) => !roleHexes.has(c.hex) && c.count >= EXTRA_COLOR_MIN_COUNT)
    .slice(0, EXTRA_COLOR_MAX)
    .map((c) => ({ hex: c.hex, count: c.count }))
  const normalRadii = (cand.radii || []).filter((n) => Number.isFinite(n) && n >= 0 && n < 100)
  return {
    form,
    evidence: {
      source: 'css',
      colors: top.map((c) => ({ hex: c.hex, count: c.count })),
      fonts: cand.fonts.slice(0, 4).map((f) => f.stack),
      radii: [...new Set(cand.radii)].sort((a, b) => a - b).slice(0, 6),
      serif,
      mono,
      rounded: form.rounded,
      roundedFound: !!rounded,
      // 一个颜色都没读到 ⇒ 表单里的四个色是模板默认值,不是提炼结果;前端据此不去动表单
      colorsFound: !!roles,
    },
    suggest: {
      description: describeExtract({
        dark: roles ? roles.dark : null,
        serif,
        mono: monoStyle,
        pill: rounded === 'pill',
        radius: normalRadii.length ? Math.max(...normalRadii) : null,
        bg: roles ? roles.bg : null,
        accent: roles ? roles.accent : null,
        origin,
      }),
      extraColors,
      extraTokens: deriveExtraTokens(cand),
      // 三样新属性同走 suggest(v0.11.22):它们与描述句一样是**可否决的建议** ——
      // 勾掉即不写。提不出的项这里根本不出现(deriveStyleTraits 只回真读到的键)。
      traits: deriveStyleTraits(cand, roles ? roles.accent : null),
    },
  }
}

// HTML → 内联 <style> 与 <link rel=stylesheet>(含 `rel=preload as=style`)。**跨域名的也跟**:
// 大多数站点的样式表放在 CDN 域名上(飞书 feishucdn、B 站 hdslb、Stripe stripecdn),只认同源时
// 这些站一份都读不到(实测 6 个站 3 个报「没找到样式表」)。安全不靠同源:每一跳照样过公网围栏
// 与解析结果检查(_fetchGuarded),份数与字节都封顶。同域名的排在前面,名额先给站点自己的。
//
// ⚠ 两处定位都**手写 indexOf,不用正则**(与 stripCssComments 同款,同一个道理)。
//   `<style[^>]*>([\s\S]*?)<\/style>` 与 `<link\b[^>]*>` 都是二次方的:前者每遇到一个未闭合的
//   `<style>` 就要往后扫到结尾找 `</style>`,后者的 `[^>]*` 在一份根本没有 `>` 的输入里要逐字符
//   回溯 —— 512KB 的病态输入实测 4.7s 与 10.9s。而正则一旦跑起来是**不可中断**的:墙钟 tick
//   只在两次调用之间生效,进了正则引擎谁也停不下它。所以这里必须从形状上就是 O(N),
//   墙钟(tick)只是第二道闸,不能当第一道用。
function parseHtmlStyleRefs(html, baseUrl, { max = EXTRACT_MAX_SHEETS, tick = _noTick } = {}) {
  const src = String(html == null ? '' : html)
  const low = src.toLowerCase() // 大小写不敏感的定位:一次小写副本,比逐字符比对省事得多
  const inline = []
  let i = 0
  while (inline.length < max) {
    tick()
    const a = low.indexOf('<style', i)
    if (a < 0) break
    const gt = low.indexOf('>', a + 6) // 标签里不许有 `>`,与原来的 [^>]* 同判
    if (gt < 0) break
    const close = low.indexOf('</style>', gt + 1)
    // 这一个开标签没有闭合 ⇒ 后面的也不会有(闭合标签只会更靠后),整轮到此为止。
    // **正是这一条把 O(N²) 压成 O(N)**:不为每个开标签各扫一遍尾巴。
    if (close < 0) break
    const body = src.slice(gt + 1, close)
    if (body.trim()) inline.push(body)
    i = close + 8
  }
  let base = null
  try { base = new URL(baseUrl) } catch { base = null }
  const links = []
  let j = 0
  for (;;) {
    tick()
    if (links.length >= max * 3) break // 先多收几条候选,排完序再截到 max
    const a = low.indexOf('<link', j)
    if (a < 0) break
    const gt = low.indexOf('>', a + 5)
    if (gt < 0) break
    j = gt + 1
    if (/[a-z0-9_]/.test(low[a + 5] || '')) continue // 原来那个 \b:`<linkedin>` 不是 link 标签
    // 标签长度封顶。下面那两条正则跑在**单个标签**上,`[^"'>]*stylesheet` 对每一处 `rel=`
    // 都要扫一遍剩下的标签 —— 一个 480KB 的假标签里塞满 `rel=`,实测 41s(与整份文档的
    // 二次方是同一类问题,只是尺度换成了标签)。真的 <link> 连 200 字节都到不了。
    if (gt + 1 - a > LINK_TAG_MAX) continue
    const tag = src.slice(a, gt + 1)
    const isSheet = /rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)
    const isPreload = /rel\s*=\s*["']?preload\b/i.test(tag) && /\bas\s*=\s*["']?style\b/i.test(tag) // 先预载再换成样式表的写法
    if (!isSheet && !isPreload) continue
    const hm = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    const href = hm && (hm[2] != null ? hm[2] : hm[3] != null ? hm[3] : hm[4])
    if (!href) continue
    let abs = null
    try { abs = base ? new URL(href, base) : new URL(href) } catch { continue }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue
    abs.hash = ''
    if (!links.includes(abs.href)) links.push(abs.href)
  }
  // 内联与外链各自封顶:内联不花网络,只是 HTML 里的一段;合在一起算的话,一个塞满小块 <style> 的
  // 服务端渲染页会把外链名额吃光,真正定调的那几份样式表一份都不拉。
  const host = base ? base.host : ''
  const site = (h) => h.split('.').slice(-2).join('.') // 粗粒度「同一站点」:www.ex.com 与 static.ex.com 算一家
  const rank = (href) => { const h = new URL(href).host; return h === host ? 0 : site(h) === site(host) ? 1 : 2 }
  const ordered = links.map((href, i) => ({ href, i, r: rank(href) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.href)
  return { inline, links: ordered.slice(0, max) }
}

// 读响应体,**流式**截断。旧写法 `(await res.text()).slice(0, max)` 的上限写了等于没写:
// 那一步已经把整个响应收进内存了,一个几百 MB 的响应照样能把 daemon 撑爆。
// 两道闸:① 有 Content-Length 且超限 ⇒ 一个字节都不读,直接拒 ② 无则边读边数,到线就停并 cancel。
async function _readCapped(res, maxBytes) {
  const len = Number(res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN)
  const body = res && res.body
  const streamable = !!(body && typeof body.getReader === 'function')
  // 声明的长度超限:能边读边截(可读流,或代理那条已在传输层封顶 capped)⇒ 照常读前 maxBytes ——
  // 现代站点的 HTML 动辄超过 512KB(Next.js 把数据内联进页面),而要的样式表链接全在 <head> 里,
  // 一律拒收的话 linear.app、stripe.com 这类站一个都提炼不了。只有「既不能截、又声明超限」才拒。
  if (Number.isFinite(len) && len > maxBytes && !streamable && !(res && res.capped)) {
    const e = new Error(`这个网址的内容太大了(超过 ${Math.round(maxBytes / 1024)} KB)—— 换一个更轻的页面`)
    e.code = 'EXTRACT_GUARD'
    throw e
  }
  // 注入的假 res(单测)、代理那条与个别 fetch 实现没有可读流 ⇒ 退回 text(),截断口径不变
  if (!streamable) {
    const t = await res.text()
    return t.length > maxBytes ? t.slice(0, maxBytes) : t
  }
  const reader = body.getReader()
  const dec = new TextDecoder('utf-8')
  let out = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) out += dec.decode(value, { stream: true })
      if (out.length >= maxBytes) { out = out.slice(0, maxBytes); break }
    }
  } finally { try { await reader.cancel() } catch { /* 读完之后 cancel 是空操作 */ } }
  return out
}

// ── 网址侧的 SSRF 围栏 ────────────────────────────────────────────────────────
// 这是一个「我给网址、服务器替我去取」的口子。控制台是 post-auth、operator 自用,但没有围栏
// 就等于把这台机器当跳板:环回上只听本机的服务(浏览器调试端口、别的守护进程)、同网段的
// 路由器与 NAS、云上的 169.254.169.254 元数据端点,全都能被一句「提炼这个网址」代拉出来。
//
// ⚠ 残余风险,明写在这里:**只挡字面 IP 与 localhost**。域名解析到内网(内网 A 记录、
//   DNS rebinding)挡不住 —— 那得在建连那一层看真实 peer 地址,而零依赖的全局 fetch 给不了
//   socket 钩子。post-auth + operator 自用的口径下认这个残余,不为它引依赖。
const SSRF_MSG = '这个网址在本机或内网上,提炼只接公网网址'
function _v4Private(o) {
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true // 不像 IPv4 的四段一律当不安全
  if (o[0] === 0 || o[0] === 127) return true                              // 0.0.0.0/8 · 127.0.0.0/8 环回
  if (o[0] === 10) return true                                             // 10/8
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true                // 172.16/12
  if (o[0] === 192 && o[1] === 168) return true                            // 192.168/16
  if (o[0] === 169 && o[1] === 254) return true                            // 169.254/16 链路本地(含云元数据 169.254.169.254)
  return false
}
// true = 看起来是公网地址或普通域名(放行)。纯函数,可单测。
function isPublicHostname(hostname) {
  const h = String(hostname == null ? '' : hostname).trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return false
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m4) return !_v4Private(m4.slice(1).map(Number))
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return false
    // IPv4 映射地址:URL 解析器会把 ::ffff:127.0.0.1 归一成 ::ffff:7f00:1,两种写法都要认
    const mm = /^::ffff:([0-9a-f.:]+)$/.exec(h)
    if (mm) {
      if (mm[1].includes('.')) return isPublicHostname(mm[1])
      const parts = mm[1].split(':')
      if (parts.length === 2) {
        const a = parseInt(parts[0], 16); const b = parseInt(parts[1], 16)
        if (Number.isFinite(a) && Number.isFinite(b)) return !_v4Private([a >> 8, a & 255, b >> 8, b & 255])
      }
      return false
    }
    const head = parseInt(h.split(':')[0] || '0', 16) || 0
    if ((head & 0xfe00) === 0xfc00) return false // fc00::/7 唯一本地
    if ((head & 0xffc0) === 0xfe80) return false // fe80::/10 链路本地
    return true
  }
  return true // 普通域名:解析结果管不了,见上面的残余风险说明
}
function assertPublicUrl(u) {
  const url = typeof u === 'string' ? new URL(u) : u
  if (isPublicHostname(url.hostname)) return url
  const e = new Error(SSRF_MSG)
  e.code = 'EXTRACT_GUARD'
  throw e
}

// 域名的解析结果也要是公网地址:跟跨域名样式表之后,页面能指定任意域名,而一个公网域名完全可以
// 解析到 192.168.x / 127.0.0.1(DNS 重绑定)。解析不了(墙内本机解析不出海外域名,走代理时很常见)
// 或超时 ⇒ 放行,交给后面的连接去报错 —— 这道检查只拒「明确解析到内网」的。
// ⚠ Clash 的 fake-ip 模式下本机解析回的是 198.18.x(基准测试段,不在内网判定里)⇒ 放行,检查等于失效;
//   这是代理模式的固有边界,不是漏判。lookup 为空(单测注入了 fetch)⇒ 不解析。
const EXTRACT_DNS_MS = 3000
const _dnsLookup = (host) => require('node:dns').promises.lookup(host, { all: true, verbatim: true })
async function _assertResolvesPublic(hostname, lookup) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '')
  if (!lookup || !h || require('node:net').isIP(h)) return // IP 字面量 isPublicHostname 已经判过
  let timer
  const addrs = await Promise.race([
    Promise.resolve().then(() => lookup(h)).catch(() => null),
    new Promise((r) => { timer = setTimeout(() => r(null), EXTRACT_DNS_MS); if (timer.unref) timer.unref() }),
  ]).finally(() => clearTimeout(timer))
  for (const a of Array.isArray(addrs) ? addrs : []) {
    if (a && a.address && !isPublicHostname(a.address)) { const e = new Error(SSRF_MSG); e.code = 'EXTRACT_GUARD'; throw e }
  }
}

// 手动跟跳。**每一跳都重过同一套校验** —— 交给 fetch 的 redirect:'follow' 就等于只查了第一跳,
// 而「公网地址 301 到 127.0.0.1」是绕过首跳校验最省事的一招。
async function _fetchGuarded(doFetch, href, init, { maxHops = EXTRACT_MAX_HOPS, lookup = null } = {}) {
  let cur = new URL(href)
  for (let hop = 0; ; hop++) {
    assertPublicUrl(cur)
    await _assertResolvesPublic(cur.hostname, lookup)
    const res = await doFetch(cur.href, { ...init, redirect: 'manual' })
    const status = res && res.status
    const loc = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null
    if (!(status >= 300 && status < 400 && loc)) return { res, url: cur.href }
    if (hop >= maxHops) {
      const e = new Error(`这个网址转了太多次(超过 ${maxHops} 跳)—— 直接填最终那个地址`)
      e.code = 'EXTRACT_GUARD'
      throw e
    }
    let next
    try { next = new URL(loc, cur) } catch { const e = new Error('这个网址跳到了一个认不出的地址:' + loc); e.code = 'EXTRACT_GUARD'; throw e }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('只认 http / https 网址:' + next.protocol)
    cur = next
  }
}

async function extractFromUrl(ref, { fetchImpl, lookup, timeoutMs = EXTRACT_TIMEOUT_MS, maxSheets = EXTRACT_MAX_SHEETS, maxBytes = MAX_CSS_CHARS, wallMs = EXTRACT_WALL_MS } = {}) {
  // 配了代理就走代理(见本段段头);注入了 fetch(单测)就用注入的,也不做真解析
  const doFetch = fetchImpl || require('./core/proxy').getProxyFetch() || globalThis.fetch
  const dns = lookup !== undefined ? lookup : (fetchImpl ? null : _dnsLookup)
  if (typeof doFetch !== 'function') throw new Error('这台机器上取不到网页(运行环境没有 fetch)')
  let u
  try { u = new URL(String(ref)) } catch { throw new Error('这不是一个网址:' + String(ref)) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只认 http / https 网址:' + u.protocol)
  const tick = _wallClock(wallMs)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const first = await _fetchGuarded(doFetch, u.href, { signal: ctl.signal, maxBytes, headers: { Accept: 'text/html,text/css,*/*' } }, { lookup: dns })
    const res = first.res
    if (!res || !res.ok) throw new Error(`打不开这个网址(HTTP ${res ? res.status : '?'})`)
    const html = await _readCapped(res, maxBytes)
    // ⚠ 同源判定的基准是**最终落点**,不是请求前那个地址:跟过跳之后还拿原 URL 解析相对路径,
    // 样式表要么拼错、要么被同源判定误杀(`ex.com` 301 到 `www.ex.com` 是最常见的一种)。
    // tick 一路传进去:这一步在**逐样式表的循环之前**,此前它整个落在墙钟之外 ——
    // 一份病态 HTML 卡死在这儿,墙钟连一次都没机会点。
    const refs = parseHtmlStyleRefs(html, first.url, { max: maxSheets, tick })
    const texts = [...refs.inline]
    let fetched = 0
    for (const href of refs.links) {
      tick()
      try {
        const r2 = await _fetchGuarded(doFetch, href, { signal: ctl.signal, maxBytes, headers: { Accept: 'text/css,*/*' } }, { lookup: dns })
        if (r2.res && r2.res.ok) { texts.push(await _readCapped(r2.res, maxBytes)); fetched++ }
      } catch { /* 单份样式表拉不到就少一份,不让整次提炼失败 */ }
    }
    // 两种「一份都没有」要分开说:页面引用了样式表却一份都没取到(网络 / 代理 / 对端拒绝),
    // 与页面里压根没有样式表(要跑脚本才出内容)—— 前者让人去查网络,后者让人换页面,说反了两头误事。
    if (!texts.length && refs.links.length) throw new Error(`页面引用了 ${refs.links.length} 份样式表,一份都没取到 —— 多半是这台机器连不上它们所在的域名(检查一下代理),或把网址发到群里让它去看`)
    if (!texts.length) throw new Error('这个页面里没找到样式表 —— 多半是要跑脚本才出内容的站;换一个静态些的页面,或把网址发到群里让它慢慢看')
    const r = extractFormFromTexts(texts, { name: u.hostname, origin: u.hostname, tick })
    r.evidence.source = 'url'
    r.evidence.ref = first.url
    r.evidence.sheets = refs.inline.length + fetched
    return r
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new Error(`抓这个网址超时了(${Math.round(timeoutMs / 1000)} 秒)—— 换一个更轻的页面,或把网址发到群里让它慢慢看`)
    if (e && e.code === 'EXTRACT_GUARD') throw e // 围栏与墙钟的话已经是人话,别被下面的兜底改写
    if (e && /^(打不开|这个页面里|页面引用了|这不是一个网址|只认)/.test(e.message || '')) throw e
    // `fetch failed` 是 Node 对一切网络层失败的统一说法(DNS 解析不了、连不上、证书不对都是它),
    // 原样抛出等于把英文内部报错甩给 operator —— 翻成「可能是哪几种情况」才有下一步可做。
    const raw = (e && e.message) || String(e)
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|certificate|TLS/i.test(raw)) {
      throw new Error('连不上这个网址 —— 可能是域名解析不了、站点拒绝连接,或这台机器访问它需要代理(配置里没配,或代理没开)。把网址发到群里让它去看是另一条路')
    }
    throw new Error('抓不到这个网址:' + raw)
  } finally { clearTimeout(timer) }
}

// 本地目录扫描。围栏三条:必须绝对路径 · 必须存在 · 必须是目录。深度与文件数都封顶 ——
// 一个 monorepo 的 node_modules 能把「提炼」变成十分钟的磁盘扫描。
// ⚠ 小程序的样式后缀不是 .css(v0.11.22 补):微信 .wxss / 支付宝 .acss / 抖音 .ttss ——
// 语法就是 CSS 子集,同一条管线读得懂。少了它们,「从小程序源码提炼」会报「没找到样式文件」,
// 而小程序恰恰是本轮要支持的两个载体之一(某项目真机撞到)。
const SCAN_EXT = /\.(css|scss|less|sass|wxss|acss|ttss)$/i
const SCAN_NAME = /^(tailwind\.config\.(js|cjs|mjs|ts)|theme[\w.-]*\.(js|ts|json)|tokens?\.(js|ts|json))$/i
const SCAN_SKIP_DIR = /^(node_modules|\.git|\.hg|\.svn|dist|build|out|coverage|\.next|\.nuxt|\.cache|vendor|\.venv|venv|__pycache__|target)$/i

function scanProjectDir(dir, { maxDepth = 4, maxFiles = 200, maxBytes = MAX_CSS_CHARS, tick = _noTick } = {}) {
  const raw = String(dir == null ? '' : dir).trim()
  if (!raw) throw new Error('先填一个目录')
  if (!path.isAbsolute(raw)) throw new Error('本机目录要写绝对路径(从根目录或盘符写起):' + raw)
  const root = path.resolve(raw)
  let st
  try { st = fs.statSync(root) } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error('这个目录不存在:' + root)
    throw new Error(`读不了这个目录(${(e && e.code) || (e && e.message)}):` + root)
  }
  if (!st.isDirectory()) throw new Error('这是一个文件,不是目录 —— 请填项目所在的目录:' + root)
  const files = []
  const texts = []
  const walk = (abs, depth) => {
    if (depth > maxDepth || files.length >= maxFiles) return
    let ents
    try { ents = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const ent of ents) {
      if (files.length >= maxFiles) return
      if (ent.isSymbolicLink()) continue // 软链不跟:既防环,也防指到围栏外
      const child = path.join(abs, ent.name)
      if (ent.isDirectory()) { if (!SCAN_SKIP_DIR.test(ent.name) && !ent.name.startsWith('.')) walk(child, depth + 1); continue }
      if (!ent.isFile()) continue
      if (!SCAN_EXT.test(ent.name) && !SCAN_NAME.test(ent.name)) continue
      tick()
      // 先看大小再读:`readFileSync` 之后才 slice 等于「先把整份读进内存,再说要不要它」——
      // 一个几十 MB 的打包产物(dist 之外也会有)光 I/O 就够久。超上限的整份跳过,
      // 截断一个 bundle 的头 512KB 也提炼不出什么。
      let size = 0
      try { size = fs.statSync(child).size } catch { continue }
      if (size > maxBytes) continue
      let text = null
      try { text = fs.readFileSync(child, 'utf8') } catch { continue }
      files.push(path.relative(root, child))
      texts.push(text.length > maxBytes ? text.slice(0, maxBytes) : text)
    }
  }
  walk(root, 1)
  return { root, files, texts }
}

function extractFromDir(dir, opts = {}) {
  // 总墙钟同样要有:这一侧全程同步跑在 daemon 进程里,卡住的是整个守护进程。
  const tick = _wallClock(opts.wallMs == null ? EXTRACT_WALL_MS : opts.wallMs)
  const scanned = scanProjectDir(dir, { ...opts, tick })
  // 目录里已经有一份风格档 ⇒ 直接用它的 tokens。它是作者写下的**结论**,
  // 而从 CSS 频次里推出来的只是统计 —— 有结论就别再猜一遍。
  const doc = findStyleDoc({ cwd: scanned.root })
  if (doc) {
    let text = null
    try { text = fs.readFileSync(doc, 'utf8') } catch { text = null }
    if (text && isStyleDoc(text)) {
      const form = styleFormFromDoc(text)
      return {
        form,
        evidence: {
          source: 'styledoc',
          styleDoc: path.relative(scanned.root, doc),
          files: scanned.files.length,
          colors: COLOR_KEYS.map((k) => ({ hex: form.colors[k], count: 0, role: COLOR_LABELS[k] })),
          fonts: [],
          radii: [],
          serif: form.serif,
          mono: form.mono,
          rounded: form.rounded,
          roundedFound: true,
        },
        // 这一支不猜:三样建议全取自这份档本身 —— 描述是作者写下的那句,补充色是档里
        // 已有的 alt-N,更多属性是档里真写了的那几项(与模板骨架不同的那些)。猜出来的
        // 那套(deriveExtraTokens)在这儿没有立场 —— 有结论就别再统计一遍。
        // ⚠ 这里若硬写 `{}`,证据区那句「直接取了它的设定,没有再去猜」就是假话:
        //   字距/描边/间距/字号全没取回来,表单里它们照样退回模板值。
        suggest: { description: form.description || '', extraColors: form.extraColors.map((hex) => ({ hex, count: 0 })), extraTokens: form.extraTokens },
      }
    }
  }
  if (!scanned.files.length) throw new Error('这个目录里没找到样式文件(.css/.scss/.less 或 tailwind/theme 配置)—— 换一层目录试试')
  // 出处标目录名而不是全路径:控制台不展示机器内部路径,而目录名足够让人认出「提自哪一份参考」
  const r = extractFormFromTexts(scanned.texts, { origin: path.basename(scanned.root), tick })
  r.evidence.source = 'dir'
  r.evidence.files = scanned.files.length
  r.evidence.scanned = scanned.files.slice(0, 8)
  return r
}

// ── 设计规范回归检查(v0.11.29,含视觉回归)───────────
// 反馈原话:「设计风格档未被强制加载与验收」「设计交付缺少圆角、间距、阴影等视觉规范回归
// 检查」。⚠ **不做阻断式强制** —— 教训 6 已写死「配置类策略对半可信 agent 本质不可强制」
// (禁了 --config 还有 SBOT_CONFIG=),硬做只会得到一个绕得过去的假门槛,还会挡住正当例外
// (设计图自带的渐变、第三方 logo 的品牌色)。真防线是**让偏离可见**:机器测得准的确定性
// 列出来,判断权留给人 —— 与「交付前并排对照并主动点名不一致处」同一条思路的机器化版本。
//
// 只测**测得准**的三样(测不准的宁可不测 —— 假警报比不报更糟):
//   颜色 —— 产物里的色值是否落在风格档色板(含 status/gradient/elevation 里的色)容差内
//   圆角 —— border-radius 的取值是否用了风格档的档位
//   字体 —— font-family 的首选族是否与风格档一致
// 间距/阴影**故意不测**:间距在真实页面里合法变体极多(gap/padding/margin × 响应式),
// 逐值比对必然满屏假警报;阴影同理(一个 shadow 串里混着色值与四个长度)。宁可少测。

// 色差:RGB 欧氏距离。够用 —— 这里要答的是「是不是同一个色」而非「像不像」,写代码时的
// 偏差要么就是同一个值、要么差得很远(#1B6B37 vs #22C55E 距离 ~90),不需要 CIEDE2000。
function _colorDist(a, b) {
  const [r1, g1, b1] = _rgb(a), [r2, g2, b2] = _rgb(b)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

// 风格档里所有「合法色」:colors 全部 + status/gradient/elevation 这些顶层段里的色值。
// ⚠ 必须连它们一起收 —— 那几段本来就是风格档的一部分(v0.11.22 特意让它们走顶层而不进
// colors,免得抢 accent),漏掉就会把作者明明定义过的成功绿报成「偏离」。
function styleAllowedColors(tokens) {
  const out = []
  const eat = (v) => { const h = _normHex(v); if (h && !out.includes(h)) out.push(h) }
  for (const v of Object.values((tokens && tokens.colors) || {})) eat(v)
  for (const seg of ['status', 'gradient', 'elevation']) {
    const blk = (tokens && tokens[seg]) || {}
    for (const v of Object.values(blk)) eat(v)
    // elevation.shadow 是 "0 4px 16px rgba(...)" 这种串 ⇒ 把里面的色抠出来
    if (blk.shadow) for (const h of colorLiterals(String(blk.shadow))) eat(h)
  }
  return out
}

// 风格档允许的圆角(px 数值集合)。rounded 段形如 { md: "8px", full: "999px" }。
// 0 恒合法(直角任何风格都可能用)。
function styleAllowedRadii(tokens) {
  const out = [0]
  for (const v of Object.values((tokens && tokens.rounded) || {})) {
    const n = parseFloat(String(v))
    if (Number.isFinite(n) && !out.includes(n)) out.push(n)
  }
  return out
}

// 产物里用到的圆角。百分比与 9999 类「全圆」统一记 999 与风格档 full 档位对齐 ——
// 否则 `border-radius:50%` 会被报成偏离,而它其实就是 full。
function usedRadii(css) {
  const out = []
  for (const m of String(css || '').matchAll(/border(?:-[a-z]+)?-radius\s*:\s*([^;}]+)/gi)) {
    for (const part of m[1].split(/[\s/]+/)) {
      const t = part.trim()
      if (!t) continue
      if (/^(50%|100%|9{3,}(px)?)$/i.test(t)) { if (!out.includes(999)) out.push(999); continue }
      const n = parseFloat(t)
      if (!Number.isFinite(n)) continue
      const px = /rem$/i.test(t) ? n * 16 : /rpx$/i.test(t) ? n / 2 : n // rpx:750 设计稿口径
      if (!out.includes(px)) out.push(px)
    }
  }
  return out
}

// font-family 首选族(去引号小写)。只比首选 —— 后面的都是兜底,逐个比必然假警报。
function _firstFamily(v) {
  const first = String(v || '').split(',')[0] || ''
  return first.replace(/['"]/g, '').trim().toLowerCase()
}
function usedFontFamilies(css) {
  const out = []
  for (const m of String(css || '').matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const f = _firstFamily(m[1])
    if (f && !/^(inherit|initial|unset|var\()/.test(f) && !out.includes(f)) out.push(f)
  }
  return out
}
function styleAllowedFamilies(tokens) {
  const out = []
  for (const v of Object.values((tokens && tokens.typography) || {})) {
    const f = _firstFamily(v && v.fontFamily)
    if (f && !out.includes(f)) out.push(f)
  }
  return out
}

// ── 中文兜底那一段(首选族之外的另一半)──────────────────────────────────────
// 首选族比对一直都在,漏的是**栈里的中文族**:删掉它、换成别家,检查器一声不吭。
// ⚠ 首选族本身**不改判据** —— 中西混排的正确写法就是拉丁在前、中文在后(中文族放首选会让
//   拉丁字母也用中文字体里的拉丁字形),所以「中文放了首选」被报出来是对的,不是误报。
function styleCjkFamilies(tokens) {
  const out = []
  for (const v of Object.values((tokens && tokens.typography) || {})) {
    for (const f of String((v && v.fontFamily) || '').split(',')) {
      const n = f.replace(/['"]/g, '').trim()
      if (n && CJK_FAMILY_RE.test(n) && !out.includes(n)) out.push(n)
    }
  }
  return out
}
// 产物里的**整条**字体栈。⚠ 两处来源都要收:`font-family: …` 与 **CSS 自定义属性**
//   (`--mono: 'Geist Mono', monospace`)—— 真实产物正是后者 + `font-family: var(--mono)`,
//   只扫前者会拿到一个 `var(--mono)` 字符串,这一维等于恒不检查。
// ⚠ **HTML 内联 style 必须先按属性边界切出来**(2026-09-02 审计逮到,两个后果都真机复现):
//   通用正则的值域是 `[^;}]+`,在 `style="font-family:'X',monospace">正文…` 里**不在引号处收口**,
//   一路吞到下一个 `;`/`}` ⇒ ①吞进来的那段里恰好有后面 `<style>` 块的中文族,整串被判成
//   「有兜底」= **该报的不报**;②`sample` 把页面正文吐进报告,而**那份报告是要贴进群的**。
const STYLE_ATTR_RE_SRC = '\\sstyle\\s*=\\s*("([^"]*)"|\'([^\']*)\')'
// 第二道防线(属性边界已治了根因)。⚠ **别定太紧**:真实世界最长的一条是控制台自己的 `--sans`,
// **177 字符** —— 上限 200 只差 23 就会把它静默丢掉,而「丢掉」= 那条栈不参与中文兜底检查
// = 静默漏检,正是本版要治的病。吞过头的那种量级完全不同(整段文件),400 分得开。
const FONT_STACK_MAX = 400
function usedFontStacks(css) {
  // ⚠ 注释里的旧写法不算活栈(`/* 旧: font-family: Arial, sans-serif; */` 曾被当成真的报出来)
  // ⚠ `@font-face` 的 font-family 是**族名声明**,结构上不可能带中文兜底 ⇒ 报它永远修不掉
  const t = stripCssComments(String(css || '')).replace(/@font-face\s*\{[^}]*\}/gi, ' ')
  const out = []
  const eat = (s) => {
    const v = String(s || '').trim()
    if (v && v.length <= FONT_STACK_MAX && !/^var\(/.test(v) && !out.includes(v)) out.push(v)
  }
  for (const m of t.matchAll(new RegExp(STYLE_ATTR_RE_SRC, 'gi'))) {
    const decl = m[2] != null ? m[2] : (m[3] || '')
    for (const f of decl.matchAll(/font-family\s*:\s*([^;]+)/gi)) eat(f[1])
  }
  // 剥掉内联样式再走通用路径(免得同一段被两条路各扫一遍);⚠ 通用值域**不跨行**
  const rest = t.replace(new RegExp(STYLE_ATTR_RE_SRC, 'gi'), ' ')
  for (const m of rest.matchAll(/font-family\s*:\s*([^;}\n]+)/gi)) eat(m[1])
  // ⚠ 自定义属性**不要求带通用关键字**:`--mono:'Geist Mono','Courier New'` 是合法字体栈,
  //   而旧判据要求值里出现 sans-serif|monospace… ⇒ 这类栈整条不检查(审计逮到)。
  //   判据改成「带引号的族名」或「通用关键字」,两者有其一即算字体栈。
  for (const m of rest.matchAll(/--[\w-]+\s*:\s*([^;}\n]+)/gi)) {
    const v = m[1]
    if (/['"][^'"]+['"]/.test(v) || /\b(sans-serif|serif|monospace|cursive|system-ui)\b/.test(v)) eat(v)
  }
  return out
}
const CJK_TEXT_RE = /[一-鿿㐀-䶿]/

// ── 字体可得性(v0.11.66)────────────────────────────────────────────────────
// 由来:v0.11.63/64 治中文字体时的推理是「真实项目 439 个文件里 @font-face 命中 0 ⇒ webfont
// 根本没加载 ⇒ Windows 掉到宋体就是丑」。**同一条推理对拉丁族一字不差地成立,而从没人查过**:
// 16 份内置档的首选拉丁族几乎全是商业授权字体(Canela / Söhne / Neue Haas Grotesk / Druk …),
// `Helvetica Neue` 出现 14 次、打头 0 次 —— 永远在兜底位。而 usedFontStacks 反而**主动剥掉**
// @font-face 块(它查的是中文兜底,那里剥是对的)⇒ 全系统没有任何一处问「这个字体加载得到吗」。
// ⇒ 用 editorial 做的页面,标题的 Canela 大概率没加载 → Playfair(也没有)→ 掉到中文族 →
//   **实际渲染是苹方**,而所有检查器一个字不说。「字体身份」有相当一部分可能是幻觉。
//
// 判据的三个来源,按确定性排:
//   ① 这批文件里的 `@font-face` 族名声明(项目自带字体文件)
//   ② 字体服务链接(googleapis 及其国内镜像 / bunny / fontsource 包名)里认得出的族名
//   ③ 系统自带清单(mac / win 分开 —— Didot 与 Futura 只有 mac 有,Windows 上照样掉)
// ⚠ 误报预算的两条出口写死在报告里:字体由别处注入(构建工具 / 外部 CSS)⇒ 记进例外档;
//   认不出族名的外部字体链接**如实报个数**,而不是假装它们提供了任何东西。
// ⚠ 系统清单是**保守清单**:没列的按「不是系统自带」处理 ⇒ 漏列一个真系统字体会产生一条误报,
//   但措辞是「找不到加载来源」(事实)而非「肯定没加载」(断言);清单按两个平台各自出厂字体列。
const _fontKey = (f) => String(f || '').replace(/['"]/g, '').trim().toLowerCase()
// ⚠ `-apple-system` / `BlinkMacSystemFont` **不是通用族**:Windows 上的浏览器不认,直接跳过 ⇒ 按 mac 专属系统族处理
//   (第一版把它归进通用,liquid-glass 的 win 落点算成了 `-apple-system` —— 一个 Windows 上不存在的东西)。
const FONT_GENERIC_RE = /^(sans-serif|serif|monospace|ui-monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-rounded|emoji|math|fangsong|inherit|initial|unset)$/
const _MAC_FONTS = ['helvetica neue', 'helvetica', 'arial', 'arial black', 'arial narrow', 'georgia', 'times', 'times new roman',
  'futura', 'avenir', 'avenir next', 'avenir next condensed', 'gill sans', 'baskerville', 'didot', 'bodoni 72', 'bodoni 72 oldstyle',
  'optima', 'palatino', 'menlo', 'monaco', 'courier', 'courier new', 'verdana', 'trebuchet ms', 'hoefler text', 'american typewriter',
  'chalkboard', 'chalkboard se', 'cochin', 'copperplate', 'marker felt', 'noteworthy', 'papyrus', 'skia', 'zapfino', 'impact', 'tahoma',
  'charter', 'seravek', 'superclarendon', 'athelas', 'iowan old style', 'apple sd gothic neo', 'sf pro', 'sf pro display', 'sf pro text',
  'sf pro rounded', 'sf mono', 'sf compact', 'new york', '-apple-system', 'blinkmacsystemfont',
  // 中文 / 日文(mac 出厂)
  'pingfang sc', 'pingfang tc', 'pingfang hk', 'hiragino sans gb', 'hiragino sans', 'hiragino kaku gothic pron', 'hiragino mincho pron',
  'hiragino maru gothic pron', 'songti sc', 'songti tc', 'yuanti sc', 'yuanti tc', 'stheiti', 'heiti sc', 'kaiti sc', 'stkaiti', 'stsong',
  'stfangsong', 'lantinghei sc', 'wawati sc', 'hannotate sc', 'hanzipen sc', 'libian sc', 'weibei sc', 'xingkai sc', 'yuppy sc', 'baoli sc']
const _WIN_FONTS = ['arial', 'arial black', 'arial narrow', 'calibri', 'calibri light', 'cambria', 'cambria math', 'candara', 'comic sans ms',
  'consolas', 'constantia', 'corbel', 'courier new', 'ebrima', 'franklin gothic medium', 'gabriola', 'gadugi', 'georgia', 'impact',
  'lucida console', 'lucida sans unicode', 'malgun gothic', 'microsoft sans serif', 'palatino linotype', 'segoe ui', 'segoe ui variable',
  'segoe ui light', 'segoe ui semibold', 'segoe print', 'segoe script', 'sitka', 'sylfaen', 'symbol', 'tahoma', 'times new roman',
  'trebuchet ms', 'verdana', 'bahnschrift', 'cascadia mono', 'cascadia code',
  // 中文 / 日文 / 韩文(win 出厂)
  'microsoft yahei', 'microsoft yahei ui', 'microsoft jhenghei', 'microsoft jhenghei ui', 'simhei', 'simsun', 'simsun-extb', 'nsimsun',
  'kaiti', 'fangsong', 'dengxian', 'mingliu', 'ms gothic', 'ms mincho', 'yu gothic', 'yu gothic ui', 'yu mincho', 'meiryo', 'meiryo ui']
// 免费可得(字体服务上有 / 开源可自带)。这是给报告里那句「加一行链接就行」用的**提示**,不是判据。
const _FREE_FONTS = ['inter', 'eb garamond', 'nunito', 'nunito sans', 'quicksand', 'ibm plex sans', 'ibm plex mono', 'ibm plex serif',
  'jost', 'josefin sans', 'space grotesk', 'space mono', 'playfair display', 'poiret one', 'limelight', 'bodoni moda', 'archivo',
  'archivo black', 'archivo narrow', 'syne', 'anton', 'rubik', 'michroma', 'share tech mono', 'dm mono', 'dm sans', 'dm serif display',
  'jetbrains mono', 'schibsted grotesk', 'familjen grotesk', 'bricolage grotesque', 'host grotesk', 'martian mono', 'geist', 'geist mono',
  'caveat', 'roboto', 'roboto mono', 'roboto slab', 'open sans', 'lato', 'montserrat', 'poppins', 'source sans 3', 'source serif 4',
  'source code pro', 'manrope', 'work sans', 'fira sans', 'fira code', 'fira mono', 'raleway', 'oswald', 'merriweather', 'lora',
  'libre baskerville', 'libre franklin', 'cormorant', 'cormorant garamond', 'crimson pro', 'crimson text', 'spectral', 'fraunces',
  'instrument sans', 'instrument serif', 'plus jakarta sans', 'outfit', 'sora', 'urbanist', 'figtree', 'onest', 'unbounded', 'bebas neue',
  'barlow', 'barlow condensed', 'karla', 'mulish', 'public sans', 'red hat display', 'red hat text', 'red hat mono', 'ubuntu', 'ubuntu mono',
  'pt sans', 'pt serif', 'pt mono',
  // 中文 / 日文开源族
  'noto sans sc', 'noto serif sc', 'noto sans tc', 'noto serif tc', 'noto sans jp', 'noto serif jp', 'noto sans cjk sc', 'noto serif cjk sc',
  'noto sans mono', 'noto sans mono cjk sc', 'source han sans sc', 'source han serif sc', 'source han sans', 'source han serif',
  'lxgw wenkai', 'xiaolai', 'ma shan zheng', 'zcool xiaowei', 'zcool kuaile', 'zcool qingke huangyou', 'long cang', 'zhi mang xing',
  'zen kaku gothic new', 'zen old mincho', 'shippori mincho', 'm plus 1p', 'sawarabi mincho']
const SYSTEM_FONTS = (() => {
  const m = new Map()
  for (const f of _MAC_FONTS) m.set(f, { mac: true, win: false })
  for (const f of _WIN_FONTS) { const e = m.get(f); if (e) e.win = true; else m.set(f, { mac: false, win: true }) }
  return m
})()
const FREE_FONTS = new Set(_FREE_FONTS)
// 一个族名 → 它从哪来得到。generic 的一律算「有」(浏览器总能兜住)。
function fontAvailability(family) {
  const key = _fontKey(family)
  if (!key) return { key, generic: false, mac: false, win: false, free: false }
  if (FONT_GENERIC_RE.test(key)) return { key, generic: true, mac: true, win: true, free: false }
  const sys = SYSTEM_FONTS.get(key) || { mac: false, win: false }
  return { key, generic: false, mac: !!sys.mac, win: !!sys.win, free: FREE_FONTS.has(key) }
}
// 栈里**第一个非通用族**(设计者真正想要的那个)。`inherit`/`var(` 这类不算。
// ⚠ `-apple-system` / `BlinkMacSystemFont` 打头是「用系统字体」的**意图**,不是选了某个族 ——
//   它们在落点推算里按 mac 专属处理(Windows 跳过),但作为「首选」要跳过,否则整条系统栈被报成
//   「只有 mac 自带」(审计实测)。
const FONT_SYSTEM_ALIAS_RE = /^(-apple-system|blinkmacsystemfont)$/
function _firstWantedFamily(stack) {
  for (const f of _stackFamilies(stack)) {
    if (/^var\(/.test(f)) return ''
    const k = _fontKey(f)
    if (!FONT_GENERIC_RE.test(k) && !FONT_SYSTEM_ALIAS_RE.test(k)) return f
  }
  return ''
}
// 这批文件**自己**提供了哪些族:@font-face 声明 + 认得出的字体服务链接 + fontsource 包名。
// ⚠ 认不出族名的外部字体链接单独计数 —— 它们可能提供了任何东西,报告要如实说「另有 N 个认不出」,
//   而不是假装没有(那会把「链接了 Inter」读成「什么都没链接」)。
const _FONT_HOSTS_RE = /fonts\.(?:googleapis\.com|gstatic\.com|bunny\.net|loli\.net|font\.im|geekzu\.org|proxy\.ustclug\.org)|fonts\.googleapis\.cn/i
function declaredFontSources(texts) {
  const loaded = new Set()
  let unknownLinks = 0
  const add = (name) => { const k = _fontKey(name); if (k) loaded.add(k) }
  for (const raw of texts || []) {
    const t = stripCssComments(String(raw || ''))
    for (const m of t.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
      for (const f of m[1].matchAll(/font-family\s*:\s*([^;]+)/gi)) add(f[1])
    }
    // ⚠ 小程序没有 @font-face,走 `wx.loadFontFace({ family: 'X', source: … })`;网页里还有
    //   `new FontFace('X', …)` —— 两种都是「项目自带了这个族」,认不出就把 某项目这类小程序全报成没来源
    for (const m of t.matchAll(/loadFontFace\s*\(\s*\{[^}]*?family\s*:\s*['"]([^'"]+)['"]/g)) add(m[1])
    for (const m of t.matchAll(/new\s+FontFace\s*\(\s*['"]([^'"]+)['"]/g)) add(m[1])
    // ⚠ 协议相对的 `//fonts.googleapis.com/…` 是老页面的常见写法,漏掉它 = 把「链接了」读成「没链接」
    for (const m of t.matchAll(/(?:https?:)?\/\/[^\s"'()<>]+/gi)) {
      const url = m[0]
      if (_FONT_HOSTS_RE.test(url)) {
        // css?family=A|B  ·  css2?family=A:wght@400&family=B  —— 两代写法都认;`+` 是空格,`:` 后是轴
        // ⚠ decodeURIComponent 遇畸形 % 会抛 —— 这里一抛整个 check 就死(审计实测),按原文退回
        const dec = (s) => { try { return decodeURIComponent(s) } catch { return s } }
        const fams = [...url.matchAll(/[?&]family=([^&#]+)/gi)].flatMap((x) => dec(x[1]).split('|'))
        let n = 0
        for (const f of fams) { const nm = f.split(':')[0].replace(/\+/g, ' ').trim(); if (nm) { add(nm); n++ } }
        // ⚠ 只有**样式表**链接才算「认不出族名」:`<link rel=preconnect href=https://fonts.gstatic.com>`
        //   是正规接法自带的,没有 family= 是它的常态 —— 把它计进去,每个正确接法都多一句噪音(审计实测 +2)
        if (!n && /\/css\d?(?:[?#]|$)/i.test(url)) unknownLinks++
        continue
      }
      const fs = /@fontsource(?:-variable)?\/([a-z0-9-]+)/i.exec(url)
      if (fs) { add(fs[1].replace(/-/g, ' ')); continue }
      if (/font/i.test(url) && /\.(?:css|woff2?|ttf|otf)(?:[?#]|$)/i.test(url)) unknownLinks++
    }
  }
  return { loaded, unknownLinks }
}
// 这条栈在某个平台上**实际落到**哪个族:从头走,第一个「自带 / 系统有 / 通用」的就是它。
// 返回 null = 一路走到底都没有(浏览器默认)。
function fontLanding(stack, { loaded = null, platform = 'mac' } = {}) {
  for (const f of _stackFamilies(stack)) {
    const av = fontAvailability(f)
    if (av.generic) return { family: f, via: 'generic' }
    if (loaded && loaded.has(av.key)) return { family: f, via: 'loaded' }
    if (platform === 'mac' ? av.mac : av.win) return { family: f, via: 'system' }
  }
  return null
}
const _landText = (l) => (l ? l.family + (l.via === 'generic' ? '(浏览器默认)' : '') : '浏览器默认')
const _cjkKindOf = (fam) => { const hit = CJK_KIND_RE.find(([, re]) => re.test(String(fam || ''))); return hit ? hit[0] : '' }
// 档管的是不是手机端(小程序 / App):落点清单只有 mac / win,对手机档不能张口说「Windows 上显示雅黑」
const _docIsMobile = (tokens) => /小程序|移动|app|手机|ios|android|鸿蒙|harmony/i.test(String((tokens && tokens.platform) || ''))
// ⭐ 一条栈的「首选族来源」裁决 —— check 与 doctor **共用这一个**(两处同款判据分开写,上一版变异检验
//   当场抓到一处没被钉住;裁决只许有一份实现)。返回 null = 没问题,否则给出两平台各自的落点与「丢没丢」。
//   「丢」的定义分两路:
//   · 拉丁首选:凡落到别的族都算丢(Canela 换成谁都不再是 Canela)
//   · **中文首选**:按黑体 / 宋体 / 圆体 / 手写那一路比 —— `'PingFang SC','Microsoft YaHei UI'` 这种
//     mac/win 各落一路黑体的写法是**有意的跨平台兜底**,不是问题(审计实测被误报);而宋体栈在 Windows
//     上落到雅黑是宋体身份整个丢掉,必须报。
function fontSourceVerdict(stack, { loaded = null } = {}) {
  // ⚠ 栈以 `-apple-system` / `BlinkMacSystemFont` / `system-ui` 打头 = 设计者要的就是「各平台自己的系统字体」,
  //   后面的 Segoe UI / Roboto 是给别的平台准备的 —— 这种栈没有「首选族」可言,整条不裁
  //   (审计实测:跳过别名后首选成了 Segoe UI,mac 那边被报「丢了」,而 mac 上正落在 -apple-system 上)。
  const lead = _fontKey(_stackFamilies(stack)[0])
  if (FONT_SYSTEM_ALIAS_RE.test(lead) || lead === 'system-ui') return null
  const first = _firstWantedFamily(stack)
  if (!first) return null
  const av = fontAvailability(first)
  if (loaded && loaded.has(av.key)) return null
  if (av.mac && av.win) return null
  const cjk = CJK_FAMILY_RE.test(first)
  const landMac = fontLanding(stack, { loaded, platform: 'mac' })
  const landWin = fontLanding(stack, { loaded, platform: 'win' })
  const kept = (l) => !!l && (cjk ? (_cjkKindOf(l.family) !== '' && _cjkKindOf(l.family) === _cjkKindOf(first)) : _fontKey(l.family) === av.key)
  const lostMac = !kept(landMac), lostWin = !kept(landWin)
  if (!lostMac && !lostWin) return null
  return { family: first, mac: av.mac, win: av.win, free: av.free, cjk, landMac, landWin, lostMac, lostWin }
}
// 报告里那句「实际显示的是什么」—— 只说丢了的那一边;中文首选时标出「宋体→黑体」这种路数变化。
function _landingSentence(v, { mobile = false } = {}) {
  if (mobile) return '手机上同样找不到它 ⇒ 实际显示的是各系统自带的中文字体(iOS / Android 各不相同)'
  const one = (label, l) => label + '→' + _landText(l) + (v.cjk && l && _cjkKindOf(l.family) !== _cjkKindOf(v.family) ? '⚠' + _cjkKindOf(v.family) + '→' + (_cjkKindOf(l.family) || '别的') : '')
  const parts = []
  if (v.lostMac) parts.push(one('mac', v.landMac))
  if (v.lostWin) parts.push(one('Windows', v.landWin))
  const head = v.mac && !v.win ? '它只有 mac 自带,Windows 上没有 ⇒ ' : !v.mac && v.win ? '它只有 Windows 自带,mac 上没有 ⇒ ' : '实际显示的会是 '
  return head + parts.join(' / ')
}

// ── 图标体系(契约见 docs/ICONS.md)──────────────────────────────────────────
// 缺口不是「少一个检查器」,是**一致性没有载体**:风格档是唯一跨轮携带到 agent 眼前的东西,
// 而它此前零处提到图标 —— 某项目那份的色/字/间距/投影/动效全是从 95 个页面量出来的,
// 唯独图标一片空白。于是每做一个新页面,agent 就重新发明一套 path,丢了也没人知道。
// ⚠ **一致性由「取得到正确图标」保证,不由「检查出不一致」保证** —— 重心在 readIcon 那条路,
// 检查器只兜底:它能发现不一致,造不出一致。
// ⚠ **描边型 vs 填充型是比「网格/描边粗细」更硬的分野**(2026-08-25 调研实测):
//   · 描边型(lucide / tabler):`stroke` + `stroke-width`,粗细能用 CSS 调。
//   · 填充型(phosphor / pixelart):轮廓已经转成填充路径 ⇒ **`strokeWidth` / `linecap` / `linejoin`
//     这三项对它完全无效**。而风格档 icons 段声明的正好是 style/strokeWidth/linecap/corner 四项 ——
//     四项里三项不成立。⇒ 验收(checkIcons)必须先按 `form` 分流,否则会把「这套库根本没有描边」
//     误报成「描边不合规」,而误报会让整份报告被无视(v0.11.29 间距/阴影不测是同一条理由)。
// ⚠ `dirs` 从字符串数组改成结构:一个目录是什么形态、什么字重、文件名带什么后缀,**都得显式声明**,
//   不能再靠对路径做正则(phosphor 的 fill 目录叫 `fill` 不叫 `filled`,正则当场就错)。
// mb = 装好后实际占的磁盘(2026-10 在 macOS 上 du 实测;几千个小文件按块计,比 npm 报的 unpackedSize 大一倍多)。
// 向导问「要不要代装」时报合计,版本变了会有出入
const ICON_LIBS = {
  // lucide 与 tabler 的分发文件属性逐字相同(24 网格 / fill:none / stroke:currentColor / 2 / round),
  // **参数同构才是混用的依据** —— 检查按参数判、不按库名判,兜底也只在同构的两套之间成立。
  lucide: { pkg: 'lucide-static', mb: 66, label: 'Lucide', license: 'ISC', form: 'stroke', grid: 24, dirs: [{ dir: 'icons', style: 'outlined' }] },
  tabler: { pkg: '@tabler/icons', mb: 49, label: 'Tabler', license: 'MIT', form: 'stroke', grid: 24, dirs: [{ dir: 'icons/outline', style: 'outlined' }, { dir: 'icons/filled', style: 'filled' }] },
  // ⚠ phosphor:**六个字重是六套独立几何**(不是同一套图的粗细参数),且 regular 档文件名无后缀、
  //   其余带 `-{字重}` 后缀(`gear.svg` / `gear-bold.svg`)—— 这是 `suffix` 字段存在的唯一理由。
  //   duotone 用两条 path + opacity 0.2 做副色,副色仍继承 currentColor(不是第二种颜色)。
  phosphor: {
    pkg: '@phosphor-icons/core', mb: 37, label: 'Phosphor', license: 'MIT', form: 'fill', grid: 256,
    dirs: [
      { dir: 'assets/thin', style: 'outlined', weight: 'thin', suffix: '-thin' },
      { dir: 'assets/light', style: 'outlined', weight: 'light', suffix: '-light' },
      { dir: 'assets/regular', style: 'outlined', weight: 'regular', suffix: '' },
      { dir: 'assets/bold', style: 'outlined', weight: 'bold', suffix: '-bold' },
      { dir: 'assets/duotone', style: 'outlined', weight: 'duotone', suffix: '-duotone' },
      { dir: 'assets/fill', style: 'filled', weight: 'regular', suffix: '-fill' },
    ],
  },
  // ⚠ pixelart:实心变体是**同目录 `-solid` 后缀**(不是子目录),而且**只覆盖 53/651**(实测)
  //   ⇒ 系统那边**不声明支持实心** —— 声明了就是句假话,八成的名字取不到实心。
  pixelart: { pkg: 'pixelarticons', mb: 15, label: 'Pixelarticons', license: 'MIT', form: 'fill', grid: 24, dirs: [{ dir: 'svg', style: 'outlined' }] },
}
// ── 图标系统(v0.11.53)= 与设计风格**平级**的实体 ────────────────────────────
// **图标系统 = 图形从哪来 + 叫什么名 + 怎么起名;风格 = 我用哪套 + 怎么画它。**
// 由来是三条实测(2026-08-25):
//  F1 系统封装的是**整个名字空间**不只是词表 —— lucide 2025 名 / tabler 5130 名,**同名只有 640**
//     (占 lucide 32%、tabler 12%)⇒ 换主库不是换个皮肤,是换一整套叫法。
//  F2 换主库有真实视觉意义 —— 8 个常用同名图标(search/heart/user/settings/calendar/clock/filter/plus)
//     几何 **8/8 全不同** ⇒ 「选哪套」是个真选择,值得做成实体。
//  F3 ⚠ **兜底会稀释主视觉,能把「选主库」这件事整个架空** —— 主库设 tabler 而 agent 仍用 lucide 词汇
//     (`more-horizontal`/`trash-2`…)⇒ 只有 32% 命中 tabler,**其余 68% 走兜底、拿到 lucide 的画法**。
// ⇒ **系统必须同时带走「命名词汇」**,否则选了等于没选 —— 这就是 semantics 表归系统的原因,
//    也是本表最要紧的一栏(不是 library 那一栏)。
// **它是代码里的一张表,不开放用户自定义**(2026-08-25 拍板)⇒ 不需要用户目录/表单/落盘裁决。
// ⚠ **一份风格档恰好一个系统**:想配多套的三种场景都另有正路 —— 一个项目多份风格档各用各的
//   (已天然支持)· 同页混用两套(**正是要禁的**,图标体系存在的全部理由就是单一来源)· 取不到时
//   换一套(**那就是 fallback**)。真配多套立刻撞上「取图标时用哪套」:顺序兜底 = 就是 fallback,
//   让 agent 每次挑 = 把智能塞进编排层。
// ⚠ **兜底只在参数同构的两套之间成立** —— lucide↔tabler 的分发属性逐字相同,混用看不出来;
//   而 phosphor(256 网格填充型)、pixelart(像素点阵)没有同构的搭档,给它们配兜底 =
//   一个像素风页面里冒出一枚矢量线性图,比缺一张图难看得多 ⇒ 它们的兜底是 null。
//   这不是遗漏:F3 说的「兜底稀释主视觉」在气质差得远的两套之间是**成倍放大**的。
const ICON_SYSTEMS = {
  lucide: { label: 'Lucide', library: 'lucide', fallbackLibrary: 'tabler', styles: ['outlined'] },
  tabler: { label: 'Tabler', library: 'tabler', fallbackLibrary: 'lucide', styles: ['outlined', 'filled'] },
  // 一次补齐「多字重 + 实心 + 双色」三项,是四套里气质跨度最大的一套
  phosphor: { label: 'Phosphor', library: 'phosphor', fallbackLibrary: null, styles: ['outlined', 'filled'], weights: ['thin', 'light', 'regular', 'bold', 'duotone'] },
  // 像素点阵:零曲线零斜线,与前三套是不同物种
  pixelart: { label: 'Pixelarticons', library: 'pixelart', fallbackLibrary: null, styles: ['outlined'] },
}
// 语义词表:两库同名的 43 条走共表,各自只写**不一样的那 19 条** —— 差异摆在一起才看得见
// F1 说的那件事(同一个「更多」,一边叫 more-horizontal 一边叫 dots)。
// ⚠ 每一条都对着**真实库文件**核过(lucide-static 2025 / @tabler/icons outline 5130),
//   62/62 命中、对照组(一个不存在的名字)如实报缺 —— 词表里写一个库里没有的名字,
//   症状是 agent 按语义名取图标却拿到「两个库里都没有」,比不写更糟。
// ⚠ 只覆盖高频操作,不求全(step 2 才扩到常用两三百条)。表里没有的名字原样透传。
const _SEM_COMMON = {
  back: 'chevron-left', forward: 'chevron-right', up: 'chevron-up', down: 'chevron-down',
  close: 'x', search: 'search', filter: 'filter', settings: 'settings',
  user: 'user', users: 'users', add: 'plus', edit: 'pencil', copy: 'copy',
  download: 'download', upload: 'upload', check: 'check', error: 'circle-x',
  calendar: 'calendar', clock: 'clock', heart: 'heart', star: 'star', bookmark: 'bookmark',
  notification: 'bell', link: 'link', external: 'external-link', file: 'file', folder: 'folder',
  list: 'list', grid: 'layout-grid', lock: 'lock', eye: 'eye', 'eye-off': 'eye-off',
  send: 'send', mail: 'mail', phone: 'phone', location: 'map-pin', tag: 'tag',
  cart: 'shopping-cart', trophy: 'trophy', medal: 'medal', gift: 'gift', camera: 'camera', print: 'printer',
}
const _SEM_LUCIDE = {
  menu: 'menu', more: 'more-horizontal', sort: 'arrow-up-down', home: 'house', delete: 'trash-2',
  share: 'share-2', refresh: 'refresh-cw', success: 'check-circle', warning: 'triangle-alert',
  info: 'info', help: 'circle-question-mark', announce: 'megaphone', logout: 'log-out', login: 'log-in',
  image: 'image', chart: 'bar-chart-3', play: 'play', pause: 'pause', message: 'message-square',
}
const _SEM_TABLER = {
  menu: 'menu-2', more: 'dots', sort: 'arrows-sort', home: 'home', delete: 'trash',
  share: 'share', refresh: 'refresh', success: 'circle-check', warning: 'alert-triangle',
  info: 'info-circle', help: 'help', announce: 'speakerphone', logout: 'logout', login: 'login',
  image: 'photo', chart: 'chart-bar', play: 'player-play', pause: 'player-pause', message: 'message',
}
// Phosphor 的叫法与前两套差得最远(实测 62 条里只有 40 条能直接用现成叫法)。
// ⚠ `menu: 'list'` 是对的 —— Phosphor 的汉堡菜单就叫 list;而它的 `hamburger` **是个汉堡包**(食物)。
//   这正是「换一套系统等于换一整套叫法」的实物:照搬别家词汇会取到风马牛不相及的图。
const _SEM_PHOSPHOR = {
  ..._SEM_COMMON,
  back: 'caret-left', forward: 'caret-right', up: 'caret-up', down: 'caret-down',
  search: 'magnifying-glass', filter: 'funnel', settings: 'gear', sort: 'arrows-down-up',
  home: 'house', delete: 'trash', share: 'share', refresh: 'arrows-clockwise',
  success: 'check-circle', warning: 'warning', error: 'x-circle', info: 'info', help: 'question',
  external: 'arrow-square-out', grid: 'squares-four', 'eye-off': 'eye-slash', more: 'dots-three',
  logout: 'sign-out', login: 'sign-in', message: 'chat-circle-text', send: 'paper-plane-tilt',
  mail: 'envelope', menu: 'list', list: 'list-bullets', image: 'image', chart: 'chart-bar',
  announce: 'megaphone', play: 'play', pause: 'pause', notification: 'bell', print: 'printer',
}
// Pixelarticons 的词汇与 lucide 高度重合(62 条里 50 条直接命中)—— 四套里迁移成本最低的一套。
// ⚠ **三条如实空着**:`medal` 库里没有;`success`/`error` 只有裸的对勾与叉,**没有圆圈态**。
//   空着 ⇒ 按语义名取会如实报「这个库里没有」,而硬塞一个形近的图标就成了「做了 A 让人以为做了 B」。
const _SEM_PIXELART = {
  ..._SEM_COMMON,
  settings: 'settings-cog', list: 'list-box', grid: 'grid-3x3', sort: 'sort-vertical',
  warning: 'square-alert', info: 'circle-info', help: 'circle-question', chart: 'chart-bar-big',
  tag: 'label', home: 'home', delete: 'trash', share: 'share', refresh: 'refresh',
  menu: 'menu', more: 'more-horizontal', announce: 'megaphone', logout: 'logout', login: 'login',
  image: 'image', play: 'play', pause: 'pause', message: 'message',
  medal: '', success: '', error: '',
}
ICON_SYSTEMS.lucide.semantics = { ..._SEM_COMMON, ..._SEM_LUCIDE }
ICON_SYSTEMS.tabler.semantics = { ..._SEM_COMMON, ..._SEM_TABLER }
ICON_SYSTEMS.phosphor.semantics = _SEM_PHOSPHOR
// 空串 = 这套库里没有这条语义 ⇒ 直接删掉键,别留一个映射到空的条目(下游会当成「没配」)
ICON_SYSTEMS.pixelart.semantics = Object.fromEntries(Object.entries(_SEM_PIXELART).filter(([, v]) => v))

// ── 项目的图标档 `design/icons.md`(2026-08-25 产品决定)──────────────────────
// ⭐ **图标库与设计风格库平级,不是风格的一个维度** —— 一个项目分别选:用哪套风格 · 用哪套图标。
// 此前 `system` 写在风格档的 icons 段里,等于「换风格就换了图标」,而这两件事本就该能自由配对。
// **落点必须在项目里、且不在风格档里**(用户选定):
//   · 存群配置不行 —— `sbot design icon` 是 agent 在**项目目录**里跑的,它够不着群配置、也不知道
//     自己属于哪个群 ⇒ 取图标那条主路当场断掉;项目 clone 到别处也会把这个选择丢掉。
//   · 一份独立档则跟着代码走,且 `assets`(图标资产扫描范围)**终于有了正确的家** ——
//     它本来就是项目事实,塞在全局风格库的档里根本没有「项目」上下文(规划里挂了很久的未决项)。
// ⚠ 分工一句话:**图标档答「图形从哪来、叫什么名」,风格档答「怎么画它」**(描边/端点/尺寸/颜色
//   仍归风格 —— 16 份内置档里 8 份声明的正是这四项,搬走它们等于让那 8 份声明当场作废;
//   而「同一套 tabler 图标,手绘风格里 1.5px、瑞士风格里 2px」本就是对的)。
const ICONS_DOC_REL = path.join('design', 'icons.md')
// 认帧:front matter 顶层有 `system` 才算图标档。⚠ **宁可漏认不可错认** —— 认错了会往别人的
// 文档上写东西(与 isStyleDoc 认 colors 同一条纪律)。
function isIconsDoc(text) {
  const fm = _frontMatter(text)
  return !!fm && fm.some((l) => /^\s*system\s*:/.test(l))
}
// 图标档 → 项目侧图标声明(读不出返回 null = 这个项目还没选图标系统)。
// ⚠ 顶层扁平不嵌套:整份档就是讲图标的,再包一层 `icons:` 只是白多一级缩进。
function parseIconsDoc(text) {
  const tk = parseStyleTokens(text)
  if (!tk || !tk.system) return null
  const fbRaw = _icStr(tk.fallbackLibrary == null ? tk.fallback : tk.fallbackLibrary, '').toLowerCase()
  // 线性/实心:图标档也能声明它 —— 挑系统的那一处顺手就定得了,不必再手改风格档
  // (控制台选图标系统时没有线性或实心)。风格档的声明仍然优先,见 iconSpec。
  // ⚠ 没写 ⇒ **undefined 不是 'outlined'**:它得能与「风格档也没写」区分开,默认值才轮得上;
  //   写死成 outlined 等于图标档替所有没声明的项目做了主张。
  // ⚠ 认不出的词当没说 + 留痕给界面(同 fallbackUnknown 那条):静默归一的话,档里写着
  //   `style: sold`(少个 i)的人会一直以为自己选的是实心。
  const stRaw = _icStr(tk.style, '').toLowerCase()
  return {
    system: _icStr(tk.system, '').toLowerCase(),
    style: stRaw ? (ICON_STYLE_WORDS[stRaw] || undefined) : undefined,
    styleUnknown: stRaw && !ICON_STYLE_WORDS[stRaw] ? stRaw : null,
    // ⚠ 没写 fallback ⇒ undefined(**不是 null**):null 是「明确不要兜底」,两者下游动作不同 ——
    //   把「没说」当成「不要」,系统自带的兜底会被静默关掉,而那是取不到图标时唯一的退路。
    // ⚠ 认不出的库名(`lucid` 少打一个 e)不许当真:`iconDirs` 查不到它 ⇒ **静默变成没有兜底**,
    //   而群卡那行还会照着念「取不到时去 lucid 兜底」。认不出就当没说,并留痕给界面标注。
    fallbackLibrary: fbRaw ? (/^(none|off|no|false)$/.test(fbRaw) ? null : (iconLibOf(fbRaw) ? fbRaw : undefined)) : undefined,
    fallbackUnknown: fbRaw && !/^(none|off|no|false)$/.test(fbRaw) && !iconLibOf(fbRaw) ? fbRaw : null,
    assets: _icStr(tk.assets, '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}
// 已有图标档时**只改 front matter 的那三键,正文逐字节保留** —— 风格档早有「手写细则不许被
// 换个设定冲掉」这条硬规矩(withStyleProse),图标档漏了同一条:而这份档的注释还写着
// 「写全注释:这份档是给人看的」,就是要人往里写东西。实测:往档里加一段项目细则后换一次系统,
// 那段当场消失。
// ⚠ 这几个键是「设成这个值」不是「合并」:传空 = 把该键**删掉**(assets/fallback 一直是这个
//   语义,style 跟上)。⇒ **调用方只改一项时必须把其余几项按当前值原样传回**,否则会把人家
//   声明过的实心静默抹成默认线性 —— 服务端那两处都照此传。
function withIconsDocFront(text, { system, assets = '', fallback = '', style = '' }) {
  const fm = _frontMatter(text)
  if (!fm) return null
  // ⚠ 连**注释掉的同名占位**一起清:模板里写着 `# fallback: "none"  # 取不到时不去 tabler 兜底`,
  //   换成一套没有兜底的系统后那句就成了假话,而它看起来像是这份档自己的说明。
  const set = (lines, key, val) => {
    const re = new RegExp('^\\s*#?\\s*' + key + '\\s*:')
    const kept = lines.filter((l) => !re.test(l))
    return val ? [...kept, `${key}: "${val}"`] : kept
  }
  let out = fm.slice()
  out = set(out, 'system', String(system || '').toLowerCase())
  out = set(out, 'style', style)
  out = set(out, 'assets', assets)
  // fallback / fallbackLibrary 两个拼法都清掉,再按需写回规范那个
  out = out.filter((l) => !/^\s*#?\s*fallbackLibrary\s*:/.test(l))
  out = set(out, 'fallback', fallback)
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  return `---\n${out.join('\n')}\n---\n${body}`
}

// 「这次该写什么内容」的**唯一裁决**:已有档 ⇒ 只改 front matter(正文逐字节保留);
// 没有 / 认不出帧 ⇒ 用模板新建。
// ⚠ 收成一处是因为它有**两个落点**(CLI 与控制台)—— 判断留在各自的落点里就测不到,
//   而测不到的分支正是会漂的那个(同一条线上 checkDesign 已经栽过一次:单测绿、真实路径没接上)。
// 风格档里 `icons.style` 的**子键级**改写。此前控制台保存风格只做整段级保留
// (withKeptSections 把整个 icons 段原样搬走)⇒ 这一维界面上只读不可写;而真实项目的风格档
// **恰恰都声明了它**,于是群卡那个项目级控件被压成灰的、等于没做。
// ⚠ **正文与其余键一个字节都不许动** —— 这份档里大量条目是踩过的坑换来的,档里自己写着
//   「要删要改先在群里说清为什么」。所以只在 icons 段内动 style 这一行,不重排、不重写。
// ⚠ 段的边界按「下一个顶层键」判,不按缩进量猜:icons 段里嵌着 size / semantics 两层子表,
//   拿缩进找结尾会在第一个子表处提前收尾,把后面的键甩到段外。
function withIconsStyleInStyleDoc(text, style) {
  const fm = _frontMatter(text)
  if (!fm) return null
  const isTop = (l) => /^[A-Za-z0-9_-]+\s*:/.test(l)
  const out = fm.slice()
  const s = out.findIndex((l) => /^icons\s*:/.test(l))
  if (s < 0) {
    if (!style) return text // 本来就没声明,要清也无事可做
    out.push('icons:', `  style: "${style}"`)
  } else {
    let e = s + 1
    while (e < out.length && !isTop(out[e])) e++
    const seg = out.slice(s + 1, e)
    const i = seg.findIndex((l) => /^\s+style\s*:/.test(l))
    if (style) {
      if (i >= 0) seg[i] = seg[i].replace(/^(\s+style\s*:).*$/, `$1 "${style}"`)
      else seg.unshift(`  style: "${style}"`)
    } else if (i >= 0) seg.splice(i, 1)
    else return text
    out.splice(s + 1, e - s - 1, ...seg)
  }
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  return `---\n${out.join('\n')}\n---\n${body}`
}

// 声明的形态必须是这套系统真供得起的。**挡在写盘前,不是写完再体检** —— 一份 `style: filled`
// 落在只有线性的 lucide 上,取图标时会静默拿到线性(iconStyleGap 只在体检时才出声),而档里
// 白纸黑字写着实心。「声明与事实不符」是这条线上最贵的一类 bug(v0.11.49 那次:声明实心、
// lucide 实心图标数为 0、stderr 摘要还跟着声明念「实心」—— 两处一起骗人)。
function _iconsDocStyle(opts) {
  const raw = _icStr(opts && opts.style, '').toLowerCase()
  if (!raw) return ''
  const style = ICON_STYLE_WORDS[raw]
  if (!style) throw new Error(`认不出的图标形态「${opts.style}」—— 可选:线性(outlined)/ 实心(filled)`)
  const sys = ICON_SYSTEMS[String((opts && opts.system) || '').toLowerCase()]
  if (sys && !(sys.styles || []).includes(style)) {
    throw new Error(`「${sys.label}」没有${style === 'filled' ? '实心' : '线性'}图标 —— 供得起实心的是:${_solidSystemNames().join(' / ') || '暂无'}`)
  }
  return style
}
function iconsDocText(existingText, opts) {
  const o = { ...opts, style: _iconsDocStyle(opts) }
  return (existingText && withIconsDocFront(existingText, o)) || composeIconsDoc(o)
}

function findIconsDoc({ cwd, readFile = _readFileOrNull } = {}) {
  const root = path.resolve(cwd || process.cwd())
  const abs = path.join(root, ICONS_DOC_REL)
  let text = null
  try { text = readFile(abs) } catch { return null }
  if (text == null || !isIconsDoc(text)) return null
  const spec = parseIconsDoc(text)
  return spec ? { abs, rel: ICONS_DOC_REL, text, ...spec } : null
}
// 落盘用的档正文。**写全注释**:这份档是给人看的,而人第一次看见它时不知道能填什么。
function composeIconsDoc({ system, assets = '', fallback = '', style = '' }) {
  const sys = ICON_SYSTEMS[String(system || '').toLowerCase()]
  if (!sys) throw new Error(`没有名为「${system}」的图标系统 —— 可选:${Object.keys(ICON_SYSTEMS).join(' / ')}`)
  const name = String(system).toLowerCase()
  return `---
system: "${name}"
${style ? `style: "${style}"`
    : (sys.styles || []).length > 1
      ? `# style: "filled"                     # 线性还是实心(这套两种都有,不写=线性);风格档里写了的话以那份为准`
      : `# 这套只有线性一种形态 —— 要实心得换一套(${_solidSystemNames().join(' / ') || '暂无'})`}
${assets ? `assets: "${assets}"` : '# assets: "miniprogram/images/icons"   # 图标文件在哪(资产体检的扫描范围;多个目录用逗号分隔)'}
${fallback ? `fallback: "${fallback}"`
    : sys.fallbackLibrary
      ? `# fallback: "none"                     # 取不到时不去 ${sys.fallbackLibrary} 兜底(默认会兜)`
      : `# 这套没有兜底库(没有画法同构的搭档)—— 库里没有的名字就是取不到,换个名字或换一套`}
---

# 图标

⚠ **用哪套图标由上面的 \`system\` 决定**(改它就换了整套图形和叫法)。这段正文**不复述**它是哪套 ——
复述一遍就成了同一件事的第二份拷贝,换系统时改了上面忘了下面,档里两句话就开始互相矛盾。
要看当前这套长什么样、有哪几套可选,让机器人列一下即可。

与设计风格是**两件事** —— 风格管怎么画(描边、端点、尺寸档、颜色),写在 \`design/styles/\` 里那几份档。

- 取图标一律用 \`sbot design icon <名字…>\`,不要自己写 path。
- 换系统会换掉**整套叫法**(同一个「更多」各家名字都不同),而页面上已经取过的图标不会自动跟着变。

<!-- 下面随便写:项目自己的图标约定(哪些不走图标体系、某个页面的特例…)换系统时会原样保留 -->
`
}

// ⚠ **查这两张表一律走自有属性**:键来自项目里 agent 可写的档,而 `ICON_SYSTEMS['constructor']`
//   / `['__proto__']` 会命中**原型上的东西**且为真 ⇒ 后面 `sys.semantics` / `sys.styles` 当场抛,
//   而 `projectIconCard` 就挂在 /api/state 上、不在任何 try 里 ⇒ **一个群的一份坏档,
//   让所有群的控制台每 15 秒黑一次**。实测 `system: "constructor"` 可复现。
const iconSystemOf = (k) => (Object.prototype.hasOwnProperty.call(ICON_SYSTEMS, String(k || '')) ? ICON_SYSTEMS[String(k)] : null)
// 「哪几套供得起实心」—— 三处要用(建档模板的注释 · iconStyleGap 的修法建议 · 控制台校验)。
// ⚠ 收成一处不是洁癖:加一套新的实心库时,散着的那几份必然只改到其中一份,而漏掉的那份
//   会稳定地少报一个选项 —— 与本文件里 iconStyleGap 曾经栽过的「同一判据散多处」同形。
const _solidSystemNames = () => Object.entries(ICON_SYSTEMS).filter(([, v]) => (v.styles || []).includes('filled')).map(([k]) => k)
const iconLibOf = (k) => (Object.prototype.hasOwnProperty.call(ICON_LIBS, String(k || '')) ? ICON_LIBS[String(k)] : null)

const ICON_DEFAULTS = { grid: 24, strokeWidth: 2, linecap: 'round', linejoin: 'round', style: 'outlined' }
const ICON_SIZE_DEFAULTS = { sm: 16, md: 20, lg: 24 }
// 渲染尺寸闸门:>32px 一律当插画/banner 不看。**用尺寸代替「图标 vs 插画」的分类** ——
// 真做分类必然误报,而误报会让整份报告被无视(v0.11.29 间距/阴影不测是同一条理由)。
const ICON_RASTER_MAX = 32

function _icNum(v, d) { const n = parseFloat(String(v == null ? '' : v)); return Number.isFinite(n) ? n : d }
function _icStr(v, d) { const s = String(v == null ? '' : v).trim(); return s || d }
// 值域归一:同一件事有**设计口径**和 **SVG 口径**两种说法(线性/实心 ↔ outlined/filled,
// 直角/圆角 ↔ miter/round)。写档的是人,不该逼他记 SVG 属性名 ⇒ 两种都收,归到 SVG 那套
// (下游 iconDirs 按 'filled' 判、checkIcons 拿它跟页面里的 stroke-linejoin 直接比)。
// ⚠ 归一只此一处:两处各写一份就是 v0.11.47/48 连着栽的那个形状。
const ICON_STYLE_WORDS = { line: 'outlined', linear: 'outlined', outline: 'outlined', outlined: 'outlined', stroke: 'outlined', solid: 'filled', fill: 'filled', filled: 'filled' }
const ICON_JOIN_WORDS = { sharp: 'miter', miter: 'miter', round: 'round', rounded: 'round', bevel: 'bevel' }
function _icWord(v, table, d) { const s = _icStr(v, '').toLowerCase(); return table[s] || (s ? s : d) }
function _icEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }

// front matter 的 icons 段 → 归一 spec。**没有该段返回 null = 整类不测**(没依据就不报,
// 与「风格档没写 rounded 就不查圆角」同一条纪律)。
// ⚠ icons 必须住 front matter 顶层,绝不进 colors:styleRoles 只扫 colors 的直接子键,
// 塞进去的颜色会参与角色兜底,彩度高的当场抢走 accent(教训 13;gradient/elevation/status
// 当初独立成段就是这个原因)。
// ⚠ 单数 `icon:` 也认(v0.11.49)。它不是「旧 schema」——25 份内置档里 17 份写着它,而那批档
// (2026-07-31 风格库 8→25)比 icons 这套读取器(2026-08-17,v0.11.31)早了 17 天,写档的人自己
// 发明了一段字段、三周后功能用了另一个拼法,**全仓库从来没有代码读过它** ⇒ 症状是「明明声明了
// 却报未启用」。回落放在读取层而不是改那 17 个文件:`design use` 是逐字节复制预设进项目的,
// 改资产救不了已经复制出去的档;而 withKeptSections 会把这类段原样带过控制台往返,不会自己烂掉。
// 它只声明四项(style / strokeWidth / linecap / corner)—— **恰好就是验收要用的那四项**,
// 一项不多一项不少 ⇒ 回落即得全部验收能力,不用替作者编任何东西。
// ⚠ **两份档合并**(v0.11.53):`iconSpec(风格档tokens, 项目图标档)`。
//   **图标档答「图形从哪来、叫什么名」**(system ⇒ library / fallbackLibrary / semantics 底座 + assets)
//   **风格档答「怎么画它」**(style / strokeWidth / linecap / linejoin / size / color)。
//   两者平级、各自可换 —— 换一套风格不该连图标一起换掉,这正是把 system 从风格档里搬出来的理由。
// ⚠ 风格档里历史遗留的 `library` / `fallbackLibrary` **仍然认**,但只在**项目没有图标档时**生效
//   (某项目两份档已经这么写了,当场作废等于把生产项目的图标来源掐掉)。两处都有时以图标档为准,
//   并由 `iconSourceConflict` 出声 —— 「两个消费者读不同来源」不出声,就会有一个长期正确掩护另一个
//   长期失效(教训 26)。
// ⚠ **两边都没有 ⇒ null**(整类不测,没依据就不报);任一边有就算启用 —— 项目选了图标系统而
//   风格档没写过图标,画法退回默认即可,不该报「未启用」。
// ⚠ 不写 `system`、也没有图标档的档,出来的 spec 与 v0.11.52 逐字节相同(只多一个 `system:null`);
//   基线取自**改动前的代码**跑出来的快照(教训 16:自己跟自己比只能证明「新代码内部自洽」)。
function iconSpec(tokens, project = null) {
  const pick = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
  const raw = pick(tokens && tokens.icons) || pick(tokens && tokens.icon) || (project ? {} : null)
  if (!raw) return null
  // 认不出的系统名 = 当没写(只报告不阻断,教训 6)。⚠ 不猜、不模糊匹配:猜错就成了
  // 「一份长得像正经报告的错报告」(教训 25),而这里猜错的后果是整套命名词汇都换了人家的。
  const sysName = _icStr(project && project.system, '').toLowerCase()
  const sys = iconSystemOf(sysName) || null
  // ⚠ 子段必须先判类型:front matter 写成 `size: { sm: 16px }`(行内对象)时解析器给的是**字符串**,
  // 而 Object.entries("…") 会把它拆成一串字符下标 —— 那会造出一堆假档位,还不报错。
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  const size = {}
  for (const [k, v] of Object.entries(obj(raw.size))) { const n = _icNum(v, null); if (n != null) size[k] = n }
  const semantics = {}
  for (const [k, v] of Object.entries(obj(raw.semantics))) { const s = _icStr(v, ''); if (s) semantics[k] = s }
  // 线性/实心三级优先:**风格档声明 > 图标档声明 > 默认**。风格档排前面是因为同一个项目
  // 可以有多份风格档(小程序一份、后台一份),各自的图标形态本来就该不一样;图标档只有一份,
  // 它给的是项目级默认 —— 控制台挑系统时顺手定的就是这一级。
  // ⚠ **判「有没有声明」必须看原始字符串,不能拿 `_icWord` 的返回值反推** —— 它对「没写」
  //   返回默认值 'outlined'、对「写了个认不出的词」原样透传,两种情况都不为空 ⇒ 反推的话
  //   「风格档没写」会被当成「风格档写了 outlined」,图标档那一级永远轮不到,这条改动等于没做。
  const styleDeclared = _icStr(raw.style, '') ? _icWord(raw.style, ICON_STYLE_WORDS, ICON_DEFAULTS.style) : null
  const style = styleDeclared || (project && project.style) || ICON_DEFAULTS.style
  // ⚠ 没声明库时按 style 定,**这不是偏好是事实**:lucide 里实心图标数为 0(ICON_LIBS.lucide
  // 只有一个线性目录),一份 style: filled 的档挂在 lucide 上不可能工作 —— 恒定默认 lucide 会
  // 让它静默拿到线性图标,而「声明实心却拿到线性」在页面上一眼可见。tabler 是唯一满足得了的库。
  // 这一条对手写 icons 段同样生效:`icons: { style: filled }` 不写 library 从 v0.11.31 起就中这个坑。
  // 图形从哪来:图标档选的系统说了算;没有图标档才退回风格档里那个历史遗留的 library,
  // 再没有才按 style 推(lucide 一个实心图标都没有,声明实心却挂 lucide 不可能工作)。
  const legacyLib = sys ? '' : _icStr(raw.library, '').toLowerCase()
  const library = sys ? sys.library : (legacyLib || (style === 'filled' ? 'tabler' : 'lucide'))
  // 兜底库:图标档说了算 → 没说用系统自带的 → 没有系统才看风格档里的历史遗留值。
  // ⚠ **必须有一个关得掉的开关**:系统会自带兜底,而兜底正是 F3 里稀释主视觉的那条路 ——
  //   只给默认不给关法,就成了「选了系统却按不住它去别家取图」。`none/off/no/false` 都收
  //   (归一只此一处);⚠ 连 `fallback:` 这个短拼法也认 —— 规划文里写的就是它,
  //   而「同一件事两个拼法、代码只读一个」正是 v0.11.49 那个坑的形状(单数 icon: 三周没人读)。
  // ⚠ `undefined`(没说)与 `null`(明确不要)必须分开:合并成一个就把「没说」当成「不要」,
  //   系统自带的兜底会被静默关掉 —— 而那是取不到图标时唯一的退路。
  const projFb = project ? project.fallbackLibrary : undefined
  const styleFbRaw = _icStr(raw.fallbackLibrary == null ? raw.fallback : raw.fallbackLibrary, '').toLowerCase()
  const styleFb = styleFbRaw ? (/^(none|off|no|false)$/.test(styleFbRaw) ? null : styleFbRaw) : undefined
  const fallbackLibrary = projFb !== undefined ? projFb
    : sys ? sys.fallbackLibrary
      : (styleFb !== undefined ? styleFb : null)
  // 库名统一小写:ICON_LIBS 是小写键,人写「Lucide」不该变成「没装这个库」
  return {
    // 项目选的系统(没选 = null)。**认不出的名字也落 null** —— 下游一律按「没选」办,
    // 绝不半信半疑地拿它去查表。
    system: sys ? sysName : null,
    // ⚠ 认不出的名字**必须留个痕**:光落 null 会让 CLI 静默退回 lucide,而 `design icons` 末行
    //   还把那个无效名字当成有效选择念出来(「本项目:pixelarticons」)—— agent 照着向群里转述,
    //   而每一张图都来自 Lucide。这正是要治的「做了 A 让人以为做了 B」。
    systemUnknown: (!sys && sysName) ? sysName : null,
    library,
    fallbackLibrary,
    // 这套库是描边型还是填充型。⚠ **验收要靠它分流** —— 填充型库的图形里根本没有 stroke,
    //   拿 strokeWidth/linecap/linejoin 去查它,查出来的每一条都是误报。
    form: (iconLibOf(library) || {}).form || 'stroke',
    style,
    // 字重:**「怎么画它」⇒ 归风格档**,与 strokeWidth 同类(描边型用 strokeWidth 调粗细,
    // 填充型只能换字重目录 —— 两者是同一件事在两种库上的不同表达)。只有声明了 weights 的库认它。
    weight: _icStr(raw.weight, 'regular').toLowerCase(),
    grid: _icNum(raw.grid, ICON_DEFAULTS.grid),
    strokeWidth: _icNum(raw.strokeWidth, ICON_DEFAULTS.strokeWidth),
    linecap: _icStr(raw.linecap, ICON_DEFAULTS.linecap),
    // corner 是 icon: 那批档的写法(直角/圆角),linejoin 是 SVG 的写法 —— 显式的 linejoin 优先
    linejoin: _icWord(raw.linejoin == null ? raw.corner : raw.linejoin, ICON_JOIN_WORDS, ICON_DEFAULTS.linejoin),
    color: raw.color == null ? null : String(raw.color),
    // 图标资产目录(体检的扫描范围)。⚠ **必须由作者声明,绝不自动发现** —— 真实项目里同一棵
    // 目录树混着插画(200×200)、徽章(天然多色)、构建产物副本(dist/),自动扫会把它们全报出来,
    // 而那样的报告一出来就是废的。⚠ front matter 解析器**不吃数组续行** ⇒ 多个目录用逗号分隔。
    // ⚠ **assets 的家是图标档**(它是项目事实,而全局风格库里的档没有「项目」上下文);
    //   风格档里的旧写法仍认,免得已经这么配着的项目当场失去扫描范围。
    assets: (project && project.assets && project.assets.length)
      ? project.assets
      : _icStr(raw.assets, '').split(',').map((s) => s.trim()).filter(Boolean),
    size: Object.keys(size).length ? size : { ...ICON_SIZE_DEFAULTS },
    // ⭐ 系统的词表在下、档里自己写的在上 —— **这一栏才是「选了系统」的真正内容**(F3):
    // 只换 library 不换词汇,agent 照旧用它熟的那套名字,68% 的图会从兜底库取回来,
    // 主库形同虚设。档里写的永远赢:项目自己的业务语义(rank / crest…)不该被通用表压掉。
    semantics: sys ? { ...sys.semantics, ...semantics } : semantics,
  }
}

// 图标来源在两处各写了一份 ⇒ 出声。⚠ 这类「两个消费者读不同来源」的局面,**不出声就会有一个
// 长期正确、掩护另一个长期失效**(教训 26 / 教训 3 同族):风格档里那行 `library: lucide` 看着
// 好好的,实际一个字都不起作用,而人还会照着它去排查「为什么图标不是 lucide 的」。
// 只报告不阻断,且**只说事实**:哪份档赢了、另一处那行现在不管用了。
function iconSourceConflict(spec, styleTokens, iconsDocRel, { projHasAssets = false } = {}) {
  if (!spec || !spec.system) return null
  const pick = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
  const raw = pick(styleTokens && styleTokens.icons) || pick(styleTokens && styleTokens.icon)
  if (!raw) return null
  // ⚠ `assets` 的优先级是「图标档有就用它,**没有就用风格档的**」⇒ 图标档没写时风格档那行**仍然生效**,
  //   把它列进「删掉」会让人照做后 `design icon-assets` 当场变成「不知道要扫哪儿」——
  //   而扫描范围必须声明、绝不自动发现 ⇒ 等于把资产体检整个关掉,且没有任何东西会报出来。
  const keys = ['library', 'fallbackLibrary', 'system']
  if (projHasAssets) keys.push('assets')
  const dead = keys.filter((k) => _icStr(raw[k], ''))
  if (!dead.length) return null
  return `风格档的 icons 段里还写着 ${dead.map((k) => '`' + k + '`').join(' / ')},但图标来源现在由 `
    + `${iconsDocRel || ICONS_DOC_REL} 决定(这次用的是「${(iconSystemOf(spec.system) || {}).label || spec.system}」)`
    + ` ⇒ 那几行已经不起作用,删掉免得日后照着它排查。`
    // ⚠ 必须点名 semantics **仍然有效** —— 某项目那两份档各有 20+ 条业务语义名(rank / fans / boost…)
    //   住在风格档里且优先级最高,笼统说一句「风格档只管怎么画」会把它们一起清掉。
    + `风格档里的 icons.semantics 不受影响(项目自己的业务叫法照旧生效、且优先于系统词表)`
}

// 指名了系统,却声明了这套系统给不了的 style ⇒ 那些图标**一张都不会来自你选的那套**,等于没选(F3)。
// ⚠ 只在「兜底真能供上」时出声:供不上是 `iconStyleGap` 那条更具体的路(「你会拿到线性」),
//   两条同时喊会把人绕晕 —— 这里不抢话(与 iconStyleGap 对「没装库」的处理同款)。
// 报**效果**不报成因,且只报告不阻断(教训 6):兜底取到的实心图标是能用的,拦下来毫无道理。
function iconSystemGap(spec, dirs) {
  if (!spec || !spec.system) return null
  const sys = iconSystemOf(spec.system)
  if (!sys || (sys.styles || []).includes(spec.style)) return null
  if (!dirs || !dirs.length) return null
  const want = spec.style === 'filled'
  // ⚠ 同上:按目录声明的 style 判,不按路径正则(phosphor 的实心目录叫 fill)
  const supplier = dirs.find((d) => (d.style === 'filled') === want && d.lib !== sys.library)
  if (!supplier) return null
  const other = Object.keys(ICON_SYSTEMS).find((k) => iconSystemOf(k).library === supplier.lib)
  // ⚠ 措辞按**真实结果**写,别写成「全部从兜底库取」:真机跑出来的是**两种结局混着** ——
  //   名字在兜底库里有同款(如 tabler 的 filled/)就取那张,没有就退回主库的线性。
  //   实测词表 62 条里 tabler 的实心只覆盖 48 条 ⇒ 剩下 14 条必然退回线性。
  //   把混合结果说成单一结局,人对着一条不成立就会把整份提示丢掉(教训:只说事实不下判断)。
  return `图标系统「${sys.label}」只有${(sys.styles || []).includes('filled') ? '实心' : '线性'}图标,`
    + `而风格档声明的是${want ? '实心' : '线性'} ⇒ 取到的图形不会是「${sys.label}」的:`
    + `名字在兜底库 ${(iconLibOf(supplier.lib) || {}).label || supplier.lib} 里有同款就取那张,没有就退回${want ? '线性' : '实心'}。`
    + `等于没选「${sys.label}」这套系统。`
    // ⚠ 换系统是**图标档**的事,不是风格档的 —— 本版起风格档里的 system 一个字都不起作用,
    //   照这句去改,下一条提示就会叫他把刚写的那行删掉。
    + (other ? `要${want ? '实心' : '线性'}:换成「${(iconSystemOf(other) || {}).label || other}」这套系统;` : '')
    + `要保住「${sys.label}」:把风格档的 icons.style 改回${want ? '线性' : '实心'}`
}

// 图标库那张列表要的样张(控制台用)。⚠ **只出控制台,不出群图** —— 群图光栅器的图元只有
// `_fillRoundRect`,画不了 path;而挑图标系统是 operator 的事,群里本来就不需要挑
// ⇒ 不违反「同一张图两端共用一份几何」那条约束(它约束的是两端都画的图)。
// ⭐ 样张里那 8 个名字是有依据的:实测这 8 个**同名图标两套库几何 8/8 全不同**,
//    换句话说这排图正是「换一套系统到底换了什么」的最短回答。
// ⚠ 库没装 ⇒ `installed:false` + 空样张,**不是空白** —— 空白会被读成「这套系统没内容」。
// ⚠ 给一**池**样张(不是定死几个):界面按卡片实际宽度自己截取几个,窄了少画、宽了多画。
//   摆满一行才看得出这套库的**气质** —— 一排稀稀拉拉的图看不出画风。
//   前 8 个是实测两库几何全不同的那批(F2),排在最前保证窄屏也先看到它们。
// ⚠ 这一池**逐个核过「三个目录里都有」**(lucide 线性 / tabler 线性 / tabler 实心):
//   线性排与实心排要能逐列对上,池里混进一个没有实心版的名字,实心排就会错位一格。
//   词表 62 条里有 14 条 tabler 没实心版(back/up/users/upload/share/refresh/…),**一个都不许进这池**。
const ICON_SAMPLE_SEMANTICS = ['search', 'heart', 'user', 'settings', 'calendar', 'home', 'more', 'delete',
  'add', 'edit', 'star', 'notification', 'lock', 'download', 'mail', 'file', 'folder', 'tag',
  'trophy', 'camera', 'send', 'location', 'cart', 'play']
function iconSystemPreview(name, { roots = null, size = 22, readFile = _readFileOrNull } = {}) {
  const key = String(name || '').toLowerCase()
  const sys = iconSystemOf(key)
  if (!sys) return null
  const r = roots || iconRoots({})
  // 样张只看**主库**:这排图要回答的是「这套系统长什么样」,掺进兜底库的图就答不准了
  const spec = { ...sys, style: 'outlined', weight: 'regular', library: sys.library, fallbackLibrary: null, grid: (iconLibOf(sys.library) || {}).grid || ICON_DEFAULTS.grid, strokeWidth: ICON_DEFAULTS.strokeWidth, linecap: ICON_DEFAULTS.linecap, linejoin: ICON_DEFAULTS.linejoin, size: { ...ICON_SIZE_DEFAULTS } }
  const all = iconDirs({ ...spec, style: 'filled' }, r) // 主库的全部目录(线性 + 实心 + 各字重)
  // ⚠ 分组判据取**目录自己声明的 style**,不是对路径做正则 —— phosphor 的实心目录叫 `assets/fill`,
  //   `/filled/` 匹配不上,那一排会整个空掉(这正是把 dirs 结构化的原因;同一判据别写两份)。
  // ⚠ 只取**当前字重**那一档:phosphor 有五个线性字重目录,不限定的话取不到的名字会静默落到
  //   另一个字重上,一排图里粗细不一。
  const wt = (d) => (d.weight || 'regular') === (spec.weight || 'regular')
  const line = all.filter((d) => d.style !== 'filled' && wt(d))
  // ⚠ **实心那排只许从 filled 目录取** —— 用普通查找顺序的话,没有实心版的名字会静默落回
  //   线性目录,于是「实心」那一排里混着线性图,等于拿线性冒充实心。实测 tabler 的实心只覆盖
  //   词表 62 条里的 48 条 ⇒ 这不是边角情况。取不到就少一个,让缺口自己显出来。
  const filled = all.filter((d) => d.style === 'filled' && wt(d))
  const take = (dirs, st) => {
    const out = []
    if (!dirs.length) return out
    for (const sem of ICON_SAMPLE_SEMANTICS) {
      const hit = readIcon(sem, spec, dirs, { readFile })
      if (hit) out.push({ sem, name: hit.name, svg: normalizeIconSvg(hit.svg, { ...spec, style: st }, { size }) })
    }
    return out
  }
  return {
    system: key,
    label: sys.label,
    library: sys.library,
    fallbackLibrary: sys.fallbackLibrary,
    styles: sys.styles,
    weights: sys.weights || null,
    form: (iconLibOf(sys.library) || {}).form || 'stroke',
    semantics: Object.keys(sys.semantics).length,
    // 图标总数**现数不写死**:包升级会变,写死的数字迟早变成一句假话(而没人会去核对它)。
    // 只在打开这一页时数一次,不上心跳。
    // ⚠ 只数**当前字重的线性档**:phosphor 六个字重目录加起来 9072,而那不是「有多少个图标可选」
    //   —— 同一个 gear 数了六遍。挑系统的人问的是词汇量,不是磁盘上有几个文件。
    count: _countSvg(line.map((d) => d.dir)),
    installed: !!r[sys.library],
    pkg: (iconLibOf(sys.library) || {}).pkg || '',
    icons: take(line, 'outlined'),
    filled: take(filled, 'filled'),
  }
}
function _countSvg(dirs) {
  let n = 0
  for (const d of dirs) { try { n += fs.readdirSync(d).filter((f) => f.endsWith('.svg')).length } catch { /* 读不到就不数 */ } }
  return n || null
}
function iconSystemPreviews(opts = {}) {
  const roots = opts.roots || iconRoots({})
  return Object.keys(ICON_SYSTEMS).map((k) => iconSystemPreview(k, { ...opts, roots })).filter(Boolean)
}
// 群里那张图标系统对照图的 HTML(交给常驻浏览器渲染成 PNG)。
// ⭐ 为什么必须是图:挑图标系统是「认不认得出、像不像样」的判断,**断言判不了、文字也说不清**
//    —— 「256 网格填充型」这句话对群里的人毫无意义,而四排图摆在一起,一眼就分得出(教训 31)。
//    这条与 `swatch` 是同一个做法:风格也是只能看不能念。
// ⚠ 群图光栅器画不了 path(图元只有圆角矩形)⇒ 这张只能走浏览器渲染,不能走那条老路。
// ⚠ **图里一个命令名都不许出现**:群成员看到的产品只有一个身份(用户面零工具名)。
//    编号是给人指的 ——「用第 3 个」比让人打出 `pixelart` 靠谱得多。
function iconSheetHtml(systems, { current = '' } = {}) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const zh = (st) => (st === 'filled' ? '实心' : '线性')
  const row = (label, icons, note) => `<div class="row"><span class="lab">${esc(label)}</span>`
    + (icons.length
      ? `<span class="ic">${icons.map((i) => `<span class="cell">${i.svg}<em>${esc(i.name)}</em></span>`).join('')}</span>`
      : `<span class="none">${esc(note)}</span>`)
    + '</div>'
  const card = (s, n) => {
    const on = current && s.system === current
    const form = s.form === 'fill' ? '填充型' : '描边型'
    return `<div class="card${on ? ' on' : ''}">
      <div class="hd"><span class="no">${n}</span><b>${esc(s.label)}</b>
        <span class="meta">${form} · ${s.styles.map(zh).join(' / ')}${s.weights ? ' · 字重 ' + s.weights.length + ' 档' : ''} · ${s.count || '?'} 个图标</span>
        ${on ? '<span class="cur">当前</span>' : ''}</div>
      ${s.installed
        ? row('线性', s.icons, '') + row('实心', s.styles.includes('filled') ? s.filled : [], '这套没有实心')
        : '<div class="row"><span class="none">这台机器上还没装这套图标</span></div>'}
    </div>`
  }
  return `<meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#fff;color:#1a1d21;font:13px/1.5 -apple-system,"PingFang SC","Helvetica Neue",sans-serif;padding:22px;width:720px}
    h1{font-size:15px;margin-bottom:4px}
    .sub{font-size:11.5px;color:#71757c;margin-bottom:16px}
    .card{border:1px solid #e6e8ec;border-radius:10px;padding:13px 15px;margin-bottom:11px}
    .card.on{border-color:#6D28D9;background:#faf7ff}
    .hd{display:flex;align-items:baseline;gap:8px;margin-bottom:9px;flex-wrap:wrap}
    .no{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;border-radius:5px;background:#1a1d21;color:#fff;font-size:11px;flex:none}
    .card.on .no{background:#6D28D9}
    b{font-size:13.5px}
    .meta{font-size:11px;color:#71757c}
    .cur{font-size:10.5px;color:#6D28D9;border:1px solid #d9c9f5;border-radius:20px;padding:1px 7px}
    .row{display:flex;align-items:center;gap:10px;margin-top:7px}
    .lab{flex:none;width:26px;font-size:10.5px;color:#9aa0a8}
    .ic{display:flex;gap:13px;flex-wrap:wrap}
    .cell{display:inline-flex;flex-direction:column;align-items:center;gap:2px}
    .cell svg{display:block}
    em{font-style:normal;font-size:8.5px;color:#a8adb4;white-space:nowrap}
    .none{font-size:11px;color:#a8adb4}
  </style>
  <h1>图标系统</h1>
  <div class="sub">与设计风格是两件事:风格管怎么画(颜色/字体/圆角),这里管图形从哪来、叫什么名 · 说「用第几个」即可</div>
  ${systems.map((s, i) => card(s, i + 1)).join('')}`
}

// 只要「有哪几套 · 装没装」的轻量口径。⚠ 与上面分开是因为**调用频次差两个量级**:
// 这份挂在 15s 心跳上(每个群卡的下拉都要它),而样张那份要逐个读 8 个 svg 文件 ——
// 16 次磁盘读 × 每 15 秒 × 长期开着的控制台,纯属白付。
function iconSystemList({ roots = null } = {}) {
  const r = roots || iconRoots({})
  return Object.entries(ICON_SYSTEMS).map(([k, s]) => ({ system: k, label: s.label, library: s.library, installed: !!r[s.library] }))
}

// 找图标包。**不随 sbot 分发**(四套合计约 160MB,而 sbot tarball 才 730KB)⇒ 机器上单独装,
// 与 rembg 同款。解析顺序:显式配置 → **sbot 自身全局目录的同级**(sbot 就装在那个 prefix 下,
// 是最稳的一条)。没装如实返回 null —— doctor 靠它如实报,且**不阻断**(教训 6)。
function iconRoots({ base, extra = null, execPath = process.execPath, exists = fs.existsSync } = {}) {
  const out = {}
  const parent = base ? path.dirname(base) : null
  // ⚠ 只认「sbot 包的同级」不够:从 git 检出目录跑时(开发机、或有人直接 node bin/sbot.js)
  // 同级是 ~/Projects,里面当然没有 —— 那会得到「装了却说没装」。补一条 node 自己的全局根:
  // <node 所在 bin>/../lib/node_modules,homebrew 与 nvm 都是这个布局。
  const npmRoot = execPath ? path.join(path.dirname(execPath), '..', 'lib', 'node_modules') : null
  // ⚠ 还不够:一台机器上可以同时装着两个 node 前缀(实测 —— 包装在 homebrew 前缀,
  // 而当时跑的是 nvm 的 node ⇒ 按 execPath 推出来的根里什么都没有)。所以再兜一层常见前缀。
  // 不 spawn `npm root -g`:那要多付一个进程,而这条路要在 doctor 与每次取图标时都走。
  const wellKnown = process.platform === 'win32'
    ? [process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : null]
    : ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules']
  for (const [lib, def] of Object.entries(ICON_LIBS)) {
    out[lib] = null
    const cands = []
    if (extra) cands.push(path.join(extra, def.pkg))
    if (parent) cands.push(path.join(parent, def.pkg))
    if (npmRoot) cands.push(path.join(npmRoot, def.pkg))
    for (const w of wellKnown) if (w) cands.push(path.join(w, def.pkg))
    for (const c of cands) { if (exists(c)) { out[lib] = c; break } }
  }
  return out
}

// 查找顺序 = 主库在前、兜底在后(库内多目录按 ICON_LIBS 声明序,如 tabler 的 outline → filled)
// 查找顺序:**先按声明的 style 分类,再按主库优先**。
// ⚠ 只按库排会让 `style: "filled"` 变成一句空话:实测两个库里**没有一个名字是 filled 独有的**
// (1054 个 filled 名字在 outline 里全都有)⇒ 线性目录永远先命中,声明实心却拿到线性,而这种
// 错在页面上一眼可见。style 是比"哪个库"更强的约束 —— 库之间参数同构、换库看不出来,
// 线性换实心却是另一个东西。
// ⚠ 排序判据从「路径里有没有 filled」改成**读目录自己声明的 style/weight**:phosphor 的实心目录
//   叫 `fill` 不叫 `filled`,正则当场就错。⚠ style 的权重高于 weight —— 线性换实心是另一个东西,
//   而字重只是同一套图形的粗细档(要不到 bold 就给 regular,还是那套图;要不到实心却给线性,一眼可见)。
function iconDirs(spec, roots) {
  const style = ((spec && spec.style) || ICON_DEFAULTS.style).toLowerCase()
  const weight = String((spec && spec.weight) || 'regular').toLowerCase()
  const all = []
  for (const lib of [spec && spec.library, spec && spec.fallbackLibrary].filter(Boolean)) {
    const def = iconLibOf(lib); const root = roots && roots[lib]
    if (!def || !root) continue
    for (const d of def.dirs) all.push({ lib, dir: path.join(root, d.dir), style: d.style || 'outlined', weight: d.weight || 'regular', suffix: d.suffix || '' })
  }
  const want = style === 'filled' ? 'filled' : 'outlined'
  const score = (d) => (d.style === want ? 0 : 2) + (d.weight === weight ? 0 : 1)
  // 同分保持原有次序(主库在前)—— sort 在 Node 里是稳定的
  return all.slice().sort((a, b) => score(a) - score(b))
}

// 声明了实心、可取的目录里却没有实心 ⇒ 取出来的**必然是线性**,而 stderr 那行摘要还会照着
// 声明写「实心」—— 两处一起骗人。报**效果**不报成因(库没装 / 库里本来就没实心,两条都落在这):
// 调用方看得见的就是「你会拿到线性」。⚠ 只报告不阻断(教训 6):线性图标是能用的,拦下来
// 等于因为一句提示把整件事堵死。dirs 为空是「没装」那条路,那边另有专门的提示,这里不抢话。
function iconStyleGap(spec, dirs) {
  if (!spec || spec.style !== 'filled' || !dirs || !dirs.length) return null
  // ⚠ 判据必须读**目录自己声明的 style**,不能对路径做正则 —— phosphor 的实心目录叫 `assets/fill`
  //   不叫 `filled`,正则匹配不上 ⇒ 明明拿到的是实心,这里却报「你会拿到线性」(真机实测)。
  //   同一判据本版在 iconDirs / iconSystemPreview 都改过了,**这两处漏了** —— 老形状:同一条判据
  //   散在多处,新写的改了、旧的没跟。
  if (dirs.some((d) => d.style === 'filled')) return null
  const libs = [spec.library, spec.fallbackLibrary].filter(Boolean)
  // ⚠ 修法要给**现在有效**的那条:风格档的 library 在有图标档时一个字都不起作用
  //   (iconSourceConflict 还会反过来叫人删掉那行),再教人去改它就是把人往沟里带。
  const solid = _solidSystemNames()
  return `声明的是实心图标,但取得到的目录里没有实心(${libs.join(' / ') || '未声明库'})⇒ 这次取到的是线性。`
    + `要实心:换一套供得起实心的图标系统(${solid.join(' / ') || '暂无'}),并确认该库已装`
}

// 语义名 → 图标名。语义表把「统一」从「事后检查」前移到「生成时就确定」——
// agent 要画「更多」时查表得到 more-horizontal,而不是自创一条 path(Apple HIG 的
// Standard icons 表就是这个做法的先例)。表里没有的名字原样透传。
// ⚠ 出来的名字要直接拼进文件路径 ⇒ **必须白名单**(教训 7:凡 agent 够得着的入口输入一律
// 不可信)。图标名本来就是 kebab-case,`../../x` 这种既不合法也不该被当成"找不到"放过去 ——
// 认不出的一律返回空,由调用方当"没这个图标"处理。
const ICON_NAME_RE = /^[a-z0-9][a-z0-9-]*$/
function resolveIconName(name, spec) {
  const n = String(name == null ? '' : name).trim()
  if (!n) return ''
  const mapped = String(((spec && spec.semantics) || {})[n] || n).trim().toLowerCase()
  return ICON_NAME_RE.test(mapped) ? mapped : ''
}

// ⚠ 文件名可能带**目录自己的后缀**(phosphor 的 bold 档是 `gear-bold.svg`)—— 这一段必须走
//   目录声明,不能拿图标名直接拼:少这一句,phosphor 除 regular 外的五档一个都取不到。
function readIcon(name, spec, dirs, { readFile = _readFileOrNull } = {}) {
  const file = resolveIconName(name, spec)
  if (!file) return null
  for (const d of dirs || []) {
    const svg = readFile(path.join(d.dir, file + (d.suffix || '') + '.svg'))
    // ⚠ 一并带回**取自哪个变体目录**:填充型库(pixelart / phosphor)里每张图的 `fill` 属性都是
    //   currentColor,拿它判「线性还是实心」必然全判成实心 —— 而 pixelart 压根没有实心变体。
    //   「取自哪个目录」才是这件事的判据;`fill` 只用来决定归一时套哪套属性。
    if (svg) return { lib: d.lib, name: file, svg, weight: d.weight || 'regular', style: d.style || null }
  }
  return null
}

// tabler 每个文件开头那条透明占位框:它是命中区不是图形,内联前必须剥 —— 不剥会在页面里
// 留一条谁也看不见、却出现在每个图标里的 path。
const ICON_BBOX_RE = /<path\s+stroke="none"\s+d="M0 0h24v24H0z"\s+fill="none"\s*\/>/gi

// 「这张图到底是实心还是线性」的**唯一判据**:源文件根 svg 的 fill(不是声明的 style ——
// 声明是意图,取到哪张图才算数)。⚠ 收成一处是因为它有**两个消费者**:归一改写要靠它决定
// 用哪套属性,取图标那行摘要要靠它如实说「你手里这张是什么」。两处各写一份 = 新写的必漏半句
// (教训 39)。⚠ 它区分得出的正是这一版让人很容易撞上的那种局面:声明实心 + 主库只有线性
// ⇒ 兜底库里有同名实心才拿得到实心,没有就悄悄退回线性,而摘要此前只照着**声明**写「实心」。
function iconSrcFill(svg) {
  const m = /<svg\b([^>]*)>/i.exec(String(svg || ''))
  return m ? ((/\bfill="([^"]*)"/i.exec(m[1]) || [])[1] || null) : null
}
function iconIsFilled(svg) { const f = iconSrcFill(svg); return !!f && f.toLowerCase() !== 'none' }

// 归一成一行可直接内联的 svg:**按风格档改写描边/端点/尺寸**,而不是原样吐文件 ——
// 原样吐等于把库的默认值当成了项目的规范,风格档写 1.5 也没人听。
// ⚠ viewBox 是坐标系,不跟着尺寸改;⚠ 无障碍默认就位(装饰 aria-hidden / 具名 aria-label +
// role),让取出来的图标**天生过得了那条检查**,而不是取完还要人再补一遍。
// ⚠ `source`(= `库/名字`)是**来源指纹**:落进产物里,以后 `design check` 才认得出这张图是从
//   哪套系统取的。⭐ 没有它,换了图标系统之后页面里的旧图标**没有任何东西会发现**(2026-08-25
//   真机:档里写 pixelart、页面里是 Tabler 的 path)—— 检查器只能发现不一致,而"能发现"这件事
//   本身要靠产出时留下的东西。给了才写,不给一个字节都不变(内置预览/样张不受影响)。
function normalizeIconSvg(svg, spec, { size = null, label = '', source = '' } = {}) {
  let s = String(svg || '').replace(/<!--[\s\S]*?-->/g, '').replace(ICON_BBOX_RE, '')
  const m = /<svg\b([^>]*)>([\s\S]*)<\/svg>/i.exec(s)
  if (!m) return ''
  const grid = (spec && spec.grid) || ICON_DEFAULTS.grid
  const vb = (/viewBox="([^"]*)"/i.exec(m[1]) || [])[1] || `0 0 ${grid} ${grid}`
  const px = size || (spec && spec.size && (spec.size.md || spec.size.lg || spec.size.sm)) || grid
  // ⚠ **实心图标不能按线性那套改写**:tabler 的 filled/ 那批是 `fill="currentColor"` 且压根
  // 没有 stroke 属性 —— 硬套 fill:none + stroke-width 会把实心图形变成它自己的轮廓线,画面
  // 直接坏掉。而 iconDirs 里就带着 filled/ 目录(主库没有的名字会去那儿找)⇒ 必踩。
  // 判据取**源文件的 fill**,不取 spec.style:实际取到哪张图才算数,声明的是意图。
  const srcFill = iconSrcFill(svg)
  const isFilled = !!srcFill && srcFill.toLowerCase() !== 'none'
  const attrs = [
    'xmlns="http://www.w3.org/2000/svg"', `width="${px}"`, `height="${px}"`, `viewBox="${vb}"`,
  ]
  if (source) attrs.push(`data-icon="${_icEsc(source)}"`)
  if (isFilled) attrs.push(`fill="${srcFill}"`)
  else attrs.push('fill="none"', 'stroke="currentColor"',
    `stroke-width="${spec ? spec.strokeWidth : ICON_DEFAULTS.strokeWidth}"`,
    `stroke-linecap="${spec ? spec.linecap : ICON_DEFAULTS.linecap}"`,
    `stroke-linejoin="${spec ? spec.linejoin : ICON_DEFAULTS.linejoin}"`)
  // 具名与隐藏是互斥的:两者同时出现等于自相矛盾(读屏既被告知名字又被要求跳过)
  if (label) attrs.push('role="img"', `aria-label="${_icEsc(label)}"`)
  else attrs.push('aria-hidden="true"')
  return `<svg ${attrs.join(' ')}>${m[2].replace(/\s*\n\s*/g, '').trim()}</svg>`
}

// sprite:页面用 <use href="#i-back"> 引用,同一个图标只落一份。
// ⚠ 版权声明必须在:Lucide 是 ISC,要求副本保留声明 —— 顺手删干净是许可问题不是洁癖。
// 从归一后的 <svg> 属性串里挑出**表现属性**搬到 <symbol> 上(width/height 不搬 —— 尺寸由使用处
// 的 CSS 定,sprite 的每个 use 尺寸可以不同;xmlns/class/aria-hidden 也不搬,它们属于外层那个 svg)。
const ICON_SPRITE_PAINT = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']
function _spritePaint(attrStr) {
  return ICON_SPRITE_PAINT
    .map((k) => { const m = new RegExp('\\s' + k + '="([^"]*)"', 'i').exec(attrStr || ''); return m ? ` ${k}="${m[1]}"` : '' })
    .join('')
}

function iconSpriteSvg(items, spec) {
  const libs = [...new Set((items || []).map((i) => i && i.lib).filter(Boolean))]
  const notice = libs.map((l) => `${(iconLibOf(l) || {}).label || l} — ${(iconLibOf(l) || {}).license || ''}`).join(' · ')
  const syms = (items || []).map((i) => {
    const one = normalizeIconSvg(i && i.svg, spec, { size: (spec && spec.grid) || ICON_DEFAULTS.grid })
    const m = /<svg\b([^>]*)>([\s\S]*)<\/svg>/i.exec(one)
    if (!m) return ''
    const vb = (/viewBox="([^"]*)"/i.exec(m[1]) || [])[1] || '0 0 24 24'
    // ⚠ 归一结果全在 m[1](属性)里,只取 m[2](内容)等于**算完又扔掉** —— 2026-08-24 真机:
    //   agent 用 `--sprite` 一次取 14 个图标,吐出来的 symbol 没有 fill/stroke/描边/端点,
    //   而清单承诺的是「取出来的已按风格档归一好」。它自己手写 CSS 补齐才没出事;换个不那么
    //   细心的,SVG 默认 fill 是**黑色**且无描边 ⇒ 线性图标渲染成一团黑块。
    // ⭐ 判据是「同一条命令加不加 --sprite,渲染结果必须一样」—— 单图标形态一直是对的,
    //   两条路各写一份就会漂,这正是本项目栽过多次的那个形状。
    // ⚠ 来源指纹要**写在 symbol 上**,不能指望 `_spritePaint` 捎过来(它只搬表现属性)。
    //   sprite 里 symbol 的 id 本来就带名字,但**名字认不出是哪套库的** —— 而「换了系统没重取」
    //   恰恰是库变了、名字没变的那种错。⚠ 注释形式的署名 agent 会顺手删掉(2026-08-25 真机:
    //   整个页面 `grep <!--` 为空),属性形式跟着图形走,删它就得动每一个 symbol。
    const prov = (i && i.lib && i.name) ? ` data-icon="${_icEsc(i.lib + '/' + i.name)}"` : ''
    return `<symbol id="i-${String((i && i.name) || '').replace(/[^a-z0-9-]/gi, '')}"${prov} viewBox="${vb}"${_spritePaint(m[1])}>${m[2]}</symbol>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true"><!-- icons: ${notice} -->${syms}</svg>`
}

// ── 布局体检(v0.11.52)────────────────────────────────────────────────────────
// `design check` 查的是**写法**(色板/圆角/字体/图标参数),`icon-assets` 查的是**图标文件**,
// 这一条查**页面渲染出来长什么样** —— 前两者全绿而页面是坏的,2026-08-24 真机上正好撞上:
// 交付前自查零不一致,而列表页有四处文字压在头像上。**「合规」和「好用」是两件事。**
//
// ⭐ **必须扫多档宽度**:同一个重叠,1280px 测出 0 处、1000px 测出 4 处、614px 测出 1 处 ——
//    只在一个宽度上测等于没测(与「只在一条路径上验功能」同一个教训)。
// ⚠ 只收**确定性事实**,一件都不需要视觉判断 —— 这是它敢自动报的前提:
//    文本重叠(纯几何) · 内容被永久裁切(overflow hidden 且 scrollWidth 超出) · 点击目标 < 24px(WCAG)。
// ⚠ **故意不测**三样,理由都是「那是判断不是事实」:①导航在窄屏消失(有没有替代入口测不了)
//    ②间距/留白(该留多少是设计判断)③**可横向滚动的容器**(滚动本身合法;真机上「筛选栏跟着
//    表格一起滚」确实是缺陷,但与「表格自己可滚」在 DOM 上长得一模一样,分不开就不报)。
// 中文小字的下限 = 风格档声明的**最小档位**。⚠ 不是正文档:真实基线上 body=14 而档里还声明了
// data=13,拿 14 当门槛会把 7 个合法的 13px 元素报成偏离 —— 作者声明过的档位就是合法的。
function styleMinFontSize(tokens) {
  let min = 0
  for (const v of Object.values((tokens && tokens.typography) || {})) {
    if (!v || typeof v !== 'object') continue
    // ⚠ **单位不能盲**:`0.875rem` 直接 parseFloat 会得到门槛 0.875px ⇒ 中文小字整条静默
    //   失效,而报告尾行还自信地写「按最小档位 0.875px」。16 份内置档全是 px,本机自测看不见。
    const raw = String(v.fontSize == null ? '' : v.fontSize).trim()
    const n = parseFloat(raw)
    if (!Number.isFinite(n) || n <= 0) continue
    const px = /rem$|em$/i.test(raw) ? n * 16 : /rpx$/i.test(raw) ? n / 2 : /pt$/i.test(raw) ? n * 4 / 3 : n
    if (!min || px < min) min = px
  }
  return min
}
const LAYOUT_MIN_TARGET = 24   // WCAG 2.2 目标尺寸下限
const LAYOUT_OVERLAP_MIN = 2   // 少于 2px 的相交按抗锯齿/边框噪音放过
// 在页面里跑的探针。⚠ 只挑**叶子文本元素**两两比:父子与容器天然嵌套,拿容器比会满屏误报。
// ⚠ 探针要**参数化**:中文最小字号的门槛来自风格档(body 档字号),不是写死的数 ——
//   「中文该多大」没有可引用的硬标准,自己发明一个必然误报;拿档自己的声明当尺子才自洽。
//   cjkMinSize = 0 ⇒ 这一类整条不测(档里没写 body 字号),报告要如实说。
const layoutProbe = ({ cjkMinSize = 0 } = {}) => `(() => {
  // ⚠ 关闭的 <details> 里的内容 display 不是 none、矩形也不为零(Chrome 用 content-visibility 藏),只看 display/矩形会把折叠块里的代码
  //   当成压在别的文字上(2026-09-05 官网 manifest 折叠块一次报出 20 条假重叠)⇒ 先问 checkVisibility(含 content-visibility 判据)。
  const vis = (el) => { if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, opacityProperty: true })) return false; const s = getComputedStyle(el); if (s.display==='none'||s.visibility==='hidden'||+s.opacity===0) return false; const r = el.getBoundingClientRect(); return r.width>0 && r.height>0 }
  const label = (el) => (el.tagName + (el.className && typeof el.className==='string' ? '.'+el.className.trim().split(/\\s+/)[0] : '')).slice(0,40)
  const text = (el) => (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,16)
  const leaves = [...document.querySelectorAll('body *')].filter((el) => vis(el) && el.children.length===0 && (el.textContent||'').trim().length>0)
  const overlaps = []
  // ⚠ 必须逐**行片段**比,不能拿 getBoundingClientRect():那是行内元素跨行时两段的**并集**。
  //   一个折行的 <code>cc-bot</code>(「cc-」在行尾、「bot」在下行行首)并集宽度 = 整段宽、
  //   高 = 两行高,于是它与这两行上的每一个词都「重叠」。2026-09-05 官网 privacy 页实测:
  //   两条重叠全是这么来的,而页面上一处压字都没有。误报会让整份报告被无视(同 ellipsis 那条教训)。
  const fragsOf = (el) => { const r=[...el.getClientRects()]; return r.length ? r : [el.getBoundingClientRect()] }
  const boxes = leaves.map(fragsOf)
  for (let i=0;i<leaves.length;i++) for (let j=i+1;j<leaves.length;j++) {
    const a=leaves[i], b=leaves[j]
    if (a.contains(b)||b.contains(a)) continue
    let best=null
    for (const ra of boxes[i]) for (const rb of boxes[j]) {
      const ox=Math.min(ra.right,rb.right)-Math.max(ra.left,rb.left)
      const oy=Math.min(ra.bottom,rb.bottom)-Math.max(ra.top,rb.top)
      // 取相交最大的那一对片段来报 —— 报告里的尺寸要指向真正压在一起的那处
      if (ox>${LAYOUT_OVERLAP_MIN} && oy>${LAYOUT_OVERLAP_MIN} && (!best || ox*oy>best.w*best.h)) best={ w:ox, h:oy }
    }
    if (best) overlaps.push({ a:text(a), b:text(b), ae:label(a), be:label(b), w:Math.round(best.w), h:Math.round(best.h) })
  }
  const clipped = [...document.querySelectorAll('body *')].filter(vis).filter((el) => {
    const cs = getComputedStyle(el)
    const ox = cs.overflowX
    if (ox!=='hidden' && ox!=='clip') return false
    // ⚠ 省略号截断是**故意的**,而 text-overflow:ellipsis 必须配 overflow:hidden ⇒ 不排掉它,
    //   每一处正常的单行省略都会被报成「内容永远看不到」。行数截断(line-clamp)同理。
    //   这是自测自己这个检查器时当场抓到的误报 —— 误报会让整份报告被无视。
    if (cs.textOverflow==='ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp!=='none')) return false
    return el.scrollWidth > el.clientWidth + 1
  }).map((el) => ({ el: label(el), by: el.scrollWidth - el.clientWidth }))
  const small = [...document.querySelectorAll('button,a,[role=button],input[type=checkbox],input[type=radio]')].filter(vis)
    .map((el) => ({ el: label(el), t: text(el) || el.getAttribute('aria-label') || '', w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }))
    .filter((x) => x.w < ${LAYOUT_MIN_TARGET} || x.h < ${LAYOUT_MIN_TARGET})
  // ── 可读性两条(v0.11.62)。**必须渲染后测**:静态 CSS 里的 .stat-label{font-size:12px}
  //    看不出它装的是「输入·缓存」还是「Input」,而底色要顺着继承往上找才知道。
  const CJK = /[\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff]/
  const CJK_MIN = ${Number(cjkMinSize) || 0}
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
  const rgbOf = (v) => { const m = /^rgba?\\(([^)]+)\\)/.exec(v || ''); if (!m) return null
    const p = m[1].split(',').map((x) => parseFloat(x)); const a = p.length > 3 ? p[3] : 1
    return a >= 0.99 ? [p[0], p[1], p[2]] : (a > 0 ? null : undefined) }  // null=半透明测不准 / undefined=全透明,继续往上找
  // 元素**实际**底色:顺祖先找第一个不透明背景。⚠ 背景图/渐变 ⇒ 测不准,放弃(不猜)
  const bgOf = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (s.backgroundImage && s.backgroundImage !== 'none') return null
      const c = rgbOf(s.backgroundColor)
      if (c === null) return null
      if (c) return c
    }
    return [255, 255, 255] // 一路到根都没有底色 ⇒ 画布默认白
  }
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4) }
    return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]) }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x,y)+0.05) / (Math.min(x,y)+0.05) }
  const cjkSmall = [], lowContrast = []
  let bgUnknown = 0 // 底色/文字色测不准而跳过的元素数 —— **必须带出去**,见 formatLayoutReport
  for (const el of leaves) {
    if (el.closest('[disabled],[aria-disabled="true"],[aria-hidden="true"]')) continue // WCAG 豁免失效控件
    // ⚠ 图表里的 <text>(坐标轴刻度)天生就小,与「正文字号偏小」不是一回事 —— 与当初「图表被
    //   当图标」同一族误报(真实产物基线上实测混进来 2 个)。
    if (el.closest('svg')) continue
    const s = getComputedStyle(el)
    const size = num(s.fontSize)
    const isCjk = CJK.test((el.textContent||'').trim())
    if (CJK_MIN > 0 && isCjk && size > 0 && size < CJK_MIN) cjkSmall.push({ el: label(el), t: text(el), size: Math.round(size*10)/10 })
    const bg = bgOf(el); if (!bg) { bgUnknown++; continue }
    const fg = rgbOf(s.color); if (!fg) { bgUnknown++; continue }
    // WCAG:大字(≥24px,或 ≥18.66px 且加粗)门槛 3:1,其余 4.5:1 —— 客观标准,不是自己发明的数
    const need = (size >= 24 || (size >= 18.66 && (parseInt(s.fontWeight,10)||400) >= 700)) ? 3 : 4.5
    const r = ratio(fg, bg)
    if (r < need) lowContrast.push({ el: label(el), t: text(el), ratio: Math.round(r*100)/100, need, size: Math.round(size*10)/10, cjk: isCjk })
  }
  const de = document.documentElement
  return { width: innerWidth, leaves: leaves.length, overlaps, clipped, small, cjkSmall, lowContrast, cjkMin: CJK_MIN, bgUnknown,
    pageOverflow: Math.max(0, de.scrollWidth - de.clientWidth) }
})()`
const LAYOUT_PROBE = layoutProbe() // 既有消费者/单测用的默认形态(可读性两条不测)

// 一次探针结果 → 归一 findings。key 用于跨宽度合并:同一处问题在多档宽度都出现应该只报一行。
function layoutFindings(raw) {
  if (!raw || typeof raw !== 'object') return []
  const w = Number(raw.width) || 0
  const out = []
  for (const o of raw.overlaps || []) {
    // ⚠ key 不含像素数:同一对元素在不同宽度重叠的像素当然不同,含进去就合并不掉、又变回逐宽度刷屏
    out.push({ kind: 'overlap', key: `overlap|${o.ae}«${o.a}»|${o.be}«${o.b}»`, width: w, a: o.a, b: o.b, ae: o.ae, be: o.be, px: `${o.w}×${o.h}` })
  }
  for (const c of raw.clipped || []) out.push({ kind: 'clipped', key: `clipped|${c.el}`, width: w, el: c.el, by: c.by })
  for (const s of raw.small || []) out.push({ kind: 'small', key: `small|${s.el}|${s.t}`, width: w, el: s.el, text: s.t, size: `${s.w}×${s.h}` })
  // ⚠ 这两类**按数值聚合成一条**,不逐元素报:真实产物基线实测「12px 中文」一次就有 40 个
  //   元素、跨 9 个 class —— 逐个报是四十行噪音,报告一变噪音就整份没人看(同 icon-a11y 的纪律)。
  //   同一字号 / 同一对比度 = 同一处病因,给条数 + 几个样本类名足够定位。
  const groupBy = (list, keyOf) => {
    const m = new Map()
    for (const x of list || []) {
      const k = keyOf(x)
      const g = m.get(k) || { n: 0, els: [] }
      g.n++; if (!g.els.includes(x.el) && g.els.length < 4) g.els.push(x.el)
      m.set(k, g)
    }
    return m
  }
  for (const [size, g] of groupBy(raw.cjkSmall, (x) => x.size)) {
    out.push({ kind: 'cjk-small', key: `cjk-small|${size}`, width: w, size: Number(size), count: g.n, els: g.els })
  }
  for (const [k, g] of groupBy(raw.lowContrast, (x) => x.ratio + '|' + x.need)) {
    const [ratio, need] = String(k).split('|').map(Number)
    out.push({ kind: 'contrast', key: `contrast|${k}`, width: w, ratio, need, count: g.n, els: g.els })
  }
  if (raw.pageOverflow > 1) out.push({ kind: 'page-overflow', key: 'page-overflow', width: w, by: raw.pageOverflow })
  return out
}

// 多档宽度的结果合并成一份。**同一处问题只出一行,把命中的宽度列出来** —— 逐宽度各报一遍
// 就是三倍噪音,而报告一旦变噪音就没人看了(同 checkIcons / icon-assets 的聚合纪律)。
function mergeLayoutRuns(runs) {
  const byKey = new Map()
  const widths = []
  for (const r of runs || []) {
    if (!r || !r.raw) continue
    widths.push(Number(r.raw.width) || 0)
    for (const f of layoutFindings(r.raw)) {
      const hit = byKey.get(f.key)
      if (hit) { hit.widths.push(f.width); if (!hit.px && f.px) hit.px = f.px }
      else byKey.set(f.key, { ...f, widths: [f.width] })
    }
  }
  const order = { overlap: 0, clipped: 1, 'page-overflow': 2, contrast: 3, 'cjk-small': 4, small: 5 }
  const findings = [...byKey.values()].sort((a, b) => (order[a.kind] - order[b.kind]) || (b.widths.length - a.widths.length))
  // cjkMin 一路带出来:0 = 那一类整条没测,报告必须如实说(「没测」与「没问题」不能长一样)
  const cjkMin = Number((runs || []).map((r) => r && r.raw && r.raw.cjkMin).find((x) => x != null)) || 0
  // ⚠ 对比度那一类同样要如实交代**没测到多少** —— 中文小字有 cjkMin 守卫,它此前一个都没有
  const bgUnknown = Math.max(0, ...(runs || []).map((r) => (r && r.raw && Number(r.raw.bgUnknown)) || 0))
  return { widths: [...new Set(widths)].sort((a, b) => b - a), findings, cjkMin, bgUnknown }
}

function formatLayoutReport(res, { rel = '', styleName = '' } = {}) {
  const L = []
  const ws = (res && res.widths) || []
  L.push('【布局体检】' + (rel ? rel + ' · ' : '') + '在 ' + (ws.length ? ws.join(' / ') + 'px' : '(未扫描)') + ' 下渲染检查'
    + (styleName ? ' · 风格档「' + styleName + '」' : ''))
  const fs = (res && res.findings) || []
  const cjkMin = (res && res.cjkMin) || 0
  // ⚠ 中文小字那一类的门槛来自风格档;档里没写正文字号 ⇒ 整条没测,必须说出来
  const cjkNote = cjkMin > 0
    ? '中文小字按风格档**声明过的最小档位** ' + cjkMin + 'px 为下限(声明过的字号都算合法)'
    : '⚠ **中文小字这一类没测** —— 风格档里没写正文字号,没有可依据的下限'
  // ⚠ **对比度测不准时不许说「无低对比文字」**(2026-09-02 审计逮到):`bgOf` 遇到渐变底 /
  //   半透明卡片 / 背景图会返回 null 并跳过,而零发现那行原先写死了这半句 ⇒ 凡玻璃拟态、
  //   渐变底的页面,「太浅」这一半**永远查不出,报告还主动断言没有** —— 正是本产品最贵的
  //   那条教训(`status:ok` 骗过了排查者本人)的同族。
  const bgSkip = (res && res.bgUnknown) || 0
  if (!fs.length) {
    L.push('· 未发现问题(无文字重叠 · 无内容被裁切 · 无过小点击目标'
      + (bgSkip ? '' : ' · 无低对比文字') + (cjkMin > 0 ? ' · 无中文小字' : '') + ')')
    // ⚠ 必须点破测了哪几档:「没发现」只在扫过的宽度上成立,不扫的宽度不等于没事
    L.push('⚠ 结论只覆盖上面这几档宽度 —— 同一个重叠在 1280px 可能一处都没有、到 1000px 就冒出四处(真机实测)')
    L.push((cjkNote.startsWith('⚠') ? '' : '⚠ ') + cjkNote)
    if (bgSkip) L.push('⚠ 有 ' + bgSkip + ' 处文字的**对比度没测** —— 它们的底色是渐变 / 半透明 / 背景图,量不准就不猜。这几处要靠眼睛看。')
    return L.join('\n')
  }
  const at = (f) => f.widths.join(' / ') + 'px'
  for (const f of fs) {
    if (f.kind === 'overlap') L.push(`· **文字重叠** 「${f.a}」压在「${f.b}」上 ${f.px}(${at(f)};${f.ae} × ${f.be})`)
    else if (f.kind === 'clipped') L.push(`· **内容被裁掉** ${f.el} 超出 ${f.by}px 且不可滚动(${at(f)})—— 那部分永远看不到`)
    else if (f.kind === 'page-overflow') L.push(`· **整页横向溢出** ${f.by}px(${at(f)})—— 手机上会左右晃`)
    else if (f.kind === 'small') L.push(`· 点击目标偏小 ${f.el}${f.text ? '「' + f.text + '」' : ''} ${f.size}(${at(f)};下限 ${LAYOUT_MIN_TARGET}px)`)
    else if (f.kind === 'cjk-small') L.push(`· **中文小字** ${f.size}px 共 ${f.count} 处(${at(f)};风格档最小的档位是 ${cjkMin}px)`
      + ` —— 例:${f.els.join(' / ')};汉字笔画密,同样字号下比拉丁难读得多`)
    else if (f.kind === 'contrast') L.push(`· **文字对比度不足** ${f.ratio}:1 共 ${f.count} 处(${at(f)};这一档需 ${f.need}:1)`
      + ` —— 例:${f.els.join(' / ')}`)
  }
  L.push('⚠ 以上是**渲染出来的几何事实**,不是审美意见 —— 但要不要改、怎么改由你和群里的人定。')
  L.push('⚠ **只覆盖扫过的宽度**,且故意不测导航在窄屏的取舍、间距留白、以及「容器能不能横向滚动」(那些是判断不是事实)。')
  if (bgSkip) L.push('⚠ 另有 ' + bgSkip + ' 处文字的**对比度没测** —— 底色是渐变 / 半透明 / 背景图,量不准就不猜。这几处要靠眼睛看。')
  L.push((cjkNote.startsWith('⚠') ? '' : '⚠ ') + cjkNote + ';图表内的文字(坐标轴刻度)一律不计 —— 它天生就小,与正文字号不是一回事。')
  return L.join('\n')
}

// 从产物里抽图标事实。⚠ **描边等属性必须连 CSS 一起扫** —— 真机那份 prototype-v2.html
// 把 stroke-width 写在 `.ui-icon` 规则里(`stroke-width: 1.8`),只扫 svg 标签属性会一条都
// 发现不了,而那恰恰是唯一一条真偏差。
// ⚠ 小程序的点击绑定必须认(bindtap/catchtap):某项目的页面全是 wxml,只认 onclick
// 等于把整个小程序端漏掉。emoji 字符集连箭头与几何符号一起收 —— → ✓ ★ 被当图标使的
// 频率不比 😀 低,而它们同样跟不了主题色、读屏念的也不是这个按钮的动作。
const CLICKY_TAG = /^(button|a)$/i
const CLICKY_ATTR = /\b(onclick|bindtap|catchtap|bind:tap|catch:tap|@click|@tap|v-on:click)\s*=/i
const CLICKY_ROLE = /\brole\s*=\s*["'](button|tab|link|menuitem|switch)["']/i
const VOID_TAGS = /^(img|br|hr|input|meta|link|source|area|base|col|embed|param|track|wbr|image|icon)$/i
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u
const EMOJI_ONLY_RE = /^[\s\u{FE0E}\u{FE0F}\u{200D}\u{1F000}-\u{1FAFF}\u{1F3FB}-\u{1F3FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]+$/u

// 「像图标的 svg」—— 图标类判据的唯一闸门(2026-09-02 真机)。由来:一份**零图标**的看板页
// 被连报四次「图标描边 1」「图标来源未核对」—— 页面里那两张 `<svg viewBox="0 0 560 200">` 是
// **图表**,而判据是「全文扫 stroke-width」+「数所有 svg」⇒ 图表被当成了图标。
// ⚠ 这道闸门在同一函数里本就有(线性/实心那段),只是没用在描边三项与 svg 计数上 ⇒ 提成一处。
// ⚠ 三条判据缺一不可:**方形 viewBox**(不用绝对尺寸 —— phosphor 是 256,尺寸闸门会排掉它)·
//   小 width · **含 `<use>`**(sprite 形态 `<svg class="icon"><use/></svg>` 没有 viewBox,
//   漏了它 = 用 sprite 的页面 iconSvgs 恒 0;这条是拿真实产物做对照组当场逮到的)。
const ICON_VB_SQUARE_MAX = 48 // 方格上限(描边型两套皆 24);填充型走 form 分流,不经描边三项
function _iconishSvg(attrs, body = '') {
  const a = String(attrs || '')
  const vb = ((/viewBox\s*=\s*"([^"]*)"/i.exec(a) || [])[1] || '').trim()
  const sq = /^0\s+0\s+(\d+(?:\.\d+)?)\s+\1$/.exec(vb)
  const w = _icNum((/\bwidth\s*=\s*"([0-9.]+)/i.exec(a) || [])[1], null)
  return !!((sq && parseFloat(sq[1]) <= ICON_VB_SQUARE_MAX) || (w != null && w <= ICON_RASTER_MAX)
    || /<use\b/i.test(String(body || '')))
}
// ⚠ svg 与 symbol **分两趟扫**:写成 `<(svg|symbol)…</\1>` 一趟时,sprite 的外层容器会把里面的
//   symbol 连同自己一起吃掉而外层又不像图标 ⇒ 整块跳过,「用 sprite 的页面这一维恒不检查」复活。
const _ICON_BLOCK_RE = { svg: /<svg\b([^>]*)>([\s\S]*?)<\/svg\s*>/gi, symbol: /<symbol\b([^>]*)>([\s\S]*?)<\/symbol\s*>/gi }
function _iconSvgBlocks(t) {
  const s = String(t || '')
  const out = []
  for (const re of [_ICON_BLOCK_RE.svg, _ICON_BLOCK_RE.symbol]) {
    re.lastIndex = 0 // 常量正则带 g ⇒ 复用前归零
    for (const m of s.matchAll(re)) if (_iconishSvg(m[1], m[2])) out.push(m[1] + ' ' + m[2])
  }
  return out
}

function usedIcons(text) {
  const t = String(text || '')
  const strokes = [], caps = [], joins = [], rasters = [], svgs = []
  // ⚠ 描边三项**分两条来路**:CSS 规则形式(`.ui-icon{stroke-width:1.8}`)全收 —— 真机唯一那条
  //   真偏差就写在 CSS 里;标签属性形式只从像图标的块里收 —— 图表的网格线正是这种写法。
  const iconBlocks = _iconSvgBlocks(t)
  const eat = (re, src, arr, norm) => { for (const m of src.matchAll(re)) { const v = norm(m[1]); if (v != null && !arr.includes(v)) arr.push(v) } }
  const asNum = (x) => _icNum(x, null)
  const asLow = (x) => String(x).toLowerCase()
  eat(/stroke-width\s*:\s*([0-9.]+)/gi, t, strokes, asNum)
  eat(/stroke-linecap\s*:\s*([a-z]+)/gi, t, caps, asLow)
  eat(/stroke-linejoin\s*:\s*([a-z]+)/gi, t, joins, asLow)
  for (const blk of iconBlocks) {
    eat(/stroke-width\s*=\s*"?\s*([0-9.]+)/gi, blk, strokes, asNum)
    eat(/stroke-linecap\s*=\s*"?\s*([a-z]+)/gi, blk, caps, asLow)
    eat(/stroke-linejoin\s*=\s*"?\s*([a-z]+)/gi, blk, joins, asLow)
  }
  for (const m of t.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    const src = (/src="([^"]+)"/i.exec(tag) || [])[1] || ''
    if (!/\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i.test(src)) continue
    const w = _icNum((/\bwidth="([0-9.]+)/i.exec(tag) || [])[1], null) ?? _icNum((/width\s*:\s*([0-9.]+)px/i.exec(tag) || [])[1], null)
    if (w == null || w > ICON_RASTER_MAX) continue   // 尺寸未知或够大 ⇒ 当插画,不看
    rasters.push(src)
  }
  for (const m of t.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi)) {
    svgs.push({ named: /aria-hidden\s*=/i.test(m[1]) || /aria-label\s*=/i.test(m[1]) || /<title[\s>]/i.test(m[2]) })
  }
  // emoji 当操作图标:**按位置判,不按字符判**。设计参照原型实测 89/162 文件、1131 处 emoji ——
  // 按字符判等于一次吐一千多条,报告当场变噪音(与「间距/阴影不测」同一条理由)。
  // 判据收成:**可交互元素里,某段文本只由 emoji 构成** ⇒ 它在承担图标职责。
  // 「按钮文案里点缀一个 emoji」(开始答题 🎉)不算 —— 那是标签的一部分。
  // ⚠ 必须走**标签栈**,不能用「配对元素正则」:`<元素>(.*?)</同名>` 会把外层整段吞掉,
  // 于是嵌在别的元素里的可点按钮**全部漏掉**(真机验证时才发现 —— 现实页面里按钮几乎总是
  // 嵌套的)。栈遍历是线性时间,顺带把「文本在不在某个可点祖先里」判准。
  const emojiIcons = []
  {
    const stack = []
    let clicky = 0
    for (const tok of t.matchAll(/<\/?[a-z][\w-]*\b[^>]*>|[^<]+/gi)) {
      const s = tok[0]
      if (s[0] !== '<') {                       // 文本节点
        const v = s.trim()
        if (clicky > 0 && v && EMOJI_RE.test(v) && EMOJI_ONLY_RE.test(v)) emojiIcons.push(v)
        continue
      }
      if (s[1] === '/') {                        // 闭合
        const name = s.slice(2).replace(/[^a-z0-9-]/gi, '').toLowerCase()
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === name) { for (let k = stack.length - 1; k >= i; k--) { if (stack[k].clicky) clicky--; stack.pop() } break }
        }
        continue
      }
      if (/\/>$/.test(s)) continue               // 自闭合:不入栈
      const name = (/^<([a-z][\w-]*)/i.exec(s) || [])[1].toLowerCase()
      if (VOID_TAGS.test(name)) continue          // img/br/input… 无闭合标签
      const isClicky = CLICKY_TAG.test(name) || CLICKY_ATTR.test(s) || CLICKY_ROLE.test(s)
      stack.push({ name, clicky: isClicky })
      if (isClicky) clicky++
    }
  }
  // 线性/实心混用:只看**像图标的** svg —— viewBox 是 0 0 G G 的小方格,或宽 ≤ 闸门。
  // 200×200 的插画带 fill 是正常的,拿它把整页判成「混用」就是误报。
  // ⚠ **`<symbol` 必须一起扫**:sprite 是推荐做法,而 sprite 页面里根本没有一个带 viewBox 的
  //   小 `<svg>` —— 外层那个是 `display:none` 的容器(没 viewBox、进不了闸门),图形全在 symbol 上。
  //   只扫 svg 等于**用了 sprite 的页面这一维恒不检查**,而 2026-08-25 那份真机产物正是 sprite
  //   (33 个 use / 18 个 symbol)⇒ 它的线性实心混用检查一直在空转。
  const fill = { outline: 0, filled: 0 }
  for (const m of t.matchAll(/<(?:svg|symbol)\b([^>]*)>/gi)) {
    const a = m[1]
    if (!_iconishSvg(a)) continue // 判据与描边三项、svg 计数**同一处**(见 _iconishSvg 段头)
    const f = (/\bfill="([^"]*)"/i.exec(a) || [])[1]
    if (f == null) continue
    if (f.trim().toLowerCase() === 'none') fill.outline++; else fill.filled++
  }
  // ⚠ `svgs`(所有 svg,无障碍名那条要用:图表同样该有名字)与 `iconSvgs`(只数像图标的,供
  //   「有没有东西可查」的闸门用)是两个数,别混用 —— 拿前者当闸门正是那条噪音的根因。
  return { strokes, caps, joins, rasters, svgs, iconSvgs: iconBlocks.length, emojiIcons, fill }
}

// 图标类检查。spec 为 null(风格档没写 icons)⇒ 整类不测。
// ⚠ 每类**按文件聚合成一条**,不逐处点名:真机那份产物有 18 个图标缺无障碍名,逐个报
// 就是 18 行噪音,而报告一旦变噪音就没人看了。
function checkIcons(sources, spec) {
  if (!spec) return []
  const out = []
  // ⚠ **描边三项要按库的形态分流**(2026-08-25):填充型库(phosphor / pixelart)的图形里
  //   根本没有 stroke —— 轮廓已经转成填充路径,`strokeWidth` / `linecap` / `linejoin` 对它
  //   完全无效。不分流的话,用这类系统的项目每份产物都会收到一串「描边 X ≠ 声明的 Y」,
  //   而那**每一条都是误报**;报告一旦变噪音就整份被无视(与间距/阴影故意不测同一条理由)。
  //   ⚠ 同理:线性/实心混用那条也不测 —— 填充型库里两者都是 fill,判据本身不成立。
  const strokeForm = (spec.form || 'stroke') === 'stroke'
  for (const src of sources || []) {
    const rel = (src && src.rel) || ''
    const u = usedIcons((src && src.text) || '')
    // ⚠ **页面里没有「像图标的 svg」⇒ 描边三项整条不查**(2026-09-02 审计逮到只治了一半):
    //   v0.11.62 把标签属性形式收进了闸门,但 CSS **冒号**形式仍对全文全收 ⇒ 图表把描边写在
    //   内嵌 `<style>`、页面 CSS 类、或 `style="stroke-width:1"` 里时,误报照旧。
    //   描边是**图标的**属性。⚠ 但**不能一刀切成「有图标才查」**:那条真机教训的现场是
    //   「描边写在 `.ui-icon{}` 里、页面里根本没有 svg」,一刀切会把它一起关掉(单测当场逮到)。
    //   判据 = **有 svg 但没有一个像图标**(= 图表页)才跳过;一个 svg 都没有时照查。
    if (strokeForm && (u.iconSvgs > 0 || u.svgs.length === 0)) {
      for (const v of u.strokes) if (Math.abs(v - spec.strokeWidth) > 0.001) out.push({ kind: 'icon-stroke', rel, value: v, expected: spec.strokeWidth })
      for (const v of u.caps) if (v !== spec.linecap) out.push({ kind: 'icon-cap', rel, value: v, expected: spec.linecap })
      for (const v of u.joins) if (v !== spec.linejoin) out.push({ kind: 'icon-join', rel, value: v, expected: spec.linejoin })
    }
    if (u.rasters.length) out.push({ kind: 'icon-raster', rel, count: u.rasters.length, sample: u.rasters.slice(0, 3) })
    const naked = u.svgs.filter((s) => !s.named).length
    if (naked) out.push({ kind: 'icon-a11y', rel, count: naked })
    if (u.emojiIcons.length) out.push({ kind: 'icon-emoji', rel, count: u.emojiIcons.length, sample: [...new Set(u.emojiIcons)].slice(0, 5) })
    // 线性/实心混用:HIG「level of detail 一致」里唯一测得准的那一半(仅描边型库成立,见上)
    if (strokeForm && u.fill.outline && u.fill.filled) out.push({ kind: 'icon-fillmix', rel, outline: u.fill.outline, filled: u.fill.filled, declared: spec.style })
  }
  return out
}

// ── 图标来源核对(第四条判据)────────────────────────────────────────────────────
// 前面几条查的是「画得对不对」(描边 / 端点 / 无障碍名 / 位图),这一条查**这张图到底是不是
// 从当前这套图标系统来的**。
// ⭐ 由来是 2026-08-25 真机:图标档写着 `system: pixelart`,而页面里的 `home` 与 **Tabler** 的
//    path 逐字一致 —— 先按 Tabler 取过一份 sprite,后来换了系统没重取。清单里那句「换系统后
//    已取过的图标不会自动跟着变」**只是一句提醒、没有任何检查** ⇒ 换完没有任何东西会发现,
//    而图标系统存在的全部理由(单一来源)当场作废。
// ⚠ 同一处真机还暴露了更糟的一层,也在这条里治掉:选了**填充型**系统时 `checkIcons` 会按
//    `form` 跳过描边三项,而那恰恰是唯一能看出「页面里混着描边型图标」的判据 ⇒
//    **选了填充型系统,反而查不出图标来源错**。④ 就是补回来的那一刀。
// ⭐ 四条判据**全是确定性事实,一条都不猜**(误报会让整份报告被无视,同间距/阴影不测):
//    ① 来源标记写着别家的库(取图标时留下的 `data-icon`,**不需要装库**就判得了)
//    ② 名字在当前系统里有,但**图形与库里那张不一致**
//    ③ 名字在当前系统里没有,而图形与**另一套库**的同名图标**逐字相同** ⇒ 它就是从那儿来的
//    ④ 当前系统是填充型,页面里却有描边型图标(填充型库的图形里根本没有 stroke)
// ⚠ **剩下的一律不报**:名字两边都查不到 = 很可能是项目自有图形(徽章 / logo / 品牌图),
//    报它就是误报。⚠ ③ 只按名字判会误报 —— 当前系统的库没装时,「别家有这个名字」什么都
//    证明不了,所以 ③ **必须拿几何说话**。
const ICON_SRC_ATTR_RE = /\bdata-icon="([a-z0-9]+)\/([a-z0-9-]+)"/i

// 页面里**认得出来源**的图标。两条来路都是我们自己产出的形状:sprite 的 `<symbol id="i-名字">`
// 与单图标形态的 `data-icon` 来源标记。
// ⚠ 名字取自页面文本 = 不可信输入,而它下一步要**直接拼进文件路径** ⇒ 必须过白名单(教训 7)。
function pageIconRefs(text) {
  const t = String(text || '')
  const out = []
  const seen = new Set()
  // ⚠ `via` 记的是**从哪种形状认出来的**:许可署名那条只对 sprite 成立(我们出的 sprite 一定
  //   带着那行注释,单图标形态从来没有过 —— 拿它去要求署名就是凭空指控)。
  // ⚠⚠ `alt` = **去掉短前缀后的名字**。真机打脸:我们出的 sprite 用 `id="i-house"`,而交付的
  //    产物里是 `id="p-house"` —— **agent 自己换了前缀**(整份文件 17 个 symbol 全是 `p-`),
  //    只认自家格式的话一个都认不出来,而输出会是「没有认得出来源的图标」,与「查过没问题」
  //    一样让人放心。⇒ 前缀不可信,名字才是。
  // ⚠ 但**猜出来的名字只能当弱证据**:`x-circle` 这类名字本身就以短段开头,剥掉会变成另一个
  //    真实存在的图标(circle)⇒ 拿它比"图形不一致"必然误报。所以先按原名查,原名在任何库里
  //    都查不到时才退到 alt,且 alt 只认「几何逐字相同」这种**正证据**(见 attributeIcons)。
  // ⚠ `i-` 是**我们自己出的 sprite 的前缀** ⇒ 剥掉它得到的名字是可信的;别家前缀(`p-`…)
  //   剥出来的只能当猜的。两者必须分开,否则自家产物也降级成"猜",② 那条对它就永远不生效。
  const push = (raw, lib, inner, via) => {
    const s = String(raw || '')
    const n = /^i-/.test(s) ? s.slice(2) : s
    if (!ICON_NAME_RE.test(n)) return
    const key = n + '|' + (lib || '')
    if (seen.has(key)) return       // 同一张图在一个文件里用几十次,只该算一个
    seen.add(key)
    const alt = (/^[a-z]{1,4}-(.+)$/.exec(n) || [])[1] || ''
    out.push({ name: n, alt: alt && ICON_NAME_RE.test(alt) ? alt : '', lib: lib || null, geom: iconGeomKey(inner), via })
  }
  for (const m of t.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/gi)) {
    const src = ICON_SRC_ATTR_RE.exec(m[1])
    // ⚠ **整个 id 都要收,不能只认 `id="i-…"`** —— 真机产物里 17 个 symbol 全是 `id="p-house"`
    //   这种自己起的前缀,只认自家格式的话一个都认不出,而输出会是「没有认得出来源的图标」,
    //   看着与「查过没问题」一模一样(教训 2 的又一种形态)。
    push((/\bid="([^"]+)"/i.exec(m[1]) || [])[1] || (src ? src[2] : ''), src ? src[1].toLowerCase() : null, m[2], 'symbol')
  }
  for (const m of t.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi)) {
    const src = ICON_SRC_ATTR_RE.exec(m[1])
    if (src) push(src[2], src[1].toLowerCase(), m[2], 'svg')
  }
  return out
}

// 比几何时把空白全去掉。归一那步的 `m[2].replace(/\s*\n\s*/g, '')` 会把 `d=` 里跨行的空白也
// 吃掉,而库文件里那处**是有换行的** ⇒ 严格比会把「同一张图」判成不同,变成一串假警报。
// ⚠ 去掉空白后理论上会撞车(`M 10 20` 与 `M 102 0`),但那只会让某一条**漏报** —— 方向是安全的
//    (判据宁漏不误:报错了人会连整份报告一起丢掉,漏一条只是回到今天的状态)。
const _geomLoose = (k) => String(k || '').replace(/\s+/g, '')

// 全部**已装**图标库的按名查找。⚠ 不只查当前系统那两个库 —— ③ 要回答的是「它是从哪儿来的」,
// 而那必然在别家库里。返回的函数带 `libs`(装了哪几套),调用方靠它区分「查过没发现」与
// 「当前系统的库根本没装,只查得动一半」。
// ⚠ **一个库都没装就回 null,不回一个恒空的函数** —— 「查了没发现」和「根本没查」在输出上
//    必须分得开,这是本项目栽过最多次的那个形状(教训 2 / 教训 40)。
function iconLookup(roots, { readFile = _readFileOrNull } = {}) {
  const dirs = []
  for (const [lib, def] of Object.entries(ICON_LIBS)) {
    const root = roots && roots[lib]
    if (!root) continue
    for (const d of def.dirs) dirs.push({ lib, dir: path.join(root, d.dir), suffix: d.suffix || '' })
  }
  if (!dirs.length) return null
  const fn = (name) => {
    const file = String(name || '')
    if (!ICON_NAME_RE.test(file)) return []
    const out = []
    for (const d of dirs) {
      const svg = readFile(path.join(d.dir, file + d.suffix + '.svg'))
      if (svg) out.push({ lib: d.lib, svg })
    }
    return out
  }
  fn.libs = [...new Set(dirs.map((d) => d.lib))]
  return fn
}

// 归属:每个认得出的图标「是从哪儿来的、合不合当前这套系统」**只判这一处**。
// ⚠ 收成一处不是洁癖 —— 来源核对与署名核对要的是同一件事实(这张图属于哪个库),两处各写
//    一份就是本项目栽过多次的那个形状(教训 39:新写的那份必漏半句)。
// `lookup` 为 null(库没装)时只剩 ① 成立 —— 少查不等于查过,调用方要如实说。
function attributeIcons(sources, spec, lookup) {
  const own = spec ? [spec.library, spec.fallbackLibrary].filter(Boolean) : []
  const libs = new Set()      // 页面里**确凿**用到的库(署名该署谁,由它说了算)
  const sprite = new Set()    // 其中哪几个是以 sprite 形态出现的(署名只对它成立,见 pageIconRefs)
  const bad = []              // 不是从当前系统来的
  // ⚠ refs 数的是**真判出了结论的**那些,不是「认得出名字的」—— 名字认得出但哪个库里都查不到时
  //    这一维其实什么都没查,而那时报「未发现不一致」就又变成了「没查 = 没问题」。
  let refs = 0
  for (const src of sources || []) {
    const rel = (src && src.rel) || ''
    for (const ref of pageIconRefs(String((src && src.text) || ''))) {
      // ① 标记写着别家的库。⚠ 兜底库算自己人:取不到时走兜底是**设计好的正路**,不是错。
      if (ref.lib) {
        refs++
        libs.add(ref.lib)
        if (ref.via === 'symbol') sprite.add(ref.lib)
        if (!own.includes(ref.lib)) bad.push({ rel, name: ref.name, why: '标着取自 ' + ((iconLibOf(ref.lib) || {}).label || ref.lib) })
        continue
      }
      if (!lookup || !ref.geom) continue
      // ⚠ 库文件要**先过一遍同一个归一器**再比:页面里那份就是这么产出来的,不走同一条路
      //    就是拿两种写法互比(教训 16:基准必须来自被测代码之外 —— 这里两边同源才成立)。
      const same = (h) => _geomLoose(iconGeomKey(normalizeIconSvg(h.svg, spec))) === _geomLoose(ref.geom)
      let hits = lookup(ref.name)
      // 原名哪儿都没有 ⇒ 退到剥掉前缀的候选名(`p-house` → `house`),但它是**猜的**
      let guessed = false
      if (!hits.length && ref.alt) { hits = lookup(ref.alt); guessed = hits.length > 0 }
      // 判定顺序 = 证据由强到弱:
      //  a. 与当前系统的那张**逐字相同** ⇒ 就是它,干净
      //  b. 与**别家**那张逐字相同 ⇒ 硬证据,它就是从那儿来的(⚠ 这条与名字是不是猜的无关 ——
      //     几何相同这件事本身就把名字对上了;放在 mine 分支之后判,否则「当前库里也有这个名字」
      //     会把证据挡掉,真机上 17 个只报得出 4 个)
      //  c. 名字在当前系统里有、但几何对不上 ⇒ 只有**可信的名字**才敢下这个结论(猜出来的名字
      //     可能压根不是那个图标:项目自有的 `p-house` 剥成 `house` 恰好撞上库里真有的那张)
      const mine = hits.filter((h) => own.includes(h.lib))
      const mineHit = mine.find(same)
      if (mineHit) { refs++; libs.add(mineHit.lib); if (ref.via === 'symbol') sprite.add(mineHit.lib); continue }
      const from = hits.find((h) => !own.includes(h.lib) && same(h))
      if (from) {
        refs++; libs.add(from.lib); if (ref.via === 'symbol') sprite.add(from.lib)
        bad.push({ rel, name: ref.name, why: '与 ' + ((iconLibOf(from.lib) || {}).label || from.lib) + ' 的同名图标逐字相同' })
        continue
      }
      if (mine.length && !guessed) { refs++; bad.push({ rel, name: ref.name, why: '图形与库里的同名图标不一致' }) }
    }
  }
  return { refs, libs: [...libs], sprite: [...sprite], bad }
}

// 判据见段头。⚠ **没选系统 ⇒ 四条全不测**(含 ④):没有「当前这套」就没有依据,而 ④ 的说法
// 本身就是「你选的这套是填充型」——没系统时它连话都说不成(没依据就不报,同「风格档没写
// rounded 就不查圆角」)。
function checkIconSource(sources, spec, lookup, attrib = null) {
  if (!spec || !spec.system) return []
  const sysLabel = (iconSystemOf(spec.system) || {}).label || spec.system
  const at = attrib || attributeIcons(sources, spec, lookup)
  const out = []
  for (const src of sources || []) {
    const rel = (src && src.rel) || ''
    const bad = at.bad.filter((b) => b.rel === rel)
    if (bad.length) out.push({ kind: 'icon-source', rel, count: bad.length, sample: bad.slice(0, 3), system: spec.system, systemLabel: sysLabel })
    // ④ 填充型系统的库里根本没有描边 ⇒ 页面里的描边型图标必然来自别处。**不需要装库**,
    //    也正是 checkIcons 因 form 分流而放弃的那一维(见段头的 ⚠)。
    const stroked = spec.form === 'fill' ? usedIcons(String((src && src.text) || '')).fill.outline : 0
    if (stroked) out.push({ kind: 'icon-form', rel, count: stroked, system: spec.system, systemLabel: sysLabel })
  }
  return out
}

// 许可署名。⭐ 2026-08-25 真机:我们出的 sprite 一定带 `<!-- icons: Tabler — MIT -->`,而交付
// 的页面里**一条注释都没有**(实测 `grep <!--` 为空)—— agent 整理时把注释统统删了。
// Lucide 是 ISC、其余三套 MIT,**都要求副本保留声明**,所以这不是洁癖是许可问题。
// ⚠ **只对 sprite 成立**:那行注释是我们随 sprite 一起出的,「本来有、现在没了」才判得了;
//    单图标形态从来就没有过署名(提醒走 stderr)⇒ 拿它要求署名就成了凭空指控。
// ⚠ **整轮只出一行**:逐文件报同一句话是噪音,而署名有一处就够(常见做法正是放在 sprite 里)。
// ⚠ 判据要宽:只要这批文件里任何一处同时出现库名与许可名,就算保住了 —— 人可能写成
//    「Icons by Tabler (MIT)」。宁可漏报也不误报:它一响就是在说人家违反许可,措辞得站得住
//    (v0.11.49 那条教训:把事实说成缺陷,人发现一条不成立就会连整份报告一起丢掉)。
function iconLicenseGap(sources, libs) {
  const use = (libs || []).map((l) => iconLibOf(l)).filter(Boolean)
  if (!use.length) return null
  const all = (sources || []).map((s) => String((s && s.text) || '')).join('\n')
  const missing = use.filter((def) => !new RegExp(def.label + '[\\s\\S]{0,60}' + def.license, 'i').test(all))
  if (!missing.length) return null
  return { kind: 'icon-license', libs: missing.map((d) => d.label + ' — ' + d.license) }
}

// ── 图标资产体检(v0.11.49)──────────────────────────────────────────────────────
// `design check` 查的是**页面写法**;这里查的是**图标文件本身**。分成两条命令而不是合并,
// 是因为节奏不同:页面检查每次交付前跑,资产体检整理时才跑 —— 混进交付报告里,这几十行会把
// 真正要看的东西淹掉(报告一旦变噪音就没人看了,同 checkIcons 的聚合纪律)。
//
// ⭐ 根因是一条链:**写死颜色 → 换色只能另存一份 → 副本爆炸 → 没有单一来源 → 改一个要找齐
//    所有副本 → 实际没人改 → 漂移固化**。某项目实测(119 个 svg):只有 1 个用 currentColor、
//    出现 41 种色值、30 组图形完全相同共 77 个文件(47 个纯冗余),而 `icons/colored/*` 与
//    `icons/*` **逐字同几何、只有写死的颜色不同** —— 链在文件清单里就是实物。
// ⚠ 几何反而是整齐的(它们本来同源,lucide 导出)⇒ **打散一致性的是导出之后的加工**,
//    所以要查的是加工痕迹(颜色写死、副本、参数漂),不是图形质量。
// 三件事都是**确定性事实**,一件都不需要视觉判断 —— 这是它敢自动报的前提。

// 几何指纹:只留 d= 与基本形状的几何属性,**一切表现属性(stroke/fill/宽高/class…)全部丢掉**
// ⇒ 「同一个图形的不同配色副本」必然撞成同一个键,而那正是要找的东西。
// ⚠ 先剥 tabler 的透明占位框:它是命中区不是图形,不剥的话同一个图标的 lucide 版与 tabler 版
//   会被判成两个(而它们确实是同一个图)。
const _ASSET_SHAPE_RE = /<(circle|rect|line|polyline|polygon|ellipse)\b([^>]*)>/g
const _ASSET_GEOM_ATTR_RE = /\b(cx|cy|r|x|y|width|height|x1|y1|x2|y2|points|rx|ry)="([^"]+)"/g
function iconGeomKey(svgText) {
  const t = String(svgText == null ? '' : svgText).replace(ICON_BBOX_RE, '')
  const ds = [...t.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1].replace(/\s+/g, ' ').trim())
  const shapes = [...t.matchAll(_ASSET_SHAPE_RE)].map((m) => m[1] + ':'
    + [...m[2].matchAll(_ASSET_GEOM_ATTR_RE)].map((a) => a[1] + '=' + a[2].replace(/\s+/g, ' ').trim()).sort().join(','))
  const key = JSON.stringify([ds, shapes])
  return key === '[[],[]]' ? '' : key // 没有任何图形 ⇒ 不参与分组(空文件不该互相"重复")
}

const _ASSET_PAINT_RE = /\b(stroke|fill)="([^"]+)"/g
// 一个 svg 资产的可测事实。⚠ 只认**显式写在文件里**的值:没写 stroke-width 的实心图标不该被
// 报成「描边偏离」——它本来就没有描边(同 normalizeIconSvg 取源文件 fill 而非声明 style 那条)。
function readIconAsset(rel, text) {
  const t = String(text == null ? '' : text)
  const paints = [...t.matchAll(_ASSET_PAINT_RE)].map((m) => m[2].trim()).filter((v) => v && v !== 'none')
  const num = (re) => { const m = re.exec(t); return m ? parseFloat(m[1]) : null }
  const str = (re) => { const m = re.exec(t); return m ? m[1].trim() : null }
  const vb = str(/viewBox="([^"]+)"/)
  const box = vb ? vb.trim().split(/[\s,]+/).map(Number) : null
  return {
    rel,
    geom: iconGeomKey(t),
    paints: [...new Set(paints)],
    currentColor: paints.some((p) => /^currentColor$/i.test(p)),
    hardcoded: [...new Set(paints.filter((p) => !/^currentColor$/i.test(p)))],
    strokeWidth: num(/stroke-width="([^"]+)"/),
    linecap: str(/stroke-linecap="([^"]+)"/),
    linejoin: str(/stroke-linejoin="([^"]+)"/),
    // 网格 = viewBox 的宽高(不是 width/height 属性 —— 后者是渲染尺寸,本来就该各页各定)
    grid: box && box.length === 4 && box.every((n) => Number.isFinite(n)) ? [box[2], box[3]] : null,
  }
}

// files = [{ rel, text }](调用方读盘,这里不碰 fs)。spec 为 null ⇒ 没依据,整件事不做。
function auditIconAssets(files, spec) {
  if (!spec) return null
  // ⚠ 连 `<svg` 都没有的文件**不算进总数**:它不是图标,查不出问题也不代表它没问题。
  //   混着算的话「扫描 2 个 svg · 未发现问题」里有一个是垃圾文件 —— 那句话就成了假的
  //   (「没查出问题」和「根本查不了」看起来一模一样,项目硬规则)。单列出来如实说。
  const all = (files || []).map((f) => ({ rel: (f && f.rel) || '', text: (f && f.text) || '' }))
  const notSvg = all.filter((f) => !/<svg[\s>]/i.test(f.text)).map((f) => f.rel)
  const assets = all.filter((f) => /<svg[\s>]/i.test(f.text)).map((f) => readIconAsset(f.rel, f.text))
  const hardcoded = assets.filter((a) => !a.currentColor && a.hardcoded.length)
  const colorCount = {}
  for (const a of assets) for (const c of a.hardcoded) colorCount[c] = (colorCount[c] || 0) + 1
  // 重复副本:按几何分组,组内 >1 即副本。⚠ 只出清单**不自动改** —— 删图标文件不可逆,
  // 且「哪个名字该留」是语义判断(chevron-right 与 chevron-right-gold 留哪个,机器说不了算)。
  const byGeom = new Map()
  for (const a of assets) { if (!a.geom) continue; const g = byGeom.get(a.geom) || []; g.push(a.rel); byGeom.set(a.geom, g) }
  const dups = [...byGeom.values()].filter((g) => g.length > 1).map((g) => g.slice().sort())
  dups.sort((a, b) => (b.length - a.length) || (a[0] < b[0] ? -1 : 1))
  const off = (pick, want, eq) => {
    const hit = assets.filter((a) => pick(a) != null && !eq(pick(a), want))
    const vals = [...new Set(hit.map((a) => String(pick(a))))]
    return hit.length ? { count: hit.length, values: vals, sample: hit.slice(0, 3).map((a) => a.rel) } : null
  }
  return {
    total: assets.length,
    notSvg,
    currentColor: assets.filter((a) => a.currentColor).length,
    hardcoded: { count: hardcoded.length, colors: Object.entries(colorCount).sort((a, b) => b[1] - a[1]) },
    dups: { groups: dups, files: dups.reduce((n, g) => n + g.length, 0), redundant: dups.reduce((n, g) => n + g.length - 1, 0) },
    stroke: off((a) => a.strokeWidth, spec.strokeWidth, (v, w) => Math.abs(v - w) < 0.001),
    linecap: off((a) => a.linecap, spec.linecap, (v, w) => v === w),
    linejoin: off((a) => a.linejoin, spec.linejoin, (v, w) => v === w),
    grid: off((a) => (a.grid ? a.grid.join('×') : null), spec.grid + '×' + spec.grid, (v, w) => v === w),
  }
}

// 报告。⚠ **截断必须出声**(no silent caps):列不下的组要说还有多少,否则「只列了 8 组」
// 会被读成「只有 8 组」。
const ICON_AUDIT_MAX_GROUPS = 8
function formatIconAuditReport(res, { styleName = '', roots = [] } = {}) {
  if (!res) return '【图标资产体检】风格档未启用图标体系(front matter 缺 icons 段)⇒ 没有可对照的声明,这一项做不了'
  const L = []
  const issues = []
  L.push('【图标资产体检】对照风格档' + (styleName ? '「' + styleName + '」' : '') + ' · 扫描 ' + res.total + ' 个 svg'
    + (roots.length ? '(' + [...new Set(roots)].join(' · ') + ')' : ''))
  // ⚠ 单列而不是混进总数:这几个文件**没查**,不是「查过没问题」。
  if (res.notSvg && res.notSvg.length) {
    L.push('· ⚠ ' + res.notSvg.length + ' 个文件里没有 `<svg>`,**没查**(不是查过没问题):' + res.notSvg.slice(0, 3).join(' / ')
      + (res.notSvg.length > 3 ? ` …还有 ${res.notSvg.length - 3} 个` : ''))
  }
  if (res.hardcoded.count) {
    issues.push('hardcoded')
    const top = res.hardcoded.colors.slice(0, 5).map(([c, n]) => c + '×' + n).join(' · ')
    L.push('· **写死颜色 ' + res.hardcoded.count + '/' + res.total + '**(用 currentColor 的只有 ' + res.currentColor + ' 个)'
      + ' —— 共 ' + res.hardcoded.colors.length + ' 种色值:' + top + (res.hardcoded.colors.length > 5 ? ' …' : ''))
    L.push('  ⭐ 这是副本爆炸的**第一环**:颜色写死 ⇒ 想换个色只能另存一份 ⇒ 没有单一来源 ⇒ 改一个要找齐所有副本 ⇒ 实际没人改')
  }
  if (res.dups.groups.length) {
    issues.push('dups')
    // ⚠ 措辞只说**事实**:「几何相同」是量出来的,「冗余」是判断 —— 真机上就有反例:小程序
    //   tabbar 的 `iconPath`/`selectedIconPath` 只能是图片文件、改不了色,同图两色是**平台强制**
    //   的,不是谁偷懒。把事实说成缺陷,人只要发现一条不成立就会连整份报告一起丢掉。
    L.push('· **图形完全相同 ' + res.dups.groups.length + ' 组、共 ' + res.dups.files + ' 个文件**(合并到各留一份可省 ' + res.dups.redundant + ' 个):')
    for (const g of res.dups.groups.slice(0, ICON_AUDIT_MAX_GROUPS)) L.push('  · ' + g.join(' = '))
    if (res.dups.groups.length > ICON_AUDIT_MAX_GROUPS) L.push('  · …还有 ' + (res.dups.groups.length - ICON_AUDIT_MAX_GROUPS) + ' 组未列出(全部要看加 --json)')
    L.push('  ⚠ 同一组里多半是**同图不同色**(颜色写死才要多存一份)—— 但有的是平台逼的(小程序 tabbar 的选中/未选中只能是两个图片文件,改不了色),**哪些该合由人定**')
  }
  for (const [k, label] of [['stroke', '描边'], ['linecap', '端点'], ['linejoin', '连接'], ['grid', '网格']]) {
    const d = res[k]; if (!d) continue
    issues.push(k)
    L.push('· ' + label + '偏离声明:' + d.values.join(' / ') + '(' + d.count + ' 个文件,例:' + d.sample.join(' / ') + ')')
  }
  if (res.grid) L.push('  ⚠ 网格不一致的多半**不是图标**(插画、logo、徽章都会混在同一棵目录树里)—— 若确实如此,要动的是目录划分或风格档里声明的范围,不是这些文件')
  if (!issues.length) return L.concat('· 未发现问题(颜色可继承 · 无重复副本 · 参数与声明一致)').join('\n')
  L.push('⚠ **只出清单,不自动改** —— 删图标文件不可逆,而「哪个名字该留」是语义判断;把这份清单连同你的判断一起说给群里,由人来定。')
  return L.join('\n')
}

// 主检查。sources = [{ rel, text }](调用方读文件,这里不碰 fs)。
// tolerance 默认 12:挡住「同一个色的不同写法/轻微舍入」,又不至于把邻近但确实不同的色放过。
// ⚠ `project` = 项目的图标档(design/icons.md)。**必须一路传到底** —— 少了它,`iconSpec` 造出来的
//   spec 就没有 `form`(恒当描边型)也没有系统词表 ⇒ 用填充型系统的项目每份产物都会收到一串
//   假的「描边不合规」。⭐ 这处是真机端到端跑出来的:单测里手工造的 spec 带着 form、绿得很好看,
//   而真实路径**造不出那个 spec** —— 「两个消费者读不同来源」的又一次(教训 26)。
// ⚠ `roots` = 机器上的图标库位置(`iconRoots()` 的产物)。**这一项也在调用方那条路上** ——
//   不传 = 图标来源那条判据整条不跑,而报告照样一片绿。与 `project` 是同一个形状:单测里手工
//   造得出的东西,真实路径未必接得上(这一族已经栽过一次,见 project 那条 ⚠)。
// ── 已知例外 ────────────────────────────────────────────────────────────────
// 由来(2026-09-02 真机):同样三条「不一致」被原样贴进群里**四次**,三条都可接受,agent 每次
// 都得另写一段解释。⇒ 缺的是**记住已经判过的**;报告一旦变噪音就整份被无视。
// ⚠ 例外**必须带理由**(否则退化成万能消音器)· **接受 ≠ 消失**(报告仍出一行说明 ——
//   「判过、可接受」与「压根没查」要能分开)。
const ACCEPTED_DOC_REL = path.join('design', 'check-accepted.md')

// finding 的稳定身份。⚠ **不含文件名**:同一处偏离在多个文件里出现,接受一次该管住全部
// (同 mergeLayoutRuns 的 key 不含像素数)。按文件聚合的那几类没有逐值身份 ⇒ 整类一个 key。
function findingKey(f) {
  if (!f || !f.kind) return ''
  const k = String(f.kind)
  if (['color', 'radius', 'font', 'icon-stroke', 'icon-cap', 'icon-join'].includes(k)) {
    return k + '|' + String(f.value == null ? '' : f.value).trim().toLowerCase()
  }
  // 「这个族由别处注入」是按族接受的 —— 接受了 Canela 不等于接受了 Söhne
  if (k === 'font-unloaded') return k + '|' + _fontKey(f.family)
  return k
}

// `accepted:` 段下每行 `<key>: <理由>`。⚠ 不复用 parseStyleTokens —— 它的键名正则是
// `[A-Za-z0-9_-]+`,而这里的键形如 `color|#B42318`,整行命不中。
function parseAcceptedDoc(text) {
  const out = {}
  const fm = _frontMatter(text)
  if (!fm) return out
  let inSeg = false
  for (const raw of fm) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    if (/^accepted\s*:\s*$/.test(raw)) { inSeg = true; continue }
    if (!/^\s/.test(raw)) { inSeg = false; continue } // 回到顶层键 ⇒ 出段
    if (!inSeg) continue
    const m = /^\s+(?:"([^"]+)"|'([^']+)'|([^:]+?))\s*:\s*(.*)$/.exec(raw)
    if (!m) continue
    const key = (m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] || '').trim()
    const why = _unquote((m[4] || '').trim())
    if (!key || !why) continue // ⚠ 没写理由的不认(防消音器)
    out[key.toLowerCase()] = why
  }
  return out
}

// 例外档写错了要**报出来**。⚠ 审计实测:写成最自然的纯 markdown 列表 ⇒ 静默失效,输出与
//   「根本没有这个文件」逐字相同;YAML 列表写法 `- key: 理由` 会把键读成 `- key` 永远匹配不上。
//   而这套机制的立论正是「机制没人知道就等于没做」—— 它自己更不能没人知道怎么写。
const ACCEPTED_FORMAT_HINT = 'front matter 里写 `accepted:` 段,每行 `<判据身份>: <为什么可接受>`(判据身份形如 `color|#B42318`)'
function acceptedDocWarnings(text) {
  const t = String(text == null ? '' : text)
  if (!t.trim()) return []
  const out = []
  const fm = _frontMatter(t)
  if (!fm) return ['**没有 front matter**,整份没生效 —— ' + ACCEPTED_FORMAT_HINT]
  if (!fm.some((l) => /^accepted\s*:\s*$/.test(l))) return ['**没有 `accepted:` 段**,整份没生效 —— ' + ACCEPTED_FORMAT_HINT]
  let inSeg = false
  for (const raw of fm) {
    if (/^accepted\s*:\s*$/.test(raw)) { inSeg = true; continue }
    if (!/^\s/.test(raw)) { inSeg = false; continue }
    if (!inSeg || !raw.trim() || /^\s*#/.test(raw)) continue
    const m = /^\s+(?:"([^"]+)"|'([^']+)'|([^:]+?))\s*:\s*(.*)$/.exec(raw)
    if (!m) { out.push('这一行读不出来,已跳过:`' + raw.trim().slice(0, 60) + '`'); continue }
    const key = (m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] || '').trim()
    if (/^-\s/.test(key)) out.push('`' + key + '` 是 YAML 列表写法,键会带上 `- ` 而永远匹配不上 —— 去掉行首的 `- `')
    else if (!_unquote((m[4] || '').trim())) out.push('`' + key + '` **没写为什么**,这一条不生效(防止它变成万能消音器)')
  }
  return out
}

function findAcceptedDoc({ cwd, readFile = _readFileOrNull } = {}) {
  const root = path.resolve(cwd || process.cwd())
  let text = null
  try { text = readFile(path.join(root, ACCEPTED_DOC_REL)) } catch { return null }
  if (text == null) return null
  const map = parseAcceptedDoc(text)
  return Object.keys(map).length ? map : null
}

// ⚠ `accepted` 同 `project`/`roots`:判断在调用方那条路上,单测只测得到纯函数(这一族栽过)
//   ⇒ 另有一条断言钉住 bin 真的传了它。
function checkDesign(sources, tokens, { tolerance = 12, project = null, roots = null, accepted = null, readFile = _readFileOrNull } = {}) {
  const colors = styleAllowedColors(tokens)
  const radii = styleAllowedRadii(tokens)
  const families = styleAllowedFamilies(tokens)
  const cjkFams = styleCjkFamilies(tokens)
  const findings = []
  // 字体来源**跨文件**收一次:css 里的 @font-face 要管住 html 里用的族(分开查会把「css 里声明了」
  // 读成「html 里没来源」)。⚠ 只收这批传进来的文件 —— 没传的那份 css 里若有声明,这里看不见,
  //   报告措辞因此是「这批文件里找不到」,并给例外档出口。
  const fontSrc = families.length ? declaredFontSources((sources || []).map((s) => (s && s.text) || '')) : null
  for (const src of sources || []) {
    const text = String((src && src.text) || '')
    const rel = (src && src.rel) || ''
    if (colors.length) {
      const seen = []
      for (const hex of colorLiterals(text)) {
        if (seen.includes(hex)) continue
        seen.push(hex)
        let best = null, bd = Infinity
        for (const c of colors) { const d = _colorDist(hex, c); if (d < bd) { bd = d; best = c } }
        if (bd > tolerance) findings.push({ kind: 'color', rel, value: hex, nearest: best, dist: Math.round(bd) })
      }
    }
    if (radii.length > 1) { // 只有 [0] = 风格档没写 rounded ⇒ 不测(没依据就不报)
      for (const px of usedRadii(text)) {
        if (!radii.some((r) => Math.abs(r - px) <= 1)) findings.push({ kind: 'radius', rel, value: px + 'px', allowed: radii.filter((r) => r > 0).map((r) => r + 'px') })
      }
    }
    if (families.length) {
      for (const f of usedFontFamilies(text)) {
        if (!families.includes(f)) findings.push({ kind: 'font', rel, value: f, allowed: families })
      }
    }
    // 中文兜底:**只在这份产物里真的出现了汉字、且风格档确实声明过中文族时才查** ——
    // 纯拉丁交付、或档本身不管中文的项目,一个字都不该多说(没依据就不报)。
    if (cjkFams.length && CJK_TEXT_RE.test(text)) {
      const naked = usedFontStacks(text).filter((s) => !CJK_FAMILY_RE.test(s))
      // ⚠ 聚合成一条 + 给出口:静态看不出哪条栈装的是汉字(等宽栈里只放英文代号完全合法)。
      if (naked.length) findings.push({ kind: 'font-cjk', rel, count: naked.length, sample: naked.slice(0, 2), declared: cjkFams })
    }
    // 字体可得性(由来见 fontAvailability 段头):**档里声明、产物照用了、却找不到加载来源**的首选族。
    // ⚠ 范围故意收窄到「档里声明的」—— 不在档里的族已由上面 'font' 那条报过,再报一次是双份噪音;
    //   而档说用它、产物照用了、它却加载不到,才是「字体身份是幻觉」这件事的现场。
    if (fontSrc) {
      const byFam = new Map()
      const mobile = _docIsMobile(tokens)
      for (const stack of usedFontStacks(text)) {
        const k = _fontKey(_firstWantedFamily(stack))
        if (!k || !families.includes(k)) continue
        const v = fontSourceVerdict(stack, { loaded: fontSrc.loaded })   // 裁决只有这一份(与 doctor ⑤ 同源)
        if (!v) continue
        let e = byFam.get(k)
        if (!e) { e = { kind: 'font-unloaded', rel, stacks: 0, unknownLinks: fontSrc.unknownLinks, mobile, ...v }; byFam.set(k, e) }
        e.stacks++
      }
      findings.push(...byFam.values())
    }
  }
  // 图标类(契约见 docs/ICONS.md)。iconsEnabled 如实标出这一类到底有没有依据可查 ——
  // 「零告警」与「压根没检查」输出一模一样,不点破就会被当成「图标没问题」。
  const ispec = iconSpec(tokens, project)
  findings.push(...checkIcons(sources, ispec))
  // 第四条:图标来源(判据与由来见 checkIconSource 段头)。
  // ⚠ 这一条比前几条更需要如实交代「查没查」:它的沉默有三种截然不同的成因(没选系统 /
  //   库没装 / 页面里压根没有认得出来源的图标),而三种在报告上长得一模一样。
  const lookup = (ispec && ispec.system && roots) ? iconLookup(roots, { readFile }) : null
  // ⚠ 兜底对象的**形状必须与真实返回值一模一样**(少一个 sprite 键,将来有人读它就是 undefined
  //   —— 「mock 与真实返回值漂移」是这一族栽过的坑)
  const attrib = ispec ? attributeIcons(sources, ispec, lookup) : { refs: 0, libs: [], sprite: [], bad: [] }
  findings.push(...checkIconSource(sources, ispec, lookup, attrib))
  // 许可署名:用了谁的图标就得留谁的声明(真机上那行注释被顺手删干净了)
  const lic = ispec ? iconLicenseGap(sources, attrib.sprite) : null
  if (lic) findings.push(lic)
  const own = ispec ? [ispec.library, ispec.fallbackLibrary].filter(Boolean) : []
  // 命中例外的挪进 `accepted`(标题条数跟着降)。⚠ 挪走不等于消失,报告仍会出一行。
  const accMap = accepted && typeof accepted === 'object' ? accepted : null
  const kept = [], waived = []
  for (const f of findings) {
    const why = accMap ? accMap[findingKey(f)] : null
    if (why) waived.push({ ...f, why }); else kept.push(f)
  }
  // ⚠ 命中过的键记下来 ⇒ 没命中的就是过期条目,报告要点名
  const usedKeys = new Set(waived.map((f) => findingKey(f)))
  const acceptedStale = accMap ? Object.keys(accMap).filter((k) => !usedKeys.has(k)) : []
  return {
    findings: kept,
    accepted: waived,
    acceptedStale,
    checked: (sources || []).map((s) => s.rel),
    iconsEnabled: !!ispec,
    iconSource: {
      system: (ispec && ispec.system) || null,
      refs: attrib.refs,
      // 这批文件里到底有没有「图标那种东西」。⚠ 没有的话,「图标来源未核对」就是一句常驻噪音:
      //   纯 CSS 交付、不用图标的项目每次都会多出这一行,而报告一旦变噪音就没人看了。
      // ⚠ **必须数「像图标的」而不是所有 svg**(2026-09-02 真机):这道闸门原先数的是全部
      //   `<svg|symbol`,于是**画图表的页面**(一个图标都没有)照样顶开它,连报四次这行噪音 ——
      //   防线写对了、判据用错了。判据见 `_iconishSvg`。
      svgs: (sources || []).reduce((n, s) => n + usedIcons(String((s && s.text) || '')).iconSvgs, 0),
      // 当前系统的库装没装 —— 没装时只有 ①④ 两条判据还成立,那是「查了一半」不是「没问题」
      libInstalled: !!(lookup && own.some((l) => lookup.libs.includes(l))),
    },
    allowed: { colors, radii: radii.filter((r) => r > 0), families },
  }
}

// 风格档的一行 tokens 摘要 —— 注入自知清单用(治「风格档未被强制加载」)。
// ⚠ 这是把「指路牌」换成「东西本身」:清单原先只说「项目有风格档,先读它」,agent 完全
// 可能没去读;而**教训 6 已写死「配置类策略对半可信 agent 本质不可强制」** —— 与其假装
// 能强制它读文件,不如把色板/字体/圆角直接摆进上下文,取消「没加载」这个可能性。
// 长度是硬约束(清单每轮都付):只列最常被写错的三样,色板超过 8 个截断并标数量。
// ⚠ `project` 同 checkDesign:**这一行是注入给 agent 的**,说错了它每轮都照着错的干。
//   不传图标档时它会对着用 phosphor 的项目说「图标 lucide+tabler」—— 而 agent 只信清单。
function tokenDigest(tokens, { maxColors = 8, project = null } = {}) {
  const parts = []
  const colors = Object.entries((tokens && tokens.colors) || {}).filter(([, v]) => _normHex(v))
  if (colors.length) {
    const head = colors.slice(0, maxColors).map(([k, v]) => k + ' ' + _normHex(v)).join(' · ')
    parts.push('色板 ' + head + (colors.length > maxColors ? ` …共 ${colors.length} 个` : ''))
  }
  const fams = styleAllowedFamilies(tokens)
  // ⚠ 中文族必须一起给:清单是 agent 每轮唯一看得到的字体口径,不给等于「这项目没有中文字体」
  const cjkFams = styleCjkFamilies(tokens)
  // ⚠ 不是系统自带的族要标「需自带文件」(v0.11.68):否则 agent 照档写 Canela,页面上出来的还是苹方,
  //   而它以为自己交付了 Canela —— 清单是它唯一看得到的字体口径,这一句只能写在这里。
  const need = (f) => { const a = fontAvailability(f); return a.generic || (a.mac && a.win) ? '' : '(需自带文件)' }
  if (fams.length) parts.push('字体 ' + fams.map((f) => f + need(f)).join(' / ') + (cjkFams.length ? ' · 中文 ' + cjkFams.join(' / ') : ''))
  const radii = styleAllowedRadii(tokens).filter((r) => r > 0)
  if (radii.length) parts.push('圆角 ' + radii.map((r) => r + 'px').join(' / '))
  const st = Object.entries((tokens && tokens.status) || {}).filter(([, v]) => _normHex(v))
  if (st.length) parts.push('状态色 ' + st.map(([k, v]) => k + ' ' + _normHex(v)).join(' · '))
  // 图标一行(没写 icons 段就不凭空多这一行 —— 清单每轮都付 token)
  const ic = iconSpec(tokens, project)
  // 填充型库没有描边可言(轮廓已转成填充路径)⇒ 报描边就是句假话,改报字重档
  if (ic) parts.push('图标 ' + [ic.library, ic.fallbackLibrary].filter(Boolean).join('+') + ' · ' + ic.grid + ' 网格 · '
    + (ic.form === 'fill' ? '填充型' : '描边 ' + ic.strokeWidth) + ' · ' + (ic.style === 'outlined' ? '线性' : ic.style))
  return parts.join(' | ')
}

// 报告文案。⚠ 结尾那句是这件事的**产品要害**:偏离**不等于错**,判断权在人 —— 不写死它,
// agent 会把「有偏离」当成必须改掉的缺陷,连设计图自带的渐变也一并改没了。
function formatCheckReport(res, { styleName = '', specIssues = 0 } = {}) {
  const L = []
  const n = res.findings.length
  L.push('【设计规范检查】对照风格档' + (styleName ? '「' + styleName + '」' : '') + ' · 检查 ' + res.checked.length + ' 个文件 · ' + (n ? n + ' 处与色板/圆角/字体/图标不一致' : '未发现不一致'))
  // ⚠ 必须点破:「零告警」和「压根没查」看起来一模一样。没写 icons 段就如实说这一类没查,
  // 否则群里会把「没报图标问题」读成「图标没问题」。
  if (res.iconsEnabled === false) L.push('· 图标这一类**未检查** —— 本项目风格档未启用图标体系(front matter 缺 icons 段)')
  // 同一条纪律的第二处:图标**来源**这一维的沉默有三种成因,不点破就会被读成「来源没问题」。
  // ⚠ 只在图标这一类本来就在查的时候说(整类没启用时上面那行已经说完了,再来一行是噪音)。
  const isrc = res.iconSource
  if (res.iconsEnabled && isrc && isrc.svgs) {
    if (!isrc.system) L.push('· 图标**来源**未核对 —— 本项目还没选图标系统(风格档只管怎么画,图形从哪来是另一份档)')
    else if (!isrc.libInstalled) L.push('· 图标**来源**只核对了一半 —— 这台机器上没有本项目图标系统的库,只认得出「与别家逐字相同」的那些')
    else if (!isrc.refs) L.push('· 图标**来源**未核对 —— 这些文件里没有认得出来源的图标(取出来的图标自带来源标记,sprite 则靠 symbol 的名字)')
  }
  // ⚠ 折叠成一行,但**必须出声**:静默消掉就分不出「判过、可接受」与「压根没查」。理由一并
  // 带上,供人复核当初判得对不对。
  // 例外档里**一条都没命中的键** = 过期条目(判据修好了 / 键写错了)。不报它 ⇒ 档越攒越多,
  //   而其中哪几条已经没用了没人知道。
  const stale = (res && res.acceptedStale) || []
  if (stale.length) L.push('· ⚠ 例外档里有 ' + stale.length + ' 条这次一条都没匹配上(判据已修好?键写错了?):' + stale.join(' · '))
  for (const w of (res && res.acceptedWarn) || []) L.push('· ⚠ 例外档:' + w)
  const waived = (res && res.accepted) || []
  if (waived.length) {
    L.push('· 另有 ' + waived.length + ' 条此前已判定可接受:'
      + waived.map((f) => (f.value != null ? String(f.value) : String(f.kind)) + '〔' + f.why + '〕').join(' · '))
  }
  // ⚠ 档本身的问题只留一行指针(不并进 findings、不影响退出码):三条验收都只会说「产物偏离
  //   了档」,而真机上缺口全在档里 —— 不留这行就永远没人知道该去改档。
  if (specIssues > 0) L.push('· ⚠ **风格档本身**还有 ' + specIssues + ' 类问题 —— 那是档的事,改产物治不好。')
  if (!n) return L.join('\n')
  const by = { color: [], radius: [], font: [], 'font-cjk': [], 'font-unloaded': [], 'icon-stroke': [], 'icon-cap': [], 'icon-join': [], 'icon-raster': [], 'icon-a11y': [], 'icon-emoji': [], 'icon-fillmix': [], 'icon-source': [], 'icon-form': [], 'icon-license': [] }
  for (const f of res.findings) (by[f.kind] || []).push(f)
  for (const f of by.color) L.push('· 颜色 ' + f.value + '(' + f.rel + ')— 不在色板里,最接近 ' + f.nearest)
  for (const f of by.radius) L.push('· 圆角 ' + f.value + '(' + f.rel + ')— 风格档的档位是 ' + f.allowed.join(' / '))
  for (const f of by.font) L.push('· 字体 ' + f.value + '(' + f.rel + ')— 风格档用的是 ' + f.allowed.join(' / '))
  for (const f of by['font-cjk']) L.push('· 有 ' + f.count + ' 条字体栈没有中文兜底(' + f.rel + ',这份产物里有汉字)— 例:'
    + f.sample.join(' / ') + ';风格档声明的中文族是 ' + f.declared.join(' / ') + '。若这几处只显示拉丁字符可忽略。')
  // ⚠ 这一条的要害是**落点**:「没加载」三个字没人会动,「实际显示的是苹方」才会。
  //   两条出口(别处注入 / 认不出的链接)必须在句子里,否则它是一句站不住的指控。
  for (const f of by['font-unloaded']) {
    // ⚠ 不断言许可:不在免费清单里 ≠ 授权字体(Inter Variable 就不在清单里),只说「要自带文件」这个事实
    L.push('· 字体「' + f.family + '」找不到加载来源(' + f.rel + ',' + f.stacks + ' 条栈)— 这批文件里既没有它的 @font-face、也没有认得出它的字体服务链接,它又不是系统自带;'
      + _landingSentence(f, { mobile: !!f.mobile }) + '。'
      + (f.free ? '它免费可得,加一行字体服务链接或自带文件即可。' : '要自带字体文件它才会出现。')
      + '(若字体由别处注入,记进例外档' + (f.unknownLinks ? ';另有 ' + f.unknownLinks + ' 个外部样式表链接认不出族名,可能就是它' : '') + ')')
  }
  for (const f of by['icon-stroke']) L.push('· 图标描边 ' + f.value + '(' + f.rel + ')— 风格档是 ' + f.expected)
  for (const f of by['icon-cap']) L.push('· 图标端点 ' + f.value + '(' + f.rel + ')— 风格档是 ' + f.expected)
  for (const f of by['icon-join']) L.push('· 图标连接 ' + f.value + '(' + f.rel + ')— 风格档是 ' + f.expected)
  for (const f of by['icon-raster']) L.push('· 位图当图标 ' + f.count + ' 处(' + f.rel + ')— 例:' + (f.sample || []).join(' / ') + ';界面图标请用矢量')
  for (const f of by['icon-a11y']) L.push('· ' + f.count + ' 个图标缺无障碍名(' + f.rel + ')— 装饰性的加 aria-hidden,有含义的加 aria-label')
  for (const f of by['icon-emoji']) L.push('· emoji 当图标 ' + f.count + ' 处(' + f.rel + ')— 例:' + (f.sample || []).join(' ') + ';可点的地方请用矢量图标(emoji 跟不了主题色、各平台字形不同、读屏念的是 emoji 名)')
  for (const f of by['icon-fillmix']) L.push('· 线性与实心混用(' + f.rel + ')— 线性 ' + f.outline + ' 个 · 实心 ' + f.filled + ' 个,风格档声明的是' + (f.declared === 'filled' ? '实心' : '线性'))
  // ⚠ 末句是这条判据的**要害**:换图标系统只改档,**已经取过的图标不会自己跟着变** —— 页面
  //   看着好好的,而它来自上一套系统。不写这句,人会以为检查器认错了。
  for (const f of by['icon-source']) L.push('· 图标来源不符 ' + f.count + ' 处(' + f.rel + ')— 本项目的图标系统是「' + f.systemLabel + '」,这些不是从它来的:'
    + (f.sample || []).map((s) => s.name + '〔' + s.why + '〕').join(' / ') + (f.count > (f.sample || []).length ? ' …' : '')
    + ';**换系统只改档,已经取过的图标不会自己跟着变**,得重新取一遍')
  for (const f of by['icon-form']) L.push('· 描边型图标 ' + f.count + ' 个(' + f.rel + ')— 本项目的图标系统「' + f.systemLabel + '」是填充型,它的图形里根本没有描边 ⇒ 这些必然来自别处')
  // ⚠ 末尾那句括号是**留给正当例外的出口**:署名放在别处(第三方许可清单、页脚)完全合法,
  //   没有它这条就成了一句站不住的指控,而站不住的指控会让整份报告被丢掉。
  for (const f of by['icon-license']) L.push('· 图标署名不在这批文件里 —— 用的是 ' + f.libs.join(' / ') + ' 的图标(sprite 形态),而这几个文件里找不到那行声明;这两个许可都要求副本保留声明,出给你的 sprite 本来自带它,整理时别删(声明放在别处也算,那就不用管这条)')
  const hasIcon = ['icon-stroke', 'icon-cap', 'icon-join', 'icon-raster', 'icon-a11y', 'icon-emoji', 'icon-fillmix', 'icon-source', 'icon-form', 'icon-license'].some((k) => by[k].length)
  L.push('⚠ 以上是「与风格档不一致」,不等于做错了 —— 设计图自带的渐变、第三方 logo 的品牌色都会出现在这里;把它连同你的判断一起说给群里,由人来定要不要改。')
  // ⭐ 到达率:机制没人知道就等于没做 ⇒ 下一步动作写在**最需要它的那一刻**,不塞进每轮都
  //   付 token 的清单。零不一致时不出这行(那时它是噪音)。
  L.push('⚠ 其中判定「这样就对」的,连同**为什么**记进 ' + ACCEPTED_DOC_REL.replace(/\\/g, '/')
    + ' —— 下次起它们折叠成一行、不再逐条重复(没写理由的不生效;风格档补齐后记得删掉对应条目)。')
  // 尺寸这一项**故意不逐值报**,原因写在这句里:HIG 明确要求按视觉重量微调单个图标尺寸
  // (asymmetric 图标还要靠 padding 做光学居中)—— 逐值报会把它推荐的做法报成错。
  if (hasIcon) L.push('⚠ 图标那几条同理:**尺寸/位置的细微差异可能是光学微调而不是错**(非对称图标几何居中反而显偏),这里只查描边、端点、矢量、无障碍名与**图形来源**这些定死的项。')
  return L.join('\n')
}

// ── 风格档体检(第四条平级验收:查**档本身**)──────────────────────────────────
// 由来:三条验收都只会说「产物偏离了档」,从不说「档本身有问题」。而真机上三个缺口全在档里
// —— 语义色没声明 · 等宽档没中文兜底 · 写了一个 1.22:1 根本不可读的成功绿。
// ⚠ 只测**作者真写了的键**:styleRoles 的兜底会凭空造色(muted = mix(bg,ink,0.55)),
//   拿它体检等于在评价档里根本不存在的颜色。
// ⚠ **明确不测**(测不准的宁可不测):line(发丝线故意就淡)· accent(可能当底色配反色文字)
//   · alt-N / gradient / elevation(用途不定)· 间距阴影。报告里如实列出没测哪些。
// ⚠ 这是**白名单**,必然认不全 —— 真机上它把 `'Xiaolai'`(小赖,开源中文手写体)报成了「缺
//   中文兜底」,而那一档本来就是中文族。⇒ 两件事都要做:清单尽量全 · **报告措辞给出口**
//   (不在清单里不等于没有)。判据本身不改成"猜":猜错的方向是静默漏报,比多问一句糟。
const CJK_FAMILY_RE = new RegExp([
  'Noto\\s+(Sans|Serif)\\s+(SC|TC|HK|JP|KR|CJK)', 'Source\\s+Han', 'PingFang', 'Hiragino\\s+Sans\\s+GB',
  'Microsoft\\s+YaHei', 'HarmonyOS\\s+Sans\\s+SC', 'Heiti\\s+SC', 'Songti\\s+SC', 'STHeiti', 'WenQuanYi',
  // ⚠ 圆体 / 楷体 / 仿宋与 Windows 经典族原先不在这张表里,而 CJK_KIND_RE 认它们 —— 两张词表分叉:
  //   soft-friendly 的 `Yuanti SC` 被当成拉丁族(v0.11.68 做 fonts 段时逮到)。凡 CJK_STACKS 里出现的族,这张表必须认。
  'Yuanti\\s+SC', 'Kaiti\\s+SC', 'STKaiti', 'STSong', 'STFangsong', 'SimSun', 'SimHei', 'DengXian', 'KaiTi', 'FangSong',
  'Xiaolai', 'LXGW', 'Sarasa', 'MiSans', 'OPPOSans', 'Alibaba\\s+PuHuiTi', 'ZCOOL', 'Ma\\s+Shan\\s+Zheng',
  'Zhi\\s+Mang\\s+Xing', 'Long\\s+Cang', 'Liu\\s+Jian\\s+Mao\\s+Cao',
  '思源', '苹方', '微软雅黑', '方正', '小赖', '霞鹜', '更纱', '站酷',
].join('|'), 'i')
// 语义色词表。⚠ 与 ROLE_KEYS 互斥 —— 命中角色词的是角色,不是语义色。
const SEMANTIC_COLOR_WORDS = {
  success: ['success', 'ok', 'positive', 'pass', 'up', 'gain', 'profit'],
  warning: ['warning', 'warn', 'caution', 'alert', 'pending'],
  danger: ['danger', 'error', 'err', 'fail', 'failed', 'negative', 'critical', 'down', 'loss'],
  info: ['info', 'notice', 'tip'],
}
// 对比度**分两档报**。由来:对 16 份内置档做误报预算时,4 份的 muted 落在 3.2~4.1(次要小字
// 用低对比是设计惯例),与一条 1.22:1 的**几乎不可见**报成同一级 —— 真雷会被淹掉。
// 门槛都是 WCAG 的现成值(4.5 正文 / 3.0 大字与非文本),不是自己发明的数。
const SPEC_TEXT_MIN = 4.5
const SPEC_TEXT_HARD = 3.0
// 九档标准字重(CSS 的 100..900)。中文静态族按这九档出文件,档外的值必然靠合成。
const STD_FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900]
const _normKey = (k) => String(k).toLowerCase().replace(/[\s_]+/g, '-')
const _isRoleWord = (n) => Object.values(ROLE_KEYS).some((ws) => ws.includes(n))
// 作者显式写了某角色时返回它;没写返回 null(**不走 styleRoles 的兜底**)
function _writtenRole(colors, role) {
  for (const [k, v] of Object.entries(colors || {})) {
    if (!ROLE_KEYS[role].includes(_normKey(k))) continue
    const hex = _normHex(v)
    if (hex) return { key: String(k), hex }
  }
  return null
}

function auditStyleSpec(tokens) {
  const colors = (tokens && tokens.colors) || {}
  const findings = []
  // ① 语义色放错段:ok/warn/err 这类键写在 colors 里而不是 status 段。
  //    ⚠ 判据很准(语义词 + 位置),而后果是实打实的:进了 colors 就会参与角色推断,
  //    危险红彩度最高时当场抢走 accent(v0.9.2 同款坑)。
  const misplaced = []
  for (const [k, v] of Object.entries(colors)) {
    const n = _normKey(k)
    if (_isRoleWord(n)) continue
    const hex = _normHex(v)
    if (!hex) continue
    const slot = Object.keys(SEMANTIC_COLOR_WORDS).find((s) => SEMANTIC_COLOR_WORDS[s].includes(n))
    if (slot) misplaced.push({ key: String(k), hex, slot })
  }
  if (misplaced.length) findings.push({ kind: 'spec-status-misplaced', items: misplaced })

  // ② 对比度:只测**有明确文字语义**的色 —— 写死的 ink/muted、status 段、以及①里那批语义色。
  const bg = _writtenRole(colors, 'bg')
  const statusSeg = Object.entries((tokens && tokens.status) || {})
    .map(([k, v]) => ({ key: String(k), hex: _normHex(v) })).filter((x) => x.hex)
  const lowContrast = []
  if (bg) {
    const probes = []
    for (const role of ['ink', 'muted']) { const r = _writtenRole(colors, role); if (r) probes.push({ ...r, why: role }) }
    for (const s of statusSeg) probes.push({ ...s, why: 'status' })
    for (const m of misplaced) probes.push({ key: m.key, hex: m.hex, why: 'status' })
    for (const p of probes) {
      const c = _contrast(_rgb(p.hex), _rgb(bg.hex))
      if (c < SPEC_TEXT_MIN) lowContrast.push({ key: p.key, hex: p.hex, on: bg.hex, ratio: Math.round(c * 100) / 100, hard: c < SPEC_TEXT_HARD })
    }
  }
  const hard = lowContrast.filter((x) => x.hard)
  const weak = lowContrast.filter((x) => !x.hard)
  if (hard.length) findings.push({ kind: 'spec-contrast', bg: bg && bg.hex, items: hard })
  if (weak.length) findings.push({ kind: 'spec-contrast-weak', bg: bg && bg.hex, items: weak })

  // ③ 非标准字重:九档之外的值(如 650)—— 拉丁可变字体真渲染得出,中文静态族只有九档
  //    ⇒ 汉字走合成伪粗,同一行里拉丁真粗、汉字假粗。误报预算实测 1/18(且那一份是我们
  //    自己的生成器写的,已修)。⚠ 判据只认**声明层**:「浏览器有没有真的合成」在 DOM 里测不准。
  const oddW = []
  for (const [slot, v] of Object.entries((tokens && tokens.typography) || {})) {
    if (!v || typeof v !== 'object') continue
    const n = parseInt(String(v.fontWeight == null ? '' : v.fontWeight), 10)
    if (Number.isFinite(n) && !STD_FONT_WEIGHTS.includes(n)) oddW.push({ slot: String(slot), weight: n })
  }
  if (oddW.length) findings.push({ kind: 'spec-weight', items: oddW })

  // ④ 中文兜底:typography 每档的 fontFamily 有没有 CJK 族。⚠ 缺了不等于中文显示不出来 ——
  //    是「掉到浏览器默认兜底、不受设计控制」;纯英文产品可忽略,措辞里给足这个出口。
  const noCjk = []
  for (const [slot, v] of Object.entries((tokens && tokens.typography) || {})) {
    if (!v || typeof v !== 'object' || !v.fontFamily) continue
    if (!CJK_FAMILY_RE.test(String(v.fontFamily))) noCjk.push({ slot: String(slot), stack: String(v.fontFamily) })
  }
  if (noCjk.length) findings.push({ kind: 'spec-cjk', items: noCjk })

  // ⑤ 首选字体的来源(由来见 fontAvailability 段头):档说「标题用 Canela」,而 Canela 不是任何
  //    系统自带的 ⇒ 项目不自带字体文件时,实际显示的是栈里下一个能用的。**按平台各报一个落点**
  //    —— Didot / Futura 只有 mac 有,neo-chinese 的宋体栈在 Windows 上落到雅黑(宋体身份整个丢掉)。
  //    ⚠ 这不进 specHardIssues(同 spec-cjk):内置档几乎份份如此,进指针就是常驻噪音;
  //    它是「整理档时看一眼」的信息,不是「每次交付都提」的问题。
  const noSrc = []
  for (const [slot, v] of Object.entries((tokens && tokens.typography) || {})) {
    if (!v || typeof v !== 'object' || !v.fontFamily) continue
    const verdict = fontSourceVerdict(v.fontFamily)   // 裁决只有这一份(与 check 的 font-unloaded 同源)
    if (verdict) noSrc.push({ slot: String(slot), ...verdict })
  }
  if (noSrc.length) findings.push({ kind: 'spec-font-source', items: noSrc, mobile: _docIsMobile(tokens) })

  // ⑥ fonts 段的中文档位写错(v0.11.68):`cjk: serf` 这种打错的会静默退回黑体 —— 退回是为了不让档整个
  //    失效,但必须有人说一声,否则宋体风格悄悄变成黑体没人知道。
  const badKinds = fontsKindIssues(tokens)
  if (badKinds.length) findings.push({ kind: 'spec-fonts-kind', items: badKinds, allowed: Object.keys(CJK_STACKS) })

  return {
    findings,
    // ⚠ 如实交代**判据够不着的地方**:没写 bg 时对比度整类不测,而「没测」与「没问题」
    //   在报告上长得一模一样。
    contrastTested: !!bg,
    notTested: ['line(发丝线故意就淡)', 'accent(可能当底色配反色文字)', '补充色 / 渐变 / 投影(用途不定)'],
  }
}

// 高确定性的那两类 —— 给 `design check` 末尾那行指针用。⚠ 偏弱对比(3~4.5)与 CJK 那两条
// **不进指针**:前者是设计惯例(4/16 内置档如此)、后者纯英文产品可忽略,进了指针就是常驻噪音。
function specHardIssues(res) {
  return ((res && res.findings) || []).filter((f) => f.kind === 'spec-status-misplaced' || f.kind === 'spec-contrast' || f.kind === 'spec-weight').length
}

function formatSpecReport(res, { styleName = '', rel = '' } = {}) {
  const L = []
  const fs = (res && res.findings) || []
  L.push('【风格档体检】' + (styleName ? '「' + styleName + '」' : '') + (rel ? ' · ' + rel : '')
    + ' · ' + (fs.length ? fs.length + ' 类问题' : '未发现问题'))
  for (const f of fs) {
    if (f.kind === 'spec-status-misplaced') {
      L.push('· 语义色写在了色板里,应当移到 status 段:'
        + f.items.map((i) => i.key + ' ' + i.hex + '(' + i.slot + ')').join(' · ')
        + ' —— 留在色板里会参与角色推断,彩度高的那个会**抢走强调色**。')
    } else if (f.kind === 'spec-contrast') {
      L.push('· 配底色 ' + f.bg + ' **几乎看不见**(低于 WCAG 的 ' + SPEC_TEXT_HARD + ':1,大字和图标都不够):'
        + f.items.map((i) => i.key + ' ' + i.hex + ' = ' + i.ratio + ':1').join(' · '))
    } else if (f.kind === 'spec-contrast-weak') {
      L.push('· 配底色 ' + f.bg + ' 做**小字**偏吃力(不到 AA 正文的 ' + SPEC_TEXT_MIN + ':1):'
        + f.items.map((i) => i.key + ' ' + i.hex + ' = ' + i.ratio + ':1').join(' · ')
        + ' —— 只用于 ≥24px 大字或非文本时,AA 就是合规的。')
    } else if (f.kind === 'spec-weight') {
      L.push('· 字重不是九档标准值:' + f.items.map((i) => i.slot + ' ' + i.weight).join(' · ')
        + ' —— 拉丁可变字体渲染得出,中文静态族只有 100…900 九档(苹方最重到 600)⇒ 汉字走合成伪粗,'
        + '同一行里拉丁真粗、汉字假粗。就近取一档标准值即可。')
    } else if (f.kind === 'spec-cjk') {
      L.push('· 没有中文字体兜底的档:' + f.items.map((i) => i.slot).join(' / ')
        + ' —— 汉字会掉到浏览器默认字体,跨平台不一致、与整页不是一套。'
        + '(产品不出中文可忽略;这一条按**已知中文族清单**判,栈里的中文族若不在清单里也会被报出来,那种情况直接忽略。)')
    } else if (f.kind === 'spec-font-source') {
      // 每档一段:族名 + **丢了的那一边**落到哪(没丢的不说)。◇ 免费可得 · ◆ 仅一个平台自带 · ⚠宋体→黑体 = 路数变了
      const one = (label, i, l) => label + '→' + _landText(l) + (i.cjk && l && _cjkKindOf(l.family) !== _cjkKindOf(i.family) ? '⚠' + _cjkKindOf(i.family) + '→' + (_cjkKindOf(l.family) || '别的') : '')
      const seg = f.items.map((i) => i.slot + '「' + i.family + '」' + (i.free ? '◇' : '') + (i.mac !== i.win ? '◆' : '')
        + (f.mobile ? '' : '(' + [i.lostMac ? one('mac', i, i.landMac) : '', i.lostWin ? one('win', i, i.landWin) : ''].filter(Boolean).join(' · ') + ')')).join(' · ')
      L.push('· 首选字体不是系统自带,**项目须自带字体文件,否则实际显示的是括号里那个**:' + seg
        + (f.mobile ? ' —— 这份档管的是手机端:手机上同样找不到它,实际显示的是各系统自带的中文字体(iOS / Android 各不相同)。' : ' —— ◇ 免费可得(字体服务或自带文件);◆ 只有一个平台自带,另一个平台照样掉;⚠ 标的是中文路数变了(如宋体栈在 Windows 上落成黑体)。')
        + '中文首选而两边都落在同一路系统字体上的(如苹方/雅黑),是有意的跨平台写法,不在这里。')
    } else if (f.kind === 'spec-fonts-kind') {
      L.push('· 中文档位写错了:' + f.items.map((i) => i.where + ' 写的是「' + i.value + '」').join(' · ')
        + ' —— 只认 ' + f.allowed.join(' / ') + ';认不出的已按黑体处理,**宋体风格会悄悄变成黑体**,请改正。')
    }
  }
  if (res && !res.contrastTested) L.push('⚠ 对比度这一类**没测** —— 档里没有可辨认的底色键(bg/background/paper…)。')
  L.push('⚠ 没测:' + (res.notTested || []).join(' · ') + ' —— 用途不定,测了必然假警报。')
  return L.join('\n')
}

module.exports = {
  auditStyleSpec, formatSpecReport, specHardIssues, CJK_FAMILY_RE, ROLE_KEYS, SEMANTIC_COLOR_WORDS, STD_FONT_WEIGHTS,
  DEFAULT_STYLE_REL, FALLBACK_STYLE_REL, CARD_W, CARD_H, PILL, BUILTIN_STYLES_DIR, userStylesDir,
  parseStyleMeta, isStyleDoc, listStyles, findStyleDoc, resolveStyleTarget, extractPalette, iconSummary, projectIconCard,
  parseStyleTokens, styleRoles, swatchSpec, swatchLayout, renderSwatchSheet,
  checkDesign, formatCheckReport, tokenDigest, styleAllowedColors, styleAllowedRadii, styleAllowedFamilies, usedRadii, usedFontFamilies,
  styleCjkFamilies, usedFontStacks, CJK_TEXT_RE,
  // 已知例外(报告降噪):判据身份 → 例外档解析 → 读盘
  ACCEPTED_DOC_REL, ACCEPTED_FORMAT_HINT, findingKey, parseAcceptedDoc, findAcceptedDoc, acceptedDocWarnings,
  // 图标体系(docs/ICONS.md):声明 → 取用 → 验收三段各一组
  ICON_LIBS, ICON_SYSTEMS, ICON_DEFAULTS, ICON_RASTER_MAX, ICONS_DOC_REL, iconSpec, iconRoots, iconDirs, iconStyleGap, iconSystemGap, iconSourceConflict, iconIsFilled, resolveIconName, readIcon,
  isIconsDoc, parseIconsDoc, findIconsDoc, composeIconsDoc, withIconsDocFront, iconsDocText, withIconsStyleInStyleDoc, iconSystemPreview, iconSystemPreviews, iconSystemList, iconSheetHtml,
  iconGeomKey, readIconAsset, auditIconAssets, formatIconAuditReport,
  // 图标来源核对(第四条判据):页面里的图标是不是从当前这套系统来的
  pageIconRefs, iconLookup, attributeIcons, checkIconSource, iconLicenseGap,
  LAYOUT_PROBE, layoutProbe, styleMinFontSize, LAYOUT_MIN_TARGET, layoutFindings, mergeLayoutRuns, formatLayoutReport,
  normalizeIconSvg, iconSpriteSvg, usedIcons, checkIcons,
  swatchRoleReport, SWATCH_ROLE_HINT,
  allStyles, styleCard, projectStyleCard,
  // 项目内多份风格档(v0.11.22)
  findStyleDocs, projectStyleCards, resolveStyleAs, withStylePlatform, pickStyleDoc, styleProse, withStyleProse, withKeptSections, STYLES_DIR_REL, PLATFORM_SLUG, MAX_PROJECT_STYLE_CARDS,
  // 自定义风格(v0.11.21)
  SCENE_WORDS, PLATFORM_WORDS, PLATFORM_CANVAS, COLOR_KEYS, COLOR_LABELS, ROUND_LEVELS, WEIGHT_LEVELS, SLUG_RE,
  ELEV_LEVELS, STATUS_KEYS, STATUS_LABELS, GRADIENT_ANGLE,
  EXTRA_COLOR_PREFIX, EXTRA_COLOR_MAX, EXTRA_TOKEN_SPEC, deriveExtraTokens, deriveStyleTraits, describeExtract,
  normalizeStyleForm, validateStyleForm, validateStyleSlug, suggestSlug,
  composeStyleDoc, styleFormFromDoc, withStyleName, quantizeRounded, quantizeWeight,
  CJK_SYSTEM_FIRST, fontStack, SANS_STACK, styleCjkKinds, cjkCardState,
  // 顶层 fonts 段(v0.11.68)
  CJK_STACKS, CJK_KIND_OF_STACK, CJK_STACK_DEFAULT, resolveFontFamily, applyFontsSegment, fontsKindIssues,
  // 字体可得性(v0.11.66)
  fontAvailability, declaredFontSources, fontLanding, fontSourceVerdict, SYSTEM_FONTS, FREE_FONTS,
  // 档位表:控制台表单要按同一组 id 出选项(单测钉住两边一致)
  ROUND_LEVELS, WEIGHT_LEVELS, ELEV_LEVELS,
  saveUserStyle, deleteUserStyle,
  colorLiterals, parseCssCandidates, dedupeColors, extractFormFromTexts, stripCssComments,
  parseHtmlStyleRefs, extractFromUrl, scanProjectDir, extractFromDir,
  isPublicHostname, assertPublicUrl, SSRF_MSG,
}
