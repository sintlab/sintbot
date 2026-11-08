// Turn ledger — one JSONL line per finished turn, appended to disk:
//   { ts, chatId, provider, sender, text, status, ms, tokens: { in, out, cr?, cw? }, err? }
// err 只在 status 为 error/failed 时出现(v0.11.61):此前失败只记 status、一个字的原因都没有,
// 而日志那边又没时间戳 ⇒ 线上失败事后无从查起。**字段缺席 = 旧行**,不是「这次没原因」。
// tokens 是**本轮增量**(cr=缓存读 cw=缓存写,engine._settleUsage 归一;v0.11.17 前的旧行
// claude 漏缓存、codex 记的是会话累计 —— 读历史数据时注意口径分界)。
// The in-memory activity feed is just a view; this file is the durable record
// and the data source for usage / cost accounting.
// Best-effort by design: a ledger failure must never break a turn.

const fs = require('node:fs')
const path = require('node:path')

function createLedger(file, log = () => {}) {
  let dirReady = false
  return {
    file,
    append(rec) {
      try {
        if (!dirReady) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); dirReady = true }
        // 账本里有发送者和消息正文:新建时只给自己读写(mode 只在创建时生效,旧文件由 core/datadir 启动时收紧)
        fs.appendFile(file, JSON.stringify(rec) + '\n', { mode: 0o600 }, (e) => { if (e) log('ledger append failed: ' + e.message) })
      } catch (e) {
        log('ledger append failed: ' + (e && e.message))
      }
    },
  }
}

module.exports = { createLedger }
