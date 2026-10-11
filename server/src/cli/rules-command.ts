// `pcs rules show|set|preview|history|revert` (spec §5c "Rule settings"):
// the chair's rule overrides from the terminal, the same store and
// validation as the Rules page. Output: setting names, numbers, revision
// ids, paper numbers. No HotCRP call except one /whoami for the actor.
//
//   pcs rules show [--json]
//   pcs rules set KEY=VALUE... [--note TEXT]     VALUE `default` = back to env
//   pcs rules preview KEY=VALUE...               what would change; saves nothing
//   pcs rules history [--limit N]
//   pcs rules revert ID|defaults [--note TEXT]
//
// KEY is the env variable name (PCS_THRESH_STALE_DAYS); the PCS_ prefix may
// be left out (THRESH_STALE_DAYS, RULE_SPLIT_WEIGHT).

import { clockFromConfig } from "../clock.js";
import { loadConfig, orExit, type Config } from "../config.js";
import { clientFromConfig } from "../hotcrp/client.js";
import { recordStoreFlags } from "../history/flags.js";
import { evaluateAll } from "../rules/evaluate.js";
import { previewRules } from "../rules/preview.js";
import { applyChanges, describeChange, flatSettings, SETTING_META, type SettingChange } from "../rules/settings.js";
import { whoamiActor } from "../rule-settings/actor.js";
import { effectiveRuleContext, effectiveSettings, revertRules, ruleContextWith, RuleSettingsError, updateRules } from "../rule-settings/service.js";
import { listRevisions } from "../rule-settings/store.js";
import { StoreError } from "../store/errors.js";
import { openStore, type Store } from "../store/store.js";
import { buildSnapshot, snapshotOptions } from "../views/snapshot.js";
import { formatInZone } from "../tz.js";
import type { Command } from "./main.js";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

export const RULES_USAGE = `usage:
  pcs rules show [--json]
  pcs rules set KEY=VALUE... [--note TEXT]     (VALUE "default" = back to the env default)
  pcs rules preview KEY=VALUE...
  pcs rules history [--limit N]
  pcs rules revert ID|defaults [--note TEXT]`;

const iso = (ms: number, tz: string) => formatInZone(new Date(ms), tz).slice(0, 16).replace("T", " ");

function normKey(k: string): string {
  const u = k.trim().toUpperCase();
  return u.startsWith("PCS_") ? u : `PCS_${u}`;
}

/** KEY=VALUE pairs and --note; null on a usage error (already reported). */
function parseArgs(args: string[]): { changes: Record<string, string | null>; note?: string; rest: string[] } | null {
  const changes: Record<string, string | null> = {};
  const rest: string[] = [];
  let note: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--note") {
      if (args[i + 1] === undefined) {
        err(`pcs rules: --note needs a value\n${RULES_USAGE}`);
        return null;
      }
      note = args[++i];
    } else if (a.includes("=")) {
      const at = a.indexOf("=");
      const v = a.slice(at + 1).trim();
      changes[normKey(a.slice(0, at))] = v.toLowerCase() === "default" ? null : v;
    } else rest.push(a);
  }
  return { changes, ...(note !== undefined ? { note } : {}), rest };
}

function withStore(cfg: Config, f: (store: Store) => number | Promise<number>): Promise<number> {
  let store: Store;
  try {
    store = openStore(cfg);
  } catch (e) {
    if (e instanceof StoreError) {
      err(`pcs rules: ${e.message}`);
      return Promise.resolve(1);
    }
    throw e;
  }
  return Promise.resolve()
    .then(() => f(store))
    .finally(() => store.close());
}

const printDiff = (diff: readonly SettingChange[]) => {
  for (const c of diff) out(`  ${describeChange(c)}`);
};

