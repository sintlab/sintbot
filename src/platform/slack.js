// Slack 平台适配器 —— 满足 src/core/interfaces.js 的 Platform 契约(start / reply / send / stop)。
// 与 feishu.js 平级、互不引用:引擎不认识 "slack" 三个字,只认这几个方法。
//
// 范围:收消息 → 回消息 → 优雅停;外加回执表情、
// 消息编辑(带降级)、附件下载三件顺手且互不依赖的能力。
// ⚠ **不含进度表达**(节流 chat.update 刷进度 + agents.sessions.setStatus 的原生 Working… / Stop)
//   —— 那是第 2 步。契约里 createStreamingCard 是可选的:本文件不实现,引擎(engine.js:1442)
//   自动退回纯文本回复,不需要任何改动。
// 接线在 bin/sbot.js(多平台路由器 multi.js 的 `adapters.slack`);本文件自成一体、不依赖引擎。
//
// ── 为什么不用 @slack/socket-mode + @slack/web-api(docs/SLACK.md「形态」)──────────
//   ① 那两个包不管我们真正要处理的东西:ack 先行 · event_id 去重 · 事件年龄闸门 · 自我回环丢弃 ·
//      429 退避 · 错误码分类 —— 引了包这些照样得写(见 SLACK.md「静默失败」 / SLACK.md「可靠性」)。
//   ② 重连这块本仓已有 wswatchdog.js 的纯状态机,而 SDK 自己的重连有已知竞态
//      (`too_many_websockets`,node-slack-sdk#1654)⇒ 引一个包再绕过它的主功能,不划算。
//   ③ 传输面 `ws` 是**既有依赖**(@larksuiteoapi/node-sdk 已经装了同一个 ^8,dedupe 后零新增);
//      web API 全部是 POST JSON,原生 fetch 就够(Node ≥22,与 package.json engines 一致 ——
//      原生 WebSocket 要 ≥22,不能用)。
//   ⇒ 新增安装体积实际为零,而**所有 Slack 行为都落在本文件里**,可被零网络单测覆盖
//      (tests/unit/slack.test.js)。
// ⚠ 但 SLACK.md「可靠性」 的警告仍然成立:Slack 的业务错误一律 HTTP 200 + `ok:false`,**必须显式抛**,
//   否则就是 v0.11.48 那次飞书事故的形状(引擎以为答案送达,群里一个字都没有)。
//   `call()` 是本文件唯一的出站入口,那一层已经写死。
//
// 实测口径见 docs/SLACK.md(861 行);本文件注释里的 §x 全部指它。

const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')
const { createWatchdog } = require('./wswatchdog')
const { getProxyFetch, getProxyAgent, proxyWarning } = require('../core/proxy') // 出网代理:Node 的 fetch 与 ws 都不读 http_proxy(见该模块头注)

// 适配器默认的出网实现。⚠ **必须现取、不能在模块加载时定形** —— `applyProxyEnv` 是在
// `loadConfig` 之后才把 `cfg.proxy` 写进 env 的,而本文件早就被 require 进来了。
// 没配代理时 `getProxyFetch()` 返回 null ⇒ 原样走全局 `fetch`,行为与改动前逐字节相同。
const netFetch = (...a) => (getProxyFetch() || fetch)(...a)

const API = 'https://slack.com/api/'

// ── 错误码分类(SLACK.md「可靠性」)──────────────────────────────────────────────
// 分类决定**处置**,不决定日志措辞:致命的必须停(否则重试循环把 app 打死),
// 频道级的必须把该群摘掉(否则每轮都白跑),更新级的必须降级发新消息(否则进度冻住)。
const FATAL = new Set(['token_revoked', 'token_expired', 'invalid_auth', 'account_inactive', 'missing_scope', 'not_authed', 'invalid_auth_token'])
const RETRYABLE = new Set(['ratelimited', 'rate_limited', 'internal_error', 'service_unavailable', 'fatal_error', 'request_timeout'])
const CHANNEL_LEVEL = new Set(['channel_not_found', 'not_in_channel', 'is_archived', 'is_inactive', 'posting_to_channel_denied', 'restricted_action', 'restricted_action_read_only_channel', 'restricted_action_thread_only_channel', 'restricted_action_non_threadable_channel'])
const CONTENT_LEVEL = new Set(['msg_too_long', 'msg_blocks_too_long', 'invalid_blocks', 'too_many_attachments', 'msg_blocks_too_many'])
// ⭐ 这一组的处置是同一个动作:**立刻改发新消息(带 thread_ts)并切换进度指针**(SLACK.md「可靠性」)。
const UPDATE_DEGRADE = new Set(['edit_window_closed', 'message_not_found', 'cant_update_message', 'block_mismatch', 'message_not_in_streaming_state', 'streaming_state_conflict'])

// 把 Slack 错误翻成「哪里不对 + 怎么修」的一句话,给向导拉频道列表、平台预检用(1.0.4)。
// 此前这两处直接显示错误码,`invalid_auth` 这类字样新手看不懂、也不知道去哪修。末尾仍带上原始码,方便搜索与报 issue。
const AUTH_CODES = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'invalid_auth_token'])
function slackHint(e) {
  const code = (e && e.code) || ''
  const p = (e && e.payload) || {}
  if (AUTH_CODES.has(code)) return `Bot Token(xoxb-)无效或已撤销 —— 到 api.slack.com 这个应用的 OAuth & Permissions 页重新安装,换上新 token [${code}]`
  if (code === 'missing_scope') return `缺权限${p.needed ? ' ' + p.needed : ''} —— 在 OAuth & Permissions 里加上,然后重新安装应用才生效 [missing_scope]`
  if (code === 'ratelimited' || code === 'rate_limited') return `触发了 Slack 限流,稍等一会儿再试 [${code}]`
  if (code === 'request_timeout') return `连不上 slack.com —— 检查网络;在中国大陆要先配好代理 [${p.cause || code}]`
  if (code === 'service_unavailable') return 'Slack 服务暂时不可用,稍后再试 [service_unavailable]'
  return code || (e && e.message) || String(e)
}

function classifyError(code) {
  if (!code) return 'other'
  if (FATAL.has(code)) return 'fatal'
  if (UPDATE_DEGRADE.has(code)) return 'degrade'
  if (RETRYABLE.has(code)) return 'retryable'
  if (CHANNEL_LEVEL.has(code)) return 'channel'
  if (CONTENT_LEVEL.has(code)) return 'content'
  return 'other'
}

