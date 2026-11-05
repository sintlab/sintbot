// AgentRunner pure helpers — provider env construction + stream-json event
// normalization, plus the spawn/settle loop driven through an injected `spawnFn`
// (same shape as codexcode's; no real `claude` is ever launched here).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { buildEnv, normalizeEvent, runTurn, BASE_SKILL_ALLOWS } = require('../../src/agent/claudecode')

test('BASE_SKILL_ALLOWS: 飞书 + 定时任务两个基础技能都自动放行(即使只读/开发档)', () => {
  // 群项目基础技能须在任何权限档下可用 —— 否则清单宣传了却被 fail-closed 拒(0.3.0 漏了 cron)。
  assert.ok(BASE_SKILL_ALLOWS.includes('Bash(sbot feishu *)'))
  assert.ok(BASE_SKILL_ALLOWS.includes('Bash(sbot cron *)'))
})

test('BASE_SKILL_ALLOWS: 企业微信群的基础技能 sbot wecom 也放行 —— 清单教了它,只读档不能 fail-closed 拒掉', () => {
  assert.ok(BASE_SKILL_ALLOWS.includes('Bash(sbot wecom *)'))
})

test('buildEnv: custom provider sets ANTHROPIC_* and blanks the api key', () => {
  const env = buildEnv({ baseUrl: 'https://api.x/anthropic', apiKey: 'tok-123', model: 'glm-5.2' })
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.x/anthropic')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-123')
  assert.equal(env.ANTHROPIC_MODEL, 'glm-5.2')
  assert.equal(env.ANTHROPIC_API_KEY, undefined) // blanked so the CLI won't validate it upstream
})

test('buildEnv: no baseUrl (claude login) leaves base unset, keeps process env', () => {
  process.env.__SBOT_KEEP = 'yes'
  const env = buildEnv({ model: 'claude-opus-4-8' })
  assert.equal(env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(env.ANTHROPIC_MODEL, 'claude-opus-4-8')
  assert.equal(env.__SBOT_KEEP, 'yes')
  delete process.env.__SBOT_KEEP
})

test('buildEnv: extraEnv (SBOT_CHAT_ID) is merged without disturbing provider isolation', () => {
  const env = buildEnv({ baseUrl: 'https://api.x/anthropic', apiKey: 'tok', model: 'm' }, undefined, { SBOT_CHAT_ID: 'oc_abc' })
  assert.equal(env.SBOT_CHAT_ID, 'oc_abc')          // base-skill context reaches the spawn
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.x/anthropic') // provider env still intact
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok')
})

test('buildEnv: provider.env overrides are layered on top', () => {
  const env = buildEnv({ baseUrl: 'https://x', apiKey: 'k', env: { API_TIMEOUT_MS: '3000000', CUSTOM: '1' } })
  assert.equal(env.API_TIMEOUT_MS, '3000000')
  assert.equal(env.CUSTOM, '1')
})

test('buildEnv: baseUrlOverride replaces the base (vision strip-proxy) but keeps auth', () => {
  const env = buildEnv({ baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'tok-1', vision: false }, 'http://127.0.0.1:5555/abc')
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5555/abc') // points at the local proxy
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-1')                    // real auth still flows through
})

test('buildEnv: clears inherited ANTHROPIC_* the provider does not define', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://stale.example/anthropic'
  process.env.ANTHROPIC_AUTH_TOKEN = 'stale-tok'
  process.env.ANTHROPIC_MODEL = 'stale-model'
  try {
    const env = buildEnv({}) // logged-in claude: defines none of them
    assert.equal(env.ANTHROPIC_BASE_URL, undefined)
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
    assert.equal(env.ANTHROPIC_MODEL, undefined)
  } finally {
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_MODEL
  }
})

test('buildEnv: provider.env can still deliberately set a cleared ANTHROPIC_* var', () => {
  process.env.ANTHROPIC_MODEL = 'stale-model'
  try {
    const env = buildEnv({ env: { ANTHROPIC_MODEL: 'forced' } })
    assert.equal(env.ANTHROPIC_MODEL, 'forced') // provider.env wins over the clearing
  } finally { delete process.env.ANTHROPIC_MODEL }
})

