// Engine — the deterministic orchestration core. Driven with mock store / runner
// / platform (no real `claude`, no Feishu). Covers dedup, watermark, routing,
// slash commands, the interrupt path, per-project perms flow, NO_REPLY,
// redaction, session persistence, and the busy queue.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Engine, NO_REPLY } = require('../../src/core/engine')
const { mdTablesToText } = require('../../src/core/mdtable') // 表格→文本已只服务卡片层,从出处导入

const tick = () => new Promise((r) => setTimeout(r, 15))

function mkStore() {
  const sessions = new Map(), providers = new Map(), watermarks = new Map(), stats = new Map(), tainted = new Set()
  return {
    getSession: (c) => sessions.get(c) || null,
    setSession: (c, v) => sessions.set(c, v),
    clearSession: (c) => { sessions.delete(c); tainted.delete(c) },
    markTainted: (c) => tainted.add(c),
    clearTainted: (c) => tainted.delete(c),
    isTainted: (c) => tainted.has(c),
    getProvider: (c) => providers.get(c) || null,
    setProvider: (c, v) => providers.set(c, v),
    clearProvider: (c) => providers.delete(c),
    getWatermark: (c) => watermarks.get(c) || 0,
    setWatermark: (c, t) => watermarks.set(c, t),
    getSessionStats: (c) => stats.get(c) || null,
    putSessionStats: (c, s) => stats.set(c, s),
    clearSessionStats: (c) => stats.delete(c),
  }
}

function mkPlatform() {
  const replies = []
  return { replies, reply: (_ctx, text) => { replies.push(text); return Promise.resolve() } }
}

function baseCfg(extra = {}) {
  return {
    providers: { claude: {}, glm: { baseUrl: 'https://x', apiKey: 'k' } },
    defaultProvider: 'claude',
    agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0 },
    groups: { G: { workdir: '/proj', provider: 'claude', allowedTools: ['Read'] } },
    ...extra,
  }
}

let _n = 0
function mkMsg(text, i = ++_n, chatId = 'G') {
  return { chatId, text, msgId: 'm-' + (++_n), createTimeMs: Date.now() + i, senderName: 'u', userId: 'u1', replyCtx: {} }
}

const okRunner = (fn = async () => ({ sessionId: 's', result: { text: 'ok' } })) => ({ runTurn: fn })

test('engine: unbound group is told it is not bound', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg({ groups: {} }), { runner: okRunner(), store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p)
  assert.match(p.replies[0], /没有绑定项目/)
})

test('engine: dedup drops a repeated msgId', async () => {
  let calls = 0
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => { calls++; return { sessionId: 's', result: { text: 'ok' } } }), store: mkStore() })
  const m = mkMsg('do'); m.msgId = 'dup-1'
  await eng.handleMessage(m, mkPlatform()); await tick()
  await eng.handleMessage({ ...m }, mkPlatform()); await tick() // same msgId
  assert.equal(calls, 1)
})

test('engine: drops pre-startup messages', async () => {
  let calls = 0
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => { calls++; return {} }), store: mkStore() })
  const m = mkMsg('old'); m.createTimeMs = eng.startedAt - 1000
  await eng.handleMessage(m, mkPlatform()); await tick()
  assert.equal(calls, 0)
})

test('engine: watermark drops out-of-order older messages', async () => {
  let calls = 0
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => { calls++; return { sessionId: 's', result: { text: 'ok' } } }), store: mkStore() })
  const b = eng.startedAt + 5000
  const m1 = mkMsg('first'); m1.createTimeMs = b + 100
  await eng.handleMessage(m1, mkPlatform()); await tick()
  const m2 = mkMsg('older'); m2.createTimeMs = b + 50
  await eng.handleMessage(m2, mkPlatform()); await tick()
  assert.equal(calls, 1)
})

// ── 水位线只归**平台投递**的消息管(2026-08-06 真机故障) ────────────────────────
// 合成消息(定时任务 / 画布按钮)的 createTimeMs = 本机 Date.now(),平台消息的 = 平台服务器
// 时间戳 —— 两把钟。以前拿它们比大小并互相推进水位线,主机钟快 27s 就让 12:10 的定时任务
// 盖下「未来」水位线,吃掉群成员 12:09:54 发的消息,且全程无痕。三条各钉一个方向。
test('watermark: 合成消息不推水位线 —— 主机钟快也不会吃掉随后到达的真人消息', async () => {
  let calls = 0
  const store = mkStore()
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => { calls++; return { sessionId: 's', result: { text: 'ok' } } }), store })
  const b = eng.startedAt + 5000
  // 定时任务先跑:本机钟快 ⇒ 它的 createTimeMs 比之后到达的真人消息还大
  await eng.handleMessage({ chatId: 'G', text: '每日日报', msgId: 'cron:G:1', synthetic: true, createTimeMs: b + 27_000, replyCtx: {} }, mkPlatform())
  await tick()
  assert.equal(store.getWatermark('G'), 0, '合成消息不该写水位线')
  const human = mkMsg('先送200分吧'); human.createTimeMs = b + 100 // 真人消息:时间戳「更早」但它才是新消息
  await eng.handleMessage(human, mkPlatform()); await tick(); await tick()
  assert.equal(calls, 2, '真人消息必须照常派发(回归:曾被当成陈年重投静默吞掉)')
  assert.equal(store.getWatermark('G'), b + 100, '水位线只跟平台消息走')
})

test('watermark: 合成消息不读水位线 —— 主机钟慢也不会把定时任务自己吞掉', async () => {
  let calls = 0
  const store = mkStore()
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => { calls++; return { sessionId: 's', result: { text: 'ok' } } }), store })
  const b = eng.startedAt + 5000
  const human = mkMsg('先回一句'); human.createTimeMs = b + 27_000
  await eng.handleMessage(human, mkPlatform()); await tick()
  // 反向:本机钟慢 ⇒ 定时任务的 createTimeMs 落在水位线下方
  await eng.handleMessage({ chatId: 'G', text: '每日日报', msgId: 'cron:G:2', synthetic: true, createTimeMs: b + 100, replyCtx: {} }, mkPlatform())
  await tick()
  assert.equal(calls, 2, '定时任务不该被水位线挡住')
})

test('watermark: 真人消息被判陈年重投时必须留痕(静默丢弃过是排障黑洞)', async () => {
  const logs = []
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore(), log: (s) => logs.push(String(s)) })
  const b = eng.startedAt + 5000
  const m1 = mkMsg('first'); m1.createTimeMs = b + 100
  await eng.handleMessage(m1, mkPlatform()); await tick()
  const m2 = mkMsg('older'); m2.msgId = 'om-stale'; m2.createTimeMs = b + 50
  await eng.handleMessage(m2, mkPlatform()); await tick()
  const hit = logs.filter((l) => l.includes('om-stale'))
  assert.equal(hit.length, 1, '丢弃必须记一行,且带上被丢消息的 id')
  assert.match(hit[0], /stale/)
  assert.match(hit[0], /watermark/)
})

test('engine: /help lists the commands', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() })
  await eng.handleMessage(mkMsg('/help'), p)
  assert.match(p.replies[0], /\/model/)
  assert.match(p.replies[0], /\/new/)
})

// /help 按群拼(v0.11.3):零工具名 + 能力按群实际收放(列了做不到的 = 说谎)
test('engine: /help 零工具名(SintBot 开头,不出现 sbot 字样)+ 能力导览', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() })
  await eng.handleMessage(mkMsg('/help'), p)
  // v0.11.82 起首段是简介(绑的项目、模型),命令段紧随其后 —— 着急时命令仍在第一屏
  // 钉的是结构(第一段是简介、第二行带目录名)不是段名措辞 —— 改个段名不该红
  assert.match(p.replies[0], /^【[^】]+】\n[^\n]*「proj」/)
  assert.match(p.replies[0], /\n【命令】\n· \/status/)
  assert.doesNotMatch(p.replies[0], /sbot/i) // 用户面零工具名(此前首行就是「sbot 命令:」,v0.9.2 清理漏网)
  assert.doesNotMatch(p.replies[0], /\/proj/) // 简介只给目录名,不给机器路径
  assert.match(p.replies[0], /直接说事/)
  assert.match(p.replies[0], /· 设计:/)
  assert.match(p.replies[0], /· 定时:/)
  assert.doesNotMatch(p.replies[0], /生成图片/) // 机器无 codex(hasImagen 未注入)⇒ 不列生图
  // ⭐ 风格与图标合成一行(用户 09-08 要求精简),但**「各选各的」四个字必须留住**:当初分两行是怕
  //   读成「挑风格顺带定了图标」,合并后靠这四个字保住意思
  assert.match(p.replies[0], /· 风格与图标:.*各选各的/)
  assert.doesNotMatch(p.replies[0], /· 图标:|· 设计风格:/) // 旧的两行写法不残留
  // ⚠ 精简的判据是「一条能不能一眼读完」—— 帮助是着急时看的,一条折成三行等于没写
  for (const line of p.replies[0].split('\n')) {
    assert.ok(line.length <= 62, `这一行太长,群里会折成好几行:${line}`)
  }
})

test('engine: /help 机器可生图时才列「生成图片」', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore(), hasImagen: () => true })
  await eng.handleMessage(mkMsg('/help'), p)
  assert.match(p.replies[0], /生成图片/)
})

test('engine: /help codex 只读群收起基础技能并明说只读;完全访问则全列', async () => {
  const cfgRo = baseCfg({ providers: { gpt: { runner: 'codex' } }, groups: { G: { workdir: '/proj', provider: 'gpt' } } })
  const p1 = mkPlatform()
  await new Engine(cfgRo, { runner: okRunner(), store: mkStore() }).handleMessage(mkMsg('/help'), p1)
  assert.doesNotMatch(p1.replies[0], /· 设计:/)
  assert.doesNotMatch(p1.replies[0], /· 定时:/)
  assert.doesNotMatch(p1.replies[0], /· 插件:/) // 只读沙箱连插件也接不上,不列
  assert.match(p1.replies[0], /只读模式/)
  assert.doesNotMatch(p1.replies[0], /生成图片/) // 只读 codex 跑不了生图桥(沙箱)
  const cfgFull = baseCfg({ providers: { gpt: { runner: 'codex' } }, groups: { G: { workdir: '/proj', provider: 'gpt', permissionMode: 'bypassPermissions' } } })
  const p2 = mkPlatform()
  await new Engine(cfgFull, { runner: okRunner(), store: mkStore(), hasImagen: () => true }).handleMessage(mkMsg('/help'), p2)
  assert.match(p2.replies[0], /· 设计:/)
  assert.match(p2.replies[0], /生成图片/) // codex 完全访问也走生图桥(v0.11.16 判据合一)
  assert.doesNotMatch(p2.replies[0], /只读模式/)
})

// v0.11.16:此前 /help 与自知清单各写一份生图判据,codex 完全访问群落在缺口里 —— 帮助里
// 承诺了「生成图片」,清单却不注入桥的说明。这条把两侧钉在一起,漂了就红。
test('engine: /help 说有生图 ⇔ 清单就注入生图桥(两侧判据必须同源)', async () => {
  const mk = (extra, deps) => baseCfg({ providers: { gpt: { runner: 'codex', model: 'm' }, claude: {} }, groups: { G: { workdir: '/proj', ...extra } } })
  for (const [label, group, hasImagen] of [
    ['codex 完全访问', { provider: 'gpt', permissionMode: 'bypassPermissions' }, true],
    ['codex 只读', { provider: 'gpt' }, true],
    ['claude 完全访问', { provider: 'claude', permissionMode: 'bypassPermissions' }, true],
    ['机器没配 codex', { provider: 'claude', permissionMode: 'bypassPermissions' }, false],
  ]) {
    const cfg = mk(group)
    const ph = mkPlatform()
    await new Engine(cfg, { runner: okRunner(), store: mkStore(), hasImagen: () => hasImagen }).handleMessage(mkMsg('/help'), ph)
    const helpSays = /生成图片/.test(ph.replies[0])
    const { r, get } = capRunner()
    const eng = new Engine(cfg, { runner: r, store: mkStore(), hasImagen: () => hasImagen })
    await eng.handleMessage(mkMsg('go'), mkPlatform()); await tick()
    const manifestHas = /【生图】/.test(get().prompt)
    assert.equal(helpSays, manifestHas, `${label}:/help 说${helpSays ? '有' : '没有'}生图,清单却${manifestHas ? '注入了' : '没注入'}`)
  }
})

test('engine: /help 列浏览器只在真有浏览器插件时(v0.11.16 补的两项能力)', async () => {
  const base = { workdir: '/proj', provider: 'claude', permissionMode: 'bypassPermissions' }
  const p1 = mkPlatform()
  await new Engine(baseCfg({ groups: { G: { ...base, plugins: { mcp: ['chrome-devtools'] } } } }),
    { runner: okRunner(), store: mkStore() }).handleMessage(mkMsg('/help'), p1)
  assert.match(p1.replies[0], /· 网页与文件:.*网址/) // 有浏览器:网址与文件并成一行
  assert.match(p1.replies[0], /· 插件:本群已接 chrome-devtools/) // 插件行按本群实际名单报
  const p2 = mkPlatform()
  await new Engine(baseCfg({ groups: { G: { ...base, plugins: { mcp: ['some-db'] } } } }),
    { runner: okRunner(), store: mkStore() }).handleMessage(mkMsg('/help'), p2)
  assert.doesNotMatch(p2.replies[0], /网页与文件|网址/) // 没浏览器就别列(列了做不到;「预览:网页原型」那行的「网页」不算)
  assert.match(p2.replies[0], /· 文件:/) // 对照组:文件那行与插件无关恒列,确实扫到了正文
  assert.match(p2.replies[0], /· 插件:本群已接 some-db/)
})

test('engine: /model 没有注入写入器时(CLI 试跑)仍是只读 — 带参数也不假装切了', async () => {
  const p = mkPlatform(); const store = mkStore()
  const cfg = baseCfg({ providers: { claude: { model: 'claude-opus-4-8' }, glm: { baseUrl: 'https://x', apiKey: 'k', model: 'glm-5.2[1m]' } } })
  const eng = new Engine(cfg, { runner: okRunner(), store }) // 无 setProvider
  await eng.handleMessage(mkMsg('/model'), p)
  assert.match(p.replies[0], /【当前模型】claude · claude-opus-4-8/) // provider · model-id, unambiguous
  assert.match(p.replies[0], /glm · glm-5\.2\[1m\]/)              // supported list carries model-ids too
  assert.match(p.replies[0], /终端试跑,不能切换/)                 // 如实说这里换不了,别给一条按了没反应的指令
  assert.match(p.replies[0], /--provider/)                       // 并说清终端里怎么换
  assert.doesNotMatch(p.replies[0], /群内不支持/)                  // 1.0.9 及以前的说法,读起来像群里也切不了
  // 带参数也走同一条只读路 —— 谎报成功比不支持更糟
  await eng.handleMessage(mkMsg('/model glm'), p)
  assert.match(p.replies[1], /终端试跑,不能切换/)
  assert.doesNotMatch(p.replies[1], /已切到/)
  assert.equal(store.getProvider('G'), null, 'group cannot create a runtime provider override')
})

// ── 群内 /model 切模型(v0.11.60,产品决定「全员可切」) ──
// 由来:codex 容量满时群里原样透传「请换个模型」,而切模型只有 operator 做得到 ——
// 等于指引用户去做他做不到的事。
const swCfg = (over = {}) => baseCfg({
  providers: { claude: { model: 'claude-opus-4-8' }, volcano: { baseUrl: 'https://v', apiKey: 'k', model: 'glm-5.2' }, gpt: { runner: 'codex', model: 'gpt-5.6' }, glm: { hidden: true, baseUrl: 'https://g', apiKey: 'k', model: 'glm-x' } },
  groups: { G: { workdir: '/proj', provider: 'claude', permissionMode: 'bypassPermissions' } }, ...over })
// 写入器 fixture:记录被调用的实参(漏传/传错都要能红)
const mkSetProvider = (impl) => { const f = async (chatId, name) => { f.calls.push({ chatId, name }); if (impl) return impl(chatId, name) }; f.calls = []; return f }

test('engine: /model 有写入器时 — 无参教怎么换,并说清换完会重新开始', async () => {
  const p = mkPlatform()
  const eng = new Engine(swCfg(), { runner: okRunner(), store: mkStore(), setProvider: mkSetProvider() })
  await eng.handleMessage(mkMsg('/model'), p)
  assert.match(p.replies[0], /【当前模型】claude · claude-opus-4-8/)
  assert.match(p.replies[0], /\/model 名字/)          // 教它怎么换
  assert.match(p.replies[0], /之前聊的内容不再带着/)  // ⚠ 代价必须写在同一屏
  assert.doesNotMatch(p.replies[0], /控制台/)         // 对照组:不再指向控制台
  // hidden 的不列。⚠ 判据用**只属于它**的型号 `glm-x` —— 拿 /glm/ 判没有分辨力:
  //   volcano 的型号正当地叫 glm-5.2,那条断言会因为完全无关的原因红/绿。
  assert.match(p.replies[0], /volcano · glm-5\.2/)    // 对照组:可切的确实列出来了
  assert.doesNotMatch(p.replies[0], /glm-x/)
})

test('engine: /model <名字> — 调写入器切换并给回执;大小写不敏感', async () => {
  const p = mkPlatform()
  const sp = mkSetProvider()
  const eng = new Engine(swCfg(), { runner: okRunner(), store: mkStore(), setProvider: sp })
  await eng.handleMessage(mkMsg('/model VOLcano'), p)
  assert.deepEqual(sp.calls, [{ chatId: 'G', name: 'volcano' }]) // ⭐ 群 id 与规范化后的名字都要对
  assert.match(p.replies[0], /已切到 volcano · glm-5\.2/)
  assert.match(p.replies[0], /新的一段对话从这里开始/)          // 清了会话就要说
})

test('engine: /model — 认不出的名字 / hidden 的模型 / 已经是当前的,都不调写入器', async () => {
  for (const [arg, want] of [['nope', /没有「nope」这个模型/], ['glm', /没有「glm」这个模型/], ['claude', /已经在用/]]) {
    const p = mkPlatform(); const sp = mkSetProvider()
    const eng = new Engine(swCfg(), { runner: okRunner(), store: mkStore(), setProvider: sp })
    await eng.handleMessage(mkMsg('/model ' + arg), p)
    assert.match(p.replies[0], want, arg)
    assert.equal(sp.calls.length, 0, `「${arg}」不该真去切`)   // ⭐ 判据是「没调写入器」,不是文案
  }
  // 对照组:同一套配置下,一个正当的名字确实切得动 —— 证明上面三个 0 不是写入器压根没接上
  const p = mkPlatform(); const sp = mkSetProvider()
  const eng = new Engine(swCfg(), { runner: okRunner(), store: mkStore(), setProvider: sp })
  await eng.handleMessage(mkMsg('/model volcano'), p)
  assert.equal(sp.calls.length, 1)
})

// ⚠ 换模型要清会话,而手头这一轮正靠它跑 —— 悄悄换掉等于把人正在等的活废了。
test('engine: /model — 群里正忙时拒绝切换,并给出可照做的下一步', async () => {
  const p = mkPlatform(); const sp = mkSetProvider()
  const eng = new Engine(swCfg(), { runner: okRunner(), store: mkStore(), setProvider: sp })
  eng._rt('G').busy = true
  await eng.handleMessage(mkMsg('/model volcano'), p)
  assert.match(p.replies[0], /还有任务在跑/)
  assert.match(p.replies[0], /\/stop/)          // 给一条能照做的路,不是只说「不行」
  assert.equal(sp.calls.length, 0)
  // 对照组:不忙时同一条命令切得动
  eng._rt('G').busy = false
  await eng.handleMessage(mkMsg('/model volcano'), p)
  assert.equal(sp.calls.length, 1)
})

// ⚠ 写入器抛的可能是 fs 错误,原文带着机器上的配置文件绝对路径 —— 回显进群 = 把机器布局
// 发给群成员(用户面零工具名)。群里只说该做什么,详情进日志。
test('engine: /model — 写入器抛错时说没换成,且不把原始报错(含机器路径)带进群', async () => {
  const p = mkPlatform(); const logs = []
  const sp = mkSetProvider(() => { throw new Error("ENOENT: no such file or directory, open '/Users/x/sbot/sbot.config.json'") })
  const eng = new Engine(swCfg(), { runner: okRunner(), store: mkStore(), setProvider: sp, log: (m) => logs.push(m) })
  await eng.handleMessage(mkMsg('/model volcano'), p)
  assert.match(p.replies[0], /没换成/)
  assert.doesNotMatch(p.replies[0], /已切到/)          // 不谎报成功
  assert.doesNotMatch(p.replies[0], /\/Users\/|ENOENT|config\.json/) // 机器路径一个字都不进群
  // 对照组:详情确实没丢,只是去了日志 —— 否则 operator 无从排查
  assert.ok(logs.some((m) => /ENOENT/.test(m)), '原始报错必须进日志')
})

// ⭐ 交接那句的判据必须按**切到的那个**大脑算 —— 它才是接下来读东西的那个。
// 且文案与控制台切模型同源(都来自读取器的 note),两处各写一份必然漂移。
test('engine: /model — 交接那句按切换后的 provider 算,且文案取自读取器', async () => {
  const seen = []
  const probe = (wd, o) => { seen.push({ wd, o }); return { convention: ['CLAUDE.md'], memory: null, landing: 'CLAUDE.md', note: '交接文案占位' } }
  const p = mkPlatform()
  const eng = new Engine(swCfg(), { runner: okRunner(), store: mkStore(), setProvider: mkSetProvider(), projectMemory: probe })
  await eng.handleMessage(mkMsg('/model gpt'), p)   // 切到 codex 系
  const last = seen.at(-1)
  assert.equal(last.wd, '/proj')
  assert.deepEqual(last.o, { full: true, isCodex: true }, '必须按目标 provider(codex)算,不是切换前的 claude')
  assert.match(p.replies[0], /交接文案占位/)        // ⚠ 文案来自读取器,engine 不另写一份
  // 读取器说没东西可交接 ⇒ 那句话一个字都不出现(说了就是假话)
  const p2 = mkPlatform()
  const eng2 = new Engine(swCfg(), { runner: okRunner(), store: mkStore(), setProvider: mkSetProvider(), projectMemory: () => null })
  await eng2.handleMessage(mkMsg('/model volcano'), p2)
  assert.match(p2.replies[0], /已切到/)             // 对照组:切换本身照常
  assert.doesNotMatch(p2.replies[0], /交接文案占位/)
})

// ⭐ 接线(本项目最贵的一类漏:判断写在调用方,单测只测得到被调用的那个纯函数)。
// engine 只知道「调了写入器」,写入器少做一件事它一无所知 —— 而后果各不相同且都不出声:
// 漏配置落盘 ⇒ 重启弹回旧模型 · 漏运行时覆盖 ⇒ 这一轮还用旧的 · **漏清会话 ⇒ 群里说了
// 「新的一段对话从这里开始」而会话没清,把 codex 的 thread-id 喂给 claude 的 --resume**。
test('接线: bin 注入的 /model 写入器必须做齐四件事(少一件就会漂,且都不出声)', () => {
  const fs = require('node:fs'), path = require('node:path')
  const BIN = fs.readFileSync(path.join(__dirname, '..', '..', 'bin', 'sbot.js'), 'utf8')
  const m = BIN.match(/engine\.setProvider = async \([\s\S]*?\n  \}/)
  assert.ok(m, 'bin 里没找到 /model 的写入器 —— 接线没了')
  const body = m[0]
  // ⚠ 对照组:捕获范围必须是那一个函数。贪到整份文件的话,下面四条会全部平凡成立(假绿)。
  assert.ok(body.length > 200 && body.length < 1400, `捕获范围异常(${body.length} 字符),这条断言会失去分辨力`)
  for (const [what, re] of [
    ['配置落盘(否则重启弹回旧模型)', /atomicWriteJSON\(/],
    ['运行时覆盖(否则这一轮还用旧的)', /store\.setProvider\(/],
    ['清会话(否则把上一套后端的会话 id 接给新后端)', /store\.clearSession\(/],
    ['清会话账', /store\.clearSessionStats\(/],
  ]) assert.match(body, re, `写入器漏了「${what}」`)
})

test('engine: /help — 能切时教 /model 名字,并把「后面跟的字不算数」的例外补上', async () => {
  const p = mkPlatform()
  const eng = new Engine(swCfg(), { runner: okRunner(), store: mkStore(), setProvider: mkSetProvider() })
  await eng.handleMessage(mkMsg('/help'), p)
  assert.match(p.replies[0], /\/model 名字/)
  assert.match(p.replies[0], /除 \/issue 与 \/model 外,后面跟的字不算数/) // ⚠ 那是对群成员的明文承诺
  // 不能切时(只有终端试跑):说清这里切不了、换用 --provider,例外也不能乱加(否则等于教一条用不了的写法)
  const p2 = mkPlatform()
  const eng2 = new Engine(swCfg(), { runner: okRunner(), store: mkStore() })
  await eng2.handleMessage(mkMsg('/help'), p2)
  assert.match(p2.replies[0], /终端试跑里不能切,换用 --provider/)
  assert.match(p2.replies[0], /除 \/issue 外,后面跟的字不算数/)
})

test('engine: /model & /status show 「默认」 for a login-type provider without a pinned model (v0.11.1)', async () => {
  // v0.11.0 把「不指定型号、跟随 CLI 默认」变成 claude 订阅登录的推荐形态 —— 群内不能再显示
  // 「claude · ?」像配置坏了。第三方端点(有 baseUrl)缺 model 仍是漏配信号,保留「?」。
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() }) // baseCfg: claude 无 model
  await eng.handleMessage(mkMsg('/model'), p)
  assert.match(p.replies[0], /【当前模型】claude · 默认/)
  assert.match(p.replies[0], /glm · \?/) // 第三方缺 model ⇒ 仍是「?」(漏配信号,不能谎报默认)
  await eng.handleMessage(mkMsg('/status'), p)
  assert.match(p.replies[1], /· 模型:claude · 默认/)
})

test('engine: /status reports provider + workdir', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() })
  await eng.handleMessage(mkMsg('/status'), p)
  assert.match(p.replies[0], /· 模型:claude/)
  assert.match(p.replies[0], /· 项目:proj/) // 零工具名:群消息不出现绝对路径,只给项目名
})

test('engine: /new on idle clears the session', async () => {
  const p = mkPlatform(); const store = mkStore(); store.setSession('G', 'old')
  const eng = new Engine(baseCfg(), { runner: okRunner(), store })
  await eng.handleMessage(mkMsg('/new'), p)
  assert.match(p.replies[0], /新会话/)
  assert.equal(store.getSession('G'), null)
})

test('engine: /stop with no active task says so', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() })
  await eng.handleMessage(mkMsg('/stop'), p)
  assert.match(p.replies[0], /没有正在运行的任务/)
})

test('engine: unknown command hints /help', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() })
  await eng.handleMessage(mkMsg('/frobnicate'), p)
  assert.match(p.replies[0], /未知命令/)
})

test('engine: /new while busy interrupts — drops queue + session, no resurrection', async () => {
  const store = mkStore()
  let started = 0
  const runner = okRunner(({ signal }) => new Promise((resolve) => {
    started++
    const done = () => resolve({ sessionId: 'partial', result: { text: 'x' }, aborted: true })
    if (signal.aborted) return done()
    signal.addEventListener('abort', done)
  }))
  const eng = new Engine(baseCfg(), { runner, store })
  eng.handleMessage(mkMsg('long task'), mkPlatform()); await tick() // NOT awaited — the turn hangs until aborted (platform is fire-and-forget)
  await eng.handleMessage(mkMsg('queued task'), mkPlatform()); await tick() // gets queued
  const rt = eng.rts.get('G')
  assert.equal(rt.busy, true)
  assert.equal(rt.queue.length, 1)
  const p = mkPlatform()
  await eng.handleMessage(mkMsg('/new'), p)
  await tick()
  assert.match(p.replies[0], /已中断/)
  assert.equal(store.getSession('G'), null) // aborted turn's partial session was NOT persisted
  assert.equal(rt.queue.length, 0)           // queued job discarded
  assert.equal(rt.busy, false)
  assert.equal(started, 1)                    // queued job never dispatched
})

test('engine: passes the group\'s own allow/deny + workdir + mode + plugins to the runner', async () => {
  let captured
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', allowedTools: ['Read', 'Bash(npm test *)'], disallowedTools: ['Bash(rm *)'], plugins: { mcp: ['chrome'], skills: ['deploy'] } } } })
  const eng = new Engine(cfg, { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('go'), mkPlatform()); await tick()
  assert.deepEqual(captured.allowedTools, ['Read', 'Bash(npm test *)'])
  assert.deepEqual(captured.disallowedTools, ['Bash(rm *)'])
  assert.equal(captured.workdir, '/proj')
  assert.equal(captured.permissionMode, 'dontAsk')
  assert.deepEqual(captured.plugins, { mcp: ['chrome'], skills: ['deploy'] }) // 原样透传,core 无感
})

test('engine: a group with no perms passes undefined (read-only, fail-closed)', async () => {
  let captured
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude' } } })
  const eng = new Engine(cfg, { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('go'), mkPlatform()); await tick()
  assert.equal(captured.allowedTools, undefined)
  assert.equal(captured.disallowedTools, undefined)
})

test('engine: a normal turn replies with the final text', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's1', result: { text: 'hello there' } })), store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p); await tick()
  assert.equal(p.replies[0], 'hello there')
})

test('engine: NO_REPLY stays silent', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's1', result: { text: NO_REPLY } })), store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p); await tick()
  assert.equal(p.replies.length, 0)
})

// Card-capable platform mock (lazy card + true silence on NO_REPLY).
function mkCardPlatform({ recallOk = true } = {}) {
  const replies = [], cards = []
  return {
    replies, cards,
    reply: (_ctx, text) => { replies.push(text); return Promise.resolve() },
    async createStreamingCard() {
      const card = { updates: [], finished: null, closed: false, recalled: false,
        update(t) { if (!this.closed) this.updates.push(t) },
        async finish(t, opts) { this.closed = true; this.finished = t; this.finishOpts = opts },
        // ack 后转静默时引擎会撤回整张卡(v0.11.10);recallOk:false 模拟撤不掉
        async recall() { this.recalled = recallOk; if (recallOk) this.closed = true; return recallOk } }
      cards.push(card)
      return card
    },
  }
}

test('engine: NO_REPLY turn creates NO card and sends nothing', async () => {
  const p = mkCardPlatform()
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: NO_REPLY }) // token streamed as assistant text too
    return { sessionId: 's', result: { text: NO_REPLY } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('chatter'), p); await tick()
  assert.equal(p.cards.length, 0)   // silence ⇒ no card ever posted
  assert.equal(p.replies.length, 0) // and no plain-text either
})

test('engine: card is created lazily on first non-NO_REPLY output and finalized with it', async () => {
  const p = mkCardPlatform()
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: 'hello ' })
    onEvent({ type: 'assistant', text: 'world' })
    return { sessionId: 's', result: { text: 'hello world' } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p); await tick()
  assert.equal(p.cards.length, 1)
  assert.equal(p.cards[0].finished, 'hello world')
  assert.equal(p.replies.length, 0) // card path — no duplicate plain-text reply
})

// ── 过程只流不留(v0.11.11):卡片最终态只保留最后一次工具调用之后的文本 ──
// 实测过一轮:卡片累积近千字,其中 4 段是「我先去查一下」「已回复…」这类
// 过程播报,答案只是最后一段。群里要的是结论,不是心路历程。

test('engine: 卡片最终只留答案 — 工具调用之前的过程播报不进最终卡片(v0.11.11)', async () => {
  const p = mkCardPlatform()
  const runner = okRunner(async ({ onEvent }) => {
    // claude 形态:text 与 tool_use 同在一个 assistant 事件里,text 在前 ⇒ 这段是「过程说明」
    onEvent({ type: 'assistant', text: '这个问题得按数据核一下,我先去查。', tools: [{ name: 'Bash', input: {} }] })
    onEvent({ type: 'assistant', text: '查到一半,再交叉核对一遍。', tools: [{ name: 'Bash', input: {} }] })
    onEvent({ type: 'assistant', text: '3325 = 本周的去重访问用户,不含爬虫。' }) // 末段无工具 ⇒ 答案
    return { sessionId: 's', result: { text: 'ignored' } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('3325 是什么口径'), p); await tick()
  assert.equal(p.cards.length, 1)
  assert.equal(p.cards[0].finished, '3325 = 本周的去重访问用户,不含爬虫。')
  assert.doesNotMatch(p.cards[0].finished, /我先去查|交叉核对/) // 过程播报一个字都不留
})

test('engine: codex 形态同样成立 — text 与 tools 是分开的事件(v0.11.11)', async () => {
  const p = mkCardPlatform()
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '先跑一下构建。' })
    onEvent({ type: 'assistant', tools: [{ name: 'Bash', input: {} }] }) // 独立的工具事件
    onEvent({ type: 'assistant', text: '构建通过,产物 1.9MB。' })
    return { sessionId: 's', result: { text: 'ignored' } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('构建一下'), p); await tick()
  assert.equal(p.cards[0].finished, '构建通过,产物 1.9MB。')
})

test('engine: 只有过程播报、没有收尾答案 ⇒ 退回累积全量,绝不留空卡(v0.11.11)', async () => {
  const p = mkCardPlatform()
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '这事我已经处理完了,细节都在上面的文件里。', tools: [{ name: 'Bash', input: {} }] })
    return { sessionId: 's', result: { text: '' } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('go'), p); await tick()
  assert.match(p.cards[0].finished, /这事我已经处理完了/) // answer 为空 ⇒ 退回 buf,宁可啰嗦不空卡
})

test('engine: 流式过程照常逐段可见(只是最终态收敛到答案)(v0.11.11)', async () => {
  const p = mkCardPlatform()
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '正在核对…', tools: [{ name: 'Bash', input: {} }] })
    onEvent({ type: 'assistant', text: '结论:一致。' })
    return { sessionId: 's', result: { text: 'ignored' } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('核对'), p); await tick()
  assert.ok(p.cards[0].updates.some((u) => /正在核对/.test(u)), '过程中人要看得见它在动')
  assert.equal(p.cards[0].finished, '结论:一致。')
})

// ── 表格伴随文本(v0.11.4):卡片内表格手机端无法复制 ⇒ finalize 补发 Tab 分隔纯文本 ──

const MD_TABLE = '| 排名 | 页面 | 访问量 |\n| --- | --- | --- |\n| 1 | 首页 | 89 |\n| 2 | 详情页 | 76 |'

test('mdTablesToText: GFM 表格转 Tab 分隔文本,分隔行丢弃', () => {
  const out = mdTablesToText('前言\n' + MD_TABLE + '\n结语')
  assert.equal(out, '排名\t页面\t访问量\n1\t首页\t89\n2\t详情页\t76')
})

test('mdTablesToText: 无表格 / 光有表头没数据 / 缺分隔行 ⇒ 空串', () => {
  assert.equal(mdTablesToText('普通回答,没有表格'), '')
  assert.equal(mdTablesToText(''), '')
  assert.equal(mdTablesToText(null), '')
  assert.equal(mdTablesToText('| a | b |\n| --- | --- |'), '') // 表头+分隔行,零数据
  assert.equal(mdTablesToText('| a | b |\n| 1 | 2 |'), '') // 连续竖线行但缺 GFM 分隔行 ⇒ 不算表格
})

test('mdTablesToText: 代码块围栏里的竖线不算表格', () => {
  const fenced = '```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```'
  assert.equal(mdTablesToText(fenced), '')
})

test('mdTablesToText: 多张表格空行分隔;单元格清理(粗体/行内代码/链接/<br/>/转义竖线)', () => {
  const two = MD_TABLE + '\n\n中间说明\n\n| x |\n| --- |\n| y |'
  assert.equal(mdTablesToText(two).split('\n\n').length, 2)
  const messy = '| 列 |\n| --- |\n| **粗**`码`[标题](http://a.b) A\\|B<br/>尾 |'
  assert.equal(mdTablesToText(messy), '列\n粗码标题 http://a.b A|B 尾')
})

test('engine: 卡片回答含表格 ⇒ 卡片照常收尾,且**不再**补发伴随消息(v0.11.11)', async () => {
  const p = mkCardPlatform()
  const answer = '查询结果:\n\n' + MD_TABLE
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: answer })
    return { sessionId: 's', result: { text: answer } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('查数据'), p); await tick()
  assert.equal(p.cards.length, 1)
  assert.equal(p.cards[0].finished, answer) // 卡片内容不动 —— 渲染照旧
  // v0.11.4~v0.11.10 这里会另发一条「表格文本版」。可复制的内容已收进卡片内的折叠区
  // (feishu.js copyPanel),群里不该再多一条消息 —— 2026-08-06 用户提「太累赘」。
  assert.equal(p.replies.length, 0, '含表格的回答不得再补发伴随消息')
})

test('engine: 卡片回答无表格 ⇒ 不补发伴随消息(零噪音)', async () => {
  const p = mkCardPlatform()
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '普通回答' })
    return { sessionId: 's', result: { text: '普通回答' } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p); await tick()
  assert.equal(p.replies.length, 0)
})

test('engine: 出错轮即使文本带表格也不补发(残缺表格不值得复制)', async () => {
  const p = mkCardPlatform()
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: MD_TABLE })
    return { sessionId: 's', result: { text: MD_TABLE, isError: true } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p); await tick()
  assert.equal(p.cards.length, 1) // 卡片仍收尾(出错文案)
  assert.equal(p.replies.length, 0) // 但没有伴随消息
})

test('engine: 纯文本兜底路径(无卡片)不重复补发 —— 文本本来就可复制', async () => {
  const p = mkPlatform() // 无 createStreamingCard ⇒ 纯文本路径
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's', result: { text: MD_TABLE } })), store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p); await tick()
  assert.equal(p.replies.length, 1) // 只有回答本身,没有第二条
  assert.match(p.replies[0], /\| 排名 \|/) // 原样 markdown(可复制)
})

