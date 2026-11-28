// 画板(whiteboard)纯函数工具 —— 三个不做任何 IO/网络的确定性函数,供群 agent
// 往飞书画板贴图 / 读画板结构时复用,可单独单测:
//
//   imageSize(buf)                     —— 从图片二进制头解析像素尺寸(PNG/JPEG/WebP,魔数解析,零依赖)
//   digestNodes(nodes, opts)           —— 把画板节点数组整形成给模型看的紧凑摘要(防御式,任何残缺节点都出行)
//   nextImagePosition(nodes, w, h,gap) —— 确定性算出新图该摆的坐标(现有节点右侧 + gap)
//
// 三者都不碰文件系统 / 飞书 API,便于 core 无感调用与测试。House style 同 visionproxy.js:
// 零依赖、报错中文、注释中文为主。

// ── imageSize ──────────────────────────────────────────────────────────────
// 只读图片头部的魔数即可拿到宽高,不解全图、不引 image 库。返回 {width,height}。

// PNG:8 字节签名 + IHDR(width/height 各 4B 大端,固定落在 offset 16 / 20)
function _png(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (buf.length < 24) return null
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// JPEG:FF D8 开头,顺着 segment 走,找 SOF0-SOF15(0xC0-0xCF,排除 DHT/JPG/DAC =
// 0xC4/0xC8/0xCC);SOF payload = 精度1B + height 2B(BE)+ width 2B(BE)。
function _jpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
  const len = buf.length
  let off = 2
  while (off + 1 < len) {
    if (buf[off] !== 0xff) { off++; continue }
    let marker = buf[off + 1]
    // marker 前可能有多个 0xFF 填充字节,吃掉
    while (marker === 0xff && off + 2 < len) { off++; marker = buf[off + 1] }
    off += 2
    // 无 length 的独立 marker:SOI/EOI/RSTn/TEM —— 直接跳过
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (off + 1 >= len) break
    const segLen = buf.readUInt16BE(off)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (off + 6 >= len) break
      return { height: buf.readUInt16BE(off + 3), width: buf.readUInt16BE(off + 5) }
    }
    if (segLen < 2) break // 损坏的长度字段,别原地打转
    off += segLen
  }
  return null
}

// WebP:RIFF....WEBP + 子块 FourCC(offset 12);块数据从 offset 20 起(跳过 4B 块大小)。
//   VP8 (lossy)    —— 起始码 9d 01 2a 后 width/height 各 2B LE,取低 14 位(offset 26/28)
//   VP8L(lossless) —— 签名 0x2f 后 4B LE 位打包:width=1+bits[0..13],height=1+bits[14..27]
//   VP8X(extended) —— canvas width/height 各 3B LE,存储值+1(offset 24/27)
function _webp(buf) {
  if (buf.length < 16) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null
  const fourcc = buf.toString('ascii', 12, 16)
  if (fourcc === 'VP8 ') {
    if (buf.length < 30) return null
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (fourcc === 'VP8L') {
    if (buf.length < 25 || buf[20] !== 0x2f) return null
    const bits = buf.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
  }
  if (fourcc === 'VP8X') {
    if (buf.length < 30) return null
    const rd3 = (o) => buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)
    return { width: rd3(24) + 1, height: rd3(27) + 1 }
  }
  return null
}

function _parseImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null
  try {
    return _png(buf) || _jpeg(buf) || _webp(buf)
  } catch {
    return null // 截断的头部触发越界读 —— 一律视为解析不出
  }
}

// 从图片二进制解析像素尺寸。解析不出 / 尺寸非正数一律抛中文错误。
function imageSize(buf) {
  const dim = _parseImage(buf)
  if (!dim || !(dim.width > 0) || !(dim.height > 0)) {
    throw new Error('不支持的图片格式(仅 PNG/JPEG/WebP)')
  }
  return { width: dim.width, height: dim.height }
}

// ── digestNodes ────────────────────────────────────────────────────────────
// 把画板节点整形成每行一条的紧凑摘要,喂给模型省 token。防御式:任意字段残缺都不抛错。

// 坐标/尺寸:有限数四舍五入取整,否则用 '?' 占位
function _num(v) { return Number.isFinite(v) ? Math.round(v) : '?' }

function _id(n) { return (n && n.id != null) ? String(n.id) : '?' }

// 从多种可能的形状里抽纯文本:字符串 / {text} / {text:{text}} / {rich_text:[...]} / [段...]
function _extractText(src) {
  if (src == null) return ''
  if (typeof src === 'string') return src
  if (typeof src.text === 'string') return src.text
  if (src.text && typeof src.text.text === 'string') return src.text.text
  if (Array.isArray(src.rich_text)) {
    return src.rich_text.map((s) => (s && typeof s.text === 'string') ? s.text : '').join('')
  }
  if (Array.isArray(src)) {
    return src.map((s) => (typeof s === 'string') ? s : (s && typeof s.text === 'string' ? s.text : '')).join('')
  }
  return ''
}

function _clip(s, max) {
  s = String(s == null ? '' : s)
  return s.length > max ? s.slice(0, max) + '…' : s
}

// ── nodeText ─────────────────────────────────────────────────────────────────
// 单一事实源:抽取一个节点承载的文字内容 —— digest 展示与画布自动感知(boardwatch)的「变更指纹」
// 共用它,这样「改了已有节点的文字但没动坐标」也能被察觉(纯挪动/改样式不改文字 ⇒ 指纹不变、静默)。
// 各类型取文字位:text_shape/sticky_note=节点自身;connector=caption/captions;
// composite_shape/mind_map=其内嵌 text;image 无文字返 ''。规范化空白折叠 + 截断(默认 200 字,
// 防长文撑爆基线内存;指纹只需能区分「变了没」,不必存全文)。纯函数,可单测。
function nodeText(node, max = 200) {
  const n = (node && typeof node === 'object') ? node : {}
  const type = typeof n.type === 'string' ? n.type : ''
  let txt = ''
  switch (type) {
    case 'image': txt = ''; break
    case 'connector': {
      const c = (n.connector && typeof n.connector === 'object') ? n.connector : {}
      const caps = Array.isArray(c.captions) ? c.captions : []
      txt = _extractText(n.caption) || caps.map((x) => _extractText(x)).filter(Boolean).join(' / ')
      break
    }
    case 'composite_shape': txt = _extractText(n) || _extractText(n.composite_shape); break
    case 'mind_map': txt = _extractText(n) || _extractText(n.mind_map); break
    default: txt = _extractText(n); break // text_shape / sticky_note / 其它:节点自身文字
  }
  txt = String(txt == null ? '' : txt).replace(/\s+/g, ' ').trim()
  return (max > 0 && txt.length > max) ? txt.slice(0, max) : txt
}

// 连接线端点吸附的目标节点 id:兼容 start_object.id / start_object.attached_object(可为 id 或对象)
function _attachedId(obj) {
  if (!obj || typeof obj !== 'object') return null
  if (typeof obj.id === 'string' || typeof obj.id === 'number') return String(obj.id)
  const ao = obj.attached_object
  if (typeof ao === 'string' || typeof ao === 'number') return String(ao)
  if (ao && typeof ao === 'object' && ao.id != null) return String(ao.id)
  return null
}

