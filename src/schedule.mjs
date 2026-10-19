// When each market's collection window is open (spec §5). Windows are in each market's own time zone,
// so summer/winter time in Israel and the US is handled by Intl, not by us.

/** Weekday ("Mon") and minutes since midnight of `date` in `timeZone`. */
export function zonedClock(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { day: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** True when `date` falls inside `window` ({ timeZone, days, start, end }). */
export function isWindowOpen(window, date = new Date()) {
  const { day, minutes } = zonedClock(date, window.timeZone);
  if (!window.days.includes(day)) return false;
  return minutes >= toMinutes(window.start) && minutes <= toMinutes(window.end);
}

/** US only: before the regular session opens (pre-market), use the pre-market move. */
export function isPreMarket(market, date = new Date()) {
  if (!market.regularOpen) return false;
  return zonedClock(date, market.window.timeZone).minutes < toMinutes(market.regularOpen);
}
