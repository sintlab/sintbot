// 运维告警(operator alert)—— 模型账号 / 额度类故障发到专用告警群,让 operator 第一时间知道。
//
// 为什么要做:账号被停 / 登录态刷新失败 / 额度用尽,此前只在**出事的那个群**里说一句(错误卡或自动切换的
// 通知),operator 不在那个群就一无所知。2026-09-25 OAuth 过期 6 轮静默失败 10 小时、09-27 账号 on hold、
// 10-05 周额度被别人用光 —— 三次都是事后翻日志才知道。账号类异常更是「会不会被封」的最早信号,必须有人立刻看到。
//
// 分工(与 quotaalert 同款):本模块只做**文案 + 去重判定**,不碰 IO、不认平台;引擎在事发点吐结构化事件
// (onAlert 钩子),bin 接线把文案发到 `alerts.chatId`。core 不认 runner 名、不碰错误原话以外的东西。
//
// 事件形状(引擎吐的):
//   { kind:'provider-down', provider, cause:'account'|'quota'|'binary', window:'weekly'|'session'|null, until:ms|null,
//     chatId?, source:'turn'|'probe', detail? }   —— 某模型不可用(出错轮判出来的 / 额度探针判出来的);
//     binary = 模型程序在配置路径与各候选位置都找不到(比如 CLI 自更新换了安装位置),只从出错轮来、不切模型
//   { kind:'provider-up',   provider }                                    —— 探针确认恢复(之前标过不可用)
//   { kind:'failover', chatId, from, to, home, cause, until, back }       —— 某群自动切换(back=true 是切回)
//   { kind:'platform-down', platform, downMs, detail }                     —— 某平台长连接断开超过宽限期(createConnWatch 吐)
//   { kind:'platform-up',   platform, downMs }                             —— 报过中断的平台重连上了
//   { kind:'platform-issue', platform, issue:'kicked'|'auth-expired'|'tool-gated', detail } —— 平台侧需要人处理的事:被另一台机器挤掉已停连 / 工具能力授权过期 / 读群历史被企业规模门控(853006)
//
// 去重:账号 / 额度类故障每个模型每小时最多一条(每轮都失败就每轮都报 = 刷屏);「已恢复」只在报过故障之后才报;
// 切换按群 + 目标 10 分钟一条(两边都没额度时来回切,别把告警群也刷满);平台中断按平台一小时一条,恢复同模型的规矩。
// ⚠ 文案是群面文字:零工具名、零机器路径(规则见 CONTRIBUTING.md「用户面零工具名」),单测钉死。
// ⚠ core 不认平台名:platform 只是个字串,中文名(飞书 / 企业微信)由 bin 经 createSink 的 platformLabels 注入。

const DOWN_COOLDOWN_MS = 60 * 60_000
const FAILOVER_COOLDOWN_MS = 10 * 60_000
const CONN_GRACE_MS = 5 * 60_000
const DETAIL_MAX = 160

// 去重闸:同键在冷却期内只放行一次。内存态即可 —— daemon 重启后同一故障再报一次反而是对的(故障还在)。
function createGate(now = () => Date.now()) {
  const last = new Map()      // key → 上次放行时刻
  const downSent = new Set()  // 报过故障的模型:只有它们的「已恢复」才值得说
  function allow(ev) {
    if (!ev || !ev.kind) return false
    const t = now()
    if (ev.kind === 'provider-down') {
      const k = `down:${ev.provider}:${ev.cause}`
      if (last.has(k) && t - last.get(k) < DOWN_COOLDOWN_MS) return false // ⚠ 没发过要用 has 判,不能拿 0 当「很久以前」(小时钟下会把首条压掉)
      last.set(k, t); downSent.add(ev.provider); return true
    }
    if (ev.kind === 'provider-up') {
      if (!downSent.has(ev.provider)) return false
      downSent.delete(ev.provider)
      for (const k of [...last.keys()]) if (k.startsWith(`down:${ev.provider}:`)) last.delete(k) // 恢复后再出事要立刻能报
      return true
    }
    if (ev.kind === 'failover') {
      const k = `failover:${ev.chatId}:${ev.to}`
      if (last.has(k) && t - last.get(k) < FAILOVER_COOLDOWN_MS) return false
      last.set(k, t); return true
    }
    // 平台连接中断:键带 `conn:` 前缀 —— 与模型的 `down:` 分开,名字撞上(某 provider 恰好叫 feishu)也不会互相压掉。
    if (ev.kind === 'platform-down') {
      const k = `conn:${ev.platform}`
      if (last.has(k) && t - last.get(k) < DOWN_COOLDOWN_MS) return false
      last.set(k, t); downSent.add(`conn:${ev.platform}`); return true
    }
    if (ev.kind === 'platform-up') {
      if (!downSent.has(`conn:${ev.platform}`)) return false
      downSent.delete(`conn:${ev.platform}`)
      last.delete(`conn:${ev.platform}`) // 恢复后再断、再过宽限期,要能立刻报,不受上一次的小时冷却影响
      return true
    }
    // 平台侧要人处理的事(被挤掉已停连 / 工具授权过期):按平台 + 事由每小时一条 —— 授权过期时每次轮询都会撞到,不压就是刷屏
    if (ev.kind === 'platform-issue') {
      const k = `issue:${ev.platform}:${ev.issue}`
      if (last.has(k) && t - last.get(k) < DOWN_COOLDOWN_MS) return false
      last.set(k, t); return true
    }
    return false
  }
  return { allow }
}

