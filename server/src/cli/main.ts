// `pcs` CLI. Subcommands register in COMMANDS below; each returns an exit code.
// Planned: probe (M0), sync / sync --watch / backfill / wipe (M3), serve (M5).

import { describeConfig, loadConfig, orExit } from "../config.js";
import { STORE_COMMANDS } from "./store-commands.js";

export interface Command {
  summary: string;
  usage?: string;
  run(args: string[]): Promise<number> | number;
}

export const COMMANDS: Record<string, Command> = {
  ...STORE_COMMANDS,
  "config-check": {
    summary: "Validate every PCS_* variable and print a summary (secrets redacted)",
    run() {
      const cfg = orExit(() => loadConfig());
      process.stdout.write(`Configuration OK\n${describeConfig(cfg).map((l) => `  ${l}`).join("\n")}\n`);
      return 0;
    },
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

