/* Injected into the console's existing script; no framework or extra connection. */
const activityPanel = (() => {
  let root, groupBody, listBody, taskBody, selected = '', count = 5
  try { selected = sessionStorage.getItem('sintbot.activity.group') || '' } catch {}
  let epoch = '', revision = -1, loaded = false, pending = null, frames = [], scheduled = false
  const rows = new Map(), groups = new Map(), detailCache = new Map(), detailPending = new Set(), detailErrors = new Map(), open = new Set()
  const groupNodes = new Map(), rowNodes = new Map(), actionPending = new Set()
  let lang = '', error = false, connected = true, focusBeforeRender = null, groupScroll = 0
  const key = r => r.chatId + ':' + r.id
  const en = () => langOf() === 'en'
  const tr = (zh, english) => en() ? english : zh
  const labels = {
    queued: ['排队', 'Queued'], running: ['运行中', 'Running'], sending: ['回复发送中', 'Sending reply'],
    answered: ['已回复', 'Replied'], silent: ['无需回复', 'No reply needed'], stopped: ['已停止', 'Stopped'],
    recalled: ['已撤回', 'Recalled'], timeout: ['已超时', 'Timed out'], error: ['失败', 'Failed'],
    'not-started': ['未启动', 'Not started'], unknown: ['结果待核实', 'Unconfirmed'],
    '已结账': ['历史记录已结账', 'Historical receipt settled'], '等待处理': ['等待处理', 'Waiting'],
  }
  const status = s => labels[s] ? tr(...labels[s]) : s
  const active = r => ['queued', 'running', 'sending', '等待处理'].includes(r.status)
  const num = n => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n)
  const stamp = ts => ts ? new Date(ts).toLocaleTimeString(en() ? 'en-GB' : 'zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: S?.timezone || 'Asia/Shanghai' }) : '—'
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
  const text = (n, value) => { if (n.textContent !== value) n.textContent = value }
  function schedule() {
    if (scheduled || document.hidden) return
    scheduled = true; requestAnimationFrame(() => { scheduled = false; paint() })
  }
  function setup() {
    if (root) return
    root = node('section', 'la'); root.setAttribute('data-i18n-skip', '')
    const style = node('style'); style.textContent = `
      .la{margin:20px 0}.la [hidden]{display:none!important}.la .la-panel{padding:0;overflow:hidden}
      .la .la-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px;border-bottom:1px solid var(--line)}
      .la h2{font-size:15px;font-weight:600;letter-spacing:0;margin:0}.la .la-capacity{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums;text-align:right}
      .la .la-select,.la .la-toggle{font:inherit;width:100%;border:0;border-radius:0;background:transparent;color:inherit;text-align:left;cursor:pointer;min-height:48px}
      .la .la-group{position:relative;display:flex;align-items:center;border-bottom:1px solid var(--line);transition:background .18s ease}.la .la-select{flex:1;min-width:0;display:grid;grid-template-columns:minmax(160px,1.2fr) minmax(120px,1fr) minmax(160px,1fr);gap:20px;padding:15px 20px 15px 24px}.la .la-select>div{min-width:0}
      .la .la-group:last-child{border-bottom:0}.la .la-group:before{content:'';position:absolute;inset:12px auto 12px 0;width:3px;border-radius:0 3px 3px 0;background:var(--ember);opacity:0;transform:scaleY(.4);transition:opacity .18s,transform .18s}
      .la .la-select strong,.la .la-select small,.la .la-model>span,.la .la-context>span{display:block;white-space:normal;overflow-wrap:anywhere}.la .la-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}.la .la-tags .tag{font-size:10px;padding:2px 6px}.la .la-tags [data-status=running]{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 30%,var(--line))}.la .la-tags [data-status=attention]{color:var(--fail)}.la .la-path{font-family:var(--mono);font-size:10.5px}
      .la .la-group:hover,.la .la-toggle:hover{background:color-mix(in srgb,var(--ember) 4%,transparent)}
      .la .la-group.selected{background:color-mix(in srgb,var(--ember) 7%,transparent)}.la .la-group.selected:before{opacity:1;transform:scaleY(1)}
      .la button:focus-visible{outline:2px solid var(--ember);outline-offset:-3px}.la button:active:not(:disabled){background:color-mix(in srgb,var(--ember) 11%,transparent)}
      .la small{display:block;color:var(--dim);font-size:11px;line-height:1.5;margin-top:4px}.la strong{font-size:13px;font-weight:600}.la .la-model{font-size:12px}.la .la-model small[data-status=running]{color:var(--ember)}.la .la-model small[data-status=attention]{color:var(--fail)}.la .la-context{font-size:12px;font-variant-numeric:tabular-nums}
      .la .la-track{height:3px;margin-top:8px;background:var(--line);overflow:hidden;border-radius:2px}.la .la-fill{height:100%;background:var(--ember);transform-origin:left;transition:transform .3s ease-out;transform:scaleX(0)}
      .la .la-groups{max-height:560px;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
      .la .la-task-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 0 12px}.la .la-task-head strong{font-size:14px;overflow-wrap:anywhere}
      .la .la-actions{display:flex;gap:6px;flex-shrink:0;padding-right:24px}.la .la-actions .iconbtn{padding:0;transition:background .15s,border-color .15s,transform .15s}.la .la-actions .iconbtn:active:not(:disabled){transform:scale(.92)}.la button:disabled{cursor:default;opacity:.45}
      .la .la-list{padding:0;overflow:hidden}.la .la-row{border-bottom:1px solid var(--line)}.la .la-row:last-child{border-bottom:0}
      .la .la-toggle{padding:16px 20px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;transition:background .15s}
      .la .la-title{font-size:13px;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:5px;overflow-wrap:anywhere}
      .la .la-preview{font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:5px}
      .la .la-state{font-size:11px;color:var(--dim);white-space:nowrap;padding-top:4px}.la .la-state:after{content:'';display:inline-block;width:5px;height:5px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(45deg);margin:0 2px 3px 14px;transition:transform .18s}
      .la [aria-expanded=true] .la-state:after{transform:rotate(225deg)}.la .la-state[data-state=running],.la .la-state[data-state=sending]{color:var(--ember)}
      .la .la-state[data-state=error],.la .la-state[data-state=unknown],.la .la-state[data-state=timeout]{color:var(--fail)}
      .la .la-fold{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .2s ease,opacity .2s ease}.la .la-fold.open{grid-template-rows:1fr;opacity:1}
      .la .la-fold-inner{min-height:0;overflow:hidden}.la .la-detail{padding:0 20px 18px;font-size:13px;line-height:1.7;overflow-wrap:anywhere}
      .la .la-detail .aexp{margin:0;max-height:360px;white-space:normal}.la .la-detail .aereply{white-space:pre-wrap}.la .la-detail .aemeta{gap:6px 16px;white-space:normal}.la .la-detail .la-source{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}.la .la-source summary{cursor:pointer;color:var(--dim);font-size:11px}.la .la-source summary:focus-visible{outline:2px solid var(--ember);outline-offset:3px}.la .la-detail .la-error{color:var(--fail)}.la .la-detail p{white-space:pre-wrap;margin:8px 0}.la .la-detail h3{font-size:11px;color:var(--dim);margin:16px 0 5px;font-weight:500}.la .la-notice{font-size:12px;color:var(--dim);margin:12px 0;line-height:1.6}
      .la .la-more{margin:12px auto 0;display:block;min-height:40px;font-size:12px}
      @media(max-width:640px){.la .la-head{padding:16px;gap:10px}.la .la-capacity{font-size:11px}.la .la-group{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start}.la .la-select{grid-column:1/-1;grid-row:1;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 16px;padding:14px 16px}.la .la-select>div:first-child{padding-right:94px;grid-column:1/-1}.la .la-actions{grid-column:2;grid-row:1;z-index:1;padding:14px 16px 0 0}.la .la-model{grid-column:1/-1}.la .la-context{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 8px}.la .la-context small{margin:0;font-size:10px}.la .la-track{grid-column:1/-1;margin-top:6px}.la .la-task-head{align-items:flex-start;flex-direction:column;gap:10px}.la .la-actions{flex-wrap:wrap}.la .la-toggle{grid-template-columns:minmax(0,1fr);gap:7px;padding:14px 16px}.la .la-state{white-space:normal;padding:0}.la .la-state:after{float:right}.la .la-detail{padding:0 16px 16px}}
      @media(prefers-reduced-motion:reduce){.la *{transition:none!important;animation:none!important}}`
    root.append(style)
    const panel = node('div', 'card la-panel'), head = node('div', 'la-head')
    head.append(node('h2'), node('span', 'la-capacity')); panel.append(head)
    groupBody = node('div', 'la-groups'); panel.append(groupBody); root.append(panel)
    const note = node('div', 'la-notice'); note.dataset.la = 'note'; note.setAttribute('role', 'status'); root.append(note)
    taskBody = node('div', 'la-task-body'); taskBody.hidden = true
    const bar = node('div', 'la-task-head'), title = node('strong'); title.dataset.la = 'activity'; bar.append(title)
    taskBody.append(bar)
    listBody = node('div', 'card la-list'); taskBody.append(listBody)
    const more = node('button', 'btn la-more'); more.dataset.la = 'more'; more.onclick = () => { count += 5; schedule() }; taskBody.append(more)
    root.append(taskBody)
  }
  async function act(action, button, chatId) {
    if (!chatId || button.disabled) return
    if (action === 'say') { openSay(chatId); return }
    const actionKey = chatId + ':' + action
    actionPending.add(actionKey); button.disabled = true
    try {
      const result = await api(action === 'stop' ? '/api/groups/stop' : '/api/groups/interrupt','POST',{chatId})
      toast(action === 'new' ? tr('已开新会话','New session started') : result.ok ? tr('已请求停止，等待结束确认','Stop requested; waiting for confirmation') : tr('当前没有可停止的运行任务','No running task to stop'),'ok')
      await sync()
    } catch (e) { toast(e.message,'err') }
    finally { actionPending.delete(actionKey); schedule() }
  }

  function groupNode(g) {
    let n = groupNodes.get(g.chatId)
    if (!n) {
      n = node('div', 'la-group'); n.dataset.chatId = g.chatId
      const select = node('button', 'la-select'); select.type = 'button'
      const a = node('div'), b = node('div', 'la-model'), c = node('div', 'la-context')
      const tags = node('div','la-tags'); tags.append(node('span','tag prov'),node('span','tag'))
      a.append(node('strong'), tags, node('small','la-path')); b.append(node('span'), node('small'))
      const track = node('div', 'la-track'); track.append(node('div', 'la-fill'))
      c.append(node('span'), node('small'), track); select.append(a, b, c); n.append(select)
      const actions = node('div','la-actions')
      for (const [action,icon] of [['say','say'],['stop','square'],['new','rotate']]) {
        const button = node('button','iconbtn sm'); button.type = 'button'; button.dataset.action = action
        button.innerHTML = IC[icon]; button.onclick = () => void act(action,button,g.chatId); actions.append(button)
      }
      n.append(actions)
      select.onclick = () => {
        if (selected === g.chatId) return
        selected = g.chatId; count = 5
        try { sessionStorage.setItem('sintbot.activity.group', selected) } catch {}
        schedule(); requestAnimationFrame(() => {
          if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
            taskBody.getAnimations().forEach(animation => animation.cancel())
            taskBody.animate([{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:180,easing:'ease-out'})
          }
        })
      }
      groupNodes.set(g.chatId, n)
    }
    const [a,b,c] = n.children[0].children, ctx = g.context
    text(a.children[0], g.name); text(a.children[2], g.workdir ? shortPath(g.workdir) : g.project)
    a.children[2].title = g.workdir || g.project
    text(a.children[1].children[0], g.runner === 'codex' ? 'codex' : 'claude')
    const state = a.children[1].children[1]
    text(state, g.held || g.queueFaulted ? tr('需要处理','Needs attention') : g.paused ? tr('已暂停','Paused') : g.finalizing ? tr('收尾中','Finishing') : g.waitingForCapacity ? tr('等待容量','Waiting for capacity') : g.busy ? 'busy' : 'idle')
    state.dataset.status = g.held || g.queueFaulted ? 'attention' : g.busy ? 'running' : 'idle'
    if (g.busy) text(state, state.textContent + ' ' + Math.floor((g.sinceMs || 0)/1000) + 's')
    if (g.queue) text(state, state.textContent + ' · ' + tr('排队 ','Queued ') + g.queue)
    text(b.children[0], g.model || tr('执行器默认（未回报实际型号）','Executor default (actual model unknown)'))
    text(b.children[1], tr('思考深度 · ','Reasoning · ') + (g.reasoningEffort || tr('默认','Default')))
    b.children[1].title = tr('当前模型配置；未指定时使用模型默认值','Current model configuration; unspecified uses the model default')
    const blocked = !S?.live?.running || g.paused || g.held || g.queueFaulted
    const busy = g.busy || g.pending > 0 || g.queue > 0 || g.waitingForCapacity || g.finalizing
    for (const [action,zh,eng] of [['say','插话','Message'],['stop','停止任务','Stop task'],['new','新会话','New session']]) {
      const button = n.querySelector('[data-action='+action+']')
      button.disabled = actionPending.has(g.chatId + ':' + action) || blocked || (action === 'stop' ? !busy : action === 'new' ? !!busy : !!g.sayBlocked)
      button.setAttribute('aria-label',tr(zh,eng) + ' · ' + g.name)
      button.title = tr(zh,eng) + ' · ' + (button.disabled ? tr('当前状态不可操作','Unavailable in the current state') : action === 'say' ? tr('这句话和回复都会发进该群','Your message and reply will be sent to this group') : action === 'new' ? tr('开始新会话，清除当前会话上下文','Start a new session with fresh context') : tr('停止当前任务，保留会话','Stop the task and keep the session'))
    }
    const valid = ctx?.usedTokens != null, capacity = ctx?.windowTokens > 0
    const percent = valid && capacity ? Math.round(ctx.usedTokens / ctx.windowTokens * 100) : null
    text(c.children[0], valid ? `${num(ctx.usedTokens)}${capacity ? ' / ' + num(ctx.windowTokens) + ' · ' + percent + '%' : ' · ' + tr('容量未知','capacity unknown')}` : ctx?.quality === 'compacted' ? tr('压缩后待上报','Awaiting usage after compaction') : !g.sessionId && !g.busy ? tr('未开始','No session') : tr('待上报','Awaiting usage'))
    const quality = ctx?.quality === 'reported' ? tr('上下文 · 最新上报','Context · Latest report') : ctx?.quality === 'historical' ? tr('上下文 · 历史采样','Context · Historical sample') : tr('上下文 · 上次上报','Context · Last report')
    text(c.children[1], ctx ? quality + ' · ' + stamp(ctx.measuredAt) : tr('上下文','Context'))
    c.children[2].children[0].style.transform = 'scaleX(' + (percent == null ? 0 : Math.max(0, Math.min(100, percent)) / 100) + ')'
    n.title = g.name + ' · ' + g.project + ' · ' + g.model + ' · ' + g.chatId.slice(-6)
    n.classList.toggle('selected',selected === g.chatId); n.children[0].setAttribute('aria-pressed', String(selected === g.chatId)); return n
  }
  async function showDetail(r, n) {
    const k = key(r), body = n.querySelector('.la-detail')
    if (!open.has(k)) return
    if (!r.details) { text(body, tr('历史记录未保存消息和回复详情。','Message and reply details were not recorded.')); return }
    if (detailErrors.get(k) === r.detailRevision) return
    let d = detailCache.get(k)
    if (!d || d.detailRevision !== r.detailRevision) {
      if (detailPending.has(k)) return
      detailPending.add(k)
      text(body, tr('加载详情…','Loading details…'))
      try {
        const value = await api('/api/activity/detail?chatId=' + encodeURIComponent(r.chatId) + '&id=' + encodeURIComponent(r.id))
        if (epoch !== value.epoch) return
        d = { ...value, lang: langOf() }; detailCache.set(k, d)
        while (detailCache.size > 40) detailCache.delete(detailCache.keys().next().value)
      } catch { detailErrors.set(k,r.detailRevision);text(body, tr('详情暂不可用，收起后可重新打开。','Details unavailable. Close and reopen to retry.')); return }
      finally { detailPending.delete(k) }
    }
    if (!open.has(k) || !n.isConnected) return
    const sig = d.detailRevision + ':' + langOf()
    if (body.dataset.rev === sig) return
    body.dataset.rev = sig; body.replaceChildren()
    const box = node('div','aexp'); body.append(box)
    if (d.tools?.length) {
      const tools = node('div','aetools')
      for (const tool of d.tools) {
        const chip = node('span','tchip'); chip.innerHTML = IC.wrench
        chip.append(document.createTextNode(' ' + tool.name + (tool.count > 1 ? ' ×' + tool.count : ''))); tools.append(chip)
      }
      box.append(tools)
    }
    box.append(node('div',d.reply ? 'aereply' : 'faint',d.reply || (active(d) ? tr('任务进行中，等待回复…','Task in progress; awaiting reply…') : tr('(无回复内容)','(No reply content)'))))
    if (d.err) box.append(node('p','la-error',d.err))
    const meta = node('div','aemeta')
    function metric(label,value) { const item = node('span'); item.append(node('b','',label+' '),document.createTextNode(value)); meta.append(item) }
    if (d.sender) metric(tr('发送者','Sender'),d.sender)
    metric(tr('状态','Status'),status(d.status))
    if (d.startedAt) metric(tr('排队','Queued'),(Math.max(0,d.startedAt-d.ts)/1000).toFixed(1)+'s')
    if (d.ms != null) metric(tr('耗时','Duration'),(d.ms/1000).toFixed(1)+'s')
    if (d.tokens) {
      const cr=d.tokens.cr||0,cw=d.tokens.cw||0
      metric('tokens',`↑${num((d.tokens.in||0)+cr+cw)} ↓${num(d.tokens.out||0)}` + (cr||cw ? ' · '+tr('缓存读 ','Cache read ')+num(cr)+tr(' / 写 ',' / write ')+num(cw) : ''))
    }
    box.append(meta)
    if (d.messages?.length || d.milestones?.length) {
      const source = node('details','la-source'); source.append(node('summary','',tr('请求、补充与阶段进度','Request, follow-ups and progress')))
      for (const message of d.messages || []) source.append(node('p','',(message.sender || '—')+' · '+(message.state==='landed'?tr('已读到','Read'):tr('已受理','Accepted'))+'\n'+message.text))
      for (const milestone of d.milestones || []) source.append(node('p','',milestone))
      box.append(source)
    }
    if (d.truncated) box.append(node('p','faint',tr('内容较长，记录已截断。','Long content was truncated in this record.')))

  }
  function rowNode(r) {
    const k = key(r); let n = rowNodes.get(k)
    if (!n) {
      n = node('article', 'la-row'); const button = node('button','la-toggle'); button.type = 'button'
      const lead = node('div'); lead.append(node('small'),node('div','la-title'),node('div','la-preview'))
      button.append(lead,node('span','la-state')); n.append(button)
      const fold = node('div','la-fold'), inner = node('div','la-fold-inner'), detail = node('div','la-detail')
      fold.id = 'la-detail-' + rowNodes.size + '-' + Math.random().toString(36).slice(2,8)
      inner.append(detail); fold.append(inner); n.append(fold)
      button.setAttribute('aria-controls', fold.id)
      button.onclick = () => { open.has(k) ? open.delete(k) : open.add(k);detailErrors.delete(k);schedule() }
      rowNodes.set(k,n)
    }
    const b = n.children[0], lead = b.children[0], group = groups.get(r.chatId)
    text(lead.children[0], stamp(r.ts) + ' · ' + (r.sender || '—'))
    text(lead.children[1], r.text || tr('内容未记录','Content not recorded'))
    text(lead.children[2], active(r) ? (r.doing || []).join(' · ') : r.preview || '')
    text(b.children[1], status(r.status) + (r.messageCount > 1 ? ' · ' + tr('消息 ','messages ') + r.messageCount : '') + (r.ms ? ' · ' + (r.ms/1000).toFixed(1)+'s' : ''))
    b.children[1].dataset.state = r.status; b.setAttribute('aria-expanded', String(open.has(k)))
    n.children[1].classList.toggle('open', open.has(k)); n.children[1].inert = !open.has(k)
    if (open.has(k)) void showDetail(r,n)
    return n
  }
  function reconcile(container, nodes) {
    const wanted = new Set(nodes)
    for (const child of [...container.children]) if (!wanted.has(child)) child.remove()
    nodes.forEach((n,i) => { if (container.children[i] !== n) container.insertBefore(n,container.children[i] || null) })
  }
  function paint() {
    if (!root?.isConnected) return
    lang = langOf()
    text(root.querySelector('h2'),tr('群 · 项目','Groups · Projects'))
    const concurrency = S?.live?.concurrency, capacity = concurrency?.max ?? S?.agent?.maxConcurrent ?? 0
    text(root.querySelector('.la-capacity'), tr('运行 ','Running ') + (concurrency?.active ?? [...groups.values()].filter(g=>g.busy).length) + (capacity > 0 ? ' / ' + capacity : '') + ' · ' + tr('排队 ','Queued ') + (S?.live?.queue || 0))
    if (loaded && selected && !groups.has(selected)) { selected = ''; try { sessionStorage.removeItem('sintbot.activity.group') } catch {} }
    reconcile(groupBody, groups.size ? [...groups.values()].map(groupNode) : [node('div','empty',loaded ? tr('暂无群项目','No projects') : tr('正在同步…','Syncing…'))])
    const group = groups.get(selected)
    taskBody.hidden = !group
    text(root.querySelector('[data-la=activity]'), (group?.name || '') + ' · ' + tr('任务活动','Task activity'))
    const all = [...rows.values()].filter(r => selected && r.chatId===selected)
      .sort((a,b) => Number(!active(a))-Number(!active(b)) || b.ts-a.ts)
    const shown = all.filter(active).concat(all.filter(r=>!active(r)).slice(0,count))
    reconcile(listBody, shown.length ? shown.map(rowNode) : [node('div','empty',loaded ? tr('该群暂无任务活动','No task activity for this group') : tr('正在同步…','Syncing…'))])
    const more = root.querySelector('[data-la=more]'); more.hidden=shown.length>=all.length;text(more,tr('查看更早的任务','Show earlier tasks'))
    const note = root.querySelector('[data-la=note]')
    text(note, !connected ? tr('连接中断，当前为最后收到的记录','Disconnected — showing last received records') : error ? tr('部分活动记录暂不可用','Some activity records are unavailable') : !selected ? tr('选择一个群项目，查看任务活动','Select a project to view its tasks') : '')
    note.hidden = !note.textContent
    for (const id of groupNodes.keys()) if (!groups.has(id)) groupNodes.delete(id)
    for (const k of rowNodes.keys()) if (!rows.has(k)) { rowNodes.delete(k); open.delete(k); detailCache.delete(k);detailErrors.delete(k) }
  }
  function apply(data, full) {
    if (!data?.epoch) return
    if (loaded && data.epoch===epoch && data.revision<revision) return
    if (full || data.epoch!==epoch) { rows.clear(); groups.clear() }
    if (data.epoch!==epoch) { detailCache.clear(); open.clear(); revision=-1 }
    epoch=data.epoch;revision=data.revision;error=!!data.storageError
    for (const r of data.activity || []) rows.set(key(r),r)
    for (const g of data.groups || []) groups.set(g.chatId,g)
    for (const k of data.removed || []) rows.delete(k)
    loaded=true;schedule()
  }
  function sync() {
    if (pending) return pending
    frames=[]
    pending=api('/api/activity?limit=100').then(data=>{
      apply(data,true); for(const frame of frames)apply(frame,false)
    }).catch(()=>{error=true;schedule()}).finally(()=>{pending=null;frames=[]})
    return pending
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){schedule();void sync()}})
  new MutationObserver(schedule).observe(document.documentElement,{attributes:true,attributeFilter:['data-lang']})
  return {
    preserve(){focusBeforeRender=root?.contains(document.activeElement)?document.activeElement:null;groupScroll=groupBody?.scrollTop||0},
    mount(){setup();const target=document.getElementById('liveActivity');if(target&&root.parentNode!==target)target.append(root);groupBody.scrollTop=groupScroll;if(focusBeforeRender?.isConnected)focusBeforeRender.focus({preventScroll:true});focusBeforeRender=null;schedule();void sync()},
    sync,
    receive(data){if(pending){frames.push(data);if(frames.length>200)frames.shift()}else apply(data,false)},
    live(live){for(const [id,value]of Object.entries(live?.groups||{})){const g=groups.get(id);if(g)Object.assign(g,value)}schedule()},
    connected(value){connected=value;schedule()},
  }
})()
