import { describe,it,expect,afterEach } from "vitest";
import { loadConfig } from "../env.js";
const saved={...process.env}; afterEach(()=>{process.env={...saved};});
describe("live gates",()=>{
 it("rejects ambiguous/v1 network",()=>{process.env.X402_NETWORK="base-sepolia";expect(()=>loadConfig()).toThrow(/eip155/);});
 it("requires testnet acknowledgement",()=>{Object.assign(process.env,{X402_MODE:"live",X402_NETWORK:"eip155:84532",X402_FACILITATOR_URL:"https://x",X402_CDP_API_KEY_ID:"id",X402_CDP_API_KEY_SECRET:"secret",X402_VAULT_ADDRESS:"0x1",X402_PUBLIC_URL:"https://example.com"});expect(()=>loadConfig()).toThrow(/X402_TESTNET_ACK/);});
 it("requires separate mainnet attestation",()=>{Object.assign(process.env,{X402_MODE:"live",X402_NETWORK:"eip155:8453",X402_FACILITATOR_URL:"https://x",X402_CDP_API_KEY_ID:"id",X402_CDP_API_KEY_SECRET:"secret",X402_VAULT_ADDRESS:"0x1",X402_PUBLIC_URL:"https://example.com",X402_MAINNET_ACK:"true"});expect(()=>loadConfig()).toThrow(/E2E_ATTESTATION/);});
});
