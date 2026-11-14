# Install SintBot 1.4.22

English · [简体中文](./zh-CN/install.md)

You need a Mac, Node.js 22 or newer, and projects stored on that Mac. Install and sign in to at least one runner: Codex or Claude Code. This release connects 1–32 project conversations across Feishu China and WeCom groups, binds each group to one local project, and runs in the foreground.

## Desktop app

On an Apple silicon Mac, [download SintBot for macOS](https://github.com/sintlab/sintbot-desktop/releases/latest), drag it to Applications and open it. Node.js is included. Choose a project and executor, then start locally, scan with Feishu, or connect a WeCom smart bot. Closing the window or quitting the app keeps the service running; Stop holds across logins until you choose Start. Remove Background Service preserves configuration and history.

For WeCom, follow the separate [connection and usage guide](./platforms/wecom.md).

## 1. Install with one command

```bash
curl -fsSL https://sintbot.com/install.sh | bash
```

The installer checks the environment, installs `sintbot@1.4.22` into `~/.local/share/sintbot`, and verifies the entry, built-in core and Feishu module. Continue when you see `Installed and verified SintBot 1.4.22`. No sudo is needed.

To preview, append `-s -- --dry-run`. To choose another location, set `SINTBOT_INSTALL_DIR` and adjust the executable paths below.

## 2. Connect Feishu in the browser (recommended)

Prerequisite: the Feishu app on your phone is signed in with an enterprise or team identity; a personal identity without an organization cannot scan, so create a team first (free). The app created by the scan belongs to the scanner's organization; approval depends on its policies.

```bash
"$HOME/.local/share/sintbot/bin/sintbot" start --ui
```

Without a configuration file this command does not fail; it opens the local setup page (`http://127.0.0.1:4600`, reachable only from this Mac). Enter a project name (default `sintbot`, created under `~/Projects` with a `README.md`) or pick an existing folder, choose the runner if both are installed, tick the basic option if you are not an organization administrator, then click Start. Scan the QR code on the page with Feishu and confirm on the phone. It then, in order: obtains the app credentials → runs the self-check → opens the contact range and visibility and publishes a version → creates a group and adds you → creates the project folder → writes `~/.sbot/config.json` → initializes the message journals, showing each result on the page. Once the scan is confirmed, the app exists in your organization; any later failed check stops before the folder and the configuration exist and the page offers Retry (it reuses the app already created, never a second one); if the group could not be created, the page asks you to create one by hand, add the bot, paste the group ID and continue.

Before showing the QR code, setup reads the selected executor's live model catalog and displays its recommended model and thinking depth. These choices are saved explicitly for the new group. If the live list is unavailable, setup stops before creating an app; check the executor login and connection, then retry. After connecting, change the choices in the console or with `/model`. Existing group choices are preserved.

When setup completes the service starts right away and the page switches to the console a few seconds later. Keep the terminal open. In the new group, send "Read the first line of the project README and reply with only that line", then compare it with the `README.md` in the project folder.

### Start on this Mac without Feishu

If you have no company or team account, or just want to try it first, the setup page ends with "Use on this Mac without a chat app". It does not scan or create any app: it writes the configuration from the project and executor chosen on the page, the service starts, and the console opens on its Chat page. Say what you need there; Claude Code or Codex on this Mac works in the project folder and the answer comes back to the page. The transcript is stored under `local-chats/` in the data directory, on this Mac only.

A conversation here runs through the same flow as a Feishu group: messages are registered, a task whose outcome is unknown is held for confirmation instead of being run again, and the commands listed by `/help` work. Unlike a group, the answer appears once the turn ends (the page shows a timer and Stop while it works), images and files are not supported yet, and there are no group message tools.

To connect Feishu later, stop SintBot, run the command below, confirm the scan in Feishu on your phone, then start as usual. Your conversations, transcripts and settings are kept, the command first backs up the configuration under `config-backups/` in the data directory, and the new group's message log is registered on the next start.

```bash
"$HOME/.local/share/sintbot/bin/sintbot" connect --attach
```

### Terminal route

The same flow is available without a browser; the flags map to the options on the page:

```bash
"$HOME/.local/share/sintbot/bin/sintbot" connect
```

In an interactive terminal it first asks for the project name (press Enter for the default `sintbot`), then prints the scan link and opens a local page with the QR code; the steps are the same as above, results are printed in the terminal, and a failure prints the rerun command with `--app-id`.

- The credentials are stored in clear text in `~/.sbot/config.json` (file 0600, directory 0700). To switch back to environment variables, change `appId` / `appSecret` to `"env:FEISHU_APP_ID"` / `"env:FEISHU_APP_SECRET"` and export both before every start.
- `--basic`: for a non-administrator in a company organization. It does not request `application:application:patch` and skips the range and publish steps; ask an administrator to finish those two in the Open Platform.
- `--app-id cli_…`: reuse an existing app (add permissions to it instead of creating one), to rerun after a stop or once a review is approved. Allowed only when there is no configuration file, or the file belongs to that app and binds no group yet; a configuration with groups is never replaced.
- `--chat oc_…`: skip group creation and bind a group you created by hand with the bot added (the notice after a failed group creation shows this command).
- `--workdir /absolute/path`: bind an existing directory instead of creating one; `--name` changes the default folder name; `--provider codex|claude` picks the runner (chosen automatically when only one is installed); `--no-open` prints the link without opening the page.
- `connect` refuses to run when a Feishu configuration already exists or the service is running. The scan requests the card callbacks used by `/model`. If the card does not respond, check the callback subscription as in section 4.

## 3. Everyday start

After setup, every start uses the same command; with the configuration in its default location it is the same one you used to connect:

```bash
"$HOME/.local/share/sintbot/bin/sintbot" start --ui
```

This checks the configuration and runners, connects Feishu and opens the local console. Keep the terminal open. If you used `--config` or `--data-dir`, pass the same flags on every start. A passing preflight does not prove Feishu authentication or delivery.

## 4. Manual setup (alternative)

Use the manual route when the scan fails, an administrator does not approve, or you prefer to manage the app yourself; it is the same procedure as before.

<details>
<summary>Show the manual steps</summary>

#### 4.1 Create the app

In the [Feishu Open Platform](https://open.feishu.cn/), create a custom app, enable the bot, grant the same permissions scan setup requests under Permissions (`im:message.group_msg`, `im:message:readonly`, `im:message:send_as_bot`, `im:resource`, `im:message.reactions:write_only`, `im:chat`, `cardkit:card:write`, `contact:contact.base:readonly`, `contact:department.base:readonly`, `contact:user.base:readonly`) and set the contact data range to all members, choose long connection for event subscription and subscribe to message receipt. For callbacks, also choose long connection and subscribe to card action callbacks (the tap-to-pick `/model` card needs them). Publish the app, add the bot to the groups you will use, and copy each group's `oc_…` chat ID.

Enter the app credentials in the default macOS terminal (the secret is not echoed):

```zsh
read -r "FEISHU_APP_ID?Feishu App ID: "
read -rs "FEISHU_APP_SECRET?Feishu App Secret: "
printf '\n'
export FEISHU_APP_ID FEISHU_APP_SECRET
```

Never post the secret in a group or commit it. Keep using this terminal; set both variables again in a new one.

#### 4.2 Write the configuration

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

#### 4.3 Initialize and start

Copy and run in the same terminal (the manual route runs `init` itself):

```bash
SINTBOT="$HOME/.local/share/sintbot/bin/sintbot"
"$SINTBOT" init --config "$HOME/.sbot/config.json" &&
"$SINTBOT" start --config "$HOME/.sbot/config.json" --preflight &&
"$SINTBOT" start --config "$HOME/.sbot/config.json" --ui
```

This initializes the message journals, checks the configuration and runners, connects Feishu and opens the local console, stopping at the first failure. **Run `init` only once**; never run it again for a restart. Keep the terminal open.

In a group, send "Read the first line of the project README and reply with only that line", then compare it with the file. A passing preflight does not prove Feishu authentication or delivery.

</details>

## 5. Use it in a group

Any text message is a task. Replies arrive in a card that appears once the model starts answering, or after 25 seconds if it is still working without output. While the task runs, the card shows how long it has run, what it is doing and the steps already delivered; at the end those steps fold into a Process section.

| Command | Effect |
| --- | --- |
| `/status` | Group status: model, project, busy or idle (steps and current work while busy), queue |
| `/skip` | Cancel only the current task; queued messages run next and the conversation is kept |
| `/stop` | Stop the current task and cancel queued ones; the conversation is kept |
| `/new` | Start a new conversation, forgetting the previous one (only while the group is idle) |
| `/model` | Opens a tap-to-pick card: choose the backend, model and thinking depth, then confirm. You can also send `/model high`, `/model <model>` or `/model <backend>`. A model or depth change continues the conversation; a backend change starts a new one. Only while the group is idle |
| `/hud` | Quota of the current model and usage of this conversation; Claude groups also show the idle compaction line and the last compaction time |
| `/issue text` | Log feedback; review and close it in the console overview |
| `/help` | List commands, with this group's project and model |

Send a command as a message of its own; except for `/issue` and `/model`, do not add other text after it. If the Feishu app also subscribes to the message-recall event (scan setup subscribes to it; add it on the manual path too), recalling your own message cancels it: a queued message is dropped, and the running task stops if that message alone started it; recalling a follow-up handed to either runner cancels the whole task, including accepted input not yet read.

Busy follow-ups default on for both Codex and Claude Code. Set `steer: false` to queue them instead; an explicit `steer` value overrides the legacy Codex setting. Claude Code must advertise the required input capabilities, otherwise messages stay queued. Reading can wait until a long-running tool finishes. The reply card follows confirmed reading, and continuation answers are combined into one final reply. If a turn returns a model error or no result, only that group is asked to resend; there is no automatic retry. If a group's last result cannot be confirmed, such as a reply whose delivery is unknown, only that group is paused and answers new messages with a short notice; other groups keep working. Nothing is replayed or retried.

When the reply card moves below a confirmed follow-up, its existing text is shown immediately and subsequent output continues from that point. Moving the card does not restart the task.

On Claude Code versions advertising compact, an idle group can compact its session after a normal turn once context reaches half the configured compaction window. New work stops compaction first. Compaction takes one concurrency slot and starts only when another slot remains free. A value of 0 leaves normal compaction to the executor and disables this idle step. Fresh quota events update usage immediately; while events remain fresh, supplemental quota requests are limited to once every 30 minutes. Idle compaction is experimental in this release: successful compaction and cache behavior still await real-model validation.

## 6. Console

Model and thinking depth are chosen per group: on the group card, the Model row picks the backend and model and the next row picks the depth, from lists read live from the local Codex and Claude Code. Subscription model cards no longer carry a model or depth; a third-party endpoint keeps its model on the model card. After the upgrade, each model card's existing model and depth move into its groups with the same effective values and no session reset, after a configuration backup. Model cards distinguish requested settings from runtime reports; expand Capacity and runtime details for reference limits. Codex context and per-model compaction each offer Executor default or Custom. Numeric inputs appear only for Custom. Changes apply next turn without resetting the session; known catalog context limits are enforced. Compaction means a threshold for Codex and a window for Claude Code, and may start earlier. Explicit legacy global compaction values are converted into independent settings for existing models, preserving per-model overrides. New models use executor defaults. Reading does not rewrite the file; the converted settings are persisted on the next normal configuration save.

The overview combines group projects and concurrency. Each row shows the runner, state and elapsed time, project folder, model and configured reasoning effort, and the latest reported context usage. Select a group to view its tasks, then expand a task for tools, reply and usage. Context is a session sample, not cumulative token consumption; unknown capacity and older samples are labeled. Row icons provide console messages, stop and new-session controls according to the current group state.

With `--ui`, open `http://127.0.0.1:4600` on this Mac. The console shows each group, stops tasks, starts a new conversation for an idle group, binds new groups, switches the model or project folder of an idle group, and adds or configures models. For LAN access, set a console password in its settings first, then enable LAN access.

The Chat page lists the conversations held on this Mac. There you can create one (project folder and model), send messages, stop the current task and start a new session; the model, access mode and project folder are still changed under Groups · Projects, where conversations appear beside groups. With only conversations and no chat platform connected, the console opens on this page.

The Message action also works while a group is busy. It follows the group’s follow-up setting: the message waits for model reading or joins the queue. “Accepted” does not yet confirm that the model has read it. New sessions and model changes still require an idle group.

Settings → Software updates checks for new releases. In the foreground setup above it shows the upgrade steps: press Ctrl-C and wait for exit, rerun the one-line installer, then start again with the same command. If your own launchd agent starts SintBot, Upgrade now waits until every group is idle and settled, installs the new version into an isolated release directory and switches the agent to it; if the new version does not connect every group within 90 seconds, the previous one is restored. A window shows each step, reconnects by itself while the service restarts and can be left running in the background. On the first start after an upgrade, each serving group gets one card listing what changed; to turn this off, clear "Announce upgrades in groups" under Settings → Software updates.

If an installation fails, retry uses a fresh directory and preserves the failed attempt for diagnosis. It switches only after verification.

You can also add a group without the console: add it to the configuration, stop the service and run `start` again; the new group is registered automatically. Bound groups cannot be removed or renamed by editing the configuration.

## Stop and restart

Press Ctrl-C and wait for exit. If the configuration uses `env:` references, set those variables first, then run:

```bash
"$HOME/.local/share/sintbot/bin/sintbot" start --config "$HOME/.sbot/config.json" --ui
```

If a group stays paused, first restart: a group whose records can recover reopens on its own and is told once to resend. If it is still paused, check what actually happened in that group, then stop the service and seal the group's incident:

```bash
"$HOME/.local/share/sintbot/bin/sintbot" incident seal --config "$HOME/.sbot/config.json" --group oc_PAUSED_GROUP_ID
```

Sealing keeps the old journal unchanged under `incidents/` in the data directory and gives the group a new journal; messages left unfinished before the seal are never processed again. Start the service again to reopen the group. When the service runs in the background (for example under the desktop app), **Seal and continue** on the console overview's "Needs attention" card performs the same seal and the service restarts by itself; it waits until other groups have no task. The service still starts when every group is paused, so the console stays available. A preflight fails while any group would stay paused. Never delete journals or resend to get around a paused group. Run only one connected process per Feishu app. This release does not register a background service.

[Illustrated website guide](https://sintbot.com/guide/install/) · [AI-assisted installation](./AI-ASSISTED-INSTALL.md)

## Connect WeCom

Choose WeCom on the first-launch setup page, or add it from Settings in an existing console. Follow the [WeCom connection guide](./platforms/wecom.md) to create the bot, bind a group and send the first task.
