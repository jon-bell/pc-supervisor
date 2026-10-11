// Rule settings (spec §5c): the env/override overlay, validation with the env
// fields' own parsers, revisions and revert, the preview diff, and that the
// app has exactly one way to build a rule context. Synthetic data only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { FIELDS, loadConfig, RULE_NAMES, THRESHOLD_NAMES, type Config } from "../../src/config.js";
import { analyze, previewRules } from "../../src/rules/index.js";
import {
  applyChanges,
  diffOverrides,
  effectiveWeights,
  envSettings,
  flatSettings,
  overlay,
  parseSetting,
  RULE_META,
  sanitizeOverrides,
  SETTING_KEYS,
  SETTING_META,
} from "../../src/rules/settings.js";
import { effectiveRuleContext, effectiveSettings, revertRules, ruleContextAt, ruleContextWith, updateRules, type RuleSettingsError } from "../../src/rule-settings/service.js";
import { listRevisions, overridesAt } from "../../src/rule-settings/store.js";
import { memoryStore, type Store } from "../../src/store/store.js";
import { at, RULES_ENV } from "../fixtures/builder.js";
import { GOLDEN_EXPECTED, GOLDEN_NOW, goldenSnapshot } from "../fixtures/golden.js";

const cfgOf = (extra: Record<string, string> = {}): Config => loadConfig({ ...RULES_ENV, PCS_NOW: GOLDEN_NOW, ...extra });

describe("metadata", () => {
  it("covers every rule and every env rule setting, and nothing else", () => {
    expect(RULE_META.map((r) => r.name)).toEqual(RULE_NAMES);
    const expected = [
      ...RULE_NAMES.flatMap((r) => [`PCS_RULE_${r}_ENABLED`, `PCS_RULE_${r}_WEIGHT`]),
      ...THRESHOLD_NAMES.map((t) => `PCS_THRESH_${t}`),
      "PCS_MERIT_ACCEPT_MIN",
      "PCS_EXPERTISE_OK_MIN",
      "PCS_REVIEWS_REQUIRED",
    ];
    expect([...SETTING_KEYS].sort()).toEqual(expected.sort());
    for (const k of SETTING_KEYS) expect(Object.keys(FIELDS), k).toContain(k);
  });

  it("each number setting's stated range is exactly what its env field accepts", () => {
    for (const m of SETTING_META) {
      if (m.kind === "bool") continue;
      expect(parseSetting(m.key, m.min).ok, `${m.key} min`).toBe(true);
      expect(parseSetting(m.key, m.max).ok, `${m.key} max`).toBe(true);
      expect(parseSetting(m.key, m.min! - 1).ok, `${m.key} below`).toBe(false);
      expect(parseSetting(m.key, m.max! + 1).ok, `${m.key} above`).toBe(false);
    }
  });

  it("names a unit, description and the rules reading each threshold", () => {
    const stale = SETTING_META.find((m) => m.key === "PCS_THRESH_STALE_DAYS")!;
    expect(stale).toMatchObject({ unit: "days", rule: "GONE_QUIET", rules: ["GONE_QUIET"] });
    const split = SETTING_META.find((m) => m.key === "PCS_THRESH_SPLIT_RANGE")!;
    expect(split.rules).toEqual(["SPLIT", "UNRESOLVED_SPLIT", "DEADLINE_NO_CONSENSUS"]);
    for (const m of SETTING_META) expect(m.description.length, m.key).toBeGreaterThan(10);
  });
});

