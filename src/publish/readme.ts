import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../lib/log.js";
import { BASE, COLUMNS, LOCALES, PREVIEW_ROWS, labelOf, titleOf, type Locale } from "./locales.js";
import type { RawTable } from "../sources/types.js";

const START = "<!-- RANKINGS:START -->";
const END = "<!-- RANKINGS:END -->";

function fmt(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  // Thousands separators stay en-US in every language: the same number must read the
  // same across READMEs, and de/es grouping (1.234) reads as a decimal to everyone else.
  if (typeof v === "number" && Number.isInteger(v) && v >= 10_000) return v.toLocaleString("en-US");
  return String(v).replace(/\|/g, "\\|");
}

function renderTable(table: RawTable, date: string, locale: Locale): string {
  const cols = COLUMNS[table.name];
  if (!cols) return "";
  const rows = table.rows.slice(0, PREVIEW_ROWS);
  const header = `| ${cols.map((c) => labelOf(locale, table.name, c)).join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const cell = (r: RawTable["rows"][number], k: string): string => {
    const v = fmt(r[k]);
    // X counts stop at the page cap — a capped 100 is "at least 100", not 100 (audit M9)
    const truncated = r["x_truncated"] === true || r["x_truncated"] === "true";
    return k === "x_mentions_7d" && truncated && v !== "—" ? `${v}+` : v;
  };
  const body = rows.map((r) => `| ${cols.map((c) => cell(r, c)).join(" | ")} |`).join("\n");
  const csvLink = `data/${date}/rankings/${table.name}.csv`;
  const title = titleOf(locale, table.name);
  return `<details${table.name === "best-100" ? " open" : ""}>\n<summary><b>${title}</b></summary>\n\n${header}\n${sep}\n${body}\n\n${locale.fullList}[${table.name}.csv](${csvLink})\n\n</details>`;
}

function renderBlock(date: string, tables: RawTable[], locale: Locale): string {
  const sections = Object.keys(COLUMNS)
    .map((name) => tables.find((t) => t.name === name))
    .filter((t): t is RawTable => t !== undefined && t.rows.length > 0)
    .map((t) => renderTable(t, date, locale))
    .join("\n\n");
  return `${START}\n\n${locale.lastUpdated(date)}\n\n${sections}\n\n${END}`;
}

/**
 * Flag translations the pipeline does not know about — a README added to the data repo
 * without a Locale entry silently freezes, which is exactly how the translations went
 * stale before this became multi-locale.
 */
function warnUnregistered(repoPath: string): void {
  const known = new Set(LOCALES.map((l) => l.file));
  for (const f of readdirSync(repoPath)) {
    if (/^README\..+\.md$/.test(f) && !known.has(f)) {
      log.warn("readme", `${f} has no entry in locales.ts — it will never be refreshed`);
    }
  }
}

/**
 * Replace the marked rankings block in every README of the data repo.
 *
 * The English README is the page people land on: a missing file or missing markers
 * there means the repo is broken and the run stops. Translations are additive — one
 * that has drifted is skipped with a warning rather than holding back the day's data.
 */
export function renderReadme(repoPath: string, date: string, tables: RawTable[]): void {
  warnUnregistered(repoPath);
  for (const locale of LOCALES) {
    const readmePath = join(repoPath, locale.file);
    if (!existsSync(readmePath)) {
      if (locale === BASE) throw new Error(`README not found: ${readmePath}`);
      log.warn("readme", `skipped ${locale.file} — file not found`);
      continue;
    }
    const readme = readFileSync(readmePath, "utf8");
    const startIdx = readme.indexOf(START);
    const endIdx = readme.indexOf(END);
    if (startIdx === -1 || endIdx === -1) {
      if (locale === BASE) throw new Error("README markers not found — cannot render rankings");
      log.warn("readme", `skipped ${locale.file} — rankings markers not found`);
      continue;
    }
    const block = renderBlock(date, tables, locale);
    writeFileSync(readmePath, readme.slice(0, startIdx) + block + readme.slice(endIdx + END.length), "utf8");
    log.info("readme", `rendered ${locale.file}`);
  }
}
