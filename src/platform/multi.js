// 多平台路由器:把若干个平台适配器(飞书 / 企业微信 …)包成**一个** Platform 给 bin 用。
//
// 为什么要它(2026-10-10 用户定「双平台并存」):daemon 要同时接飞书与企微,群项目可以是飞书群也可以是
// 企微群。bin 里几十处 `platform.send(chatId, …)`(定时任务 / 升级播报 / 运维告警 / 控制台群通知 / 预览收割)
// 不该各自判一次「这个群在哪边」—— 这里按 chatId 查一次,分发给对的适配器。core 零改:引擎拿到的仍然是
// 「某一个适配器」(入站消息由它自己的适配器送进来,合成消息由 bin 用 forChat 查出适配器再喂),所以清单的
// skillCmd / features / chatLabel 按适配器分流在这里天然成立 —— 路由器自己**不**声明这三个字段,免得被当成某个平台。
//
// 判归属 = 注入的 resolve(chatId) → 'feishu' | 'wecom' | null(由 config.chatPlatform 提供:群配置 > id 形态 > 只配
// 了一个平台就是它);查不到且只有一个适配器 ⇒ 用它;查不到且有多个 ⇒ 不发、记一行日志(宁可不发也别发错群)。
//
// start(onMessage, hooks):每个适配器各起一遍,入站回调带上它自己 `onMessage(msg, adapter, name)`;hooks 原样给
// 每个适配器(各自只认自己懂的那几个),`hooks.byPlatform[name]` 可按平台覆盖(企微的卡片回调与飞书的不是一套)。
// connHealth():按平台名的字典 `{ feishu: 快照, wecom: 快照 }` —— 控制台一行一个平台。

function createMultiPlatform({ adapters = {}, resolve = () => null, log = () => {} } = {}) {
  const names = Object.keys(adapters).filter((n) => adapters[n])
  if (!names.length) throw new Error('multi: at least one platform adapter required')
  let receiver = null, activeHooks = {}, stopped = false
  const only = () => names.length === 1 ? adapters[names[0]] : null
  const seen = new Map() // chatId → 最近一次入站消息来自哪个适配器:配置判不出归属的会话(企微单聊 id 没形态)靠它,消息从哪边来就往哪边回

  // 某个会话该走哪个适配器:配置(群 platform / id 形态 / 唯一平台)> 最近入站 > 只有一个适配器就是它;都没有 ⇒ null(调用方决定报什么)
  const forChat = (chatId) => {
    let name = null
    try { name = resolve(chatId) } catch { name = null }
    if (name && adapters[name]) return adapters[name]
    return seen.get(chatId) || only()
  }
  const miss = (what, chatId) => { log(`${what}: 判不出会话 ${chatId} 属于哪个平台(已配 ${names.join(' / ')}),未发送 —— 给这个群补 platform 字段`); return null }

  return {
    // 平台名清单 / 按名取适配器(bin 判「飞书专属子系统装不装」用)
    names: () => names.slice(),
    get: (name) => adapters[name] || null,
    forChat,
    seal() { stopped = true; receiver = null },

    async add(name, adapter) {
      if (stopped || !receiver) throw new Error('multi: transport is not running')
      if (!name || adapters[name] || !adapter || typeof adapter.start !== 'function') throw new Error('multi: invalid or duplicate adapter')
      const { byPlatform, ...base } = activeHooks
      // Publish the route only after start has accepted its callback. Until
      // then any inbound frame is ignored, never routed to a different adapter.
      let ready = false
      try {
        await adapter.start(msg => {
          if (!ready || stopped) return
          if (msg?.chatId) seen.set(msg.chatId, adapter)
          return receiver(msg, adapter, name)
        }, { ...base, ...((byPlatform || {})[name] || {}) })
      } catch (error) { await adapter.stop?.({ strict: true }); throw error }
      if (stopped) { await adapter.stop?.({ strict: true }); throw new Error('multi: transport stopped during addition') }
      adapters[name] = adapter; names.push(name); ready = true
      return true
    },

    async start(onMessage, hooks = {}) {
      receiver = onMessage; activeHooks = hooks; stopped = false
      const { byPlatform, ...base } = hooks || {}
      await Promise.all(names.map((name) => {
        const a = adapters[name]
        const h = { ...base, ...((byPlatform || {})[name] || {}) }
        // 必须把 onMessage 的返回值(Promise)交回适配器:适配器靠它 `.catch` 兜住引擎抛错(飞书那层是
        // `Promise.resolve(onMessage(...)).catch(log)`),吞掉就变成 unhandled rejection,进程直接退、不走优雅关停
        return a.start((msg) => { if (msg && msg.chatId) seen.set(msg.chatId, a); return onMessage(msg, a, name) }, h)
      }))
    },

    async reply(replyCtx, content, opts) {
      const chatId = replyCtx && replyCtx.chatId
      const a = forChat(chatId)
      if (!a) return miss('reply', chatId)
      return a.reply(replyCtx, content, opts) // opts(如 final)原样透传,各平台自行决定认不认
    },

    async send(chatId, content) {
      const a = forChat(chatId)
      if (!a) return miss('send', chatId)
      return a.send(chatId, content)
    },

    async sendCard(chatId, card) {
      const a = forChat(chatId)
      if (!a) return miss('sendCard', chatId)
      if (!a.sendCard) return null // 适配器没有卡片能力(契约里 sendCard 可选)= 能力缺口不是路由失败:调用方自己退回纯文本,这里不记日志
      return a.sendCard(chatId, card)
    },

    // 合成消息(定时任务 / 控制台插话)没有真实适配器;引擎若直接拿路由器建卡,这里按 chatId 转交
    async createStreamingCard(replyCtx, opts) {
      const a = forChat(replyCtx && replyCtx.chatId)
      if (!a || !a.createStreamingCard) return null
      return a.createStreamingCard(replyCtx, opts)
    },

    connHealth() {
      const out = {}
      for (const name of names) {
        const a = adapters[name]
        try { out[name] = a.connHealth ? a.connHealth() : null } catch { out[name] = null }
      }
      return out
    },

    async stop() {
      stopped = true; receiver = null
      await Promise.all(names.map((name) => Promise.resolve(adapters[name].stop && adapters[name].stop()).catch(() => {})))
    },
  }
}

module.exports = { createMultiPlatform }