test('engine: every turn injects the NO_REPLY / sender-tag system appendix', async () => {
  let captured
  const eng = new Engine(baseCfg(), { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('go'), mkPlatform()); await tick()
  assert.match(captured.appendSystemPrompt, /NO_REPLY/)
  assert.match(captured.appendSystemPrompt, /\[time sender\]/)
  assert.match(captured.appendSystemPrompt, /^[\x20-\x7E]+$/) // ASCII-only: travels as argv through cmd.exe on Windows
  // 排版规范(v0.11.5,operator 按真机探针拍板)的两条关键规则钉住:禁 # 标题、别手动重复表格
  assert.match(captured.appendSystemPrompt, /never use # heading lines/)
  // ⚠ 这条钉的是「说法必须跟着实现走」:v0.11.11 把可复制版从「另发一条消息」改成卡片内
  // 折叠区,规范里的措辞同步改了 —— 不同步的话 agent 会以为群里会多出一条,进而自己重复表格。
  assert.match(captured.appendSystemPrompt, /collapsible copyable version is attached/)
  assert.match(captured.appendSystemPrompt, /never repeat the table/)
  // 「简」这一层(v0.11.11):真机取证 200 字的答案被撑成 1500 字 ⇒ 把「先给结论 / 不预告 /
  // 不复述过程 / 不当着本人做第三人称汇报」钉死,漂了立刻红。
  assert.match(captured.appendSystemPrompt, /Lead with the answer/)
  assert.match(captured.appendSystemPrompt, /Do NOT announce work you are about to do/)
  assert.match(captured.appendSystemPrompt, /Never talk ABOUT someone who is in the room/)
  assert.match(captured.appendSystemPrompt, /middle dot \(U\+00B7\)/) // 符号统一,且必须以码点写(ASCII 不变量)
})

test('engine: outbound reply is redacted', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's1', result: { text: 'here: password=supersecretvalue' } })), store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p); await tick()
  assert.match(p.replies[0], /‹redacted›/)
})

// ── 数据明文按群(v0.11.6):groups[chatId].redactPii:false ⇒ 群面 PII 明文,密钥仍遮 ──

test('engine: 默认群 PII 遮盖(fail-closed);redactPii:false 群手机号明文、密钥仍遮', async () => {
  const answer = '联系 13812345678,key=sk-abcdefghijklmnopqrst'
  // 默认群
  const p1 = mkPlatform()
  const e1 = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's', result: { text: answer } })), store: mkStore() })
  await e1.handleMessage(mkMsg('hi'), p1); await tick()
  assert.match(p1.replies[0], /‹redacted:phone›/)
  // 明文群
  const cfg = baseCfg(); Object.values(cfg.groups)[0].redactPii = false
  const p2 = mkPlatform()
  const e2 = new Engine(cfg, { runner: okRunner(async () => ({ sessionId: 's', result: { text: answer } })), store: mkStore() })
  await e2.handleMessage(mkMsg('hi'), p2); await tick()
  assert.match(p2.replies[0], /13812345678/) // PII 放行
  assert.doesNotMatch(p2.replies[0], /sk-abcdefghijklmnopqrst/) // 密钥恒遮
})

test('engine: 明文群卡片路径同口径,且清单注入【数据输出】行', async () => {
  const cfg = baseCfg(); Object.values(cfg.groups)[0].redactPii = false
  let captured
  const p = mkCardPlatform()
  const runner = okRunner(async (opts) => { captured = opts; opts.onEvent({ type: 'assistant', text: '手机 13812345678' }); return { sessionId: 's', result: { text: '手机 13812345678' } } })
  const eng = new Engine(cfg, { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p); await tick()
  assert.match(p.cards[0].finished, /13812345678/)
  assert.match(captured.prompt, /【数据输出】/) // agent 被告知可明文,免得自我审查或绕路
  assert.match(captured.prompt, /原样输出/)
})

test('engine: 默认群清单不注入【数据输出】行(系统兜底,agent 无需知道)', async () => {
  let captured
  const eng = new Engine(baseCfg(), { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), mkPlatform()); await tick()
  assert.doesNotMatch(captured.prompt, /【数据输出】/)
})

test('engine: session id is persisted after a completed turn', async () => {
  const store = mkStore()
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 'sess-new', result: { text: 'ok' } })), store })
  await eng.handleMessage(mkMsg('hi'), mkPlatform()); await tick()
  assert.equal(store.getSession('G'), 'sess-new')
})

test('engine: a busy group queues the next message', async () => {
  let release, n = 0
  const runner = okRunner(() => { n++; return n === 1 ? new Promise((res) => { release = res }) : Promise.resolve({ sessionId: 's', result: { text: 'done' } }) })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  eng.handleMessage(mkMsg('first'), mkPlatform()); await tick() // NOT awaited — hangs until released
  const p2 = mkPlatform()
  await eng.handleMessage(mkMsg('second'), p2); await tick()
  assert.match(p2.replies[0], /已排队/)
  release({ sessionId: 's', result: { text: 'done' } }) // 1st resolves → queued 2nd drains (resolves immediately)
  await tick()
})

test('engine: global-cap wait notifies the group and /stop cancels the wait (FR7.2)', async () => {
  const cfg = baseCfg({
    agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 1, maxTurnTimeMins: 0 },
    groups: { G: { workdir: '/proj', provider: 'claude' }, H: { workdir: '/proj2', provider: 'claude' } },
  })
  let release, runs = 0
  const runner = okRunner(() => { runs++; return new Promise((res) => { release = res }) })
  const eng = new Engine(cfg, { runner, store: mkStore() })
  eng.handleMessage(mkMsg('long', 1, 'G'), mkPlatform()); await tick() // takes the only slot
  const pH = mkPlatform()
  eng.handleMessage(mkMsg('second', 2, 'H'), pH); await tick()
  assert.match(pH.replies[0], /已排队/) // the wait is visible, not a silent hang
  assert.equal(runs, 1)                    // H's turn has NOT spawned
  const pStop = mkPlatform()
  await eng.handleMessage(mkMsg('/stop', 3, 'H'), pStop); await tick()
  assert.match(pStop.replies[0], /已停止/) // 单条终态确认(取代旧的「正在停止…」+ 第二条)
  assert.equal(pH.replies.length, 1, '等待中的 turn 不再各发一条重复确认 — /stop 处理器统一发')
  assert.equal(eng.rts.get('H').busy, false)
  assert.equal(runs, 1)
  release({ sessionId: 's', result: { text: 'done' } }); await tick() // drain G
})

test('engine: appends a per-turn ledger record (NFR5)', async () => {
  const records = []
  const runner = okRunner(async () => ({ sessionId: 's', result: { text: 'ok', usage: { input_tokens: 3, output_tokens: 5 } } }))
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
  assert.equal(records.length, 1)
  assert.equal(records[0].chatId, 'G')
  assert.equal(records[0].provider, 'claude')
  assert.equal(records[0].status, 'ok')
  assert.deepEqual(records[0].tokens, { in: 3, out: 5 })
  assert.ok(records[0].ts > 0 && records[0].ms >= 0)
})

// ── 账本记下失败原因(v0.11.61)────────────────────────────────────────────
// 由来(2026-09-01 真机):生产群一周 15 次 error,**一次都查不出原因** —— 账本只记
// `status:"error"` 一个字的原因都没有,而日志那边又没有时间戳,两边对不上号。
// 原因其实一直在手上(preview/subtype),只是落盘时被丢掉了。
test('engine: 失败轮的账本带上原因(subtype + 人话),ok 轮一个字节都不多写', async () => {
  // 失败:runner 报 isError,正文即错误原文
  let records = []
  let runner = okRunner(async () => ({ sessionId: 's', result: { isError: true, subtype: 'error_max_turns', text: '轮次上限' } }))
  let eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
  assert.equal(records[0].status, 'error')
  assert.match(records[0].err, /error_max_turns/)   // 机器可读那半:能拿去分类计数
  assert.match(records[0].err, /轮次上限/)          // 人话那半:能读懂
  // ok 轮:**不带 err 字段**(账本一轮一行,常态不该为异常付代价)
  records = []
  runner = okRunner(async () => ({ sessionId: 's', result: { text: '干完了' } }))
  eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
  assert.equal(records[0].status, 'ok')
  assert.equal('err' in records[0], false, 'ok 轮不该出现 err 字段')
})

// 控制台活动行出错时直接显示原因:done 事件带的 err 与账本是同一个值;ok 轮不带
test('engine: 失败轮的 done 活动事件带上与账本同一句原因,ok 轮不带', async () => {
  const records = []; const done = []
  let eng = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's', result: { isError: true, subtype: 'error_max_turns', text: '轮次上限' } })), store: mkStore(),
    ledger: { append: (r) => records.push(r) }, onActivity: (a) => { if (a.kind === 'done') done.push(a) } })
  await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
  assert.equal(done[0].status, 'error')
  assert.equal(done[0].err, records[0].err)
  assert.match(done[0].err, /轮次上限/)
  done.length = 0
  eng = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's', result: { text: '干完了' } })), store: mkStore(), onActivity: (a) => { if (a.kind === 'done') done.push(a) } })
  await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
  assert.equal(done[0].status, 'ok')
  assert.equal('err' in done[0], false)
})

// ⚠ 「字段缺席」与「记了但没拿到原因」必须分得开 —— 否则又是「没查过」和「查过没问题」
//   长一模一样(本项目最贵的那条教训)。缺席 = 旧账本格式;通用句 = 我们记了、runner 没给。
test('engine: 失败却拿不到原因时也写一句,不留空', async () => {
  const records = []
  const runner = okRunner(async () => ({ sessionId: 's', result: { isError: true, text: '' } })) // 无 subtype 无正文
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
  assert.equal(records[0].status, 'error')
  assert.equal(records[0].err, '(未拿到原因)')
})

test('engine: 只有失败才写 err —— 人主动叫停 / 静默轮不算失败', async () => {
  // stopped:用户 /stop,不是故障
  const records = []
  const runner = okRunner(async () => ({ sessionId: 's', aborted: true, result: { text: '' } }))
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
  assert.equal(records[0].status, 'stopped')
  assert.equal('err' in records[0], false)
  // 对照组:同一套装置下,真失败确实会写 —— 证明上面的「没有」不是 err 压根没接上
  const r2 = []
  const eng2 = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's', result: { isError: true, text: '炸了' } })), store: mkStore(), ledger: { append: (r) => r2.push(r) } })
  await eng2.handleMessage(mkMsg('x'), mkPlatform()); await tick()
  assert.match(r2[0].err, /炸了/)
})

// ⭐ 账本与 /issue 指纹**共用同一个失败原因**(算一次)。群成员报问题的原话通常就是
// 「它刚才没理我」,这份指纹是唯一能把「空轮 / 超时 / 模型报错」分开的东西。
test('engine: /issue 附带的上一轮指纹也带失败原因,且与账本逐字相同', async () => {
  const records = []; const added = []
  const runner = okRunner(async () => ({ sessionId: 's', result: { isError: true, subtype: 'quota', text: '额度用尽' } }))
  const eng = new Engine(baseCfg(), { runner, store: mkStore(),
    ledger: { append: (r) => records.push(r) },
    issues: { add: (r) => { added.push(r); return { id: 1, sender: r.sender, text: r.text } } } })
  const p = mkPlatform()
  await eng.handleMessage(mkMsg('do it'), p); await tick()
  await eng.handleMessage(mkMsg('/issue 它刚才没理我'), p); await tick()
  assert.equal(added.length, 1)
  assert.match(added[0].turn.err, /quota/)
  assert.match(added[0].turn.err, /额度用尽/)
  assert.equal(added[0].turn.err, records[0].err, '两处必须逐字相同 —— 算两次就会漂')
  // ⚠ 判据要钉在**渲染结果**上:存进去了但渲染层丢掉,等于承诺的能力一个字没到用户手上
  //   (第一版正是如此,而当时断言的是裸对象、全绿)。
  const { fingerprint } = require('../../src/core/issues')
  assert.match(fingerprint(added[0].turn), /quota/)
  // 对照组:ok 轮的指纹不带 err(否则「有 err」就不再是失败的信号)
  const r2 = []; const a2 = []
  const eng2 = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's', result: { text: '好了' } })), store: mkStore(),
    ledger: { append: (r) => r2.push(r) }, issues: { add: (r) => { a2.push(r); return { id: 2, sender: '', text: '' } } } })
  const p2 = mkPlatform()
  await eng2.handleMessage(mkMsg('x'), p2); await tick()
  await eng2.handleMessage(mkMsg('/issue 随便说说'), p2); await tick()
  assert.equal('err' in a2[0].turn, false)
})

// ⭐⭐ 本功能最贵的一条:**不能拿正常正文冒充错误原因**。
// 出错轮的 result.text 常常是空的,而 outcome.preview 是 `finalText || buf` ⇒ 会退回 buf =
// **模型崩掉之前流式吐的那段正常回答**。第一版正是那么写的:账本里一个叫 err 的字段,内容是
// 「好的,我先读一下…」—— 查的人拿到一个自信的错误答案,比只有 status:"error" 更糟。
test('engine: 出错轮的原因**不许**是崩溃前流式吐的正常正文', async () => {
  const records = []
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '好的,我先读一下配置再给你改。' }) // 崩溃前的正常回答
    return { sessionId: 's', result: { isError: true, subtype: 'error_during_execution', text: '' } } // 出错时 text 常为空
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
  assert.equal(records[0].status, 'error')
  assert.doesNotMatch(records[0].err, /我先读一下/, 'err 里混进了正常正文 —— 那是自信的错误答案')
  assert.match(records[0].err, /error_during_execution/) // 对照组:该有的细分码在,不是整条空了
})

// ⚠ 这两条路径的原因**完全已知、而且已经原样发进群了**,却因为没接到落盘那条线上而落
//   「(未拿到原因)」—— 查的人会去查 runner,方向正好相反。
// ⚠ 射程内:v0.11.60 刚把 /model 开放给全员,任何人切到一个缺密钥的模型,之后每轮都是这个形状。
test('engine: provider 未配置 / 缺密钥 —— 原因要如实落盘,不是「未拿到原因」', async () => {
  for (const [cfgOver, want] of [
    [{ groups: { G: { workdir: '/w', provider: 'nope' } } }, /provider_not_configured/],
    [{ providers: { nokey: { baseUrl: 'https://x' } }, groups: { G: { workdir: '/w', provider: 'nokey' } } }, /provider_missing_key/],
  ]) {
    const records = []
    const eng = new Engine(baseCfg(cfgOver), { runner: okRunner(), store: mkStore(), ledger: { append: (r) => records.push(r) } })
    await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
    assert.equal(records[0].status, 'error')
    assert.match(records[0].err, want)
    assert.doesNotMatch(records[0].err, /未拿到原因/)
  }
})

test('engine: runner 抛异常(failed)也要记原因,且密钥被遮住', async () => {
  const records = []
  const runner = okRunner(async () => { throw new Error("spawn failed ANTHROPIC_AUTH_TOKEN=sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF") })
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
  assert.equal(records[0].status, 'failed')
  assert.match(records[0].err, /exception/)
  assert.match(records[0].err, /spawn failed/)
  assert.doesNotMatch(records[0].err, /AAAABBBBCCCC/, '密钥不能原样落盘') // catch 那条 preview 未脱敏,靠这里兜
})

// ⚠ 账本是结构化记录,日志才有**上下文**(失败前调了什么工具、卡片推送有没有报错)。
// 此前 error/failed 这条路在日志里一个字都不留 —— 账本说「失败了」、日志连提都没提。
test('engine: 失败时日志也留一行(带群 id 与原因),ok 轮不留', async () => {
  const logs = []
  const runner = okRunner(async () => ({ sessionId: 's', result: { isError: true, subtype: 'boom', text: '炸了' } }))
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), log: (m) => logs.push(m) })
  await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
  const line = logs.find((m) => /轮次失败/.test(m))
  assert.ok(line, '失败没在日志里留痕')
  assert.match(line, /G/)      // 群 id:多群同跑时没它就对不上是谁
  assert.match(line, /boom/)
  assert.match(line, /炸了/)
  // 对照组:ok 轮不留(否则日志里全是「失败」就没人看了)
  const l2 = []
  const eng2 = new Engine(baseCfg(), { runner: okRunner(), store: mkStore(), log: (m) => l2.push(m) })
  await eng2.handleMessage(mkMsg('x'), mkPlatform()); await tick()
  assert.equal(l2.some((m) => /轮次失败/.test(m)), false)
})

// ⚠ 这条钉的是**那两层 finally**,不是日志那行外面有没有 try —— 它对「加不加 try」正反都绿
//   (实测过),所以别把它当成「try 有效」的证据(教训 29:正反都绿的测试比没有更糟)。
//   它有意义的地方在于:哪天 `_runTurn` 末尾的 releaseSlot finally、或外层 finally 的
//   `release()` 被重构掉,这条会红 —— 而那才是真正会卡死所有群的改动。
test('engine: reportDone 内部抛错时,并发槽与群锁仍被两层 finally 释放', async () => {
  const runner = okRunner(async () => ({ sessionId: 's', result: { isError: true, subtype: 'boom', text: '炸了' } }))
  const eng = new Engine(baseCfg({ agent: { maxConcurrent: 2 } }), { runner, store: mkStore(), log: () => { throw new Error('日志坏了') } })
  // ⚠ 只跑 maxConcurrent 轮:再多一轮的话,槽一旦泄漏就会**永久阻塞**、把整个 run 拖死
  //   (实测 223 例掉到 63 而 fail 仍是 0 —— 总数掉了就是有文件没跑起来,fail 数会骗人)。
  for (let i = 0; i < 2; i++) { await eng.handleMessage(mkMsg('do ' + i), mkPlatform()); await tick() }
  assert.equal(eng.sem.cur, 0, `并发槽泄漏了(cur=${eng.sem.cur}/${eng.sem.max})—— 再来几轮就没人跑得动了`)
  assert.equal(eng._rt('G').busy, false)
})

test('engine: 空轮不写 err —— empty 本身就是信号,不是「有原因的失败」', async () => {
  const records = []
  // 零产出 ⇒ 引擎会静默重试一次,两轮都空
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's', result: { text: '' } })), store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('do it'), mkPlatform()); await tick()
  assert.ok(records.length >= 1)
  assert.equal(records.at(-1).status, 'empty')
  assert.equal('err' in records.at(-1), false)
})

test('turnErrText: 细分码 + 人话 · 脱敏 · 限长 · codex 的空细分码丢掉', () => {
  const { turnErrText } = require('../../src/core/engine')
  assert.equal(turnErrText('error_max_turns', '轮次到顶'), 'error_max_turns: 轮次到顶')
  assert.equal(turnErrText(null, 'only'), 'only')
  assert.equal(turnErrText('only', ''), 'only')
  assert.equal(turnErrText('', ''), '')
  assert.equal(turnErrText(null, null), '')
  // ⚠ codex 侧 subtype 恒为字面量 'error'(与 status 同义、零信息)⇒ 不该白占字数
  assert.equal(turnErrText('error', 'stream disconnected'), 'stream disconnected')
  // 密钥不能原样落盘(账本会被 ssh 出去跨机汇总)
  const red = turnErrText('auth', 'bad key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH')
  assert.doesNotMatch(red, /AAAABBBBCCCC/)
  assert.match(red, /auth/) // 对照组:非敏感部分照留,不是整条被吞掉
  // ⚠ **先截断再脱敏**:redact 在**无分隔长串**上是二次的,而 UI 与 daemon 同进程,一次卡死
  //   就是全群停摆(本项目栽过一次同形的 O(N²) 提炼器)。
  //   ⚠ 判据用的输入必须是**真会退化的那种形状** —— 实测:重复邮箱 120KB 只要 1ms(选它等于
  //   没测),而 64KB 无分隔字母要 1853ms。第一版就选错了,变异当场活了下来。
  const huge = 'a'.repeat(65536)
  const t0 = Date.now()
  const out = turnErrText('x', huge)
  assert.ok(Date.now() - t0 < 300, `先截断再脱敏才够快,实测 ${Date.now() - t0}ms`)
  assert.ok(out.length <= 400)
  assert.ok(turnErrText('x', 'y'.repeat(5000)).length <= 400)
})

test('fmtLogStamp: MM-DD HH:MM:SS,按给定时区(不是主机时区)', () => {
  const { fmtLogStamp } = require('../../src/core/time')
  const ts = Date.UTC(2026, 8, 1, 16, 5, 9) // 2026-09-01T16:05:09Z
  assert.equal(fmtLogStamp(ts, 'Asia/Shanghai'), '09-02 00:05:09') // 北京 +8 ⇒ 跨日、且是 00 不是 24
  assert.equal(fmtLogStamp(ts, 'America/New_York'), '09-01 12:05:09')
  assert.match(fmtLogStamp(ts, undefined), /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) // 缺省回落也得是这个形状
  assert.notEqual(fmtLogStamp(ts, 'Asia/Shanghai'), fmtLogStamp(ts, 'America/New_York')) // 对照组:时区真的起作用
})

// ⭐ 账本的「原因」与日志的「时间戳」是**一对**:少任何一半都查不成 —— 账本说「这一轮
// 失败了」、日志说「某处报了什么错」,没有时间戳就无法判断是不是同一件事。故一并钉住。
test('接线: daemon 日志每行带时间戳,按产品时区打,且横幅写明是哪个时区', () => {
  const fs = require('node:fs'), path = require('node:path')
  const BIN = fs.readFileSync(path.join(__dirname, '..', '..', 'bin', 'sbot.js'), 'utf8')
  const m = BIN.match(/^\s*const log = \(m\) =>.*$/m)
  assert.ok(m, 'daemon 的日志出口没找到 —— 接线变了')
  assert.match(m[0], /logStamp\(\)/, '日志行没带时间戳')
  // ⚠ 必须按**产品时区**,不是主机时区:日志时间是拿去和群消息对照的,而本机与产品时区差 12 小时
  assert.match(BIN, /const logTz = normalizeTz\(cfg\.timezone\)/)
  // ⚠ 戳记的**内容**由 fmtLogStamp 保证(上面那条用例真断言了格式与时区)——
  //   这里只钉接线。此前戳记逻辑内联在闭包里够不着,打成 `2026-2026 2026:2026` 也测不出来。
  assert.match(BIN, /const logStamp = \(\) => fmtLogStamp\(Date\.now\(\), logTz\)/)
  // ⚠ 横幅写明时区 —— 本项目栽过「两把钟不许比大小」,不写清楚就会被读错
  assert.match(BIN, /log times in \$\{logTz\}/)
})

// ── Token 口径修正(v0.11.17)────────────────────────────────────────────────
// 背景是 2026-08-09 的实测:claude 的 ledger `in` 常年个位数(大头在缓存字段被丢),
// codex 的 `in` 是会话累计(一句「好了吗」录出 322 万)。以下钉住归一后的两条口径。

test('engine: ledger 带上缓存读写字段 — claude 形态 usage 不再只记未命中零头', async () => {
  const records = []
  const usage = { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300 }
  const runner = okRunner(async () => ({ sessionId: 's', result: { text: 'ok', usage } }))
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('do'), mkPlatform()); await tick()
  assert.deepEqual(records[0].tokens, { in: 2, out: 9, cr: 1000, cw: 300 })
})

test('engine: usageCumulative 的会话累计经 store 基线换算成本轮增量', async () => {
  const records = []
  let call = 0
  const totals = [
    { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 },
    { input_tokens: 3000, cached_input_tokens: 2400, output_tokens: 80 },
  ]
  // 真实流里 thread.started(system init)先于 result 到,engine 靠它知道本轮会话 id
  const runner = okRunner(async (opts) => {
    opts.onEvent({ type: 'system', subtype: 'init', sessionId: 'tid' })
    return { sessionId: 'tid', result: { text: 'ok', usage: totals[call++], usageCumulative: true } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('a', 1), mkPlatform()); await tick()
  await eng.handleMessage(mkMsg('b', 2), mkPlatform()); await tick()
  assert.deepEqual(records[0].tokens, { in: 400, out: 50, cr: 600 })  // 首轮:累计即本轮;in 已扣缓存
  assert.deepEqual(records[1].tokens, { in: 200, out: 30, cr: 1800 }) // 次轮:对基线求差,不再把累计当单轮
})

test('engine: autocompactTokens 从配置流到 runner;缺省 ⇒ 0;区间外收编进 [10万,100万]', async () => {
  const got = []
  const runner = okRunner(async (opts) => { got.push(opts.autocompactTokens); return { sessionId: 's', result: { text: 'ok' } } })
  const mk = (v) => baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, ...(v == null ? {} : { autocompactTokens: v }) } })
  for (const v of [400000, null, 50000, 5_000_000, 0]) {
    await new Engine(mk(v), { runner, store: mkStore() }).handleMessage(mkMsg('go'), mkPlatform()); await tick()
  }
  // 50000→10万、500万→100万:手改配置写出 CLI 拒收的区间外值时静默收编,不让每轮必死;
  // 0 与缺省不收编(关闭语义)。真实 daemon 的默认 40 万由 config 层 DEFAULTS 合并提供。
  assert.deepEqual(got, [400000, 0, 100000, 1000000, 0])
})

test('engine: 压缩事件 → 群里通知一次并报上下文量;三条数据路径;文案零工具名(v0.11.19)', async () => {
  // ① 轮首压缩:量来自会话账里上一轮收尾的 ctx(此刻本轮还没有任何用量数)
  const store = mkStore(); store.setSession('G', 's0')
  store.putSessionStats('G', { sessionId: 's0', turns: 3, in: 1, out: 1, ctx: 372000 })
  const runner = okRunner(async (opts) => {
    opts.onEvent({ type: 'system', subtype: 'compact_boundary' })
    opts.onEvent({ type: 'system', subtype: 'compact_boundary' }) // 同轮第二次 → 不再发
    return { sessionId: 's0', result: { text: 'ok' } }
  })
  const p = mkPlatform()
  await new Engine(baseCfg(), { runner, store }).handleMessage(mkMsg('do'), p); await tick()
  const notices = p.replies.filter((r) => /压缩/.test(r))
  assert.equal(notices.length, 1, '每轮至多一条压缩通知')
  assert.match(notices[0], /此前上下文约 37\.2万 token/)
  assert.doesNotMatch(notices[0], /sbot|compact|claude/i) // 发给群成员的纯文本,零工具名
  // ② 轮中压缩:本轮流式的逐请求值覆盖会话账起点,谁新用谁
  const r2 = okRunner(async (opts) => {
    opts.onEvent({ type: 'assistant', text: 'x', contextTokens: 405000 })
    opts.onEvent({ type: 'system', subtype: 'compact_boundary' })
    return { sessionId: 's', result: { text: 'ok' } }
  })
  const p2 = mkPlatform()
  await new Engine(baseCfg(), { runner: r2, store: mkStore() }).handleMessage(mkMsg('do'), p2); await tick()
  assert.match(p2.replies.find((r) => /压缩/.test(r)), /约 40\.5万 token/)
  // ③ 无任何量(新会话极早期):退无数字版,不编数
  const r3 = okRunner(async (opts) => { opts.onEvent({ type: 'system', subtype: 'compact_boundary' }); return { sessionId: 's', result: { text: 'ok' } } })
  const p3 = mkPlatform()
  await new Engine(baseCfg(), { runner: r3, store: mkStore() }).handleMessage(mkMsg('do'), p3); await tick()
  const n3 = p3.replies.find((r) => /压缩/.test(r))
  assert.match(n3, /会话已自动压缩:/)
  assert.doesNotMatch(n3, /约 .*token/)
})

// 压缩通知后带上当前模型额度(产品决定)。判据与 /hud 同一出口(_quotaLine),
// 但自动附带的口径更收敛:有数才说,模型本就不支持查的一个字不出 —— 人没问,别多嘴。
test('engine: 压缩通知附带当前模型额度 —— 与通知并成一条;探针失败/不支持/没探针都不拦通知', async () => {
  const compactRunner = () => okRunner(async (opts) => {
    opts.onEvent({ type: 'assistant', text: 'x', contextTokens: 405000 })
    opts.onEvent({ type: 'system', subtype: 'compact_boundary' })
    return { sessionId: 's', result: { text: 'ok' } }
  })
  const run = async (usageProbe) => {
    const p = mkPlatform()
    await new Engine(baseCfg(), { runner: compactRunner(), store: mkStore(), ...(usageProbe ? { usageProbe } : {}) }).handleMessage(mkMsg('do'), p); await tick()
    return p.replies.filter((r) => /压缩|额度/.test(r))
  }
  // ① 查到了 ⇒ 通知 + 额度行在**同一条**消息里(不是两条),通知在前
  const a = await run(async () => ({ supported: true, value: '5h:12% │ 7d:40%' }))
  assert.equal(a.length, 1, '通知与额度必须并成一条,群里不多刷一条')
  assert.match(a[0], /^🔄 会话已自动压缩\(此前上下文约 40\.5万 token\)/) // ⚠ 正文括号是 ASCII,正则里得转义,否则成了分组
  assert.match(a[0], /\nclaude 额度:5h:12% │ 7d:40%$/)
  // ② 能查但这次没查到 ⇒ 仍说一句「暂时没查到」(否则会被读成没这功能)
  const b = await run(async () => ({ supported: true, value: null }))
  assert.equal(b.length, 1); assert.match(b[0], /暂时没查到/); assert.doesNotMatch(b[0], /不支持/)
  // ③ 模型本就不支持查 ⇒ 只有通知,不多嘴「不支持」(对照组:/hud 人问了才答那句)
  const c = await run(async () => ({ supported: false, value: null }))
  assert.equal(c.length, 1); assert.match(c[0], /会话已自动压缩/); assert.doesNotMatch(c[0], /额度|不支持/)
  // ④ 探针抛错 ⇒ 通知照发,不因为附带的东西丢了主体
  const d = await run(async () => { throw new Error('boom') })
  assert.equal(d.length, 1); assert.match(d[0], /会话已自动压缩/); assert.doesNotMatch(d[0], /额度/)
  // ⑤ 没注入探针(CLI 试跑)⇒ 只有通知,也不出「需要后台服务」那句
  const e = await run(null)
  assert.equal(e.length, 1); assert.match(e[0], /会话已自动压缩/); assert.doesNotMatch(e[0], /后台服务|额度/)
  for (const r of [a, b, c, d, e]) assert.doesNotMatch(r[0], /sbot|compact|curl/i) // 零工具名
})

test('engine: 压缩通知带阈值与会话用量行 —— 阈值取生效值、关着不提;会话行只认当前会话的账', async () => {
  const agent = (extra) => ({ bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, ...extra })
  const run = async ({ autocompactTokens, statsSid = 's0', withStats = true }) => {
    const store = mkStore(); store.setSession('G', 's0')
    if (withStats) store.putSessionStats('G', { sessionId: statsSid, turns: 36, in: 6_120_000, out: 50_000, ctx: 372000 })
    const runner = okRunner(async (opts) => { opts.onEvent({ type: 'system', subtype: 'compact_boundary' }); return { sessionId: 's0', result: { text: 'ok' } } })
    const cfg = baseCfg({ agent: agent(autocompactTokens == null ? {} : { autocompactTokens }) })
    const p = mkPlatform()
    await new Engine(cfg, { runner, store, usageProbe: async () => ({ supported: true, value: '5h:12%' }) }).handleMessage(mkMsg('do'), p); await tick()
    return p.replies.find((r) => /压缩/.test(r)).split('\n')
  }
  // 三行:通知(含阈值)· 额度 · 会话用量;顺序钉死(用户挑的就是这个样子)
  const a = await run({ autocompactTokens: 400000 })
  assert.equal(a.length, 3)
  assert.match(a[0], /^🔄 会话已自动压缩\(此前上下文约 37\.2万 token · 阈值 40万\):/)
  assert.doesNotMatch(a[0], /超过/, '轮首压缩报的是上一轮的上下文,可能还没到阈值,不许说「超过」')
  assert.equal(a[1], 'claude 额度:5h:12%')
  assert.equal(a[2], '【会话】第 37 轮 · 累计处理约 612万 token') // 36 轮已结算 + 进行中的这轮
  // 阈值取**生效值**:配置写 5 万会被收编成 10 万(与 /hud 同源 _autocompactTokens),通知报收编后的数
  assert.match((await run({ autocompactTokens: 50000 }))[0], /阈值 10万/)
  // 阈值关着(0 / 缺省)⇒ 首句不提阈值,其它两行照旧
  for (const v of [0, null]) {
    const b = await run({ autocompactTokens: v })
    assert.equal(b.length, 3); assert.match(b[0], /压缩\(此前上下文约 37\.2万 token\):/); assert.doesNotMatch(b[0], /阈值/)
  }
  // 会话账不是当前会话的(sessionId 对不上)⇒ 不出会话行;压根没账 ⇒ 同样不出
  for (const o of [{ statsSid: 's9' }, { withStats: false }]) {
    const c = await run({ autocompactTokens: 400000, ...o })
    assert.equal(c.length, 2, JSON.stringify(o)); assert.doesNotMatch(c.join('\n'), /【会话】/)
    assert.match(c[0], /阈值 40万/) // 对照组:少的只是会话行
  }
})

test('engine: 压缩通知的上下文量在压缩那一刻快照 —— 探针慢回来时不许被压缩后的新值顶掉', async () => {
  // 探针 40ms 才回,期间压缩后的请求已把 contextTokens 更新成 9 万:通知报的仍须是压缩前的 40.5 万
  const runner = okRunner(async (opts) => {
    opts.onEvent({ type: 'assistant', text: 'x', contextTokens: 405000 })
    opts.onEvent({ type: 'system', subtype: 'compact_boundary' })
    await new Promise((r) => setTimeout(r, 10))
    opts.onEvent({ type: 'assistant', text: 'y', contextTokens: 90000 })
    return { sessionId: 's', result: { text: 'ok' } }
  })
  const usageProbe = () => new Promise((r) => setTimeout(() => r({ supported: true, value: '5h:1%' }), 40))
  const p = mkPlatform()
  await new Engine(baseCfg(), { runner, store: mkStore(), usageProbe }).handleMessage(mkMsg('do'), p)
  await new Promise((r) => setTimeout(r, 80))
  const n = p.replies.find((r) => /压缩/.test(r))
  assert.match(n, /此前上下文约 40\.5万 token/, '报压缩前的量')
  assert.doesNotMatch(n, /9万/)
  assert.match(n, /5h:1%/, '对照组:额度行确实等到了探针的值')
})

test('engine: 定时任务 resetSessionAfter — 成功结算后翻篇,出错/被叫停保留会话(v0.11.19)', async () => {
  const reset = (extra) => ({ ...mkMsg('每日整理'), synthetic: true, resetSessionAfter: true, ...extra })
  // 成功轮:setSession('s1') 之后被清 —— 下一轮从零开始
  const store = mkStore(); store.setSession('G', 's0')
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's1', result: { text: 'done' } })), store })
  await eng.handleMessage(reset(), mkPlatform()); await tick()
  assert.equal(store.getSession('G'), null, '成功结算后会话已清(含 setSession 写回之后的次序)')
  // 出错轮:不翻篇 —— 会话留着,人工重试还有上下文
  const store2 = mkStore()
  await new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's1', result: { text: 'boom', isError: true } })), store: store2 }).handleMessage(reset(), mkPlatform()); await tick()
  assert.equal(store2.getSession('G'), 's1', '出错不翻篇')
  // 被叫停(aborted):不翻篇
  const store3 = mkStore()
  await new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's1', result: { text: 'x' }, aborted: true })), store: store3 }).handleMessage(reset(), mkPlatform()); await tick()
  assert.equal(store3.getSession('G'), 's1', '被叫停不翻篇')
  // 普通消息(无标)不受影响
  const store4 = mkStore()
  await new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's1', result: { text: 'ok' } })), store: store4 }).handleMessage(mkMsg('hi'), mkPlatform()); await tick()
  assert.equal(store4.getSession('G'), 's1')
})

test('engine: /hud 会话行 — 显示轮数/上下文/压缩阈值,/new 清账后消失', async () => {
  const store = mkStore()
  const cfg = baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, autocompactTokens: 400000 } })
  const runner = okRunner(async (opts) => {
    opts.onEvent({ type: 'system', subtype: 'init', sessionId: 'sid1' })
    return { sessionId: 'sid1', result: { text: 'ok', usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 419996 }, contextTokens: 420000 } }
  })
  const eng = new Engine(cfg, { runner, store, usageProbe: async () => '5h 已用1%' })
  await eng.handleMessage(mkMsg('do', 1), mkPlatform()); await tick()
  const p = mkPlatform(); await eng.handleMessage(mkMsg('/hud', 2), p)
  assert.match(p.replies[0], /【会话】第 1 轮/)
  assert.match(p.replies[0], /上下文约 42万 token/)
  assert.match(p.replies[0], /超 40万 会自动压缩/)
  assert.doesNotMatch(p.replies[0], /sbot|--autocompact/i) // 零工具名:发给群成员的行
  await eng.handleMessage(mkMsg('/new', 3), mkPlatform())
  const p2 = mkPlatform(); await eng.handleMessage(mkMsg('/hud', 4), p2)
  assert.doesNotMatch(p2.replies[0], /【会话】/) // 旧会话的规模账不许挂在新会话头上
})

test('engine: unbound chat gets guidance ONCE, then silence (FR1.2, P2)', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg({ groups: {} }), { runner: okRunner(), store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p)
  await eng.handleMessage(mkMsg('hello?'), p)
  await eng.handleMessage(mkMsg('anyone?'), p)
  assert.equal(p.replies.length, 1) // no per-message nagging
  assert.match(p.replies[0], /没有绑定项目/)
})

test('engine: stop(chatId) cancels the running turn without touching rts internals (P2)', async () => {
  let release
  const runner = okRunner(({ signal }) => new Promise((resolve) => {
    release = () => resolve({ sessionId: 's', result: { text: 'x' }, aborted: true })
    signal.addEventListener('abort', release)
  }))
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  eng.handleMessage(mkMsg('long'), mkPlatform()); await tick()
  assert.equal(eng.stop('G'), true)
  await tick()
  assert.equal(eng.rts.get('G').busy, false)
  assert.equal(eng.stop('G'), false) // nothing left to stop
})

