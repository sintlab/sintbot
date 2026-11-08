# SintBot public release workspace

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before changing this repository. The supported 1.3.0 route is macOS, one Feishu group and Codex. This tree contains the integration code, documentation and runtime artifacts for the built-in-core release.

Preserve unrelated work. Never replace the binary with a JavaScript decision fallback. Read [docs/install.md](./docs/install.md) for initialization and foreground startup; do not revive the old console, setup or service-install instructions. Keep English and Chinese documentation aligned. Run `node --test tests/public-release-smoke.test.js` after installing dependencies, and verify actual entry startup when changing its wiring.
