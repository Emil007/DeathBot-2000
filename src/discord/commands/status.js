const db = require("../../db");
const { getOpsStatus } = require("../../ops/status");

function ago(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return `vor ${sec}s`;
  if (sec < 3600) return `vor ${Math.round(sec / 60)}m`;
  if (sec < 86400) return `vor ${Math.round(sec / 3600)}h`;
  return `vor ${Math.round(sec / 86400)}d (${iso.slice(0, 19)}Z)`;
}

function ms(n) {
  if (n == null) return "—";
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

const cmd = {
  name: "status",
  aliases: ["health", "ops"],
  admin: true,
  group: "season",
  description: "Ops-Status: Poller, Counts, letzte Hits, Fehler",
  usage: "/status\n{prefix}status",
  examples: ["/status", "{prefix}status"],
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const snap = db.statusSnapshot();
    const ops = getOpsStatus();
    const p = ops.poller;
    const cfg = ctx.config;
    const season = snap.season;

    const lastPoll =
      p.lastFinishedAt || snap.lastPoll?.at
        ? {
            at: p.lastFinishedAt || snap.lastPoll?.at,
            mode: p.lastMode || snap.lastPoll?.mode,
            ok: p.lastOk ?? snap.lastPoll?.ok,
            durationMs: p.lastDurationMs ?? snap.lastPoll?.durationMs,
            stats: p.lastStats || snap.lastPoll?.stats,
            error: p.lastError || snap.lastPoll?.error,
          }
        : null;

    const lines = [
      "**DeathBot Status**",
      "",
      "**Saison**",
      `• Jahr **${season.year}** · Start **${season.start_date || "?"}** · Live **${
        season.live ? "ja" : "nein (Setup)"
      }**`,
      `• Reviews offen: **${snap.pendingReviews}** · Unbestätigte Celebs: **${snap.unconfirmedCelebs}** · Unbestätigte Tode: **${snap.unconfirmedDead}**`,
      "",
      "**Poller**",
      `• Busy: **${p.busy ? "ja" : "nein"}**` +
        (p.nightlyPending ? " · nightly pending" : ""),
      `• Intervall: **${cfg.wikiPollerMinutes} min** · Nightly: **${cfg.nightlyFullScrapeHour}:00** · Uptime: ${ago(
        ops.startedAt
      ).replace(/^vor /, "")} (seit ${ops.startedAt.slice(0, 19)}Z)`,
      lastPoll
        ? `• Letzter Lauf: **${lastPoll.mode}** · ${
            lastPoll.ok === false ? "FAIL" : "OK"
          } · ${ago(lastPoll.at)} · Dauer ${ms(lastPoll.durationMs)}`
        : "• Letzter Lauf: _noch keiner_",
    ];

    if (lastPoll?.stats) {
      const s = lastPoll.stats;
      lines.push(
        `• Scraped EN/DE: **${s.scrapedEn ?? "?"}** / **${s.scrapedDe ?? "?"}** · neu EN/DE: **${
          s.newEn ?? "?"
        }** / **${s.newDe ?? "?"}** · Pool-Hits: **${s.hits ?? "?"}**` +
          (s.categoryHits != null
            ? ` (cat ${s.categoryHits} / list ${s.listHits ?? "?"})`
            : "")
      );
    }
    if (lastPoll?.error) {
      lines.push(`• Letzter Fehler: \`${lastPoll.error.slice(0, 180)}\``);
    }

    lines.push(
      "",
      "**Bestand**",
      `• Spieler **${snap.players}** · Picks (Saison) **${snap.picks}**`,
      `• Celebs lebend **${snap.celebsAlive}** / tot **${snap.celebsDead}** · Auto-Watch **${snap.autoWatch}** · excluded **${snap.excluded}**`,
      `• Wiki-seen **${snap.wikiSeen}** (EN ${snap.wikiSeenEn} / DE ${snap.wikiSeenDe}) · All-deaths announced **${snap.announcedTotal}**`,
      "",
      "**Channels**",
      `• Deathpool: \`${cfg.channelDeathpool}\``,
      `• All-deaths: ${cfg.channelAllDeaths ? `\`${cfg.channelAllDeaths}\`` : "_aus_"}`,
      `• Admin: ${cfg.channelAdmin ? `\`${cfg.channelAdmin}\`` : "_DM-first_"}`,
      `• Guild-ID: ${cfg.discordGuildId ? `\`${cfg.discordGuildId}\`` : "_fehlt (slash lag)_"}`
    );

    if (snap.recentPoolDeaths.length) {
      lines.push("", "**Letzte Pool-Tode**");
      for (const c of snap.recentPoolDeaths.slice(0, 5)) {
        lines.push(
          `• **${c.name}** · ${c.died_at || "?"} · ${c.death_source || "?"} · ${ago(
            c.death_detected_at || c.died_at
          )}`
        );
      }
    }

    if (snap.recentAnnounced.length) {
      lines.push("", "**Letzte All-Deaths**");
      for (const a of snap.recentAnnounced.slice(0, 5)) {
        const label = (a.name || a.entry_id || "?").split(",")[0].slice(0, 40);
        lines.push(`• ${label} · ${a.lang || "?"} · ${ago(a.announced_at)}`);
      }
    }

    const errors = ops.events.filter((e) => e.level === "error").slice(-8);
    if (errors.length) {
      lines.push("", "**Letzte Fehler/Events**");
      for (const e of errors) {
        lines.push(`• \`${e.at.slice(11, 19)}\` ${e.msg}`);
      }
    } else {
      const recent = ops.events.slice(-5);
      if (recent.length) {
        lines.push("", "**Letzte Events**");
        for (const e of recent) {
          lines.push(`• \`${e.at.slice(11, 19)}\` ${e.msg}`);
        }
      }
    }

    await msg.reply(lines.join("\n").slice(0, 1900));
  },
};

module.exports = cmd;
