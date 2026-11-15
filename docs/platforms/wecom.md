# Connect WeCom

English · [简体中文](../zh-CN/platforms/wecom.md)

Use a WeCom smart bot in **API mode with a long connection**. Tasks run on your Mac, without a public callback URL. An ordinary group webhook bot cannot receive tasks.

Before you start, install WeCom on your phone and join or create an organization. Creating one is free and needs no verification. You do not need a group: an organization with only you in it works through a one-to-one chat with the bot.

## 1. Scan to create a bot

On first launch, select a project and executor, choose **WeCom** under **Chat platform**, and click **Scan to create bot**. Scan the code with WeCom on your phone and confirm. The bot is created automatically and is named after you by default. Its Bot ID and Secret are saved on this Mac automatically; you do not need to copy them.

For an existing installation, open **Settings → WeCom** in the console, choose the project folder and executor, and select **Scan to create bot**. The flow is the same; once connected, the card shows the connection status and bound projects, with the Bot ID under Advanced. Existing Feishu connections, projects and history are preserved.

Use one SintBot instance per bot. Create a separate bot for testing so that it does not replace an existing connection. Credentials stay on this Mac; never send them to a group.

### Already have a bot?

Expand **Already have a bot? Enter Bot ID and Secret manually** and enter the bot's credentials. To create a bot manually, use either entry and select **API mode**, then **Use long connection**:

- WeCom desktop client: **Workbench → Smart Bots → Create bot → Manual creation**.
- Admin console at work.weixin.qq.com: **Security & Management → Management Tools → Smart Bots**.

Your organization controls permission to create bots; if the entry is missing, check the client version and ask your administrator about access. After entering the credentials, finish with the message in step 2.

## 2. Send one message to connect

**Within 10 minutes**, send the bot any message in WeCom: in a one-to-one chat, just send it; in a group, add the bot and @mention it. To find the bot, search for its name at the top of WeCom or open **Workbench → Smart Bots**.

The bot replies that the project is connected (“已连接项目 …”). You can then send tasks directly, such as “Read the first line of README and reply with only that line”.

Keep your Mac online and the SintBot service running. Closing the window and stopping the service are different actions.

## Everyday use

- In a one-to-one chat, send tasks without @mentioning the bot. In a group, @mention the bot for every task and command; @All does not trigger it.
- The bot replies when a task finishes; progress is not shown while it runs.
- In a one-to-one chat, send files and images directly. In groups, the bot receives only text and mixed text-and-image messages: send images together with text, and put files in the project folder first or send them in the one-to-one chat.
- Ask it to send project files or images back to the current conversation; file size is subject to WeCom limits. No separate WeCom CLI is required.
- Use `/help`, `/status` and `/stop`; in a group, @mention the bot with each command. Recalling a message does not stop a task; use `/stop`.
- Group history queries, message editing, recall and reactions are not available.

## Troubleshooting

- If scan-to-create fails, retry or expand the manual option and enter an existing bot's credentials.
- If no message arrives within 10 minutes, start a new connection attempt and send the bot a message while setup is waiting.
- Check API long-connection mode, credentials and whether another instance owns the bot.
- If configuration was saved but the connection did not start, check connection status in the console and restart the App service if needed.
- Never automatically resend an unconfirmed send; the conversation could receive duplicate content.

Reference: [WeCom long-connection documentation](https://developer.work.weixin.qq.com/document/path/101463) · [Tencent connection guide](https://intl.cloud.tencent.com/zh/document/product/1316/84454).
