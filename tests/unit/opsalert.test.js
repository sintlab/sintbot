// 运维告警(src/core/opsalert.js):文案 + 去重闸。群面文字零工具名 / 零机器路径,单测钉死。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createGate, alertText, createSink, createConnWatch, humanDur, DOWN_COOLDOWN_MS, FAILOVER_COOLDOWN_MS } = require('../../src/core/opsalert')

const NO_TOOLNAME = /sbot|\/Users|~\/\.|\.jsonl|codex login|claude auth|claude code|\/login|on hold/i

test('opsalert: 账号异常文案带机器名 · 群名 · 原话截断,且零工具名', () => {
  const t = alertText({ kind: 'provider-down', provider: 'claude', cause: 'account', chatId: 'G', source: 'turn', detail: 'Your account is on hold and ' + 'x'.repeat(300) }, { instance: 'mac-a', groupName: 'demo' })
  assert.match(t, /🚨 【模型账号异常】mac-a · claude/)
  assert.match(t, /群「demo」的一轮因账号不可用失败/)
  assert.doesNotMatch(t, /Your account|on hold|Claude Code/i, '服务端原话不进群(里面有产品名 / 命令);原话由接线层写日志')
  assert.match(t, /检查该模型的登录态/)
  assert.doesNotMatch(t, NO_TOOLNAME)
  // 探针来源的措辞不提「群」
  const p = alertText({ kind: 'provider-down', provider: 'claude', cause: 'account', source: 'probe' }, { instance: 'mac-b' })
  assert.match(p, /额度探针读到登录态不可用/); assert.doesNotMatch(p, /群「/)
})

test('opsalert: 额度用完 / 已恢复 / 自动切换 / 切回 四种文案', () => {
  const q = alertText({ kind: 'provider-down', provider: 'claude', cause: 'quota', window: 'weekly', chatId: 'G', source: 'turn' }, { instance: 'mac-b', groupName: 'DemoApp', when: '约 2 天后' })
  assert.ok(q.startsWith('⏳ 【模型额度用完】mac-b · claude(一周窗口) · 约 2 天后重置\n'), q)
  assert.match(q, /群「DemoApp」的一轮因额度用完失败/)
  assert.equal(alertText({ kind: 'provider-up', provider: 'claude' }, { instance: 'mac-b' }), '✅ 【模型已恢复】mac-b · claude 可以正常使用了')
  const f = alertText({ kind: 'failover', chatId: 'G', from: 'claude', to: 'codex', home: 'claude', cause: 'quota', back: false }, { instance: 'mac-b', groupName: 'DemoApp', when: '约 3 小时后' })
  assert.equal(f, '🔄 【自动切换】mac-b · 群「DemoApp」:claude → codex(额度用完),约 3 小时后切回 claude')
  const fa = alertText({ kind: 'failover', chatId: 'G', from: 'claude', to: 'codex', home: 'claude', cause: 'account', back: false }, { groupName: '设计稿' })
  assert.equal(fa, '🔄 【自动切换】群「设计稿」:claude → codex(账号不可用),claude 恢复后切回')
  const b = alertText({ kind: 'failover', chatId: 'G', from: 'codex', to: 'claude', home: 'claude', cause: 'quota', back: true }, { instance: 'mac-b', groupName: 'DemoApp' })
  assert.equal(b, '🔄 【已切回】mac-b · 群「DemoApp」:codex → claude(原模型已恢复)')
  for (const s of [q, f, fa, b]) assert.doesNotMatch(s, NO_TOOLNAME)
  // 没群名就说「某个群」,不回显 chatId
  assert.match(alertText({ kind: 'failover', chatId: 'oc_abc', from: 'a', to: 'b', home: 'a', cause: 'quota', back: false }), /某个群/)
  assert.doesNotMatch(alertText({ kind: 'failover', chatId: 'oc_abc', from: 'a', to: 'b', home: 'a', cause: 'quota', back: false }), /oc_abc/)
  // 未知事件 / 空 ⇒ 空串
  assert.equal(alertText(null), ''); assert.equal(alertText({ kind: 'what' }), '')
})

