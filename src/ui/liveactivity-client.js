/* Injected into the console's existing script; no framework or extra connection. */
const activityPanel = (() => {
  // No project is selected when Overview opens: task activity shows only after a project is clicked,
  // so the selection is not remembered across tabs or reloads.
  let root, groupBody, listBody, taskBody, capacityNode, selected = '', count = 5
  let epoch = '', revision = -1, loaded = false, pending = null, frames = [], scheduled = false
  const rows = new Map(), groups = new Map(), detailCache = new Map(), detailPending = new Set(), detailErrors = new Map(), open = new Set()
  const groupNodes = new Map(), rowNodes = new Map(), actionPending = new Set()
  let lang = '', error = false, connected = true, focusBeforeRender = null, groupScroll = 0
  const key = r => r.chatId + ':' + r.id
  const en = () => langOf() === 'en'
  const tr = (zh, english) => en() ? english : zh
  // A local conversation's default name is stored as 本机对话; English reads it as Local chat.
  const nameOf = g => g.name === '本机对话' ? tr('本机对话', 'Local chat') : g.name
  const labels = {
    queued: ['排队', 'Queued'], running: ['运行中', 'Running'], sending: ['回复发送中', 'Sending reply'],
    answered: ['已回复', 'Replied'], silent: ['无需回复', 'No reply needed'], stopped: ['已停止', 'Stopped'],
    recalled: ['已撤回', 'Recalled'], timeout: ['已超时', 'Timed out'], error: ['失败', 'Failed'],
    'not-started': ['未启动', 'Not started'], unknown: ['结果待核实', 'Unconfirmed'],
    '已结账': ['历史记录已结账', 'Historical receipt settled'], '等待处理': ['等待处理', 'Waiting'],
  }
  const status = s => labels[s] ? tr(...labels[s]) : s
  const active = r => ['queued', 'running', 'sending', '等待处理'].includes(r.status)
  const num = n => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n)
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
    /* The panel owns its whole look and uses the console's tokens (--hover, --sel,
       --faint, --focus, the 11/12/13/14 type scale); the console adds no overrides. */
    const style = node('style'); style.textContent = `
      .la{margin:8px 0 0}.la [hidden]{display:none!important}.la .la-panel{padding:0;overflow:hidden}
      .la .la-head{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:42px;padding:10px 16px;border-bottom:1px solid var(--line)}
      .la h2{font-size:14px;line-height:20px;font-weight:600;letter-spacing:0;margin:0;display:flex;align-items:baseline;gap:8px;min-width:0}
      .la h2 small{display:inline;margin:0;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .la-sum{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
      .la-capacity{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
      .la-capacity .la-slots{display:inline-flex;gap:3px}.la-capacity .la-slots i{display:block;width:12px;height:4px;border-radius:2px;background:var(--line-hi)}.la-capacity .la-slots i.on{background:var(--ember)}
      .la button{font:inherit;color:inherit}
      .la .la-select,.la .la-toggle{width:100%;border:0;border-radius:0;background:transparent;text-align:left;cursor:pointer}
      .la .la-group{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;border-bottom:1px solid var(--line);transition:background-color .18s ease}
      .la .la-group:last-child{border-bottom:0}.la .la-group:before{content:'';position:absolute;inset:10px auto 10px 0;width:2px;border-radius:0 2px 2px 0;background:var(--ember);opacity:0;transform:scaleY(.4);transition:opacity .18s,transform .18s}
      .la .la-select{min-width:0;display:grid;grid-template-columns:minmax(210px,.8fr) minmax(240px,1.2fr);gap:24px;align-items:center;padding:10px 12px 10px 16px}
      .la .la-who{min-width:0}.la .la-l1{display:flex;align-items:center;gap:8px;min-width:0}
      .la .la-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--ok)}
      .la .la-dot[data-s=busy]{background:var(--ember);box-shadow:0 0 0 3px rgba(var(--ember-rgb),.18);animation:la-pulse 1.8s ease-in-out infinite}
      .la .la-dot[data-s=att]{background:var(--fail)}.la .la-dot[data-s=off]{background:var(--muted)}
      @keyframes la-pulse{50%{box-shadow:0 0 0 5px rgba(var(--ember-rgb),.06)}}
      .la .la-name{flex:0 1 auto;min-width:4.5em;font-size:14px;line-height:20px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .la .la-pill{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11.5px;line-height:18px;padding:0 7px;border-radius:999px;white-space:nowrap;font-variant-numeric:tabular-nums}
      .la .la-pill[data-s=busy]{color:var(--ember);background:rgba(var(--ember-rgb),.10)}.la .la-pill[data-s=att]{color:var(--fail);background:rgba(var(--fail-rgb),.10)}.la .la-pill[data-s=off]{color:var(--faint);background:var(--sel)}
      .la .la-l2{font-size:12px;line-height:18px;color:var(--faint);margin:1px 0 0 15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .la .la-ctx{min-width:0;font-variant-numeric:tabular-nums}
      .la .la-ctx-t{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:12px;line-height:20px;color:var(--faint);white-space:nowrap}
      .la .la-ctx-t b{font-size:15px;font-weight:600;color:var(--ink)}.la .la-ctx-t b[data-hi]{color:var(--warn)}.la .la-ctx-t b[data-na]{font-size:12px;font-weight:400;color:var(--muted)}
      .la .la-track{position:relative;height:6px;margin-top:4px;background:var(--line);overflow:hidden;border-radius:3px}
      .la .la-mark{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--ink);opacity:.34;pointer-events:none}.la .la-mark[data-k=turn]{opacity:.72}
      .la .la-ctx-n{font-size:11px;line-height:16px;margin-top:2px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.la .la-ctx-n[data-s=run]{color:var(--ember)}.la .la-ctx-n[data-s=warn]{color:var(--warn)}
      .la .la-fill{height:100%;border-radius:3px;background:var(--ember);transform-origin:left;transition:transform .3s ease-out;transform:scaleX(0)}.la .la-fill[data-hi]{background:var(--warn)}
      .la .la-actions{display:flex;gap:6px;flex-shrink:0;padding:0 12px 0 0}
      .la .la-act{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--line-hi);border-radius:8px;background:transparent;color:var(--dim);font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .15s,border-color .15s,transform .15s}
      .la .la-act .ic{width:13px;height:13px}.la .la-act:hover:not(:disabled){background:var(--hover);border-color:var(--muted)}.la .la-act:active:not(:disabled){transform:scale(.96)}
      .la .la-act[data-action=say]{color:var(--ember);border-color:rgba(var(--ember-rgb),.35);background:rgba(var(--ember-rgb),.06)}.la .la-act[data-action=say]:hover:not(:disabled){background:rgba(var(--ember-rgb),.12);border-color:rgba(var(--ember-rgb),.5)}
      .la .la-act:disabled{cursor:default;opacity:.38}.la .la-act[data-action=say]:disabled{color:var(--dim);border-color:var(--line-hi);background:transparent}
      .la .la-group:hover{background:var(--hover)}
      .la .la-group.selected{background:rgba(var(--ember-rgb),.06)}.la .la-group.selected:before{opacity:1;transform:scaleY(1)}
      .la button:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
      .la small{display:block;color:var(--faint);font-size:12px;line-height:18px}
      .la .la-groups{overflow:auto}
      .la .la-task-body{margin-top:12px}.la .la-list{padding:0;overflow:hidden}
      .la .la-row{border-bottom:1px solid var(--line)}.la .la-rows>.la-row:last-child{border-bottom:0}
      .la .la-toggle{display:grid;grid-template-columns:42px 8px minmax(0,1fr) auto 10px;gap:10px;align-items:center;padding:8px 14px 8px 16px;font-size:13px;line-height:20px;transition:background-color .15s}
      .la .la-toggle:hover{background:var(--hover)}.la [aria-expanded=true].la-toggle{background:var(--inset-bg)}
      .la .la-time{font-family:var(--mono);font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums}
      .la .la-tdot{width:7px;height:7px;border-radius:50%;background:var(--ok)}.la .la-tdot[data-s=busy]{background:var(--ember);box-shadow:0 0 0 3px rgba(var(--ember-rgb),.18)}.la .la-tdot[data-s=att]{background:var(--fail)}.la .la-tdot[data-s=off]{background:var(--muted)}
      .la .la-title{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.la .la-by{color:var(--faint);margin-right:6px}
      .la .la-doing{display:block;font-size:12px;line-height:18px;color:var(--ember);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
      .la .la-state{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--faint);white-space:nowrap;font-variant-numeric:tabular-nums}
      .la .la-chev{width:6px;height:6px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(45deg);margin-top:-4px;justify-self:center;transition:transform .18s,margin .18s}
      .la [aria-expanded=true] .la-chev{transform:rotate(225deg);margin-top:3px}
      .la .la-fold{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .2s ease,opacity .2s ease}.la .la-fold.open{grid-template-rows:1fr;opacity:1}
      .la .la-fold-inner{min-height:0;overflow:hidden}.la .la-fold.open .la-fold-inner{background:var(--inset-bg)}
      .la .la-detail{padding:2px 16px 12px 86px;overflow-wrap:anywhere}
      .la .la-code{font:11.5px/18px var(--mono);color:var(--dim);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:9px 12px;max-height:360px;overflow:auto}
      .la .la-reply{white-space:pre-wrap;color:var(--ink)}.la .la-reply[data-empty]{color:var(--muted)}
      .la .la-error{color:var(--fail);white-space:pre-wrap;margin:6px 0 0}
      .la .la-meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;padding-top:7px;border-top:1px dashed var(--line-hi);font:11px/16px var(--mono);color:var(--dim)}
      .la .la-meta i{font-style:normal;color:var(--muted);margin-right:4px}.la .la-meta .la-tool:before{content:'⌁ ';color:var(--muted)}
      .la .la-source{margin-top:8px;font:11px/17px var(--mono);color:var(--dim)}.la .la-source summary{cursor:pointer;color:var(--faint);font-family:var(--sans);font-size:12px}.la .la-source summary:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
      .la .la-source p{white-space:pre-wrap;margin:6px 0 0;padding-left:10px;border-left:2px solid var(--line-hi)}
      .la .la-notice{font-size:12px;line-height:18px;color:var(--faint);margin:8px 2px}.la .la-plain{font-size:12px;color:var(--faint)}
      .la .la-more{display:block;width:100%;padding:8px;border:0;border-top:1px solid var(--line);background:transparent;color:var(--faint);font-size:12px;cursor:pointer;text-align:center}.la .la-more:hover{color:var(--ink);background:var(--hover)}
      .la .empty{padding:12px 16px;font-size:13px;color:var(--faint)}
      @media(max-width:760px){.la .la-act span{display:none}.la .la-act{width:30px;padding:0;justify-content:center}}
      @media(max-width:640px){.la .la-head{padding:10px 12px;gap:10px}.la .la-group{align-items:start}.la .la-select{grid-column:1/-1;grid-row:1;grid-template-columns:minmax(0,1fr);gap:8px;padding:10px 12px}.la .la-who{padding-right:108px}.la .la-actions{grid-column:2;grid-row:1;z-index:1;padding:8px 10px 0 0}
        .la .la-toggle{grid-template-columns:38px 8px minmax(0,1fr) 10px;padding:8px 12px}.la .la-state{grid-column:3;grid-row:2}.la .la-detail{padding:2px 12px 12px}}
      @media(prefers-reduced-motion:reduce){.la *{transition:none!important;animation:none!important}}`
    root.append(style)
    const panel = node('div', 'card la-panel'), head = node('div', 'la-head')
    // The running/queued readout lives in the console's page-header slot while Overview is open.
    capacityNode = node('span', 'la-capacity'); capacityNode.setAttribute('data-i18n-skip', ''); capacityNode.dataset.for = 'overview'
    capacityNode.append(node('span'), node('span', 'la-slots'), node('span'))
    head.append(node('h2')); panel.append(head)
    groupBody = node('div', 'la-groups'); panel.append(groupBody); root.append(panel)
    const note = node('div', 'la-notice'); note.dataset.la = 'note'; note.setAttribute('role', 'status'); root.append(note)
    taskBody = node('div', 'card la-list la-task-body'); taskBody.hidden = true
    const bar = node('div', 'la-head'), title = node('h2'); title.dataset.la = 'activity'; title.append(node('span'), node('small'))
    const sum = node('span', 'la-sum'); sum.dataset.la = 'sum'; bar.append(title, sum); taskBody.append(bar)
    listBody = node('div', 'la-rows'); taskBody.append(listBody)
    const more = node('button', 'la-more'); more.type = 'button'; more.dataset.la = 'more'; more.onclick = () => { count += 5; schedule() }; taskBody.append(more)
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
  const clock = ms => {
    const t = Math.max(0, Math.floor((ms || 0) / 1000)), m = Math.floor(t / 60), sec = t % 60
    return m ? (en() ? `${m}m ${String(sec).padStart(2,'0')}s` : `${m}分${String(sec).padStart(2,'0')}秒`) : (en() ? sec + 's' : sec + '秒')
  }
  const backend = g => g.provider || (g.runner === 'codex' ? 'Codex' : 'Claude')
  const modelLabel = g => g.model ? (typeof modelName === 'function' ? modelName(g.model) : g.model) || g.model : tr('执行器默认型号','Executor default')
  // One state for the dot and the small pill; an idle group shows no pill at all.
  function groupState(g) {
    if (g.held || g.queueFaulted) return ['att', tr('需要处理','Needs attention')]
    if (g.paused) return ['off', tr('已暂停','Paused')]
    if (g.finalizing) return ['busy', tr('收尾中','Finishing')]
    if (g.waitingForCapacity) return ['busy', tr('等待容量','Waiting for a slot')]
    if (g.busy) return ['busy', tr('运行中 ','Running ') + clock(g.sinceMs) + (g.queue ? ' · ' + tr('排队 ','queued ') + g.queue : '')]
    if (g.queue) return ['busy', tr('排队 ','Queued ') + g.queue]
    return [S?.live?.running ? 'idle' : 'off', '']
  }
  function groupNode(g) {
    let n = groupNodes.get(g.chatId)
    if (!n) {
      n = node('div', 'la-group'); n.dataset.chatId = g.chatId
      const select = node('button', 'la-select'); select.type = 'button'
      const who = node('div', 'la-who'), l1 = node('div', 'la-l1')
      l1.append(node('span', 'la-dot'), node('span', 'la-name'), node('span', 'la-pill'))
      who.append(l1, node('div', 'la-l2'))
      const ctx = node('div', 'la-ctx'), top = node('div', 'la-ctx-t'), track = node('div', 'la-track')
      top.append(node('b'), node('span')); track.append(node('div', 'la-fill')); ctx.append(top, track, node('div', 'la-ctx-n'))
      select.append(who, ctx); n.append(select)
      const actions = node('div','la-actions')
      for (const [action,icon] of [['say','say'],['stop','square'],['new','rotate']]) {
        const button = node('button','la-act'); button.type = 'button'; button.dataset.action = action
        button.innerHTML = IC[icon]; button.append(node('span'))
        button.onclick = () => void act(action,button,g.chatId); actions.append(button)
      }
      n.append(actions)
      select.onclick = () => {
        // A second click on the selected project closes its task activity again.
        if (selected === g.chatId) { selected = ''; schedule(); return }
        selected = g.chatId; count = 5
        schedule(); requestAnimationFrame(() => {
          if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
            taskBody.getAnimations().forEach(animation => animation.cancel())
            taskBody.animate([{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:180,easing:'ease-out'})
          }
        })
      }
      groupNodes.set(g.chatId, n)
    }
    const select = n.children[0], [who, c] = select.children, [l1, l2] = who.children, ctx = g.context
    const [stateKind, stateText] = groupState(g)
    l1.children[0].dataset.s = stateKind; text(l1.children[1], nameOf(g))
    text(l1.children[2], stateText); l1.children[2].dataset.s = stateKind; l1.children[2].hidden = !stateText
    text(l2, backend(g) + ' · ' + modelLabel(g))
    const blocked = !S?.live?.running || g.paused || g.held || g.queueFaulted
    const busy = g.busy || g.pending > 0 || g.queue > 0 || g.waitingForCapacity || g.finalizing
    for (const [action,zh,eng] of [['say','插话','Message'],['stop','停止','Stop'],['new','新对话','New chat']]) {
      const button = n.querySelector('[data-action='+action+']')
      button.disabled = actionPending.has(g.chatId + ':' + action) || blocked || (action === 'stop' ? !busy : action === 'new' ? !!busy : !!g.sayBlocked)
      text(button.lastChild, tr(zh,eng))
      button.setAttribute('aria-label',tr(zh,eng) + ' · ' + nameOf(g))
      const why = !S?.live?.running ? tr('服务未运行','The service is not running') : g.paused ? tr('该群已暂停','This group is paused') : g.held || g.queueFaulted ? tr('该群需要先处理','This group needs attention first')
        : action === 'stop' && !busy ? tr('当前没有运行中的任务','No task is running') : action === 'new' && busy ? tr('任务进行中，先停止再开新对话','A task is running; stop it first') : action === 'say' && g.sayBlocked ? tr('该群暂时不能插话','Messages are paused for this group') : ''
      button.title = button.disabled && why ? why : action === 'say' ? tr('向这个群插一句，这句话和回复都会发进群','Send a message; it and the reply go to this group') : action === 'new' ? tr('开始新对话，清除当前会话上下文','Start a new chat with fresh context') : tr('停止当前任务，保留会话','Stop the current task and keep the session')
    }
    const valid = ctx?.usedTokens != null, capacity = ctx?.windowTokens > 0
    const percent = valid && capacity ? Math.round(ctx.usedTokens / ctx.windowTokens * 100) : null
    const [big, side] = c.children[0].children, hi = percent != null && percent >= 85
    if (percent != null) { text(big, percent + '%'); text(side, num(ctx.usedTokens) + ' / ' + num(ctx.windowTokens)) }
    else if (valid) { text(big, num(ctx.usedTokens)); text(side, tr('容量未知','Window unknown')) }
    else { text(big, ctx?.quality === 'compacted' ? tr('压缩后待上报','Awaiting usage after compaction') : !g.sessionId && !g.busy ? tr('未开始','No session yet') : tr('待上报','Awaiting usage')); text(side, tr('上下文','Context')) }
    big.toggleAttribute('data-na', !valid); big.toggleAttribute('data-hi', hi)
    const fill = c.children[1].children[0]; fill.toggleAttribute('data-hi', hi)
    fill.style.transform = 'scaleX(' + (percent == null ? 0 : Math.max(0, Math.min(100, percent)) / 100) + ')'
    const quality = ctx?.quality === 'reported' ? tr('最新上报','latest report') : ctx?.quality === 'historical' ? tr('历史采样','historical sample') : tr('上次上报','last report')
    // Compaction on the bar, as the service gives it (g.compaction): the two
    // lines as ticks, and one short line for a running compaction or the last
    // outcome. Nothing is decided here.
    const cv = g.compaction || null, track = c.children[1], note = c.children[2]
    const marks = cv && capacity ? cv.marks.filter(m => m.tokens < ctx.windowTokens) : []
    const key = marks.map(m => m.kind + ':' + (m.tokens / ctx.windowTokens * 100).toFixed(2)).join('|')
    if (track.dataset.marks !== key) {
      track.dataset.marks = key
      track.querySelectorAll('.la-mark').forEach(m => m.remove())
      for (const m of marks) { const tick = node('i', 'la-mark'); tick.dataset.k = m.kind; tick.style.left = (m.tokens / ctx.windowTokens * 100).toFixed(2) + '%'; track.append(tick) }
    }
    const last = cv?.last, at = last?.at ? ' ' + stamp(last.at) : ''
    const noteText = cv?.state === 'holding' ? tr('正在整理上下文，新消息在等它做完','Tidying context; a message is waiting for it')
      : cv?.state === 'compacting' ? tr('正在整理上下文','Tidying context')
      : last?.code === 'compacted' ? tr('上次整理','Last tidied') + at + (last.pre && last.post ? ' · ' + num(last.pre) + ' → ' + num(last.post) : '')
      : last?.code === 'interrupted' ? tr('上次整理被打断','Last tidy was interrupted') + at
      : last?.code === 'failed' ? tr('上次整理没成功','Last tidy failed') + at : ''
    text(note, noteText); note.hidden = !noteText
    if (cv?.state) note.dataset.s = 'run'; else if (last && last.code !== 'compacted') note.dataset.s = 'warn'; else delete note.dataset.s
    const lines = (cv?.marks || []).map(m => m.kind === 'idle' ? tr('整理线 ','Tidy line ') + num(m.tokens) + tr('（一轮结束后空闲时整理）',' (tidied after a turn, while idle)')
      : tr('压缩线 ','Compaction line ') + num(m.tokens) + tr('（到了就在任务中途压缩）',' (compacted mid-task once reached)'))
    c.title = tr('上下文','Context') + (ctx ? ' · ' + quality + (ctx.measuredAt ? ' · ' + stamp(ctx.measuredAt) : '') : '') + (lines.length ? '\n' + lines.join('\n') : '')
    n.title = [nameOf(g), g.workdir || g.project, tr('思考深度 ','Reasoning ') + (g.reasoningEffort || tr('默认','default')), g.sessionId ? tr('会话 ','Session ') + String(g.sessionId).slice(-6) : ''].filter(Boolean).join('\n')
    n.classList.toggle('selected',selected === g.chatId); select.setAttribute('aria-pressed', String(selected === g.chatId)); return n
  }
  async function showDetail(r, n) {
    const k = key(r), body = n.querySelector('.la-detail')
    if (!open.has(k)) return
    if (!r.details) { body.replaceChildren(node('div','la-code la-plain',tr('历史记录未保存消息和回复详情。','Message and reply details were not recorded.'))); delete body.dataset.rev; return }
    if (detailErrors.get(k) === r.detailRevision) return
    let d = detailCache.get(k)
    if (!d || d.detailRevision !== r.detailRevision) {
      if (detailPending.has(k)) return
      detailPending.add(k)
      body.replaceChildren(node('div','la-code la-plain',tr('加载详情…','Loading details…'))); delete body.dataset.rev
      try {
        const value = await api('/api/activity/detail?chatId=' + encodeURIComponent(r.chatId) + '&id=' + encodeURIComponent(r.id))
        if (epoch !== value.epoch) return
        d = { ...value, lang: langOf() }; detailCache.set(k, d)
        while (detailCache.size > 40) detailCache.delete(detailCache.keys().next().value)
      } catch { detailErrors.set(k,r.detailRevision);body.replaceChildren(node('div','la-code la-error',tr('详情暂不可用，收起后可重新打开。','Details unavailable. Close and reopen to retry.'))); return }
      finally { detailPending.delete(k) }
    }
    if (!open.has(k) || !n.isConnected) return
    const sig = d.detailRevision + ':' + langOf()
    if (body.dataset.rev === sig) return
    body.dataset.rev = sig; body.replaceChildren()
    // Rendered like source: small monospace text in a quiet block, the numbers on one line below it.
    const box = node('div','la-code'); body.append(box)
    const reply = node('div','la-reply',d.reply || (active(d) ? tr('任务进行中，等待回复…','Task in progress; awaiting reply…') : tr('（无回复内容）','(No reply content)')))
    if (!d.reply) reply.dataset.empty = ''
    box.append(reply)
    if (d.err) box.append(node('div','la-error',d.err))
    const meta = node('div','la-meta')
    for (const tool of d.tools || []) meta.append(node('span','la-tool',tool.name + (tool.count > 1 ? '×' + tool.count : '')))
    function metric(label,value) { const item = node('span'); item.append(node('i','',label),document.createTextNode(value)); meta.append(item) }
    if (d.startedAt) metric(tr('排队','queue'),(Math.max(0,d.startedAt-d.ts)/1000).toFixed(1)+'s')
    if (d.tokens) {
      const cr=d.tokens.cr||0,cw=d.tokens.cw||0
      metric(tr('用量','tokens'),`↑${num((d.tokens.in||0)+cr+cw)} ↓${num(d.tokens.out||0)}`)
      if (cr||cw) metric(tr('缓存','cache'),num(cr)+(cw ? ' / ' + tr('写 ','write ') + num(cw) : ''))
    }
    if (meta.children.length) box.append(meta)
    if (d.messages?.length || d.milestones?.length) {
      const source = node('details','la-source'); source.append(node('summary','',tr('请求、补充与阶段进度','Request, follow-ups and progress')))
      for (const message of d.messages || []) source.append(node('p','',(message.sender || '—')+' · '+(message.state==='landed'?tr('已读到','Read'):tr('已受理','Accepted'))+'\n'+message.text))
      for (const milestone of d.milestones || []) source.append(node('p','',milestone))
      body.append(source)
    }
    if (d.truncated) body.append(node('div','la-notice',tr('内容较长，记录已截断。','Long content was truncated in this record.')))
  }
  // Replied tasks carry no label; only the states worth a glance get a pill.
  const taskKind = s => ['running','sending','queued','等待处理'].includes(s) ? 'busy' : ['error','timeout','unknown'].includes(s) ? 'att' : ['stopped','recalled','not-started'].includes(s) ? 'off' : 'ok'
  function rowNode(r) {
    const k = key(r); let n = rowNodes.get(k)
    if (!n) {
      n = node('article', 'la-row'); const button = node('button','la-toggle'); button.type = 'button'
      const title = node('div','la-title'); title.append(node('span','la-by'), node('span'), node('span','la-doing'))
      button.append(node('span','la-time'), node('span','la-tdot'), title, node('span','la-state'), node('span','la-chev')); n.append(button)
      const fold = node('div','la-fold'), inner = node('div','la-fold-inner'), detail = node('div','la-detail')
      fold.id = 'la-detail-' + rowNodes.size + '-' + Math.random().toString(36).slice(2,8)
      inner.append(detail); fold.append(inner); n.append(fold)
      button.setAttribute('aria-controls', fold.id)
      button.onclick = () => { open.has(k) ? open.delete(k) : open.add(k);detailErrors.delete(k);schedule() }
      rowNodes.set(k,n)
    }
    const b = n.children[0], [time, dot, title, state] = b.children, kind = taskKind(r.status)
    text(time, stamp(r.ts)); dot.dataset.s = kind
    text(title.children[0], r.sender || ''); title.children[0].hidden = !r.sender
    // `textEn`: the service's own words for a row without a message (src/c2console.js getActivity)
    text(title.children[1], (en() && r.textEn) || r.text || tr('内容未记录','Content not recorded'))
    const doing = active(r) && r.doing?.length ? tr('正在：','Now: ') + r.doing.join(' · ') : ''
    text(title.children[2], doing); title.children[2].hidden = !doing
    title.title = title.children[1].textContent
    const parts = []
    if (kind !== 'ok') { const pill = node('span','la-pill',status(r.status) + (r.status === 'running' && r.startedAt ? ' ' + clock(Date.now() - r.startedAt) : '')); pill.dataset.s = kind; parts.push(pill) }
    else if (!['answered','已结账'].includes(r.status)) parts.push(node('span','',status(r.status)))
    const tail = [r.ms ? clock(r.ms) : '', r.messageCount > 1 ? (en() ? r.messageCount + ' messages' : r.messageCount + ' 条消息') : ''].filter(Boolean).join(' · ')
    if (tail) parts.push(node('span','',tail))
    const sig = parts.map(x => x.className + ':' + x.textContent).join('|')
    if (state.dataset.sig !== sig) { state.dataset.sig = sig; state.replaceChildren(...parts) }
    b.setAttribute('aria-expanded', String(open.has(k)))
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
    text(root.querySelector('.la-panel h2'),tr('群项目','Projects'))
    const concurrency = S?.live?.concurrency, capacity = concurrency?.max ?? S?.agent?.maxConcurrent ?? 0
    const running = concurrency?.active ?? [...groups.values()].filter(g=>g.busy).length
    const [capLabel, slots, capText] = capacityNode.children
    text(capLabel, tr('并发','Slots'))
    const want = capacity > 0 && capacity <= 8 ? capacity : 0
    if (slots.children.length !== want) slots.replaceChildren(...Array.from({ length: want }, () => node('i')))
    ;[...slots.children].forEach((slot, i) => slot.classList.toggle('on', i < running))
    text(capText, running + (capacity > 0 ? ' / ' + capacity : '') + (S?.live?.queue ? ' · ' + tr('排队 ','queued ') + S.live.queue : ''))
    if (loaded && selected && !groups.has(selected)) selected = ''
    reconcile(groupBody, groups.size ? [...groups.values()].map(groupNode) : [node('div','empty',loaded ? tr('暂无群项目','No projects') : tr('正在同步…','Syncing…'))])
    const group = groups.get(selected)
    taskBody.hidden = !group
    const title = root.querySelector('[data-la=activity]')
    text(title.children[0], tr('任务活动','Task activity')); text(title.children[1], group ? nameOf(group) : '')
    const all = [...rows.values()].filter(r => selected && r.chatId===selected)
      .sort((a,b) => Number(!active(a))-Number(!active(b)) || b.ts-a.ts)
    const shown = all.filter(active).concat(all.filter(r=>!active(r)).slice(0,count))
    const runningRows = all.filter(r => ['running','sending'].includes(r.status)).length
    text(root.querySelector('[data-la=sum]'), all.length ? (runningRows ? tr('运行 ','Running ') + runningRows + ' · ' : '') + (en() ? all.length + ' tasks' : '共 ' + all.length + ' 条') : '')
    reconcile(listBody, shown.length ? shown.map(rowNode) : [node('div','empty',loaded ? tr('该群暂无任务活动','No task activity for this group') : tr('正在同步…','Syncing…'))])
    const more = root.querySelector('[data-la=more]'); more.hidden=shown.length>=all.length;text(more,tr('查看更早的任务','Show earlier tasks'))
    const note = root.querySelector('[data-la=note]')
    text(note, !connected ? tr('连接中断，当前为最后收到的记录','Disconnected — showing last received records') : error ? tr('部分活动记录暂不可用','Some activity records are unavailable') : !selected ? tr('点一个群项目，查看它的任务活动','Select a project to view its tasks') : '')
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
    // The running/queued readout sits in the console's page-header slot (shown there while Overview is the open tab).
    mount(){setup();const target=document.getElementById('liveActivity');if(target&&root.parentNode!==target)target.append(root);const slot=document.getElementById('pSlot');if(slot&&capacityNode.parentNode!==slot)slot.append(capacityNode);groupBody.scrollTop=groupScroll;if(focusBeforeRender?.isConnected)focusBeforeRender.focus({preventScroll:true});focusBeforeRender=null;schedule();void sync()},
    sync,
    // Switching to Overview starts with no project selected.
    reset(){if(selected){selected='';count=5;schedule()}},
    receive(data){if(pending){frames.push(data);if(frames.length>200)frames.shift()}else apply(data,false)},
    live(live){for(const [id,value]of Object.entries(live?.groups||{})){const g=groups.get(id);if(g)Object.assign(g,value)}schedule()},
    connected(value){connected=value;schedule()},
  }
})()
