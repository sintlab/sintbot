'use strict'
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { resolveSendPath } = require('./platform/feishu')
const { redact } = require('./core/redact')
const ACTIONS = ['send-msg', 'send-file', 'send-image']

function createWecomToolServer({ socketPath, getConfig, getPlatform, canSend = () => true }) {
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
        const cfg = getConfig(), group = cfg.groups?.[request.chatId]
        if (!group || group.platform !== 'wecom' || group.paused || !ACTIONS.includes(request.action)) throw new Error('当前企业微信群或动作不可用')
        const adapter = getPlatform(request.chatId)
        if (!adapter) throw new Error('企业微信连接不可用')
        let ack
        if (request.action === 'send-msg') {
          if (typeof request.value !== 'string' || !request.value.trim()) throw new Error('消息不能为空')
          ack = await adapter.send(request.chatId, redact(request.value, { pii: group.redactPii !== false }))
        } else {
          if (typeof request.value !== 'string') throw new Error('请提供项目内相对路径')
          const file = resolveSendPath(group.workdir, request.value)
          const stat = fs.statSync(file)
          if (!stat.isFile() || stat.size < 1 || stat.size > 50 * 1024 * 1024) throw new Error('文件必须在 1 字节至 50 MiB 之间')
          ack = await adapter.sendMedia(request.chatId, fs.readFileSync(file), {
            type: request.action === 'send-image' ? 'image' : 'file', filename: path.basename(file) })
        }
        if (typeof ack !== 'string' || !ack) throw new Error('发送结果未确认，请勿自动重试')
        socket.end(JSON.stringify({ ok: true }) + '\n')
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
function requestWecomTool(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); socket.setEncoding('utf8'); let raw = '', settled = false
    const done = (error, result) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(result) }
    socket.setTimeout(300000, () => done(new Error('发送结果未确认，请勿自动重试')))
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('error', () => done(new Error('无法连接企业微信服务；不要自动重发')))
    socket.on('data', chunk => { raw += chunk; if (raw.includes('\n')) { try {
      const result = JSON.parse(raw.split('\n')[0]); done(result.ok ? null : new Error(result.error), result)
    } catch { done(new Error('发送结果无法确认')) } } })
    socket.on('end', () => { if (!settled) done(new Error('发送结果未确认，请勿自动重试')) })
  })
}
async function runWecomAction(args, { env = process.env, stdout = process.stdout } = {}) {
  if (args[0] === '--help' || args[0] === '-h') { stdout.write('wecom send-msg <text> | send-file <relative-path> | send-image <relative-path>\n'); return }
  if (args.length !== 2 || !ACTIONS.includes(args[0])) throw new Error('请选择 send-msg、send-file 或 send-image，并提供一个参数')
  if (!env.SBOT_CHAT_ID || env.SBOT_PLATFORM !== 'wecom' || !env.SBOT_WECOM_SOCKET) throw new Error('此动作只能在当前企业微信群任务中执行')
  await requestWecomTool(env.SBOT_WECOM_SOCKET, { chatId: env.SBOT_CHAT_ID, action: args[0], value: args[1] })
  stdout.write('发送已确认\n')
}
module.exports = { createWecomToolServer, requestWecomTool, runWecomAction }
