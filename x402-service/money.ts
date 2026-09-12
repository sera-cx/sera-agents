/** Exact USDC (6-decimal) conversion helpers for the x402 money path. */
export const USDC_ATOMIC_SCALE = 1_000_000n;

/**
 * Converts a human-readable decimal amount to USDC atomic units. Values with
 * more than six decimal places are rounded up, so the service never charges
 * less than the quoted requirement.
 */
export function usdcToAtomic(value: string | number): string {
  const input = String(value).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input);
  if (!match) throw new Error(`invalid USDC amount: ${input}`);

  const whole = BigInt(match[1]);
  const fraction = match[2] ?? "";
  const kept = fraction.slice(0, 6).padEnd(6, "0");
  const discarded = fraction.slice(6);
  let atomic = whole * USDC_ATOMIC_SCALE + BigInt(kept);
  if (/[1-9]/.test(discarded)) atomic += 1n;
  if (atomic <= 0n) throw new Error(`invalid USDC amount: ${input}`);
  return atomic.toString();
}

export function atomicToUsdc(value: string): string {
  const atomic = BigInt(value);
  if (atomic < 0n) throw new Error(`invalid USDC atomic amount: ${value}`);
  return `${atomic / USDC_ATOMIC_SCALE}.${(atomic % USDC_ATOMIC_SCALE).toString().padStart(6, "0")}`;
}

/** Applies a non-negative basis-point surcharge, rounding up in atomic units. */
export function addSurchargeBps(amountAtomic: string, surchargeBps: number): string {
  if (!Number.isSafeInteger(surchargeBps) || surchargeBps < 0) {
    throw new Error(`invalid surcharge bps: ${surchargeBps}`);
  }
  const denominator = 10_000n;
  const numerator = BigInt(amountAtomic) * (denominator + BigInt(surchargeBps));
  return ((numerator + denominator - 1n) / denominator).toString();
}
