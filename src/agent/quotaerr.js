// 额度 / 账号类错误判据 —— 「等一会儿没用,得换模型或换账号」的那类错(两个 runner 共用;与 ./transienterr 对称)。
//
// 为什么住 src/agent 而不是 src/core:签名表全是具体后端的原话形状,是 runner 层的知识;core 只认 runner 挂上的结构化
// 字段 result.quota,不碰原话。「几点重置」的解析(parseResetAt)依赖产品时区,留在 src/core/quotaerr.js。
//
// 与 transienterr(瞬时错:过载 / 限流 / 网关错)是两类事,那边显式把额度类排除了;这里接住它们:
//   · quota   —— 订阅额度用尽(5 小时 / 一周窗口)。服务端原话形如
//                「You've hit your weekly limit · resets Oct 1 at 9am (Asia/Shanghai)」(claude 2.1.260 真机)
//                「You've hit your usage limit. Upgrade to Pro (…) or try again at 2:30 PM.」(codex 0.144 真机)
//   · account —— 账号层面不可用:被停用 / 登录态过期刷新不了。原话形如
//                「Your account is on hold and can't use Claude Code. …」(2026-09-27 真机)
//                「Failed to authenticate: OAuth session expired and could not be refreshed」(2026-09-25 真机,6 轮)
//                「workspace routing discovery unauthorized (401)」(codex 0.162,真实案例:两台共用一份凭据各自刷新,
//                refresh token 会轮换,服务端把整族吊销;stderr 原话「401 Unauthorized: Encountered invalidated oauth
//                token for user … auth error code: token_revoked」。这句此前不在判据里 ⇒ 每轮 401 却零告警零切换,隔天才被人发现)
//
// 为什么要分这两档:额度类有确定的重置时刻,切到备用模型后到点就该切回来;账号类没有重置时刻,
// 要人去处理(重新登录 / 申诉),切过去之后只能靠探针确认恢复才切回。两档的「下一步」不同,混成一档就
// 会在错的时候切回去。
//
// 两个 runner 在出错结果上标 `quota`(与 `transient` 同一形状:runner 判、引擎只认字段);重置时刻的
// 解析放在这里(core)而不是 runner:它依赖产品时区,而 runner 不知道时区。
// ⚠ 判据宁漏不误:只认明确的额度 / 认证措辞;裸的「limit」「403」不认(正文里出现「limit」太常见)。


// 额度用尽的签名(窗口能分出来就分,分不出来为 null —— 切换逻辑不依赖窗口,只有文案用)
const QUOTA_SIGNATURES = [
  [/hit your weekly limit|weekly (?:usage )?limit (?:reached|exceeded)/i, 'weekly'],
  [/hit your (?:session|5-hour|five-hour) limit/i, 'session'],
  [/hit your (?:usage |daily |monthly )?limit|usage[ _]limit[ _](?:reached|exceeded)|usage_limit|out of (?:extra )?usage|quota (?:exceeded|exhausted|reached)|额度(?:用尽|已用完|用完)/i, null],
]
// 账号 / 登录态不可用的签名
// ⚠ 401 只认带「unauthorized」的两种拼法(宁漏不误:裸的 401 / 403 数字不认 —— 工具输出里太常见)。
const ACCOUNT_RE = /account is on hold|account (?:has been |is )?(?:suspended|restricted|disabled|deactivated|locked)|could not be refreshed|oauth session expired|oauth token (?:expired|revoked)|invalidated oauth token|token_revoked|unauthorized \(401\)|401 unauthorized|invalid[_ ]grant|failed to authenticate|authentication[_ ]error|not logged in|please (?:run )?\/?login/i

/**
 * 判一段出错原话是不是额度 / 账号类。
 * @returns {{kind:'quota'|'account', window:'weekly'|'session'|null}|null}
 */
function classifyQuota(text) {
  const s = String(text || '')
  if (!s.trim()) return null
  for (const [re, window] of QUOTA_SIGNATURES) if (re.test(s)) return { kind: 'quota', window }
  if (ACCOUNT_RE.test(s)) return { kind: 'account', window: null }
  return null
}

module.exports = { classifyQuota, QUOTA_SIGNATURES, ACCOUNT_RE }
