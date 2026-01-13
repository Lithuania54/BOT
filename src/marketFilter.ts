import { Config } from "./types";

type MarketCategoryDecision = {
  allowed: boolean;
  reasonCode?: "SKIP_CATEGORY_SPORTS" | "SKIP_CATEGORY_NOT_ALLOWED";
  reason?: string;
  matchSource?: "category" | "title";
  matched?: string;
  categories?: string[];
  title?: string;
};

const SPORTS_KEYWORDS = new Set([
  "soccer",
  "football",
  "basketball",
  "baseball",
  "hockey",
  "tennis",
  "golf",
  "cricket",
  "rugby",
  "boxing",
  "mma",
  "ufc",
  "nascar",
  "formula-1",
  "f1",
  "olympics",
  "world-cup",
  "premier-league",
  "champions-league",
  "la-liga",
  "serie-a",
  "bundesliga",
  "ligue-1",
  "nba",
  "nfl",
  "mlb",
  "nhl",
  "mls",
  "wimbledon",
]);

const SPORTS_TITLE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "versus", regex: /\bvs\.?\b|\bv\.\b/ },
  { label: "over-under", regex: /\bover\/under\b|\bo\/u\b/ },
  { label: "both-teams-score", regex: /\bboth teams to score\b/ },
  { label: "moneyline", regex: /\bmoneyline\b/ },
  { label: "spread", regex: /\bpoint spread\b|\bspread\b/ },
  { label: "win-on", regex: /\bwin on\b/ },
  { label: "club-fc", regex: /\bfc\b|\bclub\b/ },
  {
    label: "league-keywords",
    regex:
      /\b(nfl|nba|mlb|nhl|mls|ufc|f1|formula 1|premier league|champions league|la liga|serie a|bundesliga|ligue 1|world cup|olympics|wimbledon|cricket|rugby|soccer|football|basketball|baseball|hockey|tennis|golf|mma|boxing|nascar)\b/,
  },
];

export function normalizeCategoryToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function extractMarketTitle(market: any): string | undefined {
  if (!market) return undefined;
  return market?.question || market?.title || market?.name || market?.slug;
}

function collectStrings(value: unknown, out: string[]) {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number") {
    const raw = String(value);
    const parts = raw.split(/[\/,|]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      out.push(...parts);
    } else {
      out.push(raw);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = ["name", "label", "slug", "category", "tag", "value"];
    for (const key of keys) {
      if (obj[key]) collectStrings(obj[key], out);
    }
  }
}

function extractMarketCategories(market: any): string[] {
  if (!market) return [];
  const raw: string[] = [];
  const fields = [
    market?.category,
    market?.categories,
    market?.category_slug,
    market?.categorySlug,
    market?.categoryName,
    market?.marketCategory,
    market?.market_category,
    market?.group,
    market?.groupName,
    market?.tags,
    market?.tag,
    market?.market_tags,
    market?.marketTags,
  ];
  for (const field of fields) collectStrings(field, raw);
  const normalized = raw.map(normalizeCategoryToken).filter(Boolean);
  return Array.from(new Set(normalized));
}

function matchSportsTitle(title: string): { matched: boolean; pattern?: string } {
  const normalized = title.toLowerCase();
  for (const pattern of SPORTS_TITLE_PATTERNS) {
    if (pattern.regex.test(normalized)) return { matched: true, pattern: pattern.label };
  }
  return { matched: false };
}

export function isSportsTitle(title: string): boolean {
  return matchSportsTitle(title).matched;
}

function findDisallowedCategory(categories: string[], disallowed: Set<string>): string | null {
  if (disallowed.size === 0) return null;
  for (const category of categories) {
    if (disallowed.has(category)) return category;
    if (disallowed.has("sports")) {
      if (category.includes("sport") || SPORTS_KEYWORDS.has(category)) return category;
    }
  }
  return null;
}

export function evaluateMarketCategory(market: any, config: Config): MarketCategoryDecision {
  if (!market) return { allowed: true };
  const categories = extractMarketCategories(market);
  const title = extractMarketTitle(market);
  const allowedSet = new Set(config.allowedCategories.map(normalizeCategoryToken).filter(Boolean));
  const disallowedSet = new Set(config.disallowedCategories.map(normalizeCategoryToken).filter(Boolean));

  if (categories.length > 0) {
    const disallowedMatch = findDisallowedCategory(categories, disallowedSet);
    if (disallowedMatch) {
      return {
        allowed: false,
        reasonCode: "SKIP_CATEGORY_SPORTS",
        reason: "market categorized as sports",
        matchSource: "category",
        matched: disallowedMatch,
        categories,
        title,
      };
    }
    if (allowedSet.size > 0 && !categories.some((category) => allowedSet.has(category))) {
      return {
        allowed: false,
        reasonCode: "SKIP_CATEGORY_NOT_ALLOWED",
        reason: "market category not in allowlist",
        matchSource: "category",
        categories,
        title,
      };
    }
    return { allowed: true, categories, title };
  }

  if (title) {
    const titleMatch = matchSportsTitle(title);
    if (titleMatch.matched) {
      return {
        allowed: false,
        reasonCode: "SKIP_CATEGORY_SPORTS",
        reason: "sports title match",
        matchSource: "title",
        matched: titleMatch.pattern,
        title,
      };
    }
  }

  return { allowed: true, title };
}
