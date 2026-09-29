import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createTerraformTools } from "../../src/tools/builtin/terraform.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const FAKE_TERRAFORM = fileURLToPath(new URL("../fixtures/fake-terraform.mjs", import.meta.url));

describe("terraform tools (real subprocess, fake terraform stand-in — no real cloud provider to point a real binary at)", () => {
  it("terraform_init has 'safe' risk level and a real 'init' argv", async () => {
    const [init] = createTerraformTools({ terraformBinary: FAKE_TERRAFORM });
    expect(init.riskLevel).toBe("safe");
    expect(init.describeCall?.({ directory: "/tmp" })).toBe("terraform init (in /tmp)");

    const result = await init.handler({ directory: "/tmp" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["init"]');
  });

  it("terraform_plan has 'safe' risk level and a real 'plan' argv", async () => {
    const [, plan] = createTerraformTools({ terraformBinary: FAKE_TERRAFORM });
    expect(plan.riskLevel).toBe("safe");
    expect(plan.describeCall?.({ directory: "/tmp", args: ["-var-file=prod.tfvars"] })).toBe(
      "terraform plan -var-file=prod.tfvars (in /tmp)",
    );

    const result = await plan.handler({ directory: "/tmp", args: ["-var-file=prod.tfvars"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["plan","-var-file=prod.tfvars"]');
  });

  it("terraform_apply has 'ask' risk level and a real 'apply -auto-approve' argv", async () => {
    const [, , apply] = createTerraformTools({ terraformBinary: FAKE_TERRAFORM });
    expect(apply.riskLevel).toBe("ask");
    expect(apply.describeCall?.({ directory: "/tmp" })).toContain("terraform apply -auto-approve");
    expect(apply.describeCall?.({ directory: "/tmp" })).toContain("without terraform's own interactive confirmation");

    const result = await apply.handler({ directory: "/tmp" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["apply","-auto-approve"]');
  });

  it("terraform_destroy has 'ask' risk level, its own riskKey, and a real 'destroy -auto-approve' argv", async () => {
    const [, , , destroy] = createTerraformTools({ terraformBinary: FAKE_TERRAFORM });
    expect(destroy.riskLevel).toBe("ask");
    expect(destroy.riskKey?.({ directory: "/tmp" })).toBe("terraform_destroy");
    expect(destroy.describeCall?.({ directory: "/tmp" })).toContain("terraform destroy -auto-approve");
    expect(destroy.describeCall?.({ directory: "/tmp" })).toContain("DESTROYS real infrastructure");

    const result = await destroy.handler({ directory: "/tmp" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["destroy","-auto-approve"]');
  });

  it("terraform_output has 'safe' risk level and defaults to '-json'", async () => {
    const [, , , , output] = createTerraformTools({ terraformBinary: FAKE_TERRAFORM });
    expect(output.riskLevel).toBe("safe");
    expect(output.describeCall?.({ directory: "/tmp" })).toBe("terraform output -json (in /tmp)");

    const result = await output.handler({ directory: "/tmp" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["output","-json"]');
  });

  it("terraform_output honors an overriding args instead of adding -json", async () => {
    const [, , , , output] = createTerraformTools({ terraformBinary: FAKE_TERRAFORM });
    const result = await output.handler({ directory: "/tmp", args: ["-raw", "example_output"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["output","-raw","example_output"]');
  });

  it("terraform_validate has 'safe' risk level and a real 'validate' argv", async () => {
    const [, , , , , validate] = createTerraformTools({ terraformBinary: FAKE_TERRAFORM });
    expect(validate.riskLevel).toBe("safe");
    expect(validate.describeCall?.({ directory: "/tmp" })).toBe("terraform validate (in /tmp)");

    const result = await validate.handler({ directory: "/tmp" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('["validate"]');
    expect(result.content).toContain("configuration is valid");
  });

  it("terraform_apply surfaces a real failure's stderr", async () => {
    const [, , apply] = createTerraformTools({ terraformBinary: FAKE_TERRAFORM });
    const result = await apply.handler({ directory: "/tmp", args: ["--fail"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no valid credential sources");
  });

  it("reports a real missing-binary error instead of throwing", async () => {
    const [init] = createTerraformTools({ terraformBinary: "this-binary-does-not-exist-xyz" });
    const result = await init.handler({ directory: "/tmp" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/command not found|failed to start/i);
  });
});
