import { randomBytes } from "node:crypto";
import path from "node:path";

// What it takes to start finanfa's web server as a child process of the desktop app, kept free of
// Electron imports so it can be unit-tested. The server is the same one `npm run dev:web-server`
// runs; the desktop app only supervises it and points a window at it.

export interface ServerSpawnInput {
  /** True when running from an installed/packaged app (the bundled server is used), false when running from a source checkout. */
  packaged: boolean;
  /** The Electron (or Node) binary used to run the server — with ELECTRON_RUN_AS_NODE it behaves as plain Node, so no separate Node install is needed. */
  execPath: string;
  /** Packaged: the app's resources directory. Dev: unused. */
  resourcesPath?: string;
  /** Dev: the repository root (where packages/web-server lives). */
  repoRoot: string;
  /** The folder the agent works in. */
  workspace: string;
  /** Per-launch bearer token the window presents. */
  token: string;
  /** The desktop app's own pid: the server exits when this process is gone, so a crashed or force-quit app never leaves a server running. */
  parentPid: number;
  /** Extra environment for the server (provider keys, etc.) — typically process.env. */
  baseEnv: NodeJS.ProcessEnv;
}

export interface ServerSpawn {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** A fresh random secret per launch. Only the desktop app and its server ever know it. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function buildServerSpawn(input: ServerSpawnInput): ServerSpawn {
  const entry = input.packaged
    ? [path.join(input.resourcesPath ?? "", "server", "server.cjs")]
    : [path.join(input.repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(input.repoRoot, "packages", "web-server", "src", "index.ts")];

  const env: NodeJS.ProcessEnv = {
    ...input.baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    // PORT=0: the OS picks a free port, so two instances (or any other app) never collide.
    PORT: "0",
    // Loopback only, and a token on every request — another local user or process can't drive the agent.
    FINANFA_WEB_HOST: "127.0.0.1",
    FINANFA_WEB_USERS: `desktop:${input.token}`,
    FINANFA_WEB_CWD: input.workspace,
    FINANFA_PARENT_PID: String(input.parentPid),
  };
  // A source-checkout run serves the built web client from the repo; the packaged app finds it next to the server bundle.
  return { command: input.execPath, args: entry, env };
}

const READY_RE = /listening on http:\/\/localhost:(\d+)/;

/** The port from the server's "listening on" log line, once it has been printed. */
export function parseReadyPort(output: string): number | undefined {
  const match = READY_RE.exec(output);
  return match ? Number(match[1]) : undefined;
}
