import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type CsvValue = string | number | boolean | null | undefined;

function escapeCell(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Quote when the cell contains separator, quote, or newline
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Write rows as CSV. Columns are taken from `columns` to keep a stable order. */
export function writeCsv(
  filePath: string,
  columns: string[],
  rows: Array<Record<string, CsvValue>>,
): void {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c])).join(","));
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

/** Parse a CSV file written by writeCsv back into records keyed by header. */
export function readCsv(filePath: string): Array<Record<string, string>> {
  const text = readFileSync(filePath, "utf8");
  const rows = parseCsvText(text);
  const header = rows[0];
  if (!header) return [];
  return rows.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      rec[h] = cells[i] ?? "";
    });
    return rec;
  });
}

function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}
