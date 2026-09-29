import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createArgocdTools } from "../../src/tools/builtin/argocd.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_ARGOCD = fileURLToPath(new URL("../fixtures/fake-argocd.mjs", import.meta.url));

describe("argocd tools (real subprocess, fake argocd stand-in — no real ArgoCD server to point a real binary at)", () => {
  it("argocd_sync has 'ask' risk level and a real 'app sync <name>' argv", async () => {
    const [sync] = createArgocdTools({ argocdBinary: FAKE_ARGOCD });
    expect(sync.riskLevel).toBe("ask");
    expect(sync.riskKey?.({ app: "x" })).toBe("argocd_sync");
    expect(sync.describeCall?.({ app: "my-app", args: ["--prune"] })).toBe("argocd app sync my-app --prune");

    const result = await sync.handler({ app: "my-app", args: ["--prune"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["app","sync","my-app","--prune"]');
  });

  it("argocd_sync surfaces a real failure's stderr", async () => {
    const [sync] = createArgocdTools({ argocdBinary: FAKE_ARGOCD });
    const result = await sync.handler({ app: "missing-app", args: ["--fail"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("argocd_app_status has 'safe' risk level and a real 'app get <name>' argv", async () => {
    const [, status] = createArgocdTools({ argocdBinary: FAKE_ARGOCD });
    expect(status.riskLevel).toBe("safe");
    expect(status.describeCall?.({ app: "my-app" })).toBe("argocd app get my-app");

    const result = await status.handler({ app: "my-app" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["app","get","my-app"]');
    expect(result.content).toContain("Health Status: Healthy");
  });

  it("argocd_app_list has 'safe' risk level and a real 'app list' argv", async () => {
    const [, , list] = createArgocdTools({ argocdBinary: FAKE_ARGOCD });
    expect(list.riskLevel).toBe("safe");
    expect(list.describeCall?.({})).toBe("argocd app list");

    const result = await list.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["app","list"]');
  });

  it("reports a real missing-binary error instead of throwing", async () => {
    const [sync] = createArgocdTools({ argocdBinary: "this-binary-does-not-exist-xyz" });
    const result = await sync.handler({ app: "my-app" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/command not found|failed to start/i);
  });
});
