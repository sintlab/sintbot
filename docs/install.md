# Install SintBot 1.4.33

English · [简体中文](./zh-CN/install.md)

You need a Mac, Node.js 22 or newer, and projects stored on that Mac. The setup page installs Codex and Claude Code when they are missing; sign in to one of them, or add an API key, on the console's Models page. This release connects 1–32 project conversations across Slack, Feishu China groups and WeCom chats or groups, binds each conversation to one local project, and runs in the foreground.

## Desktop app

On a Mac, [download SintBot for macOS](https://github.com/sint908/sintbot-desktop/releases/latest), drag it to Applications and open it. Node.js is included. Choose a project, then connect Slack, scan with Feishu, scan with WeCom to create a bot, or start locally. Closing the window keeps the service running. Quitting SintBot stops it until you next log in or open the app. From app 0.2.0 on macOS 13 and later, SintBot opens when you log in, as a menu bar icon only; turn that off under More in its menu or in System Settings > Login Items. Remove Background Service preserves configuration and history.

For Slack, follow the [Slack connection and usage guide](./platforms/slack.md). For WeCom, follow the separate [connection and usage guide](./platforms/wecom.md).

## 1. Install with one command

```bash
curl -fsSL https://sintbot.com/install.sh | bash
```

The installer checks the environment, installs `sintbot@1.4.33` into `~/.local/share/sintbot`, and verifies the entry, built-in core and Feishu module. Continue when you see `Installed and verified SintBot 1.4.33`. No sudo is needed.

To preview, append `-s -- --dry-run`. To choose another location, set `SINTBOT_INSTALL_DIR` and adjust the executable paths below.

## 2. Connect in the browser (recommended)

```bash
"$HOME/.local/share/sintbot/bin/sintbot" start --ui
```

Without a configuration file this command does not fail; it opens the local setup page (`http://127.0.0.1:4600`, reachable only from this Mac). Choose a project, then pick your chat platform. Codex and Claude Code are installed in the background when missing (about 750 MB together, into SintBot's own folder, no sudo); the scan does not wait for them. In English the page lists Slack first.

On a Mac whose system language is Chinese, each platform's setup step has a Network proxy line, prefilled with the proxy your terminal or the system is using; change it or clear it. It is saved as the proxy for the whole service. On an existing installation, set the proxy under Settings → General in the console; it takes effect after a restart. On such a Mac the overview also says so when the system has a proxy the service is not using.

### Slack

Slack has no scan-to-create step, so connecting takes three short steps on the page, with no terminal:

1. Click **Create app in Slack**. Slack opens with the app's permissions and events already filled in; pick your workspace, click **Next**, then **Create**.
2. On the app's **Basic Information** page, generate an app-level token with the `connections:write` scope and paste it (it starts with `xapp-`). The page checks it at once.
3. Click **Open install page**, install the app to your workspace, and paste the **Bot User OAuth Token** (it starts with `xoxb-`).

Click **Connect Slack**, then send the bot any message in Slack: a direct message, or an @mention in a channel you invited it to. That conversation is bound to the project, and the service starts.

You need permission to install apps in the workspace; a free workspace you create yourself works. Both tokens are stored in clear text in `~/.sbot/config.json` (file 0600, directory 0700). In Slack, commands start with `!` (`!status`, `!stop`, `!new`), because Slack keeps `/` for itself. The [Slack guide](./platforms/slack.md) has every step, everyday use and troubleshooting.

To add Slack to an installation you already use, open **Settings → Slack** in the console; existing connections, projects and history are kept.

### Feishu

Prerequisite: the Feishu app on your phone is signed in with an enterprise or team identity; a personal identity without an organization cannot scan, so create a team first (free). The app created by the scan belongs to the scanner's organization; approval depends on its policies.

On the setup page, choose **Feishu** under **Chat platform**. Enter a project name (default `sintbot`, created under `~/Projects` with a `README.md`) or pick an existing folder, tick the basic option if you are not an organization administrator, then click Start. Scan the QR code on the page with Feishu and confirm on the phone. It then, in order: obtains the app credentials → runs the self-check → opens the contact range and visibility and publishes a version → creates a group and adds you → creates the project folder → writes `~/.sbot/config.json` → initializes the message journals, showing each result on the page. Once the scan is confirmed, the app exists in your organization; any later failed check stops before the folder and the configuration exist and the page offers Retry (it reuses the app already created, never a second one); if the group could not be created, the page asks you to create one by hand, add the bot, paste the group ID and continue.

When an executor on this Mac is already signed in, setup reads its live model catalog and saves the recommended model and thinking depth for the new group. Otherwise the group is created waiting for a model: a message there gets one line pointing to the console's Models page, where you sign in to a Claude or ChatGPT account in the browser (the Claude and Codex cards have a sign-in button) or add an API key. The first model added becomes the default. Change the choices later in the console or with `/model`; existing group choices are preserved.

When setup completes the service starts right away and the page switches to the console a few seconds later. Keep the terminal open. In the new group, send "Read the first line of the project README and reply with only that line", then compare it with the `README.md` in the project folder.

### Start on this Mac without a chat platform

If you have no company or team account, or just want to try it first, the setup page ends with "Use on this Mac first". It does not scan or create any app: it writes the configuration for the project chosen on the page, the service starts, and the console opens on its Chat page. Say what you need there; Claude Code or Codex on this Mac works in the project folder and the answer comes back to the page. The transcript is stored under `local-chats/` in the data directory, on this Mac only.

A conversation here runs through the same flow as a Feishu group: messages are registered, a task whose outcome is unknown is held for confirmation instead of being run again, and the commands listed by `/help` work. Unlike a group, the answer appears once the turn ends (the page shows a timer and Stop while it works), images and files are not supported yet, and there are no group message tools.

To add Slack or WeCom later, use Settings in the console (see [Connect Slack](#connect-slack) and [Connect WeCom](#connect-wecom)). To connect Feishu later, open Settings → Feishu in the console, choose a project folder, or leave it empty and SintBot creates one named after the new group, select "Scan to connect Feishu" and confirm in Feishu on your phone. SintBot keeps running: it creates the app and a project group, first backs up the configuration under `config-backups/` in the data directory, and connects. Your conversations, transcripts and settings are kept, and the new group uses the model your conversation already uses.

With the service stopped, the terminal does the same:

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

This checks the configuration and runners, connects the configured chat platforms (Slack, Feishu, WeCom) and opens the local console. Keep the terminal open. If you used `--config` or `--data-dir`, pass the same flags on every start. A passing preflight does not prove that a chat platform accepts the credentials or delivers messages.

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
- At most 2 tasks run at once by default; add `"agent": { "maxConcurrent": 4 }` at the top level to change it (1–32). A running service keeps the value it started with, in the console too: edit the configuration file, then restart the service.

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

In a Feishu group, any text message is a task. Replies arrive in a card that appears once the model starts answering, or after 3 seconds if it is still working without output. While the task runs, the card shows how long it has run, what it is doing and the steps already delivered; at the end those steps fold into a Process section.

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

In Slack, commands start with `!` instead of `/`: `!status`, `!stop`, `!skip`, `!new`, `!model` and `!help`; in a channel, @mention the bot with the command. A running task shows ⏳ on your message instead of a card, and ✅ once the answer arrives; one that runs longer than a few seconds also gets a progress message where the answer will go. See Everyday use in the [Slack guide](./platforms/slack.md). In WeCom, @mention the bot in a group for every task and command; see the [WeCom guide](./platforms/wecom.md).

Busy follow-ups default on for both Codex and Claude Code. Set `steer: false` to queue them instead; an explicit `steer` value overrides the legacy Codex setting. Claude Code must advertise the required input capabilities, otherwise messages stay queued. Reading can wait until a long-running tool finishes. The reply card follows confirmed reading, and continuation answers are combined into one final reply. If a turn returns a model error or no result, only that group is asked to resend; there is no automatic retry. If a group's last result cannot be confirmed, such as a reply whose delivery is unknown, only that group is paused and answers new messages with a short notice; other groups keep working. Nothing is replayed or retried. When Claude Code, or Codex in a group with busy follow-ups off, reports an error before it starts on a message, such as a reached usage limit, the group is not paused: the message is closed as not handled and the group is told why. In a Codex group with busy follow-ups on, a Codex program that exits before it starts on a message is closed the same way, and a failure it reports once the turn has begun (a reached usage limit, an expired sign-in, a network failure) ends the turn with one notice, together with any follow-up merged into it. A single task cut off when the service exits on an unexpected error is reported once in its conversation after the restart and is not redone; the group is not paused.

When the reply card moves below a confirmed follow-up, its existing text is shown immediately and subsequent output continues from that point. Moving the card does not restart the task.

On Claude Code versions advertising compact, an idle group can compact its session after a normal turn once context reaches half the configured compaction window: it runs one `/compact` on the same session and posts nothing in the group. New work stops compaction first. Compaction takes one concurrency slot and starts only when another slot remains free. A value of 0 leaves normal compaction to the executor and disables this idle step. On the turn after a successful idle compaction, the reply already delivered to the group is handed back to the model unchanged (only the end of a long one), so a follow-up that answers by number, such as "1 and 3", still connects; that reply is held in memory only and is not handed back after a service restart. Claude subscription usage is read from the quota event each turn carries: a fresh event updates usage immediately, and while events remain fresh, supplemental quota requests are limited to once every 30 minutes. Idle compaction is experimental in this release: successful compaction and cache behavior still await real-model validation.

## 6. Console

Model and thinking depth are chosen per group: click the group's card under Groups · Projects, and in the settings panel that opens, Model has the backend, the model and the thinking depth, from lists read live from the local Codex and Claude Code. Each group keeps its own model and depth for every backend it has used, so switching back to a backend restores that choice; changing the model or depth continues the conversation, and only a backend change starts a new one. Subscription model cards no longer carry a model or depth. Model cards from an API-key preset also leave the model to each group: the list shows the provider's models, read live once the card has a working key, and a group that has not chosen runs the model stored on the card. A custom endpoint keeps its model on the model card, shared by its groups. After the upgrade, each model card's existing model and depth move into its groups with the same effective values and no session reset, after a configuration backup. Model cards distinguish requested settings from runtime reports; expand Capacity and runtime details for reference limits. Codex context and per-model compaction each offer Executor default or Custom. Numeric inputs appear only for Custom. Changes apply next turn without resetting the session; known catalog context limits are enforced. Compaction means a threshold for Codex and a window for Claude Code, and may start earlier. Explicit legacy global compaction values are converted into independent settings for existing models, preserving per-model overrides. New models use executor defaults. Reading does not rewrite the file; the converted settings are persisted on the next normal configuration save.

In a model card's panel, Check login or Verify login re-reads the available models once the login is confirmed and shows which were added and which are no longer offered; `/model` in a group also fetches the latest list first. The Codex model card's panel also shows the version of the Codex program on this machine, with an Upgrade button when a newer one exists: after you confirm, the latest version is reinstalled globally and every group uses it from its next turn. It does not upgrade while a group is running a Codex task, and the button is offered only for a Codex installed globally with npm; a model card whose configuration names its own Codex program (`bin`) shows that program's version and is upgraded on the machine by hand. If an upgrade fails, the reason stays under the row and the button comes back so you can retry. The Claude subscription card does the same for the Claude Code program: one installed with npm is reinstalled with npm, one from the native installer uses its own updater, and any other install is upgraded on the machine by hand; it does not upgrade while a group is running or queuing a Claude Code task.

The overview combines group projects and concurrency. Each row shows the runner, state and elapsed time, project folder, model and configured reasoning effort, and the latest reported context usage. Select a group to view its tasks, then expand a task for tools, reply and usage. Context is a session sample, not cumulative token consumption; unknown capacity and older samples are labeled. Row icons provide console messages, stop and new-session controls according to the current group state. Below Health, Model usage shows each model's tightest figure on one line, with the ones running low first; unfold it for each model's usage windows (how much is used and when it resets) or balance. On Groups · Projects every card has the same controls in its top right corner (say something, new conversation, pause or resume, stop), and a key that cannot be used right now says why when you hover over it. Removing a group project, and disbanding its Feishu group with it, is the last section of the card's settings panel.

For a Claude Code model with a compaction line, the context bar has two marks: past the tidy line the context is tidied after a turn, while the group is idle; at the compaction line it is compacted during a turn. The line below the bar shows tidying in progress or the last result. In a long conversation, a message that arrives after tidying has started waits for it: the group is told roughly how many minutes, 5 at most. A Claude Code model added now starts with a 500k-token compaction line; change it under Auto-compaction on the model card.

The settings panel of a Claude Code group has Plugins: an unchecked MCP server is not loaded for that group, everything else loads as before, from the next turn. A server that cannot be reached is skipped and comes back by itself.

With `--ui`, open `http://127.0.0.1:4600` on this Mac. The console shows each group, stops tasks, starts a new conversation for an idle group, binds new groups, switches the model or project folder of an idle group, and adds or configures models. For LAN access, set a console password in its settings first, then enable LAN access.

The Chat page lists the conversations held on this Mac. There you can create one (project folder and model), send messages, stop the current task and start a new session; the model, access mode and project folder are still changed under Groups · Projects, where conversations appear beside groups. With only conversations and no chat platform connected, the console opens on this page.

The Message action also works while a group is busy. It follows the group’s follow-up setting: the message waits for model reading or joins the queue. “Accepted” does not yet confirm that the model has read it. New sessions and model changes still require an idle group.

Settings → Software updates checks for new releases. In the foreground setup above it shows the upgrade steps: press Ctrl-C and wait for exit, rerun the one-line installer, then start again with the same command. If your own launchd agent starts SintBot, Upgrade now waits until every group is idle and settled, installs the new version into an isolated release directory and switches the agent to it; if the new version does not connect every group within 90 seconds, the previous one is restored. A window shows each step, reconnects by itself while the service restarts and can be left running in the background. On the first start after an upgrade, each serving group gets one card listing what changed, with a link to that version's release notes on the website; to turn this off, clear "Announce upgrades in groups" under Settings → Software updates.

If an installation fails, retry uses a fresh directory and preserves the failed attempt for diagnosis. It switches only after verification.

You can also add a group without the console: add it to the configuration, stop the service and run `start` again; the new group is registered automatically. Bound groups cannot be removed or renamed by editing the configuration.

### Scheduled tasks

A conversation can have scheduled tasks; they are managed from the console. A task has a name, a time and one of three kinds:

- **Model.** At the time, one line marked `[Scheduled]` (`【定时】` in a Chinese conversation) with the task's name and the beginning of its text is posted in the conversation. The text is then handled like a message someone sent there: it waits its turn when the conversation is busy, and the answer appears under that line. This turn takes no follow-ups and runs at standard speed.
- **Message.** The text is posted, nothing else.
- **Script.** A command runs in the conversation's project folder, outside the conversation and with the service's own permissions, not the conversation's access mode. Nothing is said when it succeeds; one line is posted when it fails or runs past its time limit (15 minutes unless the task sets another).

The time is a five-field cron expression, an alias such as `@daily`, a shorthand such as `每天 09:00`, or one date and time for a task that runs once (`YYYY-MM-DD HH:mm`). It is read in the product time zone (`timezone` in the configuration, Asia/Shanghai by default) unless the task has its own.

- **At most once.** Each due time is written to a run record before anything is posted or started, and it never fires twice. A post or a run whose result is unknown, for example because the service stopped at that moment, is shown as unknown and is not repeated.
- **Missed runs are not made up for.** If the service was not running at the time, or reaches it more than two minutes late, that run is shown as missed. A run is also skipped, and shown as such, while its conversation is paused or the service is upgrading; a Model task is skipped too while the conversation is held for a person or already has two messages waiting.
- **Clock changes.** When clocks go back, a time that occurs twice fires once. When they go forward, a time that does not exist that day does not fire.
- **Where it is kept.** Tasks and the run record are in `schedules/` in the data directory, not in the configuration file. If these files cannot be read, scheduled tasks stay off and everything else keeps working; the service log says why.
- **Limits.** 20 tasks per conversation; a name up to 60 characters; text up to 4,000 characters. WeCom conversations do not have scheduled tasks yet.

## Stop and restart

Press Ctrl-C and wait for exit. If the configuration uses `env:` references, set those variables first, then run:

```bash
"$HOME/.local/share/sintbot/bin/sintbot" start --config "$HOME/.sbot/config.json" --ui
```

If a group is paused, an admin can send `/resume` in that group (`!resume` in Slack, or your own command prefix): the previous task's record is archived unchanged, its messages are never processed again, and the group is back right away while the service keeps running. With a Feishu admin list, only people on it can use it in Feishu groups. A Codex quota that runs out mid-task no longer pauses a group; the task ends with a notice instead.

If a group stays paused, first restart: a group whose records can recover reopens on its own and is told once to resend. If it is still paused, check what actually happened in that group, then stop the service and seal the group's incident:

```bash
"$HOME/.local/share/sintbot/bin/sintbot" incident seal --config "$HOME/.sbot/config.json" --group oc_PAUSED_GROUP_ID
```

Sealing keeps the old journal unchanged under `incidents/` in the data directory and gives the group a new journal; messages left unfinished before the seal are never processed again. Start the service again to reopen the group. When the service runs in the background (for example under the desktop app), **Seal and continue** on the console overview's "Needs attention" card performs the same seal. Once the paused task has fully stopped, it seals in place and the service keeps running; otherwise the service restarts by itself after the seal and waits until other groups have no task. The service still starts when every group is paused, so the console stays available. A preflight fails while any group would stay paused. Never delete journals or resend to get around a paused group. Run only one connected process per Feishu or Slack app. This release does not register a background service.

Every time the service starts, and after every setting changed while it runs, the configuration in use is stored unchanged under `config-history/` in the data directory. The latest 50 are kept and only you can read the files. To list the stored versions and which settings changed in each (setting names only, never values):

```bash
"$HOME/.local/share/sintbot/bin/sintbot" config history
```

To go back to one, stop the service first, then run the command below with a version from that list, or the beginning of one. The current configuration is stored before the restore, so the restore can itself be undone; affected groups must have settled records, and a group whose backend or project directory changed starts a new conversation. It takes effect at the next start. The command refuses to run while the service is running.

```bash
"$HOME/.local/share/sintbot/bin/sintbot" config restore VERSION --config "$HOME/.sbot/config.json"
```

[Illustrated website guide](https://sintbot.com/guide/install/) · [AI-assisted installation](./AI-ASSISTED-INSTALL.md)

## Connect Slack

Choose Slack on the first-launch setup page, or add it from Settings in an existing console. Follow the [Slack connection guide](./platforms/slack.md) to create the app, paste the two tokens, bind a conversation and send the first task.

## Connect WeCom

Choose WeCom on the first-launch setup page and click **Scan to create bot**; an existing installation uses **Settings → Add WeCom** in the console. Then, within 10 minutes, send the bot one message in WeCom: directly in a one-to-one chat, or @mention it in a group. See the [WeCom connection guide](./platforms/wecom.md) for the manual option and everyday use.
