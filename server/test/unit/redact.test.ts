import { describe, expect, it } from "vitest";
import { redact } from "../../src/redact.js";

describe("redact", () => {
  it("removes exact secrets and token-shaped strings", () => {
    expect(redact("token=s3cr3t-value here", ["s3cr3t-value"])).toBe("token=[REDACTED] here");
    expect(redact("got hct_AbC123xyz in body")).toBe("got [REDACTED] in body");
    expect(redact('Authorization: Bearer abc.def"')).toBe('Authorization: Bearer [REDACTED]"');
  });

  it("leaves ordinary text alone", () => {
    expect(redact("GET /reviews: HTTP 500", ["unrelated"])).toBe("GET /reviews: HTTP 500");
  });
});
