import { describe, expect, it } from "vitest";
import { formatInZone, isValidTimeZone, parseInstant, parseIsoLocal, zoneOffsetMs } from "../../src/tz.js";

const iso = (s: string, tz: string) => parseInstant(s, tz)?.toISOString();

describe("parseIsoLocal", () => {
  it("accepts minutes, seconds, millis, and offsets", () => {
    expect(parseIsoLocal("2030-02-01T23:59")).toMatchObject({ year: 2030, month: 2, day: 1, hour: 23, minute: 59, second: 0 });
    expect(parseIsoLocal("2030-02-01T23:59:30.5")).toMatchObject({ second: 30, millisecond: 500 });
    expect(parseIsoLocal("2030-02-01T23:59Z")?.offsetMinutes).toBe(0);
    expect(parseIsoLocal("2030-02-01T23:59-0530")?.offsetMinutes).toBe(-330);
  });

  it.each(["2030-02-01", "2030-02-30T00:00", "2030-13-01T00:00", "2030-02-01T24:00", "2030-02-01 10:00", "nope", "2030-02-01T10:00+25:00"])(
    "rejects %s",
    (s) => expect(parseIsoLocal(s)).toBeNull(),
  );
});

describe("zone conversion", () => {
  it("handles standard and daylight time", () => {
    expect(iso("2030-01-15T12:00", "America/New_York")).toBe("2030-01-15T17:00:00.000Z");
    expect(iso("2030-07-15T12:00", "America/New_York")).toBe("2030-07-15T16:00:00.000Z");
    expect(iso("2030-07-15T12:00", "Asia/Kolkata")).toBe("2030-07-15T06:30:00.000Z");
    expect(iso("2030-07-15T12:00", "UTC")).toBe("2030-07-15T12:00:00.000Z");
  });

  it("handles the date line and zones far from UTC", () => {
    expect(iso("2030-01-01T00:00", "Pacific/Kiritimati")).toBe("2029-12-31T10:00:00.000Z");
    expect(iso("2030-01-01T00:00", "Pacific/Pago_Pago")).toBe("2030-01-01T11:00:00.000Z");
  });

  // US DST 2030: starts Sun Mar 10 at 02:00, ends Sun Nov 3 at 02:00.
  it("pushes a nonexistent spring-forward time past the gap", () => {
    expect(iso("2030-03-10T02:30", "America/New_York")).toBe("2030-03-10T07:30:00.000Z"); // = 03:30 EDT
    expect(iso("2030-03-10T03:00", "America/New_York")).toBe("2030-03-10T07:00:00.000Z");
    expect(iso("2030-03-10T01:59", "America/New_York")).toBe("2030-03-10T06:59:00.000Z");
  });

  it("picks the earlier instant for an ambiguous fall-back time", () => {
    expect(iso("2030-11-03T01:30", "America/New_York")).toBe("2030-11-03T05:30:00.000Z"); // EDT
    expect(iso("2030-11-03T02:30", "America/New_York")).toBe("2030-11-03T07:30:00.000Z"); // EST
  });

  it("round-trips through formatInZone", () => {
    for (const tz of ["America/New_York", "Europe/Berlin", "Australia/Lord_Howe", "Asia/Kathmandu"]) {
      for (const s of ["2030-02-01T23:59:00", "2030-07-01T08:15:00", "2030-10-06T01:45:00"]) {
        const d = parseInstant(s, tz)!;
        expect(formatInZone(d, tz).slice(0, 19)).toBe(s);
        expect(Math.abs(zoneOffsetMs(d.getTime(), tz) % 60_000)).toBe(0);
      }
    }
    expect(formatInZone(new Date("2030-02-02T04:59:00Z"), "America/New_York")).toBe("2030-02-01T23:59:00-05:00");
  });

  it("validates zone names", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
