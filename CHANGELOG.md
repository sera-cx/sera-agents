# Changelog

All notable changes to `sera-agents` are documented in this file.

## [0.5.1] — 2026-05-24

### Fixed
- **CI now uses `npm ci`** (lockfile-reproducible) instead of `npm install` (which mutates the lockfile). Previous CI could pass on a PR that would fail after merge if any sub-dep version float was triggered by `install` rewrites.

### Added
- Root `npm run build` (`--workspaces --if-present`) and `npm run test` (`--workspaces --if-present`) scripts.
- Root `npm run ci` aggregator: `npm ci && typecheck && build && test && audit` — one command for the full quality gate locally.
- CI workflow now runs `npm test` step (no-op until packages add test scripts in v0.6.0).

## [0.5.0] — 2026-05-24

### Added
- `ARCHITECTURE.md` — repo layout, workspace structure, per-path framing, x402 state machine, dependency contract with `sera-mcp`.
- `SECURITY-MODEL.md` — per-package threat model framing, x402 attack surface (mapped against arXiv:2605.11781 "Five Attacks on x402"), template hardening expectations, hardening checklist for x402 live mode.
- `CHANGELOG.md` (this file).
- Root `package.json` with `npm` workspaces declaring all 7 packages (`sera-agent`, `x402-service`, `templates/*`, `examples/*`).
- Root `tsconfig.base.json` — shared TS config extended by each package's `tsconfig.json`.
- Per-package `tsconfig.json` + `typecheck` script + `audit` script in all 7 packages.
- Root `npm run typecheck`, `npm run audit`, `npm run check` for workspace-wide quality gates.
- README **Status** section with Stable / Demo / Experimental / Planned labels.
- README **Development** section with workspace commands.

### Changed
- CI workflow rewritten: now runs `npm run typecheck` (was missing entirely — only `npm audit` ran), then audit + gitleaks + CodeQL. Single workspace install instead of per-package matrix.
- Root `overrides` block forces `qs ^6.15.2` and `ws ^8.21.0` across the dependency tree.
- README positioning paragraph at top — explicit "Templates, examples, docs, and x402 integrations built on top of [`sera-mcp`](https://github.com/Josh-sera/sera-mcp)".
- README references `sera-mcp` via GitHub URL instead of local Desktop path.

### Fixed
- Audit: 0 vulnerabilities across all workspaces (was 1 moderate `qs` per package).
- Path A install snippet now `git clone`s `sera-mcp` instead of referencing local `~/Desktop` path.

### Notes
- Folder reorg (move x402-service into `services/`, site into `site/`) deferred — would break GitHub Pages deploy without coordinated `CNAME` + Pages config changes.
- `x402-service` live mode remains intentional scaffold. See `SECURITY-MODEL.md` for the hardening checklist required before flipping to production.

## [0.4.0] — 2026-05-13/17

- Full `/docs` section with tutorials (AI agent, cross-border payment widget, FX trading dashboard, prediction market, treasury rebalancer, x402 paid API).
- Architecture, concepts, recipes pages.
- API reference page.
- Branding pass: logo, favicons, OG image, sitemap.
- DNS to Cloudflare; live at agents.sera.cx.

## [0.3.0]

- 12-card "Build with Sera" carousel on landing page.
- 6 tutorial templates.
- Integration guides for OpenClaw, Hermes, NanoClaw, standard MCP hosts.

## [0.2.0]

- First public-facing release. Landing page, MCP integration guides, three templates, x402-service demo.

## [0.1.0]

- Initial commit. Templates + examples.
