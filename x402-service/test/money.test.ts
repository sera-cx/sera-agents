import { describe, expect, it } from "vitest";
import { addSurchargeBps, atomicToUsdc, usdcToAtomic } from "../money.js";

describe("USDC atomic-unit math", () => {
  it("converts decimal USDC without floating-point multiplication", () => {
    expect(usdcToAtomic("21.000001")).toBe("21000001");
    expect(atomicToUsdc("21000001")).toBe("21.000001");
  });

  it("rounds excess precision up to avoid undercharging", () => {
    expect(usdcToAtomic("0.0000001")).toBe("1");
  });

  it("applies bps surcharge by integer ceiling division", () => {
    expect(addSurchargeBps("1000001", 1)).toBe("1000102");
  });
});
