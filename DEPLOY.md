# agents.sera.cx — Deploy Guide

End-to-end instructions for standing up the `agents.sera.cx` stack on a single VM. Intended for the person owning the VM + DNS.

The stack is three containers in one Docker Compose project, fronted by Caddy:

```
internet ─► Caddy (80/443, TLS) ─┬─► static     (nginx, landing page + /docs/*)
                                 └─► gateway    (Hono + sera-mcp, the agent endpoints)
```

`docker-compose.yml` and `agents-gateway/deploy/Caddyfile` are the source of truth.

---

## Prerequisites on the VM

- **Docker Engine** ≥ 24 (`docker --version`) and **Compose v2** (`docker compose version`)
- **Ports 80 + 443** reachable from the internet (Caddy needs both for the Let's Encrypt HTTP-01 challenge; HTTP/3 also uses 443/udp)
- **Outbound HTTPS** to `ghcr.io` (image pull), `acme-v02.api.letsencrypt.org` (TLS), and `api.sera.cx` (gateway upstream)
- A user in the `docker` group (so `docker compose …` doesn't need sudo)

The VM does **not** need Node, sera-mcp, or any build tooling. Everything runs inside the published image.

---

## DNS

Two records on `sera.cx`:

| Type | Name | Value |
|---|---|---|
| `A` (or `CNAME`) | `agents` | the VM's public IP / hostname |
| `TXT` | `_agent` | `v=agent1; endpoint=https://agents.sera.cx/mcp; openapi=https://agents.sera.cx/openapi.json; card=https://sera.cx/.well-known/agent.json` |

The `TXT` record is from [agents-handoff.md §4](../Sera%20v1%20Mainnet/agents-handoff.md) — it lets agent directories and LLM tool registries discover Sera via DNS lookup without crawling.

Verify after propagation:

```bash
dig +short A agents.sera.cx
dig +short TXT _agent.sera.cx
```

---

## First-time setup on the VM

```bash
# 1. Clone the repo
git clone git@github.com:sera-cx/sera-agents.git
cd sera-agents

# 2. Authenticate to GHCR (so docker can pull the published gateway image).
#    Use a Personal Access Token (classic) with the `read:packages` scope.
echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-username> --password-stdin

# 3. Create the .env file (see "Environment" below for the full list).
cat > .env <<'EOF'
SERA_NETWORK=mainnet
# Optional — leave unset to run keyless.
# SERA_API_KEY=…
# SERA_API_SECRET=…
EOF

# 4. Bring the stack up. First boot pulls the gateway image from GHCR, builds the
#    static container locally, and lets Caddy provision TLS automatically.
docker compose up -d

# 5. Watch the logs until Caddy reports TLS is ready (~30s on first boot):
docker compose logs -f caddy
```

When you see `certificate obtained successfully` for `agents.sera.cx`, you're live.

---

## Environment

All env vars are read from `.env` next to `docker-compose.yml`. None are required by Compose itself — the gateway runs keyless by default — but you'll typically set at least `SERA_NETWORK`.

| Var | Default | Notes |
|---|---|---|
| `SERA_NETWORK` | `mainnet` | `mainnet` or `sepolia` |
| `SERA_API_KEY` | _(unset)_ | Optional. Set to opt in to Sera's account-level quota; without it the four public tools work keyless. |
| `SERA_API_SECRET` | _(unset)_ | Paired with `SERA_API_KEY` |
| `GATEWAY_IMAGE_TAG` | `latest` | Pin to a specific image tag for reproducible rollouts (e.g. `sha-7848d1e…`) |

Edit `.env` then `docker compose up -d` to apply.

---

## Smoke tests

After `docker compose up -d` and TLS provisioning, run these from anywhere with internet:

```bash
# Liveness — gateway up
curl -fsS https://agents.sera.cx/health
# {"status":"ok","mcp_running":true}

# OpenAPI doc — confirms the gateway routes
curl -fsS https://agents.sera.cx/openapi.json | head

# A real upstream call — proves sera-mcp is wired
curl -fsS 'https://agents.sera.cx/rates?pairs=USDC/EURC' | head

# Static landing page still served
curl -fsS https://agents.sera.cx/ | head -5
```

If any of those fail, see Troubleshooting below.

---

## Rolling updates (push-to-main flow)

Every push to `main` that touches gateway code triggers [`.github/workflows/publish-gateway.yml`](.github/workflows/publish-gateway.yml), which builds and pushes a fresh image to `ghcr.io/sera-cx/sera-agents-gateway` with three tags: `latest`, the 7-char short SHA, and the full SHA.

To roll a new gateway image onto the VM:

```bash
cd /path/to/sera-agents
git pull
docker compose pull gateway   # fetches :latest (or whatever GATEWAY_IMAGE_TAG points at)
docker compose up -d gateway  # replaces only the gateway container; Caddy + static keep running
```

To roll a static-page change:

```bash
git pull
docker compose up -d --build static
```

To roll a Caddyfile change:

```bash
git pull
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

(No restart needed for Caddy reloads.)

### Optional — automate with a cron or systemd timer

If you want auto-rollout on every push to main, drop this into root's crontab on the VM:

```cron
*/5 * * * * cd /path/to/sera-agents && git pull --ff-only && docker compose pull gateway && docker compose up -d gateway >/dev/null 2>&1
```

Or wire a GitHub Action that SSHes to the VM and runs the same three commands after `publish-gateway.yml` succeeds — both work; the cron version has zero secrets to manage.

---

## Optional hardening — per-IP rate limit at Caddy

The default Caddyfile relies on the gateway's honest 429+`Retry-After` to back off bad actors. To also brake at the proxy edge, rebuild Caddy with the `caddy-ratelimit` plugin and drop in the template at the bottom of `agents-gateway/deploy/Caddyfile`:

```bash
# On the VM, build a custom caddy image
docker build -t caddy-with-ratelimit:2 - <<'EOF'
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit
FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
EOF
```

Then change `docker-compose.yml`:

```yaml
  caddy:
    image: caddy-with-ratelimit:2   # instead of caddy:2-alpine
```

And uncomment the `rate_limit { … }` block in the Caddyfile.

Not a launch blocker — the gateway is honest about throttles either way.

---

## Troubleshooting

### `docker compose up` errors before the gateway starts
- `ghcr.io/sera-cx/sera-agents-gateway:latest manifest unknown` → check the [publish workflow runs](https://github.com/sera-cx/sera-agents/actions/workflows/publish-gateway.yml); the image is only pushed when gateway code changes
- `unauthorized` from GHCR → re-run `docker login ghcr.io` with a PAT carrying `read:packages`

### Caddy can't get a TLS cert
- Confirm DNS `A` record points at the VM and ports 80/443 are reachable: `curl -fsS http://agents.sera.cx/health` (HTTP, not HTTPS — this proves Caddy got the request before TLS provisions)
- Check firewall / cloud security group allows inbound `80` and `443`
- Watch `docker compose logs caddy` — Let's Encrypt logs the exact ACME failure

### `/health` returns 200 but `/rates` returns 502
- The gateway is up but sera-mcp subprocess is unhappy. Check `docker compose logs gateway | grep sera-mcp`.
- Most likely: `SERA_NETWORK` is misspelled, or the VM can't reach `api.sera.cx`.

### `429` responses from `/rates` or `/quote`
- That's by design — Sera throttled the upstream and the gateway is passing it through honestly. The response includes a `Retry-After` header. If you set `SERA_API_KEY`, Sera's account-level quota applies; without one, it's a shared IP-level bucket.

### Gateway restarts in a loop
- `docker compose logs gateway` will show the crash. Most common cause: `SERA_MCP_PATH` env var missing — but the image bakes that in at `/opt/sera-mcp/dist/index.js`, so it should only happen if you've overridden the var in `.env`.

---

## Checklist for shipping

- [ ] DNS `A` record points at the VM
- [ ] DNS `TXT` record at `_agent.sera.cx` matches handoff §4
- [ ] Ports 80 + 443 open inbound (and 443/udp for HTTP/3, optional)
- [ ] VM authenticated to GHCR (`docker login` succeeded)
- [ ] `.env` created with at least `SERA_NETWORK=mainnet`
- [ ] `docker compose up -d` ran clean
- [ ] All four smoke tests pass

When all six boxes are checked, agents.sera.cx is live and discoverable.

---

*Questions: partnerships@sera.cx*
