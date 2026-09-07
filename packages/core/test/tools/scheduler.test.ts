import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSchedulerTools } from "../../src/tools/builtin/scheduler.js";

const FAKE_CRONTAB_SCRIPT = fileURLToPath(new URL("../fixtures/fake-crontab.mjs", import.meta.url));

describe("schedule_task / list_scheduled_tasks / unschedule_task (real subprocess, fake crontab)", () => {
  let stateDir: string;
  let fakeCrontabFile: string;
  let originalEnvVar: string | undefined;
  let tools: ReturnType<typeof createSchedulerTools>;
  let scheduleTask: (typeof tools)[0];
  let listScheduledTasks: (typeof tools)[0];
  let unscheduleTask: (typeof tools)[0];
  const ctx = { cwd: "/tmp/my-project", sessionId: "s", signal: new AbortController().signal };

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "finanfa-fake-crontab-"));
    fakeCrontabFile = path.join(stateDir, "crontab.txt");
    originalEnvVar = process.env.FAKE_CRONTAB_FILE;
    process.env.FAKE_CRONTAB_FILE = fakeCrontabFile;

    tools = createSchedulerTools({ crontabCommand: [process.execPath, FAKE_CRONTAB_SCRIPT] });
    [scheduleTask, listScheduledTasks, unscheduleTask] = tools;
  });

  afterEach(async () => {
    if (originalEnvVar === undefined) delete process.env.FAKE_CRONTAB_FILE;
    else process.env.FAKE_CRONTAB_FILE = originalEnvVar;
    await rm(stateDir, { recursive: true, force: true });
  });

  it("has 'dangerous'/'safe'/'ask' risk levels respectively", () => {
    expect(scheduleTask.riskLevel).toBe("dangerous");
    expect(listScheduledTasks.riskLevel).toBe("safe");
    expect(unscheduleTask.riskLevel).toBe("ask");
  });

  it("reports nothing scheduled when the (fake) crontab has never been written (real 'no crontab' condition)", async () => {
    const result = await listScheduledTasks.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("No tasks currently scheduled.");
  });

  it("rejects an invalid cron expression without touching the crontab", async () => {
    const result = await scheduleTask.handler({ cronExpression: "not a cron expr", prompt: "hi" }, ctx);
    expect(result.isError).toBe(true);
    const list = await listScheduledTasks.handler({}, ctx);
    expect(list.content).toBe("No tasks currently scheduled.");
  });

  it("schedules a real task, writing it to the real (fake) crontab file, and lists it back", async () => {
    const result = await scheduleTask.handler({ cronExpression: "0 9 * * *", prompt: "run the tests and report failures", label: "daily-test-run" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/Scheduled task [0-9a-f]{12}/);

    const list = await listScheduledTasks.handler({}, ctx);
    expect(list.content).toContain("daily-test-run");
    expect(list.content).toContain('"0 9 * * *"');
    expect(list.content).toContain("run the tests and report failures");
    expect(list.content).toContain(ctx.cwd);
  });

  it("the crontab line actually contains a real, runnable command re-invoking this CLI with --prompt/--cwd/--non-interactive", async () => {
    await scheduleTask.handler({ cronExpression: "*/15 * * * *", prompt: "check for flaky tests" }, ctx);
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(fakeCrontabFile, "utf-8");
    expect(raw).toContain("--prompt");
    expect(raw).toContain("--cwd");
    expect(raw).toContain("--non-interactive");
    expect(raw).toContain(process.execPath);
  });

  it("preserves an existing unrelated crontab entry when scheduling a new task", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(fakeCrontabFile, "0 3 * * * /usr/bin/some-other-real-job.sh\n", "utf-8");

    await scheduleTask.handler({ cronExpression: "0 9 * * *", prompt: "hi" }, ctx);

    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(fakeCrontabFile, "utf-8");
    expect(raw).toContain("some-other-real-job.sh");
    expect(raw).toContain("--prompt");
  });

  it("unschedules a task by id, leaving other scheduled tasks and unrelated entries intact", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(fakeCrontabFile, "0 3 * * * /usr/bin/some-other-real-job.sh\n", "utf-8");

    const first = await scheduleTask.handler({ cronExpression: "0 9 * * *", prompt: "task one" }, ctx);
    const taskId = first.content.match(/Scheduled task ([0-9a-f]{12})/)![1]!;
    await scheduleTask.handler({ cronExpression: "0 10 * * *", prompt: "task two" }, ctx);

    const removeResult = await unscheduleTask.handler({ taskId }, ctx);
    expect(removeResult.isError).toBe(false);

    const list = await listScheduledTasks.handler({}, ctx);
    expect(list.content).not.toContain("task one");
    expect(list.content).toContain("task two");

    const { readFileSync } = await import("node:fs");
    expect(readFileSync(fakeCrontabFile, "utf-8")).toContain("some-other-real-job.sh");
  });

  it("reports an error for an unknown task id instead of silently doing nothing", async () => {
    const result = await unscheduleTask.handler({ taskId: "deadbeefdead" }, ctx);
    expect(result.isError).toBe(true);
  });
});
