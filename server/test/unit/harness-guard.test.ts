import { describe, expect, it } from "vitest";
import {
  assertHarnessUrl,
  checkHarnessAdmin,
  checkPublishedPort,
  harnessAdminEmail,
  harnessProject,
  isHarnessUrl,
  NotHarnessError,
} from "../../src/hotcrp/harness-guard.js";
import { verifyHarness, type HarnessProbe } from "../../src/hotcrp/harness-verify.js";

describe("harness guard", () => {
  it.each(["http://127.0.0.1:8080", "http://localhost:18080/", "https://localhost", "http://[::1]:8080"])("allows %s", (url) => {
    expect(isHarnessUrl(url)).toBe(true);
    expect(assertHarnessUrl({ PCS_HOTCRP_URL: url })).toBe(url);
  });

  it.each([
    "https://conf2027-shadow.hotcrp.com",
    "http://127.0.0.1.evil.example.org",
    "http://localhost.example.org:8080",
    "http://10.0.0.5:8080",
    "http://user@localhost:8080",
    "ftp://localhost",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isHarnessUrl(url)).toBe(false);
    expect(() => assertHarnessUrl({ PCS_HOTCRP_URL: url })).toThrow(NotHarnessError);
  });

  it("refuses when unset, and says how to fix it", () => {
    expect(() => assertHarnessUrl({})).toThrow(/hotcrp-up\.sh/);
  });

  it("does not echo the full URL of a non-harness host", () => {
    expect(() => assertHarnessUrl({ PCS_HOTCRP_URL: "https://real.example.org/conf?x=1" })).toThrow(
      /host real\.example\.org is not 127\.0\.0\.1\/localhost/,
    );
  });
});

describe("disposable-harness check (harness-verify)", () => {
  const env = { PCS_HOTCRP_URL: "http://127.0.0.1:18082", PCS_HOTCRP_TOKEN: "hct_unit", HOTCRP_COMPOSE_PROJECT: "pcs-ci" };
  const probe = (email: string, addr: string, seen: string[] = []): HarnessProbe => ({
    whoamiEmail: async (url) => {
      seen.push(`whoami ${url}`);
      return email;
    },
    publishedAddress: async (project) => {
      seen.push(`port ${project}`);
      return addr;
    },
  });

  it("passes for the harness chair on the compose project's port", async () => {
    const seen: string[] = [];
    await expect(verifyHarness(env, probe("admin@example.org", "127.0.0.1:18082\n", seen))).resolves.toBe(env.PCS_HOTCRP_URL);
    expect(seen).toEqual(["port pcs-ci", "whoami http://127.0.0.1:18082"]);
  });

  it("refuses a token that isn't the harness chair (e.g. a port-forward to a real instance)", async () => {
    await expect(verifyHarness(env, probe("chair@real-conf.example.org", "127.0.0.1:18082"))).rejects.toThrow(
      /belongs to chair@real-conf\.example\.org, not the harness chair admin@example\.org/,
    );
  });

  it("honors HOTCRP_ADMIN_EMAIL", async () => {
    const e = { ...env, HOTCRP_ADMIN_EMAIL: "chair@example.org" };
    await expect(verifyHarness(e, probe("chair@example.org", "127.0.0.1:18082"))).resolves.toBe(env.PCS_HOTCRP_URL);
    await expect(verifyHarness(e, probe("admin@example.org", "127.0.0.1:18082"))).rejects.toThrow(NotHarnessError);
  });

  it("refuses when the compose project publishes a different port, before calling HotCRP", async () => {
    const seen: string[] = [];
    await expect(verifyHarness(env, probe("admin@example.org", "127.0.0.1:8080", seen))).rejects.toThrow(
      /compose project "pcs-ci" publishes 127\.0\.0\.1:8080, but PCS_HOTCRP_URL is 127\.0\.0\.1:18082/,
    );
    expect(seen).toEqual(["port pcs-ci"]);
  });

  it("refuses when the compose project publishes nothing", async () => {
    await expect(verifyHarness(env, probe("admin@example.org", ""))).rejects.toThrow(/publishes \(nothing\)/);
  });

  it("refuses a non-local URL and a missing token without probing", async () => {
    const seen: string[] = [];
    const p = probe("admin@example.org", "", seen);
    await expect(verifyHarness({ ...env, PCS_HOTCRP_URL: "https://conf.example.org" }, p)).rejects.toThrow(NotHarnessError);
    await expect(verifyHarness({ ...env, PCS_HOTCRP_TOKEN: "" }, p)).rejects.toThrow(/PCS_HOTCRP_TOKEN/);
    expect(seen).toEqual([]);
  });

  it("checkPublishedPort uses the scheme's default port", () => {
    expect(() => checkPublishedPort("127.0.0.1:80", "http://localhost", "pcs")).not.toThrow();
    expect(() => checkPublishedPort("127.0.0.1:8080", "http://localhost", "pcs")).toThrow(NotHarnessError);
  });

  it("harnessProject and harnessAdminEmail default like scripts/hotcrp-up.sh", () => {
    expect(harnessProject({})).toBe("pcs");
    expect(harnessProject({ COMPOSE_PROJECT_NAME: "x" })).toBe("x");
    expect(harnessProject({ COMPOSE_PROJECT_NAME: "x", HOTCRP_COMPOSE_PROJECT: "y" })).toBe("y");
    expect(harnessAdminEmail({})).toBe("admin@example.org");
    expect(() => checkHarnessAdmin("ADMIN@example.org", {})).not.toThrow();
  });
});
