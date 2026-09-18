import { describe, expect, it, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { startCloudflareTunnel } from "../src/cloudflare-tunnel.js";

// Real end-to-end test — actually spawns cloudflared and lets it open a
// real "quick tunnel" against a throwaway local port. Skipped automatically
// wherever cloudflared genuinely isn't installed (this repeats the same
// PATH check startCloudflareTunnel itself does, just so the test reports
// as skipped instead of failing somewhere that never had the binary).
function hasCloudflared(): boolean {
  try {
    execSync("cloudflared --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("startCloudflareTunnel", () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it.skipIf(!hasCloudflared())(
    "resolves a real https://….trycloudflare.com URL for a real local port",
    async () => {
      const tunnel = await startCloudflareTunnel(4600);
      expect(tunnel).toBeDefined();
      expect(tunnel?.url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
      tunnel?.stop();
    },
    30_000,
  );

  it("resolves undefined (logging an actionable message) instead of throwing when cloudflared isn't on PATH", async () => {
    process.env.PATH = "";
    const tunnel = await startCloudflareTunnel(4600);
    expect(tunnel).toBeUndefined();
  });
});
