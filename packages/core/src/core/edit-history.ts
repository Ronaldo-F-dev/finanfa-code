export interface EditRecord {
  /** Absolute path of the file that was written/edited. */
  path: string;
  /** Content before the change, or undefined if the file didn't exist yet (undo = delete it). */
  before: string | undefined;
}

/** Per-session stack of file edits, used to implement /undo. */
export class EditHistory {
  private readonly stack: EditRecord[] = [];

  push(record: EditRecord): void {
    this.stack.push(record);
  }

  pop(): EditRecord | undefined {
    return this.stack.pop();
  }

  get size(): number {
    return this.stack.length;
  }

  /**
   * Pops every record above `targetSize`, most-recent-first (same order
   * /undo already reverts in) — used by /rewind to revert every file
   * change made since a given checkpoint in one call, rather than one
   * /undo at a time. Returns the popped records for the caller to actually
   * write back to disk (this class stays fs-free, same as pop()/push()) —
   * if the same file was edited more than once since the checkpoint,
   * writing them back in this order ends with that file's earliest
   * "before" — the correct final state.
   */
  revertTo(targetSize: number): EditRecord[] {
    const reverted: EditRecord[] = [];
    while (this.stack.length > targetSize) {
      const record = this.stack.pop();
      if (!record) break;
      reverted.push(record);
    }
    return reverted;
  }
}
