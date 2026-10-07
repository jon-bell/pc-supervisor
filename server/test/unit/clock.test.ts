import { describe, expect, it } from "vitest";
import { clockFromConfig, clockFromEnv, fixedClock, systemClock } from "../../src/clock.js";
import { ConfigError } from "../../src/config.js";

describe("clock", () => {
  it("pins to PCS_NOW in PCS_TZ", () => {
    const c = clockFromEnv({ PCS_NOW: "2030-02-26T12:00", PCS_TZ: "America/New_York" });
    expect(c.pinned).toBe(true);
    expect(c.now().toISOString()).toBe("2030-02-26T17:00:00.000Z");
  });

  it("defaults PCS_TZ to America/New_York and honors explicit offsets", () => {
    expect(clockFromEnv({ PCS_NOW: "2030-07-01T00:00" }).now().toISOString()).toBe("2030-07-01T04:00:00.000Z");
    expect(clockFromEnv({ PCS_NOW: "2030-07-01T00:00Z", PCS_TZ: "Asia/Tokyo" }).now().toISOString()).toBe(
      "2030-07-01T00:00:00.000Z",
    );
  });

  it("uses real time when PCS_NOW is unset or empty", () => {
    for (const env of [{}, { PCS_NOW: "" }]) {
      const c = clockFromEnv(env);
      expect(c).toBe(systemClock);
      expect(Math.abs(c.now().getTime() - Date.now())).toBeLessThan(1000);
    }
  });

  it("rejects a malformed PCS_NOW", () => {
    expect(() => clockFromEnv({ PCS_NOW: "tomorrow" })).toThrow(ConfigError);
  });

  it("returns a fresh Date each call", () => {
    const c = fixedClock(new Date("2030-01-01T00:00:00Z"));
    c.now().setFullYear(1999);
    expect(c.now().toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("builds from a loaded config", () => {
    expect(clockFromConfig({ now: undefined })).toBe(systemClock);
    expect(clockFromConfig({ now: new Date(0) }).now().getTime()).toBe(0);
  });
});
