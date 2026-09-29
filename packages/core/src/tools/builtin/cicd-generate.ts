import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

// Pure template generation, no external state or API calls — same "cheap
// and safe by nature" category as write_file/write_document, just with a
// fixed set of real, current CI YAML shapes instead of arbitrary content.
// Matches this repo's own .github/workflows/ci.yml/desktop-build.yml for
// real, working action versions rather than guessing at syntax.

export type ProjectType = "node" | "python" | "go" | "docker";
export type DeployTarget = "none" | "docker-registry" | "kubernetes";

export interface CicdGenerateOptions {
  testCommand?: string;
  deployTarget?: DeployTarget;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function githubTestSteps(projectType: ProjectType, testCommand?: string): string {
  switch (projectType) {
    case "node":
      return [
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-node@v4",
        "        with:",
        '          node-version: "22"',
        "          cache: npm",
        "      - run: npm ci",
        `      - run: ${testCommand ?? "npm test"}`,
      ].join("\n");
    case "python":
      return [
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-python@v5",
        "        with:",
        '          python-version: "3.12"',
        "      - run: pip install -r requirements.txt",
        `      - run: ${testCommand ?? "pytest"}`,
      ].join("\n");
    case "go":
      return [
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-go@v5",
        "        with:",
        '          go-version: "1.22"',
        "      - run: go build ./...",
        `      - run: ${testCommand ?? "go test ./..."}`,
      ].join("\n");
    case "docker":
      return [
        "      - uses: actions/checkout@v4",
        `      - run: ${testCommand ?? "docker build -t app:test ."}`,
      ].join("\n");
  }
}

function githubDeployJob(deployTarget: DeployTarget): string {
  if (deployTarget === "docker-registry") {
    return [
      "",
      "  deploy:",
      "    needs: test",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: docker/login-action@v3",
      "        with:",
      "          registry: ${{ vars.REGISTRY }}",
      "          username: ${{ vars.REGISTRY_USERNAME }}",
      "          password: ${{ secrets.REGISTRY_PASSWORD }}",
      "      - uses: docker/build-push-action@v6",
      "        with:",
      "          context: .",
      "          push: true",
      "          tags: ${{ vars.REGISTRY }}/${{ github.repository }}:${{ github.sha }}",
      "",
    ].join("\n");
  }
  if (deployTarget === "kubernetes") {
    return [
      "",
      "  deploy:",
      "    needs: test",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: azure/setup-kubectl@v4",
      "      - name: Configure kubeconfig",
      "        run: echo \"${{ secrets.KUBE_CONFIG }}\" | base64 -d > kubeconfig.yaml",
      "      - run: kubectl --kubeconfig kubeconfig.yaml apply -f k8s/",
      "",
    ].join("\n");
  }
  return "";
}

function generateGithubActionsYaml(projectType: ProjectType, options: CicdGenerateOptions): string {
  const deployTarget = options.deployTarget ?? "none";
  return [
    "name: CI",
    "",
    "on:",
    "  push:",
    "    branches: [main]",
    "  pull_request:",
    "",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    githubTestSteps(projectType, options.testCommand),
    githubDeployJob(deployTarget),
  ]
    .filter((line) => line !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") + "\n";
}

function gitlabTestScript(projectType: ProjectType, testCommand?: string): string[] {
  switch (projectType) {
    case "node":
      return ["image: node:22", "  script:", "    - npm ci", `    - ${testCommand ?? "npm test"}`];
    case "python":
      return ["image: python:3.12", "  script:", "    - pip install -r requirements.txt", `    - ${testCommand ?? "pytest"}`];
    case "go":
      return ["image: golang:1.22", "  script:", "    - go build ./...", `    - ${testCommand ?? "go test ./..."}`];
    case "docker":
      return ["image: docker:27", "  services:", "    - docker:27-dind", "  script:", `    - ${testCommand ?? "docker build -t app:test ."}`];
  }
}

function gitlabDeployStage(deployTarget: DeployTarget): string[] {
  if (deployTarget === "docker-registry") {
    return [
      "",
      "deploy:",
      "  stage: deploy",
      "  image: docker:27",
      "  services:",
      "    - docker:27-dind",
      "  script:",
      "    - docker login -u \"$REGISTRY_USERNAME\" -p \"$REGISTRY_PASSWORD\" \"$CI_REGISTRY\"",
      "    - docker build -t \"$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA\" .",
      "    - docker push \"$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA\"",
      "  only:",
      "    - main",
    ];
  }
  if (deployTarget === "kubernetes") {
    return [
      "",
      "deploy:",
      "  stage: deploy",
      "  image: bitnami/kubectl:latest",
      "  script:",
      "    - kubectl apply -f k8s/",
      "  only:",
      "    - main",
    ];
  }
  return [];
}

function generateGitlabCiYaml(projectType: ProjectType, options: CicdGenerateOptions): string {
  const deployTarget = options.deployTarget ?? "none";
  const stages = deployTarget === "none" ? ["test"] : ["test", "deploy"];
  const lines = [
    `stages: [${stages.join(", ")}]`,
    "",
    "test:",
    "  stage: test",
    ...gitlabTestScript(projectType, options.testCommand).map((l, i) => (i === 0 ? `  ${l}` : l)),
    ...gitlabDeployStage(deployTarget),
  ];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

async function refuseIfExists(cwd: string, relPath: string): Promise<{ error: string } | undefined> {
  const resolved = resolveAllowedPath(cwd, relPath);
  if (await pathExists(resolved)) {
    return {
      error:
        `${relPath} already exists — refusing to overwrite it. Pass a different output path, or delete/rename ` +
        `the existing file first if you actually want to replace it.`,
    };
  }
  return undefined;
}

interface GenerateGithubActionsInput {
  projectType: ProjectType;
  outputPath?: string;
  options?: CicdGenerateOptions;
}

export const generateGithubActionsWorkflowTool: ToolDefinition<GenerateGithubActionsInput> = {
  name: "generate_github_actions_workflow",
  description:
    "Generate a real, working GitHub Actions CI workflow YAML file (default .github/workflows/ci.yml) for a " +
    "node/python/go/docker project — checkout + language setup + a test step, and, if `options.deployTarget` " +
    "is set, a docker build+push or kubectl apply deploy job. Uses current, real Actions syntax " +
    "(actions/checkout@v4+, actions/setup-node@v4+/actions/setup-python@v5+/actions/setup-go@v5+). Refuses to " +
    "overwrite an existing workflow file at the target path — pass a different outputPath if one already " +
    "exists there.",
  riskLevel: "ask",
  riskKey: (input) => input.outputPath ?? ".github/workflows/ci.yml",
  inputSchema: {
    type: "object",
    properties: {
      projectType: { type: "string", enum: ["node", "python", "go", "docker"], description: "Project type to tailor the test step to" },
      outputPath: { type: "string", description: "Output path (default: .github/workflows/ci.yml)" },
      options: {
        type: "object",
        properties: {
          testCommand: { type: "string", description: "Override the default test command for the project type" },
          deployTarget: { type: "string", enum: ["none", "docker-registry", "kubernetes"], description: "Adds a deploy job when set (default: none)" },
        },
      },
    },
    required: ["projectType"],
  },
  describeCall: (input) => `generate GitHub Actions workflow for ${input.projectType} -> ${input.outputPath ?? ".github/workflows/ci.yml"}`,
  async handler(input, ctx) {
    const outputPath = input.outputPath ?? ".github/workflows/ci.yml";
    const refusal = await refuseIfExists(ctx.cwd, outputPath);
    if (refusal) return { content: refusal.error, isError: true };

    const yaml = generateGithubActionsYaml(input.projectType, input.options ?? {});
    const filePath = resolveAllowedPath(ctx.cwd, outputPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, yaml, "utf-8");
    return { content: `Wrote ${outputPath}:\n\n${yaml}`, isError: false };
  },
};

interface GenerateGitlabCiInput {
  projectType: ProjectType;
  outputPath?: string;
  options?: CicdGenerateOptions;
}

export const generateGitlabCiConfigTool: ToolDefinition<GenerateGitlabCiInput> = {
  name: "generate_gitlab_ci_config",
  description:
    "Generate a real, working .gitlab-ci.yml (default output path .gitlab-ci.yml) for a node/python/go/docker " +
    "project — a test stage tailored to the project type, and, if `options.deployTarget` is set, a deploy " +
    "stage (docker build+push or kubectl apply). Refuses to overwrite an existing .gitlab-ci.yml at the target " +
    "path — pass a different outputPath if one already exists there.",
  riskLevel: "ask",
  riskKey: (input) => input.outputPath ?? ".gitlab-ci.yml",
  inputSchema: {
    type: "object",
    properties: {
      projectType: { type: "string", enum: ["node", "python", "go", "docker"], description: "Project type to tailor the test stage to" },
      outputPath: { type: "string", description: "Output path (default: .gitlab-ci.yml)" },
      options: {
        type: "object",
        properties: {
          testCommand: { type: "string", description: "Override the default test command for the project type" },
          deployTarget: { type: "string", enum: ["none", "docker-registry", "kubernetes"], description: "Adds a deploy stage when set (default: none)" },
        },
      },
    },
    required: ["projectType"],
  },
  describeCall: (input) => `generate GitLab CI config for ${input.projectType} -> ${input.outputPath ?? ".gitlab-ci.yml"}`,
  async handler(input, ctx) {
    const outputPath = input.outputPath ?? ".gitlab-ci.yml";
    const refusal = await refuseIfExists(ctx.cwd, outputPath);
    if (refusal) return { content: refusal.error, isError: true };

    const yaml = generateGitlabCiYaml(input.projectType, input.options ?? {});
    const filePath = resolveAllowedPath(ctx.cwd, outputPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, yaml, "utf-8");
    return { content: `Wrote ${outputPath}:\n\n${yaml}`, isError: false };
  },
};