test('opsalert: 去重闸 —— 同模型同类故障一小时一条;恢复只在报过故障后才放行且重置冷却;切换按群+目标 10 分钟', () => {
  let now = 1_000_000
  const g = createGate(() => now)
  const down = { kind: 'provider-down', provider: 'claude', cause: 'account' }
  assert.equal(g.allow(down), true)
  assert.equal(g.allow(down), false, '同一小时内第二条压掉')
  assert.equal(g.allow({ ...down, cause: 'quota' }), true, '另一类故障是另一把锁')
  assert.equal(g.allow({ kind: 'provider-down', provider: 'codex', cause: 'account' }), true, '另一个模型是另一把锁')
  now += DOWN_COOLDOWN_MS
  assert.equal(g.allow(down), true, '冷却期满再放一条(故障还在就该再提醒)')
  // 恢复
  assert.equal(g.allow({ kind: 'provider-up', provider: 'glm' }), false, '没报过故障的模型不报恢复(平时每 5 分钟都探一次)')
  assert.equal(g.allow({ kind: 'provider-up', provider: 'claude' }), true)
  assert.equal(g.allow({ kind: 'provider-up', provider: 'claude' }), false, '恢复只报一次')
  assert.equal(g.allow(down), true, '恢复后再出事立刻能报,不受上一次冷却影响')
  // 切换
  const f = { kind: 'failover', chatId: 'G', to: 'codex' }
  assert.equal(g.allow(f), true); assert.equal(g.allow(f), false)
  assert.equal(g.allow({ ...f, chatId: 'H' }), true, '另一个群另一把锁')
  assert.equal(g.allow({ ...f, to: 'claude' }), true, '切回是另一把锁')
  now += FAILOVER_COOLDOWN_MS
  assert.equal(g.allow(f), true)
  assert.equal(g.allow(null), false); assert.equal(g.allow({ kind: 'nope' }), false)
})

// 接线层 createSink:没配 / 平台没好 / 闸压掉 / 发送失败 四路都不抛,配了就发到 alerts.chatId,文案带群名,原话只进日志
test('opsalert: createSink —— 配置热读、群名解析、闸去重、原话只进日志、send 失败只记日志', async () => {
  const sent = [], logs = []
  let cfg = { instance: 'mac-a', alerts: { chatId: 'oc_alerts' }, groups: { G: { name: 'demo', workdir: '/x' } } }
  let platform = null
  const sink = createSink({ getCfg: () => cfg, getPlatform: () => platform, log: (s) => logs.push(s), humanReset: (ms) => `约 ${Math.round(ms / 3600e3)} 小时后`, fallbackInstance: 'host' })
  const down = { kind: 'provider-down', provider: 'claude', cause: 'account', chatId: 'G', source: 'turn', detail: 'Your account is on hold and cannot use Claude Code' }
  assert.equal(sink(down), false, '平台还没建好 ⇒ 不发、不抛')
  platform = { send: (to, text) => { sent.push({ to, text }); return Promise.resolve() } }
  assert.equal(sink(down), true)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'oc_alerts')
  assert.match(sent[0].text, /mac-a · claude/); assert.match(sent[0].text, /群「demo」/)
  assert.doesNotMatch(sent[0].text, /on hold|Claude Code/i, '原话不进群')
  assert.match(logs.join('\n'), /运维告警已发:provider-down claude — Your account is on hold/, '原话进日志')
  assert.equal(sink(down), false, '闸:同模型同类一小时一条')
  // 热重载:配置对象换了,新的 chatId / instance 立刻生效;配置里没 instance 用主机名兜底
  cfg = { alerts: { chatId: 'oc_other' }, groups: {} }
  const fo = { kind: 'failover', chatId: 'G', from: 'claude', to: 'codex', home: 'claude', cause: 'quota', until: Date.now() + 2 * 3600e3, back: false }
  assert.equal(sink(fo), true)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent[1].to, 'oc_other'); assert.equal(sent[1].text, '🔄 【自动切换】host · 某个群:claude → codex(额度用完),约 2 小时后切回 claude')
  // 没配 ⇒ 不发
  cfg = { groups: {} }
  assert.equal(sink({ kind: 'provider-up', provider: 'claude' }), false)
  // send 拒绝 ⇒ 只记日志、不抛
  cfg = { alerts: { chatId: 'oc_alerts' } }
  platform = { send: () => Promise.reject(new Error('net down')) }
  assert.equal(sink({ kind: 'provider-up', provider: 'claude' }), true, '闸放行(之前报过 claude 的故障)')
  await new Promise((r) => setTimeout(r, 5))
  assert.match(logs.join('\n'), /运维告警发送失败\(provider-up\): net down/)
  // 事件为 null / getCfg 抛 ⇒ 返回 false 不抛
  assert.equal(sink(null), false)
  assert.equal(createSink({ getCfg: () => { throw new Error('x') }, getPlatform: () => platform, log: (s) => logs.push(s) })(down), false)
  assert.match(logs.join('\n'), /运维告警处理失败/)
})

