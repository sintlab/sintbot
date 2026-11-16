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

## 2. Paste the app-level token

After creating the app you land on its **Basic Information** page. Scroll to **App-Level Tokens**, click **Generate Token and Scopes**, give it any name, add the `connections:write` scope and click **Generate**. Copy the token that starts with `xapp-` and paste it into SintBot. The app settings page can take ten seconds or more to load the first time; reload it if it stays blank.

SintBot checks the token as soon as you paste it and tells you if you pasted a different kind of token.

## 3. Install the app and paste the bot token

Click **Open install page** in SintBot, then in Slack click the install button named after your workspace (for example **Install to Acme**) and **Allow**. Copy the **Bot User OAuth Token** that starts with `xoxb-` and paste it into SintBot.

Click **Connect Slack** (or **Connect and bind project** in the console). SintBot checks that both tokens belong to the same app and that the app has the permissions it needs.

Both tokens are saved only on this Mac, in the configuration file that only your account can read. Never post them in a chat.

## 4. Send the first message

When SintBot shows **Waiting for your message**, click **Open the bot in Slack** and send it any message. That conversation is now bound to the project you chose, and the bot replies that the project is connected.

To bind a channel instead, invite the bot first with `/invite @your-bot-name`, then @mention it there. The first message only binds; send your task after the reply.

A first task to try: "Read the first line of the project README and reply with only that line."

## Add another channel

Each conversation is bound to one project folder. To bind another channel, invite the bot with `/invite @your-bot-name`, then in the console open **Groups · Projects → Set up a group project**, choose Slack and pick the channel. Only channels the bot has joined are listed.

## Everyday use

- **Direct message:** every message is a task. The answer arrives in the conversation itself.
- **Channel:** only messages that @mention the bot are tasks. The answer arrives in a thread under your message; to follow up, @mention the bot again in that thread.
- **Commands start with `!`.** Slack keeps `/` for its own slash commands, so type `!status`, `!stop`, `!skip`, `!new`, `!model` or `!help`. In a channel, @mention the bot with the command. `/sint stop` and the other commands also work through the `/sint` slash command, outside threads.
- **While a task runs**, your message shows ⏳ and, in a channel, the thread also shows a **Stop** button that stops the task. When the answer arrives, ⏳ becomes ✅.
- **Images and files** you send with a task are saved on your Mac and handed to the task. Files larger than 30 MB are not downloaded.
- **Deleting your message** cancels it: a waiting message is dropped, and a running task stops.
- **Long answers** arrive as several consecutive messages.
- **A second message while a task runs** (@mention the bot in a channel) joins that task once the model reads it; it gets ⏳ too, and the answer arrives in the first message's thread. To queue it separately instead, turn off busy follow-ups for that project in the console: the thread then says it is queued and messages run in order. `!skip` drops the current task and continues with the queue.

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
| "Could not reach Slack" | Check the network. If this Mac reaches Slack through a proxy, set the `proxy` block in the configuration; it applies to both the checks and the connection. |
| The app is missing scopes | Create the app again from the link, or add the scopes on the app's **App Manifest** page and click **Reinstall to Workspace**. |
| Waiting for a message times out | Send the bot a direct message, or invite it to the channel before you @mention it, then retry. |
| The bot does not answer in a channel | @mention it, and check it has been invited (`/invite @your-bot-name`). |
| The console shows the Slack connection as failed | A token was revoked or the app was removed (shown within about 5 minutes). Connect again with new tokens. |

## Create the app by hand

If the link does not open, go to [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, pick the workspace and paste [`slack-app-manifest.yaml`](../slack-app-manifest.yaml). Continue from step 2.

Do not turn on token rotation for the app: it cannot be turned off again, and the bot token would then expire every 12 hours.

How the adapter works and the Slack platform facts behind it: [SLACK.md](../SLACK.md).
