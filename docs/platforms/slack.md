# Connect Slack

English · [简体中文](../zh-CN/platforms/slack.md)

SintBot joins your Slack workspace as an app you create yourself. It connects over Socket Mode, so tasks run on your Mac with no public address, and it works in free workspaces. Message the bot directly, or @mention it in a channel.

Slack has no scan-to-create step, so connecting takes three short steps: create the app from a link that is already filled in, paste two tokens, then send the bot one message. No terminal is needed.

## Before you start

- You need permission to install apps in the workspace. If your workspace requires admin approval, either ask an admin or create a free workspace of your own.
- One Slack app serves one Mac. Slack hands each message to only one of an app's connections, so two Macs sharing an app would each miss messages. Create a second app for a second Mac.

## 1. Create the app

On first launch, choose a project and an executor, pick **Slack** under **Chat platform**, and click **Create app in Slack**. For an installation you already use, open **Settings → Slack** in the console instead; your existing connections, projects and history are kept.

Slack opens with the app's permissions and events already filled in. Pick your workspace, click **Next**, then **Create**. You can change the app's name on the SintBot page before you click.

**Declare it as a Slack Agent**, below the button, is unticked by default; usually leave it that way. Ticked, channel threads show Slack's own "Working…" status and Stop button, but Slack then keeps workspace guests out of the app and turns every direct message with it into a thread, and neither can be undone later. Unticked, everything else works the same: a running task still shows ⏳ / ✅, and `!stop` stops it (see Everyday use). Apps created with SintBot 1.4.24 are already declared as agents; that has taken effect and needs nothing from you.

## 2. Paste the app-level token

After creating the app you land on its **Basic Information** page. Scroll to **App-Level Tokens**, click **Generate Token and Scopes**, give it any name, add the `connections:write` scope and click **Generate**. Copy the token that starts with `xapp-` and paste it into SintBot. The app settings page can take ten seconds or more to load the first time; reload it if it stays blank.

SintBot checks the token as soon as you paste it and tells you if you pasted a different kind of token.

## 3. Install the app and paste the bot token

Click **Open install page** in SintBot, then in Slack click the install button named after your workspace (for example **Install to Acme**) and **Allow**. Copy the **Bot User OAuth Token** that starts with `xoxb-` and paste it into SintBot.

Click **Connect Slack** (or **Connect and bind project** in the console). SintBot checks that both tokens belong to the same app and that the app has the permissions it needs.

Both tokens are saved only on this Mac, in the configuration file that only your account can read. Never post them in a chat.

### Reaching Slack through a proxy

If this Mac reaches Slack only through a proxy (for example on mainland-China networks), enter an address starting with `http://` under **Proxy** in the Slack step, such as `http://127.0.0.1:7890`. When the terminal that opened the setup page has a proxy set, the field is filled in for you; you can change it or clear it, and a user name and password show only as `***`. Both token checks and the connection afterwards go through this proxy. It is saved with the connection as the SintBot service's network proxy, not only for Slack: other chat platforms and the model tools on this Mac also reach the network through it, and Feishu, WeCom and local addresses are saved as direct. The service keeps using it when the system or the desktop app starts it later without the terminal's proxy settings. The service started right after setup also follows this field, even if the terminal set a different proxy or you cleared the field. Only http proxies work.

When you add Slack under **Settings → Slack** in the console, the service uses the proxy it was started with, and the card shows the one it really uses (a proxy set in the terminal that started the service wins over the saved one). If that proxy came from the terminal and the configuration has none yet, the card offers **Also save the proxy the service is using now**, ticked by default; once saved, it is the whole service's network proxy as well.

## 4. Send the first message

When SintBot shows **Waiting for your message**, click **Open the bot in Slack** and send it any message. That conversation is now bound to the project you chose, and the bot replies that the project is connected.

To bind a channel instead, invite the bot first with `/invite @your-bot-name`, then @mention it there. A channel the bot has not joined delivers nothing to it; for a private channel Slack even reports the channel as not found. The first message only binds; send your task after the reply.

A first task to try: "Read the first line of the project README and reply with only that line."

## Add another channel

Each conversation is bound to one project folder. To bind another channel, invite the bot with `/invite @your-bot-name`, then in the console open **Groups · Projects → Set up a group project**, choose Slack and pick the channel. Only channels the bot has joined are listed; if you type in the ID of a channel the bot is not in yet, the console tells you to invite it first.

## Everyday use

