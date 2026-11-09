# 安全策略

[English](./SECURITY.md) · 简体中文

不要在公开 issue 中报告安全漏洞。请用 GitHub 的 [私密漏洞报告](https://github.com/sintlab/sintbot/security/advisories/new)，或发邮件到 support@sintbot.com。说明影响版本、复现步骤和影响面，不附密钥或私有项目数据。

1.4.5 关注的范围包括：绕过已配置的 Codex 或 Claude Code 权限、把任务路由到错误的群或项目、控制台超出已配置的访问范围、回复泄漏凭据、接受不匹配二进制，以及重放外部结果未知的效果。完全访问权限本来就允许修改文件和执行命令，不等于限制在项目目录内。

本版支持 macOS、1–32 个飞书群、每群选用 Codex 或 Claude Code，采用前台启动，可选本机控制台；自动后台服务不在支持范围。调查失败时保留已有收据，操作见[安装与恢复指南](./docs/zh-CN/install.md)。
