# 安装 SintBot 1.3.0

[English](../install.md) · 简体中文

本版支持 macOS、Node.js 22 及以上、一个飞书群和 Codex 消息轮次，以前台方式运行。多群、其他聊天平台或模型通道、控制台、自动后台服务、定时任务、终端聊天和画布不在 1.3.0 支持范围。

## 1. 准备 Mac

在项目所在 Mac 的本地终端操作，确认 Node.js 22 及以上、Codex 可以实际运行且已完成登录。保留已有 Codex 安装和账号数据。SintBot 安装器不安装或登录 Codex，也不安装 Node。

```bash
node --version
codex --version
```

如果这台 Mac 已经运行 SintBot，保留原来的程序包与配置。可以把新包装到独立目录，但 **1.3.0 不自动迁移已有状态**。初始化会拒绝已有状态、旧收据或日志；不要删除它们来绕过检查。不要让两个进程连接同一个飞书应用。

## 2. 安装到独立目录

下载并检查安装脚本，再执行同一份文件：

```bash
curl -fsSL https://sintbot.com/install.sh -o /tmp/sintbot-install.sh
bash /tmp/sintbot-install.sh --dry-run
bash /tmp/sintbot-install.sh
```

脚本把精确的 **sintbot@1.3.0** 安装到 `~/.local/share/sintbot/releases/1.3.0`，验证实际入口、二进制核心和飞书模块，保留全局安装、终端配置、应用配置和服务。目标目录已存在时拒绝覆盖；可用 `--prefix /全新/绝对/目录` 指定其他位置。`--dry-run` 不修改文件，也不下载程序包。

始终使用这一个实际入口，避免误用全局旧版本：

```bash
SINTBOT="$HOME/.local/share/sintbot/releases/1.3.0/bin/sintbot"
"$SINTBOT" --version
"$SINTBOT" help
```

版本输出应为 `1.3.0`。装好程序包不会自动启动机器人。

## 3. 配置一个飞书群

在 `open.feishu.cn` 创建企业自建应用，启用机器人，授予接收与回复消息的权限，事件订阅选择长连接，订阅消息接收事件，发布应用并把机器人加入测试群。从飞书取得该群的 `oc_…` 群 ID。本版使用中国区飞书，不支持国际版 Lark。

在启动 SintBot 的本地终端中，把应用 ID 和应用密钥分别设为 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 环境变量。不要把密钥发进聊天或提交到仓库。配置中的环境变量引用在启动时解析；每次新开终端都需要保证这两个变量存在。

先用 `mkdir -p ~/.sbot && chmod 700 ~/.sbot` 创建私有配置目录，再创建 `~/.sbot/config-1.3.0.json`，内容如下。把群 ID 和项目路径换成真实值；项目目录必须已存在。只留一个群，两个显式 `false` 不要省略。

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

限制配置文件权限（`chmod 600 ~/.sbot/config-1.3.0.json`）。示例采用只读权限，接收这一个群里的普通消息，请使用专用测试群。若只接收 @ 机器人的消息，须设 `onlyWhenMentioned: true` 并填入该应用实际的 `botOpenId`；缺少机器人 ID 会在启动前被拒绝。不要从旧示例复制控制台、其他平台、定时任务或画布配置；历史完整配置不代表 1.3.0 支持范围。

## 4. 初始化并启动

**仅全新安装**执行：

```bash
"$SINTBOT" init --config "$HOME/.sbot/config-1.3.0.json"
"$SINTBOT" start --config "$HOME/.sbot/config-1.3.0.json" --preflight
"$SINTBOT" start --config "$HOME/.sbot/config-1.3.0.json"
```

`init` 在 `~/.sbot/c2-v2.log` 创建持久收据日志，只运行一次；不会重置已有日志或迁移旧状态。`--preflight` 检查本地配置与装配，不建立飞书连接，也不能代替认证或消息送达验证。`start` 持有单写锁并连接所配群，需要保持终端开启。

在群里直接发消息，要求读取项目 README 的第一行。把返回结果与文件对照。按 Ctrl-C 并等待退出，再用相同的 `start` 命令启动一次。正常重启不要重新执行 `init`。

## 停止、故障和升级

- 按 Ctrl-C 并等待退出；本版不提供登录自启或安装后台服务命令。
- 任务失败或启动提示未结收据时，保留日志与状态，核对实际结果后再处置。不要清空未知效果、覆盖日志或盲目重发相同任务。
- 安装器保留旧程序包，但切版本仍须排空旧进程、备份配置与状态、确认收据兼容。只有旧可执行文件不等于可以安全回退状态。
- 已有多群安装继续用原版本，替换为单群路径前必须有经过核对的迁移方案。

由助手操作时可用 [AI 辅助安装指南](./AI-ASSISTED-INSTALL.md)。
