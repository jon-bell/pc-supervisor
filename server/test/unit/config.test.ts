import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  FIELD_NAMES,
  RULE_NAMES,
  RULE_WEIGHT_DEFAULTS,
  THRESHOLD_DEFAULTS,
  defaultDbPath,
  describeConfig,
  loadConfig,
  loadHotcrpConfig,
} from "../../src/config.js";
import { BASE_ENV } from "./env.js";

const load = (over: Record<string, string | undefined> = {}) => loadConfig({ ...BASE_ENV, ...over }, { home: "/home/u" });

function problems(over: Record<string, string | undefined>): Record<string, string> {
  try {
    load(over);
  } catch (e) {
    if (e instanceof ConfigError) return Object.fromEntries(e.problems.map((p) => [p.name, p.message]));
    throw e;
  }
  throw new Error("expected ConfigError");
}

describe("loadConfig defaults", () => {
  const c = load();

  it("fills every documented default", () => {
    expect(c.tz).toBe("America/New_York");
    expect(c.hotcrp).toMatchObject({ url: "http://127.0.0.1:8080", forceShow: true });
    expect(c.acRole).toEqual({ kind: "meta" });
    expect(c.tierTags).toEqual({});
    expect(c.fields).toEqual({ merit: "OveMer", expertise: "RevExp" });
    expect([c.meritAcceptMin, c.expertiseOkMin, c.reviewsRequired]).toEqual([3, 3, 3]);
    expect(c.sync).toEqual({ intervalMin: 15, chunk: 200, concurrency: 2, historyRps: 1 });
    expect(c.port).toBe(5317);
    expect(c.now).toBeUndefined();
    expect(c.phases.responseOpen).toBeUndefined();
    expect(c.db.key).toBeUndefined();
  });

  it("has every rule weight and threshold from spec §5c", () => {
    expect(c.rules.weights).toEqual({
      MISSING_REVIEWS: 3,
      SPLIT: 3,
      UNRESOLVED_SPLIT: 2,
      SILENT_DISCUSSION: 3,
      GONE_QUIET: 2,
      AC_ABSENT: 2,
      CHAMPION_MISSING: 1,
      LOW_EXPERTISE: 2,
      THIN_REVIEWS: 1,
      RESPONSE_UNADDRESSED: 2,
      DEADLINE_NO_CONSENSUS: 3,
    });
    expect(c.rules.thresholds).toEqual({
      SPLIT_RANGE: 2,
      STALE_DAYS: 4,
      UNRESOLVED_DAYS: 5,
      PING_DAYS: 3,
      MIN_WORDS: 150,
      DEADLINE_DAYS: 3,
    });
  });

  it("puts the DB under ~/.local/share/pc-supervisor/<host>.db", () => {
    expect(c.db.path).toBe("/home/u/.local/share/pc-supervisor/127.0.0.1_8080.db");
    expect(defaultDbPath("https://conf2027-shadow.hotcrp.com", "/h")).toBe(
      "/h/.local/share/pc-supervisor/conf2027-shadow.hotcrp.com.db",
    );
  });

  it("parses phase dates as local times in PCS_TZ", () => {
    // 2030-02-01 23:59 EST (UTC-5)
    expect(c.phases.reviewDue.toISOString()).toBe("2030-02-02T04:59:00.000Z");
    expect(c.phases.decisionsDue.toISOString()).toBe("2030-03-04T04:59:00.000Z");
  });
});

