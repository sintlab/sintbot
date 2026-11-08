# Install SintBot 1.3.0 with an AI assistant

English · [简体中文](./zh-CN/AI-ASSISTED-INSTALL.md)

Use the terminal on the Mac that will run SintBot. A cloud shell cannot install it on the user's Mac. Follow the [installation guide](./install.md); its supported route is one Feishu group, Codex and a foreground process.

1. Check macOS, Node 22+, the actual Codex executable/login and any existing SintBot process. Do not print credentials. Preserve existing installations, configuration and state.
2. Download and inspect the installer, run its `--dry-run`, then install the exact package into a new prefix. Continue within the user's authorization; ask only for missing decisions. The installer does not change Node, Codex, shell profiles or services.
3. Use the executable under that prefix and verify it reports `1.3.0`. Do not substitute a globally installed command. A successful package install is not a successful group test.
4. Prepare the single-group configuration in the install guide. Let the user enter secrets locally or use already authorized credential references without revealing them. Use an existing authorized Feishu app only when another process is not connected to it. If app setup or login requires the user, finish other independent preparation first.
5. For fresh state only, run `init`, then `start --preflight`. Refusal due to old state or unresolved receipts is a stop condition: never delete files, fabricate a new authority or alter receipts to bypass it.
6. Run the foreground service, send an authorized read-only group request and compare its response with the file. Stop cleanly and verify a restart. If no person is available, use an authorized test account to send the request; document the sender and do not call it independent human acceptance. A bot's own API message may be ignored and is not a substitute for an incoming user message.
7. Stop temporary processes before ending the task. Report what was installed, what actually ran and any remaining setup. Do not register an automatic background service for this release.

## Copyable request

```text
Install SintBot 1.3.0 on this Mac using the versioned, isolated installation guide. Preserve existing services, configuration, state and Codex account data. Do not expose credentials. Verify the actual installed executable and binary core, configure one Feishu group for Codex, and initialize only clean new state. Run the foreground preflight and an authorized read-only group test, check the result, then verify clean stop/restart. Do not use the old setup, console or service-install flow. Stop temporary processes when finished, and distinguish package installation from successful group acceptance.
```
