// `pcs model ...` and `pcs classify` (spec §5e).
//
//   pcs model status             is the pinned model installed and verified?
//   pcs model fetch              THE ONE model download (AGENTS.md rule 4): the pinned files from the
//                                pinned URL, sha256-checked; sends no data. Chair-run only.
//   pcs model install <src>      the same files from a directory or .tar(.gz) you downloaded yourself
//   pcs model remove --yes       delete the installed model files
//   pcs model accuracy           confusion matrices on held-out synthetic data (heuristic, and the model if installed)
//   pcs model bench [--n N]      classify N synthetic comments end to end in memory; prints throughput
//   pcs classify                 classify new or changed comments in the local store now
//
// Output is counts, file names, hashes and timings only: never comment text.

import { clockFromConfig } from "../clock.js";
import { loadConfig, loadModelConfig, orExit } from "../config.js";
import { formatConfusion } from "../classifier/head.js";
import { benchPipeline, evaluateHeuristic, evaluateModel, type EvalResult } from "../classifier/evaluate.js";
import { fetchModel, installModel, MODEL, ModelFileError, removeModel, verifyModel } from "../classifier/model-files.js";
import { CommentClassifier, type RunStats } from "../classifier/service.js";
import { createWorkerEmbedder } from "../classifier/worker-embedder.js";
import { StoreError } from "../store/errors.js";
import { openStore } from "../store/store.js";
import type { Command } from "./main.js";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

const USAGE = "usage: pcs model status | fetch | install <dir|tarball> | remove --yes | accuracy | bench [--n N]";

/** "classified 120 comment(s) with the heuristic in 0.4 s (300/s)". */
export function describeRun(s: RunStats): string {
  if (s.classifier === "off") return "comment types: off (PCS_COMMENT_CLASSIFIER=off)";
  const rate = s.perSecond === null ? "" : ` (${Math.round(s.perSecond)}/s)`;
  const emb = s.classifier === "model" ? `, ${s.embedded} embedded` : "";
  return `comment types: ${s.classified} classified with the ${s.classifier}${emb} in ${(s.ms / 1000).toFixed(1)} s${rate}`;
}

function printEval(r: EvalResult): void {
  out(`\n${r.name}: held-out synthetic templates`);
  out(formatConfusion(r.heldOut));
  out(`${r.name}: hand-written hard set`);
  out(formatConfusion(r.hard));
}

async function model(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { modelDir } = orExit(() => loadModelConfig());
  try {
    switch (sub) {
      case "status": {
        const v = await verifyModel(modelDir);
        out(`model    ${MODEL.name}, licence ${MODEL.licence}`);
        out(`revision ${MODEL.repo}@${MODEL.revision}`);
        out(`dir      ${v.dir}`);
        out(`status   ${v.ok ? "installed, sha256 verified" : `not installed${v.missing.length ? `; missing ${v.missing.join(", ")}` : ""}${v.mismatched.length ? `; wrong sha256: ${v.mismatched.join(", ")}` : ""}`}`);
        if (!v.ok) out("         run `pcs model fetch`, or `pcs model install <dir|tarball>` with files you downloaded");
        return v.ok ? 0 : 1;
      }
      case "fetch": {
        if (rest.length) break;
        out(`pcs model fetch: downloading ${MODEL.name} (${MODEL.licence})`);
        out(`  from ${MODEL.baseUrl} (pinned revision; plain GETs, nothing is sent)`);
        out(`  into ${verifyModelDir(modelDir)}`);
        const v = await fetchModel(modelDir, { log: out });
        out(v.ok ? "model installed and verified" : "model NOT installed");
        return v.ok ? 0 : 1;
      }
      case "install": {
        if (rest.length !== 1) break;
        const v = await installModel(modelDir, rest[0]!, { log: out });
        out(v.ok ? `model installed and verified in ${v.dir}` : "model NOT installed");
        return v.ok ? 0 : 1;
      }
      case "remove": {
        if (rest.length !== 1 || rest[0] !== "--yes") {
          err(`pcs model remove: deletes ${verifyModelDir(modelDir)}; re-run as: pcs model remove --yes`);
          return 2;
        }
        removeModel(modelDir);
        out(`removed ${verifyModelDir(modelDir)}`);
        return 0;
      }
      case "accuracy": {
        if (rest.length) break;
        printEval(evaluateHeuristic());
        const v = await verifyModel(modelDir);
        if (!v.ok) {
          out("\nmodel: not installed (pcs model fetch); skipped");
          return 0;
        }
        const e = await createWorkerEmbedder(modelDir);
        try {
          printEval(await evaluateModel(e, "model (head trained on the training templates only)"));
        } finally {
          await e.close?.();
        }
        return 0;
      }
      case "bench": {
        let n = 10_000;
        if (rest.length === 2 && rest[0] === "--n" && /^\d+$/.test(rest[1]!)) n = Number(rest[1]);
        else if (rest.length) break;
        const v = await verifyModel(modelDir);
        out(`pcs model bench: ${n} synthetic comments, in memory (no store, no text from your conference)`);
        out(describeRun(await benchPipeline(n, { mode: "heuristic", modelDir })));
        if (v.ok) out(`${describeRun(await benchPipeline(n, { mode: "model", modelDir }))} (includes embedding the synthetic training set)`);
        else out("model: not installed; skipped");
        return 0;
      }
    }
  } catch (e) {
    if (e instanceof ModelFileError) {
      err(`pcs model: ${e.message}`);
      return 1;
    }
    throw e;
  }
  err(USAGE);
  return 2;
}

const verifyModelDir = (dir: string) => `${dir}/${MODEL.subdir}`;

export const MODEL_COMMANDS: Record<string, Command> = {
  model: {
    summary: "Local comment-classifier model: status, fetch (the one chair-run download), install, remove, accuracy, bench",
    usage: USAGE,
    run: model,
  },
  classify: {
    summary: "Classify new or changed comments in the local store now (ping / reply / discussion / non-substantive)",
    usage: "pcs classify",
    async run(args) {
      if (args.length) {
        err("usage: pcs classify");
        return 2;
      }
      const cfg = orExit(() => loadConfig());
      let store;
      try {
        store = openStore(cfg);
      } catch (e) {
        if (e instanceof StoreError) {
          err(`pcs classify: ${e.message}`);
          return 1;
        }
        throw e;
      }
      const c = new CommentClassifier(store, cfg, clockFromConfig(cfg), { log: err });
      try {
        const active = await c.active();
        const st = await c.status();
        if (st.fallback) err(`pcs classify: ${st.fallback}`);
        if (active === "off") {
          out("comment types: off (PCS_COMMENT_CLASSIFIER=off)");
          return 0;
        }
        out(describeRun(await c.run()));
        const after = await c.status();
        out(`  ${after.labelled} of ${after.comments} comment(s) labelled; ${after.chairLabels} by you; ${Object.entries(after.byKind).map(([k, n]) => `${k}=${n}`).join(" ")}`);
        return 0;
      } finally {
        await c.close();
        store.close();
      }
    },
  },
};
