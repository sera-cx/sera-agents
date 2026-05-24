/**
 * EIP-712 Order signing for Sera maker orders.
 *
 * Order struct (per docs.sera.cx/contracts/sera and confirmed via /verify-signature):
 *   {
 *     user: address,                 // signing wallet
 *     expiration: uint48,            // unix seconds
 *     feeBps: uint48,                // CONTRACT bps — denom 10^14, NOT 10^4
 *     recipient: address,            // address(0) = proceeds stay in vault ledger
 *     fromToken: address,            // base token (market spec)
 *     toToken: address,              // quote token (market spec)
 *     fromAmount: uint256,           // raw units
 *     toAmount: uint256,             // raw units
 *     initialDepositAmount: uint256, // 0 for vault-funded
 *     uuid: uint256,                 // composite uuid_int
 *   }
 *
 * Domain: { name: "Sera", version: "1", chainId, verifyingContract: <Sera address> }
 */
import { TypedDataEncoder, type Signer, type TypedDataDomain } from "ethers";

export interface OrderStruct {
  user: string;
  expiration: number;        // uint48
  feeBps: number;            // uint48 (contract bps — usually 0 for makers)
  recipient: string;
  fromToken: string;
  toToken: string;
  fromAmount: bigint;
  toAmount: bigint;
  initialDepositAmount: bigint;
  uuid: bigint;
}

export const ORDER_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Order: [
    { name: "user", type: "address" },
    { name: "expiration", type: "uint48" },
    { name: "feeBps", type: "uint48" },
    { name: "recipient", type: "address" },
    { name: "fromToken", type: "address" },
    { name: "toToken", type: "address" },
    { name: "fromAmount", type: "uint256" },
    { name: "toAmount", type: "uint256" },
    { name: "initialDepositAmount", type: "uint256" },
    { name: "uuid", type: "uint256" },
  ],
};

/** Build the Sera EIP-712 domain from /config response. */
export function seraDomain(chainId: number, seraAddress: string): TypedDataDomain {
  return {
    name: "Sera",
    version: "1",
    chainId,
    verifyingContract: seraAddress,
  };
}

/** Sign an Order via ethers. Returns 0x-prefixed hex signature. */
export async function signOrder(
  signer: Signer,
  domain: TypedDataDomain,
  order: OrderStruct,
): Promise<string> {
  return await signer.signTypedData(domain, ORDER_TYPES, {
    user: order.user,
    expiration: order.expiration,
    feeBps: order.feeBps,
    recipient: order.recipient,
    fromToken: order.fromToken,
    toToken: order.toToken,
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
    initialDepositAmount: order.initialDepositAmount,
    uuid: order.uuid,
  });
}

/** Compute the order hash (for debugging / verify-signature checks). */
export function orderHash(domain: TypedDataDomain, order: OrderStruct): string {
  return TypedDataEncoder.hash(domain, ORDER_TYPES, {
    user: order.user,
    expiration: order.expiration,
    feeBps: order.feeBps,
    recipient: order.recipient,
    fromToken: order.fromToken,
    toToken: order.toToken,
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
    initialDepositAmount: order.initialDepositAmount,
    uuid: order.uuid,
  });
}
