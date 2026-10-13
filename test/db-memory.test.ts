import { afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `DATABASE_FILE=:memory:` is how the test suites open a database, and it is not a file: nothing
 * about it belongs on disk. Opening one used to create `DATA_DIR` (the checkout's `data/` when
 * unset) and restrict it, a directory nothing would then use. One that does not exist yet is named
 * here and must still not exist after.
 */
const DATA_DIR = path.join(os.tmpdir(), `ds-memory-${process.pid}-${Date.now()}`);
process.env.DATA_DIR = DATA_DIR;
process.env.DATABASE_FILE = ":memory:";

const { getDb } = await import("@/lib/db");

afterAll(() => {
  delete process.env.DATA_DIR;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

it("opens an in-memory database without creating the data directory", () => {
  expect(getDb().prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  expect(fs.existsSync(DATA_DIR)).toBe(false);
});
