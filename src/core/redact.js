// Outbound redaction — scrub secrets / PII before anything is sent
// to a chat group. Defense-in-depth alongside the permission policy: even if the
// agent echoes a token or a .env line, it should not reach the group verbatim.
//
// Conservative by design: a few false positives (an over-redacted word) are
// acceptable; a leaked credential is not.

const PATTERNS = [
  // bearer tokens / JWTs / common API-key shapes
  [/\bBearer\s+[A-Za-z0-9._\-]{12,}/g, 'Bearer ‹redacted›'],
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{6,}/g, '‹redacted:jwt›'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '‹redacted:key›'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '‹redacted:slack›'],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, '‹redacted:slack›'],
  // cloud / code-hosting credentials (v0.6 review: FR9.1 增补)
  [/\bAKIA[0-9A-Z]{16}\b/g, '‹redacted:aws›'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '‹redacted:github›'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '‹redacted:github›'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '‹redacted:private-key›'],
  // key=value / key: value / "key":"value" forms (app_secret, api_key, auth_token,
  // token, secret, password). The key may be quote-wrapped (JSON: "password":"…") —
  // \1 pins the matching close quote; the value quotes ($4/\4) are preserved so the
  // shape survives. (?<!\w) is a word-boundary that a leading quote wouldn't break.
  [/(?<!\w)("?)(app_?secret|api_?key|auth_?token|access_?token|token|secret|password|passwd)\1(\s*[=:]\s*)("?)[^\s"'{}]{6,}\4/gi, '$1$2$1$3$4‹redacted›$4'],
  // Feishu identifiers: app id (cli_) and user open id (ou_)
  [/\bcli_[A-Za-z0-9]{12,}/g, '‹redacted:app_id›'],
  // ⚠ @ 标签里的 open_id 必须放行(2026-09-08 真机):`sbot feishu send-msg` 也过这条脱敏,
  // `<at user_id="ou_…">名字</at>` 的 id 一被遮,飞书收到空 id、mentions 为 null —— 群里看着
  // @ 了,人其实收不到提醒。后顾只认紧跟 `<at ` 的 id 属性(文本消息 user_id= / 卡片 markdown
  // id=,引号可双可单可无),标签外的裸 open_id 照遮。
  [/(?<!<at\s+(?:user_)?id=["']?)\bou_[A-Za-z0-9]{20,}/g, '‹redacted:open_id›'],
  // email + China-mainland mobile — 'pii' 类:业务数据群里手机号/邮箱就是用户要查的
  // 内容本身(2026-08-04 真机:成员手机号被遮成 ‹redacted:phone›,把人逼去截图绕行),
  // 故按群可关(groups[chatId].redactPii:false);密钥类没有这个开关 —— 凭据出现在群里
  // 只能是事故,不存在「用户要求输出」的正当场景。
  // ⚠ 本地部分必须有上界:`[…]+@` 对一段没有 @ 的长串,每个起点都要贪婪吃到头再逐字回溯找 @,
  //   整体是二次的 —— 2026-09-07 实测 128KB 纯字母串 8 秒(daemon 与控制台同进程,卡住就是全群停摆;
  //   此前只在 turnErrText 一处用截断规避,而 finalizeTurn 对全量回复的那次 redact 没设防)。
  //   RFC 5321 本地部分最长 64、域名最长 253,按此设界后每个起点最多试 64 步 ⇒ 线性。
  //   超长本地部分的邮箱仍会被遮(匹配到靠后的 64 位 + 域名),只是前面几位漏出来 —— 方向上是多遮不是少遮。
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}/g, '‹redacted:email›', 'pii'],
  [/\b1[3-9]\d{9}\b/g, '‹redacted:phone›', 'pii'],
]

// ── 按值遮盖:配置里已知的凭据原文 ──────────────────────────────────────────
// 上面的模式只认「长得像密钥」的串(sk- / AKIA / ghp_ …),可 sbot 自己就拿着每个 provider 的
// apiKey 与飞书 appSecret 的**值**,没理由靠猜形状:2026-10-09 发现火山的 key 是 UUID 形、
// 飞书 appSecret 是 32 位裸十六进制,哪条模式都不碰 —— agent 一句 `echo $ANTHROPIC_AUTH_TOKEN`
// 就原样进群。loadConfig 每次装配配置时把这些值登记进来(热重载跟着换),出站再逐个替换。
// ⚠ 只收 ≥ 16 字符的值:短串(如示例配置的 `sk-local-dummy`、空的 env 引用)按值替换会误伤正文。
const SECRET_MIN_LEN = 16
let knownSecrets = []

// values:任意可迭代的字符串;非字符串 / 太短的丢掉,去重,长的先替(短值是长值子串时不留残片)。
function setKnownSecrets(values) {
  const seen = new Set()
  for (const v of values || []) {
    if (typeof v === 'string' && v.length >= SECRET_MIN_LEN) seen.add(v)
  }
  knownSecrets = [...seen].sort((a, b) => b.length - a.length)
  return knownSecrets.length
}

// 纯字面替换(split/join,不进正则 ⇒ 值里有 . + ( 之类也不用转义,且对长文本是线性的)。
function redactKnownSecrets(text) {
  let out = text
  for (const v of knownSecrets) {
    if (out.includes(v)) out = out.split(v).join('‹redacted:secret›')
  }
  return out
}

// opts.pii === false ⇒ 跳过 'pii' 类(手机号/邮箱明文);密钥类恒生效。
// 缺省(不传 opts)= 全遮盖,既有调用点零变化、fail-closed。
// 顺序:**先按值、再按形状**。反过来会漏:形状模式吃掉已登记值的一截(如值里嵌着 11 位数字被手机号
// 模式截走、Bearer 模式在 + 处停下),剩下的残片就对不上字面值、原样出站(审查 2026-10-09 实测)。
// 先按值替没有误伤代价(字面匹配、≥16 字符),登记过的值标签统一为 ‹redacted:secret›。
function redact(text, opts) {
  if (typeof text !== 'string' || !text) return text
  const skipPii = !!(opts && opts.pii === false)
  let out = knownSecrets.length ? redactKnownSecrets(text) : text
  for (const [re, rep, cat] of PATTERNS) {
    if (skipPii && cat === 'pii') continue
    out = out.replace(re, rep)
  }
  return out
}

module.exports = { redact, PATTERNS, setKnownSecrets, SECRET_MIN_LEN }
