'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { isDeepStrictEqual } = require('node:util')
const core = require('./agent/privatecore')
const { loadInstallationFromRaw } = require('./c2install')
const { discoverSlackConversation, confirmReply } = require('./slacksetuptransport')
const { verifySlackAppToken, verifySlackBotToken } = require('./slackverify')

const PREFLIGHT_CHAT = 'oc_slack_D0PREFLIGHT'

// Adds Slack to a running installation. The live writer remains the only
// filesystem authority: the core builds the exact allowed merge, and a
// short-lived proof authorizes only that configuration. Both tokens are
// verified against Slack before a connection is opened; they stay in this
// call's memory until the configuration is written and never enter job state
// or a response.
function createSlackAttach({ configPath, stateDir, writeConfig, activateConnection,
  awaitConnected = async () => true, canAttach = () => true, discover = discoverSlackConversation,
  verifyApp = verifySlackAppToken, verifyBot = verifySlackBotToken,
  buildConfig = core.connectConfig, home = os.homedir() }) {
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
      if (await awaitConnected() !== true) throw new Error('Slack 仍未连接，请检查网络、代理或两枚令牌是否仍然有效')
      return { connected: true }
    },
    async run(input, { signal, onNotice = () => {}, onIdentity = () => {} } = {}) {
      if (!canAttach()) throw new Error('服务尚未就绪或正在维护，请稍后接入')
      if (busy) throw new Error('Slack 接入正在进行')
      busy = true
      try {
        const prior = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        const provider = input.provider || prior.defaultProvider
        const runners = Object.fromEntries(Object.entries(prior.providers || {}).map(([name, p]) => [name, ['codex', 'claude'].includes(p.runner || 'claude')]))
        const workdir = input.workdir
        if (typeof workdir !== 'string' || !path.isAbsolute(workdir) || !fs.statSync(workdir).isDirectory()) throw new Error('请选择已有项目目录')
        const name = path.basename(workdir)
        const app = await verifyApp(input.appToken)
        if (!app.ok) throw new Error(app.notice)
        const bot = await verifyBot(input.botToken, { appId: app.appId })
        if (!bot.ok) throw new Error(bot.notice)
        if (signal?.aborted) throw new Error('已取消接入')
        const identity = bot.identity || {}
        const credentials = { botToken: String(input.botToken).trim(), appToken: String(input.appToken).trim(),
          ...(identity.appId || app.appId ? { slackAppId: identity.appId || app.appId } : {}),
          ...(identity.teamId ? { teamId: identity.teamId } : {}),
          ...(identity.botUserId ? { botUserId: identity.botUserId } : {}),
          ...(identity.team ? { team: identity.team } : {}) }
        const args = { platform: 'slack', provider, runners, workdir, home, ...credentials }
        // Validate the entire merge before opening a connection. The
        // discovered conversation is validated again under the lock.
        const preview = buildConfig({ ...args, chatId: PREFLIGHT_CHAT, existing: prior })
        if (!preview.ok) throw new Error(preview.error)
        onIdentity({ team: identity.team || '', teamId: identity.teamId || '', appId: credentials.slackAppId || '',
          botName: identity.botName || '' })
        onNotice(bot.notice)
        // The merge, named after the project. The core leaves the entry unnamed.
        const merged = (raw, chatId) => {
          const result = buildConfig({ ...args, chatId, existing: raw })
          if (result.ok && result.config?.groups?.[chatId] && !result.config.groups[chatId].name) result.config.groups[chatId].name = name
          return result
        }
        const chatId = await discover({ botToken: credentials.botToken, appToken: credentials.appToken, signal, onNotice,
          // Reply in Slack only once the current configuration accepts this binding.
          confirm: async ({ chatId: found }) => {
            const check = merged(JSON.parse(fs.readFileSync(configPath, 'utf8')), found)
            if (!check.ok) throw new Error(check.error)
            return confirmReply(name)
          },
          inboxDir: path.join(stateDir, 'slack-inbox') })
        if (signal?.aborted) throw new Error('已取消接入')
        writeConfig(raw => {
          const result = merged(raw, chatId)
          if (!result.ok) throw new Error(result.error)
          proof = loadInstallationFromRaw(result.config, configPath, { dataDir: stateDir, allowAddedGroups: true }).cfg
          for (const key of Object.keys(raw)) delete raw[key]
          Object.assign(raw, result.config)
        })
        // The writer schedules transport activation before the new conversation.
        await Promise.resolve()
        if (!activation) throw new Error('配置已保存，连接尚未启动')
        await activation
        if (await awaitConnected() !== true) throw new Error('配置已保存，Slack 尚未连接成功；请在设置中刷新连接状态，勿重复添加')
        return { chatId }
      } finally { proof = null; activation = null; busy = false }
    },
  }
}
module.exports = { createSlackAttach }