class SlackError extends Error {
  constructor(code, method, payload) {
    super(`slack ${method} → ${code}`)
    this.name = 'SlackError'
    this.code = code
    this.method = method
    this.payload = payload || null
    this.kind = classifyError(code)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v, d) => (Number(v) > 0 ? Number(v) : d)

// ── 出站正文(SLACK.md「富文本」)──────────────────────────────────────────────────────────────────
// Slack 的 `markdown_text` 吃**标准 Markdown**(实测:标题分层级、嵌套列表、原生表格、
// 代码块带语言标签)⇒ agent CLI 吐什么发什么,飞书那套 mdtable 转换在这里整块省掉。
const MD_LIMIT = 12_000 // 同 payload 内 markdown 累计上限;超出静默丢弃(SLACK.md「富文本」)

// 顶层 `text` 的纯文本回退:⚠ 移动端推送**只读 message.text**(2026-07-13 changelog),
// 只发 markdown_text 不填 text ⇒ 手机推送是空的 —— 对"跑完 40 分钟推我一下"是致命的(SLACK.md「进度表达」)。
function plainFallback(md, max = 300) {
  const s = String(md || '')
    .replace(/```[\s\S]*?```/g, '[代码]')       // 代码块压成一个词,推送里没意义
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')          // 标题符号
    .replace(/[*_~`>]+/g, '')                    // 行内标记
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // 链接只留文字
    .replace(/\s*\n\s*/g, ' ')                   // 推送是单行
    .trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * 一条出站消息的完整 body。三处防御一次写死,所有发送路径共用:
 *  ① 永远带顶层 `text`(移动端推送,SLACK.md「进度表达」)
 *  ② 永远 `unfurl_links/unfurl_media: false` —— 否则 prompt injection 可以借 unfurl
 *    的出站请求把数据带走(SLACK.md「收消息」,官方安全文档专章)
 *  ③ 正文超 MD_LIMIT 先截断并显式标注,不让 Slack 静默吃掉尾部(SLACK.md「富文本」)
 */
/**
 * 群内控制面的按钮(SLACK.md「群内控制面」 的第三条入口)。
 *
 * ⭐ **为什么值得做**:Slack 自己吃掉 `/` 开头的输入,而**注册的斜杠命令在线程里根本调不出来**
 *   (官方明文)—— 偏偏进度消息与答案全都挂在线程里。⇒ 线程内此前只剩 `!stop` 一条路,
 *   而那要求人先知道有这么个写法。按钮是**线程里唯一不需要先教就会用**的入口。
 *
 * ⭐ 清单从注入的 `commands`(引擎的 SLASH_COMMANDS 单一事实源)**过一遍**,不另抄一份 ——
 *   否则哪天引擎去掉某个命令,这里会留下一个按下去说"未知命令"的按钮。
 * ⚠ 故意**不放「开新」**(`/new`):它连会话一起清,而按钮是点一下就生效、没有回头路;
 *   把破坏性最大的那个留给 `!new`(要手打,自带一道门槛)。停止那个则挂原生 confirm ——
 *   真机上出过「跑了 42 分钟、离收尾只差一步却被 /stop 掐掉」,那次代价就是没有这道确认。
 * ⚠ 但这道 confirm **堵不住旁边那个原生 Stop**(Agent Sessions 的 Working… 按钮):它走
 *   `agent_session_stopped` → `engine.stop()`,一键、无确认,且语义不同 —— 只放掉当前轮,
 *   **不清队列、不回群消息**。两个「停止」并排,别以为有了 confirm 就全堵上了。
 */
const CONTROL_BUTTONS = [
  { cmd: '/stop', label: '停止', style: 'danger', confirm: { title: '停止这个群的全部任务?', text: '正在跑的这一轮会被中断,排队里的也都不做了。只想跳过当前这一件的话,点「跳过」。', ok: '停止', cancel: '再想想' } },
  { cmd: '/skip', label: '跳过' },
  { cmd: '/status', label: '状态' },
]

function controlActions(commands = []) {
  const have = new Set(commands)
  return CONTROL_BUTTONS.filter((b) => have.has(b.cmd))
}

/**
 * App Home 的「主页」内容(SLACK.md「群内控制面」 第三层)。纯函数,便于单测。
 *
 * ⭐ **它只讲「在 Slack 里怎么用」,不复制命令表** —— 两个理由,第二个是硬的:
 *   ① 命令表的单一事实源在引擎的 `helpText()`,抄一份过来必然漂移(而漂了的那份会长期
 *     看起来是对的,正是最难发现的一类)。
 *   ② **App Home 是按人发布的,而那张表是按群算的** —— 权限档、provider、有没有画布,
 *     每个群都不同。真把「完整表」放这儿,只能挑一个群的口径显示,对其他群一律是错的。
 *   ⇒ 这一层的职责是**平台专属的入门**(那三个入口、以及为什么不是 `/`),
 *     它在别处无处可放;命令表仍然指向 `!help`,那才是按群算得准的地方。
 *
 * ⭐ 这一层的另一半价值是**改文案不用重装 app**:usage_hint 写在 manifest 里,改一次要重装;
 *   这里是运行时 `views.publish`,改完下次打开就是新的。
 */
/**
 * 该不该给这次 `app_home_opened` 发布主页。
 * ⚠ 抽成纯函数只为一件事:**这个筛子没有测试就等于没有** —— 帧处理那层单测够不着,
 *   而漏筛的代价是每次有人点开 DM 都白打一次 `views.publish`(Messages 页签也发这个事件)。
 */
function shouldPublishHome(event) {
  return !!(event && event.type === 'app_home_opened' && event.tab === 'home' && event.user)
}

function homeView({ alias = '!', umbrella = '/sint' } = {}) {
  const md = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } })
  return {
    type: 'home',
    blocks: [
      md('*在 Slack 里怎么用*'),
      { type: 'divider' },
      // ⚠ 不承诺「直接发消息就行」:开了 onlyWhenMentioned 的群必须 @;而主页是按人发的,
      //   不知道对方在哪个群 ⇒ 只说所有群都成立的那半句。
      md(`*1 · 直接说话* —— 在已绑定的频道里 @ 我(有的群不用 @ 也行,看群的设置)。跑起来之后,进度和答案都挂在那条消息的线程里。`),
      md(`*2 · 线程里点按钮* —— 任务跑着的时候,进度消息上有「停止 / 跳过 / 状态」。`
        + `\n_线程里没法用斜杠命令(Slack 的限制),按钮是线程里最快的那条路。_`),
      md(`*3 · 用 \`${alias}\` 前缀发命令* —— 比如 \`${alias}status\`、\`${alias}stop\`。`
        + `\n_为什么不是 \`/\`:\`/\` 开头的输入被 Slack 自己吃掉了,根本到不了我这儿。_`
        + `\n在频道里(不是线程里)也可以用 \`${umbrella}\`,它有自动补全。`),
      { type: 'divider' },
      md(`发 \`${alias}help\` 看这个群能用哪些命令 —— *那份是按群算的*,权限和模型不同,能用的也不同。`),
    ],
  }
}

/**
 * 按钮点击载荷 → 引擎消息(纯函数,不认得就返回 null)。
 * 抽出来是为了**可单测** —— 帧处理那层要真凭据才跑得起来,而这条路上最该测的两件事
 * (只认自己的按钮 · 不拿本机时钟推水位线)全在这个翻译里。
 */
function actionMessage(payload, { commands = [], now = () => Date.now(), nameOf = () => null } = {}) {
  if (!payload || payload.type !== 'block_actions') return null // view_submission 等一律不接
  const act = (payload.actions || [])[0]
  const cmd = act && String(act.value || '')
  // ⚠ **只认自己发出去的那几个按钮**,两道判据缺一不可:载荷是外部输入,别人 app 的按钮
  //   (或伪造的 value)不该被当成命令喂进引擎。
  //   ① action_id 带我们的前缀 —— 认「是不是我们发的」;② value 在 commands 里 —— 认「引擎
  //   认不认」(commands = 引擎的 SLASH_COMMANDS 单一事实源)。只查②的话,别人 app 里恰好
  //   value 也叫 `/stop` 的按钮会被当真。
  if (!cmd || !commands.includes(cmd)) return null
  if (!String(act.action_id || '').startsWith(ACTION_PREFIX)) return null
  const channel = payload.channel && payload.channel.id
  if (!channel) return null
  const u = payload.user || {}
  // ⚠ 去重键用 action_ts 而不是 trigger_id:trigger_id 是一次性的,同一次点击被重投时会变,
  //   而 action_ts 是那次点击本身的时刻 —— 只有它认得出「这是同一下」。
  const key = act.action_ts || payload.trigger_id || String(now())
  // 名字与消息路径**同源**(users.info 的真名缓存):载荷里的 `name`/`username` 都是 handle,
  //   同一个人发消息叫「小王」、点按钮叫「xiaowang」,群里会以为是两个人。缓存没命中才退到 handle。
  const cached = u.id ? nameOf(u.id) : null
  return {
    chatId: channel,
    userId: u.id || 'unknown',
    senderName: cached || u.name || u.username || u.id || 'user',
    text: cmd,
    msgId: 'action:' + key,
    // ⚠ 同斜杠命令那条:载荷里**没有平台 ts**,只有本机时钟 —— 拿它推水位线就是 v0.11.12
    //   那个「两把钟比大小」的坑(主机钟快 N 秒 = 开了个 N 秒黑洞吞掉真人消息)。
    synthetic: true,
    wantsAck: false,
    createTimeMs: now(),
    // ⭐ 回执落在**按钮所在的那条线程**里:点击本身只有点的人看得见,不回一句的话
    //   其他人只会看到任务莫名停了。挂线程而不是发频道 —— 任务的上下文就在这条线程里。
    // ⚠ 但**只在真有线程时**挂(`thread_ts` 存在 = 这条消息在线程里;顶层消息没有这个字段):
    //   合成轮(定时任务/插话)的进度消息发在频道顶层,若拿它的 `ts` 当线程,回执会开在
    //   一条 finish 时就被删掉的消息下面,挂在「此消息已删除」的墓碑上。那种情况与斜杠命令
    //   同款处置 —— 发频道。
    replyCtx: {
      channel,
      threadTs: (payload.message && payload.message.thread_ts) || null,
    },
  }
}

// 按钮身份前缀。⚠ 不含工具名(用户面零工具名规则的边界②虽豁免不可见标识符,但它会出现在
//   workspace 数据导出里;此刻改零成本,真机验过之后再改就得考虑在途消息)。
//   `actionMessage` 回来时**真的校验它**(见那边)—— 不是装饰。
const ACTION_PREFIX = 'sint_'

function actionsBlock(buttons) {
  if (!buttons || !buttons.length) return null
  return {
    type: 'actions',
    // 官方建议 block_id 每次迭代都换 —— 那是为 `state.values` 准备的;纯按钮场景复用无害。
    // 这里稳定是为了 `actionMessage` 能按前缀认出「这是我们的按钮」(它与 value 一起校验)。
    block_id: ACTION_PREFIX + 'controls',
    elements: buttons.map((b) => ({
      type: 'button',
      text: { type: 'plain_text', text: b.label, emoji: false },
      action_id: ACTION_PREFIX + b.cmd.replace('/', ''), // /stop → sint_stop
      value: b.cmd,
      ...(b.style ? { style: b.style } : {}),
      ...(b.confirm ? {
        confirm: {
          title: { type: 'plain_text', text: b.confirm.title },
          text: { type: 'plain_text', text: b.confirm.text },
          confirm: { type: 'plain_text', text: b.confirm.ok },
          deny: { type: 'plain_text', text: b.confirm.cancel },
          style: 'danger',
        },
      } : {}),
    })),
  }
}

function messagePayload(channel, content, { threadTs = null, ts = null, actions = null } = {}) {
  let md = String(content == null ? '' : content)
  if (md.length > MD_LIMIT) md = md.slice(0, MD_LIMIT - 40) + '\n\n… (超出 Slack 单条上限,已截断)'
  // ⚠⚠ **`markdown_text` 与顶层 `text` 互斥**(2026-09-01 真机:`markdown_text_conflict`),
  //   而两者各自都必需 —— text 管移动端推送、markdown 管渲染。**解法是走 `markdown` block**:
  //   blocks + text 可以共存,实测发得出、渲染正确(读回时 Slack 已把它转成 rich_text)。
  //   ⚠ 顺带解决 SLACK.md「静默失败」 那条「chat.update 只传 text 会静默清空 blocks」—— 这里两者永远同发。
  const body = { channel, text: plainFallback(md), blocks: [{ type: 'markdown', text: md }] }
  // ⚠ 不传 actions 时输出**逐字节与从前相同** —— 出站正文是全链路最热的一段,
  //   加个可选参数不该让既有的每一条消息都变形。
  const ab = actionsBlock(actions)
  if (ab) body.blocks.push(ab)
  if (threadTs) body.thread_ts = threadTs
  // ⚠ unfurl 开关只在**发**的时候有意义(发出去那一刻就定了);chat.update 不收这两个参数。
  if (ts) body.ts = ts
  else Object.assign(body, { unfurl_links: false, unfurl_media: false })
  return body
}

