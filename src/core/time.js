// 时间/时区口径(纯 Intl,零依赖,core 无感)。产品约定:群内一切时间表述默认
// 北京时间(Asia/Shanghai),顶层配置 `timezone`(IANA 名)可覆盖 —— 部署主机的
// 系统时区不可靠(海外主机/开发机各异),所以群面与 agent 面的时间一律经这里格式化,
// 不直接用主机本地时间。机器面时间戳(ledger/audit/水位线)仍是 epoch,不经这里。
const DEFAULT_TZ = 'Asia/Shanghai'

function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

// 无效/缺省一律回退默认(fail-safe:配置写错不至于让时间口径漂到主机时区)
function normalizeTz(tz) { return isValidTz(tz) ? tz : DEFAULT_TZ }

// One formatter per time zone, kept for the life of the process: building one
// costs far more than using it, and the scheduled-task searches ask for the
// parts of many instants. The output is the same as a fresh formatter's.
const FORMATTERS = new Map()
function formatterOf(tz) {
  const zone = normalizeTz(tz)
  let fmt = FORMATTERS.get(zone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    if (FORMATTERS.size < 64) FORMATTERS.set(zone, fmt)
  }
  return fmt
}

function tzParts(ts, tz) {
  const fmt = formatterOf(tz)
  const p = {}
  for (const x of fmt.formatToParts(new Date(ts))) if (x.type !== 'literal') p[x.type] = x.value
  return p
}

// IANA 时区在某时刻的 UTC 偏移(分);北京恒 +480(无夏令时),其它时区按时刻算
function tzOffsetMin(tz, ts = Date.now()) {
  const p = tzParts(ts, tz)
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return Math.round((asUTC - ts) / 60000)
}

// 'YYYY-MM-DD HH:mm'(按时区)— 群 prompt 时间戳等人读场景
function fmtStamp(ts, tz) {
  const p = tzParts(ts, tz)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

// 日志行首的时间戳 `MM-DD HH:MM:SS`。按**产品时区**打 —— 日志时间是拿去和群消息、账本
// 对照的,而主机时区可能差半天(本项目栽过「两把钟不许比大小」)。⚠ 故意不带年份:这个文件
// 不轮转、行数以万计,年份每行多 5 字节;跨年归属由启动横幅里那一行完整日期锚定。
function fmtLogStamp(ts, tz) {
  const p = tzParts(ts, tz)
  return `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

module.exports = { DEFAULT_TZ, isValidTz, normalizeTz, tzOffsetMin, fmtStamp, fmtLogStamp, tzParts }
