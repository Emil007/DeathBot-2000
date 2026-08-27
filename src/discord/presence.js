const { ActivityType } = require("discord.js");

/**
 * Bot custom status: "Already N people killed today!"
 * Counts all-deaths channel posts for the local calendar day (0:00–24:00 in TZ).
 * Seed/reconcile bulk marks do NOT count — only real channel announces.
 */

function todayKey(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function readDayCount(db, timeZone) {
  const today = todayKey(timeZone);
  let raw;
  try {
    raw = db.getMeta("alldeaths_day_count");
  } catch {
    return { date: today, count: 0 };
  }
  if (!raw) return { date: today, count: 0 };
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.date === today && Number.isFinite(Number(parsed.count))) {
      return { date: today, count: Math.max(0, Math.floor(Number(parsed.count))) };
    }
  } catch {
    /* reset */
  }
  return { date: today, count: 0 };
}

function writeDayCount(db, timeZone, count) {
  const date = todayKey(timeZone);
  db.setMeta(
    "alldeaths_day_count",
    JSON.stringify({ date, count: Math.max(0, Math.floor(count)) })
  );
  return { date, count: Math.max(0, Math.floor(count)) };
}

function statusText(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const people = n === 1 ? "Person" : "People";
  return `Already ${n} ${people} killed today!`;
}

async function applyPresence(client, count) {
  if (!client?.user) return;
  const state = statusText(count);
  try {
    await client.user.setPresence({
      status: "online",
      activities: [
        {
          type: ActivityType.Custom,
          name: "Custom Status",
          state,
        },
      ],
    });
  } catch (e) {
    // Older gateways sometimes ignore Custom — fall back to Watching
    try {
      await client.user.setPresence({
        status: "online",
        activities: [{ type: ActivityType.Watching, name: state }],
      });
    } catch (e2) {
      console.warn("[presence]", e2.message || e.message);
    }
  }
}

function refreshPresence(client, config, db) {
  const { count } = readDayCount(db, config.tz);
  return applyPresence(client, count);
}

/** Call after a successful all-deaths channel post. */
function recordAllDeathAnnounce(client, config, db) {
  const cur = readDayCount(db, config.tz);
  const next = writeDayCount(db, config.tz, cur.count + 1);
  return applyPresence(client, next.count);
}

function startPresence(client, config, db) {
  refreshPresence(client, config, db).catch(() => {});
  // Refresh often enough to flip to 0 after local midnight
  const timer = setInterval(() => {
    refreshPresence(client, config, db).catch(() => {});
  }, 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[presence] ${statusText(readDayCount(db, config.tz).count)} (TZ=${config.tz || "UTC"})`);
}

module.exports = {
  startPresence,
  refreshPresence,
  recordAllDeathAnnounce,
  statusText,
  todayKey,
  readDayCount,
};