test('engine: group.permissionMode overrides the global agent mode', async () => {
  let captured
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', permissionMode: 'bypassPermissions' } } })
  const eng = new Engine(cfg, { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('go'), mkPlatform()); await tick()
  assert.equal(captured.permissionMode, 'bypassPermissions')
})

test('engine: result event finalizes at answer-time; lock + session held to close', async () => {
  // A runner that streams the answer and emits the terminal `result` event BEFORE its
  // promise resolves — modelling codex, whose process (and thus close) can cling to the
  // stdout pipe for seconds past the answer. Finalize must ride the result event; the
  // per-group lock + session persistence must ride the (later) close.
  let resolveTurn = null
  const runner = okRunner((opts) => new Promise((res) => {
    resolveTurn = () => res({ sessionId: 'sess-1', result: { text: 'the answer' } })
    opts.onEvent({ type: 'assistant', text: 'the answer' })
    opts.onEvent({ type: 'result', subtype: 'success', text: 'the answer', usage: { input_tokens: 1, output_tokens: 2 } })
  }))
  const activity = []
  const store = mkStore()
  const eng = new Engine(baseCfg(), { runner, store, onActivity: (e) => activity.push(e) })

  const p = mkPlatform()
  eng.handleMessage(mkMsg('q'), p) // NOT awaited — the runner promise stays pending (process not closed)
  await tick()

  const rt = eng.rts.get('G')
  // Answer delivered: reply out at answer-time, console activity 'done' fired...
  assert.deepEqual(p.replies, ['the answer'], 'reply delivered at answer-time, not at close')
  assert.equal(activity.filter((a) => a.kind === 'done' && a.status === 'ok').length, 1, "console 'done' fired at answer-time")
  // ...but the group display stays HONEST to the lock (busy, flagged finalizing) so a new
  // message that would queue isn't shown as idle — the finalize-window mismatch fix.
  assert.equal(eng.liveState().groups.G.busy, true, 'display busy during the close window (a new msg would queue)')
  assert.equal(eng.liveState().groups.G.finalizing, true, 'flagged finalizing — answer delivered, still closing')
  assert.equal(eng.liveState().concurrency.active, 1, 'still holds the lock until close → counts active')
  // ...while the serialization lock and session persistence still wait for close (resume safety).
  assert.equal(rt.busy, true, 'lock held until the process closes')
  assert.equal(store.getSession('G'), null, 'session NOT persisted before close (rollout not yet durable)')

  resolveTurn()
  await tick()
  assert.equal(rt.busy, false, 'lock released at close')
  assert.equal(store.getSession('G'), 'sess-1', 'session persisted at close')
  assert.equal(activity.filter((a) => a.kind === 'done').length, 1, "'done' fired exactly once (idempotent across close)")
})

test('engine: a turn queued during the finalize window still waits for close (resume safety)', async () => {
  // The lock is held to close, so a second same-group message that arrives after the
  // answer (display idle) still queues and only runs once the first turn closes — the
  // exact ordering that keeps the next `resume` finding a durable rollout.
  let resolveFirst = null
  let runs = 0
  const runner = okRunner((opts) => {
    runs++
    if (runs === 1) return new Promise((res) => {
      resolveFirst = () => res({ sessionId: 's1', result: { text: 'a1' } })
      opts.onEvent({ type: 'result', subtype: 'success', text: 'a1' })
    })
    return Promise.resolve({ sessionId: 's2', result: { text: 'a2' } })
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })

  eng.handleMessage(mkMsg('first', 1), mkPlatform()); await tick()
  assert.equal(eng.liveState().groups.G.busy, true, 'still busy (finalizing) → a new message correctly queues, not silently')
  assert.equal(eng.liveState().groups.G.finalizing, true)
  eng.handleMessage(mkMsg('second', 2), mkPlatform()); await tick()
  assert.equal(runs, 1, 'second did NOT spawn while the first is still closing')
  assert.equal(eng.rts.get('G').queue.length, 1, 'second is queued behind the closing turn')

  resolveFirst(); await tick()
  assert.equal(runs, 2, 'second spawns only after the first closes')
})

test('engine: a settled turn frees its global slot before close, unblocking other groups', async () => {
  const cfg = baseCfg({
    agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 1, maxTurnTimeMins: 0 },
    groups: { G: { workdir: '/proj', provider: 'claude' }, H: { workdir: '/proj2', provider: 'claude' } },
  })
  let resolveG = null, hRan = false
  const runner = okRunner((opts) => {
    if (opts.workdir === '/proj') return new Promise((res) => {
      resolveG = () => res({ sessionId: 'g', result: { text: 'ga' } })
      opts.onEvent({ type: 'result', subtype: 'success', text: 'ga' }) // G answers but its process does NOT close
    })
    hRan = true
    return Promise.resolve({ sessionId: 'h', result: { text: 'ha' } })
  })
  const eng = new Engine(cfg, { runner, store: mkStore() })

  eng.handleMessage(mkMsg('g', 1, 'G'), mkPlatform()); await tick() // G takes the only slot, then settles
  assert.equal(eng.liveState().groups.G.finalizing, true, 'G answer settled → finalizing (still busy display)')
  assert.equal(eng.rts.get('G').busy, true, 'G lock still held (process not closed)')

  const pH = mkPlatform()
  eng.handleMessage(mkMsg('h', 2, 'H'), pH); await tick()
  assert.equal(hRan, true, 'H acquired the freed slot while G is still closing')
  assert.deepEqual(pH.replies, ['ha'])

  resolveG(); await tick() // G finally closes — releaseSlot is a no-op the second time
  assert.equal(eng.rts.get('G').busy, false)
})


test('engine: /hud reports current-model usage via injected probe (probe/null/absent)', async () => {
  const cfg = baseCfg()
  // probe returns a string → shown(裸串是老形状/试跑桩,仍然收)
  const eng = new Engine(cfg, { runner: okRunner(), store: mkStore(), usageProbe: async () => '5h 剩99% · 周 剩90%' })
  const p = mkPlatform(); await eng.handleMessage(mkMsg('/hud'), p)
  assert.match(p.replies[0], /额度/); assert.match(p.replies[0], /5h 剩99%/)
  // probe returns null → 没信息可判,沿用最保守的老口径
  const eng2 = new Engine(cfg, { runner: okRunner(), store: mkStore(), usageProbe: async () => null })
  const p2 = mkPlatform(); await eng2.handleMessage(mkMsg('/hud'), p2)
  assert.match(p2.replies[0], /不支持查额度/)
  // no probe (CLI/试跑, no daemon) → graceful guidance, never throws
  const eng3 = new Engine(cfg, { runner: okRunner(), store: mkStore() })
  const p3 = mkPlatform(); await eng3.handleMessage(mkMsg('/hud'), p3)
  assert.match(p3.replies[0], /后台服务/); assert.doesNotMatch(p3.replies[0], /daemon|sbot/i) // 零工具名:这句是发给群成员的
})

test('engine: /hud「查不到」与「不支持」是两句话 —— 接口抖动不许说成模型不支持', async () => {
  const cfg = baseCfg()
  // 能查但这次没查到(超时/限流)⇒ 劝他稍后再试,绝不说「不支持」
  const eng = new Engine(cfg, { runner: okRunner(), store: mkStore(), usageProbe: async () => ({ supported: true, value: null }) })
  const p = mkPlatform(); await eng.handleMessage(mkMsg('/hud'), p)
  assert.match(p.replies[0], /暂时没查到/)
  assert.doesNotMatch(p.replies[0], /不支持/, '本案根因:能查的模型被说成不支持')
  // 结构性不支持(这家根本没有额度接口)⇒ 照旧明说,别劝人白等
  const eng2 = new Engine(cfg, { runner: okRunner(), store: mkStore(), usageProbe: async () => ({ supported: false, value: null }) })
  const p2 = mkPlatform(); await eng2.handleMessage(mkMsg('/hud'), p2)
  assert.match(p2.replies[0], /不支持查额度/)
  assert.doesNotMatch(p2.replies[0], /稍后再试/)
  // 正常拿到值 ⇒ 还是照常显示(对照组:上面两条不是因为 /hud 整个坏了才不显示额度)
  const eng3 = new Engine(cfg, { runner: okRunner(), store: mkStore(), usageProbe: async () => ({ supported: true, value: '5h:12%' }) })
  const p3 = mkPlatform(); await eng3.handleMessage(mkMsg('/hud'), p3)
  assert.match(p3.replies[0], /5h:12%/)
  // 探针抛错也不崩(best-effort),归到最保守那句
  const eng4 = new Engine(cfg, { runner: okRunner(), store: mkStore(), usageProbe: async () => { throw new Error('boom') } })
  const p4 = mkPlatform(); await eng4.handleMessage(mkMsg('/hud'), p4)
  assert.match(p4.replies[0], /不支持查额度/)
  // 三句话都不许出现工具名/命令名(群成员看的)
  for (const px of [p, p2, p3, p4]) assert.doesNotMatch(px.replies[0], /sbot|curl|claude code/i)
})

test('engine: a hung turn (process never closes) is force-released so the queue drains — no brick', async () => {
  const cfg = baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, hardReleaseMs: 80 } })
  let runs = 0
  // Answer delivered via the result event, then the runner NEVER resolves (process won't close).
  const runner = okRunner((opts) => { runs++; return new Promise(() => { opts.onEvent({ type: 'result', subtype: 'success', text: 'a' + runs }) }) })
  const eng = new Engine(cfg, { runner, store: mkStore() })
  eng.handleMessage(mkMsg('q1', 1), mkPlatform()); await tick()
  assert.equal(runs, 1, 'q1 answered but its process never closes')
  eng.handleMessage(mkMsg('q2', 2), mkPlatform()); await tick()   // ~30ms elapsed < 80ms grace
  assert.equal(runs, 1, 'q2 queued behind the hung q1 (lock still held)')
  assert.equal(eng.rts.get('G').queue.length, 1)
  await new Promise((r) => setTimeout(r, 120)) // now past the 80ms hard-release grace
  assert.equal(runs, 2, 'hung q1 force-released after the grace → q2 dispatched; the group never bricked')
})

test('engine: /stop and /new release the lock immediately on a hung turn (never-hang)', async () => {
  const cfg = baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, hardReleaseMs: 100000 } })
  const runner = okRunner((opts) => new Promise(() => { opts.onEvent({ type: 'result', subtype: 'success', text: 'a' }) })) // never resolves
  const eng = new Engine(cfg, { runner, store: mkStore() })
  eng.handleMessage(mkMsg('q', 1), mkPlatform()); await tick()
  assert.equal(eng.rts.get('G').busy, true, 'lock held (finalizing, process clinging)')
  assert.equal(eng.stop('G'), true, 'stop acts')
  assert.equal(eng.rts.get('G').busy, false, 'lock released immediately by /stop, not waiting on the runner')
  // and /new on a fresh hung turn also frees it
  eng.handleMessage(mkMsg('q2', 2), mkPlatform()); await tick()
  assert.equal(eng.rts.get('G').busy, true)
  assert.equal(eng.interrupt('G').wasBusy, true)
  assert.equal(eng.rts.get('G').busy, false, 'lock released immediately by /new')
})

test('engine: concurrent finalize (result event racing the post-await) never returns null — no reportDone crash', async () => {
  // Slow card creation widens the window where the first finalizeTurn is awaiting cardP,
  // so the post-await call races it. Before the fix, the 2nd call returned finalOutcome=null
  // → _runTurn returned null → reportDone(null) crashed the daemon on o.status.
  const platform = { replies: [], reply: () => Promise.resolve(),
    createStreamingCard: () => new Promise((r) => setTimeout(() => r({ update() {}, finish() { return Promise.resolve() } }), 20)) }
  const activity = []
  const runner = okRunner((opts) => {
    opts.onEvent({ type: 'assistant', text: 'hi' })                         // lazily creates the card (cardP pending)
    opts.onEvent({ type: 'result', subtype: 'success', text: 'hi' })        // finalizeTurn #1 → awaits cardP
    return Promise.resolve({ sessionId: 's', result: { text: 'hi' } })      // resolves → post-await finalizeTurn #2 races #1
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), onActivity: (e) => activity.push(e) })
  await eng.handleMessage(mkMsg('go'), platform); await tick(); await new Promise((r) => setTimeout(r, 50))
  const done = activity.filter((a) => a.kind === 'done')
  assert.equal(done.length, 1, 'exactly one done, no crash')
  assert.equal(done[0].status, 'ok', 'a real status, not from a null outcome')
})

// ── Self-knowledge manifest (群项目基础能力): first turn prepends identity + status +
// base skills; both runners get SBOT_CHAT_ID via extraEnv. Resumed turns don't re-pay it.
test('engine: first turn prepends the self-knowledge manifest + injects SBOT_CHAT_ID', async () => {
  let captured
  const eng = new Engine(baseCfg(), { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store: mkStore() })
  eng.uiUrl = 'http://127.0.0.1:4600'
  await eng.handleMessage(mkMsg('hello'), mkPlatform()); await tick()
  assert.match(captured.prompt, /你是 SintBot/)
  assert.match(captured.prompt, /sbot feishu/) // base-skill invocation
  assert.match(captured.prompt, /send-file/)   // send skills
  assert.match(captured.prompt, /history/)     // read history
  assert.match(captured.prompt, /recall <message_id>/) // manage-message skills
  assert.match(captured.prompt, /sbot cron/)   // 定时任务 base skill advertised…
  assert.match(captured.prompt, /--at "2026/)  // …including one-off syntax
  assert.match(captured.prompt, /127\.0\.0\.1:4600/)
  assert.match(captured.prompt, /用户消息:/)
  assert.match(captured.prompt, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} u\] hello/) // timestamped sender tag still present
  assert.match(captured.prompt, /时间口径.*Asia\/Shanghai/) // manifest carries the timezone convention (no clock — fingerprint must stay stable)
  assert.match(captured.prompt, /北京时间/)
  assert.equal(captured.extraEnv.SBOT_CHAT_ID, 'G')
  assert.equal(captured.extraEnv.TZ, 'Asia/Shanghai') // default product timezone reaches the spawned agent
})

// Slack 群:清单里教 `sbot feishu` 的那段在 Slack 群不成立(文件上下行还没接),
// 整段换成「不可用 + 写路径」;并注入 SBOT_PLATFORM 让 CLI 侧拦得住。飞书群零改动。
// 判据是适配器自描述 features.skills === false(平台自描述机制),core 不认 'slack' 这个名字。
test('engine: Slack group manifest drops the feishu base-skill teaching and injects SBOT_PLATFORM', async () => {
  let captured
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', allowedTools: ['Read'], platform: 'slack' } } })
  const runner = okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) })
  const eng = new Engine(cfg, { runner, store: mkStore() })
  const { createSlackPlatform } = require('../../src/platform/slack')
  const real = createSlackPlatform({ botToken: 'xoxb-x', appToken: 'xapp-x' })
  const slackLike = Object.assign(mkPlatform(), { chatLabel: real.chatLabel, features: real.features }) // 用适配器真实的自描述,别在测试里另抄一份
  await eng.handleMessage(mkMsg('hello'), slackLike); await tick()
  assert.equal(captured.extraEnv.SBOT_PLATFORM, 'slack')
  assert.equal(captured.extraEnv.SBOT_CHAT_ID, 'G')
  assert.doesNotMatch(captured.prompt, /send-file "<路径>"/)   // 发送三件套不教
  assert.doesNotMatch(captured.prompt, /history \[条数\]/)      // 读历史不教
  assert.doesNotMatch(captured.prompt, /recall <message_id>/)  // 管理消息不教
  assert.match(captured.prompt, /本群在 Slack 上/)
  assert.match(captured.prompt, /一律不可用/)
  assert.match(captured.prompt, /sbot cron/)                    // 平台无关的基础技能照旧
})

test('engine: feishu group keeps the base skills; SBOT_PLATFORM 照抄群配置(config 归一后飞书群就是 feishu)', async () => {
  let captured
  const runner = okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) })
  const eng = new Engine(baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', allowedTools: ['Read'], platform: 'feishu' } } }), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('hello'), mkPlatform()); await tick()
  assert.equal(captured.extraEnv.SBOT_PLATFORM, 'feishu')
  assert.match(captured.prompt, /send-file "<路径>"/)
  assert.doesNotMatch(captured.prompt, /本群在 Slack 上/)
})

