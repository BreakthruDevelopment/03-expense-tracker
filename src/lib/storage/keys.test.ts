import { describe, expect, it } from "vitest";
import { assertBucketName, assertObjectKey, inlineDisposition, objectKeyFor } from "./keys";

const id = "0b6f0c1e-3c1a-4f55-9d0a-1f2b3c4d5e6f";

describe("object keys", () => {
  it("builds u/<owner>/<receipt> and parses it back", () => {
    const key = objectKeyFor("user_123-abc", id);
    expect(key).toBe(`u/user_123-abc/${id}`);
    expect(assertObjectKey(key)).toEqual({ ownerId: "user_123-abc", receiptId: id });
  });

  it("rejects traversal, extensions, odd owners and non-uuid ids", () => {
    for (const bad of [
      `u/../${id}`,
      `u/a/${id}.jpg`,
      `u/a/b/${id}`,
      `x/a/${id}`,
      `u/a b/${id}`,
      "u/a/not-a-uuid",
      `/u/a/${id}`,
      `u/a/${id}\n`,
      "",
    ]) {
      expect(() => assertObjectKey(bad), bad).toThrow();
    }
    expect(() => objectKeyFor("a/b", id)).toThrow();
    expect(() => objectKeyFor("a", "nope")).toThrow();
  });
});

describe("bucket names", () => {
  it("accepts normal names and refuses the rest", () => {
    expect(assertBucketName("my-project-expense-tracker-uploads")).toBe("my-project-expense-tracker-uploads");
    for (const bad of ["", "A", "UPPER", "a", "-bad-", "has space", "a..b", "googbucket", "10.0.0.1", "x/../y", "a?b=c"]) {
      expect(() => assertBucketName(bad), bad).toThrow();
    }
  });
});

describe("inlineDisposition", () => {
  it("names the file by type, never by upload", () => {
    expect(inlineDisposition("image/png")).toBe('inline; filename="receipt.png"');
  });
});