// 笔迹节点的点列包围盒:points 支持 [x,y] 或 {x,y};兼容真机嵌套 paint.points / paint.lines;
// 无有效点返回 null
function _pointsBBox(n) {
  let pts = n && n.points
  if (!Array.isArray(pts) || !pts.length) {
    const p = n && n.paint
    if (p && Array.isArray(p.points) && p.points.length) pts = p.points
    else if (p && Array.isArray(p.lines)) pts = p.lines.flatMap((l) => Array.isArray(l) ? l : (l && Array.isArray(l.points)) ? l.points : [])
  }
  if (!Array.isArray(pts) || pts.length === 0) return null
  const xs = []
  const ys = []
  for (const p of pts) {
    let px
    let py
    if (Array.isArray(p)) { px = p[0]; py = p[1] } else if (p && typeof p === 'object') { px = p.x; py = p.y }
    if (Number.isFinite(px)) xs.push(px)
    if (Number.isFinite(py)) ys.push(py)
  }
  if (!xs.length || !ys.length) return null
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

function _connectorLine(n, id) {
  // 真机形状(2026-07-21 生产实测):端点信息嵌在 n.connector 下 —— 吸附端 =
  // connector.start_object / connector.start.attached_object(含目标节点 id + snap_to,
  // 其 position 是 0~1 相对量,不可当坐标),自由端 = connector.start/end.position(绝对坐标)。
  // 节点顶层同名字段保留为回退(旧假设/防外形再变)。
  const c = (n.connector && typeof n.connector === 'object') ? n.connector : {}
  const sSide = (c.start && typeof c.start === 'object') ? c.start : {}
  const eSide = (c.end && typeof c.end === 'object') ? c.end : {}
  const so = c.start_object || sSide.attached_object || n.start_object || n.start_attached_object || {}
  const eo = c.end_object || eSide.attached_object || n.end_object || n.end_attached_object || {}
  const sId = _attachedId(so)
  const eId = _attachedId(eo)
  const sPos = (sSide.position && typeof sSide.position === 'object') ? sSide.position : so
  const ePos = (eSide.position && typeof eSide.position === 'object') ? eSide.position : eo
  const fromPart = sId ? `from:${sId}` : `from(${_num(sPos.x)},${_num(sPos.y)})`
  const toPart = eId ? `→吸附:${eId}` : `→to(${_num(ePos.x)},${_num(ePos.y)})`
  let line = `[箭头] ${id} ${fromPart}${toPart}`
  const cap = nodeText(n) // 单一事实源(caption/captions);与 boardwatch 变更指纹同一抽取
  if (cap) line += ` "${_clip(cap, 80)}"`
  return line
}

function _paintLine(n, id) {
  const box = _pointsBBox(n)
  if (box) {
    return `[笔迹] ${id} 约(${Math.round(box.minX)},${Math.round(box.minY)})~(${Math.round(box.maxX)},${Math.round(box.maxY)})`
  }
  return `[笔迹] ${id} at(${_num(n.x)},${_num(n.y)}) ${_num(n.width)}×${_num(n.height)}`
}

// 图形节点(图表通道 style=1 多节点可编辑的产物,也见于手绘):形状类型在 composite_shape.type,
// 文字兼容 node.text 与 composite_shape.text 两处嵌套。防御式,残缺字段用 '?' 占位不抛。
function _compositeLine(n, id) {
  const cs = (n.composite_shape && typeof n.composite_shape === 'object') ? n.composite_shape : {}
  const shape = typeof cs.type === 'string' ? cs.type : '?'
  const txt = nodeText(n) // 单一事实源(node.text || composite_shape.text)
  let line = `[图形] ${id} at(${_num(n.x)},${_num(n.y)}) ${_num(n.width)}×${_num(n.height)} <${shape}>`
  if (txt) line += ` "${_clip(txt, 80)}"`
  return line
}

// 思维导图节点(图表通道 mind_map 的产物):子节点靠**mind_map_node.parent_id** 挂树,children[] 只读故不展开;
// 文字兼容 node.text 与 mind_map.text。有树父节点附 (parent:xx) 供还原层级。
// ⚠ 树父节点**不在顶层 parent_id** —— 2026-07-28 真机实测:导图子节点顶层 parent_id 为空,树关系在
// mind_map_node.parent_id(官方数据结构:MindMapNode.parent_id required;顶层 parent_id 是「容器父节点」,
// 归 section/group 这类容器用)。此前这里读顶层 ⇒ 层级恒不显示,agent 看到的是一堆平铺节点看不出树。
// 故意**不回退顶层 parent_id**:移植打组后顶层 parent_id = 组 id,拿它冒充树父节点会误导。
function _mindmapLine(n, id) {
  const txt = nodeText(n) // 单一事实源(node.text || mind_map.text)
  const mn = (n.mind_map_node && typeof n.mind_map_node === 'object') ? n.mind_map_node : null
  const legacy = (n.mind_map && typeof n.mind_map === 'object') ? n.mind_map : null // MindMap 属性已弃用,只读兼容
  // 空串按「无父」处理 —— 真机上导图**根节点**的 mind_map_node.parent_id 是 ''(不是 null),
  // 只判 != null 会给根节点渲出一个空的 (parent:)(2026-07-28 探针实测)。
  const pick = (v) => (typeof v === 'string' ? (v.trim() ? v : null) : (v == null ? null : v))
  const parent = (mn ? pick(mn.parent_id) : null) || (legacy ? pick(legacy.parent_id) : null)
  let line = `[导图] ${id} at(${_num(n.x)},${_num(n.y)})`
  if (txt) line += ` "${_clip(txt, 80)}"`
  if (parent != null) line += ` (parent:${parent})`
  return line
}

function _lineFor(n) {
  const node = (n && typeof n === 'object') ? n : {}
  const type = typeof node.type === 'string' ? node.type : ''
  const id = _id(node)
  switch (type) {
    case 'image':
      return `[图] ${id} at(${_num(node.x)},${_num(node.y)}) ${_num(node.width)}×${_num(node.height)}`
    case 'connector':
      return _connectorLine(node, id)
    case 'text_shape':
    case 'sticky_note':
      return `[文字] ${id} at(${_num(node.x)},${_num(node.y)}) "${_clip(nodeText(node), 80)}"`
    case 'composite_shape':
      return _compositeLine(node, id)
    case 'mind_map':
      return _mindmapLine(node, id)
    case 'group':
      // 移植上板的图表整批会打成一个组(见 groupDiagramBatch)⇒ 组节点现在是画布常客。
      // 报成员数 + **整组删除的具体命令**:删除 = 整板 overwrite,一次删完 vs 逐个删差几十倍
      // API 调用,所以这里直接把省事的走法递到 agent 眼前(expandDeleteIds 会连带全部成员)。
      // ⚠ 措辞必须与 CLI 实际行为一致 —— 曾写成「删组只解散、不删成员」,与连带删除正好相反。
      return `[组] ${id} at(${_num(node.x)},${_num(node.y)}) 含 ${Array.isArray(node.children) ? node.children.length : 0} 个成员(整组删除:board-del-node ${id} —— 连带全部成员,只重写画板一次)`
    case 'paint':
      return _paintLine(node, id)
    default:
      return `[${type || 'unknown'}] ${id} at(${_num(node.x)},${_num(node.y)})`
  }
}

// nodes → {lines, total, truncated}。超过 opts.limit(默认 300)只出前 limit 行并标 truncated。
function digestNodes(nodes, opts = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  const total = list.length
  const limit = (opts && Number.isFinite(opts.limit) && opts.limit >= 0) ? Math.floor(opts.limit) : 300
  const truncated = total > limit
  const slice = truncated ? list.slice(0, limit) : list
  return { lines: slice.map(_lineFor), total, truncated }
}

// ── digestComments ─────────────────────────────────────────────────────────
// 把飞书云文档/画板评论(GET /drive/v1/files/:token/comments 的 items)整形成给模型看的
// 紧凑摘要:每条主评论一行 + 后续回复各一缩进行,顺带把图片 token 收集出来供 agent 取图。
// 全程防御式:任何字段残缺都不抛错。产品语义 —— 摘要给 agent 看「待处理意见」,故已解决评论
// 默认跳过(opts.includeSolved 才列)。
//
// 真机形状(2026-07-21 生产画板实测):图片不在 elements 里,而在 reply.extra.image_list
// (token 字符串数组);elements 元素形如 {type, text_run, docs_link, person},非活动字段为 null,
// 故按 element.type 派发。另保留「元素对象里含 image/attachment 字样的键」的防御式内嵌图识别
// (以防未来出现内嵌图片元素)。

// 图片 token 抽取:字符串即 token;数组/对象里递归找 token/file_token/image_key 等常见字段
const _TOKEN_KEYS = ['token', 'file_token', 'image_key', 'file_key', 'image_token', 'media_id']
function _imageTokensFrom(val) {
  const out = []
  const visit = (v) => {
    if (v == null) return
    if (typeof v === 'string') { if (v) out.push(v); return }
    if (Array.isArray(v)) { for (const x of v) visit(x); return }
    if (typeof v === 'object') {
      for (const k of _TOKEN_KEYS) {
        if (typeof v[k] === 'string' && v[k]) { out.push(v[k]); return }
      }
    }
  }
  visit(val)
  return out
}

// 元素对象里第一个含 image/attachment 字样、且值非空的键(防御式内嵌图识别;'type' 不算)
function _imageKeyOf(el) {
  for (const k of Object.keys(el)) {
    if (k === 'type') continue
    if (/image|attachment/i.test(k) && el[k] != null) return k
  }
  return null
}

// 渲染单个 content 元素为一小段文本,顺带把图片 token 收进 imageTokens
function _renderElement(el, imageTokens) {
  if (el == null) return ''
  if (typeof el === 'string') return el
  if (typeof el !== 'object') return ''
  const type = typeof el.type === 'string' ? el.type : ''
  // 图片:类型名含 image/attachment,或对象里有 image/attachment 字样的键
  const imgKey = _imageKeyOf(el)
  if (/image|attachment/i.test(type) || imgKey) {
    const val = imgKey ? el[imgKey] : el
    for (const t of _imageTokensFrom(val)) imageTokens.push(t)
    return '[图]'
  }
  switch (type) {
    case 'text_run': return _extractText(el.text_run)
    case 'docs_link': return '[链接]'
    case 'person': return '[@某人]'
    case '': break // 无 type,退到按活动键推断
    default: return `[${type}]`
  }
  // 无 type 兜底:按哪个键有值推断
  if (el.text_run != null) return _extractText(el.text_run)
  if (el.docs_link != null) return '[链接]'
  if (el.person != null) return '[@某人]'
  return '[unknown]'
}

// 渲染一条回复的正文:content.elements 逐段拼接;图片在回复级 reply.extra.image_list(裸 token
// 字符串数组,纯文字回复该字段为空数组),按其长度在文本尾追加 " [图×N]" 占位并收集 token。
function _renderReply(reply, imageTokens) {
  if (!reply || typeof reply !== 'object') return ''
  const content = reply.content
  const elements = (content && Array.isArray(content.elements)) ? content.elements : []
  let text = ''
  for (const el of elements) text += _renderElement(el, imageTokens)
  const extra = reply.extra
  const imgs = (extra && Array.isArray(extra.image_list)) ? extra.image_list : []
  if (imgs.length) {
    for (const tok of imgs) for (const t of _imageTokensFrom(tok)) imageTokens.push(t)
    text += (text ? ' ' : '') + `[图×${imgs.length}]`
  }
  return text
}

// 一条主评论 → 行数组:主行 + 每条后续回复一缩进行(imageTokens 就地累积)
function _commentLines(c, imageTokens) {
  const out = []
  const id = (c.comment_id != null) ? String(c.comment_id) : (c.id != null ? String(c.id) : '?') // 与 boardwatch.unresolvedCommentIds 同款回退 —— id 显示「?」会让 agent 无法 resolve
  const status = c.is_solved ? '已解决' : '未解决'
  const wholePart = c.is_whole ? '' : ' 局部'
  const quote = _extractText(c.quote)
  const quotePart = quote ? ` 引用:"${_clip(quote, 40)}"` : ''
  const replies = (c.reply_list && Array.isArray(c.reply_list.replies)) ? c.reply_list.replies : []
  const firstText = replies.length ? _renderReply(replies[0], imageTokens) : ''
  out.push(`[评论] ${id}(${status})${wholePart}${quotePart} "${_clip(firstText, 80)}"`)
  for (let i = 1; i < replies.length; i++) {
    const r = replies[i]
    const rid = (r && r.reply_id != null) ? String(r.reply_id) : '?'
    out.push(`  ↳ ${rid} "${_clip(_renderReply(r, imageTokens), 80)}"`)
  }
  return out
}

// comments → {lines, total, truncated, imageTokens}。
// 已解决评论默认跳过(opts.includeSolved=true 才列);total = 参与列出的主评论数;
// 超过 opts.limit(默认 100)只出前 limit 条并标 truncated;imageTokens 仅收已列出评论的图。
function digestComments(comments, opts = {}) {
  const list = Array.isArray(comments) ? comments : []
  const includeSolved = !!(opts && opts.includeSolved)
  const limit = (opts && Number.isFinite(opts.limit) && opts.limit >= 0) ? Math.floor(opts.limit) : 100
  const listable = list
    .map((c) => (c && typeof c === 'object') ? c : {})
    .filter((c) => includeSolved || !c.is_solved)
  const total = listable.length
  const truncated = total > limit
  const slice = truncated ? listable.slice(0, limit) : listable
  const imageTokens = []
  const lines = []
  for (const c of slice) for (const ln of _commentLines(c, imageTokens)) lines.push(ln)
  return { lines, total, truncated, imageTokens }
}

// ── nextImagePosition ──────────────────────────────────────────────────────
// 确定性摆放:取现有「有几何」节点(x/width 均为有限数)的最右缘 + gap 作为 x,
// 这些节点里最靠上的 y 作为 y。没有任何有几何节点则回原点 {0,0}。
function nextImagePosition(nodes, width, height, gap = 40) {
  const list = Array.isArray(nodes) ? nodes : []
  let maxRight = -Infinity
  let topY = Infinity
  let found = false
  for (const n of list) {
    if (!n || typeof n !== 'object') continue
    if (Number.isFinite(n.x) && Number.isFinite(n.width)) {
      found = true
      const right = n.x + n.width
      if (right > maxRight) maxRight = right
      if (Number.isFinite(n.y) && n.y < topY) topY = n.y
    }
  }
  if (!found) return { x: 0, y: 0 }
  const g = Number.isFinite(gap) ? gap : 40
  return { x: maxRight + g, y: Number.isFinite(topY) ? topY : 0 }
}

// 参照摆放(改图的新图要与原图排在一起):新图放参照节点(被改的原图,
// agent 从标注箭头的吸附目标拿 id)右侧同 y —— 版本演进横向一排,对比一眼可见。
// 同排已有多张(多轮迭代 V1→V2→V3)时不叠图:凡与参照垂直区间重叠(同排)的节点都算占位,
// 取其中最右者的右边界 + gap。参照 id 找不到(被删/整板重写后 id 变)→ 回退全局
// nextImagePosition 并标 fallback:true,调用方据此提示「先 board-nodes 重读」。
function besideImagePosition(nodes, refId, width, height, gap = 40) {
  const list = Array.isArray(nodes) ? nodes : []
  const ref = list.find((n) => n && n.id === refId && Number.isFinite(n.x) && Number.isFinite(n.width))
  if (!ref) return { ...nextImagePosition(list, width, height, gap), fallback: true }
  const refTop = Number.isFinite(ref.y) ? ref.y : 0
  const refBottom = refTop + (Number.isFinite(ref.height) ? ref.height : 0)
  let right = ref.x + ref.width
  for (const n of list) {
    if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.width) || !Number.isFinite(n.y)) continue
    const bottom = n.y + (Number.isFinite(n.height) ? n.height : 0)
    if (bottom <= refTop || n.y >= refBottom) continue // 不同排,不挡道
    const r = n.x + n.width
    if (r > right) right = r
  }
  return { x: right + (Number.isFinite(gap) ? gap : 40), y: refTop }
}

