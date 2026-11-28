// 企业微信官方命令行工具的薄封装:以机器人身份 HTTP 直连发消息 / 传素材 / 拉历史 / 搜人。
//
// 为什么走它而不是 daemon 的长连接:同一个机器人只许一条长连接,子进程(基础技能 `sbot wecom`、生图 worker、
// 接管链接 `--send`)再开一条就把 daemon 踢下线;工具是 HTTP 直连,不占那条连接。三处调用方此前各写一份
// exec 包装(cmdWecom 里那份还有个 `u.userid` 的未定义变量,单聊发送一跑就炸)⇒ 收成一处。
//
// ⚠ 两套 id 空间:daemon 从长连接拿到的单聊 chatId 是明文 userid,工具只认它自己那套(woA2… 形态);
//    群 id(wr 开头)两边一致。所以不是群的目标先搜人换算,且只认精确且唯一的命中 —— 模糊命中会发到别人那里。
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// 群历史只能查近 7 天,而 begin_time 恰好 7 天前会被拒(850016,真机踩到:主机钟与服务端钟差几秒就越界)⇒ 一律取 6 天
const HISTORY_DAYS = 6

// 工具要的「YYYY-MM-DD HH:MM:SS」字面量按**北京时间**解释(服务端在国内),与主机时区无关 —— 生产机是美东,按本机
// 格式化等于把窗口整体错开 12 小时:当天的消息全查不到、还一声不响(10-10 真机踩到,此前文档写的「本机时区」是错的)
function fmtBeijing(d) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

