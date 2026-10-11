// The process report (spec §10.4 G, PLAN M13):
//   GET /api/report                     aggregates only (JSON)
//   GET /api/report/export.zip          the pseudonymous export (needs PCS_PSEUDONYM_KEY; 409 without it)
//   GET /api/report/export/:file        one export file (reviews.csv, reviewers.csv, manifest.csv, README.txt)
//   GET /api/report/do-not-invite.csv   the do-not-invite carry-forward (the chair's own list; keeps emails)
// Downloads go to the chair's browser on this machine; nothing is uploaded anywhere.

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  doNotInviteCsv,
  EXPORT_FILE_NAMES,
  exportFilesFrom,
  exportZip,
  processReportFrom,
  PseudonymKeyMissingError,
  REPORT_PATHS,
  type ExportFiles,
  type ProcessReport,
} from "../../modules/report/index.js";
import type { RouteDeps } from "../app.js";

const day = (deps: RouteDeps) => deps.clock.now().toISOString().slice(0, 10);

function attachment(reply: FastifyReply, name: string, type: string): FastifyReply {
  return reply.type(type).header("content-disposition", `attachment; filename="${name}"`);
}

function files(deps: RouteDeps, reply: FastifyReply): ExportFiles | null {
  try {
    return exportFilesFrom(deps.analysis.get(), deps.store, deps.cfg);
  } catch (e) {
    if (e instanceof PseudonymKeyMissingError) {
      void reply.code(409).send({ error: e.message });
      return null;
    }
    throw e;
  }
}

export function registerReport(app: FastifyInstance, deps: RouteDeps): void {
  app.get(REPORT_PATHS.report, async (): Promise<ProcessReport> =>
    processReportFrom(deps.analysis.get(), deps.store, deps.cfg, deps.clock, { quickReject: deps.quickReject }),
  );

  app.get(REPORT_PATHS.zip, async (_req, reply) => {
    const f = files(deps, reply);
    if (!f) return reply;
    return attachment(reply, `pcs-export-${day(deps)}.zip`, "application/zip").send(exportZip(f, deps.clock.now()));
  });

  app.get<{ Params: { file: string } }>(`${REPORT_PATHS.file}:file`, async (req, reply) => {
    const name = EXPORT_FILE_NAMES.find((n) => n === req.params.file);
    if (!name) return reply.code(404).send({ error: `no export file named that; one of ${EXPORT_FILE_NAMES.join(", ")}` });
    const f = files(deps, reply);
    if (!f) return reply;
    return attachment(reply, name, name.endsWith(".csv") ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8").send(f[name]);
  });

  app.get(REPORT_PATHS.doNotInvite, async (_req, reply) => {
    const { csv } = doNotInviteCsv(deps.store, deps.clock.now());
    return attachment(reply, `do-not-invite-${day(deps)}.csv`, "text/csv; charset=utf-8").send(csv);
  });
}
