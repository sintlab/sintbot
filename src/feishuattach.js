'use strict'
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { isDeepStrictEqual } = require('node:util')
const { loadInstallationFromRaw } = require('./c2install')

// Adds Feishu to a running installation from the console: the same scan flow
// as `sintbot connect --attach` (src/connect.js) — app, readiness checks, a
// new group with the scanner in it, a backup of the configuration — except
// that the service's live writer commits the merge and the connection opens
// without a restart. Local conversations, their records and every other
// setting stay. Credentials stay inside this call; the job state only ever
// holds notices and the QR link.
function createFeishuAttach({ configPath, stateDir, writeConfig, activateConnection,
  awaitConnected = async () => true, canAttach = () => true,
  runConnect = (argv, deps) => require('./connect').runConnect(argv, deps), connectDeps = {} }) {
  let busy = false, proof = null, activation = null
  return {
    validateConnectionAddition(before, next) {
      return proof !== null && isDeepStrictEqual(proof, next)
    },
    activateConnection(cfg) {
      activation = Promise.resolve().then(() => activateConnection(cfg))
      return activation
    },
    async retry() {
      if (!canAttach()) throw new Error('服务尚未就绪或正在维护')
      if (await awaitConnected() !== true) throw new Error('飞书仍未连接，请检查网络，或确认这个应用没有被另一台 SintBot 连着')
      return { connected: true }
    },
    async run(input, { signal, onNotice = () => {}, onQr = () => {} } = {}) {
      if (!canAttach()) throw new Error('服务尚未就绪或正在维护，请稍后接入')
      if (busy) throw new Error('飞书接入正在进行')
      busy = true
      const signals = new EventEmitter()
      const onAbort = () => signals.emit('SIGINT')
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const workdir = input?.workdir
        if (typeof workdir !== 'string' || !path.isAbsolute(workdir) || workdir !== path.resolve(workdir)) throw new Error('请选择已有项目目录')
        let last = '', bound = null
        const lines = { write(text) { for (const line of String(text).split('\n')) if (line.trim()) { last = line.trim(); onNotice(last) } return true } }
        const code = await runConnect(['--attach', '--workdir', workdir, '--config', configPath, '--data-dir', stateDir, '--no-open'], {
          stderr: lines, stdout: lines, isTTY: false, signals, ...connectDeps,
          live: {
            onQr: url => onQr(url),
            onBound: info => { bound = info },
            commit: merge => writeConfig(raw => {
              const next = merge(JSON.parse(JSON.stringify(raw)))
              proof = loadInstallationFromRaw(next, configPath, { dataDir: stateDir, allowAddedGroups: true }).cfg
              for (const key of Object.keys(raw)) delete raw[key]
              Object.assign(raw, next)
            }),
          } })
        if (signal?.aborted) throw new Error('已取消接入')
        if (code !== 0 || !bound) {
          // Saved but not opened is reported as such: never offer a second scan.
          if (activation) throw new Error('配置已保存，飞书连接尚未启动；请在设置中刷新连接状态，勿重复接入')
          throw new Error(last || '飞书接入没有完成')
        }
        // The writer schedules the connection before the new group.
        await Promise.resolve()
        if (!activation) throw new Error('配置已保存，连接尚未启动')
        await activation
        if (await awaitConnected() !== true) throw new Error('配置已保存，飞书尚未连接成功；请在设置中刷新连接状态，勿重复接入')
        return { chatId: bound.chatId, name: bound.name }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        proof = null; activation = null; busy = false
      }
    },
  }
}
module.exports = { createFeishuAttach }
