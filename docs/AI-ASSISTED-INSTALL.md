# Install SintBot 1.4.19 with an AI assistant

English · [简体中文](./zh-CN/AI-ASSISTED-INSTALL.md)

Use the terminal on the Mac that will run SintBot. A cloud shell cannot install it on the user's Mac. Follow the [installation guide](./install.md); its supported route is 1–32 Feishu groups, Codex or Claude Code per group, and a foreground process.

1. Check macOS, Node 22+, the actual Codex or Claude Code executable and login, and any existing SintBot process. Do not print credentials. Preserve existing installations, configuration and state.
2. Run the one-line installation command in the guide; `--dry-run` is optional. Continue within the user's authorization; ask only for missing decisions. The installer does not change Node, Codex, Claude Code, shell profiles or services.
3. The installer verifies the version and core at `~/.local/share/sintbot/bin/sintbot`. A successful package install is not a successful group test.
4. Prefer the browser setup: `sintbot start --ui` opens the local setup page when no configuration exists; from the terminal `sintbot connect` does the same flow, printing the scan link and opening a local QR page; only the user can scan and confirm on the phone, after which it creates the project folder and group, writes the configuration and initializes, so no secret passes through the assistant. It refuses when a Feishu configuration exists or the service is running; do not delete files to get past that. If the scan is not possible, prepare the configuration by the manual route in the install guide: let the user enter secrets locally or use already authorized credential references without revealing them. Use an existing authorized Feishu app only when another process is not connected to it.
5. On the manual route, run `init` for fresh state only (never again after `connect` has initialized), then `start --preflight`. Refusal due to an existing journal or unresolved receipts is a stop condition: never delete files, fabricate a new authority or alter receipts to bypass it.
6. Run the foreground service, send an authorized read-only group request and compare its response with the file. Stop cleanly and verify a restart. If no person is available, use an authorized test account to send the request; document the sender and do not call it independent human acceptance. A bot's own API message may be ignored and is not a substitute for an incoming user message.
7. Stop temporary processes before ending the task. Report what was installed, what actually ran and any remaining setup. Do not register an automatic background service for this release.

## Copyable request

```text
Install SintBot 1.4.19 on this Mac using the one-line installation guide. Preserve existing services, configuration, state and Codex or Claude Code account data. Do not expose credentials. Verify the actual installed executable and binary core, configure the Feishu groups with their runners, and initialize only clean new state. Run the foreground preflight and an authorized read-only group test, check the result, then verify clean stop/restart. Stop temporary processes when finished, and distinguish package installation from successful group acceptance.
```