test('buildEnv: ANTHROPIC_API_KEY passes through for a keyless provider (direct API auth)', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-direct'
  try {
    assert.equal(buildEnv({}).ANTHROPIC_API_KEY, 'sk-direct')       // kept: legitimate auth path
    assert.equal(buildEnv({ baseUrl: 'https://x', apiKey: 'k' }).ANTHROPIC_API_KEY, undefined) // blanked when a token is set
  } finally { delete process.env.ANTHROPIC_API_KEY }
})

test('buildEnv: strips CLAUDECODE (avoid nested-session detection)', () => {
  process.env.CLAUDECODE = '1'
  const env = buildEnv({})
  assert.equal(env.CLAUDECODE, undefined)
  delete process.env.CLAUDECODE
})

test('normalizeEvent: system init carries sessionId', () => {
  const e = normalizeEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' })
  assert.equal(e.type, 'system')
  assert.equal(e.subtype, 'init')
  assert.equal(e.sessionId, 'sess-1')
})

test('normalizeEvent: assistant extracts text / thinking / tools', () => {
  const e = normalizeEvent({ type: 'assistant', session_id: 's', message: { content: [
    { type: 'text', text: 'hello ' }, { type: 'text', text: 'world' },
    { type: 'thinking', thinking: 'hmm' },
    { type: 'tool_use', name: 'Read', input: { file: 'a' } },
  ] } })
  assert.equal(e.text, 'hello world')
  assert.equal(e.thinking, 'hmm')
  assert.deepEqual(e.tools, [{ name: 'Read', input: { file: 'a' } }])
})

test('normalizeEvent: result carries text / isError / usage', () => {
  const e = normalizeEvent({ type: 'result', subtype: 'success', result: 'done', is_error: false, usage: { input_tokens: 5, output_tokens: 7 }, session_id: 's' })
  assert.equal(e.type, 'result')
  assert.equal(e.text, 'done')
  assert.equal(e.isError, false)
  assert.deepEqual(e.usage, { input_tokens: 5, output_tokens: 7 })
})

test('normalizeEvent: unknown type falls through to { type, raw }', () => {
  const e = normalizeEvent({ type: 'weird', foo: 1 })
  assert.equal(e.type, 'weird')
  assert.deepEqual(e.raw, { type: 'weird', foo: 1 })
})

// ── CLI 能力探测(supportsFlag)──────────────────────────────────────────────
// 由来:v0.11.17 起无条件传 `--autocompact`,而 生产机装的 claude 2.1.207 不认它 ⇒ 凡走 claude
// runner 的 provider **每轮必崩**,潜伏 4 天(那个群一直跑 codex,走的是另一条参数)。
// ⚠ 判据必须是「问 CLI 支持什么」而不是「版本号比大小」—— 引入版本的确切边界我们并不知道,
// 只知道 2.1.207 没有、2.1.222 有;猜边界两头都会错。这几条用真脚本当假 CLI 钉死四种情形。
const { supportsFlag } = require('../../src/agent/claudecode')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

