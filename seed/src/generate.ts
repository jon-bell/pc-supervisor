// Generated scenarios (shadow, scale): a realistic spread of reviewing and
// discussion behavior from a fixed RNG seed. Same seed, same scenario.
//
// Per paper: one AC (metareview), `seniorPerPaper` senior PC reviews, and
// one junior-or-reciprocal review. Each paper has a latent quality; merits
// scatter around it. Some reviews are late or never arrive, some are thin,
// some reviewers move after discussion opens, ACs and reviewers vary in how
// much they comment, some papers get author responses, a few get decisions.

import {
  at,
  type Assignment,
  type Paper,
  type Person,
  type Scenario,
  type ScenarioEvent,
  type When,
} from "./format.js";
import { intBetween, mulberry32, pick, shuffled, weighted } from "./rng.js";

export interface GenerateOptions {
  name: string;
  description: string;
  seed: number;
  papers: number;
  acs: number;
  seniors: number;
  juniors: number;
  reciprocals: number;
  seniorPerPaper: number;
  /** Probability multipliers for discussion volume (1 = shadow-like). */
  commentRate: number;
  /** When the stage is observed. */
  now: When;
}

const FIRST = [
  "Alba", "Bram", "Cleo", "Dov", "Edda", "Fitz", "Gita", "Hale", "Ines", "Jory", "Kaia", "Lenz", "Mael", "Nell",
  "Oren", "Pia", "Quin", "Rhys", "Suvi", "Tove", "Ugo", "Vera", "Wim", "Xan", "Yara", "Zev",
];
const LAST = [
  "Ashgrove", "Birchley", "Cobbleford", "Dimmock", "Eversholt", "Fallowmere", "Gorsedge", "Hazelmoor", "Ivybridge",
  "Juniperhill", "Kestrelwood", "Larchmont", "Mossbank", "Nettlecombe", "Oakhurst", "Pebblebrook", "Quarrydale",
  "Rushmere", "Sedgefield", "Thistlewood", "Underhay", "Vetchley", "Willowcroft", "Yarrowby", "Zennor",
];
const TOPIC_A = ["Incremental", "Probabilistic", "Typed", "Scalable", "Lightweight", "Automated", "Differential", "Interactive", "Compositional", "Adaptive"];
const TOPIC_B = ["Slicing", "Fuzzing", "Repair", "Refactoring", "Testing", "Verification", "Debugging", "Mining", "Profiling", "Synthesis"];
const TOPIC_C = ["Build Systems", "Mobile Apps", "Smart Contracts", "Microservices", "Notebooks", "Compilers", "CI Pipelines", "Config Files", "ML Libraries", "Web APIs"];