// 时长人话:「不到 1 分钟」/「约 N 分钟」/「约 H 小时 M 分钟」。自带「约」,拼文案时别再加。
function humanDur(ms) {
  const m = Math.round(Math.max(0, Number(ms) || 0) / 60_000)
  if (m < 1) return '不到 1 分钟'
  if (m < 60) return `约 ${m} 分钟`
  const h = Math.floor(m / 60), r = m % 60
  return `约 ${h} 小时${r ? ` ${r} 分钟` : ''}`
}

// 平台长连接的中断观察:看门狗每次状态变化调 note(platform, snapshot),这里判「断开持续超过宽限期」才吐事件。
//
// 为什么要宽限期:机器断电重启后开机头两分钟 DNS 未就绪,两个平台都先报 ENOTFOUND 再自愈(10-11 真机)——
// 没有宽限每次重启都是一条假告警;默认 5 分钟,比看门狗自己的退避重建周期宽得多。
// 为什么要做:两台机互相探活只看控制台 HTTP 200,平台订阅一直失败(凭据被吊销 / 被另一条连接反复踢 / DNS 长期不通)
// 时 daemon 活着、控制台绿着,没人知道群消息其实收不到。
// 依赖全注入(now / setTimer / clearTimer)所以能用假时钟单测;本模块不碰 IO,事件交给 onAlert(= createSink 产物)。
function createConnWatch({ now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, graceMs = CONN_GRACE_MS, onAlert = () => {}, log = () => {} } = {}) {
  const st = new Map() // platform → { downSince, timer, reported, lastError }
  const get = (p) => { if (!st.has(p)) st.set(p, { downSince: null, timer: null, reported: false, lastError: '' }); return st.get(p) }
  const disarm = (r) => { if (r.timer) { try { clearTimer(r.timer) } catch {} r.timer = null } }
  const emit = (ev) => { try { onAlert(ev) } catch (e) { log('平台连接告警处理失败(忽略): ' + (e && e.message)) } }

  function fire(platform) {
    const r = get(platform)
    r.timer = null
    if (r.downSince == null || r.reported) return // connected 已撤过 / 已报过(防御:定时器照理此时已被撤)
    r.reported = true
    emit({ kind: 'platform-down', platform, downMs: now() - r.downSince, detail: r.lastError })
  }

  function note(platform, snap) {
    if (!platform || !snap || !snap.state) return
    const r = get(platform)
    if (snap.state === 'connected') {
      disarm(r)
      if (r.reported) emit({ kind: 'platform-up', platform, downMs: now() - (r.downSince == null ? now() : r.downSince) })
      r.downSince = null; r.reported = false; r.lastError = ''
      return
    }
    if (snap.state === 'stopped') { disarm(r); r.downSince = null; r.reported = false; return } // daemon 关停,不是故障
    // connecting / reconnecting / failed 都算断开态;只在**进入**断开态那一刻起计时,之后的状态抖动不重置、不重复起表
    if (snap.lastError) r.lastError = String(snap.lastError)
    if (r.downSince == null) r.downSince = now()
    if (!r.timer && !r.reported) {
      r.timer = setTimer(() => fire(platform), graceMs)
      if (r.timer && typeof r.timer.unref === 'function') r.timer.unref() // 观察用定时器不该拖住进程退出
    }
  }

  function stop() { for (const r of st.values()) disarm(r) }
  return { note, stop }
}

