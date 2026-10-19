// Network access to the news sources (spec §3). Every function returns normalized data and throws on failure;
// the caller decides what a failed source means.

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const TV_HEADERS = { "User-Agent": BROWSER_UA, Origin: "https://www.tradingview.com", Referer: "https://www.tradingview.com/" };
const TIMEOUT_MS = 15_000;

async function request(url, { headers = {}, method = "GET", body } = {}) {
  const res = await fetch(url, { method, body, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status}`);
  return res;
}

// --- TradingView scanner ---------------------------------------------------------------------------------

const SCAN_COLUMNS = ["name", "description", "exchange", "change", "premarket_change", "relative_volume_10d_calc", "market_cap_basic", "Value.Traded", "type"];
const SCAN_REGION = { us: "america", il: "israel" };

function scanRow(row) {
  const [name, description, exchange, change, premarketChange, relVolume, marketCap, turnover, type] = row.d;
  return { symbol: row.s, ticker: name, description, exchange, change, premarketChange, relVolume, marketCap, turnover, type };
}

/** Market-specific filters: US = NYSE/NASDAQ above the cap floor; TASE = above the turnover floor (spec §4). */
function baseFilters(key, market) {
  const filters = [
    { left: "exchange", operation: "in_range", right: market.exchanges },
    { left: "type", operation: "in_range", right: ["stock", "dr"] },
  ];
  if (market.minMarketCapUsd) filters.push({ left: "market_cap_basic", operation: "greater", right: market.minMarketCapUsd });
  if (market.minTurnoverIls) filters.push({ left: "Value.Traded", operation: "greater", right: market.minTurnoverIls });
  return filters;
}

async function scan(key, body) {
  const res = await request(`https://scanner.tradingview.com/${SCAN_REGION[key]}/scan`, {
    method: "POST",
    headers: { ...TV_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ columns: SCAN_COLUMNS, options: { lang: "en" }, ...body }),
  });
  const json = await res.json();
  return (json.data ?? []).map(scanRow);
}

/** Stocks moving at least the threshold either way, biggest first. `preMarket`: rank by the pre-market move. */
export async function fetchMovers(key, market, preMarket) {
  const field = preMarket ? "premarket_change" : "change";
  const t = market.moveThresholdPct;
  const query = (operation, right, sortOrder) =>
    scan(key, {
      filter: [...baseFilters(key, market), { left: field, operation, right }],
      sort: { sortBy: field, sortOrder },
      range: [0, market.maxMovers],
    });
  const [up, down] = await Promise.all([query("greater", t, "desc"), query("less", -t, "asc")]);
  return [...up, ...down]
    .map((r) => ({ ...r, move: preMarket ? r.premarketChange : r.change }))
    .filter((r) => typeof r.move === "number")
    .sort((a, b) => Math.abs(b.move) - Math.abs(a.move))
    .slice(0, market.maxMovers);
}

/** Scanner rows for specific symbols (stories from the general feeds), with the same filters as the movers. */
export async function fetchQuotes(key, market, symbols) {
  if (!symbols.length) return [];
  return scan(key, { filter: baseFilters(key, market), symbols: { tickers: symbols }, range: [0, symbols.length] });
}

// --- TradingView news ------------------------------------------------------------------------------------

function tvItem(item) {
  const provider = typeof item.provider === "string" ? item.provider : item.provider?.id;
  return {
    id: item.id,
    title: (item.title ?? "").trim(),
    provider,
    publishedAt: new Date(item.published * 1000).toISOString(),
    url: item.link || `https://www.tradingview.com${item.storyPath}`,
    symbols: (item.relatedSymbols ?? []).map((s) => s.symbol),
  };
}

/** TradingView news flow. `filters`: e.g. { lang: "he", symbol: "TASE:TEVA", provider: ["reuters"] }. */
export async function fetchTvNews(filters) {
  const params = new URLSearchParams({ client: "screener", streaming: "false" });
  for (const [k, v] of Object.entries(filters)) {
    if (v == null) continue;
    // The API rejects provider lists that aren't sorted.
    params.append("filter", `${k}:${Array.isArray(v) ? [...v].sort().join(",") : v}`);
  }
  const res = await request(`https://news-mediator.tradingview.com/news-flow/v2/news?${params}`, { headers: TV_HEADERS });
  const json = await res.json();
  return (json.items ?? []).map(tvItem).filter((i) => i.title);
}

// --- RSS (TheMarker) and SEC Atom ---------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(\w+);/g, (m, e) => ENTITIES[e] ?? m)
    .trim();
}
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : "";
};

/** RSS 2.0 items as news items without symbols. */
export function parseRss(xml, provider) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    id: tag(item, "guid") || tag(item, "link"),
    title: tag(item, "title"),
    provider,
    publishedAt: new Date(tag(item, "pubDate")).toISOString(),
    url: tag(item, "link"),
    symbols: [],
  }));
}

export async function fetchRss(feed) {
  const res = await request(feed.url, { headers: { "User-Agent": BROWSER_UA } });
  return parseRss(await res.text(), feed.id);
}

// SEC asks automated clients to identify themselves (https://www.sec.gov/os/accessing-edgar-data).
// A URL in the User-Agent gets HTTP 403; set SEC_USER_AGENT (e.g. "Company contact@domain") to add a contact.
const SEC_UA = process.env.SEC_USER_AGENT || "SMART TRADE HUB news-feed";

/** 8-K items worth surfacing: agreements, acquisitions, results, impairments, delisting, restatements. */
const SEC_ITEMS = {
  "1.01": "Material agreement",
  "1.03": "Bankruptcy",
  "2.01": "Completed acquisition",
  "2.02": "Results of operations",
  "2.06": "Material impairment",
  "3.01": "Delisting notice",
  "4.02": "Non-reliance on financials",
};

/** Latest material 8-K filings of NYSE/Nasdaq companies, as news items with a `ticker`. */
export async function fetchSec8K() {
  const headers = { "User-Agent": SEC_UA };
  const [feed, map] = await Promise.all([
    request("https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=100&output=atom", { headers }).then((r) => r.text()),
    request("https://www.sec.gov/files/company_tickers_exchange.json", { headers }).then((r) => r.json()),
  ]);
  // Listed on NYSE / Nasdaq only: no OTC (spec §4).
  const tickerByCik = new Map(map.data.filter((c) => c[3] === "NYSE" || c[3] === "Nasdaq").map((c) => [String(c[0]), c[2]]));
  return [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap(([, entry]) => {
    const title = tag(entry, "title");
    const m = title.match(/^8-K\s*-\s*(.+?)\s*\((\d+)\)/);
    if (!m) return [];
    const ticker = tickerByCik.get(String(Number(m[2])));
    const items = [...tag(entry, "summary").matchAll(/Item (\d\.\d\d)/g)].map((x) => x[1]).filter((i) => SEC_ITEMS[i]);
    if (!ticker || !items.length) return [];
    return [{
      id: `sec:${m[2]}:${tag(entry, "updated")}`,
      ticker,
      title: `${m[1]}: ${items.map((i) => SEC_ITEMS[i]).join(", ")} (8-K)`,
      provider: "sec",
      publishedAt: new Date(tag(entry, "updated")).toISOString(),
      url: entry.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent",
      symbols: [],
    }];
  });
}
