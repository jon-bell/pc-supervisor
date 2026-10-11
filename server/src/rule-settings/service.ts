// Effective rule settings = env defaults + the chair's overrides from the
// store (spec §5c "Rule settings"). effectiveRuleContext() is THE way the
// app builds a RuleContext: triage, AC/lead/reviewer metrics, the overview
// and burndown, the modules and report, the CLI, and flag history all go
// through it, so they always agree. (server/test/unit/rule-settings.test.ts
// fails if src/ builds one any other way.)
//
// Changes (updateRules / revertRules) append a rule_revision row with the
// actor, the clock's time, the effective diff and an optional note. They
// never call HotCRP; the analysis cache keys on the latest revision id, so
// the next read re-evaluates.

import { fixedClock, type Clock } from "../clock.js";
import type { Config } from "../config.js";
import { ruleContextFromConfig, type RuleContext } from "../rules/context.js";
import { applyChanges, diffOverrides, envSettings, overlay, type Overrides, type RuleSettings, type SettingChange, type ChangeError } from "../rules/settings.js";
import type { Store } from "../store/store.js";
import { currentOverrides, getRevision, insertRevision, overridesAt, type RuleRevision } from "./store.js";

type Cfg = Pick<Config, "rules" | "meritAcceptMin" | "expertiseOkMin" | "reviewsRequired" | "phases">;

export interface EffectiveSettings {
  defaults: RuleSettings;
  overrides: Overrides;
  settings: RuleSettings;
  /** The revision in force; null = none (env defaults). */
  revision: RuleRevision | null;
}

export function effectiveSettings(store: Pick<Store, "db">, cfg: Cfg): EffectiveSettings {
  const defaults = envSettings(cfg);
  const { revision, overrides } = currentOverrides(store.db);
  return { defaults, overrides, settings: overlay(defaults, overrides), revision };
}

/** The rule context the app uses: env defaults + the store's overrides, at the clock's instant. */
export function effectiveRuleContext(store: Pick<Store, "db">, cfg: Cfg, clock: Clock): RuleContext {
  return ruleContextFromConfig(cfg, clock, currentOverrides(store.db).overrides);
}

/** The rule context at a past instant (ms), with the overrides in force then (flag-history reconstruction). */
export function ruleContextAt(store: Pick<Store, "db">, cfg: Cfg, atMs: number): RuleContext {
  return ruleContextFromConfig(cfg, fixedClock(new Date(atMs)), overridesAt(store.db, atMs));
}

/** The rule context for proposed overrides at an instant (ms): the rules preview. */
export function ruleContextWith(cfg: Cfg, overrides: Overrides, atMs: number): RuleContext {
  return ruleContextFromConfig(cfg, fixedClock(new Date(atMs)), overrides);
}

export type RuleSettingsErrorCode = "invalid" | "unknown_revision" | "no_change";

export class RuleSettingsError extends Error {
  readonly status: number;
  constructor(
    readonly code: RuleSettingsErrorCode,
    message: string,
    readonly errors: ChangeError[] = [],
  ) {
    super(message);
    this.name = "RuleSettingsError";
    this.status = code === "unknown_revision" ? 404 : code === "no_change" ? 409 : 400;
  }
}

export const MAX_NOTE = 500;

export interface ChangeMeta {
  actor: string;
  atMs: number;
  note?: unknown;
}

function note(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new RuleSettingsError("invalid", "note must be a string");
  const s = v.trim();
  if (s.length > MAX_NOTE) throw new RuleSettingsError("invalid", `note is longer than ${MAX_NOTE} characters`);
  return s === "" ? null : s;
}

export interface ChangeResult {
  revision: RuleRevision;
  diff: SettingChange[];
}

/**
 * Validate and save `changes` (key -> value, or null = back to the env
 * default). Throws RuleSettingsError: invalid (with per-key errors), or
 * no_change when nothing would change.
 */
export function updateRules(store: Pick<Store, "db">, cfg: Cfg, changes: unknown, meta: ChangeMeta): ChangeResult {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new RuleSettingsError("invalid", "changes must be an object of setting -> value (null = env default)");
  }
  const n = note(meta.note);
  const cur = effectiveSettings(store, cfg);
  const { overrides, errors } = applyChanges(cur.overrides, changes as Record<string, unknown>);
  if (errors.length) throw new RuleSettingsError("invalid", errors.map((e) => `${e.key}: ${e.error}`).join("; "), errors);
  const diff = diffOverrides(cur.defaults, cur.overrides, overrides);
  if (diff.length === 0) throw new RuleSettingsError("no_change", "nothing to change: the settings already have these values");
  const revision = insertRevision(store.db, { atMs: meta.atMs, actor: meta.actor, kind: "set", note: n, overrides, diff });
  return { revision, diff };
}

/** Restore revision `to`'s overrides (0 = the env defaults, i.e. no overrides) as a new revision. */
export function revertRules(store: Pick<Store, "db">, cfg: Cfg, to: unknown, meta: ChangeMeta): ChangeResult {
  if (typeof to !== "number" || !Number.isSafeInteger(to) || to < 0) throw new RuleSettingsError("invalid", "to must be a revision id (0 = env defaults)");
  const n = note(meta.note);
  let target: Overrides = {};
  if (to > 0) {
    const r = getRevision(store.db, to);
    if (!r) throw new RuleSettingsError("unknown_revision", `no rule revision #${to}`);
    target = r.overrides;
  }
  const cur = effectiveSettings(store, cfg);
  const diff = diffOverrides(cur.defaults, cur.overrides, target);
  if (diff.length === 0) throw new RuleSettingsError("no_change", to === 0 ? "already on the env defaults" : `already the same as revision #${to}`);
  const revision = insertRevision(store.db, { atMs: meta.atMs, actor: meta.actor, kind: "revert", revertedTo: to, note: n, overrides: target, diff });
  return { revision, diff };
}