// ───────── 平台长连接中断(createConnWatch + 闸 + 文案)─────────
// 假时钟:setTimer 只登记到期时刻,tick(ms) 推进 now 并按序触发到期的回调 —— 宽限期逻辑全在注入的时钟上,零真实等待。
function fakeClock(start = 1_000_000) {
  let now = start, seq = 0
  const timers = new Map() // id → { due, fn }
  const setTimer = (fn, ms) => { const id = ++seq; timers.set(id, { due: now + ms, fn }); return id }
  const clearTimer = (id) => timers.delete(id)
  const tick = (ms) => {
    now += ms
    for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].due - b[1].due)) if (t.due <= now) { timers.delete(id); t.fn() }
  }
  return { now: () => now, setTimer, clearTimer, tick, pending: () => timers.size }
}

test('opsalert: createConnWatch —— 断开不到宽限不报;到点仍断报一次;抖动不重复;恢复报 up;再断再到点能再报', () => {
  const clk = fakeClock()
  const evs = []
  const w = createConnWatch({ now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, graceMs: 5 * 60_000, onAlert: (e) => evs.push(e) })
  w.note('wecom', { state: 'connecting' })
  w.note('wecom', { state: 'reconnecting', lastError: 'getaddrinfo ENOTFOUND wecom.example' })
  clk.tick(4 * 60_000)
  assert.equal(evs.length, 0, '宽限期内不报(开机前 2 分钟 DNS 未就绪的真机现象挡在这里)')
  w.note('wecom', { state: 'failed', lastError: 'subscribe 853000' })
  assert.equal(clk.pending(), 1, '断开态内再来状态变化不重复起表')
  clk.tick(60_000)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, 'platform-down'); assert.equal(evs[0].platform, 'wecom')
  assert.equal(evs[0].downMs, 5 * 60_000, '时长从进入断开态那一刻算,不是从最后一次状态变化算')
  assert.equal(evs[0].detail, 'subscribe 853000', 'lastError 取最新一条,放 detail 只进日志')
  w.note('wecom', { state: 'reconnecting' })
  clk.tick(60 * 60_000)
  assert.equal(evs.length, 1, '已报过就不再报(重复提醒交给闸 / 下一次中断)')
  // 恢复
  w.note('wecom', { state: 'connected' })
  assert.equal(evs.length, 2); assert.equal(evs[1].kind, 'platform-up'); assert.equal(evs[1].downMs, 65 * 60_000)
  assert.equal(clk.pending(), 0)
  // 再断再到点要能再报(状态已清)
  w.note('wecom', { state: 'reconnecting', lastError: 'x' })
  clk.tick(5 * 60_000)
  assert.equal(evs.length, 3); assert.equal(evs[2].kind, 'platform-down'); assert.equal(evs[2].downMs, 5 * 60_000)
  w.note('wecom', { state: 'connected' })
  assert.equal(evs.length, 4)
})

