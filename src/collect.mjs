// One collection run (spec §7): for every market whose window is open, gather candidates, score them, and write
// the top items to data/hot-news.json. Markets outside their window keep what was collected last.
//
//   node src/collect.mjs           respect the windows
//   node src/collect.mjs --force   collect every enabled market now
//   node src/collect.mjs --dry     print the result instead of writing it

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isPreMarket, isWindowOpen } from "./schedule.mjs";
import { pickHot, rejectReason, findKeywords } from "./score.mjs";
import { fetchArticleImage, fetchMovers, fetchQuotes, fetchRss, fetchSec8K, fetchTvNews, logoUrl } from "./sources.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = process.env.HOT_NEWS_CONFIG || join(ROOT, "config.json");
const DATA_PATH = join(ROOT, "data", "hot-news.json");

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Run `fn`, logging and returning `fallback` when the source fails (spec §9: other sources carry on). */
async function attempt(label, errors, fn, fallback = []) {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    console.warn(`[warn] ${label}: ${err.message}`);
    return fallback;
  }
}

const isLeading = (config, item) => config.leadingSources.includes(item.provider);
const newestFirst = (a, b) => b.publishedAt.localeCompare(a.publishedAt);

/** The headline that best explains a move: leading source, then hot keywords, then the newest. */
function bestHeadline(items, config, market) {
  const kw = (i) => findKeywords(i.title, config.keywords[market.lang] ?? [], market.lang).length;
  return [...items].sort((a, b) => isLeading(config, b) - isLeading(config, a) || kw(b) - kw(a) || newestFirst(a, b))[0];
}

/** Every candidate story for one market. Throws only when no source at all could be read. */
async function collectMarket(key, market, config, now) {
  const errors = [];
  const usable = (items) => items.filter((i) => !rejectReason(i, config, market.lang, now));
  const inMarket = (symbol) => market.symbolPrefixes.some((p) => symbol.startsWith(p));
  const stockOf = (symbols) => {
    const stocks = symbols.filter((s) => market.exchanges.some((ex) => s.startsWith(`${ex}:`)));
    return stocks.length === 1 ? stocks[0] : null;
  };
  const preMarket = isPreMarket(market, now);

  const [movers, feed, rss, sec] = await Promise.all([
    attempt(`${key} scanner`, errors, () => fetchMovers(key, market, preMarket), null),
    market.feedProviders.length ? attempt(`${key} feed`, errors, () => fetchTvNews({ lang: market.lang, provider: market.feedProviders }), null) : [],
    Promise.all(market.rss.map((feed) => attempt(`${key} rss ${feed.id}`, errors, () => fetchRss(feed), null))),
    market.useSec8K ? attempt(`${key} sec`, errors, fetchSec8K, null) : [],
  ]);
  const sourcesRead = [movers, feed, ...rss, sec].filter((s) => s !== null).length;
  if (!sourcesRead) throw new Error(errors.join("; "));
  const secFresh = usable(sec ?? []);

  // 1. Stocks moving hard right now, each with the news that explains why.
  const moverCandidates = await mapLimit(movers ?? [], 4, async (m) => {
    const news = usable(await attempt(`${key} news ${m.symbol}`, errors, () => fetchTvNews({ lang: market.lang, symbol: m.symbol })));
    const filings = secFresh.filter((f) => f.ticker === m.ticker);
    const head = bestHeadline(news, config, market) ?? filings[0];
    if (!head) return null;
    return {
      ...head,
      ticker: m.ticker,
      change: m.move,
      move: m.move,
      relVolume: preMarket ? null : m.relVolume,
      logoid: m.logoid,
      corroborating: [...new Set([...news, ...filings].map((n) => n.provider))],
    };
  });

  // 2. General market news: macro stories, or a story on one stock that we then look up.
  const feedItems = usable([...(feed ?? []), ...rss.flat().filter(Boolean)]).filter((i) => !i.symbols.length || i.symbols.some(inMarket));
  const feedStocks = [...new Set(feedItems.map((i) => stockOf(i.symbols)).filter(Boolean))];
  const quotes = new Map((await attempt(`${key} quotes`, errors, () => fetchQuotes(key, market, feedStocks))).map((q) => [q.symbol, q]));
  const feedCandidates = feedItems.flatMap((i) => {
    const stock = stockOf(i.symbols);
    if (!stock) return [{ ...i, ticker: null, change: null, move: null, feed: true }];
    const q = quotes.get(stock);
    // A stock story on a stock outside the filters (OTC, small cap, thin turnover) is skipped.
    if (!q) return [];
    const move = preMarket ? q.premarketChange : q.change;
    return [{ ...i, ticker: q.ticker, change: move ?? null, move: move ?? null, relVolume: preMarket ? null : q.relVolume, logoid: q.logoid, feed: true }];
  });

  // 3. With the scanner down, material 8-K filings stand in for movers (spec §9).
  const secCandidates = movers === null ? secFresh.map((f) => ({ ...f, change: null, move: null, feed: true })) : [];

  return { candidates: [...moverCandidates.filter(Boolean), ...feedCandidates, ...secCandidates], errors };
}

