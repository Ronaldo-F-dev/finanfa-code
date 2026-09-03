/**
 * Per-session record of the last full file content a tool has observed for
 * a given path (read_file on a full, untruncated read; the read-before-write
 * inside edit_file/write_file). Lets those write tools warn when the file on
 * disk has changed since the model last saw it — e.g. a human edited it by
 * hand, or another process touched it, while the agent was reasoning or
 * using other tools between then and this write — instead of silently
 * overwriting that change with no signal at all.
 */
export class FileFreshnessTracker {
  private readonly seen = new Map<string, string>();

  record(path: string, content: string): void {
    this.seen.set(path, content);
  }

  /** A warning string if `path` was seen before with content different from `currentContent`, else undefined. */
  checkStale(path: string, currentContent: string): string | undefined {
    const known = this.seen.get(path);
    if (known !== undefined && known !== currentContent) {
      return `⚠ ${path} changed on disk since it was last read in this session (edited outside this tool, or by another process) — proceeding against its current content.`;
    }
    return undefined;
  }
}