// 参照摆放(图表版,2026-07-24):新图表放参照节点右侧同排,与 besideImagePosition 同款语义,但把
// 参照的纵向占位带**扩到入图高度**(图表往往比原图高 —— 只按参照自身高度扫会漏掉带下方的遮挡节点)。
// 参照的纵向区间 = [refTop, refTop + max(参照高, 入图高)];扫与该带相交节点的最右缘 + gap,y = 参照顶。
// 参照 id 找不到(被删/整板重写后 id 变)→ 回退全局 nextImagePosition 并标 fallback:true。纯函数可单测。
function besideRegionPosition(nodes, refId, width, height, gap = 40) {
  const list = Array.isArray(nodes) ? nodes : []
  const ref = list.find((n) => n && n.id === refId && Number.isFinite(n.x) && Number.isFinite(n.width))
  if (!ref) return { ...nextImagePosition(list, width, height, gap), fallback: true }
  const refTop = Number.isFinite(ref.y) ? ref.y : 0
  const refH = Number.isFinite(ref.height) ? ref.height : 0
  const inH = Number.isFinite(height) ? height : 0
  const bandBottom = refTop + Math.max(refH, inH) // 占位带扩到入图高度
  let right = ref.x + ref.width
  for (const n of list) {
    if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.width) || !Number.isFinite(n.y)) continue
    const bottom = n.y + (Number.isFinite(n.height) ? n.height : 0)
    if (bottom <= refTop || n.y >= bandBottom) continue // 不在这条带上,不挡道
    const r = n.x + n.width
    if (r > right) right = r
  }
  return { x: right + (Number.isFinite(gap) ? gap : 40), y: refTop }
}

