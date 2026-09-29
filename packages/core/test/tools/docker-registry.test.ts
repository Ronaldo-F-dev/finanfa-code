import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  createDockerComposeUpDownTool,
  createDockerComposeStatusTool,
  createDockerRegistryLoginTool,
} from "../../src/tools/builtin/docker-registry.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_COMPOSE = fileURLToPath(new URL("../fixtures/fake-compose-cli.mjs", import.meta.url));
const FAKE_AWS = fileURLToPath(new URL("../fixtures/fake-aws.mjs", import.meta.url));
const FAKE_AZ = fileURLToPath(new URL("../fixtures/fake-az.mjs", import.meta.url));
const FAKE_GCLOUD = fileURLToPath(new URL("../fixtures/fake-gcloud.mjs", import.meta.url));
const FAKE_DOCKER = fileURLToPath(new URL("../fixtures/fake-docker.mjs", import.meta.url));
const NONEXISTENT = "this-binary-does-not-exist-xyz";

describe("docker_compose (up/down, real subprocess, fake docker/compose stand-in)", () => {
  it("has 'ask' risk level, scoped riskKey by subcommand", () => {
    const tool = createDockerComposeUpDownTool({ dockerBinary: FAKE_COMPOSE });
    expect(tool.riskLevel).toBe("ask");
    expect(tool.riskKey?.({ subcommand: "up" })).toBe("docker_compose:up");
    expect(tool.riskKey?.({ subcommand: "down" })).toBe("docker_compose:down");
  });

  it("prefers the modern `docker compose` form, building real argv with -f and extra flags", async () => {
    const tool = createDockerComposeUpDownTool({ dockerBinary: FAKE_COMPOSE });
    const result = await tool.handler({ subcommand: "up", file: "docker-compose.yml", args: ["-d", "--build"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["compose","-f","docker-compose.yml","up","-d","--build"]');
  });

  it("falls back to the legacy standalone docker-compose binary when `docker` isn't available", async () => {
    const tool = createDockerComposeUpDownTool({ dockerBinary: NONEXISTENT, dockerComposeBinary: FAKE_COMPOSE });
    const result = await tool.handler({ subcommand: "down", args: ["--volumes"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["down","--volumes"]');
  });

  it("reports a clear error naming both missing binaries when neither is available", async () => {
    const tool = createDockerComposeUpDownTool({ dockerBinary: NONEXISTENT, dockerComposeBinary: NONEXISTENT + "-2" });
    const result = await tool.handler({ subcommand: "up" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(NONEXISTENT);
    expect(result.content).toMatch(/docker compose|docker-compose/i);
  });

  it("surfaces a real subprocess failure's stderr", async () => {
    const tool = createDockerComposeUpDownTool({ dockerBinary: FAKE_COMPOSE });
    const result = await tool.handler({ subcommand: "up", args: ["--fail"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no configuration file provided");
  });
});

describe("docker_compose_status (ps/logs, real subprocess, fake docker/compose stand-in)", () => {
  it("has 'safe' risk level", () => {
    const tool = createDockerComposeStatusTool({ dockerBinary: FAKE_COMPOSE });
    expect(tool.riskLevel).toBe("safe");
  });

  it("builds real argv including a service filter", async () => {
    const tool = createDockerComposeStatusTool({ dockerBinary: FAKE_COMPOSE });
    const result = await tool.handler({ subcommand: "logs", service: "web", args: ["--tail", "50"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["compose","logs","--tail","50","web"]');
  });

  it("runs 'ps' with no extra args", async () => {
    const tool = createDockerComposeStatusTool({ dockerBinary: FAKE_COMPOSE });
    const result = await tool.handler({ subcommand: "ps" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["compose","ps"]');
  });
});

describe("docker_registry_login", () => {
  it("has 'ask' risk level, scoped riskKey by provider", () => {
    const tool = createDockerRegistryLoginTool();
    expect(tool.riskLevel).toBe("ask");
    expect(tool.riskKey?.({ provider: "ecr" })).toBe("docker_registry_login:ecr");
    expect(tool.riskKey?.({ provider: "acr" })).toBe("docker_registry_login:acr");
    expect(tool.riskKey?.({ provider: "gcr" })).toBe("docker_registry_login:gcr");
  });

  describe("ecr", () => {
    it("requires region and accountId", async () => {
      const tool = createDockerRegistryLoginTool({ awsBinary: FAKE_AWS, dockerBinary: FAKE_DOCKER });
      const result = await tool.handler({ provider: "ecr" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("region");
      expect(result.content).toContain("accountId");
    });

    it("pipes the real aws ecr get-login-password output into docker login --password-stdin (no shell string, no plaintext password in argv)", async () => {
      const tool = createDockerRegistryLoginTool({ awsBinary: FAKE_AWS, dockerBinary: FAKE_DOCKER });
      const result = await tool.handler({ provider: "ecr", region: "us-east-1", accountId: "123456789012" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("123456789012.dkr.ecr.us-east-1.amazonaws.com");
      expect(result.content).toContain('password-stdin="fake-ecr-login-password-token"');
    });

    it("surfaces the real aws stderr when the aws step fails", async () => {
      const tool = createDockerRegistryLoginTool({ awsBinary: FAKE_AWS, dockerBinary: FAKE_DOCKER });
      const result = await tool.handler({ provider: "ecr", region: "--fail", accountId: "123456789012" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("UnrecognizedClientException");
    });

    it("surfaces a real docker login failure", async () => {
      const tool = createDockerRegistryLoginTool({ awsBinary: FAKE_AWS, dockerBinary: FAKE_DOCKER });
      const result = await tool.handler({ provider: "ecr", region: "us-east-1", accountId: "fail-account" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("unauthorized");
    });

    it("names the AWS CLI specifically when it's missing", async () => {
      const tool = createDockerRegistryLoginTool({ awsBinary: NONEXISTENT, dockerBinary: FAKE_DOCKER });
      const result = await tool.handler({ provider: "ecr", region: "us-east-1", accountId: "123456789012" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("AWS CLI");
      expect(result.content).toContain(NONEXISTENT);
    });
  });

  describe("acr", () => {
    it("requires registryName", async () => {
      const tool = createDockerRegistryLoginTool({ azBinary: FAKE_AZ });
      const result = await tool.handler({ provider: "acr" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("registryName");
    });

    it("runs the real `az acr login --name <registryName>` argv", async () => {
      const tool = createDockerRegistryLoginTool({ azBinary: FAKE_AZ });
      const result = await tool.handler({ provider: "acr", registryName: "myregistry" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain('["acr","login","--name","myregistry"]');
    });

    it("names the Azure CLI specifically when it's missing", async () => {
      const tool = createDockerRegistryLoginTool({ azBinary: NONEXISTENT });
      const result = await tool.handler({ provider: "acr", registryName: "myregistry" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Azure CLI");
      expect(result.content).toContain(NONEXISTENT);
    });

    it("surfaces a real az failure's stderr", async () => {
      const tool = createDockerRegistryLoginTool({ azBinary: FAKE_AZ });
      const result = await tool.handler({ provider: "acr", registryName: "--fail" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("az login");
    });
  });

  describe("gcr", () => {
    it("defaults to gcr.io when no registries given", async () => {
      const tool = createDockerRegistryLoginTool({ gcloudBinary: FAKE_GCLOUD });
      const result = await tool.handler({ provider: "gcr" }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain('["auth","configure-docker","gcr.io","--quiet"]');
    });

    it("uses custom Artifact Registry hostnames when given", async () => {
      const tool = createDockerRegistryLoginTool({ gcloudBinary: FAKE_GCLOUD });
      const result = await tool.handler({ provider: "gcr", registries: ["us-docker.pkg.dev", "eu-docker.pkg.dev"] }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain('["auth","configure-docker","us-docker.pkg.dev,eu-docker.pkg.dev","--quiet"]');
    });

    it("names the gcloud CLI specifically when it's missing", async () => {
      const tool = createDockerRegistryLoginTool({ gcloudBinary: NONEXISTENT });
      const result = await tool.handler({ provider: "gcr" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Google Cloud CLI");
      expect(result.content).toContain(NONEXISTENT);
    });
  });
});