// ── 入站正文(SLACK.md「收消息」)──────────────────────────────────────────────────────────────────
// ⚠ 绝不抄 cc-bot 的 sanitize():它把换行压成空格(`.replace(/[\r\n]/g,' ')`)——
//   sbot 要把多行 prompt 原样喂给 agent,压掉换行就是**毁掉代码块**(SLACK.md「收消息」)。
// ⚠ 顺序要紧:先 lt/gt 再 amp。反过来的话 `&amp;lt;`(用户真的打了 "&lt;")会被解成 `<`。
const ENTITIES = [['&lt;', '<'], ['&gt;', '>'], ['&amp;', '&']]

/**
 * Slack 的 text 是"半转义"的:只转 & < >,并把 @提及/频道/链接包成 <…> 记号。
 * 展开成人能读、agent 也能读的普通文本;`botUserId` 的提及直接剥掉(不然每句都以 @bot 开头)。
 */
function parseText(raw, { botUserId = '' } = {}) {
  let s = String(raw == null ? '' : raw)
  if (botUserId) s = s.split(`<@${botUserId}>`).join(' ')
  s = s
    .replace(/<@([UWB][A-Z0-9]+)(\|([^>]*))?>/g, (_m, id, _p, label) => '@' + (label || id))
    .replace(/<#([CGD][A-Z0-9]+)(\|([^>]*))?>/g, (_m, id, _p, label) => '#' + (label || id))
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+(\|([^>]*))?>/g, (_m, _p, label) => label || '@group')
    // 链接:有标签的还原成 Markdown 链接(agent 读得懂、回得出),裸链接保持原样
    .replace(/<((?:https?|mailto):[^>|]+)\|([^>]*)>/g, '[$2]($1)')
    .replace(/<((?:https?|mailto):[^>|]+)>/g, '$1')
  for (const [k, v] of ENTITIES) s = s.split(k).join(v)
  return s.trim()
}

/**
 * ⚠⚠ **Slack 把 `/` 开头的输入当成它自己的斜杠命令吃掉**(真机 2026-09-01:群里发 `/status`,
 * 消息**根本没到过 bot**)—— 也就是说 sbot 那套群内控制面(/stop /skip /new /status …)
 * 在 Slack 群里整套失效,而 `/stop` 是出事时唯一的刹车。
 *
 * 两条对策,这里实现第一条(零 Slack 侧配置、立刻可用):**替代前缀** `!stop` → `/stop`。
 * 第二条是在 manifest 注册一个 `/sint` 总入口(有自动补全,但要重装 app),走 slash_commands 事件。
 *
 * ⚠ 只还原**清单里真有的**命令 —— 否则一句以 `!` 开头的普通话会被引擎回一句「未知命令」。
 * 清单由 bin 从 `src/core/engine.js` 的 SLASH_COMMANDS 注入(单一事实源,那边有漂移守卫)。
 */
function restoreCommand(text, { commands = [], alias = '!' } = {}) {
  const s = String(text || '')
  if (!alias || !s.startsWith(alias) || !commands.length) return s
  const rest = s.slice(alias.length)
  const head = rest.split(/\s/)[0].toLowerCase()
  if (!commands.includes('/' + head)) return s
  // ⚠ 命令词归一成小写再交给引擎 —— 引擎的 switch 是大小写敏感的,识别了却给它一个 `/STOP`
  //   等于回一句「未知命令」。慌起来打 `!STOP` 的人正是最需要这条命令生效的人。
  return '/' + head + rest.slice(head.length)
}

/**
 * 出站文案里的命令写法本地化:`/stop` → `!stop`。与 `restoreCommand` 正好对称
 * (入站 `!`→`/`,出站 `/`→`!`),两边共用同一份命令清单。
 *
 * ⚠ 为什么必须做:引擎的文案是平台无关的,里面写死了 `/` —— 比如换模型的提示原文是
 * 「换模型:发『/model 名字』」。**在 Slack 群里照做是发不出去的**(平台把 `/` 开头
 * 吞了),群成员照着做一次不灵,就会认为这个 bot 坏了。2026-09-01 真机撞见。
 *
 * ⚠ **只用在引擎自己说的话上(reply/send),绝不用在 agent 的答案上** —— 答案里出现
 * `/status` 完全可能是一条 HTTP 路由,改了就是篡改内容。答案走的是卡片的 finish 那条路,
 * 不经这里。
 * ⚠ 代码块与行内代码整段跳过:那里面的 `/model` 多半是在讲别的系统。
 */
function localizeCommands(text, { commands = [], alias = '!' } = {}) {
  const s = String(text == null ? '' : text)
  if (!alias || alias === '/' || !commands.length) return s
  const names = commands.map((c) => c.replace(/^\//, '')).filter(Boolean)
  if (!names.length) return s
  const re = new RegExp('(^|[\\s(（「『"\'*_\\[·、,,。;;])\\/(' + names.join('|') + ')\\b', 'g')
  // 用代码围栏/行内代码切段,奇数段是代码 —— 原样保留
  return s.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) => (i % 2 ? seg : seg.replace(re, (m, pre, cmd) => pre + alias + cmd)))
    .join('')
}

/**
 * 附件标记(与 feishu.js v0.11.7 同构):图片/文件消息**不能整条丢** —— 飞书那边真机踩过
 * 「我发给你的图里的那张表」,图被静默丢掉,agent 完全不知道有图。标记里的 file_id 正是
 * downloadResource 要的那个参数 ⇒ agent 顺着它自己就能把文件取下来。
 */
function attachmentMarks(files) {
  return (Array.isArray(files) ? files : []).filter((f) => f && f.id).map((f) => {
    const kind = String(f.mimetype || '').startsWith('image/') ? '图片' : '文件'
    const name = f.name || f.title || ''
    return `[${kind}${name ? ' ' + name : ''} file_id=${f.id}]`
  })
}

/**
 * 这条 message 事件要不要交给引擎。返回 'handle' | 'recall' | 丢弃原因(字符串)。
 * ⚠ 三条自我回环防护(SLACK.md「收消息」)全在这里,漏一条就是无限自问自答:
 *   ① `message_changed` 必丢 —— chat.update 会把编辑事件打回给自己(30 分钟任务按 3 秒节流
 *      = 600 条回声),而且 Slack 的自动语言检测在你没动手时也会发它
 *   ② bot 判定看 `bot_id` 字段在不在,**不能**用 `subtype === 'bot_message'`(那是 classic app)
 *   ③ `message_deleted` 要放行给 onRecall,但**自己 chat.delete 触发的那条必须先滤掉**
 * ⚠ `file_share` 单独放行 —— cc-bot 踩过"带图消息被 subtype 一刀切"(SLACK.md「收消息」)。
 */
function shouldHandle(event, { botUserId = '', onlyWhenMentioned = false, ownTs = null } = {}) {
  if (!event || event.type !== 'message') return 'not-message'
  const sub = event.subtype
  if (sub === 'message_deleted') {
    const dts = event.deleted_ts // ⚠ ts 是删除动作的时间,deleted_ts 才是被删的那条(SLACK.md「收消息」)
    if (!dts) return 'deleted-no-ts'
    if (ownTs && ownTs.has(dts)) return 'own-delete'
    return 'recall'
  }
  if (sub === 'message_changed') return 'echo-changed'
  if (sub && sub !== 'file_share') return 'subtype:' + sub
  if (event.bot_id) return 'bot-message'
  if (botUserId && event.user === botUserId) return 'self'
  if (!event.channel) return 'no-channel'
  if (onlyWhenMentioned && event.channel_type !== 'im' && !(botUserId && String(event.text || '').includes(`<@${botUserId}>`))) return 'not-mentioned'
  return 'handle'
}

// ── event_id 去重(SLACK.md「可靠性」)────────────────────────────────────────────────────────
// ⚠ Socket Mode 的 envelope **没有 retry 标记**(官方未记载),分不出首投还是重投 ——
//   只能靠 event_id。TTL 要盖住 Slack 的重试点(1 分钟 / 5 分钟),默认 10 分钟。
function createDedupe({ ttlMs = 10 * 60 * 1000, max = 5000, now = () => Date.now() } = {}) {
  const seen = new Map() // id -> 过期时刻
  return {
    /** true = 第一次见(应处理);false = 重投(丢弃) */
    take(id) {
      if (!id) return true // 没 id 就没法去重,宁可重复也不丢
      const t = now()
      const exp = seen.get(id)
      if (exp && exp > t) return false
      seen.delete(id) // 重新插到队尾,淘汰按插入序才准
      seen.set(id, t + ttlMs)
      if (seen.size > max) {
        for (const [k, e] of seen) if (e <= t) seen.delete(k)                       // 先清过期
        for (const k of seen.keys()) { if (seen.size <= max) break; seen.delete(k) } // 还超就淘汰最旧
      }
      return true
    },
    size: () => seen.size,
  }
}