describe("validation", () => {
  it("uses the env parsers: same types and bounds", () => {
    expect(parseSetting("PCS_THRESH_STALE_DAYS", 7.5)).toEqual({ ok: true, value: 7.5 });
    expect(parseSetting("PCS_THRESH_STALE_DAYS", "7")).toEqual({ ok: true, value: 7 });
    expect(parseSetting("PCS_THRESH_STALE_DAYS", -1)).toMatchObject({ ok: false, error: expect.stringMatching(/at least 0/) });
    expect(parseSetting("PCS_THRESH_STALE_DAYS", "soon").ok).toBe(false);
    expect(parseSetting("PCS_THRESH_STALE_DAYS", true).ok).toBe(false);
    expect(parseSetting("PCS_THRESH_STALE_DAYS", Number.NaN).ok).toBe(false);
    expect(parseSetting("PCS_REVIEWS_REQUIRED", 2.5).ok).toBe(false);
    expect(parseSetting("PCS_REVIEWS_REQUIRED", 101).ok).toBe(false);
    expect(parseSetting("PCS_RULE_SPLIT_ENABLED", false)).toEqual({ ok: true, value: false });
    expect(parseSetting("PCS_RULE_SPLIT_ENABLED", "off")).toEqual({ ok: true, value: false });
    expect(parseSetting("PCS_RULE_SPLIT_ENABLED", 0).ok).toBe(false);
    expect(parseSetting("PCS_HOTCRP_URL", "http://x").ok).toBe(false);
    expect(parseSetting("PCS_THRESH_SPLT_RANGE", 2)).toMatchObject({ ok: false, error: expect.stringMatching(/unknown rule setting/) });
  });

  it("applyChanges is all-or-nothing; null resets to the env default", () => {
    const cur = { PCS_THRESH_STALE_DAYS: 7 };
    expect(applyChanges(cur, { PCS_THRESH_STALE_DAYS: null, PCS_RULE_SPLIT_WEIGHT: 5 })).toEqual({ overrides: { PCS_RULE_SPLIT_WEIGHT: 5 }, errors: [] });
    const bad = applyChanges(cur, { PCS_RULE_SPLIT_WEIGHT: 5, PCS_THRESH_MIN_WORDS: -3 });
    expect(bad.overrides).toBe(cur);
    expect(bad.errors.map((e) => e.key)).toEqual(["PCS_THRESH_MIN_WORDS"]);
  });

  it("sanitizes stored overrides this build no longer accepts", () => {
    expect(sanitizeOverrides({ PCS_THRESH_STALE_DAYS: 7, PCS_GONE: 1, PCS_REVIEWS_REQUIRED: 1000 })).toEqual({
      overrides: { PCS_THRESH_STALE_DAYS: 7 },
      dropped: ["PCS_GONE", "PCS_REVIEWS_REQUIRED"],
    });
  });
});

describe("overlay", () => {
  it("env defaults, then overrides on top; a disabled rule weighs 0", () => {
    const d = envSettings(cfgOf({ PCS_RULE_SPLIT_WEIGHT: "5", PCS_RULE_LOW_EXPERTISE_ENABLED: "false" }));
    expect(d.weights.SPLIT).toBe(5);
    expect(d.enabled.LOW_EXPERTISE).toBe(false);
    const s = overlay(d, { PCS_RULE_SPLIT_WEIGHT: 1, PCS_RULE_LOW_EXPERTISE_ENABLED: true, PCS_RULE_GONE_QUIET_ENABLED: false, PCS_THRESH_STALE_DAYS: 9, PCS_MERIT_ACCEPT_MIN: 4 });
    expect(s).toMatchObject({ meritAcceptMin: 4, thresholds: { STALE_DAYS: 9 } });
    expect(effectiveWeights(s)).toMatchObject({ SPLIT: 1, LOW_EXPERTISE: 2, GONE_QUIET: 0 });
    expect(flatSettings(d).PCS_THRESH_STALE_DAYS).toBe(4);
  });

  it("diffs effective values and whether each side was an override", () => {
    const d = envSettings(cfgOf());
    expect(diffOverrides(d, {}, { PCS_THRESH_STALE_DAYS: 4 })).toEqual([{ key: "PCS_THRESH_STALE_DAYS", from: 4, to: 4, fromOverride: false, toOverride: true }]);
    expect(diffOverrides(d, { PCS_THRESH_STALE_DAYS: 9 }, {})).toEqual([{ key: "PCS_THRESH_STALE_DAYS", from: 9, to: 4, fromOverride: true, toOverride: false }]);
    expect(diffOverrides(d, { PCS_THRESH_STALE_DAYS: 9 }, { PCS_THRESH_STALE_DAYS: 9 })).toEqual([]);
  });
});

