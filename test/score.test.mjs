import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findKeywords, pickHot, rejectReason, sameStory } from "../src/score.mjs";
import { isPreMarket, isWindowOpen } from "../src/schedule.mjs";
import { parseRss } from "../src/sources.mjs";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const us = config.markets.us;
const il = config.markets.il;
const now = new Date("2026-10-19T15:00:00Z");
const minutesAgo = (m) => new Date(now.getTime() - m * 60_000).toISOString();
const news = (over) => ({ id: Math.random().toString(36), title: "Some headline", provider: "reuters", publishedAt: minutesAgo(20), url: "https://x", symbols: [], ...over });

test("keywords: English whole words, capitals case-sensitive", () => {
  assert.deepEqual(findKeywords("Nvidia raises guidance", ["guidance"], "en"), ["guidance"]);
  assert.deepEqual(findKeywords("Goldman upgrades", ["gold"], "en"), []);
  assert.deepEqual(findKeywords("fed up with delays", ["Fed"], "en"), []);
  assert.deepEqual(findKeywords("Fed holds rates", ["Fed"], "en"), ["Fed"]);
});

test("keywords: Hebrew with prefixes, not inside other words", () => {
  assert.deepEqual(findKeywords("החברה תציג בכנס המשקיעים", ["כנס"], "he"), ["כנס"]);
  assert.deepEqual(findKeywords("המשקיע נכנס להפסד", ["כנס"], "he"), []);
  assert.deepEqual(findKeywords("והריבית עלתה", ["ריבית"], "he"), ["ריבית"]);
});

test("rejects old, routine, blocked and out-of-scope news", () => {
  assert.equal(rejectReason(news({ publishedAt: minutesAgo(181) }), config, "en", now), "too old");
  assert.equal(rejectReason(news({ title: "Acme to present at Morgan Stanley conference" }), config, "en", now), "routine");
  assert.equal(rejectReason(news({ title: "Bitcoin jumps past record" }), config, "en", now), "out of scope");
  assert.equal(rejectReason(news({ symbols: ["OANDA:XAUUSD", "TVC:GOLD"] }), config, "en", now), "out of scope");
  assert.equal(rejectReason(news({ provider: "spam" }), { ...config, blockedSources: ["spam"] }, "en", now), "blocked source");
  assert.equal(rejectReason(news({ title: "Fed signals pause in rate cuts" }), config, "en", now), null);
});

test("same story across sources", () => {
  assert.ok(sameStory("Powell signals pause in rate cuts", "Fed's Powell signals a pause in rate cuts, markets slip"));
  assert.ok(!sameStory("Powell signals pause in rate cuts", "Nvidia raises data-center guidance"));
});

test("picks the top 2, merges the same story, never twice the same stock", () => {
  const picked = pickHot(
    [
      { ...news({ title: "Nvidia raises data-center guidance", provider: "reuters" }), ticker: "NVDA", change: 6.2, move: 6.2, relVolume: 3 },
      { ...news({ title: "Nvidia shares rally on guidance", provider: "dow-jones" }), ticker: "NVDA", change: 6.2, move: 6.2, relVolume: 3 },
      { ...news({ title: "Powell signals pause in rate cuts" }), ticker: null, change: null, move: null, feed: true },
      { ...news({ title: "Fed's Powell signals a pause in rate cuts", provider: "dow-jones" }), ticker: null, change: null, move: null, feed: true },
      { ...news({ title: "Tesla slides after delivery miss", provider: "reuters" }), ticker: "TSLA", change: -4.5, move: -4.5, relVolume: 1 },
    ],
    config,
    us,
  );
  assert.equal(picked.length, 2);
  assert.equal(picked[0].ticker, "NVDA");
  assert.ok(picked[0].reasons.includes("2 sources"));
  assert.equal(new Set(picked.map((p) => p.ticker)).size, 2);
});

test("general news needs a hot keyword or a real move", () => {
  const picked = pickHot([{ ...news({ title: "Nasdaq climbs as chip stocks bounce back" }), ticker: null, change: null, move: null, feed: true }], config, us);
  assert.equal(picked.length, 0);
});

test("windows follow each market's time zone, including summer time", () => {
  // 19/10/2026: New York on EDT (UTC-4), Israel on IDT until 25/10 (UTC+3).
  assert.ok(isWindowOpen(us.window, new Date("2026-10-19T08:05:00Z"))); // 04:05 NY = 11:05 Israel
  assert.ok(!isWindowOpen(us.window, new Date("2026-10-19T07:55:00Z")));
  assert.ok(isWindowOpen(il.window, new Date("2026-10-19T06:30:00Z"))); // 09:30 Israel
  assert.ok(!isWindowOpen(il.window, new Date("2026-10-18T08:00:00Z"))); // Sunday
  // Winter: 7/12/2026, New York on EST (UTC-5).
  assert.ok(isWindowOpen(us.window, new Date("2026-12-07T21:25:00Z"))); // 16:25 NY = 23:25 Israel
  assert.ok(isPreMarket(us, new Date("2026-10-19T12:00:00Z")));
  assert.ok(!isPreMarket(us, new Date("2026-10-19T14:00:00Z")));
});

test("parses TheMarker RSS", () => {
  const [item] = parseRss(
    '<rss><channel><item><title>המאבק על אינמוד &amp; סטיל</title><link>https://www.themarker.com/a</link><pubDate>Mon, 19 Oct 2026 18:32:53 +0300</pubDate><enclosure url="https://img.example/a.jpg?w=108&amp;h=81" type="image/jpeg"/></item></channel></rss>',
    "themarker",
  );
  assert.equal(item.title, "המאבק על אינמוד & סטיל");
  assert.equal(item.publishedAt, "2026-10-19T15:32:53.000Z");
  assert.equal(item.image, "https://img.example/a.jpg?w=108&h=81");
});
