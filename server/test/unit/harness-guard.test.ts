import { describe, expect, it } from "vitest";
import { assertHarnessUrl, isHarnessUrl, NotHarnessError } from "../../src/hotcrp/harness-guard.js";

describe("harness guard", () => {
  it.each(["http://127.0.0.1:8080", "http://localhost:18080/", "https://localhost", "http://[::1]:8080"])("allows %s", (url) => {
    expect(isHarnessUrl(url)).toBe(true);
    expect(assertHarnessUrl({ PCS_HOTCRP_URL: url })).toBe(url);
  });

  it.each([
    "https://conf2027-shadow.hotcrp.com",
    "http://127.0.0.1.evil.example.org",
    "http://localhost.example.org:8080",
    "http://10.0.0.5:8080",
    "http://user@localhost:8080",
    "ftp://localhost",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isHarnessUrl(url)).toBe(false);
    expect(() => assertHarnessUrl({ PCS_HOTCRP_URL: url })).toThrow(NotHarnessError);
  });

  it("refuses when unset, and says how to fix it", () => {
    expect(() => assertHarnessUrl({})).toThrow(/hotcrp-up\.sh/);
  });

  it("does not echo the full URL of a non-harness host", () => {
    expect(() => assertHarnessUrl({ PCS_HOTCRP_URL: "https://real.example.org/conf?x=1" })).toThrow(
      /host real\.example\.org is not 127\.0\.0\.1\/localhost/,
    );
  });
});
