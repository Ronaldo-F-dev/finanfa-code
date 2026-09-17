import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDefinition, ToolImage } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import { readImageFile } from "../../util/image.js";
import { SHELL, killProcessGroup } from "../../util/process.js";

// Video understanding beyond audio transcription (transcribe_audio only
// ever sees the audio track) — samples still frames via ffmpeg/ffprobe
// and hands them to the model exactly like view_image, reusing whatever
// vision-route fallback every other image path already uses. Not real
// video understanding (motion between frames, exact timing, anything
// audio-synced) — the honest scope here is "look at a handful of frames
// from this clip", the same thing a human would do scrubbing through a
// video player, not a video-native model.

// Not runSubprocess: same reasoning as ocr_image.ts — its own labeled
// "(exit code N)"/stdout-stderr framing is right for build/test output,
// wrong here where ffprobe's stdout needs to be a clean parseable number
// and ffmpeg's own success path has no payload to show at all.
function runFfmpegLike(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; isError: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: SHELL, detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: timedOut ? `Timed out after ${timeoutMs}ms` : stderr, isError: timedOut || code !== 0 });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.message, isError: true });
    });
  });
}

const DEFAULT_FRAME_COUNT = 5;
const MAX_FRAME_COUNT = 10;
const TIMEOUT_MS = 60_000;

interface ViewVideoFramesInput {
  path: string;
  frame_count?: number;
}

export const viewVideoFramesTool: ToolDefinition<ViewVideoFramesInput> = {
  name: "view_video_frames",
  description:
    "View a set of evenly-spaced still frames extracted from a video file (mp4, mov, webm, ...) — for a screen " +
    "recording, a demo clip, or a video the user referenced. This samples still frames (the same way you'd " +
    "manually scrub through a video player and grab a few to look at), not full video understanding — motion " +
    "between frames, exact timing, and audio aren't captured (use transcribe_audio for the audio track).",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the video file, relative to the project root" },
      frame_count: { type: "number", description: `How many evenly-spaced frames to extract (default ${DEFAULT_FRAME_COUNT}, max ${MAX_FRAME_COUNT})` },
    },
    required: ["path"],
  },
  describeCall: (input) => `view frames from ${input.path}`,
  async handler(input, ctx) {
    const sourcePath = resolveAllowedPath(ctx.cwd, input.path);
    const frameCount = Math.min(Math.max(1, Math.floor(input.frame_count ?? DEFAULT_FRAME_COUNT)), MAX_FRAME_COUNT);

    const probe = await runFfmpegLike("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", sourcePath], TIMEOUT_MS);
    if (probe.isError) {
      return { content: `Could not read "${input.path}" as a video: ${probe.stderr.trim() || "ffprobe failed with no output."}`, isError: true };
    }
    const duration = Number(probe.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      return { content: `Could not determine the duration of "${input.path}".`, isError: true };
    }

    const tmpDir = await mkdtemp(path.join(tmpdir(), "finanfa-video-frames-"));
    try {
      const images: ToolImage[] = [];
      const timestamps: number[] = [];
      for (let i = 0; i < frameCount; i++) {
        // Evenly spaced across (0, duration), never exactly the first/last
        // instant — often a black or not-yet-decoded frame.
        const t = (duration * (i + 1)) / (frameCount + 1);
        const framePath = path.join(tmpDir, `frame-${i}.png`);
        const extract = await runFfmpegLike("ffmpeg", ["-y", "-ss", t.toFixed(3), "-i", sourcePath, "-frames:v", "1", "-update", "1", framePath], TIMEOUT_MS);
        if (extract.isError) {
          return { content: `Failed to extract a frame at ${t.toFixed(1)}s: ${extract.stderr.trim() || "ffmpeg failed with no output."}`, isError: true };
        }
        const read = await readImageFile(framePath, framePath);
        if (!read.ok) return { content: read.error, isError: true };
        images.push(read.image);
        timestamps.push(t);
      }
      const label = timestamps.map((t) => `${t.toFixed(1)}s`).join(", ");
      return { content: `${frameCount} frame(s) from "${input.path}" (${duration.toFixed(1)}s total) at ${label}`, isError: false, images };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
};
