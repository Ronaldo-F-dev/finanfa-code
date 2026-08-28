import { createRequire } from "node:module";
import { Client as PgClient } from "pg";
import mysql from "mysql2/promise";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";

// node:sqlite is experimental, so Node's own `module.builtinModules` list
// deliberately omits it (verified directly) — Vite/vite-node's builtin
// handling relies on that list and normalizes away the "node:" prefix it
// assumes every builtin also answers to unprefixed, which breaks resolution
// under Vitest (a real, reproduced failure, not a hypothetical: `import {
// DatabaseSync } from "node:sqlite"` at the top of this file made every test
// importing it fail to even load, with Vite trying to resolve a nonexistent
// "sqlite" npm package). A runtime `require()` via createRequire bypasses
// Vite's ESM import interception entirely, since it's just a function call
// from its perspective, not an import specifier to resolve/rewrite.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type DbParam = string | number | boolean | null;

const MAX_OUTPUT = 50_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n... (truncated)` : s;
}

// node:sqlite returns BigInt for integer columns once readBigInts is on
// (needed — see runSqlite) — JSON.stringify throws on a bare BigInt, so it
// needs converting to a string first. Small IDs come back as "1" instead of
// 1 as a result; a safe tradeoff against silently crashing on a value past
// Number.MAX_SAFE_INTEGER.
function toJson(rows: unknown): string {
  return JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2);
}

function redactCredentials(connectionString: string): string {
  return connectionString.replace(/:\/\/([^:/@]+)(:[^@/]+)?@/, "://$1:***@");
}

type Scheme = "sqlite" | "postgres" | "mysql";

function detectScheme(connectionString: string): Scheme | undefined {
  if (connectionString.startsWith("sqlite://") || connectionString === "sqlite::memory:") return "sqlite";
  if (connectionString.startsWith("postgres://") || connectionString.startsWith("postgresql://")) return "postgres";
  if (connectionString.startsWith("mysql://")) return "mysql";
  return undefined;
}

// node:sqlite's synchronous API requires picking .all() (rows) vs .run()
// (write metadata) up front — calling the wrong one doesn't throw, it just
// silently returns the wrong thing (.run() on a SELECT returns
// {lastInsertRowid, changes} instead of any actual row; .all() on an INSERT
// returns [] instead of an affected-row count). pg and mysql2 don't need
// this: both return a consistent shape regardless of statement type, so the
// row-vs-write distinction there is just "is the rows array non-empty?".
function looksLikeRowReturning(sql: string): boolean {
  return /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

// SQLite has no native boolean type — it stores one as the integer 0/1 —
// and node:sqlite's types correctly refuse a raw JS boolean bind value, so
// it needs converting here. Postgres/MySQL accept a boolean directly.
function sqliteParam(value: DbParam): string | number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function sqliteDbPath(connectionString: string, cwd: string): string {
  if (connectionString === "sqlite::memory:") return ":memory:";
  return resolveAllowedPath(cwd, connectionString.slice("sqlite://".length));
}

function runSqlite(dbPath: string, query: string, params: DbParam[]): string {
  // readBigInts: true — without it, a value past Number.MAX_SAFE_INTEGER
  // throws a RangeError on read instead of just being a slightly awkward
  // BigInt (verified: an INTEGER column holding 2^53+1 throws by default).
  const db = new DatabaseSync(dbPath, { readBigInts: true });
  try {
    const stmt = db.prepare(query);
    const boundParams = params.map(sqliteParam);
    if (looksLikeRowReturning(query)) {
      return toJson(stmt.all(...boundParams));
    }
    const result = stmt.run(...boundParams);
    return `${result.changes} row(s) affected. lastInsertRowid: ${result.lastInsertRowid}`;
  } finally {
    db.close();
  }
}

async function runPostgres(connectionString: string, query: string, params: DbParam[]): Promise<string> {
  const client = new PgClient(connectionString);
  try {
    await client.connect();
    const result = await client.query(query, params);
    return result.rows.length > 0 ? toJson(result.rows) : `${result.rowCount ?? 0} row(s) affected.`;
  } finally {
    await client.end().catch(() => {});
  }
}

async function runMysql(connectionString: string, query: string, params: DbParam[]): Promise<string> {
  const connection = await mysql.createConnection(connectionString);
  try {
    const [rows] = await connection.execute(query, params);
    if (Array.isArray(rows)) return toJson(rows);
    const header = rows as { affectedRows?: number; insertId?: number };
    return `${header.affectedRows ?? 0} row(s) affected. insertId: ${header.insertId ?? "n/a"}`;
  } finally {
    await connection.end().catch(() => {});
  }
}

interface QueryDatabaseInput {
  connectionString: string;
  query: string;
  params?: (string | number | boolean | null)[];
}

export const queryDatabaseTool: ToolDefinition<QueryDatabaseInput> = {
  name: "query_database",
  description:
    "Run a SQL query against SQLite, PostgreSQL, or MySQL, picked from the connectionString's scheme: " +
    '"sqlite://path/to/file.db" (or "sqlite::memory:" for a throwaway one — note it does NOT persist between ' +
    'calls, a fresh empty database is created each time), "postgres://user:pass@host:port/db", or ' +
    '"mysql://user:pass@host:port/db". Returns rows as JSON for a query that produces them, or an affected-row ' +
    "count otherwise. Placeholder syntax differs by database and isn't portable: SQLite/MySQL use \"?\", " +
    'Postgres uses "$1", "$2", etc.',
  riskLevel: "dangerous",
  inputSchema: {
    type: "object",
    properties: {
      connectionString: { type: "string", description: 'e.g. "sqlite://data.db", "postgres://user:pass@host/db"' },
      query: { type: "string", description: "SQL to run" },
      params: {
        type: "array",
        items: { type: ["string", "number", "boolean", "null"] },
        description: "Bind parameters for placeholders in the query",
      },
    },
    required: ["connectionString", "query"],
  },
  riskKey: (input) => redactCredentials(input.connectionString),
  describeCall: (input) => `query ${redactCredentials(input.connectionString)}: ${input.query}`,
  async handler(input, ctx) {
    const scheme = detectScheme(input.connectionString);
    if (!scheme) {
      return {
        content: `Unrecognized connection string. Expected a "sqlite://", "sqlite::memory:", "postgres://"/"postgresql://", or "mysql://" scheme.`,
        isError: true,
      };
    }

    const params = input.params ?? [];
    // Resolved outside the try/catch below so a path escaping the project
    // root propagates as a thrown error, same as every other file-touching
    // tool (read_file, write_file, git_add, ...) — it's a security-boundary
    // violation, not an ordinary query failure to report back as a result.
    const sqliteDbPathResolved = scheme === "sqlite" ? sqliteDbPath(input.connectionString, ctx.cwd) : null;
    try {
      let content: string;
      if (scheme === "sqlite") {
        content = runSqlite(sqliteDbPathResolved as string, input.query, params);
      } else if (scheme === "postgres") {
        content = await runPostgres(input.connectionString, input.query, params);
      } else {
        content = await runMysql(input.connectionString, input.query, params);
      }
      return { content: truncate(content), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
