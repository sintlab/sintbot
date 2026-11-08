# 安装 SintBot 1.3.0

[English](../install.md) · 简体中文

准备一台 Mac、Node.js 22 及以上、已安装并登录的 Codex，以及保存在本机的项目。本版连接一个中国区飞书群，以前台方式运行。

## 1. 一行安装

```bash
curl -fsSL https://sintbot.com/install.sh | bash
```

安装器自动检查环境，将 `sintbot@1.3.0` 安装到 `~/.local/share/sintbot`，并验证程序入口、内置核心和飞书模块。看到 `Installed and verified SintBot 1.3.0` 即可继续。不需要 sudo。

可选预览：在命令末尾加 `-s -- --dry-run`。自定义安装位置使用 `SINTBOT_INSTALL_DIR` 环境变量，并同步修改后面的可执行文件路径。

## 2. 连接飞书

在 [飞书开放平台](https://open.feishu.cn/) 创建企业自建应用，启用机器人、接收和回复消息权限，事件订阅选择长连接并订阅消息接收。发布应用，把机器人加入测试群，取得该群的 `oc_…` 群 ID。

在 macOS 默认终端中输入应用凭据，密钥输入不回显：

```zsh
read -r "FEISHU_APP_ID?Feishu App ID: "
read -rs "FEISHU_APP_SECRET?Feishu App Secret: "
printf '\n'
export FEISHU_APP_ID FEISHU_APP_SECRET
```

不要把密钥发进群或提交到仓库。继续使用这个终端；新开终端时需重新设置这两个变量。

## 3. 绑定项目

用 `mkdir -p ~/.sbot && chmod 700 ~/.sbot` 创建私有配置目录，再创建 `~/.sbot/config-1.3.0.json`。替换群 ID 和项目绝对路径，项目目录须已存在。

```json
{
  "defaultProvider": "codex",
  "providers": { "codex": { "runner": "codex" } },
  "feishu": {
    "appId": "env:FEISHU_APP_ID",
    "appSecret": "env:FEISHU_APP_SECRET",
    "onlyWhenMentioned": false
  },
  "groups": {
    "oc_REPLACE_WITH_YOUR_CHAT_ID": {
      "platform": "feishu",
      "provider": "codex",
      "workdir": "/absolute/path/to/your/project",
      "permissionMode": "dontAsk",
      "codexSteer": false,
      "codexApp": false
    }
  }
}
```

保存后执行 `chmod 600 ~/.sbot/config-1.3.0.json`。此示例先用只读权限，接收群内普通消息，适合专用测试群。

## 4. 首次启动

在刚才的终端里一次复制执行：

```bash
SINTBOT="$HOME/.local/share/sintbot/bin/sintbot"
"$SINTBOT" init --config "$HOME/.sbot/config-1.3.0.json" &&
"$SINTBOT" start --config "$HOME/.sbot/config-1.3.0.json" --preflight &&
"$SINTBOT" start --config "$HOME/.sbot/config-1.3.0.json"
```

这组命令初始化消息日志、预检配置并连接飞书，任一步失败就停止。**初始化只运行一次**；正常重启不要再次执行 `init`。保持终端开启。

在群里发“读取项目 README 的第一行，只回复这一行”，并与本地文件对照。预检通过不代表飞书认证或消息送达已验证。

## 停止与重启

按 Ctrl-C 并等待退出。确认飞书环境变量已设置，再执行：

```bash
"$HOME/.local/share/sintbot/bin/sintbot" start --config "$HOME/.sbot/config-1.3.0.json"
```

若任务失败或启动提示未结收据，保留任务日志并核对实际结果；不要通过删除日志或重复发送任务绕过问题。一个飞书应用同时只运行一个连接进程。本版不自动注册后台服务。

[带图示的官网指南](https://sintbot.com/zh/guide/install/) · [AI 辅助安装](./AI-ASSISTED-INSTALL.md)
