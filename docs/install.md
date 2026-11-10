# Install SintBot 1.4.12

English · [简体中文](./zh-CN/install.md)

You need a Mac, Node.js 22 or newer, and projects stored on that Mac. Install and sign in to at least one runner: Codex or Claude Code. This release connects 1–32 Feishu China groups, binds each group to one local project, and runs in the foreground.

## 1. Install with one command

```bash
curl -fsSL https://sintbot.com/install.sh | bash
```

The installer checks the environment, installs `sintbot@1.4.12` into `~/.local/share/sintbot`, and verifies the entry, built-in core and Feishu module. Continue when you see `Installed and verified SintBot 1.4.12`. No sudo is needed.

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
      "steer": true
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

Any text message is a task. Replies arrive in a card that appears once the model starts answering, or after 25 seconds if it is still working without output. While the task runs, the card shows how long it has run, what it is doing and the steps already delivered; at the end those steps fold into a Process section.

| Command | Effect |
| --- | --- |
| `/status` | Group status: model, project, busy or idle (steps and current work while busy), queue |
| `/skip` | Cancel only the current task; queued messages run next and the conversation is kept |
| `/stop` | Stop the current task and cancel queued ones; the conversation is kept |
| `/new` | Start a new conversation, forgetting the previous one (only while the group is idle) |
| `/model` | List models; `/model name` switches (only while the group is idle; starts a new conversation) |
| `/hud` | Quota of the current model and usage of this conversation |
| `/issue text` | Log feedback; review and close it in the console overview |
| `/help` | List commands, with this group's project and model |

Send a command as a message of its own; except for `/issue` and `/model`, do not add other text after it. If the Feishu app also subscribes to the message-recall event (the console's setup guide recommends it), recalling your own message cancels it: a queued message is dropped, and the running task stops if that message alone started it; recalling a follow-up handed to either runner cancels the whole task, including accepted input not yet read.

Busy follow-ups default on for both Codex and Claude Code. Set `steer: false` to queue them instead; an explicit `steer` value overrides the legacy Codex setting. Claude Code must advertise the required input capabilities, otherwise messages stay queued. Reading can wait until a long-running tool finishes. The reply card follows confirmed reading, and continuation answers are combined into one final reply. If a turn returns a model error or no result, only that group is asked to resend; there is no automatic retry. If a group's last result cannot be confirmed, such as a reply whose delivery is unknown, only that group is paused and answers new messages with a short notice; other groups keep working. Nothing is replayed or retried.

## 6. Console

The overview combines group projects and concurrency. Each row shows the runner, state and elapsed time, project folder, model and configured reasoning effort, and the latest reported context usage. Select a group to view its tasks, then expand a task for tools, reply and usage. Context is a session sample, not cumulative token consumption; unknown capacity and older samples are labeled. Row icons provide console messages, stop and new-session controls according to the current group state.

With `--ui`, open `http://127.0.0.1:4600` on this Mac. The console shows each group, stops tasks, starts a new conversation for an idle group, binds new groups, switches the model or project folder of an idle group, and adds or configures models. For LAN access, set a console password in its settings first, then enable LAN access.

Settings → Software updates checks for new releases. In the foreground setup above it shows the upgrade steps: press Ctrl-C and wait for exit, rerun the one-line installer, then start again with the same command. If your own launchd agent starts SintBot, Upgrade now waits until every group is idle and settled, installs the new version into `~/.local/share/sintbot/releases/<version>` and switches the agent to it; if the new version does not connect every group within 90 seconds, the previous one is restored. A window shows each step, reconnects by itself while the service restarts and can be left running in the background. On the first start after an upgrade, each serving group gets one card listing what changed; to turn this off, clear "Announce upgrades in groups" under Settings → Software updates.

You can also add a group without the console: add it to the configuration, stop the service and run `start` again; the new group is registered automatically. Bound groups cannot be removed or renamed by editing the configuration.

## Stop and restart

Press Ctrl-C and wait for exit. With the Feishu variables set, run:

```bash
"$HOME/.local/share/sintbot/bin/sintbot" start --config "$HOME/.sbot/config.json" --ui
```

If a group stays paused, first restart: a group whose records can recover reopens on its own and is told once to resend. If it is still paused, check what actually happened in that group, then stop the service and seal the group's incident:

```bash
"$HOME/.local/share/sintbot/bin/sintbot" incident seal --config "$HOME/.sbot/config.json" --group oc_PAUSED_GROUP_ID
```

Sealing keeps the old journal unchanged under `incidents/` in the data directory and gives the group a new journal; messages left unfinished before the seal are never processed again. Start the service again to reopen the group. A preflight fails while any group would stay paused. Never delete journals or resend to get around a paused group. Run only one connected process per Feishu app. This release does not register a background service.

[Illustrated website guide](https://sintbot.com/guide/install/) · [AI-assisted installation](./AI-ASSISTED-INSTALL.md)
