'use strict'
// 群里 /model 的「模型卡」。发 /model 不带参数 ⇒ 一张能点的卡:
//   后端一排按钮 · 型号一个下拉 · 思考深度一排按钮 + 「确认更新」「关闭」;确认后卡片收成一行回执(卡片本身就是回执,不另发消息);
//   10 分钟后过期翻只读(防止往上翻聊天记录时误点到几天前的老卡)。
// 纯函数、零依赖:飞书卡片 schema 2.0 的 JSON 形状只在此一处;样式与通知卡同一套(撑满宽 · 标题栏底色说类别 ·
//   注意事项与右下角小字用 notation 灰字;⚠ 2.0 不认 note 组件)。没有这种卡的平台(企微)由调用方退回文本回执。
// ⚠ 脱敏:型号 / 后端名来自配置与清单,没有用户输入;结果行里的人名来自平台,同样经 opts.redact。

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const DEFAULT_VALUE = '__default__' // 下拉里「跟随默认」那一项的值(选项值不能是空串)

const grey = (s, size = 'notation') => ({ tag: 'markdown', text_size: size, content: `<font color='grey'>${esc(s)}</font>` })

function button(label, { selected = false, value, disabled = false } = {}) {
  const b = { tag: 'button', text: { tag: 'plain_text', content: label }, type: selected ? 'primary_filled' : 'default', size: 'small', width: 'default' }
  if (disabled) b.disabled = true
  if (value) b.behaviors = [{ type: 'callback', value }]
  return b
}

// 一排按钮:flow 布局,窄屏自动折行
function buttonRow(buttons) {
  return { tag: 'column_set', flex_mode: 'flow', horizontal_spacing: '6px', horizontal_align: 'left', columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })) }
}

/**
 * 「先选、再确认」(点一下就生效容易点错):
 *   点后端 / 选型号 / 点深度只改**卡上的草稿**(卡片重画选中状态,什么都没生效);草稿与当前不同时出一行「将改为 … —— 会不会开新对话」,
 *   「确认更新」一次生效(只写一次、最多开一次新对话、审计一条),卡片收成一行回执;「关闭」什么都不改,卡片原地变成灰色「已关闭」。
 *   草稿随每个回调值带回去(无状态,守护进程重启也不丢):{ a:'mc', f:'p'|'m'|'e'|'s'|'ok'|'x', v?, d:{p,m,e,s?}, t }
 *   —— p 后端 · m 型号 · e 深度('' = 跟随默认)· s 速度('fast' | 'std',只在有速度这一行时带);下拉的选中值在回调的 action.option 里。
 * @param s {
 *   mode: 'edit' | 'receipt' | 'closed' | 'expired',  current: 'claude · claude-opus-5 · xhigh'(当前生效的)
 *   failover: '', quota: '',                          —— 额度临时切换那一句 / 缓存额度(有才给)
 *   draft: { p, m, e },                               —— edit:卡上正在选的
 *   backends: [{ name, selected }], model: { options: [{ value, label }], selected } | null(null = 这家型号到后台改),
 *   efforts: [{ value, label, selected }],            —— label 里由调用方标「(默认)」
 *   speeds: [{ value:'std'|'fast', label, selected }] | null, speedNote: ''  —— 这个型号有 Fast 档才有;null / 没给 ⇒ 不出这一行,卡与此前逐字节相同
 *   preview: { to, note } | null,                     —— 草稿与当前不同才有;null ⇒「确认更新」灰着
 *   receipt: { line, before },                        —— receipt:谁改成了什么 · 之前是什么
 *   issuedAt: 发卡 / 上次操作的时刻(写进回调值,10 分钟过期)
 * }
 */
