/**
 * uuid_int composite construction for Sera Order / Intent structs.
 *
 * Per Sera spec (256-bit layout):
 *   [255:252] executor_id  (4 bits)
 *   [251:124] UUID bits    (128 bits — UUID4 embedded)
 *   [123:12]  group_id     (112 bits — first 112 bits of order_id for standalone)
 *   [11:0]    leg_id       (12 bits — 0 for standalone; 0,1,2,… for VL batches)
 *
 * Mismatch between `order_id` (UUID4 string) and `uuid_int` is rejected by
 * the API. Always build them together via `makeOrderId()`.
 */
import { randomBytes, randomUUID } from "node:crypto";

/** UUID4 string + matching composite uuid_int as decimal string. */
export interface OrderIdPair {
  order_id: string;     // UUID4 string, e.g. "00000000-0000-4000-8000-000000000001"
  uuid_int: string;     // uint256 decimal
}

/** Mainnet default per Sera docs. Override at runtime via sera.doctor / GET /health. */
export const DEFAULT_EXECUTOR_ID = 0n;

/**
 * Build a standalone Order's id pair (leg_id=0).
 *
 * @param executorId  4-bit executor identifier from /health (mainnet default 0)
 */
export function makeOrderId(executorId: bigint = DEFAULT_EXECUTOR_ID): OrderIdPair {
  const uuid = randomUUID();                          // e.g. "8d9d8a4e-ff27-4f8a-b1c1-…"
  const uuidHex = uuid.replace(/-/g, "");             // 32 hex chars = 128 bits
  const uuidBits = BigInt("0x" + uuidHex);
  // group_id = first 112 bits of the order_id (high bits of the UUID).
  const groupId = uuidBits >> 16n;
  const legId = 0n;
  return {
    order_id: uuid,
    uuid_int: packUuidInt(executorId, uuidBits, groupId, legId).toString(),
  };
}

/**
 * Build a VL-batch sibling. All siblings share `groupId`; their `legId`
 * increments 0, 1, 2… in submission order. The primary (leg_id=0) returns
 * its own `groupId` so subsequent calls can pass it back.
 */
export function makeVlSibling(
  primaryGroupId: bigint,
  legId: number,
  executorId: bigint = DEFAULT_EXECUTOR_ID,
): OrderIdPair {
  if (legId < 0 || legId > 4095) throw new Error(`legId out of range: ${legId}`);
  const uuid = randomUUID();
  const uuidBits = BigInt("0x" + uuid.replace(/-/g, ""));
  return {
    order_id: uuid,
    uuid_int: packUuidInt(executorId, uuidBits, primaryGroupId, BigInt(legId)).toString(),
  };
}

/** Extract the group_id that future VL siblings should share with this order. */
export function groupIdFor(uuid: string): bigint {
  return BigInt("0x" + uuid.replace(/-/g, "")) >> 16n;
}

function packUuidInt(executorId: bigint, uuidBits: bigint, groupId: bigint, legId: bigint): bigint {
  // Layout: executor_id << 252 | uuid_bits << 124 | group_id << 12 | leg_id
  if (executorId < 0n || executorId > 0xfn) throw new Error("executorId must fit in 4 bits");
  if (uuidBits < 0n || uuidBits >= 1n << 128n) throw new Error("uuid must fit in 128 bits");
  if (groupId < 0n || groupId >= 1n << 112n) throw new Error("groupId must fit in 112 bits");
  if (legId < 0n || legId >= 1n << 12n) throw new Error("legId must fit in 12 bits");
  return (executorId << 252n) | (uuidBits << 124n) | (groupId << 12n) | legId;
}

/** Generate a fresh `uuid` field (uint256 decimal) for things like WithdrawIntent that don't need composite layout. */
export function freshUuid(): string {
  const buf = randomBytes(16);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n.toString();
}