const windowLabel = (w) => (w === 'weekly' ? '一周' : w === 'session' ? '5 小时' : '')
const causeLabel = (c) => (c === 'account' ? '账号不可用' : c === 'binary' ? '程序缺失' : '额度用完')

// 事件 → 告警正文 | ''。ctx:{ instance(这台机器怎么自称) · groupName(事发群名,可空) · when(距重置的人话,可空) }
function alertText(ev, ctx = {}) {
  if (!ev || !ev.kind) return ''
  const where = ctx.instance ? `${ctx.instance} · ` : ''
  const group = ctx.groupName ? `群「${ctx.groupName}」` : (ev.chatId ? '某个群' : '')
  if (ev.kind === 'provider-down') {
    if (ev.cause === 'account') {
      // ⚠ 不把服务端原话(ev.detail)贴进群:原话里有「Claude Code」「/login」这类产品名 / 命令(v0.11.107 定的口径
      //    「英文原话只进账本」);原话由接线层写进日志,排查看日志。
      const lines = [`🚨 【模型账号异常】${where}${ev.provider}`]
      lines.push(ev.source === 'probe' ? '额度探针读到登录态不可用' : `${group || '有群'}的一轮因账号不可用失败`)
      lines.push('请尽快检查该模型的登录态与账号状态;配了备用模型的群会自动切换,没配的群每轮都会失败。')
      return lines.join('\n')
    }
    if (ev.cause === 'binary') {
      // 路径只进日志不进群(同上口径);这档不切备用 —— 装回去就好,切模型反而清会话
      return `🚨 【模型程序缺失】${where}${ev.provider}\n${group || '有群'}的一轮因为在这台机器上找不到该模型的程序而失败(配置的路径与常见安装位置都没有)\n常见成因是刚升级或迁移过它;请在这台机器上重新安装或改回配置路径(日志里有原路径)。装回之前该模型的群每轮都会失败。`
    }
    const win = windowLabel(ev.window)
    const head = `⏳ 【模型额度用完】${where}${ev.provider}${win ? `(${win}窗口)` : ''}${ctx.when ? ` · ${ctx.when}重置` : ''}`
    const src = ev.source === 'probe' ? '额度探针读到已到上限' : `${group || '有群'}的一轮因额度用完失败`
    return `${head}\n${src};配了备用模型的群会自动切换并到点切回。`
  }
  if (ev.kind === 'provider-up') return `✅ 【模型已恢复】${where}${ev.provider} 可以正常使用了`
  if (ev.kind === 'platform-issue') {
    const label = (ctx.platformLabels && ctx.platformLabels[ev.platform]) || ev.platform || '平台'
    // ⚠ 事由只给人话,不给服务端 / 工具原话(原话有命令名、链接;原话进日志)
    if (ev.issue === 'kicked') return `🔌 【${label}连接被挤掉】${where}另一台机器用同一个机器人登录,10 分钟内第二次被踢下线,本机已停止重连\n请检查是不是两台机器配了同一个机器人(每台各建各的);处理完后重启守护进程才会重新连接。`
    if (ev.issue === 'tool-gated') return `🚧 【${label}读群历史未开放】${where}官方命令行工具回「本企业不可用」(853006):读群历史这项能力官方按企业规模门控,不是配置错\n「不 @ 也回复」已暂停半小时后再试,@ 它仍正常;群里不 @ 的话它看不见,要连着聊就私聊它。`
    if (ev.issue === 'auth-expired') return `🔑 【${label}工具授权过期】${where}官方命令行工具的能力授权(每 7 天一续)已过期\n群里会暂时查不到成员姓名、发不了图和文件、「不 @ 也回复」停摆;请机器人创建者在企业微信里点续期链接(日志里有),续完自动恢复。`
    return ''
  }
  if (ev.kind === 'platform-down' || ev.kind === 'platform-up') {
    // 平台中文名由接线层注入(core 不认平台名);查不到就直接用字串。⚠ lastError(ENOTFOUND / 853000 这类网络 / 服务端
    //    原话)在 ev.detail 里,只进日志不进群 —— 与模型账号异常同一口径。
    const label = ctx.platformLabel || ev.platform || '平台'
    if (ev.kind === 'platform-up') return `✅ 【平台连接恢复】${where}${label}:中断${humanDur(ev.downMs)}后已重连`
    return `📡 【平台连接中断】${where}${label}:已断开${humanDur(ev.downMs)}\n这段时间该平台的群消息收不到也发不出;会一直自动重连,持续不恢复请检查网络与机器人凭据。`
  }
  if (ev.kind === 'failover') {
    if (ev.back) return `🔄 【已切回】${where}${group || '有群'}:${ev.from} → ${ev.to}(原模型已恢复)`
    const tail = ev.home && ev.to !== ev.home ? (ctx.when ? `,${ctx.when}切回 ${ev.home}` : `,${ev.home} 恢复后切回`) : ''
    return `🔄 【自动切换】${where}${group || '有群'}:${ev.from} → ${ev.to}(${causeLabel(ev.cause)})${tail}`
  }
  return ''
}

