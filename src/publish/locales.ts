/**
 * README copy, one entry per language.
 *
 * The data repo keeps a README per language, each carrying the same
 * <!-- RANKINGS:START/END --> markers, so the daily run refreshes every one of them.
 *
 * Column keys live in COLUMNS once, shared by all languages: a translation supplies
 * only the copy it actually translates and falls back to English for the rest. A
 * missing translation then shows an English header instead of shifting a table out
 * of alignment. Only four kinds of string are translatable — list title, column
 * header, the "last updated" line and the full-list link prefix. Table data (skill
 * names, vendors, numbers) is language-neutral by nature.
 *
 * Adding a language: create README.<code>.md in the data repo with the markers in
 * place, then append a Locale here. Both halves are needed — a README without an
 * entry never gets rendered, an entry without a README is skipped with a warning.
 */

export const PREVIEW_ROWS = 10;

/** Ranking lists in README order, each with the CSV columns its preview shows. */
export const COLUMNS: Record<string, readonly string[]> = {
  "best-100": ["rank", "skill", "vendor", "wis", "coverage"],
  "top-installs": ["rank", "skill", "installs_skillssh", "downloads_clawhub", "downloads_skillhub_cn"],
  "trending-7d": ["rank", "skill", "installs_skillssh", "growth_pct"],
  "social-buzz": ["rank", "skill", "x_mentions_7d", "hn_hits_7d", "bsky_hits_7d", "gh_mentions_7d"],
  "most-active": ["rank", "skill", "last_update", "versions_clawhub"],
  "official-100": ["rank", "skill", "vendor", "verified_by"],
  "official-vendors": ["rank", "platform", "vendor", "skills_count", "total_installs_or_downloads"],
  "top-repos": ["rank", "repo", "stars", "pushed_at"],
  "rising-stars": ["rank", "skill", "first_seen_days", "pop_score"],
};

export interface Locale {
  /** README file name in the data repo root. */
  file: string;
  /** The line above the lists. */
  lastUpdated: (date: string) => string;
  /**
   * Prefix of the full-list link, separator included — English needs a trailing
   * space, zh/ja end on a full-width colon that takes none.
   */
  fullList: string;
  /** List title shown in <summary>, by list name. */
  titles: Record<string, string>;
  /** Column header, by list name then column key. */
  labels: Record<string, Record<string, string>>;
}

/** English is the fallback for every other language, so its copy must be complete. */
const EN: Locale = {
  file: "README.md",
  lastUpdated: (date) =>
    `> Last updated: **${date}** (UTC) · Top ${PREVIEW_ROWS} preview per list — full Top 100 in the CSVs.`,
  fullList: "➡️ Full list: ",
  titles: {
    "best-100": "🏆 Best 100 (Worth-Installing Score)",
    "top-installs": "📈 Top Installs (all ecosystems)",
    "trending-7d": "🚀 Trending (7 days)",
    "social-buzz": "💬 Social Buzz (X · HN · Bluesky · GitHub, 7 days)",
    "most-active": "🔧 Most Active (popular & frequently updated)",
    "official-100": "✅ Official 100 (verified publishers)",
    "official-vendors": "🏢 Official Vendors (grouped by platform)",
    "top-repos": "⭐ Top Repositories",
    "rising-stars": "🌱 Rising Stars (under 30 days old)",
  },
  labels: {
    "best-100": { rank: "#", skill: "Skill", vendor: "Vendor", wis: "WIS", coverage: "Cov" },
    "top-installs": { rank: "#", skill: "Skill", installs_skillssh: "skills.sh", downloads_clawhub: "ClawHub", downloads_skillhub_cn: "SkillHub CN" },
    "trending-7d": { rank: "#", skill: "Skill", installs_skillssh: "Installs", growth_pct: "Weekly Δ%" },
    "social-buzz": { rank: "#", skill: "Skill", x_mentions_7d: "X", hn_hits_7d: "HN", bsky_hits_7d: "Bluesky", gh_mentions_7d: "GitHub" },
    "most-active": { rank: "#", skill: "Skill", last_update: "Updated", versions_clawhub: "Versions" },
    "official-100": { rank: "#", skill: "Skill", vendor: "Vendor", verified_by: "Verified by" },
    "official-vendors": { rank: "#", platform: "Platform", vendor: "Vendor", skills_count: "Skills", total_installs_or_downloads: "Installs/Downloads" },
    "top-repos": { rank: "#", repo: "Repository", stars: "Stars", pushed_at: "Pushed" },
    "rising-stars": { rank: "#", skill: "Skill", first_seen_days: "Age (days)", pop_score: "Popularity" },
  },
};

