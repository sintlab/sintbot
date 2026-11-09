// 群通知卡(v0.11.137)。群里「机器人对大家说的话」—— 公告 / 升级播报 / 提醒 / 故障 / 变更 / 状态 —— 此前全是纯文本,
// 只能靠【】与「·」排版,和回答卡、和成员的闲聊混在一起。这里给它们一个共用的形状:
//   · 彩色标题栏说性质(看颜色就知道是公告还是故障),标题一句话,副标题说「和我有什么关系 / 要我做什么」
//   · 正文 markdown,最多几条要点(加粗小标题 + 一句话;命令用行内代码)
//   · 注意事项:分隔线下的灰字,⚠ 开头,不抢主文
//   · 右下角小字:时间 · 来源(与回答卡右下角小字同一位置、同一字号,风格一致)
// 纯函数、零依赖:飞书卡片 schema 2.0 的 JSON 形状只在此一处;没有这种卡的平台(企微)由调用方退回 noticeText()。
// ⚠ 2.0 不认 note 组件(真机被拒,见 takeovercard.js),小字一律 markdown + text_size notation + <font color='grey'>。
// ⚠ 脱敏:卡是 JSON 不能整体 redact,构卡时逐字段过 opts.redact(接管卡 / 生图卡同一纪律)。

// template = 标题栏底色;tagColor = 标题栏右侧类别小标签的色(text_tag 的色名表里没有 grey,用 neutral);emoji 只给文本兜底用 ——
// 卡面上颜色已经说明性质,标题再带 emoji 就显得满(v0.11.138 用户:「小一点、精致一些」)。
const TONES = {
  notice: { template: 'blue', tagColor: 'blue', emoji: '📣', label: '公告' },
  upgrade: { template: 'green', tagColor: 'green', emoji: '🚀', label: '升级' },
  action: { template: 'orange', tagColor: 'orange', emoji: '👋', label: '提醒' },
  alert: { template: 'red', tagColor: 'red', emoji: '⚠️', label: '故障' },
  change: { template: 'indigo', tagColor: 'indigo', emoji: '🔁', label: '变更' },
  status: { template: 'grey', tagColor: 'neutral', emoji: '🔄', label: '状态' },
}
// 群命令 --tone 收中文;英文键也认(大小写不限)。认不出返回 null,让调用方报「不认识的类别」而不是悄悄当公告发
const ALIASES = { 公告: 'notice', 通知: 'notice', 升级: 'upgrade', 提醒: 'action', 故障: 'alert', 告警: 'alert', 额度: 'alert', 变更: 'change', 切换: 'change', 状态: 'status' }

function resolveTone(x) {
  const raw = String(x == null ? '' : x).trim()
  if (!raw) return 'notice'
  const k = raw.toLowerCase()
  if (TONES[k]) return k
  return ALIASES[raw] || null
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const asLines = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v])).map((x) => String(x == null ? '' : x).trim()).filter(Boolean)

// 把调用方给的字段收拾成一份干净的通知:tone 归一、标题兜底、注意事项去掉重复的 ⚠(这里统一加一个)、逐字段脱敏
function normalize(n = {}, { redact } = {}) {
  const r = typeof redact === 'function' ? (s) => String(redact(String(s))) : (s) => String(s)
  const tone = resolveTone(n.tone) || 'notice'
  const t = TONES[tone]
  const title = r(String(n.title == null ? '' : n.title).trim() || t.label)
  const subtitle = n.subtitle ? r(String(n.subtitle).trim()) : ''
  const body = n.body ? r(String(n.body).replace(/^\n+|\n+$/g, '')) : ''
  const warnings = asLines(n.warnings).map((w) => r(w.replace(/^(?:⚠️|⚠|\s)+/u, '').trim())).filter(Boolean)
  const footer = n.footer ? r(String(n.footer).trim()) : ''
  return { tone, emoji: t.emoji, label: t.label, template: t.template, tagColor: t.tagColor, title, subtitle, body, warnings, footer }
}

// 正文里「**标签** 说明」这种要点行(v0.11.138):排成两栏对齐(标签窄栏加粗、说明宽栏),不再靠全角空格硬顶。
// 只认这一种写法,其余行原样 markdown;连续的普通行合成一个 markdown 元素,免得每行一个元素把行距撑开。
const ROW_RE = /^\*\*(.+?)\*\*[\s　:：]*(\S.*)$/
function bodyElements(body) {
  const out = []
  let plain = []
  const flush = () => { if (plain.length) { out.push({ tag: 'markdown', text_size: 'normal', content: plain.join('\n') }); plain = [] } }
  for (const line of body.split('\n')) {
    const m = ROW_RE.exec(line.trim())
    if (!m) { plain.push(line); continue }
    flush()
    out.push({
      tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', horizontal_align: 'left',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'top', elements: [{ tag: 'markdown', text_size: 'normal', content: `**${m[1]}**` }] },
        { tag: 'column', width: 'weighted', weight: 3, vertical_align: 'top', elements: [{ tag: 'markdown', text_size: 'normal', content: m[2] }] },
      ],
    })
  }
  flush()
  return out
}

// 飞书卡片(schema 2.0),撑满宽(fill)。标题栏:底色按类别 + 标题 + 副标题 + 右侧类别小标签;卡身 12px 内边距 / 8px 行距;
// 注意事项与右下角都是最小字号灰字(notation),正文 normal。标题 / 副标题 / 模板色那组字段与接管卡同款(服务端已收);
// text_tag_list / column_set / 内边距已在飞书上实发验证过。宽度:飞书只有 compact / default / fill 三档没有数值,
// .138 用的窄版用户看了「有点太窄」,三档对照后拍板**全部撑满**(v0.11.139),不按内容自动选档。
function buildNoticeCard(n, opts) {
  const x = normalize(n, opts)
  const elements = x.body ? bodyElements(x.body) : []
  if (x.warnings.length) elements.push({ tag: 'markdown', text_size: 'notation', content: x.warnings.map((w) => `<font color='grey'>⚠ ${esc(w)}</font>`).join('\n') })
  if (x.footer) elements.push({ tag: 'markdown', text_size: 'notation', text_align: 'right', content: `<font color='grey'>${esc(x.footer)}</font>` })
  // 只有标题的通知:卡身不能空(空 elements 服务端会拒),把副标题 / 标题落一行
  if (!elements.length) elements.push({ tag: 'markdown', text_size: 'normal', content: x.subtitle || x.title })
  const header = {
    title: { tag: 'plain_text', content: x.title },
    template: x.template,
    text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: x.label }, color: x.tagColor }],
    padding: '12px 12px 12px 12px',
  }
  if (x.subtitle) header.subtitle = { tag: 'plain_text', content: x.subtitle }
  return { schema: '2.0', config: { width_mode: 'fill' }, header, body: { padding: '12px 12px 12px 12px', vertical_spacing: '8px', elements } }
}

// 纯文本版:同一份内容、同一个顺序(标题 → 副标题 → 正文 → ⚠ 注意 → 页脚)。没有卡的平台、发卡失败的兜底都用它,
// 两条路说的话必须一样 —— 卡与文本各写一份文案,迟早漂。
function noticeText(n, opts) {
  const x = normalize(n, opts)
  const L = [`${x.emoji} ${x.title}`]
  if (x.subtitle) L.push(x.subtitle)
  if (x.body) L.push(x.body)
  for (const w of x.warnings) L.push(`⚠ ${w}`)
  if (x.footer) L.push(x.footer)
  return L.join('\n')
}

module.exports = { TONES, resolveTone, buildNoticeCard, noticeText, bodyElements }
