// How "hot" is decided (spec §4): every candidate gets a score, the same story from several sources is merged
// into one, and each market shows its top items above the minimum score, never two on the same stock.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Words from `words` found in `text`. English matches whole words, case-insensitive unless the word has capitals
 * ("FDA", "Fed"). Hebrew allows up to two prefix letters (ו, ה, ב, ל, מ, ש, כ) and any ending, so "כנס" matches
 * "בכנס" but not "נכנס".
 */
export function findKeywords(text, words, lang) {
  return words.filter((w) => {
    if (lang === "he") return new RegExp(`(^|[^\\p{L}])[והבלמשכ]{0,2}${escapeRe(w)}`, "u").test(text);
    const flags = w === w.toLowerCase() ? "i" : "";
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRe(w)}($|[^A-Za-z0-9])`, flags).test(text);
  });
}

const minutesBetween = (a, b) => (b.getTime() - new Date(a).getTime()) / 60_000;

/** Why a news item can't be shown at all, or null when it's fine. */
export function rejectReason(item, config, lang, now, maxAgeMinutes = config.maxAgeMinutes) {
  if (config.blockedSources.includes(item.provider)) return "blocked source";
  const age = minutesBetween(item.publishedAt, now);
  if (!(age <= maxAgeMinutes)) return "too old";
  if (age < -10) return "published in the future";
  if (findKeywords(item.title, config.routineKeywords[lang] ?? [], lang).length) return "routine";
  if (findKeywords(item.title, config.excludeKeywords[lang] ?? [], lang).length) return "out of scope";
  const prefixes = config.excludeSymbolPrefixes;
  if (item.symbols.length && item.symbols.every((s) => prefixes.some((p) => s.startsWith(p)))) return "out of scope";
  return null;
}

/** Score of one candidate before merging sources; `reasons` explains it (kept in the data file for debugging). */
export function baseScore(c, config, market) {
  const s = config.scores;
  let score = 0;
  const reasons = [];
  if (c.move != null && Math.abs(c.move) >= market.moveThresholdPct) {
    score += s.move + Math.min(s.moveExtraMax, Math.round((Math.abs(c.move) - market.moveThresholdPct) * s.movePerPct));
    reasons.push(`move ${c.move.toFixed(1)}%`);
    if (c.relVolume >= market.relVolumeBonusAt) {
      score += s.relVolume;
      reasons.push(`volume x${c.relVolume.toFixed(1)}`);
    }
  } else {
    score += s.feedBase;
  }
  if (config.leadingSources.includes(c.provider)) {
    score += s.leadingSource;
    reasons.push(`leading source ${c.provider}`);
  }
  const hits = findKeywords(c.title, config.keywords[market.lang] ?? [], market.lang);
  if (hits.length) {
    score += Math.min(s.keywordMax, hits.length * s.keyword);
    reasons.push(`keywords: ${hits.join(", ")}`);
  }
  return { score, reasons, keywordHits: hits.length };
}

const STOP = new Set(["the", "and", "for", "with", "from", "after", "into", "that", "this", "its", "are", "has", "says", "said", "של", "על", "את", "עם", "אחרי", "לא", "גם", "כי"]);
export function tokens(title) {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

/** Two titles tell the same story when they share at least half of the smaller title's words. */
export function sameStory(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  const small = Math.min(ta.size, tb.size);
  if (small < 3) return false;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / small >= 0.5;
}

/**
 * Pick the market's items. Candidates: { ticker, change, move, relVolume, title, provider, url, publishedAt,
 * corroborating: provider ids also reporting it, feed: true for general-feed items that need a hot keyword }.
 * Feed items may be older than maxAgeMinutes: they're only used by the fallback (see `fillFallback`).
 */
export function pickHot(candidates, config, market, now = new Date()) {
  const fresh = candidates.filter((c) => minutesBetween(c.publishedAt, now) <= config.maxAgeMinutes);
  const scored = fresh
    .map((c) => ({ ...c, ...baseScore(c, config, market) }))
    // A general-feed story is hot only for a reason: a hot keyword or a real move on its stock.
    .filter((c) => !c.feed || c.keywordHits > 0 || (c.move != null && Math.abs(c.move) >= market.moveThresholdPct));

  // Merge the same story: same stock, or titles that say the same thing.
  const parent = scored.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < scored.length; i++)
    for (let j = i + 1; j < scored.length; j++) {
      const a = scored[i];
      const b = scored[j];
      if ((a.ticker && a.ticker === b.ticker) || sameStory(a.title, b.title)) parent[find(j)] = find(i);
    }
  const clusters = new Map();
  scored.forEach((c, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), c]));

  const s = config.scores;
  const stories = [...clusters.values()].map((members) => {
    const providers = new Set(members.flatMap((m) => [m.provider, ...(m.corroborating ?? [])]));
    const best = members.reduce((a, b) => (b.score > a.score ? b : a));
    // Show the story from a leading source when one has it (spec §4, no duplicates).
    const shown = members.filter((m) => config.leadingSources.includes(m.provider)).sort((a, b) => b.score - a.score)[0] ?? best;
    const withStock = members.find((m) => m.ticker) ?? shown;
    const extra = Math.min(s.extraSourceMax, (providers.size - 1) * s.extraSource);
    return {
      ...shown,
      ticker: shown.ticker ?? withStock.ticker ?? null,
      change: shown.change ?? withStock.change ?? null,
      score: best.score + extra,
      reasons: [...best.reasons, ...(extra ? [`${providers.size} sources`] : [])],
    };
  });

  const picked = [];
  const tickers = new Set();
  for (const story of stories.filter((st) => st.score >= config.minScore).sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt))) {
    if (story.ticker && tickers.has(story.ticker)) continue;
    picked.push(story);
    if (story.ticker) tickers.add(story.ticker);
    if (picked.length === config.itemsPerMarket) break;
  }
  return fillFallback(picked, candidates, config, market, now);
}

/**
 * When fewer than itemsPerMarket stories are hot (a quiet market, or TASE movers without Hebrew headlines), fill
 * the rest with the latest general market news from a leading source, up to fallback.maxAgeMinutes old, still
 * without routine or out-of-scope items, duplicates or a second story on the same stock.
 */
export function fillFallback(picked, candidates, config, market, now) {
  const fb = config.fallback;
  if (!fb?.enabled || picked.length >= config.itemsPerMarket) return picked;
  const out = [...picked];
  const pool = candidates
    .filter((c) => c.feed && config.leadingSources.includes(c.provider) && minutesBetween(c.publishedAt, now) <= fb.maxAgeMinutes)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  for (const c of pool) {
    const dup = out.some((p) => p.url === c.url || (c.ticker && p.ticker === c.ticker) || sameStory(p.title, c.title));
    if (dup) continue;
    out.push({ ...c, score: 0, reasons: ["fallback: latest market news"], fallback: true });
    if (out.length === config.itemsPerMarket) break;
  }
  return out;
}