describe("revisions (store)", () => {
  let store: Store;
  const cfg = cfgOf();
  const meta = (atLocal: string, note?: string) => ({ actor: "chair@example.org", atMs: at(atLocal), note });
  beforeEach(() => {
    store = memoryStore();
  });
  afterEach(() => store.close());

  it("saves append-only revisions with actor, time, diff and note; effective = env + latest", () => {
    expect(effectiveSettings(store, cfg).revision).toBeNull();
    const r1 = updateRules(store, cfg, { PCS_THRESH_STALE_DAYS: 7 }, meta("2030-02-20T09:00", "quiet papers are fine for a week"));
    const r2 = updateRules(store, cfg, { PCS_RULE_THIN_REVIEWS_ENABLED: false }, meta("2030-02-21T09:00"));
    expect(r1.revision).toMatchObject({ id: 1, kind: "set", actor: "chair@example.org", at: at("2030-02-20T09:00"), note: "quiet papers are fine for a week", overrides: { PCS_THRESH_STALE_DAYS: 7 } });
    expect(r2.revision.overrides).toEqual({ PCS_THRESH_STALE_DAYS: 7, PCS_RULE_THIN_REVIEWS_ENABLED: false });
    expect(r2.diff).toEqual([{ key: "PCS_RULE_THIN_REVIEWS_ENABLED", from: true, to: false, fromOverride: false, toOverride: true }]);
    const ctx = effectiveRuleContext(store, cfg, fixedClock(cfg.now!));
    expect(ctx.thresholds.STALE_DAYS).toBe(7);
    expect(ctx.weights.THIN_REVIEWS).toBe(0);
    expect(listRevisions(store.db).map((r) => r.id)).toEqual([2, 1]);
    expect(() => store.db.prepare("update rule_revision set actor = 'x'").run()).toThrow(/append-only/);
    expect(() => store.db.prepare("delete from rule_revision").run()).toThrow(/append-only/);
  });

  it("reverts to any revision or to the env defaults, as a new revision", () => {
    updateRules(store, cfg, { PCS_THRESH_STALE_DAYS: 7 }, meta("2030-02-20T09:00"));
    updateRules(store, cfg, { PCS_THRESH_STALE_DAYS: 10, PCS_RULE_SPLIT_WEIGHT: 1 }, meta("2030-02-21T09:00"));
    const back = revertRules(store, cfg, 1, meta("2030-02-22T09:00", "too aggressive"));
    expect(back.revision).toMatchObject({ id: 3, kind: "revert", revertedTo: 1, overrides: { PCS_THRESH_STALE_DAYS: 7 } });
    expect(back.diff.map((c) => c.key)).toEqual(["PCS_RULE_SPLIT_WEIGHT", "PCS_THRESH_STALE_DAYS"]);
    const env = revertRules(store, cfg, 0, meta("2030-02-23T09:00"));
    expect(env.revision.overrides).toEqual({});
    expect(effectiveRuleContext(store, cfg, fixedClock(cfg.now!)).thresholds.STALE_DAYS).toBe(4);
    expect(overridesAt(store.db, at("2030-02-21T12:00"))).toEqual({ PCS_THRESH_STALE_DAYS: 10, PCS_RULE_SPLIT_WEIGHT: 1 });
    expect(ruleContextAt(store, cfg, at("2030-02-20T12:00")).thresholds.STALE_DAYS).toBe(7);
    expect(ruleContextAt(store, cfg, at("2030-02-19T12:00")).thresholds.STALE_DAYS).toBe(4);
  });

  it("refuses invalid changes, no-ops and unknown revisions without writing", () => {
    const err = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e as RuleSettingsError;
      }
      throw new Error("did not throw");
    };
    expect(err(() => updateRules(store, cfg, { PCS_THRESH_STALE_DAYS: -1 }, meta("2030-02-20T09:00")))).toMatchObject({ code: "invalid", status: 400, errors: [{ key: "PCS_THRESH_STALE_DAYS" }] });
    expect(err(() => updateRules(store, cfg, [], meta("2030-02-20T09:00")))).toMatchObject({ code: "invalid" });
    expect(err(() => updateRules(store, cfg, { PCS_THRESH_STALE_DAYS: 7 }, meta("2030-02-20T09:00", "x".repeat(501))))).toMatchObject({ code: "invalid" });
    expect(err(() => updateRules(store, cfg, { PCS_THRESH_STALE_DAYS: null }, meta("2030-02-20T09:00")))).toMatchObject({ code: "no_change", status: 409 });
    expect(err(() => revertRules(store, cfg, 0, meta("2030-02-20T09:00")))).toMatchObject({ code: "no_change" });
    expect(err(() => revertRules(store, cfg, 9, meta("2030-02-20T09:00")))).toMatchObject({ code: "unknown_revision", status: 404 });
    expect(err(() => revertRules(store, cfg, -1, meta("2030-02-20T09:00")))).toMatchObject({ code: "invalid" });
    expect(listRevisions(store.db)).toEqual([]);
  });
});

