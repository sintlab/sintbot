#!/usr/bin/env node
// sbot — drive a headless Claude Code CLI with a swappable model brain.
//
// 命令面(完整清单与各条用法见 printHelp / SUBHELP,那两处是从派发表钉住的权威版本):
//   安装与运维   setup · doctor · providers · ui · start · issue
//   本机试跑     chat · agent run
//   群里基础技能 feishu · cron · imagen · preview · design · browser(agent 在群项目里调,目标群取 $SBOT_CHAT_ID)

const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const readline = require('node:readline')
const { parseArgs } = require('node:util')
const { createReadlineSecretMask } = require('../src/cli-secret')
const { tr } = require('../src/clilang')
const { PROXY_ENV_KEYS } = require('../src/core/proxy')
const { loadConfig, findConfigPath, defaultConfigPath, applyProxyEnv, deriveNoProxy, resolveSecret, platformsConfigured, chatPlatform } = require('../src/config')
const { resolveProjectsRoots, withinRoots, describeRoots, parseRootsInput, expandHome, workdirInput, defaultWorkdir } = require('../src/projectsroot')
// Runner dispatch (keeps core/engine agnostic — it only sees `{ runTurn }`): a provider
// with `runner: "codex"` drives Codex CLI (GPT, Route B), else Claude Code. Shared with
// the UI server so 测试/试跑 route the same way. See DESIGN §1 / docs/CODEX-RUNNER.md.
const runner = require('../src/agent/runner')
const { probeVersion } = runner
const usage = require('../src/usage') // provider balance/quota (deepseek/glm/minimax) for /hud
const codexstatus = require('../src/agent/codexstatus') // codex subscription 5h/weekly usage for /hud
const claudestatus = require('../src/agent/claudestatus') // setup 第 0 步:claude 装了没登录时提示
const installdeps = require('../src/installdeps') // setup 第 0 步:替新用户装 claude / codex
const setupmodels = require('../src/setupmodels') // setup 模型步:推荐顺序、各家拿 key 的地方、国际站端点、试跑失败的人话
const crypto = require('node:crypto')
const { StateStore, atomicWriteJSON, withFileLock } = require('../src/core/store')
const { createLedger } = require('../src/core/ledger')
const { secureDataDir } = require('../src/core/datadir') // 状态目录 700、里面的账本 / 审计 / 日志 600(启动时收紧旧文件)
const { createIssues, summarize, fingerprint } = require('../src/core/issues')
const { pendingFile, writePending, takePending, resumable, resumePrompt, resumeNotice } = require('../src/core/pending')
const quotaalert = require('../src/core/quotaalert') // 额度告警判定+文案(v0.11.8)
const opsalert = require('../src/core/opsalert') // 运维告警:模型账号异常 / 额度用完 / 自动切换 → alerts.chatId(文案 + 去重,纯函数)
const { Engine, SLASH_COMMANDS } = require('../src/core/engine')
const { normalizeCron, normalizeAt, describeTask, collectCrons } = require('../src/core/cron')
const { createCronFire } = require('../src/core/cronfire')
const { createScheduler } = require('../src/core/scheduler')
const verify = require('../src/core/verify') // 凭据最近一次验证的记录(试跑 / 预检 / 真实轮次写,doctor 读)
const { createCliPlatform } = require('../src/platform/cli')
const { createWecomPlatform } = require('../src/platform/wecom') // 企业微信智能机器人长连接(配了 wecom 块就接它;docs/WECOM.md)
const { createMultiPlatform } = require('../src/platform/multi') // 多平台路由器:飞书 + 企微同时接,按群分发(双平台并存)
const { createWecomCli } = require('../src/platform/wecomcli') // 企微官方命令行工具封装:基础技能 / 生图通知 / 接管链接三处共用(不占长连接)
const { createFeishuPlatform, feishuClient, fetchChats, feishuPrecheck, feishuHint, fetchOrgUsers, resolveContactToOpenId, sendChatText, sendChatImage, sendChatFile, sendChatCard, historyAtMark, updateCardEntity, uploadImage, resolveSendPath, larkErrMsg, fetchChatHistory, replyMessage, editMessage, recallMessage, downloadResource, reactMessage, createBoardDoc, shareDocWithChat, addChatTabDoc, uploadBoardImage, createBoardNodes, createBoardDiagram, listBoardNodes, deleteBoardNodes, boardTextNode, boardUsageNoteNodes, subscribeBoard, listBoardComments, resolveBoardComment, downloadBoardMedia, boardPreviewImageKey } = require('../src/platform/feishu')
const { createSlackPlatform } = require('../src/platform/slack') // Slack 适配器(docs/SLACK.md):路由器里与飞书 / 企微平级,按群分发
const { imageSize, digestNodes, digestComments, nodeText, nextImagePosition, besideImagePosition, besideRegionPosition, nodesBBox, sanitizeDiagramNodes, shiftDiagramNodes, groupDiagramBatch, parseInvalidNodeFields, buildDeliverCard, diagramSpec, redactNodeTexts, trimPngWhitespace, decodePngRGBA, encodePngRGBA, padToMaxAspect } = require('../src/platform/board') // 画布纯函数(尺寸魔数/节点·评论摘要/文字指纹/摆放几何/图表移植:并集bbox·净化·平移·打组·字段解析/结果卡/图表映射/节点脱敏/PNG白边裁剪·PNG编解码/卡内预览高宽比封顶)
const { createBoardWatch } = require('../src/platform/boardwatch') // 画布自动感知(B3):轮询主触发+事件加速 → diff → 群播报
const { boardNoticeDir, pushNotice, shiftNotice, takeNoticeByGo } = require('../src/platform/boardnotice') // 单卡回填文件桥(FIFO 队列 + 按 goId 精确摘卡;按标注改结果回填进原播报卡)
const { appendBoardOp, readBoardOps } = require('../src/platform/boardops') // bot 侧画布写留痕(轮询自编辑抑制数据面)
const boardOpsDir = () => path.join(os.homedir(), '.sbot', 'board-ops')
const imagen = require('../src/agent/imagen') // 生图基础技能(异步 detached worker,borrow codex 订阅)
const design = require('../src/design') // 设计风格档(项目根 DESIGN.md):预设清单/落盘裁决/参考图主色
const preview = require('../src/preview') // 群预览服务(detached 静态服务 + daemon 侧闲置回收):端口序/围栏/记录/收割
const { redact } = require('../src/core/redact') // base-skill outbound text is redacted like engine replies
const { fmtStamp, fmtLogStamp, normalizeTz } = require('../src/core/time')
const { checkHealth, whichSync } = require('../src/health')
const { createUiServer } = require('../src/ui/server')
const feishulogin = require('../src/ui/feishulogin') // 公网地址归一(ui.publicUrl → https://host):/help 与清单给人的是它
const { buildTakeoverCard } = require('../src/platform/takeovercard') // 「接管浏览器」的群内卡片(四态:等人来 / 接管中 / 已结束 / 已过期)
const cdp = require('../src/cdp') // 接管卡片上的页面截图:CLI 直接连常驻浏览器截一张
const { hashPassword } = require('../src/ui/auth')
const updateFeature = require('../src/updater')

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const gray = (s) => `\x1b[90m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`

const isLoopbackHost = (h) => /^(127\.0\.0\.1|localhost|::1)$/i.test(String(h))
// 本机非环回 IPv4(局域网访问地址)
function lanIPv4() {
  const out = []
  const ifs = os.networkInterfaces()
  for (const name of Object.keys(ifs)) for (const ni of ifs[name] || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
  return out
}
// 遮蔽回显读取密码(raw 模式,逐字符;支持退格 / Ctrl-C)。ASCII 密码即可,不处理多字节。
function askPassword(q) {
  return new Promise((resolve) => {
    process.stdout.write(q)
    const stdin = process.stdin
    const wasRaw = !!stdin.isRaw
    if (stdin.setRawMode) stdin.setRawMode(true)
    stdin.resume(); stdin.setEncoding('utf8')
    let pw = ''
    const cleanup = () => { if (stdin.setRawMode) stdin.setRawMode(wasRaw); stdin.pause(); stdin.removeListener('data', onData) }
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") { cleanup(); process.stdout.write("\n"); return resolve(pw) }
        if (ch === "\u0003") { cleanup(); process.stdout.write("\n"); process.exit(1) } // Ctrl-C
        if (ch === "\u007f" || ch === "\b") { if (pw.length) { pw = pw.slice(0, -1); process.stdout.write("\b \b") } continue }
        pw += ch; process.stdout.write("*")
      }
    }
    stdin.on('data', onData)
  })
}

function die(msg) {
  process.stderr.write(red(`sbot: ${msg}`) + '\n')
  process.exit(1)
}

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ')
  return s.length > n ? s.slice(0, n) + '…' : s
}

// 每个子命令的用法。⚠ **`--help` 统一在派发处拦一次,不要逐个子命令去补** —— 逐处补
// 正是它坏成现在这样的原因:2026-08-25 照派发表逐个数过,13 个子命令里 11 个不认
// `--help`,而且坏成四种互不相同的形状:
//   ① feishu / cron  → 报「缺少目标群」(与 help 毫无关系,最误导)
//   ② preview / issue / agent → 报 unknown action
//   ③ chat / doctor / ui / start / setup → 漏出 node parseArgs 的 Unknown option 内部报错
//   ④ providers → 静默吞掉 --help,直接把命令跑了
// 真机事实与 v0.11.50 治 design 一族时的是同一条:**agent 拿到一条没用过的命令,
// 第一反应就是先敲 `--help`** —— 第一次交互就撞一句假错误。
// ⚠ 每条的参数与动作名**照代码写**,不照记忆写:2026-09-08 逐条对账逮到 cron 的 help 教 `add --expr`
//   而 add 只认位置参数(照着敲必失败)、feishu 18 个动作 14 个参数一个没写、preview 的 stop <id>
//   与 --config 在群里被拒这些都没说。tests/unit/cli-help.test.js 从各命令的分支里读出动作名,
//   缺一个就红;参数名没有那种守卫,改了解析就要来这里同步。
const SUBHELP = {
  providers: '用法: sintbot providers\n'
    + '      列出配置里的模型 provider:型号 / 端点 / key 是否就位;* = 默认那个\n'
    + '      (改 provider 走控制台「模型」页或直接编辑 sbot.config.json;群里用 /model 切)',
  setup: '用法: sintbot setup [--full] [--config <path>]\n'
    + '      首次向导:环境检查 → 模型(先看 Claude / Codex 登录,都没有推荐 DeepSeek,填 key 当场试跑)。聊天平台、代理、项目根目录、绑群装完在控制台里配\n'
    + '      --full:另外在终端里问代理、机器人名与聊天平台凭据(飞书 / Slack / 企业微信)、项目根目录、绑一个群(给没有浏览器的服务器用)\n'
    + '      回车即默认;已有配置只补缺项、不动已填的;新建默认写到 ~/.sbot/config.json(当前目录已有 sbot.config.json 就更新它;--config 另指),权限 600',
  ui: '用法: sintbot ui [--port <n>] [--host <ip>] [--no-open] [--config <path>]\n'
    + '      sintbot ui --set-password\n'
    + '      浏览器里的控制台(配置模式,不接 daemon):配置 / 健康 / provider 试跑 / 群绑定;默认 http://127.0.0.1:4600\n'
    + '      --host 0.0.0.0 对局域网开放 —— 必须先 --set-password 设过密码,否则拒绝启动;--host / --port 只管本次,不写进配置\n'
    + '      与 daemon 共宿的实时控制台是 sintbot start --ui\n'
    + '      公网访问不走命令行参数:配置 ui.publicUrl + feishu.admins 名单,经 SSH 隧道与反代终结 HTTPS,公网上只认「用飞书登录」—— 见 https://github.com/sintlab/sintbot/blob/main/docs/zh-CN/PUBLIC-ACCESS.md',
  doctor: '用法: sintbot doctor [--config <path>] [--kill-leftovers]\n'
    + '      体检:Node / 配置 / claude CLI 与旗子 / 各 provider 的 key 与端点 / 浏览器与 MCP / 飞书凭证与权限预检 / 项目根目录 / 各群目录 / 遗留进程\n'
    + '      --kill-leftovers  顺手结束「遗留进程」(agent 轮次结束后仍在跑的后台 shell,体检尾巴会列出来;不加只列不杀)\n'
    + '      末尾列出运行中的预览服务;有 fail 退出码 1(warn 不算,但要看内容)\n'
    + '      配置按 --config > SBOT_CONFIG > 当前目录的 sbot.config.json > ~/.sbot/config.json 的顺序找;第二行显示实际用的是哪个',
  start: '用法: sintbot start [--ui] [--ui-port <n>] [--ui-host <ip>] [--no-open] [--config <path>]\n'
    + '      飞书守护进程:群消息 → 绑定项目 → agent → 回群;配置文件改了热重载,不用重启\n'
    + '      --ui 同时提供实时控制台(默认 127.0.0.1:4600;对外绑定须先 sintbot ui --set-password;端口被占只提示,daemon 照常跑)\n'
    + '      前置:feishu.appId / appSecret 已配、claude CLI 可用;SIGTERM / Ctrl-C 优雅退出(会中止进行中的轮次)\n'
    + '      公网入口(SSH 隧道 + 反代 + ui.publicUrl + 飞书登录名单)不在参数里,见 https://github.com/sintlab/sintbot/blob/main/docs/zh-CN/PUBLIC-ACCESS.md;launchd 常驻要带 --ui-host 0.0.0.0',
  chat: '用法: sintbot chat [--workdir|-C <dir>] [--provider <名>] [--model <id>] [--allow <list>] [--deny <list>] [--config <path>]\n'
    + '      从终端逐行驱动引擎(不接飞书):每行 = 一条群消息;/help 看群内命令,/exit 退出\n'
    + '      --allow / --deny 逗号分隔的工具名,两个都不给 ⇒ 只读;会话状态落在 <workdir>/.sbot/',
  agent: '用法: sintbot agent run [--provider <名>] [--model <id>] [--workdir|-C <dir>] [--resume <sid>] [--config <path>] "<prompt>"\n'
    + '      跑单轮无头 agent(唯一动作是 run):正文走 stdout,进度与 session id 走 stderr;只读,不给工具权限\n'
    + '      轮次出错退出码 1;续接上一轮用 --resume <session id>',
  wecom: '用法: sbot wecom <动作> [参数…] [--chat <群id>] [--config <path>]\n'
    + '      企业微信群的基础技能(platform:"wecom" 时的「当前群」操作);目标群:--chat,不传取 $SBOT_CHAT_ID;路径一律项目内相对路径\n'
    + '      依赖官方命令行工具已装并按机器人凭据授权(doctor 的 wecom.cli 行)\n'
    + '\n  消息\n'
    + '    send-msg "<文本>"                        发消息(markdown:粗体 / 列表 / 链接 / 行内代码会渲染;表格、代码块不渲染)\n'
    + '    send-file <路径> · send-image <路径>       发文件 / 图片(服务端限制:图 ≤10MB,文件 ≤20MB)\n'
    + '    history [n]                              拉本群最近 7 天的人类发言(最多 n 条,默认 50;不含机器人自己发的)\n'
    + '      没有的能力:回复 / 编辑 / 撤回 / 表情 / 下载(群里的图片与文件到达时已自动落盘,标记里给的是本机路径)',
  feishu: '用法: sbot feishu <动作> [参数…] [--chat <oc_…>] [--config <path>]\n'
    + '      目标群:--chat,不传取 $SBOT_CHAT_ID(群里跑时已注入);路径一律项目内相对路径\n'
    + '\n  消息\n'
    + '    send-msg "<文本>"                        发文本(正文以 - 开头也照收)\n'
    + '    send-file <路径> · send-image <路径>       发文件 / 图片\n'
    + '    history [n]                              拉最近 n 条(默认 20,最多 50):每条带 message_id,并标 →@某某·未@bot / →@bot\n'
    + '    reply <message_id> "<文本>"              回复某条\n'
    + '    edit <message_id> "<文本>"               改自己发过的消息\n'
    + '    recall <message_id>                      撤回自己发过的消息(别名 delete)\n'
    + '    download <message_id> <file_key> <file|image> [目标路径]   下载群里的附件 / 图片(目标默认取 file_key)\n'
    + '    react <message_id> <表情>                表情回应(THUMBSUP 之类的枚举名,或直接给 👍)\n'
    + '\n  画布(群须已绑定项目;--board <画板id> 可指到别的画板)\n'
    + '    board-create [--title <名>] [--new]      建本群设计画布并分享到群;已有则直接给链接不重建,--new 另建一块\n'
    + '    board-add-image <图> [--x <n> --y <n> --width <n> --height <n>] [--beside <节点id>] [--label <名>] [--deliver] [--note <说明>]\n'
    + '                                             放图上板:不给坐标放最右;--beside 放某节点右侧;--deliver 把结果回填进群里那张播报卡\n'
    + '    board-add-diagram <源码文件> [--type flow|mindmap|sequence|class|er|component|usecase|activity] [--syntax mermaid|plantuml]\n'
    + '                      [--as-image] [--beside <节点id>] [--x --y] [--label <名>] [--deliver] [--note <说明>]\n'
    + '                                             Mermaid / PlantUML 渲染后移植成可编辑节点(语法按扩展名推断);--as-image 只贴图\n'
    + '    board-add-nodes <节点JSON文件>            写结构化节点(文件内容 {nodes:[…]} 或数组,最多 3000 个)\n'
    + '    board-nodes [--raw]                      读节点:图片 / 箭头 / 文字 / 图形 / 思维导图的坐标与内容 —— 读标注用它,别靠截图\n'
    + '    board-del-node <节点id…> [--no-cascade]  删节点(默认连子节点一起);被删的存档到 design/board-history.jsonl,剩余节点 id 会变\n'
    + '    board-comments [--raw]                   读画板文档的评论(附图给素材 token)\n'
    + '    board-resolve-comment <评论id>           标记评论已解决\n'
    + '    board-get-media <素材token> <目标路径>    下载评论里的附图\n'
    + '\n  确认走 stderr;给程序读的(history / board-nodes / 链接 / 节点 id)走 stdout;失败退出码 1',
  cron: '用法: sbot cron <动作> [参数…] [--chat <oc_…>] [--config <path>]\n'
    + '      本群定时任务(群须已绑定项目;时间一律按产品时区,不看主机时区)\n'
    + '    add "<时间>" --do "<要做的事>" | --say "<要说的话>" | --run "<命令>" [--note <备注>]   周期任务(时间也可写成 --expr "<时间>")\n'
    + '    add --at "YYYY-MM-DD HH:mm" --do | --say | --run "…" [--note <备注>]  一次性,触发后自删\n'
    + '    list                                                              本群任务与 id\n'
    + '    update <id> [--expr "<时间>" | --at "<时刻>"] [--do | --say | --run "…"] [--note "…"] [--timeout <分钟>] [--escalate | --no-escalate]   改哪项给哪项(--note "" 清备注;别名 edit)\n'
    + '    remove <id> · on <id> · off <id>                                  删 / 启用 / 停用(remove 别名 rm、delete)\n'
    + '      时间写法:5 段 cron · @daily / @hourly / @weekly / @monthly … · 每天 9:00 · 工作日 8:30 · 每周三 9:00 · 每小时\n'
    + '      --do 到点起一轮 agent(占群锁,高频要当成本审);--say 到点只发一句,不起 agent\n'
    + '      --run 到点在项目根直接跑这条命令,不起 agent、不占群锁:退出码 0 只留日志,失败群里一句提示附输出末尾;\n'
    + '            加 --escalate 改为失败时把输出交给 agent 排查;--timeout <分钟> 超时上限(默认 15)。适合巡检 / 日报 / 刷看板这类脚本;会改仓库的活仍用 --do',
  preview: '用法: sbot preview start <相对路径> [--port <n>] [--label <名>] [--idle-min <分钟>] [--project-root] [--chat <oc_…>]\n'
    + '      sbot preview status [--json]\n'
    + '      sbot preview stop [<id>] [--all]\n'
    + '      把 HTML 原型挂到局域网给群成员看:detached 起服务,轮次结束后仍活着;闲置(默认 30 分钟,0 = 不按闲置)/\n'
    + '      超 8 小时 / 群暂停 / 解绑 自动回收并通知群;控制台概览页可见可停\n'
    + '      路径:目录须含 index.html;单文件只服务它自己(旁边的 css / 图片取不到,要么起目录要么内联);\n'
    + '      默认只服务项目子目录,项目根须显式 --project-root(会告知群);--port 须在端口段内(默认 4610–4629,可配)\n'
    + '      每群同时只一个:同一路径重开直接复用,换路径则替换;stop 不带 id 停本群的,绝不默认全停\n'
    + '      群里(有 --chat / $SBOT_CHAT_ID)不收 --all 与 --config;终端里可 stop --all,配置用 SBOT_CONFIG=… 指定',
  browser: '用法: sbot browser link [--tab <网址或标题片段>] [--send] [--minutes <n>] [--json]\n'
    + '      签一条只能打开一次的「接管浏览器」链接(默认 10 分钟内有效,--minutes 可给 1~60,越界收编回边界),发给群里要登录 / 过验证码 / 扫码的人:\n'
    + '      --tab 把链接绑在某个已打开的标签页上(对方只能操作那一页,不能看别的、不能新开网址)—— 卡在哪个页面就给哪个,推荐总是带\n'
    + '      --send 直接把一张卡发进群(带当前页面截图 + 「接管浏览器」按钮 + 有效期;有人点开始接管卡片自动翻成「正在接管中」)—— 群里跑时就用它,别自己贴链接\n'
    + '      对方在手机或电脑上打开就能直接操作这台机器的浏览器,登录态留在浏览器里,之后 agent 自己接着干\n'
    + '      要守护进程带控制台在跑(sintbot start --ui);群里跑时控制台地址已注入,终端里可设 SBOT_UI_URL=http://127.0.0.1:4600',
  service: '用法: sintbot service install [--ui-host <ip>] [--config <path>] [--dry-run]\n'
    + '      sintbot service status | restart | logs [-n <行数>] | uninstall\n'
    + '      把 sintbot start --ui 装成常驻服务:崩溃自动拉起、登录后自启(macOS = launchd,Linux = systemd --user)\n'
    + '      install 写单元文件并立即启动;服务里固定用当前的 node、sbot 与配置文件的绝对路径,PATH 取当前 shell 的\n'
    + '      --dry-run 只打印要写的单元文件,不动系统;--ui-host 0.0.0.0 对局域网开控制台(须先 sintbot ui --set-password,否则拒装)\n'
    + '      服务拿不到当前 shell 的环境变量:配置里 env:VAR 引用的 key、以及配置没写代理时 shell 里的代理变量,值直接写进单元文件(文件权限 600);换了要重跑 install\n'
    + '      还没接任何聊天平台也照装:服务先只开控制台,在「设置」里接好平台后自己重启连上\n'
    + '      Windows 不自动装:打印 NSSM / pm2 的现成命令。日志在 ~/.sbot/logs/;同一份状态只许一个 daemon,第二个会直接报错退出',
  version: '用法: sintbot version        (也认 sbot --version / -v)\n'
    + '      打印版本号',
  issue: '用法: sintbot issue list [--all] [--json]        (不给动作时默认就是 list)\n'
    + '      sintbot issue show <id>\n'
    + '      sintbot issue close <id> [--note <说明>] [--no-notify]\n'
    + '      sintbot issue reopen <id> [--note <说明>]\n'
    + '      本机的群内反馈本:群成员在群里用 /issue 提,每台机器一本、各自发号;与代码托管平台的 issue 无关\n'
    + '      list 默认只看待处理(--all 含已处理;--json 走 stdout 供跨机汇总)\n'
    + '      close 默认回原群告知(说明一并带上;群已暂停或飞书未配则不发),--no-notify 不发;reopen 放回待处理,不发群消息',
}

// 帮助走 **stdout + 退出码 0**。⚠ 不要走 die():那是红色 stderr + 退出码 1,
// agent 会判定「这条命令失败了」—— 而「把 help 读成失败」正是本 bug 最伤的地方。
// ⚠ 「求助」与「参数给漏了」是两回事,别共用一条出口:前者 helpOut(0),
//    后者仍 die(1) —— 漏参数时报成功,调用方会以为活干完了。
function helpOut(text) {
  process.stdout.write(text + '\n')
}

function printSubHelp(sub) {
  helpOut(SUBHELP[sub])
}

// 顶层清单按**谁在用**分三组(运维 / 本机试跑 / 群里的基础技能),不按实现顺序平铺:agent 在群里
// 只会碰第三组,operator 在终端里只会碰前两组,混在一起 34 行谁都得从头找。每个命令一行,
// 动作名列全(feishu 18 个、design 10 个都在这儿),细节去各自的 --help。
// ⚠ 派发表里每个子命令都必须以「sbot <名>」或「sintbot <名>」出现在这里(cli-help.test 钉着):否则 agent 无从知道它存在。
// 给人用的(安装运维 / 本机试跑)写 sintbot;agent 用的基础技能写 sbot —— 权限白名单是 `Bash(sbot …)`,写成 sintbot 会被拦。
function printHelp() {
  process.stdout.write(`sintbot — 从聊天群驱动无头 Claude Code 与 Codex,模型大脑可换

  · 群即项目:一个群绑一个项目,多人在群里直接派活(改码 · 部署 · 查资料 · 出图 · 定时任务);每群独立会话、排队与权限
  · 记得住:项目约定与长期记忆存在项目目录里,长会话自动压缩,换模型不丢
  · 数据留在本机:项目、会话、记忆、账本全在本机硬盘,项目随 git 备份;出站自动脱敏,权限按群预设、无人值守不挂起
  · 只换脑,不换框架:沿用 Claude Code 的工具 / 权限 / 插件体系;模型任选(Claude · GPT · DeepSeek · GLM · MiniMax,或任何兼容 Anthropic 接口的端点),群里 /model 即切
  · 各用所长:同一个项目里各模型干各自擅长的活 —— Claude 改码,GPT 出图(借本机 codex 订阅,零 API key)

官网 https://sintbot.com · 源码与文档 https://github.com/sintlab/sintbot · 反馈问题 https://github.com/sintlab/sintbot/issues

用法: sintbot <命令> [动作] [参数…]        每条命令都收 --help(输出走 stdout、退出码 0);sbot 是同一个命令的短名

【安装与运维】(配置默认在 ~/.sbot/config.json;--config / $SBOT_CONFIG 可另指)
  sintbot setup [--config <path>]          首次向导:环境检查 · 模型 · 聊天平台(飞书 / Slack / 企业微信)· 项目根目录 · 绑一个群;完了自动体检
  sintbot service install|status|restart|logs|uninstall   装成常驻服务(macOS launchd / Linux systemd),崩溃自动拉起、登录后自启
  sintbot version                          打印版本号
  sintbot doctor [--config <path>] [--kill-leftovers]   体检:配置 / claude CLI / provider / MCP / 飞书权限 / 群绑定 / 遗留进程;有 fail 退出码 1
  sintbot providers                        列出配置里的模型 provider(* = 默认)
  sintbot ui [--port <n>] [--host <ip>]    浏览器控制台(配置模式,不接 daemon);--set-password 设密码,对外绑定必先设
  sintbot start [--ui] [--ui-host <ip>]    前台跑守护进程(群消息 → 绑定项目 → agent → 回群);--ui 同时开实时控制台
  sintbot issue list|show|close|reopen     本机的群内反馈本(群成员在群里用 /issue 提);close 默认回原群告知

【本机试跑】(不接飞书)
  sintbot chat [-C <dir>] [--provider <名>]         终端里逐行驱动引擎:每行 = 一条群消息,/help 看群内命令,/exit 退出
  sintbot agent run [--provider <名>] "<prompt>"    单轮无头 agent,只读;--resume <sid> 续接

【群里的基础技能】(agent 在群项目里调,写 sbot:与 agent 的权限白名单一致;目标群取 --chat <oc_…>,群里跑时已注入 $SBOT_CHAT_ID)
  sbot feishu <动作>                    消息:send-msg · send-file · send-image · history · reply · edit · recall · download · react
                                        画布:board-create · board-add-image · board-add-diagram · board-add-nodes · board-nodes
                                              board-del-node · board-comments · board-resolve-comment · board-get-media
  sbot wecom <动作>                     企业微信群(platform:"wecom"):send-msg · send-file · send-image · history
  sbot cron <动作>                      定时任务:add "<时间>" --do|--say|--run · list · update · remove · on · off(时间按产品时区)
  sbot imagen "<描述>" --out <png>      借本机 codex 订阅生图,任何模型的群都能用;受理即返回,--wait 等;退出码 2 = 还在跑,不是失败
  sbot preview start|stop|status        把 HTML 原型挂到局域网给群成员看;detached、闲置自动回收
  sbot browser link                     签一条只能打开一次的接管链接:群成员在手机或电脑上直接操作机器人的浏览器(登录 / 验证码 / 扫码)
  sbot design <动作>                    风格档与图标:styles · use · swatch · extract-colors · icons · icon
                                        交付前四条验收:check · doctor · layout · icon-assets(有偏离退出码 3,不是失败)

【约定】
  配置查找顺序   --config > $SBOT_CONFIG > ./sbot.config.json > ~/.sbot/config.json;密钥可写 "env:VAR"
  退出码         0 成功 · 1 失败或参数错 · 2 imagen 仍在跑 · 3 design 验收有偏离
  输出           确认与进度走 stderr;给程序读的正文(列表 / JSON / SVG / 链接)走 stdout
  --help         feishu / agent 只认紧跟命令的头两个位置(再往后是正文);其余命令放哪儿都认
`)
}

function cmdProviders() {
  const cfg = loadConfig()
  process.stdout.write(`providers${cfg._path ? dim('  (' + cfg._path + ')') : dim('  (built-in defaults)')}\n`)
  for (const [name, p] of Object.entries(cfg.providers)) {
    const def = name === cfg.defaultProvider ? cyan(' *') : '  '
    const base = p.baseUrl || 'anthropic (logged-in)'
    const key = p.apiKey ? 'set' : (p.baseUrl ? gray('MISSING') : 'n/a')
    process.stdout.write(`${def}${name.padEnd(10)} model=${(p.model || '-').padEnd(18)} base=${base}  key=${key}\n`)
  }
  process.stdout.write(dim('\n* = default provider\n'))
}

// claude 出错时先把「API Error: …」当一条 assistant 文本流出来,result 里再给同一句 ⇒ 记住最后一段正文,
// result 的报错与它相同就不再打一遍(1.0.2 及以前同一句错误在终端里出现两次)
let lastAssistantText = ''
function renderEvent(ev) {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') process.stderr.write(dim(`● session ${ev.sessionId}`) + '\n')
      break
    case 'assistant':
      if (ev.thinking) process.stdout.write(gray(`[thinking] ${truncate(ev.thinking, 140)}`) + '\n')
      for (const t of ev.tools || []) {
        process.stdout.write(cyan(`🔧 ${t.name} `) + gray(truncate(JSON.stringify(t.input), 80)) + '\n')
      }
      if (ev.text) { process.stdout.write(ev.text); lastAssistantText = ev.text }
      break
    case 'result':
      process.stdout.write('\n')
      if (ev.isError && String(ev.text || '').trim() !== lastAssistantText.trim()) process.stderr.write(red(`✕ ${ev.text || 'error'}`) + '\n')
      break
  }
}

async function cmdAgentRun(rest) {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      workdir: { type: 'string', short: 'C' },
      resume: { type: 'string' },
      config: { type: 'string' },
    },
  })

  const prompt = positionals.join(' ').trim()
  if (!prompt) return die('missing prompt: sintbot agent run [--provider X] "<prompt>"')

  const cfg = loadConfig(values.config)
  applyProxyEnv(cfg)
  const provName = values.provider || cfg.defaultProvider
  const provider = cfg.providers[provName]
  if (!provider) return die(`unknown provider '${provName}' (have: ${Object.keys(cfg.providers).join(', ')})`)
  if (provider.baseUrl && !provider.apiKey) {
    return die(`provider '${provName}' has a baseUrl but no apiKey — set its env var (see sbot.config.json)`)
  }

  const model = values.model || provider.model
  process.stderr.write(dim(`▶ provider=${provName} model=${model || '(default)'} base=${provider.baseUrl || 'anthropic'}`) + '\n')

  try {
    const { sessionId, result } = await runner.runTurn({
      bin: cfg.agent.bin,
      prompt,
      provider,
      model: values.model,
      workdir: values.workdir ? expandHome(values.workdir) : undefined, // `-C '~/x'` 带引号时 shell 不展开
      sessionId: values.resume,
      permissionMode: 'dontAsk', // one-shot CLI: fail-closed floor (no global setting; per-group modes live on the console cards)
      // one-shot CLI has no project context ⇒ no allow list (read-only under dontAsk).
      // Tool permissions are per-project — use a bound group for tool-using turns.
      onEvent: renderEvent,
    })
    verify.recordTurn(provider, !(result && result.isError), (result && result.text) || '') // doctor / 控制台据此报「能用」或「key 不对」
    if (result && result.isError) {
      // 出错的轮次没有可续的上下文,不给 resume 提示;key 型模型认证失败时指一下去哪换
      if (result.authFailed) process.stderr.write(dim(`  换 key:控制台「模型」页,或重跑 sintbot setup`) + '\n')
      process.exit(1)
    }
    process.stderr.write(dim(`■ done  session=${sessionId}  (resume with: sintbot agent run --resume ${sessionId} "…")`) + '\n')
  } catch (e) {
    verify.recordTurn(provider, false, e.message)
    die(e.message)
  }
}

// `sbot chat` — drive the engine from the terminal via the stub CLI platform
// (no Feishu). Each line you type is a "group message" to the bound workdir.
async function cmdChat(rest) {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      workdir: { type: 'string', short: 'C' },
      allow: { type: 'string' },
      deny: { type: 'string' },
      config: { type: 'string' },
    },
  })

  const cfg = loadConfig(values.config)
  applyProxyEnv(cfg)
  const provName = values.provider || cfg.defaultProvider
  if (!cfg.providers[provName]) return die(`unknown provider '${provName}' (have: ${Object.keys(cfg.providers).join(', ')})`)
  const workdir = path.resolve(expandHome(values.workdir || '') || process.cwd()) // `-C '~/x'` 带引号时 shell 不展开
  // Permissions are per-project; grant this ad-hoc session's tools explicitly via
  // --allow/--deny (comma-separated). Omit ⇒ read-only under dontAsk. Scoped to workdir.
  const asList = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined)

  const store = new StateStore(path.join(workdir, '.sbot', 'state.json'))
  const engine = new Engine(cfg, {
    runner,
    store,
    defaultGroup: { workdir, provider: provName, model: values.model, allowedTools: asList(values.allow), disallowedTools: asList(values.deny) },
    log: (m) => process.stderr.write(gray('· ' + m) + '\n'),
    ledger: createLedger(path.join(workdir, '.sbot', 'turns.jsonl')),
  })
  engine.codexMcp = () => { try { return require('../src/plugins').codexPlugins().mcp.map((m) => m.name) } catch { return [] } }
  engine.projectMcp = (wd) => { try { return require('../src/plugins').projectPlugins(wd).mcp.map((m) => m.name) } catch { return [] } } // 项目级 .mcp.json → 清单【项目自带插件】(v0.11.2)
  // 项目现有风格档 → 清单(v0.11.22);v0.11.29 起连 tokens 摘要一起给 —— 清单只给路径
  // 等于只给指路牌,agent 可能根本没读。core 不碰 fs,故在这里读。
  engine.styleDocs = (wd) => { try { const ic = design.findIconsDoc({ cwd: wd }); return design.findStyleDocs({ cwd: wd }).map((d) => withDigest(d, ic)) } catch { return [] } }
  engine.projectMemory = (wd, o) => { try { return require('../src/projectmemory').probeHandover(wd, o) } catch { return null } } // 跨会话留得住的东西 → 清单;core 不碰 fs
  engine.hasImagen = () => Object.values(engine.cfg.providers || {}).some((p) => p && p.runner === 'codex') // 生图桥可用性(core 不认 runner 名,bin 判)
  const platform = createCliPlatform({ senderName: process.env.USER || 'you' })

  process.stderr.write(dim(`sintbot chat — provider=${provName} workdir=${workdir}\ntype a message + Enter; /help for commands; /exit to quit`) + '\n')
  await platform.start((msg) => engine.handleMessage(msg, platform))
}

// 还没接聊天平台时的 `sbot start --ui`:只开配置模式的控制台(与 `sintbot ui` 同一套),等人在「设置」里接平台。
// 照拿单实例锁(和正式 daemon 同一把:之后在终端里 sintbot start 会被拦下,不会两个抢一个平台)。
// 服务托管(SBOT_SUPERVISED=1)时,配置里第一次出现配齐的平台就 3 秒后退出 —— launchd / systemd 拉起来就是正式 daemon、连上平台;
// 前台跑的只在日志里提示重启。
async function serveSetupConsole(cfg, { port, host, noOpen }) {
  const configPath = cfg._path || path.join(process.cwd(), 'sbot.config.json')
  if (!isLoopbackHost(host) && !((cfg.ui || {}).auth)) return die(`控制台对外(--ui-host ${host})需先设密码:sintbot ui --set-password`)
  const supervised = process.env[require('../src/service').SUPERVISED_ENV] === '1'
  const stateDir = path.join(os.homedir(), '.sbot')
  try { secureDataDir(stateDir) } catch {}
  const lock = require('../src/core/instancelock').acquire(path.join(stateDir, 'daemon.lock'))
  if (!lock.ok) return die(`另一个 sbot 已在运行(pid ${lock.holder || '?'})—— 先停掉它(装了服务就 sintbot service uninstall / restart)`)
  process.on('exit', lock.release)
  const logTz = normalizeTz(cfg.timezone) // 与正式 daemon 同一口径:按产品时区打戳
  const logStamp = () => fmtLogStamp(Date.now(), logTz)
  const log = (m) => process.stderr.write(gray(`[${logStamp()}] · ` + m) + '\n')
  const ui = createUiServer({ configPath, host, log, setupMode: { supervised } })
  ui.server.on('error', (e) => die(e.code === 'EADDRINUSE' ? `控制台端口 ${port} 被占用 —— 加 --ui-port <其它> 换端口` : 'ui server error: ' + (e && e.message)))
  ui.listen(port, host, () => {
    const url = `http://127.0.0.1:${port}`
    process.stderr.write('\n' + cyan('  sbot 控制台') + dim('  →  ') + url + gray('  (还没接聊天平台:在「设置」里接飞书 / Slack / 企业微信)') + '\n\n')
    log(`还没接聊天平台,只开控制台 ${url}` + (supervised ? ';接上平台后自动重启连上' : ''))
    if (!noOpen) tryOpen(url)
  })
  let told = false
  fs.watchFile(configPath, { interval: 1500 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs || told) return
    let now
    try { now = platformsConfigured(loadConfig(configPath)) } catch { return } // 写到一半 / 改坏了:等下一次
    const names = Object.keys(now).filter((k) => now[k])
    if (!names.length) return
    told = true
    if (supervised) { log(`已接上 ${names.join(' / ')} —— 3 秒后重启守护进程连上`); setTimeout(() => process.exit(0), 3000) }
    else log(`已接上 ${names.join(' / ')} —— 按 Ctrl-C 后重新运行 sintbot start --ui 连上`)
  })
  const bye = () => { try { ui.close() } catch {} process.exit(0) }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}

// `sbot start` — the daemon: Feishu WS in, engine routes each group message to
// its bound project, agent runs, reply goes back to the group.
async function cmdStart(rest) {
  const wantUi = rest.includes('--ui')
  const noOpen = rest.includes('--no-open')
  rest = rest.filter((a) => a !== '--ui' && a !== '--no-open')
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: 'string' }, 'ui-port': { type: 'string' }, 'ui-host': { type: 'string' } },
  })

  const cfg = loadConfig(values.config)
  applyProxyEnv(cfg)
  // 双平台并存:配了哪个平台就接哪个(feishu 块 appId+appSecret ⇒ 飞书;wecom 块 botId+secret ⇒ 企微),至少一个;
  // 两个都配就两个都接,群项目各自带 platform 字段说明属于哪边(config.normalizeGroupPlatforms 归一,路由器按它分发)。
  const plat = platformsConfigured(cfg)
  if (!plat.feishu && !plat.wecom && !plat.slack) {
    // 带 --ui(后台服务就是这么起的):只开控制台,等人在「设置」里接平台 —— 1.0.12 起没平台也装服务,装完就有地方可去
    if (wantUi) return serveSetupConsole(cfg, { port: Number(values['ui-port']) || 4600, host: (cfg.ui && cfg.ui.host) || values['ui-host'] || '127.0.0.1', noOpen })
    if (cfg.wecom && (cfg.wecom.botId || cfg.wecom.secret)) return die('sbot.config.json 的 wecom 块缺 ' + (cfg.wecom.botId ? 'secret' : 'botId') + '(机器人 API 配置页「使用长连接」处)')
    return die('没有配置任何聊天平台 — 在 sbot.config.json 里加 "feishu" 块(appId/appSecret)、"wecom" 块(botId/secret)或 "slack" 块(botToken/appToken),配几个接几个')
  }
  if (cfg._deprecatedPlatform !== undefined) process.stderr.write(gray('warning: 顶层 platform 字段已废弃、被忽略 — 现在配了哪个平台就接哪个,群自己带 platform 字段') + '\n')
  // 块写了却不齐的平台不接也要出声(doctor 对它报 fail,启动一声不吭就是两处口径不一)
  if (!plat.feishu && cfg.feishu && (cfg.feishu.appId || cfg.feishu.appSecret)) process.stderr.write(yellow('warning: feishu 块缺 ' + (cfg.feishu.appId ? 'appSecret' : 'appId') + ',飞书不接') + '\n')
  if (!plat.wecom && cfg.wecom && (cfg.wecom.botId || cfg.wecom.secret)) process.stderr.write(yellow('warning: wecom 块缺 ' + (cfg.wecom.botId ? 'secret' : 'botId') + ',企业微信不接') + '\n')
  if (!plat.slack && cfg.slack && (cfg.slack.botToken || cfg.slack.appToken)) process.stderr.write(yellow('warning: slack 块缺 ' + (cfg.slack.botToken ? 'appToken' : 'botToken') + ',Slack 不接') + '\n')
  // ⚠ 配了就接:同一个企微机器人只许一条长连接,两台机都配同一对凭据会互踢(新连踢旧连、60s 后再抢)—— 启动横幅点名是哪个机器人,出事能对号
  if (plat.wecom) process.stderr.write(gray(`企业微信:接机器人 ${cfg.wecom.botName || '(未填名)'} · Bot ID …${String(cfg.wecom.botId).slice(-6)}(一个机器人只许一条长连接,别在另一台机配同一个)`) + '\n')
  // Startup probe (FR3.4): fail fast if the agent binary is missing/broken.
  const probe = await probeVersion(cfg.agent.bin)
  if (!probe.ok) return die(`agent check failed: ${probe.error} (run 'sintbot doctor')`)

  const groupCount = Object.keys(cfg.groups || {}).length
  if (!groupCount) process.stderr.write(gray('warning: no groups bound — every message will get "not bound to a project"') + '\n')

  const statePath = path.join(os.homedir(), '.sbot', 'state.json')
  // 先收紧权限再写任何东西:旧版本建的目录是 755、账本是 644,同机其他用户能读到群聊正文
  let tightened = []
  try { tightened = secureDataDir(path.dirname(statePath)) } catch (e) { process.stderr.write(yellow('warning: 收紧状态目录权限失败:' + (e && e.message)) + '\n') }
  // 单实例锁(src/core/instancelock.js):同一份状态只许一个 daemon —— 两个会抢同一个平台的消息
  const lock = require('../src/core/instancelock').acquire(path.join(path.dirname(statePath), 'daemon.lock'))
  if (!lock.ok) return die(`另一个 sbot 已在运行(pid ${lock.holder || '?'}${lock.cmd ? ' · ' + lock.cmd.slice(0, 80) : ''})—— 同一份状态只许一个 daemon,否则会抢同一个平台的消息。先停掉那个(装了服务就 sintbot service uninstall / restart,或结束终端里的 sintbot start)`)
  process.on('exit', lock.release)
  const store = new StateStore(statePath)
  // ⚠ 日志此前**一行时间戳都没有**,而账本记的是 epoch ms ⇒ **两边对不上号**:出事时账本说
  //   「这一轮失败了」、日志说「某处报了什么错」,却无法判断是不是同一件事。2026-09-01 真机排查
  //   撞上过:生产群一周 15 次 error,一次都查不出原因 —— 两边各缺一半,合起来等于查不了。
  // ⚠ 时间按**产品时区**打(与群里的时间戳同一口径、与主机时区解耦)。启动横幅里写明是哪个时区 ——
  //   本项目栽过「两把钟不许比大小」,日志时间是给人拿去和群消息对照的,不写清楚就会被读错。
  const logTz = normalizeTz(cfg.timezone)
  const logStamp = () => fmtLogStamp(Date.now(), logTz)
  const log = (m) => process.stderr.write(gray(`[${logStamp()}] · ` + m) + '\n')
  if (tightened.length) log(`状态目录权限已收紧(目录 700、文件 600):${tightened.length} 项`)
  let ui = null
  let updaterManager = null
  let platform = null // set below; the UI (created first) reads WS health through this ref(多平台路由器,src/platform/multi.js)
  // 把一条消息交给引擎:**合成消息**(控制台插话 / 定时任务 / 续做 / 画布确认)没有真实适配器,按 chatId 查出它所属平台的
  // 适配器再喂 —— 引擎读的 skillCmd / features / chatLabel 是适配器上的,喂路由器会让企微群的清单按飞书口径写。
  // 入站消息由路由器带着自己的适配器送来(第二参)。engine / platform 都在下面才赋值,这里只是闭包、调用时才碰。
  const handle = (msg, adapter) => engine.handleMessage(msg, adapter || (platform && platform.forChat && platform.forChat(msg && msg.chatId)) || platform)
  const ledger = createLedger(path.join(os.homedir(), '.sbot', 'turns.jsonl'), log)
  // /hud usage probe (daemon-only; keeps core runner-agnostic). codex → subscription
  // 5h/weekly %; keyed providers → account balance/quota. 判据、缓存与 { supported, value }
  // 形状全在 src/usage.js 的 createUsageProbe(可单测);这里只把 codex 那条通道接进去。
  const usageProbe = usage.createUsageProbe({
    codexUsage: async () => codexstatus.formatUsage(await codexstatus.rateLimits('codex')),
  })
  // 额度告警(v0.11.8):轮结算后顺带查一次 —— **不新起定时器**(没人用的时候额度不会变,
  // 定时轮询就是白打接口)。判定与文案在 core/quotaalert(纯函数),这里只做 IO 与派发。
  // 去重按 **provider** 存盘(store.wasQuotaAlerted):额度是账号级事实,多群共用一个订阅
  // 不该吵 N 遍;落盘而非内存 —— 发版频繁,内存态每次 kickstart 都会重播。
  // 数据源自带 60s 缓存(claudeusage 内建 / codexRate 这里做),所以每轮调用不会真打接口。
  // ⚠ 检查节流(每 provider 5 分钟):不加这道,活跃对话里**每轮结算都会起一个进程** ——
  // codex 侧 spawn `codex app-server`,Claude 侧 macOS 无凭据文件时 spawn `security` 查
  // Keychain。额度是慢变量,5 分钟粒度足够(跨过阈值晚说几分钟无妨,进程开销省掉 95%)。
  const quotaCheckedAt = new Map()
  const QUOTA_CHECK_MS = 5 * 60_000
  const codexRateCache = { at: 0, v: null }
  const tokenCache = { at: 0, v: null }
  // 一次取数,两个消费者:额度告警(quotaalert 判定)与额度自动切换(engine.noteQuota / engine.quotaStatus 的结构化窗口)。
  // 返回 { alert, status } —— status = { ok, windows:[{kind:'session'|'weekly', percent, resetsAt}] } | null(没探到)。
  // codex 的 resetsAt 是相对秒数或绝对秒,这里统一成绝对毫秒并取整到分钟(与 quotaalert.codexAlert 同一口径)。
  const fetchQuota = async (name) => {
    const provider = (engine.cfg.providers || {})[name]
    if (!provider || provider.hidden) return { alert: null, status: null }
    const now = Date.now()
    if (provider.runner === 'codex') {
      if (!codexRateCache.at || now - codexRateCache.at > QUOTA_CHECK_MS) {
        codexRateCache.v = await codexstatus.rateLimits(provider.bin || 'codex').catch(() => null) // 与 runner 同源取 provider.bin(cfg.agent.bin 是 claude 那支)
        codexRateCache.at = now
      }
      const u = codexRateCache.v
      if (!u) return { alert: null, status: null }
      const windows = [u.primary, u.secondary].filter((w) => w && typeof w.usedPercent === 'number').map((w) => {
        let resetsAt = null
        if (w.resetsAt != null && Number.isFinite(Number(w.resetsAt))) { const raw = Number(w.resetsAt); const ms = raw > 1e9 ? raw * 1000 - now : raw * 1000; if (ms > 0 && ms < 30 * 864e5) resetsAt = Math.round((now + ms) / 60e3) * 60e3 }
        return { kind: Number(w.windowMins) >= 1440 ? 'weekly' : 'session', percent: w.usedPercent, resetsAt }
      })
      return { alert: quotaalert.codexAlert(u), status: windows.length ? { ok: true, windows } : null }
    }
    if (provider.baseUrl) return { alert: null, status: null } // 第三方端点没有这类窗口额度
    const cu = require('../src/agent/claudeusage') // 订阅登录的 Claude
    // token 读取是同步 spawn `security`(≤1.5s,阻塞事件循环)⇒ 缓存一分钟;读不到 = **没探到**(钥匙串未解锁 / 偶发超时都会
    // 这样),不是「账号不可用」—— 第一版把它报成 ok:false,一次假阴性就会让每个 claude 群误切到备用并宣告账号不可用
    if (!tokenCache.at || now - tokenCache.at > 60_000) { tokenCache.v = cu.readAccessToken(); tokenCache.at = now }
    const token = tokenCache.v
    if (!token) return { alert: null, status: null }
    const data = await cu.fetchRaw(token, { log }).catch(() => null) // 取数失败留一行痕(超时/限流/状态码),排查不用靠猜
    if (!data) return { alert: null, status: null }
    const limits = cu.parseLimits(data)
    // 只认 5 小时窗与全量周窗;按模型族分摊的周窗(weekly_scoped)不进判定 —— 它满了不等于整个账号不能用
    const windows = limits.filter((l) => l && (l.kind === 'session' || l.kind === 'weekly_all') && typeof l.percent === 'number')
      .map((l) => ({ kind: l.kind === 'session' ? 'session' : 'weekly', percent: l.percent, resetsAt: typeof l.resetsAt === 'number' ? l.resetsAt : null }))
    // 一个窗口都解不出(接口形状变了)= 没探到:给 null,别让引擎把「没数据」读成「全退下去了」
    return { alert: quotaalert.claudeAlert(limits), status: windows.length ? { ok: true, windows } : null }
  }
  // 额度自动切换要问「某个模型眼下能不能用」(切备用前看备用有没有额度 · 切回前看主模型恢复了没):与告警同一份取数。
  // ⚠ 这里 `engine` 还没声明(const 在下面),只能先定义成普通函数、经构造参数注入 —— 第一版写成 `engine.quotaStatus = …`,
  //    daemon 一启动就 TDZ 抛「Cannot access 'engine' before initialization」;单测全在 engine 层,cmdStart 没人跑,1660 例全绿照崩(对抗审查实跑逮到)。
  const quotaStatus = async (name) => { try { return (await fetchQuota(name)).status } catch (e) { log(`额度探针失败(${name}): ` + (e && e.message)); return null } }
  const checkQuotaAlert = async (chatId) => {
    try {
      const g = (engine.cfg.groups || {})[chatId]
      if (!g || g.paused) return
      // 按**实际在用**的模型查(临时切到备用时查的是备用):告警与自动切换都该盯着正在花的那份额度
      const name = engine._resolveProvider(chatId, g).name
      const provider = (engine.cfg.providers || {})[name]
      if (!provider || provider.hidden) return
      const last = quotaCheckedAt.get(name) || 0
      if (Date.now() - last < QUOTA_CHECK_MS) return
      quotaCheckedAt.set(name, Date.now())
      const { alert, status } = await fetchQuota(name)
      // 额度自动切换(v0.11.107):把窗口交给引擎判定(≥95% ⇒ 正用它的群下一轮前切备用;退下去了 ⇒ 清不可用标)
      engine.noteQuota(name, status)
      if (!alert) return
      if (store.wasQuotaAlerted(name, alert.kind, alert.resetsAt)) return
      store.markQuotaAlerted(name, alert.kind, alert.resetsAt)
      const text = quotaalert.alertText(alert)
      // 同一订阅下所有未暂停的绑定群各发一条(额度是账号级,但每个群的人都该被告知)
      for (const [cid, gg] of Object.entries(engine.cfg.groups || {})) {
        if (!gg || gg.paused) continue
        if (engine._resolveProvider(cid, gg).name !== name) continue // 实际在用的模型(临时切换中按备用算)
        Promise.resolve(platform.send(cid, text)).catch((e) => log(`额度告警(${cid}): ` + (e && e.message)))
      }
      log(`额度告警已播:${name} ${alert.kind} ${alert.percent}%`)
    } catch (e) { log('额度告警检查失败(忽略): ' + (e && e.message)) }
  }

  // 群内反馈本(/issue):与 ledger 同族的本机 JSONL,daemon 注入 —— core 不碰 fs。
  // version 一并注入:事后分析一条反馈时,「它是哪一版报的」是第一判据。
  const issues = createIssues(path.join(os.homedir(), '.sbot', 'issues.jsonl'), { log, withFileLock, host: cfg.instance || undefined })
  // 运维告警(alerts.chatId):引擎在事发点吐事件,opsalert.createSink 配文案、去重、发群(纯逻辑在 core,可单测)。
  // ⚠ getCfg / getPlatform 是函数:engine 与 platform 都在下面才赋值,定义时碰就是 TDZ 启动必崩(v0.11.107 的教训);
  //    读 engine.cfg 而非 cfg:热重载后 alerts.chatId / 群名 / instance 都要跟着新配置。
  const onAlert = opsalert.createSink({
    getCfg: () => engine.cfg,
    getPlatform: () => platform,
    log,
    humanReset: quotaalert.humanReset,
    fallbackInstance: os.hostname().split('.')[0],
    platformLabels: { feishu: '飞书', wecom: '企业微信', slack: 'Slack' }, // 平台中文名在这里注入:core 不认平台名
  })
  // 平台长连接中断观察:两个适配器的 onConn 把看门狗快照喂进来,断开超过宽限期(默认 5 分钟)才经 onAlert 发告警群。
  // ⚠ 必须在 onAlert 定义之后再建(const 的 TDZ,同上一条教训);⚠ 告警本身也走 platform.send ⇒ 断的若正是告警群
  //    所在平台,这条告警必然发不出(createSink 的 catch 只记日志),是预期 —— 它报的是「另一个平台断了」。
  const connWatch = opsalert.createConnWatch({ onAlert, log })
  const engine = new Engine(cfg, { runner, store, log, ledger, usageProbe, quotaStatus, issues, onAlert, verifyTurn: verify.recordTurn, version: require('../package.json').version, onActivity: (ev) => {
    if (ui) ui.pushEvent('turn', ev)
    // 轮结算后查额度(fire-and-forget,绝不拖慢结算)
    if (ev && ev.kind === 'done' && ev.chatId) checkQuotaAlert(ev.chatId)
    // 画布单卡回填兜底(2026-07-23):boardgo 轮次 done → 若 agent 没 --deliver(队列还有本轮锚点),
    // 出队把「处理中」播报卡收尾成终态,不卡死处理中。有 --deliver 时它已出队 ⇒ 这里拿到 null no-op。
    // ⚠ 判「本轮含 boardgo」必须扫全批 msgIds(排队合并的代表是末条,单看 ev.msgId 会漏批内 boardgo);
    // 文案按轮次 status 如实(failed 轮不谎报「完成」);无 cardId(文本播报)出队即弃,无卡可收尾。
    try {
      const evIds = Array.isArray(ev && ev.msgIds) ? ev.msgIds : (ev && ev.msgId ? [ev.msgId] : [])
      if (ev && ev.kind === 'done' && ev.chatId && evIds.some((id) => typeof id === 'string' && id.startsWith('boardgo:'))) {
        // 先按本轮 goId **精确定位**这轮自己的卡(不靠 FIFO 头 —— detached imagen worker 交付会错位;审查 M2)。
        // 队列已无本轮锚点 = agent 已 --deliver 自行回填 ⇒ null no-op。
        const mine = takeNoticeByGo(boardNoticeDir(), ev.chatId, evIds, { peek: true })
        // imagen 异步交付让位:仅 **apply 轮**可能起 --deliver 生图 worker(受理秒回,轮先 done、图后到),
        // 让位给 worker 收尾(否则双卡)。**sync 轮从不 --deliver/起 worker ⇒ 恒由本兜底收尾,绝不让位**
        // (审查 M2:chatId 级 imagenPending 会被无关 worker 抑制,让 sync 卡永久卡「同步中」)。
        const syncRound = mine && mine.kind === 'sync'
        if (!syncRound) {
          const imagenPending = (() => { try { return imagen.listTasks(imagen.imagenDir()).some((t) => t && t.deliver && t.chatId === ev.chatId && t.status === 'running' && (Date.now() - (t.createdAt || 0) <= imagen.IMAGEN_WALL_MS + 60_000) && (t.pid == null || imagen.pidAlive(t.pid))) } catch { return false } })()
          if (imagenPending) { log(`board notice 收尾让位 imagen worker: ${ev.chatId}`); return }
        }
        const notice = takeNoticeByGo(boardNoticeDir(), ev.chatId, evIds) // 消费本轮这张(非队头)
        if (notice && notice.cardId && boardClient) {
          // 文案按 status 如实但不冤枉:ok=完成;no-reply(agent 刻意无回复)与 failed/stopped 都用
          // 中性收尾,不喊「失败」吓人(实际情况详见群消息,重试入口给足)。ok 收尾把 agent 的结论
          // 摘要写进卡(2026-07-23 用户提「过程内容进卡」的折中拍板:过程留流式卡,**结论进播报卡**
          // —— 卡自足不用翻聊天记录,又不碰流式机制/同卡更新频控)。
          const ok = ev.status === 'ok'
          const syncRound = notice.kind === 'sync' // sync 轮 agent 不 --deliver ⇒ 恒走这里收尾;文案按「同步源码」如实
          const summary = String((ev.preview || ev.reply || '')).replace(/\s+/g, ' ').trim().slice(0, 220)
          const card = ok
            ? buildDeliverCard({ boardUrl: notice.url || null, title: syncRound ? '画布改动已同步' : '画布反馈处理完成', note: summary ? `**${syncRound ? '同步结论' : '处理结论'}**:${summary}` : (syncRound ? '已把画布上的改动同步回源码,未新增画板版本。' : '结果见群里消息与画布。'), redact })
            : { schema: '2.0', config: { width_mode: 'default' }, header: { title: { tag: 'plain_text', content: '本轮处理已结束' }, template: 'orange' }, body: { padding: '16px', vertical_spacing: '8px', elements: [{ tag: 'markdown', content: '本轮未正常交付结果(详见群里消息)—— 可在群里直接说需求重试。' }] } }
          updateCardEntity(boardClient, notice.cardId, card).catch((e) => log('board notice 收尾: ' + (e && e.message)))
        }
      }
    } catch (e) { log('board notice 收尾: ' + (e && e.message)) }
  } })
  // Let the self-knowledge manifest report the project dir's REAL git origin state (关联/缺失/不一致),
  // same source as the console's 仓库 badge. Pure fs (no spawn) — safe to call while building a manifest.
  { const gitrepo = require('../src/gitrepo'); engine.repoInfo = (workdir, repo) => ({ state: gitrepo.quickLinkState(workdir, repo), origin: gitrepo.readOriginFromGitConfig(workdir) }) }
  // codex 群的自知清单如实列全局 codex MCP(config.toml 全局生效、无按群门控)—— 注入读取器,core 不认 plugins 模块。
  engine.codexMcp = () => { try { return require('../src/plugins').codexPlugins().mcp.map((m) => m.name) } catch { return [] } }
  // 项目级 .mcp.json → 清单【项目自带插件】+ 浏览器纪律触发判据(v0.11.2;某项目真踩:chrome-devtools
  // 声明在项目里,清单不列 ⇒ agent 有浏览器工具却没注入使用纪律)。
  engine.projectMcp = (wd) => { try { return require('../src/plugins').projectPlugins(wd).mcp.map((m) => m.name) } catch { return [] } }
  engine.styleDocs = (wd) => { try { const ic = design.findIconsDoc({ cwd: wd }); return design.findStyleDocs({ cwd: wd }).map((d) => withDigest(d, ic)) } catch { return [] } }
  // 项目里跨会话留得住的东西(约定文件 + claude 私有记忆目录)→ 清单【这个项目的长期记忆】。
  // 缺的不是能力是可达:群是完全访问,那些 markdown 本来就读得到,只是没人告诉过它在哪、什么规矩。
  // core 不碰 fs,故在这里读;探测不到(或记忆目录归属存疑)就返回 null,清单里一个字都不出现。
  engine.projectMemory = (wd, o) => { try { return require('../src/projectmemory').probeHandover(wd, o) } catch { return null } }
  // 群内 `/model` 切模型的写入器(v0.11.60,产品决定「全员可切」)。core 不碰 fs,故写在这里。
  // ⚠ **必须与控制台切模型做完全相同的一组动作** —— 配置落盘(持久) + 运行时覆盖(下一轮即生效)
  //   + 清会话与会话账。少任何一样都会漂:只写配置 ⇒ 这一轮还用旧模型;只写覆盖 ⇒ 重启后弹回去;
  //   不清会话 ⇒ 把 codex 的 thread-id 喂给 claude 的 `--resume`,当场坏掉。
  // ⚠ 写盘走 atomicWriteJSON(与控制台同一个),不自己拼写法;写完让 daemon 走既有的热重载。
  // keepSession(v0.11.107):额度临时切换中用 /model 钉住当前这个备用 —— 后端没变,会话留着;覆盖与记录照写(记录由 store.setProvider 连带清)
  engine.setProvider = async (chatId, name, { keepSession = false } = {}) => {
    const p = cfg._path || path.join(process.cwd(), 'sbot.config.json')
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!raw.groups || !raw.groups[chatId]) throw new Error('这个群还没绑定项目')
    if (!(raw.providers || {})[name]) throw new Error(`没有「${name}」这个模型`)
    raw.groups[chatId].provider = name
    atomicWriteJSON(p, raw)
    store.setProvider(chatId, name)
    if (!keepSession) { store.clearSession(chatId); store.clearSessionStats(chatId) }
    reloadCfg()
  }
  // 生图桥(sbot imagen)可用性 = 配置里有 codex provider(机器订阅登录态与其同源)。core 不认 runner 名,bin 判。
  engine.hasImagen = () => Object.values(engine.cfg.providers || {}).some((p) => p && p.runner === 'codex')
  const reloadCfg = () => {
    try {
      const c = loadConfig(values.config); applyProxyEnv(c); engine.reload(c)
      if (ui) engine.publicUrl = (c.ui || {}).publicEnabled === false ? null : feishulogin.normalizePublicUrl((c.ui || {}).publicUrl) // 公网入口关闭时不再向群内清单宣传
      log('config reloaded (hot)')
    } catch (e) { log('reload failed: ' + (e && e.message)) }
  }
  // Hot-reload on config-file change — so a separately-run `sbot ui` (or a manual
  // edit) takes effect on this daemon without a restart. `sbot start --ui` also
  // reloads instantly via the console's onConfigChange hook below.
  if (cfg._path) { try { fs.watchFile(cfg._path, { interval: 1500 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) reloadCfg() }) } catch {} }
  if (wantUi) {
    const configPath = cfg._path || path.join(process.cwd(), 'sbot.config.json')
    const uiPort = Number(values['ui-port']) || 4600
    // 控制台设置页可持久切换绑定地址;保存的 host 优先于服务单元里的旧参数。
    const uiHost = (cfg.ui && cfg.ui.host) || values['ui-host'] || '127.0.0.1'
    const uiLoopback = isLoopbackHost(uiHost)
    // Advertise the console address in the agent's self-knowledge manifest (群项目基础能力).
    // For LAN binding, use the first LAN IP so group members get a reachable URL, not 127.0.0.1.
    engine.uiUrl = `http://${uiLoopback ? '127.0.0.1' : (lanIPv4()[0] || '127.0.0.1')}:${uiPort}`
    // agent 自查用的环回地址(免密):对外绑定时 uiUrl 是 LAN IP、带密码墙,拿它自查会撞登录框。
    engine.uiLocalUrl = `http://127.0.0.1:${uiPort}`
    // 公网地址(v0.11.72 起的入口):群里 /help 与清单给人的是它,不是局域网 IP —— 出了局域网 LAN 地址
    // 打不开、还要密码,而公网入口只认飞书登录。归一判据与控制台「飞书登录」就绪判据同源(feishulogin)。
    engine.publicUrl = (cfg.ui || {}).publicEnabled === false ? null : feishulogin.normalizePublicUrl((cfg.ui || {}).publicUrl)
    // Fail-closed: LAN exposure requires a console password (set via `sbot ui --set-password`).
    if (!uiLoopback && !((cfg.ui || {}).auth)) die(`控制台对外(--ui-host ${uiHost})需先设密码:sintbot ui --set-password`)
    const service = require('../src/service')
    updaterManager = updateFeature.createUpdater({
      currentVersion: require('../package.json').version,
      stateFile: path.join(os.homedir(), '.sbot', 'update.json'),
      getLiveState: () => engine.liveState(),
      fetchImpl: require('../src/core/proxy').getProxyFetch() || globalThis.fetch,
      getManagedService: () => { const st = service.status(); return !!st.running && st.pid === process.pid },
      restartManagedService: () => service.restartAsync(),
      setAnnouncementBaseline: (version) => store.setLastVersion(version),
      log,
    })
    // 接管卡片翻状态:有人兑换 ⇒「正在接管中」;点「结束」/ 到时 ⇒「接管已结束」;票过期没人来 ⇒「已过期」。boardClient 在下面才定义,hook 只在运行时才调,不踩 TDZ。
    const flipTakeoverCard = (state) => (meta) => {
      if (!meta || !meta.cardId || !boardClient) return
      const g = (engine.cfg.groups || {})[meta.chatId] || {}
      const red = (s) => redact(s, { pii: g.redactPii !== false })
      updateCardEntity(boardClient, meta.cardId, buildTakeoverCard({ ...meta, state, redact: red })).then(() => log(`接管卡翻「${state}」`)).catch((e) => log(`接管卡翻「${state}」失败: ` + larkErrMsg(e))) // 成功也记一行:部署验收要能正向证明翻了
    }
    ui = createUiServer({
      configPath,
      host: uiHost,
      onTakeoverClaim: flipTakeoverCard('claimed'),
      onTakeoverExpire: flipTakeoverCard('expired'),
      onTakeoverEnd: flipTakeoverCard('ended'),
      getLiveState: () => engine.liveState(),
      getConnHealth: () => (platform && platform.connHealth ? platform.connHealth() : null), // 各平台连接健康度({ feishu, wecom } 字典,路由器出)
      onConfigChange: reloadCfg,
      onHostChange: (boundHost, address) => {
        const port = address && typeof address === 'object' ? address.port : uiPort
        const loopback = isLoopbackHost(boundHost)
        engine.uiUrl = `http://${loopback ? '127.0.0.1' : (lanIPv4()[0] || '127.0.0.1')}:${port}`
        engine.uiLocalUrl = `http://127.0.0.1:${port}`
      },
      updater: updaterManager,
      control: {
        setProvider: (chatId, name) => store.setProvider(chatId, name),   // 实时切模型(下一轮生效)
        // 某群**实际在用**的模型(临时切换到备用时是备用,与 /status · 账本同口径)—— 控制台改 provider 型号时判「受影响群」
        // 要按这个算,按配置算会清错群的会话(正跑备用的群被白清,正跑它的群反而没清)
        providerOf: (chatId) => { const g = (engine.cfg.groups || {})[chatId]; return g ? engine._resolveProvider(chatId, g).name : null },
        clearSession: (chatId) => { store.clearSession(chatId); store.clearSessionStats(chatId) }, // /new(会话规模账一并清零)
        stop: (chatId) => engine.stop(chatId), // /stop
        interrupt: (chatId) => engine.interrupt(chatId), // 中断并开新:abort + 清队列 + 清 session(= busy 时的 /new)
        // Post a one-off notice into the group when its config changes in the console
        // (model switch / permission / plugins). Fire-and-forget; only fires when the
        // daemon is live (platform assigned) — `sbot ui` standalone has no platform ⇒ no-op.
        notifyGroup: (chatId, text) => { try { if (platform && platform.send) Promise.resolve(platform.send(chatId, text)).catch((e) => log('notifyGroup: ' + (e && e.message))) } catch (e) { log('notifyGroup: ' + (e && e.message)) } },
        // 控制台「向群里插一句」——**会驱动一轮**的注入,不是纯通知。
        // ⚠ 与上面 notifyGroup 的区别就在这:那条只让群里多一行字、agent 不动;这条要它真去做事。
        // ⚠ 与定时任务 `--do` 的区别:立刻生效,不用算触发时间、不留一次性任务的残迹 —— 在此之前
        //    operator 想让某个群干件事,只能拿 cron --at 当"现在说句话"用(2026-08-19 连用两次才立的项)。
        // `shown` 非空 ⇒ 先把这句话发进群(群成员看得见来龙去脉);为 null ⇒ 静默注入,群里只看到产出。
        // 返回结构化结果而不是布尔:前端要**如实**告诉人「到底插进去没有」,理由与 issues 那条 canNotify 相同。
        say: (chatId, text, shown, quiet) => {
          if (!platform || !platform.send) return { ok: false, reason: 'no-daemon' }   // `sintbot ui` 纯配置模式
          const g = (engine.cfg.groups || {})[chatId]
          if (!g) return { ok: false, reason: 'unbound' }
          if (g.paused) return { ok: false, reason: 'paused' }                          // 暂停群按语义跳过,与 cron 一致
          const now = Date.now()
          if (shown) { try { Promise.resolve(platform.send(chatId, shown)).catch((e) => log('say(shown): ' + (e && e.message))) } catch (e) { log('say(shown): ' + (e && e.message)) } }
          // ⚠ synthetic:true 是关键 —— 它让这条消息**不推水位线**(v0.11.12:合成消息的时间戳来自本机
          //    Date.now(),与平台消息不是同一把钟;拿它推水位线会静默吞掉真人消息)。
          try {
            // wantsAck:插话勾了「回复」= operator 就在等结果 ⇒ 该走 ack(合成消息默认不 ack,
          // 而那条规则写在插话存在之前)。没有它,长任务整轮不建卡,operator 与群里都看不到动静。
          handle({ chatId, userId: 'console', senderName: '管理员', synthetic: true, quiet: !!quiet, wantsAck: !quiet, text: String(text || ''), msgId: `console:${chatId}:${now}`, createTimeMs: now, replyCtx: { chatId } })
          } catch (e) { log('say: ' + (e && e.message)); return { ok: false, reason: 'inject-failed' } }
          return { ok: true }
        },
      },
      log,
    })
    ui.server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        process.stderr.write(gray(`  控制台端口 ${uiPort} 被占用 — 加 --ui-port <其它> 换端口;daemon 继续运行`) + '\n')
        ui = null
        engine.uiUrl = null; engine.publicUrl = null // 没在听就别在清单 / help 里宣传地址(否则 agent 会把打不开的地址给人)
      }
      else log('ui error: ' + (e && e.message))
    })
    ui.listen(uiPort, uiHost, () => {
      const url = `http://127.0.0.1:${uiPort}`
      process.stderr.write('\n' + cyan('  sbot 控制台') + dim('  →  ') + url + gray('  (实时活动已连 daemon · 配置热重载)') + '\n')
      if (engine.publicUrl) process.stderr.write(dim('    公网   →  ') + engine.publicUrl + dim('  (飞书登录,只放行管理员名单)') + '\n')
      if (!uiLoopback) {
        for (const ip of lanIPv4()) process.stderr.write(dim('    局域网 →  ') + `http://${ip}:${uiPort}` + '\n')
        process.stderr.write(yellow('  ⚠ 已对局域网开放') + dim(' — 仅在可信网络使用;需密码登录,HTTP 明文') + '\n')
      }
      process.stderr.write('\n')
      if (!noOpen) tryOpen(url)
      if (updaterManager) void updaterManager.start().catch((e) => log('update check: ' + (e && e.message)))
    })
  }
  // 配了哪个平台就建哪个适配器;路由器按群分发(连接状态事件带 platform 名,控制台一行一个平台)。
  const adapters = {}
  if (plat.feishu) adapters.feishu = createFeishuPlatform({
    appId: cfg.feishu.appId,
    appSecret: cfg.feishu.appSecret,
    botOpenId: cfg.feishu.botOpenId,
    onlyWhenMentioned: cfg.feishu.onlyWhenMentioned === true,
    ws: cfg.feishu.ws || {}, // WS 活性看门狗调优(pingTimeoutSec 等),真机可调
    card: cfg.feishu.card || {}, // 流式卡片调优:throttleMs 推送节流窗(省飞书 API 月调用量;0=逐帧)
    onConn: (h) => { connWatch.note('feishu', h); if (ui) ui.pushEvent('conn', { platform: 'feishu', ...h }) }, // 连接状态变化:喂中断观察 + 推控制台 SSE
    log,
  })
  // 「不 @ 也回复」的第二道门:便宜模型门控(docs/WECOM.md)。配置 `wecom.gatekeeper` = 模型名 或 { provider, model?, maxPerMin? };
  // 指的模型要有 baseUrl + apiKey(直接 HTTP 问一句 YES / NO,不起 CLI)。
  // 为什么门**总是装、配置每次调用现读**:控制台热重载后 doctor 读的是文件,若门只在启动时按配置装,就会出现「文件里写着 ·
  // doctor 说好 · 运行时没装」(v0.11.36 那种三处都不出声的坑)。所以只要接了企微就装门;没配时门直接回「不答」、不问模型、
  // 不记失败;provider / model / maxPerMin 任一变了就重建内层(限速计数随之归零,可接受)。botName 每次现读(剥 @ 也是)。
  const wecomGate = () => {
    if (!plat.wecom) return null
    const { createGatekeeper } = require('../src/platform/wecomgate')
    const { createAskOnce, askableProvider } = require('../src/agent/askonce')
    const askOnce = createAskOnce()
    let warned = ''
    let inner = null, innerKey = ''
    const gk = () => { const g = (engine.cfg.wecom || {}).gatekeeper; return !g ? null : (typeof g === 'string' ? { provider: g } : g) }
    const build = (g) => createGatekeeper({
      botName: () => (engine.cfg.wecom || {}).botName, // 现读:改名热生效
      maxPerMin: g.maxPerMin,
      log,
      ask: async (q) => {
        const cur = gk()
        if (!cur) throw new Error('门控已在配置里关掉')
        const p = (engine.cfg.providers || {})[cur.provider]
        const why = askableProvider(p, cur.provider, { model: cur.model })
        if (why) { if (warned !== why) { warned = why; log('企业微信门控不可用:' + why) } throw new Error(why) }
        warned = ''
        return askOnce({ ...p, name: cur.provider }, { system: q.system, user: q.user, model: cur.model })
      },
    })
    log(gk() ? `企业微信「不 @ 也回复」第二道门已装:便宜模型门控 → ${gk().provider}` : '企业微信「不 @ 也回复」只有规则一道门(没配便宜模型门控;控制台配上即生效)')
    return async (chatId, q) => {
      const g = gk()
      if (!g) return false
      const key = JSON.stringify([g.provider, g.model || '', g.maxPerMin || ''])
      if (!inner || key !== innerKey) { inner = build(g); innerKey = key; log(`企业微信门控生效:${g.provider}${g.model ? `(${g.model})` : ''}`) }
      return inner(chatId, q)
    }
  }
  if (plat.wecom) adapters.wecom = createWecomPlatform({
    botId: cfg.wecom.botId,
    secret: cfg.wecom.secret,
    botName: () => (engine.cfg.wecom || {}).botName, // 剥正文里的 @机器人;现读 engine.cfg ⇒ 控制台改名热生效
    names: cfg.wecom.names, // { userid: 显示名 } 手工映射(优先于命令行工具搜人)
    cli: cfg.wecom.cli, // 官方命令行工具可执行名(默认 wecom-cli;false = 不搜姓名)
    welcome: cfg.wecom.welcome, // 首次进入单聊的欢迎语(空 = 不回)
    throttleMs: cfg.wecom.throttleMs, // 流式帧节流窗
    inboxDir: cfg.wecom.inboxDir, // 入站图片 / 文件落盘目录(默认 ~/.sbot/wecom-inbox)
    // 「不 @ 也回复」:轮询已绑企微群的历史补入站(零 token),规则门控后才喂模型;群列表现读 engine.cfg(跟随热重载)
    pollSec: cfg.wecom.pollSec, followSec: cfg.wecom.followSec, keywords: () => (engine.cfg.wecom || {}).keywords, // 点名词现读(控制台改了热生效);两档秒数仍启动时读
    pollChats: () => Object.entries(engine.cfg.groups || {}).filter(([id, g]) => g && !g.paused && g.platform === 'wecom' && /^wr/.test(id)).map(([id]) => id),
    gate: wecomGate(),
    onIssue: (ev) => onAlert({ kind: 'platform-issue', platform: 'wecom', ...ev }), // 被挤掉停连 / 工具授权过期 → 运维告警群(文案在 opsalert)
    onConn: (h) => { connWatch.note('wecom', h); if (ui) ui.pushEvent('conn', { platform: 'wecom', ...h }) },
    log,
  })
  // Slack 平台(docs/SLACK.md):Socket Mode 长连接,作为路由器的第三个适配器,与飞书 / 企微互不影响。
  // ⚠ 没有 createStreamingCard ⇒ 引擎自动退回纯文本回复(进度表达是第 2 步)。
  if (plat.slack) adapters.slack = createSlackPlatform({
    botToken: cfg.slack.botToken,
    appToken: cfg.slack.appToken,
    botUserId: cfg.slack.botUserId || '',           // 留空则 start() 时用 auth.test 自取
    onlyWhenMentioned: cfg.slack.onlyWhenMentioned === true,
    replyInThread: cfg.slack.replyInThread !== false, // 缺省挂线程(Slack 的"回复"就是 thread)
    ws: cfg.slack.ws || {},                          // 重连调优(debugReconnects 等),真机可调
    // ⚠ Slack 自己占用 `/` 开头 ⇒ 群内控制面要走替代前缀(`!stop`)或注册的 `/sint` 总入口。
    //   清单从引擎那份单一事实源注入,别在这儿另抄一份(engine.test.js 有漂移守卫)。
    commands: SLASH_COMMANDS,
    commandAlias: cfg.slack.commandAlias || '!',
    umbrellaCommand: cfg.slack.umbrellaCommand || '/sint',
    // 进度刷新节流窗(ms)。⚠ chat.update 是 Tier 3 = 50/min **整个 app 共享、不按频道拆** ——
    // 调小了不是"更流畅"而是"并发一多就集体撞限流"。缺省 20s(每任务 3 次/分)。
    card: cfg.slack.card || {},
    onConn: (h) => { connWatch.note('slack', h); if (ui) ui.pushEvent('conn', { platform: 'slack', ...h }) },
    log,
  })
  // resolve 现读 engine.cfg:热重载后新绑的群 / 补写的 platform 字段立刻生效
  platform = createMultiPlatform({ adapters, resolve: (chatId) => chatPlatform(engine.cfg, chatId), log })

  // 画布自动感知(B3;docs/BOARD.md):**轮询主触发**(真机事实 2026-07-21:updated_v1 事件
  // 不投递到 WS 长连接;事件路径保留仅作飞书修好后的加速通道,两路共享基线天然幂等)。
  // 轮询带静默期门槛(发现新增押后到下一周期指纹不变才播 —— 不打断创作中的用户)+
  // ops journal 自编辑抑制(CLI board 写动作留痕,poll 前重放到基线)。lookup/listBoards
  // 每次现读 engine.cfg ⇒ 自动跟随配置热重载;订阅仍保留(启动补订,幂等)。
  // boardClient 独立于 platform 内部 client(SDK 自管 token)。
  // ⚠ 画布 / 接管卡实体更新是飞书专属:没配飞书时没有 client,相关路径按 null 守卫(群项目没有画布配置时这些路径本来也走不到)
  const boardClient = plat.feishu ? feishuClient(cfg.feishu.appId, cfg.feishu.appSecret) : null
  const boardCfg = (cfg.feishu && cfg.feishu.board) || {}
  // ⚠ 一处算、两处用:boardWatch 拿它决定轮不轮询,自知清单拿它决定「要不要告诉 agent 反馈会
  // 自动播报」。**各算一份必漂移** —— 而漂了的后果是清单对 agent 说假话(轮询关着却写着「会
  // 自动播报」),agent 转头就对群成员说「你改完我会收到」。⚠ 必须取这个**固化值**而不是现读
  // 配置:pollMs 在 daemon 启动时就定死了,热改 pollSec 不重启是不生效的(改配置也别信)。
  // 默认关(飞书 API 月调用量是租户级上限,每个有画布的群每轮约 2 个调用):pollSec 填正数才开,最小 30。
  const boardPollSec = Number(boardCfg.pollSec)
  const boardPollMs = (!boardClient || !(boardPollSec > 0)) ? 0 : Math.max(30, boardPollSec) * 1000
  engine.boardWatchOn = () => boardPollMs > 0
  const boardWatch = createBoardWatch({
    pollMs: boardPollMs, // 0 = 不轮询(默认)
    holdRounds: Number(boardCfg.holdRounds) || 5,
    listNodes: (wb) => listBoardNodes(boardClient, wb),
    listComments: (docToken) => listBoardComments(boardClient, docToken), // 评论第二通道:轮询也拉未解决评论
    previewImage: async (wb, fresh) => boardPreviewImageKey(boardClient, wb, { nodes: await listBoardNodes(boardClient, wb), freshNodes: fresh }), // 播报卡内嵌预览图,聚焦新标注附近(全量 nodes 定映射基准;失败 boardwatch 自降级)
    digest: (nodes) => digestNodes(nodes),
    nodeText: (node) => nodeText(node), // 节点文字指纹(启用「改文字/删除」感知;缺注入则只感知新增)
    lookupGroup: (wb) => {
      for (const [chatId, g] of Object.entries(engine.cfg.groups || {})) {
        if (g && g.board && g.board.whiteboardId === wb) return { chatId, docToken: g.board.docToken, url: g.board.url || null } // docToken 供拉评论;url 供「去画布查看」按钮
      }
      return null
    },
    listBoards: () => Object.values(engine.cfg.groups || {}).filter((g) => g && !g.paused).map((g) => g.board && g.board.whiteboardId).filter(Boolean), // 暂停群不轮询不播报
    readOps: (wb) => readBoardOps(boardOpsDir(), wb),
    notify: (chatId, text) => platform.send(chatId, redact(text)), // 文本 fallback(发卡失败/旧端)
    notifyCard: (chatId, card) => platform.sendCard(chatId, card), // 播报卡(button 确认;标注文本已在构卡时逐条 redact)
    redact,
    botOpenId: (cfg.feishu && cfg.feishu.botOpenId) || null,
    log,
  })

  // 定时任务调度器(定时任务基础技能): 分钟级 ticker 扫每群 crons。到点 → --do 构造合成消息喂
  // engine(复用群路由/权限/流式卡片/并发隔离,群间互不干扰),--say 直接发一条消息(过 redact)。
  // tasks() 每 tick 读 engine.cfg ⇒ 自动跟随配置热重载;dedup 按 (chatId,id) 复合键。
  const cronFire = createCronFire({
    getGroup: (chatId) => engine.cfg.groups && engine.cfg.groups[chatId],
    tz: () => engine.tz,
    handleMessage: (msg) => handle(msg),
    send: (chatId, text) => platform.send(chatId, text),
    redact, log, ledger,
    removeTask: (chatId, id) => removeCronTask(engine.cfg._path, chatId, id, log),
    // 脚本拿到的环境 = daemon 环境 + 与 agent 子进程同一组基础能力变量(SBOT_CHAT_ID / TZ / SBOT_CONFIG / SBOT_UI_URL)
    env: (task) => ({ ...process.env, ...engine.baseSkillEnv(task.chatId) }),
  })
  const scheduler = createScheduler({
    tasks: () => collectCrons(engine.cfg),
    tz: () => engine.tz,
    log,
    // 到点做什么在 src/core/cronfire.js(可单测);这里只注入依赖。
    fire: cronFire,
  })

  // 预览服务收割器(群预览服务;docs/PREVIEW.md):socket 在 detached worker,**生命周期策略在这里**
  // —— 闲置/超龄/群暂停/群解绑该收的收,并代 worker 发那条「预览已停止」群通知(worker 不带飞书
  // SDK)。这是本技能存在的理由:v0.8.2 之前「记得关」全靠 agent 跨轮记忆,那台机器上有个 agent
  // 私装的静态服务挂了一周没人发现。groupState 每 tick 现读 engine.cfg ⇒ 自动跟随配置热重载。
  const previewReaper = preview.createPreviewReaper({
    dir: preview.previewDir(),
    groupState: (chatId) => {
      const g = engine.cfg.groups && engine.cfg.groups[chatId]
      if (!g) return { bound: false, paused: false }
      // 回收策略也现读(v0.9.3):operator 在控制台勾「常驻」是改配置,而 idleMs/maxMs 是
      // start 那一刻快照进记录的 —— 不在这儿把配置带出来,勾了也只对**下一个**预览生效
      // (真机 2026-07-31 踩到:群里收到「已设为常驻」,服务照样闲置 30 分钟后停了)。
      const o = preview.normalizeOptions(engine.cfg.preview, g.preview)
      return { bound: true, paused: !!g.paused, idleMs: o.idleMs, maxMs: o.maxMs }
    },
    kill: killPreviewPid,
    notify: (chatId, text) => platform.send(chatId, redact(text)),
    log,
  })

  // Graceful shutdown (FR10.3): on SIGTERM/SIGINT, abort in-flight turns (kills
  // their child claude) and exit cleanly so a supervisor restart leaves no orphans.
  let stopping = false
  const shutdown = async (sig) => {
    if (stopping) return
    stopping = true
    // 被打断的请求记账(见 src/core/pending.js 头注):⚠ 必须在 engine.shutdown() **之前**取
    // —— abort 触发的 release() 会清掉快照。这条路只有优雅关停走得到,所以「重启后自动续做」
    // 天然只对 operator 亲手敲的 kickstart 生效,崩溃自愈不会自己开工。
    try {
      const interrupted = engine.interruptedTurns()
      const n2 = interrupted.length ? writePending(pendingFile(path.join(os.homedir(), '.sbot')), interrupted, log) : 0
      if (n2) process.stderr.write(gray(`\n记下 ${n2} 笔被打断的请求,重启后重做`) + '\n')
    } catch (e) { log('被打断的请求记账失败: ' + (e && e.message)) }
    const n = engine.shutdown()
    try { scheduler.stop() } catch {}
    // 在跑的定时脚本一并杀掉(整棵进程组):daemon 退了它们就成孤儿,父端管道一关下次写 stdout 就死、无人报。
    try { const ns = cronFire.abortAll(); if (ns) process.stderr.write(gray(`\n杀掉 ${ns} 条在跑的定时脚本`) + '\n') } catch {}
    try { boardWatch.stopPoll() } catch {}
    // ⚠ 只停收割器,**不动运行中的预览** —— 它们是跨轮资产,而 daemon 每次发版都会被 kickstart
    // 重启;关停就杀等于「跨轮存活」名存实亡(这正是不把 socket 放进 daemon 的理由之一)。
    try { previewReaper.stop() } catch {}
    try { connWatch.stop() } catch {} // 关停不是故障:撤掉平台中断的宽限定时器,免得 stop 过程中到点误报
    process.stderr.write(gray(`\n${sig} — shutting down (aborted ${n} in-flight turn(s))`) + '\n')
    Promise.resolve(platform.stop && platform.stop()).catch(() => {})
    if (ui) { try { ui.close() } catch {} }
    // Wait for aborted children to be reaped before exiting: the SIGTERM→SIGKILL
    // grace is ~10s, and exiting earlier would orphan a SIGTERM-ignoring child.
    if (n > 0) {
      const clean = await engine.drain(12_000)
      if (!clean) process.stderr.write(gray('warning: some turns did not exit within the grace window') + '\n')
    }
    try { store.flush() } catch {} // persist any debounced watermark before exit
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  process.stderr.write(dim(`sintbot start — ${platform.names().join('+')} daemon (${probe.version}), ${groupCount} group(s) bound, state=${statePath}, log times in ${logTz} (now ${fmtStamp(Date.now(), logTz)})`) + '\n')
  // onRecall(撤回即停): 排队中剔除 / 运行中如 /stop(卡片收尾注明撤回,无卡片则全程静默)。
  // onBoardUpdated(画布自动感知): 事件进 boardwatch 去抖,core 无感。
  // onReaction(点表情即触发): 表情落在某画布的最新播报消息上 = 用户确认
  // 处理标注 → 合成消息喂 engine(复用群路由/锁/权限/卡片全套管线,cron --do 同款);
  // takeNotice 消费即清 ⇒ 多人点/重复点只触发一次;paused 群由 engine 入口自然拦截。
  // 画布确认改图的共用工单(表情 onReaction / 按钮 onCardAction 共享):合成消息喂 engine ——
  // 复用群路由/锁/权限/流式卡片全套管线(cron --do 同款)。触发消息自带本轮标注清单(播报时记的
  // digest)⇒ agent 只处理清单内标注、旧标注不碰;处理完保留标注(2026-07-22 拍板不删)。
  const fireBoardApply = (hit, operatorId, via, noticeMsgId) => {
    // v0.7.4 分流:sync = 用户直接改/删了画布内容(画板已是终态)⇒ 只把改动同步回源码、不重渲不新增版本;
    // apply = 有新标注/评论 ⇒ 按反馈产出新版(原按标注改闭环)。两者 msgId 都 boardgo: 前缀,共用单卡回填/兜底。
    const sync = hit.kind === 'sync'
    log(`画布播报被${via}确认 → ${sync ? '触发源码同步(不重渲)' : '触发按标注改'}: ${hit.chatId}`)
    const now = Date.now()
    // 这张播报卡的实体 cardId 入队(FIFO;+画板 url + kind 供轮次收尾兜底用)⇒ agent `board-add-image
    // --deliver` 出队后用 cardkit card.update 把结果回填进它(单卡:处理中→结果卡)。实体卡更新只认
    // card_id;表情 fallback 落在文本播报上时无 cardId,--deliver 会新发结果卡兜底。队列化 ⇒ 多轮
    // 连续确认各回填各的卡(群锁线性,交付顺序=触发顺序),不串卡。sync 轮 agent 不 --deliver ⇒ 恒靠兜底收尾。
    if (noticeMsgId) {
      const gb = engine.cfg.groups && engine.cfg.groups[hit.chatId] && engine.cfg.groups[hit.chatId].board
      // goId = 本轮触发的合成消息 msgId(与下面 handleMessage 同款),done 兜底按它精确摘卡(审查 M2)
      try { pushNotice(boardNoticeDir(), hit.chatId, { msgId: noticeMsgId, cardId: hit.cardId || null, url: (gb && gb.url) || null, kind: hit.kind || 'apply', goId: `boardgo:${hit.chatId}:${now}` }) } catch (e) { log('board notice 记录: ' + (e && e.message)) }
    }
    const lines = (hit.digestLines && hit.digestLines.length) ? `${sync ? '本轮改动清单' : '本轮标注清单'}:\n` + hit.digestLines.join('\n') + '\n' : ''
    // sync:用户在画板上直接改/删了内容 —— 唯一任务是把改动收敛回源文件,严禁重渲/出新版/上板(画板已是终态,再渲一版纯冗余)。
    const syncText = `用户在画布上直接修改/删除了内容(${via}确认)。${lines}画布上已经是改后的样子。你的任务**只有一件**:把这些改动同步回对应源文件 —— 图表节点文字被改 ⇒ 找到并更新 design/diagrams/ 里对应的 .mmd 源码(只改文字对齐,别动结构);[已删除] 行 ⇒ 从对应源码里移除该内容。**禁止重渲染、禁止生成新版本、禁止上板任何新内容、不要用 --deliver**(画板已是终态,再渲一版是冗余撑爆画布);动手前先 board-nodes 拉一次核对当前内容;找不到对应源文件就只在群里说明这些改动、不要凭空创造。完成后在群里**一句话**复述你把哪些改动同步进了哪个源文件。`
    // apply:有新标注/评论 —— 原按标注改闭环。⚠ 明确要求标注+评论一起处理(评论无独立播报,靠这里提醒现拉);
    // 逐行语义分叉:(原文字:…) 若改的是图表/图片内容本身=用户已改好只同步源码不再出新版,若改的是标注便签/箭头文字=改意见措辞按新文字执行。
    const applyText = `用户确认处理画布反馈(${via})。${lines}动手前先 board-nodes 和 board-comments 各拉一次 —— 上面清单是本轮标注,评论要现拉(可能有新评论,别只看标注);清单里 (原文字:…) 行=用户改了该节点文字:**若改的是图表/图片内容本身(图表里的图形、图上文字)= 用户已经改好了,只把改动同步回 .mmd 等源码、不要再为它出新版重渲;若改的是标注便签/箭头上的文字 = 用户在修改「意见」的措辞,按新文字理解意图去执行**;[已删除] 行=用户删了内容,一般只需知悉、不要恢复;标注和评论一起处理:按标注/评论改对应内容 —— 落在图片上就 board-add-image --beside <原图节点id> --deliver 出新图放原图右侧,落在图表图形上就改对应 .mmd 源码后 board-add-diagram --beside <该图形节点id> --deliver 重渲一版(别把图表改动做成图片;用户若直接改过图表文字则先合并回 .mmd,且这部分已改好不用再出新版),每处理完一条评论 board-resolve-comment 标记已解决;处理完保留标注不要删除,在群里**用列表逐条复述**你对每条标注与评论的理解与处理(每条一行,别堆成一大段)`
    handle({ chatId: hit.chatId, userId: operatorId || 'board', senderName: sync ? '画布同步' : '画布确认', synthetic: true, text: sync ? syncText : applyText, msgId: `boardgo:${hit.chatId}:${now}`, createTimeMs: now, replyCtx: { chatId: hit.chatId } })
  }
  // 群是否已暂停(paused 群 engine.handleMessage 会静默丢弃 —— 确认入口必须先拒,否则用户看到
  // 「已开工」实际啥也没发生;拒绝时不消费锚点,恢复后再点仍有效)。
  const groupPaused = (chatId) => { const g = engine.cfg.groups && engine.cfg.groups[chatId]; return !!(g && g.paused) }
  // 表情确认(2026-07-22 换按钮后暂留作 fallback,至真机验证按钮回调通再摘)。
  const onReaction = (r) => {
    if (!r || !r.msgId) return
    if (r.operatorId && cfg.feishu && cfg.feishu.botOpenId && r.operatorId === cfg.feishu.botOpenId) return // bot 自身
    const probe = boardWatch.takeNotice(r.msgId, { peek: true })
    if (!probe) return // 不是画布播报消息(别的消息被点表情,不相干)
    if (groupPaused(probe.chatId)) { log(`画布确认被拒(群已暂停): ${probe.chatId}`); return } // 表情无 toast 通道,静默不消费
    const hit = boardWatch.takeNotice(r.msgId)
    if (!hit) return
    fireBoardApply(hit, r.operatorId, `表情 ${r.emoji || '?'}`, r.msgId)
    // 表情没有 3s 响应通道 —— 主动把播报卡翻成「处理中/同步中」(与按钮路径同态;fire-and-forget,失败无害)
    if (hit.cardId && boardClient) updateCardEntity(boardClient, hit.cardId, boardWatch.buildAckCard(hit.digestLines, hit.kind)).catch(() => {})
  }
  // 播报卡按钮回调(2026-07-22 主路;card.action.trigger → WS → 这里 → 返回 {toast,card} 作 3s 响应)。
  // 先解析 value 再按 val.a 分发;返回 undefined ⇒ 卡片保持不变。
  //   boardgo   = 「按标注改图」:takeNotice 命中 → 触发按标注改 + 播报卡改「处理中」去按钮防重复点。
  //   boardskip = 「忽略」(v0.7.1):消费锚点(防日后误点老卡的 👍 触发整轮 agent)+ 翻成「已忽略」灰卡;
  //               不做暂停门(忽略在暂停群也应生效)、不 fireBoardApply、不喂 engine。
  const onCardAction = (evt) => {
    let val = evt && evt.action && evt.action.value
    if (typeof val === 'string') { try { val = JSON.parse(val) } catch { val = null } } // 个别端把 value 下发成 JSON 字符串(防御)
    const action = val && (val.a || val.action)
    if (action === 'boardgo') {
      const probe = boardWatch.takeNotice(evt.messageId, { peek: true })
      if (!probe) return { toast: { type: 'info', content: '这批反馈已在处理或已过期' } } // 重复点/已消费
      if (groupPaused(probe.chatId)) return { toast: { type: 'warning', content: '⏸ 本群项目已暂停 — 恢复后再点即可' } } // 不消费,按钮保留
      const hit = boardWatch.takeNotice(evt.messageId)
      if (!hit) return { toast: { type: 'info', content: '这批反馈已在处理或已过期' } }
      fireBoardApply(hit, evt.operator && evt.operator.openId, '按钮', evt.messageId)
      const sync = hit.kind === 'sync'
      return { toast: { type: 'success', content: sync ? '开始同步 🔄 正在把改动同步回源码…' : '已开工 🖌 正在处理画布反馈…' }, card: { type: 'raw', data: boardWatch.buildAckCard(hit.digestLines, hit.kind) } }
    }
    if (action === 'boardskip') {
      const probe = boardWatch.takeNotice(evt.messageId, { peek: true })
      if (!probe) return { toast: { type: 'info', content: '这批反馈已在处理或已过期' } } // 措辞与 boardgo 分支一致
      boardWatch.takeNotice(evt.messageId) // 消费锚点(消歧 + 防误触)
      return { toast: { type: 'info', content: '已忽略 🙈 可随时在群里说需求' }, card: { type: 'raw', data: boardWatch.buildSkippedCard() } }
    }
    return // 不是画布播报按钮,忽略
  }
  // 入站消息带着它自己的适配器进引擎(清单按适配器分流);hooks 各适配器只认自己懂的那几个
  await platform.start((msg, adapter) => handle(msg, adapter), {
    onRecall: (r) => engine.handleRecall(r), onBoardUpdated: (e) => boardWatch.onEvent(e), onReaction, onCardAction,
    byPlatform: {
      // Slack 原生 Stop 按钮:用户点了 → Slack 发 agent_session_stopped → 停这一轮。
      // ⚠ 官方明文「点了 Stop 状态不会自己变,转成 active 是 app 的责任」—— 那一步在
      //   适配器的卡片收尾里做(finish/recall 都会转),这里只管把轮次真停掉。
      slack: { onAgentStop: (e) => { log(`slack 用户点了 Stop: chat=${e.chatId}`); try { engine.stop(e.chatId) } catch (err) { log('slack stop 失败: ' + (err && err.message)) } } },
    },
  })
  scheduler.start() // 定时任务从下一分钟边界起生效
  // 预览收割器:立刻跑一轮(daemon 重启期间 worker 可能已自尽、通知还挂着 notifyPending 等人代发,
  // 或有孤儿记录要清),之后按 tick 周期巡检
  previewReaper.tick()
  previewReaper.start()
  // 画布事件订阅 + diff 基线(fire-and-forget;单画布失败只记日志不影响启动)。开机时网络常常还没就绪:
  // 订阅遇到网络类错误按退避间隔重试(基线的重试在 boardWatch.prime 里);其它错误(重复订阅 / 没权限)只记日志。
  const BOARD_SUB_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000]
  const isNetErr = (e) => !!e && (/^(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH)$/.test(e.code || '') || /getaddrinfo|socket hang up/i.test(e.message || ''))
  const subscribeWithRetry = (gcid, wb, attempt = 0) => subscribeBoard(boardClient, wb).catch((e) => {
    const delay = isNetErr(e) ? BOARD_SUB_RETRY_MS[attempt] : 0
    log(`画布订阅(${gcid}): ` + larkErrMsg(e) + (delay ? ` · ${delay / 1000}s 后重试` : ''))
    if (delay) setTimeout(() => subscribeWithRetry(gcid, wb, attempt + 1), delay).unref()
  })
  for (const [gcid, g] of Object.entries(cfg.groups || {})) {
    const wb = g && g.board && g.board.whiteboardId
    if (!wb || !boardClient) continue
    subscribeWithRetry(gcid, wb)
    boardWatch.prime(wb)
  }
  boardWatch.startPoll() // 轮询主触发(事件不投递的兜底;pollSec 不填 / 0 = 不起)
  // 版本升级群播报:对比 state 记录的上个版本,升级了就向各绑定群发一条更新摘要
  // (文案取 CHANGELOG.json,与控制台「版本历史」同源;首次运行/降级只记录不播报)。
  // 放在 platform.start 之后;fire-and-forget,单群失败只记日志不影响启动。
  try {
    const cur = require('../package.json').version
    if (store.getLastVersion() !== cur) {
      let changelog = []
      try { changelog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.json'), 'utf8')) } catch {}
      // 产品名走顶层 `brand` 配置(不写 = SintBot):不同部署可以给群里的机器人起不同的名字。
      const notice = require('../src/upgrade').buildUpgradeNotice(store.getLastVersion(), cur, changelog, cfg.brand)
      if (notice) for (const [chatId, g] of Object.entries(cfg.groups || {})) {
        if (g && g.paused) continue // 暂停 = 别打扰,升级播报也不发
        Promise.resolve(platform.send(chatId, notice)).then((r) => { if (r === null) log(`升级播报未送达(${chatId}):平台确认没发出去`) }).catch((e) => log(`升级播报(${chatId}): ` + (e && e.message)))
      }
      store.setLastVersion(cur)
    }
  } catch (e) { log('升级播报: ' + (e && e.message)) }
  // 续做上次被打断的请求(见 src/core/pending.js 头注)。放在升级播报之后 —— 群里读起来
  // 是「已升级 → 继续上次那件事」。先发一句告知再重投:不等确认(那要一整套回复匹配状态
  // 机),反悔用现成的 /stop。读取即消费 ⇒ 每笔只续一次;超时的只记日志不重投。
  try {
    const { due, expired } = resumable(takePending(pendingFile(path.join(os.homedir(), '.sbot')), log), { now: Date.now() })
    for (const r of expired) log(`被打断的请求已超时,不重做(${r.chatId}): ${redact(r.text.slice(0, 40))}`)
    for (const rec of due) {
      const g = cfg.groups && cfg.groups[rec.chatId]
      if (!g || g.paused) { log(`被打断的请求跳过 —— 群未绑定或已暂停(${rec.chatId})`); continue }
      const now = Date.now()
      // ⚠ 告知里引用了原话 ⇒ 必须过 redact(与群内其它出站文本同一条纪律);PII 档
      // 跟随该群设置(数据群 redactPii:false 时原样,与 engine 的群面口径一致)。
      // ⚠ 告知**只是尽力**:发失败也照样重做(链在 catch 之后 ⇒ 顺序仍是先告知后开工)。
      // 反过来做就是拿一条装饰性消息当闸门 —— 它一失败,本要救回来的请求就又丢了,
      // 而丢请求正是这条机制存在的理由。
      Promise.resolve(platform.send(rec.chatId, redact(resumeNotice(rec), { pii: g.redactPii !== false })))
        .catch((e) => log(`续做告知发送失败(${rec.chatId}): ` + (e && e.message)))
        .then(() => handle({ chatId: rec.chatId, userId: 'resume', senderName: rec.sender || '群成员', synthetic: true, text: resumePrompt(rec), msgId: `resume:${rec.chatId}:${rec.ts}`, createTimeMs: now, replyCtx: { chatId: rec.chatId } }))
        .catch((e) => log(`重做失败(${rec.chatId}): ` + (e && e.message)))
    }
  } catch (e) { log('续做被打断的请求: ' + (e && e.message)) }
  process.stderr.write(dim(`listening for ${platform.names().map((n) => ({ feishu: 'Feishu', wecom: 'WeCom', slack: 'Slack' })[n] || n).join(' + ')} messages… (SIGTERM/Ctrl-C to stop)`) + '\n')
  // WSClient keeps the event loop alive.
}

// Render the shared health check to the terminal (data comes from src/health.js,
// so `doctor` and the console stay in sync). Returns counts; never exits.
async function runDoctor(cfg, { summary = true } = {}) {
  const { rows, fails, warns } = await checkHealth(cfg)
  const mark = { ok: cyan('✓'), warn: '\x1b[33m!\x1b[0m', fail: red('✗') }
  for (const r of rows) process.stdout.write(`${mark[r.status]} ${r.label.padEnd(22)} ${gray(r.detail)}\n`)
  if (summary) process.stdout.write(dim(`\n${fails} 失败 · ${warns} 警告\n`))
  return { fails, warns }
}

// Feishu app precheck for `doctor` / `setup` — bot identity + scope probes. These are
// network calls, so kept OUT of the shared checkHealth(控制台**不**调 checkHealth,它自己在 buildState 里算一套更短的健康行;doctor 行只上 operator 终端); they
// run only on the explicit doctor/setup path. Shares feishuPrecheck with the console
// (same ✓/✗ rows). No-op unless plaintext creds are present.
// 分两步:runFeishuPrecheck 先跑(结果记进凭据验证记录,体检里的「feishu」行就是这次的结论),
// printFeishuPrecheck 在体检行之后列明细。失败数并进 doctor 的汇总;「bot 身份」那项已由 feishu 行计过,不重复算。
async function runFeishuPrecheck(cfg) {
  const fe = cfg.feishu
  if (!fe || !fe.appId || !fe.appSecret || String(fe.appId).startsWith('env:') || String(fe.appSecret).startsWith('env:')) return null
  try {
    const r = await feishuPrecheck(feishuClient(fe.appId, fe.appSecret), { appId: fe.appId })
    verify.recordPrecheck('feishu', fe, r.checks)
    return { checks: r.checks }
  } catch (e) { return { error: (e && e.message) || String(e) } }
}
function printFeishuPrecheck(pre) {
  if (!pre) return { fails: 0, warns: 0 }
  process.stdout.write('\n' + cyan('飞书应用预检') + dim(' — 用配置里的凭据调一次飞书接口(不建长连接),核对 bot 身份 / 权限') + '\n')
  if (pre.error) { process.stdout.write(red('✗ ') + '预检失败: ' + gray(pre.error) + '\n'); return { fails: 1, warns: 0 } }
  const mark = { ok: cyan('✓'), warn: '\x1b[33m!\x1b[0m', fail: red('✗'), skip: gray('○') }
  for (const c of pre.checks) process.stdout.write(`${mark[c.status] || '?'} ${c.label.padEnd(30)} ${gray((c.detail || '').slice(0, 90))}\n`)
  const rest = pre.checks.filter((c) => c.key !== 'bot')
  return { fails: rest.filter((c) => c.status === 'fail').length, warns: rest.filter((c) => c.status === 'warn').length }
}

// setup helper — resolve an admin from ou_ openId / email / mobile and add it.
async function setupResolveAdmin(cli, q, addOne) {
  if (q.startsWith('ou_')) { addOne(q, q); return }
  try {
    const r = await resolveContactToOpenId(cli, q)
    if (r.openId) addOne(r.openId, q)
    else process.stdout.write(red('  未查到该邮箱/手机号(需 contact:user.id:readonly)') + '\n')
  } catch (e) { process.stdout.write(red('  查询失败: ' + ((e && e.message) || e)) + '\n') }
}

// `sbot doctor` — health check before/while running the daemon (FR10.5).
async function cmdDoctor(rest) {
  const { values } = parseArgs({ args: rest, allowPositionals: true, options: { config: { type: 'string' }, 'kill-leftovers': { type: 'boolean' } } })
  let cfg
  try { cfg = loadConfig(values.config) } catch (e) { return die(e.message) }
  const pre = await runFeishuPrecheck(cfg)
  const h = await runDoctor(cfg, { summary: false })
  const p = printFeishuPrecheck(pre)
  const fails = h.fails + p.fails
  process.stdout.write(dim(`\n${fails} 失败 · ${h.warns + p.warns} 警告${pre ? '(含飞书预检)' : ''}\n`))
  printPreviewStatus()
  await printLeftovers(!!values['kill-leftovers'])
  if (fails) process.exit(1)
}

// doctor 尾巴(二):遗留进程(src/leftover.js)—— agent 轮次结束后仍在跑的后台 shell。健康行只给一句
// 汇总,这里逐条列(pid / 存活 / 它在跑什么),`--kill-leftovers` 时当场结束并复查。
// ⚠ 不加旗子只列不杀:偶尔是 agent 故意留的(起了个 dev server 在看),杀不杀是人的判断。
async function printLeftovers(doKill) {
  const leftover = require('../src/leftover')
  let r
  try { r = await leftover.list() } catch { return }
  if (!r.supported || !r.rows.length) { if (doKill && r.supported) process.stdout.write(dim('\n遗留进程:无,没什么可结束的\n')); return }
  process.stdout.write('\n' + cyan('遗留进程') + dim(`  (${r.rows.length} 个后台 shell 在 agent 轮次结束后仍在跑 · 判据:父进程已退 + 存活 ≥ 1 小时)`) + '\n')
  for (const x of r.rows) process.stdout.write(`  ${yellow('⚠')} pid ${String(x.pid).padEnd(6)} ${x.age.padEnd(6)} ${dim(x.summary)}\n`)
  if (!doKill) { process.stdout.write(dim('  结束:sintbot doctor --kill-leftovers(或控制台「概览 → 后台进程」)\n')); return }
  const res = await leftover.kill(r.rows.map((x) => x.pid))
  leftover.clearCache()
  const again = await leftover.list()
  const left = again.rows.filter((x) => r.rows.some((y) => y.pid === x.pid))
  process.stdout.write(`  已发结束信号 ${res.killed.length} 个` + (res.skipped.length ? dim(`,跳过 ${res.skipped.length} 个(动手前复核已不是遗留进程:${res.skipped.join(' ')})`) : '') + (res.failed.length ? red(`,失败 ${res.failed.length} 个(${res.failed.map((f) => `pid ${f.pid}: ${f.error}`).join('; ')})`) : '') + (left.length ? yellow(`;复查仍在:${left.map((x) => x.pid).join(' ')}`) : dim(';复查已不在')) + '\n')
}

// doctor 尾巴:运行中的群预览服务(`sbot preview`)。它们是**在局域网上开着端口**的东西 ——
// 属于运维事实,doctor 必须如实报(那个挂了一周的 agent 私装服务,正是因为没有任何地方看得见)。
// 纯读 ~/.sbot/preview/ 记录,不探网不 spawn;一个都没有就一行都不占。
function printPreviewStatus() {
  let live = []
  // 只列 running(starting 尚未绑定端口,报 URL 会是假的);卡住的 starting 归 reaper 的 60s 宽限
  try { live = preview.listRecords(preview.previewDir()).filter((r) => r.status === 'running' && preview.isLive(r)) } catch { return }
  if (!live.length) return
  process.stdout.write('\n' + cyan('预览服务') + dim(`  (sbot preview · ${live.length} 个运行中)`) + '\n')
  for (const r of live) {
    process.stdout.write(`  ${r.projectRoot ? yellow('⚠') : '·'} :${r.port}  ${r.label || r.entry}  ${dim(preview.displayServed(r))}${r.single ? dim('(单文件)') : dim('/(整个目录)')}  ${dim(previewUrl(r))}\n`)
    if (!r.idleMs && !r.maxMs) process.stdout.write(dim('      ⚠ 常驻:不会自动停 —— 用完请 sbot preview stop\n'))
    if (r.projectRoot) process.stdout.write(dim('      ⚠ 正在服务整个项目目录 —— 全部代码在局域网可读;考虑 sbot preview stop 后改服务子目录\n'))
  }
  process.stdout.write(dim('  停止:sbot preview stop --all(或控制台「概览 → 预览服务」)\n'))
}

// `sbot service` — 常驻服务(src/service.js 生成单元文件;这里只做参数、输出与人话)。
async function cmdService(rest) {
  const svc = require('../src/service')
  const action = rest[0] && !rest[0].startsWith('-') ? rest[0] : 'status'
  const { values } = parseArgs({ args: rest.slice(action === rest[0] ? 1 : 0), allowPositionals: true, options: { config: { type: 'string' }, 'ui-host': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'pass-env': { type: 'boolean' }, check: { type: 'boolean' }, n: { type: 'string' } } })
  const platform = process.platform
  const home = os.homedir()
  const nice = (st) => st.running ? cyan(tr('● 运行中', '● running')) + (st.pid ? dim(` pid ${st.pid}`) : '') : st.loaded ? yellow(tr(`○ 已加载、未在运行(${st.state || '?'})`, `○ loaded, not running (${st.state || '?'})`)) : st.installed ? yellow(tr('○ 已安装、未加载', '○ installed, not loaded')) : gray(tr('○ 未安装', '○ not installed'))
  if (action === 'install') {
    const configPath = findConfigPath(values.config)
    if (!configPath) return die('没找到配置文件 —— 先跑 sintbot setup(或 --config 指定)')
    // 控制台对外又没设密码:daemon 一启动就会拒绝退出,装成服务就是每 15 秒拉起一次的死循环 ⇒ 装之前就拦
    let raw
    try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch (e) { return die(`读不了配置 ${configPath}:${e.message}`) }
    const uiHost = values['ui-host'] || ((raw.ui || {}).host)
    if (uiHost && !isLoopbackHost(uiHost) && !((raw.ui || {}).auth)) return die(`控制台对外(--ui-host ${uiHost})要先设密码:sintbot ui --set-password${values.config ? ' --config ' + values.config : ''} —— 否则服务一启动就退出、被反复拉起`)
    // 一个聊天平台都没接也照装(1.0.12 起):服务先只开控制台,在「设置」里接好平台后自己重启连上(cmdStart 的配置模式)。
    // 1.0.10–1.0.11 在这里拦下(退出码 3),结果装完没有任何地方可去 —— 控制台也打不开
    const plat = platformsConfigured(loadConfig(configPath))
    const noPlatform = !plat.feishu && !plat.wecom && !plat.slack
    // 服务进程拿不到当前 shell 的环境变量:配置里 env: 引用的 key、配置没写代理时 shell 里的代理变量,值直接写进单元文件(600)。
    // 1.0.10–1.0.12 先问一句;用户 10-28 定「安装过程要精简」⇒ 不问也不说(不带进去,服务里这些模型 / 平台、连 Claude / ChatGPT 都用不了)。
    // --pass-env 仍认(以前要它才写),现在是默认行为
    const refs = svc.envRefs(raw)
    const inShell = refs.filter((v) => process.env[v])
    const nowhere = refs.filter((v) => !process.env[v])
    const shellProxy = PROXY_ENV_KEYS.filter((k) => process.env[k])
    const proxyVars = (raw.proxy && raw.proxy.http) || !shellProxy.some((k) => !/^no_proxy$/i.test(k)) ? [] : shellProxy // 只有 NO_PROXY 不算有代理
    const carry = [...inShell, ...proxyVars]
    const env = Object.fromEntries(carry.map((v) => [v, process.env[v]]))
    const quiet = process.env.SINTBOT_INSTALLER === '1' // install.sh 调起:只报结果一行,细节留给 sintbot service status
    const tools = ['claude', 'codex'].map((n) => whichSync(n)).filter(Boolean)
    const node = svc.stableNodeBin({ execPath: process.execPath, candidates: [whichSync('node')] })
    const sbotBin = path.resolve(__dirname, 'sbot.js')
    const spec = svc.serviceSpec({
      nodeBin: node.bin,
      sbotBin,
      configPath: path.resolve(configPath),
      uiHost,
      home,
      pathEnv: svc.buildPath([path.dirname(node.bin), ...tools.map((t) => path.dirname(t))], process.env.PATH, path.delimiter),
      env,
    })
    if (node.warn) process.stderr.write(yellow('⚠ ' + node.warn) + '\n')
    if (svc.versionedPath(sbotBin)) process.stderr.write(yellow(`⚠ sbot 装在带版本号的 node 目录下(${sbotBin}),换 node 版本后要重装 sintbot 并重跑 sintbot service install`) + '\n')
    if (noPlatform && !quiet) process.stderr.write(dim(tr('  还没接聊天平台:服务先只开控制台,在「设置」里接好平台后会自动重启并连上', 'No chat platform yet: the service starts with just the console; once you connect one under Settings it restarts itself and connects')) + '\n')
    if (nowhere.length) process.stderr.write(yellow(`⚠ 配置引用的环境变量 ${nowhere.join(' ')} 当前终端里也没有 —— 用到它们的模型 / 平台不会工作`) + '\n')
    if (platform !== 'darwin' && platform !== 'linux') { process.stdout.write(svc.windowsHint(spec) + '\n'); return }
    if (!tools.length) process.stderr.write(yellow('⚠ PATH 里没找到 claude / codex —— 服务能起,但群里的轮次会失败;装好后重跑 sintbot service install') + '\n')
    if (values['dry-run']) { // 打印时遮掉带进服务的值(多半是 key)
      const shown = { ...spec, env: Object.fromEntries(Object.keys(spec.env).map((k) => [k, '<已隐藏>'])) }
      process.stdout.write(dim(`# ${svc.unitPath(platform, home)}`) + '\n' + svc.render(platform, shown)); return
    }
    const r = svc.install(spec, { platform, home })
    if (quiet) { // 安装脚本里:成功只一行;失败照常把每一步列出来
      await new Promise((res) => setTimeout(res, 1500))
      const st = svc.status({ platform, home })
      if (st.running && r.steps.every((s) => s.ok)) { process.stderr.write(`  ${cyan('✓')} ${tr('后台服务已启动', 'Background service started')}\n`); return }
    }
    process.stderr.write(cyan('✓ ') + tr(`已写入 ${r.file}`, `Wrote ${r.file}`) + (r.backup ? dim(tr(`(原文件备份为 ${path.basename(r.backup)})`, ` (previous file backed up as ${path.basename(r.backup)})`)) : '') + '\n')
    for (const s of r.steps) process.stderr.write(`${s.ok ? cyan('✓') : red('✗')} ${dim(s.cmd)}${s.err && !s.ok ? '  ' + red(s.err.split('\n')[0]) : ''}\n`)
    if (!quiet) await new Promise((res) => setTimeout(res, 1500))
    process.stderr.write(`${tr('状态', 'Status')}:${nice(svc.status({ platform, home }))}\n` + dim(`${tr('配置', 'Config')}:${spec.args[spec.args.indexOf('--config') + 1]}\n${tr('日志', 'Log')}:${spec.errLog}\n`))
    if (platform === 'linux') process.stderr.write(dim('提示:要开机就起(不必先登录),跑一次 loginctl enable-linger $USER') + '\n')
    if (r.steps.some((s) => !s.ok)) process.exit(1)
    return
  }
  // --check:只给退出码(0 在运行 / 3 装了但没在跑 / 4 没装或这个平台没有自动服务),install.sh 据此决定问不问装服务、要不要重启。
  // 不用 1、2:1.0.11 及以前不认 --check,报错退出就是 1,install.sh 得能把「不知道」和「没在跑」分开
  if (action === 'status' && values.check) { const st = svc.status({ platform, home }); process.exit(st.running ? 0 : st.installed || st.loaded ? 3 : 4) }
  if (action === 'status') { const st = svc.status({ platform, home }); process.stdout.write(`${nice(st)}\n` + dim(st.file ? `单元文件:${st.file}${st.installed ? '' : '(不存在)'}\n` : '这个平台没有自动服务(见 sintbot service --help)\n')); return }
  if (action === 'restart') { const r = svc.restart({ platform }); if (!r.ok) return die('重启失败:' + (r.err || '?')); process.stderr.write(cyan('✓ ') + '已重启\n'); return }
  if (action === 'uninstall') { const r = svc.uninstall({ platform, home }); process.stderr.write((r.removed ? cyan('✓ ') + `已停止并删除 ${r.file}` : dim('没有已安装的服务')) + '\n' + dim('日志与配置都保留在 ~/.sbot/') + '\n'); return }
  if (action === 'logs') {
    const n = Math.max(1, Number(values.n) || 50)
    const file = path.join(home, '.sbot', 'logs', 'err.log')
    if (!fs.existsSync(file)) return die(`还没有日志:${file}`)
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    process.stdout.write(lines.slice(-n - 1).join('\n') + '\n' + dim(`(${file} 末尾 ${n} 行;实时看:tail -f ${file})`) + '\n')
    return
  }
  die(`unknown service action '${action}' (try: sintbot service --help)`)
}

// `sbot setup` — interactive first-run wizard. Seeds sbot.config.json from the
// example, collects provider keys (visible + length-confirmed, stored directly
// in the gitignored config), an optional proxy split, and optional Feishu /
// group binding (with id auto-fetch) — then runs doctor. Shares helpers with the
// console (deriveNoProxy / feishu*), so CLI and UI stay in sync.
// 向导走一遍最多问二十来个问题;输入结束后还要问到这么多次,只能是某个循环拿默认值走不出去
const SETUP_MAX_ASKS_AFTER_EOF = 60

async function cmdSetup(rest) {
  const { values } = parseArgs({ args: rest, allowPositionals: true, options: { config: { type: 'string' }, full: { type: 'boolean' } } })
  const cfgPath = defaultConfigPath(values.config)
  const examplePath = path.join(__dirname, '..', 'sbot.config.example.json')
  // 1.0.12 起默认只问环境和模型(用户 10-28 定:是否在中国大陆、代理、项目根目录、聊天平台凭据都不在终端里要,装完在控制台配)。
  // --full = 旧的完整问答(平台凭据 / 代理 / 项目根目录 / 绑群),给没有浏览器的服务器用;那部分只有中文。
  const full = !!values.full
  const T = (zh, en) => tr(zh, en) // 中文 / 英文按 src/clilang.js
  const lang = tr('zh', 'en')
  const fromInstaller = process.env.SINTBOT_INSTALLER === '1' // install.sh 调起:不重复报 Node、不打自己的「下一步」

  let raw
  let seeded = false
  if (fs.existsSync(cfgPath)) {
    try { raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch (e) { return die(`existing config is invalid JSON: ${e.message}`) }
    if (!fromInstaller) process.stdout.write(dim(T(`更新已有配置 ${cfgPath}`, `Updating the existing config ${cfgPath}`)) + '\n')
  } else if (fs.existsSync(examplePath)) {
    raw = JSON.parse(fs.readFileSync(examplePath, 'utf8'))
    seeded = true
    if (!fromInstaller) process.stdout.write(dim(T(`新建配置,问完再写入 ${cfgPath}`, `New config; it is written to ${cfgPath} at the end`)) + '\n')
  } else {
    // claude 不钉 model(v0.11.1):写死会覆盖 CLI 自己的默认,每出一代新模型就落后一代(v0.11.0 拍板)
    raw = { agent: { bin: 'claude', permissionMode: 'dontAsk', maxTurnTimeMins: 10, maxConcurrent: 2 }, defaultProvider: 'claude', providers: { claude: {} }, groups: {} }
  }
  if (seeded && raw.groups) delete raw.groups.oc_example_chat_id // drop the placeholder binding
  if (!raw.groups) raw.groups = {}
  // An existing config may lack these — e.g. `sbot ui --set-password` on a fresh machine writes
  // only { ui: { auth } }, then `sbot setup` would deref `Object.keys(raw.providers)` and crash.
  // Backfill (mirrors the no-config fallback above); never overwrites a present field.
  if (!raw.providers) raw.providers = { claude: {} } // 同上:不钉 model,跟随 CLI 默认
  if (!raw.agent) raw.agent = { bin: 'claude', permissionMode: 'dontAsk', maxTurnTimeMins: 10, maxConcurrent: 2 }
  if (!raw.defaultProvider) raw.defaultProvider = 'claude'

  // Line-queue reader: robust for both interactive TTY and piped/bulk input.
  // On EOF, pending asks resolve to null → the caller falls back to its default,
  // so a short/redirected input just accepts defaults instead of hanging.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const secretMask = createReadlineSecretMask(rl)
  // 问题交给 readline 当提示符写(setPrompt + prompt),不直接写 stdout:readline 一重绘这一行(改窗口大小、退格)
  // 就按它记的提示符重写 —— 默认是 `> `,1.0.11 实装里问题文字被吞成「> y」、试跑时冒出一个 `>`。问完和空闲时置空。
  rl.setPrompt('')
  const queued = []
  let waiter = null
  let closed = false
  rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l) } else queued.push(l) })
  rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null) } })
  const nextLine = () => queued.length ? Promise.resolve(queued.shift())
    : closed ? Promise.resolve(null)
    : new Promise((res) => { waiter = res })
  // 输入读完之后(管道、</dev/null、Docker RUN、CI)每一问都拿默认值。默认值走不出去的循环会原地空转:
  // 1.0.8 的模型菜单默认「1」→ key 为空 → 回菜单,3 分钟往输出里写了 18 GB。所以 ① 会转圈或有副作用的问题
  // 另给一个「输入已结束」时的答案(endedDef);② 兜底:输入结束后还问了这么多次就中止,配置不落盘。
  let askedAfterEnd = 0
  const ask = async (q, def, endedDef = def, { maskInput = false } = {}) => {
    const line = `${cyan('?')} ${q}${def ? dim(` [${def}]`) : ''} `
    if (closed) process.stdout.write(line)
    else { rl.setPrompt(line); rl.prompt() }
    if (maskInput && !closed) secretMask.start(line)
    let a
    try { a = await nextLine() } finally { if (maskInput) secretMask.stop() }
    if (!closed) rl.setPrompt('')
    if (a == null) {
      process.stdout.write('\n')
      if (++askedAfterEnd > SETUP_MAX_ASKS_AFTER_EOF) throw new Error('输入已经结束,向导还在提问 —— 已中止,配置没有写入。请在终端里直接运行 sintbot setup')
      return endedDef || ''
    }
    return String(a).trim() || def || ''
  }
  const askYN = async (q, defYes, endedYes = defYes) => {
    const a = (await ask(`${q} ${dim(defYes ? '(Y/n)' : '(y/N)')}`, '', endedYes ? 'y' : 'n')).toLowerCase()
    return a ? a[0] === 'y' : !!defYes
  }
  // Key/secret prompt: mask terminal echo so a local AI agent's terminal capture
  // cannot copy the credential into its transcript; confirm receipt by length.
  const askKey = async (q) => {
    const v = await ask(q, '', undefined, { maskInput: true })
    if (v) process.stdout.write(dim(`  ✓ 已记录（${v.length} 位）`) + '\n')
    return v
  }

  try {
    // 安装脚本调起时它自己已经说过「这里只配模型」,不再重复
    const scope = fromInstaller ? T('(Enter 用默认值)', ' (Enter accepts the default)') : T('配模型(聊天平台、代理、项目目录装完在控制台里配;Enter 用默认值)', ' model setup (chat platform, proxy and project folder are set in the console afterwards; Enter accepts the default)')
    if (!fromInstaller) process.stdout.write('\n' + cyan('sintbot setup') + dim(full ? ' — 完整配置(Enter 用默认值)' : T(' — ' + scope, ' —' + scope)) + '\n\n')

    // 第 0 步:环境检查 —— 只报不拦(缺了照样能把配置写完,最后的体检会接着报)。
    // 缺 claude / codex 时问一句替新用户装(npm i -g;官方源连不上自动换国内镜像,见 src/installdeps.js)。
    process.stdout.write(gray(T('— 环境 —', '— Environment —')) + '\n')
    const nodeOk = Number(process.versions.node.split('.')[0]) >= 22
    if (!fromInstaller || !nodeOk) process.stdout.write(`  ${nodeOk ? cyan('✓') : red('✗')} Node ${process.versions.node}${nodeOk ? '' : red(T('(需要 ≥ 22)', ' (needs 22 or later)'))}\n`)
    const installDep = (name, binName) => {
      const r = installdeps.installGlobal(name, { bin: binName, log: (l) => process.stdout.write(dim('  ' + l) + '\n') })
      const bin = whichSync(binName)
      if (r.ok && bin) { process.stdout.write(`  ${cyan('✓')} ${T('已安装', 'Installed')} ${binName} ${dim(bin)}\n`); return bin }
      if (r.verification && !r.verification.ok) {
        process.stdout.write(`  ${red('✗')} ${T(`安装后 ${binName} --version 校验失败:${r.verification.error}。请检查 PATH 或重新完整安装;不要仅凭文件存在、包版本或 npm 退出码判断成功。`, `Post-install ${binName} --version verification failed: ${r.verification.error}. Check PATH or reinstall completely; a file, package version or successful npm exit is not proof of a working CLI.`)}\n`)
        return null
      }
      if (r.ok) {
        const pre = installdeps.globalPrefix()
        const dir = pre ? (process.platform === 'win32' ? pre : path.join(pre, 'bin')) : T('npm prefix -g 下的 bin 目录', 'the bin folder under npm prefix -g')
        process.stdout.write(`  ${yellow('!')} ${T(`装好了,但当前 PATH 里找不到 ${binName} —— 把 ${dir} 加进 PATH,重开终端再跑一次 sintbot setup`, `Installed, but ${binName} is not on PATH: add ${dir} to PATH, open a new terminal and run sintbot setup again`)}\n`)
        return null
      }
      process.stdout.write(`  ${red('✗')} ${T(`安装失败(退出码 ${r.code})—— 请查看上方 npm 错误,排查见 https://github.com/sintlab/sintbot/blob/main/docs/zh-CN/install.md「一键安装」`, `Install failed (exit code ${r.code}); check the npm error above and see https://github.com/sintlab/sintbot/blob/main/docs/install.md`)}\n`)
      return null
    }
    const claudeName = (raw.agent && raw.agent.bin) || 'claude'
    let claudeBin = whichSync(claudeName)
    const claudeCheck = installdeps.probeCli(claudeBin || claudeName)
    if (!claudeCheck.ok) claudeBin = null
    if (claudeBin) process.stdout.write(`  ${cyan('✓')} claude ${dim(claudeCheck.version)} ${dim(claudeBin)}\n`)
    else {
      process.stdout.write(`  ${red('✗')} ${T('claude(Claude Code CLI)不可用 —— 每一轮都靠它干活', 'claude (Claude Code CLI) is unavailable; every turn runs on it')} ${dim(claudeCheck.error)}\n`)
      // 必需组件:终端里直接装,不问(1.0.13,用户定「安装要精简」);不在终端里(管道、CI)不替他装
      if (process.stdin.isTTY) claudeBin = installDep('claude', claudeName)
      else process.stdout.write(dim(T(`  稍后自己装:npm i -g ${installdeps.PACKAGES.claude} --include=optional --ignore-scripts=false`, `  Install it later: npm i -g ${installdeps.PACKAGES.claude} --include=optional --ignore-scripts=false`)) + '\n')
    }
    // Claude 登录态留到模型步一起报,那里据此决定推荐走哪条路。官方非交互子命令,0.2s、不联网;
    // 老版本 CLI 没有它(ok:false)⇒ null,当作没探到
    const claudeLogin = async () => {
      if (!claudeBin) return null
      const st = await claudestatus.loginStatus(claudeBin).catch(() => null)
      return st && st.ok ? !!st.loggedIn : null
    }
    let claudeLoggedIn = await claudeLogin()
    let codexBin = whichSync('codex')
    let codexLoggedIn = false
    if (!codexBin) {
      // 可选组件不问,一行给装法
      process.stdout.write(`  ${gray('○')} ${T(`codex 没装(可选,有 ChatGPT 账号时用):npm i -g ${installdeps.PACKAGES.codex},再 codex login`, `codex not installed (optional, for a ChatGPT account): npm i -g ${installdeps.PACKAGES.codex}, then codex login`)}\n`)
    }
    if (codexBin) {
      // 只读本机登录态(不联网);没登录时,GPT 群、生图、claude 额度用完自动切到 codex 都不会成
      const codexLogin = await codexstatus.loginStatus('codex').catch(() => null)
      const codexOut = codexLogin && codexLogin.ok && codexLogin.loggedIn === false
      codexLoggedIn = !!(codexLogin && codexLogin.ok && codexLogin.loggedIn)
      process.stdout.write(`  ${cyan('✓')} codex ${dim(codexBin)}${codexOut ? '  ' + yellow(T('没登录 —— GPT 群、生图、额度用完时自动切到 codex 都要它:跑一次 codex login', 'not logged in; GPT groups, image generation and switching to codex when quota runs out all need it: run codex login')) : ''}\n`)
    }
    // 设计图标库(Lucide / Tabler / Phosphor / Pixelarticons):agent 出设计图时按名字取图标,缺了只能自己画。
    // 可选组件,不问(1.0.13 起;1.0.11–1.0.12 问一句代装):缺了给一行装法,doctor 也会接着提示
    {
      const roots = design.iconRoots({ base: path.join(__dirname, '..'), extra: (raw.design && raw.design.iconsDir) || null })
      const libs = Object.entries(roots).filter(([, v]) => !v).map(([k]) => design.ICON_LIBS[k])
      if (!libs.length) process.stdout.write(`  ${cyan('✓')} ${T('设计图标库', 'Design icon libraries')} ${dim(Object.values(design.ICON_LIBS).map((l) => l.label).join(' · '))}\n`)
      else {
        const pkgs = libs.map((l) => l.pkg).join(' ')
        const mb = Math.round(libs.reduce((n, l) => n + (l.mb || 0), 0))
        process.stdout.write(`  ${gray('○')} ${T(`设计图标库没装(可选,出设计图时用;约 ${mb} MB):npm i -g ${pkgs}`, `Design icon libraries not installed (optional, used for designs; about ${mb} MB): npm i -g ${pkgs}`)}\n`)
      }
    }
    process.stdout.write('\n')

    // 不问「在不在中国大陆」(隐私,用户 10-28 定):只按时区猜,决定有国际站的厂商先试哪个站、--full 里推荐哪个平台;不写进配置
    const mainland = setupmodels.looksMainland()

    // 模型:推荐顺序 Claude 订阅 → ChatGPT(Codex)→ 都没有推荐 DeepSeek(src/setupmodels.js)
    process.stdout.write(gray(T('— 模型 —', '— Model —')) + '\n')
    let example = null
    try { example = JSON.parse(fs.readFileSync(examplePath, 'utf8')) } catch {}
    const presetOf = (name) => (example && example.providers && example.providers[name]) || null
    const ensurePreset = (name) => {
      if (!raw.providers[name] && presetOf(name)) raw.providers[name] = JSON.parse(JSON.stringify(presetOf(name)))
      return raw.providers[name]
    }
    const readyKeyed = () => Object.keys(raw.providers).filter((n) => raw.providers[n].baseUrl && !raw.providers[n].hidden && setupmodels.keyPresent(raw.providers[n].apiKey))
    const verified = [] // 本次向导里试跑通过的
    const tried = new Set() // 本次试跑过的(不论成败),结尾不再重复问
    // 试跑一轮(与控制台「模型 → 测试」同一个 runTurn 和提示词):不用工具,只要一句回复。
    // 关掉 claude 的自动重试:key 错时它默认反复重试约 3 分钟才放弃,关掉后半秒内就拿到 401 原文
    const tryTurn = async (name) => {
      const p = raw.providers[name]
      const provider = { ...p, ...(p.apiKey ? { apiKey: resolveSecret(p.apiKey) } : {}) }
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), provider.runner === 'codex' ? 180000 : 60000)
      const t0 = Date.now()
      try {
        const { result, aborted } = await runner.runTurn({
          bin: claudeBin || claudeName, prompt: lang === 'en' ? verify.TRIAL_PROMPT_EN : verify.TRIAL_PROMPT, provider, model: provider.model,
          workdir: os.tmpdir(), permissionMode: (raw.agent && raw.agent.permissionMode) || 'dontAsk', signal: ac.signal,
          extraEnv: { CLAUDE_CODE_MAX_RETRIES: '0' },
        })
        const text = (result && result.text) || ''
        if (aborted || ac.signal.aborted) return { ok: false, text: `timeout: ${T(`${Math.round((Date.now() - t0) / 1000)} 秒内没有回复`, `no reply within ${Math.round((Date.now() - t0) / 1000)} s`)}`, ms: Date.now() - t0 }
        const ok = !!text && !(result && result.isError)
        verify.recordTurn(provider, ok, text) // doctor / 控制台据此报「能用」或「key 不对」
        return { ok, text: text || T('没有返回内容', 'No output'), ms: Date.now() - t0, model: provider.model }
      } catch (e) {
        verify.recordTurn(provider, false, (e && e.message) || String(e))
        return { ok: false, text: (e && e.message) || String(e), ms: Date.now() - t0 }
      } finally { clearTimeout(timer) }
    }
    // 型号取配置里的(r.model),不靠模型自报:走 Claude Code 的第三方模型常自称 Claude,新用户会以为没切成
    const reportTurn = (label, r) => process.stdout.write(`  ${cyan('✓')} ${label}${r.model ? ' · ' + r.model : ''} ${T(`能用(${(r.ms / 1000).toFixed(1)} 秒)`, `works (${(r.ms / 1000).toFixed(1)} s)`)}: ${r.text.replace(/\s+/g, ' ').slice(0, 80)}\n`)
    // 配一家用 API key 的:告诉去哪拿 key → 粘贴 → 当场试跑,失败说人话、可重试。
    // 有国际站的厂商(key 在哪个站开的就得连哪个站):不问人在哪 —— 先试一个站(已有配置按它现在的站,新配按时区),
    // 认证失败自动换另一个站再试;没装 claude 试跑不了时才问「这个 key 是哪个站开的」(问 key,不问人)
    const configureKeyed = async (name) => {
      const info = setupmodels.PROVIDER_INFO[name] || { label: name }
      const label = setupmodels.infoText(info, 'label', lang) || name
      const billing = setupmodels.infoText(info, 'billing', lang)
      const p = ensurePreset(name)
      if (!p) { process.stdout.write(red(T(`  没有 ${name} 的预设`, `  No preset for ${name}`)) + '\n'); return false }
      const cnBase = (presetOf(name) && presetOf(name).baseUrl) || p.baseUrl
      const useSite = (k) => { if (info.intl) p.baseUrl = k === 'intl' ? info.intl.baseUrl : cnBase }
      const first = !info.intl ? 'cn' : p.baseUrl === info.intl.baseUrl ? 'intl' : setupmodels.keyPresent(p.apiKey) ? 'cn' : mainland ? 'cn' : 'intl'
      const sites = info.intl ? [first, first === 'cn' ? 'intl' : 'cn'] : ['cn']
      useSite(sites[0])
      if (info.intl) process.stdout.write(dim(T(`  在 ${info.site} 或国际站 ${info.intl.site} 注册 → 充值 → 创建 API key(${billing})`, `  Sign up at ${info.site} or the international site ${info.intl.site} → top up → create an API key (${billing})`)) + '\n')
      else if (info.site) process.stdout.write(dim(T(`  在 ${info.site} 注册 → 充值 → 创建 API key(${billing})`, `  Sign up at ${info.site} → top up → create an API key (${billing})`)) + '\n')
      for (;;) {
        const envRef = setupmodels.keyPresent(p.apiKey) && String(p.apiKey).startsWith('env:') ? p.apiKey.slice(4) : ''
        const had = setupmodels.keyPresent(p.apiKey) ? (envRef ? T(`环境变量 ${envRef}`, `environment variable ${envRef}`) : T('已设置', 'set')) : ''
        const key = await askKey(T(`粘贴 ${label} 的 API key`, `Paste your ${label} API key`) + (had ? dim(T(`(当前:${had};留空=保持)`, ` (current: ${had}; empty = keep)`)) : T('(留空=跳过)', ' (empty = skip)')))
        if (key) p.apiKey = key
        if (!setupmodels.keyPresent(p.apiKey)) return false
        if (!claudeBin) {
          if (info.intl) useSite(await askYN(T(`这个 key 是在国际站 ${setupmodels.host(info.intl.site)} 开的吗?(否 = ${setupmodels.host(info.site)})`, `Was this key created on the international site ${setupmodels.host(info.intl.site)}? (no = ${setupmodels.host(info.site)})`), first === 'intl') ? 'intl' : 'cn')
          process.stdout.write(dim(T('  没装 claude,先不试跑;装好后在控制台「模型」页点测试', '  claude is not installed, so no test run now; once it is, press Test on the console Models page')) + '\n')
          return true
        }
        let r = null
        for (const k of sites) {
          useSite(k)
          process.stdout.write(dim(T(`  用 ${label}${info.intl ? `(${setupmodels.host(p.baseUrl)})` : ''} 试跑一轮…`, `  Test run with ${label}${info.intl ? ` (${setupmodels.host(p.baseUrl)})` : ''}…`)) + '\n')
          r = await tryTurn(name)
          if (r.ok || setupmodels.explainTestFailure(r.text).kind !== 'auth') break // 只有认证失败才可能是站点不对
        }
        tried.add(name)
        if (r.ok) { reportTurn(label, r); verified.push(name); return true }
        useSite(sites[0])
        const why = setupmodels.explainTestFailure(r.text, { baseUrl: p.baseUrl, lang })
        process.stdout.write(`  ${red('✗')} ${why.text}\n`)
        if (!(await askYN(T('再试一次?(可以重新粘贴 key)', 'Try again? (you can paste the key again)'), why.kind === 'auth' || why.kind === 'network', false))) {
          process.stdout.write(dim(T('  key 先保存;跑通之前这个模型的轮次会失败,之后可在控制台「模型」页再测', '  The key is saved; turns on this model will fail until it works; test it again later on the console Models page')) + '\n')
          return true
        }
      }
    }
    const others = Object.keys(setupmodels.PROVIDER_INFO).filter((n) => n !== setupmodels.RECOMMENDED)
    const pickOthers = async () => {
      others.forEach((n, i) => process.stdout.write(`    ${i + 1}) ${setupmodels.infoText(setupmodels.PROVIDER_INFO[n], 'label', lang)}  ${dim(setupmodels.infoText(setupmodels.PROVIDER_INFO[n], 'billing', lang))}\n`))
      const sel = await ask(T('选哪家?序号,可空格分隔多选(留空 = 返回)', 'Which one? Number(s), space-separated (empty = back)'), '')
      const picked = [...new Set(sel.split(/[\s,]+/).map((x) => others[Number(x) - 1]).filter(Boolean))]
      for (const n of picked) await configureKeyed(n)
      return picked.length > 0
    }

    const codexReady = () => !!(codexBin && codexLoggedIn)
    const col = (zh, en) => T(zh.padEnd(14 - (zh.length - zh.replace(/[^\x00-\xff]/g, '').length)), en.padEnd(20))
    process.stdout.write(`  ${col('Claude 订阅', 'Claude subscription')} ${claudeLoggedIn ? cyan(T('✓ 已登录', '✓ logged in')) : gray(claudeBin ? T('○ 未登录', '○ not logged in') : T('○ 没装 claude', '○ claude not installed'))}\n`)
    process.stdout.write(`  ${col('ChatGPT(Codex)', 'ChatGPT (Codex)')} ${codexReady() ? cyan(T('✓ 已登录', '✓ logged in')) : gray(codexBin ? T('○ 未登录', '○ not logged in') : T('○ 没装 codex', '○ codex not installed'))}\n`)
    if (readyKeyed().length) process.stdout.write(`  ${col('API key 模型', 'API key models')} ${cyan('✓')} ${readyKeyed().join(' ')}\n`)
    let route = setupmodels.subscriptionRoute({ claudeLoggedIn, codexLoggedIn: codexReady() })
    // 已经有能用的就不再问(1.0.13 起不问「再加一个」:加模型在控制台「模型 · 库」)
    if (!route && !readyKeyed().length) {
      process.stdout.write('\n  ' + T('没检测到 Claude 订阅或 Codex 登录。', 'No Claude subscription or Codex login found. ') + cyan(T('推荐用 DeepSeek', 'DeepSeek is recommended')) + T(':注册充值就能用、按量付费,不需要 Claude 账号。', ': sign up, top up and go, pay as you go, no Claude account needed.') + '\n')
      for (;;) {
        process.stdout.write(`    1) ${T('用 DeepSeek', 'DeepSeek')} ${dim(T('(推荐)', '(recommended)'))}${T('—— 粘贴 API key', ': paste an API key')}\n`
          + `    2) ${T('用别家:智谱 GLM / MiniMax / 火山方舟', 'Another provider: Zhipu GLM / MiniMax / Volcano Ark')}\n`
          + `    3) ${T('用 Claude 订阅 —— 另开一个终端跑 claude auth login,登录好回到这里', 'Claude subscription: run claude auth login in another terminal, then come back here')}\n`
          + `    4) ${T(`用 ChatGPT(Codex)—— 另开一个终端跑 codex login(没装先 npm i -g ${installdeps.PACKAGES.codex}),登录好回到这里`, `ChatGPT (Codex): run codex login in another terminal (install first with npm i -g ${installdeps.PACKAGES.codex}), then come back here`)}\n`
          + `    5) ${T('先跳过(之后在控制台「模型」页添加)', 'Skip for now (add one later on the console Models page)')}\n`)
        const a = await ask(T('选', 'Choose'), '1', '5') // 输入已结束 ⇒ 先跳过(选 1 拿不到 key 会回到这里)
        if (a === '1') { if (await configureKeyed(setupmodels.RECOMMENDED)) break; continue }
        if (a === '2') { if (await pickOthers() && readyKeyed().length) break; continue }
        if (a === '3' || a === '4') {
          await ask(T('登录好了按回车', 'Press Enter once logged in'), '')
          if (a === '3') claudeLoggedIn = await claudeLogin()
          else {
            codexBin = codexBin || whichSync('codex')
            const st = codexBin ? await codexstatus.loginStatus('codex').catch(() => null) : null
            codexLoggedIn = !!(st && st.ok && st.loggedIn)
          }
          route = setupmodels.subscriptionRoute({ claudeLoggedIn, codexLoggedIn: codexReady() })
          if (route) { process.stdout.write(`  ${cyan('✓')} ${route === 'claude' ? T('Claude 订阅', 'Claude subscription') : 'Codex'} ${T('已登录', 'logged in')}\n`); break }
          process.stdout.write(`  ${yellow('!')} ${T('还是没检测到登录', 'Still no login found')}\n`)
          continue
        }
        break // 5 或其他:先跳过
      }
    }
    if (route === 'codex') ensurePreset('codex')

    // 从示例新建时:没拿到 key 的预设(没填、环境变量里也没有)不写进配置,免得体检一上来就是一排「no apiKey」;
    // 之后要用,在控制台「模型 → 添加模型」选预设即可。已有配置一律不动。
    if (seeded) {
      const dropped = Object.keys(raw.providers).filter((n) => raw.providers[n].baseUrl && !setupmodels.keyPresent(raw.providers[n].apiKey) && n !== raw.defaultProvider)
      for (const n of dropped) delete raw.providers[n]
      for (const p of Object.values(raw.providers)) if (dropped.includes(p.fallback)) delete p.fallback
    }

    // 从示例新建、codex 没装或没登录:codex 预设与指向它的自动切换不写进配置(否则体检里是一排切不过去的提醒);
    // 之后 codex login 了,在控制台「模型」页添加
    if (seeded && !codexReady()) {
      const cx = Object.keys(raw.providers).filter((n) => raw.providers[n].runner === 'codex' && n !== raw.defaultProvider)
      for (const n of cx) delete raw.providers[n]
      for (const p of Object.values(raw.providers)) if (cx.includes(p.fallback)) delete p.fallback
    }

    // 默认模型:已登录的订阅优先,其次本次跑通的、已有 key 的;再跑一次 setup 时沿用还能用的旧默认
    const usable = (n) => {
      const p = raw.providers[n]
      if (!p || p.hidden) return false
      if (p.baseUrl) return setupmodels.keyPresent(p.apiKey)
      if (p.runner === 'codex') return codexReady()
      return !!claudeLoggedIn
    }
    // 没订阅时:本次跑通的 > DeepSeek > 其他有 key 的;试跑失败过的不推荐
    const okKeyed = readyKeyed().filter((n) => !tried.has(n) || verified.includes(n))
    const auto = route || verified[0] || (okKeyed.includes(setupmodels.RECOMMENDED) ? setupmodels.RECOMMENDED : okKeyed[0]) || readyKeyed()[0] || raw.defaultProvider || 'claude'
    const suggest = !seeded && raw.defaultProvider && usable(raw.defaultProvider) ? raw.defaultProvider : auto
    // 默认模型与试跑都不问(1.0.13,用户定「安装要精简」):按上面的顺序自动选,还没试跑过就直接试一轮;群里 /model 随时换
    raw.defaultProvider = suggest
    const usableNames = Object.keys(raw.providers).filter(usable)
    if (usableNames.length) process.stdout.write(dim(T(`  默认模型:${suggest}${usableNames.length > 1 ? '(群里 /model 可换)' : ''}`, `  Default model: ${suggest}${usableNames.length > 1 ? ' (switch in a group with /model)' : ''}`)) + '\n')
    const dp = raw.defaultProvider
    const canTry = raw.providers[dp] && usable(dp) && (raw.providers[dp].runner === 'codex' ? codexBin : claudeBin)
    if (canTry && !tried.has(dp)) {
      process.stdout.write(dim(T(`  用 ${dp} 试跑一轮…`, `  Test run with ${dp}…`)) + '\n')
      const r = await tryTurn(dp)
      if (r.ok) { reportTurn(dp, r); verified.push(dp) }
      else process.stdout.write(`  ${red('✗')} ${setupmodels.explainTestFailure(r.text, { baseUrl: raw.providers[dp].baseUrl, lang }).text}\n`)
    }

    // 代理:默认不问(用户 10-28 定;结尾只给一句建议,服务安装时可把终端里的代理带进去)。--full 里用到 Claude / ChatGPT 才问;
    // 国内模型端点自动直连(noProxy)
    const officialInUse = !!(claudeLoggedIn || codexReady() || !(raw.providers[raw.defaultProvider] || {}).baseUrl)
    if (full && officialInUse) {
      if (await askYN('配置代理?(Claude / ChatGPT 要走代理;国内模型端点与飞书会自动直连)', !!(raw.proxy && raw.proxy.http))) {
        const http = await ask('HTTP 代理地址', (raw.proxy && raw.proxy.http) || 'http://127.0.0.1:7890')
        const noProxy = deriveNoProxy(raw.providers)
        raw.proxy = { http, https: http, noProxy }
        process.stdout.write(dim(`  NO_PROXY = ${noProxy}`) + '\n')
      } else if (raw.proxy) {
        delete raw.proxy
      }
    } else if (seeded) {
      delete raw.proxy // 示例里的代理是占位,没问就不写进新配置;已有配置的代理不动
    }

    // 聊天平台 / 机器人名 / 项目根目录 / 绑群:只在 --full 里问。默认流程里这些都在控制台配(「设置」「群 · 项目」),已有配置一律不动
    if (full) {
      // 机器人在群里叫什么(自知清单的自称 + 升级播报;企业微信还用它剥正文里的 @)
      process.stdout.write('\n' + gray('— 聊天平台 —') + '\n')
      const brand = await ask('机器人在群里叫什么', raw.brand || 'SintBot')
      if (brand && brand !== 'SintBot') raw.brand = brand
      else delete raw.brand

      // 接哪些平台:可以同时接;默认 = 已经配好的那些,一个都没有时按地区推荐:中国大陆飞书,其余 Slack。
      // 飞书只支持中国版(open.feishu.cn,SDK 默认域名);国际版 Lark(larksuite.com)是另一套开放平台,还没接,提示里写明。
      const realCreds = (v) => v && !String(v).startsWith('env:') && !/x{6,}|XXXX/.test(String(v))
      const had = [realCreds(raw.feishu && raw.feishu.appId) && 'feishu', realCreds(raw.slack && raw.slack.botToken) && 'slack', realCreds(raw.wecom && raw.wecom.botId) && 'wecom'].filter(Boolean)
      const platQ = mainland ? '接哪个聊天平台?国内推荐飞书 —— feishu / wecom / slack,空格分隔可多选(none = 先不接)'
        : '接哪些聊天平台?推荐 Slack —— slack / feishu(飞书中国版,国际版 Lark 还不支持)/ wecom,空格分隔可多选(none = 先不接)'
      const platIn = (await ask(platQ, had.join(' ') || (mainland ? 'feishu' : 'slack'))).toLowerCase()
      const plats = platIn === 'none' ? [] : [...new Set(platIn.split(/[\s,]+/).filter((x) => ['feishu', 'slack', 'wecom'].includes(x)))]
      if (platIn !== 'none' && !plats.length) process.stdout.write(red('  没认出平台名(feishu / slack / wecom),先跳过 —— 之后可重跑 setup 或去控制台配') + '\n')

      if (plats.includes('feishu')) {
        process.stdout.write(gray('  飞书:开放平台建「企业自建应用」→ 加机器人能力 → 事件订阅选长连接;权限清单见 https://github.com/sintlab/sintbot/blob/main/docs/zh-CN/platforms/feishu.md') + '\n')
        raw.feishu = raw.feishu || { onlyWhenMentioned: false }
        // 从示例新建:示例里的 env: 占位不是用户的值 —— 当作没填,免得默认值显示成 env:FEISHU_APP_ID、还提示「留空=保持不变」
        if (seeded) for (const k of ['appId', 'appSecret']) if (String(raw.feishu[k] || '').startsWith('env:')) raw.feishu[k] = ''
        // 示例里的 botOpenId 占位同理 —— 预检失败时下面那句「没填才问」会把它当成已填,原样写进新配置
        if (/^ou_x/i.test(String(raw.feishu.botOpenId || ''))) raw.feishu.botOpenId = ''
        // Default = the CURRENT value, incl. an `env:VAR` ref — Enter keeps it. Previously an env:
        // ref defaulted to '' so a plain Enter wiped it (broke creds for env-managed deploys).
        raw.feishu.appId = await ask('飞书 appId', raw.feishu.appId || '')
        const existingSecret = raw.feishu.appSecret || '' // incl. env: ref — 回车=保持不变
        const secretIn = await askKey(`飞书 appSecret${existingSecret ? '（留空=保持不变）' : ''}`)
        raw.feishu.appSecret = secretIn || existingSecret
        if (raw.feishu.onlyWhenMentioned === undefined) raw.feishu.onlyWhenMentioned = false

        // Precheck (同源 feishuPrecheck):探 bot 身份 + 权限,自动回填 botOpenId。
        const feUsable = raw.feishu.appId && raw.feishu.appSecret && !String(raw.feishu.appId).startsWith('env:') && !String(raw.feishu.appSecret).startsWith('env:')
        if (feUsable && await askYN('飞书预检?(探 bot 身份/权限,自动填 botOpenId)', true)) {
          const mark = { ok: cyan('✓'), warn: '\x1b[33m!\x1b[0m', fail: red('✗'), skip: gray('○') }
          try {
            const r = await feishuPrecheck(feishuClient(raw.feishu.appId, raw.feishu.appSecret), { appId: raw.feishu.appId })
            verify.recordPrecheck('feishu', raw.feishu, r.checks)
            if (r.botOpenId) { raw.feishu.botOpenId = r.botOpenId; process.stdout.write(cyan('  ✓ ') + `botOpenId = ${r.botOpenId}\n`) }
            if (r.identity && r.identity.appName) process.stdout.write(cyan('  ✓ ') + `应用 = ${r.identity.appName}${r.identity.activateText ? ` (${r.identity.activateText})` : ''}\n`)
            for (const c of r.checks) process.stdout.write(`  ${mark[c.status] || '?'} ${c.label} ${gray('— ' + (c.detail || '').slice(0, 140))}\n`) // 1.0.4:提示是写好的整句(怎么修),别截在半句
          } catch (e) { process.stdout.write(red(`  预检失败(${(e && e.message) || e})`) + '\n') }
          if (!raw.feishu.botOpenId) raw.feishu.botOpenId = await ask('bot openId (可留空)', '')
        } else {
          const curOid = String(raw.feishu.botOpenId || '').startsWith('ou_x') ? '' : (raw.feishu.botOpenId || '')
          raw.feishu.botOpenId = await ask('bot openId (可留空,用于精确 @ 门控)', curOid)
        }

        // Admins (可多个,建群自动拉入):从通讯录选(推荐)/ 邮箱·手机号 / ou_ openId。
        if (feUsable) {
          const cur = Array.isArray(raw.feishu.admins) ? raw.feishu.admins.slice() : (raw.feishu.adminOpenId ? [{ openId: raw.feishu.adminOpenId, name: raw.feishu.adminName || '' }] : [])
          if (await askYN(`配置管理员?(可多个,建群自动拉入${cur.length ? ';当前 ' + cur.length + ' 人' : ''})`, !cur.length)) {
            const admins = cur.slice()
            const addOne = (openId, name) => { if (openId && !admins.some((a) => a.openId === openId)) { admins.push({ openId, name: name || openId }); process.stdout.write(cyan('  + ') + (name || openId) + '\n') } }
            const cli = feishuClient(raw.feishu.appId, raw.feishu.appSecret)
            let users = []
            try { users = (await fetchOrgUsers(cli)).users } catch {}
            if (users.length) {
              process.stdout.write(gray(`  通讯录可见 ${users.length} 人:`) + '\n')
              users.slice(0, 50).forEach((u, i) => process.stdout.write(`    ${cyan(String(i + 1))}) ${u.name}\n`))
              const pick = await ask('选管理员序号(空格分隔;或输邮箱/手机号/ou_;留空跳过)', '')
              if (/^[\d\s]+$/.test(pick) && pick.trim()) { for (const n of pick.split(/\s+/).filter(Boolean)) { const u = users[+n - 1]; if (u) addOne(u.openId, u.name) } }
              else if (pick.trim()) { await setupResolveAdmin(cli, pick.trim(), addOne) }
            } else {
              process.stdout.write(gray('  (通讯录取不到 — 需 contact scope + 数据授权范围;可手动输)') + '\n')
              const q = await ask('管理员 邮箱/手机号/ou_openId(留空跳过)', '')
              if (q) await setupResolveAdmin(cli, q, addOne)
            }
            raw.feishu.admins = admins
            delete raw.feishu.adminOpenId; delete raw.feishu.adminName
            process.stdout.write(dim(`  管理员共 ${admins.length} 人`) + '\n')
          }
        }
      } else if (seeded) {
        delete raw.feishu // drop the example placeholder so doctor doesn't flag it
      }

      if (plats.includes('slack')) {
        process.stdout.write(gray('  Slack:api.slack.com/apps → Create New App → From a manifest,粘贴 ' + path.join(__dirname, '..', 'docs', 'slack-app-manifest.yaml') + ' 的内容;') + '\n'
          + gray('         装进 workspace 后取 Bot Token(xoxb-),再在 Basic Information 建一个 App-Level Token(xapp-,勾 connections:write)') + '\n')
        raw.slack = raw.slack || {}
        raw.slack.botToken = (await askKey(`Slack Bot Token(xoxb-…)${raw.slack.botToken ? '(留空=保持不变)' : ''}`)) || raw.slack.botToken || ''
        raw.slack.appToken = (await askKey(`Slack App Token(xapp-…)${raw.slack.appToken ? '(留空=保持不变)' : ''}`)) || raw.slack.appToken || ''
        if (raw.slack.onlyWhenMentioned === undefined) raw.slack.onlyWhenMentioned = true
        const usable = realCreds(raw.slack.botToken) && realCreds(raw.slack.appToken)
        if (usable && await askYN('Slack 预检?(验凭据 / 权限 / 长连接 / 已加入的频道)', true)) {
          const mark = { ok: cyan('✓'), warn: '\x1b[33m!\x1b[0m', fail: red('✗') }
          try {
            const r = await require('../src/platform/slack').slackPrecheck(raw.slack.botToken, raw.slack.appToken)
            verify.recordPrecheck('slack', raw.slack, r.checks)
            if (r.botUserId) raw.slack.botUserId = r.botUserId
            if (r.identity) raw.slack.identity = r.identity
            for (const c of r.checks) process.stdout.write(`  ${mark[c.status] || '?'} ${c.label} ${gray('— ' + (c.detail || '').slice(0, 140))}\n`)
          } catch (e) { process.stdout.write(red(`  预检失败(${(e && e.message) || e})`) + '\n') }
        }
      }

      if (plats.includes('wecom')) {
        process.stdout.write(gray('  企业微信:管理后台「智能机器人 → 新建 → API 模式 → 使用长连接」拿 Bot ID 与 Secret(见 https://github.com/sintlab/sintbot/blob/main/docs/zh-CN/platforms/wecom.md)') + '\n')
        raw.wecom = raw.wecom || {}
        raw.wecom.botId = await ask('企业微信 Bot ID', realCreds(raw.wecom.botId) ? raw.wecom.botId : '')
        raw.wecom.secret = (await askKey(`企业微信 Secret${raw.wecom.secret ? '(留空=保持不变)' : ''}`)) || raw.wecom.secret || ''
        raw.wecom.botName = await ask('机器人在企业微信里的名字(用来剥掉正文里的 @)', raw.wecom.botName || brand || 'SintBot')
      }

      // 项目根目录:群项目都放这里,控制台选目录 / 保存绑定 / 风格提炼只认这里面的路径(src/projectsroot.js)。
      // 一行,回车即默认;多个用 ; 分隔;等于没围的值(/、家目录、/Users …)说原因重问;不存在问一句是否创建。
      // 回车接受默认时**不落盘**(默认值不写进配置,和别的默认项一样);再跑向导时默认值取现有配置。
      for (;;) {
        const cur = resolveProjectsRoots(raw)
        const defText = cur.roots.join(';')
        const ans = await ask('项目根目录(群项目都放这里;多个用 ; 分隔)', defText)
        const list = parseRootsInput(ans)
        const r = resolveProjectsRoots({ projectsRoots: list })
        if (r.dropped.length) { for (const d of r.dropped) process.stdout.write(red(`  ✗ ${d.value}:${d.why}`) + '\n'); process.stdout.write(dim('  请重输(留空回车 = 用默认)') + '\n'); continue }
        if (ans !== defText || cur.fromConfig) raw.projectsRoots = list
        for (const root of r.roots) {
          if (fs.existsSync(root)) continue
          if (await askYN(`  ${root} 不存在,现在创建?`, true)) {
            try { fs.mkdirSync(root, { recursive: true }); process.stdout.write(cyan('  ✓ 已创建 ') + root + '\n') }
            catch (e) { process.stdout.write(red(`  创建失败:${(e && e.message) || e}`) + '\n') }
          }
        }
        break
      }

      if (await askYN('绑定一个 群→项目?', false)) {
        let chatId = ''
        let groupName = '' // 从列表里选的群 / 频道名,用来给项目目录出默认值
        const fe = raw.feishu
        // 绑到哪个平台的群:只接了一个平台就是它,接了多个先问
        // 排序按地区(决定默认绑哪边):中国大陆飞书在前,其余 Slack 在前
        const live = (mainland ? ['feishu', 'wecom', 'slack'] : ['slack', 'feishu', 'wecom']).filter((x) => (x === 'feishu' ? realCreds(fe && fe.appId) : x === 'slack' ? realCreds(raw.slack && raw.slack.botToken) : realCreds(raw.wecom && raw.wecom.botId)))
        let bindPlat = live[0] || 'feishu'
        if (live.length > 1) { const a = (await ask(`这个群在哪个平台? (${live.join(' / ')})`, live[0])).toLowerCase(); if (live.includes(a)) bindPlat = a }
        const usableFeishu = bindPlat === 'feishu' && fe && fe.appId && fe.appSecret && !String(fe.appId).startsWith('env:') && !String(fe.appSecret).startsWith('env:')
        if (bindPlat === 'slack' && realCreds(raw.slack.botToken)) {
          try {
            const chans = await require('../src/platform/slack').fetchSlackChannels(raw.slack.botToken)
            if (chans.length) {
              process.stdout.write(gray('  bot 已加入的频道:') + '\n')
              chans.forEach((c, i) => process.stdout.write(`    ${cyan(String(i + 1))}) #${c.name}  ${dim(c.id)}\n`))
              const pick = await ask('选择要绑定的频道(序号,或直接粘贴频道 ID;留空跳过)', '')
              const hit = /^\d+$/.test(pick) && chans[+pick - 1]
              chatId = hit ? hit.id : pick
              if (hit) groupName = hit.name
            } else chatId = await ask('频道 ID(如 C0123ABCD;bot 还没进任何频道 —— 先在频道里 /invite 它)', '')
          } catch (e) {
            // 1.0.4:错误码翻成人话(凭据 / 权限 / 网络各自怎么修),不再只甩一个 invalid_auth
            process.stdout.write(red(`  拉频道列表失败:${require('../src/platform/slack').slackHint(e)}`) + '\n')
            chatId = await ask('频道 ID(如 C0123ABCD;修好上面的问题后重跑向导就能从列表里选)', '')
          }
        } else if (bindPlat === 'wecom') {
          chatId = await ask('企业微信群 ID(还不知道就留空:先跑起来,在群里 @ 机器人说一句,再到控制台绑定 —— 那里会列出 @ 过它的群)', '')
        } else if (usableFeishu) {
          try {
            const chats = await fetchChats(feishuClient(fe.appId, fe.appSecret))
            if (chats.length) {
              process.stdout.write(gray('  bot 所在的群:') + '\n')
              chats.forEach((c, i) => process.stdout.write(`    ${cyan(String(i + 1))}) ${c.name}  ${dim(c.chatId)}\n`))
              const pick = await ask('选择要绑定的群(序号,或直接粘贴 chatId;留空跳过)', '')
              const hit = /^\d+$/.test(pick) && chats[+pick - 1]
              chatId = hit ? hit.chatId : pick
              if (hit && hit.name !== '(未命名群)') groupName = hit.name
            } else {
              process.stdout.write(gray('  (bot 不在任何群里 — 先把 bot 拉进群再重试,或手动输入)') + '\n')
              chatId = await ask('群 chatId (如 oc_xxx)', '')
            }
          } catch (e) {
            process.stdout.write(red(`  拉群列表失败:${feishuHint(e, 'im:chat')}`) + '\n')
            chatId = await ask('群 chatId (如 oc_xxx)', '')
          }
        } else {
          chatId = await ask('群 chatId (如 oc_xxx;配了飞书可自动列群供选)', '')
        }
        if (!chatId) {
          // 没有群就不往下问了(1.0.4 前照问目录和 provider,问完才说「未绑定」)
          process.stdout.write(gray('  没有群 ID,先不绑定 —— 跑起来后在控制台「群 · 项目」页绑定') + '\n')
        } else {
          // 认 `~`、存展开后的绝对路径;写错了当场重问(1.0.2 及以前原样收下 `~/x`,在当前目录建出一个叫 `~` 的文件夹)。
          // 1.0.4 起有默认值:项目根目录下以群名命名的子目录,回车即用
          const pr = resolveProjectsRoots(raw)
          const def = defaultWorkdir(groupName, pr.roots)
          let workdir = ''
          for (;;) {
            const wd = workdirInput(await ask(`项目目录(在 ${describeRoots(pr.roots)} 下,可以用 ~ 开头;回车用默认)`, def))
            if (wd.path) { workdir = wd.path; break }
            process.stdout.write(red('  ' + wd.error) + '\n')
          }
          // 项目根目录围栏在向导里只提醒不拦:向导与手改配置文件是同一条 operator 路,但要让他知道
          // 控制台不会认这样的绑定、doctor 会一直提示(围栏判据与控制台同源,src/projectsroot.js)
          if (!withinRoots(workdir, pr.roots)) process.stdout.write(yellow(`  ⚠ 不在项目根目录(${describeRoots(pr.roots)})下 —— 控制台不会允许这样的绑定,doctor 会提示;向导照记`) + '\n')
          if (!fs.existsSync(workdir) && await askYN(`  ${workdir} 不存在,现在创建?`, true)) {
            try { fs.mkdirSync(workdir, { recursive: true }); process.stdout.write(cyan('  ✓ 已创建 ') + workdir + '\n') }
            catch (e) { process.stdout.write(red(`  创建失败:${(e && e.message) || e}`) + '\n') }
          }
          const gp = await ask('该群 provider', raw.defaultProvider)
          delete raw.groups.oc_example_chat_id
          raw.groups[chatId] = { workdir, provider: gp, ...(live.length > 1 || bindPlat !== 'feishu' ? { platform: bindPlat } : {}) }
        }
      }
    }
    // 默认流程从示例新建:示例里的飞书块是 env: 占位(FEISHU_APP_ID …),当前终端里两个都有值才留(环境变量管凭据的部署),
    // 否则不写进配置 —— 不然体检一上来就报「feishu 块缺 appSecret」
    // 示例里的 projectsRoots 就是默认值(~/Projects):不落盘,和 --full 里回车接受默认一样 —— 写进去就成了「配置里指定的根」,
    // 目录还不存在时体检报失败;没写的默认根在控制台第一次浏览时自动创建
    if (!full && seeded && JSON.stringify(raw.projectsRoots) === JSON.stringify(['~/Projects'])) delete raw.projectsRoots
    if (!full && seeded && raw.feishu) {
      const fe = raw.feishu
      const envOk = (v) => String(v || '').startsWith('env:') && !!process.env[String(v).slice(4)]
      if (envOk(fe.appId) && envOk(fe.appSecret)) { if (/^ou_x/i.test(String(fe.botOpenId || ''))) fe.botOpenId = '' }
      else delete raw.feishu
    }
  } finally {
    secretMask.restore()
    rl.close()
  }

  // 配置里有密钥:新建的文件从落盘那一刻就只给自己读写(先写后 chmod 会留一个默认权限的空窗);
  // 目录也是新建才收紧。已有文件沿用它自己的权限,doctor 会提示权限过宽。
  const posix = process.platform !== 'win32'
  const cfgDir = path.dirname(cfgPath)
  if (posix && !fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 })
  atomicWriteJSON(cfgPath, raw, posix ? { mode: 0o600 } : {})
  process.stdout.write('\n' + cyan('✓ ') + T(`已保存 ${cfgPath}`, `Saved ${cfgPath}`) + '\n')

  const cfg = loadConfig(cfgPath)
  const cfgArg = cfgPath === path.join(os.homedir(), '.sbot', 'config.json') ? '' : ` --config ${cfgPath}`
  if (full) {
    process.stdout.write('\n' + gray('— 体检 —') + '\n')
    await runDoctor(cfg)
  } else {
    // 新装时「没接平台 / 没绑群 / Claude 没登录」都是正常状态,整屏警告看着像出错:只报失败项,完整体检留给 sintbot doctor
    const { rows } = await checkHealth(cfg)
    const failed = rows.filter((r) => r.status === 'fail')
    if (failed.length) {
      for (const r of failed) process.stdout.write(`${red('✗')} ${r.label.padEnd(22)} ${gray(r.detail)}\n`)
      process.stdout.write(dim(T(`  完整体检:sintbot doctor${cfgArg}`, `  Full check: sintbot doctor${cfgArg}`)) + '\n')
    } else process.stdout.write(cyan('✓ ') + T('体检通过', 'Health check passed') + dim(T(`(完整:sintbot doctor${cfgArg})`, ` (full: sintbot doctor${cfgArg})`)) + '\n')
  }
  if (!((cfg.providers || {})[cfg.defaultProvider] || {}).baseUrl) {
    process.stdout.write('\n' + yellow(T('⚠ 订阅条款:', '⚠ Subscription terms: ')) + T('用个人的 Claude / ChatGPT 订阅登录来服务多人群聊,可能不符合提供方的使用条款;团队使用请改用 API key 或企业账号,并自行确认合规。', 'serving a multi-person group chat from a personal Claude / ChatGPT subscription may break the provider\'s terms; for team use switch to an API key or a business account and check compliance yourself.') + '\n')
  }
  if (fromInstaller) return // 后台服务、控制台地址、接下来去哪:install.sh 结尾统一给
  const plat = platformsConfigured(cfg)
  const noPlatform = !plat.feishu && !plat.wecom && !plat.slack
  process.stdout.write('\n' + gray(T('— 下一步 —', '— Next —')) + '\n'
    + `  sintbot service install${cfgArg}   ${dim(T('装成后台服务,控制台常开在 http://127.0.0.1:4600(登录后自启,崩溃自动拉起)', 'install the background service; the console stays at http://127.0.0.1:4600 (starts at login, restarts on crash)'))}\n`
    + `  sintbot ui${cfgArg}                ${dim(noPlatform ? T('现在就打开控制台:在「设置」里接飞书 / Slack / 企业微信,在「群 · 项目」里绑群', 'open the console now: connect Slack, Feishu or WeCom under Settings, bind a group under Groups') : T('打开控制台:绑群、切模型、看实时活动', 'open the console: bind groups, switch models, watch live activity'))}\n`
    + `  sintbot chat${cfgArg}              ${dim(T('不接平台也能先在终端里和它聊几句', 'chat with it in the terminal first, no platform needed'))}\n`
    )
}

// 能不能在这台机器上弹浏览器:SSH 进来的会话弹到的是对方屏幕(或根本没有屏幕),Linux 没有图形界面也不弹 —— 只打印地址
function canOpenBrowser(env = process.env, platform = process.platform) {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false
  return true
}

function tryOpen(url) {
  if (!canOpenBrowser()) return
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try { require('node:child_process').spawn(cmd, isWin ? ['', url] : [url], { shell: isWin, stdio: 'ignore', detached: true }).unref() } catch { /* just print the URL */ }
}

// `sbot ui` — serve the local control console (概览 / providers / groups /
// settings) wired to the real config. Loopback-only by default; `--host 0.0.0.0`
// (or a LAN IP) opens it to the local network, which REQUIRES a password first
// (`--set-password`). Live daemon activity shows when co-hosted (`sbot start --ui`).
async function cmdUi(rest) {
  const noOpen = rest.includes('--no-open')
  rest = rest.filter((a) => a !== '--no-open')
  const { values } = parseArgs({ args: rest, allowPositionals: true, options: { config: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, 'set-password': { type: 'boolean' } } })
  const cfg = loadConfig(values.config)
  const configPath = cfg._path || path.join(process.cwd(), 'sbot.config.json')
  const readRawCfg = () => (fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}) // 损坏则抛,交由 die 面对

  // `--set-password`: set/replace the console access password (scrypt hash), then exit.
  if (values['set-password']) {
    const pw = await askPassword('设置控制台访问密码: ')
    if (pw.length < 6) die('密码太短(至少 6 位)')
    if ((await askPassword('再输一次确认: ')) !== pw) die('两次输入不一致')
    let raw; try { raw = readRawCfg() } catch (e) { die(`配置文件损坏,已拒绝写入:${e.message}`) }
    raw.ui = raw.ui || {}; raw.ui.auth = hashPassword(pw)
    atomicWriteJSON(configPath, raw)
    process.stderr.write(green('  ✓ 已设置控制台访问密码') + dim(`  → ${configPath}`) + '\n')
    process.stderr.write(dim('  对外访问(--host)现在会要求登录 · 移除密码:删掉 config 里的 ui.auth') + '\n')
    return
  }

  applyProxyEnv(cfg)
  const port = Number(values.port) || 4600
  const host = values.host || (cfg.ui && cfg.ui.host) || '127.0.0.1'
  const loopback = isLoopbackHost(host)
  // Fail-closed: never expose the operator console to the LAN without a password.
  if (!loopback) {
    let raw; try { raw = readRawCfg() } catch (e) { die(`配置文件损坏:${e.message}`) }
    if (!((raw.ui || {}).auth)) die(`对外访问(--host ${host})需先设置密码:sintbot ui --set-password`)
  }
  const ui = createUiServer({ configPath, host, log: (m) => process.stderr.write(gray('· ' + m) + '\n') })
  ui.server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      // 后台服务在跑 = 控制台已经开着(1.0.12 起没平台也装服务):直接打开它,别报「端口被占用」
      const st = (() => { try { return require('../src/service').status({ platform: process.platform, home: os.homedir() }) } catch { return {} } })()
      if (st.running) {
        const url = `http://127.0.0.1:${port}`
        process.stderr.write(cyan('  ') + tr(`控制台已在后台服务里运行 → ${url}`, `The console is already running in the background service → ${url}`) + '\n')
        if (!noOpen) tryOpen(url)
        process.exit(0)
      }
      return die(`端口 ${port} 被占用 — 换端口:sintbot ui --port <其它>`)
    }
    die('ui server error: ' + (e && e.message))
  })
  ui.listen(port, host, () => {
    const localUrl = `http://127.0.0.1:${port}`
    process.stderr.write('\n' + cyan('  sbot 控制台') + dim('  →  ') + localUrl + '\n')
    if (!loopback) {
      for (const ip of lanIPv4()) process.stderr.write(dim('    局域网 →  ') + `http://${ip}:${port}` + '\n')
      process.stderr.write(yellow('  ⚠ 已对局域网开放') + dim(' — 仅在可信网络使用;需密码登录,HTTP 明文传输(嗅探可见)') + '\n')
    }
    process.stderr.write(dim(`  config: ${configPath}   ·   Ctrl-C 退出`) + '\n\n')
    if (!noOpen) tryOpen(localUrl)
  })
  const bye = () => { try { ui.close() } catch {} process.exit(0) }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}

// ── 画布图表移植(v0.7.2)辅助函数 ─────────────────────────────────────────────
// v0.7.0 真机两病:plantuml 端点无位置参数 ⇒ 图表压在主画板已有内容上;Mermaid 容器子节点用
// overwrite 法删不掉。解法:端点永远只在群里看不见的 scratch 画板上渲染,结果读回后以普通节点
// 批量搬进主画板算定的空白区 ⇒ 位置可控、可删、可标注吸附。以下函数承担 scratch 生命周期、
// 渲染读回、净化平移移植、整图降级、结果卡交付;纯几何/校验在 src/platform/board.js(可单测)。

// scratch 画板(每群一块,懒建):复用 createBoardDoc 建隐藏文档 —— **不分享群/不挂标签页/不订阅**
// ⇒ 群里看不见,且不在 groups[].board.whiteboardId 上,boardwatch 天然不轮询它。存
// groups[chatId].board.scratch,已存在则复用。返回 scratch 的 whiteboardId。
async function ensureScratchBoard(client, cfg, chatId) {
  const g = cfg.groups && cfg.groups[chatId]
  const existing = g && g.board && g.board.scratch
  if (existing && existing.whiteboardId) return existing.whiteboardId
  const title = redact('(sbot)图表渲染暂存 · 勿动') // 出站脱敏(与群回复一致)
  const { docToken, whiteboardId } = await createBoardDoc(client, { title })
  const p = cfg._path
  if (p && g) {
    withFileLock(p, () => {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
      raw.groups = raw.groups || {}; raw.groups[chatId] = raw.groups[chatId] || {}
      raw.groups[chatId].board = raw.groups[chatId].board || {}
      raw.groups[chatId].board.scratch = { docToken, whiteboardId, createdAt: new Date().toISOString() }
      atomicWriteJSON(p, raw)
    })
  }
  return whiteboardId
}

// 暂存画板死档自愈:清掉 config 里的 scratch 指针 ⇒ 下次 ensureScratchBoard 自动重建。
// 只在 renderDiagramToScratch 打了 scratchDead 标记时调(渲染语法错误等不清 —— 乱清会每次
// 失败都泄漏一份新隐藏文档)。best-effort,失败无害。
function dropScratchPointer(cfg, chatId) {
  const p = cfg._path
  if (!p) return
  try {
    withFileLock(p, () => {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
      const b = raw.groups && raw.groups[chatId] && raw.groups[chatId].board
      if (b && b.scratch) { delete b.scratch; atomicWriteJSON(p, raw) }
    })
  } catch {}
}

// 每次渲染前清场:overwrite 写单个占位节点归零(自愈,清掉上次遗留的图表垃圾)。空板 overwrite
// 可能被拒(空板语义未知)→ 退普通 create 占位。scratch 无人监听 ⇒ 不留 ops 痕。best-effort。
async function clearScratchBoard(client, scratchWb) {
  const ph = boardTextNode('ph', 0, 0, 40, 20, '·')
  try { await createBoardNodes(client, scratchWb, [ph], { overwrite: true }) } catch { try { await createBoardNodes(client, scratchWb, [ph]) } catch {} }
}

// 在 scratch 上渲染一次图表并读回图表节点集(before/after diff 剔掉占位与旧残留)。
// 返回 { rootId, nodes };nodes 空 = 渲染没产出可读节点(调用方据此再降级)。
async function renderDiagramToScratch(client, scratchWb, { syntaxType, diagramType, styleType, code }) {
  await clearScratchBoard(client, scratchWb)
  let before
  try {
    before = new Set((await listBoardNodes(client, scratchWb)).map((n) => n && n.id).filter(Boolean))
  } catch (e) {
    // 渲染前的纯读都失败 = scratch 文档大概率已死(被删/失权)——与 plantuml 语法错误无关的
    // 无歧义信号。打标记让调用方清掉指针,下次自动重建;否则死档会让图表永久降级直渲老路(审查 #1)。
    const err = new Error('暂存画板不可用:' + larkErrMsg(e)); err.scratchDead = true; throw err
  }
  const rootId = await createBoardDiagram(client, scratchWb, { code, syntaxType, diagramType, styleType })
  const after = await listBoardNodes(client, scratchWb)
  return { rootId, nodes: after.filter((n) => n && n.id && !before.has(n.id)) }
}

// 结果卡交付(board-add-image / board-add-diagram --deliver 共用):出队本轮播报卡锚点 → 有 cardId
// 则 cardkit card.update 回填(处理中→结果卡,单卡),失败/无 cardId 则新发一张结果卡。imgKey 由
// 调用方按各自方式取好(图片=上传消息图;图表=画板聚焦预览),取不到(null)仍发无图结果卡不阻断。
async function deliverResultCard(client, chatId, { imgKey = null, boardUrl = null, title, note = '' } = {}) {
  const notice = shiftNotice(boardNoticeDir(), chatId)
  const card = buildDeliverCard({ imgKey, boardUrl, title, note, redact })
  let filled = false
  if (notice && notice.cardId) {
    try { await updateCardEntity(client, notice.cardId, card); filled = true } catch (e) { process.stderr.write(dim('  (回填原卡失败,改发新结果卡: ' + (e && e.message) + ')\n')) }
  }
  if (!filled) await sendChatCard(client, chatId, card)
  process.stderr.write(green(filled ? '  ✓ 结果已回填进画布播报卡(单卡)\n' : '  ✓ 已发结果卡到群\n'))
}

// 放一张图上主画板(board-add-image 主体 + 图表 as-image 降级共用):魔数尺寸 → 摆放三档
// (x/y 显式 > --beside 参照右侧同排 > 全局最右)→ 上传素材 → 写 image 节点(+可选标签)→ ops 留痕
// → 可选 --deliver 结果卡。返回节点 ids。提炼共享而非复制,两处行为一致。
async function putImageOnBoard(client, cfg, chatId, whiteboardId, gBoard, absImage, opts = {}) {
  const { xOpt, yOpt, widthOpt, heightOpt, besideOpt, labelOpt, deliverFlag, noteOpt, srcLabel, deliverTitle } = opts
  const px = imageSize(fs.readFileSync(absImage)) // 像素尺寸(魔数解析;非 PNG/JPEG/WebP 报人话)
  let w = widthOpt !== undefined ? Number(widthOpt) : undefined
  let h = heightOpt !== undefined ? Number(heightOpt) : undefined
  if (!Number.isFinite(w) && !Number.isFinite(h)) { w = Math.min(600, px.width); h = Math.round(w * px.height / px.width) }
  else if (!Number.isFinite(h)) h = Math.round(w * px.height / px.width)
  else if (!Number.isFinite(w)) w = Math.round(h * px.width / px.height)
  let x = Number(xOpt); let y = Number(yOpt)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const nodes = await listBoardNodes(client, whiteboardId)
    if (besideOpt) {
      const p = besideImagePosition(nodes, besideOpt, w, h)
      if (p.fallback) process.stderr.write(dim(`  (参照节点 ${besideOpt} 未找到 — 回退默认摆放;整板重写后节点 id 会变,先 board-nodes 重读)\n`))
      ;({ x, y } = p)
    } else { ({ x, y } = nextImagePosition(nodes, w, h)) }
  }
  const token = await uploadBoardImage(client, whiteboardId, absImage)
  const nodes = [{ id: 'img1', type: 'image', x, y, width: w, height: h, image: { token } }]
  if (labelOpt) nodes.push(boardTextNode('lbl1', x, y + h + 8, w, 28, redact(labelOpt)))
  const ids = await createBoardNodes(client, whiteboardId, nodes)
  try { appendBoardOp(boardOpsDir(), whiteboardId, { op: 'add', ids }) } catch {} // 自编辑留痕(轮询感知不自问自答);失败不阻断
  process.stderr.write(green('  ✓ 已放图上画布 ') + dim(srcLabel || absImage) + '\n')
  process.stdout.write(`图片节点: ${ids[0] || '?'}  at(${x},${y}) ${w}×${h}${labelOpt ? `  标签节点: ${ids[1] || '?'}` : ''}\n`)
  if (deliverFlag) {
    const boardUrl = (gBoard && gBoard.url) || null
    let imgKey = null
    try { imgKey = await withCardPreview(absImage, (p) => uploadImage(client, p)) } catch (e) { process.stderr.write(dim('  (结果图上传失败,发无图结果卡: ' + (e && e.message) + ')\n')) }
    try { await deliverResultCard(client, chatId, { imgKey, boardUrl, title: labelOpt || deliverTitle || '已按标注改图', note: noteOpt || '' }) } catch (e) { process.stderr.write(dim('  (结果卡交付失败: ' + (e && e.message) + ' — 图已上板,可手动 send-image)\n')) }
  }
  return ids
}

// 图表移植:把从 scratch 读回的图表节点净化+平移后,一批 POST 进主画板(非 overwrite,故可删)。
// 摆放三档:显式 --x/--y > --beside 参照右侧同排 > 主画板全部内容 union bbox 最右 +40 顶对齐(空板落原点)。
// --label 并进同一批(图表 bbox 正下方 +8)。99992402 字段校验失败 → 解析被拒字段名累加进 dropKeys
// 重试(上限 5 轮,每轮 stderr 告警);解析不出可剔字段则抛错(调用方降级 as-image)。
// 成功返回 { ids, box(平移后 bbox), tier(摆放档), labelIncluded }。
async function transplantDiagram(client, mainWb, diagramNodes, { xOpt, yOpt, besideOpt, labelOpt }) {
  const box = nodesBBox(diagramNodes)
  if (!box) throw new Error('读回的图表节点无有效几何,无法定位移植')
  const bw = box.maxX - box.minX; const bh = box.maxY - box.minY
  let target; let tier
  if (Number.isFinite(Number(xOpt)) && Number.isFinite(Number(yOpt))) { target = { x: Number(xOpt), y: Number(yOpt) }; tier = '显式坐标' }
  else {
    const mainNodes = await listBoardNodes(client, mainWb)
    if (besideOpt) {
      const p = besideRegionPosition(mainNodes, besideOpt, bw, bh)
      if (p.fallback) { process.stderr.write(dim(`  (参照节点 ${besideOpt} 未找到 — 回退默认摆放;整板重写后 id 会变,先 board-nodes 重读)\n`)); tier = '默认(参照失效)' } else tier = 'beside 参照右侧'
      target = { x: p.x, y: p.y }
    } else {
      const mb = nodesBBox(mainNodes)
      target = mb ? { x: mb.maxX + 40, y: mb.minY } : { x: 0, y: 0 }
      tier = mb ? '默认(空白区最右)' : '默认(空画板原点)'
    }
  }
  const dx = target.x - box.minX; const dy = target.y - box.minY
  const labelNode = labelOpt ? boardTextNode('dlbl1', target.x, box.maxY + dy + 8, Math.max(120, bw), 28, redact(labelOpt)) : null
  const dropKeys = []
  let grouping = true // 打组是锦上添花:被拒时退散节点重试,别连累整条可编辑移植(审查 M1 的口径保留)
  for (let attempt = 0; attempt < 6; attempt++) {
    const clean = shiftDiagramNodes(sanitizeDiagramNodes(diagramNodes, dropKeys), dx, dy)
    // 标签节点也过同一份 dropKeys —— 若被拒字段恰好长在标签 text_shape 上,不剔它会 6 轮全败白降级(审查 #4)
    const content = labelNode ? [...clean, sanitizeDiagramNodes([labelNode], dropKeys)[0]] : clean
    // 整批打组(2026-07-28 真机探针定案,修 v0.7.8 的反向写法):组关系由**成员写 parent_id** 建立。
    // `node.children` 是只读派生字段(官方数据结构文档标 read_only)—— 写它服务端静默丢弃、建出空组,
    // 这就是 v0.7.8「服务端接受但 UI 没编组」的全部原因。同批纠正的另两条误判:
    //   ① 组几何**不会**按成员 bbox 派生(省略只拿到默认 100,100 120×100 ⇒ 组框与内容错位)⇒ 必须显式给;
    //   ② 成员挂组后 x/y **仍是画布绝对坐标**(group 是软组合、不建坐标系,与文档「存在父容器时为相对
    //      父容器坐标」的通则不同,导出图对照实测重叠)⇒ shiftDiagramNodes 的绝对落点一行不用改。
    // 只给**没有父**的节点挂组(style=1 若自带容器父子,不去抢它的 parent_id);group 放**批首**,与
    // 探针验证过的形态一致(成员引用批内先出现的 id)。删 group 只解组不删子节点,演变档案安全。
    const g = grouping ? groupDiagramBatch(content) : { batch: content, groupLocalId: null }
    const batch = g.batch
    const groupLocalId = g.groupLocalId
    try {
      const ids = await createBoardNodes(client, mainWb, batch)
      // 返回 ids 与传入 batch 同序 ⇒ 组在批首时切掉它,nodeIds = 图表本体(+标签)的持久 id,
      // 供调用方报「根节点」与 --beside 参照(别让用户拿到组 id 当图形 id 用)。
      const nodeIds = groupLocalId ? ids.slice(1) : ids.slice()
      return { ids, nodeIds, groupId: groupLocalId ? (ids[0] || null) : null, box: { minX: target.x, minY: target.y, maxX: target.x + bw, maxY: box.maxY + dy }, tier, labelIncluded: !!labelNode }
    } catch (e) {
      const msg = larkErrMsg(e)
      if (!/99992402/.test(msg)) throw e
      let fields = parseInvalidNodeFields(msg).filter((f) => !dropKeys.includes(f))
      let progressed = false
      // 服务端点名 parent_id ⇒ 是**打组这一层**的问题,退组即可 —— 绝不把 parent_id 剔进 dropKeys,
      // 那会连图表自带的容器父子关系一起抹掉(sanitizeDiagramNodes 是无差别剔顶层键)。
      if (fields.includes('parent_id')) {
        fields = fields.filter((f) => f !== 'parent_id')
        if (grouping) { grouping = false; progressed = true; process.stderr.write(dim('  (服务端拒收 parent_id — 退散节点(不打组)重试)\n')) }
      }
      if (fields.length) {
        for (const f of fields) dropKeys.push(f)
        progressed = true
        if (attempt < 5) process.stderr.write(dim(`  (移植 POST 被 99992402 拒,剔除字段 [${fields.join(', ')}] 后重试第 ${attempt + 2} 次)\n`)) // 末轮失败不再谎报「重试」,直接走下面的 throw
      }
      if (!progressed) {
        // 定位不到可剔字段时先怀疑打组(批里唯一非图表本体的东西;如服务端日后不认 type:"group",
        // 报文命中 type 会被 STOP 集滤掉走到这)—— 退组重试一轮,仍失败才是图表本体的问题;
        // 别让打组这个锦上添花连累整条可编辑移植降级(审查 M1 口径)。
        if (grouping) { grouping = false; process.stderr.write(dim('  (移植被拒且无法定位字段 — 退散节点(不打组)重试)\n')); continue }
        throw new Error('图表节点移植被拒(99992402)且无法定位可剔字段:' + msg)
      }
    }
  }
  throw new Error('图表节点移植重试多轮仍失败(99992402)')
}

// 整板导出(download_as_image)带服务端缓存:近期导出过的板,再导出返回的还是旧快照
// (2026-07-27 真机:渲染后节点秒级可见,但先拍过基线的板 42s 内导出内容不刷新;停止导出
// 一段时间后「渲染后首拍」即新)。⇒ 用「上次导出 md5」判新鲜:同 hash = 疑似缓存,间隔 15s
// 重拍,最多 3 次;无记录(首次/上次很久前)信任首拍。hash 记录随 board-ops 目录持久化,
// 紧连两轮 --deliver 也不会把上一轮的旧图当成这一轮的预览。
async function exportBoardPngFresh(client, whiteboardId, destAbs) {
  const crypto = require('node:crypto')
  const wb = client.board && client.board.v1 && client.board.v1.whiteboard
  if (!wb || typeof wb.downloadAsImage !== 'function') throw new Error('SDK 缺少 board.whiteboard.downloadAsImage — 请升级 @larksuiteoapi/node-sdk')
  const hashFile = path.join(boardOpsDir(), 'export-hash-' + String(whiteboardId).replace(/[^\w-]/g, '') + '.json')
  let last = null
  try {
    const rec = JSON.parse(fs.readFileSync(hashFile, 'utf8'))
    // 只有「近期」记录才参与缓存判定(真机缓存 TTL 是几十秒级):久隔的同 hash 是同一图表
    // 幂等重发(字节必相同),不是缓存 —— 不带窗口会白等 30s(审查 L3/L4)。
    if (rec && rec.hash && Number.isFinite(rec.ts) && Date.now() - rec.ts < 10 * 60_000) last = rec.hash
  } catch { /* 无记录:信任首拍 */ }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true })
  let hash = null
  for (let i = 0; i < 3; i++) {
    const res = await wb.downloadAsImage({ path: { whiteboard_id: whiteboardId } })
    if (!res || typeof res.writeFile !== 'function') throw new Error('画板导出失败:未返回图片流')
    await res.writeFile(destAbs)
    hash = crypto.createHash('md5').update(fs.readFileSync(destAbs)).digest('hex')
    if (!last || hash !== last) break
    if (i < 2) { process.stderr.write(dim('  (画板导出疑似命中服务端缓存旧图,15s 后重拍)\n')); await new Promise((r) => setTimeout(r, 15_000)) }
  }
  try { fs.mkdirSync(boardOpsDir(), { recursive: true }); fs.writeFileSync(hashFile, JSON.stringify({ hash, ts: Date.now() })) } catch { /* 记录失败不阻断 */ }
}

// 图表 → 紧凑 PNG(--as-image 与交付卡预览共用)。⚠ style_type=2(服务端整图)只支持 PlantUML,
// Mermaid 一律 invalid arg 2890002(2026-07-27 真机枚举坐实 —— v0.7.5 用 style2 做预览因此从未
// 生效过,一直静默回退整板导出+坐标映射裁剪的老路,这就是「预览区域位置对不上」连修三版不见效
// 的真相)。现路线与语法无关:style1 渲染到 scratch(或 skipRender 复用 deliver 流程刚渲好的现场)
// → 导出 scratch(带缓存新鲜度重试)→ trimPngWhitespace 白边裁剪 ⇒ 紧凑图表图。板上只有这张
// 图表,裁掉画布留白即是图表本身,不依赖导出几何规则(2560² 顶对齐 fit + 缩放上限,未公开)。
// trim 不出(全白/收益小/形态不支持)用整板原图 —— 内容仍正确只是多留白,不算失败。
async function renderDiagramToPng(client, scratchWb, spec, safeCode, destAbs, { skipRender = false } = {}) {
  if (!skipRender) {
    const rendered = await renderDiagramToScratch(client, scratchWb, { syntaxType: spec.syntaxType, diagramType: spec.diagramType, styleType: 1, code: safeCode })
    if (!rendered || !rendered.nodes.length) return false
  }
  await exportBoardPngFresh(client, scratchWb, destAbs)
  try {
    const trimmed = trimPngWhitespace(_exportToPngBuf(destAbs))
    if (trimmed) fs.writeFileSync(destAbs, trimmed)
    else process.stderr.write(dim('  (白边裁剪未生效 — 预览用整板导出原图,内容正确但留白较多)\n'))
  } catch (e) { process.stderr.write(dim('  (白边裁剪失败,用整板原图: ' + (e && e.message) + ')\n')) }
  return true
}

// 整板导出真机实测是 JPEG(JFIF 2560×2560,并非文档暗示的 PNG;2026-07-27)—— trim 只解 PNG
// ⇒ darwin 用 sips 转码后再裁(与 boardPreviewImageKey 的 sips 先例同款,零新依赖);已是 PNG
// 直接用;非 darwin 无转码器返回 null,调用方用原图(内容正确只是多留白)。
// ⚠ 暂存必须落 os.tmpdir(),不能写在输入文件旁边:v0.8.1 起 absFile 可能是**群项目 workdir 里的
// 用户交付物**,一旦墙钟树杀 / `/stop` 卡在 sips 与 unlink 之间,`xxx.jpg.trimtmp.png` 就留在仓库里,
// 下次 agent 一个 `git add -A` 提交进去。
function _exportToPngBuf(absFile) {
  const buf = fs.readFileSync(absFile)
  if (buf[0] === 0x89 && buf[1] === 0x50) return buf // PNG 魔数
  if (process.platform !== 'darwin') return null
  const tmp = path.join(os.tmpdir(), `sbot-topng-${process.pid}-${Date.now()}.png`)
  try {
    require('node:child_process').execFileSync('sips', ['-s', 'format', 'png', absFile, '--out', tmp], { stdio: 'ignore', timeout: 15_000 })
    const png = fs.readFileSync(tmp)
    return (png[0] === 0x89 && png[1] === 0x50) ? png : null
  } catch { return null } finally { try { fs.unlinkSync(tmp) } catch { /* 未生成 */ } }
}

// 卡内预览图归一化(v0.8.1):把要塞进卡片的图先压成高宽比 ≤ 1.3 再上传,`fn(路径)` 拿到的
// 可能是临时文件。为什么必须客户端做:cardkit 的 img 只有 `fit_horizontal` 能自适应卡宽,而它
// **不接受 size**(2026-07-29 生产凭证字段探针:size 仅在配 crop_center 时被收,crop 又会切
// 掉手机原型的上下段)⇒ 9:19.5 的竖图渲染出来卡高 ≈2.2 倍卡宽,一张卡刷两屏。见 board.js
// padToMaxAspect 头部。**只动卡内预览** —— 落盘产物、画板节点、sendChatImage 发的原图一律是原图
// (用户要的是原图存档)。绝不阻断交付:补不出来传原图;补出来了但 `fn` 失败,**再用原图跑一遍**
// —— 「一张偏高的卡」远好过「一张没图的卡」,后者比本来要修的缺陷还糟。
const CARD_PREVIEW_MAX_RATIO = 1.3 // 门槛与补边口径同一个数:分开写迟早漂,漂了就是「判要补却补不动」
// 补边后体积闸:飞书 im.image.create 上限 10MB,取 8MB 留 2MB 余量 —— 高熵图(照片/渲染图,尤其
// JPEG 来源经 sips 转 PNG)重编码后会涨到数 MB,审查实测 1170×2532 补到 1948×2532 = 9.73MB,
// 直逼上限。超阈值就别递出去了:那是一次必然失败的上传,换来的只是多一轮重试延迟。
const CARD_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
// padToMaxAspect 的 reason(以及 bin 侧自己的两种)→ 一句能指导排障的中文:是平台限制、图的形态
// 问题,还是尺寸防呆。折成一句「未能补边」运维只能干瞪眼。
const CARD_PREVIEW_WHY = {
  'no-png': '非 PNG 且本机没有转码器(仅 macOS 有 sips)',
  'decode-failed': 'PNG 形态解不开(仅支持位深 8、非隔行)',
  'too-large': '补出来的画布超过 4000² 内存闸',
  'bad-input': '解出的像素平面/尺寸不可用',
  'within-ratio': '解码后的实际比例并未超阈值',
}
async function withCardPreview(absImage, fn) {
  let tmp = null
  try {
    // 先用魔数看比例:横图/方图(绝大多数图表)直接原路上传,不白花一次 PNG 编解码
    const dims = imageSize(fs.readFileSync(absImage))
    if (dims.height / dims.width > CARD_PREVIEW_MAX_RATIO) {
      const png = _exportToPngBuf(absImage) // PNG 直用;JPEG/WebP 在 darwin 走 sips;非 darwin → null
      const d = png ? decodePngRGBA(png) : null
      const r = d ? padToMaxAspect(d.px, d.width, d.height, { maxRatio: CARD_PREVIEW_MAX_RATIO }) : null
      const why = !png ? 'no-png' : (!d ? 'decode-failed' : r.reason)
      if (r && r.padded) {
        const out = encodePngRGBA(r.px, r.width, r.height)
        if (out.length > CARD_PREVIEW_MAX_BYTES) {
          process.stderr.write(dim(`  (补边后 ${(out.length / 1048576).toFixed(1)}MB 超过卡片图上传上限,放弃补边用原图 — 卡会偏高)\n`))
        } else {
          const p = path.join(os.tmpdir(), `sbot-card-preview-${process.pid}-${Date.now()}.png`)
          fs.writeFileSync(p, out)
          tmp = p // 写盘成功**之后**才认:encode/写盘半途抛错时 tmp 仍是 null,不会把半截文件递去上传
          process.stderr.write(dim(`  (卡内预览已补边 ${dims.width}×${dims.height} → ${r.width}×${r.height},原图不受影响)\n`))
        }
      } else process.stderr.write(dim(`  (竖长图未能补边,卡片预览用原图 — 卡会偏高:${CARD_PREVIEW_WHY[why] || why})\n`))
    }
  } catch (e) { process.stderr.write(dim('  (卡内预览归一化跳过,用原图: ' + (e && e.message) + ')\n')) }
  if (!tmp) return await fn(absImage)
  try {
    return await fn(tmp)
  } catch (e) {
    // 补边图这一路失败(最可能:重编码后体积仍撞上传上限、或临时盘满)⇒ 原图再来一次。
    // 不兜的话调用方只拿到 null,主战场就发出一张无图结果卡 —— 比卡偏高严重得多。
    process.stderr.write(dim('  (补边图交付失败,回退原图重试: ' + (e && e.message) + ')\n'))
    return await fn(absImage)
  } finally { try { fs.unlinkSync(tmp) } catch { /* 已清 */ } }
}

// 移植成功后的 --deliver:结果卡预览图。首选「导出 scratch + 白边裁剪」—— deliver 时 scratch
// 上刚渲完这张图表且现场未动(清场在 deliver 之后),skipRender 免重渲直接导出;板上只有这张图,
// 裁掉画布留白即是图表本身(2026-07-27 真机定案:style2 整图仅 PlantUML 支持,整板导出是 2560²
// 顶对齐 fit + 未公开缩放规则 ⇒ 坐标映射裁剪不可靠,白边裁剪不依赖任何导出几何)。scratch 路
// 失败才回退主画板导出聚焦(老路,坐标映射有系统性偏差,聊胜于无);预览失败降级无图卡,绝不
// 阻断交付。每条路都打 stderr 说明预览来源 —— v0.7.5 静默回退让「修复没生效」瞒了三个版本,
// 观测是修这个 bug 的一部分。
async function deliverDiagramCard(client, chatId, mainWb, gBoard, freshIds, { labelOpt, noteOpt, scratchWb = null, spec = null, safeCode = null }) {
  const boardUrl = (gBoard && gBoard.url) || null
  let imgKey = null
  if (scratchWb && spec && safeCode) {
    const os = require('node:os')
    const tmpPng = path.join(os.tmpdir(), `sbot-diagram-preview-${process.pid}-${Date.now()}.png`) // 带 pid:两个群同毫秒 --deliver 会撞名,finally 会删掉对方的图(最坏是 A 群的预览进了 B 群的卡)
    try {
      await renderDiagramToPng(client, scratchWb, spec, safeCode, tmpPng, { skipRender: true }) // skipRender 路只可能 throw、不返回 false(审查 L2:别留永假的 else 死日志)
      imgKey = await withCardPreview(tmpPng, (p) => uploadImage(client, p))
      process.stderr.write(dim('  (预览来源:scratch 导出+白边裁剪)\n'))
    } catch (e) { process.stderr.write(dim('  (scratch 预览失败,回退主画板导出: ' + (e && e.message) + ')\n')) }
    finally { try { fs.unlinkSync(tmpPng) } catch {} }
  }
  if (!imgKey) {
    try {
      const allNodes = await listBoardNodes(client, mainWb) // 移植后主画板全量(定预览映射基准)
      const fresh = new Set(freshIds)
      const freshNodes = allNodes.filter((n) => n && fresh.has(n.id))
      imgKey = await boardPreviewImageKey(client, mainWb, { nodes: allNodes, freshNodes })
      if (imgKey) process.stderr.write(dim('  (预览来源:主画板导出聚焦 — 降级路,位置可能有偏差)\n'))
    } catch (e) { process.stderr.write(dim('  (画板预览生成失败,发无图结果卡: ' + (e && e.message) + ')\n')) }
  }
  try { await deliverResultCard(client, chatId, { imgKey, boardUrl, title: labelOpt || '已按反馈更新图表', note: noteOpt || '' }) } catch (e) { process.stderr.write(dim('  (结果卡交付失败: ' + (e && e.message) + ')\n')) }
}

// 整图路径(显式 --as-image + 移植失败降级共用):scratch style1 渲染 → 导出+白边裁剪 → 下载到
// design/diagrams/<源名>.png(仓库档案)→ board-add-image 同款上传摆放(x/y/beside/label/deliver
// 全支持)。成功返回 true;任何环节缺料返回 false(调用方据此再降级直渲主画板)。
async function runDiagramAsImage(client, cfg, chatId, mainWb, gBoard, scratchWb, { spec, safeCode, srcName, diagPlace, deliverFlag, noteOpt }) {
  try {
    const stem = path.basename(String(srcName || '')).replace(/\.[^.]+$/, '') || 'diagram'
    const outRel = path.join('design', 'diagrams', stem + '.png')
    const outAbs = resolveSendPath(process.cwd(), outRel, false) // 写围栏(镜像 download 系动作)
    if (!await renderDiagramToPng(client, scratchWb, spec, safeCode, outAbs)) return false
    await putImageOnBoard(client, cfg, chatId, mainWb, gBoard, outAbs, { xOpt: diagPlace.xOpt, yOpt: diagPlace.yOpt, besideOpt: diagPlace.besideOpt, labelOpt: diagPlace.labelOpt, deliverFlag, noteOpt, srcLabel: outRel, deliverTitle: '已按反馈更新图表' })
    try { await clearScratchBoard(client, scratchWb) } catch {}
    return true
  } catch (e) {
    process.stderr.write(dim('  (整图上板失败: ' + larkErrMsg(e) + ')\n'))
    if (e && e.scratchDead) { dropScratchPointer(cfg, chatId); process.stderr.write(dim('  (已清除失效的暂存画板指针,下次自动重建)\n')) }
    return false
  }
}

// 最后兜底:直接在主画板渲染(v0.7.0 老路)—— 无位置控制,可能压到现有内容,明确告警。
// deliver 三件套(deliverFlag/noteOpt/chatId+gBoard)可选传入:最深兜底也不丢 --deliver(审查 #3)——
// 发无图结果卡注明降级,别让「处理中」卡没有下文。
async function renderDiagramOnMain(client, mainWb, { syntaxType, diagramType, styleType, code }, labelOpt, { deliverFlag = false, noteOpt = '', chatId = null, gBoard = null } = {}) {
  const before = new Set((await listBoardNodes(client, mainWb)).map((n) => n && n.id).filter(Boolean))
  const rootId = await createBoardDiagram(client, mainWb, { code, syntaxType, diagramType, styleType })
  if (rootId) { try { appendBoardOp(boardOpsDir(), mainWb, { op: 'add', ids: [rootId] }) } catch {} }
  let after = null; let allNew = rootId ? [rootId] : []
  try {
    after = await listBoardNodes(client, mainWb)
    const newIds = after.map((n) => n && n.id).filter((id) => id && !before.has(id))
    if (newIds.length) { allNew = newIds; const extra = newIds.filter((id) => id !== rootId); if (extra.length) { try { appendBoardOp(boardOpsDir(), mainWb, { op: 'add', ids: extra }) } catch {} } }
  } catch (e) { process.stderr.write(dim('  (建图成功但回读节点失败: ' + (e && e.message) + ' — 子节点留痕不全;图已上板,勿重试)\n')) }
  let labelId = null
  if (labelOpt && after) {
    try {
      let box = null
      for (const n of after) {
        if (!n || !allNew.includes(n.id) || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
        const w = Number.isFinite(n.width) ? n.width : 0; const h = Number.isFinite(n.height) ? n.height : 0
        const b = { minX: n.x, minY: n.y, maxX: n.x + w, maxY: n.y + h }
        box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : b
      }
      if (box) { const lblIds = await createBoardNodes(client, mainWb, [boardTextNode('dlbl1', box.minX, box.maxY + 8, Math.max(120, box.maxX - box.minX), 28, redact(labelOpt))]); labelId = lblIds[0]; try { appendBoardOp(boardOpsDir(), mainWb, { op: 'add', ids: lblIds }) } catch {} }
    } catch (e) { process.stderr.write(dim('  (标签放置失败,可忽略: ' + (e && e.message) + ')\n')) }
  }
  process.stderr.write(green('  ✓ 已在主画板渲染图表\n'))
  process.stdout.write(`图表根节点: ${rootId || '?'}  新增 ${allNew.length} 个节点${labelId ? '  标签节点: ' + labelId : ''}\n⚠ 直接渲染在主画板,如与现有内容重叠请在画板上手动拖动。\n`)
  if (deliverFlag && chatId) {
    const degradeNote = (noteOpt ? noteOpt + '\n' : '') + '(注:本次为降级渲染,图表可能与画板已有内容重叠,请在画板上检查位置)'
    try { await deliverResultCard(client, chatId, { boardUrl: (gBoard && gBoard.url) || null, title: labelOpt || '已更新图表', note: degradeNote }) } catch (e) { process.stderr.write(dim('  (结果卡交付失败: ' + (e && e.message) + ')\n')) }
  }
}

// `sbot feishu <action>` — base skill (DESIGN §4.6 群项目基础能力): let a group's agent operate on
// ITS OWN group with sbot's bot identity (same as replies). Actions:
//   send-file/send-image/send-msg — push a file / image / text message
//   history [N]                   — read the last N messages (newest→oldest; default 20)
//   reply <msg_id> <text>         — reply to a message
//   edit <msg_id> <text>          — edit the bot's OWN message
//   recall <msg_id>               — recall (delete) the bot's OWN message
//   download <msg_id> <key> <file|image> [dest] — download an attachment into the project dir
//   react <msg_id> <emoji>        — react with an emoji (THUMBSUP / 👍 …)
//   board-create [--title] [--new] — create the group's design board (Feishu 画板 doc, shared to chat)
//   board-add-image <path> [--beside id] [--x --y --width --height] [--label] [--deliver --note] — put an image onto the board (--deliver 交付结果卡:回填进原播报卡/新发)
//   board-add-diagram <path> [--type <名>] [--syntax mermaid|plantuml] [--as-image] [--beside id] [--x --y] [--label] [--deliver --note] — render a Mermaid/PlantUML diagram (在暂存画板渲染再移植进主画板空白区,位置可控·可删·可标注;--beside 放旧版旁横排对比;--deliver 交付结果卡)
//   board-add-nodes <path.json>   — write structured node JSON onto the board (精细通道:mermaid 表达不了时用)
//   board-nodes [--raw]           — read the board (structured digest of images/arrows/text/paint/shapes/mind-map)
//   board-del-node <id...>        — delete node(s) (annotation cleanup after processing)
//   board-comments [--raw]        — read doc comments (2nd feedback channel; images as tokens)
//   board-resolve-comment <id>    — mark a comment solved (closes the feedback loop)
//   board-get-media <tok> <dest>  — download a board asset / comment image by token
// Target chat = --chat or $SBOT_CHAT_ID (engine injects it). File paths fenced to cwd; outbound
// text (send-msg/reply/edit, board titles/labels, diagram source, node texts) is redacted like engine replies.
// `sbot wecom` — 企业微信群的基础技能(与 `sbot feishu` 同一位置、同一套参数习惯)。发送走官方命令行工具
// (以机器人身份、HTTP 直连;**不能**自己再开一条长连接 —— 同一个机器人只许一条,开了就把 daemon 踢下线)。
// ⚠ 单聊 chat id 两套空间:daemon 从长连接拿到的是明文 userid,命令行工具只认它自己那套(woA2… 形态)
//    ⇒ 不是群(不以 wr 开头)就先用搜人把 userid 换成工具认的那个。
async function cmdWecom(rest) {
  const action = rest[0]
  const rawArgs = rest.slice(1)
  let chatOpt, configOpt
  const positionals = []
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (a === '--chat') chatOpt = rawArgs[++i]
    else if (a.startsWith('--chat=')) chatOpt = a.slice(7)
    else if (a === '--config') configOpt = rawArgs[++i]
    else if (a.startsWith('--config=')) configOpt = a.slice(9)
    else positionals.push(a)
  }
  if (!action || action === '--help' || action === '-h') return helpOut(SUBHELP.wecom)
  const cfg = loadConfig(configOpt)
  if (!cfg.wecom || !cfg.wecom.botId) return die('企业微信机器人未配置(sbot.config.json 缺 wecom.botId / secret)')
  const chatId = chatOpt || process.env.SBOT_CHAT_ID
  if (!chatId) return die('缺少目标群 — 传 --chat <群id> 或设置 env SBOT_CHAT_ID')
  const cliBin = cfg.wecom.cli === false ? null : (cfg.wecom.cli || 'wecom-cli')
  if (!cliBin) return die('企业微信命令行工具已被配置关闭(wecom.cli:false),基础技能不可用')
  // 工具封装(exec / 搜人换算 / 发送 / 上传 / 历史)在 src/platform/wecomcli.js —— 生图 worker 与接管链接 --send 共用同一份
  const wc = createWecomCli({ bin: cliBin })
  try {
    if (action === 'send-msg') {
      const text = positionals.join(' ')
      if (!text.trim()) return die('缺少文本')
      await wc.sendMarkdown(chatId, redact(text))
      process.stdout.write('已发送\n'); return
    }
    if (action === 'send-image' || action === 'send-file') {
      const abs = resolveSendPath(process.cwd(), positionals[0], true)
      if (action === 'send-image') await wc.sendImage(chatId, abs); else await wc.sendFile(chatId, abs)
      process.stdout.write(`已发送 ${path.basename(abs)}\n`); return
    }
    if (action === 'history') {
      const n = Math.min(200, Math.max(1, Number(positionals[0]) || 50)) // 封顶 200:这是给 agent 补上下文用的,不是导出
      if (!/^wr/.test(chatId)) return die('历史只支持群聊')
      const msgs = (await wc.history(chatId)).slice(-n)
      for (const m of msgs) {
        const body = m.msg_type === 'text' ? (m.text && m.text.content) : `[${m.msg_type}]`
        process.stdout.write(`[${m.send_time}] ${m.user_name || m.userid}: ${redact(String(body || '')).replace(/\n/g, ' ')}\n`)
      }
      if (!msgs.length) process.stdout.write('(最近 7 天没有人类发言)\n')
      return
    }
    return die(`未知动作 ${action}\n` + SUBHELP.wecom)
  } catch (e) { return die((e && e.message) || String(e)) }
}

async function cmdFeishu(rest) {
  const action = rest[0]
  // Hand-roll option parsing (not util.parseArgs): send-msg bodies / filenames legitimately start
  // with '-' (Markdown lists like "- item"), which parseArgs(strict) rejects as an unknown option —
  // and the self-knowledge manifest teaches agents exactly that form. Pull out --chat/--config; the
  // rest stays positional (message text / path), leading '-' and all.
  const rawArgs = rest.slice(1)
  let chatOpt, configOpt
  // board-* 专用具名参数(其余动作不受影响;值不会以 '-' 开头,安全)
  let titleOpt, newFlag, xOpt, yOpt, widthOpt, heightOpt, labelOpt, rawFlag, boardOpt, besideOpt, deliverFlag, noteOpt
  let typeOpt, syntaxOpt, asImageFlag // 图表通道(board-add-diagram)专用
  let noCascadeFlag // board-del-node 专用:关掉「删容器连带内容」的展开
  const positionals = []
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (a === '--chat') chatOpt = rawArgs[++i]
    else if (a.startsWith('--chat=')) chatOpt = a.slice(7)
    else if (a === '--config') configOpt = rawArgs[++i]
    else if (a.startsWith('--config=')) configOpt = a.slice(9)
    else if (a === '--title') titleOpt = rawArgs[++i]
    else if (a === '--new') newFlag = true
    else if (a === '--x') xOpt = rawArgs[++i]
    else if (a === '--y') yOpt = rawArgs[++i]
    else if (a === '--width') widthOpt = rawArgs[++i]
    else if (a === '--height') heightOpt = rawArgs[++i]
    else if (a === '--label') labelOpt = rawArgs[++i]
    else if (a === '--raw') rawFlag = true
    else if (a === '--board') boardOpt = rawArgs[++i]
    else if (a === '--beside') besideOpt = rawArgs[++i] // 参照节点 id:新图放它右侧(按标注改的排版)
    else if (a === '--deliver') deliverFlag = true // 交付结果卡:上板 + 回填进原播报卡(单卡)/ 无原卡则新发
    else if (a === '--note') noteOpt = rawArgs[++i] // 结果卡里的一句改动说明
    else if (a === '--type') typeOpt = rawArgs[++i] // 图表类型(flow/mindmap/sequence/… 或中文别名)
    else if (a === '--syntax') syntaxOpt = rawArgs[++i] // 图表语法(mermaid | plantuml;覆盖扩展名识别)
    else if (a === '--as-image') asImageFlag = true // 图表渲染成整张图片(scratch 渲染+导出+白边裁剪;plantuml 兜底可用官方 style2),否则多节点可编辑
    else if (a === '--no-cascade') noCascadeFlag = true // board-del-node:只删点名的,不连带容器内容/导图子树(默认连带)
    else positionals.push(a)
  }
  // Slack 群:引擎注入 SBOT_PLATFORM=slack。飞书这族动作在那儿一概走不通(文件上下行还没接到
  // Slack,docs/SLACK.md 第 3 步)。不拦的话要么打到飞书 API 报 lark 错、要么 feishu 没配时报「未配置」——
  // 两种都不说人话,agent 会转头重试。显式 --chat 指向飞书群的手工用法不拦。
  if (!chatOpt && process.env.SBOT_PLATFORM === 'slack') return die('本群在 Slack 上 —— sbot feishu 的动作(发文件/发图/读历史/回复/编辑/撤回/下载/表情)在 Slack 群暂不可用,Slack 侧文件上下行还没接。要给群成员看的文件或图片:把项目内相对路径与打开方式写进回复正文;不要重试本命令。')
  const cfg = loadConfig(configOpt)
  if (!cfg.feishu || !cfg.feishu.appId || !cfg.feishu.appSecret) return die('feishu 未配置(sbot.config.json 缺 feishu.appId/appSecret)')
  const chatId = chatOpt || process.env.SBOT_CHAT_ID
  if (!chatId) return die('缺少目标群 — 传 --chat <oc_...> 或设置 env SBOT_CHAT_ID')
  applyProxyEnv(cfg)
  const client = feishuClient(cfg.feishu.appId, cfg.feishu.appSecret)
  // 群面出站脱敏(v0.11.6,与 engine 同口径):PII 按群开关(redactPii:false ⇒ 手机号/邮箱明文),
  // 密钥类恒遮盖。只作用于 send-msg/reply/edit 三个群消息通道;画布节点/图表源码等仍全遮。
  const red = (s) => redact(s, { pii: !(cfg.groups && cfg.groups[chatId] && cfg.groups[chatId].redactPii === false) })
  try {
    if (action === 'send-file' || action === 'send-image') {
      const abs = resolveSendPath(process.cwd(), positionals[0])
      if (action === 'send-file') await sendChatFile(client, chatId, abs)
      else await sendChatImage(client, chatId, abs)
      process.stderr.write(green(`  ✓ 已发送${action === 'send-file' ? '文件' : '图片'}到群 `) + dim(chatId) + '  ' + positionals[0] + '\n')
    } else if (action === 'send-msg') {
      const text = positionals.join(' ')
      if (!text.trim()) return die('缺少消息内容 — sbot feishu send-msg "<文本>"')
      await sendChatText(client, chatId, red(text)) // 出站脱敏,与 engine 群回复同口径(PII 按群)
      process.stderr.write(green('  ✓ 已发送消息到群 ') + dim(chatId) + '\n')
    } else if (action === 'history') {
      const n = positionals[0] ? parseInt(positionals[0], 10) : 20
      const msgs = await fetchChatHistory(client, chatId, n)
      const tz = normalizeTz(cfg.timezone)
      // @ 标记(裁决在 feishu.js 的 historyAtMark,这里只消费):「@了别人未@bot」的消息按设计不触发轮次,
      // 历史里不标就与真问 bot 的长得一模一样 —— 排查者与 agent 都吃过这个亏。bot 自己的 open_id 从配置来。
      const botOid = String((cfg.feishu && cfg.feishu.botOpenId) || '')
      const lines = msgs.map((m) => {
        const who = m.senderType === 'app' ? 'bot' : (m.senderId || '?')
        const body = m.text != null ? m.text : `(${m.msgType})`
        return `[${m.createTimeMs ? fmtStamp(m.createTimeMs, tz) : '?'} ${who}${historyAtMark(m.mentions, botOid)}] ${body}  {${m.msgId}}`
      })
      // 群消息内容是入站上下文(给 agent 读),不脱敏;message_id 用于后续 reply/edit/recall
      process.stdout.write(`共 ${msgs.length} 条群消息(新→旧):\n` + (lines.join('\n') || '(空)') + '\n')
    } else if (action === 'reply') {
      const msgId = positionals[0]; const text = positionals.slice(1).join(' ')
      if (!msgId || !text.trim()) return die('用法: sbot feishu reply <message_id> "<文本>"')
      await replyMessage(client, msgId, red(text))
      process.stderr.write(green('  ✓ 已回复消息 ') + dim(msgId) + '\n')
    } else if (action === 'edit') {
      const msgId = positionals[0]; const text = positionals.slice(1).join(' ')
      if (!msgId || !text.trim()) return die('用法: sbot feishu edit <message_id> "<文本>"(仅能编辑 bot 自己发的消息)')
      await editMessage(client, msgId, red(text))
      process.stderr.write(green('  ✓ 已编辑消息 ') + dim(msgId) + '\n')
    } else if (action === 'recall' || action === 'delete') {
      const msgId = positionals[0]
      if (!msgId) return die('用法: sbot feishu recall <message_id>(仅能撤回 bot 自己发的消息)')
      await recallMessage(client, msgId)
      process.stderr.write(green('  ✓ 已撤回消息 ') + dim(msgId) + '\n')
    } else if (action === 'download') {
      const msgId = positionals[0]; const fileKey = positionals[1]; const type = positionals[2]
      const dest = positionals[3] || fileKey
      if (!msgId || !fileKey) return die('用法: sbot feishu download <message_id> <file_key> <file|image> [目标相对路径]')
      const abs = resolveSendPath(process.cwd(), dest, false) // 写模式:目标文件尚不存在
      await downloadResource(client, msgId, fileKey, type === 'image' ? 'image' : 'file', abs)
      process.stderr.write(green('  ✓ 已下载到 ') + dim(dest) + '\n')
    } else if (action === 'react') {
      const msgId = positionals[0]; const emoji = positionals[1]
      if (!msgId || !emoji) return die('用法: sbot feishu react <message_id> <emoji>(如 THUMBSUP / 👍)')
      await reactMessage(client, msgId, emoji)
      process.stderr.write(green('  ✓ 已回应 ') + dim(msgId) + ' ' + emoji + '\n')
    } else if (action === 'board-create') {
      // 群设计画布(docs/BOARD.md):建 docx+画板块 → openchat 分享本群(edit)→ 放使用说明便签
      // → 挂群标签页(失败降级,不阻断)→ 写回 groups[chatId].board(cron 同款锁写)。
      // 已有画布报现有链接不重建(防 agent 重复建文档),--new 才另建(旧文档保留)。
      if (!cfg.groups || !cfg.groups[chatId]) return die(`群 ${chatId} 未绑定项目 — 先在控制台「群·项目」绑定`)
      const existing = cfg.groups[chatId].board
      if (existing && existing.url && !newFlag) {
        process.stdout.write(`本群已有画布:${existing.url}\n(重建用 board-create --new;旧画布文档会保留,只是不再是「当前画布」)\n`)
        return
      }
      const title = redact(titleOpt || `${cfg.groups[chatId].name || '群'} · 设计画布`) // 出站文本,脱敏与群回复一致
      const { docToken, whiteboardId, url } = await createBoardDoc(client, { title })
      await shareDocWithChat(client, docToken, chatId)
      // 使用说明便签(确定性拼装,零模型成本):用户第一次打开画板就知道怎么标注、怎么触发
      try {
        const noteIds = await createBoardNodes(client, whiteboardId, boardUsageNoteNodes())
        try { appendBoardOp(boardOpsDir(), whiteboardId, { op: 'add', ids: noteIds }) } catch {} // 留痕失败不阻断
      } catch (e) { process.stderr.write(dim('  (使用说明便签放置失败,可忽略:' + larkErrMsg(e) + ')\n')) }
      // 群标签页 = 常驻入口(免翻聊天记录);scope 未开等失败只降级提示,绝不让建画布整体失败
      let tabOk = false
      try { await addChatTabDoc(client, chatId, url, title); tabOk = true } catch (e) { process.stderr.write(dim('  (挂群标签页失败,可忽略:' + larkErrMsg(e) + ')\n')) }
      // 画布自动感知:按画板订阅变更事件(daemon 启动也会补订,双保险;失败降级)
      try { await subscribeBoard(client, whiteboardId) } catch (e) { process.stderr.write(dim('  (画布事件订阅失败,可忽略:' + larkErrMsg(e) + ')\n')) }
      const p = cfg._path
      if (p) {
        withFileLock(p, () => {
          const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
          raw.groups = raw.groups || {}; raw.groups[chatId] = raw.groups[chatId] || {}
          // 保留既有 scratch 指针(--new 重建主画布不该把渲染暂存板一起丢成孤儿文档;审计观察)
          const prevScratch = raw.groups[chatId].board && raw.groups[chatId].board.scratch
          raw.groups[chatId].board = { docToken, whiteboardId, url, createdAt: new Date().toISOString(), ...(prevScratch ? { scratch: prevScratch } : {}) }
          atomicWriteJSON(p, raw)
        })
      }
      process.stderr.write(green('  ✓ 已创建本群设计画布') + (tabOk ? '(已挂到群标签页)' : '') + '\n')
      process.stdout.write(`画布链接:${url}\n(请把链接发到群里;之后用 board-add-image 放图)\n`)
    } else if (action === 'board-get-media') {
      // 下载画板素材 / 评论附图(通用 medias download;token 来自 board-nodes 的图节点或
      // board-comments 的附图清单)。目标路径围栏写模式。
      const tok = positionals[0]; const dest = positionals[1]
      if (!tok || !dest) return die('用法: sbot feishu board-get-media <素材token> <目标相对路径>')
      const abs = resolveSendPath(process.cwd(), dest, false)
      await downloadBoardMedia(client, tok, abs)
      process.stderr.write(green('  ✓ 已下载素材到 ') + dim(dest) + '\n')
    } else if (action === 'board-comments' || action === 'board-resolve-comment') {
      // 评论 = 画布的第二条意见通道(锚点 [画板]/[图片];附图为裸 token 走 board-get-media 下载)。
      const gBoard = cfg.groups && cfg.groups[chatId] && cfg.groups[chatId].board
      if (!gBoard || !gBoard.docToken) return die('本群还没有设计画布 — 先 sbot feishu board-create')
      if (action === 'board-comments') {
        const items = await listBoardComments(client, gBoard.docToken)
        if (rawFlag) { process.stdout.write(JSON.stringify(items, null, 2) + '\n'); return }
        const d = digestComments(items)
        process.stdout.write(`画布评论(未解决 ${d.lines.length}${d.truncated ? ',已截断' : ''} / 共 ${d.total}):\n` + (d.lines.join('\n') || '(无未解决评论)') + '\n')
        if (d.imageTokens && d.imageTokens.length) process.stdout.write(`评论附图 ${d.imageTokens.length} 张: ${d.imageTokens.join(' ')}\n(下载: sbot feishu board-get-media <图token> "<目标相对路径>")\n`)
      } else {
        const cid = positionals[0]
        if (!cid) return die('用法: sbot feishu board-resolve-comment <评论id>(id 见 board-comments 输出)')
        await resolveBoardComment(client, gBoard.docToken, cid, true)
        process.stderr.write(green('  ✓ 已标记评论已解决 ') + dim(cid) + '\n')
      }
    } else if (action === 'board-add-image' || action === 'board-add-diagram' || action === 'board-add-nodes' || action === 'board-nodes' || action === 'board-del-node') {
      // 这些动作共用画布定位:--board 显式覆盖,否则读本群配置(未建 ⇒ 报人话)
      const gBoard = cfg.groups && cfg.groups[chatId] && cfg.groups[chatId].board
      const whiteboardId = boardOpt || (gBoard && gBoard.whiteboardId)
      if (!whiteboardId) return die('本群还没有设计画布 — 先 sbot feishu board-create 创建(或传 --board <画板id>)')
      if (action === 'board-add-image') {
        if (!positionals[0]) return die('用法: sbot feishu board-add-image "<图片相对路径>" [--beside <参照节点id>] [--x --y --width --height] [--label "方案1"] [--deliver --note "改动说明"]')
        const abs = resolveSendPath(process.cwd(), positionals[0])
        // 提炼共享:魔数尺寸 → 摆放三档 → 上传 → 写 image 节点(+标签)→ ops 留痕 → 可选 --deliver 结果卡
        // (与图表 as-image 降级同一路径,不复制两份)
        await putImageOnBoard(client, cfg, chatId, whiteboardId, gBoard, abs, { xOpt, yOpt, widthOpt, heightOpt, besideOpt, labelOpt, deliverFlag, noteOpt, srcLabel: positionals[0] })
      } else if (action === 'board-add-diagram') {
        // 图表通道(v0.7.2 移植重构):端点无位置参数、Mermaid 容器子节点删不掉(v0.7.0 真机两病)⇒
        // 让 plantuml 端点只在群里看不见的 scratch 画板上渲染,读回后净化+平移成普通节点批量搬进主画板
        // 算定的空白区 ⇒ 位置可控·可删·可标注吸附。降级梯子:可编辑移植 → 整图 as-image(位置仍可控·
        // 单节点可删,丢可编辑性)→ scratch 建不出/渲染不了 → 直渲主画板(老路,可能压内容,明确告警)。
        if (!positionals[0]) return die('用法: sbot feishu board-add-diagram "<图源码相对路径>" [--type flow|mindmap|sequence|class|er|component|usecase|activity] [--syntax mermaid|plantuml] [--as-image] [--beside <参照节点id>] [--x --y] [--label "文案"] [--deliver --note "说明"]')
        const abs = resolveSendPath(process.cwd(), positionals[0]) // mustExist,cwd 围栏
        const spec = diagramSpec(positionals[0], { type: typeOpt, syntax: syntaxOpt, asImage: asImageFlag }) // 校验+枚举映射(中文报错)
        const code = fs.readFileSync(abs, 'utf8')
        if (!code.trim()) return die('图表源码为空 —— 请检查文件内容')
        const safeCode = redact(code) // 出站脱敏:源码里若含密钥/PII 也不外泄
        if (safeCode.length > 1_000_000) return die(`图表源码 ${safeCode.length} 字符,超过 100 万上限 —— 请精简`)
        const diagPlace = { xOpt, yOpt, besideOpt, labelOpt }
        // 准备 scratch(建不出则整段降级直渲主画板)
        let scratchWb = null
        try { scratchWb = await ensureScratchBoard(client, cfg, chatId) } catch (e) { process.stderr.write(dim('  (暂存画板准备失败:' + larkErrMsg(e) + ' — 降级直接在主画板渲染)\n')) }
        // 显式 --as-image:scratch 渲染整图 → 下载 → board-add-image 同款上传摆放(位置可控、单节点可删)
        if (asImageFlag) {
          if (scratchWb && await runDiagramAsImage(client, cfg, chatId, whiteboardId, gBoard, scratchWb, { spec, safeCode, srcName: positionals[0], diagPlace, deliverFlag, noteOpt })) { /* done */ }
          else { process.stderr.write(dim('  (as-image 路径不可用 — 降级直接在主画板渲染整图)\n')); await renderDiagramOnMain(client, whiteboardId, { ...spec, code: safeCode }, labelOpt, { deliverFlag, noteOpt, chatId, gBoard }) }
        } else if (scratchWb) {
          // 默认:可编辑移植
          let rendered = null
          try { rendered = await renderDiagramToScratch(client, scratchWb, { ...spec, code: safeCode }) } catch (e) {
            process.stderr.write(dim('  (暂存画板渲染失败:' + larkErrMsg(e) + ')\n'))
            if (e && e.scratchDead) { dropScratchPointer(cfg, chatId); process.stderr.write(dim('  (已清除失效的暂存画板指针,下次自动重建)\n')) }
          }
          let done = false
          if (rendered && rendered.nodes.length) {
            try {
              const r = await transplantDiagram(client, whiteboardId, rendered.nodes, diagPlace)
              try { appendBoardOp(boardOpsDir(), whiteboardId, { op: 'add', ids: r.ids }) } catch {} // 自编辑留痕(轮询不自问自答)
              process.stderr.write(green('  ✓ 已生成图表并移植到画布 ') + dim(positionals[0]) + '\n')
              // 报「图表本体节点数 + 首个图形 id」——「根」必须是图形而非组 id,用户下次 --beside 要拿它当参照。
              // 打组是尽力而为(被拒会退散节点),故如实按 r.groupId 分叉措辞,不宣传没发生的事。
              process.stdout.write(`图表已移植:${r.nodeIds.length} 个节点(根 ${r.nodeIds[0] || '?'})  at(${Math.round(r.box.minX)},${Math.round(r.box.minY)})  摆放=${r.tier}${r.labelIncluded ? '  含标签' : ''}${r.groupId ? `  组 ${r.groupId}` : ''}\n新图表已放进画板空白区、不会压到现有内容${r.groupId ? ',且已打组(画板上可整体拖动,组内图形仍可单独编辑/标注;要整张删掉传组 id 即可连带全部成员)' : '(本次未打组,图形是各自独立的节点)'};要与旧版横排对比,下次加 --beside <本图任意节点id>。\n`)
              // 交付预览直接导出 scratch(现场就是这张图表,免重渲;主画板刚写入且播报时导出过,
              // 服务端导出缓存必是旧快照,故不取主板)—— 清场必须放在 deliver 之后。
              if (deliverFlag) await deliverDiagramCard(client, chatId, whiteboardId, gBoard, r.ids, { labelOpt, noteOpt, scratchWb, spec, safeCode })
              try { await clearScratchBoard(client, scratchWb) } catch {} // 尽力清场
              done = true
            } catch (e) { process.stderr.write(dim('  (可编辑移植失败:' + larkErrMsg(e) + ' — 降级为整图上板,位置仍可控但丢失可编辑性)\n')) }
          }
          // 移植失败/无产出 → as-image 降级 → 仍不行则直渲主画板
          if (!done) {
            if (await runDiagramAsImage(client, cfg, chatId, whiteboardId, gBoard, scratchWb, { spec, safeCode, srcName: positionals[0], diagPlace, deliverFlag, noteOpt })) { /* done */ }
            else { process.stderr.write(dim('  (暂存移植与整图降级均不可用 — 直接在主画板渲染,可能与现有内容重叠)\n')); await renderDiagramOnMain(client, whiteboardId, { ...spec, code: safeCode }, labelOpt, { deliverFlag, noteOpt, chatId, gBoard }) }
          }
        } else {
          // scratch 建不出:直渲主画板(v0.7.0 老路)
          await renderDiagramOnMain(client, whiteboardId, { ...spec, code: safeCode }, labelOpt, { deliverFlag, noteOpt, chatId, gBoard })
        }
      } else if (action === 'board-add-nodes') {
        // 精细通道:直接写结构化节点 JSON(mermaid 表达不了时用 —— 60+ composite_shape 图形 / 自由
        // 布局 / 结构化 mind_map / section 分区)。非 overwrite;已知文本字段过 redact,不碰 id/token/type。
        if (!positionals[0]) return die('用法: sbot feishu board-add-nodes "<节点JSON相对路径>"(文件内容 {nodes:[…]} 或裸数组)')
        const abs = resolveSendPath(process.cwd(), positionals[0]) // mustExist,cwd 围栏
        let parsed
        try { parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) } catch (e) { return die('节点 JSON 解析失败:' + (e && e.message)) }
        const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.nodes) ? parsed.nodes : null)
        if (!arr) return die('节点 JSON 格式不对:应为 {nodes:[…]} 或裸数组')
        if (!arr.length) return die('节点数组为空 —— 至少要有 1 个节点')
        if (arr.length > 3000) return die(`节点过多(${arr.length}),上限 3000 —— 请拆分`)
        const safe = redactNodeTexts(arr, redact) // 只脱敏已知文本字段(text 键的字符串值)
        const ids = await createBoardNodes(client, whiteboardId, safe)
        try { appendBoardOp(boardOpsDir(), whiteboardId, { op: 'add', ids }) } catch {}
        process.stderr.write(green('  ✓ 已写入画布节点 ') + dim(positionals[0]) + '\n')
        process.stdout.write(`新增 ${ids.length} 个节点: ${ids.join(' ')}\n(位置由传入坐标决定;服务端会改写节点 id,以上为持久 id)\n`)
      } else if (action === 'board-nodes') {
        const nodes = await listBoardNodes(client, whiteboardId)
        if (rawFlag) { process.stdout.write(JSON.stringify(nodes, null, 2) + '\n'); return }
        const d = digestNodes(nodes)
        process.stdout.write(`画布节点(共 ${d.total}${d.truncated ? ',仅列前 ' + d.lines.length + ' 条,全量加 --raw' : ''}):\n` + (d.lines.join('\n') || '(空画布)') + '\n')
      } else { // board-del-node(外层条件已限定动作集,此分支必为 board-del-node)
        const ids = positionals
        if (!ids.length) return die('用法: sbot feishu board-del-node <节点id> [更多id…] [--no-cascade]\n  · 一次可传多个 id —— 无论几个都只重写画板一次(省飞书 API 调用,也别循环调用)\n  · 传「组 id」即删整张图表(连带全部成员);传导图节点即连带其整棵子树;成员被删光的空组自动清掉\n  · --no-cascade 只删点名的这些(可能留下悬空子节点或空组)')
        const { deleted: dropped, keepIds, cascaded } = await deleteBoardNodes(client, whiteboardId, ids, { cascade: !noCascadeFlag })
        // 自编辑留痕:overwrite 后全部节点 id 变,rewrite 留痕带全量新 id ⇒ 轮询基线整体重置
        try { appendBoardOp(boardOpsDir(), whiteboardId, { op: 'rewrite', ids: keepIds }) } catch {}
        // 删除前存档(拍板 2026-07-21):被删节点完整 JSON 追加到项目 design/board-history.jsonl。
        // 画布保持整洁(删),标注史随项目进 git(留)—— 三层可追溯:群内复述 / jsonl / git 历史。
        try {
          const dir = path.join(process.cwd(), 'design')
          fs.mkdirSync(dir, { recursive: true })
          fs.appendFileSync(path.join(dir, 'board-history.jsonl'), JSON.stringify({ ts: new Date().toISOString(), whiteboardId, deleted: dropped }) + '\n')
          process.stderr.write(green('  ✓ 已删除画布节点 ') + dim(ids.join(' ')) + dim('(已存档 design/board-history.jsonl)') + '\n')
        } catch (e) {
          process.stderr.write(green('  ✓ 已删除画布节点 ') + dim(ids.join(' ')) + dim('(存档失败,可忽略:' + (e && e.message) + ')') + '\n')
        }
        // stdout = agent 读的。如实报连带了多少(删除是破坏性动作,绝不静默扩大),并挑明「id 已全变」——
        // 这是逐个删除的成因:拿旧 id 再删必失败,于是每轮重读、每轮重写。一次删完就不用管新 id。
        const n = dropped.length
        process.stdout.write(`已删除 ${n} 个节点${cascaded && cascaded.length ? `(其中 ${cascaded.length} 个是连带删除:容器成员/导图子树/被清空的组)` : ''},剩余 ${keepIds.length} 个;本次只重写画板 1 次。\n`
          + `⚠ 画板已全量重写,**所有剩余节点的 id 都已改变** —— 若还要接着操作画布,必须先重新 sbot feishu board-nodes;正常情况下你应该一次就删完了,不要循环调用本命令。\n`)
      }
    } else {
      die(`unknown feishu action '${action || ''}' (send-file | send-image | send-msg | history | reply | edit | recall | download | react | board-create | board-add-image | board-add-diagram | board-add-nodes | board-nodes | board-del-node | board-comments | board-resolve-comment | board-get-media)`)
    }
  } catch (e) {
    die('feishu 操作失败:' + (larkErrMsg ? larkErrMsg(e) : e && e.message))
  }
}

// Delete one cron task (used by the daemon to reap a one-off after it fires). Cross-process
// lock so it can't clobber a concurrent `sbot cron` edit from an agent.
function removeCronTask(cfgPath, chatId, id, log = () => {}) {
  if (!cfgPath) return
  try {
    withFileLock(cfgPath, () => {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      const g = raw.groups && raw.groups[chatId]
      if (!g || !Array.isArray(g.crons)) return
      const i = g.crons.findIndex((c) => c.id === id)
      if (i >= 0) { g.crons.splice(i, 1); atomicWriteJSON(cfgPath, raw) }
    })
  } catch (e) { log('cron 一次性清理失败: ' + (e && e.message)) }
}

// `sbot cron <action>` — 定时任务 base skill: let a group's agent schedule work on ITS OWN group.
//   add "<cron>" --do "<指令>"   到点触发 agent 执行(回群),或
//   add "<cron>" --say "<文本>"  到点只发一条消息(不起 agent)
//   update <id> [--expr "<cron>"] [--do/--say "<文本>"] [--note ..]   改时间/类型/内容
//   list · remove <id> · on <id> · off <id>
// Stored per-group at groups[chatId].crons; the daemon's scheduler picks them up on the next
// config hot-reload. Writes go through a file lock so two groups editing concurrently can't
// clobber each other. cron accepts standard 5-field, @aliases, and 「每天 09:00」 shorthands.
// 任务类型的人话标签(add 回执与 list 共用一份,别各写各的)
function cronKindLabel(kind) { return kind === 'do' ? '[触发]' : kind === 'run' ? '[跑脚本]' : '[发消息]' }

async function cmdCron(rest) {
  const action = rest[0]
  const args = rest.slice(1)
  let chatOpt, configOpt, doText, sayText, runText, note, exprOpt, atOpt, timeoutMin, escalate
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--chat') chatOpt = args[++i]
    else if (a.startsWith('--chat=')) chatOpt = a.slice(7)
    else if (a === '--config') configOpt = args[++i]
    else if (a.startsWith('--config=')) configOpt = a.slice(9)
    else if (a === '--do') doText = args[++i]
    else if (a === '--say') sayText = args[++i]
    else if (a === '--run') runText = args[++i] // 脚本任务(v0.11.103):到点直接跑命令,不起 agent
    else if (a === '--timeout') timeoutMin = Number(args[++i])
    else if (a === '--escalate') escalate = true
    else if (a === '--no-escalate') escalate = false
    else if (a === '--note') note = args[++i]
    else if (a === '--expr') exprOpt = args[++i]
    else if (a === '--at') atOpt = args[++i] // 一次性:YYYY-MM-DD HH:mm
    else positionals.push(a)
  }
  const cfg = loadConfig(configOpt)
  const chatId = chatOpt || process.env.SBOT_CHAT_ID
  if (!chatId) return die('缺少目标群 — 传 --chat <oc_...> 或设置 env SBOT_CHAT_ID')
  const p = cfg._path
  if (!p) return die('找不到配置文件')
  if (!cfg.groups || !cfg.groups[chatId]) return die(`群 ${chatId} 未绑定项目 — 先在控制台「群·项目」绑定`)

  // read-modify-write under a cross-process lock (concurrent `sbot cron` from other groups
  // must serialize, not clobber). fn(crons) mutates the array; returning { write:false }
  // skips the write (e.g. id not found).
  const mutate = (fn) => withFileLock(p, () => {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    raw.groups = raw.groups || {}
    raw.groups[chatId] = raw.groups[chatId] || {}
    const g = raw.groups[chatId]
    g.crons = Array.isArray(g.crons) ? g.crons : []
    const r = fn(g.crons) || {}
    if (r.write !== false) atomicWriteJSON(p, raw)
    return r
  })

  if (action === 'add') {
    const isOnce = atOpt !== undefined
    let norm, normAt
    if (isOnce) {
      if (positionals[0] || exprOpt !== undefined) return die('--at(一次性) 与 cron 表达式二选一')
      try { normAt = normalizeAt(atOpt) } catch (e) { return die(e && e.message) }
    } else {
      // 表达式两种写法都认:位置参数(清单教的)与 --expr(update 用的同名参数,README 与旧 help 也这么写过)。
      // 此前只认位置参数,而 help 教的偏偏是 --expr ⇒ 照 help 敲必失败。
      // 两处都给且不一样 ⇒ 拒,别静默取其一(审查逮到:位置参数悄悄赢,--expr 那份被丢)
      if (positionals[0] && exprOpt !== undefined && positionals[0] !== exprOpt) return die('时间表达式只给一处:位置参数或 --expr,两处给了不同的值')
      const expr = positionals[0] || exprOpt
      if (!expr) return die('用法: sbot cron add "<cron 或 每天 9:00>" (--do|--say),或一次性 --at "<YYYY-MM-DD HH:mm>" (--do|--say)')
      try { norm = normalizeCron(expr) } catch (e) { return die(e && e.message) }
    }
    if (!doText && !sayText && !runText) return die('需指定 --do "<到点让你做的事>"(触发 agent)、--say "<文本>"(到点只发消息)或 --run "<命令>"(到点直接跑脚本)')
    if ([doText, sayText, runText].filter((x) => x !== undefined).length > 1) return die('--do / --say / --run 三选一')
    if (timeoutMin !== undefined && !(timeoutMin > 0)) return die('--timeout 要给正数(分钟)')
    if ((timeoutMin !== undefined || escalate !== undefined) && !runText) return die('--timeout / --escalate 只对 --run 有意义')
    const id = crypto.randomBytes(4).toString('hex') // 群间全局唯一,避免 id 撞
    const kind = doText !== undefined ? 'do' : sayText !== undefined ? 'say' : 'run'
    const text = doText ?? sayText ?? runText
    const task = isOnce
      ? { id, at: normAt, once: true, kind, text, enabled: true }
      : { id, expr: norm, kind, text, enabled: true }
    if (note) task.note = note
    if (timeoutMin) task.timeoutMin = timeoutMin
    if (escalate) task.escalate = true
    mutate((crons) => { crons.push(task); return {} })
    const when = isOnce ? normAt + '(一次)' : norm
    process.stderr.write(green('  ✓ 已创建定时任务 ') + dim(id) + '  ' + when + '  ' + cronKindLabel(kind) + ' ' + task.text.slice(0, 40) + '\n')
  } else if (action === 'list') {
    const crons = (cfg.groups[chatId].crons) || []
    if (!crons.length) { process.stdout.write('本群暂无定时任务\n'); return }
    process.stdout.write(`本群定时任务(${crons.length}):\n` + crons.map((c) =>
      `  ${c.enabled === false ? '○停用' : '●启用'}  ${c.id}  ${describeTask(c)}${c.at ? '(一次)' : ''}  ${cronKindLabel(c.kind)} ${String(c.text || '').slice(0, 50)}${c.note ? '  — ' + c.note : ''}`
    ).join('\n') + '\n')
  } else if (action === 'remove' || action === 'rm' || action === 'delete') {
    const id = positionals[0]
    if (!id) return die('用法: sbot cron remove <id>')
    const r = mutate((crons) => { const i = crons.findIndex((c) => c.id === id); if (i < 0) return { write: false, notFound: true }; crons.splice(i, 1); return {} })
    if (r.notFound) return die(`未找到定时任务 ${id}(用 sbot cron list 查看)`)
    process.stderr.write(green('  ✓ 已删除定时任务 ') + dim(id) + '\n')
  } else if (action === 'on' || action === 'off') {
    const id = positionals[0]
    if (!id) return die(`用法: sbot cron ${action} <id>`)
    const r = mutate((crons) => { const c = crons.find((x) => x.id === id); if (!c) return { write: false, notFound: true }; c.enabled = action === 'on'; return {} })
    if (r.notFound) return die(`未找到定时任务 ${id}`)
    process.stderr.write(green(`  ✓ 已${action === 'on' ? '启用' : '停用'}定时任务 `) + dim(id) + '\n')
  } else if (action === 'update' || action === 'edit') {
    const id = positionals[0]
    if (!id) return die('用法: sbot cron update <id> [--expr "<cron>"] [--do "<文本>"|--say "<文本>"] [--note "<备注>"]')
    if ([doText, sayText, runText].filter((x) => x !== undefined).length > 1) return die('--do / --say / --run 三选一')
    if (timeoutMin !== undefined && !(timeoutMin > 0)) return die('--timeout 要给正数(分钟)')
    if (runText !== undefined && !String(runText).trim()) return die('--run 的命令不能为空')
    let normExpr, normAt
    if (exprOpt !== undefined) { try { normExpr = normalizeCron(exprOpt) } catch (e) { return die(e && e.message) } }
    if (atOpt !== undefined) { try { normAt = normalizeAt(atOpt) } catch (e) { return die(e && e.message) } }
    if (normExpr && normAt) return die('--expr(循环) 与 --at(一次性) 二选一')
    if (!normExpr && !normAt && !doText && !sayText && runText === undefined && note === undefined && timeoutMin === undefined && escalate === undefined) return die('没有要修改的字段 — 用 --expr / --at / --do / --say / --run / --note / --timeout / --escalate')
    const r = mutate((crons) => {
      const c = crons.find((x) => x.id === id)
      if (!c) return { write: false, notFound: true }
      if (normExpr) { c.expr = normExpr; delete c.at; delete c.once } // 转为循环
      if (normAt) { c.at = normAt; c.once = true; delete c.expr }      // 转为一次性
      if (doText) { c.kind = 'do'; c.text = doText }
      else if (sayText) { c.kind = 'say'; c.text = sayText }
      else if (runText !== undefined) { c.kind = 'run'; c.text = runText }
      if (note !== undefined) { if (note) c.note = note; else delete c.note }
      // 脚本任务专属两项:给到非 run 任务 ⇒ 拒(与 add 同一口径,别静默丢);换成 do/say 时一并清掉,免得配置里留着没意义的字段
      if (c.kind !== 'run' && (timeoutMin !== undefined || escalate !== undefined)) return { write: false, notRun: true }
      if (c.kind !== 'run') { delete c.timeoutMin; delete c.escalate }
      else {
        if (timeoutMin !== undefined) c.timeoutMin = timeoutMin
        if (escalate !== undefined) { if (escalate) c.escalate = true; else delete c.escalate }
      }
      return {}
    })
    if (r.notFound) return die(`未找到定时任务 ${id}(用 sbot cron list 查看)`)
    if (r.notRun) return die('--timeout / --escalate 只对 --run 任务有意义(这条不是,或先用 --run 改成脚本任务)')
    process.stderr.write(green('  ✓ 已更新定时任务 ') + dim(id) + '\n')
  } else {
    die(`unknown cron action '${action || ''}' (add | list | update | remove | on | off)`)
  }
}

// ── sbot design — 设计风格档基础技能(src/design.js 放纯逻辑,这里只接线)────────────────
//   styles                                        列出可用风格预设(内置 + ~/.sbot/design-styles 自定义)
//   use <slug> [--out <相对路径>] [--force]        把预设落成项目的风格档(默认根 DESIGN.md)
//   swatch <slug…> [--current] [--out <x.png>]    风格可视化:tokens → 微缩界面预览图(发群里让人选)
//   extract-colors <图片相对路径> [--n 6] [--json] 从参考图统计主色板(写进风格档的 colors tokens)
// 风格档 = 群设计工作流的风格持久层:front matter 放 tokens,正文写氛围与 Do's and Don'ts;
// 生图/出图表前必读(imagen 也把它的路径喂给生图后端 —— 探测走 design.findStyleDoc,与落盘
// 裁决同一套认帧,承诺范围就是「根 DESIGN.md / design/DESIGN.md」这两个位置)。
const { BUILTIN_STYLES_DIR, userStylesDir } = design // 目录口径住 src/design.js:控制台列风格库要用同一份

// 参考图 → 可解码的 PNG buffer。手写解码器只吃「位深 8 / 非隔行」PNG,且逐像素统计怕超大图 ⇒
// 非 PNG / 长边超限 / 尺寸认不出(GIF、BMP 等 imageSize 不认的格式)时,darwin 走系统 sips
// 转码+缩放(与 _exportToPngBuf 同款,零新依赖);非 darwin 无转码器 ⇒ 抛中文人话让用户自己转。
// force=true:PNG 也强制过一遍 sips —— 给「解码失败(16 位/隔行/低位深调色板)」当归一化重试。
function readImageAsPng(absFile, { force = false } = {}) {
  const buf = fs.readFileSync(absFile)
  const isPng = buf[0] === 0x89 && buf[1] === 0x50
  let dims = null
  try { dims = imageSize(buf) } catch { /* 未知格式:尺寸不明,下面一律按需缩放 */ }
  const tooBig = !dims || Math.max(dims.width, dims.height) > 1600
  if (isPng && !tooBig && !force) return buf
  if (process.platform !== 'darwin') {
    throw new Error(isPng
      ? (dims ? `图片 ${dims.width}×${dims.height} 太大(长边上限 1600)—— 请先缩小再试` : '这张 PNG 解不开 —— 请用系统工具另存一版(位深 8、非隔行)再试')
      : '只能直接解 PNG —— 请先把参考图转成 PNG,或在 macOS 上运行(会自动用系统 sips 转码)')
  }
  const tmp = path.join(os.tmpdir(), `sbot-palette-${process.pid}-${Date.now()}.png`)
  try {
    // -Z 只在「已知超限」或「尺寸不明」时加:sips -Z 会把小图**放大**到该边长(实测 40² → 1600²),
    // 无谓插值出并不存在的中间色、污染色板 —— 尺寸不明的格式仍必须加,否则 8000² 的 GIF 会转出
    // 巨图再被解码器的 3000² 防呆挡下,报出一句驴唇不对马嘴的错。
    const args = ['-s', 'format', 'png']
    if (tooBig) args.push('-Z', '1600')
    require('node:child_process').execFileSync('sips', [...args, absFile, '--out', tmp], { stdio: 'ignore', timeout: 20_000 })
    return fs.readFileSync(tmp)
  } catch (e) {
    throw new Error('图片转码失败(sips):' + (e && e.message))
  } finally { try { fs.unlinkSync(tmp) } catch { /* 未生成 */ } }
}

// ── 布局体检的浏览器接线(纯逻辑在 src/design.js;这里只负责把探针送进真实渲染引擎)──
// ⚠ 浏览器地址**复用 `browserTargets()`** —— doctor 读的就是它。两个消费者各读一份来源,
//   就会有一个长期正确、掩护另一个长期失效(v0.11.36 那条教训)。
// ⚠ 零新依赖:Node ≥22 原生有 WebSocket(生产机=26.5 / 开发机=22.22,doctor 已钉 Node 版本)。
function cdpBrowserUrl(home) {
  const t = require('../src/plugins').browserTargets(home)
  return t.length ? t[0].url.replace(/\/+$/, '') : null
}
async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('连不上浏览器调试端口')) })
  let id = 0
  const waiters = new Map(); const events = new Map()
  ws.onmessage = (m) => {
    let d; try { d = JSON.parse(m.data) } catch { return }
    if (d.id && waiters.has(d.id)) { const w = waiters.get(d.id); waiters.delete(d.id); d.error ? w.no(new Error(d.error.message || 'CDP 错误')) : w.ok(d.result) }
    else if (d.method && events.has(d.method)) { const fns = events.get(d.method); events.delete(d.method); for (const f of fns) f(d.params) }
  }
  return {
    send: (method, params = {}) => new Promise((ok, no) => { const n = ++id; waiters.set(n, { ok, no }); ws.send(JSON.stringify({ id: n, method, params })) }),
    once: (method, ms = 15000) => new Promise((ok) => {
      const t = setTimeout(() => ok(null), ms) // 超时**不算失败**:有些页面不发 load(缓存/空文档),照样能测
      events.set(method, [...(events.get(method) || []), (p) => { clearTimeout(t); ok(p) }])
    }),
    close: () => { try { ws.close() } catch {} },
  }
}
// 对一个本地 html 逐档宽度跑探针。返回 [{raw}] 交给 mergeLayoutRuns。
async function cdpLayoutScan(fileAbs, widths, base, probeOpts = {}) {
  // ⚠ 必须用 pathToFileURL,别手拼 `'file://' + 绝对路径`:Windows 上那样拼出来是
  //   `file://D:\proj\x.html`(正确形式是 `file:///D:/proj/x.html`)—— 盘符被当成主机名,
  //   路径分隔符也没转义。本机 macOS 上看不出来,Windows 真机才会撞上。
  const targetUrl = pathToFileURL(fileAbs).href
  let tab
  for (const init of [{ m: 'PUT' }, { m: 'GET' }]) { // Chrome 版本间 /json/new 的方法要求不一致,两种都试
    try {
      const r = await fetch(`${base}/json/new?${encodeURIComponent(targetUrl)}`, { method: init.m })
      if (r.ok) { tab = await r.json(); break }
    } catch { /* 换下一种 */ }
  }
  if (!tab || !tab.webSocketDebuggerUrl) throw new Error(`浏览器没能新建标签页(${base})—— 常驻浏览器起来了吗?`)
  const s = await cdpSession(tab.webSocketDebuggerUrl)
  const runs = []
  try {
    await s.send('Page.enable'); await s.send('Runtime.enable')
    for (const width of widths) {
      await s.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      const loaded = s.once('Page.loadEventFired')
      await s.send('Page.navigate', { url: targetUrl })
      await loaded
      await new Promise((r) => setTimeout(r, 250)) // 让字体/布局稳一稳,免得量到中间态
      const { result } = await s.send('Runtime.evaluate', { expression: design.layoutProbe(probeOpts), returnByValue: true })
      if (result && result.value) runs.push({ raw: result.value })
    }
  } finally {
    s.close()
    try { await fetch(`${base}/json/close/${tab.id}`) } catch { /* 关不掉不影响结果,但要留痕 */ }
  }
  return runs
}

// 把一段 HTML 交给常驻浏览器渲染成 PNG。⚠ 与布局体检共用同一个浏览器与同一套连接代码 ——
// 群里要看图标就必须真渲染:群图光栅器的图元只有圆角矩形,画不了 path。
// ⚠ 临时 html 落在系统临时目录、用完即删:写进项目目录会在交付物里留一个谁也不知道哪来的文件。
// ⚠ 按**内容实际高度**截,不按视口 —— 视口截出来底部会留一大片白,而那种图发进群里像是出错了。
async function cdpShotHtml(html, base, { width = 720, scale = 2 } = {}) { // 720 = iconSheetHtml 的版面宽,对齐免得右边留白
  const tmp = path.join(os.tmpdir(), `sbot-sheet-${process.pid}-${Date.now()}.html`)
  fs.writeFileSync(tmp, html)
  const targetUrl = pathToFileURL(tmp).href // 同上:手拼 file:// 在 Windows 上是坏的
  let tab
  for (const m of ['PUT', 'GET']) { // Chrome 版本间 /json/new 的方法要求不一致,两种都试
    try { const r = await fetch(`${base}/json/new?${encodeURIComponent(targetUrl)}`, { method: m }); if (r.ok) { tab = await r.json(); break } } catch { /* 换下一种 */ }
  }
  if (!tab || !tab.webSocketDebuggerUrl) { try { fs.unlinkSync(tmp) } catch { /* 清不掉不影响 */ } throw new Error(`浏览器没能新建标签页(${base})—— 常驻浏览器起来了吗?`) }
  // ⚠ 建会话这一步**也要在 try 里**:它抛的时候(ws 连不上)临时文件不删、刚建的标签页不关,
  //   而常驻浏览器是长期不重启的 —— 每失败一次攒一个。
  let s = null
  try {
    s = await cdpSession(tab.webSocketDebuggerUrl)
    await s.send('Page.enable')
    await s.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: scale, mobile: false })
    const loaded = s.once('Page.loadEventFired')
    await s.send('Page.navigate', { url: targetUrl })
    await loaded
    await new Promise((r) => setTimeout(r, 250)) // 让字体/布局稳一稳,免得截到中间态
    const { result } = await s.send('Runtime.evaluate', { expression: 'JSON.stringify({w:document.body.scrollWidth,h:document.body.scrollHeight})', returnByValue: true })
    const box = JSON.parse((result && result.value) || '{}')
    // ⚠ `clip.scale` 固定 1:它与 `deviceScaleFactor` **是叠乘的** —— 两处都写 2 会出 4 倍图。
    //   实测 760×959 的版面出成 3040×3836(530KB),而这张图是要发进群的。DPR 只交给 DPR。
    const shot = await s.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.min(box.w || width, width), height: box.h || 900, scale: 1 },
    })
    return Buffer.from(shot.data, 'base64')
  } finally {
    if (s) s.close()
    try { await fetch(`${base}/json/close/${tab.id}`) } catch { /* 关不掉不影响结果 */ }
    try { fs.unlinkSync(tmp) } catch { /* 清不掉不影响 */ }
  }
}

async function cmdDesign(rest) {
  const action = rest[0]
  // ⚠ `sbot design --help` 的 --help 落在**动作位**上,而下面那个循环只扫 rest.slice(1),
  //   够不着它 ⇒ 单独认一次。(各子动作的 --help 由那个循环接。)
  const topHelp = action === '--help' || action === '-h'
  // 手写解析(同 cmdFeishu):slug / 路径不会以 '-' 开头,但保持同一风格便于对照
  const args = rest.slice(1)
  let outOpt, forceFlag = false, nOpt, jsonFlag = false, currentFlag = false, allFlag = false, asOpt
  let spriteFlag = false, sizeOpt, labelOpt, helpFlag = false, widthsOpt
  let assetsOpt, noFallbackFlag = false, sheetFlag = false // design icons:资产目录 / 不要兜底库 / 出对照图
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--out') outOpt = args[++i]
    else if (a === '--as') asOpt = args[++i]
    else if (a === '--force') forceFlag = true
    else if (a === '--n') nOpt = args[++i]
    else if (a === '--json') jsonFlag = true
    else if (a === '--current') currentFlag = true
    else if (a === '--all') allFlag = true
    else if (a === '--sprite') spriteFlag = true
    else if (a === '--size') sizeOpt = args[++i]
    else if (a === '--label') labelOpt = args[++i]
    else if (a === '--widths') widthsOpt = args[++i] // 布局体检:逗号分隔的像素宽度
    else if (a === '--assets') assetsOpt = args[++i] // 图标资产目录(体检的扫描范围,多个逗号分隔)
    else if (a === '--no-fallback') noFallbackFlag = true // 取不到就取不到,不去兜底库找
    else if (a === '--sheet') sheetFlag = true // 图标系统对照图(发群里让人指着选)
    // ⚠ `--help` 必须在这儿吃掉:不接的话它会落进 positionals 被当成**路径**,报出「文件不存在:--help」
    //   这种驴唇不对马嘴的错(check / icon / icon-assets 三条都中招)。2026-08-24 真机实测:
    //   **agent 拿到一条没用过的命令,第一反应就是先 `--help`** —— 第一次交互就撞一句假错误。
    else if (a === '--help' || a === '-h') helpFlag = true
    else positionals.push(a)
  }
  // --out 决定往哪写,是安全敏感参数:漏值时手写解析会把下一个 flag 当路径(`--out --force`
  // 会写出一个名叫 "--force" 的文件),挡在这里比事后解释便宜
  if (outOpt !== undefined && (!outOpt || outOpt.startsWith('-'))) return die('--out 后面要跟项目内的相对路径(.md),不是别的参数')
  // 同 --out:漏值时手写解析会把下一个 flag 当用途名,建出一个叫 "--force" 的风格档
  if (asOpt !== undefined && (!asOpt || asOpt.startsWith('-'))) return die('--as 后面要跟用途名(载体词如「小程序」,或小写英文名如 landing-2026)')
  if (asOpt !== undefined && outOpt !== undefined) return die('--as 与 --out 只能给一个:--as 按用途落进 design/styles/,--out 是自己指定路径')
  // ⚠ 下面四条(styles / use / extract-colors / swatch)的 --help 此前没接:styles 静默把命令跑了,
  //   另三条走 die() 退出码 1 —— 正是 v0.11.55 在别处治过的「把 help 读成命令失败」。求助与漏参数
  //   仍分两条出口:前者 helpOut(0),后者 die(1)。
  if (action === 'styles') {
    const STYLES_USAGE = '用法: sbot design styles\n'
      + '      看风格库有哪几套(按场景分组;带 [载体 …] 的只适用于那种载体,没标的通用)\n'
      + '      出对比图挑: sbot design swatch <slug> <slug> …;落盘: sbot design use <slug>'
    if (helpFlag) return helpOut(STYLES_USAGE)
    const styles = design.listStyles({ builtinDir: BUILTIN_STYLES_DIR, userDir: userStylesDir() })
    if (!styles.length) {
      // 空库不是错误:内置预设随包安装,自定义预设是可选的 —— 告诉人往哪放就行
      process.stdout.write(`(暂无风格预设)\n内置预设目录:${BUILTIN_STYLES_DIR}\n自定义预设放 ${userStylesDir()}/<slug>.md(同名覆盖内置)\n`)
      return
    }
    // 按场景分组(v0.9.5)。风格库涨到二十几种之后,平铺一长串等于没给信息 —— agent 只看
    // 名字和一句话根本挑不准,而它挑错了,真正合适的那个用户**根本看不到**。分组是把
    // 「先问用途、再筛风格」这件事做进输出里,而不是指望它自己想起来。
    const SCENES = [
      ['工具产品', '控制台 / 看板 / 表格 / 内部系统'],
      ['品牌门面', '落地页 / 发布页 / 官网首屏'],
      ['内容阅读', '长文 / 杂志 / 文档站'],
      ['活动推广', '海报 / 发布会 / 潮流企划'],
      ['生图插画', '主要用来出图,不适合直接做界面'],
    ]
    // 载体标(v0.11.22)排在名字前:它是**排除法**用的 —— 做小程序时,标了「后台网站」的
    // 那几套直接不用看。没标的是通用款,不加任何标记(常态不用说)。
    const fmt = (s) => `  ${s.slug.padEnd(18)}${s.platform ? `[载体 ${s.platform}] ` : ''}${s.name}${s.description ? ' — ' + s.description : ''}${s.source === 'user' ? '  [自定义]' : ''}`
    const out = [`可用风格预设(共 ${styles.length})。**先确认用途,再从对应场景里挑 2-4 个出对比图** ——`,
      '库里风格多,凭名字硬猜会漏掉真正合适的那个(用户看不到的就等于不存在)。',
      '带 [载体 …] 的只适用于那种载体(小程序 / 后台网站 …),做别的就别选它;没标的通用。', '']
    const shown = new Set()
    for (const [scene, hint] of SCENES) {
      const hit = styles.filter((s) => (s.suits || '').includes(scene))
      if (!hit.length) continue
      out.push(`【${scene}】${hint}`)
      for (const s of hit) { out.push(fmt(s)); shown.add(s.slug) }
      out.push('')
    }
    const rest = styles.filter((s) => !shown.has(s.slug))
    if (rest.length) { out.push('【未标场景】'); rest.forEach((s) => out.push(fmt(s))); out.push('') }
    process.stdout.write(out.join('\n')
      + '(同一个风格可能落在多个场景里,重复出现是正常的。\n'
      + ' 出对比图给人看: sbot design swatch <slug> <slug> …;落盘: sbot design use <slug>,落盘后按项目需要改写即可)\n')
  } else if (action === 'use') {
    const slug = positionals[0]
    const styles = design.listStyles({ builtinDir: BUILTIN_STYLES_DIR, userDir: userStylesDir() })
    const USE_USAGE = '用法: sbot design use <slug> [--as <用途>] [--out <相对路径.md>] [--force]\n'
      + '      给本项目落一份风格档(默认项目根 DESIGN.md;根上已是架构文档则落 design/DESIGN.md)\n'
      + '      --as 小程序|后台网站|网页前台|移动 App|印刷物料(或小写英文用途名)⇒ 落 design/styles/<用途>.md,一个项目可以有多份\n'
      + '      --out 自己指定路径(与 --as 二选一);已有同名风格档要 --force 才覆盖,不是风格档的文件一律不覆盖'
    if (helpFlag) return helpOut(USE_USAGE)
    if (!slug) return die(USE_USAGE + (styles.length ? '\n可用:' + styles.map((s) => s.slug).join(' ') : ''))
    const hit = styles.find((s) => s.slug === slug)
    if (!hit) return die(`没有名为 ${slug} 的风格预设\n可用:${styles.map((s) => s.slug).join(' ') || '(空)'}\n(看名称与描述: sbot design styles)`)
    let text
    try { text = fs.readFileSync(hit.path, 'utf8') } catch (e) { return die('读取预设失败:' + (e && e.message)) }
    let target
    try { target = design.resolveStyleTarget({ cwd: process.cwd(), out: outOpt, force: forceFlag, as: asOpt }) } catch (e) { return die(e.message) }
    // --as 给的是载体词 ⇒ 把它写进这份档的 front matter:文件名(admin.md)只是文件名,
    // 「这份管后台网站」这件事必须写在档里,否则列清单、挑档、控制台标签全都读不到。
    if (target.platform) text = design.withStylePlatform(text, target.platform)
    // 原子写(仓库配置写回同款纪律):落盘要么是完整预设要么原样不动 —— 半截文件会被
    // isStyleDoc 认成「不是风格档」,连锁误诊成架构文档,后面越判越离谱
    const tmpFile = target.path + '.' + process.pid + '.tmp'
    try {
      fs.mkdirSync(path.dirname(target.path), { recursive: true }) // 降级落点 design/ 可能还不存在
      fs.writeFileSync(tmpFile, text)
      fs.renameSync(tmpFile, target.path)
    } catch (e) {
      try { fs.unlinkSync(tmpFile) } catch { /* 没写出来 */ }
      return die('写入风格档失败:' + (e && e.message))
    }
    const rel = path.relative(process.cwd(), target.path)
    process.stderr.write(green('  ✓ 已写入风格档 ') + dim(rel) + (target.note ? dim('(' + target.note + ')') : '') + '\n')
    process.stdout.write(`风格档已落盘:${rel}(预设:${hit.name})\n${target.note ? target.note + '\n' : ''}此后每次生图/出图表前先读它,按其色板/字体/Do's and Don'ts 执行;风格要调整就直接改这个文件(它随项目进 git)。\n`)
    // 预设本身不合格式(多见于用户自己放的 ~/.sbot/design-styles/*.md):落是落下了,但
    // isStyleDoc 认不出 ⇒ imagen 不会喂它、下次 use 会把它当架构文档躲开。明说,别让人蒙在鼓里。
    if (!design.isStyleDoc(text)) {
      process.stderr.write(yellow('  ⚠ 该预设不符合风格档格式') + dim(`(${hit.path} 的 front matter 里没有顶层 colors:)`) + '\n')
      process.stderr.write(dim('    生图不会把它当风格依据,下次 sbot design use 也会把这个文件当普通文档躲开 —— 请补上 front matter 的 colors 段\n'))
    }
  } else if (action === 'extract-colors') {
    const rel = positionals[0]
    const EXTRACT_USAGE = '用法: sbot design extract-colors <图片相对路径> [--n <主色个数 1-12,默认 6>] [--json]\n'
      + '      从参考图提色板(主色 + 中性色,带占比);只收项目内的图片文件,不收网址\n'
      + '      色板只说得清「用什么颜色」,气质 / 构图 / 留白要自己看图归纳或请用户描述'
    if (helpFlag) return helpOut(EXTRACT_USAGE)
    if (!rel) return die(EXTRACT_USAGE)
    let n = nOpt ? parseInt(nOpt, 10) : 6
    if (!Number.isFinite(n) || n < 1) n = 6
    n = Math.min(n, 12)
    let abs
    try { abs = resolveSendPath(process.cwd(), rel) } catch (e) { return die(e.message) } // mustExist + cwd 围栏(与 feishu 系动作同源)
    let png
    try { png = readImageAsPng(abs) } catch (e) { return die(e.message) }
    let d = decodePngRGBA(png)
    // 16 位色深 / 隔行 / 低位深调色板的小 PNG 手写解码器不吃(见 board.js 解码器注释)——
    // darwin 上让 sips 归一化成位深 8 再来一次,比让用户自己去 Photoshop 另存强
    if (!d && process.platform === 'darwin') {
      try { d = decodePngRGBA(readImageAsPng(abs, { force: true })) } catch { /* 归一化也不行,下面报人话 */ }
    }
    if (!d) return die('PNG 解码失败 —— 支持位深 8、非隔行的常规 PNG;请用系统工具另存一版再试')
    const pal = design.extractPalette(d.px, d.width, d.height, { n })
    if (jsonFlag) {
      process.stdout.write(JSON.stringify({ file: rel, width: d.width, height: d.height, colors: pal.colors, neutrals: pal.neutrals }, null, 2) + '\n')
      return
    }
    const pct = (s) => (s * 100).toFixed(1) + '%'
    const rows = (arr) => arr.map((c) => `${c.hex}  ${pct(c.share)}`).join('\n') || '(无)'
    process.stdout.write(`参考图主色(${rel} · ${d.width}×${d.height}):\n${rows(pal.colors)}\n中性色/底色:\n${rows(pal.neutrals)}\n`
      + '(把主色写进风格档 front matter 的 colors;色板只说得清「用什么颜色」—— 气质、构图、留白要么自己看图归纳,要么请用户用文字描述。)\n')
  } else if (action === 'swatch') {
    // 风格可视化:tokens → 微缩界面预览图。存在的理由 = 「瑞士网格」和「新中式」在文字上
    // 都是「浅底深字一点强调色」,选风格这件事只能看,不能靠念描述。
    const styles = design.listStyles({ builtinDir: BUILTIN_STYLES_DIR, userDir: userStylesDir() })
    const SWATCH_USAGE = '用法: sbot design swatch <slug> [更多 slug…] [--out <相对路径.png>]\n'
      + '      sbot design swatch --current           把本项目现有的风格档全画上(几份画几份)\n'
      + '      sbot design swatch --all               全库一张网格图\n'
      + '      把风格画成微缩界面预览图(默认落 design/style-swatch.png);候选对比一次最多点名 4 套\n'
      + '      图上只有序号,stdout 给的「序号 → 名称」要照抄进群消息'
    if (helpFlag) return helpOut(SWATCH_USAGE)
    const specs = []
    const rows = []
    // --all(v0.10.1):全库一张网格图。**与候选对比是两个场景** —— 候选是"从这几个里选一个"
    // (2-4 张并排,每张 260px 看得清网点/字脚/双线);全库是"有哪些"(要的是全,宁可小)。
    if (allFlag) {
      for (const st of styles) {
        let text
        try { text = fs.readFileSync(st.path, 'utf8') } catch { continue }
        const spec = design.swatchSpec(text)
        specs.push(spec)
        rows.push({ slug: st.slug, name: spec.name || st.name, description: spec.description || st.description, suits: st.suits })
      }
      if (!specs.length) return die('风格库是空的')
    }
    if (currentFlag) {
      // 一个项目可以有多份风格档(v0.11.22:小程序一份、后台一份…)⇒ --current 把它们**全画上**,
      // 一张图就能看出「这两块到底差在哪」。序号行报出各自管哪块,群里才说得清「第 2 张是后台那份」。
      const docs = design.findStyleDocs({ cwd: process.cwd() })
      if (!docs.length) return die('本项目还没有风格档(找过项目根 DESIGN.md、design/DESIGN.md 与 design/styles/*.md)\n先落一份:sbot design use <slug> [--as 小程序];或直接传预设 slug 出候选对比图')
      for (const doc of docs) {
        let text
        try { text = fs.readFileSync(doc.abs, 'utf8') } catch (e) { return die('读取风格档失败:' + (e && e.message)) }
        const spec = design.swatchSpec(text)
        specs.push(spec)
        rows.push({ slug: doc.platform ? '(本项目 · ' + doc.platform + ')' : '(本项目)', name: spec.name || doc.rel, description: spec.description })
      }
    }
    for (const slug of positionals) {
      const hit = styles.find((s) => s.slug === slug)
      if (!hit) return die(`没有名为 ${slug} 的风格预设\n可用:${styles.map((s) => s.slug).join(' ') || '(空)'}\n(看名称与描述: sbot design styles)`)
      let text
      try { text = fs.readFileSync(hit.path, 'utf8') } catch (e) { return die('读取预设失败:' + (e && e.message)) }
      const spec = design.swatchSpec(text)
      specs.push(spec)
      rows.push({ slug: hit.slug, name: spec.name || hit.name, description: spec.description || hit.description })
    }
    if (!specs.length) return die(SWATCH_USAGE + (styles.length ? '\n可用:' + styles.map((s) => s.slug).join(' ') : ''))
    // 上限 4:再多每张就窄到看不清,而清单教的本来就是「挑 2-4 个候选」。宁可报错让人重挑,
    // 也不出一张糊到没法选的图。
    // 候选对比限 4 张(再多每张就窄到看不清);--all 是浏览场景,走网格不受此限
    // 上限 4 那条是给**挑候选**写的(再多每张就窄到看不清)⇒ 只拦「显式点名超过 4 个预设」。
    // `--current` 是「把本项目现有的档全画上」,项目真有 5 份档时它不该撞这道闸门 —— 那句
    // 「挑 2-4 个候选方向即可」在那个场景里是句不通的话。份数多了自动走网格,与 --all 同款。
    if (positionals.length > 4) return die(`一次最多 4 个风格(收到 ${positionals.length} 个)—— 再多每张就窄到看不清了;挑 2-4 个候选方向即可,或用 --all 出全库网格图`)
    const gridMode = allFlag || specs.length > 4
    const noColor = specs.filter((s) => !s.roles).length
    let rel = outOpt || path.join('design', 'style-swatch.png')
    if (!/\.png$/i.test(rel)) return die('--out 只能写 .png 文件:' + rel)
    let abs
    try { abs = resolveSendPath(process.cwd(), rel, false) } catch (e) { return die(e.message) } // 写模式:文件还不存在
    let sheet
    try { sheet = design.renderSwatchSheet(specs, gridMode ? { cols: 4 } : {}) } catch (e) { return die('生成风格图失败:' + (e && e.message)) }
    const png = encodePngRGBA(sheet.px, sheet.width, sheet.height)
    const tmpFile = abs + '.' + process.pid + '.tmp'
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(tmpFile, png)
      fs.renameSync(tmpFile, abs)
    } catch (e) {
      try { fs.unlinkSync(tmpFile) } catch { /* 没写出来 */ }
      return die('写入风格图失败:' + (e && e.message))
    }
    rel = path.relative(process.cwd(), abs)
    process.stderr.write(green('  ✓ 已生成风格图 ') + dim(`${rel}(${sheet.width}×${sheet.height})`) + '\n')
    const numbered = specs.length > 1
    // ⚠ 图上只有阿拉伯数字序号 —— 风格名是中文,点阵字模画不了。所以这份「序号→名称」对照
    // 必须由 stdout 交给 agent 照抄进群消息,否则用户看得见四张图却说不出要哪张。
    // --all 出的是"有哪些"的全景,16 行带完整描述会长到没法读 ⇒ 只给「序号 名称 · 场景」;
    // 候选对比(2-4 张)才带一句话,那时用户是在"选",需要判断依据。
    const list = allFlag
      ? rows.map((r, i) => `  ${i + 1}. ${r.name}${r.suits ? ' · ' + r.suits : ''}`).join('\n')
      : rows.map((r, i) => `  ${numbered ? (i + 1) + '. ' : ''}${r.name}${r.slug.startsWith('(') ? ' ' + r.slug : '(' + r.slug + ')'}${r.description ? ' — ' + r.description : ''}`).join('\n')
    process.stdout.write(`风格图已生成:${rel}(${specs.length} 个 · ${sheet.width}×${sheet.height})\n`
      + `图上${allFlag ? '的序号(按行从左到右)' : numbered ? '从左到右的序号' : '这张'}对应:\n${list}\n`
      // 角色判定 + 「改色值没用」那段教学(v0.9.3,机制与病史见 design.js swatchRoleReport)
      + (allFlag ? '' : `图就是按这套角色判定画的:\n${design.swatchRoleReport(specs, { numbered })}\n` + design.SWATCH_ROLE_HINT)
      // Slack 群(SBOT_PLATFORM 由引擎注入):发图还没接上,提示改成写路径,别把 agent 往飞书命令上引。
      + (process.env.SBOT_PLATFORM === 'slack' ? '本群在 Slack 上暂不能发图 —— 把这张图的相对路径写进回复,对照表照下面列。\n' : `发给群里:sbot feishu send-image "${rel}"\n`)
      + (numbered
        ? '⚠ 消息里必须把上面的「序号 + 名称 + 一句话」列出来 —— 图上只有数字,用户回「第2个」时你才对得上是哪个风格;选定后 sbot design use <slug> 落盘。\n'
          + '⚠ 群消息里只写风格的名称与描述,**别把 slug、命令名或机器路径写进去**(用户要选的是风格,不是命令)。\n'
        : '(风格档改了就重跑本命令,图会跟着变 —— 图标完全由 front matter 的 colors/rounded/typography 派生)\n'))
    if (noColor) {
      process.stderr.write(yellow('  ⚠ 有风格档没解析出可用色板') + dim('(front matter 的 colors 缺失或写坏)—— 那几张画成了灰色空卡\n'))
    }
  } else {
  if (action === 'check') {
    // 设计规范回归检查(含视觉回归)。只报告、**不阻断** ——
    // 判断权留给人(理由见 src/design.js 该段头注)。退出码 0 无偏离 / 3 有偏离,
    // 用 3 而不是 1 是为了与「命令本身失败」区分开:有偏离不是执行失败。
    // ⚠ `--help` 必须排在**所有业务前置检查之前**:v0.11.50 治的是「--help 落进 positionals 被
    //   当成路径」,但这条 die 排在前面 ⇒ 在**还没有风格档的新项目**里问用法,答的是「本项目还没有
    //   风格档」。而 agent 第一次碰一条命令恰恰就是在那种项目里、恰恰就是先敲 --help。
    //   **问「怎么用」和「能不能用」是两个问题,前者任何时候都该答得出。**
    if (helpFlag) return helpOut('用法: sbot design check <文件…> [--as <用途>] [--json]\n      例: sbot design check index.html styles.css\n      退出码 0 无偏离 / 3 有偏离 / 1 命令失败')
    const docs = design.findStyleDocs({ cwd: process.cwd() })
    const pick = design.pickStyleDoc(docs, asOpt)
    if (!pick) return die(docs.length
      ? `没有名为「${asOpt}」的风格档 —— 本项目现有:${docs.map((d) => d.platform || d.rel).join(' / ')}`
      : '本项目还没有风格档 —— 先 sbot design use <slug> 落一份,或用 --as 指名')
    if (!positionals.length) return die('用法: sbot design check <文件…> [--as <用途>] [--json]\n      例: sbot design check index.html styles.css')
    const sources = []
    for (const rel of positionals) {
      let abs
      try { abs = resolveSendPath(process.cwd(), rel, true) } catch (e) { return die((e && e.message) || String(e)) }
      try { sources.push({ rel, text: fs.readFileSync(abs, 'utf8') }) } catch (e) { return die(`读不了 ${rel}:${(e && e.message) || e}`) }
    }
    const tokens = design.parseStyleTokens(fs.readFileSync(pick.abs, 'utf8'))
    // ⚠ 把项目的图标档一并交给它:图标那几条的判据(用哪套系统、是描边型还是填充型)住在那份档里,
    //   不传 = 填充型系统的项目每次交付都会收到一串假的「描边不合规」(真机端到端撞到过)。
    // ⚠ `roots` 同理:图标**来源**那条判据要拿页面里的图形跟库里的真文件比,不传 = 那条整条
    //   不跑,而报告照样一片绿(「零告警」与「压根没查」看起来一模一样)。
    // ⚠ `accepted` 与上面两项同一形状(判断写在调用方这条路上):不传 = 已知例外整条不生效,
    //   而报告照样每次把同样几条噪音重贴一遍 —— 那正是这机制要治的病。
    const res = design.checkDesign(sources, tokens, {
      project: design.findIconsDoc({ cwd: process.cwd() }),
      roots: iconRootsHere(),
      accepted: design.findAcceptedDoc({ cwd: process.cwd() }),
    })
    // 例外档写错了要出声 —— 静默失效与「根本没这个文件」输出一模一样
    try {
      const _acc = path.join(process.cwd(), design.ACCEPTED_DOC_REL)
      if (fs.existsSync(_acc)) res.acceptedWarn = design.acceptedDocWarnings(fs.readFileSync(_acc, 'utf8'))
    } catch { /* 读不到就不提,不因为它挡住整份报告 */ }
    // styleCount/stylePinned 给 JSON 侧同样的判断依据:只给 style 一个相对路径,消费方分不出
    // 「项目就这一份」和「有好几份、这次蒙的第一份」——而那正是要区分的两件事。
    if (jsonFlag) { process.stdout.write(JSON.stringify({ style: pick.rel, styleCount: docs.length, stylePinned: !!asOpt, ...res }, null, 2) + '\n'); if (res.findings.length) process.exitCode = 3; return }
    const which = styleWhich(docs, pick, asOpt)
    // ⚠ 档本身的问题**不并进 findings**(check 查的是产物),只在末尾留一行指针 —— 但必须留:
    //   真机上三个缺口全在档里,而三条验收谁都不会说「档有问题」。
    process.stdout.write((which ? which + '\n' : '')
      + design.formatCheckReport(res, { styleName: pick.name || pick.platform || pick.rel, specIssues: design.specHardIssues(design.auditStyleSpec(tokens)) }) + '\n')
    if (res.findings.length) process.exitCode = 3
    return
  }
  if (action === 'doctor') {
    // 第四条平级验收:查**风格档本身**(前三条都只会说「产物偏离了档」,不会说「档有问题」)。
    const USAGE = '用法: sbot design doctor [--as <用途>] [--json]\n'
      + '      检查风格档本身:语义色放错段 / 色板读不清(对比度)/ 缺中文兜底 / 非标准字重 / 首选字体是否系统自带(并说各平台实际落到哪个族)\n'
      + '      退出码 0 没问题 / 3 有问题 / 1 命令失败'
    if (helpFlag) return helpOut(USAGE)
    const docs = design.findStyleDocs({ cwd: process.cwd() })
    const pick = design.pickStyleDoc(docs, asOpt)
    if (!pick) return die(docs.length
      ? `没有名为「${asOpt}」的风格档 —— 本项目现有:${docs.map((d) => d.platform || d.rel).join(' / ')}`
      : '本项目还没有风格档')
    const tokens = design.parseStyleTokens(fs.readFileSync(pick.abs, 'utf8'))
    const res = design.auditStyleSpec(tokens)
    if (jsonFlag) { process.stdout.write(JSON.stringify({ style: pick.rel, styleCount: docs.length, ...res }, null, 2) + '\n'); if (res.findings.length) process.exitCode = 3; return }
    const which = styleWhich(docs, pick, asOpt)
    process.stdout.write((which ? which + '\n' : '')
      + design.formatSpecReport(res, { styleName: pick.name || pick.platform || pick.rel, rel: pick.rel }) + '\n')
    if (res.findings.length) process.exitCode = 3
    return
  }
  if (action === 'layout') {
    // 布局体检:把页面真渲染出来量几何。与 design check(查写法)、icon-assets(查图标文件)
    // 并列的第三条 —— 2026-08-24 真机上 check 零不一致而页面有四处文字压在头像上。
    const LAYOUT_USAGE = '用法: sbot design layout <html 文件…> [--widths 1280,1000,430] [--as <用途>] [--json]'
      + '\n      在几档宽度下真渲染,报五件事实:文字重叠 · 内容被裁掉且不可滚 · 点击目标 < 24px'
      + '\n      · 文字对比度低于 WCAG · 中文字号低于风格档最小档位(图表内的文字不计)'
      + '\n      ⚠ **必须多档** —— 真机实测同一处重叠:1280px 零处、1000px 四处、614px 一处'
      + '\n      须常驻浏览器(没有会如实说并给装法);退出码 0 干净 / 3 有发现 / 1 命令失败'
    if (helpFlag) return helpOut(LAYOUT_USAGE)
    if (!positionals.length) return die(LAYOUT_USAGE)
    const widths = (widthsOpt || '1280,1000,430').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n >= 240 && n <= 3840)
    if (!widths.length) return die('--widths 要给 240~3840 之间的像素数,逗号分隔(如 1280,1000,430)')
    const base = cdpBrowserUrl()
    // 软降级(教训 6):没有常驻浏览器就如实说 + 给出装法,不阻断别的事
    if (!base) return die('这台机器没有配常驻浏览器(chrome-devtools 类 MCP 的 --browserUrl)—— 布局体检要真渲染,没有浏览器做不了')
    const docs = design.findStyleDocs({ cwd: process.cwd() })
    const pick = design.pickStyleDoc(docs, asOpt)
    // ⚠ `--as` 打错时**必须 die**(check / doctor 都 die,只有这条静默降级)—— 降级的后果
    //   不只是少查一类:cjkMinSize 变 0,报告会把「你 --as 打错了」说成「你的档里没写字号」,
    //   给出**错误的原因**(审计实测,档里明明写了 13px)。
    if (asOpt && !pick) return die(docs.length
      ? `没有名为「${asOpt}」的风格档 —— 本项目现有:${docs.map((d) => d.platform || d.rel).join(' / ')}`
      : '本项目还没有风格档')
    const cjkMinSize = pick ? design.styleMinFontSize(design.parseStyleTokens(fs.readFileSync(pick.abs, 'utf8'))) : 0
    let bad = 0
    for (const rel of positionals) {
      let abs
      try { abs = resolveSendPath(process.cwd(), rel, true) } catch (e) { return die((e && e.message) || String(e)) }
      if (!/\.html?$/i.test(abs)) return die(`${rel} 不是 html —— 布局体检只看渲染得出来的页面`)
      let runs
      // ⚠ 中文小字的下限来自风格档(声明过的**最小**档位),不是写死的数 —— 没有风格档就传 0,
      //   那一类整条不测,报告会如实说。判断写在这条路上,单测只测得到纯函数。
      try { runs = await cdpLayoutScan(abs, widths, base, { cjkMinSize }) } catch (e) { return die('布局体检失败:' + ((e && e.message) || e)) }
      if (!runs.length) return die(`${rel} 一档都没量到 —— 页面加载失败?`)
      const res = design.mergeLayoutRuns(runs)
      if (jsonFlag) process.stdout.write(JSON.stringify({ file: rel, ...res }, null, 2) + '\n')
      else process.stdout.write(design.formatLayoutReport(res, { rel, styleName: pick ? (pick.name || pick.platform || pick.rel) : '' }) + '\n')
      if (res.findings.length) bad++
    }
    if (bad) process.exitCode = 3
    return
  }
  if (action === 'icon-assets') {
    // 图标资产体检(设计系统缺口 1)。与 `design check` 分开:那条查**页面写法**、每次交付前跑;
    // 这条查**图标文件本身**、整理时才跑。合并的话这几十行会把交付报告淹掉(报告变噪音就没人看)。
    const ICON_ASSETS_USAGE = '用法: sbot design icon-assets [目录或 svg 文件…] [--as <用途>] [--json]\n'
      + '      查图标文件本身:颜色能不能继承(写死的 fill/stroke)/ 同图多份 / 描边、端点、网格偏离风格档\n'
      + '      不给路径就扫 design/icons.md 里 assets: 声明的目录(绝不自动发现);退出码 0 干净 / 3 有发现 / 1 命令失败'
      + `\n      不给路径 = 用 ${design.ICONS_DOC_REL} 里 assets: 声明的目录;两者都没有会告诉你怎么配`
      + '\n      例: sbot design icon-assets assets/icons --as 小程序'
      + '\n      查三件事:颜色能不能继承(currentColor)· 有没有同图多份 · 描边/端点/连接/网格偏不偏离声明'
      + '\n      退出码 0 干净 / 3 有发现 / 1 命令失败'
    if (helpFlag) return helpOut(ICON_ASSETS_USAGE)
    const docs = design.findStyleDocs({ cwd: process.cwd() })
    const pick = design.pickStyleDoc(docs, asOpt)
    if (!pick) return die(docs.length
      ? `没有名为「${asOpt}」的风格档 —— 本项目现有:${docs.map((d) => d.platform || d.rel).join(' / ')}`
      : '本项目还没有风格档 —— 先 sbot design use <slug> 落一份,或用 --as 指名')
    const tokens = design.parseStyleTokens(fs.readFileSync(pick.abs, 'utf8'))
    const iconsDoc = design.findIconsDoc({ cwd: process.cwd() })
    const spec = design.iconSpec(tokens, iconsDoc)
    if (!spec) return die('本项目还没有图标口径 —— 先 sbot design icons use <系统> 选一套(图形从哪来),'
      + '风格档的 icons 段再管怎么画(描边/端点/尺寸)'
      + styleAltHint(docs, pick, asOpt))
    // 扫描范围:命令行给的优先,否则用风格档 icons.assets 声明的。**两个都没有就明说怎么配** ——
    // 绝不自动去猜哪个目录是图标目录(猜错 = 一份长得像正经报告的错报告)。
    // 别的档里声明了 assets 吗 —— ⚠ 「明明声明过却被告知『不知道要扫哪儿』」是最气人的一种错:
    //   声明在别的档里,而这条命令只看它挑中的那份。点名说出来,比让人自己去翻两份档便宜得多。
    const declaredElsewhere = docs
      .filter((d) => d.abs !== pick.abs)
      .map((d) => { try { const s = design.iconSpec(design.parseStyleTokens(fs.readFileSync(d.abs, 'utf8'))); return s && s.assets.length ? { d, assets: s.assets } : null } catch { return null } })
      .filter(Boolean)
    const roots = positionals.length ? positionals : spec.assets
    if (!roots.length) {
      return die(`不知道要扫哪儿 —— 在 ${design.ICONS_DOC_REL} 里加一行 \`assets: "相对目录"\`(多个用逗号分隔),或直接把目录/文件传给它`
        + (declaredElsewhere.length
          ? '\n⭐ 本项目**别的风格档里声明了**:' + declaredElsewhere.map((x) => `${x.d.platform || x.d.rel} → ${x.assets.join(' , ')}(加 --as ${x.d.platform || x.d.rel})`).join(' · ')
          : '')
        + '\n⚠ 故意不自动发现:真实项目里同一棵目录树往往混着插画、logo、构建产物副本,扫进来的报告是废的\n' + ICON_ASSETS_USAGE)
    }
    // ⚠ 给了路径、又没指名档,而这个路径正是**另一份档**声明的图标目录 ⇒ 当场点破。
    //   v0.11.35 那次的教训:拿后台那份去查小程序的东西,**对错了档的报告比没有报告更糟**
    //   —— 它长得像一份正经报告,人照着改反而把对的改错。这里只提示不自动换档(换档是人的判断)。
    if (positionals.length && !asOpt) {
      const owner = declaredElsewhere.find((x) => x.assets.some((a) => positionals.some((p) => {
        const norm = (s) => String(s).replace(/^\.\//, '').replace(/\/+$/, '')
        return norm(p) === norm(a) || norm(p).startsWith(norm(a) + '/')
      })))
      if (owner) process.stderr.write(dim(`  ⚠ ${positionals.join(' / ')} 正是「${owner.d.platform || owner.d.rel}」那份档声明的图标目录,而这次对照的是「${pick.platform || pick.rel}」`
        + ` —— 要按它自己的口径查,加 --as ${owner.d.platform || owner.d.rel}\n`))
    }
    // ⚠ **目录和 svg 文件都收**(2026-08-24 真机换来的):隔壁 `design check` 收的是文件,所以
    //   agent 的第一反应是 `icon-assets assets/icons/*.svg` —— 只收目录的话它撞一句裸的
    //   `ENOTDIR: not a directory`,得再试一次才对。**同一族命令的入参形状不该互相打架。**
    const files = []
    const seen = new Set()
    const projRoot = path.resolve(process.cwd())
    const addFile = (abs, rel) => {
      // ⚠ 围栏要认**软链解析后**的落点:`resolveSendPath` 不解析软链(preview.js 同款教训),
      //   而 readFileSync 会跟着软链走 ⇒ 图标目录里放一条指向项目外的软链就读得到围栏外的文件。
      //   项目内的软链**照收** —— 2026-08-24 真机上 agent 就用它把单个文件包成目录来扫,那是正当用法。
      let real
      try { real = fs.realpathSync(abs) } catch { return }
      if (real !== projRoot && !real.startsWith(projRoot + path.sep)) return
      if (seen.has(real)) return // 目录与其中某个文件同时给到时,别把同一个文件数两遍(会凭空多出「重复副本」)
      seen.add(real)
      try { files.push({ rel, text: fs.readFileSync(abs, 'utf8') }) } catch { /* 读不了的跳过,不因一个文件废掉整次体检 */ }
    }
    for (const rel of roots) {
      let abs
      try { abs = resolveSendPath(process.cwd(), rel, true) } catch (e) { return die((e && e.message) || String(e)) }
      let st
      try { st = fs.statSync(abs) } catch (e) { return die(`读不了 ${rel}:${(e && e.message) || e}`) }
      if (!st.isDirectory()) {
        if (!/\.svg$/i.test(abs)) return die(`${rel} 不是 svg 也不是目录 —— 这条只看矢量图标文件`)
        addFile(abs, path.basename(rel))
        continue
      }
      const walk = (d, prefix) => {
        let ents
        try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { return die(`读不了目录 ${rel}:${(e && e.message) || e}`) }
        for (const ent of ents.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (ent.isDirectory()) walk(path.join(d, ent.name), prefix + ent.name + '/')
          else if (/\.svg$/i.test(ent.name)) addFile(path.join(d, ent.name), prefix + ent.name)
        }
      }
      walk(abs, roots.length > 1 ? rel.replace(/\/*$/, '/') : '')
    }
    if (!files.length) return die(`${roots.join(' / ')} 里一个 svg 都没有 —— 目录写对了吗?`)
    const res = design.auditIconAssets(files, spec)
    if (jsonFlag) {
      process.stdout.write(JSON.stringify({ style: pick.rel, roots, ...res }, null, 2) + '\n')
      if (res.hardcoded.count || res.dups.groups.length || res.stroke || res.linecap || res.linejoin || res.grid) process.exitCode = 3
      return
    }
    const which = styleWhich(docs, pick, asOpt)
    process.stdout.write((which ? which + '\n' : '') + design.formatIconAuditReport(res, { styleName: pick.name || pick.platform || pick.rel, roots }) + '\n')
    if (res.hardcoded.count || res.dups.groups.length || res.stroke || res.linecap || res.linejoin || res.grid) process.exitCode = 3
    return
  }
  if (action === 'icons') {
    // 图标库 = **与设计风格库平级**的一张表(代码里预先整理好,不开放自定义,2026-08-25 拍板)。
    // 这条命令只做两件事:看有哪几套 / 给本项目选一套(落 design/icons.md)。
    // ⚠ 与 `design icon`(取图标)只差一个字母,所以两边的用法行都要写清对方是干嘛的 ——
    //   名字像的两条命令,不点破就会有人一直用错那条。
    const ICONS_USAGE = `用法: sbot design icons                 看图标库有哪几套 · 本项目在用哪套(${Object.keys(design.ICON_SYSTEMS).join(' / ')})`
      + `\n      sbot design icons --sheet [--out <相对路径.png>]   出一张带序号的对照图发群里让人指着选(须常驻浏览器)`
      + `\n      sbot design icons use <系统> [--assets <目录,…>] [--no-fallback] [--force]`
      + `\n      给本项目定一套,落 ${design.ICONS_DOC_REL};已定过要 --force(换系统 = 换整套命名,已取过的图标不会跟着变)`
      + `\n      --assets 声明图标文件目录(icon-assets 体检只扫这里,绝不自动发现);--no-fallback 取不到不去兜底库找`
      + `\n      (取图标是另一条:sbot design icon <名字…>)`
    const cur = design.findIconsDoc({ cwd: process.cwd() })
    const sub = positionals[0]
    if (helpFlag) return helpOut(ICONS_USAGE)
    // 对照图:与 `design swatch` 同一个路子 —— 挑图标系统只能看,不能靠念「256 网格填充型」。
    // ⚠ 图里带序号,群里指着说「用第 3 个」比让人打出英文名靠谱得多(也符合用户面零工具名)。
    if (sheetFlag) {
      const b = cdpBrowserUrl()
      // 软降级(教训 6):没有常驻浏览器就如实说 + 给出还能怎么办,不阻断别的事
      if (!b) return die('这台机器没有配常驻浏览器 —— 图标对照图要真渲染才画得出来(群图那条路只画得了矩形,画不了图标)\n先用文字版:sbot design icons')
      const previews = design.iconSystemPreviews()
      let rel = outOpt || path.join('design', 'icon-systems.png')
      if (!/\.png$/i.test(rel)) return die('--out 只能写 .png 文件:' + rel)
      let abs
      try { abs = resolveSendPath(process.cwd(), rel, false) } catch (e) { return die(e.message) } // 写模式:文件还不存在
      let png
      try { png = await cdpShotHtml(design.iconSheetHtml(previews, { current: cur ? cur.system : '' }), b) } catch (e) { return die('出图失败:' + ((e && e.message) || e)) }
      const tmpFile = abs + '.' + process.pid + '.tmp'
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(tmpFile, png)
        fs.renameSync(tmpFile, abs) // 原子写:半张图发进群里比没有图更糟
      } catch (e) { try { fs.unlinkSync(tmpFile) } catch { /* 没写出来 */ } return die('写入图片失败:' + ((e && e.message) || e)) }
      // 序号 → 名字的对照走 stdout:图里只有序号(给人指),而 agent 落档时要的是名字
      process.stdout.write(`图标系统对照图:${path.relative(process.cwd(), abs)}(${previews.length} 套)\n`
        + previews.map((p, i) => `${i + 1}. ${p.label}${cur && cur.system === p.system ? '(当前)' : ''} —— ${p.system}`).join('\n') + '\n'
        + '把图发到群里让人指着选(说「第 N 个」即可),定了再落档。\n')
      return
    }
    if (!sub) {
      // ⚠ 用户面不出现 `null` / `outlined` 这类内部值:兜底为空就说「不兜底」,形态说人话。
      //   字重只有声明了的库才提(其余库提了就是句空话)。
      const zh = (st) => (st === 'filled' ? '实心' : '线性')
      const lines = Object.entries(design.ICON_SYSTEMS).map(([k, s]) => {
        const on = cur && cur.system === k
        const form = (design.ICON_LIBS[s.library] || {}).form === 'fill' ? '填充型' : '描边型'
        return `${on ? '● ' : '○ '}${k.padEnd(9)}${s.label} · ${form} · ${s.styles.map(zh).join(' / ')}`
          + (s.weights ? ` · 字重 ${s.weights.length} 档` : '')
          + ` · 语义名 ${Object.keys(s.semantics).length} 条`
          + (s.fallbackLibrary ? ` · 取不到时去 ${(design.ICON_LIBS[s.fallbackLibrary] || {}).label || s.fallbackLibrary} 兜底` : ' · 不兜底')
      })
      // ⚠ 认不出的系统名**不能当成有效选择念出来** —— 否则 agent 会照着向群里转述「本项目用的是 X」,
      //   而每一张图其实都来自默认库(做了 A 让人以为做了 B)。
      const unknown = cur && !design.ICON_SYSTEMS[cur.system]
      process.stdout.write(`图标库(${lines.length} 套;图标与设计风格平级,各选各的)\n${lines.join('\n')}\n`
        + (cur
          ? (unknown
            ? `\n⚠ 本项目的图标档里写着「${cur.system}」,这不是图标系统的名字(${cur.rel})—— 现在等于没选,取图标会退回默认库。改成上面四个之一:sbot design icons use <${Object.keys(design.ICON_SYSTEMS).join('|')}> --force\n`
            : `\n本项目:${cur.system}(${cur.rel})${cur.assets.length ? ' · 资产目录 ' + cur.assets.join(' , ') : ''}\n`)
          : `\n本项目还没选 —— sbot design icons use <${Object.keys(design.ICON_SYSTEMS).join('|')}>\n`))
      return
    }
    if (sub !== 'use') return die(`unknown: design icons ${sub}\n${ICONS_USAGE}`)
    const want = String(positionals[1] || '').toLowerCase()
    if (!design.ICON_SYSTEMS[want]) return die(`没有名为「${positionals[1] || ''}」的图标系统 —— 可选:${Object.keys(design.ICON_SYSTEMS).join(' / ')}\n${ICONS_USAGE}`)
    // 已经有一份且不是同一套 ⇒ 要 --force。**换图标系统会换掉整套命名词汇**,页面上已经用
    // `sbot design icon` 取过的那些图标不会自动跟着变(教训 10:做了 A 别让人以为做了 B)。
    if (cur && cur.system !== want && !forceFlag) {
      return die(`本项目已经选了「${cur.system}」(${cur.rel})—— 换成「${want}」要加 --force`
        + `\n⚠ 换系统会换掉整套命名词汇(同一个「更多」:${design.ICON_SYSTEMS[cur.system] ? design.resolveIconName('more', design.ICON_SYSTEMS[cur.system]) : '?'} → ${design.resolveIconName('more', design.ICON_SYSTEMS[want])}),`
        + `**页面上已经取过的图标不会自动跟着变** —— 换完要把用到图标的页面重新取一遍`)
    }
    const abs = path.join(process.cwd(), design.ICONS_DOC_REL)
    // assets 没显式给就沿用旧档里那份 —— 换系统不该顺手把资产目录清掉
    const assets = assetsOpt || (cur ? cur.assets.join(' , ') : '')
    // ⚠ 已有档 ⇒ **只改 front matter 那几键,正文逐字节保留**(风格档早有这条硬规矩,图标档漏了):
    //   这份档的注释就写着「是给人看的」,人往里写的项目细则不该被换个系统冲掉。
    let text
    const fb = noFallbackFlag ? 'none' : (cur && cur.fallbackLibrary === null ? 'none' : '')
    try {
      text = design.iconsDocText(cur && cur.text, { system: want, assets, fallback: fb })
    } catch (e) { return die(e.message) }
    const tmpFile = abs + '.' + process.pid + '.tmp'
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(tmpFile, text)
      fs.renameSync(tmpFile, abs) // 原子写:半截档会被认帧挡下,连带图标口径整个消失
    } catch (e) {
      try { fs.unlinkSync(tmpFile) } catch { /* 没写出来 */ }
      return die('写入图标档失败:' + (e && e.message))
    }
    const s = design.ICON_SYSTEMS[want]
    process.stderr.write(green('  ✓ 已写入图标档 ') + dim(design.ICONS_DOC_REL) + '\n')
    process.stdout.write(`图标系统已定:${s.label}(${design.ICONS_DOC_REL})\n`
      + `取图标一律用 sbot design icon <名字…>,别自己写 path;语义名按这套系统的叫法(更多 → ${design.resolveIconName('more', s)})。\n`
      + `描边/端点/尺寸/颜色仍归设计风格档 —— 这两件事平级、各配各的。\n`)
    return
  }
  if (action === 'icon') {
    // 取图标(契约见 docs/ICONS.md)。**这条命令才是「跟设计图统一」的正路** —— 检查器只能
    // 发现不一致、造不出一致;没有它,声明 library 也只是一句空话,agent 照样自创 path。
    // 语义名先经风格档 semantics 翻译(back → chevron-left),没命中就当图标名原样查。
    // ⚠ 用法排在最前(同 check 那条):在还没选图标系统的项目里问「怎么用」,答的不该是「你还没选」
    const DESIGN_ICON_USAGE = '用法: sbot design icon <名字…> [--sprite] [--size sm|md|lg|<px>] [--label "文案"] [--as <用途>]\n'
      + '      例: sbot design icon back more close --sprite\n'
      + '      按语义名取图标(先经风格档 semantics 翻译),已按风格档归一描边 / 尺寸并带来源指纹;stdout 是纯 SVG,可直接贴进页面\n'
      + '      --sprite 合成一张 <symbol> 雪碧图;--size 给档位名或直接给像素数;--label 无障碍名,只能配一个图标\n'
      + '      须机器装了对应图标包(没装会如实说并给装法);选用哪套图标系统是另一条:sbot design icons'
    if (helpFlag) return helpOut(DESIGN_ICON_USAGE)
    if (!positionals.length) return die(DESIGN_ICON_USAGE)
    const docs = design.findStyleDocs({ cwd: process.cwd() })
    const pick = design.pickStyleDoc(docs, asOpt)
    const tokens = pick ? design.parseStyleTokens(fs.readFileSync(pick.abs, 'utf8')) : {}
    const iconsDoc = design.findIconsDoc({ cwd: process.cwd() })
    const spec = design.iconSpec(tokens, iconsDoc)
    if (!spec) return die(`本项目还没选图标系统 —— sbot design icons use <${Object.keys(design.ICON_SYSTEMS).join('|')}> 落一份 ${design.ICONS_DOC_REL}`
      + '\n  (图标与设计风格是两件事:图标档管图形从哪来、叫什么名;风格档管怎么画它)'
      + styleAltHint(docs, pick, asOpt))
    // 一个无障碍名套在多个不同图标上必然是错的(读屏会把「更多」念成「返回」)——挡在这里
    if (labelOpt && positionals.length > 1) return die('--label 只能配一个图标:无障碍名是这个图标的名字,套给多个必然张冠李戴')
    // base = sbot 自己的包根:全局安装时它的同级就是那两个图标包(最稳的一条);
    // 配置里的 design.iconsDir 优先(operator 可以指到别处)。读不到配置不该让取图标失败。
    const roots = iconRootsHere()
    const dirs = design.iconDirs(spec, roots)
    if (!dirs.length) {
      // 软降级(教训 6):没装就如实说 + 给装法,不阻断别的事
      // ⚠ 装法按**这个项目选的系统**给包名:此前写死 lucide/tabler 两个包,选了 phosphor / pixelart 的项目
      //   照着装完还是没有 —— 一句给错的装法比不给更耗时间。
      const pkgs = [spec.library, spec.fallbackLibrary].filter(Boolean).map((l) => (design.ICON_LIBS[l] || {}).pkg).filter(Boolean)
      return die(`机器上没有图标库(要 ${spec.library}${spec.fallbackLibrary ? ' / ' + spec.fallbackLibrary : ''})—— 装一次即可:npm i -g ${pkgs.join(' ') || 'lucide-static @tabler/icons'}`)
    }
    const px = sizeOpt && /^[0-9.]+$/.test(sizeOpt) ? parseFloat(sizeOpt) : (spec.size[sizeOpt || 'md'] || spec.size.md || spec.grid)
    const got = [], missing = []
    for (const name of positionals) {
      const hit = design.readIcon(name, spec, dirs, {})
      if (hit) got.push({ ...hit, asked: name }); else missing.push(name)
    }
    if (missing.length) return die(`这些图标两个库里都没有:${missing.join(' / ')} —— 换个名字(用库里的英文名,如 chevron-left / trophy),或在风格档 icons.semantics 里给它定个语义名`
      + styleAltHint(docs, pick, asOpt))
    if (spriteFlag) process.stdout.write(design.iconSpriteSvg(got, spec) + '\n')
    // ⚠ 带上来源指纹(`data-icon="库/名字"`):没有它,换了图标系统之后页面里的旧图标**没有
    //   任何东西会发现**(2026-08-25 真机)。sprite 那条在 iconSpriteSvg 里写进每个 symbol。
    else for (const g of got) process.stdout.write(design.normalizeIconSvg(g.svg, spec, { size: px, label: labelOpt || '', source: g.lib + '/' + g.name }) + '\n')
    // 署名走 stderr:stdout 要保持纯净(agent 会直接把它写进页面),但 ISC 要求副本保留声明 ——
    // sprite 模式已把声明写进产物里,单图标模式在这里提醒一句。
    // 实心图标上报「描边 N」是假信息:那批本来就没有描边(fill 撑起图形)
    // ⚠ 但「声明实心 + 取不到实心」时这行会跟着声明写「实心」,而手里的其实是线性 ——
    //   两处一起骗人。先把差距说出来,再按**真拿到的**报。
    const gap = design.iconStyleGap(spec, dirs)
    if (gap) process.stderr.write(dim('  ⚠ ' + gap + '\n'))
    // 指名了图标系统却声明了它给不了的 style ⇒ 那些图标全从兜底库来,「选了系统」当场作废(F3)。
    // 这条与上面那条互斥(兜底供得上 / 供不上),不会同时出声。
    const sysGap = design.iconSystemGap(spec, dirs)
    if (sysGap) process.stderr.write(dim('  ⚠ ' + sysGap + '\n'))
    // 图标来源在风格档里还留着一份旧声明 ⇒ 说清哪份赢了。不说的话那行会长期看着有效、实则一个字不起作用
    const conflict = design.iconSourceConflict(spec, tokens, iconsDoc && iconsDoc.rel, { projHasAssets: !!(iconsDoc && iconsDoc.assets.length) })
    if (conflict) process.stderr.write(dim('  ⚠ ' + conflict + '\n'))
    // ⚠ 图标档里写了个认不出的系统名 ⇒ 这次的图全来自默认库,必须说破(否则「取自 Lucide」看着像正常)
    if (spec.systemUnknown) process.stderr.write(dim(`  ⚠ 图标档里写着「${spec.systemUnknown}」,这不是图标系统的名字 —— 本次退回默认库;可选:${Object.keys(design.ICON_SYSTEMS).join(' / ')}\n`))
    // ⚠ **按手里这几张图真实的样子报,不按声明报**(v0.11.53 真机撞到:system lucide + 声明实心,
    //   摘要写着「实心」而递出去的是 lucide 的线性 more-horizontal)。`!gap` 只挡得住「一张实心
    //   都取不到」那一种,挡不住「这次这几个名字恰好没有实心版」—— 实测词表 62 条里 tabler 的
    //   实心只覆盖 48 条,混着出是常态,不是边角料。
    // ⚠ 判据是**取自哪个变体目录**,不是 svg 的 fill 属性:填充型库里每张图都是 fill=currentColor,
    //   按 fill 判会把 pixelart(根本没有实心变体)的图一律报成「实心」,而同一屏的提示正说着
    //   「你会拿到线性」—— 两句话打架。取不到目录声明时(手搓 dirs)才退回按 fill 判。
    const fills = got.map((g) => (g.style ? g.style === 'filled' : design.iconIsFilled(g.svg)))
    const filledOut = fills.length > 0 && fills.every(Boolean)
    const mixedOut = fills.some(Boolean) && !filledOut
    // ⚠ 多份档时「归一到哪一份」也得说 —— 描边粗细与尺寸档是按那份档归一的,挑错档取出来的
    // 图标跟设计图对不上,而 SVG 本身看不出是照哪份归的。同样走 stderr,不污染 stdout。
    const which = styleWhich(docs, pick, asOpt)
    process.stderr.write(dim(`  取自 ${[...new Set(got.map((g) => (design.ICON_LIBS[g.lib] || {}).label || g.lib))].join(' / ')}(${filledOut ? '实心' : mixedOut ? `实心 ${fills.filter(Boolean).length} 个 · 线性 ${fills.filter((x) => !x).length} 个〔库里没实心版〕` : (spec.form === 'fill' ? '线性〔填充型库,无描边可言〕' : '描边 ' + spec.strokeWidth)} · ${px}px · 已归一到本项目风格档)\n`
      + (which ? `  ${which}\n` : '')))
    return
  }
    // ⚠ **光秃秃的 `sbot design` 与 `sbot design --help` 也要答得出「有哪些子命令、各干什么」**。
    //   在此之前两者都回「unknown design action ''」—— 而「不认识 ''」对第一次碰这条命令的人
    //   什么都没说。⭐ 按**查什么对象**分组列,不按实现顺序:三条验收平级、只是对象不同
    //   (页面写法 / 图标文件 / 渲染几何),这一点靠一行行的名字看不出来,必须写出来。
    // ⚠ 求助(--help)与「没给子命令 / 给错子命令」用同一份正文,但**退出码不同**:
    //   前者是它要的答案 ⇒ stdout + 0;后者是用错了 ⇒ stderr + 1。
    // ⚠ 这里的参数照代码写(2026-09-08 对账):extract-colors 曾写「图/网址」而它只收项目内图片文件、
    //   swatch 漏了 --all / --out、四条验收没说退出码 3 —— 顶层清单说错,agent 第一次就照错的敲。
    const DESIGN_USAGE = (`用法: sbot design <动作> [参数…]\n`
      + `\n  设计风格(色板 / 字体 / 圆角 / 图标画法)\n`
      + `    styles                                      看风格库有哪几套(按场景分组)\n`
      + `    use <slug> [--as <用途>] [--out <.md>] [--force]    给本项目落一份风格档;--as 落 design/styles/<用途>.md,一个项目可多份\n`
      + `    swatch <slug…> | --current | --all [--out <.png>]   把风格画成预览图(点名最多 4 套;--current 画本项目全部档)\n`
      + `    extract-colors <图片> [--n <1-12>] [--json]         从参考图提色(项目内的图片文件,不收网址)\n`
      + `\n  图标(与设计风格平级:图形从哪来、叫什么名)\n`
      + `    icons [--sheet]                             看图标库有哪几套 · 本项目在用哪套;--sheet 出带序号的对照图供群里指着选\n`
      + `    icons use <系统> [--assets <目录,…>] [--no-fallback] [--force]   给本项目定一套(落 ${design.ICONS_DOC_REL});已定过要 --force\n`
      + `    icon <名字…> [--sprite] [--size sm|md|lg|<px>] [--label "文案"]  取图标(已按风格档归一;别自己写 path)\n`
      + `\n  交付前的四条验收(平级,按查什么对象分;退出码 0 无偏离 / 3 有偏离 ≠ 命令失败 / 1 命令失败;都收 --json)\n`
      + `    check <文件…>                               查页面写法:色板 / 圆角 / 字体与可得性 / 图标参数与来源\n`
      + `    icon-assets [目录或 svg…]                   查图标文件本身:能不能继承颜色 / 同图多份 / 参数偏离(范围须声明,不自动发现)\n`
      + `    layout <html…> [--widths 1280,1000,430]     查渲染出来的几何:文字重叠 / 内容被裁 / 点击目标过小(须常驻浏览器,多档宽度)\n`
      + `    doctor                                      查风格档本身:语义色放错段 / 色板读不清 / 中文兜底 / 非标准字重 / 首选字体装没装\n`
      + `\n  多份风格档时每条都要 --as <用途> 指名(生图那边叫 --style),不指名用第一份并会说明\n`
      + `每条都收 --help`)
    if (helpFlag || topHelp) return helpOut(DESIGN_USAGE)
    die(DESIGN_USAGE + (action ? `\n\n(不认识的子命令:'${action}')` : ''))
  }
}

// --wait 默认秒数:生图实测 91~516s,而 agent 的 Bash 工具普遍 120s 超时 ⇒ 默认取 90s,
// 让「等到了」和「Bash 超时」两种结局都落在 agent 还能读到输出的窗口内。等不到不是失败
// (worker 是 detached 的),所以这个值宁短勿长 —— 长了只是白占着 agent 的一次工具调用。
const WAIT_DEFAULT_SEC = 90

// 图标库在这台机器上的位置。base = sbot 自己的包根:全局安装时它的同级就是那几个图标包
// (最稳的一条);配置里的 design.iconsDir 优先(operator 可以指到别处)。读不到配置不该让
// 取图标/查图标失败。⚠ **收成一处**:取图标与查来源两条路都要它,各写一份就会漂 ——
// 一边认 design.iconsDir、另一边不认,症状是「取得到的图标,检查器说它来路不明」(教训 35)。
function iconRootsHere() {
  let extraDir = null
  try { const c = loadConfig(); extraDir = (c.design && c.design.iconsDir) || null } catch { /* 没配置就只认同级 */ }
  return design.iconRoots({ base: path.join(__dirname, '..'), extra: extraDir })
}

// 多份风格档时:**用了哪份必须说出来**。imagen 受理输出早有这条(「风格依据:…」),check 与 icon
// 当初漏了 —— 2026-08-18 真机:某项目放进两份档当天,不指名的 `design check` 拿后台那份去查小
// 程序的 wxss,把小程序自己的主绿 #1B6B37 报成「不在色板里」。⚠ **对错了档的报告比没有报告更糟**:
// 它长得像一份正经回归报告,人照着改反而把对的改错。单档项目不出这行(平白多一行就是噪音)。
function styleWhich(docs, pick, asOpt) {
  if (!pick || !Array.isArray(docs) || docs.length < 2) return ''
  const who = pick.platform || pick.rel
  if (asOpt) return `风格依据:${who}(本项目共 ${docs.length} 份,已指名)`
  return `风格依据:${who} —— ⚠ 没指名,默认用了第一份;换一份加 --as <用途>:${docs.map((d) => d.platform || d.rel).join(' / ')}`
}

// 报错时追加的一句。**只在「多份 + 没指名」时出** —— 那种情形下十有八九是「要的东西在另一份
// 里」(语义名 rank 定义在小程序档,却对着后台档去查),而原报错只会说「两个库里都没有」,把人
// 引向改名字或改 semantics,越走越远。
function styleAltHint(docs, pick, asOpt) {
  if (asOpt || !Array.isArray(docs) || docs.length < 2) return ''
  const who = (pick && (pick.platform || pick.rel)) || docs[0].platform || docs[0].rel
  return `\n  ⚠ 本项目有 ${docs.length} 份风格档,这次用的是「${who}」(没指名 ⇒ 默认第一份)—— 要找的多半在另一份里,加 --as <用途>:${docs.map((d) => d.platform || d.rel).join(' / ')}`
}

// 给风格档补一行 tokens 摘要(色板/字体/圆角/状态色)供自知清单注入。读不了就退回原样 ——
// 摘要缺失只是少一段提示,不该让整份清单注入失败。
function withDigest(d, iconsDoc = null) {
  try {
    const tokens = design.parseStyleTokens(fs.readFileSync(d.abs, 'utf8'))
    // icons:这个项目有没有图标口径 —— 清单据此决定教「怎么取图标」还是「这一类没启用」。
    // ⚠ 判据现在跨两份档(图标档选系统 / 风格档定画法),任一边有就算有 —— 项目选了系统而
    //   风格档没写过图标,画法退回默认即可,清单不该说「没启用」。
    // iconAssets:声明了图标资产目录吗 —— 只有声明了,资产体检才有扫描范围可言,
    // 清单也才值得多这一句(没声明的项目多一行就是纯噪音,而清单每轮都付 token)。
    const spec = design.iconSpec(tokens, iconsDoc)
    return { ...d, digest: design.tokenDigest(tokens, { project: iconsDoc }), icons: !!spec, iconAssets: !!(spec && spec.assets.length) }
  } catch { return d }
}

// ── sbot imagen — 生图基础技能(异步 detached worker;src/agent/imagen.js 放可测逻辑,这里只接线)──
// 受理进程写任务文件、spawn 脱离进程树的 worker 后立即返回 ⇒ agent 的 Bash 调用秒回,群锁
// 不被生图占用(主对话并行,2026-07-22 拍板);worker spawn `codex exec --json` 固定生图模板
// (非自由指令 —— 确定性专用任务,不是嵌套 agent),成图后自动上板(spawn board-add-image 子
// 命令,完整复用围栏/摆放/ops 留痕)+ 发群通知,全程零模型成本。原始 --json 流存
// ~/.sbot/imagen/<id>.stream.jsonl(生图进度粒度分析素材,docs/BOARD.md 未决)。
async function cmdImagen(rest) {
  if (rest[0] === '--_worker') return imagenWorker(rest[1]) // 内部入口(detached spawn 出来的)
  let outOpt, labelOpt, chatOpt, configOpt, modelOpt, besideOpt, styleOpt, maskOpt, deliverFlag = false, waitSec = 0, listFlag = false, noBoardFlag = false, transparentFlag = false
  let helpFlag = false
  const refOpts = [] // --ref 可给多次(多参考图),顺序即 prompt 里的编号
  const positionals = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--ref') refOpts.push(rest[++i]) // 输入图/参考图:给了就是编辑语义(设计图→网页资产管线)
    else if (a === '--mask') maskOpt = rest[++i] // 遮罩:透明处重绘、不透明处保原样(局部重绘/补全)
    else if (a === '--transparent') transparentFlag = true // 输出真 alpha 透明底 PNG(抠素材给网页)
    else if (a === '--out') outOpt = rest[++i]
    else if (a === '--label') labelOpt = rest[++i]
    else if (a === '--beside') besideOpt = rest[++i] // 参照节点 id:上板时放它右侧(改图场景透传给 board-add-image)
    else if (a === '--deliver') deliverFlag = true // 按标注改图交付:成图结果回填进群里那张播报卡(单卡)
    else if (a === '--chat') chatOpt = rest[++i]
    else if (a === '--config') configOpt = rest[++i]
    else if (a === '--model') modelOpt = rest[++i]
    else if (a === '--style') styleOpt = rest[++i] // 项目有多份风格档时指名用哪份(载体词 / 文件名 / 档名)
    else if (a === '--no-board') noBoardFlag = true // 与设计/产品流程无关的单张图:只发群,不进画布
    // --wait [秒]:受理后原地等一会儿(worker 恒 detached,等不到也不影响它跑完)。
    // --sync 保留为别名 —— 旧清单/旧习惯里全是它,直接删会让 agent 拿到「未知参数」而不是
    // 正确行为;但语义已换成「等待」而非「在当前进程跑」(见受理段注释)。
    else if (a === '--wait' || a === '--sync') {
      const n = Number(rest[i + 1])
      if (Number.isFinite(n) && n > 0) { waitSec = Math.min(n, 600); i++ } else waitSec = WAIT_DEFAULT_SEC
    }
    else if (a === '--list') listFlag = true
    // ⚠ 必须显式吃掉 --help,否则它落进 positionals **变成画面描述**:
    //   `sbot imagen --help --out x.png` 会真的拿「--help」去生图。与 v0.11.50
    //   在 design 一族治的是同一个形状。
    else if (a === '--help' || a === '-h') helpFlag = true
    else positionals.push(a)
  }
  // --beside/--deliver 是「这张图在设计流程里」的显式信号,与 --no-board 直接矛盾 ⇒ 忽略后者
  // 并说明。倒过来(让 --no-board 赢)会让按标注改图的交付悄悄丢板,那是核心闭环。
  if (noBoardFlag && (besideOpt || deliverFlag)) {
    process.stderr.write(dim('  (--no-board 与 --beside/--deliver 矛盾 —— 后者表示这张图属于设计流程,本次仍上画布)\n'))
    noBoardFlag = false
  }
  const dir = imagen.imagenDir()
  if (listFlag) {
    imagen.reapStale(dir) // 读侧自愈:进程已死/超龄的 running 当场落成失败,别让它永远挂着
    const tasks = imagen.listTasks(dir).slice(-10)
    if (!tasks.length) { process.stdout.write('(无生图任务记录)\n'); return }
    for (const t of tasks) {
      const st = t.status === 'running' ? (imagen.pidAlive(t.pid) || t.pid == null ? '进行中' : '已中断') : t.status === 'ok' ? '完成' : '失败'
      process.stdout.write(`${t.id}  [${st}]  ${t.label || t.outRel}${t.error ? '  — ' + t.error : ''}\n`)
    }
    return
  }
  // ⚠ 退出码契约(2 = 仍在跑,不是失败)必须写在 help 里:此前只在运行时文案里说,而 agent 是先读 help
  //   再决定「退出码非 0 要不要重试」的 —— 有一次卡死就是把 2 当失败重投出来的。
  const IMAGEN_USAGE = '用法: sbot imagen "<画面描述>" --out <相对路径.png> [--label "方案1"] [--style <用途>] [--no-board] [--wait [秒]]\n'
    + '      改图 / 抠图 / 补全: sbot imagen "<处理要求>" --ref <输入图> [--ref <图2>…] [--mask <遮罩>] [--transparent] --out <相对路径.png>\n'
    + '      按标注改图交付:   sbot imagen "<处理要求>" --ref <原图> --beside <原图节点id> --deliver --out <相对路径.png>\n'
    + '      看任务:           sbot imagen --list\n'
    + '      借本机 codex 订阅生图,任何模型的群都能用。受理即返回、后台跑完发群;受理成功 ≠ 文件已存在\n'
    + '      --wait [秒] 原地等(默认 90,最多 600);退出码 0 完成 / 1 失败 / 2 仍在跑或同一 --out 已在跑 —— 不是失败,别重试;同时最多 2 个任务\n'
    + '      --ref 可多次,描述里按 [1][2] 引用 = 在这张图上动手,不是照描述重画;--mask 只重绘遮罩透明处(须配 --ref);--transparent 出真透明底\n'
    + '      属于设计流程的图自动上板,散图加 --no-board;--beside / --deliver 表示在设计流程里,会压过 --no-board\n'
    + '      多份风格档时 --style <用途> 指名(design 那边叫 --as);目标群取 --chat <oc_…> 或 $SBOT_CHAT_ID'
  if (helpFlag) return helpOut(IMAGEN_USAGE)
  const promptText = positionals.join(' ').trim()
  if (!promptText || !outOpt) return die(IMAGEN_USAGE)
  // --mask 只在有输入图时有意义:遮罩是「在这张图上圈出要重绘的区域」,没有那张图就无从谈起。
  // 静默忽略会让人以为局部重绘生效了(实际是整张重画)⇒ 直接拒。
  if (maskOpt && !refOpts.length) return die('--mask 需配合 --ref 使用 —— 遮罩是圈定「在哪张输入图上重绘」,单独给没有意义')
  const chatId = chatOpt || process.env.SBOT_CHAT_ID
  if (!chatId) return die('缺群上下文 — 群 agent 自动带 SBOT_CHAT_ID;手工运行加 --chat <chatId>')
  const cfg = loadConfig(configOpt) // 校验配置可读 + 把 _path 交给 worker(worker cwd 不同,须显式)
  if (!cfg.feishu || !cfg.feishu.appId) return die('配置缺 feishu 应用凭证 — 生图完成通知发不了群')
  const abs = resolveSendPath(process.cwd(), outOpt, false) // 写围栏(镜像 send/download 系动作)
  // 输入图/遮罩走**读围栏**(第三参 true = 必须已存在),与 send-file 同一套:群里的 agent
  // 够得着这个命令,路径不设防就等于给了「把机器上任意图片喂给生图后端」的口子。
  // 解析成绝对路径再落任务 —— worker 的 cwd 与这里不同。
  let refAbs, maskAbs
  try {
    refAbs = refOpts.map((p) => resolveSendPath(process.cwd(), p, true))
    maskAbs = maskOpt ? resolveSendPath(process.cwd(), maskOpt, true) : null
  } catch (e) { return die((e && e.message) || String(e)) }
  // 读侧自愈:进程已死/超龄的 running 当场落成失败 —— 这一步必须在下面两道闸之前,
  // 否则一条僵尸任务既能占满并发位、又能把「同一张图」的挡板挡在自己身上,新任务永远进不来。
  imagen.reapStale(dir)
  // 同一张图的重复提交(2026-09-05 事故):群里的 agent 见失败就原样重投,同一个 outRel 投到 3 次,
  // 每次烧满 10 分钟墙钟 ⇒ 并发上限 2 的队列被同一张图占死。全局并发只数个数、不问是不是同一张图,
  // 所以必须在它之前单独拦一道 —— 而且要给的是「别重投」的话,不是「稍后再试」。
  const dup = imagen.findRunningForOut(imagen.listTasks(dir), abs, { chatId })
  if (dup) {
    process.stderr.write(red('sbot: ' + imagen.buildDupMessage(dup)) + '\n')
    // ⚠ 2 而不是 1 —— 与 `--wait` 的「仍在跑,不是失败,别重试」同一个码:对 agent 来说这两种
    // 情形的下一步动作完全一样(什么都别做,等群里的图)。给 1 会被读成「命令失败 ⇒ 重试」,
    // 那正是这个 bug 的形状。
    process.exitCode = 2
    return
  }
  const running = imagen.countRunning(dir)
  if (running >= imagen.IMAGEN_MAX_CONCURRENT) return die(`生图并发已满(${running}/${imagen.IMAGEN_MAX_CONCURRENT} 个任务进行中)— 稍后再试;sbot imagen --list 可查看`)
  // 风格档选档(v0.11.22):项目可能有多份(小程序一份、后台一份…)。**受理侧就定下来并落进任务**
  // —— worker 是另一个进程、cwd 也不同,让它自己再猜一次就会出现「群里说用了 A、实际喂了 B」。
  const styleDocs = design.findStyleDocs({ cwd: process.cwd() })
  const stylePick = design.pickStyleDoc(styleDocs, styleOpt)
  if (styleOpt && !stylePick) {
    return die(`没有名为「${styleOpt}」的风格档 —— 本项目现有:${styleDocs.map((d) => d.platform || d.rel).join(' / ') || '(一份都没有)'}`)
  }
  const task = imagen.newTask({ chatId, workdir: process.cwd(), out: abs, outRel: outOpt, label: labelOpt, prompt: promptText, configPath: cfg._path, model: modelOpt, beside: besideOpt, deliver: deliverFlag, noBoard: noBoardFlag, styleDoc: stylePick ? stylePick.abs : null, refs: refAbs, mask: maskAbs, transparent: transparentFlag })
  imagen.writeTask(dir, task)
  // ⚠ 2026-08-14 修:这里**恒走 detached**,`--wait/--sync` 只是在受理之后
  // 多轮询一会儿。旧版 `--sync` 直接在**当前进程**跑 worker —— 而当前进程是 agent 的 Bash 子
  // 进程,生图实测 91~516s、远超 agent Bash 工具的超时,超时/轮次结束即被杀 ⇒ 任务永远卡在
  // running、图从未生成,agent 那头只看到「命令结束了」就当成功,接着把不存在的文件写进页面。
  // 改成 detached 之后,受理进程就算被杀,worker 照样活着把图跑完并发群 —— 等不到 ≠ 失败。
  const logFd = fs.openSync(path.join(dir, task.id + '.log'), 'a')
  const child = require('node:child_process').spawn(process.execPath, [__filename, 'imagen', '--_worker', imagen.taskFile(dir, task.id)], { detached: true, stdio: ['ignore', logFd, logFd] })
  child.unref()
  fs.closeSync(logFd)
  const hasBoard = cfg.groups && cfg.groups[chatId] && cfg.groups[chatId].board && cfg.groups[chatId].board.whiteboardId
  // 用了哪份风格档必须**说出来**:项目有多份时,悄悄挑一份就是「做了 A 让人以为做了 B」。
  const styleLine = styleDocs.length > 1 && stylePick
    ? `风格依据:${stylePick.platform || stylePick.rel}(本项目共 ${styleDocs.length} 份;换一份加 --style <用途>)\n`
    : ''
  process.stdout.write(styleLine + `已受理(任务 ${task.id}):后台生图中,完成后自动${hasBoard ? '上画布并' : ''}在群里发图+通知。\n` +
    // ⚠ 这一行管另一半:受理成功 ≠ 图已存在。不说死,agent 会拿着退出码 0
    // 立刻把这个路径写进页面 —— 而文件那时还不存在,做出来就是一堆 404。
    `⚠ 此刻 ${outOpt} 还不存在,先别引用它;要图才能继续的活等图到了下一轮再做。\n` +
    `不阻塞当前对话 —— 你不需要等待或轮询,可以继续做别的/直接结束本轮。\n` +
    `(同时最多 ${imagen.IMAGEN_MAX_CONCURRENT} 个生图任务;想原地等一会儿加 --wait [秒])\n`)
  if (!waitSec) return
  // 轮询等待:worker 已经 detached 起来了,这里只是盯任务文件的状态。
  // 退出码三态 —— 0 完成 · 1 失败 · 2 仍在跑(**不是失败**,文案里说死);agent 据此决定
  // 能不能引用文件。读侧顺手 reapStale:僵尸任务(进程已死/超龄)当场落成失败,否则这里会
  // 一直等一个永远不会变的 running。
  const r = await imagen.waitForTask({
    read: () => imagen.readTask(imagen.taskFile(dir, task.id)),
    reap: () => imagen.reapStale(dir),
    deadlineMs: Date.now() + waitSec * 1000,
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  })
  if (r.status === 'ok') { process.stdout.write(imagen.WAIT_TEXT.ok(task.outRel) + '\n'); return }
  if (r.status === 'fail') { process.stdout.write(imagen.WAIT_TEXT.fail(task.outRel, r.error) + '\n'); process.exitCode = 1; return }
  process.stdout.write(imagen.WAIT_TEXT.pending(task.outRel, waitSec) + '\n')
  process.exitCode = 2 // ⚠ 不是失败 —— 但必须非零,返回 0 正是这个 bug 的成因(文案里说死)
}

// worker 主流程:spawn codex 生图 → 校验产物 → 上板(有画布)→ 发群通知 → 落任务状态。
// 通知失败只记日志(任务状态照落);任何路径都不留 running 悬置。
async function imagenWorker(file) {
  if (!file) return die('imagen --_worker 需任务文件路径(内部命令)')
  const dir = path.dirname(file)
  let task = imagen.readTask(file)
  task.pid = process.pid
  imagen.writeTask(dir, task)
  const finish = (status, extra) => { task = { ...task, status, finishedAt: Date.now(), ...(extra || {}) }; imagen.writeTask(dir, task) }
  let cfg
  try { cfg = loadConfig(task.configPath || undefined) } catch (e) { finish('fail', { error: e.message }); return false }
  applyProxyEnv(cfg) // ⚠ codex 的 WS 客户端只认 env 代理变量(实测:不设则直连被墙/慢 12 倍)
  // worker 的子命令(board-add-image)在 **项目目录** 里跑,那儿没有 sbot.config.json ⇒ 不显式
  // 告诉它配置在哪,`loadConfig` 就读到内置默认、`die('feishu 未配置')`,而上板失败只记一行日志:
  // 任务照落 ok,群里那张图就是没进画布,没人知道为什么。与 engine 给群 agent 注入的同一口径。
  // ⚠ 平时藏着:群里发起时 agent 环境本来就有 SBOT_CONFIG,worker 继承了它 ⇒ 只有**从终端手投**
  //   (出事故后重投失败的那张图时)才露出来。放在这里而不是逐个 spawn 点传 —— 将来再加子命令
  //   不必记得带上它。
  if (cfg._path) process.env.SBOT_CONFIG = cfg._path
  // ⚠ 客户端提到生图**之前**建(进度消息要用它)⇒ 建不出来必须当场落成失败,不能让异常把
  // worker 带走、把任务永远停在 running(那要等 reapStale 才收得掉)。
  // 群在哪个平台就走哪条通知路:飞书 = 卡片(进度卡 / 完成卡 / 失败卡);企微 = 官方命令行工具发图 + markdown(没有进度消息 ——
  // 工具发出去的消息改不了,挂一条「生成中」只能永远挂着)。企微没有画布,上板那段自然走不到(群配置里没有 board)。
  const onWecom = chatPlatform(cfg, task.chatId) === 'wecom'
  let client = null
  const wc = onWecom ? createWecomCli({ bin: (cfg.wecom && cfg.wecom.cli) || 'wecom-cli' }) : null
  if (onWecom && cfg.wecom && cfg.wecom.cli === false) { finish('fail', { error: '群通知通道不可用:企业微信命令行工具已在配置里关闭' }); return false }
  if (!onWecom) { try { client = feishuClient(cfg.feishu.appId, cfg.feishu.appSecret) } catch (e) { finish('fail', { error: '群通知通道不可用:' + (e && e.message) }); return false } }

  // ── 群里那条会自己更新的进度消息(docs/BOARD.md 2026-07-22 待办;09-05 真机证实是真痛点:
  //    12 个任务各跑 10 分钟,群里只看到「受理」和最后的「失败」)。
  // 形态取**实体卡原地更新**而非文本 edit:发卡是现成的 `sendChatCard`(它返回 cardId,文本那条
  // 路的 sendChatText 不返回 message_id),且与完成卡/失败卡同一套体裁。
  // ⚠ 纯增益:发不出、更不动一律只记一行 stderr,绝不影响生图与交付。
  let progress = null // { msgId, cardId }
  let stage = 'start'
  let pushedStage = null
  let lastPushAt = null
  let pushing = false
  const progressCard = () => imagen.buildProgressCard(task, { stage, elapsedMs: Date.now() - (task.createdAt || Date.now()), redact })
  const pushProgress = async (force = false) => {
    if (!progress || pushing) return
    const now = Date.now()
    if (!force && !imagen.shouldPushProgress({ stage, pushedStage, lastPushAt }, now)) return
    pushing = true
    pushedStage = stage; lastPushAt = now
    try { await updateCardEntity(client, progress.cardId, progressCard()) }
    catch (e) { process.stderr.write('进度更新失败(忽略): ' + (e && e.message) + '\n') }
    finally { pushing = false }
  }
  if (client) {
    try { progress = await sendChatCard(client, task.chatId, progressCard()); lastPushAt = Date.now(); pushedStage = stage }
    catch (e) { progress = null; process.stderr.write('进度消息发不出(忽略): ' + (e && e.message) + '\n') }
  }
  // 收尾:撤回进度卡,正式通知随后单独发(BOARD.md 方案里的「撤回后发正式通知」)。撤回失败就
  // 把它改成终态 —— **进度消息绝不能留在「生成中」永远挂着**,失败路径尤其(那正是最想看它的时候)。
  const closeProgress = async () => {
    if (!progress) return
    const p = progress; progress = null
    try { await recallMessage(client, p.msgId) } catch {
      stage = 'ended'
      try { await updateCardEntity(client, p.cardId, progressCard()) } catch (e) { process.stderr.write('进度卡收尾失败(忽略): ' + (e && e.message) + '\n') }
    }
  }
  // 心跳靠定时器不靠事件:流事件很稀(10 分钟才十来条),等事件来推进度就等不来。
  const ticker = setInterval(() => { pushProgress(false) }, imagen.IMAGEN_PROGRESS_TICK_MS)
  if (ticker.unref) ticker.unref()

  // 起跑前给 out 拍快照 —— 失败时靠它区分「本次写下的半成品」与「上一版成功的图本来就在那儿」。
  const beforeOut = imagen.statOut(task.out)
  const r = await imagenRunCodex(task, dir, cfg, (ev) => { stage = imagen.nextStage(stage, ev) })
  clearInterval(ticker)
  if (!r.ok) {
    // 失败(含墙钟超时)必须把 out 上那一版挪走:留着它,下一轮 agent 一看文件在就当图做好了,
    // 拿一张 codex 自己都没验收通过的半成品去交付(2026-09-05 实测=旧指针残影+灰色补丁块)。
    const q = imagen.quarantinePartial(task.out, beforeOut)
    const reason = imagen.withPartialNote(r.reason, q.moved ? imagen.partialPath(task.outRel) : null)
    // ⚠ 先落任务状态再去发消息:`--wait` 那头轮询的就是这个文件,不能让一次卡住的群通知
    // 把「已经失败了」这件事拖成「还在跑」。
    finish('fail', { error: reason, partial: q.moved ? imagen.partialPath(task.outRel) : null })
    await closeProgress()
    try {
      // deliver 任务失败:出队播报卡锚点收尾成失败态(done 兜底已让位给本 worker,不收会卡「处理中」)
      if (task.deliver) {
        const n = shiftNotice(boardNoticeDir(), task.chatId)
        if (n && n.cardId) await updateCardEntity(client, n.cardId, { schema: '2.0', config: { width_mode: 'default' }, header: { title: { tag: 'plain_text', content: '⚠️ 生成图片失败' }, template: 'orange' }, body: { padding: '16px', vertical_spacing: '8px', elements: [{ tag: 'markdown', content: '本轮改图的图片生成失败,详见群里消息 —— 可在群里直接说需求重试。' }] } }).catch(() => {})
      }
      if (onWecom) await wc.sendMarkdown(task.chatId, redact(imagen.buildFailMessage(task, reason)))
      else {
        const mid = await sendChatCard(client, task.chatId, imagen.buildFailCard(task, reason, { redact })).catch(() => null)
        if (!mid) await sendChatText(client, task.chatId, redact(imagen.buildFailMessage(task, reason)))
      }
    } catch (e) { process.stderr.write('通知失败: ' + (e && e.message) + '\n') }
    return false
  }
  // 上板 = spawn board-add-image 子命令(与 agent 手动上板同路径:围栏/摆放/标签/ops 留痕全复用)。
  // deliver 任务透传 --deliver ⇒ 子命令出队回填播报卡/新发结果卡 = 交付完成,worker 不再另发
  // done 卡(否则双卡);--note 带耗时补齐结果卡元信息。
  let boardOk = false
  const elapsedMs = task.createdAt ? Date.now() - task.createdAt : null
  const g = cfg.groups && cfg.groups[task.chatId]
  // 上板/上传也要几秒到几十秒 —— 让进度卡先走到「收尾中」再去干活,别在最后一段又静默下来。
  stage = 'wrap'
  await pushProgress(true)
  // noBoard:与设计/产品流程无关的单张图只发群 —— 画布是设计演变档案,不是图片收纳箱。
  if (!task.noBoard && g && g.board && g.board.whiteboardId) {
    boardOk = await new Promise((res) => {
      const args = [__filename, 'feishu', 'board-add-image', task.outRel]
      if (task.label) args.push('--label', task.label)
      if (task.beside) args.push('--beside', task.beside)
      if (task.deliver) { args.push('--deliver'); if (elapsedMs) args.push('--note', `生成耗时 ${Math.round(elapsedMs / 1000)}s`) }
      const c = require('node:child_process').spawn(process.execPath, args, { cwd: task.workdir, env: { ...process.env, SBOT_CHAT_ID: task.chatId }, stdio: ['ignore', 'inherit', 'inherit'] })
      c.on('close', (code) => res(code === 0))
      c.on('error', () => res(false))
    })
  }
  const delivered = boardOk && task.deliver // --deliver 的 board-add-image 已回填/新发结果卡
  // 进度卡在正式通知之前撤掉 —— deliver 那条路 worker 不再另发卡(结果已回填播报卡),
  // 不在这里收尾就会留一张永远「生成中」的卡挂在群里。
  await closeProgress()
  if (!delivered && onWecom) try {
    await wc.sendImage(task.chatId, task.out)
    await wc.sendMarkdown(task.chatId, redact(imagen.buildDoneMessage(task, false, null, { boards: false })))
  } catch (e) { process.stderr.write('通知失败: ' + (e && e.message) + '\n') }
  if (!delivered && !onWecom) try {
    // ⚠ noBoard 时必须连 boardUrl 一起清掉 —— 否则卡上照旧挂「打开设计画布」按钮、文案还教人
    // 「在画布上标注」,而这张图根本没上板。指路指到一张不存在的图上,比不指更糟。
    const boardUrl = (!task.noBoard && g && g.board && g.board.url) || null // 画板入口直达
    let imgKey = null
    try { imgKey = await withCardPreview(task.out, (p) => uploadImage(client, p)) } catch (e) { process.stderr.write('图片上传失败(降级发文本): ' + (e && e.message) + '\n') }
    // 画布交付卡(合并卡):图在卡内 + 元信息 + 打开画布按钮 —— 一张卡替原来的 图+文 两条。
    // 发卡失败(缺 cardkit scope / 旧端)降级回原生图 + 文本,绝不无声失败。
    let mid = null
    if (imgKey) { const card = imagen.buildDoneCard(task, { boardOk, boardUrl, imgKey, elapsedMs, redact }); mid = await sendChatCard(client, task.chatId, card).catch((e) => { process.stderr.write('发卡失败(降级): ' + (e && e.message) + '\n'); return null }) }
    if (!mid) {
      await sendChatImage(client, task.chatId, task.out) // 降级:双面约定单图群里也发一份
      await sendChatText(client, task.chatId, redact(imagen.buildDoneMessage(task, boardOk, boardUrl)))
    }
  } catch (e) { process.stderr.write('通知失败: ' + (e && e.message) + '\n') }
  finish('ok', { boardOk })
  return true
}

// spawn `codex exec --json` 固定生图模板;墙钟超时树杀;原始 JSONL 流存盘。
// onEvent(可选)= 每解析出一条流事件回调一次(worker 用它推进群里那条进度消息的阶段)。
function imagenRunCodex(task, dir, cfg, onEvent = null) {
  return new Promise((resolve) => {
    const { spawn } = require('node:child_process')
    const { IS_WIN, resolveSpawn } = require('../src/agent/winexec')
    // codex bin/model 缺省取第一个 runner:"codex" 的 provider(与群后端同源);--model 可覆盖
    const cp = Object.values(cfg.providers || {}).find((p) => p && p.runner === 'codex') || {}
    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-c', 'approval_policy=never']
    const model = task.model || cp.model
    if (model) args.push('--model', model)
    args.push('--json', '--cd', task.workdir, '-')
    const env = { ...process.env }
    delete env.CLAUDECODE
    delete env.OPENAI_API_KEY // 恒走机器的 codex login 订阅,绝不误落 API 计费(同 codexcode)
    let wall = null
    let settled = false
    const settle = (v) => { if (settled) return; settled = true; if (wall) clearTimeout(wall); resolve(v) } // 单次结算,任何路径不留悬置计时器
    const { file, spawnArgs } = resolveSpawn(cp.bin || 'codex', args)
    let child
    try {
      child = spawn(file, spawnArgs, { cwd: task.workdir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !IS_WIN })
    } catch (e) { return settle({ ok: false, reason: 'codex 启动失败:' + (e && e.message) }) }
    child.on('error', (e) => settle({ ok: false, reason: 'codex 不可用(机器需 codex login):' + (e && e.message) }))
    child.stdin.on('error', () => {})
    // 项目有风格档就把路径一并交给生图后端(它自己去读)—— 系列图跨任务保持同一套色板/字体,
    // 不靠群 agent 每次把风格抄进 prompt(抄一次漂一次)。findStyleDoc 与落盘裁决同一套认帧
    // (两个位置都过 isStyleDoc),绝不把架构文档当风格依据喂进去;没有风格档则原样,零回归。
    // 风格档在**受理侧**就选定并写进任务(见那处注释);老任务没有这个字段 ⇒ 退回单档探测,
    // 保证发版瞬间队列里的任务照常有风格依据。
    child.stdin.end(imagen.buildImagenPrompt(task.prompt, task.out, task.styleDoc || design.findStyleDoc({ cwd: task.workdir }),
      { refs: task.refs, mask: task.mask, transparent: task.transparent }))
    const streamPath = path.join(dir, task.id + '.stream.jsonl')
    // 边存盘边按行喂进度:一次 data 事件不保证是整行(也可能一次来好几行)⇒ 必须自己攒缓冲。
    // 只喂 stdout —— stderr 里是 codex 的诊断行(rmcp/模型刷新报错),不是 JSON 事件。
    let lineBuf = ''
    const feed = (chunk) => {
      if (!onEvent) return
      lineBuf += chunk
      let i
      while ((i = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, i); lineBuf = lineBuf.slice(i + 1)
        const ev = imagen.parseStreamLine(line)
        if (ev) { try { onEvent(ev) } catch {} } // 进度是增益,回调抛错不许波及生图
      }
      if (lineBuf.length > 1_000_000) lineBuf = '' // 单行超长(整段 base64)不许把内存吃光
    }
    child.stdout.on('data', (d) => { try { fs.appendFileSync(streamPath, d) } catch {}; feed(String(d)) })
    child.stderr.on('data', (d) => { try { fs.appendFileSync(streamPath, d) } catch {} })
    const killTree = () => {
      if (IS_WIN && child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) } catch {}
        try { child.kill() } catch {}
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} } // detached ⇒ 组长,负 pid 杀全组
      }
    }
    // 墙钟到点树杀。⚠ 超时 ≠ 什么都没产出:被杀那一刻盘上常常已经落了一版中间产物
    // (2026-09-05:9 张改图全在盘上,群里却只报了「失败」)。**那一版的去向由 worker 统一处理**
    // —— 挪到 .partial 再把去处写进失败原因(见 imagenWorker 的 quarantinePartial)。
    // 放在那边而不是这里,是因为「所有失败路径都得挪」,不只超时这一条;写在这里只覆盖一条。
    wall = setTimeout(() => {
      killTree()
      settle({ ok: false, reason: `生图超时(${Math.round(imagen.IMAGEN_WALL_MS / 60000)} 分钟)` })
    }, imagen.IMAGEN_WALL_MS)
    child.on('close', () => settle(imagen.checkImageOut(task.out, imageSize))) // 成败以产物为准(存在+魔数可解析)
  })
}

// ── sbot preview — 群预览服务(detached 静态服务;src/preview.js 放可测逻辑,这里只接线)──────
// 治的是「agent 为了让群成员打开原型,先装 launchctl 常驻作业、被禁后改用故意不结束本轮续命」
// 那条链(docs/PREVIEW.md 有全文)。受理即返回、跨轮存活、按群固定端口、闲置自动回收。
// socket 在 worker(daemon 是全群单点,不能让 LAN handler 的 bug 带走整台 bot,且发版 kickstart
// 会掐断 in-daemon 托管的预览);生命周期策略在 daemon(reaper)+ worker 自己也会闲置自尽。
// 群内反馈本 —— 每台机器一本(`~/.sbot/issues.jsonl`),与仓库托管平台的 issue 无关。
// 消费者是「开发机上把两台的本子拉到一起分析」这个动作,所以 `list --json` 是一等公民:
//   sbot issue list --json                                          # 本机
//   ssh <另一台> 'cd ~/sbot && sbot issue list --json'                # 另一台
// ⚠ 故意不做 sbot 之间互相拉取:那要引入集群概念(违背「当前单机部署」的已锁定决策),
// 换来的只是省一条 ssh。跨机唯一性靠每条自带的 host 字段,不靠全局发号。
async function cmdIssue(rest) {
  const action = rest[0] || 'list'
  const args = rest.slice(1)
  let configOpt, note, asJson = false, all = false, notify = true
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--config') configOpt = args[++i]
    else if (a.startsWith('--config=')) configOpt = a.slice(9)
    else if (a === '--note') note = args[++i]
    else if (a === '--json') asJson = true
    else if (a === '--all') all = true
    else if (a === '--no-notify') notify = false
    else positionals.push(a)
  }
  const cfg = loadConfig(configOpt)
  const tz = normalizeTz(cfg.timezone)
  // 顶层可选 `instance`:这台机器在反馈里怎么自称。不配就退主机名 —— 但主机名往往既长又
  // 认不出是哪台(实测生产机的主机名形如 xxxdeMac-mini,而 operator 心里它们叫「A 机」「B 机」)。
  // 汇总多台时这个名字就是分组依据,值得让人自己起。
  const book = createIssues(path.join(os.homedir(), '.sbot', 'issues.jsonl'), { withFileLock, host: cfg.instance || undefined })

  if (action === 'list') {
    const items = book.list({ all })
    // --json 一次吐全量结构化:给「集中分析」那一步用,不做分页不做截断。
    if (asJson) { process.stdout.write(JSON.stringify({ host: book.host, issues: items }, null, 2) + '\n'); return }
    if (!items.length) { process.stderr.write(dim(`  反馈本空的${all ? '' : '(只看未处理;--all 看全部)'}\n`)); return }
    process.stderr.write(`\n【反馈本】${book.host} · ${items.length} 条${all ? '' : '未处理'}\n\n`)
    for (const it of items.slice().reverse()) { // 新的在上:反馈本按「最近发生什么」读
      const head = `  #${it.id}  ${fmtStamp(it.ts, tz)}  ${it.group || it.chatId || ''} · ${it.sender || '?'}`
      process.stderr.write((it.status === 'closed' ? dim(head + '  [已处理]') : head) + '\n')
      process.stderr.write('      ' + summarize(it, { width: 200 }) + '\n')
      const fp = fingerprint(it.turn)
      if (fp) process.stderr.write(dim(`      └ 上一轮 ${fp}${it.version ? ' · v' + it.version : ''}\n`))
      if (it.note) process.stderr.write(dim(`      └ 处理:${it.note}\n`))
      process.stderr.write('\n')
    }
    return
  }

  if (action === 'show') {
    const it = book.get(positionals[0])
    if (!it) return die(`没有 #${positionals[0]} 这条(sintbot issue list --all 看全部)`)
    process.stdout.write(JSON.stringify(it, null, 2) + '\n')
    return
  }

  if (action === 'close' || action === 'reopen') {
    const id = positionals[0]
    if (!id) return die(`用法: sintbot issue ${action} <id> [--note "<说明>"]`)
    const it = book.setStatus(id, action, note)
    if (!it) return die(`#${id} 不存在,或本来就是${action === 'close' ? '已处理' : '未处理'}状态`)
    process.stderr.write(green(`  ✓ #${it.id} 已标记为${action === 'close' ? '已处理' : '重新打开'}\n`))
    // 回原群一句 —— 反馈系统唯一的死法就是「提了没下文」,提的人不会再提第二次。
    // ⚠ 通知失败绝不能让状态变更失败(状态已经落盘了):只提示,不回滚、不非零退出。
    if (action === 'close' && notify && it.chatId) {
      if (!cfg.feishu || !cfg.feishu.appId || !cfg.feishu.appSecret) {
        process.stderr.write(dim('  (未配置消息平台,没通知到群)\n'))
        return
      }
      // 暂停群不打扰 —— 与控制台端点、引擎侧全部群内通知同一条语义;CLI 不该是漏网的那个口。
      const gCfg = cfg.groups && cfg.groups[it.chatId]
      if (gCfg && gCfg.paused) {
        process.stderr.write(dim('  (该群已暂停,未通知)\n'))
        return
      }
      try {
        const client = feishuClient(cfg.feishu.appId, cfg.feishu.appSecret)
        const body = `✅ 你提的 #${it.id} 已处理\n「${summarize(it, { width: 40 })}」` + (it.note ? `\n${it.note}` : '')
        // ⚠ 出站必过脱敏,与 send-msg / engine 群回复同口径(PII 按该群开关,密钥恒遮)。
        // 这条消息回的是原群、内容是他们自己说的话,看着无需脱敏 —— 但反馈正文里粘进
        // 一段带 key 的日志是很常见的事,「原样发回原群」不构成把密钥再广播一次的理由。
        const red = (s) => redact(s, { pii: !(cfg.groups && cfg.groups[it.chatId] && cfg.groups[it.chatId].redactPii === false) })
        await sendChatText(client, it.chatId, red(body))
        process.stderr.write(green('  ✓ 已在原群告知\n'))
      } catch (e) {
        process.stderr.write(dim(`  (没通知到群:${(e && e.message) || e})\n`))
      }
    }
    return
  }

  die(`unknown issue action '${action}' (list | show | close | reopen)`)
}

// 接管浏览器的一次性链接(v0.11.85,docs/BROWSER.md「远程接管」):群 agent 撞到登录墙 / 验证码 / 滑块 / 扫码时调,
// 把打印出来的链接原样发进群。签票走控制台的环回接口 —— 本机环回且不带反代头即放行(src/ui/server.js 那道门),
// 所以要守护进程带控制台在跑;地址由 engine 经 SBOT_UI_URL 注入,终端里手工跑可自己设。
async function cmdBrowser(rest) {
  const action = rest[0]
  const args = rest.slice(1)
  if (!action || action === '--help' || action === '-h' || args.includes('--help') || args.includes('-h')) return helpOut(SUBHELP.browser)
  if (action !== 'link') return die(`未知动作 ${action}(只有 link)\n` + SUBHELP.browser)
  let minutes = 0; let asJson = false; let tab = ''; let send = false; let chatOpt = ''; let configOpt
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a === '--minutes') minutes = Number(args[++i]) || 0; else if (a === '--tab') tab = String(args[++i] || ''); else if (a === '--send') send = true; else if (a === '--chat') chatOpt = String(args[++i] || ''); else if (a === '--config') configOpt = args[++i]; else if (a === '--json') asJson = true }
  const base = String(process.env.SBOT_UI_URL || 'http://127.0.0.1:4600').replace(/\/+$/, '')
  let r
  try {
    // X-Sbot-Local:签票接口只认带这个头的本机请求(挡本机网页的跨站 POST;见 src/ui/server.js 那道门)
    const resp = await fetch(base + '/api/browser/link', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sbot-Local': '1' }, body: JSON.stringify({ ...(minutes > 0 ? { minutes } : {}), ...(tab ? { tab } : {}) }) })
    r = await resp.json().catch(() => ({}))
    if (!resp.ok) return die(r.error || `控制台返回 HTTP ${resp.status}`)
  } catch (e) { return die(`连不上控制台(${base}):守护进程要带控制台在跑(sintbot start --ui);终端里手工跑可用 SBOT_UI_URL=… 指定 —— ${e.message}`) }
  // --send:命令自己把卡发进群。截图失败 / 传图失败都不阻断 —— 卡没图照发;卡本身发不出去才是错
  if (send) {
    const chatId = chatOpt || process.env.SBOT_CHAT_ID
    if (!chatId) return die('--send 要有目标群:群里跑时已注入,终端里加 --chat <oc_…>')
    const cfg = loadConfig(configOpt)
    const group = (cfg.groups || {})[chatId] || {}
    const red = (s) => redact(s, { pii: group.redactPii !== false })
    // 企微群:官方命令行工具发「页面截图 + 带链接的 markdown」(工具发不了按钮卡,发出去的消息也改不了状态 ⇒ 不挂票翻卡,
    // 兑换 / 过期由接管页自己告诉人);截图拿不到就只发链接
    if (chatPlatform(cfg, chatId) === 'wecom') {
      if (cfg.wecom && cfg.wecom.cli === false) return die('企业微信命令行工具已在配置里关闭,发不了')
      const wc = createWecomCli({ bin: (cfg.wecom && cfg.wecom.cli) || 'wecom-cli' })
      let withImage = false
      if (r.target) {
        try {
          const shot = await cdp.captureTarget(String((cfg.browser || {}).cdpUrl || cdp.DEFAULT_CDP_URL).replace(/\/+$/, ''), r.target, { maxWidth: 640 })
          const tmp = path.join(os.tmpdir(), `sbot-takeover-${Date.now()}.jpg`)
          fs.writeFileSync(tmp, Buffer.from(shot.data, 'base64'))
          try { await wc.sendImage(chatId, tmp); withImage = true } finally { try { fs.unlinkSync(tmp) } catch {} }
        } catch (e) { process.stderr.write(dim('  (页面截图没拿到,只发链接:' + (e && e.message) + ')') + '\n') }
      }
      const title = r.pageTitle ? red(String(r.pageTitle)) : ''
      const md = `**需要有人在手机上接管浏览器**${title ? `\n> 页面:${title}` : ''}\n[点这里开始接管](${r.url})\n${r.minutes} 分钟内有效、只能打开一次` + (r.target ? '、只对应那一个页面' : '') + ';登录态会留在这台机器的浏览器里'
      try { await wc.sendMarkdown(chatId, md) } catch (e) { return die('发不出去:' + (e && e.message)) }
      if (asJson) { process.stdout.write(JSON.stringify({ ...r, sent: true, withImage }) + '\n'); return }
      process.stderr.write(green('  ✓ 接管入口已发到群') + dim(withImage ? '(带页面截图)' : '(没带图)') + '\n')
      return
    }
    if (!cfg.feishu || !cfg.feishu.appId || !cfg.feishu.appSecret) return die('feishu 未配置,发不了卡')
    const client = feishuClient(cfg.feishu.appId, cfg.feishu.appSecret)
    let imgKey = null
    if (r.target) {
      try {
        const shot = await cdp.captureTarget(String((cfg.browser || {}).cdpUrl || cdp.DEFAULT_CDP_URL).replace(/\/+$/, ''), r.target, { maxWidth: 640 })
        const tmp = path.join(os.tmpdir(), `sbot-takeover-${Date.now()}.jpg`)
        fs.writeFileSync(tmp, Buffer.from(shot.data, 'base64'))
        try { imgKey = await uploadImage(client, tmp) } finally { try { fs.unlinkSync(tmp) } catch {} }
      } catch (e) { process.stderr.write(dim('  (页面截图没拿到,卡里不带图:' + (e && e.message) + ')') + '\n') }
    }
    const cardOpts = { url: r.url, pageTitle: r.pageTitle, pageUrl: r.pageUrl, imgKey, minutes: r.minutes, redact: red }
    let sent
    try { sent = await sendChatCard(client, chatId, buildTakeoverCard(cardOpts)) } catch (e) { return die('发卡失败:' + larkErrMsg(e)) }
    if (!sent) return die('发卡失败:飞书没返回消息 id')
    // 把卡挂到票上:有人兑换 / 票过期时 daemon 翻卡(失败不阻断,卡已经发出去了)
    try { await fetch(base + '/api/browser/link/attach', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sbot-Local': '1' }, body: JSON.stringify({ id: r.id, card: { cardId: sent.cardId, chatId, pageTitle: r.pageTitle, pageUrl: r.pageUrl, minutes: r.minutes } }) }) } catch {}
    if (asJson) { process.stdout.write(JSON.stringify({ ...r, sent: true, msgId: sent.msgId, withImage: !!imgKey }) + '\n'); return }
    process.stderr.write(green('  ✓ 接管卡已发到群') + dim(imgKey ? '(带页面截图)' : '(没带图)') + '\n')
    return
  }
  if (asJson) { process.stdout.write(JSON.stringify(r) + '\n'); return }
  process.stdout.write(String(r.url || '') + '\n')
  const reachNote = r.reach === 'public' ? '' : r.reach === 'lan' ? ';⚠ 这是局域网地址,出了局域网打不开 —— 要给外面的人用,先在控制台「设置」里填公网地址' : ';⚠ 控制台只绑了本机,这条链接只有这台电脑自己打得开 —— 要给别人用,先填公网地址,或让守护进程带 --ui-host 0.0.0.0 启动'
  process.stderr.write(dim(`${r.minutes} 分钟内有效,只能打开一次` + (r.target ? '(只对应当前那个页面)' : '') + reachNote) + '\n')
}

async function cmdPreview(rest) {
  if (rest[0] === '--_worker') return previewWorker(rest[1]) // 内部入口(detached spawn 出来的)
  const action = rest[0]
  const args = rest.slice(1)
  let portOpt, labelOpt, idleOpt, chatOpt, configOpt
  let projectRootFlag = false; let allFlag = false; let jsonFlag = false
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--port') portOpt = args[++i]
    else if (a === '--label') labelOpt = args[++i]
    else if (a === '--idle-min') idleOpt = args[++i]
    else if (a === '--chat') chatOpt = args[++i]
    else if (a === '--config') configOpt = args[++i]
    else if (a === '--project-root') projectRootFlag = true
    else if (a === '--all') allFlag = true
    else if (a === '--json') jsonFlag = true
    else positionals.push(a)
  }
  const dir = preview.previewDir()
  const chatId = chatOpt || process.env.SBOT_CHAT_ID || null
  // ⚠ 只给**只读动作**(status/stop)用:它们是收拾残局的手段,不该因为配置坏了就用不了。
  // **start 绝不能用它** —— 退到默认值意味着 operator 写的 `preview.host: 127.0.0.1`(锁只给本机)
  // 会因为一个 JSON 语法错误静默变成绑 0.0.0.0 上局域网。安全判定读不出信息时必须拒绝而不是
  // 放行(DESIGN §4.1 fail-closed),所以 start 走裸 loadConfig、坏配置即 die(全家桶其它技能同款)。
  const cfgSafe = () => { try { return loadConfig(configOpt) } catch { return {} } }
  // ⚠ 群与群之间不可互相触碰(cron「crons are scoped to their own group」同款纪律)。
  // `--all` 是**跨群**动作,只对无群上下文的 operator 终端有意义 —— 否则群 agent 一句
  // `sbot preview stop --all` 就能把别的群正在给人看的原型全停掉(既有基础技能都没给过这种触达面)。
  if (chatId && allFlag) return die('--all 只能在无群上下文时使用(operator 终端);群内的默认作用域是本群')
  // ⚠ 真机(2026-07-30):群里要求「随时都能打开」,agent 自己在项目目录写了份
  // `.sbot-preview-long.config.json`({preview:{host:'0.0.0.0',idleMin:0,maxHours:0}})并用 --config
  // 指过去,把两道回收兜底全关了 —— 服务从此永不自停。它没恶意(这是它解决问题的常规手段),
  // 但 `--config` 因此成了 operator 策略的绕过口:端口段、绑定地址、回收上限,连 verifyRecordFence
  // 的锚点(groups[chatId].workdir)都能被自造配置覆盖。**配置是 operator 的策略面,群内不许换**
  // (daemon 已用 SBOT_CONFIG 把真配置注入 spawn env,群内本来也不需要 --config)。
  // 「长期开放」的正规入口 = operator 按群设 groups[chatId].preview(控制台群卡),见下。
  // 判据用 chatId(含 --chat)而**不是** env SBOT_CHAT_ID:后者 agent 一句 `SBOT_CHAT_ID= sbot …` 就能
  // 清掉从而绕过;而 start 无论如何都要有 chatId,所以这条挡得住。代价是 operator 也不能 `--chat X
  // --config Y` 连用 —— 给他留 env 出口(SBOT_CONFIG=…),报错里写明。
  // ⚠ 残余风险(记档,别自欺):有 shell 的 agent 也能 `SBOT_CONFIG=evil.json sbot preview …`,而那正是
  // daemon 传真配置用的同一个变量、无法区分来源。**配置类策略对半可信的 agent 本质上不可强制** ——
  // 真正的防线是:①正路存在(operator 在控制台按群设常驻)②控制台看得见策略与在跑的预览
  // ③清单明写别自造配置。而 serveRoot 那类围栏不同,它锚在 cwd 上、agent 伪造不了。
  if (chatId && configOpt) return die('群内不能用 --config 换配置 —— 预览策略(端口段/绑定地址/回收上限)是 operator 的设置。\n需要长期开放不自动停:让 operator 在控制台该群卡的「预览」里勾「常驻」(或在群里直接说需求,由用户决定)。\n(operator 手工换配置请用 env:SBOT_CONFIG=<路径> sbot preview …)')

  if (action === 'status') {
    const all = preview.listRecords(dir)
    const scoped = chatId ? all.filter((r) => r.chatId === chatId) : all
    if (jsonFlag) {
      const live = scoped.filter((r) => preview.isLive(r))
      process.stdout.write(JSON.stringify(live.map((r) => ({ id: r.id, chatId: r.chatId, port: r.port, label: r.label, entry: r.entry, serveRoot: r.serveRoot, url: previewUrl(r), startedAt: r.startedAt, lastReqAt: r.lastReqAt, reqCount: r.reqCount })), null, 2) + '\n')
      return
    }
    const lines = preview.buildStatusLines(scoped, {})
    process.stdout.write(lines.join('\n') + '\n')
    for (const r of scoped.filter((x) => preview.isLive(x))) process.stdout.write(`  ${previewUrl(r)}\n`)
    return
  }

  if (action === 'stop') {
    const all = preview.listRecords(dir)
    const live = all.filter((r) => preview.isLive(r))
    let targets
    if (positionals[0]) targets = live.filter((r) => r.id === positionals[0] && (!chatId || r.chatId === chatId))
    else if (allFlag) targets = live // 只在无群上下文时可达(上面已挡住群内 --all)
    else if (chatId) targets = live.filter((r) => r.chatId === chatId)
    // 无 id、无群上下文、又没 --all:**不默认停全部**(破坏性动作不静默扩大到别的群)
    else return die('缺群上下文 — 停本群的加 --chat <chatId>;确要停所有群的预览用 --all;先看 sbot preview status')
    // 注:`--chat` 仍可显式指向别的群(与 feishu/cron/imagen 全家桶同惯例,operator 逃生阀);
    // 收紧的是**跨群批量** —— 群内不许 `--all`,默认作用域恒为本群。
    if (!targets.length) { process.stdout.write('(没有运行中的预览可停)\n'); return }
    for (const r of targets) {
      preview.markStopped(dir, r, 'manual', { notify: false }) // 「谁杀谁写」+ 先落判定再杀;手动停不发群(动手的人自己会说)
      killPreviewPid(r.pid)
      process.stdout.write(`已停止预览:${r.label || r.entry} :${r.port}\n`)
    }
    return
  }

  if (action !== 'start') return die(`unknown preview action '${action || ''}' (start | stop | status)`)

  // ── start ──────────────────────────────────────────────────────────────────
  const rel = positionals[0]
  if (!rel) return die('用法: sbot preview start <项目内相对路径(.html 或目录)> [--label "记账原型"] [--port <n>] [--idle-min <n>] [--project-root]')
  if (!chatId) return die('缺群上下文 — 群 agent 自动带 SBOT_CHAT_ID;手工运行加 --chat <chatId>')
  const cfg = loadConfig(configOpt) // 见 cfgSafe 注释:start 必须裸读,坏配置即 die(绑定地址等安全项不可退默认)
  // 顶层 preview 为基线,`groups[chatId].preview` 为按群覆盖(只由 operator 设 —— 见上面 --config 那条)
  const gcfg = (cfg.groups && cfg.groups[chatId]) || {}
  const opts = preview.normalizeOptions(cfg.preview, gcfg.preview)
  let target
  try { target = preview.resolveServeTarget({ cwd: process.cwd(), rel, projectRoot: projectRootFlag }) } catch (e) { return die(e.message) }
  let only
  if (portOpt !== undefined) {
    only = parseInt(portOpt, 10)
    // ⚖ 拍板 A:--port 必须落在段内 —— 防火墙整段放行一次就够,段外端口是「下次又要开一个口子」
    if (!Number.isFinite(only) || only < opts.from || only > opts.to) return die(`--port 需在 ${opts.from}-${opts.to} 段内(该段是预留给预览的;不传则按群自动固定分配)`)
  }
  let idleMs = opts.idleMs
  if (idleOpt !== undefined) {
    const m = parseInt(idleOpt, 10)
    if (!Number.isFinite(m) || m < 0) return die('--idle-min 需为 ≥0 的整数(0 = 不按闲置回收)')
    idleMs = m > 0 ? m * 60_000 : 0
  }

  // 一群最多一个:同 serveRoot+entry 幂等复用(治「每次换新端口越堆越多」),异 root 则停旧起新。
  // ⚠ 整段「查 → 停旧 → 落新记录」必须**跨进程互斥**:同群两个 start 撞在一起时,各自的 findLive
  // 都可能先于对方落盘 ⇒ 谁也没看见谁,一群起出两个活预览(本机实测复现过,两个端口各一个监听)。
  // 生产上群锁本已把同群的轮次串起来,但「一群最多一个」是对外承诺的不变量,不能靠上游巧合成立。
  // 锁按群分文件 ⇒ 不同群互不排队(cron CLI 并发写配置同款手法,store.withFileLock)。
  fs.mkdirSync(dir, { recursive: true })
  let replaced = null
  let reuse = null
  let rec = null
  try {
    withFileLock(path.join(dir, 'claim-' + String(chatId).replace(/[^A-Za-z0-9_-]/g, '_')), () => {
      const live = preview.findLive(dir, chatId)
      if (live && live.status === 'running' && live.port && live.serveRoot === target.serveRoot && live.entry === target.entry) { reuse = live; return }
      if (live) {
        preview.markStopped(dir, live, 'replaced', { notify: false }) // 先落判定再杀(见 preview.js reaper 处注释)
        killPreviewPid(live.pid)
        replaced = live
      }
      rec = preview.newRecord({
        chatId, workdir: process.cwd(), serveRoot: target.serveRoot, entry: target.entry,
        label: labelOpt, candidates: preview.portCandidates(chatId, { from: opts.from, to: opts.to, only }),
        host: opts.host, idleMs, maxMs: opts.maxMs, projectRoot: target.projectRoot, single: target.single, configPath: cfg._path,
      })
      preview.writeRecord(dir, rec)
    })
  } catch (e) { return die(e.message) }
  if (reuse) {
    process.stdout.write(`预览已在运行(复用,未重启):${previewUrl(reuse)}\n` +
      `把链接发到群里即可 —— 不要等待或轮询,现在就可以正常收尾本轮。\n`)
    return
  }
  // detached + unref:脱离 agent 进程树 ⇒ 本轮结束 / 树杀 / hardRelease 都不波及它(imagen 同款)
  const logFd = fs.openSync(path.join(dir, rec.id + '.log'), 'a')
  const child = require('node:child_process').spawn(process.execPath, [__filename, 'preview', '--_worker', preview.recordFile(dir, rec.id)], { detached: true, stdio: ['ignore', logFd, logFd] })
  child.unref()
  fs.closeSync(logFd)
  // 回读实际端口再打印 URL:绑定权在 worker,受理侧先探再交给它绑会留竞态窗 —— 那样打印出去的
  // URL 可能根本没绑上,agent 就把死链发进群了。等一下(亚秒级)换 URL 恒真。
  const bound = await waitPreviewBound(dir, rec.id, 4000)
  if (!bound) {
    // 超时:worker 可能卡在别处 —— 从记录里取它自己写的 pid 收干净(本地 rec.pid 恒 null),
    // 并把记录落成 fail,不然它会以 'starting' 占着「本群那一个」直到 reaper 的 60s 宽限
    let latest = null
    try { latest = preview.readRecord(preview.recordFile(dir, rec.id)) } catch {}
    if (latest && latest.pid) killPreviewPid(latest.pid)
    // 别把别人写好的终态覆盖成 'fail'(并发 start 的输家会被赢家标成 'replaced' —— 那才是真原因)
    const cur = latest || rec
    if (cur.status === 'starting' || cur.status === 'running') {
      try { preview.writeRecord(dir, { ...cur, status: 'fail', error: '启动超时(4s 内未就绪)', finishedAt: Date.now() }) } catch {}
    }
    return die(`预览启动超时(4s 内未就绪)—— 看日志 ${path.join(dir, rec.id + '.log')}`)
  }
  if (bound.status !== 'running') return die(`预览启动失败:${bound.error || '未知原因'}`)
  process.stdout.write(preview.buildStartedText(bound, previewUrl(bound), { replaced, idleMin: Math.round(idleMs / 60_000), maxHours: opts.maxMs / 3_600_000, lan: !isLoopbackHost(bound.host) }))
  // 单文件形态:把「哪些资源会 404」当场说清楚。文件形态只服务 entry
  // 是 v0.9.0 有意的最小暴露面,不推翻 —— 缺的一直是**没人告诉用户素材会丢**:链接发出去,
  // 打开一看图全裂,而受理时一句提示都没有。⚠ 只提示不自动改成目录形态:那会扩大暴露面,
  // 而暴露面的变化必须是人的显式决定。
  if (target.single) {
    try {
      const refs = preview.scanLocalRefs(fs.readFileSync(path.join(target.serveRoot, target.entry), 'utf8'))
      if (refs.length) {
        const dirRel = path.relative(process.cwd(), target.serveRoot) || '.'
        process.stdout.write('\n' + preview.localRefsWarning(refs, { entry: target.entry, dirHint: dirRel }) + '\n')
      }
    } catch { /* 读不了就不提示 —— 服务已经起来了,不能因为一句提示失败 */ }
  }
  // --project-root 不静默:整个项目目录被服务这件事,群里必须看得见(v0.8.1 事故就是没人知道)
  if (target.projectRoot) {
    // 告知与否要如实报:没有飞书凭证(CLI 手工跑)时发不出去,不能照印「已在群里告知」
    let told = false; let why = '配置无飞书凭证,群内未告知'
    if (cfg.feishu && cfg.feishu.appId) {
      try {
        const client = feishuClient(cfg.feishu.appId, cfg.feishu.appSecret)
        await sendChatText(client, chatId, redact(`⚠ 预览服务正在把**整个项目目录**暴露到局域网(${rel})—— 用完请让我停掉,或让我改成只服务原型子目录。`))
        told = true
      } catch (e) { why = '群内告知发送失败:' + (e && e.message) }
    }
    process.stderr.write(yellow('  ⚠ 正在服务整个项目目录') + dim(told ? ' — 已在群里告知' : ' — ' + why) + '\n')
    // stdout 也要让 agent 知道(它只看 stdout):没告知成功就该由它在群里自己说一句
    if (!told) process.stdout.write('⚠ 本次服务的是整个项目目录(全部代码在局域网可读),自动告知未发出 —— 请你在群里说明一句。\n')
  }
}

// 预览 URL:地址选择走 src/preview.js 的 hostForUrl(CLI / doctor / 控制台同一份,防三处漂移)
const previewUrl = (rec) => preview.buildUrl(rec, preview.hostForUrl(rec, lanIPv4()))

// 杀预览 worker = src/preview.js 的 killWorker(控制台也用同一份)。**杀之后由调用方 markStopped**
// (「谁杀谁写」——worker 被杀时不写记录,否则会把收割方刚写进去的 reason 覆盖成无信息量的值)。
const killPreviewPid = (pid) => preview.killWorker(pid)

// 等 worker 把绑定结果写回记录(running + 实际端口,或 fail + 原因)
async function waitPreviewBound(dir, id, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    let r = null
    try { r = preview.readRecord(preview.recordFile(dir, id)) } catch { /* 还没写出来 */ }
    if (r && (r.status === 'running' || r.status === 'fail')) return r
    await new Promise((res) => setTimeout(res, 80))
  }
  return null
}

const PREVIEW_MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.wasm': 'application/wasm', '.map': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
}

// worker 主体:只读静态服务 + 闲置自尽。不带飞书 SDK(它只是个静态服务,不该为发一句话把 SDK
// 拖进一个长命进程)⇒ 自尽时立 notifyPending,由 daemon reaper 代发群通知。
function previewWorker(file) {
  if (!file) return die('preview --_worker 需记录文件路径(内部命令)')
  const http = require('node:http')
  // ⚠ 这个入口 agent 够得着(`BASE_SKILL_ALLOWS` 放行 `Bash(sbot preview *)`),所以**记录是不可信输入**。
  // 两道复核,缺一不可(实测过:不校验时自造一份记录就能把 $HOME 挂上局域网):
  //   ① 记录文件必须在 ~/.sbot/preview/ 里 —— 挡「指向 workdir 里自造的一份 JSON」;
  //   ② 围栏重跑,锚点取**配置里该群的 workdir**(不是记录自称的 workdir,那也是可写的)。
  const abs = path.resolve(file)
  if (path.dirname(abs) !== preview.previewDir()) return die(`preview --_worker 只接受 ${preview.previewDir()} 里的记录文件(内部命令,不要手工调用)`)
  const dir = path.dirname(abs)
  let rec = preview.readRecord(abs)
  {
    let anchor = null
    try {
      const wcfg = loadConfig(rec.configPath || undefined)
      const g = wcfg.groups && wcfg.groups[rec.chatId]
      if (g && g.workdir) anchor = g.workdir
    } catch { /* 配置读不出来:退回记录自称的 workdir,由 ① 兜底 */ }
    try { preview.verifyRecordFence(rec, { anchorWorkdir: anchor }) } catch (e) {
      preview.writeRecord(dir, { ...rec, status: 'fail', error: '围栏复核未通过:' + (e && e.message), finishedAt: Date.now() })
      return die('记录未通过围栏复核:' + (e && e.message))
    }
  }
  let lastReq = rec.lastReqAt || 0
  let reqCount = rec.reqCount || 0
  let lastFlush = 0
  const flush = (extra) => { rec = { ...rec, pid: process.pid, lastReqAt: lastReq || null, reqCount, ...(extra || {}) }; preview.writeRecord(dir, rec) }
  const fail = (reason) => { flush({ status: 'fail', error: String(reason || '未知'), finishedAt: Date.now() }); process.exit(1) }
  // ⚠ 有主判定的写:**先回读磁盘,记录已被别人判掉就不写、并退场**。
  // 不这么做的话(v0.9.0 实现期实测复现):收割方 markStopped('idle', notify) 之后、SIGTERM 落地之前,
  // 只要还有一个 in-flight 请求走到这里,`{...rec}` 就会把 status 写回 'running' 并**抹掉 notifyPending**
  // ⇒ 群里那条「预览已停止」永远发不出去,而下一 tick 只能报成「意外停止」。同理护住「替换」路径
  // (agent 起新预览时,旧预览可能正被谁的浏览器加载)。合并写在**磁盘那份**上,顺带不覆盖别人的字段。
  const touchOwned = () => {
    let cur = null
    try { cur = preview.readRecord(abs) } catch { return } // 记录没了(被清理)⇒ 什么都不写
    if (cur.status !== 'running' && cur.status !== 'starting') {
      process.stderr.write(`preview 记录已被判为 ${cur.status}(${cur.stoppedReason || '-'}) — 停止服务并退出\n`)
      return process.exit(0)
    }
    preview.writeRecord(dir, { ...cur, lastReqAt: lastReq || null, reqCount })
  }

  const handler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('method not allowed') }
    const r = preview.resolveRequestPath({ serveRoot: rec.serveRoot, urlPath: req.url, token: rec.token, entry: rec.entry, single: !!rec.single })
    if (!r.ok) {
      // 一律不回显细节(免得成探测器);token 不符与文件不存在对外长得一样
      res.writeHead(r.code, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end(r.code === 400 ? 'bad request' : 'not found')
    }
    reqCount++
    lastReq = Date.now()
    // 落盘去抖:一次页面加载几十个请求,不能每个都打一次盘(状态显示与闲置判定都只需要粗粒度)
    if (lastReq - lastFlush > preview.LASTREQ_DEBOUNCE_MS) { lastFlush = lastReq; try { touchOwned() } catch {} }
    const head = {
      'Content-Type': PREVIEW_MIME[path.extname(r.abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store', // 原型在迭代,别让人看到缓存里的旧版
      'X-Content-Type-Options': 'nosniff',
    }
    // GET 走 chunked、**不发 Content-Length**:原型文件正被 agent 反复重写,stat 到读之间大小一变
    // (缩了 Node 直接报 mismatch 掐掉连接、涨了则截断)—— 让它自己分块,坏最多是刷新一下。
    // HEAD 不传体,给出 stat 的长度是有用信息。
    if (req.method === 'HEAD') { res.writeHead(200, { ...head, 'Content-Length': r.size }); return res.end() }
    res.writeHead(200, head)
    fs.createReadStream(r.abs).on('error', () => { try { res.destroy() } catch {} }).pipe(res)
  }

  // 按候选序试绑(受理侧算好的:首选端口起环形扫全段;--port 则只有一个候选)
  const cands = Array.isArray(rec.candidates) && rec.candidates.length ? rec.candidates : [rec.port]
  const attempt = (i) => {
    if (i >= cands.length) return fail(cands.length === 1 ? `端口 ${cands[0]} 被占用` : `端口段 ${cands[0]}… 全被占用(${cands.length} 个都试过)`)
    const srv = http.createServer(handler)
    srv.on('error', (e) => {
      try { srv.close() } catch {}
      if (e && e.code === 'EADDRINUSE') return attempt(i + 1)
      fail((e && e.message) || String(e))
    })
    srv.listen(cands[i], rec.host, () => {
      // ⚠ 上位前先回读记录:受理侧可能在这几百毫秒里已经把这条记录判掉了(同群又 start 了一次 ⇒
      // 「替换」路径把它标 stopped;或超时兜底标 fail)。此时若照写 'running',就会出现「一群两个
      // 活预览」+ 一个没人认领的僵尸监听。认账退场 —— 记录的所有权已经不在我这儿了。
      let cur = null
      try { cur = preview.readRecord(abs) } catch {}
      if (cur && cur.status !== 'starting' && cur.status !== 'running') {
        process.stderr.write(`preview 记录已被判为 ${cur.status}(${cur.stoppedReason || cur.error || '-'}) — 不上位,退出\n`)
        try { srv.close() } catch {}
        return process.exit(0)
      }
      flush({ status: 'running', port: cands[i], boundAt: Date.now() })
      process.stderr.write(`preview serving ${rec.serveRoot} on ${rec.host}:${cands[i]}\n`)
    })
  }
  attempt(0)

  // 闲置/超龄自尽:不依赖 daemon(它可能没开、可能正在升级重启)。立 notifyPending 让 daemon 代发。
  const tick = setInterval(() => {
    if (rec.status !== 'running') return
    const t = Date.now()
    // 回收策略**现读磁盘**(v0.9.3):operator 中途勾了「常驻」,daemon 侧会把新策略写进这份
    // 记录,这里就跟着变 —— 此前用的是启动时的内存快照,于是「勾了常驻,worker 照旧到点自尽」。
    // 读不到就退回快照:降级方向安全(快照是「会停」,不会把服务永久挂在局域网上)。
    let cur = null
    try { cur = preview.readRecord(abs) } catch { /* 下面按快照判;真要自尽时还会再读一次 */ }
    const idleMs = cur && Number.isFinite(cur.idleMs) ? cur.idleMs : rec.idleMs
    const maxMs = cur && Number.isFinite(cur.maxMs) ? cur.maxMs : rec.maxMs
    const idleFrom = lastReq || rec.boundAt || rec.startedAt || t
    const reason = (idleMs > 0 && t - idleFrom > idleMs) ? 'idle'
      : (maxMs > 0 && t - (rec.startedAt || t) > maxMs) ? 'max'
      : null
    if (!reason) return
    // 自尽也要先回读:收割方可能已经判过了(reason 是它写的),别把它的判定覆盖成自己这份
    if (!cur) { try { cur = preview.readRecord(abs) } catch { return process.exit(0) } }
    if (cur.status !== 'running' && cur.status !== 'starting') return process.exit(0)
    preview.writeRecord(dir, { ...cur, status: 'stopped', stoppedReason: reason, stoppedAt: t, notifyPending: true, lastReqAt: lastReq || null, reqCount })
    process.exit(0)
  }, 30_000)
  if (tick.unref) tick.unref() // http 服务自己吊着事件循环;定时器不该成为唯一的存活理由
  // 被 kill 时**不写记录**:收割方已经把 reason 写进去了(「谁杀谁写」),这里再写会覆盖成无信息量的值
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
}

async function main() {
  const argv = process.argv.slice(2)
  const sub = argv[0]

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return printHelp()

  // 统一拦 `--help`,排在所有子命令之前(见 SUBHELP 上方那段的由来)。
  // ⚠ 认哪几个位置,按**尾部是不是自由文本**分两类:
  //    · feishu / agent 的尾部是正文(send-msg 的文本、agent run 的 prompt),`--help` 落在第三个
  //      位置之后就是正文 —— 正文以 '-' 开头是自知清单明确教过的写法(所以 feishu 才手写了参数
  //      解析)⇒ 只认紧跟命令的头两个位置(`sbot X --help` / `sbot X <动作> --help`)。
  //    · 其余命令的位置参数是 id / 路径 / 时间,不可能就是「--help」这个词 ⇒ 放哪儿都认。
  //      由来(2026-09-08 对账):`sbot issue close 3 --help` 曾真去关 #3、`preview stop x --help`
  //      真去停 —— 「问怎么用」变成「照做了一遍」,比报一句假错误还糟。
  //    design / imagen 不在 SUBHELP 里:它们**按动作**各有各的用法,自己接得更细(且全程扫)。
  const FREE_TEXT_TAIL = new Set(['feishu', 'agent'])
  const scan = FREE_TEXT_TAIL.has(sub) ? argv.slice(1, 3) : argv.slice(1)
  if (SUBHELP[sub] && scan.some((a) => a === '--help' || a === '-h')) return printSubHelp(sub)

  if (sub === 'version' || sub === '--version' || sub === '-v') return void process.stdout.write(require('../package.json').version + '\n')
  if (sub === 'service') return cmdService(argv.slice(1))
  if (sub === 'providers') return cmdProviders()
  if (sub === 'setup') return cmdSetup(argv.slice(1))
  if (sub === 'ui') return cmdUi(argv.slice(1))
  if (sub === 'doctor') return cmdDoctor(argv.slice(1))
  if (sub === 'feishu') return cmdFeishu(argv.slice(1))
  if (sub === 'wecom') return cmdWecom(argv.slice(1))
  if (sub === 'cron') return cmdCron(argv.slice(1))
  if (sub === 'imagen') return cmdImagen(argv.slice(1))
  if (sub === 'design') return cmdDesign(argv.slice(1))
  if (sub === 'preview') return cmdPreview(argv.slice(1))
  if (sub === 'browser') return cmdBrowser(argv.slice(1))
  if (sub === 'issue') return cmdIssue(argv.slice(1))
  if (sub === 'start') return cmdStart(argv.slice(1))
  if (sub === 'chat') return cmdChat(argv.slice(1))
  if (sub === 'agent') {
    if (argv[1] !== 'run') return die(`unknown agent action '${argv[1] || ''}' (try: sintbot agent run "<prompt>")`)
    return cmdAgentRun(argv.slice(2))
  }
  die(`unknown command '${sub}' (try: sintbot help)`)
}

main().catch((e) => die(e && e.message || String(e)))
