'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { isDeepStrictEqual } = require('node:util')
const core = require('./agent/privatecore')
const { loadInstallationFromRaw } = require('./c2install')
const { discoverWecomGroup } = require('./wecomsetuptransport')

// The live writer remains the only filesystem authority. The core builds the
// exact allowed merge; a short-lived proof authorizes only that configuration.
function createWecomAttach({ configPath, stateDir, writeConfig, activateConnection,
  awaitConnected = async () => true, canAttach = () => true, discover = discoverWecomGroup, buildConfig = core.connectConfig, home = os.homedir() }) {
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
      if (await awaitConnected() !== true) throw new Error('企业微信仍未连接，请检查网络、机器人凭据或是否被其他实例占用')
      return { connected: true }
    },
    async run(input, { signal, onNotice = () => {} } = {}) {
      if (!canAttach()) throw new Error('服务尚未就绪或正在维护，请稍后接入')
      if (busy) throw new Error('企业微信接入正在进行')
      busy = true
      try {
        const prior = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        const provider = input.provider || prior.defaultProvider
        const runners = Object.fromEntries(Object.entries(prior.providers || {}).map(([name, p]) => [name, ['codex', 'claude'].includes(p.runner || 'claude')]))
        const workdir = input.workdir
        if (typeof workdir !== 'string' || !path.isAbsolute(workdir) || !fs.statSync(workdir).isDirectory()) throw new Error('请选择已有项目目录')
        // Validate the entire merge before opening a connection. The actual
        // discovered identity is validated again under the configuration lock.
        const args = { platform: 'wecom', botId: input.botId, secret: input.secret, provider, runners, workdir, home }
        const preview = buildConfig({ ...args, chatId: 'wr_setup_preflight', existing: prior })
        if (!preview.ok) throw new Error(preview.error)
        const chatId = await discover({ botId: input.botId, secret: input.secret, signal, onNotice,
          inboxDir: path.join(stateDir, 'wecom-inbox') })
        if (signal?.aborted) throw new Error('已取消接入')
        writeConfig(raw => {
          const result = buildConfig({ ...args, chatId, existing: raw })
          if (!result.ok) throw new Error(result.error)
          proof = loadInstallationFromRaw(result.config, configPath, { dataDir: stateDir, allowAddedGroups: true }).cfg
          for (const key of Object.keys(raw)) delete raw[key]
          Object.assign(raw, result.config)
        })
        // The writer schedules transport activation before the new group.
        await Promise.resolve()
        if (!activation) throw new Error('配置已保存，连接尚未启动')
        await activation
        if (await awaitConnected() !== true) throw new Error('配置已保存，企业微信尚未鉴权成功；请在设置中刷新连接状态，勿重复添加')
        return { chatId }
      } finally { proof = null; activation = null; busy = false }
    },
  }
}
module.exports = { createWecomAttach }
