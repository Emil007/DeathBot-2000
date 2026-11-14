/**
 * Kalendertage in einer IANA-Zeitzone.
 *
 * Diese Helfer lesen und schreiben process.env.TZ nicht. loadConfig darf die
 * Prozesszone nicht verbiegen; applyProcessTimezone läuft erst aus main().
 */

function asDate(instant) {
  return instant instanceof Date ? instant : new Date(instant);
}

function calendarParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(asDate(instant));
  const map = {};
  for (const part of parts) {
    if (part.type === "year" || part.type === "month" || part.type === "day") {
      map[part.type] = part.value;
    }
  }
  return map;
}

function calendarDate(instant, timeZone) {
  const { year, month, day } = calendarParts(instant, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function calendarYear(instant, timeZone) {
  return Number(calendarParts(instant, timeZone).year);
}

function calendarMonthIndex(instant, timeZone) {
  return Number(calendarParts(instant, timeZone).month) - 1;
}

function parseCalendarDate(s) {
  if (typeof s !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Date.UTC überläuft ungültige Tage (2027-02-29 → 1. März). Nur ein
  // Roundtrip auf dasselbe Jahr, denselben Monat und denselben Tag gilt.
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return s;
}

function addCalendarDays(yyyyMmDd, n) {
  const parsed = parseCalendarDate(yyyyMmDd);
  if (!parsed) throw new Error(`Invalid calendar date: ${yyyyMmDd}`);
  if (!Number.isInteger(n)) throw new Error("Calendar day offset must be an integer");
  const [year, month, day] = parsed.split("-").map(Number);
  // Tagesüberlauf im UTC-Kalender, kein Instant plus n * 24h.
  const shifted = new Date(Date.UTC(year, month - 1, day + n));
  const yyyy = String(shifted.getUTCFullYear()).padStart(4, "0");
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function wallClockAsUtc(utcMs, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map = {};
  for (const part of fmt.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  let year = Number(map.year);
  let month = Number(map.month);
  let day = Number(map.day);
  let hour = Number(map.hour);
  // ISO-8601: 24:00 ist Mitternacht am Beginn des nächsten Kalendertags.
  if (hour === 24) {
    hour = 0;
    day += 1;
  }
  return Date.UTC(year, month - 1, day, hour, Number(map.minute), Number(map.second));
}

function localMidnightUtc(yyyyMmDd, timeZone) {
  const parsed = parseCalendarDate(yyyyMmDd);
  if (!parsed) throw new Error(`Invalid calendar date: ${yyyyMmDd}`);
  const [year, month, day] = parsed.split("-").map(Number);
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0);
  let utc = desired;
  for (let i = 0; i < 4; i++) {
    const diff = wallClockAsUtc(utc, timeZone) - desired;
    if (diff === 0) return new Date(utc).toISOString();
    utc -= diff;
  }
  throw new Error(`Could not resolve local midnight for ${parsed} in time zone ${timeZone}`);
}

function applyProcessTimezone(config) {
  process.env.TZ = config.tz;
}

module.exports = {
  calendarDate,
  calendarYear,
  calendarMonthIndex,
  localMidnightUtc,
  parseCalendarDate,
  addCalendarDays,
  isValidTimeZone,
  applyProcessTimezone,
};
