import { describe, expect, it } from "vitest";
import { createContainerTools } from "../../src/tools/builtin/containers.js";
import { isCommandAvailable } from "../../src/util/command-availability.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

// Both docker and kubectl are genuinely installed and functional in this
// environment (confirmed separately: `docker ps`/`docker info` work
// against a real local Docker daemon; `kubectl version --client` works
// with no cluster needed) — tested against the REAL binaries, not a fake
// stand-in, unlike run_avrdude/run_arduino_cli/run_platformio. Heavier
// operations (image pull/build/run) are deliberately not exercised here
// to keep this test fast/network-independent; the wrapper mechanics
// (argv passthrough, exit code, riskKey) are already proven correct by
// every other CLI-wrapper tool's tests, and are identical here.
describe.skipIf(!isCommandAvailable("docker"))("run_docker (real docker binary)", () => {
  it("has 'dangerous' risk level, scoped riskKey by subcommand", () => {
    const [docker] = createContainerTools();
    expect(docker.riskLevel).toBe("dangerous");
    expect(docker.riskKey?.({ args: ["ps"] })).toBe("run_docker:ps");
    expect(docker.riskKey?.({ args: ["rm", "-f", "x"] })).toBe("run_docker:rm");
  });

  it("runs the real 'docker ps' subcommand successfully against the real local daemon", async () => {
    const [docker] = createContainerTools();
    const result = await docker.handler({ args: ["ps"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("CONTAINER ID");
  }, 20_000);

  it("reports a real error for an invalid subcommand instead of throwing", async () => {
    const [docker] = createContainerTools();
    const result = await docker.handler({ args: ["this-is-not-a-real-docker-subcommand"] }, ctx);
    expect(result.isError).toBe(true);
  }, 20_000);
});

describe.skipIf(!isCommandAvailable("kubectl"))("run_kubectl (real kubectl binary)", () => {
  it("has 'dangerous' risk level, scoped riskKey by subcommand", () => {
    const [, kubectl] = createContainerTools();
    expect(kubectl.riskLevel).toBe("dangerous");
    expect(kubectl.riskKey?.({ args: ["get", "pods"] })).toBe("run_kubectl:get");
    expect(kubectl.riskKey?.({ args: ["delete", "pod", "x"] })).toBe("run_kubectl:delete");
  });

  it("runs the real 'kubectl version --client' subcommand successfully (no cluster needed)", async () => {
    const [, kubectl] = createContainerTools();
    const result = await kubectl.handler({ args: ["version", "--client"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Client Version");
  }, 20_000);

  it("reports a real connection-refused error when no cluster is reachable, not a thrown exception", async () => {
    const [, kubectl] = createContainerTools();
    const result = await kubectl.handler({ args: ["get", "pods"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toMatch(/connection|refused|unable to connect/);
  }, 20_000);
});

describe("createContainerTools (binary override, for environments without docker/kubectl)", () => {
  it("defaults to the real 'docker'/'kubectl' binary names when no override is given", () => {
    const [docker, kubectl] = createContainerTools();
    expect(docker.describeCall?.({ args: ["ps"] })).toBe("docker ps");
    expect(kubectl.describeCall?.({ args: ["get", "pods"] })).toBe("kubectl get pods");
  });
});
