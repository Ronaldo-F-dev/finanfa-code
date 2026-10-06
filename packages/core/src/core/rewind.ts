import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { AgentSession } from "./session.js";

/** Writes one EditRecord's "before" content back to disk (or deletes the file if it didn't exist before that change) — shared by /undo and rewinding. */
export async function revertFileRecord(record: { path: string; before: string | undefined }): Promise<void> {
  if (record.before === undefined) {
    await rm(record.path, { force: true });
  } else {
    await mkdir(path.dirname(record.path), { recursive: true });
    await writeFile(record.path, record.before, "utf-8");
  }
}

export interface RewindResult {
  /** The first 60 characters of the message the session was rewound to just before. */
  preview: string;
  /** How many file changes (edits, writes, creations) were reverted. */
  revertedFiles: number;
  /** Messages left in the conversation. */
  remainingMessages: number;
}

/**
 * Restores the conversation AND every file change made through the edit/write tools since checkpoint
 * `checkpointNumber` (1-based, see AgentSession.checkpoints): the session ends up exactly as it was right
 * before that message was sent. Returns undefined for a number that isn't a current checkpoint.
 *
 * Only changes recorded in the session's edit history are reverted — what a shell command did to the
 * disk (a `bash` call, a build, an install) is not tracked and stays.
 */
export async function rewindSession(session: AgentSession, checkpointNumber: number): Promise<RewindResult | undefined> {
  const { checkpoints } = session;
  if (!Number.isInteger(checkpointNumber) || checkpointNumber < 1 || checkpointNumber > checkpoints.length) return undefined;

  const checkpoint = checkpoints[checkpointNumber - 1]!;
  const reverted = session.history.revertTo(checkpoint.historySize);
  for (const record of reverted) await revertFileRecord(record);

  session.messages = session.messages.slice(0, checkpoint.messageIndex - 1);
  session.checkpoints = checkpoints.slice(0, checkpointNumber - 1);
  // An error recorded after a message that no longer exists must not resurface when the conversation grows back past that index.
  session.errorLog = session.errorLog.filter((entry) => entry.afterMessageIndex <= session.messages.length);
  await session.persist();

  return { preview: checkpoint.preview, revertedFiles: reverted.length, remainingMessages: session.messages.length };
}
