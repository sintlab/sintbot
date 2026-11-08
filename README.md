# SintBot

[简体中文](./README.zh-CN.md) · [Install](./docs/install.md) · [Website](https://sintbot.com)

SintBot runs a coding agent on your Mac from a Feishu group. Bind **one group to one local project**, send a request, and receive progress and the final reply in that group.

## Version 1.3.0

This first built-in-core release supports **macOS, Node.js 22 or newer, one Feishu group and Codex message turns**. You need a working local Codex installation and login, plus a Feishu custom app. Model usage follows your Codex account's terms and limits.

The application runs in the foreground. Keep its terminal open; stop it with Ctrl-C and wait for shutdown to finish. This release does not install an automatic background service.

Multiple groups, Claude and other model routes, Slack, WeCom, international Lark, the management console, scheduled tasks, terminal chat, busy-turn steering and whiteboards are outside this release's supported scope. Existing installations using those features should keep their current version. Support will expand in subsequent releases.

## Install and connect

Follow the [installation guide](./docs/install.md) to install the exact version into a separate directory, configure one group, initialize a new receipt journal and start the bot. The installer leaves existing installations and services in place.

```bash
curl -fsSL https://sintbot.com/install.sh -o /tmp/sintbot-install.sh
bash /tmp/sintbot-install.sh --dry-run
bash /tmp/sintbot-install.sh
```

The installer installs the package only. It does not authenticate Codex, collect credentials, connect the group or start a service. An [AI-assisted installation guide](./docs/AI-ASSISTED-INSTALL.md) covers the same steps.

## First task

Start with a read-only request in your configured group, for example: “Read the first line of this project's README and reply with that line.” Check the answer against the local file, stop the foreground process cleanly, then start it again. A successful package install alone does not verify the group connection or a model turn.

## Data and recovery

Project files, configuration and persistent receipts remain on your Mac. Feishu receives messages and replies, and Codex sends model input to its configured provider. Read-only is the recommended initial permission level; granting full access allows the agent to change files and execute commands.

If startup reports unresolved receipts or uncertain external effects, preserve the state and investigate. Do not delete the journal, clear receipts or resend the task merely to get past startup: the prior request may already have executed. Existing multi-group state is not automatically migrated by 1.3.0.

## License

SintBot is distributed under [PolyForm Shield 1.0.0](./LICENSE). The package includes a built-in core. Use of the software is covered by the included license. Dependency notices are in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

Author: **WaterTian**.