// ── 事件年龄闸门(SLACK.md「可靠性」)────────────────────────────────────────────
// ⚠ 开了 Delayed Events,守护进程宕机 3 小时后恢复,会收到一堆 20 小时前的"帮我跑一下"
//   并**直接启动一堆过期任务**。⇒ 超龄的一律丢弃(带日志),别让它们进引擎。
function isStale(eventTimeSec, { maxAgeMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
  const t = Number(eventTimeSec)
  if (!t) return false // 没有时间戳就别猜
  return now() - t * 1000 > maxAgeMs
}

// ── Web API 封装 ──────────────────────────────────────────────────────────────────
/**
 * 唯一的出站入口。四条纪律焊死在这里:
 *  ① `ok:false` 显式抛(SLACK.md「可靠性」)—— 不抛就会把"没发出去"当成发出去了
 *  ② 任何 warning 都上报(SLACK.md「静默失败」)—— 那张静默失败表近一半只在这个字段里露头
 *  ③ 重试**短而有界**(SLACK.md「可靠性」):默认最多 2 次、总等待 ≤10 秒。SDK 默认那套
 *     "10 次 / 约 30 分钟"会让 postMessage 重复发、让进度更新卡在队列里冻住
 *  ④ 只对 429 / 5xx / 网络错误重试;业务错误一次就抛(重试也不会变对)
 */
/**
 * ⚠⚠ **出站一律 form 编码,不许用 JSON body**(2026-09-01 真机实测,官方文档没有这一条)。
 * 读类方法会**静默忽略** JSON body 里的参数:`users.list {limit:2}` 走 JSON 返回 **8 个人且
 * `ok:true`**,走 form 才返回 2 个;`users.info {user:U…}` 走 JSON 直接报 `user_not_found`
 * (参数根本没被读到,不是没这个人)。⇒ 这是 SLACK.md「静默失败」「ok:true 但什么都没发生」那一族的新成员,
 * 而且是最阴的一种:**分页/过滤参数被忽略时连错误都没有**。
 * 嵌套值(blocks / files)按官方 form 约定序列化成 JSON 字符串,写方法实测通过。
 */
function encodeParams(body) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(body || {})) {
    if (v === undefined || v === null) continue
    p.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  return p
}