describe("loadConfig overrides", () => {
  it("treats empty strings as unset", () => {
    const c = load({ PCS_NOW: "", PCS_PORT: "", PCS_TZ: "  ", PCS_PHASE_RESPONSE_OPEN: "", PCS_PHASE_RESPONSE_CLOSE: "" });
    expect(c.now).toBeUndefined();
    expect(c.port).toBe(5317);
    expect(c.tz).toBe("America/New_York");
  });

  it("applies every kind of override", () => {
    const c = load({
      PCS_HOTCRP_URL: "https://conf.example.org/sub/",
      PCS_FORCE_SHOW: "false",
      PCS_TZ: "Europe/Berlin",
      PCS_NOW: "2030-02-26T12:00",
      PCS_PHASE_RESPONSE_OPEN: "2030-02-08T00:00",
      PCS_PHASE_RESPONSE_CLOSE: "2030-02-11T23:59",
      PCS_AC_ROLE: "tag:ac",
      PCS_TIER_TAGS: "junior=jr, reciprocal=recip",
      PCS_FIELD_MERIT: "Merit",
      PCS_MERIT_ACCEPT_MIN: "4",
      PCS_RULE_SPLIT_WEIGHT: "5",
      PCS_RULE_GONE_QUIET_WEIGHT: "0",
      PCS_THRESH_MIN_WORDS: "200",
      PCS_THRESH_STALE_DAYS: "2.5",
      PCS_DB_PATH: "~/pcs/test.db",
      PCS_DB_KEY: "k3y",
      PCS_SYNC_CHUNK: "50",
      PCS_HISTORY_RPS: "0.5",
      PCS_PORT: "6000",
    });
    expect(c.hotcrp.url).toBe("https://conf.example.org/sub");
    expect(c.hotcrp.forceShow).toBe(false);
    expect(c.now?.toISOString()).toBe("2030-02-26T11:00:00.000Z"); // CET = UTC+1
    expect(c.phases.responseOpen?.toISOString()).toBe("2030-02-07T23:00:00.000Z");
    expect(c.acRole).toEqual({ kind: "tag", tag: "ac" });
    expect(c.tierTags).toEqual({ junior: "jr", reciprocal: "recip" });
    expect(c.fields.merit).toBe("Merit");
    expect(c.meritAcceptMin).toBe(4);
    expect(c.rules.weights.SPLIT).toBe(5);
    expect(c.rules.weights.GONE_QUIET).toBe(0);
    expect(c.rules.weights.AC_ABSENT).toBe(RULE_WEIGHT_DEFAULTS.AC_ABSENT);
    expect(c.rules.thresholds.MIN_WORDS).toBe(200);
    expect(c.rules.thresholds.STALE_DAYS).toBe(2.5);
    expect(c.rules.thresholds.PING_DAYS).toBe(THRESHOLD_DEFAULTS.PING_DAYS);
    expect(c.db.path.endsWith("/pcs/test.db")).toBe(true);
    expect(c.db.key).toBe("k3y");
    expect(c.sync.chunk).toBe(50);
    expect(c.sync.historyRps).toBe(0.5);
    expect(c.port).toBe(6000);
  });

  it("accepts an explicit offset regardless of PCS_TZ", () => {
    expect(load({ PCS_NOW: "2030-02-26T12:00Z" }).now?.toISOString()).toBe("2030-02-26T12:00:00.000Z");
    expect(load({ PCS_NOW: "2030-02-26T12:00+02:00" }).now?.toISOString()).toBe("2030-02-26T10:00:00.000Z");
  });
});

