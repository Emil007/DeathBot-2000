/**
 * In-memory ops status for /status (poller heartbeats, recent errors).
 * Persists last successful poll summary into meta for restarts.
 */

const MAX_EVENTS = 40;

const state = {
  startedAt: new Date().toISOString(),
  poller: {
    busy: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastMode: null,
    lastOk: null,
    lastDurationMs: null,
    lastStats: null,
    lastError: null,
    nightlyPending: false,
  },
  events: [], // { at, level, msg }
};

function pushEvent(level, msg) {
  const row = {
    at: new Date().toISOString(),
    level,
    msg: String(msg).slice(0, 300),
  };
  state.events.push(row);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  return row;
}

function markPollStart(mode) {
  state.poller.busy = true;
  state.poller.lastStartedAt = new Date().toISOString();
  state.poller.lastMode = mode;
  state.poller.lastError = null;
  pushEvent("info", `poll start mode=${mode}`);
}

function markPollEnd(mode, { ok, stats = null, error = null, durationMs = null } = {}) {
  state.poller.busy = false;
  state.poller.lastFinishedAt = new Date().toISOString();
  state.poller.lastMode = mode;
  state.poller.lastOk = ok;
  state.poller.lastDurationMs = durationMs;
  state.poller.lastStats = stats;
  if (error) {
    state.poller.lastError = String(error).slice(0, 500);
    pushEvent("error", `poll ${mode} failed: ${error}`);
  } else {
    pushEvent(
      "info",
      `poll ${mode} ok` +
        (stats
          ? ` scrapedEN=${stats.scrapedEn ?? "?"} scrapedDE=${stats.scrapedDe ?? "?"} newEN=${stats.newEn ?? "?"} hits=${stats.hits ?? "?"}`
          : "")
    );
  }

  try {
    const db = require("../db");
    db.setMeta(
      "last_poll",
      JSON.stringify({
        at: state.poller.lastFinishedAt,
        mode,
        ok,
        durationMs,
        stats,
        error: state.poller.lastError,
      })
    );
  } catch {
    /* db may not be open in tests */
  }
}

function noteError(msg) {
  pushEvent("error", msg);
}

function getOpsStatus() {
  return {
    startedAt: state.startedAt,
    poller: { ...state.poller },
    events: [...state.events],
  };
}

function setNightlyPending(v) {
  state.poller.nightlyPending = Boolean(v);
}

module.exports = {
  markPollStart,
  markPollEnd,
  noteError,
  getOpsStatus,
  setNightlyPending,
  pushEvent,
};