// ── annotationFocusRegion ──────────────────────────────────────────────────
// 播报卡预览图聚焦(整板导出图太大、看不清标注)—— 算出「新标注附近」在
// 整板导出图上的像素裁剪框。纯几何零 IO,可单测;裁剪执行(sips)在 feishu.js。
// 映射假设:导出图 = 整板内容 bbox 的等比渲染(边距未知)⇒ 分别按 x/y 线性映射 + 大 padding
// 容忍 ±10% 偏差(裁大一点标注必在画面,好过裁准但偏移丢标注)。

// 单节点几何 bbox:常规节点 x/y/width/height;connector 用两端点坐标(吸附端无坐标由调用方
// 并入目标节点 bbox);paint 用点列包围盒。无几何返回 null。
function _nodeGeoBBox(n) {
  if (!n || typeof n !== 'object') return null
  const pts = _pointsBBox(n)
  if (pts) return pts
  if (n.type === 'connector' || n.connector) {
    const c = (n.connector && typeof n.connector === 'object') ? n.connector : {}
    const xs = []
    const ys = []
    for (const side of [c.start, c.end]) {
      const p = side && typeof side === 'object' && side.position && typeof side.position === 'object' ? side.position : null
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { xs.push(p.x); ys.push(p.y) }
    }
    if (xs.length) return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
  }
  if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
    const w = Number.isFinite(n.width) ? n.width : 0
    const h = Number.isFinite(n.height) ? n.height : 0
    return { minX: n.x, minY: n.y, maxX: n.x + w, maxY: n.y + h }
  }
  return null
}

function _unionBox(a, b) {
  if (!a) return b
  if (!b) return a
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }
}

// connector 新标注吸附的目标节点 id(标注指向的原图应一起入画)
function _connectorTargets(n) {
  const c = (n && n.connector && typeof n.connector === 'object') ? n.connector : {}
  const out = []
  for (const [obj, side] of [[c.start_object, c.start], [c.end_object, c.end]]) {
    const id = _attachedId(obj) || _attachedId(side && side.attached_object)
    if (id) out.push(id)
  }
  return out
}

// allNodes=整板全量(定映射基准),freshNodes=本轮新增标注。返回 {x,y,w,h}(整数像素)或
// null(不值得裁:无几何 / 聚焦区≈全图 / 映射不可用)。
function annotationFocusRegion(allNodes, freshNodes, imgW, imgH, { pad = 0.2, minWidthRatio = 0.22, maxTallRatio = 1.3, skipRatio = 0.8 } = {}) {
  if (!(imgW > 0) || !(imgH > 0)) return null
  const all = Array.isArray(allNodes) ? allNodes : []
  const fresh = Array.isArray(freshNodes) ? freshNodes : []
  let board = null
  const byId = new Map()
  for (const n of all) {
    if (n && n.id != null) byId.set(String(n.id), n)
    board = _unionBox(board, _nodeGeoBBox(n))
  }
  if (!board || !(board.maxX > board.minX) || !(board.maxY > board.minY)) return null
  let focus = null
  for (const n of fresh) {
    focus = _unionBox(focus, _nodeGeoBBox(n))
    for (const tid of _connectorTargets(n)) focus = _unionBox(focus, _nodeGeoBBox(byId.get(tid)))
  }
  if (!focus) return null
  // 画板坐标 → 图片像素(x/y 各自线性)
  const sx = imgW / (board.maxX - board.minX)
  const sy = imgH / (board.maxY - board.minY)
  let x0 = (focus.minX - board.minX) * sx
  let y0 = (focus.minY - board.minY) * sy
  let x1 = (focus.maxX - board.minX) * sx
  let y1 = (focus.maxY - board.minY) * sy
  // padding 外扩(每边按区域尺寸比例,且不低于图宽 8% —— 点状标注也要带出周边上下文)
  const padX = Math.max((x1 - x0) * pad, imgW * 0.05)
  const padY = Math.max((y1 - y0) * pad, imgW * 0.05)
  x0 -= padX; x1 += padX; y0 -= padY; y1 += padY
  // 最小宽(看得清)与最大高宽比(别又是竖长条)
  const minW = imgW * minWidthRatio
  if (x1 - x0 < minW) { const cx = (x0 + x1) / 2; x0 = cx - minW / 2; x1 = cx + minW / 2 }
  if (y1 - y0 > (x1 - x0) * maxTallRatio) {
    const targetW = (y1 - y0) / maxTallRatio
    const cx = (x0 + x1) / 2
    x0 = cx - targetW / 2; x1 = cx + targetW / 2
  }
  // clamp 图内(先平移后截断)
  if (x0 < 0) { x1 -= x0; x0 = 0 }
  if (y0 < 0) { y1 -= y0; y0 = 0 }
  if (x1 > imgW) { x0 = Math.max(0, x0 - (x1 - imgW)); x1 = imgW }
  if (y1 > imgH) { y0 = Math.max(0, y0 - (y1 - imgH)); y1 = imgH }
  // 仍太高(图不够宽扩不动)→ 截高:以聚焦中心为准保标注
  if (y1 - y0 > (x1 - x0) * maxTallRatio) {
    const focusCy = ((focus.minY - board.minY) * sy + (focus.maxY - board.minY) * sy) / 2
    const half = ((x1 - x0) * maxTallRatio) / 2
    y0 = Math.max(0, focusCy - half); y1 = Math.min(imgH, focusCy + half)
  }
  const w = Math.round(x1 - x0)
  const h = Math.round(y1 - y0)
  if (!(w > 0) || !(h > 0)) return null
  if (w * h >= imgW * imgH * skipRatio) return null // 聚焦区≈全图,不值得裁
  return { x: Math.round(x0), y: Math.round(y0), w, h }
}