// 造一个「--help 会打印指定文本」的可执行脚本当假 CLI。每次执行往 tally 追加一行 ⇒ 数得出
// 它到底被 spawn 了几次(用来验缓存)。
function fakeCli(name, helpText, { exitCode = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-flag-'))
  const bin = path.join(dir, name)
  const tally = path.join(dir, 'tally')
  fs.writeFileSync(bin, `#!/bin/sh\necho run >> "${tally}"\ncat <<'H'\n${helpText}\nH\nexit ${exitCode}\n`)
  fs.chmodSync(bin, 0o755)
  return { bin, runs: () => (fs.existsSync(tally) ? fs.readFileSync(tally, 'utf8').trim().split('\n').length : 0) }
}

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX 专用(假 CLI 用 sh 脚本)' : false }

test('supportsFlag: --help 里有该旗子 ⇒ true', posixOnly, async () => {
  const f = fakeCli('claude-new', 'Usage: claude [options]\n  --autocompact <n>  compact at n tokens\n  --resume <id>')
  assert.equal(await supportsFlag(f.bin, '--autocompact'), true)
})

test('supportsFlag: --help 里没有该旗子 ⇒ false(老 CLI,正是 2.1.207 那种)', posixOnly, async () => {
  const f = fakeCli('claude-old', 'Usage: claude [options]\n  --resume <id>\n  --model <m>')
  assert.equal(await supportsFlag(f.bin, '--autocompact'), false)
})

test('supportsFlag: 探不出来 ⇒ null,与「确定不支持」分开', posixOnly, async () => {
  // ⚠ null ≠ false:两者调用方都不传旗子(降级好过每轮崩),但 doctor 要把它们说成两件事 ——
  // 「CLI 太旧,升级即可」和「探测本身没跑通」的下一步动作完全不同。
  assert.equal(await supportsFlag(path.join(os.tmpdir(), 'sbot-no-such-bin-xyz'), '--autocompact'), null)
  const bad = fakeCli('claude-broken', 'boom', { exitCode: 3 })
  assert.equal(await supportsFlag(bad.bin, '--autocompact'), null)
})

test('supportsFlag: 按 bin 缓存 ⇒ 并发多轮只探一次', posixOnly, async () => {
  // 每轮 spawn 一次 `--help` 是白付的成本;缓存的是 Promise 不是结果,所以并发也只探一次。
  const f = fakeCli('claude-cached', '  --autocompact <n>')
  const [a, b, c] = await Promise.all([
    supportsFlag(f.bin, '--autocompact'),
    supportsFlag(f.bin, '--autocompact'),
    supportsFlag(f.bin, '--autocompact'),
  ])
  assert.deepEqual([a, b, c], [true, true, true])
  assert.equal(await supportsFlag(f.bin, '--autocompact'), true) // 第四次:走缓存
  assert.equal(f.runs(), 1, '同一 bin 应只 spawn 一次 --help')
})

test('supportsFlag: 缓存带 TTL —— 升级 claude 后不必重启 daemon 也会重探', posixOnly, async () => {
  // ⚠ 由来:2026-08-13 事故的止血手法就是「升级机器上的 claude、daemon 全程不重启」。
  // 若永久缓存,升级完 daemon 仍拿旧答案不传旗子,而 doctor(另一个进程)会说「可用」——
  // 两个消费者读不同来源、一个长期正确掩护另一个长期失效,正是教训 26 的形状。
  const f = fakeCli('claude-ttl', 'Usage: claude\n  --resume <id>')   // 先扮老版本
  const t0 = 1_700_000_000_000
  assert.equal(await supportsFlag(f.bin, '--autocompact', t0), false)
  assert.equal(await supportsFlag(f.bin, '--autocompact', t0 + 30_000), false, '30s 内走缓存')
  assert.equal(f.runs(), 1)

  // 机器上把 claude 升了(脚本改成会打印那个旗子),但 daemon 没重启
  fs.writeFileSync(f.bin, `#!/bin/sh\necho run >> "${path.join(path.dirname(f.bin), 'tally')}"\necho '  --autocompact <n>'\n`)
  fs.chmodSync(f.bin, 0o755)
  assert.equal(await supportsFlag(f.bin, '--autocompact', t0 + 30_000), false, 'TTL 内仍用旧结论')
  assert.equal(await supportsFlag(f.bin, '--autocompact', t0 + 11 * 60_000), true, 'TTL 过期后重探,拿到新结论')
  assert.equal(f.runs(), 2)
})

// ── 关流式宽限期的强制收尾 = 「下一轮空轮」的紧前一枚指纹 ─────────────────────────
// 2026-09-05 真机:同一天三次 `status:"empty"`,claude 进程 0.5 秒内零产出退出。
// 从 claude 会话 transcript 逐条对出来的链条是:
//   上一轮起了后台命令(`Bash` 的 run_in_background)⇒ 答案给完进程也不肯退 ⇒ 这里的宽限期
//   到点强杀 ⇒ 那个后台任务没有留下收尾记录 ⇒ 下一次 `--resume` 时 CLI 先把一条
//   `<task-notification>`(上一轮的后台任务没有结果)排进队列、**排在我们的 prompt 前面** ⇒
//   那一轮零 API 调用、零产出退出(engine 记 empty,静默重试一次)。
// ⭐ 判据的分辨力全在**对照**上,所以下面三条必须一起在:强杀留痕 · 自然退出**不留痕** ·
//   人为中止**不留痕**。少了后两条,这行日志每轮都出现,等于没有判据。
function fakeClaudeChild() {
  const child = new EventEmitter()
  child.pid = 5150
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { on() {}, end() {} }
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  child.emitLine = (obj) => child.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  return child
}
const RESULT_LINE = { type: 'result', subtype: 'success', session_id: 'sid-1', result: '好了', usage: {} }

test('runTurn: 答案已到而进程不肯退 ⇒ 宽限期强制收尾,并留下取证行', async () => {
  const child = fakeClaudeChild()
  const logs = []
  const p = runTurn({ prompt: 'hi', provider: {}, closeGraceMs: 20, log: (m) => logs.push(m), spawnFn: () => child })
  await new Promise((r) => setImmediate(r)) // launch 在微任务里
  child.emitLine(RESULT_LINE) // 答案到了 —— 从这一刻起计宽限期
  const out = await p               // 'close' 永不到来,只能靠宽限期兜住(never-hang 不变量)
  assert.equal(child.killed, true, '不肯退的进程必须被收掉,否则群锁一直被占')
  assert.equal(out.result.text, '好了') // 强制收尾不丢答案
  const line = logs.find((m) => /强制收尾/.test(m))
  assert.ok(line, '这一行是下一轮空轮的唯一前置线索,没有它只能看到孤零零一个 empty')
  assert.match(line, /20ms 内没退出/)
  assert.match(line, /run_in_background/) // 指名到具体机制,否则拿到日志的人不知道去查什么
  assert.match(line, /下一轮可能空转/)     // 说清代价落在**下一条消息**上,不是这一轮
})

test('runTurn: 进程自己退干净 ⇒ 一个字都不留(对照组 —— 否则这行日志没有分辨力)', async () => {
  const child = fakeClaudeChild()
  const logs = []
  const p = runTurn({ prompt: 'hi', provider: {}, closeGraceMs: 20, log: (m) => logs.push(m), spawnFn: () => child })
  await new Promise((r) => setImmediate(r))
  child.emitLine(RESULT_LINE)
  child.emit('close', 0) // 真机 09-05 03:19 那轮:答案后 202ms 就 close,后面一次 empty 都没有
  await p
  await new Promise((r) => setTimeout(r, 40)) // 熬过宽限期,确认残留定时器没有偷偷补打一行
  assert.equal(child.killed, false, '自然退出的进程不该被杀')
  assert.equal(logs.length, 0, '常态每轮都打 = 真正出事那一行被淹掉')
})

test('runTurn: 人为中止(/stop・撤回・墙钟)同样走宽限期,但不留那行 —— 那是预期内的杀', async () => {
  const child = fakeClaudeChild()
  const logs = []
  const ac = new AbortController()
  const p = runTurn({ prompt: 'hi', provider: {}, closeGraceMs: 20, softStopGraceMs: 5, log: (m) => logs.push(m), signal: ac.signal, spawnFn: () => child })
  await new Promise((r) => setImmediate(r))
  ac.abort()
  const out = await p
  assert.equal(out.aborted, true)
  assert.equal(logs.some((m) => /强制收尾/.test(m)), false, '每次 /stop 都留一行像故障的话,真正的那条就找不着了')
})

// ── key 错快速失败(1.0.3):第一次 api_retry 带 401 / 403 就收尾,不等 claude 重试约 3 分钟 ──────────
// 只对 key 型模型(有 baseUrl);订阅登录的 401 可能是 CLI 在刷新登录,照旧让它重试;过载(529)也照旧重试。
const RETRY = (status) => ({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 565, error_status: status, error: status === 401 ? 'authentication_failed' : 'overloaded', session_id: 'sid-1' })

test('runTurn: key 型模型第一次重试报 401 ⇒ 当场收尾,出错 result 标 account、说人话,不留强制收尾那行', async () => {
  const child = fakeClaudeChild()
  const logs = []; const events = []
  const p = runTurn({ prompt: 'hi', provider: { baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'k' }, closeGraceMs: 20, log: (m) => logs.push(m), onEvent: (e) => events.push(e), spawnFn: () => child })
  await new Promise((r) => setImmediate(r))
  child.emitLine(RETRY(401))
  const out = await p
  assert.equal(child.killed, true)
  assert.equal(out.aborted, false, '不是人叫停的')
  assert.equal(out.result.isError, true)
  assert.equal(out.result.quota.kind, 'account', '与重试耗尽后的 authentication_error 同一档:备用模型 / 告警照走')
  assert.match(out.result.text, /HTTP 401.*key 不对或已失效/)
  assert.equal(events.filter((e) => e.type === 'result').length, 1, '渲染侧也看得到这条 result')
  assert.equal(logs.some((m) => /强制收尾/.test(m)), false)
})

test('runTurn: 订阅登录(无 baseUrl)的 401、key 型模型的 529 ⇒ 都不拦,等 CLI 自己重试', async () => {
  for (const [provider, status] of [[{}, 401], [{ baseUrl: 'https://x', apiKey: 'k' }, 529]]) {
    const child = fakeClaudeChild()
    const p = runTurn({ prompt: 'hi', provider, closeGraceMs: 20, spawnFn: () => child })
    await new Promise((r) => setImmediate(r))
    child.emitLine(RETRY(status))
    assert.equal(child.killed, false, `${status} 不该被拦`)
    child.emitLine(RESULT_LINE); child.emit('close', 0)
    assert.equal((await p).result.text, '好了')
  }
})

// ── 瞬时错(API 过载)标人话,与 codex 侧同一份判据 ──────────────────────────────
// ⚠ 夹具照 2.1.260 二进制里的**真实形状**写(2026-09-08 审查核对):① error_during_execution / error_max_turns
//   的原因在 errors[] 里、**没有 result**;② API 过载是 subtype success + is_error + result 带「API Error: 529 …」。
//   第一版夹具写成「error_during_execution + result」—— 那种形状 CLI 根本不发,测试绿着、生产上永远不命中。
test('normalizeEvent: 出错结果的原因从 errors[] 或 result 取;过载类标 transient;非过载 / 成功不标', () => {
  const RAW = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
  // ① 真实形状:原因只在 errors[],result 缺席
  const a = normalizeEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [RAW], session_id: 's' })
  assert.equal(a.text, RAW, '原因要从 errors[] 补进 text,否则账本与卡片都是空')
  assert.ok(a.transient && a.transient !== RAW, '应标一句人话(措辞由 transienterr.test 钉,这里不钉)')
  // ② 真实形状:API 过载 = success + is_error + result
  const b = normalizeEvent({ type: 'result', subtype: 'success', is_error: true, result: RAW, session_id: 's' })
  assert.equal(b.text, RAW)
  assert.ok(b.transient && b.transient !== RAW)
  // 对照:非过载的 errors[] 照样进 text,但不标 transient
  const plain = normalizeEvent({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['轮次上限', '第二条'], session_id: 's' })
  assert.equal(plain.text, '轮次上限; 第二条')
  assert.equal(plain.transient, undefined)
  // 对照:成功轮 result 原样、不看 errors、不标(哪怕正文提到 overloaded)
  const ok = normalizeEvent({ type: 'result', subtype: 'success', result: 'the server was overloaded yesterday', is_error: false, errors: ['x'], session_id: 's' })
  assert.equal(ok.text, 'the server was overloaded yesterday')
  assert.equal(ok.transient, undefined)
})

