/** One CSV file produced by a collector. */
export interface RawTable {
  /** File name without extension, e.g. "skills-sh" → raw/skills-sh.csv */
  name: string;
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null | undefined>>;
}

export interface Collector {
  /** Source id used in logs and probe output. */
  id: string;
  collect(): Promise<RawTable[]>;
  /** Cheap single-request connectivity check. Throws on failure. */
  probe(): Promise<string>;
}