function createWecomCli({ bin = 'wecom-cli', exec = execFile, timeoutMs = 60_000 } = {}) {
  // 调工具:JSON 回包里固定带两段安全提示字段,剥掉;{error:{code,message}} ⇒ 抛;退出码 0 但不是 JSON 也不能当成功
  // opts.cwd:工具只许把下载的文件写进**它自己的 cwd**(或 /private/tmp)—— 真机 10-12:`--output-dir ~/.sbot/wecom-inbox` 被拒
  //   「目标路径超出可访问范围(允许范围: <cwd>, /private/tmp)」。所以取媒体时把 cwd 设成目标目录、`--output-dir .`
  const run = (args, opts = {}) => new Promise((resolve, reject) => {
    exec(bin, args, { timeout: timeoutMs, maxBuffer: 8 << 20, ...(opts.cwd ? { cwd: opts.cwd } : {}) }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(Object.assign(new Error('企业微信命令行工具未安装(doctor 的 wecom.cli 行)'), { code: 'ENOENT' }))
      let j = null
      try { j = JSON.parse(String(stdout || '').trim() || '{}') } catch { /* 非 JSON 输出按下面处理 */ }
      if (j && j.error) {
        // 两个要翻成人话的码(10-12 调研):850003 = 工具的能力授权(每 7 天一续)过期,要创建者点续期链接;853006 = 企业规模门控
        // (>10 人企业官方尚未开放 chat.* 与 message send,不是配置错)。原码与续期链接挂在 Error 上给日志 / 告警用
        const code = j.error.code, help = j.error.help_message || j.help_message || ''
        const msg = String(code) === '850003' ? '工具的能力授权已过期(每 7 天一续),请机器人创建者点续期链接' + (help ? ':' + String(help).slice(0, 200) : '')
          : String(code) === '853006' ? '企业规模门控:企业超过 10 人时官方尚未开放这项能力(不是配置错)'
          : `${j.error.message || code || '失败'}`
        return reject(Object.assign(new Error(msg), { code, help }))
      }
      if (err && !j) return reject(new Error(String(stderr || err.message || '').trim().slice(0, 300)))
      if (!j) return reject(new Error('工具没有返回可读的结果:' + String(stdout || stderr || '').trim().slice(0, 200)))
      if (!opts.keepContext) { delete j.security_notice; delete j.extra_identity_context }
      resolve(j)
    })
  })

  // 搜人:只认精确命中(userid 相等或关键词命中),模糊到别人头上就是张冠李戴
  const findUser = async (userId) => {
    const r = await run(['contact', 'users', 'search', '--keywords', userId])
    return (r.users || []).filter((x) => x && (x.userid === userId || (x.matched_keywords || []).includes(userId)))
  }

  // 目标会话换算成工具认的 id:群原样;单聊搜人,精确且唯一才发
  const chatIdForCli = async (chatId) => {
    if (/^wr/.test(chatId)) return chatId
    const hits = await findUser(chatId)
    if (hits.length !== 1 || !hits[0].userid) throw new Error(hits.length ? '单聊对象不唯一,发不了' : '找不到这个单聊对象的账号,发不了')
    return hits[0].userid
  }

  // 工具的 send 子命令按 --msg-type 取同名 JSON 参数(--markdown / --image / --file);success:false 也算失败
  const sendBody = async (chatId, msgType, payload) => {
    const r = await run(['message', 'aibot', 'send', '--chat-id', await chatIdForCli(chatId), '--msg-type', msgType, '--' + msgType, JSON.stringify(payload)])
    if (r.success === false) throw new Error(r.message || '发送被拒')
    return r
  }

  const upload = async (kind, absPath) => {
    const up = await run(['media', 'upload', '--type', kind, '--file-path', absPath])
    if (!up.media_id) throw new Error('上传没有返回素材 id')
    return up.media_id
  }


  // 机器人自己是谁:官方工具的隐藏服务 `identity whoami`(--help 不列,schema list 能看到;10-12 调研 + 真机)—— 平台所有
  // 其他地方(长连接协议 / 其余接口)都没有机器人名,这是唯一的正路。回包是一段文本:
  //   机器人身份:\n名字:SintBot\nID:aib…\n授权真人用户身份:\n名字:张三\nID:wo…
  // 解析成 { bot:{name,id}, user:{name,id} };老版工具没这条服务 ⇒ 抛(调用方退回扫群历史里的 @)
  const whoami = async () => {
    const j = await run(['identity', 'whoami'], { keepContext: true })
    const t = String(j.extra_identity_context || '')
    const pick = (head) => { const m = new RegExp(head + '[:：]\\s*名字[:：]\\s*([^\\n]*?)\\s*\\n\\s*ID[:：]\\s*(\\S+)').exec(t); return m ? { name: m[1].trim(), id: m[2].trim() } : null }
    const bot = pick('机器人身份'), user = pick('授权真人用户身份')
    if (!bot || !bot.name) throw new Error('身份接口没有返回机器人名')
    return { bot, user }
  }

  return {
    run,
    whoami,
    findUser,
    chatIdForCli,
    sendMarkdown: (chatId, content) => sendBody(chatId, 'markdown', { content }),
    sendImage: async (chatId, absPath) => sendBody(chatId, 'image', { media_id: await upload('image', absPath) }),
    sendFile: async (chatId, absPath) => sendBody(chatId, 'file', { media_id: await upload('file', absPath) }),
    // 群历史(近 N 天,只有群;真机上含不 @ 机器人的人类发言、带 userid 与 user_name,不含机器人自己发的)
    history: async (chatId, { days = HISTORY_DAYS, now = () => new Date() } = {}) => {
      const end = now(), begin = new Date(end.getTime() - days * 86400_000)
      const r = await run(['chat', 'messages', 'list', '--chat-id', chatId, '--begin-time', fmtBeijing(begin), '--end-time', fmtBeijing(end)])
      return r.messages || []
    },
    // 取群历史里某条消息的媒体(图片 / 文件 / 视频):历史列表只给 media_id 不给内容,要再调一次这个接口。
    // 工具的回包有两种形态(schema 写明):内容长或含非 UTF-8 字节 ⇒ 框架落盘到 --output-dir,JSON 里给 file_path;
    // 内容短 ⇒ 直接给 content 字串。两种都归一成 { path, name, type }:文件一定在本机磁盘上,调用方只管搬与改名。
    // 真机 10-12:落盘形态 = `file_path` 绝对路径 + 原始文件名(`企业微信截图_….png`,带扩展名)+ 0600;相对路径也兜(按 outDir 解析)。
    fetchMedia: async (mediaId, outDir) => {
      if (!mediaId) throw new Error('缺少媒体 id')
      fs.mkdirSync(outDir, { recursive: true, mode: 0o700 }) // cwd 必须先存在,否则 spawn 直接 ENOENT
      const r = await run(['message', 'files', 'get', '--media-id', String(mediaId), '--output-dir', '.'], { cwd: outDir })
      const it = (r && r.media_item) || {}
      const name = it.file_name ? String(it.file_name) : null
      if (it.file_path) return { path: path.resolve(outDir, String(it.file_path)), name, type: it.media_type || null }
      if (typeof it.content === 'string') {
        // 短内容直接在 JSON 里(小文本文件那类):自己落盘,文件名只认安全字符
        fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
        let base = (name || '').replace(/[^\w.-]+/g, '_').slice(0, 80)
        if (!base || /^\.+$/.test(base)) base = `msg_media_${String(mediaId).replace(/[^\w-]+/g, '_').slice(-12)}` // 远端给的文件名洗完只剩「.」「..」之类 ⇒ 用 media_id 兜底
        const p = path.join(outDir, base)
        fs.writeFileSync(p, it.content, { mode: 0o600 })
        return { path: p, name, type: it.media_type || null }
      }
      throw new Error('取媒体没有返回文件内容')
    },
  }
}

module.exports = { createWecomCli, HISTORY_DAYS, fmtBeijing }
