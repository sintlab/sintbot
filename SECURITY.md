# Security policy

English · [简体中文](./SECURITY.zh-CN.md)

Do not report security issues in public issues. Use GitHub's [private vulnerability reporting](https://github.com/sintlab/sintbot/security/advisories/new), or email support@sintbot.com. Include the affected version, reproduction steps and the impact; omit credentials and private project data.

For 1.3.0, relevant issues include bypassing the configured Codex permission level, sending work to the wrong bound group/project, leaking credentials in replies, accepting a mismatched binary, or replaying an uncertain external effect. Full access deliberately permits file changes and command execution; do not treat it as project-directory confinement.

The supported route is macOS, one Feishu group and Codex, with foreground startup. The console and automatic service installation are outside this version's supported scope. Preserve existing receipts when investigating a failure. See the [installation and recovery guide](./docs/install.md).
