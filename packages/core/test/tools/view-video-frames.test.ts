import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { viewVideoFramesTool } from "../../src/tools/builtin/view-video-frames.js";

const execFileAsync = promisify(execFile);

describe("view_video_frames tool (real ffmpeg/ffprobe execution)", () => {
  let dir: string;
  let videoPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-video-frames-"));
    videoPath = path.join(dir, "test.mp4");
    // A real, tiny synthetic video (no external asset needed) — a solid
    // color test pattern is enough to exercise real frame extraction.
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=64x64:rate=10", "-pix_fmt", "yuv420p", videoPath]);
  }, 30_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("extracts the default number of real frames as real PNG images", async () => {
    const result = await viewVideoFramesTool.handler({ path: "test.mp4" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.images).toHaveLength(5);
    for (const image of result.images!) {
      expect(image.mimeType).toBe("image/png");
      expect(image.base64.length).toBeGreaterThan(0);
    }
    expect(result.content).toContain("5 frame(s)");
    expect(result.content).toContain("3.0s total");
  });

  it("honors a custom frame_count, capped at the max", async () => {
    const result = await viewVideoFramesTool.handler({ path: "test.mp4", frame_count: 2 }, ctx());
    expect(result.isError).toBe(false);
    expect(result.images).toHaveLength(2);

    const capped = await viewVideoFramesTool.handler({ path: "test.mp4", frame_count: 999 }, ctx());
    expect(capped.images).toHaveLength(10);
  });

  it("fails clearly for a file that isn't a real video, instead of hanging or crashing", async () => {
    const notAVideo = path.join(dir, "not-a-video.mp4");
    await execFileAsync("bash", ["-c", `echo "not a video" > "${notAVideo}"`]);
    const result = await viewVideoFramesTool.handler({ path: "not-a-video.mp4" }, ctx());
    expect(result.isError).toBe(true);
  });

  it("fails clearly for a nonexistent file", async () => {
    const result = await viewVideoFramesTool.handler({ path: "missing.mp4" }, ctx());
    expect(result.isError).toBe(true);
  });

  it("rejects a path escaping the project root", async () => {
    await expect(viewVideoFramesTool.handler({ path: "../outside.mp4" }, ctx())).rejects.toThrow(/outside the project root/);
  });

  it("has 'safe' risk level", () => {
    expect(viewVideoFramesTool.riskLevel).toBe("safe");
  });
});