function personName(i: number): { first: string; last: string } {
  // Unique by construction: FIRST x LAST x generation.
  const f = FIRST[i % FIRST.length]!;
  const l = LAST[Math.floor(i / FIRST.length) % LAST.length]!;
  const gen = Math.floor(i / (FIRST.length * LAST.length));
  return { first: f, last: gen === 0 ? l : `${l}${"abcdefghij"[gen - 1] ?? gen}` };
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function generateScenario(o: GenerateOptions): Scenario {
  const rng = mulberry32(o.seed);
  const people: Person[] = [];
  let n = 0;
  const mk = (kind: string, count: number, tags: string[]) =>
    Array.from({ length: count }, (_, i) => {
      const { first, last } = personName(n++);
      const email = `${kind}${i + 1}.${last.toLowerCase()}@example.org`;
      people.push({ email, first, last, affiliation: `${pick(rng, LAST)} University`, roles: ["pc"], tags });
      return email;
    });
  const acs = mk("ac", o.acs, []);
  const seniors = mk("sr", o.seniors, []);
  const juniors = mk("jr", o.juniors, ["junior"]);
  const recips = mk("rc", o.reciprocals, ["reciprocal"]);

  const papers: Paper[] = [];
  const assignments: Assignment[] = [];
  const events: ScenarioEvent[] = [];

  // Balanced loads: deal from shuffled decks, reshuffling when exhausted.
  const deck = (xs: readonly string[]) => {
    let cur: string[] = [];
    return (avoid: ReadonlySet<string>) => {
      for (let tries = 0; tries < 3 * xs.length + 10; tries++) {
        if (cur.length === 0) cur = shuffled(rng, xs);
        const x = cur.pop()!;
        if (!avoid.has(x)) return x;
        cur.unshift(x);
      }
      throw new Error("generateScenario: could not deal a distinct reviewer");
    };
  };
  const nextAc = deck(acs);
  const nextSenior = deck(seniors);
  const nextJunior = deck(juniors);
  const nextRecip = deck(recips);

  // Reviewer and AC temperaments: how likely they are to comment, and to be late.
  const chatty = new Map<string, number>();
  for (const p of people) chatty.set(p.email, weighted(rng, [[0.05, 1], [0.35, 2], [0.65, 4], [0.9, 2]]));
  const lateness = new Map<string, number>();
  for (const p of people) lateness.set(p.email, weighted(rng, [[0.02, 6], [0.15, 3], [0.4, 1]]));

  const d = (day: number, h: number, m: number): When =>
    at("discussionOpen", day, `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);

  for (let pid = 1; pid <= o.papers; pid++) {
    papers.push({
      pid,
      title: `${pick(rng, TOPIC_A)} ${pick(rng, TOPIC_B)} for ${pick(rng, TOPIC_C)} (${pid})`,
      authors: Array.from({ length: intBetween(rng, 1, 3) }, (_, k) => {
        const { first, last } = personName(100000 + pid * 3 + k);
        return { email: `author${pid}-${k + 1}@example.org`, first, last, affiliation: "Example University" };
      }),
    });
    const ac = nextAc(new Set());
    assignments.push({ pid, email: ac, role: "metareview" });
    const used = new Set<string>([ac]);
    const reviewers: string[] = [];
    for (let k = 0; k < o.seniorPerPaper; k++) {
      const s = nextSenior(used);
      used.add(s);
      reviewers.push(s);
      assignments.push({ pid, email: s, role: k === 0 ? "primary" : "secondary" });
    }
    const third = rng() < 0.5 ? nextJunior(used) : nextRecip(used);
    reviewers.push(third);
    assignments.push({ pid, email: third, role: "pcreview" });

    // Reviews.
    const quality = weighted(rng, [[1, 1], [2, 4], [3, 3], [4, 2], [5, 1]]);
    const merits = new Map<string, number>();
    const submitted: string[] = [];
    for (const [k, r] of reviewers.entries()) {
      const late = rng() < (lateness.get(r) ?? 0.1);
      if (late && rng() < 0.4) continue; // never arrives
      const merit = clamp(quality + weighted(rng, [[-2, 1], [-1, 4], [0, 8], [1, 4], [2, 1]]), 1, 5);
      merits.set(r, merit);
      submitted.push(r);
      const junior = k === reviewers.length - 1;
      const thin = rng() < 0.06;
      const words = thin ? intBetween(rng, 25, 120) : junior ? intBetween(rng, 150, 450) : intBetween(rng, 220, 700);
      const when = late
        ? at("reviewDue", intBetween(rng, 1, 6), `${String(intBetween(rng, 8, 20)).padStart(2, "0")}:${String(intBetween(rng, 0, 59)).padStart(2, "0")}`)
        : at("reviewDue", -intBetween(rng, 1, 14), `${String(intBetween(rng, 8, 22)).padStart(2, "0")}:${String(intBetween(rng, 0, 59)).padStart(2, "0")}`);
      events.push({
        type: "review",
        at: when,
        pid,
        email: r,
        scores: { OveMer: merit, RevExp: weighted(rng, [[1, 1], [2, 3], [3, 6], [4, 3]]) },
        words,
      });
    }
    const ms = [...merits.values()];
    const split = ms.length > 0 && Math.max(...ms) - Math.min(...ms) >= 2;

    // Score movement on split papers: an extreme reviewer moves one step inward.
    if (split && rng() < 0.4) {
      const lo = Math.min(...ms);
      const hi = Math.max(...ms);
      const mover = pick(rng, submitted.filter((r) => merits.get(r) === lo || merits.get(r) === hi));
      const m = merits.get(mover)!;
      events.push({ type: "scoreChange", at: d(intBetween(rng, 2, 11), intBetween(rng, 8, 20), intBetween(rng, 0, 59)), pid, email: mover, scores: { OveMer: m === lo ? m + 1 : m - 1 } });
    }

    // Author response.
    if (rng() < 0.45) {
      events.push({
        type: "response",
        key: `p${pid}-resp`,
        at: at("responseOpen", intBetween(rng, 0, 3), `${String(intBetween(rng, 8, 22)).padStart(2, "0")}:${String(intBetween(rng, 0, 59)).padStart(2, "0")}`),
        pid,
        email: papers[papers.length - 1]!.authors[0]!.email,
        words: intBetween(rng, 150, 600),
      });
    }

    // Discussion. Distinct (day, hour, minute) slots per paper keep times unique.
    let ck = 0;
    const slots = new Set<string>();
    const slot = (lo: number, hi: number): When => {
      for (;;) {
        const t: [number, number, number] = [intBetween(rng, lo, hi), intBetween(rng, 8, 22), intBetween(rng, 0, 59)];
        const k = t.join(":");
        if (!slots.has(k)) {
          slots.add(k);
          return d(...t);
        }
      }
    };
    const acRate = (chatty.get(ac) ?? 0.5) * o.commentRate;
    if (rng() < Math.min(0.95, acRate + 0.2)) {
      const silent = reviewers.filter((r) => (chatty.get(r) ?? 0) < 0.2);
      const mentions = silent.length > 0 && rng() < 0.5 ? [pick(rng, silent)] : undefined;
      events.push({ type: "comment", key: `p${pid}-c${++ck}`, pid, email: ac, at: slot(0, 4), ...(mentions ? { mentions } : {}) });
      if (rng() < acRate * 0.6) events.push({ type: "comment", key: `p${pid}-c${++ck}`, pid, email: ac, at: slot(5, 13) });
    }
    for (const r of submitted) {
      const rate = (chatty.get(r) ?? 0.3) * o.commentRate;
      let k = 0;
      while (k < 3 && rng() < rate * (k === 0 ? 1 : 0.5)) {
        const mentions = rng() < 0.1 ? [pick(rng, reviewers.filter((x) => x !== r))] : undefined;
        events.push({ type: "comment", key: `p${pid}-c${++ck}`, pid, email: r, at: slot(1, 13), ...(mentions ? { mentions } : {}) });
        k++;
      }
    }

    // A few early decisions (clear consensus).
    if (!split && ms.length >= 3 && rng() < 0.2) {
      events.push({ type: "decision", pid, decision: Math.min(...ms) >= 3 ? "Accepted" : "Rejected", at: slot(8, 13) });
    }
  }

  return {
    name: o.name,
    description: o.description,
    people,
    papers,
    assignments,
    stages: [{ name: "all", now: o.now, events }],
  };
}
