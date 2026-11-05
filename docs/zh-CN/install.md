# 安装

[English](../install.md) · 简体中文

新用户用[一键安装](#一键安装)最省事;手动装就是三步:装包 → `sintbot setup` → `sintbot service install`。如果请 AI 助手安装并带你完成首次使用,先看[AI 安装与首次使用说明](./AI-ASSISTED-INSTALL.md),让流程留在目标电脑上,凭据不进聊天。下面按平台补充细节。

## 一键安装

macOS / Linux(Linux 为实验性支持):

```bash
curl -fsSL https://sintbot.com/install.sh | bash
```

脚本分四步,每一步先检查、已经有的跳过。通过 Homebrew 安装 / 升级 Node、安装后台服务前会先询问(回车 = 接受默认值);安装或升级 SintBot 本身属于这次安装流程。模型配置时若缺少必需的 Claude Code CLI,向导会自动安装。终端里只装好、配好模型:不问你在哪,也不要求填代理、项目目录、聊天平台凭据 —— 这些装完在控制台里配。

1. **环境:Node 22+**:没有或版本太旧时,交互安装会先询问;Mac 上有 Homebrew 可用它装 / 升级,否则会给出 [nodejs.org](https://nodejs.org) 的下载地址后停下。没有交互终端时不会自动装 / 升级 Node,真实安装会直接停止。
   **npm 源**:你配过 npm 源就照用;还是官方源时先试连一下,连不上(国内常见)本次改用国内镜像 `registry.npmmirror.com`。
2. **装 sintbot**:`npm i -g sintbot`。已经是最新版就直接跳过,旧版本直接升级。npm 全局目录没有写权限时不会用 sudo,而是给出改装到用户目录的命令。
3. **配模型** `sintbot setup`:检查 Claude Code,没装就装上(见下一节);然后配模型,当场试跑一轮。见下文[第 2 节](#2-配置sintbot-setup)。
4. **后台服务**:问要不要 `sintbot service install`(登录后自启、崩溃自动拉起)。装好后控制台常开在 `http://127.0.0.1:4600` —— 还没接聊天平台也开着,脚本会在浏览器里打开它(SSH 连进来装的只打印地址)。服务已经在跑、这次也没升级就跳过这一步;升级了会问要不要重启服务(重启会在已接的群里播报升级)。

结尾给出控制台地址和接下来做什么:在「设置」里接飞书 / Slack / 企业微信,在「群 · 项目」里绑群,然后在群里 @ 机器人。不接平台也能先用 `sintbot chat` 在终端里试。

- 想先看看它会做什么:`curl -fsSL https://sintbot.com/install.sh | bash -s -- --dry-run`(不安装、不修改、也不提问;npm 可用时检查源和最新版,并读取服务状态,还会提示模型向导可能安装必需组件和发送计费试跑);脚本源码就是仓库根目录的 [install.sh](../../install.sh)。
- 没有可交互的终端时(如 CI),若已有 Node 22+ 仍可能只装包,向导和常驻服务会跳过并提示未完成;若没有合格 Node,真实安装会停止。无交互 `--dry-run` 仍可预览计划。
- 脚本和向导的输出语言跟着系统:`LANG` 以 `zh` 开头,或者 macOS 的系统语言是中文,就是中文,否则英文;想指定就设 `SINTBOT_LANG=zh` 或 `en`,例如 `curl -fsSL https://sintbot.com/install.sh | SINTBOT_LANG=zh bash`。
- Windows 不支持一键安装,按下面手动来。

## Claude Code:安装与登录

SintBot 每一轮都调用本机的 `claude` 命令行干活(Codex 群调用 `codex`),所以这台机器上要有 Claude Code —— 用 DeepSeek 等模型时也一样,它是执行框架,只是不用登录。

**安装**,任选一种:

- 让向导装:`sintbot setup` 在终端里运行时发现没装、或 `--version` 跑不通就直接装(就是下一条的 npm 命令,源连不上会自动换镜像)。安装后必须通过 `--version` 校验才算成功。
- npm:`npm i -g @anthropic-ai/claude-code --include=optional --ignore-scripts=false`。平台二进制属于可选依赖,还需要执行安装后脚本;国内连不上官方源时加 `--registry https://registry.npmmirror.com`。
- 官方原生安装程序(手动安装推荐):见 [Claude Code 安装说明](https://code.claude.com/docs/zh-CN/setup)。选一种方式,避免多份安装互相覆盖。

装好后 `claude --version` 能打出版本号即可。升级用 `claude update`(npm 装的也可以 `npm i -g @anthropic-ai/claude-code@latest --include=optional --ignore-scripts=false`),升级后重新验证。

升级后若出现 `permission denied` 或 `native binary not installed`,先用 `command -v claude`(Windows 用 `where.exe claude`)核对入口,再按所选方式完整重装,运行 `claude --version` 和 `sintbot doctor` 验证。包版本或 npm 退出码不能证明程序可用;给占位文件或残缺二进制补执行权限也无法修复。保留 `~/.claude` 和 `~/.claude.json` 中的配置与会话历史。

**认证**,按要用的模型选一种:

| 要用的模型 | 怎么做 |
|---|---|
| DeepSeek / 智谱 GLM / MiniMax / 火山方舟等(用 API key) | **不用登录**,装好即可;key 在向导里粘贴,见 [models.md](./models.md#三步接上-deepseek-等模型) |
| Claude,用订阅(Pro / Max) | 终端跑 `claude auth login`,在打开的浏览器里登录;`claude auth status` 查看是否已登录 |
| Claude,用 Anthropic API key(按量计费) | `claude auth login --console`;或把 `ANTHROPIC_API_KEY` 放进守护进程的环境 |

- 没有屏幕的机器(如当服务器用的 Mac mini):用屏幕共享(`vnc://机器IP`)进桌面跑一次 `claude auth login`,登录态落盘后无人值守也能用。
- 用个人订阅服务多人群聊的条款问题,见 [中文 README](../../README.zh-CN.md#安全须知)的「安全须知」。
- 验证:`claude --version` → `claude auth status`(用订阅时)→ `sintbot agent run "用一句话自我介绍"`(先在终端试一轮,只读)。

## 前置

| 要求 | 检查 | 说明 |
|---|---|---|
| Node ≥ 22 | `node -v` | 当前 LTS 即可(浏览器接管页要用 Node 自带的 WebSocket) |
| Claude Code | `claude --version` | 可以让 `sintbot setup` 替你装;安装与登录见上一节。只用 DeepSeek 等 API key 模型的话装了不登录也行 |
| Codex CLI(可选) | `codex --version` | 有 ChatGPT 账号才用得上:GPT 群与生图。`npm i -g @openai/codex` 后 `codex login`(浏览器 OAuth,要图形界面) |
| 设计图标库(可选) | `sintbot doctor` 的 `design.icons` 行 | Lucide、Tabler、Phosphor、Pixelarticons 四套,合计约 170 MB。agent 出设计图时按名字从这里取图标;没装就只能自己画,和设计图对不上 |

`sintbot setup` 第一步会检查这几样:缺 Claude Code 就直接装;Codex 和设计图标库是可选的,缺了只打印装法、不问;Claude 与 Codex 的登录状态在模型那一步一起显示。

## 1. 装包

```bash
npm i -g sintbot
sintbot version
```

包名是 **`sintbot`**(npm 上叫 `sbot` 的是别人的包,别装错)。装出两个同义命令:`sbot` 和 `sintbot`。

> ⚠ 同一台机器同时有 Homebrew 的 node 和 nvm 的 node 时,`npm i -g` 装进的是**当前 shell 那份**。常驻服务用的是装服务那一刻的 node(`sintbot service install` 会把路径写进服务),两者对不上就会出现「升级了但跑的还是旧版」。用 `sintbot service install --dry-run` 看服务里写的是哪个 node。

从源码跑:

```bash
git clone https://github.com/sintlab/sintbot.git && cd sintbot
npm install
npm link            # 可选:把 sbot 命令链到全局
```

## 2. 配置:`sintbot setup`

交互式向导,回车即默认(方括号里的值,`(Y/n)` 大写的那个)。只问这台机器跑起来需要的两样:

1. **环境**:Claude Code(缺了就装)、Codex 和设计图标库(可选,缺了打印装法),见上文「前置」
2. **模型**:先显示 Claude 订阅、ChatGPT(Codex)的登录状态和已有 key 的模型,按这个顺序推荐:
   - Claude 已登录 → 默认 Claude;否则 Codex 已登录 → 默认 Codex。不再多问;别的模型在控制台「模型 · 库」里加
   - 都没有 → **推荐 DeepSeek**:告诉你去 platform.deepseek.com 拿 key,粘贴后**当场试跑一轮**。也可以选别家(智谱 GLM / MiniMax / 火山方舟)、另开终端登录 Claude 或 Codex 后回来重新检测,或先跳过
   - 智谱 GLM、MiniMax 有国际站(Z.ai / minimax.io),key 只在开它的那个站能用:向导先试一个站,认证失败自动换另一个站再试;没装 Claude Code 试跑不了时,才问 key 是哪个站开的
   - 试跑失败会说原因:key 不对、余额不足或没实名、连不上(是不是开着全局代理)、模型名不对;可以重新粘贴再试
   - 默认模型由向导自动选(已登录的订阅优先,其次试跑通过的,再次有 key 的),还没试跑过就直接试一轮;群里 `/model` 随时切
   - 没装或没登录 codex 时,codex 预设和「额度用完自动切到 codex」不写进配置。Kimi 不在预设里,要在控制台「模型 · 库 → 添加模型 → 自定义」添加。见 [models.md](./models.md)

配置写到 `~/.sbot/config.json`(权限 600);当前目录已有 `sbot.config.json` 时更新那份。再跑一次 `sintbot setup` 只补缺项,不动已填的。

向导最后做一次简短体检,只列失败项;完整的看 `sintbot doctor`。

**其余的都在控制台里配**(`sintbot ui`,装了服务就是 `http://127.0.0.1:4600`):

| 配什么 | 控制台里的位置 |
|---|---|
| 聊天平台凭据(飞书 / Slack / 企业微信)、预检、飞书管理员 | 「设置」,每个平台都有分步指南;另见 [platforms/](./platforms/) |
| 把群绑到项目目录 | 「群 · 项目」 |
| 机器人名字、网络代理 | 「设置 → 机器人与网络」 |
| 项目根目录 | 控制台里只读(它是控制台能绑哪些目录的围栏)。默认 `~/Projects`;要改就编辑配置里的 `projectsRoots`,或运行 `sintbot setup --full` |

**`sintbot setup --full`**:在终端里问旧的完整一套,给没有浏览器的服务器用 —— 代理分流、机器人名、聊天平台凭据与预检、项目根目录、绑第一个群。

## 3. 常驻:`sintbot service install`

```bash
sintbot service install                      # 写入并启动服务
sintbot service install --ui-host 0.0.0.0    # 控制台对局域网开放(先 sintbot ui --set-password)
sintbot service status | restart | logs | uninstall
```

- **macOS**:写 `~/Library/LaunchAgents/com.sbot.daemon.plist`(LaunchAgent,随用户登录启动,崩溃 15 秒后拉起)
- **Linux**(实验性:1.0 只用单元测试核对过生成的单元文件,没在真机上装过):写 `~/.config/systemd/user/sbot.service`;要开机就起(不必先登录)再跑一次 `loginctl enable-linger $USER`
- 日志:`~/.sbot/logs/err.log`(`sintbot service logs` 看末尾)
- 服务里固定的是:node 的路径、sbot 入口、配置文件绝对路径,以及当前 shell 的 PATH(`claude` / `codex` 所在目录排最前)。**换了 node、挪了配置、新装了 claude 之后,重跑一次 `sintbot service install`**
- node 路径:Homebrew 装的 node 实际在带版本号的目录里,升级后旧路径就没了 —— install 会换成指向同一个程序、不带版本号的路径(如 `/opt/homebrew/bin/node`)。nvm / volta 这类找不到稳定路径的照用原路径,并提醒你换 node 版本后重装服务
- 环境变量:服务里**没有**你 shell 里的变量,install 会把需要的值直接写进服务定义(文件权限 600,`--dry-run` 打印时值是遮住的):配置里所有 `"env:变量名"` 引用,以及配置没写代理时 shell 里的 `https_proxy` 这类变量。换了 key 或代理要重跑 install;或者干脆在配置里填明文(配置文件本身就是 600;代理在控制台「设置 → 机器人与网络」填)
- 控制台对外(`--ui-host` 非本机地址)而没设密码时,install 直接拒绝 —— 否则服务每次一启动就退出
- 还没接聊天平台也照装:服务先只开控制台,在「设置」里接好平台、保存后,几秒内自己重启并连上(1.0.10、1.0.11 这种情况会拒绝安装)
- 服务在跑时运行 `sintbot ui`,会直接打开服务里的控制台,不报端口被占用
- ⚠ 装了服务就别再手动 `sintbot start`:同一个系统用户只允许一个守护进程(锁文件 `~/.sbot/daemon.lock`),第二个会报出已在运行的那个的 pid 后退出。另一台机器或另一个系统用户用**同一个机器人应用**再起一个的话:飞书和 Slack 会把每条消息**随机交给其中一个连接**(另一个就收不到),企业微信则是新连接顶掉旧连接,10 分钟内被顶两次就不再重连

### 升级

控制台「设置 → 软件更新」启动时及之后每天自动检查稳定版,也可手动检查。自动检查始终开启。发现新版后由管理员明确确认才安装;所有群任务和队列空闲后,只升级到刚检测到的精确版本。全局安装目录不可写或当前不是全局安装时不会提权,页面会提示改用终端。

受托管的后台服务会在安装并核对版本后自动重启;前台运行则需手动重启。可忽略当前版本,并选择升级后是否向群播报。网络检查失败不会清掉上次成功结果。

```bash
npm i -g sintbot@latest && sintbot service restart
```

重启会中止正在跑的轮次;被中止的那一轮在重启后自动重做,群里会说一声。最稳妥的做法是挑控制台「概览」里各群都空闲的时候重启。

## macOS:当服务器用的 Mac mini

无人值守要满足:不休眠、断电自恢复、重启后自动进桌面。

```bash
sudo pmset -a sleep 0 disablesleep 1 autorestart 1 powernap 0
```

再到「系统设置 → 用户与群组」打开**自动登录**。LaunchAgent 要有用户会话才会启动(它要读 `~/.claude` / `~/.codex` 的登录态和钥匙串),不开自动登录,重启后服务不会起来。

`codex login` 要浏览器:用屏幕共享(`vnc://机器IP`)进桌面做一次,凭据落盘后无人值守也能用。

## Windows

> 1.0 没有在 Windows 真机上验证过(持续集成只跑 Linux)。下面几条按代码行为写成,遇到问题请提 issue。

- `claude` 若是 npm 装的,实际是 `claude.cmd` 垫片 —— 已自动处理,配置里写 `claude` 即可
- 服务化:`sintbot service install` 在 Windows 上不自动装,而是打印 [NSSM](https://nssm.cc/) 与 pm2 的现成命令,照着执行即可。用 NSSM 时,API key 和代理变量要用 `nssm set SintBot AppEnvironmentExtra …` 带进服务环境
- 项目根目录默认 `D:\Projects`(没有 D 盘则 `%USERPROFILE%\Projects`)

## 代理

在中国大陆:官方 Claude、ChatGPT / Codex、Slack 要走代理,国内模型端点、飞书、企业微信直连。在控制台「设置 → 机器人与网络」填代理(或用 `sintbot setup --full`)后,配置里的 `proxy` 块会:

- 注入到每次 spawn 的 `claude` / `codex` 子进程(不覆盖 shell 里已有的值);
- 也用于守护进程自己连 Slack(Node 的 `fetch` / WebSocket 不读 `HTTP_PROXY` 环境变量,所以单独处理)。

**国内模型端点要直连**:DeepSeek、智谱、MiniMax、火山方舟绕到境外再连回来,既慢,也可能触发对方的风控。在控制台或向导里填代理时,`noProxy` 会按你启用的 provider 自动生成;如果是自己在 shell 里配的代理,把这些域名加进 `NO_PROXY`:

```bash
export NO_PROXY=api.deepseek.com,open.bigmodel.cn,api.minimaxi.com,ark.cn-beijing.volces.com,localhost,127.0.0.1
```

验证代理通没通:`curl -I https://chatgpt.com/` 返回 403 就是通了(Cloudflare 拦裸 curl);超时或连接被拒才是不通。

## 常见问题

| 现象 | 原因与做法 |
|---|---|
| 体检或群里报「未登录」/ `Not logged in` | 默认模型还是 `claude`,但这台机器没登录 Claude。只用 DeepSeek 等:重跑 `sintbot setup` 选模型,或群里 `/model deepseek`、控制台给群换模型;要用 Claude 就跑 `claude auth login` |
| 试跑报「key 不对」(401) | key 没复制完整。智谱 / MiniMax 向导已经把中国站和国际站都试过了,说明 key 本身不对。重跑 `sintbot setup` 重新粘贴 |
| 报余额不足 / 未实名 | 到厂商后台充值、完成实名后再试 |
| 很慢或连不上国内模型 | 开着全局代理(梯子)时请求会绕到境外:把模型域名设成直连,见上文「代理」 |
| npm 安装很慢或失败 | 加 `--registry https://registry.npmmirror.com`;一键安装和向导会自动换 |
| 全局安装报权限错误(EACCES) | 别用 sudo,把 npm 全局目录改到用户目录,做法见上文「一键安装」第 3 条 |
| GitHub 打不开 | 中文介绍和安装步骤在[官网](https://sintbot.com/zh/)上都有;英文 README 在 [npmmirror 的包页](https://npmmirror.com/package/sintbot)上也能看到 |
| 群里 @ 了没反应 | `sintbot doctor` 看平台那几行;`sintbot service logs` 看最近的错误 |

## 卸载

```bash
sintbot service uninstall
npm rm -g sintbot
rm -rf ~/.sbot          # 配置、会话账本、日志都在这里;项目目录不受影响
```
