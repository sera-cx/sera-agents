# Contributing to sera-agents

Thanks for taking the time. This is the agent suite around the [Sera MCP](https://github.com/Josh-sera/sera-mcp) — landing page, templates, bundled CLI agent, x402 service, integration docs.

## What kind of contributions help

- **Host integrations.** Add a `integrations/<host>/` folder with config + README for a host we don't yet cover.
- **New templates.** Starter scaffolds for shapes we don't ship — Slack bot, Discord bot, scheduled cron worker, browser extension, mobile app backend, anything.
- **Reference flows.** A small runnable agent in `examples/<name>/` that demonstrates a real workflow.
- **x402 service hardening.** Real EIP-3009 verification, facilitator integration, rate limiting, persistent payment-id store.
- **Landing page polish.** Better mobile UX, animations, accessibility improvements.
- **Documentation.** Anything that makes any of the four paths easier to use.

## Project shape

```
sera-agents/
├── index.html              Landing page (single-file static)
├── README.md
├── PLAN.md                 Active delivery plan
├── LAUNCH.md               Public + internal launch copy
├── sera-agent/             Path C — bundled CLI
├── templates/              Path B — starter templates
├── x402-service/           Path D — protocol-level service
├── integrations/           Per-host integration docs + configs
└── examples/               Reference flows (programmatic agents)
```

## Getting set up

```bash
git clone https://github.com/Josh-sera/sera-agents
cd sera-agents

# Pick whichever piece you're working on
cd sera-agent && npm install        # or templates/web-chat, x402-service, etc.
```

The MCP server is a separate repo. To work end-to-end you'll need it built locally:

```bash
git clone https://github.com/Josh-sera/sera-mcp ~/sera-mcp
cd ~/sera-mcp && npm install && npm run build
```

By default the agent code paths look for `~/Desktop/sera-mcp/dist/index.js`. Override with `SERA_MCP_DIST` env when running.

## Pull requests

- Keep PRs focused. One template, one integration, or one bug fix per PR.
- Update the top-level [`integrations/README.md`](integrations/README.md) host table when adding a host.
- Update [`README.md`](README.md) if you add a new top-level folder.
- Run `npm install` in any package you touched to confirm it still resolves cleanly.

## Adding a host integration

1. Create `integrations/<host-name>/`
2. Add `README.md` that walks through (a) install/build prerequisites, (b) the host's config file shape, (c) how to wire Sera, (d) verify command
3. Add an example config file (e.g. `<host-name>.example.json`) that's literally copy-pasteable
4. Update [`integrations/README.md`](integrations/README.md) host table
5. Optionally add a card to the landing page's Hosts section in `index.html`

## Adding a template

1. Create `templates/<template-name>/`
2. Include: `agent.ts` (or `server.ts`), `package.json`, `README.md`
3. Use the same OpenAI Agents SDK + MCPServerStdio pattern as the existing templates (or document why you chose differently)
4. Add to [`templates/README.md`](templates/README.md) and the Path B section in `index.html`

## License

By contributing, you agree your contributions are licensed under MIT.
