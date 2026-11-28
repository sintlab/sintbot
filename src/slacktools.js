'use strict'
// The agent's Slack tools, served by the running service on a local socket
// (same shape as src/wecomtools.js): `sintbot slack <action>` run from a turn
// asks the service, which owns the Slack connection, to share a project file
// in the conversation or to read its recent messages. The request names the
// conversation and, for a channel turn, its thread; the service checks both
// against its configuration before anything reaches Slack.
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { resolveSendPath } = require('./platform/feishu')
const { redact } = require('./core/redact')
const { normalizeTz } = require('./core/time')
const { isSlackChatId, isSlackDmChatId } = require('./platform/slack')
const { formatHistory, MAX_UPLOAD_BYTES, HISTORY_LIMITS } = require('./slackfiles')

const ACTIONS = ['send-file', 'send-image', 'history', 'thread']
const SENDS = new Set(['send-file', 'send-image'])
const SLACK_TS = /^\d{1,12}\.\d{1,9}$/
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i
const USAGE = 'slack send-file <relative-path> | send-image <relative-path> | history [count] | thread [count]\n'
// The agent reads these sentences: a channel or a direct message, never a group.
const where = chatId => isSlackDmChatId(chatId) ? 'Slack 私聊' : isSlackChatId(chatId) ? 'Slack 频道' : 'Slack 频道或私聊'
const COUNT_HINT = `条数要写成正整数（history 最多 ${HISTORY_LIMITS.history.max}，thread 最多 ${HISTORY_LIMITS.thread.max}）`

function countOf(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value) || Number(value) < 1) throw new Error(COUNT_HINT)
  return Number(value)
}

function createSlackToolServer({ socketPath, getConfig, getPlatform, canSend = () => true }) {
  const peers = new Set()
  const server = net.createServer(socket => {
    socket.setEncoding('utf8')
    peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('error', () => {})
    socket.setTimeout(300000, () => socket.destroy())
    let raw = '', handling = false
    socket.on('data', chunk => {
      if (handling) return
      raw += chunk.toString('utf8')
      if (Buffer.byteLength(raw) > 128 * 1024) { socket.destroy(); return }
      if (!raw.includes('\n')) return
      handling = true
      void (async () => {
        const request = JSON.parse(raw.slice(0, raw.indexOf('\n')))
        if (!canSend()) throw new Error('服务尚未就绪或正在维护')
        const chatId = request && request.chatId
        const cfg = getConfig(), group = isSlackChatId(chatId) ? cfg.groups?.[chatId] : null
        if (!group || group.platform !== 'slack') throw new Error('当前会话不是已连接项目的 Slack 频道或私聊')
        if (group.paused) throw new Error(`当前 ${where(chatId)}已暂停`)
        if (!ACTIONS.includes(request.action)) throw new Error('动作不可用：请选择 send-file、send-image、history 或 thread')
        const direct = isSlackDmChatId(chatId)
        const given = request.thread === undefined || request.thread === null || request.thread === '' ? null : request.thread
        if (given !== null && (typeof given !== 'string' || !SLACK_TS.test(given))) throw new Error('线程标识格式不对')
        // A direct message is answered in the conversation itself: no thread.
        const thread = direct ? null : given
        if (request.action === 'thread' && !thread) {
          throw new Error(direct ? '私聊里没有线程；用 history 读最近的发言' : '当前任务不在频道线程里；用 history 读频道最近的发言')
        }
        const adapter = getPlatform(chatId)
        if (!adapter) throw new Error('Slack 连接不可用')
        if (SENDS.has(request.action)) {
          if (typeof request.value !== 'string' || !request.value) throw new Error('请提供项目内相对路径')
          const file = resolveSendPath(group.workdir, request.value)
          const stat = fs.statSync(file)
          if (!stat.isFile() || stat.size < 1 || stat.size > MAX_UPLOAD_BYTES) throw new Error('文件必须在 1 字节至 50 MiB 之间')
          if (request.action === 'send-image' && !IMAGE.test(file)) throw new Error('send-image 只发图片（png、jpg、gif、webp 等）；其它文件用 send-file')
          if (typeof adapter.sendMedia !== 'function') throw new Error('Slack 连接不可用')
          const ack = await adapter.sendMedia(chatId, fs.readFileSync(file), {
            type: request.action === 'send-image' ? 'image' : 'file', filename: path.basename(file), thread })
          if (typeof ack !== 'string' || !ack) throw new Error('发送结果未确认，请勿自动重试')
          socket.end(JSON.stringify({ ok: true }) + '\n')
          return
        }
        if (typeof adapter.readHistory !== 'function') throw new Error('Slack 连接不可用')
        const limit = countOf(request.value)
        const result = await adapter.readHistory(chatId, { thread: request.action === 'thread' ? thread : null, limit })
        const output = redact(formatHistory(result, { tz: normalizeTz(cfg.timezone) }), { pii: group.redactPii !== false })
        socket.end(JSON.stringify({ ok: true, output }) + '\n')
      })().catch(error => socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'))
    })
  })
  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); server.off('error', reject); resolve() })
    }),
    close: () => new Promise(resolve => { for (const peer of peers) peer.destroy(); server.close(() => resolve()) }),
  }
}

function requestSlackTool(socketPath, request) {
  const sending = SENDS.has(request && request.action)
  const lost = () => new Error(sending ? '发送结果未确认，请勿自动重试' : '读取没有完成，请稍后再试')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); socket.setEncoding('utf8'); let raw = '', settled = false
    const done = (error, result) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(result) }
    socket.setTimeout(300000, () => done(lost()))
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('error', () => done(new Error(sending ? '无法连接 SintBot 服务；不要自动重发' : '无法连接 SintBot 服务')))
    socket.on('data', chunk => { raw += chunk; if (raw.includes('\n')) { try {
      const result = JSON.parse(raw.split('\n')[0]); done(result.ok ? null : new Error(result.error), result)
    } catch { done(sending ? new Error('发送结果无法确认') : new Error('读取结果无法解析')) } } })
    socket.on('end', () => { if (!settled) done(lost()) })
  })
}

async function runSlackAction(args, { env = process.env, stdout = process.stdout } = {}) {
  if (args[0] === '--help' || args[0] === '-h') { stdout.write(USAGE); return }
  const action = args[0]
  if (!ACTIONS.includes(action)) throw new Error('请选择 send-file、send-image、history 或 thread')
  if (SENDS.has(action) ? args.length !== 2 : args.length > 2) {
    throw new Error(SENDS.has(action) ? `${action} 需要一个项目内相对路径` : `${action} 最多带一个条数`)
  }
  if (!env.SBOT_CHAT_ID || env.SBOT_PLATFORM !== 'slack' || !env.SBOT_SLACK_SOCKET) throw new Error(`此动作只能在当前 ${where(env.SBOT_CHAT_ID)}任务中执行`)
  if (!SENDS.has(action)) countOf(args[1])
  const thread = env.SBOT_SLACK_THREAD || null
  const result = await requestSlackTool(env.SBOT_SLACK_SOCKET, { chatId: env.SBOT_CHAT_ID, thread, action, value: args[1] })
  if (SENDS.has(action)) { stdout.write('发送已确认\n'); return }
  const output = typeof result.output === 'string' ? result.output : ''
  stdout.write(output.endsWith('\n') ? output : output + '\n')
}

module.exports = { createSlackToolServer, requestSlackTool, runSlackAction, SLACK_TOOL_USAGE: USAGE }
