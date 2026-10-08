// GET /api/search-completions: tags (with paper counts), PC members, HotCRP
// keywords, values and "Search in" collections for the filter box's
// autocomplete (search-completions.ts). Cached; read-only.

import type { FastifyInstance } from "fastify";
import type { SearchCompletionsResponse } from "../api-types.js";
import type { RouteDeps } from "../app.js";

export function registerSearchCompletions(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/search-completions", async (): Promise<SearchCompletionsResponse> => deps.searchCompletions.get());
}