describe("loadConfig errors", () => {
  it("lists every problem at once, one line per variable", () => {
    let err: unknown;
    try {
      loadConfig({
        NODE_ENV: "production",
        PCS_HOTCRP_URL: "http://127.0.0.1:8080",
        PCS_PORT: "abc",
        PCS_PHASE_REVIEW_DUE: "nope",
        PCS_PHASE_DISCUSSION_OPEN: "2030-02-12T00:00",
        PCS_PHASE_DISCUSSION_CLOSE: "2030-03-01T23:59",
        PCS_PHASE_DECISIONS_DUE: "2030-03-03T23:59",
        PCS_TZ: "Mars/Olympus",
        PCS_RULE_SPLT_WEIGHT: "3",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as ConfigError).message;
    expect(msg.split("\n")).toEqual([
      "Invalid configuration (6 problems):",
      "  PCS_HOTCRP_TOKEN: required (chair API token: HotCRP > Account settings > Developer)",
      '  PCS_TZ: unknown time zone "Mars/Olympus" (use an IANA name like America/New_York)',
      '  PCS_PHASE_REVIEW_DUE: expected an ISO date-time like 2027-01-15T23:59 (local to PCS_TZ), got "nope"',
      '  PCS_PORT: expected an integer from 1 to 65535, got "abc"',
      "  PCS_RULE_SPLT_WEIGHT: unknown setting (typo?); see .env.example for the full list",
      "  PCS_DB_KEY: required (SQLCipher key for the local DB; only NODE_ENV=test may omit it)",
      "Every setting is an environment variable; see .env.example.",
    ]);
  });

  it("rejects malformed values for each kind of variable", () => {
    const p = problems({
      PCS_HOTCRP_URL: "ftp://x",
      PCS_FORCE_SHOW: "maybe",
      PCS_AC_ROLE: "boss",
      PCS_TIER_TAGS: "junior",
      PCS_FIELD_EXPERTISE: "Rev Exp",
      PCS_RULE_SPLIT_WEIGHT: "-1",
      PCS_THRESH_MIN_WORDS: "lots",
      PCS_SYNC_CONCURRENCY: "0",
      PCS_HISTORY_RPS: "0",
      PCS_NOW: "2030-02-30T12:00",
    });
    expect(Object.keys(p).sort()).toEqual(
      [
        "PCS_HOTCRP_URL",
        "PCS_FORCE_SHOW",
        "PCS_AC_ROLE",
        "PCS_TIER_TAGS",
        "PCS_FIELD_EXPERTISE",
        "PCS_RULE_SPLIT_WEIGHT",
        "PCS_THRESH_MIN_WORDS",
        "PCS_SYNC_CONCURRENCY",
        "PCS_HISTORY_RPS",
        "PCS_NOW",
      ].sort(),
    );
  });

  it("rejects /api in the URL and date-only phase values", () => {
    const p = problems({ PCS_HOTCRP_URL: "https://c.example.org/api/", PCS_PHASE_REVIEW_DUE: "2030-02-01" });
    expect(p.PCS_HOTCRP_URL).toMatch(/without \/api/);
    expect(p.PCS_PHASE_REVIEW_DUE).toMatch(/ISO date-time/);
  });

  it("checks phase order and the response window pairing", () => {
    const p = problems({
      PCS_PHASE_DISCUSSION_OPEN: "2030-01-01T00:00",
      PCS_PHASE_RESPONSE_OPEN: "2030-02-08T00:00",
    });
    expect(p.PCS_PHASE_DISCUSSION_OPEN).toBe("must not be earlier than PCS_PHASE_REVIEW_DUE");
    expect(p.PCS_PHASE_RESPONSE_CLOSE).toMatch(/both/);
  });

  it("never echoes secret values", () => {
    const secret = "hct_has space";
    let msg = "";
    try {
      load({ PCS_HOTCRP_TOKEN: secret, PCS_DB_KEY: "a b" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/PCS_HOTCRP_TOKEN: must not contain whitespace/);
    expect(msg).toMatch(/PCS_DB_KEY: must not contain whitespace/);
    expect(msg).not.toContain("has space");
    expect(msg).not.toContain("a b");
  });

  it("requires PCS_DB_KEY outside NODE_ENV=test", () => {
    expect(problems({ NODE_ENV: undefined }).PCS_DB_KEY).toMatch(/required/);
    expect(load({ NODE_ENV: "production", PCS_DB_KEY: "x" }).db.key).toBe("x");
  });

  it("ignores script-only PCS_ENV_OUT", () => {
    expect(() => load({ PCS_ENV_OUT: "/tmp/x" })).not.toThrow();
  });
});

describe("loadHotcrpConfig", () => {
  it("needs only the HotCRP variables", () => {
    const c = loadHotcrpConfig({ PCS_HOTCRP_URL: "http://localhost:8080/", PCS_HOTCRP_TOKEN: "hct_x1234" });
    expect(c).toEqual({
      url: "http://localhost:8080",
      token: "hct_x1234",
      forceShow: true,
      sync: { chunk: 200, concurrency: 2, historyRps: 1 },
    });
  });

  it("still reports all of its problems together", () => {
    expect(() => loadHotcrpConfig({ PCS_SYNC_CHUNK: "x" })).toThrow(
      /PCS_HOTCRP_URL: required[\s\S]*PCS_HOTCRP_TOKEN: required[\s\S]*PCS_SYNC_CHUNK: expected an integer/,
    );
  });
});

describe("describeConfig", () => {
  it("redacts secrets", () => {
    const c = load({ PCS_DB_KEY: "sekrit-key" });
    const out = describeConfig(c).join("\n");
    expect(out).not.toContain(BASE_ENV.PCS_HOTCRP_TOKEN);
    expect(out).not.toContain("sekrit-key");
    expect(out).toContain("Review due        2030-02-01T23:59:00-05:00");
  });
});

describe(".env.example", () => {
  const text = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
  const documented = new Set([...text.matchAll(/^#?\s*(PCS_[A-Z0-9_]+)=/gm)].map((m) => m[1]));

  it("documents every variable in the schema", () => {
    expect(FIELD_NAMES.filter((n) => !documented.has(n))).toEqual([]);
  });

  it("documents nothing the schema doesn't know", () => {
    expect([...documented].filter((n) => !(FIELD_NAMES as string[]).includes(n!))).toEqual([]);
  });

  it("lists each rule weight line with its default", () => {
    for (const n of RULE_NAMES) {
      expect(text).toMatch(new RegExp(`^#?\\s*PCS_RULE_${n}_WEIGHT=${RULE_WEIGHT_DEFAULTS[n]}$`, "m"));
    }
  });
});
