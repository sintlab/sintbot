# Install SintBot 1.4.0

English · [简体中文](./zh-CN/install.md)

You need a Mac, Node.js 22 or newer, and projects stored on that Mac. Install and sign in to at least one runner: Codex or Claude Code. This release connects 1–32 Feishu China groups, binds each group to one local project, and runs in the foreground.

## 1. Install with one command

```bash
curl -fsSL https://sintbot.com/install.sh | bash
```

The installer checks the environment, installs `sintbot@1.4.0` into `~/.local/share/sintbot`, and verifies the entry, built-in core and Feishu module. Continue when you see `Installed and verified SintBot 1.4.0`. No sudo is needed.

To preview, append `-s -- --dry-run`. To choose another location, set `SINTBOT_INSTALL_DIR` and adjust the executable paths below.

## 2. Connect Feishu

In the [Feishu Open Platform](https://open.feishu.cn/), create a custom app, enable the bot and the permissions to receive and reply to messages, choose long connection for event subscription and subscribe to message receipt. Publish the app, add the bot to the groups you will use, and copy each group's `oc_…` chat ID.

Enter the app credentials in the default macOS terminal (the secret is not echoed):

```zsh
read -r "FEISHU_APP_ID?Feishu App ID: "
read -rs "FEISHU_APP_SECRET?Feishu App Secret: "
printf '\n'
export FEISHU_APP_ID FEISHU_APP_SECRET
```

Never post the secret in a group or commit it. Keep using this terminal; set both variables again in a new one.

## 3. Bind projects

Create a private directory with `mkdir -p ~/.sbot && chmod 700 ~/.sbot`, then create `~/.sbot/config.json`. Replace the chat IDs and absolute project paths; each project directory must already exist. The example binds two groups, one with Codex and one with Claude Code. With one group, delete the other entry.

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

Then run `chmod 600 ~/.sbot/config.json`.

- `permissionMode: "dontAsk"` is restricted and suits a first test group. Use `"bypassPermissions"` (full access) once it should edit files and run commands.
- To pin a Claude model, add `"model"` to `providers.claude`; otherwise Claude Code's default model on this Mac is used.
- At most 2 tasks run at once by default; add `"agent": { "maxConcurrent": 4 }` at the top level to change it (1–32).

## 4. First start

Copy and run in the same terminal:

```bash
SINTBOT="$HOME/.local/share/sintbot/bin/sintbot"
"$SINTBOT" init --config "$HOME/.sbot/config.json" &&
"$SINTBOT" start --config "$HOME/.sbot/config.json" --preflight &&
"$SINTBOT" start --config "$HOME/.sbot/config.json" --ui
```

This initializes the message journals, checks the configuration and runners, connects Feishu and opens the local console, stopping at the first failure. **Run `init` only once**; never run it again for a restart. Keep the terminal open.

In a group, send "Read the first line of the project README and reply with only that line", then compare it with the file. A passing preflight does not prove Feishu authentication or delivery.

## 5. Use it in a group

Any text message is a task. Replies arrive in a card that appears once the model starts answering and refreshes as it works.

| Command | Effect |
| --- | --- |
| `/help` | List commands |
| `/status` | Group status: model, project, busy or idle, queue |
| `/model` | List models; `/model name` switches (only while the group is idle; starts a new conversation) |
| `/new` | Start a new conversation (only while the group is idle) |
| `/stop` | Stop the current task and cancel queued ones |
| `/hud` | Quota of the current model and usage of this conversation |
| `/issue text` | Log feedback; review and close it in the console overview |

Messages sent while a task runs are added to that task in Codex groups (`codexSteer: true`) and queued in Claude Code groups. If a turn returns a model error or no result, only that group is asked to resend; there is no automatic retry and other groups are unaffected.

## 6. Console

With `--ui`, open `http://127.0.0.1:4600` on this Mac. The console shows each group, stops tasks, binds new groups, and switches the model or project folder of an idle group. For LAN access, set a console password in its settings first, then enable LAN access.

You can also add a group without the console: add it to the configuration, stop the service and run `start` again; the new group is registered automatically. Bound groups cannot be removed or renamed by editing the configuration.

## Stop and restart

Press Ctrl-C and wait for exit. With the Feishu variables set, run:

```bash
"$HOME/.local/share/sintbot/bin/sintbot" start --config "$HOME/.sbot/config.json" --ui
```

If startup reports an unsettled receipt or a result is uncertain, keep the journals and check what actually happened; never delete journals or resend to get around it. Run only one connected process per Feishu app. This release does not register a background service.

[Illustrated website guide](https://sintbot.com/guide/install/) · [AI-assisted installation](./AI-ASSISTED-INSTALL.md)
