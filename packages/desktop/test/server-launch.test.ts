import { describe, expect, it } from "vitest";
import { buildServerSpawn, generateToken, parseReadyPort } from "../src/server-launch.js";

const base = { parentPid: 4242, execPath: "/Apps/Finanfa/Finanfa", repoRoot: "/repo", workspace: "/work", token: "t0k3n", baseEnv: { ANTHROPIC_API_KEY: "k", PATH: "/bin" } } as const;

describe("buildServerSpawn", () => {
  it("in a source checkout runs the TypeScript server through tsx, with Electron acting as Node", () => {
    const spec = buildServerSpawn({ ...base, packaged: false });
    expect(spec.command).toBe("/Apps/Finanfa/Finanfa");
    expect(spec.args).toEqual(["/repo/node_modules/tsx/dist/cli.mjs", "/repo/packages/web-server/src/index.ts"]);
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("when packaged runs the bundled server from the app's resources", () => {
    const spec = buildServerSpawn({ ...base, packaged: true, resourcesPath: "/Apps/Finanfa/resources" });
    expect(spec.args).toEqual(["/Apps/Finanfa/resources/server/server.cjs"]);
  });

  it("locks the server down: loopback, a free port, the per-launch token, the chosen workspace", () => {
    const { env } = buildServerSpawn({ ...base, packaged: false });
    expect(env.FINANFA_WEB_HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe("0");
    expect(env.FINANFA_WEB_USERS).toBe("desktop:t0k3n");
    expect(env.FINANFA_WEB_CWD).toBe("/work");
    expect(env.FINANFA_PARENT_PID).toBe("4242");
  });

  it("keeps the user's environment (provider keys, PATH) but never lets it widen the bind or replace the token", () => {
    const { env } = buildServerSpawn({
      ...base,
      packaged: false,
      baseEnv: { ANTHROPIC_API_KEY: "k", PATH: "/bin", FINANFA_WEB_HOST: "0.0.0.0", FINANFA_WEB_USERS: "evil:x", PORT: "9999" },
    });
    expect(env.ANTHROPIC_API_KEY).toBe("k");
    expect(env.PATH).toBe("/bin");
    expect(env.FINANFA_WEB_HOST).toBe("127.0.0.1");
    expect(env.FINANFA_WEB_USERS).toBe("desktop:t0k3n");
    expect(env.PORT).toBe("0");
  });
});

describe("generateToken", () => {
  it("is long, hex, and different every time", () => {
    const a = generateToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateToken()).not.toBe(a);
  });
});

describe("parseReadyPort", () => {
  it("reads the port from the server's ready line, wherever it sits in the output", () => {
    expect(parseReadyPort("warming up\nfinanfa-code-web server listening on http://localhost:51234 (bound to 127.0.0.1)\n")).toBe(51234);
  });
  it("is undefined until that line has been printed", () => {
    expect(parseReadyPort("starting…")).toBeUndefined();
    expect(parseReadyPort("")).toBeUndefined();
  });
});