function show(store: Store, cfg: Config, json: boolean): number {
  const eff = effectiveSettings(store, cfg);
  const values = flatSettings(eff.settings);
  const defaults = flatSettings(eff.defaults);
  if (json) {
    out(
      JSON.stringify(
        {
          revision: eff.revision?.id ?? 0,
          settings: SETTING_META.map((m) => ({ key: m.key, value: values[m.key], default: defaults[m.key], overridden: eff.overrides[m.key] !== undefined })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  out(eff.revision ? `rule settings: revision #${eff.revision.id} (${iso(eff.revision.at, cfg.tz)} by ${eff.revision.actor})` : "rule settings: env defaults (no revisions)");
  const w = Math.max(...SETTING_META.map((m) => m.key.length));
  for (const m of SETTING_META) {
    const over = eff.overrides[m.key] !== undefined;
    out(`  ${m.key.padEnd(w)}  ${String(values[m.key]).padStart(7)}${over ? `  (override; env default ${defaults[m.key]})` : ""}${m.unit ? `  ${m.unit}` : ""}`);
  }
  return 0;
}

function preview(store: Store, cfg: Config, changes: Record<string, string | null>): number {
  const eff = effectiveSettings(store, cfg);
  const { overrides, errors } = applyChanges(eff.overrides, changes);
  if (errors.length) {
    for (const e of errors) err(`pcs rules: ${e.key}: ${e.error}`);
    return 2;
  }
  const clock = clockFromConfig(cfg);
  const ctx = effectiveRuleContext(store, cfg, clock);
  const ev = evaluateAll(buildSnapshot(store, snapshotOptions(cfg)), ctx);
  const p = previewRules(ev, ruleContextWith(cfg, overrides, ctx.now));
  out(`flagged papers: ${p.current.flagged} -> ${p.proposed.flagged} of ${p.papers} (${p.newlyFlagged} newly flagged, ${p.unflagged} unflagged)`);
  for (const m of SETTING_META.filter((x) => x.kind === "bool")) {
    const r = m.rule!;
    if (p.current.byRule[r] !== p.proposed.byRule[r]) out(`  ${r}: ${p.current.byRule[r]} -> ${p.proposed.byRule[r]}`);
  }
  for (const c of p.changes.slice(0, 50)) {
    const parts = [...c.gained.map((r) => `+${r}`), ...c.lost.map((r) => `-${r}`)];
    out(`  #${c.pid}: severity ${c.severityFrom} -> ${c.severityTo}${parts.length ? ` (${parts.join(" ")})` : ""}`);
  }
  if (p.changesTotal > 50) out(`  ... and ${p.changesTotal - 50} more`);
  return 0;
}

async function commit(store: Store, cfg: Config, run: (actor: string, atMs: number) => ReturnType<typeof updateRules>): Promise<number> {
  const clock = clockFromConfig(cfg);
  const actor = await whoamiActor(clientFromConfig(cfg.hotcrp))();
  try {
    const r = run(actor, clock.now().getTime());
    out(`saved rule revision #${r.revision.id}${r.revision.kind === "revert" ? ` (revert to ${r.revision.revertedTo === 0 ? "env defaults" : `#${r.revision.revertedTo}`})` : ""}`);
    printDiff(r.diff);
    const h = recordStoreFlags(store, cfg, clock, { cause: "rules", revisionId: r.revision.id });
    out(`flag history: ${h.raised} raised, ${h.cleared} cleared`);
    return 0;
  } catch (e) {
    if (e instanceof RuleSettingsError) {
      if (e.errors.length) for (const x of e.errors) err(`pcs rules: ${x.key}: ${x.error}`);
      else err(`pcs rules: ${e.message}`);
      return e.code === "no_change" ? 1 : 2;
    }
    throw e;
  }
}

export const RULES_COMMANDS: Record<string, Command> = {
  rules: {
    summary: "Show, change, preview, list or revert the chair's rule settings (env = defaults; overrides in the local DB)",
    usage: RULES_USAGE,
    async run(args) {
      const [sub, ...rest] = args;
      const p = parseArgs(rest);
      if (!p) return 2;
      const n = Object.keys(p.changes).length;
      const bad = (msg: string) => {
        err(`pcs rules ${sub ?? ""}: ${msg}\n${RULES_USAGE}`);
        return 2;
      };
      switch (sub) {
        case "show": {
          if (n || p.rest.some((a) => a !== "--json") || p.note !== undefined) return bad("unexpected argument");
          const cfg = orExit(() => loadConfig());
          return withStore(cfg, (s) => show(s, cfg, p.rest.includes("--json")));
        }
        case "set":
        case "preview": {
          if (!n || p.rest.length) return bad(p.rest.length ? `unexpected argument ${JSON.stringify(p.rest[0])}` : "give at least one KEY=VALUE");
          if (sub === "preview" && p.note !== undefined) return bad("--note is for set");
          const cfg = orExit(() => loadConfig());
          if (sub === "preview") return withStore(cfg, (s) => preview(s, cfg, p.changes));
          return withStore(cfg, (s) => commit(s, cfg, (actor, atMs) => updateRules(s, cfg, p.changes, { actor, atMs, note: p.note })));
        }
        case "history": {
          let limit = 50;
          if (p.rest[0] === "--limit" && /^\d+$/.test(p.rest[1] ?? "") && p.rest.length === 2) limit = Number(p.rest[1]);
          else if (p.rest.length || n) return bad("unexpected argument");
          const cfg = orExit(() => loadConfig());
          return withStore(cfg, (s) => {
            const revs = listRevisions(s.db, { limit });
            if (revs.length === 0) out("no rule revisions: the env defaults apply");
            for (const r of revs) {
              const what = r.kind === "revert" ? `revert to ${r.revertedTo === 0 ? "env defaults" : `#${r.revertedTo}`}` : "set";
              out(`#${r.id}  ${iso(r.at, cfg.tz)}  ${r.actor}  ${what}${r.note ? `  "${r.note}"` : ""}`);
              printDiff(r.diff);
            }
            return 0;
          });
        }
        case "revert": {
          const target = p.rest[0];
          if (n || p.rest.length !== 1 || !(target === "defaults" || /^\d+$/.test(target ?? ""))) return bad("give one revision id, or `defaults`");
          const to = target === "defaults" ? 0 : Number(target);
          const cfg = orExit(() => loadConfig());
          return withStore(cfg, (s) => commit(s, cfg, (actor, atMs) => revertRules(s, cfg, to, { actor, atMs, note: p.note })));
        }
        default:
          return bad(sub === undefined ? "missing subcommand" : `unknown subcommand ${JSON.stringify(sub)}`);
      }
    },
  },
};
