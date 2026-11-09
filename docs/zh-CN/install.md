# 安装 SintBot 1.4.5

[English](../install.md) · 简体中文

准备一台 Mac、Node.js 22 及以上，以及保存在本机的项目。执行器至少装好并登录一个：Codex，或 Claude Code。本版连接中国区飞书的 1–32 个群，每个群绑定一个本地项目，以前台方式运行。

## 1. 一行安装

```bash
curl -fsSL https://sintbot.com/install.sh | bash
```

安装器会自动检查环境，把 `sintbot@1.4.5` 装到 `~/.local/share/sintbot`，并验证程序入口、内置核心和飞书模块。看到 `Installed and verified SintBot 1.4.5` 就可以继续。不需要 sudo。

可选预览：在命令末尾加 `-s -- --dry-run`。要自定义安装位置，设置 `SINTBOT_INSTALL_DIR` 环境变量，并同步修改后面的可执行文件路径。

## 2. 连接飞书

在 [飞书开放平台](https://open.feishu.cn/) 创建企业自建应用，启用机器人、接收和回复消息的权限，事件订阅选择长连接并订阅消息接收。发布应用后，把机器人加入要使用的群，取得每个群的 `oc_…` 群 ID。

在 macOS 默认终端中输入应用凭据（密钥输入时不显示）：

```zsh
read -r "FEISHU_APP_ID?Feishu App ID: "
read -rs "FEISHU_APP_SECRET?Feishu App Secret: "
printf '\n'
export FEISHU_APP_ID FEISHU_APP_SECRET
```

不要把密钥发进群或提交到仓库。后续步骤都在这个终端里做；新开终端时需要重新设置这两个变量。

## 3. 绑定项目

用 `mkdir -p ~/.sbot && chmod 700 ~/.sbot` 创建私有配置目录，再创建 `~/.sbot/config.json`。把群 ID 和项目绝对路径换成你自己的，项目目录必须已经存在。下面的示例绑定两个群：一个用 Codex，一个用 Claude Code。只有一个群时删掉另一项即可。

```json
{
  "defaultProvider": "codex",
  "providers": {
    "codex": { "runner": "codex" },
    "claude": { "runner": "claude" }
  },
  "feishu": {
    "appId": "env:FEISHU_APP_ID",
    "appSecret": "env:FEISHU_APP_SECRET",
    "onlyWhenMentioned": false
  },
  "groups": {
    "oc_REPLACE_WITH_FIRST_CHAT_ID": {
      "platform": "feishu",
      "provider": "codex",
      "workdir": "/absolute/path/to/first/project",
      "permissionMode": "dontAsk",
      "codexSteer": true
    },
    "oc_REPLACE_WITH_SECOND_CHAT_ID": {
      "platform": "feishu",
      "provider": "claude",
      "workdir": "/absolute/path/to/second/project",
      "permissionMode": "dontAsk"
    }
  }
}
```

保存后执行 `chmod 600 ~/.sbot/config.json`。

- `permissionMode: "dontAsk"` 是受限权限，适合先在测试群试用。确认需要让它修改文件、执行命令时，改为 `"bypassPermissions"`（完全访问）。
- 要固定 Claude 型号，可在 `providers.claude` 里加 `"model"`；不写就用这台机器上 Claude Code 的默认模型。
- 同时运行的任务默认最多 2 个，可在顶层加 `"agent": { "maxConcurrent": 4 }` 调整（1–32）。

## 4. 首次启动

在刚才的终端里一次复制执行：

```bash
SINTBOT="$HOME/.local/share/sintbot/bin/sintbot"
"$SINTBOT" init --config "$HOME/.sbot/config.json" &&
"$SINTBOT" start --config "$HOME/.sbot/config.json" --preflight &&
"$SINTBOT" start --config "$HOME/.sbot/config.json" --ui
```

这组命令依次初始化消息日志、预检配置和执行器、连接飞书并打开本机控制台，任一步失败就停止。**初始化只运行一次**；以后重启不要再执行 `init`。保持终端开启。

在群里发“读取项目 README 的第一行，只回复这一行”，并和本地文件对照。预检通过不代表飞书认证或消息送达已经验证。

## 5. 在群里使用

直接发文字就是给它派任务。回复以卡片呈现：模型开始输出时出现；25 秒还没有输出也会先出现。运行中卡片显示已跑多久、正在做什么和已完成的步骤，结束后这些步骤收进「过程」折叠区。

| 命令 | 作用 |
| --- | --- |
| `/status` | 本群状态：模型、项目、是否在忙（在忙时含步数和正在做什么）、排队数 |
| `/skip` | 只放弃当前任务，排队的接着处理，之前的对话保留 |
| `/stop` | 停止当前任务，连同排队的一起取消；之前的对话保留 |
| `/new` | 忘掉之前的对话，开始新的一段（只在本群空闲时生效） |
| `/model` | 查看可选模型；`/model 名字` 切换（只在本群空闲时生效，切换后开始新的一段对话） |
| `/hud` | 当前模型的额度与本段对话的用量 |
| `/issue 一句话` | 记下问题反馈，在控制台概览里查看和标记处理 |
| `/help` | 查看可用命令，以及本群的项目和模型 |

命令单独发一条；除 `/issue` 和 `/model` 外，后面不要跟别的字。如果飞书应用还订阅了消息撤回事件（控制台接入引导里建议订阅），撤回自己发的消息即取消那件事：还在排队的直接丢弃；当前任务只由这一条触发时会停下；Codex 群里撤回已补充进当前任务的那条，会连当前任务一起取消。

任务进行中再发的消息：Codex 群（`codexSteer: true`）会补充进当前任务，Claude Code 群会排队，等这一轮结束再处理。某一轮模型报错或没有结果时，只在本群提示重新发送，不会自动重试。某个群上一轮的结果无法确认时（例如回复是否送达不明），只暂停这个群，它收到新消息会回一句说明，其他群照常；不重放、不重试。

## 6. 控制台

带 `--ui` 启动后，在本机浏览器打开 `http://127.0.0.1:4600`。控制台可以查看各群状态（暂停的群显示「需要处理」）、停止任务、给空闲的群开新会话、绑定新群、给空闲的群切换模型或项目目录、添加和设置模型。要从局域网访问，先在控制台的设置里设访问密码，再开启局域网访问。

「设置 → 软件更新」会检查新版本。按上面前台方式运行时，卡片给出升级步骤：按 Ctrl-C 等待退出，重新运行一行安装命令，再用原来的命令启动。如果用你自己的 launchd 后台任务启动 SintBot，「现在升级」会等所有群空闲、记录结清后，把新版本装到 `~/.local/share/sintbot/releases/<版本>` 并切换过去；新版本 90 秒内没连上全部群会自动换回旧版。升级时窗口逐步显示进度，服务重启时页面自动重连，也可以放到后台继续。升级不在群里播报。

不用控制台也能加群：在配置里加上新群，停止后重新 `start` 即可，新群会自动登记。已绑定的群不能通过改配置删除或改名。

## 停止与重启

按 Ctrl-C 并等待退出。确认飞书环境变量已设置，再执行：

```bash
"$HOME/.local/share/sintbot/bin/sintbot" start --config "$HOME/.sbot/config.json" --ui
```

某个群一直暂停时，先重启：记录能恢复的群会自己重新开放，并提示一次重新发送。重启后仍暂停，先核对这个群实际发生了什么，再停止服务，封存这个群的事故记录：

```bash
"$HOME/.local/share/sintbot/bin/sintbot" incident seal --config "$HOME/.sbot/config.json" --group oc_暂停的群ID
```

封存会把原日志原样留在数据目录的 `incidents/` 下，并给这个群换一份新日志；封存前没处理完的消息不会再处理。再次启动服务，这个群就重新开放。有群会保持暂停时，预检会失败。不要通过删除日志或重复发送来绕过暂停。一个飞书应用同一时间只运行一个连接进程。本版不自动注册后台服务。

[带图示的官网指南](https://sintbot.com/zh/guide/install/) · [AI 辅助安装](./AI-ASSISTED-INSTALL.md)
