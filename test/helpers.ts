import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCsv, type CsvValue } from "../src/lib/csv.js";

/** A throwaway data/ directory; call cleanup() when done. */
export function tempDataDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "best-skills-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Writes data/<date>/raw/<name>.csv with `n` rows of a single id column. */
export function writeRows(dataDir: string, date: string, name: string, n: number): void {
  writeCsv(
    join(dataDir, date, "raw", `${name}.csv`),
    ["id"],
    Array.from({ length: n }, (_, i) => ({ id: `row-${i}` })),
  );
}

export function writeRaw(dataDir: string, date: string, name: string, columns: string[], rows: Array<Record<string, CsvValue>>): void {
  writeCsv(join(dataDir, date, "raw", `${name}.csv`), columns, rows);
}

/** YYYY-MM-DD, `n` days before 2026-11-26 (the reference "today" of the fixtures). */
export function day(n: number): string {
  return new Date(Date.UTC(2026, 10, 26) - n * 86_400_000).toISOString().slice(0, 10);
}