function createSlackApi(token, { log = () => {}, fetchImpl = null, sleepImpl = sleep, timeoutMs = 15_000, retryCapMs = 10_000 } = {}) {
  const doFetch = fetchImpl || netFetch
  return async function call(method, body = {}, { retries = 2, tokenOverride = null, onHeaders = null } = {}) {
    let attempt = 0
    let waited = 0
    for (;;) {
      let res
      try {
        res = await doFetch(API + method, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenOverride || token}`,
            // ⚠ 不带 charset —— 带了 Slack 每条响应都回一个 `superfluous_charset` warning
            //   (真机 2026-09-01 实测)。form 编码本来就是 UTF-8,写了纯属噪音,
            //   而噪音会把真正的 warning(那张静默失败表)淹掉。
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: encodeParams(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        if (attempt++ < retries) { const w = Math.min(1000 * 2 ** attempt, retryCapMs - waited); if (w > 0) { waited += w; await sleepImpl(w); continue } }
        throw new SlackError('request_timeout', method, { cause: (e && e.message) || String(e) })
      }
      if (res.status === 429) {
        // ⚠ 超限后继续硬发,官方警告 app 有被永久停用的风险 ⇒ 严格按 Retry-After 等
        const after = Math.max(1, Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 1) * 1000
        if (attempt++ < retries && waited + after <= retryCapMs) { waited += after; log(`slack ${method}: 429,等 ${after / 1000}s 重试`); await sleepImpl(after); continue }
        throw new SlackError('ratelimited', method, { retryAfterMs: after })
      }
      if (res.status >= 500) {
        if (attempt++ < retries) { const w = Math.min(1000 * 2 ** attempt, Math.max(0, retryCapMs - waited)); if (w > 0) { waited += w; await sleepImpl(w); continue } }
        throw new SlackError('service_unavailable', method, { status: res.status })
      }
      // 已授予的 scope 只出现在响应头里(没有专门的接口)⇒ 预检要用就得在这层给出去
      if (onHeaders) { try { onHeaders(res.headers) } catch {} }
      const j = await res.json().catch(() => null)
      if (!j || typeof j !== 'object') throw new SlackError('invalid_response', method, { status: res.status })
      if (!j.ok) throw new SlackError(j.error || 'unknown_error', method, j)
      const warn = j.warning || (j.response_metadata && j.response_metadata.warnings)
      if (warn) log(`⚠ slack ${method} 有 warning(可能是静默失败,见 https://github.com/sintlab/sintbot/blob/main/docs/zh-CN/SLACK.md「静默失败」): ${JSON.stringify(warn).slice(0, 200)}`)
      return j
    }
  }
}

// ── 附件下载(SLACK.md「收消息」)────────────────────────────────────────────────────────────────
// ⚠ 认证缺失时 Slack 返回 **HTTP 200 + HTML 登录页**,不是 401 —— 不嗅探就会把一堆 HTML
//   写进 .png,之后 vision 那条链路报的错完全指不到这里。
async function downloadFile(call, token, fileId, destPath, { fetchImpl = null } = {}) {
  const doFetch = fetchImpl || netFetch
  const info = await call('files.info', { file: fileId })
  const f = (info && info.file) || {}
  const url = f.url_private_download || f.url_private
  if (!url) throw new SlackError('file_not_found', 'files.info', { fileId })
  const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow' })
  if (!res.ok) throw new SlackError('download_failed', 'files.download', { status: res.status })
  const ctype = String((res.headers && res.headers.get && res.headers.get('content-type')) || '')
  const buf = Buffer.from(await res.arrayBuffer())
  const head = buf.slice(0, 64).toString('utf8').trimStart().toLowerCase()
  if (ctype.includes('text/html') || head.startsWith('<!doctype') || head.startsWith('<html')) {
    throw new SlackError('download_got_login_page', 'files.download', { hint: '凭据无效或缺 files:read —— Slack 用 200 + 登录页表达这件事' })
  }
  const part = destPath + '.part' // 写完再改名:半截文件绝不出现在最终路径上
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(part, buf)
  fs.renameSync(part, destPath)
  return { path: destPath, bytes: buf.length, name: f.name || path.basename(destPath), mimetype: f.mimetype || ctype }
}

/**
 * 进度更新节流器。⚠ 引擎每来一段助手文本就调一次 `update`(engine.js:1749),外加 15 秒一跳的
 * 脉搏 —— 不节流会直接把 `chat.update` 的 **Tier 3(50/min,per workspace per app,不按频道拆)**
 * 打满,而配额是整个 app 共享的:12 个并发任务按 4 次/分就到顶了(SLACK.md「进度表达」)。
 * ⭐ 撞到 429 就自动把间隔翻倍(封顶 60s)—— 官方警告超限后继续硬发有被永久停用的风险。
 * 语义:窗口内只留最后一帧(进度是全量重写,中间帧丢了无所谓);内容没变则整帧跳过。
 */
function createProgressThrottle({ intervalMs = 20_000, send, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} } = {}) {
  let last = 0, pending = null, timer = null, sentText = null, closed = false
  let gap = Math.max(1000, Number(intervalMs) || 20_000)
  const fire = async () => {
    timer = null
    if (closed || pending == null) return
    const text = pending
    pending = null
    if (text === sentText) return // 没变就别发 —— 一次白发也是一次配额
    last = now()
    sentText = text
    try {
      await send(text)
    } catch (e) {
      if (e && (e.code === 'ratelimited' || e.code === 'rate_limited')) {
        gap = Math.min(60_000, gap * 2)
        log(`slack 进度刷新撞到限流,间隔放大到 ${Math.round(gap / 1000)}s`)
      }
      sentText = null // 没发成功就别把它记成已发,下一帧照发
    }
  }
  return {
    update(text) {
      if (closed) return
      pending = String(text == null ? '' : text)
      if (timer) return
      const wait = Math.max(0, gap - (now() - last))
      timer = setTimer(fire, wait)
      if (timer && timer.unref) timer.unref()
    },
    /** 排干在途的一帧 —— 收尾前必须调,否则收尾后还会被补一帧盖回去 */
    async settle() {
      if (timer) { clearTimer(timer); timer = null }
      await fire()
    },
    close() { closed = true; if (timer) { clearTimer(timer); timer = null } },
    get intervalMs() { return gap },
  }
}

// ── 控制台助手(与 feishu.js 的 feishuPrecheck / fetchChats 平级)────────────────────
// 这些不参与消息收发,只服务控制台的「Slack 应用」卡与绑群下拉。

// 少一条就会静默失效的 scope(SLACK.md「scope 与 manifest」;分类依据是"缺了会怎样",不是官方文档的排列)
const REQUIRED_SCOPES = ['chat:write', 'channels:history', 'channels:read', 'users:read']
const RECOMMENDED_SCOPES = {
  'groups:history': '私有频道收不到消息',
  'im:history': '单人 DM 收不到消息',
  'mpim:history': '群组 DM 收不到消息',
  'groups:read': '私有频道不出现在绑群列表里',
  'reactions:write': '收到消息时的 👀 回执发不出',
  'files:read': '群成员发的图片/文件下载不了',
  'chat:write.public': '没被 /invite 的公开频道发不了消息',
}

/**
 * 一次性把「能不能用」查清楚,每条都给可照做的下一步 —— 与飞书那张预检卡同一形态。
 * ⚠ scope 从响应头 `x-oauth-scopes` 读:Slack 没有"查我有哪些 scope"的接口,
 *   而缺 scope 的典型症状是**事件静默不来**(SLACK.md「静默失败」),不主动对照就只能靠猜。
 */
async function slackPrecheck(botToken, appToken, { fetchImpl = null } = {}) {
  const call = createSlackApi(botToken, { fetchImpl })
  const checks = []
  let botUserId = null
  let identity = null
  let scopes = []

  try {
    const me = await call('auth.test', {}, { retries: 1, onHeaders: (h) => { scopes = String((h.get && h.get('x-oauth-scopes')) || '').split(',').map((x) => x.trim()).filter(Boolean) } })
    botUserId = me.user_id || null
    identity = { botName: me.user || '', botUserId, team: me.team || '', teamId: me.team_id || '', url: me.url || '' }
    checks.push({ key: 'auth', status: 'ok', label: 'bot 凭据', detail: `${me.user || 'bot'} · ${me.team || ''}` })
  } catch (e) {
    checks.push({ key: 'auth', status: 'fail', label: 'bot 凭据', detail: slackHint(e) })
    return { checks, botUserId, identity, scopes }
  }

  const missing = REQUIRED_SCOPES.filter((x) => !scopes.includes(x))
  checks.push(missing.length
    ? { key: 'scopes', status: 'fail', label: '必需权限', detail: `缺 ${missing.join(' / ')} —— 改 manifest 后要**重新安装**才生效` }
    : { key: 'scopes', status: 'ok', label: '必需权限', detail: `${scopes.length} 项已授予` })
  const weak = Object.entries(RECOMMENDED_SCOPES).filter(([k]) => !scopes.includes(k))
  if (weak.length) checks.push({ key: 'scopes-opt', status: 'warn', label: '可选权限', detail: weak.map(([k, why]) => `${k}(${why})`).join(' · ') })

  // app-level token:除了真去开一次连接,没有别的验法(拿到 URL 就够了,不连)
  try {
    await call('apps.connections.open', {}, { retries: 0, tokenOverride: appToken })
    checks.push({ key: 'socket', status: 'ok', label: 'Socket Mode', detail: 'app token 有效,长连接可建立' })
  } catch (e) {
    const code = (e && e.code) || String(e)
    checks.push({ key: 'socket', status: 'fail', label: 'Socket Mode', detail: code === 'invalid_auth' ? 'xapp 无效 —— Basic Information → App-Level Tokens 重取(要勾 connections:write)' : code })
  }

  try {
    const chans = await fetchSlackChannels(botToken, { fetchImpl })
    checks.push(chans.length
      ? { key: 'channels', status: 'ok', label: '已加入的频道', detail: `${chans.length} 个 —— 绑群时从这里选` }
      : { key: 'channels', status: 'warn', label: '已加入的频道', detail: '一个都没有 —— 去频道里发 `/invite @bot`,不做这步收不到任何消息' })
  } catch (e) {
    checks.push({ key: 'channels', status: 'warn', label: '已加入的频道', detail: slackHint(e) })
  }

  return { checks, botUserId, identity, scopes }
}

/**
 * bot 已加入的频道(绑群下拉的数据源)。
 * ⚠ 两个静默失败点都在这三行里(SLACK.md「静默失败」):**`types` 必须显式给全** —— 默认只有
 *   `public_channel`,私有群/DM 会整体缺席且不报错;**分页必须走 cursor** ——
 *   服务端过滤在分页之后,某页只回几条但 `next_cursor` 非空,`len<limit` 判不出结束。
 * ⭐ 用 `users.conversations` 而不是 `conversations.list`:前者只回**bot 自己在里面的**频道,
 *   而 bot 不在的频道绑了也收不到消息 —— 列出来只会让人绑一个死群。
 */
async function fetchSlackChannels(botToken, { fetchImpl = null, maxPages = 10 } = {}) {
  const call = createSlackApi(botToken, { fetchImpl })
  const out = []
  let cursor = ''
  for (let i = 0; i < maxPages; i++) {
    const r = await call('users.conversations', {
      // ⚠ **只列频道,不列 DM** —— 两个理由:① sbot 是"一群一项目",DM 不是绑定对象;
      //   ② 真机 2026-09-01 实测:带上 `mpim,im` 会报 `missing_scope needed=mpim:read` ——
      //   **`mpim:history` 并不蕴含 `mpim:read`**(收得到消息 ≠ 列得出会话),要 DM 就得多要
      //   两个 scope 并重装 app。不值当。
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    }, { retries: 1 })
    for (const c of r.channels || []) {
      out.push({
        id: c.id,
        name: c.is_im ? `DM · ${c.user || c.id}` : (c.name || c.id),
        isPrivate: !!c.is_private,
        isIm: !!c.is_im,
        members: Number(c.num_members) || 0,
      })
    }
    cursor = (r.response_metadata && r.response_metadata.next_cursor) || ''
    if (!cursor) break
  }
  return out
}

/** 一次性发一条文本(控制台绑群回执用;与 feishu.js 的 sendChatText 平级)。 */
async function sendSlackText(botToken, channel, text, { fetchImpl = null } = {}) {
  const call = createSlackApi(botToken, { fetchImpl })
  const r = await call('chat.postMessage', messagePayload(channel, text), { retries: 1 })
  return (r && r.ts) || null
}

// ── 平台本体 ──────────────────────────────────────────────────────────────────────
/**
 * @param {object} o
 *   botToken   xoxb-… (chat:write, channels:history, reactions:write, files:read, users:read)
 *   appToken   xapp-… (connections:write) —— 只用于 apps.connections.open
 *   botUserId  可选;不传则 start() 时用 auth.test 自取(顺带验证凭据)
 *   onlyWhenMentioned  公开频道里只在被 @ 时响应(DM 永远响应)
 *   replyInThread      回复挂进线程(默认 true,SLACK.md「收消息」:Slack 的"回复"就是 thread)
 *   maxEventAgeMs      事件年龄闸门,默认 10 分钟(SLACK.md「可靠性」)
 *   ws {}              重连调优:backoffBaseMs / backoffCapMs / staleReconnectingMs /
 *                      tickIntervalMs / refreshRatio / debugReconnects
 */
function createSlackPlatform({
  botToken, appToken, botUserId = '', onlyWhenMentioned = false,
  replyInThread = true, maxEventAgeMs = 10 * 60 * 1000,
  commands = [], commandAlias = '!', umbrellaCommand = '/sint',
  card = {}, log = () => {}, onConn = () => {}, ws = {}, fetchImpl = null,
} = {}) {
  if (!botToken || !appToken) throw new Error('slack: botToken (xoxb-) and appToken (xapp-) required')
  // env 里有代理变量但我们用不了(典型:shell 的 all_proxy=socks5://…)⇒ 出网会直连,**要说出来**:
  //   直连被墙的错误形态完全指不到"代理没生效"。只在没注 fetchImpl 时说(注了 = 单测/探针,不出网)。
  if (!fetchImpl) { const w = proxyWarning(); if (w) log('⚠ ' + w) }

  const call = createSlackApi(botToken, { log, fetchImpl })
  const dedupe = createDedupe()
  const ownTs = new Set()      // 自己发过/删过的 ts —— 回环与"自杀式撤回"防护(SLACK.md「收消息」)
  const nameCache = new Map()  // userId -> 名字 | null
  let selfId = botUserId
  let sock = null              // 当前生效的连接
  let standby = null           // 无缝切换期间的新连接(disconnect:warning / 主动刷新)
  let connecting = false
  let stopped = false
  let fatal = null             // 致命凭据错误 ⇒ 停止一切重试(SLACK.md「可靠性」)
  let fatalAt = 0
  // 启动期就撞上致命凭据错误时没有看门狗,健康快照由它出(形状与看门狗快照一致)
  const fatalSnapshot = () => ({ state: 'failed', since: fatalAt, lastReadyAt: 0, lastEventAt: 0, reconnects: 0, rebuilds: 0, lastError: `凭据失效(${fatal})` })
  let watchdog = null
  let refreshTimer = null, retryTimer = null, tickTimer = null
  let approxLifeSec = 0
  let consecFail = 0

  const tickIntervalMs = num(ws.tickIntervalMs, 30_000)
  const refreshRatio = Number(ws.refreshRatio) > 0 && Number(ws.refreshRatio) < 1 ? Number(ws.refreshRatio) : 0.9
  const wdOpts = {
    staleReconnectingMs: num(ws.staleReconnectingMs, 120_000),
    backoffBaseMs: num(ws.backoffBaseMs, 2_000),
    backoffCapMs: num(ws.backoffCapMs, 60_000),
  }
  // ⚠ apps.connections.open 是 Tier 3(50/min),重连间隔**不得低于 1.2 秒**,
  //   否则崩溃循环会撞 429 → 更连不上(SLACK.md「可靠性」)。抖动是为了避免双机同时重连。
  const reconnectDelay = () => Math.min(wdOpts.backoffCapMs, Math.max(1200, wdOpts.backoffBaseMs * 2 ** Math.min(consecFail, 5))) * (0.8 + Math.random() * 0.4)

  const clearTimer = (t) => { if (t) { try { clearTimeout(t) } catch {} } return null }
  const remember = (ts) => {
    if (!ts) return
    ownTs.add(ts)
    for (const k of ownTs) { if (ownTs.size <= 2000) break; ownTs.delete(k) } // Set 保序,淘汰最旧
  }

  async function nameOf(userId) {
    if (!userId) return null
    if (nameCache.has(userId)) return nameCache.get(userId)
    try {
      const r = await call('users.info', { user: userId }, { retries: 0 })
      const u = (r && r.user) || {}
      const name = (u.profile && (u.profile.display_name || u.profile.real_name)) || u.real_name || u.name || null
      nameCache.set(userId, name)
      return name
    } catch (e) {
      nameCache.set(userId, null) // 缓存失败,别每条消息都去撞一次(缺 users:read 时尤其)
      log('slack users.info 失败(发送者名回退为 user id): ' + (e && e.message))
      return null
    }
  }

  // ⚠ 这里的重试是**明示的取舍**:网络超时但服务端其实已成功时,重试会把同一条答案发两遍
  //   (SLACK.md「可靠性」 点名的风险)。Slack 的 chat.postMessage 没有幂等键,二选一 ——
  //   而本仓的口径一向是「把消息弄丢才是事故」(见 feishu.js reply 的兜底注释),
  //   所以选重复。⭐ 进度更新走 updateMessage(retries:0),不吃这个取舍。
  async function postMessage(channel, content, { threadTs = null, retries = 2, actions = null } = {}) {
    if (!channel || !content) return null
    try {
      const r = await call('chat.postMessage', messagePayload(channel, content, { threadTs, actions }), { retries })
      // ⚠ "送达"以副作用为准,不以 ok:true 为准(SLACK.md「静默失败」):没有 ts 就是没发出去
      if (!r || !r.ts) { log('slack postMessage: ok 但没有 ts —— 按未送达处理'); return null }
      remember(r.ts)
      return r.ts
    } catch (e) {
      onApiError('chat.postMessage', e, channel)
      return null
    }
  }

  // 进度消息的初值。引擎马上就会用真正的进度覆盖它;它只是"这一轮已经开始了"的占位。
  const T_PROGRESS_INIT = '⏳ 处理中…'

  /** 👀/⏳/✅ 这类回执。already_reacted 视为成功(重启后补发同一个不该报错)。 */
  async function addReactionTo(channel, ts, name) {
    if (!channel || !ts || !name) return false
    try { await call('reactions.add', { channel, timestamp: ts, name }, { retries: 1 }); return true } catch (e) {
      if (e && e.code === 'already_reacted') return true
      log(`slack reactions.add(${name}) 失败: ${(e && e.code) || e}`)
      return false
    }
  }
  async function removeReactionFrom(channel, ts, name) {
    if (!channel || !ts || !name) return false
    try { await call('reactions.remove', { channel, timestamp: ts, name }, { retries: 0 }); return true } catch (e) {
      if (e && (e.code === 'no_reaction' || e.code === 'message_not_found')) return true
      log(`slack reactions.remove(${name}) 失败: ${(e && e.code) || e}`)
      return false
    }
  }
  /** 删自己发的消息。⚠ 先记下 ts —— 否则删除事件打回来会被当成"用户撤回即停"(SLACK.md「收消息」)。 */
  async function deleteOwnMessage(channel, ts) {
    if (!channel || !ts) return false
    remember(ts)
    try { await call('chat.delete', { channel, ts }, { retries: 1 }); return true } catch (e) { log('slack chat.delete 失败: ' + ((e && e.code) || e)); return false }
  }

  function onApiError(where, e, channel) {
    const kind = (e && e.kind) || 'other'
    if (kind === 'fatal') {
      fatal = e.code
      log(`🔴 slack ${where} 致命错误 ${e.code} —— 凭据失效,已停止重试。去 api.slack.com 重取 token 后重启守护进程。`)
      try { if (watchdog) watchdog.onError(e) } catch {}
    } else if (kind === 'channel') {
      log(`slack ${where}: 频道级错误 ${e.code}(channel=${channel || '?'})—— 该群应从路由表摘掉`)
    } else {
      log(`slack ${where} error: ${(e && e.message) || e}`)
    }
  }

  // ── Socket Mode ─────────────────────────────────────────────────────────────
  function closeSocket(s, why) {
    if (!s) return
    try { s.__intentional = true; s.close() } catch {}
    log(`slack socket closed (${why})`)
  }

  function scheduleReconnect() {
    if (stopped || fatal || retryTimer || connecting || standby) return // ⚠ 候补在途时再开一条 = too_many_websockets
    const d = Math.round(reconnectDelay())
    retryTimer = setTimeout(() => { retryTimer = null; openSocket({ replacement: false }) }, d)
    if (retryTimer.unref) retryTimer.unref()
  }

  async function openSocket({ replacement = false } = {}) {
    if (stopped || fatal || connecting) return
    if (replacement && standby) return // ⚠ 同时只允许一条候补 —— 多开就是 too_many_websockets(SLACK.md「可靠性」)
    connecting = true
    let url
    try {
      // ⚠ app-level token 必须放 Authorization header,做 POST 参数会报错(2026-08-31 实测)
      const r = await call('apps.connections.open', {}, { retries: 1, tokenOverride: appToken })
      url = r && r.url
      if (!url) throw new SlackError('no_url', 'apps.connections.open', r)
    } catch (e) {
      connecting = false
      consecFail++
      onApiError('apps.connections.open', e, null)
      if (!fatal) { if (watchdog) watchdog.onReconnecting(); scheduleReconnect() }
      return
    }
    // ⭐ 调试神技:连接寿命缩到 360 秒,断线重连逻辑 6 分钟一轮而不是几小时(SLACK.md「可靠性」)
    if (ws.debugReconnects) url += (url.includes('?') ? '&' : '?') + 'debug_reconnects=true'

    // ⚠ WS 与 REST **共用同一个隧道 agent**:`ws` 同样不读 `http_proxy`,而它不走代理时的
    //   表现是**「连上了但一直没 Hello」** —— 连 error 都不报,最像"Slack 挂了"的一种失败。
    const s = new WebSocket(url, { agent: getProxyAgent() || undefined })
    s.__replacement = replacement
    s.addEventListener('open', () => { connecting = false })
    s.addEventListener('message', (ev) => onFrame(s, ev && ev.data))
    s.addEventListener('error', (ev) => {
      connecting = false
      const msg = (ev && (ev.message || (ev.error && ev.error.message))) || 'websocket error'
      log('slack socket error: ' + msg)
    })
    s.addEventListener('close', () => {
      connecting = false
      const wasStandby = s === standby
      if (wasStandby) standby = null
      else if (s === sock) sock = null
      else return // 交接时关掉的旧连接 —— 早就不是当前连接了,不触发任何动作
      if (stopped || fatal) return
      if (sock) return // 主连接还在(候补没起来 / 已交接完)—— 别再开一条
      if (s.__intentional && !wasStandby) return
      consecFail++
      if (watchdog) watchdog.onReconnecting()
      // ⚠ 断线期间的事件 Slack **不补发**(SLACK.md「可靠性」:"you may lose events until you
      //   establish a connection")—— 这里只能尽快连回来;补拉历史要等接线时按群做。
      scheduleReconnect()
    })
    if (replacement) standby = s
    else sock = s
  }

  function promote(s) {
    if (s !== standby) return
    const old = sock
    sock = s
    standby = null
    closeSocket(old, 'handover') // 先连上新的再关旧的:官方给 10 秒预告就是为了这个
  }

  function onFrame(s, raw) {
    let m
    try { m = JSON.parse(typeof raw === 'string' ? raw : String(raw)) } catch { return }

    if (m.type === 'hello') {
      approxLifeSec = (m.debug_info && Number(m.debug_info.approximate_connection_time)) || 0
      if (s.__replacement) promote(s)
      consecFail = 0
      if (watchdog) (s.__replacement ? watchdog.onReconnected() : watchdog.onReady())
      s.__replacement = false
      log(`slack socket hello(连接数 ${m.num_connections || '?'} · 预计存活≈${approxLifeSec || '?'}s · host=${(m.debug_info && m.debug_info.host) || '?'})`)
      // ⭐ 服务端明说这条连接大概能活多久(实测 ≈5 小时)⇒ 提前 10% 主动换,别等它断(SLACK.md「可靠性」)
      refreshTimer = clearTimer(refreshTimer)
      if (approxLifeSec > 60) {
        refreshTimer = setTimeout(() => { if (!stopped && !fatal) openSocket({ replacement: true }) }, Math.round(approxLifeSec * 1000 * refreshRatio))
        if (refreshTimer.unref) refreshTimer.unref()
      }
      return
    }

    if (m.type === 'disconnect') {
      log(`slack socket disconnect: reason=${m.reason || '?'}`)
      if (m.reason === 'link_disabled') {
        // 有人在 app 设置里关了 Socket Mode —— 重连一万次也没用,停下来并说清楚
        fatal = 'link_disabled'
        if (watchdog) watchdog.onError(new Error('Socket Mode 已在 app 设置里被关闭'))
        return
      }
      // warning ≈ 10 秒后断(⚠ 官方明说可能收不到)/ refresh_requested 例行刷新 /
      // too_many_websockets(不在官方文档里但生产必现,node-slack-sdk#1654)
      if (s === sock && !standby) openSocket({ replacement: true })
      return
    }

    // ⚠ 收到就立刻 ack,业务异步跑(SLACK.md「可靠性」)。Socket Mode 下 ack 超时全站没写明,
    //   而 60 分钟内失败率超 95% 会让事件订阅被临时禁用 ⇒ ack 之前永远不 await 任何东西。
    if (m.envelope_id) { try { s.send(JSON.stringify({ envelope_id: m.envelope_id })) } catch (e) { log('slack ack 失败: ' + (e && e.message)) } }
    if (watchdog) watchdog.onEvent()

    const payload = m.payload || {}

    // 注册过的斜杠命令(manifest 里的 `/sint`)走这条,不是 events_api。
    // ⚠ Slack 的斜杠命令**只有发起人看得见**(它不是频道消息)⇒ 我们照常用 chat.postMessage
    //   把回执发进频道,群里其他人才知道谁停了什么。
    if (m.type === 'slash_commands') {
      const cmdText = String(payload.text || '').trim()
      // `/sint stop` ⇒ 引擎要的是 `/stop`;若将来直接注册了 `/stop`,则原样用它。
      const asEngine = payload.command === umbrellaCommand ? '/' + cmdText : `${payload.command} ${cmdText}`.trim()
      if (!dedupe.take('slash:' + payload.trigger_id)) return
      const now = Date.now()
      Promise.resolve(emit({
        chatId: payload.channel_id,
        userId: payload.user_id || 'unknown',
        senderName: payload.user_name || payload.user_id || 'user',
        text: asEngine,
        msgId: 'slash:' + (payload.trigger_id || now),
        // ⚠ synthetic:斜杠命令的载荷**没有平台 ts**,只有本机时钟 —— 拿它推水位线就是
        //   v0.11.12 那个「两把钟比大小」的坑(会静默吞掉真人消息)。
        synthetic: true,
        wantsAck: false,
        createTimeMs: now,
        replyCtx: { channel: payload.channel_id }, // 不挂线程:控制面的回执该让全群看见
      })).catch((e) => log('slack slash onMessage error: ' + (e && e.message)))
      return
    }

    // 按钮点击(Block Kit)。⭐ **不需要改 manifest 也不用重装** —— `interactivity` 早就开着,
    //   Socket Mode 下这类载荷本来就在投递,此前只是被上面那行 `return` 丢掉了。
    // ⚠ 斜杠命令在**线程里调不出来**,而进度消息就在线程里 ⇒ 这是线程内唯一免教学的控制入口。
    if (m.type === 'interactive') {
      // 名字取消息路径同一份缓存(同步读;没命中就退回载荷里的 handle,不为一个按钮去打 users.info)
      const msg = actionMessage(payload, { commands, nameOf: (id) => (nameCache.has(id) ? nameCache.get(id) : null) })
      if (!msg) return
      if (!dedupe.take(msg.msgId)) return
      Promise.resolve(emit(msg)).catch((e) => log('slack action onMessage error: ' + (e && e.message)))
      return
    }

    if (m.type !== 'events_api') return
    const eventId = payload.event_id
    const eventTime = payload.event_time
    const event = payload.event
    if (!event) return
    if (!dedupe.take(eventId)) { log(`slack 重投事件已丢弃 event_id=${eventId}`); return }
    if (isStale(eventTime, { maxAgeMs: maxEventAgeMs })) {
      // Delayed Events 开启后最多补投 24 小时 —— 过期的"帮我跑一下"绝不能真去跑(SLACK.md「可靠性」)
      log(`slack 事件超龄已丢弃(${Math.round((Date.now() / 1000 - eventTime) / 60)} 分钟前): ${event.type}`)
      return
    }
    try { handleEvent(event) } catch (e) { log('slack event error: ' + (e && e.message)) }
  }

  let emit = () => {}
  let hooks = {}

  function handleEvent(event) {
    if (event.type === 'app_mention') return // 被 @ 时 message 与 app_mention 同时来,以 message 为准(SLACK.md「收消息」)
    if (event.type === 'app_rate_limited') { log('🔴 slack app_rate_limited —— 事件投递已超 30,000/小时,期间的消息全部丢失'); return }
    if (event.type === 'agent_session_stopped') { if (hooks.onAgentStop) hooks.onAgentStop({ chatId: event.channel, threadTs: event.thread_ts, userId: event.user }); return }
    // App Home 主页。⚠ 这个事件**两个页签都会来**(Messages 也算),不筛就等于每次有人点开
    //   DM 都白发一次 views.publish。⚠ 失败一律只记日志:主页发不出来不该影响任何一轮任务。
    if (event.type === 'app_home_opened') {
      if (!shouldPublishHome(event)) return
      call('views.publish', { user_id: event.user, view: homeView({ alias: commandAlias, umbrella: umbrellaCommand }) }, { retries: 0 })
        .catch((e) => log(`slack App Home 发布失败(${(e && e.code) || e})—— 不影响任务;`
          + `多半是 manifest 里没开 app_home.home_tab_enabled,改完要重装 app`))
      return
    }
    if (event.type !== 'message') return

    const verdict = shouldHandle(event, { botUserId: selfId, onlyWhenMentioned, ownTs })
    if (verdict === 'recall') {
      log(`slack recall event: chat=${event.channel || '?'} msg=${event.deleted_ts}`)
      if (hooks.onRecall) hooks.onRecall({ chatId: event.channel, msgId: event.deleted_ts })
      return
    }
    if (verdict !== 'handle') return

    const files = Array.isArray(event.files) ? event.files : []
    const body = restoreCommand(parseText(event.text, { botUserId: selfId }), { commands, alias: commandAlias })
    const text = [body, ...attachmentMarks(files)].filter(Boolean).join('\n')
    if (!text) return

    // 发送者名:**绝不在这里 await**。命中缓存就同步用,未命中回退 user id 并后台预热 ——
    // 这条纪律照搬 feishu.js:每帧是独立的并发 listener,一个 await 会让后到但已缓存的消息
    // 先进引擎、推高该群的水位线,更早那条反被当成过期丢掉(engine.js 单调水位线)。
    let senderName = event.user || 'user'
    if (event.user) {
      if (nameCache.has(event.user)) senderName = nameCache.get(event.user) || event.user
      else nameOf(event.user).catch(() => {})
    }

    const images = files.filter((f) => String(f.mimetype || '').startsWith('image/')).map((f) => ({ key: f.id, name: f.name || f.title || f.id }))

    Promise.resolve(emit({
      chatId: event.channel,
      userId: event.user || 'unknown',
      senderName,
      text,
      msgId: event.ts,
      ...(images.length ? { images } : {}),
      createTimeMs: Math.round(parseFloat(event.ts) * 1000) || Date.now(), // ts 是 epoch 秒(带微秒小数)
      // userId 进 replyCtx 是给 agents.sessions.setStatus 当 initiator_user_id 用的 ——
      // 原生 Working… 那条要显示"谁发起的"。⚠ 它只在会话**首次创建**时生效,之后静默忽略。
      replyCtx: { channel: event.channel, ts: event.ts, threadTs: event.thread_ts || event.ts, userId: event.user || '' },
    })).catch((e) => log('slack onMessage error: ' + (e && e.message)))
  }

  return {
    // 自描述(引擎按它改写自知清单;core 不认平台名,只读这几个字段)。不声明 skillCmd:Slack 还没有
    // 基础技能命令(文件上下行没接,docs/SLACK.md 第 3 步)⇒ features.skills:false 让清单把那一段整段换成「写路径」。
    // 回复是独立落地的消息、不是钉在轮次开头的卡片;读历史 / 回复编辑撤回 / 表情 / 下载 / 画布 / 生图通知 / 接管卡都没接。
    chatLabel: 'Slack 群',
    features: { skills: false, history: false, editRecall: false, react: false, download: false, boards: false, imagen: false, takeoverCard: false, cardPinned: false, noticeCard: false },

    async start(onMessage, h = {}) {
      emit = onMessage
      hooks = h || {}
      // auth.test 一石二鸟:验凭据(错了立刻在启动期炸,而不是第一条消息时静默不回)+ 取自己的
      // user id(回环防护与 @ 门禁都靠它)。⚠ 没有它 onlyWhenMentioned 形同虚设。
      try {
        const me = await call('auth.test', {}, { retries: 1 })
        selfId = selfId || me.user_id
        log(`slack 已认证:bot=${me.user || '?'}(${selfId}) team=${me.team || '?'}`)
      } catch (e) {
        onApiError('auth.test', e, null)
        // 凭据本身就是错的 ⇒ Slack 这一路停在「连接失败」、不再重试 —— 但**不抛**:多平台路由器里飞书 / 企微与它同进程,
        // 抛出去 = 整个 daemon 起不来(launchd 还会反复拉起再退),别的平台的群全跟着停(企微适配器同样从不在 start 里抛)。
        // 失败态经 connHealth(控制台「Slack 连接」行)与 onConn(运维告警的断线观察)报出去;换好 token 重启即恢复。
        if (fatal) { fatalAt = Date.now(); try { onConn(fatalSnapshot()) } catch {} ; return }
      }
      watchdog = createWatchdog({ rebuild: () => { closeSocket(sock, 'watchdog-rebuild'); sock = null; standby = null; connecting = false; openSocket({ replacement: false }) }, log, onConn, ...wdOpts })
      await openSocket({ replacement: false })
      tickTimer = setInterval(() => { if (watchdog) watchdog.tick() }, tickIntervalMs)
      if (tickTimer.unref) tickTimer.unref()
      log('slack Socket Mode 已启动(watchdog on)')
    },

    // 控制台健康行读它;字段与飞书同口径(src/ui/server.js connHealthStatus)
    connHealth() {
      const base = watchdog ? watchdog.snapshot() : fatal ? fatalSnapshot() : { state: 'stopped', since: 0, lastReadyAt: 0, lastEventAt: 0, reconnects: 0, rebuilds: 0, lastError: null }
      return { ...base, sdkState: sock ? ['connecting', 'open', 'closing', 'closed'][sock.readyState] || null : null, reconnectAttempts: consecFail, approxLifeSec, fatal }
    },

    async reply(replyCtx, content) {
      // ⚠ `chatId` 是合成消息的写法:定时任务 / 控制台插话 / 重启补做 / 画布确认都构造
      //   `replyCtx: { chatId }`(那套写在只有飞书的时候,飞书的 replyCtx 就叫 chatId)。
      //   不认它的话,这几条路在 Slack 群里会**静默不回**——而它们恰恰是没人盯着的那几条。
      const channel = replyCtx && (replyCtx.channel || replyCtx.chatId)
      // SLACK.md「收消息」:Slack 的"回复"就是 thread。挂进线程,群里多人交叉说话时看得出这句在回应谁;
      // replyInThread:false ⇒ 直接发在频道里(见 docs/SLACK.md「进度表达」)。
      const threadTs = replyInThread ? (replyCtx && (replyCtx.threadTs || replyCtx.ts)) || null : null
      // ⚠ 只有引擎自己说的话(命令回执 / 排队提示 / 报错)走这条 —— agent 的答案走卡片的
      //   finish,那里**不做**改写(答案里的 `/status` 可能真是一条路由)。
      return postMessage(channel, localizeCommands(content, { commands, alias: commandAlias }), { threadTs })
    },

    async send(chatId, content) {
      return postMessage(chatId, localizeCommands(content, { commands, alias: commandAlias }))
    },

    /**
     * 进度表达(docs/SLACK.md「进度表达」)。引擎只认这一个可选方法,拿到的对象要有
     * update / finish / recall —— 与飞书的流式卡片同契约,但底下完全是另一套:
     *
     *   建进度消息(挂线程) → setStatus(processing) 出**原生 Working… + Stop 按钮**
     *   → 节流 chat.update 刷进度 → 最终答案**独立 postMessage** → finally setStatus(active)
     *
     * ⚠ 三条硬要求,少一条就是一类事故:
     *  ① **最终答案必须独立发**,不能只靠 update 送达(SLACK.md「进度表达」 铁律 —— v0.11.48「844 轮里 34 轮
     *     答案没进过群」换来的)。⭐ 附带一个 Slack 特有的好处:**编辑不发通知,新消息才推人** ——
     *     "跑完 40 分钟推我一下"这个核心场景,靠 update 是推不动的。
     *  ② **`setStatus(active)` 必须无条件收尾**:发消息不会自动清掉 loading UX,不显式转就一直
     *     转圈**到 1 小时超时**,用户看到的是"它卡死了",而答案其实早发了(SLACK.md「静默失败」)。
     *  ③ processing **1 小时会超时**,长任务要心跳续期(重发即重置计时器)。
     */
    async createStreamingCard(replyCtx) {
      const channel = replyCtx && (replyCtx.channel || replyCtx.chatId)
      if (!channel) return null
      // ⚠ 频道内的原生会话**必须挂线程**(SLACK.md「进度表达」 组件二);合成消息(定时任务/插话)没有 ts,
      //   那就退化成频道里的一条独立进度消息,原生状态那半自然也就没有——不影响答案送达。
      const threadTs = (replyCtx && (replyCtx.threadTs || replyCtx.ts)) || null
      // 控制按钮只挂在**进度消息**上 —— 它是"这一轮还在跑"的那条,按钮的语义天然绑在它身上;
      // 答案那条是终态,挂个能点的「停止」在上面就是骗人(见 finish 的兜底分支)。
      const btns = controlActions(commands)
      let ts = null
      try { ts = await postMessage(channel, T_PROGRESS_INIT, { threadTs, retries: 1, actions: btns }) } catch { ts = null }
      if (!ts) return null // 建不出来就退回纯文本回复(引擎自己会兜)

      let statusOff = false // 拿不到原生状态(比如 app 没开 agent_view)⇒ 只降级,绝不影响这一轮
      const setStatus = async (status, first = false) => {
        if (statusOff || !threadTs) return
        try {
          const r = await call('agents.sessions.setStatus', {
            channel_id: channel,
            thread_ts: threadTs,
            status,
            // ⚠ 只在会话首次创建时生效,之后静默忽略;指定的人不在频道里会静默回退成 bot 自己
            ...(first && replyCtx.userId ? { initiator_user_id: replyCtx.userId } : {}),
          }, { retries: 0 })
          // SLACK.md「静默失败」:以副作用为准,不以 ok:true 为准
          if (r && r.agent_status && r.agent_status !== status) log(`⚠ slack 会话状态写入 ${status} 但读回是 ${r.agent_status}`)
        } catch (e) {
          statusOff = true // 一次不行就别每 5 分钟再撞一次
          const code = (e && e.code) || String(e)
          log(`slack 原生状态不可用(${code})—— 进度照常刷,只是没有 Working…/Stop。`
            + (code === 'not_authorized' ? ' 多半是 app 没开 agent_view,改 manifest 后要重装。' : ''))
        }
      }
      await setStatus('processing', true)
      // 心跳:processing 一小时超时,重发即重置。5 分钟一次,Tier 3 下成本可忽略。
      const beat = setInterval(() => { setStatus('processing') }, 5 * 60 * 1000)
      if (beat.unref) beat.unref()

      // ⏳ 打在**用户那条消息**上:线程折叠着的时候,频道里也看得出在跑。
      const react = (name) => { if (replyCtx.ts) addReactionTo(channel, replyCtx.ts, name).catch(() => {}) }
      react('hourglass_flowing_sand')

      const throttle = createProgressThrottle({
        intervalMs: Number(card.throttleMs) > 0 ? Number(card.throttleMs) : 20_000,
        log,
        send: async (text) => {
          // ⚠ 每帧都要重新带上按钮:`chat.update` 是**整条替换**,少传 blocks 就等于把按钮删了
          //   (同 SLACK.md「静默失败」 那条「只传 text 会静默清空 blocks」的形状)。
          const r = await call('chat.update', messagePayload(channel, text, { ts, actions: btns }), { retries: 0 })
          return r
        },
      })

      let closed = false
      const teardown = () => { closed = true; clearInterval(beat); throttle.close() }

      return {
        update(text) { if (!closed) throttle.update(text) },

        async finish(text) {
          if (closed) return
          closed = true
          clearInterval(beat)
          throttle.close()
          try { await throttle.settle() } catch { /* 在途那帧失败无所谓,下面就落地了 */ }
          let answerTs = null
          try { answerTs = await postMessage(channel, text, { threadTs, retries: 2 }) } catch { answerTs = null }
          let deliveredTs = answerTs
          if (answerTs) {
            // 答案已独立落地 ⇒ 进度消息功成身退,线程里只留一条终态(不刷屏)。
            // ⚠ 顺序不能反:先删后发的话,发失败就把两头都丢了。
            try { await deleteOwnMessage(channel, ts) } catch { /* 删不掉就留着,顶多多一条 */ }
          } else {
            // 独立那条没发出去(限流/频道级错误)⇒ 至少把答案写进进度消息,别让它烂在半路
            // ⚠ 这里**故意不带 actions** —— 轮次已经结束,`chat.update` 整条替换正好把按钮抹掉。
            //   留着的话就是一条"答案已出、旁边还有个能点的停止"的消息,点下去只会得到一句
            //   「当前没有在跑的任务」,把人教成"这按钮坏的"。
            log('🔴 slack 最终答案独立发送失败 —— 退回写入进度消息')
            try {
              const updated = await call('chat.update', messagePayload(channel, text, { ts }), { retries: 1 })
              if (updated && updated.ok === true) deliveredTs = ts
              else log('slack 收尾写入未确认')
            } catch (e) { log('slack 收尾写入也失败: ' + ((e && e.code) || e)) }
          }
          react('white_check_mark')
          if (replyCtx.ts) removeReactionFrom(channel, replyCtx.ts, 'hourglass_flowing_sand').catch(() => {})
          await setStatus('active') // ⚠ 无条件 —— 不转就转圈到一小时超时
          return deliveredTs
        },

        // ack 后转静默:撤掉进度消息,保住"静默轮群里不留痕迹"(engine.js dropAckCard)
        async recall() {
          if (closed) return false
          teardown()
          try { await throttle.settle() } catch {}
          let ok = false
          try { ok = await deleteOwnMessage(channel, ts) } catch { ok = false }
          if (replyCtx.ts) removeReactionFrom(channel, replyCtx.ts, 'hourglass_flowing_sand').catch(() => {})
          await setStatus('active')
          return ok
        },
      }
    },

    /**
     * 就地改写一条消息。SLACK.md「可靠性」:改不动就**立刻降级发新消息**并把指针换过去 ——
     * 冻住的进度条比丑一点的进度条糟得多。返回 { ts, degraded }。
     * ⚠ 进度更新用 retries:0(SLACK.md「可靠性」:失败就跳过本轮,别排队重试把进度拖冻)。
     */
    async updateMessage(channel, ts, content, { threadTs = null } = {}) {
      try {
        const r = await call('chat.update', messagePayload(channel, content, { ts }), { retries: 0 })
        return { ts: (r && r.ts) || ts, degraded: false }
      } catch (e) {
        if (e && e.kind === 'degrade') {
          log(`slack chat.update ${e.code} ⇒ 降级发新消息并切换进度指针`)
          const fresh = await postMessage(channel, content, { threadTs, retries: 1 })
          return { ts: fresh, degraded: true }
        }
        onApiError('chat.update', e, channel)
        return { ts, degraded: false, failed: true }
      }
    },

    /** 👀 回执(实现见闭包里的 addReactionTo —— 卡片收尾那条 ✅ 走的是同一处)。 */
    addReaction(channel, ts, name = 'eyes') { return addReactionTo(channel, ts, name) },
    removeReaction(channel, ts, name) { return removeReactionFrom(channel, ts, name) },

    /** 删除自己发的消息(同上,与进度消息的收尾共用一处实现)。 */
    deleteMessage(channel, ts) { return deleteOwnMessage(channel, ts) },

    /** ⭐ 对账通道(SLACK.md「静默失败」):唯一能独立验证"这条消息真的存在于该频道"的手段,成本可忽略。 */
    async permalink(channel, ts) {
      try { const r = await call('chat.getPermalink', { channel, message_ts: ts }, { retries: 1 }); return (r && r.permalink) || null } catch { return null }
    },

    /** 下载群里的图片/文件到本地绝对路径。 */
    async downloadResource(fileId, destPath) {
      return downloadFile(call, botToken, fileId, destPath, { fetchImpl })
    },

    /** 逃生口:让调用方直接打任意 Web API(第 2 步接进度表达时会用到 agents.sessions.*)。 */
    api: call,

    async stop() {
      stopped = true
      if (tickTimer) { try { clearInterval(tickTimer) } catch {} tickTimer = null }
      refreshTimer = clearTimer(refreshTimer)
      retryTimer = clearTimer(retryTimer)
      if (watchdog) { try { watchdog.stop() } catch {} }
      closeSocket(standby, 'stop')
      closeSocket(sock, 'stop')
      standby = null
      sock = null
    },
  }
}

module.exports = {
  createSlackPlatform,
  createProgressThrottle,
  slackPrecheck,
  fetchSlackChannels,
  sendSlackText,
  REQUIRED_SCOPES,
  RECOMMENDED_SCOPES,
  createSlackApi,
  createDedupe,
  downloadFile,
  parseText,
  restoreCommand,
  localizeCommands,
  attachmentMarks,
  shouldHandle,
  isStale,
  messagePayload,
  controlActions,
  actionsBlock,
  actionMessage,
  homeView,
  shouldPublishHome,
  CONTROL_BUTTONS,
  plainFallback,
  classifyError,
  slackHint,
  SlackError,
  FATAL,
  RETRYABLE,
  CHANNEL_LEVEL,
  UPDATE_DEGRADE,
  MD_LIMIT,
}
