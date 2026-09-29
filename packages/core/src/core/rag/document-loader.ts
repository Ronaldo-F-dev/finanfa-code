import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import fg from "fast-glob";
import matter from "gray-matter";
import { extractPdf, extractDocx, extractDoc, extractXlsx, extractCsv } from "../../tools/builtin/documents.js";

// Phase 4 of the RAG rollout: turn arbitrary project files (dropped in by
// a user, not a fixed seed corpus) into plain text + metadata that later
// phases can embed and cite. Extraction itself is NOT reimplemented here —
// every format below calls the exact same pdf-parse/mammoth/word-extractor/
// exceljs code paths that tools/builtin/documents.ts's read_document tool
// already uses, just exported for reuse instead of duplicated.

export type DocumentType = "pdf" | "docx" | "doc" | "xlsx" | "markdown" | "text" | "csv";

const EXTENSION_TO_TYPE: Record<string, DocumentType> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".doc": "doc",
  ".xlsx": "xlsx",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".csv": "csv",
};

/** Extensions loadDirectory() will pick up; kept in sync with EXTENSION_TO_TYPE's keys. */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_TO_TYPE);

export interface LoadedDocument {
  /** Absolute path this document was loaded from. */
  sourcePath: string;
  type: DocumentType;
  /** Extracted plain text — for Markdown, frontmatter already stripped out (see `frontmatter` below). */
  text: string;
  /** Markdown frontmatter fields (title, tags, etc.), when present. Undefined for non-Markdown files or Markdown with no frontmatter block. */
  frontmatter?: Record<string, unknown>;
  /** File mtime at load time, for later cache invalidation (a changed file needs re-chunking/re-embedding). */
  mtimeMs: number;
  /** sha256 of the extracted text — same hashing approach memory-search-index.ts/session-search-index.ts already use to key their embedding caches, so phase 5 can reuse content_hash as the cache key here too. */
  contentHash: string;
}

/** A file whose extension isn't one loadDirectory() knows how to extract, reported rather than thrown so a directory walk can skip it and keep going. */
export interface SkippedFile {
  path: string;
  reason: string;
}

export interface LoadDirectoryResult {
  documents: LoadedDocument[];
  skipped: SkippedFile[];
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function detectType(filePath: string): DocumentType | undefined {
  return EXTENSION_TO_TYPE[path.extname(filePath).toLowerCase()];
}

/**
 * Loads a single file by path, detecting its type from the extension and
 * extracting plain text via the same extractors read_document uses.
 * Throws a clear error for a missing file or an unsupported extension —
 * callers walking a directory (loadDirectory) catch this per-file instead
 * so one bad file doesn't abort the whole walk.
 */
export async function loadDocument(filePath: string): Promise<LoadedDocument> {
  const absolutePath = path.resolve(filePath);
  const type = detectType(absolutePath);
  if (!type) {
    throw new Error(
      `Unsupported document type "${path.extname(absolutePath) || "(no extension)"}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}.`,
    );
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    throw new Error(`File not found: ${absolutePath}`);
  }

  let text: string;
  let frontmatter: Record<string, unknown> | undefined;

  switch (type) {
    case "pdf":
      text = await extractPdf(await readFile(absolutePath));
      break;
    case "docx":
      text = await extractDocx(await readFile(absolutePath));
      break;
    case "doc":
      text = await extractDoc(await readFile(absolutePath));
      break;
    case "xlsx":
      text = await extractXlsx(await readFile(absolutePath));
      break;
    case "csv":
      text = await extractCsv(absolutePath);
      break;
    case "markdown": {
      const raw = await readFile(absolutePath, "utf-8");
      const parsed = matter(raw);
      text = parsed.content.trim();
      if (Object.keys(parsed.data).length > 0) frontmatter = parsed.data as Record<string, unknown>;
      break;
    }
    case "text":
      text = (await readFile(absolutePath, "utf-8")).trim();
      break;
  }

  return {
    sourcePath: absolutePath,
    type,
    text,
    frontmatter,
    mtimeMs: fileStat.mtimeMs,
    contentHash: hashContent(text),
  };
}

/**
 * Walks a project directory and loads every supported file found, using
 * fast-glob (already a dependency, already used by the glob tool) rather
 * than a hand-rolled directory walker. Unsupported files are silently
 * excluded by the glob pattern itself; a supported file that fails to
 * extract (corrupt PDF, etc.) is reported in `skipped` instead of aborting
 * the whole walk.
 */
export async function loadDirectory(dirPath: string): Promise<LoadDirectoryResult> {
  const absoluteDir = path.resolve(dirPath);
  const pattern = `**/*{${SUPPORTED_EXTENSIONS.join(",")}}`;
  const matches = await fg(pattern, {
    cwd: absoluteDir,
    dot: false,
    ignore: ["**/node_modules/**", "**/.git/**"],
    onlyFiles: true,
    caseSensitiveMatch: false,
  });

  const documents: LoadedDocument[] = [];
  const skipped: SkippedFile[] = [];
  for (const relativePath of matches) {
    const absolutePath = path.join(absoluteDir, relativePath);
    try {
      documents.push(await loadDocument(absolutePath));
    } catch (err) {
      skipped.push({ path: absolutePath, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { documents, skipped };
}