test('opsalert: createConnWatch —— 来得及恢复零告警;stopped 不报;两个平台各自计时;stop() 撤全部;onAlert 抛不冒泡', () => {
  const clk = fakeClock()
  const evs = [], logs = []
  const w = createConnWatch({ now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, graceMs: 5 * 60_000, onAlert: (e) => { evs.push(e); if (e.platform === 'boom') throw new Error('sink died') }, log: (s) => logs.push(s) })
  // 宽限期内恢复 ⇒ 定时器撤掉、什么都不报(没报过 down 就没有 up)
  w.note('feishu', { state: 'reconnecting' }); clk.tick(2 * 60_000); w.note('feishu', { state: 'connected' })
  clk.tick(10 * 60_000); assert.equal(evs.length, 0); assert.equal(clk.pending(), 0)
  // stopped = daemon 关停,不是故障
  w.note('feishu', { state: 'reconnecting' }); w.note('feishu', { state: 'stopped' })
  clk.tick(10 * 60_000); assert.equal(evs.length, 0)
  // 两个平台各自一把表:飞书先断 3 分钟后企微才断,飞书先到点
  w.note('feishu', { state: 'reconnecting' }); clk.tick(3 * 60_000); w.note('wecom', { state: 'failed' })
  clk.tick(2 * 60_000); assert.deepEqual(evs.map((e) => e.platform), ['feishu'])
  clk.tick(3 * 60_000); assert.deepEqual(evs.map((e) => e.platform), ['feishu', 'wecom'])
  // stop():把在跑的表全撤(关停路径)
  w.note('feishu', { state: 'connected' }); w.note('wecom', { state: 'connected' }); evs.length = 0
  w.note('feishu', { state: 'reconnecting' }); w.note('wecom', { state: 'reconnecting' })
  assert.equal(clk.pending(), 2); w.stop(); assert.equal(clk.pending(), 0)
  clk.tick(60 * 60_000); assert.equal(evs.length, 0)
  // onAlert 抛 ⇒ 只记日志,note 本身不抛(它挂在看门狗的 onConn 上,抛了会断连接处理)
  w.note('boom', { state: 'failed' }); assert.doesNotThrow(() => clk.tick(5 * 60_000))
  assert.match(logs.join('\n'), /平台连接告警处理失败/)
  // 垃圾输入不抛
  assert.doesNotThrow(() => { w.note('', { state: 'failed' }); w.note('x', null); w.note('x', {}) })
})

test('opsalert: 去重闸 —— 平台中断按平台一小时一条、与模型键不撞;恢复只在报过中断后放行一次并重置冷却', () => {
  let now = 1_000_000
  const g = createGate(() => now)
  const down = { kind: 'platform-down', platform: 'wecom' }
  assert.equal(g.allow(down), true)
  assert.equal(g.allow(down), false, '一小时内第二条压掉')
  assert.equal(g.allow({ kind: 'platform-down', platform: 'feishu' }), true, '另一个平台另一把锁')
  assert.equal(g.allow({ kind: 'provider-down', provider: 'wecom', cause: 'account' }), true, '同名模型是另一把锁(键有前缀)')
  assert.equal(g.allow({ kind: 'provider-up', provider: 'wecom' }), true, '模型的恢复不被平台的状态影响')
  assert.equal(g.allow({ kind: 'platform-up', platform: 'feishu' }), true)
  assert.equal(g.allow({ kind: 'platform-up', platform: 'feishu' }), false, '恢复只报一次')
  assert.equal(g.allow({ kind: 'platform-up', platform: 'nope' }), false, '没报过中断的平台不报恢复')
  assert.equal(g.allow({ kind: 'platform-down', platform: 'feishu' }), true, '恢复后再断立刻能报,不受上一次冷却影响')
  now += DOWN_COOLDOWN_MS
  assert.equal(g.allow(down), true, '冷却期满再放一条')
})

