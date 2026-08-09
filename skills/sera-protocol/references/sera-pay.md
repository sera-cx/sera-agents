# SeraPay Reference (sera-cx/sera-pay)

**Repo**: https://github.com/sera-cx/sera-pay
**What it is**: A merchant-facing stablecoin payment application — wallet-based merchant
sign-in, a dashboard for payment history/settings/menus/dev tools, branded QR payment links, and
a checkout flow with live FX rate display. Ships as one deployable app (React frontend + Express
API server behind a single origin).
**License**: MIT (the app itself) — distinct from the PolyForm Noncommercial license on
`orderbook-contract-v2`; don't conflate the two when talking about redistribution terms.

## Table of Contents
1. [Tech Stack](#stack)
2. [Project Structure](#structure)
3. [Auth: Privy Wallet Sign-In](#auth)
4. [Server: tRPC + REST Routes](#server)
5. [Talking to Sera: the REST API Client](#sera-api)
6. [Environment Variables](#env)
7. [Storage: Cloudflare R2](#storage)
8. [Scripts & Local Dev](#scripts)

---

## Tech Stack {#stack}

| Layer | Technology |
|---|---|
| Frontend framework | React 19.2 + Vite 7 |
| Frontend router | wouter (not react-router) |
| Data fetching | TanStack Query + tRPC (`@trpc/client`, `@trpc/react-query`) |
| API layer | Express 4 + tRPC server (`@trpc/server`) — typed end-to-end, not a plain REST API internally |
| Wallet auth | Privy (`@privy-io/react-auth`) — embedded/external wallet sign-in, not custom SIWE |
| Chain libraries | **Both** `wagmi` and `viem`, plus `ethers` v6 (legacy call sites) |
| ORM / DB | Drizzle ORM (`drizzle-kit generate/migrate/push`) over `pg` (Postgres) |
| UI components | shadcn/ui pattern — Radix primitives + `class-variance-authority` + Tailwind v4 |
| QR codes | `qr-code-styling` / `qrcode` / `qrcode.react` for generation, `jsqr` for scanning |
| PDF/export | `jspdf` + `html2canvas` (receipts/exports) |
| Object storage | AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) against Cloudflare R2's S3-compatible API |
| Validation | Zod v4 |
| Testing | Vitest 2.1 |
| Process manager | PM2 (`ecosystem.config.cjs`) for production |
| Package manager | pnpm (`packageManager` pinned in `package.json`) |
| TypeScript | 5.9.3 |

Note the frontend uses **both** `wagmi`/`viem` and `ethers` — don't assume one is dead code
without checking the specific file; they coexist across older and newer parts of the app.

## Project Structure {#structure}

```
sera-pay/
├── client/                # React/Vite frontend
│   ├── index.html
│   ├── public/
│   └── src/
├── server/                # Express + tRPC API server
│   ├── _core/             # tRPC setup (router/procedure builders), system router
│   ├── routers.ts         # tRPC appRouter assembly — feature routers get added here
│   ├── payment-routes.ts  # Payment link + checkout REST endpoints (largest file in server/)
│   ├── gateway-routes.ts  # Merchant/API-gateway REST endpoints
│   ├── menu-routes.ts     # Menu & item management REST endpoints
│   ├── compliance.ts      # Compliance/KYC-adjacent checks
│   ├── sera-api.ts         # Typed client for Sera's REST API (see below)
│   ├── secret-vault.ts     # Encrypted merchant secret storage helpers
│   ├── storage.ts          # Cloudflare R2 (S3-compatible) storage helpers
│   └── db.ts               # Drizzle ORM query layer
├── drizzle/                # Schema + migrations
├── shared/                 # Types/constants shared between client and server
├── lib/                    # Internal packages, generated API helpers
├── scripts/                 # dev.mjs / build.mjs / start.mjs (see Scripts below)
├── ecosystem.config.cjs    # PM2 process config for production
└── drizzle.config.ts
```

`payment-routes.ts` is ~110KB — the bulk of the app's payment/checkout logic lives there. When
asked to modify checkout/payment-link behavior, start there rather than guessing at a smaller
file.

## Auth: Privy Wallet Sign-In {#auth}

Merchant auth is **Privy**, not a hand-rolled SIWE flow:

```bash
VITE_PRIVY_APP_ID=...
VITE_PRIVY_CLIENT_ID=...
VITE_PRIVY_USE_CLIENT_ID_IN_DEV=false   # leave false for localhost unless your Privy client ID allows local origins
PRIVY_SECRET=...
PRIVY_JWKS=...
```

Server-side session state layers on top via `SESSION_SECRET` (stable random, ≥32 bytes) —
Privy handles wallet-level auth; the app's own session cookie is separate. Generate both
`SESSION_SECRET` and `SERA_CONFIG_ENCRYPTION_KEY` independently:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The tRPC `auth` router exposes `auth.me` (current user query) and `auth.logout` (mutation) —
see `server/routers.ts`.

## Server: tRPC + REST Routes {#server}

The app mixes **tRPC** (typed RPC over HTTP, used for auth/system/internal queries) with
**plain Express REST routes** (`payment-routes.ts`, `gateway-routes.ts`, `menu-routes.ts`) for
the payment/merchant/menu surface — likely because those need to be callable from outside the
tRPC client (webhooks, external integrations, QR-link redemption). Comment convention in
`routers.ts`: *"all api should start with `/api/` so that the gateway can route correctly"* —
respect that prefix when adding new REST endpoints.

```typescript
// server/routers.ts — tRPC router assembly pattern
export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(() => ({ success: true } as const)),
  }),
  // feature routers get added here
});
export type AppRouter = typeof appRouter;
```

## Talking to Sera: the REST API Client {#sera-api}

SeraPay does **not** call the orderbook contracts directly, and does not use the GraphQL
subgraph either — it calls Sera's hosted REST API (`server/sera-api.ts`):

```typescript
DEFAULT_SERA_API_BASE_URL = "https://api.sera.cx/api/v1"
DEFAULT_SERA_API_TESTNET_BASE_URL = "https://api.testnet.sera.cx/api/v1"
```

Known endpoints (from `callSeraApi` call sites):

| Endpoint | Purpose |
|---|---|
| `GET /tokens` | List supported tokens (`{ tokens: SeraToken[] }`) |
| `GET /markets` | List markets (`{ markets: SeraMarket[] }`) |
| `GET /fx/rate?base=USD&quote=SGD` | Current FX rate for a pair |
| `GET /health` | Liveness — `{ status: "healthy" | ... }` |
| `GET /config` | Deployed addresses — `{ chain_id, sera_address, vault_address, sor_address }` (v2 contract naming) |
| `POST /api-keys/verify` | Verify an `api_key:api_secret` credential pair, returns `owner_address` |

`callSeraApi` supports three auth modes (`none`, `api_key`, `eip712`) and three operating modes
(`mock`, `test`, `live`) — `mock` mode returns a canned healthy snapshot without hitting the
network at all, useful for local dev without real credentials. Every call is logged via
`createSeraApiRequestLog`, with `sensitiveRequest`/`sensitiveResponse` flags to redact
credentials/secrets from the stored log body.

The `/config` response's `sera_address` / `vault_address` / `sor_address` fields line up with
the **v2** contract set (`Sera.sol`, `Vault.sol`, `SeraSOR.sol`) — see
`references/orderbook-v2.md`. If a user asks how SeraPay settles payments on-chain, this REST
API — not direct contract calls — is the integration surface to point them at.

## Environment Variables {#env}

```bash
# Server
NODE_ENV=development
PORT=3000
DATABASE_URL=...

# Session / encryption (each independently, >=32 random bytes)
SESSION_SECRET=...
SERA_CONFIG_ENCRYPTION_KEY=...

# Optional — defaults to http://localhost:3000 (dev) / https://pay.sera.cx (prod)
PAYMENT_BASE_URL=...

# Sera API
SERA_API_BASE_URL=https://api.sera.cx/api/v1
SERA_API_TESTNET_BASE_URL=https://api.testnet.sera.cx/api/v1
SERA_API_KEY=...
SERA_WEBHOOK_SECRET=...            # verifies inbound webhooks from Sera
GOLDSKY_GRAPHQL_URL=...            # optional — exchange-graph lookups

# Privy (wallet auth)
VITE_PRIVY_APP_ID=...
VITE_PRIVY_CLIENT_ID=...
VITE_PRIVY_USE_CLIENT_ID_IN_DEV=false
PRIVY_SECRET=...
PRIVY_JWKS=...

# CORS
ALLOWED_ORIGINS=http://localhost:3000,https://sera.cx,https://app.sera.cx,https://pay.sera.cx,...
VITE_APP_BASE_URL=...

# Cloudflare R2 (optional — server-side only, never prefix with VITE_)
CLOUDFLARE_R2_ACCOUNT_ID=...
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
CLOUDFLARE_R2_API_TOKEN=...
CLOUDFLARE_R2_BUCKET=...
CLOUDFLARE_R2_ENDPOINT=...
CLOUDFLARE_R2_PUBLIC_URL=...
```

Never commit real values for `DATABASE_URL`, session/encryption keys, Privy secrets, R2
credentials, or `SERA_WEBHOOK_SECRET`.

## Storage: Cloudflare R2 {#storage}

Merchant logos and menu images go to R2 via the S3-compatible API (`server/storage.ts`). If
`CLOUDFLARE_R2_PUBLIC_URL` isn't set, the app proxies image reads through a backend route
instead, so the bucket can stay private. Each merchant stores exactly one current logo
reference plus their QR style/color preferences on their merchant profile row — both persist
across sessions.

## Scripts & Local Dev {#scripts}

```bash
git clone https://github.com/sera-cx/sera-pay
cd sera-pay
pnpm install
cp .env.example .env
pnpm run dev        # scripts/dev.mjs — serves on first free port starting at 3000
```

```bash
pnpm run dev        # local dev server
pnpm run check      # tsc --noEmit
pnpm test           # vitest run
pnpm run build      # scripts/build.mjs — production build
pnpm start          # scripts/start.mjs — run built app
pnpm run db:generate  # drizzle-kit generate
pnpm run db:migrate   # drizzle-kit migrate
pnpm run db:push      # drizzle-kit push
```

Before publishing/sharing a fork, the repo's own guidance (`docs/open-source-sanitization-prompt.md`)
recommends running `pnpm run check && pnpm test && pnpm run build` and double-checking that
`.env`, build output, and local logs aren't committed.