// 「按标注改」结果卡(Card JSON 2.0;board-add-image --deliver 用它,回填进原播报卡或新发)。
// 图在卡内 + 可选说明 + 打开画布按钮。纯函数注入 redact(title/note 是 agent 输入)。
// ⚠ 2.0 button:样式=type、文字=text 对象(写成 button_style/content 渲染空白,v0.6.8 踩过)。
function buildDeliverCard({ imgKey = null, boardUrl = null, title = '已按标注改图', note = '', redact = (s) => s } = {}) {
  const t = redact(String(title || '已按标注改图'))
  const elements = []
  if (imgKey) elements.push({ tag: 'img', img_key: imgKey, scale_type: 'fit_horizontal', corner_radius: '8px', preview: true, alt: { tag: 'plain_text', content: t } })
  if (note) elements.push({ tag: 'markdown', content: redact(String(note)) })
  if (boardUrl) elements.push({ tag: 'hr' }, { tag: 'button', type: 'primary', width: 'fill', text: { tag: 'plain_text', content: '打开设计画布' }, behaviors: [{ type: 'open_url', default_url: boardUrl }] })
  if (!elements.length) elements.push({ tag: 'markdown', content: t }) // 防御:空元素卡可能被飞书拒
  return {
    schema: '2.0', config: { width_mode: 'default' },
    header: { title: { tag: 'plain_text', content: `✓ ${t}` }, template: 'green' },
    body: { padding: '16px', vertical_spacing: '12px', elements },
  }
}

// ── diagramSpec ────────────────────────────────────────────────────────────
// 图表通道(Mermaid/PlantUML → 画板 nodes/plantuml 端点):把「文件名 + 选项」解析成端点要的三个
// 枚举参数 {syntaxType, diagramType, styleType}。纯校验零 IO,可单测;全部中文报错。
//   syntax:  --syntax 覆盖 > 扩展名识别(.mmd/.mermaid=mermaid,.puml/.plantuml/.uml=plantuml)>
//            识别不出则报错要求 --syntax 指定
//   type:    --type → diagram_type;缺省 0(飞书自动识别);非法值报可用列表(认中英别名)
//   style:   缺省 1(多节点可编辑 —— 标注箭头能吸附到具体图形,契合按标注改闭环);--as-image ⇒ 2(整张图片)
const DIAGRAM_TYPES = {
  mindmap: 1, sequence: 2, activity: 3, class: 4, er: 5, flow: 6, usecase: 7, component: 8,
  思维导图: 1, 时序图: 2, 活动图: 3, 类图: 4, ER图: 5, 流程图: 6, 用例图: 7, 组件图: 8, 架构图: 8,
}
const SYNTAX_BY_EXT = { mmd: 2, mermaid: 2, puml: 1, plantuml: 1, uml: 1 }
const _DIAGRAM_TYPE_NAMES = 'mindmap/sequence/activity/class/er/flow/usecase/component,或中文别名 思维导图/时序图/活动图/类图/ER图/流程图/用例图/组件图/架构图'

function diagramSpec(fileName, { type, syntax, asImage } = {}) {
  // 语法类型:1=PlantUML 2=Mermaid
  let syntaxType
  if (syntax != null && String(syntax).trim()) {
    const s = String(syntax).trim().toLowerCase()
    if (s === 'mermaid') syntaxType = 2
    else if (s === 'plantuml') syntaxType = 1
    else throw new Error(`未知的图表语法 '${syntax}'(可用:mermaid | plantuml)`)
  } else {
    const ext = String(fileName || '').split('.').pop().toLowerCase()
    syntaxType = SYNTAX_BY_EXT[ext]
    if (!syntaxType) throw new Error('无法从扩展名识别图表语法(.mmd/.mermaid=mermaid,.puml/.plantuml/.uml=plantuml)—— 请用 --syntax mermaid|plantuml 指定')
  }
  // 图类型:0=自动识别(缺省)
  let diagramType = 0
  if (type != null && String(type).trim()) {
    const key = String(type).trim()
    const mapped = DIAGRAM_TYPES[key] != null ? DIAGRAM_TYPES[key] : DIAGRAM_TYPES[key.toLowerCase()]
    if (mapped == null) throw new Error(`未知的图类型 '${type}'(可用:${_DIAGRAM_TYPE_NAMES})`)
    diagramType = mapped
  }
  // 样式:1=多节点可编辑,2=服务端渲成整张图片。⚠ style=2 只支持 PlantUML —— Mermaid 传 2
  // 恒被拒(invalid arg 2890002,2026-07-27 真机枚举坐实;v0.7.5 拿它做交付卡预览因此从未生效)
  // ⇒ mermaid 恒给 1,整图(--as-image)由「导出暂存板+白边裁剪」实现(bin renderDiagramToPng),
  // 不经 styleType 表达;plantuml 的 --as-image 兜底直渲仍可用官方整图。
  const styleType = (asImage && syntaxType === 1) ? 2 : 1
  return { syntaxType, diagramType, styleType }
}

// ── 图表移植(scratch 渲染 → 主画板搬运)纯函数(v0.7.2)────────────────────────
// 真机事实(v0.7.0 验证):plantuml 端点无位置参数 —— 渲染直接压在主画板已有内容上,且 Mermaid
// 生成的容器子节点用 overwrite 法删不掉。解法:让端点只在群里看不见的 scratch 画板上渲染,读回后
// 净化+平移成普通节点批量写进主画板算定的空白区 ⇒ 位置可控、可删除、可标注吸附。以下三个纯函数
// 承担「净化 / 平移 / 报错字段解析」,IO(建 scratch/渲染/读回/POST)在 bin 接线。

// 一组节点的并集几何包围盒(union of _nodeGeoBBox);无任何有几何节点返回 null。
// 移植用它算「图表节点集自身 bbox」(定平移量)与「主画板全部内容 bbox」(定默认落点=最右空白区)。
function nodesBBox(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  let box = null
  for (const n of list) box = _unionBox(box, _nodeGeoBBox(n))
  return box
}

// 净化:把从 scratch 读回的图表节点整理成可 POST 回主画板的节点。
//  · 剔 `children`(只读派生字段,原样 POST 会被拒)
//  · **保留原 id 作批内局部引用** —— connector 的吸附 id / mind_map 的 parent_id 引用同批其它节点,
//    官方「一批 nodes 内可建父子/连接引用」语义,服务端会统一改写 id;这是移植保真的关键假设
//    (v0.7.2 真机待验点)。
//  · dropKeys 里的顶层键逐个剔(遇 99992402 字段校验失败时,把服务端点名的输出型字段剔掉重试)
// 纯函数不改入参(浅拷每个节点的顶层键;值引用原对象,平移在 shiftDiagramNodes 里深拷)。
function sanitizeDiagramNodes(nodes, dropKeys = []) {
  const drop = new Set(['children', ...(Array.isArray(dropKeys) ? dropKeys : [])])
  const list = Array.isArray(nodes) ? nodes : []
  return list.map((n) => {
    if (!n || typeof n !== 'object') return n
    const out = {}
    for (const k of Object.keys(n)) { if (!drop.has(k)) out[k] = n[k] }
    return out
  })
}