const ZH_CN: Locale = {
  file: "README.zh-CN.md",
  lastUpdated: (date) =>
    `> 最后更新：**${date}**（UTC）· 每个榜单预览 Top ${PREVIEW_ROWS}——完整 Top 100 见 CSV 文件。`,
  fullList: "➡️ 完整榜单：",
  titles: {
    "best-100": "🏆 最佳 100（值得安装得分）",
    "top-installs": "📈 安装量排行（所有生态）",
    "trending-7d": "🚀 趋势榜（7 天）",
    "social-buzz": "💬 社交热度（X · HN · Bluesky · GitHub，7 天）",
    "most-active": "🔧 最活跃（热门且频繁更新）",
    "official-100": "✅ 官方 100（已验证发布者）",
    "official-vendors": "🏢 官方发布者（按平台分组）",
    "top-repos": "⭐ 热门仓库",
    "rising-stars": "🌱 新星榜（创建未满 30 天）",
  },
  labels: {
    "best-100": { vendor: "发布者", coverage: "覆盖度" },
    "top-installs": { downloads_skillhub_cn: "SkillHub 中国区" },
    "trending-7d": { installs_skillssh: "安装量", growth_pct: "周增长 Δ%" },
    "most-active": { last_update: "更新时间", versions_clawhub: "版本数" },
    "official-100": { vendor: "发布者", verified_by: "验证方" },
    "official-vendors": { platform: "平台", vendor: "发布者", skills_count: "Skills 数量", total_installs_or_downloads: "安装量/下载量" },
    "top-repos": { repo: "仓库", pushed_at: "最近推送" },
    "rising-stars": { first_seen_days: "天数", pop_score: "热度" },
  },
};

const JA: Locale = {
  file: "README.ja.md",
  lastUpdated: (date) =>
    `> 最終更新：**${date}**（UTC）· 各リストの Top ${PREVIEW_ROWS} を表示——完全な Top 100 は CSV を参照してください。`,
  fullList: "➡️ 完全版：",
  titles: {
    "best-100": "🏆 Best 100（導入価値スコア）",
    "top-installs": "📈 インストール数上位（全エコシステム）",
    "trending-7d": "🚀 トレンド（7 日間）",
    "social-buzz": "💬 ソーシャルでの話題性（X · HN · Bluesky · GitHub、7 日間）",
    "most-active": "🔧 最も活発（人気があり更新頻度が高い）",
    "official-100": "✅ Official 100（認証済みパブリッシャー）",
    "official-vendors": "🏢 公式ベンダー（プラットフォーム別）",
    "top-repos": "⭐ 上位リポジトリ",
    "rising-stars": "🌱 注目の新星（公開から 30 日未満）",
  },
  labels: {
    "best-100": { vendor: "ベンダー", coverage: "カバレッジ" },
    "top-installs": { downloads_skillhub_cn: "SkillHub 中国" },
    "trending-7d": { installs_skillssh: "インストール数", growth_pct: "週間 Δ%" },
    "most-active": { last_update: "更新日", versions_clawhub: "バージョン数" },
    "official-100": { vendor: "ベンダー", verified_by: "認証元" },
    "official-vendors": { platform: "プラットフォーム", vendor: "ベンダー", skills_count: "Skills 数", total_installs_or_downloads: "インストール/ダウンロード数" },
    "top-repos": { repo: "リポジトリ", pushed_at: "最終プッシュ" },
    "rising-stars": { first_seen_days: "経過日数", pop_score: "人気度" },
  },
};

const KO: Locale = {
  file: "README.ko.md",
  lastUpdated: (date) =>
    `> 마지막 업데이트: **${date}** (UTC) · 각 목록의 Top ${PREVIEW_ROWS} 미리 보기 — 전체 Top 100은 CSV에서 확인하세요.`,
  fullList: "➡️ 전체 목록: ",
  titles: {
    "best-100": "🏆 Best 100 (설치 가치 점수)",
    "top-installs": "📈 설치 수 상위 (모든 생태계)",
    "trending-7d": "🚀 트렌드 (7일)",
    "social-buzz": "💬 소셜 화제성 (X · HN · Bluesky · GitHub, 7일)",
    "most-active": "🔧 가장 활발함 (인기 있고 자주 업데이트됨)",
    "official-100": "✅ Official 100 (검증된 게시자)",
    "official-vendors": "🏢 공식 공급자 (플랫폼별 그룹)",
    "top-repos": "⭐ 상위 저장소",
    "rising-stars": "🌱 떠오르는 신예 (등록 후 30일 미만)",
  },
  labels: {
    "best-100": { vendor: "공급자", coverage: "커버리지" },
    "top-installs": { downloads_skillhub_cn: "SkillHub 중국" },
    "trending-7d": { installs_skillssh: "설치 수", growth_pct: "주간 Δ%" },
    "most-active": { last_update: "업데이트", versions_clawhub: "버전 수" },
    "official-100": { vendor: "공급자", verified_by: "검증 플랫폼" },
    "official-vendors": { platform: "플랫폼", vendor: "공급자", skills_count: "Skills 수", total_installs_or_downloads: "설치/다운로드 수" },
    "top-repos": { repo: "저장소", pushed_at: "최근 푸시" },
    "rising-stars": { first_seen_days: "경과 일수", pop_score: "인기도" },
  },
};