describe("preview diff (golden fixture)", () => {
  const cfg = cfgOf();
  const now = at(GOLDEN_NOW);
  const current = analyze(goldenSnapshot(), ruleContextWith(cfg, {}, now)).evaluation;

  it("the documented override case: STALE_DAYS 13 unflags pid 6 only", () => {
    const p = previewRules(current, ruleContextWith(cfg, { PCS_THRESH_STALE_DAYS: 13 }, now));
    expect(p.changes).toEqual([
      { pid: 6, title: expect.any(String), from: ["GONE_QUIET"], to: [], gained: [], lost: ["GONE_QUIET"], severityFrom: 2, severityTo: 0 },
    ]);
    expect(p).toMatchObject({ papers: 13, newlyFlagged: 0, unflagged: 1, changesTotal: 1 });
    expect(p.current.byRule.GONE_QUIET).toBe(2);
    expect(p.proposed.byRule.GONE_QUIET).toBe(1);
    expect(p.proposed.flagged).toBe(p.current.flagged - 1);
  });

  it("lowering a threshold newly flags papers, listed first; weights change severity only", () => {
    // From a config where pid 6 is unflagged (quiet limit 13), back to a limit of 4.
    const relaxed = analyze(goldenSnapshot(), ruleContextWith(cfg, { PCS_THRESH_STALE_DAYS: 13 }, now)).evaluation;
    const p = previewRules(relaxed, ruleContextWith(cfg, { PCS_THRESH_STALE_DAYS: 4, PCS_RULE_SPLIT_WEIGHT: 10 }, now));
    expect(p.newlyFlagged).toBe(1);
    expect(p.changes[0]).toMatchObject({ pid: 6, severityFrom: 0, gained: ["GONE_QUIET"] });
    const split = p.changes.find((c) => c.pid === 3)!;
    expect(split).toMatchObject({ gained: [], lost: [], severityFrom: 3, severityTo: 10 });
  });

  it("disabling a rule removes it everywhere; no change = an empty diff", () => {
    const p = previewRules(current, ruleContextWith(cfg, { PCS_RULE_SPLIT_ENABLED: false }, now));
    expect(p.proposed.byRule.SPLIT).toBe(0);
    expect(p.changes.map((c) => c.pid).sort((a, b) => a - b)).toEqual([3, 4, 12]);
    expect(previewRules(current, ruleContextWith(cfg, {}, now)).changes).toEqual([]);
    expect(Object.keys(GOLDEN_EXPECTED)).toHaveLength(13);
  });
});

describe("one path to a rule context", () => {
  it("src/ builds rule contexts only through rule-settings/service.ts", () => {
    const root = fileURLToPath(new URL("../../src/", import.meta.url));
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          const rel = p.slice(root.length);
          if (rel === "rules/context.ts" || rel === "rule-settings/service.ts") continue;
          if (/ruleContextFromConfig\(|ruleContextFromSettings\(/.test(readFileSync(p, "utf8"))) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