function _shiftPos(p, dx, dy) {
  if (p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y)) { p.x += dx; p.y += dy }
}

// 平移:把净化后的图表节点整体平移 (dx,dy)。深拷后就地改,不动入参。移的是**绝对坐标**位:
//  · 顶层 x/y(所有节点的锚点)
//  · connector 自由端 start/end.position(绝对;吸附端 position 是 0~1 相对量,有 attached_object 就不动)
//  · paint 自由笔迹点列(绝对;有点列则以点列为几何,不动 x/y 免双移)
// 不动的相对量:connector.turning_points(相对连接线自身原点,随顶层 x/y 平移自动跟随)、
// connector.*_object.position(吸附点 0~1 相对量)。纯函数可单测。
function shiftDiagramNodes(nodes, dx, dy) {
  const list = Array.isArray(nodes) ? nodes : []
  return list.map((n) => {
    if (!n || typeof n !== 'object') return n
    const c = JSON.parse(JSON.stringify(n))
    // 点列识别必须与 _pointsBBox 同款三形态(顶层 points / paint.points / paint.lines 嵌套),
    // 且点支持 {x,y} 与 [x,y] 两种 —— 少认一种就会「bbox 算了它、平移漏了它」,既滞留该节点又
    // 带偏整批落点(审查 #2)。空点列视同无点列,回落 x/y 平移。
    const rawPts = Array.isArray(c.points) ? c.points
      : (c.paint && Array.isArray(c.paint.points)) ? c.paint.points
        : (c.paint && Array.isArray(c.paint.lines)) ? c.paint.lines.flatMap((l) => Array.isArray(l) ? l : (l && Array.isArray(l.points)) ? l.points : [])
          : null
    if (rawPts && rawPts.length) {
      for (const pt of rawPts) { // 笔迹几何在点列(绝对),不动 x/y 免双移
        if (Array.isArray(pt)) { if (Number.isFinite(pt[0])) pt[0] += dx; if (Number.isFinite(pt[1])) pt[1] += dy }
        else _shiftPos(pt, dx, dy)
      }
    } else {
      if (Number.isFinite(c.x)) c.x += dx
      if (Number.isFinite(c.y)) c.y += dy
    }
    const conn = c.connector
    if (conn && typeof conn === 'object') {
      for (const k of ['start', 'end']) {
        const side = conn[k]
        if (side && typeof side === 'object' && !side.attached_object && side.position) _shiftPos(side.position, dx, dy)
      }
    }
    return c
  })
}

// 整批打组:把移植批(图表本体 + 可选标签)包成一个 group,让画板上能整体拖动。
// **组关系由成员写 parent_id 建立**,不是给 group 塞 children —— `node.children` 官方标 read_only,
// 写它服务端静默丢弃、只建出一个空组(2026-07-27 v0.7.8 真机「接受≠生效」的根因,2026-07-28 探针定案)。
// 同批定死的另两条:
//   ① 组几何**不派生** —— 省略 x/y/width/height 只拿到默认 (100,100) 120×100,组框与内容错位 ⇒ 显式给成员并集 bbox;
//   ② 成员挂组后 x/y **仍是画布绝对坐标**(group 是软组合不建坐标系;导出图对照:挂进原点 (600,400) 的组、
//      传 (0,0) 的图形与不挂组传 (0,0) 的图形完全重叠)⇒ 调用方的平移落点无需换算。
// 只给**没有父**的节点挂组(图表自带容器父子的不去抢);group 放**批首**(成员引用批内先出现的 id,与探针形态一致)。
// 无有效几何/空数组 ⇒ 原样返回不打组(groupLocalId=null),调用方据此如实措辞。纯函数不改入参(浅拷)。
function groupDiagramBatch(nodes, localId = 'dgrp1') {
  const list = Array.isArray(nodes) ? nodes : []
  const box = list.length ? nodesBBox(list) : null
  if (!box) return { batch: list, groupLocalId: null }
  const members = list.map((n) => (n && typeof n === 'object' && !n.parent_id) ? { ...n, parent_id: localId } : n)
  const group = { id: localId, type: 'group', x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY }
  return { batch: [group, ...members], groupLocalId: localId }
}

// 删除展开:删容器/树根时连带其内容,并清掉因此变空的组。**目的是省飞书 API 调用**。
// 背景(2026-07-28 真机实测,ops journal + turn ledger 双向对齐):画板没有删除端点,删 = 全量
// overwrite,**每删一次整板 id 全换**(相邻两次 rewrite 的 id 交集恒为 0)⇒ 逐个删除不但慢,还
// 逼得调用方每轮重读。真机一轮删 34 个节点 = 34 次 CLI 调用 ≈ 100 次 API 调用 / 270 秒;展开后
// 同一件事 = 1 次调用 / 2 次 API(读一次 + 写一次)。租户月配额是全公司共用的硬约束,这笔账要算。
// 三条规则:
//  ① 容器(group/section 等):顶层 parent_id 指向它的节点全部连带,递归(容器可嵌套)
//  ② mind_map:树关系在 `mind_map_node.parent_id`(**不在**顶层 parent_id,顶层归容器用)⇒
//     删某个导图节点连带它的整棵子树,否则剩下的子节点会挂在被删的父上成为悬空节点
//  ③ 收尾:成员被删光的 group 一并删掉 —— 否则画板上会积空组(真机已见一个 children=0 的残骸);
//     取到不动点为止(空组被删可能让它的父组也变空)
// 纯函数。返回展开后的 id 全集 + `cascaded`(连带进来的部分)—— 删除是破坏性动作,调用方必须
// 如实把「多删了什么」报给用户,不能静默扩大。
function expandDeleteIds(nodes, ids) {
  const list = Array.isArray(nodes) ? nodes : []
  const requested = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => x != null && x !== ''))]
  const childrenOf = new Map() // 顶层 parent_id 反查(容器语义)
  const mmChildrenOf = new Map() // mind_map_node.parent_id 反查(导图树语义)
  const put = (m, k, v) => { if (k == null || k === '') return; if (!m.has(k)) m.set(k, []); m.get(k).push(v) }
  for (const n of list) {
    if (!n || n.id == null) continue
    put(childrenOf, n.parent_id, n.id)
    put(mmChildrenOf, n.mind_map_node && n.mind_map_node.parent_id, n.id)
  }
  const out = new Set()
  const stack = [...requested]
  while (stack.length) { // 迭代式,天然防环(见过的不再入栈)
    const id = stack.pop()
    if (out.has(id)) continue
    out.add(id)
    for (const c of (childrenOf.get(id) || [])) if (!out.has(c)) stack.push(c)
    for (const c of (mmChildrenOf.get(id) || [])) if (!out.has(c)) stack.push(c)
  }
  for (let pass = 0; pass < 8; pass++) { // 空组清理到不动点(嵌套组;8 层封顶防病态数据死循环)
    let grew = false
    for (const n of list) {
      if (!n || n.type !== 'group' || n.id == null || out.has(n.id)) continue
      const mem = childrenOf.get(n.id) || []
      if (mem.length && mem.every((c) => out.has(c))) { out.add(n.id); grew = true }
    }
    if (!grew) break
  }
  const want = new Set(requested)
  return { ids: [...out], requested, cascaded: [...out].filter((id) => !want.has(id)) }
}

