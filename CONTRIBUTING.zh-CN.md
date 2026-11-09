# 参与开发

[English](./CONTRIBUTING.md) · 简体中文

本仓包含 SintBot 1.4.4 的平台集成、文档及带内置核心的运行产物。本版支持 macOS、1–32 个飞书群、每群选用 Codex 或 Claude Code、群内命令与本机控制台。

## 验证修改

使用 macOS 和 Node.js 22 及以上：

```bash
npm ci --ignore-scripts
node --test tests/public-release-smoke.test.js
node bin/sintbot-v2.js help
```

公开烟测验证真实入口、二进制加载和缺少核心时拒绝运行，不连接飞书或启动模型。修改已支持行为时，补充宿主的定向测试，不带凭据或生产数据。授权群测试按[安装指南](./docs/zh-CN/install.md)执行；包加载成功不等于消息送达通过。

## 边界

- 决策使用内置核心，不增加兜底、不导入旧版本引擎绕过失败。
- 保留收据与状态安全，不静默清空未知效果，不重放结果不明的模型派发。
- 修改集中在受支持宿主和集成范围；未支持平台、模型通道或命令须继续拒绝，直至独立实现并验收。
- 双语文档同步，改入口接线后实际启动进程验证。
- 贡献中不包含密钥、生产日志、私有路径、测试账号或个人信息。

贡献适用随仓 [LICENSE](./LICENSE)。安全问题按 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md) 私密报告，不发公开 issue。