// 压缩事件的量(v0.11.93):2.1.260 真机核对 —— 会话文件里 compactMetadata.preTokens=187836,SDK 输出层
// 的名字是 compact_metadata.pre_tokens(二进制里两种拼法都在)。两种都认;没有就不编数。
test('normalizeEvent: compact_boundary 的 pre/post tokens 两种拼法都透传;缺失不编数', () => {
  const a = normalizeEvent({ type: 'system', subtype: 'compact_boundary', session_id: 's', compact_metadata: { trigger: 'auto', pre_tokens: 187836, post_tokens: 153045 } })
  assert.deepEqual(a, { type: 'system', subtype: 'compact_boundary', sessionId: 's', preTokens: 187836, postTokens: 153045 })
  const b = normalizeEvent({ type: 'system', subtype: 'compact_boundary', session_id: 's', compactMetadata: { trigger: 'auto', preTokens: 1000 } })
  assert.equal(b.preTokens, 1000); assert.equal('postTokens' in b, false)
  const c = normalizeEvent({ type: 'system', subtype: 'compact_boundary', session_id: 's' })
  assert.equal('preTokens' in c, false); assert.equal(c.subtype, 'compact_boundary')
})

// 额度 / 账号类出错结果标 quota(v0.11.107,判据在 agent/quotaerr;这里只钉「runner 把字段挂上了」)
test('normalizeEvent: 额度用尽 / 账号不可用的出错结果标 quota;其它出错与成功轮不标', () => {
  const { normalizeEvent } = require('../../src/agent/claudecode')
  const weekly = "You've hit your weekly limit · resets Oct 1 at 9am (Asia/Shanghai)"
  const a = normalizeEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [weekly], session_id: 's' })
  assert.deepEqual(a.quota, { kind: 'quota', window: 'weekly' }); assert.equal(a.text, weekly, '原话仍留给账本')
  const b = normalizeEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Failed to authenticate: OAuth session expired and could not be refreshed'], session_id: 's' })
  assert.equal(b.quota && b.quota.kind, 'account')
  assert.equal(normalizeEvent({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['轮次上限'], session_id: 's' }).quota, undefined)
  // 成功轮哪怕正文提到 limit 也不标(只看出错结果)
  assert.equal(normalizeEvent({ type: 'result', subtype: 'success', is_error: false, result: "we've hit your weekly limit of jokes", session_id: 's' }).quota, undefined)
})

