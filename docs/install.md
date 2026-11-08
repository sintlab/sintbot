# Install SintBot 1.3.0

English · [简体中文](./zh-CN/install.md)

Prepare a Mac, Node.js 22 or newer, an installed and signed-in Codex, and a local project. This release connects one Feishu China group and runs in the foreground.

## 1. Install with one command

```bash
curl -fsSL https://sintbot.com/install.sh | bash
```

The installer checks the environment, installs `sintbot@1.3.0` in `~/.local/share/sintbot`, and verifies its executable, built-in core and Feishu module. Continue when you see `Installed and verified SintBot 1.3.0`. No sudo is needed.

For an optional preview, append `-s -- --dry-run`. To use another installation directory, set `SINTBOT_INSTALL_DIR` and adjust the executable path below.

## 2. Connect Feishu

Create an enterprise custom app on the [Feishu developer platform](https://open.feishu.cn/). Enable the bot and message reception/reply permissions. Select long-connection event delivery and subscribe to message reception. Publish the app, add its bot to a test group and obtain the group's `oc_…` chat ID.

Enter the app credentials in the default macOS terminal. Secret input is hidden:

```zsh
read -r "FEISHU_APP_ID?Feishu App ID: "
read -rs "FEISHU_APP_SECRET?Feishu App Secret: "
printf '\n'
export FEISHU_APP_ID FEISHU_APP_SECRET
```

Never send the secret to a group or commit it. Continue in this terminal; set both variables again when opening a new terminal.

## 3. Link your project

Create a private configuration directory with `mkdir -p ~/.sbot && chmod 700 ~/.sbot`, then create `~/.sbot/config-1.3.0.json`. Replace the group ID and absolute project path. The project directory must exist.

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

After saving, run `chmod 600 ~/.sbot/config-1.3.0.json`. This example starts read-only and receives ordinary group messages; use a dedicated test group.

## 4. First start

Copy this block into the same terminal:

```bash
SINTBOT="$HOME/.local/share/sintbot/bin/sintbot"
"$SINTBOT" init --config "$HOME/.sbot/config-1.3.0.json" &&
"$SINTBOT" start --config "$HOME/.sbot/config-1.3.0.json" --preflight &&
"$SINTBOT" start --config "$HOME/.sbot/config-1.3.0.json"
```

This initializes the message journal, checks configuration and connects to Feishu. Any failed step stops the sequence. **Initialize only once**; do not repeat `init` for normal restarts. Keep the terminal open.

Ask the group to read the first line of the project's README and compare the reply with the file. Preflight alone does not verify Feishu authentication or message delivery.

## Stop and restart

Press Ctrl-C and wait for shutdown. Confirm the Feishu environment variables are set, then run:

```bash
"$HOME/.local/share/sintbot/bin/sintbot" start --config "$HOME/.sbot/config-1.3.0.json"
```

If a task fails or startup reports unresolved receipts, preserve the journal and verify the outcome. Do not delete logs or resend tasks to bypass the problem. Connect only one process to a Feishu app at a time. This release does not register an automatic background service.

[Website guide](https://sintbot.com/guide/install/) · [AI-assisted installation](./AI-ASSISTED-INSTALL.md)
