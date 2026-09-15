import { spawn, type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";
import { killProcessGroup, SHELL } from "../util/process.js";

export interface BackgroundProcessInfo {
  name: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: string;
  logFile: string;
}

/**
 * Tracks long-running background processes (dev servers, watchers) started
 * via the start_background_process tool, so they can be listed and stopped
 * by name instead of the model having to improvise with `nohup`/`setsid`/
 * `pkill -f`/manual PID tracking — the exact dance that repeatedly went
 * wrong in real sessions (wrong process killed, orphaned server holding a
 * port, stale log file read after the process had already died). Session-
 * scoped only: a fresh finanfa-code run starts with an empty registry, and
 * doesn't know about processes a *previous* run started — same as `bash &`
 * today, a process survives finanfa-code exiting unless explicitly stopped
 * first, so "start a dev server, then close the agent and keep using it in
 * the browser" still works.
 */
export class BackgroundProcessManager {
  private readonly processes = new Map<string, { info: BackgroundProcessInfo; child: ChildProcess }>();

  start(name: string, command: string, cwd: string, logFile: string): BackgroundProcessInfo {
    if (this.processes.has(name)) {
      throw new Error(`A background process named "${name}" is already tracked — stop it first, or pick a different name.`);
    }

    const fd = openSync(logFile, "a");
    let child: ChildProcess;
    try {
      // detached: true — see killProcessGroup — lets a later stop() reap the
      // whole process group, not just this immediate shell. stdio writes
      // straight to the log file, not a pipe finanfa-code holds open, so
      // this process (and finanfa-code itself) can exit independently of
      // each other without the "orphan holds the pipe open" issue bash hits
      // when a script backgrounds something without redirecting output.
      child = spawn(command, { cwd, shell: SHELL, detached: true, stdio: ["ignore", fd, fd] });
    } catch (err) {
      throw new Error(`Failed to start "${command}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof child.pid !== "number") {
      throw new Error(`Failed to start "${command}" (no PID assigned).`);
    }
    child.unref(); // don't keep the finanfa-code process itself alive just because this is running

    const info: BackgroundProcessInfo = {
      name,
      pid: child.pid,
      command,
      cwd,
      startedAt: new Date().toISOString(),
      logFile,
    };
    this.processes.set(name, { info, child });
    child.on("exit", () => this.processes.delete(name));
    return info;
  }

  list(): BackgroundProcessInfo[] {
    return [...this.processes.values()].map((p) => p.info);
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  stop(name: string): boolean {
    const entry = this.processes.get(name);
    if (!entry) return false;
    killProcessGroup(entry.child);
    this.processes.delete(name);
    return true;
  }

  /** Stops everything currently tracked. Not called automatically on shutdown — see the class doc. */
  stopAll(): void {
    for (const name of this.processes.keys()) this.stop(name);
  }
}
