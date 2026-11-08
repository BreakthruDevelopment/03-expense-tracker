import { describe, expect, it } from "vitest";
import { isLoopbackUrl, localDriverAllowed } from "./local-policy";

describe("local driver policy", () => {
  it("is allowed outside production", () => {
    expect(localDriverAllowed({ nodeEnv: "development", allowLocal: false, appUrl: "https://x.example" })).toBe(true);
    expect(localDriverAllowed({ nodeEnv: "test", allowLocal: false, appUrl: "http://localhost:3000" })).toBe(true);
  });
  it("needs the flag and a loopback http URL in production", () => {
    expect(localDriverAllowed({ nodeEnv: "production", allowLocal: false, appUrl: "http://localhost:3000" })).toBe(false);
    expect(localDriverAllowed({ nodeEnv: "production", allowLocal: true, appUrl: "http://localhost:3000" })).toBe(true);
    expect(localDriverAllowed({ nodeEnv: "production", allowLocal: true, appUrl: "http://127.0.0.1:3100" })).toBe(true);
  });
  it("refuses a public or https URL even with the flag", () => {
    for (const appUrl of ["https://app3.breakthruventures.ai", "https://localhost:3000", "http://localhost.evil.test", "http://app.run.app", "not a url"]) {
      expect(localDriverAllowed({ nodeEnv: "production", allowLocal: true, appUrl })).toBe(false);
    }
    expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
  });
  it("refuses credentials, tricks and non-loopback IPv6 forms", () => {
    expect(isLoopbackUrl("http://127.0.0.1@evil.test")).toBe(false);
    expect(isLoopbackUrl("http://localhost:x@evil.test")).toBe(false);
    expect(isLoopbackUrl("http://user:pw@localhost:3000")).toBe(false);
    expect(isLoopbackUrl("http://[::ffff:127.0.0.1]:3000")).toBe(false);
  });
  it("accepts uppercase and IPv6 loopback spellings", () => {
    expect(isLoopbackUrl("HTTP://LOCALHOST:3000")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3000")).toBe(true);
  });
  it("refuses when CLOUD names a deployment", () => {
    const base = { nodeEnv: "production", allowLocal: true, appUrl: "http://localhost:3000" };
    expect(localDriverAllowed({ ...base, cloud: "gcp" })).toBe(false);
    expect(localDriverAllowed({ ...base, cloud: "local" })).toBe(true);
    expect(localDriverAllowed({ ...base })).toBe(true);
  });
});
