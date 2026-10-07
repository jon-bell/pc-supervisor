// The large-conference target (spec §10, PLAN M7): 2,400 papers, 40 ACs,
// 2 senior PC reviews + 1 junior/reciprocal review per paper plus the AC's
// metareview (9,600 review rows). Generated from a fixed seed.

import { at } from "../../src/format.js";
import { generateScenario } from "../../src/generate.js";

export const scenario = generateScenario({
  name: "scale",
  description: "2,400 papers, 40 ACs, 400 senior + 120 junior + 120 reciprocal reviewers, ~9.6k review rows",
  seed: 2400,
  papers: 2400,
  acs: 40,
  seniors: 400,
  juniors: 120,
  reciprocals: 120,
  seniorPerPaper: 2,
  commentRate: 0.8,
  now: at("discussionOpen", 14, "12:00"),
});

export default scenario;