/**
 * The picture beside a story: the article's own photo (RSS image or og:image), else the company logo, else none
 * (the card shows a neutral icon). Images are hotlinked from their hosts, never copied.
 */
async function imageFor(story, errors) {
  const photo = story.image ?? (await attempt(`image ${story.url}`, errors, () => fetchArticleImage(story.url), null));
  if (photo) return { url: photo, kind: "photo" };
  return story.logoid ? { url: logoUrl(story.logoid), kind: "logo" } : null;
}

function toItem(story, config, market) {
  return {
    id: story.id,
    ticker: story.ticker,
    change: story.change == null ? null : Math.round(story.change * 100) / 100,
    title: story.title,
    lang: market.lang,
    source: config.sourceNames[story.provider] ?? story.provider,
    sourceId: story.provider,
    url: story.url,
    publishedAt: story.publishedAt,
    image: story.imageInfo ?? null,
    score: story.score,
    reasons: story.reasons,
  };
}

export async function run({ force = false, dry = false, now = new Date() } = {}) {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const previous = await readFile(DATA_PATH, "utf8").then(JSON.parse, () => null);
  const markets = {};
  let collected = 0;

  for (const [key, market] of Object.entries(config.markets)) {
    const before = previous?.markets?.[key];
    const window = { ...market.window };
    if (!market.enabled) {
      markets[key] = { enabled: false, window, updatedAt: before?.updatedAt ?? null, items: [] };
      continue;
    }
    if (!force && !isWindowOpen(market.window, now)) {
      markets[key] = { ...before, enabled: true, window, items: before?.items ?? [], updatedAt: before?.updatedAt ?? null };
      console.log(`[${key}] window closed, keeping ${markets[key].items.length} items`);
      continue;
    }
    collected++;
    try {
      const { candidates, errors } = await collectMarket(key, market, config, now);
      const picked = pickHot(candidates, config, market);
      await Promise.all(picked.map(async (s) => (s.imageInfo = await imageFor(s, errors))));
      const items = picked.map((s) => toItem(s, config, market));
      markets[key] = { enabled: true, window, updatedAt: now.toISOString(), items, ...(errors.length ? { warnings: errors } : {}) };
      console.log(`[${key}] ${candidates.length} candidates -> ${items.length} items`);
      for (const i of items) console.log(`   ${i.score}  ${i.ticker ?? "macro"} ${i.change ?? ""}  ${i.title}  (${i.source}; ${i.reasons.join("; ")})`);
    } catch (err) {
      // Nothing could be read: keep the last items; the card shows "update delayed" once they're stale.
      console.error(`[${key}] failed: ${err.message}`);
      markets[key] = { ...before, enabled: true, window, items: before?.items ?? [], updatedAt: before?.updatedAt ?? null, error: err.message };
    }
  }

  if (!collected) {
    console.log("No market window is open; nothing to do.");
    return null;
  }
  const data = {
    version: 1,
    generatedAt: now.toISOString(),
    maxAgeMinutes: config.maxAgeMinutes,
    staleAfterMinutes: config.staleAfterMinutes,
    markets,
  };
  if (dry) console.log(JSON.stringify(data, null, 2));
  else {
    await mkdir(dirname(DATA_PATH), { recursive: true });
    await writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
  }
  return data;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  run({ force: args.has("--force"), dry: args.has("--dry") }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