// 从飞书 99992402(字段校验失败)报错文本里解析出「被拒的节点字段名」,供移植 POST 逐个剔除重试。
// ⚠ 真机报错形态未知(v0.7.2 待验点)—— 防御式覆盖几种常见形态,解析不出返回 [](调用方据此停止
// 重试、降级 as-image)。只返回顶层可剔字段名(去重、滤掉明显的结构/协议词)。纯函数可单测。
function parseInvalidNodeFields(msg) {
  const s = String(msg == null ? '' : msg)
  const out = []
  const push = (f) => { if (f && !out.includes(f)) out.push(f) }
  // 形态一:JSON 路径 nodes[3].some_field(.sub…)→ 抽第一段
  for (const m of s.matchAll(/nodes\[\d+\]\.([A-Za-z_][\w]*)/g)) push(m[1])
  // 形态二:field "x" / field: x / 字段 x
  for (const m of s.matchAll(/(?:field|字段)[\s:="']*([A-Za-z_][\w]*)/gi)) push(m[1])
  // 形态三:'x' is invalid / x is not allowed / x 不合法/非法/不允许
  for (const m of s.matchAll(/['"`]?([A-Za-z_][\w]*)['"`]?\s+(?:is\s+(?:invalid|not\s+allowed)|不合法|非法|不允许)/gi)) push(m[1])
  const STOP = new Set(['field', 'fields', 'validation', 'failed', 'nodes', 'node', 'invalid', 'the', 'is', 'code', 'msg', 'error', 'request', 'param', 'params', 'value', 'id', 'type'])
  return out.filter((f) => !STOP.has(f.toLowerCase()))
}

// ── redactNodeTexts ────────────────────────────────────────────────────────
// board-add-nodes 出站脱敏:递归克隆节点数组,只对键名为 'text' 的**字符串**值套 redactFn ——
// 覆盖 text_shape/sticky_note/composite_shape 的 text.text、connector captions/caption 内的 text
// 等一切文本位;绝不改动 id / token / type 等结构字段(它们键名不是 'text',天然不碰)。纯函数不改入参。
function redactNodeTexts(nodes, redactFn = (s) => s) {
  const r = typeof redactFn === 'function' ? redactFn : (s) => s
  const walk = (v, key) => {
    if (typeof v === 'string') return (key === 'text') ? r(v) : v
    if (Array.isArray(v)) return v.map((x) => walk(x, key))
    if (v && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v)) out[k] = walk(v[k], k)
      return out
    }
    return v
  }
  return walk(nodes, null)
}

// ── PNG 解码/编码/白边裁剪(图表交付卡预览)──────────────────────────────────
// 背景(2026-07-27 真机):飞书整板导出(download_as_image)是固定 2560×2560 正方形画布,
// 内容等比 fit(带缩放上限)+ 水平居中 + 顶对齐,规则未公开 ⇒ 小图表四周大片留白,任何
// 「按板坐标映射像素」的裁剪都在赌未公开常数(annotationFocusRegion 的独立轴映射即前车之鉴)。
// scratch 暂存板上只有当前这张图表 ⇒ 对导出图做「非白内容包围盒」裁剪即得紧凑预览,完全
// 不依赖导出几何。零依赖纪律:PNG 手写解码(node:zlib inflate),支持位深 8、无隔行的
// 灰度/RGB/调色板/带α 全形态;不支持的形态/解码失败一律返回 null,调用方用原图兜底不阻断。

const zlib = require('node:zlib')

function _paethPredictor(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c)
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
}

// PNG → RGBA 平面 {width,height,px:Buffer(w*h*4)}。不校验 CRC(容错优先);任何不支持/异常 → null。
function decodePngRGBA(buf) {
  try {
    if (!_png(buf)) return null
    let w = 0; let h = 0; let bitDepth = 0; let colorType = -1; let interlace = 0
    let palette = null; let trns = null
    const idats = []
    for (let off = 8; off + 8 <= buf.length;) {
      const len = buf.readUInt32BE(off)
      const type = buf.toString('latin1', off + 4, off + 8)
      const data = buf.subarray(off + 8, off + 8 + len)
      if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12] }
      else if (type === 'PLTE') palette = data
      else if (type === 'tRNS') trns = data
      else if (type === 'IDAT') idats.push(data)
      else if (type === 'IEND') break
      off += 12 + len
    }
    if (!w || !h || w * h > 3000 * 3000) return null // 防呆:比飞书导出 2560² 略宽
    if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(colorType)) return null
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
    const stride = w * ch
    const raw = zlib.inflateSync(Buffer.concat(idats))
    if (raw.length < (stride + 1) * h) return null
    const flat = Buffer.alloc(stride * h) // 去 filter 后的原始通道平面
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)]
      const rowOff = y * (stride + 1) + 1
      const outOff = y * stride
      if (f > 4) return null
      for (let x = 0; x < stride; x++) {
        const rx = raw[rowOff + x]
        const a = x >= ch ? flat[outOff + x - ch] : 0
        const b = y > 0 ? flat[outOff - stride + x] : 0
        const c = (y > 0 && x >= ch) ? flat[outOff - stride + x - ch] : 0
        let v = rx
        if (f === 1) v = rx + a
        else if (f === 2) v = rx + b
        else if (f === 3) v = rx + ((a + b) >> 1)
        else if (f === 4) v = rx + _paethPredictor(a, b, c)
        flat[outOff + x] = v & 0xff
      }
    }
    // 统一转 RGBA
    const px = Buffer.alloc(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const s = i * ch; const d = i * 4
      if (colorType === 6) { px[d] = flat[s]; px[d + 1] = flat[s + 1]; px[d + 2] = flat[s + 2]; px[d + 3] = flat[s + 3] }
      else if (colorType === 2) { px[d] = flat[s]; px[d + 1] = flat[s + 1]; px[d + 2] = flat[s + 2]; px[d + 3] = 255 }
      else if (colorType === 0) { px[d] = px[d + 1] = px[d + 2] = flat[s]; px[d + 3] = 255 }
      else if (colorType === 4) { px[d] = px[d + 1] = px[d + 2] = flat[s]; px[d + 3] = flat[s + 1] }
      else { // 3: palette
        const pi = flat[s] * 3
        if (!palette || pi + 2 >= palette.length) return null
        px[d] = palette[pi]; px[d + 1] = palette[pi + 1]; px[d + 2] = palette[pi + 2]
        px[d + 3] = trns && flat[s] < trns.length ? trns[flat[s]] : 255
      }
    }
    return { width: w, height: h, px }
  } catch { return null }
}

// RGBA 平面 → PNG(位深 8 / colorType 6 / filter 0 / 无隔行)。CRC 手写表(Node 18 无 zlib.crc32)。
const _CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c }
  return t
})()
function _crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
function _chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(_crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function encodePngRGBA(px, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride) }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    _chunk('IHDR', ihdr), _chunk('IDAT', zlib.deflateSync(raw)), _chunk('IEND', Buffer.alloc(0)),
  ])
}