- **Direct message:** every message is a task. The answer arrives in the conversation itself.
- **Channel:** only messages that @mention the bot are tasks. The answer arrives in a thread under your message; to follow up, @mention the bot again in that thread.
- **Commands start with `!`.** Slack keeps `/` for its own slash commands, so type `!status`, `!stop`, `!skip`, `!new`, `!model` or `!help`. In a channel, @mention the bot with the command. `/sint stop` and the other commands also work through the `/sint` slash command, outside threads.
- **While a task runs**, your message shows ⏳; when the answer arrives, it becomes ✅.
- **To stop a task**, say stop where the task is. In the task's thread, @mention the bot with `!stop`: only the task running in that thread stops, and tasks waiting in the queue still run (a follow-up of the same thread that was waiting too; to cancel a waiting message, delete it). If nothing in that thread is running, it tells you so and stops nothing. To stop the whole channel (the current task and everything queued), @mention the bot with `!stop` as a new message in the channel, or use `/sint stop` there. In a direct message, `!stop` stops the current task and everything queued. Apps declared as a Slack Agent also show Slack's own Stop button in channel threads; it does the same as `!stop` typed in that thread, and pressed after its task has ended, it only tells you so.
- **A task that could not finish** (for example, the service was stopped in the middle) gets ⚠️ instead of ⏳, and its thread says it did not finish. SintBot never runs it again by itself; send it again if you still need it.
- **Images and files** you send with a task are saved on your Mac and handed to the task. Files larger than 30 MB are not downloaded.
- **Deleting your message** cancels it: a waiting message is dropped, and a running task stops.
- **Long answers** arrive as several consecutive messages.
- **More messages while a task runs.** In a channel, each thread is its own task. A message in the running task's thread (@mention the bot there) joins that task once the model reads it; it gets ⏳ too, and the answer arrives in that thread. A new @mention outside that thread waits as a task of its own: its thread says it is queued, and its answer arrives in its own thread. Messages waiting in the same thread run together. At most two messages wait; beyond that, or while a task is wrapping up, the bot asks you to send the message again shortly. In a direct message, a second message joins the running task. To make every message wait instead of joining, turn off busy follow-ups for that project in the console. `!skip` drops the current task and continues with the queue.
- **Notice language.** Each conversation has its own setting, Chinese or English, for what SintBot itself says there: notices, command replies, status and errors. It does not change the model's answers. Slack conversations are in English by default, whatever the language of the setup page or the console. To switch one to Chinese, or back, open the conversation's card under **Groups · Projects** in the console, expand **More settings** and pick **Notice language**. It applies from the next message, also while a task is running, and the conversation continues as before.

Keep your Mac awake and the SintBot service running. Closing the window does not stop the service.

## Not available yet

- Sending files or images from the task into Slack. The answer names the file's path in the project instead.
- Progress text while a task runs. You see the status and the final answer.
- Canvas, scheduled tasks and reading channel history.

## Troubleshooting

| What you see | What to do |
|---|---|
| "You pasted the bot token…" or another token kind | Paste each token in its own field: `xapp-` first, `xoxb-` second. |
| The app-level token is refused | Generate a new one under **Basic Information → App-Level Tokens** with `connections:write`. |
| "The two tokens belong to different Slack apps" | Copy both tokens from the same app's settings. |
| "Could not reach Slack" | Check the network. If this Mac reaches Slack through a proxy (for example on mainland-China networks), enter it under **Proxy** in the Slack step of the setup page and try again. For an installation already in use, set the `proxy` block in the configuration (such as `{"https": "http://127.0.0.1:7890"}`) and restart the service; it applies to both the checks and the connection. |
| The app is missing scopes | Create the app again from the link, or add the scopes on the app's **App Manifest** page and click **Reinstall to Workspace**. |
| Waiting for a message times out | Send the bot a direct message, or invite it to the channel before you @mention it, then retry. |
| The bot does not answer in a channel | @mention it, and check it has been invited (`/invite @your-bot-name`). |
| After binding a channel the console says the bot is not in it, or a reply fails with "channel not found" | Send `/invite @your-bot-name` in that channel. Slack reports a private channel without the bot as not found; after the app is reinstalled the bot has left its channels and must be invited again. |
| The console shows the Slack connection as failed | A token was revoked or the app was removed (shown within about 5 minutes). Connect again with new tokens. |
| The Slack connection is yellow: "Another machine may be using the same Slack app" | Another Mac (or another SintBot) is connected with this app, and Slack hands each message to only one of them. Stop it there, or create a separate app for that Mac. The warning clears by itself within about 15 minutes. |

## Create the app by hand

If the link does not open, go to [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, pick the workspace and paste [`slack-app-manifest.yaml`](../slack-app-manifest.yaml). Continue from step 2. This manifest does not declare a Slack Agent; if you do want one, remove the `# ` in front of the three lines named at the top of the file (see step 1 for what it does and what cannot be undone).

Do not turn on token rotation for the app: it cannot be turned off again, and the bot token would then expire every 12 hours.

How the adapter works and the Slack platform facts behind it: [SLACK.md](../SLACK.md).
