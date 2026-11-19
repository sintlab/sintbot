'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { isDeepStrictEqual } = require('node:util')
const core = require('./agent/privatecore')
const { loadInstallationFromRaw } = require('./c2install')
const { discoverWecomGroup, confirmReply } = require('./wecomsetuptransport')
const { provisionWecomBot, WECOM_SCAN_NOTICES } = require('./wecomprovision')

const SCAN_PREFLIGHT = Object.freeze({ botId: 'scan_preflight', secret: 'scan_preflight' })

// The live writer remains the only filesystem authority. The core builds the
// exact allowed merge; a short-lived proof authorizes only that configuration.
// With input.scan the bot is created by a WeCom scan; its credentials stay in
// this closure (never in job state or responses) and a retry reuses them, so
// one attachment never creates a second bot.
function createWecomAttach({ configPath, stateDir, writeConfig, activateConnection,
  awaitConnected = async () => true, canAttach = () => true, discover = discoverWecomGroup, provision = provisionWecomBot,
  buildConfig = core.connectConfig, home = os.homedir() }) {
  let busy = false, proof = null, activation = null, scanned = null
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
    async run(input, { signal, onNotice = () => {}, onQr = () => {}, onBot = () => {} } = {}) {
      if (!canAttach()) throw new Error('服务尚未就绪或正在维护，请稍后接入')
      if (busy) throw new Error('企业微信接入正在进行')
      busy = true
      const scan = input?.scan === true
      try {
        const prior = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        const provider = input.provider || prior.defaultProvider
        const runners = Object.fromEntries(Object.entries(prior.providers || {}).map(([name, p]) => [name, ['codex', 'claude'].includes(p.runner || 'claude')]))
        const workdir = input.workdir
        if (typeof workdir !== 'string' || !path.isAbsolute(workdir) || !fs.statSync(workdir).isDirectory()) throw new Error('请选择已有项目目录')
        const name = path.basename(workdir)
        // Validate the entire merge before opening a connection (or creating a
        // bot). The discovered identity is validated again under the lock.
        const args = { platform: 'wecom', provider, runners, workdir, home }
        const preview = buildConfig({ ...args, ...(scan ? SCAN_PREFLIGHT : { botId: input.botId, secret: input.secret }),
          chatId: 'wr_setup_preflight', existing: prior })
        if (!preview.ok) throw new Error(preview.error)
        let bot
        if (scan) {
          bot = scanned || await provision({ signal, onNotice, onQr })
          scanned = bot
          onBot()
        } else bot = { botId: input.botId, secret: input.secret }
        // The merge, named after the project. The core leaves the WeCom entry unnamed.
        const merged = (raw, chatId) => {
          const result = buildConfig({ ...args, botId: bot.botId, secret: bot.secret, chatId, existing: raw })
          if (result.ok && result.config?.groups?.[chatId] && !result.config.groups[chatId].name) result.config.groups[chatId].name = name
          return result
        }
        let chatId
        try {
          chatId = await discover({ botId: bot.botId, secret: bot.secret, signal, onNotice,
            ...(scan ? { notice: WECOM_SCAN_NOTICES.botReady } : {}),
            // Reply in WeCom only once the current configuration accepts this binding.
            confirm: async ({ chatId: found, chatType }) => {
              const check = merged(JSON.parse(fs.readFileSync(configPath, 'utf8')), found)
              if (!check.ok) throw new Error(check.error)
              return confirmReply(name, chatType)
            },
            inboxDir: path.join(stateDir, 'wecom-inbox') })
        } catch (error) {
          // A bot whose connection was refused is not offered again.
          if (scan && /^机器人连接(不可用|失败)/.test(error?.message || '')) scanned = null
          throw error
        }
        if (signal?.aborted) throw new Error('已取消接入')
        writeConfig(raw => {
          const result = merged(raw, chatId)
          if (!result.ok) throw new Error(result.error)
          proof = loadInstallationFromRaw(result.config, configPath, { dataDir: stateDir, allowAddedGroups: true }).cfg
          for (const key of Object.keys(raw)) delete raw[key]
          Object.assign(raw, result.config)
        })
        // The credentials are saved now; a later attempt is refused by the core.
        scanned = null
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
