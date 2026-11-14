const { createPackage } = require("../../backup");
const db = require("../../db");
const { logEvent, logError } = require("../log");
const { runWikiPoll } = require("../../jobs/wiki-poll");
const { runYearRollover } = require("../../jobs/year-rollover");
const { formatReconcileSummary } = require("../announce");
const { resolveAdminTarget } = require("../admin-notify");
const DATE_INVALID =
  "Datum muss YYYY-MM-DD sein, und es muss ein echtes Kalenderdatum sein.";

function loadTime() {
  try {
    return require("../../db/time");
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes("db/time")) throw e;
    return null;
  }
}

function parseCalendarDate(s) {
  const shared = loadTime();
  if (shared) return shared.parseCalendarDate(s);
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) return null;
  return s;
}

function calendarYear(instant, timeZone) {
  const shared = loadTime();
  if (shared) return shared.calendarYear(instant, timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const y = parts.find((p) => p.type === "year");
  return Number(y && y.value);
}

function mentionOpts() {
  try {
    return require("../safe-text").mentionOpts();
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes("safe-text")) throw e;
    return { allowedMentions: { parse: [] } };
  }
}

function isTokenBurned(err) {
  const code = err?.code ?? err?.rawError?.code;
  return Number(code) === 50027;
}

function switchFailureText(err) {
  const stack = String(err?.stack || "");
  if (stack.includes("createPackage") || stack.includes("year-rollover backup")) {
    return `Backup fehlgeschlagen: ${err.message}`;
  }
  return `Aktivierung fehlgeschlagen: ${err.message}`;
}

async function ackSwitch(msg) {
  try {
    await msg.reply("Wechsel läuft.");
  } catch (e) {
    if (isTokenBurned(e)) return;
    throw e;
  }
}

/**
 * Schaltet nur über runYearRollover (Mutex liegt in M5). Beobachtet den
 * Kanal-Send der Abschlussbilanz, falls der Rückgabewert kein posted-Flag hat.
 */
