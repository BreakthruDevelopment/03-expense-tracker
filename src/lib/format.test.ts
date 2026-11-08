import { describe, expect, it } from "vitest";
import { currentMonth, formatDay, formatMoney, monthLabel, monthRange, shiftMonth } from "./format";

describe("format", () => {
  it("formats integer cents per currency", () => {
    expect(formatMoney(1240, "USD")).toBe("$12.40");
    expect(formatMoney(4180, "EUR")).toBe("€41.80");
    expect(formatMoney(100_000_000, "USD")).toBe("$1,000,000.00");
  });
  it("handles months", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(shiftMonth("2026-01", 1)).toBe("2025-12");
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(currentMonth(new Date("2026-11-08T12:00:00Z"))).toBe("2026-11");
    expect(formatDay("2026-10-04")).toBe("Oct 4, 2026");
  });
});
