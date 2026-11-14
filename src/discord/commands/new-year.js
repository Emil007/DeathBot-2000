const { createPackage } = require("../../backup");
const db = require("../../db");
const { logEvent, logError } = require("../log");
const { runWikiPoll } = require("../../jobs/wiki-poll");
const { formatReconcileSummary } = require("../announce");
const { resolveAdminTarget } = require("../admin-notify");

function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

/**
 * Datum in Europe/Vienna (YYYY-MM-DD) — F01: Wechsel-Entscheidungen hängen am
 * Wiener Kalendertag (Cron feuert 00:00 Europe/Vienna, also 23:00 UTC am
 * 31.12.). Ein UTC-Datum läge am 31.12. noch einen Tag hinter dem Saisonstart.
 * `date` ist injizierbar für Tests.
 */
function todayInVienna(date = new Date()) {
  if (date == null) date = new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Wechsel erst ab Saisonstart erlaubt (force hebt nur das Datum auf). */
function assertActivateDateAllowed(startDate, force, now = new Date()) {
  if (force) return { ok: true };
  if (!startDate) return { ok: false, reason: "Kein Startdatum gesetzt." };
  if (todayInVienna(now) < startDate) {
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
          "🆕 **Saison-Wechsel und Eröffnung**",
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
      const dateGuard = assertActivateDateAllowed(announced.start_date, force);
      if (!dateGuard.ok) {
        await msg.reply(dateGuard.reason);
        return;
      }

      let pkg;
      try {
        pkg = createPackage(ctx.config, { reason: "season-switch" });
      } catch (e) {
        await logError(ctx.client, ctx.config, e, { where: "new-year activate backup" });
        await msg.reply(`Backup fehlgeschlagen: ${e.message}`);
        return;
      }

      const archivedSeason = db.getActiveSeason();
      let res;
      try {
        res = db.activateAnnouncedSeason();
      } catch (e) {
        await logError(ctx.client, ctx.config, e, { where: "new-year activate" });
        await msg.reply(`Aktivierung fehlgeschlagen: ${e.message} (Backup: \`${pkg.name}\`)`);
        return;
      }

      // Stiller Reconcile auf der neuen Saison; kein Seed (Feed läuft weiter).
      let reconcileHits = [];
      try {
        const r = await runWikiPoll(ctx.client, ctx.config, { mode: "reconcile" });
        reconcileHits = r.hits || [];
      } catch (e) {
        await logError(ctx.client, ctx.config, e, { where: "new-year reconcile", userId: ctx.config.adminId });
      }
      const snapCount = db
        .getDb()
        .prepare("SELECT COUNT(*) c FROM season_point_snapshots WHERE season_id = ?")
        .get(archivedSeason.id).c;

      await logEvent(ctx.client, ctx.config, {
        kind: "season-switch",
        summary: `Saisonwechsel ${archivedSeason.year} → ${res.activated.year}`,
        userId: ctx.config.adminId,
        detail: `archived=${res.archived.id} activated=${res.activated.id} backup=${pkg?.name} snapshots=${snapCount} reconcile=${reconcileHits.length}`,
      });

      const summary = formatReconcileSummary(reconcileHits, db.getActiveSeason());
      const target = await resolveAdminTarget(ctx, { preferDmUser: msg.author });
      try {
        if (target?.send) await target.send(summary);
      } catch {
        /* ignore */
      }

      await msg.reply(
        [
          `✅ **Saison ${res.archived.year} archiviert** — **Saison ${res.activated.year} ist live**`,
          `• Archiv: id ${res.archived.id} (Punkte-Snapshot: ${snapCount} Spieler)`,
          `• Live: id ${res.activated.id}, Start **${res.activated.start_date}**`,
          "• Picks/Celebs beider Saisons bleiben erhalten, Kontostand startet bei 0",
          `• Stiller Abgleich: **${reconcileHits.length}** Nachträge (Details per DM/Admin)`,
          "• All-Deaths-Feed läuft weiter (kein neuer Seed)",
          force ? "⚠️ Wechsel vor dem Startdatum (force)." : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
      return;
    }

    // ---- WIPE (Notfall) ----
    const guard = assertWipeAllowed();
    if (!guard.ok) {
      await msg.reply(guard.reason);
      return;
    }

    const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
    const year = dateArg ? parseInt(dateArg.slice(0, 4), 10) : new Date().getFullYear();
    const startDate = dateArg ? parseDate(dateArg) : `${year}-01-01`;

    const pkg = createPackage(ctx.config, { reason: "new-year" });
    const { oldSeason, newSeasonId } = db.clearSeasonForNewYear(year, startDate);

    db.getDb().exec(`
      DELETE FROM death_awards;
      DELETE FROM picks;
      DELETE FROM celeb_aka;
      DELETE FROM celeb_blacklist;
      DELETE FROM celebs;
      DELETE FROM player_bonuses;
      DELETE FROM pick_draft_entries;
      DELETE FROM pick_drafts;
    `);

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
        "1. `/import` bzw. `{prefix}import @User`",
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
