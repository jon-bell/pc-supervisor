// Scenario registry. Scenarios load lazily (scale is generated on import).

import type { Scenario } from "./format.js";

export const SCENARIO_NAMES = ["golden", "multistage", "shadow", "scale"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export function isScenarioName(s: string): s is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(s);
}

export async function loadScenario(name: ScenarioName): Promise<Scenario> {
  switch (name) {
    case "golden":
      return (await import("../scenarios/golden/scenario.js")).scenario;
    case "multistage":
      return (await import("../scenarios/multistage/scenario.js")).scenario;
    case "shadow":
      return (await import("../scenarios/shadow/scenario.js")).scenario;
    case "scale":
      return (await import("../scenarios/scale/scenario.js")).scenario;
  }
}