function buildModelCard(s, { redact } = {}) {
  const r = typeof redact === 'function' ? (x) => String(redact(String(x))) : (x) => String(x)
  const mode = s.mode || (s.expired ? 'expired' : 'edit')
  const t = s.issuedAt || 0
  const d = { p: '', m: '', e: '', ...(s.draft || {}) }
  const cb = (f, v) => ({ a: 'mc', f, ...(v !== undefined ? { v } : {}), d, t })
  const els = []
  const head = (title, template, tag, tagColor) => ({
    title: { tag: 'plain_text', content: title },
    subtitle: { tag: 'plain_text', content: r(s.current || '') },
    template, text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: tag }, color: tagColor }],
    padding: '12px 12px 12px 12px',
  })
  let header
  if (mode === 'receipt') {
    // 确认之后:收成一行回执 —— 控件全收起(卡片就此「关闭」),群里留一条谁改成了什么
    header = head('模型已更新', 'green', '已更新', 'green')
    const rc = s.receipt || {}
    els.push({ tag: 'markdown', text_size: 'normal', content: esc(r(rc.line || '')) })
    if (rc.before) els.push(grey(r(rc.before)))
  } else if (mode === 'closed') {
    header = head('本群模型', 'grey', '已关闭', 'neutral')
    els.push(grey('已关闭 · 模型没变', 'normal'))
  } else if (mode === 'expired') {
    header = head('本群模型', 'grey', '已过期', 'neutral')
    els.push(grey('这张卡已过期,没有改任何东西 —— 发 /model 重新打开', 'normal'))
  } else {
    header = head('本群模型', 'indigo', '模型', 'indigo')
    const info = []
    if (s.failover) info.push(`**额度切换** ${esc(s.failover)}`)
    if (s.quota) info.push(`**额度** ${esc(s.quota)}`)
    if (info.length) els.push({ tag: 'markdown', text_size: 'normal', content: info.join('\n') })
    const backendBtns = buttonRow((s.backends || []).map((b) => button(b.name, { selected: b.selected, value: b.selected ? null : cb('p', b.name) })))
    let modelCtl
    if (s.model) {
      modelCtl = {
        tag: 'select_static', width: 'fill', type: 'default',
        placeholder: { tag: 'plain_text', content: '选一个型号' },
        initial_option: s.model.selected || DEFAULT_VALUE,
        options: s.model.options.map((o) => ({ text: { tag: 'plain_text', content: o.label }, value: o.value || DEFAULT_VALUE })),
        behaviors: [{ type: 'callback', value: cb('m') }],
      }
    } else modelCtl = grey('这个后端的型号在控制台改', 'normal')
    const effortBtns = buttonRow((s.efforts || []).map((e) => button(e.label || e.value, { selected: e.selected, value: e.selected ? null : cb('e', e.value || DEFAULT_VALUE) })))
    // 标签在上、控件在下(手机上五个深度按钮一排放得下)
    for (const [label, ctl] of [['后端', backendBtns], ['型号', modelCtl], ['思考深度', effortBtns]]) els.push(grey(label), ctl)
    // 速度:这个型号有 Fast 档才出;代价写在按钮下面的灰字里(点之前就看得到)
    const hasSpeed = Array.isArray(s.speeds) && s.speeds.length > 0
    if (hasSpeed) {
      els.push(grey('速度'), buttonRow(s.speeds.map((x) => button(x.label || x.value, { selected: x.selected, value: x.selected ? null : cb('s', x.value) }))))
      if (s.speedNote) els.push(grey(r(s.speedNote)))
    }
    els.push({ tag: 'hr' })
    if (s.preview) {
      els.push({ tag: 'markdown', text_size: 'normal', content: `**将改为** ${esc(s.preview.to)}` })
      if (s.preview.note) els.push(grey(s.preview.note))
    }
    els.push(buttonRow([
      button('确认更新', { selected: !!s.preview, value: s.preview ? cb('ok') : null, disabled: !s.preview }),
      button('关闭', { value: { a: 'mc', f: 'x', t } }),
    ]))
    els.push(grey(`选好后点「确认更新」才生效 · 换后端会开新对话，换型号或调深度${hasSpeed ? '或速度' : ''}接着当前对话 · 要等手头任务结束 · 10 分钟内有效 · 点不动时可直接发 /model high 这类文字`))
  }
  return { schema: '2.0', config: { width_mode: 'fill', update_multi: true }, header, body: { padding: '12px 12px 12px 12px', vertical_spacing: '8px', elements: els } }
}

module.exports = { buildModelCard, DEFAULT_VALUE }
