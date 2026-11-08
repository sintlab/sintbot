# Contributing

English · [简体中文](./CONTRIBUTING.zh-CN.md)

This repository contains platform integration, documentation and runtime artifacts for SintBot 1.4.0 with its built-in core. The release supports macOS, 1–32 Feishu groups, Codex or Claude Code per group, chat commands and the local console.

## Check a change

Use macOS and Node.js 22 or newer:

```bash
npm ci --ignore-scripts
node --test tests/public-release-smoke.test.js
node bin/sintbot-v2.js help
```

The public smoke suite checks the actual entry, binary loading and rejection of a missing core. It does not contact Feishu or start a model. For changes to supported behavior, add focused host tests without credentials or production data. Follow the [installation guide](./docs/install.md) for an authorized group check; package loading alone does not prove message delivery.

## Boundaries

- Keep decisions in the built-in core. Do not add a fallback or import a previous release's engine to bypass a failure.
- Preserve receipt and state safety. Never silently reset uncertain effects or replay an unknown model dispatch.
- Keep changes to the supported host/integration scope. Unsupported platforms, model routes and commands must remain rejected until separately implemented and accepted.
- Keep English and Chinese documentation aligned, and verify actual process startup when changing entry wiring.
- Do not include secrets, production logs, private paths, test accounts or personal information in a contribution.

Contributions are covered by the included [LICENSE](./LICENSE). Report security issues using [SECURITY.md](./SECURITY.md), not a public issue.
