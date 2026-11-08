# Install SintBot 1.3.0

English · [简体中文](./zh-CN/install.md)

This release supports macOS, Node.js 22+, one Feishu group and Codex message turns. It runs in the foreground. Multiple groups, other chat platforms or model routes, the console, automatic service setup, scheduled tasks, terminal chat and whiteboards are not supported in 1.3.0.

## 1. Prepare the Mac

Use a terminal on the Mac where the project lives. Confirm Node.js 22+ and a working, authenticated Codex installation. Keep the existing Codex installation and account data. The SintBot installer does not install or log in to Codex and does not install Node.

```bash
node --version
codex --version
```

If this Mac already runs SintBot, leave it running its current package and configuration. A separate package prefix is safe to install, but **1.3.0 does not automatically migrate existing state**. Its initialization refuses existing state, old receipts or an existing journal. Do not delete these files to bypass that check. Do not connect two processes to the same Feishu application.

## 2. Install into a separate directory

Download and inspect the installer, then run the same file:

```bash
curl -fsSL https://sintbot.com/install.sh -o /tmp/sintbot-install.sh
bash /tmp/sintbot-install.sh --dry-run
bash /tmp/sintbot-install.sh
```

It installs **sintbot@1.3.0** into `~/.local/share/sintbot/releases/1.3.0`, checks the actual executable, binary core and Feishu module, and leaves global packages, shell profiles, configuration and services untouched. It refuses an existing target directory. Use `--prefix /new/absolute/directory` for a different location. `--dry-run` makes no changes and does not fetch a package.

Keep using the exact executable, so an older global command cannot be selected accidentally:

```bash
SINTBOT="$HOME/.local/share/sintbot/releases/1.3.0/bin/sintbot"
"$SINTBOT" --version
"$SINTBOT" help
```

The expected version is `1.3.0`. Installing the package does not start a bot.

## 3. Configure one Feishu group

Create a Feishu enterprise custom application on `open.feishu.cn`, enable its bot, grant message reception and reply permissions, choose long-connection event delivery, subscribe to message reception, publish the application and add its bot to your test group. Obtain that group's `oc_…` chat ID from Feishu. Use the China Feishu platform; international Lark is not supported.

Enter the app ID and app secret locally as `FEISHU_APP_ID` and `FEISHU_APP_SECRET` environment variables in the terminal that will start SintBot. Do not paste the secret into chat or commit it to your repository. Environment references are resolved at startup; both values must be present in each new terminal session.

Create the private configuration directory with `mkdir -p ~/.sbot && chmod 700 ~/.sbot`, then create `~/.sbot/config-1.3.0.json` with the following content. Replace the group ID and project path with actual values. The project must already exist. Keep exactly one group and the two explicit `false` flags.

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

Keep the configuration private (`chmod 600 ~/.sbot/config-1.3.0.json`). This example begins read-only and receives ordinary messages in this one group; use a dedicated test group. To require mentions instead, set `onlyWhenMentioned: true` and supply the actual app-specific `botOpenId`; startup rejects a missing bot ID. Do not add console, other-platform, scheduled-task or whiteboard settings from an older example. The full historical configuration schema is not the supported 1.3.0 setup.

## 4. Initialize and start

For a **new installation only**:

```bash
"$SINTBOT" init --config "$HOME/.sbot/config-1.3.0.json"
"$SINTBOT" start --config "$HOME/.sbot/config-1.3.0.json" --preflight
"$SINTBOT" start --config "$HOME/.sbot/config-1.3.0.json"
```

`init` creates a new persistent receipt journal at `~/.sbot/c2-v2.log`; it never resets an existing journal or migrates old state. Run it once. `--preflight` checks local configuration and assembly without starting the Feishu connection; it does not prove authentication or message delivery. `start` holds the single-writer lock and connects the configured group. Keep that terminal open.

Send a message in the group and request the first line of the project's README. Check the returned line against the file. Press Ctrl-C and wait for the process to exit, then run the same `start` command again. Do not rerun `init` for normal restarts.

## Stop, failure and upgrades

- Stop with Ctrl-C and wait for shutdown. This version does not provide automatic login startup or a service-install command.
- If a request fails or startup reports unresolved receipts, preserve the journal and state. Verify what happened before retrying. Do not clear unknown effects, overwrite the journal or run the same task again blindly.
- The installer never replaces an earlier package. A version change still requires draining the old process, preserving configuration/state and checking receipt compatibility. A spare executable alone is not a safe rollback of state.
- Existing multi-group installations remain on their previous release. A reviewed migration is required before replacing them with this single-group route.

See the [AI-assisted guide](./AI-ASSISTED-INSTALL.md) if an assistant is performing the local steps.