// 错误原话截断成一行(只进日志;引擎给的 detail 已脱敏,这里只管长度与换行)
function clip(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > DETAIL_MAX ? t.slice(0, DETAIL_MAX - 1) + '…' : t
}

// 接线层(bin 用):事件 → 闸 → 文案 → 发到 alerts.chatId。依赖全注入,所以能单测;IO 只有 send 与 log。
//   getCfg()      → 当前配置(热重载后要读新的 alerts.chatId / groups / instance,所以是函数不是值)
//   getPlatform() → 平台对象(可能还没建好 ⇒ null;要有 send(chatId, text))
//   humanReset(ms)→ 「约 N 后」(与额度告警同一份措辞,由调用方注入,core 内不互相 require 成环)
//   fallbackInstance → 配置没写 instance 时这台机器怎么自称(主机名)
//   platformLabels → { 平台名: 中文名 }(平台连接告警用;core 不认平台名,所以由 bin 注入)
// 返回 onAlert(ev):同步、永不抛(抛了只记日志 —— 它挂在轮次结算路上)。
// ⚠ 平台连接告警经同一个 platform.send 发出,而 send 是路由器按告警群归属分发 —— 若断的恰是告警群所在平台,
//    这条告警必然发不出去(落到下面的 catch 只记日志)。这是预期:它能报的是「另一个平台断了」,本平台断了靠对端机探活。
function createSink({ getCfg, getPlatform, gate = createGate(), log = () => {}, humanReset = () => '', fallbackInstance = '', platformLabels = {} }) {
  return function onAlert(ev) {
    try {
      const cfg = (typeof getCfg === 'function' && getCfg()) || {}
      const a = cfg.alerts
      const to = a && a.chatId != null ? String(a.chatId).trim() : ''
      const platform = typeof getPlatform === 'function' ? getPlatform() : null
      if (!to || !platform || typeof platform.send !== 'function') return false
      if (!gate.allow(ev)) return false
      const g = ev.chatId ? (cfg.groups || {})[ev.chatId] : null
      const when = typeof ev.until === 'number' && ev.until > Date.now() ? humanReset(ev.until - Date.now()) : ''
      const platformLabel = ev.platform ? ((platformLabels || {})[ev.platform] || ev.platform) : ''
      const text = alertText(ev, { instance: cfg.instance || fallbackInstance, groupName: g && g.name, when, platformLabel })
      if (!text) return false
      const d = clip(ev.detail)
      // Platform 契约:send 对「平台确认没送出去」resolve null 而不抛(企微主动推送被拒就是这形态)⇒ null 也要当失败记,否则日志写「已发」而群里没有
      Promise.resolve(platform.send(to, text))
        .then((r) => log(r === null ? `运维告警发送失败(${ev.kind}):平台确认未送达` : `运维告警已发:${ev.kind} ${ev.provider || ev.platform || ev.to || ''}${d ? ' — ' + d : ''}`))
        .catch((e) => log(`运维告警发送失败(${ev.kind}): ` + (e && e.message)))
      return true
    } catch (e) { log('运维告警处理失败(忽略): ' + (e && e.message)); return false }
  }
}

module.exports = { createGate, alertText, createSink, createConnWatch, humanDur, DOWN_COOLDOWN_MS, FAILOVER_COOLDOWN_MS, CONN_GRACE_MS }