// 续接的会话记录已不在:夹具照 claude 2.1.302 实测的真实形状(原因只在 errors[],session_id 回的是那个死 id)
test('normalizeEvent: 「No conversation found with session ID」标 sessionGone;别的错不标', () => {
  const gone = normalizeEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, result: null, errors: ['No conversation found with session ID: 9b1c2d3e-0000-4000-8000-000000000000'], session_id: '9b1c2d3e-0000-4000-8000-000000000000' })
  assert.equal(gone.sessionGone, true)
  assert.equal(gone.isError, true)
  const other = normalizeEvent({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['轮次上限'], session_id: 's' })
  assert.equal(other.sessionGone, undefined)
  const ok = normalizeEvent({ type: 'result', subtype: 'success', is_error: false, result: '日志里出现过 No conversation found with session ID 这句', session_id: 's' })
  assert.equal(ok.sessionGone, undefined, '成功轮的正文提到这句也不算')
})

// 模型程序找不到(配置路径与各候选位置都没有):群里只说人话,路径只进日志;code 给引擎发运维告警(原话带路径,不能进群)
test('runTurn: spawn ENOENT ⇒ 错误文案是人话(零路径零产品名)+ code=AGENT_BIN_MISSING,路径进 log;别的 spawn 错照旧裸抛', async () => {
  { const child = fakeClaudeChild(), logs = []
    const p = runTurn({ prompt: 'hi', provider: {}, bin: '/nonexistent/x/claude', closeGraceMs: 20, log: (m) => logs.push(m), spawnFn: () => child })
    await new Promise((r) => setImmediate(r))
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    const e = await p.then(() => null, (x) => x)
    assert.ok(e); assert.equal(e.code, 'AGENT_BIN_MISSING')
    assert.equal(e.message, '模型程序在这台机器上找不到了,需要管理员处理')
    assert.ok(logs.some((m) => /cannot find agent binary '\/nonexistent\/x\/claude'/.test(m)), '路径在日志里,排障够用') }
  { const child = fakeClaudeChild()
    const p = runTurn({ prompt: 'hi', provider: {}, bin: '/nonexistent/x/claude', closeGraceMs: 20, spawnFn: () => child })
    await new Promise((r) => setImmediate(r))
    child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))
    const e = await p.then(() => null, (x) => x)
    assert.ok(e && e.code === 'EACCES' && /EACCES/.test(e.message), '对照组:非 ENOENT 不改口径') }
})
