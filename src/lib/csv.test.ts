import { describe, expect, it } from "vitest";
import { csvCell, csvRow } from "./csv";

describe("csvCell", () => {
  it("prefixes formula starters with an apostrophe", () => {
    for (const s of ["=1+1", "+1", "-1", "@a", "\tx", "\rx"]) expect(csvCell(s)).toMatch(/^"?'/);
  });
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });
  it("leaves plain values and numbers alone, nulls become empty", () => {
    expect(csvCell("Cafe")).toBe("Cafe");
    expect(csvCell(12)).toBe("12");
    expect(csvRow([null, undefined, "x"])).toBe(",,x");
  });
});
