# Virtuals Protocol integration

Make Sera's cross-border FX available to [Virtuals Protocol](https://whitepaper.virtuals.io)
agents. There are two surfaces, and you can ship either independently:

| Surface | What it gives you | Needs on-chain setup? |
|---|---|---|
| **GAME SDK plugin** | Any GAME agent (incl. GAME Cloud **X/Twitter agents**) can call Sera FX as native functions | ❌ No — keyless, works today |
| **ACP provider** | Sera FX becomes a **discoverable, paid service** other Virtuals agents can buy on-chain | ✅ Yes — agent + whitelisted wallet + Service Registry registration |

Everything here talks to the public gateway at **`https://agents.sera.cx`** — keyless, read-/prepare-only. `fx_settle` returns *unsigned* EIP-712 typed data; the agent/user signs in their own wallet, so nothing here takes custody of funds.

---

## 1. GAME SDK plugin (start here)

[`game/sera-plugin.ts`](game/sera-plugin.ts) exposes four functions as a ready-to-use `GameWorker`:

| Function | Does |
|---|---|
| `sera_get_fx_rates` | Live reference rates for BASE/QUOTE pairs |
| `sera_list_corridors` | Supported corridors + liquidity depth |
| `sera_fx_quote` | Price a conversion → `amount_out`, `mid_rate`, `quote_id` |
| `sera_fx_settle` | Unsigned EIP-712 settlement intent from a `quote_id` |

```bash
npm i @virtuals-protocol/game
```

```ts
import { GameAgent } from "@virtuals-protocol/game";
import { seraFxWorker } from "./game/sera-plugin";

const agent = new GameAgent(process.env.GAME_API_KEY!, {
  name: "Sera FX Agent",
  goal: "Move money across currencies at the best available rate.",
  description: "Uses Sera to quote and prepare cross-border stablecoin settlements.",
  workers: [seraFxWorker],
});
await agent.init();
```

A full runnable example is in [`game/example-agent.ts`](game/example-agent.ts). Point it at a self-hosted gateway with `SERA_GATEWAY_URL`.

> **GAME Cloud / X agents:** GAME Cloud (the hosted, low-code builder) currently
> powers **X/Twitter agents**. Register the four functions above as custom
> functions in your GAME Cloud worker (same name/description/args, each doing the
> `fetch` to `https://agents.sera.cx`), and your X agent can quote and settle FX
> in-thread. See [`../x/README.md`](../x/README.md).

---

## 2. ACP provider (sell Sera FX to other agents)

[Agent Commerce Protocol (ACP)](https://whitepaper.virtuals.io/about-virtuals/agent-commerce-protocol-acp)
lets other Virtuals agents **discover and pay for** your service on-chain. You can
join **API-only** — no autonomous agent required, just fulfil jobs.

[`acp/sera-provider.ts`](acp/sera-provider.ts) is a provider skeleton: the
`fulfilSeraJob()` function (quote → optional unsigned settlement intent) is the
stable, Sera-specific part; the ACP wiring around it is sketched and should be
confirmed against your installed SDK version.

```bash
npm i @virtuals-protocol/acp-node
```

### On-chain onboarding (your steps — needs your wallet/keys)

These require signing with your own wallet and **cannot be done from this repo**:

1. **Create + whitelist an agent wallet** in the [Virtuals console](https://app.virtuals.io).
2. **Register the agent** in the [ACP Service Registry](https://whitepaper.virtuals.io/acp-product-resources/acp-dev-onboarding-guide/set-up-agent-profile/register-agent)
   with your Sera FX offering (name, price, deliverable schema). Without this,
   buyers can't discover the service.
3. Follow the [ACP Dev Onboarding Guide](https://whitepaper.virtuals.io/acp-product-resources/acp-dev-onboarding-guide)
   for wallet whitelist, job lifecycle, and SLA.
4. Set `WHITELISTED_WALLET_PRIVATE_KEY`, `ACP_AGENT_ID`, `AGENT_WALLET_ADDRESS`
   and run the provider.

> SDKs: [`@virtuals-protocol/acp-node`](https://www.npmjs.com/package/@virtuals-protocol/acp-node)
> (Node) · [`virtuals-acp`](https://pypi.org/project/virtuals-acp/) (Python).

---

## Security notes

- **Non-custodial.** `fx_settle` returns unsigned typed data; signing happens in
  the buyer's/agent's wallet. This integration never holds keys or moves funds.
- **Keep ACP wallet keys out of the repo.** `WHITELISTED_WALLET_PRIVATE_KEY`
  lives only in the provider's runtime environment.
- **Rate limits.** The gateway returns `429` + `Retry-After` on upstream
  throttles; the plugin surfaces that message so the agent can back off.
