// `sbot setup` 模型步的纯逻辑:各家在哪拿 key、国际站端点、默认走哪条路、试跑失败怎么说人话。
// 向导本身在 bin/sbot.js(交互、读写配置);这里只放可单测的部分。
//
// 推荐顺序(2026-10-19 定):有 Claude 订阅 → 用 Claude;有 ChatGPT(Codex)→ 用 Codex;都没有 → 推荐 DeepSeek。
// 1.0.12 起向导不问「在不在中国大陆」(用户 10-28 定:那是隐私)。有国际站的厂商先按时区试一个站,认证失败自动换另一个站再试。
// 文案带英文(en),中英文由 src/clilang.js 决定。

// 用 API key 的预设(名字与 sbot.config.example.json 的 providers 键一致):label / site / billing / 国际站,
// 都取自模型来源清单 src/providers.js(wizard 标记的条目,按清单顺序;与控制台「添加模型」同一份)。
// intl:有国际站的厂商,key 在哪个站开的就得连哪个站,填错站点会 401。
const providers = require('./providers')
const PROVIDER_INFO = providers.wizardInfo()
const RECOMMENDED = providers.PROVIDERS.find((e) => e.recommended).id

// 中国大陆常见时区:只用来决定有国际站的厂商先试哪个站、推荐哪个聊天平台(不问用户,也不写进配置)
const MAINLAND_TZ = new Set(['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Urumqi', 'Asia/Kashgar', 'PRC'])
function looksMainland(tz) {
  if (tz === undefined) { try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { tz = '' } }
  return MAINLAND_TZ.has(String(tz || ''))
}

const host = (url) => { try { return new URL(url).host } catch { return String(url || '') } }

// 已登录的订阅优先:Claude > Codex;都没有返回 null(向导转去推荐 DeepSeek)
function subscriptionRoute({ claudeLoggedIn, codexLoggedIn } = {}) {
  if (claudeLoggedIn) return 'claude'
  if (codexLoggedIn) return 'codex'
  return null
}

// key 是否真能用上:明文非空,或 env: 引用且这个环境变量此刻有值
function keyPresent(apiKey, env = process.env) {
  if (!apiKey || typeof apiKey !== 'string') return false
  if (apiKey.startsWith('env:')) return !!env[apiKey.slice(4)]
  return true
}

// 一家厂商的显示名 / 计费说明(英文缺省回落中文原文)
const infoText = (info, key, lang) => (lang === 'en' && info && info.en && info.en[key]) || (info && info[key]) || ''

// 试跑失败的原文 → 一句人话 + 类别。原文来自 claude 命令行(API Error: 401 …)或 spawn / 网络异常。
// 控制台「验证 Key」用同一份(11-20 用 Claude Code 2.1.322 对假端点取到的原话:401 ⇒「Not logged in · Please run /login」,
// 402 ⇒「API Error: 402 Insufficient balance」,404 ⇒「There's an issue with the selected model …」,网页 ⇒「malformed response … HTML page」)。
function explainTestFailure(text, { baseUrl, lang = 'zh' } = {}) {
  const t = String(text || '')
  const en = lang === 'en'
  const h = baseUrl ? host(baseUrl) : (en ? 'the model endpoint' : '模型端点')
  if (/\b401\b|authentication|invalid (api )?key|invalid_authentication|unauthori[sz]ed|令牌|token expired|login fail|api key.*invalid|模型认证失败|not logged in|please run \/login/i.test(t)) {
    return { kind: 'auth', text: en ? 'The key was rejected: check it was copied in full; for providers with an international site, the key must come from the same site you connect to' : 'key 不对:检查有没有复制完整;有国际站的厂商,确认 key 和所选站点是同一个站开的' }
  }
  if (/\b402\b|insufficient|balance|余额|欠费|arrear|quota|实名|recharge|billing/i.test(t)) {
    return { kind: 'balance', text: en ? 'The account cannot be used: most likely no balance or identity verification is pending; top up / verify in the provider console and try again' : '账户不能用:多半是余额不足或还没实名,到厂商后台充值 / 实名后再试' }
  }
  // 端点不是 Anthropic 格式(网页、OpenAI 格式地址):Claude Code 报「返回空或格式不对」
  if (/malformed response|body is an HTML page|not valid JSON|Unexpected token '?<|<!DOCTYPE|<html/i.test(t)) {
    return { kind: 'format', text: en ? `${h} is not an Anthropic-format API: check that the endpoint is not a web page or an OpenAI-format address` : `${h} 不是 Anthropic 格式的接口:检查端点有没有填成网页地址或 OpenAI 格式的地址` }
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out|fetch failed|socket hang up|network|connection error|aborted/i.test(t)) {
    return { kind: 'network', text: en ? `Cannot reach ${h}: check the network; if a global proxy is on, let ${h} connect directly` : `连不上 ${h}:检查网络;开着全局代理的话,把 ${h} 设成直连` }
  }
  if (/\b404\b|model.*(not found|not exist|does not exist|invalid|not supported)|模型.*不存在/i.test(t)) {
    return { kind: 'model', text: en ? 'Wrong model name, or this key has no access to that model: change the model name on the console Models page' : '模型名不对或这个 key 没开通该模型:到控制台「模型」页改模型名' }
  }
  return { kind: 'other', text: t.split('\n')[0].slice(0, 200) || (en ? 'No output' : '没有返回内容') }
}

module.exports = { PROVIDER_INFO, RECOMMENDED, looksMainland, host, subscriptionRoute, keyPresent, explainTestFailure, infoText }
