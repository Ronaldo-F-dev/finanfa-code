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
}