async function runYearRolloverObserved(client, config, force) {
  let observedPosted = false;
  const channels = client?.channels;
  const hadOwn = Boolean(channels && Object.prototype.hasOwnProperty.call(channels, "fetch"));
  const prevFetch = channels?.fetch;
  if (typeof prevFetch === "function") {
    channels.fetch = async (...args) => {
      const ch = await prevFetch.apply(channels, args);
      if (!ch || typeof ch.send !== "function") return ch;
      return new Proxy(ch, {
        get(target, prop, receiver) {
          if (prop === "send") {
            return (payload) => {
              const content =
                payload && typeof payload === "object" && payload.content != null
                  ? String(payload.content)
                  : typeof payload === "string"
                    ? payload
                    : "";
              if (content.includes("Abschlussbilanz")) observedPosted = true;
              return target.send(payload);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
  }
  try {
    const result = await runYearRollover(client, config, { force: Boolean(force) });
    const explicit = result && (result.posted ?? result.reviewPosted ?? result.fin?.posted);
    const reviewPosted = typeof explicit === "boolean" ? explicit : observedPosted;
    return { result, reviewPosted };
  } finally {
    if (channels && typeof prevFetch === "function") {
      if (hadOwn) channels.fetch = prevFetch;
      else delete channels.fetch;
    }
  }
}

/**
 * Datum in der Bot-Zeitzone (YYYY-MM-DD) — F01: Wechsel-Entscheidungen hängen am
 * TZ-Kalendertag (Cron feuert 00:00 config.tz). Ein UTC-Datum läge am 31.12. noch
 * einen Tag hinter dem Saisonstart. `date` ist injizierbar für Tests.
 *
 * `timeZone` ist konfigurierbar (config.tz). Default Europe/Vienna — bleibt
 * damit rückwärtskompatibel zu Aufrufen ohne Zeitzonen-Argument.
 */
function todayInVienna(date = new Date(), timeZone = "Europe/Vienna") {
  if (date == null) date = new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Wechsel erst ab Saisonstart erlaubt (force hebt nur das Datum auf). timeZone = config.tz. */
function assertActivateDateAllowed(startDate, force, now = new Date(), timeZone = "Europe/Vienna") {
  if (force) return { ok: true };
  if (!startDate) return { ok: false, reason: "Kein Startdatum gesetzt." };
  if (todayInVienna(now, timeZone) < startDate) {
    return { ok: false, reason: `Wechsel erst ab dem Saisonstart (**${startDate}**) möglich. \`force:true\` nur für Testläufe.` };
  }
  return { ok: true };
}

/** Wipe nur erlauben, wenn weder running noch announced existiert (leerer Setup/Notfall). */
function assertWipeAllowed() {
  const active = db.getActiveSeason();
  const announced = db.getAnnouncedSeason();
  if (active?.phase === "running" || announced) {
    return {
      ok: false,
      reason:
        "Die laufende Saison wird nicht mehr geleert. Wechsel = `/announce-season` (Eröffnung) + `/new-year activate:true` (am Saisonstart, archiviert statt löscht).",
    };
  }
  return { ok: true };
}

const cmd = {
  name: "new-year",
  admin: true,
  group: "season",
  description: "Saisonwechsel: archiviert die alte, schaltet die announced-Saison live",
  usage:
    "/new-year activate:true\n/announce-season …\n{prefix}new-year activate",
  examples: [
    "/new-year activate:true",
    "/new-year activate:true force:true",
    "/announce-season announce_channel:#Kanal",
    "{prefix}new-year activate",
  ],
  details:
    "NEU: `/new-year activate:true` archiviert die laufende Saison (Daten bleiben, Punkte-Snapshot) und schaltet die per /announce-season eröffnete Saison live (ab Startdatum). Wipe = nur Notfall ohne running/announced.",
  options: [
    {
      name: "activate",
      description: "Archiviert die laufende Saison + aktiviert die announced-Saison",
      type: "BOOLEAN",
      required: false,
    },
    {
      name: "force",
      description: "Datumsprüfung überspringen (für Testläufe)",
      type: "BOOLEAN",
      required: false,
    },
    {
      name: "wipe",
      description: "Notfall-Wipe (nur ohne running/announced erlaubt)",
      type: "BOOLEAN",
      required: false,
    },
    {
      name: "confirm",
      description: "Nur für wipe (Legacy)",
      type: "BOOLEAN",
      required: false,
    },
    {
      name: "start_date",
      description: "Nur für wipe (Legacy)",
      type: "STRING",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const args = [];
    if (interaction.options.getBoolean("activate")) args.push("activate");
    if (interaction.options.getBoolean("force")) args.push("force");
    if (interaction.options.getBoolean("wipe")) args.push("wipe");
    const cn = interaction.options.getBoolean("confirm");
    if (cn === true) args.push("confirm");
    const sd = interaction.options.getString("start_date");
    if (sd) args.push(sd);
    return args;
  },
  async run(ctx, args, msg) {
    const has = (x) => args.some((a) => String(a).toLowerCase() === x);
    const isActivate = has("activate");
    const isWipe = has("wipe") || has("confirm");

    // Hilfe
    if (!isActivate && !isWipe) {
      await msg.reply(
        [
          "🆕 **Saison-Wechsel und Eröffnung** — erst ankündigen, am Start begraben.",
          "",
          "• **Eröffnung:** `/announce-season announce_channel:#Kanal` — legt die kommende Saison an und postet das Teilnahme-Embed (**die laufende Runde läuft weiter**).",
          "• **Wechsel am Saisonstart:** `/new-year activate:true` — archiviert die laufende Saison (Daten + Punkte-Snapshot bleiben), schaltet die announced-Saison live.",
          "• Erneutes Embed: `/announce-season repost:true`.",
          "",
          "Der alte Complete-Wipe (`wipe:true`) ist nur noch ein Notfall für einen leeren Setup-Pool — sobald eine Saison läuft oder angekündigt ist, wird er verweigert.",
        ].join("\n")
      );
      return;
    }

    if (isActivate && isWipe) {
      await msg.reply("`activate` und `wipe` schließen sich aus.");
      return;
    }

    // ---- ACTIVATE ----
    if (isActivate) {
      const announced = db.getAnnouncedSeason();
      if (!announced) {
        await msg.reply("Keine announced-Saison vorhanden. Zuerst `/announce-season announce_channel:#Kanal`.");
        return;
      }
      const force = has("force");
      const dateGuard = assertActivateDateAllowed(announced.start_date, force, new Date(), ctx.config.tz);
      if (!dateGuard.ok) {
        await msg.reply(dateGuard.reason);
        return;
      }

      await ackSwitch(msg);

      const archivedSeason = db.getActiveSeason();
      let switched;
      try {
        switched = await runYearRolloverObserved(ctx.client, ctx.config, force);
      } catch (e) {
        await logError(ctx.client, ctx.config, e, { where: "new-year activate", userId: ctx.config.adminId });
        await msg.reply(switchFailureText(e));
        return;
      }

      const result = switched?.result;
      if (!result || result.switched !== true) {
        if (result?.reason === "no-announced") {
          await msg.reply("Wechsel ist schon durch.");
          return;
        }
        if (result?.reason === "not-yet") {
          await msg.reply(
            result.start
              ? `Wechsel erst ab dem Saisonstart (**${result.start}**) möglich. \`force:true\` nur für Testläufe.`
              : "Kein Startdatum gesetzt."
          );
          return;
        }
        await msg.reply(`Aktivierung fehlgeschlagen: ${result?.reason || "unbekannt"}`);
        return;
      }

      const archived = result.archived;
      const activated = result.activated;
      const reviewPosted = Boolean(switched.reviewPosted);
      const channelId = result.channel || activated?.deathpool_channel_id || null;

      // Reconcile erst nach dem Wechsel, nicht davor. Kein Seed.
      let reconcileHits = [];
      try {
        const r = await runWikiPoll(ctx.client, ctx.config, { mode: "reconcile" });
        reconcileHits = r?.hits || [];
      } catch (e) {
        await logError(ctx.client, ctx.config, e, { where: "new-year reconcile", userId: ctx.config.adminId });
      }
      const snapCount = archived
        ? db
            .getDb()
            .prepare("SELECT COUNT(*) c FROM season_point_snapshots WHERE season_id = ?")
            .get(archived.id).c
        : 0;

      await logEvent(ctx.client, ctx.config, {
        kind: "season-switch",
        summary: `Saisonwechsel ${archivedSeason?.year} → ${activated?.year}`,
        userId: ctx.config.adminId,
        detail: `archived=${archived?.id} activated=${activated?.id} snapshots=${snapCount} reconcile=${reconcileHits.length} review=${reviewPosted}`,
      });

      const summary = formatReconcileSummary(reconcileHits, db.getActiveSeason());
      const target = await resolveAdminTarget(ctx, { preferDmUser: msg.author });
      try {
        if (target?.send) await target.send({ content: summary, ...mentionOpts() });
      } catch {
        /* ignore */
      }

      const channelBit = channelId
        ? `<#${channelId}>`
        : "**Anlage fehlgeschlagen** (gesehen in Logs)";
      try {
        await msg.reply(
          [
            `✅ **Saison ${archived.year} archiviert** — **Saison ${activated.year} ist live.** Das alte Jahr liegt, das neue wartet auf Namen.`,
            `• Archiv: id ${archived.id} (Punkte-Snapshot: ${snapCount} Spieler)`,
            `• Live: id ${activated.id}, Start **${activated.start_date}**`,
            `• Deathpool-Kanal: ${channelBit}`,
            `• Abschlussbilanz: ${reviewPosted ? "gepostet" : "**nicht gesendet** (Details in den Logs)"}`,
            "• Picks/Celebs beider Saisons bleiben erhalten, Kontostand startet bei 0",
            `• Stiller Abgleich: **${reconcileHits.length}** Nachträge (Details per DM/Admin)`,
            "• All-Deaths-Feed läuft weiter (kein neuer Seed)",
            force ? "⚠️ Wechsel vor dem Startdatum (force)." : "",
          ]
            .filter(Boolean)
            .join("\n")
        );
      } catch (e) {
        if (!isTokenBurned(e)) throw e;
        await logError(ctx.client, ctx.config, e, { where: "new-year activate reply", userId: ctx.config.adminId });
      }
      return;
    }

    // ---- WIPE (Notfall) ----
    const flags = new Set(["activate", "force", "wipe", "confirm"]);
    const dateArgs = args.filter((a) => !flags.has(String(a).toLowerCase()));
    let year;
    let startDate;
    if (dateArgs.length) {
      const parsed = dateArgs.map((a) => parseCalendarDate(String(a)));
      if (parsed.some((d) => !d)) {
        await msg.reply(DATE_INVALID);
        return;
      }
      startDate = parsed[0];
      year = Number(startDate.slice(0, 4));
    } else {
      year = calendarYear(new Date(), ctx.config.tz);
      startDate = `${year}-01-01`;
    }

    const guard = assertWipeAllowed();
    if (!guard.ok) {
      await msg.reply(guard.reason);
      return;
    }

    let pkg;
    try {
      pkg = createPackage(ctx.config, { reason: "new-year" });
    } catch (e) {
      await logError(ctx.client, ctx.config, e, { where: "new-year wipe backup", userId: ctx.config.adminId });
      await msg.reply(`Backup fehlgeschlagen: ${e.message}`);
      return;
    }

    const { oldSeason, newSeasonId } = db.clearSeasonForNewYear(year, startDate);

    await logEvent(ctx.client, ctx.config, {
      kind: "new-year-wipe",
      summary: `Notfall-Wipe: neue Saison ${newSeasonId} (Start ${startDate})`,
      userId: ctx.config.adminId,
      detail: `oldSeason=${oldSeason.year} wipe=yes (running/announced war keines da)`,
    });

    await msg.reply(
      [
        "🧨 **Notfall-Wipe (Setup-Pool)**",
        `• Backup: \`${pkg.name}\``,
        `• Neue Saison id ${newSeasonId}, Start **${startDate}**, live=**nein**`,
        "",
        `1. \`${ctx.config.prefix}import @User\``,
        "2. `/check` — stiller Wiki-Abgleich, Zusammenfassung per DM",
        "3. `/go` — Live ab jetzt",
      ].join("\n")
    );
  },
};

module.exports = cmd;
module.exports.assertWipeAllowed = assertWipeAllowed;
module.exports.assertActivateDateAllowed = assertActivateDateAllowed;
module.exports.todayInVienna = todayInVienna;
