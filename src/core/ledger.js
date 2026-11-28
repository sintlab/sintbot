// Turn ledger — one JSONL line per finished turn, appended to disk:
//   { ts, chatId, provider, sender, text, status, ms, tokens: { in, out, cr?, cw? }, err? }
// err 只在 status 为 error/failed 时出现(v0.11.61):此前失败只记 status、一个字的原因都没有,
// 而日志那边又没时间戳 ⇒ 线上失败事后无从查起。**字段缺席 = 旧行**,不是「这次没原因」。
// tokens 是**本轮增量**(cr=缓存读 cw=缓存写,engine._settleUsage 归一;v0.11.17 前的旧行
// claude 漏缓存、codex 记的是会话累计 —— 读历史数据时注意口径分界)。
// The in-memory activity feed is just a view; this file is the durable record
// and the data source for usage / cost accounting.
// Best-effort by design: a ledger failure must never break a turn.
//
// Rows reach the file in the order append() was called. Appends are still
// asynchronous and append() still returns at once, but each one waits for the
// previous append to the same file, from any ledger in this process (the
// console and the service each keep one for the audit file): concurrent
// writes could otherwise land in any order. A failed write is logged and the
// next one goes ahead.

const fs = require('node:fs')
const path = require('node:path')

const pending = new Map() // absolute file path -> the last append to it (never rejects)

function createLedger(file, log = () => {}) {
  let dirReady = false
  const key = path.resolve(file)
  return {
    file,
    append(rec) {
      try {
        if (!dirReady) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); dirReady = true }
        const line = JSON.stringify(rec) + '\n'
        // 账本里有发送者和消息正文:新建时只给自己读写(mode 只在创建时生效,旧文件由 core/datadir 启动时收紧)
        const write = (pending.get(key) || Promise.resolve())
          .then(() => fs.promises.appendFile(file, line, { mode: 0o600 }))
          .then(() => {}, (e) => { try { log('ledger append failed: ' + (e && e.message)) } catch {} })
        pending.set(key, write)
        write.then(() => { if (pending.get(key) === write) pending.delete(key) })
      } catch (e) {
        log('ledger append failed: ' + (e && e.message))
      }
    },
  }
}

module.exports = { createLedger }