test('opsalert: 平台中断 / 恢复文案 —— 中文名由 ctx 注入、查不到用字串、时长人话、原话不进群、零工具名', () => {
  assert.equal(humanDur(0), '不到 1 分钟'); assert.equal(humanDur(29_000), '不到 1 分钟')
  assert.equal(humanDur(5 * 60_000), '约 5 分钟'); assert.equal(humanDur(59.6 * 60_000), '约 1 小时')
  assert.equal(humanDur(60 * 60_000), '约 1 小时'); assert.equal(humanDur(125 * 60_000), '约 2 小时 5 分钟')
  const d = alertText({ kind: 'platform-down', platform: 'wecom', downMs: 5 * 60_000, detail: 'getaddrinfo ENOTFOUND wecom.example' }, { instance: 'mac-a', platformLabel: '企业微信' })
  assert.ok(d.startsWith('📡 【平台连接中断】mac-a · 企业微信:已断开约 5 分钟\n'), d)
  assert.match(d, /群消息收不到也发不出/); assert.match(d, /自动重连/); assert.match(d, /网络与机器人凭据/)
  assert.doesNotMatch(d, /ENOTFOUND|getaddrinfo|wecom/, '网络 / 服务端原话与平台英文名不进群')
  const u = alertText({ kind: 'platform-up', platform: 'feishu', downMs: 125 * 60_000 }, { instance: 'mac-b', platformLabel: '飞书' })
  assert.equal(u, '✅ 【平台连接恢复】mac-b · 飞书:中断约 2 小时 5 分钟后已重连')
  // 没注入中文名 ⇒ 直接用平台字串;没 instance 不留孤零零的「 · 」
  assert.equal(alertText({ kind: 'platform-up', platform: 'slack', downMs: 10_000 }), '✅ 【平台连接恢复】slack:中断不到 1 分钟后已重连')
  for (const s of [d, u]) assert.doesNotMatch(s, NO_TOOLNAME)
})

test('opsalert: createSink —— 平台告警经 platformLabels 翻中文名,日志行带平台名与原话', async () => {
  const sent = [], logs = []
  const cfg = { instance: 'mac-a', alerts: { chatId: 'oc_alerts' }, groups: {} }
  const platform = { send: (to, text) => { sent.push({ to, text }); return Promise.resolve() } }
  const sink = createSink({ getCfg: () => cfg, getPlatform: () => platform, log: (s) => logs.push(s), platformLabels: { feishu: '飞书', wecom: '企业微信' } })
  assert.equal(sink({ kind: 'platform-down', platform: 'wecom', downMs: 6 * 60_000, detail: 'subscribe failed 853000' }), true)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'oc_alerts')
  assert.match(sent[0].text, /mac-a · 企业微信:已断开约 6 分钟/)
  assert.doesNotMatch(sent[0].text, /853000|wecom/, '原话与英文平台名只进日志')
  assert.match(logs.join('\n'), /运维告警已发:platform-down wecom — subscribe failed 853000/, '日志行要能看出哪个平台')
  assert.equal(sink({ kind: 'platform-down', platform: 'wecom', downMs: 7 * 60_000 }), false, '闸:一小时一条')
  assert.equal(sink({ kind: 'platform-up', platform: 'wecom', downMs: 20 * 60_000 }), true)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sent[1].text, '✅ 【平台连接恢复】mac-a · 企业微信:中断约 20 分钟后已重连')
  // 没给 platformLabels 的旧调用方式照样能用(字串兜底)
  const sink2 = createSink({ getCfg: () => cfg, getPlatform: () => platform, log: () => {} })
  assert.equal(sink2({ kind: 'platform-down', platform: 'feishu', downMs: 60_000 }), true)
  await new Promise((r) => setTimeout(r, 5))
  assert.match(sent[2].text, /mac-a · feishu:已断开约 1 分钟/)
})

