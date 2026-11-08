// StateStore — crash-safe JSON state for the engine.
//
// Per-group state: { groups: { "<chatId>": { sessionId, provider, watermark } } }.
// Writes are atomic (sibling .tmp → fsync → rename, with cleanup on failure) so
// a crash/power-loss mid-write can't leave a half-written or zero-byte file —
// same-dir rename is atomic on POSIX. Abstracted so SQLite can swap in later.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

// opts.mode = 新建文件时的权限位(如 0o600);已有文件一律沿用它自己的权限,不受这个参数影响。
function atomicWriteJSON(file, obj, opts = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.tmp-${crypto.randomUUID()}`)
  const data = JSON.stringify(obj, null, 2)
  // Carry the existing file's mode over to the replacement: a config file may be 0600
  // (the operator tightened it, it holds an appSecret) and a fresh tmp file — born with
  // the default umask — would silently widen it back to 0644 on every save.
  let mode = null
  try { mode = fs.statSync(file).mode & 0o777 } catch { mode = opts.mode == null ? null : opts.mode } // 新文件:有 opts.mode 就用它,否则随 umask
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, data)
      fs.fsyncSync(fd)
      if (mode != null) fs.fchmodSync(fd, mode)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    throw e
  }
}

// Synchronous sleep without spinning the CPU — Atomics.wait on a throwaway buffer.
// Used only inside the short lock-retry loop below (CLI processes, not the daemon loop).
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms)) } catch { /* no SAB → skip the wait */ }
}

// Cross-process exclusive lock around a read-modify-write of a shared file (e.g. two group
// agents both running `sbot cron add` against the same sbot.config.json). O_EXCL lockfile +
// bounded retry + stale-lock steal (a crashed holder's lock is reclaimed after staleMs), so a
// concurrent config edit is serialized instead of one clobbering the other. fn runs holding it.
function withFileLock(target, fn, { retries = 100, waitMs = 50, staleMs = 10_000 } = {}) {
  const lock = target + '.lock'
  let held = false
  for (let i = 0; i < retries && !held; i++) {
    try {
      const fd = fs.openSync(lock, 'wx') // wx = O_CREAT|O_EXCL: fails if it already exists
      try { fs.writeSync(fd, String(process.pid)) } finally { fs.closeSync(fd) }
      held = true
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { const st = fs.statSync(lock); if (Date.now() - st.mtimeMs > staleMs) { fs.unlinkSync(lock); continue } } catch { /* lock vanished → retry immediately */ }
      sleepSync(waitMs)
    }
  }
  if (!held) throw new Error(`获取配置锁超时(${target}.lock 被占用) — 另一进程可能正在写配置`)
  try { return fn() } finally { try { fs.unlinkSync(lock) } catch { /* best-effort release */ } }
}

class StateStore {
  constructor(file) {
    this.file = file
    this.data = { groups: {} }
    this._load()
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.data = parsed && typeof parsed === 'object' ? parsed : { groups: {} }
    } catch {
      this.data = { groups: {} }
    }
    if (!this.data.groups) this.data.groups = {}
  }

  _save() { atomicWriteJSON(this.file, this.data, { mode: 0o600 }) }

  _group(chatId) {
    return this.data.groups[chatId] || (this.data.groups[chatId] = {})
  }

  getSession(chatId) { return this._group(chatId).sessionId || null }
  setSession(chatId, sid) { this._group(chatId).sessionId = sid; this._save() }
  // C2 writeback: persist a new snapshot before exposing the session in this
  // process. Mark an aborted session in the same replacement when requested;
  // omitted/false tainted leaves the existing flag as the legacy setter does.
  // The legacy setter keeps its existing behavior for other callers.
  setSessionAtomic(chatId, sid, { tainted, sessionStats } = {}) {
    if (sessionStats !== undefined && (!sessionStats ||
        typeof sessionStats !== 'object' || Array.isArray(sessionStats) ||
        sessionStats.sessionId !== sid ||
        ['turns', 'in', 'out'].some(key =>
          !Number.isFinite(sessionStats[key]) || sessionStats[key] < 0) ||
        (sessionStats.ctx !== undefined &&
          (!Number.isFinite(sessionStats.ctx) || sessionStats.ctx < 0)) ||
        (sessionStats.cum !== undefined && (!sessionStats.cum ||
          typeof sessionStats.cum !== 'object' || Array.isArray(sessionStats.cum) ||
          ['in', 'cr', 'out'].some(key =>
            !Number.isFinite(sessionStats.cum[key]) || sessionStats.cum[key] < 0))))) {
      throw new TypeError('session statistics must match the session being written')
    }
    const groups = this.data.groups || {}
    const group = { ...(groups[chatId] || {}), sessionId: sid }
    if (tainted === true) group.tainted = true
    if (sessionStats !== undefined) group.sessionStats = {
      ...sessionStats,
      ...(sessionStats.cum === undefined ? {} : { cum: { ...sessionStats.cum } }),
    }
    const next = { ...this.data, groups: { ...groups, [chatId]: group } }
    atomicWriteJSON(this.file, next, { mode: 0o600 })
    this.data = next
  }
  // 清会话连带清「被掐断」标记:标记属于那段会话,会话没了它就没有意义。
  clearSession(chatId) { const g = this._group(chatId); delete g.sessionId; delete g.tainted; this._save() }

  // 「这段会话上一轮被掐断过」(v0.11.103):/stop · /skip · 控制台停止 · 撤回 · 墙钟 · 关停都算。
  // 为什么要落盘:被掐的轮若起过后台子任务,之后每次续接会话 CLI 都先塞它们的完成通知、模型
  // 答一句「不需要回复」就退出 —— 真人消息永远轮不到(2026-09-15 某项目实证,三条消息空转
  // 到有人 /new)。引擎据此在下一轮空转时**直接换新会话重做**而不是同会话重试。落盘而不是
  // 内存态:关停也是一种掐断,重启后「恢复续做」走的正是同一段会话。产出过一轮(ok / 静默)
  // 即清 —— 会话证明了自己还能接上。
  markTainted(chatId) { this._group(chatId).tainted = true; this._save() }
  clearTainted(chatId) { const g = this._group(chatId); if (g.tainted) { delete g.tainted; this._save() } }
  isTainted(chatId) { return !!this._group(chatId).tainted }

  // 会话规模账(v0.11.17):{ sessionId, turns, in, out, ctx?, cum? }。/hud「会话」行与
  // codex 累计→增量换算的数据源;逻辑在 engine._settleUsage,这里只存取。换会话即作废重记。
  getSessionStats(chatId) { return this._group(chatId).sessionStats || null }
  putSessionStats(chatId, s) { this._group(chatId).sessionStats = s; this._save() }
  clearSessionStats(chatId) { delete this._group(chatId).sessionStats; this._save() }

  // Session writeback may be followed by a requested fresh session. Publish
  // all three session-owned fields in one file replacement, and only replace
  // the live snapshot after that write succeeds. A failed fsync/rename cannot
  // make this process observe a reset that the next process will not see.
  resetSessionAndStats(chatId) {
    const groups = this.data.groups || {}
    const group = { ...(groups[chatId] || {}) }
    delete group.sessionId
    delete group.tainted
    delete group.sessionStats
    const next = { ...this.data, groups: { ...groups, [chatId]: group } }
    atomicWriteJSON(this.file, next, { mode: 0o600 })
    this.data = next
  }

  getProvider(chatId) { return this._group(chatId).provider || null }
  // ⚠ 人主动切模型(/model · 控制台)连带作废「额度临时切换」记录:人说了算,引擎之后不再自作主张切回。
  setProvider(chatId, name) { const g = this._group(chatId); g.provider = name; delete g.failover; this._save() }
  clearProvider(chatId) { const g = this._group(chatId); delete g.provider; delete g.failover; this._save() } // /model reset — follow config again

  // 额度临时切换记录(v0.11.107):{ home, from, to, kind:'quota'|'account', until:ms|null, at, checkedAt? }。
  // home = 配置里本群的模型(切回的目标);to = 现在临时用的。运行时覆盖(provider)与记录一起写、一起清 ——
  // 两处各写一份就会出现「覆盖还在、记录没了」的半状态,引擎永远不切回。落盘:发版重启不能把临时切换忘掉
  // (忘了 = 下一轮又去撞额度),也不能忘掉「这是临时的」(忘了 = 永远停在备用模型上)。
  getFailover(chatId) { return this._group(chatId).failover || null }
  setFailover(chatId, rec) { const g = this._group(chatId); g.provider = rec.to; g.failover = rec; this._save() }
  clearFailover(chatId) { const g = this._group(chatId); if (!g.failover) return; delete g.failover; delete g.provider; this._save() }
  touchFailover(chatId, patch) { const g = this._group(chatId); if (!g.failover) return; Object.assign(g.failover, patch); this._save() }

  // 「这个模型眼下没额度 / 不可用」(顶层,按 provider —— 额度是账号级事实,多群共用):
  // { until: ms|null, kind }。until 过了自动失效;null = 要人处理(账号类),只能由探针或人清。
  // 用处只有一个:挑备用模型时跳过同样没额度的,免得两个都用完了来回切(09-28 真机:claude 周额度
  // 用完切到 codex,codex 当天也撞了用量上限)。
  markExhausted(name, { until = null, kind = 'quota' } = {}, now = Date.now()) {
    if (!this.data.exhausted) this.data.exhausted = {}
    this.data.exhausted[name] = { until: until == null ? null : until, kind, at: now }
    for (const [k, v] of Object.entries(this.data.exhausted)) if (v && typeof v.until === 'number' && v.until <= now) delete this.data.exhausted[k]
    this._save()
  }
  isExhausted(name, now = Date.now()) { return !!this.getExhausted(name, now) }
  // 还没过期的那条标 { until, kind, at } | null —— 派发层跨群预判要知道 kind(文案)与 until(切回时刻),光 true/false 不够
  getExhausted(name, now = Date.now()) {
    const e = (this.data.exhausted || {})[name]
    if (!e) return null
    if (typeof e.until === 'number' && e.until <= now) return null
    return e
  }
  // 返回之前有没有这条标(**不看过期**):额度类的标都带 until,窗口一过 getExhausted 就查不到了,可「探到干净」正是
  // 恢复的证据 —— 运维告警的「已恢复」要靠这个返回值才发得出(审查 2026-10-09 逮到的死代码)。
  clearExhausted(name) {
    if (!(this.data.exhausted && this.data.exhausted[name])) return false
    delete this.data.exhausted[name]; this._save(); return true
  }

  // 上次运行的 daemon 版本(顶层,不属于任何群)—— 升级群播报的比对基线。
  getLastVersion() { return this.data.lastVersion || null }
  setLastVersion(v) { this.data.lastVersion = v; this._save() }

  // 额度告警去重(v0.11.8):窗口身份 = resetsAt。同一窗口只播一次;窗口滚动(resetsAt 变)
  // 自然放行下一次。**按 provider 存而非按群** —— 额度是账号级事实,多群共用一个订阅时
  // 群级去重会让同一件事吵 N 遍(operator 2026-08-04 拍板)。落盘而非内存:发版频繁,
  // 内存态每次 kickstart 都会重播一次。
  wasQuotaAlerted(provider, kind, resetsAt) {
    const a = (this.data.quotaAlerts || {})[`${provider}:${kind}`]
    return !!a && a.resetsAt === (resetsAt == null ? null : resetsAt)
  }
  markQuotaAlerted(provider, kind, resetsAt, now = Date.now()) {
    if (!this.data.quotaAlerts) this.data.quotaAlerts = {}
    this.data.quotaAlerts[`${provider}:${kind}`] = { resetsAt: resetsAt == null ? null : resetsAt, at: now }
    // 顺带清掉过期条目(resetsAt 已过去 ⇒ 那个窗口再也不会回来),防止 state 无限长胖
    for (const [k, v] of Object.entries(this.data.quotaAlerts)) {
      if (v && typeof v.resetsAt === 'number' && v.resetsAt < now) delete this.data.quotaAlerts[k]
    }
    this._save()
  }

  getWatermark(chatId) { return this._group(chatId).watermark || 0 }
  setWatermark(chatId, ts) {
    const g = this._group(chatId)
    if (ts > (g.watermark || 0)) { g.watermark = ts; this._saveSoon() }
  }

  // Watermarks advance on EVERY inbound message — a synchronous fsync per message
  // would put a disk write on the event loop's hot path. Debouncing is safe here:
  // a watermark lost to a crash only re-admits messages that the startup-time
  // drop (createTimeMs < startedAt) already filters out. Sessions/providers keep
  // their immediate write (losing those would be user-visible).
  _saveSoon(ms = 500) {
    if (this._timer) return
    this._timer = setTimeout(() => { this._timer = null; try { this._save() } catch {} }, ms)
    if (this._timer.unref) this._timer.unref()
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    this._save()
  }
}

module.exports = { StateStore, atomicWriteJSON, withFileLock, sleepSync }
