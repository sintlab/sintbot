'use strict'
// English display text for the Slack onboarding notices. The Chinese sentences
// come from the built-in core (verdicts on pasted tokens, the ready notice)
// and from the host's setup and attach flows; they stay the source and drive
// every decision. This is display only, for a page set to English.
//
// The function is self-contained on purpose: the setup page embeds its source.
function translateSlackNotice(value) {
  const line = String(value == null ? '' : value)
  const exact = {
    '应用级令牌可用。': 'The app-level token works.',
    '这枚应用级令牌的格式不完整，请回到 Basic Information → App-Level Tokens 重新复制整枚令牌。': 'This app-level token is incomplete. Go back to Basic Information → App-Level Tokens and copy the whole token again.',
    '应用级令牌无效或已撤销：到 Basic Information → App-Level Tokens 重新生成一枚，权限选 connections:write。': 'The app-level token is invalid or revoked. Generate a new one under Basic Information → App-Level Tokens with the connections:write scope.',
    '这枚应用级令牌没有 connections:write 权限：到 Basic Information → App-Level Tokens 重新生成并选上它。': 'This app-level token lacks the connections:write scope. Generate a new one under Basic Information → App-Level Tokens and add that scope.',
    '还没有验证应用级令牌，请再试一次。': 'The app-level token has not been checked yet. Try again.',
    'Bot Token 无效或已撤销：到 OAuth & Permissions 重新安装应用，再复制新的 Bot User OAuth Token。': 'The bot token is invalid or revoked. Reinstall the app under OAuth & Permissions, then copy the new Bot User OAuth Token.',
    '还没有验证 Bot Token，请再试一次。': 'The bot token has not been checked yet. Try again.',
    '两枚令牌来自不同的 Slack 应用。请从同一个应用的设置页复制应用级令牌和 Bot Token。': 'The two tokens belong to different Slack apps. Copy the app-level token and the bot token from the same app.',
    '已连接 Slack。': 'Connected to Slack.',
    'Slack 已连接，在 Slack 里给机器人发任务即可：私聊直接发，频道里 @它。': 'Slack is connected. Send the bot a task in Slack: message it directly, or @mention it in a channel.',
    '在打开的 Slack 页面里选择工作区，点 Next，再点 Create。需要你有在该工作区安装应用的权限；没有的话可以先新建一个免费工作区。': 'On the Slack page that opened, pick a workspace, choose Next, then Create. You need permission to install apps there; if you do not have it, create a free workspace first.',
    'Slack 接入不能携带其他平台的凭据': 'A Slack connection cannot carry another platform’s credentials.',
    '请填写 Bot Token（xoxb- 开头）': 'Enter the bot token (starts with xoxb-).',
    '请填写应用级令牌（xapp- 开头）': 'Enter the app-level token (starts with xapp-).',
    '请选择 Slack 频道或私聊': 'Choose a Slack channel or direct message.',
    'Slack 应用信息格式无效': 'The Slack app details are not valid.',
    '已经接入 Slack，请使用已有连接': 'Slack is already connected. Use the existing connection.',
    '该会话已绑定或项目数量已达上限': 'This conversation is already bound, or the project limit has been reached.',
    '请填写应用级令牌和 Bot Token': 'Enter the app-level token and the bot token.',
    '请先粘贴应用级令牌': 'Paste the app-level token first.',
    '请先粘贴应用级令牌和 Bot Token': 'Paste the app-level token and the bot token first.',
    '等待消息超时，请在 Slack 里给机器人发一句话后重试': 'No message arrived. Send the bot a message in Slack, then retry.',
    'Slack 连接不可用，请检查两枚令牌是否仍然有效': 'The Slack connection is unavailable. Check that both tokens are still valid.',
    '连不上 Slack，请检查网络或代理后重试': 'Could not reach Slack. Check your network or proxy and retry.',
    'Slack 连接失败，请检查令牌和网络': 'Could not connect to Slack. Check the tokens and your network.',
    'Slack 连接尚未完全关闭，请稍后重试': 'The Slack connection has not closed yet. Please retry shortly.',
    '在 Slack 里给机器人发一句话（私聊，或在已邀请它的频道里 @它）即可完成接入。': 'Send the bot any message in Slack (a direct message, or @mention it in a channel it has been invited to) to finish.',
    'Slack 仍未连接，请检查网络、代理或两枚令牌是否仍然有效': 'Slack is still disconnected. Check the network, the proxy and whether both tokens are still valid.',
    'Slack 接入正在进行': 'Slack setup is in progress.',
    '配置已保存，Slack 尚未连接成功；请在设置中刷新连接状态，勿重复添加': 'Configuration saved, but Slack has not connected. Refresh connection status in Settings instead of adding it again.',
    'Slack 接入不可用': 'Slack setup is unavailable.',
    '当前服务不能添加 Slack 连接': 'This service cannot add a Slack connection.',
    '正在验证两枚令牌…': 'Checking both tokens…',
    'Slack 已添加，请在 Slack 里发送任务。': 'Slack added. Send your tasks in Slack.',
    'Slack 接入失败': 'Slack setup failed.',
    'Slack 连接已存在': 'A Slack connection already exists.',
    '这里只列出机器人已加入的频道。先在 Slack 的目标频道里发 /invite @机器人名，再刷新。': 'Only channels the bot has joined are listed. In the Slack channel you want, send /invite @your-bot-name, then refresh.',
    '应用缺少列出频道的权限（channels:read / groups:read），补上后需重新安装': 'The app lacks the scopes to list channels (channels:read / groups:read). Add them and reinstall.',
    '读取 Slack 频道失败，请检查网络或代理后重试': 'Could not read Slack channels. Check your network or proxy and retry.',
    '代理地址要以 http:// 开头，例如 http://127.0.0.1:7890': 'The proxy address must start with http://, for example http://127.0.0.1:7890.',
    '代理例外列表格式无效': 'The proxy exception list is not valid.',
    '代理地址里的 *** 只代表原来那个代理的用户名和密码；换了代理地址，请重新填写用户名和密码。': 'The *** in the proxy address stands only for the saved proxy’s user name and password. For a different proxy address, enter its user name and password again.',
    '机器人看不到这个私聊：只能绑定和机器人本身的私聊。在 Slack 里打开机器人、给它发一句话，再绑定那个私聊': 'The bot cannot see this direct message. Only a direct message with the bot itself can be bound: open the bot in Slack, send it a message, then bind that conversation.',
    '机器人还不在这个频道里（私有频道会显示为找不到频道）：先在 Slack 的这个频道里发 /invite @机器人名 把它请进来': 'The bot is not in this channel yet (a private channel shows as not found). In that Slack channel, send /invite @your-bot-name first.',
  }
  if (Object.prototype.hasOwnProperty.call(exact, line)) return exact[line]
  const kinds = { app: ['app-level token', 'xapp-', 'Basic Information → App-Level Tokens'], bot: ['bot token', 'xoxb-', 'OAuth & Permissions → Bot User OAuth Token'] }
  let m = /^请粘贴\s?(应用级令牌|Bot Token)（x(?:app|oxb)- 开头），在应用设置的 .+。$/.exec(line)
  if (m) { const k = kinds[m[1] === 'Bot Token' ? 'bot' : 'app']; return 'Paste the ' + k[0] + ' (starts with ' + k[1] + '). It is under ' + k[2] + ' in the app settings.' }
  m = /^这里要填\s?(应用级令牌|Bot Token)（x(?:app|oxb)- 开头），你贴的是\s?(.+)。它在应用设置的 .+。$/.exec(line)
  if (m) {
    const k = kinds[m[1] === 'Bot Token' ? 'bot' : 'app']
    const pasted = /^应用级令牌/.test(m[2]) ? 'the app-level token (starts with xapp-), so the two fields are swapped'
      : /^Bot Token/.test(m[2]) ? 'the bot token (starts with xoxb-), so the two fields are swapped'
      : /^用户令牌/.test(m[2]) ? 'a user token (starts with xoxp-)'
      : /^配置令牌/.test(m[2]) ? 'a configuration token (starts with xoxe; it manages apps and cannot send or receive messages)'
      : /^开了令牌轮换/.test(m[2]) ? 'a rotating token (starts with xoxe.). SintBot needs a token without rotation; create a new app from the link on this page'
      : 'something else'
    return 'This field takes the ' + k[0] + ' (starts with ' + k[1] + '). You pasted ' + pasted + '. It is under ' + k[2] + ' in the app settings.'
  }
  m = /^连不上 Slack（(.+)）：检查网络或代理后再试一次。$/.exec(line)
  if (m) return 'Could not reach Slack (' + m[1] + '). Check your network or proxy and try again.'
  m = /^Slack 拒绝了这枚应用级令牌（(.+)）。请确认应用是用本页的链接创建的，并已开启 Socket Mode。$/.exec(line)
  if (m) return 'Slack refused this app-level token (' + m[1] + '). Make sure the app was created from the link on this page and that Socket Mode is on.'
  m = /^Slack 拒绝了这枚 Bot Token（(.+)）。$/.exec(line)
  if (m) return 'Slack refused this bot token (' + m[1] + ').'
  m = /^应用缺少必需权限：(.+)。请用本页的链接重新创建应用，或在应用的 App Manifest 页补上后重新安装。$/.exec(line)
  if (m) return 'The app is missing required scopes: ' + m[1].split('、').join(', ') + '. Create the app again from the link on this page, or add them on the App Manifest page and reinstall.'
  m = /^已连接，但应用少了这些权限：(.+)。可以继续使用；要补上需在应用的 App Manifest 页添加后重新安装。$/.exec(line)
  if (m) return 'Connected, but the app lacks these scopes: ' + m[1].replace(/（[^）]*）/g, '').split('；').join(', ') + '. You can keep going; to add them, edit the App Manifest page and reinstall.'
  m = /^已连接 Slack 工作区「(.+)」。$/.exec(line)
  if (m) return 'Connected to the Slack workspace “' + m[1] + '”.'
  m = /^已连接项目 (.+)，可以直接发任务。命令以 ! 开头，例如 !status。$/.exec(line)
  if (m) return 'Connected to project ' + m[1] + '. Send a task any time. Commands start with !, for example !status.'
  m = /^已连接项目 (.+)，在这个频道里 @我 发任务。命令以 ! 开头，例如 !status。$/.exec(line)
  if (m) return 'Connected to project ' + m[1] + '. @mention me in this channel to send a task. Commands start with !, for example !status.'
  return null
}

module.exports = { translateSlackNotice }
