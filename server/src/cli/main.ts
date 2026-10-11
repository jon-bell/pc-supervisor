// `pcs` CLI. Subcommands register in COMMANDS below; each returns an exit code.
// probe (M0) lives in ../probe/. sync / backfill / wipe (M3) live in ./store-commands.ts. serve (M5) in ./serve.ts.

import { describeConfig, loadConfig, orExit } from "../config.js";
import { PROBE_USAGE, runProbe } from "../probe/command.js";
import { ASSIGNMENT_COMMANDS } from "./assignment-command.js";
import { IMPORT_COMMANDS } from "./import-command.js";
import { MODULE_COMMANDS } from "./modules-command.js";
import { PROGRESS_COMMANDS } from "./progress-command.js";
import { REPORT_COMMANDS } from "./report-command.js";
import { SERVE_COMMAND } from "./serve.js";
import { SOLVER_COMMANDS } from "./solver-command.js";
import { STORE_COMMANDS } from "./store-commands.js";
import { RULES_COMMANDS } from "./rules-command.js";

export interface Command {
  summary: string;
  usage?: string;
  run(args: string[]): Promise<number> | number;
}

export const COMMANDS: Record<string, Command> = {
  ...STORE_COMMANDS,
  ...IMPORT_COMMANDS,
  ...ASSIGNMENT_COMMANDS,
  ...SOLVER_COMMANDS,
  ...MODULE_COMMANDS,
  ...PROGRESS_COMMANDS,
  ...REPORT_COMMANDS,
  ...RULES_COMMANDS,
  serve: SERVE_COMMAND,
  "config-check": {
    summary: "Validate every PCS_* variable and print a summary (secrets redacted)",
    run() {
      const cfg = orExit(() => loadConfig());
      process.stdout.write(`Configuration OK\n${describeConfig(cfg).map((l) => `  ${l}`).join("\n")}\n`);
      return 0;
    },
  },
  probe: {
    summary: "Read-only shape report of the HotCRP instance (no content; safe on the real one)",
    usage: PROBE_USAGE,
    run: (args) => runProbe(args),
  },
  help: {
    summary: "Show this help",
    run() {
      process.stdout.write(helpText());
      return 0;
    },
  },
};

function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  const lines = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`);
  return `Usage: pcs <command> [args]\n\nCommands:\n${lines.join("\n")}\n\nConfiguration is environment variables only; see .env.example.\n`;
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === "--help" || name === "-h") {
    process.stdout.write(helpText());
    return name === undefined ? 2 : 0;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    process.stderr.write(`pcs: unknown command "${name}"\n\n${helpText()}`);
    return 2;
  }
  return cmd.run(args);
}