// 本机运行约定(v0.8.1):真机踩到 agent 把局域网静态服务装成常驻作业(kill 掉自动拉起),
// 项目目录持续暴露。这是无条件注入的软约束 —— 至少锁住它没被误删,且措辞不绑单一操作系统。
test('engine: manifest carries the local-runtime conventions (temp services must be cleaned up)', async () => {
  let captured
  const eng = new Engine(baseCfg(), { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('hello'), mkPlatform()); await tick()
  assert.match(captured.prompt, /【本机运行约定】/)
  assert.match(captured.prompt, /固定复用一个端口/)
  assert.match(captured.prompt, /绝不把服务装成常驻\/自启作业/)
  assert.match(captured.prompt, /launchctl/) // 点名各系统机制,免得 agent 以为换个系统就不算
  assert.match(captured.prompt, /计划任务/)
  // v0.8.2:真机踩到 —— 禁了常驻作业却没给「允许的长活方式」,agent 只好拖着轮次不结束给服务续命,
  // 群里后续消息全被排队干等。必须同时给出正路与硬禁令。
  assert.match(captured.prompt, /严禁靠「拖着本轮不结束」/)
  assert.match(captured.prompt, /首选 sbot feishu send-file/) // 默认路径是发文件,不是起服务
  // v0.9.0:正路从 v0.8.2 的 `screen -dmS`(通用逃生阀,能起任意进程/暴露任意目录)收成**唯一**
  // 一条受管命令。**断言 screen 不在清单里** —— 两条并列等于给逃生阀发许可,正路只留一条才管得住。
  assert.match(captured.prompt, /唯一正路是 `sbot preview start/)
  assert.match(captured.prompt, /sbot preview stop/)
  assert.match(captured.prompt, /闲置一段时间自动停/)
  assert.match(captured.prompt, /不用你记着关/)
  assert.doesNotMatch(captured.prompt, /screen -dmS/, '正路只留 sbot preview 一条,不再教 screen')
  // 清单**不写具体端口号**:端口按群确定但冲突时会顺延 ⇒ 写进去可能是假话;且清单指纹必须跨轮
  // 稳定(同自知清单「钟点不进清单」的约定,DESIGN §4.6)。
  assert.doesNotMatch(captured.prompt, /46[12]\d/, '清单不得写死预览端口(运行时状态会毒化指纹)')
  assert.match(captured.prompt, /原型请放\*\*子目录\*\*/) // 默认拒服务项目根,前置教它放对地方
  // 2026-07-30 反向诱导测试:群里要求「随时都能打开」,它自己造了份配置用 --config 把回收全关。
  // 清单要同时给出「别自造配置」与「正路是让 operator 勾常驻」,否则禁了绕法又没出口。
  assert.match(captured.prompt, /不要自己造配置文件用 --config 去改/)
  assert.match(captured.prompt, /operator 在控制台该群卡的「预览」勾「常驻」/)
  // 单文件模式:它此前对用户说「仅暴露原型文件」而实际整个目录可读 ⇒ 清单要说清两种形态的差别
  assert.match(captured.prompt, /只有这一个文件对外可见/)
  // 时长不写死数字(配置可改 + 指纹稳定),但要指路「以命令输出为准」
  assert.doesNotMatch(captured.prompt, /闲置 30 分钟自动停/)
})

// 2026-07-30 真机:群里让它「控制台截图发来」,它答「未连接到可控制的浏览器窗口,请你在 Chrome
// 打开…并回复已连接」—— 把本该自己做的事推回给用户。根因是清单只给了地址、还写着「运维配置用,
// 群成员一般用不到」(等于劝它别碰),且给的是**要密码的 LAN 地址**而非免密的环回地址。
test('engine: manifest 告诉 agent 可以自己开控制台截图(环回免密地址)', async () => {
  let captured
  const cfg = baseCfg()
  cfg.groups.G.plugins = { mcp: ['chrome-devtools'] } // 浏览器段的门控
  const eng = new Engine(cfg, { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store: mkStore() })
  eng.uiUrl = 'http://192.168.1.75:4600'
  eng.uiLocalUrl = 'http://127.0.0.1:4600'
  await eng.handleMessage(mkMsg('hello'), mkPlatform()); await tick()
  assert.match(captured.prompt, /控制台:http:\/\/192\.168\.1\.75:4600/)
  assert.match(captured.prompt, /你自己用浏览器打开 http:\/\/127\.0\.0\.1:4600/)
  assert.match(captured.prompt, /环回访问免密/)
  // 这句是纠正那次真机行为的关键:别把活推回给用户
  assert.match(captured.prompt, /不要反过来要求用户去连浏览器/)
  // 旧措辞「群成员一般用不到」是劝退,必须不在了
  assert.doesNotMatch(captured.prompt, /群成员一般用不到/)
})

// 项目级 MCP(workdir/.mcp.json,bin 注入 projectMcp 读取器)进清单 + 触发浏览器纪律(v0.11.2)。
// DemoApp 真踩:chrome-devtools 声明在项目里、群卡没勾任何用户级插件 ⇒ 此前清单一字不提、
// 浏览器使用纪律一条不注入 —— agent 有浏览器工具却没规矩。
test('engine: 项目级 MCP 进清单【项目自带插件】且触发浏览器纪律(v0.11.2)', async () => {
  let captured
  const eng = new Engine(baseCfg(), { // 群未勾任何用户级插件(plugins 未配置)
    runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }),
    store: mkStore(),
    projectMcp: (wd) => (wd === '/proj' ? ['wechat-devtools', 'cloudbase', 'chrome-devtools'] : []),
  })
  eng.uiLocalUrl = 'http://127.0.0.1:4600'
  await eng.handleMessage(mkMsg('hello'), mkPlatform()); await tick()
  assert.match(captured.prompt, /【项目自带插件\(MCP\)】wechat-devtools, cloudbase, chrome-devtools/)
  assert.match(captured.prompt, /随项目自动加载/)
  assert.match(captured.prompt, /浏览器使用约定/) // 项目级 chrome-devtools 也要触发纪律段
  assert.match(captured.prompt, /你自己用浏览器打开 http:\/\/127\.0\.0\.1:4600/)
})

test('engine: 项目级 MCP 无浏览器类时不触发浏览器纪律(判据合并不误伤)', async () => {
  let captured
  const eng = new Engine(baseCfg(), {
    runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }),
    store: mkStore(),
    projectMcp: () => ['cloudbase'], // 只有非浏览器类
  })
  await eng.handleMessage(mkMsg('hello'), mkPlatform()); await tick()
  assert.match(captured.prompt, /【项目自带插件\(MCP\)】cloudbase/)
  assert.doesNotMatch(captured.prompt, /浏览器使用约定/)
})

// 无浏览器插件的群不该被教「用浏览器开控制台」(它没有浏览器)
test('engine: 没有浏览器插件时不注入「自己开控制台」那段', async () => {
  let captured
  const eng = new Engine(baseCfg(), { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store: mkStore() })
  eng.uiUrl = 'http://192.168.1.75:4600'
  eng.uiLocalUrl = 'http://127.0.0.1:4600'
  await eng.handleMessage(mkMsg('hello'), mkPlatform()); await tick()
  assert.match(captured.prompt, /控制台:http/)
  assert.doesNotMatch(captured.prompt, /你自己用浏览器打开/)
})

// v0.8.2:agent 在 send-msg 参数里写 `\n` 当换行,群里原样显示字面反斜杠 n(与 Mermaid 同源)。
// 与那条一样,断言清单里出现的是**字面**反斜杠 n —— 写成真换行就等于教它继续犯。
test('engine: manifest warns against literal backslash-n in outgoing messages', async () => {
  let captured
  const eng = new Engine(baseCfg(), { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('hello'), mkPlatform()); await tick()
  assert.ok(captured.prompt.includes('别在双引号里写 `\\n`'), '清单必须含字面的反斜杠 n')
  assert.match(captured.prompt, /换行就直接敲真换行/)
})

// ⚠ Mermaid 换行教学的转义:清单里必须出现**字面的**反斜杠 n(那正是要禁止的写法)。
// 若哪天有人把 '\\n' 手滑写成 '\n' 或换成模板字符串,教学就会变成「教它用真换行」—— 正好
// 教成要修的那个 bug,且不会有任何报错。这条断言就是防这个。
test('engine: manifest teaches <br/> for Mermaid line breaks with a LITERAL backslash-n', async () => {
  let captured
  const cfg = baseCfg()
  cfg.groups.G.board = { url: 'https://example.feishu.cn/docx/x', whiteboardId: 'wb1' } // 画布段才带图表教学
  const eng = new Engine(cfg, { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('hello'), mkPlatform()); await tick()
  assert.match(captured.prompt, /节点标签换行必须用 `<br\/>`/)
  assert.ok(captured.prompt.includes('绝不能用 `\\n`'), '清单必须含字面的反斜杠 n,不能是真换行')
  assert.ok(!/绝不能用 `\n`/.test(captured.prompt), '绝不能被写成真换行(那就教成了要修的 bug)')
  assert.match(captured.prompt, /style <子图id> fill:/) // 子图单独上色
})

// ⚠ 真机 2026-07-31:用户说「主色改靛蓝」,agent 改了色值、图也重画了,但按钮还是黄的
// (键名 blue 不在角色词表 ⇒ 按彩度挑),它却在群里说「靛蓝将承担主要视觉面积」。清单必须
// 教清楚「改主色 ≠ 改色值」,否则它只会反复改色值、越改越糊涂。
test('engine: manifest 教「改主色 ≠ 改色值」(角色按键名判,要指定主色得改成 accent)', async () => {
  let captured
  const cfg = baseCfg()
  cfg.groups.G.board = { url: 'https://example.feishu.cn/docx/x', whiteboardId: 'wb1' } // 设计流程段在画布块里
  const eng = new Engine(cfg, { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('hello'), mkPlatform()); await tick()
  assert.match(captured.prompt, /改主色 ≠ 改色值/)
  assert.match(captured.prompt, /改名为 `accent`/)
  assert.match(captured.prompt, /改完色板务必核对这行/) // 指向 swatch 打印的角色判定
})

// ⚠ 真机 2026-07-31(v0.9.3 部署当天):改完主色只回「已换为正红,并发送了更新后的预览图」,
// 用户打开 HTML 原型发现纹丝未动 —— 那份原型停在两天前、用的还是两套风格之前的色板。
// 风格档语义没错(只管之后的产出),错在没说破这个落差。
test('engine: manifest 教「改风格档不会自动改已有产物」并要求主动说清影响范围', async () => {
  let captured
  const cfg = baseCfg()
  cfg.groups.G.board = { url: 'https://example.feishu.cn/docx/x', whiteboardId: 'wb1' }
  const eng = new Engine(cfg, { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('hello'), mkPlatform()); await tick()
  assert.match(captured.prompt, /改风格档不会自动改已有产物/)
  assert.match(captured.prompt, /要不要我一并更新/)
  assert.match(captured.prompt, /别让用户自己去发现原型没变/)
  assert.match(captured.prompt, /风格预览图/) // 措辞纠偏:别让人以为是原型的预览
})

test('engine: an unchanged follow-up turn does NOT re-inject the manifest (but still sets SBOT_CHAT_ID)', async () => {
  let captured
  const eng = new Engine(baseCfg(), { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('one'), mkPlatform()); await tick()   // turn 1: injects + caches manifest, sets session
  await eng.handleMessage(mkMsg('two'), mkPlatform()); await tick()   // turn 2: same manifest ⇒ skip
  assert.doesNotMatch(captured.prompt, /你是 SintBot/)
  assert.match(captured.prompt, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} u\] two/)
  assert.equal(captured.extraEnv.SBOT_CHAT_ID, 'G')
})

// ── manifest 准确性:仓库真实状态 + push 权限 + codex 基础技能受限(核对 _buildManifest 后补) ──
const capRunner = () => { let c; const r = okRunner((o) => { c = o; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }); return { r, get: () => c } }

test('manifest: 仓库真实状态 — ok/缺失/不一致 如实反映(读真 origin,非回显配置)', async () => {
  const mk = (repoInfo, group) => {
    const { r, get } = capRunner()
    const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', repo: 'git@h:me/x.git', permissionMode: 'bypassPermissions', ...group } } })
    const eng = new Engine(cfg, { runner: r, store: mkStore(), repoInfo }); return { eng, get }
  }
  // ok:origin 与配置一致
  let { eng, get } = mk(() => ({ state: 'ok', origin: 'git@h:me/x.git' }))
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.match(get().prompt, /代码仓库.*git@h:me\/x\.git/); assert.match(get().prompt, /已关联好/)
  // missing:项目目录没设 origin
  ;({ eng, get } = mk(() => ({ state: 'missing', origin: null })))
  await eng.handleMessage(mkMsg('b'), mkPlatform()); await tick()
  assert.match(get().prompt, /还没设 origin/); assert.match(get().prompt, /git remote add origin/)
  // drift:实际 origin 与配置不同 → 报出实际值
  ;({ eng, get } = mk(() => ({ state: 'drift', origin: 'git@h:other/y.git' })))
  await eng.handleMessage(mkMsg('c'), mkPlatform()); await tick()
  assert.match(get().prompt, /不一致.*git@h:other\/y\.git/); assert.match(get().prompt, /先问用户/)
})

test('manifest: 关联了仓库但权限 deny 了 git push → 如实警告(开发档),完全访问则不警告', async () => {
  // 开发档:deny git push → 警告
  let { r, get } = capRunner()
  let cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', repo: 'git@h:me/x.git', allowedTools: ['Read', 'Bash(git commit *)'], disallowedTools: ['Bash(git push *)'] } } })
  let eng = new Engine(cfg, { runner: r, store: mkStore(), repoInfo: () => ({ state: 'ok', origin: 'git@h:me/x.git' }) })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.match(get().prompt, /不放行 git push/)
  // 完全访问:不警告
  ;({ r, get } = capRunner())
  cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', repo: 'git@h:me/x.git', permissionMode: 'bypassPermissions' } } })
  eng = new Engine(cfg, { runner: r, store: mkStore(), repoInfo: () => ({ state: 'ok', origin: 'git@h:me/x.git' }) })
  await eng.handleMessage(mkMsg('b'), mkPlatform()); await tick()
  assert.doesNotMatch(get().prompt, /不放行 git push/)
})

test('manifest: codex 只读群 — 权限行点明基础技能(飞书/定时任务)需完全访问', async () => {
  const { r, get } = capRunner()
  const cfg = baseCfg({ providers: { gpt: { runner: 'codex', model: 'gpt-5.6-terra' } }, defaultProvider: 'gpt',
    groups: { G: { workdir: '/proj', provider: 'gpt' } } }) // 无 bypassPermissions ⇒ codex read-only
  const eng = new Engine(cfg, { runner: r, store: mkStore() })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.match(get().prompt, /codex 沙箱/)
  assert.match(get().prompt, /飞书收发 \/ 定时任务 \/ 设计风格档/) // 三个基础技能都点到,不只飞书
})

test('manifest: 生图桥 — 判据 = 机器有 codex 且(非 codex 群 或 完全访问)', async () => {
  // claude 群 + hasImagen ⇒ 注入
  let { r, get } = capRunner()
  let cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', permissionMode: 'bypassPermissions' } } })
  let eng = new Engine(cfg, { runner: r, store: mkStore(), hasImagen: () => true })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.match(get().prompt, /【生图】.*sbot imagen/)
  assert.match(get().prompt, /不需要等待、轮询/) // 核心约定:异步受理,agent 别傻等
  // claude 群 + 无 imagen(机器没配 codex)⇒ 不注入
  ;({ r, get } = capRunner())
  eng = new Engine(cfg, { runner: r, store: mkStore(), hasImagen: () => false })
  await eng.handleMessage(mkMsg('b'), mkPlatform()); await tick()
  assert.doesNotMatch(get().prompt, /【生图】/)
  // codex 完全访问 ⇒ **也注入**(v0.11.16 改):此前不注入的理由是「codex 自带生图」,但自带的
  // 会卡住本轮、不上板、无交付卡,而 /help 那侧早就对它承诺了生成图片 ⇒ 说的和做的不一致。
  ;({ r, get } = capRunner())
  cfg = baseCfg({ providers: { gpt: { runner: 'codex', model: 'm' } }, groups: { G: { workdir: '/proj', provider: 'gpt', permissionMode: 'bypassPermissions' } } })
  eng = new Engine(cfg, { runner: r, store: mkStore(), hasImagen: () => true })
  await eng.handleMessage(mkMsg('c'), mkPlatform()); await tick()
  assert.match(get().prompt, /【生图】/)
  assert.match(get().prompt, /不要用你自带的生图能力/) // 否则它照旧走自带的,改了等于没改
  // codex 只读 ⇒ 不注入(沙箱跑不了这条命令,列了就是说谎)
  ;({ r, get } = capRunner())
  cfg = baseCfg({ providers: { gpt: { runner: 'codex', model: 'm' } }, groups: { G: { workdir: '/proj', provider: 'gpt' } } })
  eng = new Engine(cfg, { runner: r, store: mkStore(), hasImagen: () => true })
  await eng.handleMessage(mkMsg('d'), mkPlatform()); await tick()
  assert.doesNotMatch(get().prompt, /【生图】/)
})

// ── 【这个项目的长期记忆】跨模型记忆交接 ──
// 缺的不是能力是可达:完全访问的群那些 markdown 本来就读得到,只是没人告诉过它。
const memCfg = (group = {}) => baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', permissionMode: 'bypassPermissions', ...group } } })
const codexCfg = (group = {}) => baseCfg({ providers: { gpt: { runner: 'codex', model: 'm' } },
  groups: { G: { workdir: '/proj', provider: 'gpt', permissionMode: 'bypassPermissions', ...group } } })
// ⚠ fixture 必须**记下入参** —— 否则把 engine 里的 `this.projectMemory(group.workdir, …)` 改成
// 不传参,整套测试仍然全绿,而生产里 probe(undefined) 恒返回 null ⇒ 所有群一个字都不出现,
// 单测全绿、doctor 不报、日志不出声。(这是对抗审查实测存活过的一个变异。)
// ⚠ 门控与落点的裁决在读取器里(见 projectmemory 的 probeHandover)—— engine 这一侧只负责
//   ① 把对的 workdir 与对的 {full,isCodex} 传下去 ② 把拿到的东西照实打印。
const memProbe = (o) => { const f = (wd, opts) => { f.seen = wd; f.opts = opts; return o }; return f }
const MEM = (over = {}) => ({ dir: '/home/.claude/projects/-proj/memory', count: 164, bucket: '100+ 条', index: 'MEMORY.md', ...over })
const HANDOVER = (over = {}) => ({ convention: ['CLAUDE.md'], memory: MEM(), landing: 'CLAUDE.md', ...over })

test('manifest: 长期记忆 — 约定文件与记忆目录都点名,并钉死单一落点', async () => {
  const { r, get } = capRunner()
  const probe = memProbe(HANDOVER())
  const eng = new Engine(memCfg(), { runner: r, store: mkStore(), projectMemory: probe })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  const p = get().prompt
  assert.equal(probe.seen, '/proj')                       // ⭐ 传下去的必须是该群的 workdir
  assert.match(p, /【这个项目的长期记忆】/)
  assert.match(p, /上下文里没有就自己读一遍/)            // 核心:它可能根本没加载
  assert.match(p, /项目约定:CLAUDE\.md/)
  assert.match(p, /\/home\/\.claude\/projects\/-proj\/memory/) // 真路径,不是「去找找看」
  assert.match(p, /100\+ 条/)
  assert.match(p, /先读 MEMORY\.md 索引/)                 // 只给坐标不搬内容
  assert.match(p, /落点是 CLAUDE\.md/)                    // 单一落点(教训 26 家族)
})

// ⭐ 门控判据本身由读取器裁决,但**判据要用的两个事实只有 core 知道** ——
// 传错/漏传的话读取器只能按默认(都是 falsy)裁决 ⇒ 完全访问的群反而拿不到记忆,且不出声。
test('manifest: 长期记忆 — 把这一轮的 {full,isCodex} 如实传给读取器(四种群各验一次)', async () => {
  const cases = [
    ['claude 完全访问', memCfg(), { full: true, isCodex: false }],
    ['claude 白名单', baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', allowedTools: ['Read'] } } }), { full: false, isCodex: false }],
    ['codex 完全访问', codexCfg(), { full: true, isCodex: true }],
    ['codex 只读', baseCfg({ providers: { gpt: { runner: 'codex', model: 'm' } }, groups: { G: { workdir: '/proj', provider: 'gpt' } } }), { full: false, isCodex: true }],
  ]
  for (const [label, cfg, want] of cases) {
    const { r } = capRunner()
    const probe = memProbe(HANDOVER())
    const eng = new Engine(cfg, { runner: r, store: mkStore(), projectMemory: probe })
    await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
    assert.equal(probe.seen, '/proj', label)
    assert.deepEqual(probe.opts, want, label)
  }
})

// 读取器把记忆那一行门控掉(非完全访问的 claude 群)时,engine 只打印剩下的,不自作主张。
test('manifest: 长期记忆 — 读取器只给约定文件时,不凭空冒出记忆那一行', async () => {
  const { r, get } = capRunner()
  const eng = new Engine(memCfg(), { runner: r, store: mkStore(),
    projectMemory: memProbe(HANDOVER({ memory: null })) })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  const p = get().prompt
  assert.doesNotMatch(p, /长期记忆:/)          // 记忆那一行不给
  assert.doesNotMatch(p, /100\+ 条/)
  assert.match(p, /项目约定:CLAUDE\.md/)      // 对照组:约定文件在 workdir 内,照给
  assert.match(p, /落点是 CLAUDE\.md/)
})

test('manifest: 长期记忆 — 两份约定档都点名,落点用读取器裁决的那一份', async () => {
  const { r, get } = capRunner()
  const eng = new Engine(codexCfg(), { runner: r, store: mkStore(),
    projectMemory: memProbe(HANDOVER({ convention: ['CLAUDE.md', 'AGENTS.md'], landing: 'AGENTS.md' })) })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.match(get().prompt, /项目约定:CLAUDE\.md、AGENTS\.md/) // 两份都点名
  assert.match(get().prompt, /落点是 AGENTS\.md/)               // 落点只有一个
  assert.doesNotMatch(get().prompt, /落点是 CLAUDE\.md/)
})

test('manifest: 长期记忆 — 项目里没有(或这一轮给不出去)⇒ 一个字都不出现(带对照组)', async () => {
  const { r, get } = capRunner()
  const eng = new Engine(memCfg(), { runner: r, store: mkStore(), projectMemory: memProbe(null) })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.doesNotMatch(get().prompt, /长期记忆/)
  assert.match(get().prompt, /你是 SintBot/) // 对照组:清单本身照常注入,不是整段没生成
})

test('manifest: 长期记忆 — 未注入读取器(CLI stub)时不报错也不出声', async () => {
  const { r, get } = capRunner()
  const eng = new Engine(memCfg(), { runner: r, store: mkStore() }) // 无 projectMemory
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.doesNotMatch(get().prompt, /长期记忆/)
  assert.match(get().prompt, /你是 SintBot/)
})

test('manifest: 长期记忆 — codex 群多一行「只读」,claude 群没有', async () => {
  // codex 群:记忆目录只读(格式规矩它不熟,写坏了对面读到垃圾)
  let { r, get } = capRunner()
  let eng = new Engine(codexCfg(), { runner: r, store: mkStore(),
    projectMemory: memProbe(HANDOVER({ convention: ['AGENTS.md'], landing: 'AGENTS.md', memory: MEM({ dir: '/m', bucket: '20+ 条' }) })) })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.match(get().prompt, /长期记忆目录\*\*只读\*\*/)
  assert.match(get().prompt, /要沉淀就写 AGENTS\.md/)
  // claude 群:它自己的框架会往里写,不该拦。
  // ⚠ 断言必须钉住**这一行**而不是「只读」二字 —— 权限行本身也会出现「只读」(缺省 fail-closed),
  //   宽写法会因为完全无关的原因翻(现在靠 memCfg 默认完全访问才没撞上)。
  ;({ r, get } = capRunner())
  eng = new Engine(memCfg(), { runner: r, store: mkStore(),
    projectMemory: memProbe(HANDOVER({ memory: MEM({ dir: '/m', bucket: '20+ 条' }) })) })
  await eng.handleMessage(mkMsg('b'), mkPlatform()); await tick()
  assert.match(get().prompt, /长期记忆:\/m/)                        // 对照组:这一段确实生成了
  assert.doesNotMatch(get().prompt, /长期记忆目录\*\*只读\*\*/)
})

test('manifest: 长期记忆 — 有记忆但零约定文件(只聊数据的群)⇒ 不谈落点、不劝它建文件', async () => {
  const { r, get } = capRunner()
  const eng = new Engine(codexCfg(), { runner: r, store: mkStore(),
    projectMemory: memProbe(HANDOVER({ convention: [], landing: null, memory: MEM({ dir: '/m', count: 4, bucket: '不到 10 条' }) })) })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /长期记忆:\/m/)      // 记忆照报
  assert.doesNotMatch(p, /落点是/)      // 没有约定文件,就没有落点可指
  assert.doesNotMatch(p, /要沉淀就写/)  // 更不能劝它往用户项目里新建文件
  assert.match(p, /长期记忆目录\*\*只读\*\*/) // 但「别往记忆里写」这条仍然成立
})

// 读取器契约是「给不出东西就返回 null」。万一它给了个一条都打印不出的空壳(契约违例/将来改坏),
// 绝不能只剩一个光秃秃的标题、下面一条都没有。
test('manifest: 长期记忆 — 读取器给了打印不出内容的空壳 ⇒ 连标题都不出现', async () => {
  const { r, get } = capRunner()
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', allowedTools: ['Read'] } } })
  const eng = new Engine(cfg, { runner: r, store: mkStore(),
    projectMemory: memProbe({ convention: [], landing: null, memory: null }) }) // 契约违例:读取器给了个空壳
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.doesNotMatch(get().prompt, /【这个项目的长期记忆】/)
  assert.match(get().prompt, /你是 SintBot/) // 对照组:清单本身照常注入
})

// ⭐ 上面几条喂的都是手写对象 ⇒ 探测器**改了字段名**(如 bucket)两个文件都照绿,而真机清单里
// 会打出 undefined。这条把**真探测器的输出**接进清单,钉住两边的形状契约。
test('manifest: 长期记忆 — 真探测器的输出能被清单正确消费(形状契约)', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const { probeHandover, memorySlug } = require('../../src/projectmemory')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-eng-mem-'))
  const wd = path.join(root, 'proj'); fs.mkdirSync(wd)
  fs.writeFileSync(path.join(wd, 'CLAUDE.md'), '# 约定')
  const cfgDir = path.join(root, 'cfg')
  const md = path.join(cfgDir, 'projects', memorySlug(fs.realpathSync(wd)), 'memory')
  fs.mkdirSync(md, { recursive: true })
  fs.writeFileSync(path.join(md, 'MEMORY.md'), '# index')
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(md, `m${i}.md`), '# m')

  const { r, get } = capRunner()
  const cfg = baseCfg({ groups: { G: { workdir: wd, provider: 'claude', permissionMode: 'bypassPermissions' } } })
  const eng = new Engine(cfg, { runner: r, store: mkStore(), projectMemory: (w, o) => probeHandover(w, { ...o, configDir: cfgDir }) })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /项目约定:CLAUDE\.md/)
  assert.match(p, new RegExp('长期记忆:' + md.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(p, /10\+ 条/)                 // 12 条 ⇒ 10+ 档;字段改名会让这里变 undefined
  assert.doesNotMatch(p, /undefined/)        // 形状漂移的直接症状
  assert.match(p, /先读 MEMORY\.md 索引/)
})

// ⭐ 档位存在的唯一理由。真实项目每天都在长记忆,报精确条数 ⇒ 清单指纹天天变 ⇒ 每天白重注入
// 一份几 KB 的清单,还会对 agent 说一句假话(「你的能力/配置已更新」——其实什么都没更新)。
test('manifest: 长期记忆 — 条数在档位内变化不翻指纹(跨档才重注入)', async () => {
  let n = 100
  const { r, get } = capRunner()
  const eng = new Engine(memCfg(), { runner: r, store: mkStore(),
    projectMemory: () => ({ convention: ['CLAUDE.md'], memory: { dir: '/m', count: n, bucket: n >= 100 ? '100+ 条' : '50+ 条', index: 'MEMORY.md' } }) })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.match(get().prompt, /你是 SintBot/)          // 首轮注入
  n = 164                                            // 记忆长了 64 条,仍在同一档
  await eng.handleMessage(mkMsg('b'), mkPlatform()); await tick()
  assert.doesNotMatch(get().prompt, /你是 SintBot/)   // 指纹没变 ⇒ 不重注入
  n = 60                                             // 跨档 ⇒ 该重注入
  await eng.handleMessage(mkMsg('c'), mkPlatform()); await tick()
  assert.match(get().prompt, /你是 SintBot/)
  assert.match(get().prompt, /能力\/配置已更新/)
})

test('manifest: 浏览器类插件在场 → 注入使用约定行;非浏览器插件不注入', async () => {
  const { r, get } = capRunner()
  // claude 群:群卡勾选 chrome-devtools ⇒ 插件行 + 浏览器约定行
  let cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', plugins: { mcp: ['chrome-devtools'] } } } })
  let eng = new Engine(cfg, { runner: r, store: mkStore() })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.match(get().prompt, /已启用插件\(MCP\)】chrome-devtools/)
  assert.match(get().prompt, /浏览器使用约定/)
  assert.match(get().prompt, /take_snapshot/) // 用法纪律的核心条款在场
  assert.match(get().prompt, /close_page/)
  assert.match(get().prompt, /fullPage/)      // 长页面整页截图工作流
  assert.match(get().prompt, /send-image/)    // 截图经飞书基础技能发群,不贴回复里
  // 非浏览器插件 ⇒ 无约定行
  cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', plugins: { mcp: ['filesystem'] } } } })
  eng = new Engine(cfg, { runner: r, store: mkStore() })
  await eng.handleMessage(mkMsg('b'), mkPlatform()); await tick()
  assert.doesNotMatch(get().prompt, /浏览器使用约定/)
})

// 纯文本模型(vision:false)+ 浏览器 = 白跑重灾区:模型收到的图片全被 strip-proxy 换成占位
// 文本,而它会照常"截图确认"。清单要如实告知,并把截图约定收紧成必带 filePath。
test('manifest: vision:false 的模型 → 声明无识图能力;有浏览器时截图约定收紧', async () => {
  const { r, get } = capRunner()
  let cfg = baseCfg({ providers: { txt: { baseUrl: 'https://x', apiKey: 'k', model: 'glm-5.2', vision: false } }, defaultProvider: 'txt',
    groups: { G: { workdir: '/proj', provider: 'txt', plugins: { mcp: ['chrome-devtools'] } } } })
  let eng = new Engine(cfg, { runner: r, store: mkStore() })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.match(get().prompt, /没有识图能力/)      // 通用声明(与浏览器无关,群里发图同样看不到)
  assert.match(get().prompt, /占位文本/)
  assert.match(get().prompt, /必须带 filePath/)   // 浏览器块内的收紧条款
  // 有识图能力的模型:两条都不出现(零回归)
  cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', plugins: { mcp: ['chrome-devtools'] } } } })
  eng = new Engine(cfg, { runner: r, store: mkStore() })
  await eng.handleMessage(mkMsg('b'), mkPlatform()); await tick()
  assert.match(get().prompt, /浏览器使用约定/)     // 浏览器约定照常在
  assert.doesNotMatch(get().prompt, /没有识图能力/)
  assert.doesNotMatch(get().prompt, /必须带 filePath/)
})

test('manifest: codex 群经注入读取器如实列全局 codex MCP(config.toml 全局生效、无按群门控)', async () => {
  const { r, get } = capRunner()
  const cfg = () => baseCfg({ providers: { gpt: { runner: 'codex' } }, defaultProvider: 'gpt',
    groups: { G: { workdir: '/proj', provider: 'gpt', permissionMode: 'bypassPermissions' } } })
  const eng = new Engine(cfg(), { runner: r, store: mkStore(), codexMcp: () => ['chrome-devtools', 'other'] })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.match(get().prompt, /已启用插件\(MCP\)】chrome-devtools, other/)
  assert.match(get().prompt, /浏览器使用约定/) // 全局 MCP 里有浏览器类 ⇒ codex 群同样拿到约定
  // 未注入读取器(如 CLI 场景):不误报插件
  const eng2 = new Engine(cfg(), { runner: r, store: mkStore() })
  await eng2.handleMessage(mkMsg('b'), mkPlatform()); await tick()
  assert.doesNotMatch(get().prompt, /已启用插件/)
  assert.doesNotMatch(get().prompt, /浏览器使用约定/)
})

// ── 时间口径(默认北京):消息前缀时间戳按 cfg.timezone 格式化(与主机时区无关),
// TZ 也随之注入子进程;换时区 = 换口径,两处同步。
test('engine: the message timestamp + spawned TZ follow cfg.timezone, not the host timezone', async () => {
  let captured
  const runner = okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) })
  // 时间戳须晚于引擎启动(旧消息会被 drop-older-than-startup 拦),所以用当下时刻;
  // 期望串经 fmtStamp 生成(其对固定时刻的正确性由 time.test.js 覆盖),与主机时区无关。
  const { fmtStamp } = require('../../src/core/time')
  // 两个引擎都先构造,再取消息时刻 —— 时间戳必须晚于两者的 startedAt(旧消息守卫)
  const bj = new Engine(baseCfg(), { runner, store: mkStore() }) // 未配置 ⇒ 默认北京
  const utc = new Engine(baseCfg({ timezone: 'UTC' }), { runner, store: mkStore() })
  const at = Date.now() + 5
  const msgAt = (text) => ({ ...mkMsg(text), createTimeMs: at })

  await bj.handleMessage(msgAt('hello'), mkPlatform()); await tick()
  assert.ok(captured.prompt.includes(`[${fmtStamp(at, 'Asia/Shanghai')} u] hello`))
  assert.equal(captured.extraEnv.TZ, 'Asia/Shanghai')

  await utc.handleMessage(msgAt('hello'), mkPlatform()); await tick()
  assert.ok(captured.prompt.includes(`[${fmtStamp(at, 'UTC')} u] hello`))
  assert.equal(captured.extraEnv.TZ, 'UTC')
  assert.match(captured.prompt, /时间口径.*UTC/) // manifest 的口径行跟着换
})

test('engine: hot-reloaded timezone updates the next turn timestamp and child TZ', async () => {
  const seen = []
  const runner = okRunner(async (opts) => {
    seen.push(opts)
    return { sessionId: 'same-session', result: { text: 'ok' } }
  })
  const store = mkStore()
  const eng = new Engine(baseCfg(), { runner, store })
  const { fmtStamp } = require('../../src/core/time')
  const at = Date.now() + 5000
  const message = (text, createTimeMs) => ({ ...mkMsg(text), createTimeMs })

  await eng.handleMessage(message('before', at), mkPlatform()); await tick()
  assert.equal(seen[0].extraEnv.TZ, 'Asia/Shanghai')
  assert.equal(store.getSession('G'), 'same-session')

  eng.reload(baseCfg({ timezone: 'UTC' }))
  await eng.handleMessage(message('after', at + 60_000), mkPlatform()); await tick()
  assert.equal(seen.length, 2)
  assert.ok(seen[1].prompt.includes(`[${fmtStamp(at + 60_000, 'UTC')} u] after`))
  assert.match(seen[1].prompt, /时间口径.*UTC/)
  assert.equal(seen[1].extraEnv.TZ, 'UTC')
  assert.equal(eng.baseSkillEnv('G').TZ, 'UTC')
  assert.equal(store.getSession('G'), 'same-session', 'changing timezone keeps the current model session')

  eng.reload(baseCfg({ timezone: 'Not/A_Zone' }))
  assert.equal(eng.baseSkillEnv('G').TZ, 'Asia/Shanghai', 'invalid timezone uses the product fallback')
})

test('engine: enabling a plugin mid-session re-injects the updated manifest WITHOUT resetting the session', async () => {
  let captured
  const store = mkStore()
  const eng = new Engine(baseCfg(), { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store })
  await eng.handleMessage(mkMsg('one'), mkPlatform()); await tick()   // turn 1: injects manifest, session = s1
  assert.equal(store.getSession('G'), 's1')
  eng.cfg.groups.G.plugins = { mcp: ['newmcp'] }                      // operator enables a plugin (no reset)
  await eng.handleMessage(mkMsg('two'), mkPlatform()); await tick()   // turn 2: manifest changed ⇒ re-inject
  assert.match(captured.prompt, /能力\/配置已更新/)
  assert.match(captured.prompt, /newmcp/)
  assert.equal(store.getSession('G'), 's1', 'session preserved — adding a capability must not wipe context')
})

// Config discovery for the feishu base skill (real-machine bug, v0.2.0→0.2.1): the agent runs
// `sbot feishu` from its workdir, where loadConfig's ./sbot.config.json / ~/.sbot lookups miss a
// config living elsewhere (e.g. ~/sbot/). The engine injects SBOT_CONFIG = the daemon's own path.
test('engine: injects SBOT_CONFIG (daemon config path) so `sbot feishu` finds it from any cwd', async () => {
  let captured
  const cfg = baseCfg(); cfg._path = '/Users/x/sbot/sbot.config.json'
  const eng = new Engine(cfg, { runner: okRunner((opts) => { captured = opts; return Promise.resolve({ sessionId: 's', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), mkPlatform()); await tick()
  assert.equal(captured.extraEnv.SBOT_CONFIG, '/Users/x/sbot/sbot.config.json')
  assert.equal(captured.extraEnv.SBOT_CHAT_ID, 'G')
})

// Plain-text fallback (no streaming card, e.g. cardkit scope missing) must use the accumulated
// stream buffer, not just result.text: codex streams the answer as several agent_message items and
// result.text can be empty or only the last chunk — so a `finalText`-only reply drops the answer.
test('engine: no-card reply uses streamed buf, not just result.text (codex multi-part)', async () => {
  const runner = okRunner((opts) => {
    opts.onEvent({ type: 'assistant', text: '第一段。' })
    opts.onEvent({ type: 'assistant', text: '第二段。' })
    opts.onEvent({ type: 'result', subtype: 'success', text: '' }) // codex: final result carries no text
    return Promise.resolve({ sessionId: 's', result: { text: '', usage: null } })
  })
  const p = mkPlatform() // no createStreamingCard ⇒ plain-text path
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('go'), p); await tick()
  assert.equal(p.replies.length, 1)
  assert.match(p.replies[0], /第一段。第二段。/)
})

// ── 排队合并(dequeue-time coalescing)+ 撤回即停(handleRecall) ─────────────────────

test('engine: 排队合并 — 忙时攒下的 N 条消息出队时合并成一轮,各带 [时间 发送者] 行', async () => {
  const prompts = []
  let finishFirst
  const runner = okRunner((opts) => {
    prompts.push(opts.prompt)
    if (prompts.length === 1) return new Promise((res) => { finishFirst = () => res({ sessionId: 's1', result: { text: 'ok1' } }) })
    return Promise.resolve({ sessionId: 's1', result: { text: 'ok2' } })
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  const p = mkPlatform()
  eng.handleMessage(mkMsg('第一件事'), p); await tick()          // 占住锁
  await eng.handleMessage(mkMsg('补充一'), p)                    // 排队 1
  await eng.handleMessage(mkMsg('补充二'), p)                    // 排队 2
  assert.match(p.replies[0], /已排队/)
  assert.match(p.replies[1], /一并处理/)                          // 第 2 条排队起,明示会合并
  finishFirst(); await tick(); await tick()                      // release → coalesce → 下一轮
  assert.equal(prompts.length, 2, '两条排队消息必须合并成一轮,而不是各起一轮')
  assert.match(prompts[1], /条消息.*一并处理/)                    // 批量说明头
  assert.match(prompts[1], /补充一/)
  assert.match(prompts[1], /补充二/)
  assert.doesNotMatch(prompts[1], /第一件事/)                     // 上一轮的内容不重复出现
  assert.match(prompts[1], /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} u\] 补充一/) // 每条保留自己的时间戳行
})

test('engine: 撤回排队中的消息 — 从队列剔除,出队只处理剩下的(单条则不带批量头)', async () => {
  const prompts = []
  let finishFirst
  const runner = okRunner((opts) => {
    prompts.push(opts.prompt)
    if (prompts.length === 1) return new Promise((res) => { finishFirst = () => res({ sessionId: 's1', result: { text: 'ok' } }) })
    return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } })
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  const p = mkPlatform()
  eng.handleMessage(mkMsg('长任务'), p); await tick()
  const m2 = mkMsg('这条会被撤回'); await eng.handleMessage(m2, p)
  const m3 = mkMsg('这条保留'); await eng.handleMessage(m3, p)
  assert.equal(eng.handleRecall({ chatId: 'G', msgId: m2.msgId }), true)
  finishFirst(); await tick(); await tick()
  assert.equal(prompts.length, 2)
  assert.doesNotMatch(prompts[1], /这条会被撤回/)   // 撤回的没进下一轮
  assert.match(prompts[1], /这条保留/)
  assert.doesNotMatch(prompts[1], /一并处理/)        // 只剩一条 ⇒ 无批量头
})

test('engine: 撤回运行中的消息 — 如 /stop 中止,但无卡片时全程静默;锁释放后群可继续', async () => {
  const prompts = []
  const runner = okRunner(({ prompt, signal }) => {
    prompts.push(prompt)
    if (prompts.length > 1) return Promise.resolve({ sessionId: 's2', result: { text: 'ok' } })
    return new Promise((resolve) => {   // 第一轮挂起直到 abort(撤回触发)
      const done = () => resolve({ sessionId: 'partial', result: { text: 'x' }, aborted: true })
      if (signal.aborted) return done()
      signal.addEventListener('abort', done)
    })
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  const p = mkPlatform()
  const m = mkMsg('发错了马上撤回')
  eng.handleMessage(m, p); await tick()
  assert.equal(eng.handleRecall({ chatId: 'G', msgId: m.msgId }), true)
  await tick(); await tick()
  assert.ok(!p.replies.some((t) => /已停止/.test(t)), '撤回中止必须静默 — 不发「已停止」(那是 /stop 的确认语)')
  await eng.handleMessage(mkMsg('下一件事'), p); await tick()      // 锁已释放,新消息正常跑
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /下一件事/)
})

test('engine: 撤回不认识的消息 / 已合并进运行中批量的消息 — 不中止', async () => {
  const prompts = []
  let finishFirst, finishBatch
  const runner = okRunner((opts) => {
    prompts.push(opts.prompt)
    if (prompts.length === 1) return new Promise((res) => { finishFirst = () => res({ sessionId: 's1', result: { text: 'ok' } }) })
    return new Promise((res) => { finishBatch = () => res({ sessionId: 's1', result: { text: 'ok' } }) })
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  const p = mkPlatform()
  assert.equal(eng.handleRecall({ chatId: 'G', msgId: 'nope' }), false)     // 无运行态 → no-op
  eng.handleMessage(mkMsg('第一轮'), p); await tick()
  const m2 = mkMsg('批量甲'); await eng.handleMessage(m2, p)
  const m3 = mkMsg('批量乙'); await eng.handleMessage(m3, p)
  finishFirst(); await tick(); await tick()                                  // 批量轮开跑(挂起)
  assert.equal(prompts.length, 2)
  assert.equal(eng.handleRecall({ chatId: 'G', msgId: m2.msgId }), false)   // 批量中的一条 → 不中止整轮
  assert.equal(eng.liveState().groups.G.busy, true, '批量轮必须继续跑')
  finishBatch(); await tick()                                               // 收尾,别留挂起的锁
})

// ── /stop 单条终态确认(v0.3.5):abort → 原地等真停 → 只回一条「已停止」;挂死走 forceRelease 兜底 ──

test('engine: /stop — 正常中止只回一条「已停止」,无「正在停止…」,finalize 不重复确认', async () => {
  const runner = okRunner(({ signal }) => new Promise((resolve) => {
    const done = () => resolve({ sessionId: 'partial', result: { text: 'x' }, aborted: true })
    if (signal.aborted) return done()
    signal.addEventListener('abort', done)
  }))
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  eng.handleMessage(mkMsg('long'), mkPlatform()); await tick()
  const p = mkPlatform()
  await eng.handleMessage(mkMsg('/stop'), p); await tick()
  assert.deepEqual(p.replies, ['已停止'], '/stop 者恰好收到一条终态确认')
  const all = p.replies.filter((t) => /已停止/.test(t))
  assert.equal(all.length, 1, '不能出现第二条「已停止」(finalize 的 no-card 确认须被 stopRequested 抑制)')
  assert.equal(eng.rts.get('G').busy, false)
})

test('engine: /stop — runner 挂死不理 abort ⇒ 等待窗后 forceRelease 强制清锁,仍回「已停止」', async () => {
  const cfg = baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, stopWaitMs: 200, hardReleaseMs: 100000 } })
  const runner = okRunner(() => new Promise(() => {})) // 永不 resolve、无视 abort
  const eng = new Engine(cfg, { runner, store: mkStore() })
  eng.handleMessage(mkMsg('hung'), mkPlatform()); await tick()
  assert.equal(eng.rts.get('G').busy, true)
  const p = mkPlatform()
  await eng.handleMessage(mkMsg('/stop'), p)
  assert.match(p.replies[0], /已停止/)
  assert.equal(eng.rts.get('G').busy, false, '等待窗超时后 forceRelease 兜底 — 「已停止」保证兑现')
})

// ── 中止的一轮必须记 stopped:真 CLI 临死前还会吐一个 result 事件 ────────────────────
// 2026-08-16 DemoApp 实测:群成员撤回消息 → 引擎按设计中止 → 那一轮却在 ledger 里记成
// `error`,群里给的也是「出错」而不是「消息已撤回,已停止处理」。根因是结算竞态:claude CLI
// 收到 SIGTERM 后**先吐一个 result 事件再退出**(探针实测 2.1.228:SIGTERM 后 ~0.05s 出
// {subtype:'error_during_execution', is_error:true, terminal_reason:'aborted_streaming',
// usage 全零},随后 close code=143),而 onEvent 里「答案即结算」那条路原先写死 aborted:false
// ⇒ 它抢先把这轮定成 error;runner 稍后带着正确的 aborted:true 回来时 finalized 闸门已关。
// ⚠ **以前测不出来**:上面那些用例的假 runner 在 abort 后直接 resolve({aborted:true})、一个
// result 事件都不发 —— 基准取自「我以为 CLI 会怎样」,而不是它真的怎样(同教训 16)。下面这个
// 假 runner 按真 CLI 的形状来:先发 result/is_error,再带 aborted 收尾。
const killEmitsResultRunner = () => okRunner(({ signal, onEvent }) => new Promise((resolve) => {
  const onKill = () => {
    onEvent({ type: 'result', subtype: 'error_during_execution', isError: true, usage: null }) // 临死前这一发
    resolve({ sessionId: 'partial', result: { subtype: 'error_during_execution', isError: true }, aborted: true })
  }
  if (signal.aborted) return onKill()
  signal.addEventListener('abort', onKill)
}))

test('engine: 撤回中止 — CLI 临死前吐的 result/is_error 不许把这一轮定成 error', async () => {
  const records = []
  const eng = new Engine(baseCfg(), { runner: killEmitsResultRunner(), store: mkStore(), ledger: { append: (r) => records.push(r) } })
  const p = mkPlatform()
  const m = mkMsg('发错了马上撤回')
  eng.handleMessage(m, p); await tick()
  assert.equal(eng.handleRecall({ chatId: 'G', msgId: m.msgId }), true)
  for (let i = 0; i < 6; i++) await tick()
  assert.equal(records.length, 1, '中止的一轮也要留痕')
  assert.equal(records[0].status, 'stopped', '人主动撤回 ≠ 故障 —— 记成 error 会污染一切拿 ledger 当判据的分析')
  assert.ok(!p.replies.some((t) => /出错/.test(t)), '撤回中止不该在群里报错')
  assert.ok(!p.replies.some((t) => /已停止/.test(t)), '撤回中止仍须静默(「已停止」是 /stop 的确认语)')
})

test('engine: /stop 中止 — 同样记 stopped,群里仍只有一条「已停止」', async () => {
  const records = []
  const eng = new Engine(baseCfg(), { runner: killEmitsResultRunner(), store: mkStore(), ledger: { append: (r) => records.push(r) } })
  const p = mkPlatform()                                   // 两条消息共用一个 platform:
  eng.handleMessage(mkMsg('long'), p); await tick()        // finalize 的回复发给**本轮**的 platform,
  await eng.handleMessage(mkMsg('/stop'), p)               // 各用各的就看不见多出来的那条
  for (let i = 0; i < 6; i++) await tick()
  assert.equal(records[0].status, 'stopped')
  assert.deepEqual(p.replies, ['已停止'], '不能在确认之外再多一条「出错」')
})

// ── 群暂停(groups[chatId].paused;2026-07-22)—— 完全静默 + 排队清空 + 水位线照推 ──

test('paused: 暂停群消息静默丢弃 — 不派发不回复,水位线仍推进(恢复后不回放)', async () => {
  let calls = 0
  const store = mkStore()
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', paused: true } } })
  const eng = new Engine(cfg, { runner: okRunner(async () => { calls++; return { sessionId: 's', result: { text: 'ok' } } }), store })
  const p = mkPlatform()
  const m = mkMsg('干活')
  await eng.handleMessage(m, p); await tick()
  assert.equal(calls, 0)
  assert.equal(p.replies.length, 0) // 完全静默(通知走控制台暂停动作那一条,不在这里)
  assert.equal(store.getWatermark('G'), m.createTimeMs) // 水位线照推 ⇒ 恢复后重投不回放
})

test('paused: slash 命令也静默(/status /stop 一视同仁)', async () => {
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', paused: true } } })
  const eng = new Engine(cfg, { runner: okRunner(), store: mkStore() })
  const p = mkPlatform()
  await eng.handleMessage(mkMsg('/status'), p); await tick()
  assert.equal(p.replies.length, 0)
})

test('paused: 轮进行中被暂停 → 当前轮跑完,排队消息在出队时丢弃不派发', async () => {
  let calls = 0
  let release
  const gate = new Promise((r) => { release = r })
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => { calls++; await gate; return { sessionId: 's', result: { text: 'ok' } } }), store: mkStore() })
  const p = mkPlatform()
  eng.handleMessage(mkMsg('第一条'), p); await tick()         // NOT awaited — 挂起轮(gate 未放行)
  await eng.handleMessage(mkMsg('排队的'), p); await tick()   // 入队
  assert.equal(eng.rts.get('G').queue.length, 1)
  eng.cfg.groups.G.paused = true // 模拟控制台暂停 + 热重载
  release(); await tick(); await tick()
  assert.equal(calls, 1, '排队消息被丢弃,不再起第二轮')
  assert.equal(eng.rts.get('G').queue.length, 0)
})

test('paused: 恢复后(去掉 paused)消息照常处理', async () => {
  let calls = 0
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', paused: true } } })
  const eng = new Engine(cfg, { runner: okRunner(async () => { calls++; return { sessionId: 's', result: { text: 'ok' } } }), store: mkStore() })
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.equal(calls, 0)
  delete eng.cfg.groups.G.paused // 恢复(热重载)
  await eng.handleMessage(mkMsg('b'), mkPlatform()); await tick()
  assert.equal(calls, 1)
})

// ── 收到任务先回一声(v0.11.10)────────────────────────────────────────────
// 卡是懒建的(NO_REPLY 轮群里必须无痕),所以回执不能一收到就发 —— 做法是「等一会儿还没动静
// 才把本来就要建的那张卡提前建出来填一句」。测试用真时钟,故阈值取几十毫秒。
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ackCfg = (ackDelayMs) => { const c = baseCfg(); c.agent = { ...c.agent, ackDelayMs }; return c }
const slowRunner = (ms, { text = 'ok', stream = null } = {}) => ({
  runTurn: async ({ onEvent }) => {
    await wait(ms)
    if (stream) onEvent({ type: 'assistant', text: stream })
    return { sessionId: 's', result: { text } }
  },
})

test('ack: 迟迟没动静 ⇒ 先在卡里回一声,答案到了在同一张卡原地替换', async () => {
  const p = mkCardPlatform()
  const eng = new Engine(ackCfg(20), { runner: slowRunner(100, { text: '查完了' }), store: mkStore() })
  eng.handleMessage(mkMsg('查一下'), p)
  await wait(60)
  assert.equal(p.cards.length, 1, 'ack 应把卡提前建出来')
  assert.match(p.cards[0].updates[0], /已收到/)
  await wait(140)
  assert.equal(p.cards[0].finished, '查完了') // 同一张卡,原地替换
  assert.equal(p.cards.length, 1)             // 没有第二张卡
  assert.equal(p.replies.length, 0)           // 也没多发消息
})

test('ack: 阈值内就有答案 ⇒ 一切照旧,零变化', async () => {
  const p = mkCardPlatform()
  const eng = new Engine(ackCfg(300), { runner: slowRunner(10, { text: 'fast', stream: 'fast' }), store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p); await wait(60)
  assert.equal(p.cards[0].finished, 'fast')
  assert.ok(!p.cards[0].updates.some((u) => /已收到/.test(u)), '快轮不该出现回执')
})

test('ack: 之后却以静默收场 ⇒ 撤回那张卡,群里不留痕', async () => {
  const p = mkCardPlatform()
  const eng = new Engine(ackCfg(20), { runner: slowRunner(100, { text: NO_REPLY }), store: mkStore() })
  await eng.handleMessage(mkMsg('闲聊'), p); await wait(200)
  assert.equal(p.cards[0].recalled, true)
  assert.equal(p.cards[0].finished, null, '撤掉了就不该再 finish 一次')
  assert.equal(p.replies.length, 0)
})

test('ack: 撤回失败 ⇒ 退中性句收尾,绝不把「正在处理」晾在群里', async () => {
  const p = mkCardPlatform({ recallOk: false })
  const eng = new Engine(ackCfg(20), { runner: slowRunner(100, { text: NO_REPLY }), store: mkStore() })
  await eng.handleMessage(mkMsg('闲聊'), p); await wait(200)
  assert.equal(p.cards[0].recalled, false)
  assert.equal(p.cards[0].finished, '_(已处理)_')
  assert.doesNotMatch(String(p.cards[0].finished), /正在处理/)
})

test('ack: 流式吐出的 NO_REPLY 不进卡 —— ack 打破了「有卡 ⇒ 文本必已分歧」这个巧合', async () => {
  const p = mkCardPlatform()
  const eng = new Engine(ackCfg(20), { runner: slowRunner(100, { text: NO_REPLY, stream: NO_REPLY }), store: mkStore() })
  await eng.handleMessage(mkMsg('x'), p); await wait(200)
  assert.ok(!p.cards[0].updates.some((u) => u.includes(NO_REPLY)), 'NO_REPLY 不该被逐字打进卡里')
  assert.equal(p.cards[0].recalled, true)
})

test('ack: 合成消息(定时任务 / 画布按钮带真人 id)永不回执', async () => {
  for (const extra of [{ userId: 'cron', synthetic: true }, { userId: 'ou_real_operator', synthetic: true }]) {
    const p = mkCardPlatform()
    const eng = new Engine(ackCfg(20), { runner: slowRunner(90, { text: 'done' }), store: mkStore() })
    await eng.handleMessage({ ...mkMsg('job'), ...extra }, p); await wait(60)
    assert.equal(p.cards.length, 0, '合成消息不该有回执卡(没人在等这句「收到」)')
    await wait(120)
  }
})

test('ack: 文案里没有工具名/命令名(用户面零工具名)', async () => {
  const p = mkCardPlatform()
  const eng = new Engine(ackCfg(20), { runner: slowRunner(100, { text: 'ok' }), store: mkStore() })
  eng.handleMessage(mkMsg('go'), p)
  await wait(60)
  const ack = p.cards[0].updates[0]
  assert.match(ack, /已收到/) // 对照组:确实扫到了那句回执,下面的否定断言才有意义
  assert.doesNotMatch(ack, /sbot|claude|codex|CLI/i)
  await wait(140)
})

test('ack: 真输出恰好赶在 timer 前一刻 ⇒ 不被回执盖掉(竞态)', async () => {
  const p = mkCardPlatform()
  const runner = { runTurn: async ({ onEvent }) => { await wait(25); onEvent({ type: 'assistant', text: '真答案' }); await wait(80); return { sessionId: 's', result: { text: '真答案' } } } }
  const eng = new Engine(ackCfg(40), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('go'), p); await wait(200)
  assert.ok(!p.cards[0].updates.some((u) => /已收到/.test(u)), '回执不该盖掉已经在流的真答案')
  assert.equal(p.cards[0].finished, '真答案')
})

test('ledger: 强制清锁后迟到的结算,耗时仍是真实毫秒(不是 epoch)', async () => {
  const rows = []
  const eng = new Engine(baseCfg(), {
    store: mkStore(),
    ledger: { append: (r) => rows.push(r) },
    runner: { runTurn: async () => { await wait(70); return { sessionId: 's', result: { text: 'ok' } } } },
  })
  eng.handleMessage(mkMsg('go'), mkPlatform())
  await wait(20)
  eng._rt('G').forceRelease() // 挂死时 /stop 走的就是这条:rt.startedAt 被清 0
  await wait(160)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].ms < 10_000, `耗时应是真实毫秒,实际 ${rows[0].ms}`)
  assert.ok(rows[0].ts > 1e12, 'ts 仍是开始时刻的 epoch 毫秒')
})

// ── 被打断的轮次:关停快照(「恢复后自动续做」v1)——————————————————————————
// 判据全在 interruptedTurns():什么算欠账、什么不算。落盘/时效/文案在 pending.test.js。

test('中断快照: 在跑的轮被取到,且正文完整 —— 不是 ledger 那份 60 字摘要', async () => {
  const rows = []
  const eng = new Engine(baseCfg(), {
    store: mkStore(),
    ledger: { append: (r) => rows.push(r) },
    runner: { runTurn: async () => { await wait(120); return { sessionId: 's', result: { text: 'ok' } } } },
  })
  const long = '帮我核对一下上周的报表数据' + 'x'.repeat(80) // 远超 60 字
  eng.handleMessage(mkMsg(long), mkPlatform())
  await wait(30)
  const snap = eng.interruptedTurns()
  assert.equal(snap.length, 1)
  assert.equal(snap[0].text, long, '续做要拿完整请求,截半了等于没问')
  assert.ok(snap[0].text.length > 60)
  assert.equal(snap[0].chatId, 'G')
  assert.equal(snap[0].sender, 'u')
  await wait(160)
  assert.equal(rows[0].text.length, 60, '对照组:ledger 那份确实只有 60 字 ⇒ 不能拿它当续做输入')
  assert.deepEqual(eng.interruptedTurns(), [], '轮次收尾后不再是欠账')
})

test('中断快照: settled 的轮不算欠账 —— 答案已经发进群了,续做等于重算一遍钱', async () => {
  const eng = new Engine(baseCfg(), {
    store: mkStore(),
    runner: { runTurn: async ({ onEvent }) => { onEvent({ type: 'result', text: '答案' }); await wait(150); return { sessionId: 's', result: { text: '答案' } } } },
  })
  eng.handleMessage(mkMsg('查一下'), mkPlatform())
  await wait(40)
  assert.equal(eng._rt('G').busy, true, '对照组:锁还握着(子进程没退干净)')
  assert.equal(eng._rt('G').settled, true)
  assert.deepEqual(eng.interruptedTurns(), [])
  await wait(160)
})

test('中断快照: 合成消息不记账(定时任务下次到点还会跑,画布按钮可以再点)', async () => {
  const eng = new Engine(baseCfg(), {
    store: mkStore(),
    runner: { runTurn: async () => { await wait(120); return { sessionId: 's', result: { text: 'ok' } } } },
  })
  const m = mkMsg('每日整理')
  m.synthetic = true
  eng.handleMessage(m, mkPlatform())
  await wait(30)
  assert.equal(eng._rt('G').busy, true, '对照组:轮确实在跑,只是不记账')
  assert.deepEqual(eng.interruptedTurns(), [])
  await wait(160)
})

test('中断快照: 空闲的群不产生欠账', async () => {
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() })
  await eng.handleMessage(mkMsg('go'), mkPlatform()); await tick()
  assert.deepEqual(eng.interruptedTurns(), [])
})

test('中断快照: 合并批次取全部真人正文,混在批里的合成消息剔除', async () => {
  const eng = new Engine(baseCfg(), {
    store: mkStore(),
    runner: { runTurn: async () => { await wait(60); return { sessionId: 's', result: { text: 'ok' } } } },
  })
  eng.handleMessage(mkMsg('第一件事'), mkPlatform()) // 占住锁
  await wait(15)
  const cron = mkMsg('定时的活儿'); cron.synthetic = true
  eng.handleMessage(mkMsg('第二件事'), mkPlatform())
  eng.handleMessage(cron, mkPlatform())
  eng.handleMessage(mkMsg('第三件事'), mkPlatform())
  await wait(100) // 第一轮(60ms)结束 → 队列合并成一批开跑,此刻正跑到一半
  const snap = eng.interruptedTurns()
  assert.equal(snap.length, 1)
  assert.equal(snap[0].text, '第二件事\n第三件事')
  await wait(160)
})

test('中断快照: 被撤回的轮不记账 —— 用户收回了请求,重启后重做等于把撤回的内容又办了', async () => {
  const eng = new Engine(baseCfg(), {
    store: mkStore(),
    runner: { runTurn: async () => { await wait(200); return { sessionId: 's', result: { text: 'ok' } } } },
  })
  const m = mkMsg('把刚才那段聊天记录发出来')
  eng.handleMessage(m, mkPlatform())
  await wait(30)
  assert.equal(eng.interruptedTurns().length, 1, '对照组:撤回前它确实是一笔欠账')
  eng.handleRecall({ chatId: 'G', msgId: m.msgId })
  // ⚠ 撤回只 abort 不 forceRelease ⇒ 锁还握着、rt.pending 还在,窗口就在这儿
  assert.equal(eng._rt('G').busy, true)
  assert.deepEqual(eng.interruptedTurns(), [])
  await wait(230)
})

test('中断快照: /stop 与 /new 的窗口期同样不记账(abort 到清锁之间锁还握着)', async () => {
  const eng = new Engine(baseCfg(), {
    store: mkStore(),
    runner: { runTurn: async () => { await wait(200); return { sessionId: 's', result: { text: 'ok' } } } },
  })
  eng.handleMessage(mkMsg('跑个长任务'), mkPlatform())
  await wait(30)
  assert.equal(eng.interruptedTurns().length, 1) // 对照组
  eng._rt('G').stopRequested = true // /stop 置标记 → abort → 最多等 1s 才 forceRelease
  assert.deepEqual(eng.interruptedTurns(), [])
  eng._rt('G').stopRequested = false
  eng._rt('G').interrupt = true // /new 同理
  assert.deepEqual(eng.interruptedTurns(), [])
  await wait(230)
})

test('engine: 旧的 /quota 已不再识别(更名为 /hud,不留暗门别名)', async () => {
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore(), usageProbe: async () => '5h:12%' })
  const p = mkPlatform(); await eng.handleMessage(mkMsg('/quota'), p)
  assert.match(p.replies[0], /未知命令/) // 帮助里列什么,switch 就只认什么
  const p2 = mkPlatform(); await eng.handleMessage(mkMsg('/hud'), p2)
  assert.match(p2.replies[0], /5h:12%/) // 对照组:新名字确实通
})

test('engine: /help 里的命令名与实际接受的命令一致(防更名只改一处)', async () => {
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore(), usageProbe: async () => 'x' })
  const p = mkPlatform(); await eng.handleMessage(mkMsg('/help'), p)
  const listed = [...p.replies[0].matchAll(/·\s(\/[a-z]+)\s—/g)].map((m) => m[1])
  assert.ok(listed.length >= 6, `对照组:帮助里应扫到 6 条命令,实际 ${listed.length}`)
  for (const cmd of listed) {
    const px = mkPlatform(); await eng.handleMessage(mkMsg(cmd), px)
    assert.doesNotMatch(px.replies[0] || '', /未知命令/, `${cmd} 列在帮助里却不被识别`)
  }
})

test('manifest: 画布反馈会不会自动播报,跟着真实轮询状态说 —— 关着就明说「等他在群里讲」', async () => {
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', permissionMode: 'bypassPermissions', board: { url: 'https://b', whiteboardId: 'wb' } } } })
  // 轮询开着 ⇒ 照旧说会自动播报
  let { r, get } = capRunner()
  let eng = new Engine(cfg, { runner: r, store: mkStore() })
  eng.boardWatchOn = () => true
  await eng.handleMessage(mkMsg('a'), mkPlatform()); await tick()
  assert.match(get().prompt, /自动在群里播报摘要/)
  assert.doesNotMatch(get().prompt, /不会自动播报/)
  // 轮询关着(两台生产机的现状)⇒ 必须明说不会,并禁止对群成员承诺「我会自动收到」
  ;({ r, get } = capRunner())
  eng = new Engine(cfg, { runner: r, store: mkStore() })
  eng.boardWatchOn = () => false
  await eng.handleMessage(mkMsg('b'), mkPlatform()); await tick()
  assert.match(get().prompt, /画布反馈不会自动播报/)
  assert.match(get().prompt, /等他在群里说一声/)
  assert.doesNotMatch(get().prompt, /会自动在群里播报摘要/)
  // 没注入判据(CLI/试跑)⇒ 按「没有轮询」保守走,不凭空承诺
  ;({ r, get } = capRunner())
  eng = new Engine(cfg, { runner: r, store: mkStore() })
  await eng.handleMessage(mkMsg('c'), mkPlatform()); await tick()
  assert.match(get().prompt, /画布反馈不会自动播报/)
})

// ── 空轮:零产出不再算成功 ────────────────────────────────────────────────────
// 2026-08-13 DemoApp 真机:合并了 4 条真人消息(含 3 张图)的一轮 5 秒空退 —— tokens
// {in:0,out:0}、零工具、正文全空、claude 的 session 里那条 user 消息之后没有任何 assistant
// 响应。ledger 却把它记成 ok,群里只吐一句「(无输出)」⇒ 消息静默蒸发 25 分钟没人发现,
// 连事后来排查的人都被那个 ok 骗过一轮。故 ok 收窄为「真有产出」,零产出单列并自动重试一次。
// ⚠ 判据要三个零同时成立:下面「调过工具」「产出过 token」两条是能区分实现的实验 ——
// 判宽一格,重跑的就可能是已经部署过 / 已经发过消息的那一轮。

const emptyRunner = () => okRunner(async () => ({ sessionId: 's', result: {} }))

test('engine: 零产出的一轮记 empty,不再冒充 ok', async () => {
  const records = []
  const eng = new Engine(baseCfg(), { runner: emptyRunner(), store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('这题是不是送分'), mkPlatform())
  for (let i = 0; i < 10; i++) await tick()
  assert.ok(records.length >= 1, '空轮也必须留痕')
  assert.equal(records[0].status, 'empty')
  assert.ok(!records.some((r) => r.status === 'ok'), '两轮都空 ⇒ 一条 ok 都不该有')
})

test('engine: 空轮自动重试,且恰好一次', async () => {
  let calls = 0
  const runner = okRunner(async () => { calls++; return { sessionId: 's', result: {} } })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('q'), mkPlatform())
  for (let i = 0; i < 12; i++) await tick()
  assert.equal(calls, 2, '一次原轮 + 一次重试;重试仍空就收手,不能滚成无限循环')
})

test('engine: 重试成功 ⇒ 群里只留答案,空的那一轮一个字都不出', async () => {
  let calls = 0
  const runner = okRunner(async () => {
    calls++
    return calls === 1 ? { sessionId: 's', result: {} } : { sessionId: 's', result: { text: '是送分,题干把答案抄在题面上了' } }
  })
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('这题送分吗'), p)
  for (let i = 0; i < 12; i++) await tick()
  assert.equal(calls, 2)
  assert.deepEqual(p.replies, ['是送分,题干把答案抄在题面上了'], '重试成功就当无事发生')
  assert.ok(!p.replies.some((r) => /无输出/.test(r)), '旧口径会在这里吐「(无输出)」')
})

test('engine: 重试仍空 ⇒ 给一句能照做的话,且只说一次', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: emptyRunner(), store: mkStore() })
  await eng.handleMessage(mkMsg('q'), p)
  for (let i = 0; i < 12; i++) await tick()
  assert.equal(p.replies.length, 1, '两轮空只出声一次,不重复打扰群')
  assert.match(p.replies[0], /麻烦再发一次/)
  assert.doesNotMatch(p.replies[0], /无输出/)
})

// ── 空轮换会话重做(v0.11.103):会话接不上了就别在同一段会话里死磕 ────────────────────────
// 2026-09-15 DemoApp 实证:掐掉一个起过后台子任务的轮 ⇒ 之后每次续接会话 CLI 都先塞它们的完成通知,
// 模型答一句「不需要回复」退出,三条真人消息全空转、同会话重试同样空,直到有人 /new。
// 两个触发:①上一轮被掐断(store.tainted)⇒ 首次空转就换会话;②续接旧会话连空两次 ⇒ 换会话。
// 换会话只对续接的会话做;新开的会话空了清它没意义(既有「恰好一次」那条用例就是这种形状)。

// 中止型 runner:第 n 次调用按脚本回,第 1 次挂着直到被 abort(模拟被 /stop 掐断的长轮)
const scriptedRunner = (script, calls) => okRunner(({ signal, sessionId }) => new Promise((resolve) => {
  calls.push(sessionId === undefined ? null : sessionId)
  const step = script[calls.length - 1] || script[script.length - 1]
  if (step === 'hang') {
    const done = () => resolve({ sessionId: 's', result: { text: 'x' }, aborted: true })
    if (signal.aborted) return done()
    return signal.addEventListener('abort', done)
  }
  if (step === 'empty') return resolve({ sessionId: 's', result: {} })
  resolve({ sessionId: 's2', result: { text: step } })
}))

test('engine: 续接会话连空两次 ⇒ 换新会话再做一次(第三次不带 sessionId),仍空才出声', async () => {
  const calls = []
  const store = mkStore(); store.setSession('G', 'old')
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: scriptedRunner(['empty', 'empty', 'empty'], calls), store })
  await eng.handleMessage(mkMsg('q'), p)
  for (let i = 0; i < 16; i++) await tick()
  assert.equal(calls.length, 3, '同会话重试一次 + 换会话一次,然后收手')
  assert.equal(calls[0], 'old'); assert.equal(calls[1], 's', '第二次仍续接')
  assert.equal(calls[2], null, '第三次必须是新会话:带着旧 sessionId 去重做等于什么都没换')
  assert.equal(p.replies.length, 2, '换会话说一句 + 最终失败说一句,不多不少')
  assert.match(p.replies[0], /已自动开新会话/)
  assert.match(p.replies[1], /麻烦再发一次/)
})

test('engine: 换会话后成功 ⇒ 群里只有「换了会话」那句 + 答案', async () => {
  const calls = []
  const store = mkStore(); store.setSession('G', 'old')
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: scriptedRunner(['empty', 'empty', '重做的答案'], calls), store })
  await eng.handleMessage(mkMsg('q'), p)
  for (let i = 0; i < 16; i++) await tick()
  assert.equal(calls.length, 3)
  assert.deepEqual(p.replies.map((r) => r.replace(/ —— .*/, '')), ['🔄 上一段对话接不上了,已自动开新会话重做这条', '重做的答案'])
  assert.equal(store.getSession('G'), 's2', '新会话的 id 落盘,后面的轮接着它')
})

test('engine: 新开的会话空 ⇒ 只同会话重试一次,绝不「换会话」(清它没意义)', async () => {
  const calls = []
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: scriptedRunner(['empty', 'empty', 'empty'], calls), store: mkStore() })
  await eng.handleMessage(mkMsg('q'), p)
  for (let i = 0; i < 16; i++) await tick()
  assert.equal(calls.length, 2)
  assert.ok(!p.replies.some((r) => /开新会话/.test(r)))
  assert.match(p.replies[0], /麻烦再发一次/)
})

test('engine: 上一轮被 /stop 掐断 ⇒ 下一轮一空就换会话,不再同会话重试(09-15 那个形状)', async () => {
  const calls = []
  const store = mkStore(); store.setSession('G', 'old')
  const runner = scriptedRunner(['hang', 'empty', '重做的答案'], calls)
  const eng = new Engine(baseCfg(), { runner, store })
  eng.handleMessage(mkMsg('长任务'), mkPlatform()); await tick()
  const pStop = mkPlatform()
  await eng.handleMessage(mkMsg('/stop'), pStop); await tick()
  assert.match(pStop.replies[0], /已停止/)
  for (let i = 0; i < 6; i++) await tick()
  assert.equal(store.isTainted('G'), true, '被掐断的会话要打上标记,下一轮空转才认得出来')
  const p = mkPlatform()
  await eng.handleMessage(mkMsg('同事的下一条'), p)
  for (let i = 0; i < 16; i++) await tick()
  assert.equal(calls.length, 3, '中止 1 + 空 1 + 换会话重做 1;没有那次注定徒劳的同会话重试')
  assert.equal(calls[2], null, '重做必须在新会话里')
  assert.match(p.replies[0], /已自动开新会话/)
  assert.equal(p.replies[1], '重做的答案')
  assert.equal(store.isTainted('G'), false, '换了会话标记就该没了')
})

test('engine: 被掐断后只要产出过一轮,标记即清 —— 之后的空轮走回同会话重试', async () => {
  const calls = []
  const store = mkStore(); store.setSession('G', 'old')
  const runner = scriptedRunner(['hang', '接得上', 'empty', '重试成功'], calls)
  const eng = new Engine(baseCfg(), { runner, store })
  eng.handleMessage(mkMsg('长任务'), mkPlatform()); await tick()
  await eng.handleMessage(mkMsg('/stop'), mkPlatform()); await tick()
  for (let i = 0; i < 6; i++) await tick()
  assert.equal(store.isTainted('G'), true)
  await eng.handleMessage(mkMsg('a'), mkPlatform())
  for (let i = 0; i < 8; i++) await tick()
  assert.equal(store.isTainted('G'), false, 'ok 一轮 = 会话证明了自己接得上')
  const p = mkPlatform()
  await eng.handleMessage(mkMsg('b'), p)
  for (let i = 0; i < 16; i++) await tick()
  assert.equal(calls.length, 4)
  assert.equal(calls[2], 's2', '空的那轮续接的是 ok 轮留下的会话')
  assert.equal(calls[3], 's', '同会话重试(带着空轮报回的 sessionId),不是换会话:标记清了就不该再换')
  assert.deepEqual(p.replies, ['重试成功'])
})

test('engine: 插话(quiet)的空轮换会话不在群里出声', async () => {
  const calls = []
  const store = mkStore(); store.setSession('G', 'old')
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: scriptedRunner(['empty', 'empty', 'empty'], calls), store })
  await eng.handleMessage({ ...mkMsg('q'), quiet: true }, p)
  for (let i = 0; i < 16; i++) await tick()
  assert.equal(calls.length, 3, '重试照做')
  assert.deepEqual(p.replies, [], '群里无痕是承诺,连换会话的提示也不许漏出去')
})

test('engine: 新开会话的首轮就被 /stop 掐断 ⇒ 落盘的同时打标(审查逮到的形状:会话落盘了却没标)', async () => {
  const calls = []
  const store = mkStore() // 不预置会话 ⇒ 第一轮是新会话
  const eng = new Engine(baseCfg(), { runner: scriptedRunner(['hang', 'empty', '重做的答案'], calls), store })
  eng.handleMessage(mkMsg('长任务'), mkPlatform()); await tick()
  await eng.handleMessage(mkMsg('/stop'), mkPlatform()); await tick()
  for (let i = 0; i < 6; i++) await tick()
  assert.equal(store.getSession('G'), 's', '被掐断的首轮会话照常落盘')
  assert.equal(store.isTainted('G'), true, '落盘的同时必须打标,否则下一条空转要白跑一次同会话重试')
  const p = mkPlatform()
  await eng.handleMessage(mkMsg('下一条'), p)
  for (let i = 0; i < 16; i++) await tick()
  assert.equal(calls.length, 3); assert.equal(calls[2], null, '一空就换会话,不做同会话重试')
})

test('engine: /new 中断后迟到的中止收尾不许把新会话打脏', async () => {
  const store = mkStore(); store.setSession('G', 'old')
  let resolveOld
  const runner = okRunner(({ signal, sessionId }) => new Promise((resolve) => {
    if (sessionId === 'old') { resolveOld = () => resolve({ sessionId: 'old', result: { text: 'x' }, aborted: true }); return } // 对 abort 不响应,迟到收尾
    resolve({ sessionId: 's2', result: { text: '新会话答案' } })
  }))
  const eng = new Engine(baseCfg(), { runner, store })
  eng.handleMessage(mkMsg('长任务'), mkPlatform()); await tick()
  await eng.handleMessage(mkMsg('/new'), mkPlatform()); await tick() // 清会话 + forceRelease
  const p = mkPlatform()
  await eng.handleMessage(mkMsg('新话题'), p)
  for (let i = 0; i < 8; i++) await tick()
  assert.deepEqual(p.replies, ['新会话答案']); assert.equal(store.getSession('G'), 's2')
  resolveOld(); for (let i = 0; i < 6; i++) await tick() // 旧轮此刻才收尾
  assert.equal(store.isTainted('G'), false, '迟到的中止只认自己接的那段(old),不碰 s2')
})

test('engine: _retryEmpty 三道早返 —— 已 /stop · 锁已释放 · 群已暂停 ⇒ 不重试、不清会话、不出声', () => {
  const store = mkStore(); store.setSession('G', 'old'); store.markTainted('G')
  const eng = new Engine(baseCfg(), { runner: okRunner(), store })
  const rt = eng._rt('G')
  const mk = () => { const p = mkPlatform(); return { job: { msg: mkMsg('q'), platform: p }, p } }
  let { job, p } = mk(); rt.stopRequested = true
  eng._retryEmpty(rt, job, { status: 'empty', resumed: true }, false)
  assert.equal(rt.queue.length, 0); assert.deepEqual(p.replies, []); assert.equal(store.getSession('G'), 'old')
  rt.stopRequested = false; ({ job, p } = mk())
  eng._retryEmpty(rt, job, { status: 'empty', resumed: true }, true) // released
  assert.equal(rt.queue.length, 0); assert.deepEqual(p.replies, [])
  eng.cfg.groups.G.paused = true; ({ job, p } = mk())
  eng._retryEmpty(rt, job, { status: 'empty', resumed: true }, false)
  assert.equal(rt.queue.length, 0); assert.deepEqual(p.replies, []); assert.equal(store.getSession('G'), 'old', '暂停群连会话都不该清')
  eng.cfg.groups.G.paused = false; ({ job, p } = mk())
  eng._retryEmpty(rt, job, { status: 'empty', resumed: true }, false) // 对照:门都开着就该换会话
  assert.equal(rt.queue.length, 1); assert.match(p.replies[0], /已自动开新会话/); assert.equal(store.getSession('G'), null)
})

test('engine: runTurn 给 runner 的 extraEnv 与 baseSkillEnv 同源 —— 定时脚本路径调的正是它', async () => {
  let seen
  const runner = okRunner(async ({ extraEnv }) => { seen = extraEnv; return { sessionId: 's', result: { text: 'ok' } } })
  const eng = new Engine({ ...baseCfg(), _path: '/tmp/sbot.config.json' }, { runner, store: mkStore(), uiLocalUrl: 'http://127.0.0.1:4600' })
  await eng.handleMessage(mkMsg('q'), mkPlatform())
  for (let i = 0; i < 6; i++) await tick()
  assert.deepEqual(seen, eng.baseSkillEnv('G'), '两个消费者读同一个函数,不许各写一份')
  assert.equal(seen.SBOT_CHAT_ID, 'G'); assert.equal(seen.SBOT_CONFIG, '/tmp/sbot.config.json'); assert.equal(seen.SBOT_UI_URL, 'http://127.0.0.1:4600'); assert.ok(seen.TZ)
})

test('engine: _coalesce 把换会话的两个标记也按「任一为真」归并', () => {
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() })
  const merged = eng._coalesce([{ msg: mkMsg('重做的'), emptyRetried: true, freshRetried: true, firstResumed: true }, { msg: mkMsg('新来的') }])
  assert.equal(merged.freshRetried, true); assert.equal(merged.firstResumed, true)
})

test('engine: 调过工具但正文为空 ⇒ 仍是 ok,绝不重跑(副作用不可做第二遍)', async () => {
  let calls = 0
  const records = []
  const runner = okRunner(async ({ onEvent }) => {
    calls++
    onEvent({ type: 'assistant', tools: [{ name: 'Bash' }] }) // 已经动过手:可能是部署、可能是发消息
    return { sessionId: 's', result: {} }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('部署到 prod'), mkPlatform())
  for (let i = 0; i < 12; i++) await tick()
  assert.equal(calls, 1, '重跑这种轮 = 把已经做过的事再做一遍')
  assert.equal(records[0].status, 'ok')
})

test('engine: 产出过 token 但正文为空 ⇒ 仍是 ok,不重试', async () => {
  let calls = 0
  const records = []
  const runner = okRunner(async () => {
    calls++
    return { sessionId: 's', result: { usage: { input_tokens: 120, output_tokens: 7 } } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('q'), mkPlatform())
  for (let i = 0; i < 12; i++) await tick()
  assert.equal(calls, 1, '模型开口了就不算空轮 —— 空的是它的答案,不是这一轮')
  assert.equal(records[0].status, 'ok')
})

test('engine: NO_REPLY 的静默轮不是空轮 —— 不重试,仍记 no-reply', async () => {
  let calls = 0
  const records = []
  const runner = okRunner(async ({ onEvent }) => {
    calls++
    onEvent({ type: 'assistant', text: NO_REPLY })
    return { sessionId: 's', result: { text: NO_REPLY } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('定时任务'), mkPlatform())
  for (let i = 0; i < 12; i++) await tick()
  assert.equal(calls, 1, '有意静默 ≠ 什么都没发生')
  assert.equal(records[0].status, 'no-reply')
})

// 批内各条取值可能不同的三个标记,逐个裁决(2026-09-07 通读逮到,与 v0.11.42 quiet 同形)。
test('engine: 合并批次 —— 代表取最后一条真人消息;synthetic 全批才算;wantsAck 任一;resetSessionAfter 全批才翻篇', () => {
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() })
  const human = { ...mkMsg('真人的问题'), msgId: 'm-human', replyCtx: { chatId: 'G', messageId: 'm-human' } }
  const cron = { ...mkMsg('定时整理'), msgId: 'cron:G:1', synthetic: true, resetSessionAfter: true, replyCtx: { chatId: 'G' } }
  const say = { ...mkMsg('插话'), msgId: 'console:G:1', synthetic: true, wantsAck: true, replyCtx: { chatId: 'G' } }
  // 真人在前、定时任务在后:代表仍是真人(卡片锚到有 message_id 的那条),整批不算合成,也不翻篇
  const a = eng._coalesce([{ msg: human }, { msg: cron }])
  assert.equal(a.msg.msgId, 'm-human')
  assert.equal(a.msg.replyCtx.messageId, 'm-human')
  assert.equal(a.msg.synthetic, false)
  assert.equal(a.msg.resetSessionAfter, false, '真人的上下文不能被合并进来的整理任务清掉')
  assert.equal(a.batch.length, 2)
  // 全是合成消息:代表取末条,synthetic 保持,wantsAck 任一为真即为真
  const b = eng._coalesce([{ msg: cron }, { msg: say }])
  assert.equal(b.msg.msgId, 'console:G:1')
  assert.equal(b.msg.synthetic, true)
  assert.equal(b.msg.wantsAck, true)
  assert.equal(b.msg.resetSessionAfter, false, '只有一条要求翻篇 ⇒ 不翻')
  // 两条整理任务都要求翻篇 ⇒ 翻
  const c = eng._coalesce([{ msg: cron }, { msg: { ...cron, msgId: 'cron:G:2' } }])
  assert.equal(c.msg.resetSessionAfter, true)
  // 对照:单条不合并,原样返回
  assert.equal(eng._coalesce([{ msg: cron }]).msg, cron)
})

test('engine: 合并批次保住重试标记 —— 后到的新消息洗不掉它', async () => {
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() })
  const merged = eng._coalesce([{ msg: mkMsg('空轮重发的'), emptyRetried: true }, { msg: mkMsg('新来的') }])
  assert.equal(merged.emptyRetried, true, '代表取末条,但标记取批内任一为真,否则会一空再空反复重试')
  assert.equal(merged.batch.length, 2, '两条消息都还在,一条都不能丢')
})

// ── 群内反馈本 /issue ────────────────────────────────────────────────────────
// 群成员是这套系统真正的使用者,却一直没有够得着的反馈入口 —— 说了就散在聊天记录里。
// 命令只认显式 /issue(不让 agent 猜哪句是 bug 报告:智能不进编排层),落盘交给注入的
// 反馈本(core 不碰 fs)。最值钱的是附带的「上一轮指纹」—— 报问题的人描述不出的那半。

function mkIssues() {
  const added = []
  return { added, add: (r) => { const rec = { ...r, id: added.length + 1, status: 'open' }; added.push(rec); return rec } }
}

test('engine: /issue 记一条并回执带编号', async () => {
  const issues = mkIssues()
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore(), issues, version: '0.11.24' })
  await eng.handleMessage(mkMsg('/issue 刚才发的图它没理我'), p); await tick()
  assert.equal(issues.added.length, 1)
  assert.equal(issues.added[0].text, '刚才发的图它没理我')
  assert.equal(issues.added[0].sender, 'u')
  assert.equal(issues.added[0].version, '0.11.24', '哪一版报的是事后分析第一判据')
  assert.match(p.replies[0], /已记下 #1/)
})

test('engine: /issue 自动附上一轮的技术指纹', async () => {
  const issues = mkIssues()
  const runner = okRunner(async () => ({ sessionId: 's', result: { text: '答', usage: { input_tokens: 3, output_tokens: 5 } } }))
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), issues })
  await eng.handleMessage(mkMsg('干活'), mkPlatform()); await tick()
  const p = mkPlatform()
  await eng.handleMessage(mkMsg('/issue 它答得不对'), p); await tick()
  const turn = issues.added[0].turn
  assert.ok(turn, '「刚才」那一轮的指标正是报问题的人说不出、我们最需要的那半')
  assert.equal(turn.status, 'ok')
  assert.deepEqual(turn.tokens, { in: 3, out: 5 })
  assert.equal(turn.provider, 'claude')
  assert.match(p.replies[0], /运行记录/)
})

test('engine: /issue 没有前一轮时不附指纹,也不编一个', async () => {
  const issues = mkIssues()
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore(), issues })
  await eng.handleMessage(mkMsg('/issue 一进来就不对'), p); await tick()
  assert.equal(issues.added[0].turn, null)
  assert.doesNotMatch(p.replies[0], /运行记录/)
})

test('engine: /issue 正文保留换行 —— 现象与复现步骤常靠它分隔', async () => {
  const issues = mkIssues()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore(), issues })
  await eng.handleMessage(mkMsg('/issue 现象:没反应\n复现:连发三张图'), mkPlatform()); await tick()
  assert.equal(issues.added[0].text, '现象:没反应\n复现:连发三张图', 'args.join(" ") 会把换行压成空格')
})

test('engine: /issue 不带正文给用法,不记空条目', async () => {
  const issues = mkIssues()
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore(), issues })
  await eng.handleMessage(mkMsg('/issue'), p); await tick()
  assert.equal(issues.added.length, 0)
  assert.match(p.replies[0], /用法/)
})

test('engine: 没有反馈本时如实说不可用,不假装记下了', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() }) // 不注入 issues(CLI 试跑)
  await eng.handleMessage(mkMsg('/issue 有个问题'), p); await tick()
  assert.match(p.replies[0], /不可用/)
  assert.doesNotMatch(p.replies[0], /已记下/, '假装记下了比明说不可用糟得多')
})

test('engine: /issue 不占群锁,不派轮次', async () => {
  let runs = 0
  const issues = mkIssues()
  const eng = new Engine(baseCfg(), { runner: okRunner(async () => { runs++; return { sessionId: 's', result: { text: 'x' } } }), store: mkStore(), issues })
  await eng.handleMessage(mkMsg('/issue 随手报一条'), mkPlatform()); await tick()
  assert.equal(runs, 0, '报个问题不该花一次模型调用,也不该让后面的人排队')
  assert.equal(eng.rts.get('G').busy, false)
})

test('engine: /help 列出 /issue', async () => {
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore(), issues: mkIssues() })
  await eng.handleMessage(mkMsg('/help'), p); await tick()
  assert.match(p.replies[0], /\/issue/)
})

test('engine: 反馈本写失败时如实说没记下,不冒泡成「内部错误」', async () => {
  const p = mkPlatform()
  const boom = { add: () => { throw new Error('disk full') } }
  const eng = new Engine(baseCfg(), { runner: okRunner(), store: mkStore(), issues: boom })
  await eng.handleMessage(mkMsg('/issue 报个问题'), p); await tick()
  assert.equal(p.replies.length, 1)
  assert.match(p.replies[0], /没记下来/)
  assert.doesNotMatch(p.replies[0], /内部错误/, '「内部错误」会让人以为已经记下了 —— 那正是这本账要消灭的情形')
})

// ── 设计图 → 网页 的图片资产管线(清单侧,v0.11.27)────────────────────────────
// 此前这一环是断的:agent 能照设计图写 HTML/CSS,但素材拆不出来,只能凭印象重画 ⇒ 页面与
// 设计图对不上。清单教四步(列清单 → 抠 → 补全 → 对照自查),并把「要保原样就得 --ref」讲死。

function capRunnerPrompt() {
  let seen = null
  return { r: { runTurn: async (o) => { seen = o; return { sessionId: 's', result: { text: 'ok' } } } }, get: () => seen }
}

test('engine: 生图可用的群,清单教「设计图→网页」四步与改图三参数', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.hasImagen = () => true
  await eng.handleMessage(mkMsg('照这张设计图做页面'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /设计图 → 网页/)
  assert.match(p, /先列资产清单/)
  assert.match(p, /能用 CSS 的一律不要出图/, '出图比写 CSS 贵得多,这条得写死')
  assert.match(p, /rembg/, '保真抠图优先本地工具,免额度且结果确定')
  assert.match(p, /--transparent/)
  assert.match(p, /--mask/)
  assert.match(p, /--ref/)
  assert.match(p, /并排对照/, '交付前自查')
  assert.match(p, /主动在群里点名说明/, '重绘过的素材必须说出来 —— 别让人以为用的是原图')
})

test('engine: 「要保原样就必须给 --ref」写进清单(不写它会退回凭印象重画)', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.hasImagen = () => true
  await eng.handleMessage(mkMsg('x'), mkPlatform()); await tick()
  assert.match(get().prompt, /要保留原图细节就必须给/)
})

test('engine: 生图不可用的群不注入这套流程(讲了也做不了)', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.hasImagen = () => false
  await eng.handleMessage(mkMsg('x'), mkPlatform()); await tick()
  const p = get().prompt
  assert.doesNotMatch(p, /设计图 → 网页/)
  assert.doesNotMatch(p, /rembg/)
  assert.match(p, /【你是 SintBot】/, '对照组:清单本身确实注入了(否则本条断言无效)')
})

// ── 风格档:从「指路牌」变成「摆在上下文里」+ 交付前回归检查(v0.11.29)──
test('engine: 清单直接摆出风格档 tokens,并要求交付前跑 check 贴结果', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => [{ rel: 'design/styles/mini.md', abs: '/p/design/styles/mini.md', platform: '小程序', digest: '色板 accent #1B6B37 | 字体 inter | 圆角 8px / 999px' }]
  await eng.handleMessage(mkMsg('做个页面'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /#1B6B37/, 'tokens 要摆进上下文 —— 只给路径等于只给指路牌,它可能根本没读')
  assert.match(p, /圆角 8px/)
  assert.match(p, /design check/)
  assert.match(p, /原样贴进你给群里的交付说明/)
  assert.match(p, /不等于做错了/, '不写死这句,它会把设计图自带的渐变也一并改掉')
})

// ── 压缩之后清单要回来(v0.11.34)────────────────────────────────────────────────
// ⚠ 真机实证(DemoApp,2026-08-17 16:09 压缩):自知清单只在**会话首轮**注入一次,
// 而压缩把最久远的内容折叠掉 —— 清单正是最久远的那一段。压缩后的 18KB 摘要里,清单的
// 13 条关键约定**丢了 12 条**(身份/零工具名/画布/生图/预览/交付纪律全没了,只剩 NO_REPLY)。
// 症状不是「不会用工具」(MCP 工具定义每轮随请求重传,压不掉),而是**规矩没了**。
// ⚠ 两条腿都要有:压缩事件只有 claude 报得出来,**codex 的压缩不上 exec 输出流**
// (生产机三个群全是 codex)⇒ 必须另有一条与 runner 无关的兜底。
test('清单: 压缩之后下一轮必须重注入(claude 报得出压缩事件)', async () => {
  const prompts = []
  const runner = okRunner((opts) => {
    prompts.push(opts.prompt)
    if (prompts.length === 2) opts.onEvent({ type: 'system', subtype: 'compact_boundary' })
    return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } })
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  const p = mkPlatform()
  const has = (t) => /基础技能|对外怎么说/.test(t)
  for (let i = 0; i < 4; i++) { await eng.handleMessage(mkMsg('第' + i + '条'), p); await tick(); await tick() }
  assert.ok(has(prompts[0]), '首轮必带清单')
  assert.ok(!has(prompts[1]), '没压缩就不重复付这份 token')
  assert.ok(has(prompts[2]), '压缩发生在第 2 轮 ⇒ 第 3 轮必须把清单带回来')
  assert.ok(!has(prompts[3]), '带回来之后又恢复「不重复注入」')
})

test('清单: 没有压缩信号的 runner 靠轮数兜底(codex 群唯一的保障)', async () => {
  const prompts = []
  const eng = new Engine(baseCfg(), { runner: okRunner((o) => { prompts.push(o.prompt); return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store: mkStore() })
  const p = mkPlatform()
  const has = (t) => /基础技能|对外怎么说/.test(t)
  for (let i = 0; i < 25; i++) { await eng.handleMessage(mkMsg('m' + i), p); await tick(); await tick() }
  const withManifest = prompts.map((t, i) => (has(t) ? i : -1)).filter((i) => i >= 0)
  assert.equal(withManifest[0], 0, '首轮')
  assert.ok(withManifest.length >= 2, '25 轮里必须再重注入过至少一次 —— 否则 codex 群压缩后永远失忆')
  assert.ok(withManifest[1] <= 21, '兜底间隔不能太长(默认 20 轮),实测第 ' + withManifest[1] + ' 轮')
})

test('清单: 重注入不谎称「能力已更新」—— 内容真变了才这么说', async () => {
  const prompts = []
  const runner = okRunner((opts) => {
    prompts.push(opts.prompt)
    if (prompts.length === 1) opts.onEvent({ type: 'system', subtype: 'compact_boundary' })
    return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } })
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  const p = mkPlatform()
  await eng.handleMessage(mkMsg('a'), p); await tick(); await tick()
  await eng.handleMessage(mkMsg('b'), p); await tick(); await tick()
  assert.ok(/基础技能|对外怎么说/.test(prompts[1]), '压缩后重注入')
  assert.ok(!/能力\/配置已更新/.test(prompts[1]), '清单一个字没变,说「已更新」是假话 —— 那句只留给真变了的时候')
})

// ── 图标体系(v0.11.31;契约见 docs/ICONS.md)──────────────────
// ⚠ 一致性由「取得到正确图标」保证,不由「检查出不一致」保证 —— 所以清单的重点是那条取图标
// 的命令,而不是再念一遍规范。未启用时也必须说一句:否则「没报图标问题」会被读成「图标没问题」。
test('engine: 风格档启用了图标体系 ⇒ 清单教怎么取图标,并写死「不要自己写 path」', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => [{ rel: 'DESIGN.md', digest: '色板 accent #1B6B37 | 图标 lucide+tabler · 24 网格 · 描边 2 · 线性', icons: true }]
  await eng.handleMessage(mkMsg('做个页面'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /design icon/, '正路必须给到 —— 没有它,声明了图标库也还是自己画')
  assert.match(p, /不要自己写 path|绝不要自己写 path/)
  assert.match(p, /emoji/, 'emoji 不能当操作图标要写进去')
  assert.ok(!/未启用图标体系/.test(p), '启用了就不该再说未启用')
})

test('engine: 风格档没有 icons 段 ⇒ 清单如实说这一类没检查(不能让人读成「图标没问题」)', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => [{ rel: 'DESIGN.md', digest: '色板 accent #1B6B37', icons: false }]
  await eng.handleMessage(mkMsg('做个页面'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /还没选图标系统/)
  // ⚠ 仍然**不教取图标** —— 没选系统就没有统一口径,教了只会让它跑一条必然失败的命令
  assert.ok(!/design icon <名字/.test(p), '没选系统就别教取图标 —— 那条命令这时必然取不到')
  // ⭐ 但**必须教怎么选**:群里没有按钮,全靠对话,清单不提 = 群成员永远选不了这一维
  //   (与「17 份档声明了却报未启用」「新项目一个字不提设计规范」同族 —— 能力的到达率)
  assert.match(p, /design icons/, '没选的时候更要告诉它怎么选,否则这个能力在群里等于不存在')
})

// ⚠ 图标系统那段必须**与风格档解耦** —— 它一度写在「有风格档」那一支里,零风格档的新项目一个字
//   都读不到(而注释还写着「无条件注入」)。这与本版立论直接打架:图标与风格是**平级**的两件事,
//   把图标能力挂在风格档存不存在上,等于又绑了一次。原样复发的是 v0.11.49 第④件。
test('engine: 零风格档的新项目,清单里照样告诉它图标系统怎么看怎么换', async () => {
  const mk = async (docs) => {
    const { r, get } = capRunnerPrompt()
    const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
    eng.styleDocs = () => docs
    await eng.handleMessage(mkMsg('做个页面'), mkPlatform()); await tick()
    return get().prompt
  }
  const withDoc = await mk([{ rel: 'DESIGN.md', digest: '色板 accent #1B6B37', icons: true }])
  const noDoc = await mk([])
  assert.match(withDoc, /design icons/, '有风格档时本来就该有(先证明这条断言扫得到)')
  assert.match(noDoc, /design icons/, '零风格档时也必须有 —— 图标与风格平级,不该挂在风格档存不存在上')
  assert.doesNotMatch(noDoc, /design check/, '对照组:没风格档时仍不提对照检查(没依据可查)⇒ 两块确实是分开的')
})

test('engine: 项目没有风格档时不提 check(没依据可查)', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => []
  await eng.handleMessage(mkMsg('x'), mkPlatform()); await tick()
  const p = get().prompt
  assert.doesNotMatch(p, /design check/)
  assert.match(p, /【你是 SintBot】/, '对照组:清单确实注入了')
})

// 2026-10-30:预设不适合所有项目,只在明确从零设计新产品且缺少视觉方向时推荐;
// 日常页面任务不再收到「还没有风格档」或自动挑候选的提示。
test('engine: 零风格档只在全新产品且未定方向时允许推荐风格库', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => []
  await eng.handleMessage(mkMsg('x'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /【风格库提示边界】/, '要明确限制推荐适用范围')
  assert.match(p, /仅在明确启动全新产品/, '只有新产品且无方向时才允许推荐')
  assert.match(p, /不要主动提风格库/, '普通页面任务应保持安静')
  assert.match(p, /符合条件时.*需要时再展示少量候选预览.*由对方选定后保存/, '新产品场景保留可执行的选择流程')
  assert.doesNotMatch(p, /还没有风格档|这次的活儿若涉及.*设计/, '不再把缺少风格档描述成当前任务的缺陷')
})

// 对照:有档时**绝不能**再冒出「还没有风格档」那段(两段互斥,漏了会同时说两套话)
test('engine: 有风格档时不许再说「还没有风格档」', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => [{ rel: 'DESIGN.md', digest: '色板 accent #1B6B37' }]
  await eng.handleMessage(mkMsg('x'), mkPlatform()); await tick()
  const p = get().prompt
  assert.doesNotMatch(p, /还没有风格档/)
  assert.match(p, /色板 accent #1B6B37/, '对照组:有档那条路确实走到了')
})

// 资产体检只在**声明了资产目录**时才提 —— 没声明就没有扫描范围,多一行是纯噪音(清单每轮都付 token)。
test('engine: 声明了图标资产目录才教资产体检,没声明不多这一行', async () => {
  const mk = async (doc) => {
    const { r, get } = capRunnerPrompt()
    const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
    eng.styleDocs = () => [doc]
    await eng.handleMessage(mkMsg('x'), mkPlatform()); await tick()
    return get().prompt
  }
  const on = await mk({ rel: 'DESIGN.md', digest: '色板 accent #1B6B37', icons: true, iconAssets: true })
  assert.match(on, /design icon-assets/, '声明了就该教')
  assert.match(on, /整理图标时才跑/, '并且要说清节奏,否则它会每次交付都跑')
  const off = await mk({ rel: 'DESIGN.md', digest: '色板 accent #1B6B37', icons: true, iconAssets: false })
  assert.doesNotMatch(off, /design icon-assets/, '没声明资产目录就别提')
  assert.match(off, /design icon /, '对照组:图标那块本身确实注入了')
})

// v0.11.52:真机换来的 —— 让它做两个后台页面,全链路都对,但群里只收到一个 zip(要下载解压才
// 看得见)。它自查时截过图,图躺在项目里没发出去。⭐ 缺口不在能力(send-image 一直有),在**这条
// 路径上没人让它发**:三处截图教学全是条件性的(有画布 / 群里主动要 / 有设计图可对照),而
// 「做完页面直接交付」落在三个条件之外。⚠ 这条**不许挂条件** —— 一挂就又漏掉别的路径。
test('engine: 交付界面类产物要连截图一起发(不挂任何条件)', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => []              // 没风格档
  await eng.handleMessage(mkMsg('x'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /连一张截图一起发/, '没画布、没风格档、没人主动要,也必须有这条')
  assert.match(p, /send-image/)
  assert.match(p, /下载解压才看得见|手机/, '要说清为什么 —— 只给命令不给理由,它会按自己的判断省掉')
})

test('engine: 多份风格档时每份各列一行 tokens', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => [
    { rel: 'design/styles/mini.md', platform: '小程序', digest: '色板 accent #1B6B37' },
    { rel: 'design/styles/admin.md', platform: '后台网站', digest: '色板 accent #005F29' },
  ]
  await eng.handleMessage(mkMsg('x'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /#1B6B37/)
  assert.match(p, /#005F29/, '两份都要摆出来 —— 认错哪份就是整套颜色错')
})

test('engine: 风格档口径与有没有画布无关 —— 没建画布的群照样写页面', async () => {
  // ⚠ 这条是真机 bug 的守卫:原先整段挂在 `if (group.board && group.board.url)` 里,
  //   于是**没建画布的群连风格档都没被提过一次** —— 正是「风格档未被强制加载」
  //   有一半就来自这里。移出独立成段后,两种群都必须拿到 tokens 与 check 教学。
  for (const board of [null, { url: 'https://x/docx/abc', whiteboardId: 'w1' }]) {
    const { r, get } = capRunnerPrompt()
    const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', allowedTools: ['Read'], ...(board ? { board } : {}) } } })
    const eng = new Engine(cfg, { runner: r, store: mkStore() })
    eng.styleDocs = () => [{ rel: 'DESIGN.md', digest: '色板 accent #1B6B37 | 圆角 8px' }]
    await eng.handleMessage(mkMsg('做个页面'), mkPlatform()); await tick()
    const p = get().prompt
    const label = board ? '有画布群' : '无画布群'
    assert.match(p, /#1B6B37/, `${label}也要拿到 tokens`)
    assert.match(p, /design check/, `${label}也要被教交付前检查`)
  }
})

test('engine: 清单教「单文件预览的素材会 404,先处理再发链接」', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  await eng.handleMessage(mkMsg('把原型给大家看看'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /会全部 404/)
  assert.match(p, /先处理再发链接/)
  assert.match(p, /没有不该给人看的东西/, '改起目录会扩大暴露面,清单要一起说')
})

test('engine: 清单教「素材不许拉变形」并进交付自查', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.hasImagen = () => true
  await eng.handleMessage(mkMsg('照设计图做页面'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /object-fit/)
  assert.match(p, /不许把素材拉变形/)
  assert.match(p, /裁的是画面、不是把画面压扁/)
  assert.match(p, /逐张确认图片没被拉伸变形/, '交付自查里也要有 —— 拉扁最容易看漏')
})

test('engine: 清单点破「check 退出码 3 不是命令失败」(否则 agent 会当报错)', async () => {
  // imagen 的 --wait 退出码 2 踩过同款:非零退出码在 agent 的 Bash 工具里显示成「命令失败」,
  // 不点破它就会去重试、或干脆不提这件事。这条是复审补的 —— 那边写了这边最初漏了。
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => [{ rel: 'DESIGN.md', digest: '色板 accent #1B6B37' }]
  await eng.handleMessage(mkMsg('x'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /退出码是 3/)
  assert.match(p, /不是命令出错/)
  assert.match(p, /不用重试/)
})

// v0.11.62:第四条平级验收(查**风格档本身**)。⚠ 与 v0.11.55 / v0.11.49 同族 —— 命令发了、
// 清单没动 ⇒ 对 agent 而言这条能力**不存在**。前三条只会说「产物偏离了档」,谁都不会说
// 「档有问题」,而真机上缺口常常就在档里 ⇒ 不注入,那类缺口永远没人去改。
test('engine: 清单教第四条验收 `design doctor`(查风格档自己,不是查产物)', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => [{ rel: 'DESIGN.md', digest: '色板 accent #1B6B37' }]
  await eng.handleMessage(mkMsg('做个页面'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /design doctor/, '命令名不进清单 = 这条能力对 agent 不存在')
  assert.match(p, /从不说「档本身有问题」|档本身/, '得说清它跟另三条差在**查什么对象**上')
  assert.match(p, /语义色放错段/, '至少点名一类它查得出、而另三条查不出的东西')
  // 对照组:没风格档的项目不许提(doctor 没档可查,指过去就是一条跑不通的路)
  const { r: r2, get: g2 } = capRunnerPrompt()
  const eng2 = new Engine(baseCfg(), { runner: r2, store: mkStore() })
  eng2.styleDocs = () => []
  await eng2.handleMessage(mkMsg('做个页面'), mkPlatform()); await tick()
  assert.doesNotMatch(g2().prompt, /design doctor/, '零风格档时不提 —— 它会直接报「本项目还没有风格档」')
  assert.match(g2().prompt, /【你是 SintBot】/, '对照组的对照组:清单确实注入了')
})

// v0.11.62 追平:layout 早已从三件事长到五件,而清单还写着「三件事」—— 说少了的那两类
// (低对比文字 / 中文小字)它就不会去看报告里那几行,更不会当成要修的东西。
test('engine: 清单里 layout 报的是五件事(含低对比与中文小字)', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => [{ rel: 'DESIGN.md', digest: '色板 accent #1B6B37' }]
  await eng.handleMessage(mkMsg('做个页面'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /design layout/)
  assert.match(p, /报五件事/, '写「三件事」等于告诉它另两类不用管')
  assert.match(p, /对比度/)
  assert.match(p, /中文字号/)
  assert.doesNotMatch(p, /报三件事/, '旧说法必须消失(两处并存会互相打架)')
})

// v0.11.62 追平:check 也查中文兜底;判过可接受的偏离连理由记进例外档,免得同样三条噪音
// 被原样贴进群里四次(真机 2026-09-02)。
test('engine: 清单里 check 含中文兜底,并给出「已判可接受」的落点', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore() })
  eng.styleDocs = () => [{ rel: 'DESIGN.md', digest: '色板 accent #1B6B37' }]
  await eng.handleMessage(mkMsg('做个页面'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /中文字体兜底/)
  assert.match(p, /design\/check-accepted\.md/)
  assert.match(p, /没写理由的不生效/, '不写这句它会记一堆空条目,例外档就成了万能消音器')
})

// ── 控制台插话的「回复不进群」(quiet) ─────────────────────────────────────────
// operator 在控制台勾掉「它的回复」时,那一轮必须在群里**彻底无痕**。⚠ 关键是卡片:它是流式的,
// 建了就已经在群里亮着,等到最后再压回复已经晚了 —— 所以闸门在懒建那一口,与 NO_REPLY 同位置。
// ⚠ 三条都配了对照组(同输入、quiet:false):没有对照,"零回复"分不清是压住了还是压根没跑。
const mkQuietMsg = (text, quiet) => Object.assign(mkMsg(text), { synthetic: true, quiet })

test('engine: quiet 轮不发回复也不建卡(对照组证明同样输入本会出声)', async () => {
  // ⚠ runner 必须**真的流式输出** —— 否则 ensureCard() 压根不会被调用,
  //   `cards.length===0` 就是句假话(变异检验抓到过:拆掉建卡那道闸,这条照样绿)。
  const run = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '做完' })
    onEvent({ type: 'assistant', text: '了' })
    return { sessionId: 's1', result: { text: '做完了' } }
  })
  const q = mkCardPlatform()
  const e1 = new Engine(baseCfg(), { runner: run, store: mkStore() })
  await e1.handleMessage(mkQuietMsg('干活', true), q); await tick()
  assert.equal(q.replies.length, 0, 'quiet 轮不该有回复')
  assert.equal(q.cards.length, 0, 'quiet 轮连卡片都不该建(卡是流式的,建了就已经在群里)')

  const n = mkCardPlatform()   // 对照组:同样的输入、只是不 quiet
  const e2 = new Engine(baseCfg(), { runner: run, store: mkStore() })
  await e2.handleMessage(mkQuietMsg('干活', false), n); await tick()
  assert.ok(n.replies.length + n.cards.length > 0, '对照组必须出声 —— 否则上面的"零"证明不了什么')
})

test('engine: quiet 轮**连报错也不进群**(是取舍,不是漏网)', async () => {
  // 这个开关的语义是「这次动作不在群里留痕」,漏一条错误出去就破了承诺。
  // 代价:失败群里没人知道 ⇒ 界面必须写明「连出错也不会说,状态去实时活动看」。
  // 账本与活动流照常记 —— 是不广播,不是丢掉。
  const run = okRunner(async () => ({ sessionId: 's1', result: { text: 'boom', isError: true } }))
  const q = mkCardPlatform()
  const e1 = new Engine(baseCfg(), { runner: run, store: mkStore() })
  await e1.handleMessage(mkQuietMsg('干活', true), q); await tick()
  assert.equal(q.replies.length, 0)

  const n = mkCardPlatform()
  const e2 = new Engine(baseCfg(), { runner: run, store: mkStore() })
  await e2.handleMessage(mkQuietMsg('干活', false), n); await tick()
  assert.ok(n.replies.length > 0, '对照组:非 quiet 的报错必须出声')
})

test('engine: quiet 只压广播,不影响轮次本身跑完(账本仍记 ok)', async () => {
  let ran = 0
  const run = okRunner(async () => { ran++; return { sessionId: 's1', result: { text: '做完了' } } })
  const done = []
  const e = new Engine(baseCfg(), { runner: run, store: mkStore(), onActivity: (a) => { if (a.kind === 'done') done.push(a) } })
  await e.handleMessage(mkQuietMsg('干活', true), mkCardPlatform()); await tick()
  assert.equal(ran, 1, '轮次照跑')
  assert.equal(done.length, 1, '活动流照记 —— 群里不出声不等于没发生')
  assert.equal(done[0].status, 'ok', 'quiet 不该被记成 no-reply:它真有产出,只是没广播')
})

// ── quiet 的出声口不止 finalizeTurn 那一条(v0.11.42 修) ───────────────────────
// v0.11.38~41 的 quiet 闸是**逐处装**的,只堵住了懒建卡片 + finalizeTurn 的 if/else 链;
// 链外还有六个出声口全都照发。改法是把闸装在 reply 这个**唯一出口**上,下面每条钉一个口子。
// ⚠ 全部带对照组(同输入、quiet:false):没有对照,"零回复"分不清是压住了还是压根没跑到。

test('engine: quiet 轮在群忙时不发排队提示', async () => {
  // 「群里彻底无痕」被一句「⏳ 已排队」破功最刺眼:群成员看见一条没头没尾的排队,
  // 却永远等不到它对应的产出。⚠ 这个口子在 _dispatch,_runTurn 那道 reply 闸够不着。
  const mk = async (quiet) => {
    const p = mkCardPlatform()
    const e = new Engine(baseCfg(), { runner: slowRunner(120, { text: 'done' }), store: mkStore() })
    e.handleMessage(mkMsg('占住群锁'), p); await tick()
    await e.handleMessage(mkQuietMsg('顺手改个文档', quiet), p); await tick()
    return p.replies.filter((r) => /已排队/.test(r))
  }
  assert.deepEqual(await mk(true), [], 'quiet 插话不该发排队提示')
  assert.ok((await mk(false)).length > 0, '对照组:非 quiet 排队时必须提示 —— 否则上面的"零"证明不了什么')
})

test('engine: quiet 轮在全局并发满时不发排队提示', async () => {
  // 与上一条不同的口子:那条是群锁,这条是全局信号量(_runTurn 里,acquire 之前)。
  const mk = async (quiet) => {
    const cfg = baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 1, maxTurnTimeMins: 0 },
      groups: { G: { workdir: '/proj', provider: 'claude', allowedTools: ['Read'] }, H: { workdir: '/p2', provider: 'claude', allowedTools: ['Read'] } } })
    const busy = mkCardPlatform(), p = mkCardPlatform()
    const e = new Engine(cfg, { runner: slowRunner(150, { text: 'done' }), store: mkStore() })
    e.handleMessage(mkMsg('别的群占住并发', undefined, 'H'), busy); await tick()
    const m = Object.assign(mkMsg('顺手改个文档'), { synthetic: true, quiet })
    await e.handleMessage(m, p); await tick()
    return p.replies.filter((r) => /已排队/.test(r))
  }
  assert.deepEqual(await mk(true), [], 'quiet 插话不该发「有其它任务在跑」')
  assert.ok((await mk(false)).length > 0, '对照组:非 quiet 并发满时必须提示')
})

test('engine: quiet 轮里 runner 抛异常,报错也不进群', async () => {
  // ⚠ 与已有的「isError 不进群」不是同一条路:那条走 finalizeTurn,这条走 _runTurn 的 catch,
  //   catch 里 `if (card) … else reply(…)` —— quiet 没有卡,直接落到 reply。承诺原先只对前者成立。
  const boom = okRunner(async () => { throw new Error('spawn ENOENT') })
  const q = mkCardPlatform()
  await new Engine(baseCfg(), { runner: boom, store: mkStore() }).handleMessage(mkQuietMsg('干活', true), q); await tick()
  const n = mkCardPlatform()
  await new Engine(baseCfg(), { runner: boom, store: mkStore() }).handleMessage(mkQuietMsg('干活', false), n); await tick()
  assert.ok(n.replies.some((r) => /ENOENT/.test(r)), '对照组:非 quiet 的崩溃必须出声')
  assert.deepEqual(q.replies, [], 'quiet 轮不该有崩溃报错进群')
})

test('engine: quiet 轮 provider 未配置,报错也不进群', async () => {
  // 前置校验在 reply 定义之后、轮次开始之前 —— quiet 变量必须早于 reply 求值,否则这条会红。
  const mk = async (quiet) => {
    const cfg = baseCfg({ providers: {}, groups: { G: { workdir: '/proj', provider: 'nope', allowedTools: ['Read'] } } })
    const p = mkCardPlatform()
    await new Engine(cfg, { runner: okRunner(async () => ({})), store: mkStore() }).handleMessage(mkQuietMsg('干活', quiet), p); await tick()
    return p.replies
  }
  assert.deepEqual(await mk(true), [], 'quiet 轮不该有「模型未配置」进群')
  assert.ok((await mk(false)).length > 0, '对照组:非 quiet 必须报未配置')
})

test('engine: quiet 轮触发会话压缩,通知也不进群', async () => {
  const run = okRunner(async ({ onEvent }) => { onEvent({ type: 'system', subtype: 'compact_boundary' }); return { sessionId: 's', result: { text: 'ok' } } })
  const mk = async (quiet) => {
    const p = mkCardPlatform()
    await new Engine(baseCfg(), { runner: run, store: mkStore() }).handleMessage(mkQuietMsg('干活', quiet), p); await tick()
    return p.replies.filter((r) => /压缩/.test(r))
  }
  assert.deepEqual(await mk(true), [], 'quiet 轮不该有压缩通知进群')
  assert.ok((await mk(false)).length > 0, '对照组:非 quiet 压缩时必须说一声')
})

// ── 排队合并不许把 quiet 与非 quiet 混进同一轮(v0.11.42 修) ──────────────────
// _coalesce 取 `{...last}` ⇒ quiet 跟着**代表消息(末条)**走,哪个方向出错纯看谁最后到。
// 让每轮的答案报出它处理了哪几条,否则「真人有没有被回应」根本判不了。
const echoRunner = (firstDelayMs) => {
  let n = 0
  return okRunner(async ({ prompt }) => {
    if (++n === 1) await wait(firstDelayMs)
    const tags = ['占锁', '真人问题', '后台维护'].filter((t) => prompt.includes(t))
    return { sessionId: 's', result: { text: '答复<' + tags.join('+') + '>' } }
  })
}

test('engine: quiet 插话排在真人消息后面,不许把真人那条一起静音', async () => {
  // ⚠ 这是本项目最贵的一类 bug:真人问了,轮次真的跑了,答案被一起压掉 ⇒ 他永远等不到回答。
  const p = mkCardPlatform()
  const e = new Engine(baseCfg(), { runner: echoRunner(150), store: mkStore() })
  e.handleMessage(mkMsg('占锁'), p); await tick()
  e.handleMessage(mkMsg('真人问题'), p)
  e.handleMessage(mkQuietMsg('后台维护', true), p)
  await wait(400)
  assert.ok(p.replies.some((r) => /答复<.*真人问题/.test(r)), '真人那条必须收到回答')
})

test('engine: quiet 插话排在真人消息前面,它的产出不许被广播', async () => {
  const p = mkCardPlatform()
  const e = new Engine(baseCfg(), { runner: echoRunner(150), store: mkStore() })
  e.handleMessage(mkMsg('占锁'), p); await tick()
  e.handleMessage(mkQuietMsg('后台维护', true), p)
  e.handleMessage(mkMsg('真人问题'), p)
  await wait(400)
  assert.ok(p.replies.some((r) => /答复<.*真人问题/.test(r)), '真人那条仍要收到回答(对照:证明这批真的跑了)')
  assert.ok(!p.replies.some((r) => /后台维护/.test(r)), 'quiet 那条的内容不该出现在群里的答复里')
})

test('engine: quiet 插话写成 slash 命令时,回执也不进群(命令照常执行)', async () => {
  // 插话框里打 /new 也会走命令处理器,那里另有一个 reply —— 与 _runTurn 那道闸是两个出口。
  const mk = async (quiet) => {
    const p = mkCardPlatform(), store = mkStore()
    store.setSession('G', 'old-session')
    await new Engine(baseCfg(), { runner: okRunner(), store }).handleMessage(mkQuietMsg('/new', quiet), p); await tick()
    return { replies: p.replies, session: store.getSession('G') }
  }
  const q = await mk(true)
  assert.deepEqual(q.replies, [], 'quiet 时命令回执不该进群')
  assert.equal(q.session, null, '⚠ 但命令本身照常执行 —— 不出声不等于不干活')
  assert.ok((await mk(false)).replies.length > 0, '对照组:非 quiet 的命令必须有回执')
})

test('engine: quiet 轮在未绑定群里不出声,且不吃掉给真人的那句一次性引导', async () => {
  // ⚠ 「一次性」的东西被 quiet 轮消耗掉,就不是「这次不留痕」而是把别人的提示吃了。
  const cfg = baseCfg({ groups: {} })
  const e = new Engine(cfg, { runner: okRunner(), store: mkStore() })
  const p = mkCardPlatform()
  await e.handleMessage(mkQuietMsg('干活', true), p); await tick()
  assert.deepEqual(p.replies, [], 'quiet 轮不该在未绑定群里出声')
  await e.handleMessage(mkMsg('真人来了'), p); await tick()
  assert.ok(p.replies.some((r) => /没有绑定项目/.test(r)), '真人仍要拿到那句引导 —— 名额没被 quiet 轮吃掉')
})

test('engine: quiet 轮撞上内部错误也不出声(对照组证明这条路真的会出声)', async () => {
  // ⚠ 第一版这条测试是假的:拿 store.setWatermark 抛错去逼 catch,而**合成消息根本不推水位线**
  //   (v0.11.12 起整块在 `if (!msg.synthetic)` 里)⇒ 那一版拆掉闸门照样全绿,变异检验才抓出来。
  //   改成直接让 _resolveGroup 抛 —— 它在 try 里、且对合成消息一样会走到。
  const mk = async (quiet) => {
    const p = mkCardPlatform()
    const e = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() })
    e._resolveGroup = () => { throw new Error('boom') }
    await e.handleMessage(mkQuietMsg('干活', quiet), p); await tick()
    return p.replies
  }
  assert.deepEqual(await mk(true), [], 'quiet 轮不该有内部错误进群')
  assert.ok((await mk(false)).length > 0, '对照组:非 quiet 必须报内部错误')
})

test('engine: 排队提示的条数不把看不见的插话数进去', async () => {
  // 群成员看到「与前面 2 条一并处理」却一条也没见过 = 把「群里无痕」漏了出去。
  const p = mkCardPlatform()
  const e = new Engine(baseCfg(), { runner: slowRunner(150, { text: 'done' }), store: mkStore() })
  e.handleMessage(mkMsg('占住群锁'), p); await tick()
  e.handleMessage(mkQuietMsg('看不见的插话一', true), p)
  e.handleMessage(mkQuietMsg('看不见的插话二', true), p)
  await e.handleMessage(mkMsg('真人的消息'), p); await tick()
  const q = p.replies.filter((r) => /已排队/.test(r))
  assert.equal(q.length, 1, '只有真人那条该收到排队提示')
  assert.ok(!/前面/.test(q[0]), `不该报出前面还有几条(拿到的是:${q[0]})`)
})

// ── /stop 与 /skip:差别只在队列上(v0.11.46) ──────────────────────────────────
// 口径(2026-08-21 用户定):/stop = 全都别做了(当前 + 排队一起取消,保会话)· /skip = 只放弃
// 当前这一件,排队的接着做 · /new = 全都别做了 + 开新会话。
// 由来:DemoApp 群一轮跑了 42 分钟没动静,群里想「停这个、让它继续后面的」,而当时只有 /stop。
const stopCfg = (stopWaitMs) => baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 4, maxTurnTimeMins: 0, ackDelayMs: 0, stopWaitMs, hardReleaseMs: 100000 } })

// ⚠ 第二轮必须**理会 abort 信号**:不理它的话被强杀了也照样返回 ok,判据没有分辨力
//   (「没被杀」和「被杀了但我不认」输出一模一样 —— 第一版复现就栽在这儿)。
const twoTurnRunner = () => {
  let n = 0
  return okRunner(async ({ signal }) => {
    if (++n === 1) { await new Promise((r) => signal.addEventListener('abort', r, { once: true })); return { sessionId: 's', result: { text: '一号' } } }
    let killed = false
    await new Promise((r) => { const tm = setTimeout(r, 900); signal.addEventListener('abort', () => { killed = true; clearTimeout(tm); r() }, { once: true }) })
    if (killed) throw new Error('二号被殃及')
    return { sessionId: 's', result: { text: '二号跑完了' } }
  })
}

test('engine: /skip 只放弃当前轮,排队的照常跑完', async () => {
  // ⭐ 这条钉的是轮次身份守卫:等待循环若认 `rt.busy`(群忙不忙)而不是「我那轮停了没」,
  //   前一轮 release 会立刻把继任者派出去 ⇒ rt.busy 又是 true ⇒ 等到 stopWaitMs 把继任者强杀。
  //   2026-08-21 DemoApp 真机就是这么丢掉三条排队中的真人消息的。
  const done = []
  const e = new Engine(stopCfg(400), { runner: twoTurnRunner(), store: mkStore(), onActivity: (a) => { if (a.kind === 'done') done.push(a) } })
  const p = mkCardPlatform()
  e.handleMessage(mkMsg('一号:正在跑'), p); await tick()
  e.handleMessage(mkMsg('二号:排队中'), p); await tick()
  await e.handleMessage(mkMsg('/skip'), p)
  await wait(1600)
  assert.equal(done.length, 2, '两轮都该有结算')
  assert.equal(done[1].status, 'ok', `继任轮必须跑完(拿到 ${done[1] && done[1].status} / ${done[1] && done[1].ms}ms)`)
  assert.ok(p.replies.some((r) => /已跳过当前任务 — 接着做排队的 1 条/.test(r)), '要如实报出后面还有几条')
  assert.equal(p.replies.filter((r) => /已停止/.test(r)).length, 0, '/skip 不该说「已停止」')
})

test('engine: /stop 连排队的一起取消,并如实报出丢了几条', async () => {
  const done = []
  const e = new Engine(stopCfg(400), { runner: twoTurnRunner(), store: mkStore(), onActivity: (a) => { if (a.kind === 'done') done.push(a) } })
  const p = mkCardPlatform()
  e.handleMessage(mkMsg('一号:正在跑'), p); await tick()
  e.handleMessage(mkMsg('二号:排队中'), p); await tick()
  await e.handleMessage(mkMsg('/stop'), p)
  await wait(1600)
  assert.equal(done.length, 1, '排队那条不该再跑 —— 它已被取消')
  assert.ok(p.replies.some((r) => /已停止 — 连同排队的 1 条一并取消/.test(r)),
    `丢了几条必须说出来,否则发过消息的人会等一个永远不来的回应(拿到:${JSON.stringify(p.replies)})`)
})

test('engine: 队列为空时 /stop 与 /skip 各自的说法', async () => {
  const mk = async (cmd) => {
    const e = new Engine(stopCfg(300), { runner: okRunner(async ({ signal }) => { await new Promise((r) => signal.addEventListener('abort', r, { once: true })); return { sessionId: 's', result: { text: 'x' } } }), store: mkStore() })
    const p = mkCardPlatform()
    e.handleMessage(mkMsg('在跑'), p); await tick()
    await e.handleMessage(mkMsg(cmd), p)
    return p.replies.join(' | ')
  }
  assert.match(await mk('/stop'), /已停止(?! —)/, '没有排队时不该多出「连同排队的 0 条」')
  assert.match(await mk('/skip'), /已跳过当前任务\(后面没有排队的了\)/, '没有排队时要说清后面没有了')
})

test('engine: /stop 对赖着不走的当前轮仍然强制停(守卫不能把这条修坏)', async () => {
  // 守卫加错会把 forceRelease 一并废掉 ⇒ 挂死进程再也停不下来,那是把「保证兑现」退回「尽力而为」。
  const e = new Engine(stopCfg(300), { runner: okRunner(async () => { await wait(5000); return { sessionId: 's', result: { text: '赖着' } } }), store: mkStore() })
  const p = mkCardPlatform()
  e.handleMessage(mkMsg('挂死的一轮'), p); await tick()
  const t0 = Date.now()
  await e.handleMessage(mkMsg('/stop'), p)
  assert.ok(Date.now() - t0 < 2000, '/stop 必须在等待窗内返回,不能干等到轮次自己结束')
  const gs = e.liveState().groups
  assert.equal(gs[Object.keys(gs)[0]].busy, false, '群锁必须已被强制释放')
})

// ── /status 要说得出「它还在动吗」(v0.11.46) ────────────────────────────────
test('engine: /status 报出已跑多久 · 已执行几步 · 最近动静', async () => {
  // ⭐ 判据是「最近动静」不是「已跑多久」:跑了很久 ≠ 卡住了,能分开两者的只有前者。
  let release
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', tools: [{ name: 'Bash' }, { name: 'Read' }] })
    onEvent({ type: 'assistant', tools: [{ name: 'Bash' }] })
    await new Promise((r) => { release = r })
    return { sessionId: 's', result: { text: '好了' } }
  })
  const e = new Engine(baseCfg(), { runner, store: mkStore() })
  const p = mkCardPlatform()
  e.handleMessage(mkMsg('长任务'), p); await tick()
  await e.handleMessage(mkMsg('/status'), p)
  const st = p.replies.find((r) => /本群状态/.test(r))
  assert.match(st, /运行中.{0,2}已跑 \d+ 秒/, '要说已跑多久')
  assert.match(st, /已执行 3 步/, '要说执行了几步(2 + 1 次工具)')
  assert.match(st, /最近动静 \d+ 秒前/, '要说最近一次动静距今多久 —— 这才是「卡没卡住」的判据')
  release(); await tick()
  await e.handleMessage(mkMsg('/status'), p)
  assert.match(p.replies.filter((r) => /本群状态/.test(r)).pop(), /状态:空闲/, '跑完后回到空闲,不留上一轮的读数')
})

test('engine: 下一轮的 /status 不带上一轮的步数', async () => {
  // ⚠ 第一版这条是假的:只在**空闲**时断言,而空闲分支压根不打印步数 ——「不清零」这个变异
  //   照样全绿(变异检验抓出来的)。真判据必须是**第二轮正在跑时**的读数。
  let n = 0, release
  const runner = okRunner(async ({ onEvent }) => {
    if (++n === 1) { onEvent({ type: 'assistant', tools: [{ name: 'Bash' }, { name: 'Read' }] }); return { sessionId: 's', result: { text: '一轮完' } } }
    onEvent({ type: 'assistant', tools: [{ name: 'Bash' }] })
    await new Promise((r) => { release = r })
    return { sessionId: 's', result: { text: '二轮完' } }
  })
  const e = new Engine(baseCfg(), { runner, store: mkStore() })
  const p = mkCardPlatform()
  await e.handleMessage(mkMsg('第一轮:两步'), p); await tick()
  e.handleMessage(mkMsg('第二轮:一步'), p); await tick()
  await e.handleMessage(mkMsg('/status'), p)
  const st = p.replies.filter((r) => /本群状态/.test(r)).pop()
  assert.match(st, /已执行 1 步/, `第二轮只该报自己的 1 步,不能把上一轮的 2 步带进来(拿到:${st})`)
  release(); await tick()
})

// ── /help 要讲清三条命令对「排队任务」的不同(v0.11.46) ──────────────────────
test('engine: /help 说清 /stop 与 /new 对排队任务的区别,并提醒命令单独发', async () => {
  // 这三句缺一条,2026-08-21 那场误解就还会再发生一次(有人要「停这个继续后面的」,
  // 有人以为 /stop 会连队列一起停,最后跑来提需求「加个跳过当前任务的命令」)。
  const e = new Engine(baseCfg(), { runner: okRunner(), store: mkStore() })
  const p = mkCardPlatform()
  await e.handleMessage(mkMsg('/help'), p)
  const h = p.replies[0]
  // ⚠ 判据是**纪律**不是措辞:三条描述同两个维度(排队的怎么办 · 记不记得之前),
  //   且同一维度必须用**同一个词** —— 上一版 /new 写「不记得之前聊过什么」而 /stop 写「会话保留」,
  //   同一件事两套说法,群成员得自己翻译。按词钉死而不按整句钉死,措辞收紧时这条不会假红。
  const line = (c) => (h.split('\n').find((l) => l.startsWith('· ' + c + ' —')) || '')
  assert.match(line('/skip'), /排队的继续/, '/skip:排队的继续')
  assert.match(line('/stop'), /全取消/, '/stop:排队的一并取消')
  for (const c of ['/skip', '/stop']) assert.match(line(c), /还记得/, c + ' 要用与另一条**同一个词**说「记得之前」')
  assert.match(line('/new'), /忘掉/, '/new:忘掉之前')
  assert.doesNotMatch(line('/new'), /还记得/, '/new 不该说记得')
  assert.ok(h.indexOf('/skip') < h.indexOf('/stop') && h.indexOf('/stop') < h.indexOf('/new'),
    '三条叫停按破坏性递增排:/skip → /stop → /new')
  assert.match(line('/status'), /还有没有动静/, '/status 要写成「能不能看出卡没卡住」,不是字段列表')
  assert.match(h, /^⚠ 命令单独发一条/m, '这句要用 ⚠ 起头,不能长得和命令条目一样')
  assert.ok(!/^· 命令/m.test(h), '不能写成「· 命令…」—— 会被当成第八个命令')
})

// ── 群面的排队数字一律不许数进 quiet 插话(v0.11.46 复核阶段补齐) ─────────────────
// 本版早先只修了排队提示那一处;随后新增的 /stop 丢弃数、/skip 待办数又各漏一次,
// /status 的排队行则一直漏着。⇒ 收成 _visibleQueue 一个出口,这里把四处一起钉住。
const withQuietQueued = async (cmd) => {
  const p = mkCardPlatform()
  const e = new Engine(baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 4, maxTurnTimeMins: 0, ackDelayMs: 0, stopWaitMs: 300, hardReleaseMs: 100000 } }),
    { runner: okRunner(async ({ signal }) => { await new Promise((r) => { const tm = setTimeout(r, 1200); signal.addEventListener('abort', () => { clearTimeout(tm); r() }, { once: true }) }); return { sessionId: 's', result: { text: 'x' } } }), store: mkStore() })
  e.handleMessage(mkMsg('占住群锁'), p); await tick()
  e.handleMessage(mkQuietMsg('看不见的插话一', true), p)
  e.handleMessage(mkQuietMsg('看不见的插话二', true), p)
  e.handleMessage(mkMsg('真人排队的一条'), p); await tick()
  await e.handleMessage(mkMsg(cmd), p)
  return p.replies
}

test('engine: /status 的排队数不把 quiet 插话数进去', async () => {
  const st = (await withQuietQueued('/status')).filter((r) => /本群状态/.test(r)).pop()
  assert.match(st, /· 排队:1/, `队里 3 条但只有 1 条群里看得见(拿到:${st})`)
})

test('engine: /stop 报的丢弃数只算群里看得见的', async () => {
  const rs = await withQuietQueued('/stop')
  assert.ok(rs.some((r) => /已停止 — 连同排队的 1 条一并取消/.test(r)),
    `不能报 3 条 —— 群成员只见过 1 条(拿到:${JSON.stringify(rs.filter((r) => /已停止/.test(r)))})`)
})

test('engine: /skip 报的待办数只算群里看得见的', async () => {
  const rs = await withQuietQueued('/skip')
  assert.ok(rs.some((r) => /已跳过当前任务 — 接着做排队的 1 条/.test(r)),
    `不能报 3 条(拿到:${JSON.stringify(rs.filter((r) => /已跳过/.test(r)))})`)
})

// ── 被取消的请求,下一轮不许自己捡回去做(产品决定 2026-08-21) ────────────────
// 实证:/skip 掉一个 sleep 90 的长任务后,继任轮产出「长任务完成 排队甲 排队乙」、
// 耗时 149s —— 那 90 秒又跑了一遍。根因不在引擎在会话:被取消的那条仍在历史里且没答过,
// --resume 接上去模型自然当成待办。⇒ 引擎知道「哪一条被取消了」,把这个事实说给它听。
const cancelCfg = () => baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 4, maxTurnTimeMins: 0, ackDelayMs: 0, stopWaitMs: 300, hardReleaseMs: 100000 } })
// 第一轮挂着等 abort,第二轮把拿到的 prompt 交出来
const promptCatcher = () => {
  const got = []
  let n = 0
  const runner = okRunner(async ({ prompt, signal }) => {
    if (++n === 1) { await new Promise((r) => signal.addEventListener('abort', r, { once: true })); return { sessionId: 's', result: { text: '一号' } } }
    got.push(prompt)
    return { sessionId: 's', result: { text: '二号' } }
  })
  return { runner, got }
}

test('engine: /skip 之后,下一轮的提示里写明「上一条已取消,别继续做」', async () => {
  const { runner, got } = promptCatcher()
  const e = new Engine(cancelCfg(), { runner, store: mkStore() })
  const p = mkCardPlatform()
  e.handleMessage(mkMsg('跑个很久的活:线索卡功能'), p); await tick()
  e.handleMessage(mkMsg('顺便回一句 甲'), p); await tick()
  await e.handleMessage(mkMsg('/skip'), p); await wait(700)
  assert.equal(got.length, 1, '继任轮要跑起来,否则下面断言无意义')
  assert.match(got[0], /上一条请求已被「\/skip」取消/, `要点名是被什么取消的(拿到:${got[0].slice(0, 160)})`)
  assert.match(got[0], /线索卡功能/, '要带上被取消那条的内容,否则它不知道指的是哪件')
  assert.match(got[0], /默认不要继续做它/, '要说死默认行为')
  assert.match(got[0], /除非下面这条明确要求你继续/, '⚠ 必须留口子:取消后紧接着说「继续」是常见的')
  assert.ok(got[0].indexOf('系统提示') < got[0].indexOf('顺便回一句 甲'), '提示要排在本轮消息之前')
})

test('engine: 这个提示是一次性的,再下一轮不再出现', async () => {
  const got = []
  let n = 0
  const runner = okRunner(async ({ prompt, signal }) => {
    if (++n === 1) { await new Promise((r) => signal.addEventListener('abort', r, { once: true })); return { sessionId: 's', result: { text: '一号' } } }
    got.push(prompt)
    return { sessionId: 's', result: { text: 'ok' } }
  })
  const e = new Engine(cancelCfg(), { runner, store: mkStore() })
  const p = mkCardPlatform()
  e.handleMessage(mkMsg('要被取消的活'), p); await tick()
  await e.handleMessage(mkMsg('/skip'), p); await wait(500)
  await e.handleMessage(mkMsg('第二条真人消息'), p); await wait(300)
  await e.handleMessage(mkMsg('第三条真人消息'), p); await wait(300)
  assert.equal(got.length, 2, '两轮都该跑')
  assert.match(got[0], /上一条请求已被/, '紧接着那一轮要带提示')
  assert.ok(!/上一条请求已被/.test(got[1]), `再下一轮不该还带着(拿到:${got[1].slice(0, 120)})`)
})

test('engine: /stop 与撤回也打这个标记,/new 不打', async () => {
  const mk = async (how) => {
    const { runner, got } = promptCatcher()
    const e = new Engine(cancelCfg(), { runner, store: mkStore() })
    const p = mkCardPlatform()
    const first = mkMsg('要被取消的活')
    e.handleMessage(first, p); await tick()
    if (how === 'recall') e.handleRecall({ chatId: 'G', msgId: first.msgId })
    else await e.handleMessage(mkMsg(how), p)
    await wait(500)
    await e.handleMessage(mkMsg('随后一条'), p); await wait(400)
    return got[0] || ''
  }
  assert.match(await mk('/stop'), /上一条请求已被「\/stop」取消/)
  assert.match(await mk('recall'), /上一条请求已被「发送者撤回了消息」取消/)
  // /new 清了会话 ⇒ 没有历史可捡,再提「上一条」只会让新会话首轮收到一句莫名其妙的话
  assert.ok(!/上一条请求已被/.test(await mk('/new')), '/new 不该打这个标记')
})

test('engine: 墙钟超时不算「取消」—— 那件事是想做的,只是超时了', async () => {
  // ⚠ 判据宁漏不误:把超时也标成取消,等于让它把没做完的正事丢掉。
  const got = []
  let n = 0
  const runner = okRunner(async ({ prompt, signal }) => {
    if (++n === 1) { await new Promise((r) => signal.addEventListener('abort', r, { once: true })); return { sessionId: 's', result: { text: '超时了' } } }
    got.push(prompt)
    return { sessionId: 's', result: { text: 'ok' } }
  })
  const cfg = baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 4, maxTurnTimeMins: 0.004, ackDelayMs: 0, hardReleaseMs: 100000 } }) // ≈0.24s
  const e = new Engine(cfg, { runner, store: mkStore() })
  const p = mkCardPlatform()
  e.handleMessage(mkMsg('慢活'), p); await wait(600)
  await e.handleMessage(mkMsg('随后一条'), p); await wait(400)
  assert.equal(got.length, 1, '第二轮要跑起来')
  assert.ok(!/上一条请求已被/.test(got[0]), `超时不该被当成取消(拿到:${got[0].slice(0, 120)})`)
})

// ── 长任务的卡片活体征(v0.11.47) ───────────────────────────────────────────
// 2026-08-21 DemoApp 实测:一轮 1508s / 40 次工具 / 正文 877 字 ⇒ 卡原地停在「已收到,正在
// 处理…」半小时,群里读起来就是「卡死了」——那次事故正是这么误判掐掉一个要交付的任务的。
// ⚠ 测试把 PULSE_MS 当黑箱:不改常量,而是**验三条不变量**,免得写成钉死 120000 的假测试。
const pulseCfg = (ms) => baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, ackDelayMs: 0, cardPulseMs: ms } })

test('engine: 长任务只调工具不说话时,卡里会滚动出「已跑多久 · 最近动静」', async () => {
  // ⭐ 这条才是正面判据 —— 上面两条只验「不该做什么」,脉搏压根不触发时它们照样绿。
  const p = mkCardPlatform()
  const run = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '我先看看代码' })   // 有一段文字 ⇒ 卡被建出来
    onEvent({ type: 'assistant', tools: [{ name: 'Bash' }] })
    // 之后长时间只有工具、不说话。⚠ 窗口要比 2 帧宽得多:脉搏的闸是「距上次碰卡满 cardPulseMs」,而碰卡时刻取的是
    //   回调真正执行的那一刻 —— 回调一晚,下一跳量出来就差 1ms 不到间隔、被闸掉。原先 420ms 只有 3 跳、刚好够 2 帧,
    //   CI 慢机器(Node 24,2026-10-20)一跳被闸就只剩 1 帧而红。900ms 有 7 跳,隔一跳闸一次也有 3 帧。
    await wait(900)
    return { sessionId: 's', result: { text: '做完了' } }
  })
  await new Engine(pulseCfg(120), { runner: run, store: mkStore() }).handleMessage(mkMsg('长任务'), p); await tick()
  const card = p.cards[0]
  assert.ok(card, '要有卡')
  const pulses = card.updates.filter((u) => /⏳ (处理中 · )?已跑/.test(u))
  assert.ok(pulses.length >= 2, `不说话期间应当滚动多次(拿到 ${pulses.length} 次:${JSON.stringify(card.updates)})`)
  // v0.11.95 瘦成一行(产品决定):已跑多久 + 最近在做;步数不上卡(与「最近在做」重复);动静新鲜时不提
  assert.match(pulses[pulses.length - 1], /^⏳ 已跑 \d+ 秒 · 最近在做:跑命令$/m, '一行:已跑 + 最近在做')
  assert.doesNotMatch(pulses[pulses.length - 1], /已执行|最近动静/, '步数与新鲜的动静都不上卡')
  assert.match(pulses[0], /我先看看代码/, '已经说过的话要保留,不能被脉搏冲掉')
  assert.ok(!/⏳ (处理中 · )?已跑/.test(String(card.finished)), '最终态不许留下脉搏行')
})

test('engine: 脉搏只在停滞超过阈值时才提「最近动静」;还没调过工具时退回「处理中 · 已跑」', async () => {
  // 停滞阈值做成可配(cardPulseStaleMs),否则单测只能靠等两分钟
  const mk = (staleMs) => baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, ackDelayMs: 0, cardPulseMs: 100, cardPulseStaleMs: staleMs } })
  const run = () => okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '看一下' })
    onEvent({ type: 'assistant', tools: [{ name: 'Bash' }] })
    await wait(800) // 之后一直没动静
    return { sessionId: 's', result: { text: '好了' } }
  })
  const p = mkCardPlatform()
  // ⚠ 时序用例:脉搏 100ms 一帧、停滞阈值 400ms ⇒ 首帧离阈值有 300ms 余量。原先阈值 200ms 只留 100ms,
  //   CI 慢机器(Node 22,2026-09-14)首帧就晚过阈值、打出「最近动静 0 秒前」而红;本机 5 连跑全绿。
  await new Engine(mk(400), { runner: run(), store: mkStore() }).handleMessage(mkMsg('长活'), p); await tick()
  const pulses = p.cards[0].updates.filter((u) => /⏳ /.test(u))
  assert.ok(pulses.length >= 3, `要有多帧(拿到 ${pulses.length})`)
  // 钉的是形状:先有不提的帧、之后才出现提的帧、一旦提就每帧都提(停滞只会越来越久)
  const firstStale = pulses.findIndex((u) => /最近动静/.test(u))
  assert.ok(firstStale > 0, `刚动过的那几帧不提,停滞后才提(首个带提醒的帧序号 ${firstStale});帧:${JSON.stringify(pulses)}`)
  assert.ok(pulses.slice(firstStale).every((u) => /· 最近动静 \d+ 秒前$/m.test(u)), '停滞超过阈值:之后每帧都追加提醒')
  // 对照组:阈值够远 ⇒ 全程不提
  const p2 = mkCardPlatform()
  await new Engine(mk(60_000), { runner: run(), store: mkStore() }).handleMessage(mkMsg('长活'), p2); await tick()
  assert.ok(!p2.cards[0].updates.some((u) => /最近动静/.test(u)), '阈值够远就一次都不提')
  // 还没调过任何工具:没有「最近在做」可说 ⇒ 退回「处理中 · 已跑」
  const p3 = mkCardPlatform()
  await new Engine(mk(60_000), { runner: okRunner(async ({ onEvent }) => { onEvent({ type: 'assistant', text: '想想' }); await wait(300); return { sessionId: 's', result: { text: '好' } } }), store: mkStore() }).handleMessage(mkMsg('活'), p3); await tick()
  assert.ok(p3.cards[0].updates.some((u) => /^⏳ 处理中 · 已跑 \d+ 秒$/m.test(u)), JSON.stringify(p3.cards[0].updates))
})

test('engine: cardPulseMs=0 ⇒ 关掉脉搏(operator 可按飞书配额自行取舍)', async () => {
  const p = mkCardPlatform()
  const run = okRunner(async ({ onEvent }) => { onEvent({ type: 'assistant', text: '在干活' }); await wait(400); return { sessionId: 's', result: { text: '好了' } } })
  await new Engine(pulseCfg(0), { runner: run, store: mkStore() }).handleMessage(mkMsg('长任务'), p); await tick()
  assert.equal(p.cards[0].updates.filter((u) => /⏳ (处理中 · )?已跑/.test(u)).length, 0, '关掉后不该有脉搏')
})

test('engine: 脉搏绝不会自己建卡(静默轮/quiet 轮不留痕的底线)', async () => {
  // ⭐ 这条比「脉搏好不好看」重要得多:建了卡,NO_REPLY 与 quiet 两个承诺当场破掉。
  // ⚠ 第一版写成了空测试:用默认 120s 间隔跑一个 300ms 的轮次,**脉搏根本没机会跳** ——
  //   拆掉建卡守卫照样全绿(变异检验抓出来的)。必须把间隔调小到脉搏真会跳,断言才有分辨力。
  const run = okRunner(async () => { await wait(320); return { sessionId: 's', result: { text: NO_REPLY } } })
  const p = mkCardPlatform()
  await new Engine(pulseCfg(60), { runner: run, store: mkStore() }).handleMessage(mkMsg('静默轮'), p); await tick()
  assert.equal(p.cards.length, 0, '静默轮不该有卡 —— 期间脉搏至少有 5 次机会去建它')
  const q = mkCardPlatform()
  await new Engine(pulseCfg(60), { runner: okRunner(async () => { await wait(320); return { sessionId: 's', result: { text: '做完' } } }), store: mkStore() })
    .handleMessage(mkQuietMsg('无痕插话', true), q); await tick()
  assert.equal(q.cards.length, 0, 'quiet 轮不该有卡')
})

// ── 压缩后提醒下一轮别凭记忆接着做(v0.11.47) ────────────────────────────────
test('engine: 压缩过一次 ⇒ 下一轮 prompt 里提醒先确认状态,且只提醒一次', async () => {
  // ⚠ 与「重发自知清单」是两件事:清单管规矩(v0.11.34),这条管**任务进度**。
  // ⚠ 引擎救不了当前那一轮 —— 压缩发生在轮次进行中,prompt 早发出去了;只能管下一轮。
  const got = []
  let n = 0
  const runner = okRunner(async ({ prompt, onEvent }) => {
    n++
    got.push(prompt)
    if (n === 1) onEvent({ type: 'system', subtype: 'compact_boundary' })
    return { sessionId: 's', result: { text: 'ok' } }
  })
  const e = new Engine(baseCfg(), { runner, store: mkStore() })
  const p = mkCardPlatform()
  await e.handleMessage(mkMsg('第一轮:期间压缩'), p); await tick()
  await e.handleMessage(mkMsg('第二轮'), p); await tick()
  await e.handleMessage(mkMsg('第三轮'), p); await tick()
  assert.equal(got.length, 3)
  assert.ok(!/上下文自动压缩/.test(got[0]), '压缩发生在第一轮进行中,补不进它自己的 prompt')
  assert.match(got[1], /上下文自动压缩/, '紧接着那一轮要提醒')
  assert.match(got[1], /动手前先自己确认一遍当前状态/, '要给可照做的动作,不是「你忘了什么」')
  assert.ok(!/上下文自动压缩/.test(got[2]), '一次性 —— 再下一轮不该还带着')
})

test('engine: /new 之后不再提醒压缩(新会话没有「刚压缩过」这回事)', async () => {
  const got = []
  let n = 0
  const runner = okRunner(async ({ prompt, onEvent }) => {
    got.push(prompt)
    if (++n === 1) onEvent({ type: 'system', subtype: 'compact_boundary' })
    return { sessionId: 's', result: { text: 'ok' } }
  })
  const e = new Engine(baseCfg(), { runner, store: mkStore() })
  const p = mkCardPlatform()
  await e.handleMessage(mkMsg('第一轮:期间压缩'), p); await tick()
  await e.handleMessage(mkMsg('/new'), p); await tick()
  await e.handleMessage(mkMsg('新会话首轮'), p); await tick()
  assert.equal(got.length, 2)
  assert.ok(!/上下文自动压缩/.test(got[1]), `新会话首轮不该带压缩提醒(拿到:${got[1].slice(0, 100)})`)
})

test('engine: 脉搏报的步数是本轮的,不许把下一轮的读进旧卡', async () => {
  // ⚠ 第一版只跑一轮 ⇒ 守卫拆不拆都一样,是空测试(变异检验抓出来的)。真判据必须造出
  //   「旧轮挂死、interval 还活着,而 rt.steps 已属于新一轮」这个场景:
  //   一号**不理 abort**(模拟挂死进程)⇒ /skip 强制释放锁、二号开跑,而一号的 finally 从未跑到。
  const p = mkCardPlatform()
  let release1
  let n = 0
  const runner = okRunner(async ({ onEvent }) => {
    if (++n === 1) {
      onEvent({ type: 'assistant', text: '一号开工' })          // 建卡
      onEvent({ type: 'assistant', tools: [{ name: 'Bash' }, { name: 'Bash' }] }) // 一号 2 步
      await new Promise((r) => { release1 = r })                // 挂死:不理 abort
      return { sessionId: 's', result: { text: '一号' } }
    }
    onEvent({ type: 'assistant', tools: Array.from({ length: 9 }, () => ({ name: 'Bash' })) }) // 二号 9 步
    await wait(220)
    return { sessionId: 's', result: { text: '二号' } }
  })
  const e = new Engine(baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 4, maxTurnTimeMins: 0, ackDelayMs: 0, cardPulseMs: 50, stopWaitMs: 120, hardReleaseMs: 100000 } }),
    { runner, store: mkStore() })
  e.handleMessage(mkMsg('一号:会挂死'), p); await tick()
  e.handleMessage(mkMsg('二号:排队中'), p); await tick()
  await e.handleMessage(mkMsg('/skip'), p)   // 强制释放一号的锁 ⇒ 二号开跑,一号的 interval 还活着
  await wait(260)
  const card1 = p.cards[0]
  const pulses = card1.updates.filter((u) => /⏳ (处理中 · )?已跑/.test(u))
  const leaked = pulses.filter((u) => /已执行 9 步/.test(u))
  assert.equal(leaked.length, 0, `一号的卡上浮现了二号的 9 步 —— 轮次身份守卫失效(拿到:${JSON.stringify(pulses.slice(-2))})`)
  if (release1) release1()
})

test('engine: 脉搏不许把 NO_REPLY 打进 ack 卡(痕迹泄漏)', async () => {
  // ⚠ 复核时实测复现过:卡上出现「NO_R ⏎⏎ ⏳ 处理中 …」。根因是脉搏拼正文时少了流式那道
  //   `!NO_REPLY.startsWith(t)` 的门 —— ack 预建卡打破了「有卡 ⇒ 文本必已分歧」这个巧合。
  const p = mkCardPlatform()
  const runner = okRunner(async ({ onEvent }) => {
    await wait(60)
    onEvent({ type: 'assistant', text: NO_REPLY.slice(0, 4) })  // 只吐出前缀
    await wait(160)                                             // 给脉搏充分机会
    onEvent({ type: 'assistant', text: NO_REPLY.slice(4) })
    return { sessionId: 's', result: { text: NO_REPLY } }
  })
  const cfg = baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, ackDelayMs: 20, cardPulseMs: 40 } })
  await new Engine(cfg, { runner, store: mkStore() }).handleMessage(mkMsg('一件不用回话的事'), p); await wait(80)
  const card = p.cards[0]
  assert.ok(card, 'ack 会把卡建出来 —— 否则这条测不到东西')
  const leaked = card.updates.filter((u) => u.includes(NO_REPLY.slice(0, 4)))
  assert.equal(leaked.length, 0, `NO_REPLY 被脉搏打进卡里 ${leaked.length} 次:${JSON.stringify(card.updates.slice(0, 4))}`)
  assert.ok(card.updates.some((u) => /⏳ (处理中 · )?已跑/.test(u)), '对照:脉搏本身确实跳过 —— 否则「没泄漏」证明不了什么')
})

test('engine: ack 的判据是「有没有人在等回复」,不是「是不是合成消息」', async () => {
  // 实测(codex 那种整段文字在末尾才吐的后端):真人消息 39ms 建卡、5 帧脉搏;同样的活走控制台
  // 插话则 221ms 才建卡(临近收尾)、0 帧脉搏 —— operator 勾了「回复」却全程看不到动静。
  const lateText = () => okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', tools: [{ name: 'Bash' }] }); await wait(220)
    onEvent({ type: 'assistant', text: '查完了' }); return { sessionId: 's', result: { text: '查完了' } }
  })
  const cfg = baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, ackDelayMs: 30, cardPulseMs: 40 } })
  const pulses = async (extra) => {
    const p = mkCardPlatform()
    await new Engine(cfg, { runner: lateText(), store: mkStore() }).handleMessage(Object.assign(mkMsg('长任务'), extra), p); await wait(40)
    return p.cards[0] ? p.cards[0].updates.filter((u) => /⏳ (处理中 · )?已跑/.test(u)).length : 0
  }
  assert.ok(await pulses({}) >= 2, '对照组:真人消息本来就该早早建卡并滚动')
  assert.ok(await pulses({ synthetic: true, wantsAck: true }) >= 2, '插话勾了「回复」= 有人在等 ⇒ 也要 ack 建卡、脉搏要滚')
  assert.equal(await pulses({ synthetic: true }), 0, '⚠ 定时任务 / 画布按钮没人等 ⇒ 照旧不 ack')
  assert.equal(await pulses({ synthetic: true, wantsAck: true, quiet: true }), 0, '⚠ 无痕插话仍然一个字都不留')
})

// 跑久了降频(v0.11.48):15 秒的节奏是给「还在等它出声」那几分钟的。一轮跑到第 25 分钟时
// 盯着看的人早走了,而超过 10 分钟后每帧还从流式推送变成更贵的整卡更新。
// ⚠ 判据必须是**对照式**的:光数「慢档有几帧」证明不了降频 —— 得跟「不降频」跑同一个场景比。
test('engine: 跑过阈值后脉搏降频(与不降频跑同一场景对照)', async () => {
  const scenario = async (extra) => {
    const p = mkCardPlatform()
    const run = okRunner(async ({ onEvent }) => {
      onEvent({ type: 'assistant', text: '在干活' })
      onEvent({ type: 'assistant', tools: [{ name: 'Bash' }] })
      await wait(800)
      return { sessionId: 's', result: { text: '做完了' } }
    })
    const cfg = baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, ackDelayMs: 0, cardPulseMs: 30, ...extra } })
    await new Engine(cfg, { runner: run, store: mkStore() }).handleMessage(mkMsg('长任务'), p); await tick()
    return p.cards[0].updates.filter((u) => /⏳ (处理中 · )?已跑/.test(u)).length
  }
  const slowed = await scenario({ cardPulseSlowAfterMs: 200, cardPulseSlowMs: 500 })
  const flat = await scenario({ cardPulseSlowAfterMs: 10 * 60 * 1000 }) // 对照组:阈值够远 ⇒ 全程快档
  assert.ok(flat >= 6, `对照组本身要跳够多帧,否则这条测试没有分辨力(拿到 ${flat})`)
  assert.ok(slowed * 2 < flat, `过阈值后该明显变稀:降频 ${slowed} 帧 vs 不降频 ${flat} 帧`)
  assert.ok(slowed >= 2, `但不能一帧不发 —— 阈值前那段仍是快档(拿到 ${slowed})`)
})

// ── 后台任务活不过本轮(2026-09-05 空轮根因)────────────────────────────────────
// 真机链条(claude 会话 transcript 逐条对出来的):agent 用后台命令跑 12 张生图、答案给完就
// 结束本轮 ⇒ 进程被宽限期强制收尾 ⇒ 那个后台任务没有收尾记录 ⇒ 下一次 `--resume` 时 CLI 先把
// 一条「上一轮的后台任务没有结果」的系统提示排进队列、**排在群消息前面** ⇒ 那一轮零 API 调用、
// 零产出退出(ledger 记 empty)。当天三次 empty 的紧前一轮全部起过后台命令,其余轮次一次都没有。
// ⭐ 治在清单而不是加大重试:**代价不落在起它的那一轮,而落在下一个说话的人身上** —— 起它的
//   agent 永远看不到后果,靠「起的东西自己收干净」这条通则拦不住,必须点名并说清代价归谁。

test('manifest: 后台任务活不过本轮 —— 代价落在下一条群消息上,必须点名说清', async () => {
  const { r, get } = capRunner()
  await new Engine(baseCfg(), { runner: r, store: mkStore() }).handleMessage(mkMsg('a'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /【本机运行约定】/)
  assert.match(p, /不要把活儿丢进后台再回头查/)
  assert.match(p, /进程本身并不会退/) // v0.11.108 改口:旧句「活不过这一轮」被 生产机上跑了 35 天的孤儿循环推翻
  // ⚠ 这一句是整条的要害:只说「拿不到结果」它会觉得「那我不看就是了」,照起不误。
  assert.match(p, /下一条群消息的那一轮空转/)
  assert.match(p, /run_in_background/) // claude 群点名到具体机制,否则它不知道说的是哪个开关
  assert.match(p, /Monitor/)
})

test('manifest: codex 群不提 run_in_background/Monitor(它没这两样),但通则照说', async () => {
  // ⚠ 对照组:少了它,把工具名那行的 `!isCodex` 门控删掉照样全绿,而生产里 codex 群会收到
  //   一条对不上号的指令 —— 教它去关一个不存在的开关。
  const { r, get } = capRunner()
  const cfg = baseCfg({ providers: { gpt: { runner: 'codex', model: 'm' } },
    groups: { G: { workdir: '/proj', provider: 'gpt', permissionMode: 'bypassPermissions' } } })
  await new Engine(cfg, { runner: r, store: mkStore() }).handleMessage(mkMsg('b'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /不要把活儿丢进后台再回头查/, '通则两个 runner 都成立,不该跟着工具名一起消失')
  assert.doesNotMatch(p, /run_in_background/)
  assert.doesNotMatch(p, /靠它轮询的 `Monitor`/)
})

// ── 生图:槽位与失败重投(2026-09-05 真机)────────────────────────────────────────
// 同一天群里连投 9 张改图任务(槽位只有 2 个 ⇒ 后七个纯排队干等),失败后又把同一张原样重投
// 3 次 —— 每次各烧满十分钟墙钟。「有 2 个槽位」这个**事实**清单里一直写着,漏的是**该怎么办**。
test('manifest: 生图段教「别一次投一大批」「失败别原样重投」,且槽位数只说一处', async () => {
  const { r, get } = capRunner()
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', permissionMode: 'bypassPermissions' } } })
  await new Engine(cfg, { runner: r, store: mkStore(), hasImagen: () => true }).handleMessage(mkMsg('a'), mkPlatform()); await tick()
  const p = get().prompt
  assert.match(p, /同时只有 2 个生图槽位/)
  assert.match(p, /一次别投一大批/)
  assert.match(p, /一张一张来/)           // 事实之外还要给可照做的动作,否则它照样一次投一批
  assert.match(p, /失败了别原样重投/)
  assert.match(p, /先看失败卡上说的原因/) // 不给下一步,它只会换个说法再投一次
  // 槽位数是同一个事实 —— 清单里只许出现一处。两处各写一份必然漂移(本文件反复栽过)。
  assert.equal((p.match(/2 个生图槽位|最多 2 个生图任务/g) || []).length, 1)
})

// ── 空轮取证:「empty」三个字本身没有分辨力 ──────────────────────────────────────
// 「模型开了口但没话说」和「这一轮压根没轮到我们的消息」在账本里长得一模一样,而两者的下一步
// 动作完全相反。判据三样,都在收尾那一刻手上,且**反过来输出会不同**。
test('engine: 空轮日志带判据字段 —— 三个字段各自都要跟着状态动', async () => {
  const logsOf = async (runner, store = mkStore()) => {
    const logs = []
    const eng = new Engine(baseCfg(), { runner, store, log: (m) => logs.push(m) })
    await eng.handleMessage(mkMsg('q'), mkPlatform())
    for (let i = 0; i < 12; i++) await tick()
    return logs.filter((m) => /空轮判据/.test(m))
  }
  // ① CLI 正常收了一轮尾,模型却一次都没被调用 —— 2026-09-05 真机三次全是这个形状
  const a = await logsOf(okRunner(async () => ({ sessionId: 's', result: {} })))
  assert.ok(a.length >= 1, '不留判据行,事后只能看到一个孤零零的 empty(2026-09-01 那批 error 的老毛病)')
  assert.match(a[0], /result 事件=有\(success\)/)
  assert.match(a[0], /assistant 事件=0/)
  assert.match(a[0], /会话=新开/)
  // ② 模型开过口(只是没话说)⇒ 计数必须不同,否则这个字段等于没写
  const b = await logsOf(okRunner(async ({ onEvent }) => { onEvent({ type: 'assistant', text: '' }); return { sessionId: 's', result: {} } }))
  assert.match(b[0], /assistant 事件=1/)
  // ③ 进程半路没了(压根没有 result 事件)⇒ 与 ① 是两件事,排查方向也不同
  const c = await logsOf(okRunner(async () => ({ sessionId: 's' })))
  assert.match(c[0], /result 事件=无/)
  // ④ 接旧会话 vs 新开:只有续接才可能被上一轮的残留吃掉这一轮
  const st = mkStore(); st.setSession('G', '391ef680-8602-4959')
  const d = await logsOf(okRunner(async () => ({ sessionId: '391ef680-8602-4959', result: {} })), st)
  assert.match(d[0], /会话=续接 391ef680/)
  // 自动重试的那一轮必然是「续接」(原轮已把 sessionId 落盘)—— 顺带证明这个字段真的在动
  assert.match(a[1], /会话=续接 s/)
})

test('engine: 只有空轮才打判据行 —— 正常轮 / 静默轮 / 出错轮都不打(对照组)', async () => {
  // ⚠ 少了这条,把 `if (nothingProduced)` 删成无条件照样全绿,而日志会被每轮一行淹掉。
  const logsOf = async (runner, text = 'q') => {
    const logs = []
    await new Engine(baseCfg(), { runner, store: mkStore(), log: (m) => logs.push(m) }).handleMessage(mkMsg(text), mkPlatform())
    for (let i = 0; i < 12; i++) await tick()
    return logs.filter((m) => /空轮判据/.test(m))
  }
  assert.equal((await logsOf(okRunner())).length, 0, '有产出的正常轮')
  assert.equal((await logsOf(okRunner(async ({ onEvent }) => { onEvent({ type: 'assistant', text: NO_REPLY }); return { sessionId: 's', result: { text: NO_REPLY } } }))).length, 0, '有意静默 ≠ 什么都没发生')
  assert.equal((await logsOf(okRunner(async () => ({ sessionId: 's', result: { isError: true, subtype: 'error_max_turns' } })))).length, 0, '出错轮另有 err 字段与专门那行日志')
})

// ── 瞬时错(服务端过载)在群里说人话 + 已流出的正文保住(2026-09-08 测试群现场)────────
// 现场:agent 刚流出「这个场景更适合可搜索的单页图标目录」就撞 codex「Selected model is at capacity.
// Please try a different model.」,卡片整卡被这句英文原话顶掉 —— 「换个模型」群成员照做不了。
test('engine: 瞬时错的卡片说人话并给下一步;已流出的正文保住;账本仍记服务端原话', async () => {
  const RAW = 'Selected model is at capacity. Please try a different model.'
  const records = []
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '这个场景更适合可搜索的单页图标目录。' })
    return { sessionId: 's', result: { isError: true, subtype: 'error', text: RAW, transient: '模型这会儿排不上队(服务端过载)' } }
  })
  const p = mkCardPlatform()
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('为什么不做成 HTML'), p); await tick()
  const card = p.cards[0].finished
  assert.match(card, /排不上队/)
  assert.match(card, /发一句「继续」/) // 下一步是事实:提问已在会话历史里
  assert.doesNotMatch(card, /at capacity|different model/) // 服务端英文原话不进群
  assert.match(card, /单页图标目录/) // 已流出的正文保住
  assert.ok(card.indexOf('单页图标目录') < card.indexOf('❌'), '正文在前、错误行在后(与中止路径同形)')
  assert.match(records[0].err, /at capacity/) // 账本留原话,查的人靠它对号
  assert.doesNotMatch(records[0].err, /排不上队/)
  // 对照 1:非瞬时错不给「继续」那句(否则人人被劝稍后再来),但正文同样保住
  const p2 = mkCardPlatform()
  const eng2 = new Engine(baseCfg(), { runner: okRunner(async ({ onEvent }) => { onEvent({ type: 'assistant', text: '先读配置。' }); return { sessionId: 's', result: { isError: true, subtype: 'boom', text: '炸了' } } }), store: mkStore() })
  await eng2.handleMessage(mkMsg('x'), p2); await tick()
  assert.doesNotMatch(p2.cards[0].finished, /继续/)
  assert.match(p2.cards[0].finished, /先读配置。[\s\S]*❌ 出错:炸了/)
  // 对照 2:无卡路径(纯文本平台)同一口径
  const p3 = mkPlatform()
  await new Engine(baseCfg(), { runner, store: mkStore() }).handleMessage(mkMsg('y'), p3); await tick()
  assert.match(p3.replies[0], /排不上队[\s\S]*发一句「继续」/)
  assert.doesNotMatch(p3.replies[0], /at capacity/)
})

// ── 交付载体三分:翻找 → HTML · 挑一个 → 对照图 · 评审改 → 画布(2026-09-08 测试群现场)────
// 现场:2025 个 Lucide 图标切成 15 张全上了画布,agent 照的是「批量 ≥3 张只发画布链接」;原话「画布太麻烦」。
test('engine: 清单教「交付载体按读者要干什么选」,画布段的 ≥3 张规则只对设计稿成立', async () => {
  // 无画布的群:三分规则无条件在(本机运行约定段)
  let captured
  const eng = new Engine(baseCfg(), { runner: okRunner((o) => { captured = o; return Promise.resolve({ sessionId: 's', result: { text: 'ok' } }) }), store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), mkPlatform()); await tick()
  // 钉规则的三个要件(可搜索 HTML 走 send-file · 目录类不上画布 · 三分各给正路),不钉加粗记号与标点
  assert.match(captured.prompt, /交付载体按[^\n]*读者要干什么/)
  assert.match(captured.prompt, /可按名字搜索[^\n]*HTML[^\n]*send-file/)
  assert.match(captured.prompt, /目录类不上画布/)
  const line = captured.prompt.split('\n').find((l) => l.includes('交付载体按'))
  for (const w of ['翻找', '挑一个', '评审']) assert.ok(line.includes(w), `三分规则缺「${w}」`)
  // 有画布的群:画布段那条 ≥3 张规则就地限定为「设计稿」,不再是无限定的「批量」
  let cap2
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', permissionMode: 'bypassPermissions', board: { url: 'https://b', whiteboardId: 'wb' } } } })
  const eng2 = new Engine(cfg, { runner: okRunner((o) => { cap2 = o; return Promise.resolve({ sessionId: 's', result: { text: 'ok' } }) }), store: mkStore() })
  await eng2.handleMessage(mkMsg('hi'), mkPlatform()); await tick()
  assert.match(cap2.prompt, /board-add-image/) // 对照组:画布段确实注入了
  assert.match(cap2.prompt, /\*\*设计稿\*\*批量 ≥3 张只发画布链接/)
  assert.doesNotMatch(cap2.prompt, /一份\(批量 ≥3 张/, '旧的无限定写法不能残留')
})

// ── /help 重排(v0.11.82,产品决定):简介 · 后台公网地址 · 插件行 ───────────────────────
test('engine: /help 简介给本群项目名与模型;配了公网地址才有「后台」行且只给公网的', async () => {
  const cfg = baseCfg({ providers: { gpt: { runner: 'codex', model: 'gpt-x' } }, groups: { G: { workdir: '/Users/x/Projects/DemoApp', provider: 'gpt', permissionMode: 'bypassPermissions' } } })
  const p = mkPlatform()
  const eng = new Engine(cfg, { runner: okRunner(), store: mkStore(), uiUrl: 'http://192.168.1.9:4600' })
  eng.publicUrl = 'https://ca.example.com'
  await eng.handleMessage(mkMsg('/help'), p)
  const h = p.replies[0]
  assert.match(h, /^【[^】]+】\n[^\n]*「DemoApp」[^\n]*gpt · gpt-x/) // 首段简介:目录名 + provider · 型号
  assert.doesNotMatch(h, /\/Users\//) // 零机器路径
  assert.match(h, /· 后台:https:\/\/ca\.example\.com,管理员用飞书账号登录/)
  assert.doesNotMatch(h, /192\.168/) // 局域网地址不进群:出了局域网打不开、还要密码
  for (const line of h.split('\n')) if (!/https?:\/\//.test(line)) assert.ok(line.length <= 62, `这一行太长:${line}`) // 网址行长度由域名定,不算
  // 对照:没配公网地址 ⇒ 整行不出现(不退回局域网地址)
  const p2 = mkPlatform()
  await new Engine(cfg, { runner: okRunner(), store: mkStore(), uiUrl: 'http://192.168.1.9:4600' }).handleMessage(mkMsg('/help'), p2)
  assert.doesNotMatch(p2.replies[0], /后台:|192\.168/)
})

test('engine: /help 插件行 —— 没接只说类别不点软件名;接了按名单报,多了截断计数', async () => {
  const base = { workdir: '/proj', provider: 'claude', permissionMode: 'bypassPermissions' }
  const p0 = mkPlatform()
  await new Engine(baseCfg({ groups: { G: base } }), { runner: okRunner(), store: mkStore() }).handleMessage(mkMsg('/help'), p0)
  assert.match(p0.replies[0], /· 插件:接上插件就能操控对应软件/)
  assert.doesNotMatch(p0.replies[0], /Photoshop|Blender|Fusion/i) // 产品决定:不点具体软件名(会被读成已经能用)
  const p5 = mkPlatform()
  await new Engine(baseCfg({ groups: { G: { ...base, plugins: { mcp: ['a', 'b', 'c', 'd', 'e'] } } } }), { runner: okRunner(), store: mkStore() }).handleMessage(mkMsg('/help'), p5)
  assert.match(p5.replies[0], /· 插件:本群已接 a · b · c 等 5 个/) // 钉名单与截断计数,不钉后半句措辞
})

// 清单里的控制台地址:配了公网地址就给公网的(飞书登录),局域网退居第二段;没配保持原样
test('engine: 清单「控制台」行优先给公网地址,局域网地址退居第二段', async () => {
  const { r, get } = capRunnerPrompt()
  const eng = new Engine(baseCfg(), { runner: r, store: mkStore(), uiUrl: 'http://192.168.1.9:4600' })
  eng.publicUrl = 'https://ca.example.com'
  await eng.handleMessage(mkMsg('go'), mkPlatform()); await tick()
  // 钉的是次序(公网在前、局域网在后、同一行)与「飞书登录」这个事实,不钉括号里的整句
  assert.match(get().prompt, /· 控制台:https:\/\/ca\.example\.com[^\n]*飞书[^\n]*http:\/\/192\.168\.1\.9:4600/)
  const { r: r2, get: get2 } = capRunnerPrompt()
  await new Engine(baseCfg(), { runner: r2, store: mkStore(), uiUrl: 'http://192.168.1.9:4600' }).handleMessage(mkMsg('go'), mkPlatform()); await tick()
  assert.match(get2().prompt, /· 控制台:http:\/\/192\.168\.1\.9:4600/)
  assert.doesNotMatch(get2().prompt, /ca\./) // 没配公网就没有公网那段
})

// ── 审查补漏(2026-09-08):claude CLI 的 API 过载会把「API Error: 529 …」当正文流出来;合成轮不给「你刚才那条」────
test('engine: 出错卡剔掉「API Error:」那行正文;合成轮不给「发一句「继续」」;账本不带 success: 前缀', async () => {
  const RAW = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
  const records = []
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '我先看一下项目结构。' })
    onEvent({ type: 'assistant', text: RAW }) // CLI 的真实行为:错误文本同时作为 assistant 文本流出
    return { sessionId: 's', result: { isError: true, subtype: 'success', text: RAW, transient: '模型这会儿排不上队(服务端过载)' } }
  })
  const p = mkCardPlatform()
  const eng = new Engine(baseCfg(), { runner, store: mkStore(), ledger: { append: (r) => records.push(r) } })
  await eng.handleMessage(mkMsg('改一下'), p); await tick()
  const card = p.cards[0].finished
  assert.match(card, /我先看一下项目结构/) // 真正文保住
  assert.doesNotMatch(card, /API Error/) // 英文原话那行剔掉
  assert.match(card, /排不上队[\s\S]*发一句「继续」/)
  assert.match(records[0].err, /^API Error: 529/) // 账本留原话,且不带「success: 」前缀
  // 合成轮(定时任务 / 插话):没人「刚才说过」,不给那句下一步
  const p2 = mkCardPlatform()
  const eng2 = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng2.handleMessage({ ...mkMsg('定时整理'), synthetic: true, wantsAck: true, msgId: 'cron:1' }, p2); await tick()
  assert.match(p2.cards[0].finished, /排不上队/)
  assert.doesNotMatch(p2.cards[0].finished, /继续/)
})

test('engine: /help 插件行按真实长名单自动缩到 62 字符内', async () => {
  const base = { workdir: '/proj', provider: 'claude', permissionMode: 'bypassPermissions' }
  const names = ['chrome-devtools', 'feishu-mcp-server', 'blender-mcp-bridge', 'fusion-connector', 'db-tools']
  const p = mkPlatform()
  await new Engine(baseCfg({ groups: { G: { ...base, plugins: { mcp: names } } } }), { runner: okRunner(), store: mkStore() }).handleMessage(mkMsg('/help'), p)
  const line = p.replies[0].split('\n').find((l) => l.startsWith('· 插件:'))
  assert.ok(line && line.length <= 62, `插件行仍超长:${line}`)
  assert.match(line, /chrome-devtools/) // 至少列出第一个
  assert.match(line, /等 5 个/) // 总数照报
})

// ── /help 补三处(v0.11.92):撤回即停 · 记忆怎么留 · 压缩提示的出处 ─────────────────────
// 三件机制早就在(handleRecall / v0.11.59 记忆交接 / v0.11.19 压缩通知),群成员却无从知道 —— 「做了却到不了用它的人手上」。
test('engine: /help 说撤回也算取消、记忆怎么留、会话会自动压缩;记忆那行只给完全访问的群', async () => {
  const p = mkPlatform()
  await new Engine(baseCfg(), { runner: okRunner(), store: mkStore() }).handleMessage(mkMsg('/help'), p)
  const h = p.replies[0]
  assert.match(h, /^⚠ 撤回自己发的消息 = 取消/m, '撤回即停要写进 /help,且用 ⚠ 起头(不是第九个命令)')
  assert.match(h, /合成一轮在做的除外/, '边界照实写:合批那轮撤回不打断')
  assert.match(h, /^· 记忆:.*项目文件.*\/new 也不丢/m, '记忆怎么留:让它记进项目文件,换模型 / new 不丢')
  assert.match(h, /^· \/hud — .*自动压缩.*群里会提示/m, '压缩通知的出处挂在 /hud 那行')
  // 只读群写不了项目文件 ⇒ 记忆那行不列(列了就是说谎);撤回与 /hud 那两句与权限无关,照旧
  const cfgRo = baseCfg({ providers: { gpt: { runner: 'codex' } }, groups: { G: { workdir: '/proj', provider: 'gpt' } } })
  const p2 = mkPlatform()
  await new Engine(cfgRo, { runner: okRunner(), store: mkStore() }).handleMessage(mkMsg('/help'), p2)
  assert.doesNotMatch(p2.replies[0], /· 记忆:/)
  assert.match(p2.replies[0], /^⚠ 撤回自己发的消息/m)
  assert.match(p2.replies[0], /自动压缩/)
})

// ── 里程碑与「最近在做」(v0.11.93)────────────────────────────────────────────
// 2026-09-11 DemoApp 真机:一轮 51 分钟 138 次工具,卡上只有心跳数字,群里连问两次「怎么不更新进度」。
// 两条腿:模型每完成一个阶段输出 `>> …`(附言教),引擎认它进卡、收尾收进折叠区;模型一个字不说时,
// 「最近在做」由工具调用确定性推出 —— 后者不依赖模型配合,是保底。
test('milestones: `>> ` 行认出来 · 去重 · 封顶 12 · 代码围栏里的不算;render 换 ▶;strip 剔掉', () => {
  const { milestonesOf, renderMilestones, stripMilestones } = require('../../src/core/engine')
  const text = '开工\n>> 登录弹层做完\n>>设置页截图已发\n>> 登录弹层做完\n```sh\necho x >> log.txt\n```\n收尾答案'
  assert.deepEqual(milestonesOf(text), ['登录弹层做完', '设置页截图已发'])
  assert.equal(renderMilestones(text), '开工\n▶ 登录弹层做完\n▶ 设置页截图已发\n▶ 登录弹层做完\n```sh\necho x >> log.txt\n```\n收尾答案')
  assert.equal(stripMilestones(text), '开工\n```sh\necho x >> log.txt\n```\n收尾答案')
  assert.equal(milestonesOf(Array.from({ length: 20 }, (_, i) => `>> 第${i}步`).join('\n')).length, 12)
  assert.deepEqual(milestonesOf('普通正文\n没有里程碑'), [])
  assert.equal(renderMilestones('普通正文'), '普通正文') // 对照组:没标记原样
})

test('describeTool: 工具调用 → 一句人话;只给文件名不给路径;插件按名字;认不出的不凑数', () => {
  const { describeTool } = require('../../src/core/engine')
  assert.equal(describeTool('Edit', { file_path: '/Users/x/Projects/DemoApp/pages/login/index.js' }), '改 index.js')
  assert.equal(describeTool('Read', { file_path: 'C:\\proj\\a.txt' }), '看 a.txt')
  assert.equal(describeTool('Write', { path: 'src/new.js' }), '写 new.js')
  assert.equal(describeTool('Write', {}), '写文件')
  assert.equal(describeTool('Bash', { command: 'rm -rf /Users/x/secret' }), '跑命令') // 命令内容不给
  assert.equal(describeTool('mcp__wechat-devtools__wechat_screenshot', {}), '用插件 wechat-devtools')
  assert.equal(describeTool('MCP', { server: 'blender' }), '用插件 blender') // codex 形状
  assert.equal(describeTool('Grep', {}), '搜代码')
  assert.equal(describeTool('ToolSearch', {}), null)
  assert.equal(describeTool('SomethingNew', {}), null)
  for (const [n, i] of [['Edit', { file_path: '/Users/x/a.js' }], ['Bash', { command: '/Users/x/run.sh' }]]) assert.doesNotMatch(String(describeTool(n, i)), /\/Users/) // 零机器路径
})

// 确定性里程碑(2026-09-14):另一台机器上一个真实群 116 轮里模型只吐过 1 行 `>> `,附言 / CLAUDE.md 硬规则 / CLI 沉默提醒
// 三层都没用 ⇒ 「做到哪了」不能靠模型配合,从交付类工具调用直接推。
test('autoMilestone: 交付类工具调用 → 「已完成」一句;只给文件名;临时脚本不算;一次 Bash 只记最重的;非交付类不凑数', () => {
  const { autoMilestone } = require('../../src/core/engine')
  assert.equal(autoMilestone('Write', { file_path: '/Users/x/proj/src/new.js' }), '写了 new.js')
  assert.equal(autoMilestone('Edit', { file_path: 'C:\\proj\\a.txt' }), '改了 a.txt')
  assert.equal(autoMilestone('Write', { file_path: '/tmp/upd17.py' }), null) // 写给自己用的脚本
  assert.equal(autoMilestone('Write', { file_path: '/private/tmp/x.py' }), null)
  assert.equal(autoMilestone('Read', { file_path: '/Users/x/a.js' }), null)
  assert.equal(autoMilestone('Bash', { command: 'cd "/Users/x/p" && sbot feishu send-file "调研/南岛 手册.pdf" 2>&1 | tail -1' }), '已发文件 南岛 手册.pdf')
  assert.equal(autoMilestone('Bash', { command: 'sbot feishu send-image /Users/x/p/cover.png' }), '已发图片 cover.png')
  assert.equal(autoMilestone('Bash', { command: 'sbot feishu send-msg "好了"' }), '已发消息到群')
  assert.equal(autoMilestone('Bash', { command: "cat > \"/Users/x/p/poi/day_fac.py\" <<'EOF'\nprint(1)\nEOF\npython3 day_fac.py" }), '写了 day_fac.py')
  assert.equal(autoMilestone('Bash', { command: "cat > /tmp/upd.py <<'EOF'\nx\nEOF\npython3 /tmp/upd.py" }), null)
  assert.equal(autoMilestone('Bash', { command: "cat > /Users/x/p/a.py <<'EOF'\nx\nEOF\n&& sbot feishu send-file /Users/x/p/out.pdf" }), '已发文件 out.pdf') // 最重的一条
  assert.equal(autoMilestone('Bash', { command: 'git add -A && git commit -m x && git push' }), '已推送远端')
  assert.equal(autoMilestone('Bash', { command: 'git -C /Users/x/p commit -m "x"' }), '已提交代码')
  assert.equal(autoMilestone('Bash', { command: 'timeout 60 "$CH" --headless --print-to-pdf="/Users/x/p/out.pdf" a.html' }), '已出 PDF out.pdf')
  assert.equal(autoMilestone('Bash', { command: 'OUT=/Users/x/p/out.pdf; "$CH" --headless --print-to-pdf="$OUT" a.html' }), '已出 PDF') // 变量解不出名,只报动作
  assert.equal(autoMilestone('Bash', { command: 'cat > "$F" <<EOF\nx\nEOF' }), null)
  assert.equal(autoMilestone('Bash', { command: 'sbot feishu board-add-image /Users/x/a.png' }), '已上画布')
  assert.equal(autoMilestone('Bash', { command: 'sbot imagen "一只猫" --out /Users/x/cat.png' }), '已提交生图')
  assert.equal(autoMilestone('Bash', { command: 'sbot imagen --list' }), null)
  assert.equal(autoMilestone('Bash', { command: 'ls -la && npm test && echo ">> not a milestone"' }), null)
  assert.equal(autoMilestone('Bash', {}), null)
  assert.equal(autoMilestone('mcp__chrome-devtools__take_screenshot', {}), null)
  for (const [n, i] of [['Write', { file_path: '/Users/x/a.js' }], ['Bash', { command: 'sbot feishu send-file /Users/x/b.pdf' }], ['Bash', { command: 'cat > /Users/x/c.py <<EOF' }]]) assert.doesNotMatch(String(autoMilestone(n, i)), /\/Users/) // 零机器路径
})

test('engine: 模型一个字不说时,交付类工具调用也在卡上累积成 ▶ 行(ack 卡 + 脉搏),收尾进折叠区;与模型自己的 `>> ` 行并排、去重', async () => {
  const p = mkCardPlatform()
  const run = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', tools: [{ name: 'Bash', input: { command: "cat > /p/poi/day_fac.py <<'EOF'\nx\nEOF" } }] })
    onEvent({ type: 'assistant', tools: [{ name: 'Edit', input: { file_path: '/p/build_rt.py' } }, { name: 'Read', input: { file_path: '/p/rt.css' } }] })
    onEvent({ type: 'assistant', tools: [{ name: 'Edit', input: { file_path: '/p/build_rt.py' } }] }) // 同一文件改两次只记一条
    await wait(350)
    onEvent({ type: 'assistant', tools: [{ name: 'Bash', input: { command: 'sbot feishu send-file "/p/调研/手册.pdf"' } }] })
    onEvent({ type: 'assistant', text: '>> 已发文件 手册.pdf\n>> 预览已发\n\n✅ 手册更新好了。' })
    return { sessionId: 's', result: { text: '>> 已发文件 手册.pdf\n>> 预览已发\n\n✅ 手册更新好了。' } }
  })
  const cfg = baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 2, maxTurnTimeMins: 0, ackDelayMs: 30, cardPulseMs: 100 } })
  await new Engine(cfg, { runner: run, store: mkStore() }).handleMessage(mkMsg('把停车场标上去'), p); await tick()
  const card = p.cards[0]
  assert.ok(card, '没有文本也要有卡(ack 建的)')
  const pulses = card.updates.filter((u) => /⏳ (处理中 · )?已跑/.test(u))
  assert.ok(pulses.length >= 1, `要有脉搏(拿到 ${pulses.length} 次:${JSON.stringify(card.updates)})`)
  assert.match(pulses[pulses.length - 1], /^▶ 写了 day_fac\.py\n▶ 改了 build_rt\.py\n\n⏳ 已跑/, '模型没说话,卡上也看得见做到哪了;看文件不算')
  assert.doesNotMatch(pulses[pulses.length - 1], /\/p\//, '零机器路径')
  assert.match(card.updates[card.updates.length - 1], /^▶ 写了 day_fac\.py\n▶ 改了 build_rt\.py\n▶ 已发文件 手册\.pdf\n\n▶ 已发文件 手册\.pdf\n▶ 预览已发/, '打字机上自动块在前、模型的 ▶ 行在后')
  assert.equal(card.finished, '✅ 手册更新好了。', '收尾正文只留答案')
  assert.deepEqual(card.finishOpts && card.finishOpts.milestones, ['写了 day_fac.py', '改了 build_rt.py', '已发文件 手册.pdf', '预览已发'], '自动的在前、模型的在后,重复的只留一条')
})

test('engine: 长任务里 `>> ` 行随打字机显示成 ▶,脉搏带「最近在做」;收尾正文剔掉里程碑、整批交给卡片折叠区', async () => {
  const p = mkCardPlatform()
  const run = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '先看结构\n' })
    onEvent({ type: 'assistant', tools: [{ name: 'Read', input: { file_path: '/p/pages/index.js' } }, { name: 'Bash', input: { command: 'npm test' } }] })
    onEvent({ type: 'assistant', text: '>> 登录弹层做完\n' })
    onEvent({ type: 'assistant', tools: [{ name: 'Edit', input: { file_path: '/p/pages/login.js' } }] })
    await wait(320)
    onEvent({ type: 'assistant', text: '>> 设置页截图已发\n\n✅ 第 2 步做好了,截图在群里。' })
    return { sessionId: 's', result: { text: '>> 设置页截图已发\n\n✅ 第 2 步做好了,截图在群里。' } }
  })
  await new Engine(pulseCfg(100), { runner: run, store: mkStore() }).handleMessage(mkMsg('做第 2 步'), p); await tick()
  const card = p.cards[0]
  assert.ok(card.updates.some((u) => /▶ 登录弹层做完/.test(u)), '中途的里程碑要显示成 ▶')
  assert.ok(!card.updates.some((u) => /^>> /m.test(u)), '卡上不许出现原始的 >> 标记')
  const pulses = card.updates.filter((u) => /⏳ (处理中 · )?已跑/.test(u))
  assert.ok(pulses.length >= 1, '要有脉搏')
  assert.match(pulses[pulses.length - 1], /最近在做:看 index\.js · 跑命令 · 改 login\.js/, '脉搏下面那行由工具调用推出,最新在最后')
  assert.doesNotMatch(pulses[pulses.length - 1], /\/p\//, '零机器路径')
  assert.equal(card.finished, '✅ 第 2 步做好了,截图在群里。', '收尾正文剔掉里程碑行')
  assert.deepEqual(card.finishOpts && card.finishOpts.milestones, ['改了 login.js', '登录弹层做完', '设置页截图已发'], '里程碑整批交给平台收进折叠区(改文件这类交付动作自动记一条,排在模型报的前面)')
})

test('engine: 相邻 assistant 文本之间补换行 —— 三行 `>> ` 分三条事件到达时不黏成一行(生产机deepseek 真机形状)', async () => {
  const p = mkCardPlatform()
  const run = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '>> 已建目录并写入 a.txt' }); onEvent({ type: 'assistant', tools: [{ name: 'Bash' }] })
    onEvent({ type: 'assistant', text: '>> 已写入 b.txt' }); onEvent({ type: 'assistant', tools: [{ name: 'Bash' }] })
    onEvent({ type: 'assistant', text: '>> 已统计文件数\n\n_probe 里有 2 个文件' })
    return { sessionId: 's', result: { text: '>> 已统计文件数\n\n_probe 里有 2 个文件' } }
  })
  await new Engine(baseCfg(), { runner: run, store: mkStore() }).handleMessage(mkMsg('去'), p); await tick()
  const card = p.cards[0]
  assert.deepEqual(card.finishOpts && card.finishOpts.milestones, ['已建目录并写入 a.txt', '已写入 b.txt', '已统计文件数'], '三条各自成行')
  assert.equal(card.finished, '_probe 里有 2 个文件')
  assert.match(card.updates[card.updates.length - 1] || '', /▶ 已建目录并写入 a\.txt\n▶ 已写入 b\.txt\n▶ 已统计文件数/, '打字机上也是三行')
  // 对照组:文本自己带了换行的,不多加一个(不会出现空行)
  const p2 = mkCardPlatform()
  await new Engine(baseCfg(), { runner: okRunner(async ({ onEvent }) => { onEvent({ type: 'assistant', text: '甲\n' }); onEvent({ type: 'assistant', tools: [{ name: 'Bash' }] }); onEvent({ type: 'assistant', text: '乙' }); return { sessionId: 's', result: { text: '乙' } } }), store: mkStore() }).handleMessage(mkMsg('去'), p2); await tick()
  assert.equal(p2.cards[0].updates[p2.cards[0].updates.length - 1], '甲\n乙')
})

test('engine: 模型只报了里程碑没写收尾 ⇒ 里程碑留在正文里(不空卡);没有里程碑 ⇒ finish 不带 milestones', async () => {
  const p = mkCardPlatform()
  const run = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '>> 第一步做完\n' })
    onEvent({ type: 'assistant', tools: [{ name: 'Bash' }] })
    onEvent({ type: 'assistant', text: '>> 第二步做完' })
    return { sessionId: 's', result: { text: '>> 第二步做完' } }
  })
  await new Engine(baseCfg(), { runner: run, store: mkStore() }).handleMessage(mkMsg('去'), p); await tick()
  assert.equal(p.cards[0].finished, '▶ 第一步做完\n▶ 第二步做完')
  assert.equal((p.cards[0].finishOpts || {}).milestones, undefined) // footer(耗时 / tokens)另算,见卡片底部小字那组测试
  const p2 = mkCardPlatform()
  await new Engine(baseCfg(), { runner: okRunner(async ({ onEvent }) => { onEvent({ type: 'assistant', text: '普通回答' }); return { sessionId: 's', result: { text: '普通回答' } } }), store: mkStore() }).handleMessage(mkMsg('问'), p2); await tick()
  assert.equal(p2.cards[0].finished, '普通回答'); assert.equal((p2.cards[0].finishOpts || {}).milestones, undefined)
})

test('engine: /status 忙时多一行「最近在做」;附言教 `>> ` 且仍是 ASCII', async () => {
  const p = mkPlatform()
  const run = okRunner(async ({ onEvent }) => { onEvent({ type: 'assistant', tools: [{ name: 'Edit', input: { file_path: '/p/a.js' } }] }); await wait(250); return { sessionId: 's', result: { text: 'ok' } } })
  const eng = new Engine(baseCfg(), { runner: run, store: mkStore() })
  eng.handleMessage(mkMsg('长活'), p); await wait(60)
  const ps = mkPlatform(); await eng.handleMessage(mkMsg('/status'), ps)
  assert.match(ps.replies[0], /· 最近在做:改 a\.js/)
  await wait(300)
  const { r, get } = capRunner()
  await new Engine(baseCfg(), { runner: r, store: mkStore() }).handleMessage(mkMsg('go'), mkPlatform()); await tick()
  assert.match(get().appendSystemPrompt, /starting with ">> "/)
  assert.match(get().appendSystemPrompt, /^[\x20-\x7E]+$/)
})

test('engine: 压缩通知优先用 runner 透传的 preTokens;有 postTokens 就带「压缩后约」', async () => {
  // 真机(2026-09-11):上一条 assistant 的 usage 是 36007,而压缩元数据 preTokens=187836 —— 读进来的
  // 8 个文件还没进任何 usage。只看 liveCtx 就少报 5 倍。
  const runner = okRunner(async (opts) => {
    opts.onEvent({ type: 'assistant', text: 'x', contextTokens: 36007 })
    opts.onEvent({ type: 'system', subtype: 'compact_boundary', preTokens: 187836, postTokens: 153045 })
    return { sessionId: 's', result: { text: 'ok' } }
  })
  const p = mkPlatform()
  await new Engine(baseCfg(), { runner, store: mkStore() }).handleMessage(mkMsg('do'), p); await tick()
  const n = p.replies.find((r) => /压缩/.test(r))
  assert.match(n, /此前上下文约 18\.8万 token → 压缩后约 15\.3万/)
  assert.doesNotMatch(n, /3\.6万/)
})

// ── 定时任务的排队提示(2026-09-16 产品决定):点名任务 · 说清会自动运行 · 句首 ⏰ 与真人的 ⏳ 区分 ──
// 由来:合成消息没有平台 message_id,排队提示挂不到任何一条消息下面,群里凭空多一句「⏳ 已排队」;
// 生产机账本 44 天 65 次,56 次任务最后静默收尾 ⇒ 那句排队后面永远没有下文。
const mkCronMsg = (text) => Object.assign(mkMsg(text), { synthetic: true, cron: true, replyCtx: { chatId: 'G' } })

test('engine: 定时任务排队时说清是定时任务、会自动运行;真人消息的措辞不变(对照组)', async () => {
  const p = mkPlatform()
  const e = new Engine(baseCfg(), { runner: slowRunner(200, { text: 'done' }), store: mkStore() })
  e.handleMessage(mkMsg('占住群锁'), p); await tick()
  await e.handleMessage(mkCronMsg('每日数据日报:在项目根执行 node scripts/daily-report.js'), p); await tick()
  await e.handleMessage(mkMsg('真人的消息'), p); await tick()
  const q = p.replies.filter((r) => /已排队/.test(r))
  assert.equal(q.length, 2, `两条都该有排队提示(拿到的是:${JSON.stringify(p.replies)})`)
  assert.match(q[0], /^⏰ 定时任务已排队 — /)
  assert.match(q[0], /自动运行/)
  assert.doesNotMatch(q[0], /「|」|每日数据日报/)                // 拍板不点名具体任务
  assert.doesNotMatch(q[0], /⏳|\/stop|前面/)                 // 它是队里第一条:不提「前面」,不教人 /stop
  assert.match(q[1], /^⏳ 已排队 — .*与前面 1 条一并处理/)     // 真人那句原样(对照组)
})

test('engine: 定时任务排在别的消息后面时,提示说明会一并处理', async () => {
  const p = mkPlatform()
  const e = new Engine(baseCfg(), { runner: slowRunner(200, { text: 'done' }), store: mkStore() })
  e.handleMessage(mkMsg('占住群锁'), p); await tick()
  await e.handleMessage(mkMsg('先来的真人消息'), p); await tick()
  await e.handleMessage(mkCronMsg('运行 python3 src/report.py'), p); await tick()
  const q = p.replies.filter((r) => /已排队/.test(r))
  assert.equal(q.length, 2, JSON.stringify(p.replies))
  assert.match(q[1], /^⏰ 定时任务已排队 — /)
  assert.match(q[1], /与前面 1 条一并处理/)
})

test('engine: 定时任务在全局并发满时的提示也说清自动运行,不教人 /stop', async () => {
  const cfg = baseCfg({ agent: { bin: 'claude', permissionMode: 'dontAsk', maxConcurrent: 1, maxTurnTimeMins: 0 },
    groups: { G: { workdir: '/proj', provider: 'claude', allowedTools: ['Read'] }, H: { workdir: '/p2', provider: 'claude', allowedTools: ['Read'] } } })
  const busy = mkPlatform(), p = mkPlatform()
  const e = new Engine(cfg, { runner: slowRunner(200, { text: 'done' }), store: mkStore() })
  e.handleMessage(mkMsg('别的群占住并发', undefined, 'H'), busy); await tick()
  await e.handleMessage(mkCronMsg('站点巡检:在项目根执行 …'), p); await tick()
  const q = p.replies.filter((r) => /已排队/.test(r))
  assert.equal(q.length, 1, JSON.stringify(p.replies))
  assert.match(q[0], /^⏰ 定时任务已排队 — 当前有其它任务在跑/)
  assert.match(q[0], /自动运行/)
  assert.doesNotMatch(q[0], /\/stop/)
})

// ── 卡片底部小字:耗时与 tokens(2026-09-16 用户提)—— 口径与控制台「实时活动」详情底部一致 ──
test('engine: 卡片收尾时交给平台一行 footer —— 耗时 + tokens(↑ 含缓存,缓存另列)', async () => {
  const p = mkCardPlatform()
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '答案在这里。' })
    return { sessionId: 's', result: { text: '答案在这里。', usage: { input_tokens: 1200, output_tokens: 50, cache_read_input_tokens: 3000 } } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('问一下'), p); await tick()
  assert.equal(p.cards.length, 1)
  const f = p.cards[0].finishOpts && p.cards[0].finishOpts.footer
  assert.ok(f, `finishOpts 里该有 footer(拿到的是:${JSON.stringify(p.cards[0].finishOpts)})`)
  assert.match(f, /^耗时 \d+ 秒 · tokens ↑4\.2k ↓50$/)   // ↑ = 1200 + 缓存读 3000 = 4.2k(同控制台主数字);拆分故意不上卡
  assert.doesNotMatch(f, /缓存/)
  assert.equal(p.cards[0].finished, '答案在这里。')                      // 正文不受影响
})

test('engine: runner 没报用量 ⇒ footer 只有耗时;里程碑与 footer 同时存在互不挤占', async () => {
  const p = mkCardPlatform()
  const runner = okRunner(async ({ onEvent }) => {
    onEvent({ type: 'assistant', text: '>> 查了数据\n' })
    onEvent({ type: 'assistant', text: '结论:没问题。' })
    return { sessionId: 's', result: { text: '结论:没问题。' } }
  })
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('查一下'), p); await tick()
  const o = p.cards[0].finishOpts || {}
  assert.match(o.footer || '', /^耗时 \d+ 秒$/, JSON.stringify(o))
  assert.doesNotMatch(o.footer || '', /tokens/)
  assert.deepEqual(o.milestones, ['查了数据'])
})

// 后台进程纪律(v0.11.108):清单里要有「只许前台有限次数轮询、不起后台无限循环、浏览器页用完关」。
// 它是静态文本(指纹跨轮稳定),默认群就该有,不依赖任何能力开关。
test('engine: 清单注入【后台进程与浏览器页】纪律', async () => {
  const cfg = baseCfg()
  let captured
  const p = mkCardPlatform()
  const runner = okRunner(async (opts) => { captured = opts; opts.onEvent({ type: 'assistant', text: 'ok' }); return { sessionId: 's', result: { text: 'ok' } } })
  const eng = new Engine(cfg, { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('hi'), p); await tick()
  assert.match(captured.prompt, /【后台进程与浏览器页】/)
  assert.match(captured.prompt, /有限次数/)
  assert.match(captured.prompt, /绝不起后台无限 until \/ while 循环/)
  assert.match(captured.prompt, /关掉自己开的那一页/)
})

// 自知清单按平台自描述改写(core 不认识任何平台名,只读 platform.skillCmd / features / chatLabel):
// 换了命令名就整体替换;平台没有的能力(读历史 / 回复编辑撤回 / 表情 / 下载 / 画布)那几行不教 —— 教了 agent 就会去调不存在的动作;
// 入站媒体已落盘的平台,标记说明换成「直接读那个路径」。默认(飞书形状)一字不变。
test('engine: 清单按 platform.skillCmd / features 改写,默认形状不变', async () => {
  const cfg = baseCfg({ groups: { G: { workdir: '/proj', provider: 'claude', permissionMode: 'bypassPermissions' } } })
  const run = async (platform) => {
    const { r, get } = capRunner()
    const eng = new Engine(cfg, { runner: r, store: mkStore() })
    await eng.handleMessage(mkMsg('go'), platform); await tick()
    return get().prompt
  }
  const dflt = await run(mkPlatform())
  assert.match(dflt, /sbot feishu <动作>/); assert.match(dflt, /读历史:history \[条数\]  →  每条含/); assert.match(dflt, /message_id=…/); assert.match(dflt, /从飞书群驱动/)
  assert.match(dflt, /渲染成一张卡片/); assert.match(dflt, /send-msg 发的是\*\*纯文本消息\*\*/)
  assert.doesNotMatch(dflt, /sbot wecom/)
  const alt = Object.assign(mkPlatform(), { skillCmd: 'sbot wecom', chatLabel: '企业微信群', features: { editRecall: false, react: false, download: false, boards: false, imagen: false, cardPinned: false, plainSend: false, mediaMarker: 'path' } })
  const out = await run(alt)
  assert.match(out, /sbot wecom <动作>/); assert.doesNotMatch(out, /sbot feishu/)
  assert.match(out, /读历史:history \[条数\]  →  群里最近 7 天/, 'history 有,但说法换成「补上下文」'); assert.doesNotMatch(out, /按 id 操作/)
  assert.doesNotMatch(out, /撤回自己发的/); assert.doesNotMatch(out, /表情回应/); assert.doesNotMatch(out, /download <message_id>/)
  assert.doesNotMatch(out, /board-create/); assert.doesNotMatch(out, /上画布|画布播报卡|board-add/); assert.doesNotMatch(out, /渲染成一张卡片/); assert.doesNotMatch(out, /钉在本轮开始/)
  assert.match(out, /作为一条消息发出去/); assert.match(out, /send-msg 发的是 markdown 消息/)
  assert.match(out, /\[图片 path=…\]/); assert.match(out, /从企业微信群驱动/); assert.match(out, /群里单独发的图片 \/ 文件 \/ 视频\*\*只在「刚被 @ 过/)
  // 对照组:两份清单都有基础技能标题 —— 改写是替换不是删段
  assert.match(out, /【基础技能】/); assert.match(dflt, /【基础技能】/)
})

// ── 两车道(v0.11.115):@ 消息快车道 · 轮询来的不 @ 消息慢车道 ─────────────────────────────
// core 只认 msg.polled 这个布尔(投递方标)。三处:入队插到 polled 前 · 出队不混批 · 全局并发给 @ 留一个坑。

test('engine: Semaphore reserve —— 低优先级按软上限拿槽,给 @ 留一个坑;max ≤ 1 不留;交接只给够得着的等待者', async () => {
  const { Semaphore } = require('../../src/core/engine')
  const s = new Semaphore(2)
  await s.acquire(null, 1)                       // 轮询轮次占 1
  assert.equal(s.wouldBlock(1), true, '第二个轮询轮次拿不到(软上限 1)')
  assert.equal(s.wouldBlock(0), false, '@ 还能拿最后那个坑')
  let polledGot = false; const w = s.acquire(null, 1).then(() => { polledGot = true })
  await s.acquire(null, 0)                       // @ 拿走最后一个坑,cur = 2
  assert.equal(s.cur, 2)
  s.release()                                    // @ 结束:剩 1 个在用,等待的轮询仍不够软上限 ⇒ 不交接,cur 降 1
  await new Promise((r) => setImmediate(r))
  assert.equal(polledGot, false, '只剩一个坑时轮询等待者不接'); assert.equal(s.cur, 1)
  s.release()                                    // 跑着的轮询结束 ⇒ 交给等待的轮询(cur 保持 1)
  await w; assert.equal(polledGot, true); assert.equal(s.cur, 1)
  // 等待队列里 reserve=1 排在 reserve=0 前面时,只剩最后一个坑要越过它交给 @
  const s2 = new Semaphore(2); await s2.acquire(null, 1); await s2.acquire(null, 0)
  const order = []; const a = s2.acquire(null, 1).then(() => order.push('polled')); const b = s2.acquire(null, 0).then(() => order.push('at'))
  s2.release(); await b; assert.deepEqual(order, ['at'], '越过排在前面的轮询等待者,把坑交给 @')
  s2.release(); s2.release(); await a
  // max 1:没有坑可留,reserve 视为 0(否则轮询永远拿不到槽)
  const s1 = new Semaphore(1); assert.equal(s1.wouldBlock(1), false); await s1.acquire(null, 1); assert.equal(s1.cur, 1)
  // max 0 = 不限
  const s0 = new Semaphore(0); assert.equal(s0.wouldBlock(1), false); await s0.acquire(null, 1)
})

test('engine: 群忙时 @ 消息插到队里所有轮询消息之前;轮询消息之间、@ 之间仍按先后', async () => {
  const p = mkCardPlatform()
  const e = new Engine(baseCfg(), { runner: slowRunner(300, { text: 'done' }), store: mkStore() })
  e.handleMessage(mkMsg('占住群锁'), p); await tick()
  const polled = (t) => Object.assign(mkMsg(t), { polled: true })
  await e.handleMessage(polled('闲聊一'), p); await e.handleMessage(polled('闲聊二'), p)
  await e.handleMessage(mkMsg('@ 来的一'), p); await e.handleMessage(polled('闲聊三'), p); await e.handleMessage(mkMsg('@ 来的二'), p)
  await tick()
  assert.deepEqual(e._rt('G').queue.map((j) => j.msg.text), ['@ 来的一', '@ 来的二', '闲聊一', '闲聊二', '闲聊三'])
  assert.equal(e._visibleQueue(e._rt('G')), 2, '群里看到的排队数不含轮询消息')
})

test('engine: _runLen 不把 @ 与轮询消息混进一批(与 quiet 同一条纪律)', () => {
  const e = new Engine(baseCfg(), { runner: slowRunner(10, { text: 'x' }), store: mkStore() })
  const j = (t, polled, quiet) => ({ msg: Object.assign(mkMsg(t), { polled, quiet }) })
  assert.equal(e._runLen([j('a'), j('b'), j('c', true), j('d', true), j('e')]), 2)
  assert.equal(e._runLen([j('c', true), j('d', true), j('e')]), 2)
  assert.equal(e._runLen([j('c', true), j('q', true, true), j('d', true)]), 1, 'quiet 仍单独成段')
})

test('engine: 轮询消息在群忙时不发排队提示(对照组:@ 消息要发)', async () => {
  const mk = async (polled) => {
    const p = mkCardPlatform()
    const e = new Engine(baseCfg(), { runner: slowRunner(120, { text: 'done' }), store: mkStore() })
    e.handleMessage(mkMsg('占住群锁'), p); await tick()
    await e.handleMessage(Object.assign(mkMsg('那帮我看下'), { polled }), p); await tick()
    return p.replies.filter((r) => /已排队/.test(r))
  }
  assert.deepEqual(await mk(true), [], '轮询消息不该发排队提示')
  assert.ok((await mk(false)).length > 0, '对照组:@ 消息排队时必须提示')
})

test('engine: 等槽的轮询轮次握着群锁时,同群来了 @ ⇒ 就地把它提升为 @ 优先级(释放时能接到槽),不再被别的群拖住', async () => {
  const { Semaphore } = require('../../src/core/engine')
  // 信号量层:reserve=1 的等待者在只剩最后一个坑时不接;reserve 改成 0 后下一次释放就接
  const s = new Semaphore(2)
  await s.acquire(null, 1)                                   // 别的群的轮询轮次占 1
  await s.acquire(null, 0)                                   // 别的群的 @ 占 1 ⇒ 满
  let w = null; let got = false; const pend = s.acquire(null, 1, (x) => { w = x }).then(() => { got = true })
  assert.ok(w && w.reserve === 1, 'onWait 交出等待者对象')
  s.release(); await new Promise((r) => setImmediate(r))
  assert.equal(got, false, '只剩一个坑:轮询等待者不接(给 @ 留的)'); assert.equal(s.cur, 1)
  w.reserve = 0                                              // 同群来了 @ ⇒ 提升
  s.release(); await pend; assert.equal(got, true, '提升后下一次释放就接到槽')
  // 引擎层:_dispatch 在群忙 + 新 job 非 polled 时清零 rt.slotWaiter.reserve;polled 来了不清
  const e = new Engine(baseCfg(), { runner: slowRunner(10, { text: 'x' }), store: mkStore() })
  const rt = e._rt('G'); rt.busy = true; rt.slotWaiter = { reserve: 1, fn: () => {} }
  const p = mkCardPlatform()
  await e._dispatch({ msg: Object.assign(mkMsg('闲聊'), { polled: true }), platform: p, group: baseCfg().groups.G })
  assert.equal(rt.slotWaiter.reserve, 1, '轮询消息排队不提升')
  await e._dispatch({ msg: mkMsg('@ 来的'), platform: p, group: baseCfg().groups.G })
  assert.equal(rt.slotWaiter.reserve, 0, '@ 排队 ⇒ 正在等槽的轮询轮次按 @ 优先级拿槽')
})

test('engine: _enqueue 是入队唯一出口 —— front 只插到自己那一段的最前面,非 polled 永远在 polled 前面', () => {
  const e = new Engine(baseCfg(), { runner: slowRunner(10, { text: 'x' }), store: mkStore() })
  const rt = e._rt('G')
  const j = (t, polled) => ({ msg: Object.assign(mkMsg(t), { polled }) })
  e._enqueue(rt, j('p1', true)); e._enqueue(rt, j('a1')); e._enqueue(rt, j('p2', true)); e._enqueue(rt, j('a2'))
  assert.deepEqual(rt.queue.map((x) => x.msg.text), ['a1', 'a2', 'p1', 'p2'])
  e._enqueue(rt, j('p0', true), { front: true })   // 轮询的空轮重试:插到轮询段最前,不越过 @
  assert.deepEqual(rt.queue.map((x) => x.msg.text), ['a1', 'a2', 'p0', 'p1', 'p2'])
  e._enqueue(rt, j('a0'), { front: true })         // @ 的重试:队首
  assert.deepEqual(rt.queue.map((x) => x.msg.text), ['a0', 'a1', 'a2', 'p0', 'p1', 'p2'])
  assert.equal(e._runLen(rt.queue), 3, '出队先吃完 @ 段'); assert.equal(e._visibleQueue(rt), 3)
})

// ── 命令清单的单一事实源(v0.11.59:Slack 那边 `/` 被平台占了,适配器要按这份清单还原前缀)──

test('SLASH_COMMANDS 必须与 _handleCommand 的 case 标签逐条对上', () => {
  // ⭐ 清单从源码里抠出来比对,而不是靠人记得两处一起改 —— 与 cli-help 那条同一手法。
  const src = require('node:fs').readFileSync(require.resolve('../../src/core/engine.js'), 'utf8')
  const cases = [...src.matchAll(/^\s*case '(\/[a-z]+)':/gm)].map((m) => m[1])
  const { SLASH_COMMANDS } = require('../../src/core/engine')
  assert.deepEqual([...SLASH_COMMANDS].sort(), [...new Set(cases)].sort(), '新增群内命令时,SLASH_COMMANDS 要一起加')
  assert.ok(cases.length >= 8, '把 case 标签抠出来这件事本身也要有分辨力 —— 抠不到就不是"全对上了"')
})

test('engine: 群里的产品名走顶层 brand 配置(不配 = SintBot)', async () => {
  const grab = async (cfg) => {
    let captured
    const eng = new Engine(cfg, { runner: okRunner((o) => { captured = o; return Promise.resolve({ sessionId: 's1', result: { text: 'ok' } }) }), store: mkStore() })
    await eng.handleMessage(mkMsg('hi'), mkPlatform()); await tick()
    return captured.prompt
  }
  // 不配:默认名
  const old = await grab(baseCfg())
  assert.match(old, /【你是 SintBot】/)
  assert.match(old, /身份就是 SintBot 一个整体/)
  // 配了:两处一起换,旧名一个字都不许剩(只换一处 = agent 自称新名却又说自己是旧名)
  const neo = await grab(baseCfg({ brand: 'AcmeBot' }))
  assert.match(neo, /【你是 AcmeBot】/)
  assert.match(neo, /身份就是 AcmeBot 一个整体/)
  assert.doesNotMatch(neo, /SintBot/)
})

// ── 续接的会话记录已不在(runner 标 sessionGone;典型是 Claude Code 清掉 30 天没动过的会话记录)──
const goneRunner = (calls, { delayMs = 0, after = '新会话的答案' } = {}) => okRunner(async ({ sessionId }) => {
  calls.push(sessionId === undefined ? null : sessionId)
  if (delayMs) await wait(delayMs)
  if (sessionId) return { sessionId, result: { isError: true, subtype: 'error_during_execution', text: `No conversation found with session ID: ${sessionId}`, sessionGone: true } }
  return { sessionId: 'fresh', result: { text: after } }
})

test('engine: 续接的会话记录已不在 ⇒ 换新会话重做这条,群里只有说明 + 答案,不报错', async () => {
  const calls = []
  const store = mkStore(); store.setSession('G', 'dead')
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner: goneRunner(calls), store })
  await eng.handleMessage(mkMsg('改一下首页'), p)
  for (let i = 0; i < 12; i++) await tick()
  assert.deepEqual(calls, ['dead', null], '第二次必须不带旧 id')
  assert.deepEqual(p.replies.map((r) => r.replace(/ —— .*/, '')), ['🔄 上一段对话的记录已过期清理,已自动开新会话重做这条', '新会话的答案'])
  assert.equal(store.getSession('G'), 'fresh', '新会话落盘,后面的消息接着它')
})

test('engine: 会话记录已不在 + 卡上只有回执 ⇒ 撤卡,不留英文报错卡', async () => {
  const calls = []
  const store = mkStore(); store.setSession('G', 'dead')
  const p = mkCardPlatform()
  const eng = new Engine(ackCfg(20), { runner: goneRunner(calls, { delayMs: 60 }), store })
  await eng.handleMessage(mkMsg('改一下首页'), p)
  await wait(300)
  assert.deepEqual(calls, ['dead', null])
  assert.equal(p.cards[0].recalled, true, '第一张(只有回执)要撤掉')
  assert.ok(!p.cards.some((c) => /No conversation found/.test(c.finished || '')), '任何卡上都不该出现 CLI 原话')
  assert.match(p.replies[0], /记录已过期清理/)
})

test('engine: 新会话本身报同样的错 ⇒ 不再重做(最多一次),照常出错', async () => {
  const calls = []
  const runner = okRunner(async ({ sessionId }) => {
    calls.push(sessionId === undefined ? null : sessionId)
    return { sessionId: 'x', result: { isError: true, text: 'No conversation found with session ID: x', sessionGone: true } }
  })
  const store = mkStore(); store.setSession('G', 'dead')
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner, store })
  await eng.handleMessage(mkMsg('q'), p)
  for (let i = 0; i < 12; i++) await tick()
  assert.equal(calls.length, 2)
  assert.equal(p.replies.length, 2, '说明一句 + 第二次的出错一句')
  assert.match(p.replies[1], /No conversation found/)
})

test('engine: 新开的会话(没有续接)报这个错 ⇒ 不当成「记录过期」处理', async () => {
  const calls = []
  const runner = okRunner(async ({ sessionId }) => {
    calls.push(sessionId === undefined ? null : sessionId)
    return { sessionId: 'x', result: { isError: true, text: 'No conversation found with session ID: x', sessionGone: true } }
  })
  const p = mkPlatform()
  const eng = new Engine(baseCfg(), { runner, store: mkStore() })
  await eng.handleMessage(mkMsg('q'), p)
  for (let i = 0; i < 12; i++) await tick()
  assert.equal(calls.length, 1)
  assert.ok(!p.replies.some((r) => /记录已过期/.test(r)))
})

// 1.0.3:真实轮次的成败交给凭据验证记录(verifyTurn),doctor / 控制台概览据此报「能用 / key 不对」。
// 叫停的轮不算证据;出错轮把原话交过去,由记录那侧判是不是认证问题。
test('engine: verifyTurn —— ok 轮报成功、出错轮带原话报失败、叫停的轮不报', async () => {
  const calls = []
  const verifyTurn = (p, ok, text) => calls.push({ ok, text, hasProvider: !!p })
  const run = async (result, aborted = false) => {
    const eng = new Engine(baseCfg(), { runner: okRunner(async () => ({ sessionId: 's', aborted, result })), store: mkStore(), verifyTurn })
    await eng.handleMessage(mkMsg('x'), mkPlatform()); await tick()
  }
  await run({ text: '好的' })
  await run({ isError: true, text: 'API Error: 401 authentication_error' })
  await run({ text: '' }, true)
  assert.deepEqual(calls, [{ ok: true, text: '好的', hasProvider: true }, { ok: false, text: 'API Error: 401 authentication_error', hasProvider: true }])
})