test('opsalert: platform-issue —— 被挤掉 / 工具授权过期两种文案(中文平台名、零工具名、原话不进群);闸按平台 + 事由每小时一条', () => {
  const k = alertText({ kind: 'platform-issue', platform: 'wecom', issue: 'kicked', detail: 'kicked 2x botId …GBVL' }, { instance: 'mac-a', platformLabels: { wecom: '企业微信' } })
  assert.match(k, /🔌 【企业微信连接被挤掉】mac-a · /); assert.match(k, /已停止重连/); assert.match(k, /重启守护进程/); assert.doesNotMatch(k, /GBVL|kicked/); assert.doesNotMatch(k, NO_TOOLNAME)
  const a = alertText({ kind: 'platform-issue', platform: 'wecom', issue: 'auth-expired', detail: 'https://x/renew' }, { instance: 'mac-a', platformLabels: { wecom: '企业微信' } })
  assert.match(a, /🔑 【企业微信工具授权过期】/); assert.match(a, /续期链接/); assert.doesNotMatch(a, /https:/); assert.doesNotMatch(a, NO_TOOLNAME)
  assert.equal(alertText({ kind: 'platform-issue', platform: 'wecom', issue: 'other' }, {}), '')
  let t = 0; const g = createGate(() => t)
  assert.equal(g.allow({ kind: 'platform-issue', platform: 'wecom', issue: 'kicked' }), true)
  assert.equal(g.allow({ kind: 'platform-issue', platform: 'wecom', issue: 'kicked' }), false, '一小时内同事由不重复')
  assert.equal(g.allow({ kind: 'platform-issue', platform: 'wecom', issue: 'auth-expired' }), true, '不同事由各算各的')
  const tg = alertText({ kind: "platform-issue", platform: "wecom", issue: "tool-gated", detail: "this tool is not available for your corporation" }, { instance: "mac-a", platformLabels: { wecom: "企业微信" } })
  assert.match(tg, /读群历史未开放/); assert.match(tg, /853006/); assert.match(tg, /不是配置错/); assert.match(tg, /私聊/)
  assert.ok(!/sbot|wecom-cli|~\//.test(tg), "告警文案零工具名 / 路径")
  t = DOWN_COOLDOWN_MS + 1; assert.equal(g.allow({ kind: 'platform-issue', platform: 'wecom', issue: 'kicked' }), true)
})

// 程序缺失(cause='binary'):原话带安装路径与产品名,告警群同样只说人话;这档不切备用,文案说清「装回之前每轮都失败」
test('opsalert: 程序缺失文案 —— 机器名 · 模型 · 群名 · 成因与怎么救,零路径零产品名;与账号类分开去重', () => {
  const t = alertText({ kind: 'provider-down', provider: 'claude', cause: 'binary', chatId: 'G', source: 'turn', detail: '模型程序在这台机器上找不到了,需要管理员处理' }, { instance: 'host-a', groupName: 'Demo' })
  assert.match(t, /^🚨 【模型程序缺失】host-a · claude\n/)
  assert.match(t, /群「Demo」的一轮因为在这台机器上找不到该模型的程序而失败/)
  assert.match(t, /升级或迁移/); assert.match(t, /装回之前该模型的群每轮都会失败/)
  assert.doesNotMatch(t, NO_TOOLNAME); assert.doesNotMatch(t, /opt\/homebrew|cannot find|Claude Code|PATH/i)
  assert.match(alertText({ kind: 'provider-down', provider: 'claude', cause: 'binary', source: 'turn' }, {}), /有群的一轮/)
  const gate = createGate(() => 1_000_000)
  assert.equal(gate.allow({ kind: 'provider-down', provider: 'claude', cause: 'binary' }), true)
  assert.equal(gate.allow({ kind: 'provider-down', provider: 'claude', cause: 'binary' }), false)
  assert.equal(gate.allow({ kind: 'provider-down', provider: 'claude', cause: 'account' }), true, '程序缺失与账号异常是两件事,各报各的')
})
