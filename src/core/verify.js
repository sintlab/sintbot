// 凭据「最近一次验证」的记录:doctor 与控制台概览据此区分「配了」和「能用」(1.0.3)。
// 此前两边只看配没配 —— key 试跑失败、飞书预检失败时照样「0 失败」「全部正常」,要到群里跑一轮才炸。
//
// 按凭据指纹记(sha256 前 12 位,不存原文):换了 key 指纹就变,状态自然回到「未验证」,不用谁去清旧记录。
// 写入方:向导试跑与平台预检、控制台的模型测试与平台预检、真实轮次(成功记能用,认证失败记失败)。
// 存 ~/.sbot/verify.json(600)。真实轮次每轮都会报一次 ⇒ 状态没变且距上次写盘不到 6 小时就不写。
// 读写出错一律静默:这只是体检的参考信息,不能因为它挡住轮次或启动。

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { atomicWriteJSON } = require('./store')

const REFRESH_MS = 6 * 3600 * 1000
const defaultFile = () => path.join(os.homedir(), '.sbot', 'verify.json')

// kind 区分凭据种类(provider / feishu / slack),parts 是决定「是不是同一份凭据」的字段;有一项为空 ⇒ ''(不记)
function fingerprint(kind, ...parts) {
  if (!parts.length || parts.some((x) => x == null || String(x) === '')) return ''
  return crypto.createHash('sha256').update([kind, ...parts.map(String)].join('\0')).digest('hex').slice(0, 12)
}
// API key 型模型(有 baseUrl):端点 + key。订阅登录 / codex 没有可记的凭据,另有本机登录态探测。
const providerFp = (p) => (p && p.baseUrl && p.apiKey ? fingerprint('provider', p.baseUrl, p.apiKey) : '')
const feishuFp = (fe) => (fe ? fingerprint('feishu', fe.appId, fe.appSecret) : '')
const slackFp = (sl) => (sl ? fingerprint('slack', sl.botToken, sl.appToken) : '')

function readAll(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {} } catch { return {} }
}

// → { ok, at, reason } | null
function lookup(fp, { file = defaultFile() } = {}) {
  if (!fp) return null
  const r = readAll(file)[fp]
  return r && typeof r.ok === 'boolean' ? r : null
}

// reason:失败原因(给人看的一句话,不带凭据);成功时忽略
function record(fp, ok, reason = '', { file = defaultFile(), now = Date.now() } = {}) {
  if (!fp) return false
  try {
    const all = readAll(file)
    const prev = all[fp]
    const why = ok ? '' : String(reason || '').slice(0, 200)
    if (prev && prev.ok === ok && (prev.reason || '') === why && now - Date.parse(prev.at) < REFRESH_MS) return false
    all[fp] = { ok, at: new Date(now).toISOString(), ...(why ? { reason: why } : {}) }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    atomicWriteJSON(file, all, { mode: 0o600 })
    return true
  } catch { return false }
}

// 一次试跑 / 真实轮次的结果 → 记一笔。只认凭据层面的结论:成功记能用;认证失败、账户不能用(欠费 / 未实名)
// 记失败;网络、超时、模型名这类与凭据无关的失败不动原记录。
function recordTurn(provider, ok, text = '', opts) {
  const fp = providerFp(provider)
  if (!fp) return false
  if (ok) return record(fp, true, '', opts)
  const why = require('../setupmodels').explainTestFailure(text, { baseUrl: provider.baseUrl })
  return why.kind === 'auth' || why.kind === 'balance' ? record(fp, false, why.text, opts) : false
}

// 平台预检(feishuPrecheck / slackPrecheck 的 checks)→ 记一笔。飞书看「bot 身份」那项(凭据 + 机器人能力
// 一次验完);Slack 看 bot 凭据与 Socket Mode 两项。权限缺项只降级不算凭据失败,不在这里记。
const PRECHECK_KEYS = { feishu: ['bot'], slack: ['auth', 'socket'] }
function recordPrecheck(kind, creds, checks, opts) {
  const fp = kind === 'feishu' ? feishuFp(creds) : kind === 'slack' ? slackFp(creds) : ''
  if (!fp || !Array.isArray(checks)) return false
  const rows = (PRECHECK_KEYS[kind] || []).map((k) => checks.find((c) => c && c.key === k))
  const bad = rows.find((c) => c && c.status === 'fail')
  if (bad) return record(fp, false, `${bad.label}:${bad.detail || ''}`, opts)
  return rows.every((c) => c && c.status === 'ok') ? record(fp, true, '', opts) : false
}

// 体检行用的时间:今天写「HH:mm」,更早写「M 月 D 日」
function when(at, now = Date.now()) {
  const d = new Date(at)
  if (isNaN(d)) return ''
  const n = new Date(now)
  const pad = (x) => String(x).padStart(2, '0')
  return d.toDateString() === n.toDateString() ? `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

// 试跑一轮用的提示词(向导试跑与控制台「模型 → 测试」共用)。不让模型自报身份:走 Claude Code 的第三方模型
// 常照系统提示自称 Claude,新用户会以为没切成;型号由调用方按配置显示
const TRIAL_PROMPT = '用一句话回复,说明你已准备好开始工作。'
const TRIAL_PROMPT_EN = 'Reply in one sentence that you are ready to start working.' // 英文向导用

module.exports = { fingerprint, providerFp, feishuFp, slackFp, lookup, record, recordTurn, recordPrecheck, when, REFRESH_MS, TRIAL_PROMPT, TRIAL_PROMPT_EN }
