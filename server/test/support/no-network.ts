// Unit tests must not touch the network: any real fetch fails loudly.
// Tests that exercise HTTP code inject a fake `fetch` instead.
import { beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("unit tests must not use the network; inject a fake fetch");
  });
});