// 白边裁剪:找「非白且不透明」内容的包围盒,外扩 margin 后裁出。内容判定=α>16 且任一通道
// < threshold(浅色填充如 #EBF1FA 的 min 通道 235 < 245 ⇒ 判内容,纯白画布 255 ⇒ 白)。
// 返回裁剪后的 PNG Buffer;全白 / 收益太小(裁后仍 ≥ maxKeepRatio 面积)/ 形态不支持 → null,
// 调用方用原图。
function trimPngWhitespace(buf, { threshold = 245, margin = 24, maxKeepRatio = 0.9 } = {}) {
  const d = decodePngRGBA(buf)
  if (!d) return null
  const { width: w, height: h, px } = d
  let minX = w; let minY = h; let maxX = -1; let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (px[o + 3] > 16 && (px[o] < threshold || px[o + 1] < threshold || px[o + 2] < threshold)) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null // 全白
  minX = Math.max(0, minX - margin); minY = Math.max(0, minY - margin)
  maxX = Math.min(w - 1, maxX + margin); maxY = Math.min(h - 1, maxY + margin)
  const cw = maxX - minX + 1; const chh = maxY - minY + 1
  if (cw * chh >= w * h * maxKeepRatio) return null // 不值得裁
  const out = Buffer.alloc(cw * chh * 4)
  for (let y = 0; y < chh; y++) px.copy(out, y * cw * 4, ((minY + y) * w + minX) * 4, ((minY + y) * w + maxX + 1) * 4)
  return encodePngRGBA(out, cw, chh)
}

// 卡内预览图的高宽比封顶:超过 maxRatio 的竖长图左右补边居中,压回「一屏能看完」。
// 为什么在**上传前改图**而不是让卡片渲染端收着:2026-07-29 在生产机上用生产凭证跑过 cardkit
// 字段探针(只 card.create 不投递)—— `fit_horizontal`(按卡宽铺满、高自适应)加任何 size
// 一律被拒(`img size is not allowed`),size 只在配 `crop_center` 时才收;而 crop_* 是**裁剪**,
// 会切掉手机 UI 原型的上下两段(最不能接受),且 size 是死像素不随卡宽自适应。另有 `max_height`
// 这类「传了不报错」的字段:按本项目铁律 —— **服务端接受 ≠ 语义生效**(v0.7.9 给 group 塞只读
// 的 children 建出空组即前车之鉴)—— 未经目视确认的字段一律不采信。⇒ 只用纯客户端、确定性、
// 所有端一致的办法:把 9:19.5(≈2.17)的竖图补成 1.3,卡高压进约 1.3 倍卡宽,手机占卡宽约 60%。
//
// px = RGBA 平面(与 decodePngRGBA 同构)。高宽比已达标 ⇒ 原样返回 padded:false(零改动路径,
// 横图/方图不白花一次编解码;此时 px 与入参**同引用**,调用方按只读用,别就地改)。bg 缺省 =
// 采样原图四角求平均(手机原型的四角就是页面底色,补出来像刻意留白而不是贴错底);四角任一
// 通道极差 > 32(角上有内容/渐变)或任一角半透明 ⇒ 猜不准,纯白兜底。
// 不补白时带 `reason` 说明是哪一类(纯函数不打日志,原因交给调用方翻成人话):
//   within-ratio 比例本就达标 · bad-input 平面/尺寸不可用 · too-large 补出来的画布超内存上限。
function padToMaxAspect(px, width, height, { maxRatio = 1.3, bg = null } = {}) {
  const w = Number.isFinite(width) ? Math.floor(width) : 0
  const h = Number.isFinite(height) ? Math.floor(height) : 0
  let ratio = Number(maxRatio)
  if (!Number.isFinite(ratio) || ratio <= 0) ratio = 1.3 // 非法阈值退默认,别拿 NaN 去算新宽
  // 早返回也回传**取整后**的 w/h:调用方(bin 侧日志/后续几何)拿到的尺寸口径与补白路一致,
  // 不会因为入参是 100.7 就在两条路上看到两个数
  const asis = (reason) => ({ px, width: w, height: h, padded: false, reason })
  if (!Buffer.isBuffer(px) || w <= 0 || h <= 0) return asis('bad-input')
  if (h / w <= ratio) return asis('within-ratio')
  const newW = Math.ceil(h / ratio)
  // 内存闸:上游 decodePngRGBA 挡的是**输入** 3000²(9Mpx),而补白后的输出必然更宽 ——
  // 极端长条(w=1、h 很大)能算出几百 Mpx 的画布。故这里单设**输出** 4000²(16Mpx ≈ 64MB 平面)
  // 上限:比上游宽约 1.8 倍是刻意的,免得把 2000×4400 这种合法高清竖图挡在门外;再大就不补 ——
  // 交付原图要紧,不为排版赌内存。
  if (newW * h > 4000 * 4000) return asis('too-large')

  let fill = _normalizeBg(bg)
  if (!fill) fill = _cornerAvgColor(px, w, h)
  const out = Buffer.alloc(newW * h * 4)
  const bgRow = Buffer.alloc(newW * 4)
  for (let i = 0; i < newW; i++) bgRow.set(fill, i * 4)
  // 左右像素差 1 时**左少右多**(floor),固定口径,免得同一张图两次跑出不同结果
  const left = Math.floor((newW - w) / 2)
  for (let y = 0; y < h; y++) {
    out.set(bgRow, y * newW * 4)
    const s = y * w * 4
    if (s >= px.length) continue // px 被截断:这行只铺底色(仍是整幅,不留一块透明黑)
    const row = px.subarray(s, Math.min(s + w * 4, px.length))
    out.set(row, (y * newW + left) * 4)
  }
  return { px: out, width: newW, height: h, padded: true, reason: null }
}

// 显式底色:接受 [r,g,b] / [r,g,b,a];α 一律 255(卡片背景不透明,半透明补边会露出卡底)。
// 认不出的值 → null 交给四角采样,别让一个笔误的参数把整张图刷成黑色。
function _normalizeBg(bg) {
  if (!bg || typeof bg.length !== 'number' || bg.length < 3) return null
  const c = [0, 1, 2].map((i) => Number(bg[i]))
  if (c.some((v) => !Number.isFinite(v))) return null
  return [...c.map((v) => Math.max(0, Math.min(255, Math.round(v)))), 255]
}

function _cornerAvgColor(px, w, h) {
  const WHITE = [255, 255, 255, 255]
  const read = (x, y) => {
    const o = (y * w + x) * 4
    // α < 250 的角 = 透明底(logo/图标/透明底 mockup 常见):它的 RGB 多半是没意义的 0
    // ⇒ 直接判「猜不出」。不看 α 就会把全透明底采成 [0,0,0] ⇒ 卡片上两侧补出不透明黑框。
    return (o + 3 < px.length && px[o + 3] >= 250) ? [px[o], px[o + 1], px[o + 2]] : null
  }
  const cs = [read(0, 0), read(w - 1, 0), read(0, h - 1), read(w - 1, h - 1)]
  if (cs.some((c) => !c)) return WHITE // 数据不全 / 角是透明的:都别猜底色
  for (let ch = 0; ch < 3; ch++) {
    const vals = cs.map((c) => c[ch])
    if (Math.max(...vals) - Math.min(...vals) > 32) return WHITE // 四角明显不一致 ⇒ 角上有内容,猜不准
  }
  return [0, 1, 2].map((ch) => Math.round(cs.reduce((s, c) => s + c[ch], 0) / 4)).concat(255)
}

module.exports = { imageSize, digestNodes, digestComments, nodeText, nextImagePosition, besideImagePosition, besideRegionPosition, nodesBBox, sanitizeDiagramNodes, shiftDiagramNodes, groupDiagramBatch, expandDeleteIds, parseInvalidNodeFields, annotationFocusRegion, buildDeliverCard, diagramSpec, redactNodeTexts, decodePngRGBA, encodePngRGBA, trimPngWhitespace, padToMaxAspect }