const DE: Locale = {
  file: "README.de.md",
  lastUpdated: (date) =>
    `> Zuletzt aktualisiert: **${date}** (UTC) · Top-${PREVIEW_ROWS}-Vorschau je Liste – die vollständigen Top 100 stehen in den CSV-Dateien.`,
  fullList: "➡️ Vollständige Liste: ",
  titles: {
    "best-100": "🏆 Beste 100 (Installationswert)",
    "top-installs": "📈 Meiste Installationen (alle Ökosysteme)",
    "trending-7d": "🚀 Trends (7 Tage)",
    "social-buzz": "💬 Soziale Resonanz (X · HN · Bluesky · GitHub, 7 Tage)",
    "most-active": "🔧 Aktivste Skills (beliebt und häufig aktualisiert)",
    "official-100": "✅ Offizielle 100 (verifizierte Herausgeber)",
    "official-vendors": "🏢 Offizielle Anbieter (nach Plattform gruppiert)",
    "top-repos": "⭐ Top-Repositorys",
    "rising-stars": "🌱 Aufsteiger (jünger als 30 Tage)",
  },
  labels: {
    "best-100": { vendor: "Anbieter", coverage: "Abdeckung" },
    "top-installs": { downloads_skillhub_cn: "SkillHub China" },
    "trending-7d": { installs_skillssh: "Installationen", growth_pct: "Wöchentliches Δ%" },
    "most-active": { last_update: "Aktualisiert", versions_clawhub: "Versionen" },
    "official-100": { vendor: "Anbieter", verified_by: "Verifiziert durch" },
    "official-vendors": { platform: "Plattform", vendor: "Anbieter", total_installs_or_downloads: "Installationen/Downloads" },
    "top-repos": { pushed_at: "Letzter Push" },
    "rising-stars": { first_seen_days: "Alter (Tage)", pop_score: "Beliebtheit" },
  },
};

const ES: Locale = {
  file: "README.es.md",
  lastUpdated: (date) =>
    `> Última actualización: **${date}** (UTC) · Vista previa del Top ${PREVIEW_ROWS} de cada lista; el Top 100 completo está en los CSV.`,
  fullList: "➡️ Lista completa: ",
  titles: {
    "best-100": "🏆 Mejores 100 (puntuación de valor de instalación)",
    "top-installs": "📈 Más instalaciones (todos los ecosistemas)",
    "trending-7d": "🚀 Tendencias (7 días)",
    "social-buzz": "💬 Repercusión social (X · HN · Bluesky · GitHub, 7 días)",
    "most-active": "🔧 Más activas (populares y actualizadas con frecuencia)",
    "official-100": "✅ 100 oficiales (editores verificados)",
    "official-vendors": "🏢 Proveedores oficiales (agrupados por plataforma)",
    "top-repos": "⭐ Repositorios principales",
    "rising-stars": "🌱 Estrellas emergentes (menos de 30 días)",
  },
  labels: {
    "best-100": { vendor: "Proveedor", coverage: "Cobertura" },
    "top-installs": { downloads_skillhub_cn: "SkillHub China" },
    "trending-7d": { installs_skillssh: "Instalaciones", growth_pct: "Δ% semanal" },
    "most-active": { last_update: "Actualización", versions_clawhub: "Versiones" },
    "official-100": { vendor: "Proveedor", verified_by: "Verificado por" },
    "official-vendors": { platform: "Plataforma", vendor: "Proveedor", total_installs_or_downloads: "Instalaciones/descargas" },
    "top-repos": { repo: "Repositorio", pushed_at: "Último push" },
    "rising-stars": { first_seen_days: "Antigüedad (días)", pop_score: "Popularidad" },
  },
};

/** English first: it is the fallback, and rendering it is what must never silently fail. */
export const BASE = EN;
export const LOCALES: readonly Locale[] = [EN, ZH_CN, JA, KO, DE, ES];

/** Column header for a list, falling back to English and then to the raw column key. */
export function labelOf(locale: Locale, list: string, col: string): string {
  return locale.labels[list]?.[col] ?? BASE.labels[list]?.[col] ?? col;
}

/** List title, falling back to English and then to the raw list name. */
export function titleOf(locale: Locale, list: string): string {
  return locale.titles[list] ?? BASE.titles[list] ?? list;
}
