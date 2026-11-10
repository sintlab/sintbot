'use strict'

// Messaging actions of the `feishu` subcommand, shared by the legacy entry and
// the release entry so a group's agent gets the same skills under both:
// send-msg · send-notice · send-file · send-image · history · reply · edit ·
// recall (alias delete) · download · react. Canvas actions stay in the legacy
// entry. None of them needs the service: each call uses the bot's own app
// credentials directly.
//
// Target chat: --chat, else $SBOT_CHAT_ID (injected for every group turn).
// Configuration: --config, else $SBOT_CONFIG (also injected), else the usual
// lookup. Paths are relative to the working directory and never leave it;
// outbound text is redacted like the engine's replies (PII per group).
const fs = require('node:fs')
const config = require('./config')
const feishu = require('./platform/feishu')
const { cliNotice, deliverNotice } = require('./platform/noticesend')
const { TONES, resolveTone } = require('./platform/noticecard')
const { redact } = require('./core/redact')
const { fmtStamp, normalizeTz } = require('./core/time')

const FEISHU_MESSAGE_ACTIONS = Object.freeze(['send-msg', 'send-notice', 'send-file', 'send-image',
  'history', 'answers', 'reply', 'edit', 'recall', 'delete', 'download', 'react'])

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`

// A refusal with its own wording: callers print it as is and exit 1.
class FeishuCliError extends Error {
  constructor(message) { super(message); this.name = 'FeishuCliError' }
}
const refuse = (message) => { throw new FeishuCliError(message) }

// Hand-roll option parsing (not util.parseArgs): send-msg bodies / filenames legitimately start
// with '-' (Markdown lists like "- item"), which parseArgs(strict) rejects as an unknown option —
// and the self-knowledge manifest teaches agents exactly that form. Pull out --chat/--config; the
// rest stays positional (message text / path), leading '-' and all. Canvas options are taken out
// for every action, as they always were.
function parseFeishuArgs(action, rawArgs) {
  const o = { warnings: [], positionals: [] }
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (a === '--chat') o.chat = rawArgs[++i]
    else if (a.startsWith('--chat=')) o.chat = a.slice(7)
    else if (a === '--config') o.config = rawArgs[++i]
    else if (a.startsWith('--config=')) o.config = a.slice(9)
    else if (a === '--data-dir') o.dataDir = rawArgs[++i]
    else if (a.startsWith('--data-dir=')) o.dataDir = a.slice(11)
    else if (action === 'send-notice' && a === '--sub') o.subtitle = rawArgs[++i]
    else if (action === 'send-notice' && a === '--tone') o.tone = rawArgs[++i]
    else if (action === 'send-notice' && a === '--warn') o.warnings.push(rawArgs[++i])
    else if (action === 'send-notice' && a === '--from') o.from = rawArgs[++i]
    else if (a === '--title') o.title = rawArgs[++i]
    else if (a === '--new') o.new = true
    else if (a === '--x') o.x = rawArgs[++i]
    else if (a === '--y') o.y = rawArgs[++i]
    else if (a === '--width') o.width = rawArgs[++i]
    else if (a === '--height') o.height = rawArgs[++i]
    else if (a === '--label') o.label = rawArgs[++i]
    else if (a === '--raw') o.raw = true
    else if (a === '--board') o.board = rawArgs[++i]
    else if (a === '--beside') o.beside = rawArgs[++i] // 参照节点 id:新图放它右侧(按标注改的排版)
    else if (a === '--deliver') o.deliver = true // 交付结果卡:上板 + 回填进原播报卡(单卡)/ 无原卡则新发
    else if (a === '--note') o.note = rawArgs[++i] // 结果卡里的一句改动说明
    else if (a === '--type') o.type = rawArgs[++i] // 图表类型(flow/mindmap/sequence/… 或中文别名)
    else if (a === '--syntax') o.syntax = rawArgs[++i] // 图表语法(mermaid | plantuml;覆盖扩展名识别)
    else if (a === '--as-image') o.asImage = true // 图表渲染成整张图片,否则多节点可编辑
    else if (a === '--no-cascade') o.noCascade = true // board-del-node:只删点名的,不连带容器内容/导图子树
    else o.positionals.push(a)
  }
  return o
}

// The checks every action shares, in the legacy order: Slack groups, then
// configuration, then the target chat.
function feishuContext(opts, { env = process.env, loadConfig = config.loadConfig,
  findConfigPath = config.findConfigPath, applyProxyEnv = config.applyProxyEnv,
  feishuClient = feishu.feishuClient, client } = {}) {
  // Slack 群:引擎注入 SBOT_PLATFORM=slack。飞书这族动作在那儿一概走不通(文件上下行还没接到
  // Slack,docs/SLACK.md 第 3 步)。不拦的话要么打到飞书 API 报 lark 错、要么 feishu 没配时报「未配置」——
  // 两种都不说人话,agent 会转头重试。显式 --chat 指向飞书群的手工用法不拦。
  if (!opts.chat && env.SBOT_PLATFORM === 'slack') refuse('本群在 Slack 上 —— sbot feishu 的动作(发文件/发图/读历史/回复/编辑/撤回/下载/表情)在 Slack 群暂不可用,Slack 侧文件上下行还没接。要给群成员看的文件或图片:把项目内相对路径与打开方式写进回复正文;不要重试本命令。')
  const configPath = opts.config || env.SBOT_CONFIG
  if (!findConfigPath(configPath)) refuse('feishu 未配置:找不到配置文件 — 传 --config <path> 或设置 env SBOT_CONFIG')
  const cfg = loadConfig(configPath)
  if (!cfg.feishu || !cfg.feishu.appId || !cfg.feishu.appSecret) refuse('feishu 未配置(sbot.config.json 缺 feishu.appId/appSecret)')
  const chatId = opts.chat || env.SBOT_CHAT_ID
  if (!chatId) refuse('缺少目标群 — 传 --chat <oc_...> 或设置 env SBOT_CHAT_ID')
  applyProxyEnv(cfg)
  // 群面出站脱敏(与 engine 同口径):PII 按群开关(redactPii:false ⇒ 手机号/邮箱明文),密钥类恒遮盖。
  const red = (s) => redact(s, { pii: !(cfg.groups && cfg.groups[chatId] && cfg.groups[chatId].redactPii === false) })
  return { cfg, chatId, red, client: client || feishuClient(cfg.feishu.appId, cfg.feishu.appSecret) }
}

// args = [action, ...rest]. Confirmations go to stderr; what a program reads
// (history lines, message ids) goes to stdout.
async function runFeishuAction(args, deps = {}) {
  const action = args[0]
  if (!FEISHU_MESSAGE_ACTIONS.includes(action)) refuse(`unknown feishu action '${action || ''}' (${FEISHU_MESSAGE_ACTIONS.filter((a) => a !== 'delete').join(' | ')})`)
  const opts = parseFeishuArgs(action, args.slice(1))
  const { cfg, chatId, red, client } = feishuContext(opts, deps)
  const cwd = deps.cwd || process.cwd()
  const now = deps.now || Date.now
  const out = deps.stdout || ((s) => process.stdout.write(s))
  const err = deps.stderr || ((s) => process.stderr.write(s))
  const p = opts.positionals
  if (action === 'answers') {
    if (!cfg.groups?.[chatId]) refuse('目标群没有绑定，不能读取本机答复记录')
    const { readRecordedAnswers } = require('./recordedanswers')
    const result = readRecordedAnswers({ dataDir: opts.dataDir || (deps.env || process.env).SBOT_DATA_DIR,
      chatId, id: p[0] || '' })
    out(JSON.stringify(result, null, 2) + '\n')
    if (!result.answers.length) err('未找到本群匹配记录；可能已过保留范围或尚未落盘，不能推断原卡正文。\n')
    return result
  }
  // Usage errors before any network call, worded as the legacy entry did.
  let notice
  if (action === 'send-msg' && !p.join(' ').trim()) refuse('缺少消息内容 — sbot feishu send-msg "<文本>"')
  if (action === 'send-notice') {
    // 群通知卡:标题 + 正文(其余位置参数各占一行)+ 可选副标题 / 类别 / 注意事项 / 来源。
    // 与 send-msg 的分工:这张卡是「对大家宣布一件事」,阶段性结果与定时提醒仍走 send-msg。
    if (!String(p[0] || '').trim()) refuse('缺少标题 — sbot feishu send-notice "<标题>" ["<正文…>"] [--sub <副标题>] [--tone 公告|升级|提醒|故障|变更|状态] [--warn <注意事项>]… [--from <来源>]')
    try {
      notice = cliNotice(p, { subtitle: opts.subtitle, tone: opts.tone, warnings: opts.warnings,
        from: opts.from, stamp: fmtStamp(now(), normalizeTz(cfg.timezone)) })
    } catch (e) { refuse(e.message) }
  }
  if ((action === 'reply' || action === 'edit') && (!p[0] || !p.slice(1).join(' ').trim())) {
    refuse(action === 'reply' ? '用法: sbot feishu reply <message_id> "<文本>"' : '用法: sbot feishu edit <message_id> "<文本>"(仅能编辑 bot 自己发的消息)')
  }
  if ((action === 'recall' || action === 'delete') && !p[0]) refuse('用法: sbot feishu recall <message_id>(仅能撤回 bot 自己发的消息)')
  if (action === 'download' && (!p[0] || !p[1])) refuse('用法: sbot feishu download <message_id> <file_key> <file|image> [目标相对路径]')
  if (action === 'react' && (!p[0] || !p[1])) refuse('用法: sbot feishu react <message_id> <emoji>(如 THUMBSUP / 👍)')
  try {
    if (action === 'send-file' || action === 'send-image') {
      const abs = feishu.resolveSendPath(cwd, p[0])
      if (action === 'send-file') await feishu.sendChatFile(client, chatId, abs)
      else await feishu.sendChatImage(client, chatId, abs)
      err(green(`  ✓ 已发送${action === 'send-file' ? '文件' : '图片'}到群 `) + dim(chatId) + '  ' + p[0] + '\n')
      return { action, chatId, path: abs }
    }
    if (action === 'send-msg') {
      await feishu.sendChatText(client, chatId, red(p.join(' '))) // 出站脱敏,与 engine 群回复同口径(PII 按群)
      err(green('  ✓ 已发送消息到群 ') + dim(chatId) + '\n')
      return { action, chatId }
    }
    if (action === 'send-notice') {
      // 有卡能力就发卡(逐字段脱敏);建卡被拒或没送达时退回同一份通知的文本。
      const sent = await deliverNotice({ features: { noticeCard: true },
        sendCard: (id, card) => feishu.sendChatCard(client, id, card),
        send: (id, body) => feishu.sendChatText(client, id, body) }, chatId, notice, { redact: red, log: (m) => err(dim('  (' + m + ')') + '\n') })
      if (sent.mode === 'card') {
        err(green('  ✓ 已发送通知卡到群 ') + dim(chatId) + `  ${TONES[resolveTone(notice.tone)].label}「${notice.title}」\n`)
        if (sent.result && sent.result.msgId) out(sent.result.msgId + '\n') // 给程序读:message_id(要撤回 / 回复它时用)
      } else {
        err(green('  ✓ 已发送通知到群 ') + dim(chatId) + '(文本)\n')
      }
      return { action, chatId, mode: sent.mode, msgId: (sent.result && sent.result.msgId) || null }
    }
    if (action === 'history') {
      const n = p[0] ? parseInt(p[0], 10) : 20
      const msgs = await feishu.fetchChatHistory(client, chatId, n)
      const tz = normalizeTz(cfg.timezone)
      // @ 标记(裁决在 feishu.js 的 historyAtMark,这里只消费):「@了别人未@bot」的消息按设计不触发轮次,
      // 历史里不标就与真问 bot 的长得一模一样。bot 自己的 open_id 从配置来。
      const botOid = String((cfg.feishu && cfg.feishu.botOpenId) || '')
      const lines = msgs.map((m) => {
        const who = m.senderType === 'app' ? 'bot' : (m.senderId || '?')
        const body = m.text != null ? m.text : `(${m.msgType})`
        return `[${m.createTimeMs ? fmtStamp(m.createTimeMs, tz) : '?'} ${who}${feishu.historyAtMark(m.mentions, botOid)}] ${body}  {${m.msgId}}`
      })
      // 群消息内容是入站上下文(给 agent 读),不脱敏;message_id 用于后续 reply/edit/recall
      out(`共 ${msgs.length} 条群消息(新→旧):\n` + (lines.join('\n') || '(空)') + '\n')
      return { action, chatId, count: msgs.length }
    }
    if (action === 'reply' || action === 'edit') {
      const msgId = p[0]
      await (action === 'reply' ? feishu.replyMessage : feishu.editMessage)(client, msgId, red(p.slice(1).join(' ')))
      err(green(action === 'reply' ? '  ✓ 已回复消息 ' : '  ✓ 已编辑消息 ') + dim(msgId) + '\n')
      return { action, chatId, msgId }
    }
    if (action === 'recall' || action === 'delete') {
      await feishu.recallMessage(client, p[0])
      err(green('  ✓ 已撤回消息 ') + dim(p[0]) + '\n')
      return { action, chatId, msgId: p[0] }
    }
    if (action === 'download') {
      const [msgId, fileKey, type] = p
      const dest = p[3] || fileKey
      const abs = feishu.resolveSendPath(cwd, dest, false) // 写模式:目标文件尚不存在
      await feishu.downloadResource(client, msgId, fileKey, type === 'image' ? 'image' : 'file', abs)
      err(green('  ✓ 已下载到 ') + dim(dest) + '\n')
      return { action, chatId, path: abs }
    }
    // react
    await feishu.reactMessage(client, p[0], p[1])
    err(green('  ✓ 已回应 ') + dim(p[0]) + ' ' + p[1] + '\n')
    return { action, chatId, msgId: p[0] }
  } catch (e) {
    throw new FeishuCliError('feishu 操作失败:' + feishu.larkErrMsg(e))
  }
}

// `--help` text of the release entry. The legacy entry keeps its own, which
// also lists the canvas actions.
function feishuUsage(cmd = 'sintbot') {
  return `用法: ${cmd} feishu <动作> [参数…] [--chat <oc_…>] [--config <path>]\n`
    + '      目标群:--chat,不传取 $SBOT_CHAT_ID(群里跑时已注入);配置:--config,不传取 $SBOT_CONFIG;路径一律项目内相对路径\n'
    + '\n  消息\n'
    + '    send-msg "<文本>"                        发文本(正文以 - 开头也照收)\n'
    + '    send-notice "<标题>" "<正文>"              发群通知卡(可加 --sub / --tone / --warn / --from)\n'
    + '    send-file <路径> · send-image <路径>       发文件 / 图片\n'
    + '    history [n]                              拉最近 n 条(默认 20,最多 50):每条带 message_id,并标 →@某某·未@bot / →@bot\n'
    + '    answers [消息或轮次ID]                    只读本群本机答复记录；默认最近 10 轮，不代表完整飞书历史\n'
    + '    reply <message_id> "<文本>"              回复某条\n'
    + '    edit <message_id> "<文本>"               改自己发过的消息\n'
    + '    recall <message_id>                      撤回自己发过的消息(别名 delete)\n'
    + '    download <message_id> <file_key> <file|image> [目标路径]   下载群里的附件 / 图片(目标默认取 file_key)\n'
    + '    react <message_id> <表情>                表情回应(THUMBSUP 之类的枚举名,或直接给 👍)\n'
    + '\n  确认走 stderr;给程序读的(history / message_id)走 stdout;失败退出码 1\n'
}

module.exports = { FEISHU_MESSAGE_ACTIONS, FeishuCliError, parseFeishuArgs, feishuContext, runFeishuAction, feishuUsage }
