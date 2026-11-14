# Connect WeCom

English · [简体中文](../zh-CN/platforms/wecom.md)

Use a WeCom smart bot in **API mode with a long connection**. Tasks run on your Mac, without a public callback URL. An ordinary group webhook bot cannot receive tasks.

## 1. Create a bot

In the WeCom desktop client, open **Workbench → Smart Bots → Create → Manual creation**. Select **API mode**, then **Long connection**. Keep the Bot ID and Secret. Your organization controls permission to create bots; if the entry is missing, check the client version and ask your administrator about access.

Use one SintBot instance per bot. Create a separate bot for testing so that it does not replace an existing connection.

## 2. Connect in SintBot

On first launch, select a project and executor, choose **WeCom** under **Chat platform**, enter the Bot ID and Secret, and click **Connect WeCom**.

For an existing installation, open **Settings → Add WeCom** in the console. Enter the credentials, an existing project folder and an executor, then connect and bind the project. Existing Feishu connections, projects and history are preserved. Enter credentials locally; never send the secret to a group.

## 3. Bind a group and send a task

Create or choose an internal WeCom group and add the bot. While SintBot is waiting for a group message, @mention the bot with “connect”. SintBot discovers the group and binds the selected project; you do not need to copy a group ID. The first message binds the group. After completion, @mention the bot again with a task such as “Read the first line of README and reply with only that line”.

Keep your Mac online and the SintBot service running. Closing the window and stopping the service are different actions.

## Everyday use

- @mention the bot for group tasks, including messages with images or files.
- Ask it to send project files or images to the current group. No separate WeCom CLI is required.
- Outbound files are limited to 50 MiB; WeCom may impose additional limits for specific media types.
- Use `/help`, `/status` and `/stop` while @mentioning the bot.
- History queries, message editing/recall and reactions are not connected. Use `/stop` rather than recalling a message to stop a task.

## Troubleshooting

Check API long-connection mode, credentials and whether another instance owns the bot. If waiting times out, add the bot to the intended group and @mention it during a new connection attempt. Cancel or retry a failed attempt. If configuration was saved but the connection did not start, check connection status and restart the App service if needed. Never automatically resend an unconfirmed send.

Reference: [Tencent connection guide](https://intl.cloud.tencent.com/zh/document/product/1316/84454).
