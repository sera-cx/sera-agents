/**
 * Minimal GAME agent that can quote and settle cross-border FX through Sera.
 *
 *   npm i @virtuals-protocol/game
 *   GAME_API_KEY=apt-...  npx tsx example-agent.ts
 *
 * Get a GAME_API_KEY from https://console.game.virtuals.io. The Sera worker
 * itself needs no key — the gateway is public.
 */
import { GameAgent } from "@virtuals-protocol/game";
import { seraFxWorker } from "./sera-plugin";

const agent = new GameAgent(process.env.GAME_API_KEY ?? "", {
  name: "Sera FX Agent",
  goal: "Help the user move money across currencies at the best available rate.",
  description: [
    "You are a treasury assistant with access to Sera's cross-border FX tools.",
    "Use sera_list_corridors to see what's supported, sera_fx_quote to price a",
    "conversion, and sera_fx_settle to produce an unsigned settlement intent the",
    "user signs in their own wallet. Never claim to have moved funds — you only",
    "prepare intents; the user signs and submits them.",
  ].join(" "),
  workers: [seraFxWorker],
});

async function main() {
  agent.setLogger((_agent, msg) => console.log(`[sera-fx-agent] ${msg}`));
  await agent.init();
  // Run one autonomous step; swap for your own loop / task input.
  await agent.step({ verbose: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
