import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { queryDatabaseTool } from "../../src/tools/builtin/query-database.js";

describe("query_database tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-query-db-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  describe("sqlite (real node:sqlite, no external server needed)", () => {
    const dbUrl = "sqlite://data.db";

    it("creates a table, inserts, and selects rows back as JSON", async () => {
      const create = await queryDatabaseTool.handler(
        { connectionString: dbUrl, query: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)" },
        ctx(),
      );
      expect(create.isError).toBe(false);

      const insert = await queryDatabaseTool.handler(
        { connectionString: dbUrl, query: "INSERT INTO users (name, age) VALUES (?, ?)", params: ["Alice", 30] },
        ctx(),
      );
      expect(insert.isError).toBe(false);
      expect(insert.content).toContain("1 row(s) affected");

      const select = await queryDatabaseTool.handler(
        { connectionString: dbUrl, query: "SELECT * FROM users WHERE age > ?", params: [20] },
        ctx(),
      );
      expect(select.isError).toBe(false);
      const rows = JSON.parse(select.content);
      // integers come back stringified — see toJson()'s doc comment: readBigInts
      // is on to avoid crashing past Number.MAX_SAFE_INTEGER, and a bigint
      // isn't JSON-serializable as a bare number
      expect(rows).toEqual([{ id: "1", name: "Alice", age: "30" }]);
    });

    it("persists data across separate calls via the same file path", async () => {
      await queryDatabaseTool.handler({ connectionString: dbUrl, query: "CREATE TABLE t (v TEXT)" }, ctx());
      await queryDatabaseTool.handler({ connectionString: dbUrl, query: "INSERT INTO t VALUES ('x')" }, ctx());
      const result = await queryDatabaseTool.handler({ connectionString: dbUrl, query: "SELECT * FROM t" }, ctx());
      expect(JSON.parse(result.content)).toEqual([{ v: "x" }]);
    });

    it("sqlite::memory: does NOT persist across separate calls", async () => {
      await queryDatabaseTool.handler({ connectionString: "sqlite::memory:", query: "CREATE TABLE t (v TEXT)" }, ctx());
      const result = await queryDatabaseTool.handler({ connectionString: "sqlite::memory:", query: "SELECT * FROM t" }, ctx());
      // a fresh in-memory db each call means "t" was never created in this call
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/no such table/i);
    });

    it("converts boolean params to 0/1, since SQLite has no native boolean type", async () => {
      await queryDatabaseTool.handler(
        { connectionString: dbUrl, query: "CREATE TABLE t (active INTEGER)" },
        ctx(),
      );
      await queryDatabaseTool.handler(
        { connectionString: dbUrl, query: "INSERT INTO t VALUES (?)", params: [true] },
        ctx(),
      );
      const result = await queryDatabaseTool.handler({ connectionString: dbUrl, query: "SELECT * FROM t" }, ctx());
      expect(JSON.parse(result.content)).toEqual([{ active: "1" }]);
    });

    it("INSERT ... RETURNING returns the inserted row, not a plain affected-count", async () => {
      await queryDatabaseTool.handler({ connectionString: dbUrl, query: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)" }, ctx());
      const result = await queryDatabaseTool.handler(
        { connectionString: dbUrl, query: "INSERT INTO t (name) VALUES (?) RETURNING *", params: ["x"] },
        ctx(),
      );
      expect(JSON.parse(result.content)).toEqual([{ id: "1", name: "x" }]);
    });

    it("reports a SQL error cleanly instead of throwing", async () => {
      const result = await queryDatabaseTool.handler({ connectionString: dbUrl, query: "SELECT * FROM nonexistent" }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/no such table/i);
    });

    it("rejects a database path escaping the project root", async () => {
      await expect(
        queryDatabaseTool.handler({ connectionString: "sqlite://../outside.db", query: "SELECT 1" }, ctx()),
      ).rejects.toThrow(/outside the project root/);
    });

    it("redacts credentials from describeCall/riskKey (n/a for sqlite, but path is shown plainly)", () => {
      expect(queryDatabaseTool.describeCall!({ connectionString: dbUrl, query: "SELECT 1" })).toContain("data.db");
    });
  });

  describe("unrecognized connection strings", () => {
    it("rejects a connection string with no recognized scheme", async () => {
      const result = await queryDatabaseTool.handler({ connectionString: "mongodb://localhost/db", query: "{}" }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unrecognized connection string");
    });
  });

  describe("postgres/mysql (connection-handling only — no live server in this environment)", () => {
    it("fails cleanly, not by throwing, when a postgres connection is refused", async () => {
      const result = await queryDatabaseTool.handler(
        { connectionString: "postgres://user:pass@127.0.0.1:1/db", query: "SELECT 1" },
        ctx(),
      );
      expect(result.isError).toBe(true);
    });

    it("fails cleanly, not by throwing, when a mysql connection is refused", async () => {
      const result = await queryDatabaseTool.handler(
        { connectionString: "mysql://user:pass@127.0.0.1:1/db", query: "SELECT 1" },
        ctx(),
      );
      expect(result.isError).toBe(true);
    });

    it("redacts the password from describeCall/riskKey for a postgres connection string", () => {
      const input = { connectionString: "postgres://myuser:supersecret@host:5432/db", query: "SELECT 1" };
      expect(queryDatabaseTool.describeCall!(input)).not.toContain("supersecret");
      expect(queryDatabaseTool.riskKey!(input)).not.toContain("supersecret");
      expect(queryDatabaseTool.describeCall!(input)).toContain("myuser");
    });

    it("redacts the password from describeCall/riskKey for a mysql connection string", () => {
      const input = { connectionString: "mysql://root:hunter2@localhost:3306/db", query: "SELECT 1" };
      expect(queryDatabaseTool.describeCall!(input)).not.toContain("hunter2");
      expect(queryDatabaseTool.riskKey!(input)).not.toContain("hunter2");
    });
  });
});
