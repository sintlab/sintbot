# Security policy

English · [简体中文](./SECURITY.zh-CN.md)

Do not report security issues in public issues. Use GitHub's [private vulnerability reporting](https://github.com/sintlab/sintbot/security/advisories/new), or email support@sintbot.com. Include the affected version, reproduction steps and the impact; omit credentials and private project data.

For 1.4.7, relevant issues include bypassing the configured Codex or Claude Code permission level, sending work to the wrong bound group/project, exposing the console beyond its configured access, leaking credentials in replies, accepting a mismatched binary, or replaying an uncertain external effect. Full access deliberately permits file changes and command execution; do not treat it as project-directory confinement.

The supported route is macOS, 1–32 Feishu groups with Codex or Claude Code, and foreground startup with the optional local console. Automatic service installation is outside this version's supported scope. Preserve existing receipts when investigating a failure. See the [installation and recovery guide](./docs/install.md).
