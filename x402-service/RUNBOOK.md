# Base Sepolia x402 v2 runbook

Live operation is intentionally two-stage. Never put CDP key material, payer keys, or Sera signer keys in an attestation or ticket.

1. Read secrets from the approved secret manager: funded Base Sepolia payer (test ETH + test USDC), CDP API key, public HTTPS staging URL, and dedicated Sera Sepolia vault/recipient.
2. Configure `X402_NETWORK=eip155:84532`, `X402_TESTNET_ACK=true`, `X402_PUBLIC_URL`, CDP credentials, and `SERA_NETWORK=sepolia`. Run `sera.doctor` and a quote successfully before startup.
3. Run the v2 buyer against the returned `PAYMENT-REQUIRED` value to obtain an opaque `PAYMENT-SIGNATURE`, then run `npm run e2e:sepolia`. The runner gets its payment ID from the initial 402 response. Confirm the CDP settlement transaction in the Base explorer and the Sera delivery transaction and recipient amount.
4. Record the generated evidence ID with date, commit SHA, payment ID, CDP transaction, Sera transaction, and reviewer. Do not record secrets.
5. Only after review may mainnet use `X402_NETWORK=eip155:8453`, `X402_MAINNET_ACK=true`, and the approved `X402_E2E_ATTESTATION_ID`.

`settlement_unknown` means a settle request timed out or could not be reached. Do not retry, refund, or deliver automatically: investigate CDP using the payment ID and recorded transaction references. `settlement_failed` is a definitive facilitator rejection and also has no delivery/refund. `failed_refundable` is reserved for a confirmed settlement followed by failed Sera delivery, and is the manual refund queue.
