// ~150 papers with a realistic spread (shadow-PC sized), for demos and manual
// UI work. Generated from a fixed seed: identical on every run.

import { at } from "../../src/format.js";
import { generateScenario } from "../../src/generate.js";

export const scenario = generateScenario({
  name: "shadow",
  description: "150 papers, 10 ACs, 45 senior + 15 junior + 10 reciprocal reviewers; realistic spread",
  seed: 20300212,
  papers: 150,
  acs: 10,
  seniors: 45,
  juniors: 15,
  reciprocals: 10,
  seniorPerPaper: 2,
  commentRate: 1,
  now: at("discussionOpen", 14, "12:00"),
});

export default scenario;
