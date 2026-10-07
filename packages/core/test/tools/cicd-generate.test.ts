import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { generateGithubActionsWorkflowTool, generateGitlabCiConfigTool } from "../../src/tools/builtin/cicd-generate.js";

describe("generate_github_actions_workflow / generate_gitlab_ci_config (pure template generation)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-cicd-generate-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("has 'ask' risk level for both tools", () => {
    expect(generateGithubActionsWorkflowTool.riskLevel).toBe("ask");
    expect(generateGitlabCiConfigTool.riskLevel).toBe("ask");
  });

  describe("generate_github_actions_workflow", () => {
    for (const projectType of ["node", "python", "go", "docker"] as const) {
      it(`writes syntactically valid YAML with a real setup action + test step for projectType "${projectType}"`, async () => {
        const outputPath = `${projectType}-ci.yml`;
        const result = await generateGithubActionsWorkflowTool.handler({ projectType, outputPath }, ctx());
        expect(result.isError).toBe(false);

        const written = await readFile(path.join(dir, outputPath), "utf-8");
        const parsed = yaml.load(written) as any;

        expect(parsed.jobs.test.steps[0].uses).toMatch(/^actions\/checkout@v[4-9]/);

        if (projectType === "node") {
          expect(parsed.jobs.test.steps[1].uses).toMatch(/^actions\/setup-node@v[4-9]/);
          expect(parsed.jobs.test.steps.some((s: any) => s.run === "npm test")).toBe(true);
        } else if (projectType === "python") {
          expect(parsed.jobs.test.steps[1].uses).toMatch(/^actions\/setup-python@v[5-9]/);
          expect(parsed.jobs.test.steps.some((s: any) => s.run === "pytest")).toBe(true);
        } else if (projectType === "go") {
          expect(parsed.jobs.test.steps[1].uses).toMatch(/^actions\/setup-go@v[5-9]/);
          expect(parsed.jobs.test.steps.some((s: any) => s.run === "go test ./...")).toBe(true);
        } else {
          expect(parsed.jobs.test.steps.some((s: any) => /docker build/.test(s.run ?? ""))).toBe(true);
        }
      });
    }

    it("respects a custom testCommand", async () => {
      const result = await generateGithubActionsWorkflowTool.handler(
        { projectType: "node", outputPath: "custom.yml", options: { testCommand: "npm run test:ci" } },
        ctx(),
      );
      expect(result.isError).toBe(false);
      const parsed = yaml.load(await readFile(path.join(dir, "custom.yml"), "utf-8")) as any;
      expect(parsed.jobs.test.steps.some((s: any) => s.run === "npm run test:ci")).toBe(true);
    });

    it("adds a docker-registry deploy job only when deployTarget is set", async () => {
      const withoutDeploy = await generateGithubActionsWorkflowTool.handler({ projectType: "node", outputPath: "a.yml" }, ctx());
      expect(withoutDeploy.isError).toBe(false);
      const parsedNoDeploy = yaml.load(await readFile(path.join(dir, "a.yml"), "utf-8")) as any;
      expect(parsedNoDeploy.jobs.deploy).toBeUndefined();

      const withDeploy = await generateGithubActionsWorkflowTool.handler(
        { projectType: "node", outputPath: "b.yml", options: { deployTarget: "docker-registry" } },
        ctx(),
      );
      expect(withDeploy.isError).toBe(false);
      const parsedDeploy = yaml.load(await readFile(path.join(dir, "b.yml"), "utf-8")) as any;
      expect(parsedDeploy.jobs.deploy).toBeDefined();
      expect(parsedDeploy.jobs.deploy.steps.some((s: any) => (s.uses ?? "").startsWith("docker/build-push-action"))).toBe(true);
    });

    it("adds a kubectl apply step when deployTarget is kubernetes", async () => {
      const result = await generateGithubActionsWorkflowTool.handler(
        { projectType: "docker", outputPath: "k8s.yml", options: { deployTarget: "kubernetes" } },
        ctx(),
      );
      expect(result.isError).toBe(false);
      const parsed = yaml.load(await readFile(path.join(dir, "k8s.yml"), "utf-8")) as any;
      expect(parsed.jobs.deploy.steps.some((s: any) => /kubectl .*apply/.test(s.run ?? ""))).toBe(true);
    });

    it("refuses to overwrite an existing workflow file with a clear error", async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "ci.yml"), "already here", "utf-8");

      const result = await generateGithubActionsWorkflowTool.handler({ projectType: "node", outputPath: "ci.yml" }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/already exists/i);
      expect(result.content).toMatch(/different (output )?path|overwrite/i);

      // Confirm it genuinely left the existing file untouched.
      expect(await readFile(path.join(dir, "ci.yml"), "utf-8")).toBe("already here");
    });

    it("defaults to .github/workflows/ci.yml and refuses to overwrite it there too", async () => {
      await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
      await writeFile(path.join(dir, ".github", "workflows", "ci.yml"), "existing", "utf-8");

      const result = await generateGithubActionsWorkflowTool.handler({ projectType: "node" }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/already exists/i);
    });
  });

  describe("generate_gitlab_ci_config", () => {
    for (const projectType of ["node", "python", "go", "docker"] as const) {
      it(`writes syntactically valid YAML with real stages for projectType "${projectType}"`, async () => {
        const outputPath = `${projectType}.gitlab-ci.yml`;
        const result = await generateGitlabCiConfigTool.handler({ projectType, outputPath }, ctx());
        expect(result.isError).toBe(false);

        const parsed = yaml.load(await readFile(path.join(dir, outputPath), "utf-8")) as any;
        expect(parsed.stages).toContain("test");
        expect(parsed.test).toBeDefined();
        expect(parsed.test.stage).toBe("test");
        expect(Array.isArray(parsed.test.script)).toBe(true);
      });
    }

    it("adds a deploy stage only when deployTarget is set", async () => {
      const withoutDeploy = await generateGitlabCiConfigTool.handler({ projectType: "node", outputPath: "a.yml" }, ctx());
      expect(withoutDeploy.isError).toBe(false);
      const parsedNoDeploy = yaml.load(await readFile(path.join(dir, "a.yml"), "utf-8")) as any;
      expect(parsedNoDeploy.deploy).toBeUndefined();
      expect(parsedNoDeploy.stages).not.toContain("deploy");

      const withDeploy = await generateGitlabCiConfigTool.handler(
        { projectType: "node", outputPath: "b.yml", options: { deployTarget: "kubernetes" } },
        ctx(),
      );
      expect(withDeploy.isError).toBe(false);
      const parsedDeploy = yaml.load(await readFile(path.join(dir, "b.yml"), "utf-8")) as any;
      expect(parsedDeploy.stages).toContain("deploy");
      expect(parsedDeploy.deploy.script.some((s: string) => /kubectl apply/.test(s))).toBe(true);
    });

    it("refuses to overwrite an existing .gitlab-ci.yml with a clear error", async () => {
      await writeFile(path.join(dir, ".gitlab-ci.yml"), "already here", "utf-8");
      const result = await generateGitlabCiConfigTool.handler({ projectType: "node" }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/already exists/i);
      expect(await readFile(path.join(dir, ".gitlab-ci.yml"), "utf-8")).toBe("already here");
    });
  });
});
