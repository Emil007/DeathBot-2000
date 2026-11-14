/**
 * Shared Wikipedia gate for the poller, the pick assistant, and review.
 *
 * withWikiSlot runs at most two functions at once. A call from an async
 * context that already holds a slot runs inline: callers wrap a whole lookup,
 * and each GET inside that lookup takes a slot too. Without re-entry those
 * two layers deadlock as soon as both slots are busy.
 *
 * allowUserWiki allows 40 resolutions per user and calendar day in `tz`.
 * A missing user id is the poller: it is not counted and only hits the slot cap.
 */

const { AsyncLocalStorage } = require("async_hooks");

const MAX_SLOTS = 2;
const DAILY_LIMIT = 40;

const slotContext = new AsyncLocalStorage();
let activeSlots = 0;
const slotQueue = [];

const dailyCounts = new Map();

function fallbackCalendarDate(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function missingTimeModule(err) {
  if (!err || err.code !== "MODULE_NOT_FOUND") return false;
  const first = String(err.message).split("\n")[0];
  return (
    first === "Cannot find module '../db/time'" ||
    first === "Cannot find module '../db/time.js'" ||
    /Cannot find module '.*[/\\]db[/\\]time(?:\.js)?'$/.test(first)
  );
}

function loadCalendarDate() {
  try {
    const time = require("../db/time");
    if (typeof time.calendarDate !== "function") {
      throw new Error("src/db/time.js must export calendarDate");
    }
    return time.calendarDate;
  } catch (err) {
    // ANNAHME: M1 owns src/db/time.js and is not in this workspace yet.
    // The fallback is the contract's en-CA calendar day. Once the module
    // exists, its calendarDate is used and a broken export still throws.
    if (!missingTimeModule(err)) throw err;
    return fallbackCalendarDate;
  }
}

const calendarDate = loadCalendarDate();

function pumpSlots() {
  while (activeSlots < MAX_SLOTS && slotQueue.length > 0) {
    const job = slotQueue.shift();
    activeSlots += 1;
    slotContext.run({ held: true }, () => {
      Promise.resolve()
        .then(() => job.fn())
        .then(job.resolve, job.reject)
        .finally(() => {
          activeSlots -= 1;
          pumpSlots();
        });
    });
  }
}

function withWikiSlot(fn) {
  if (slotContext.getStore()?.held) {
    return Promise.resolve().then(() => fn());
  }
  return new Promise((resolve, reject) => {
    slotQueue.push({ fn, resolve, reject });
    pumpSlots();
  });
}

function allowUserWiki(userId, tz) {
  if (userId == null || userId === "") return true;
  const zone = tz || process.env.TZ || "UTC";
  const day = calendarDate(new Date(), zone);
  const key = `${String(userId)}\0${day}`;
  const used = dailyCounts.get(key) || 0;
  if (used >= DAILY_LIMIT) return false;
  dailyCounts.set(key, used + 1);
  return true;
}

module.exports = {
  withWikiSlot,
  allowUserWiki,
};
