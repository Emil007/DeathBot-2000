const axios = require("axios");
const db = require("../../db");
const { parseSheetTable } = require("../import-sheet");
const celebReview = require("../celeb-review");
const { usageReply } = require("../usage");
const { logEvent } = require("../log");

function loadParseCalendarDate() {
  try {
    return require("../../db/time").parseCalendarDate;
  } catch (err) {
    // ANNAHME: M1 legt src/db/time.js an. Bis das Modul im Workspace liegt,
    // gilt hier derselbe Kalendervertrag (Roundtrip über Date.UTC).
    if (err.code !== "MODULE_NOT_FOUND") throw err;
    return fallbackParseCalendarDate;
  }
}

function fallbackParseCalendarDate(s) {
  if (typeof s !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
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

function loadSafeText() {
  try {
    return require("../safe-text");
  } catch (err) {
    // ANNAHME: M1 legt src/discord/safe-text.js an. Bis das Modul liegt,
    // gelten sanitizeDisplayName und mentionOpts nach demselben Vertrag.
    if (err.code !== "MODULE_NOT_FOUND") throw err;
    return {
      sanitizeDisplayName: fallbackSanitizeDisplayName,
      mentionOpts() {
        return { allowedMentions: { parse: [] } };
      },
    };
  }
}

const UNNAMED = "\u201EUnbenannt\u201C";
const MARKDOWN_MENTION = /[*_~|`<>@()[\]]/g;

function fallbackSanitizeDisplayName(raw) {
  let s = raw == null ? "" : String(raw);
  s = s.replace(/\p{Cc}/gu, "");
  s = s.replace(/[\u2028\u2029]/g, "");
  s = s.replace(MARKDOWN_MENTION, "");
  s = s.replace(/\s+/gu, " ").trim();
  const chars = Array.from(s);
  if (chars.length > 80) s = chars.slice(0, 80).join("").trim();
  return s || UNNAMED;
}

const parseCalendarDate = loadParseCalendarDate();
const { sanitizeDisplayName, mentionOpts } = loadSafeText();

const pending = new Map();
const DONE = /^(done|fertig|end)$/i;

function reply(msg, content) {
  return msg.reply({ content, ...mentionOpts() });
}

/** Importiert immer in die AKTIVE Saison; announced/legacy als Ziel ist ein Fehler. */
function seasonForImport() {
  const season = db.getActiveSeason();
  if (!season || season.active !== 1) throw new Error("Keine aktive Saison für den Import.");
  if (season.phase === "announced") throw new Error("Announced-Saison ist kein Import-Ziel (Anmeldung läuft über den Bot).");
  return season;
}

/** Schon-tot-Zeile zahlt nur ab Saisonstart, bestätigt und nicht ausgeschlossen. */
function sheetDeathPays(celeb, diedOn, season) {
  if (!diedOn) return false;
  if (celeb.wiki_confirmed !== 1 || celeb.exclude_from_auto !== 0) return false;
  if (season.start_date && diedOn < season.start_date) return false;
  return true;
}

function applyImportRows(player, rows) {
  const season = seasonForImport();
  let added = 0;
  let deadAwarded = 0;
  const errors = [];
  const ageWarnings = [];
  const reviewIds = [];

  const tx = db.getDb().transaction(() => {
    // Erst innen: ein Abbruch rollt die bisherige Liste zurück.
    db.clearPicksForPlayer(player.id, season.id);
    for (const row of rows) {
      try {
        const { celeb, ageConflict, created } = db.findOrCreateCeleb({
          name: row.name,
          age: row.age,
          description: row.description,
        });
        if (ageConflict) {
          ageWarnings.push(
            `${sanitizeDisplayName(row.name)}: kept age ${ageConflict.existing}, ignored ${ageConflict.incoming}`
          );
        }
        db.setPick(player.id, celeb.id, season.id);
        added++;

        const fresh = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(celeb.id);

        if (!fresh.wiki_confirmed) {
          reviewIds.push(fresh.id);
        } else if (created) {
          reviewIds.push(fresh.id);
        }

        const diedOn = row.diedAt ? parseCalendarDate(row.diedAt) : null;
        if (row.diedInvalid || (row.diedAt && !diedOn)) {
          errors.push(`${sanitizeDisplayName(row.name)}: ungültiges Todesdatum`);
        } else if (diedOn && fresh.is_alive) {
          const result = db.applyDeath(celeb.id, {
            confirmed: true,
            source: "sheet",
            diedAt: diedOn,
          });
          // skipped (unbestätigt / exclude) zählt nicht als Sheet-Punkt.
          if (!result?.skipped && result.awards?.some((a) => a.player.id === player.id)) {
            deadAwarded++;
          }
        } else if (diedOn && !fresh.is_alive) {
          if (sheetDeathPays(fresh, diedOn, season)) {
            const existing = db
              .getDb()
              .prepare(
                "SELECT 1 FROM death_awards WHERE celeb_id = ? AND player_id = ? AND season_id = ?"
              )
              .get(celeb.id, player.id, season.id);
            if (!existing) {
              const score = db.scoreForAge(fresh.age_at_pick ?? fresh.sheet_age_hint);
              if (score > 0) {
                db.addPoints(player.id, score);
                db.getDb()
                  .prepare(
                    `INSERT INTO death_awards (celeb_id, player_id, points, season_id) VALUES (?, ?, ?, ?)`
                  )
                  .run(celeb.id, player.id, score, season.id);
                deadAwarded++;
              }
            }
          }
        }
      } catch (e) {
        errors.push(`${sanitizeDisplayName(row.name)}: ${e.message}`);
      }
    }
  });
  tx();

  return {
    added,
    deadAwarded,
    errors,
    ageWarnings,
    season,
    reviewIds: [...new Set(reviewIds)],
  };
}

async function readAttachmentText(attachment) {
  const name = (attachment.name || "").toLowerCase();
  if (
    !/\.(tsv|csv|txt)$/i.test(name) &&
    attachment.contentType &&
    !/text|csv/i.test(attachment.contentType)
  ) {
    return null;
  }
  const { data } = await axios.get(attachment.url, {
    responseType: "text",
    timeout: 20000,
  });
  return String(data);
}

async function finalize(ctx, msg, wait, text) {
  const parsed = parseSheetTable(text);
  if (parsed.error) {
    await reply(msg, `Import fehlgeschlagen: ${parsed.error}`);
    return true;
  }

  const player = db.upsertPlayer({
    displayName: wait.displayName,
    discordUserId: wait.playerDiscordId,
  });

  const { added, deadAwarded, errors, ageWarnings, reviewIds } = applyImportRows(
    player,
    parsed.rows
  );

  await reply(
    msg,
    [
      `✅ Liste ersetzt für <@${wait.playerDiscordId}> (**${wait.displayName}**)`,
      `• Picks: **${added}**`,
      `• Sheet-tot + Punkte: **${deadAwarded}**`,
      `• Punkte gesamt: **${db.playerTotal(player.id)}**`,
      `• In Wiki-/Alter-Review: **${reviewIds.length}**`,
      ageWarnings.length
        ? `• Alter behalten (erster gewinnt):\n` +
          ageWarnings.slice(0, 8).map((w) => `  – ${w}`).join("\n")
        : null,
      errors.length ? `• Fehler: ${errors.slice(0, 5).join("; ")}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  );

  await logEvent(ctx.client, ctx.config, {
    kind: "import",
    summary: `Admin-Import abgeschlossen → <@${wait.playerDiscordId}> (${wait.displayName})`,
    userId: ctx?.adminId || ctx.config.adminId,
    detail: `picks=${added} deadAwarded=${deadAwarded} review=${reviewIds.length} errors=${errors.length} season=${db.getActiveSeason().id}`,
  });

  if (reviewIds.length) {
    const { resolveAdminTarget } = require("../admin-notify");
    const target = await resolveAdminTarget(ctx, {
      preferDmUser: msg.author,
      fallbackChannel: msg.channel,
    });
    await celebReview.queueCelebsForReview(ctx, reviewIds, target || msg.channel);
  }
  return true;
}

const cmd = {
  name: "import",
  admin: true,
  group: "season",
  description: "Spielerliste ersetzen; Paste bis done/fertig/end oder Datei",
  usage: "/import user:@Spieler [file:…]\n{prefix}import @User",
  examples: [
    "/import user:@Spieler",
    "/import user:@Spieler file:liste.tsv",
    "{prefix}import @User",
  ],
  details:
    "Ersetzt die gesamte Pick-Liste des Spielers und stellt Celebs in die Wiki-/Alter-Review. Mehrere Paste-Nachrichten OK — abschließen mit done/fertig/end.",
  options: [
    {
      name: "user",
      description: "Spieler (Discord-User)",
      type: "USER",
      required: false,
    },
    {
      name: "user_id",
      description: "Discord-Snowflake (Fallback in DMs)",
      type: "STRING",
      required: false,
    },
    {
      name: "file",
      description: "Optional .tsv / .csv / .txt — importiert sofort",
      type: "ATTACHMENT",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const user = interaction.options.getUser("user");
    if (user) return [];
    const id = interaction.options.getString("user_id");
    return id ? [id] : [];
  },
  async run(ctx, args, msg) {
    let mention = msg.mentions.users.first();
    if (!mention && args[0] && /^\d{16,20}$/.test(args[0])) {
      mention = await ctx.client.users.fetch(args[0]).catch(() => null);
    }
    if (!mention) {
      await reply(msg, usageReply(cmd, ctx.config));
      return;
    }
    const season = db.getActiveSeason();
    const displayName = sanitizeDisplayName(
      msg.mentions.members?.first()?.displayName || mention.username
    );
    const wait = {
      playerDiscordId: mention.id,
      displayName,
      chunks: [],
      expires: Date.now() + 15 * 60 * 1000,
    };
    pending.set(msg.author.id, wait);

    const file = msg.attachments?.first?.() || null;
    if (file) {
      try {
        const text = await readAttachmentText(file);
        if (!text) {
          pending.delete(msg.author.id);
          await reply(msg, "Brauchst eine .tsv / .csv / .txt Anlage.");
          return;
        }
        pending.delete(msg.author.id);
        await reply(
          msg,
          `Import für **${displayName}** — Datei wird eingelesen (Saisonstart **${season.start_date || "?"}**).`
        );
        await finalize(ctx, msg, wait, text);
        return;
      } catch (e) {
        pending.delete(msg.author.id);
        await reply(msg, `Datei lesen fehlgeschlagen: ${e.message}`);
        return;
      }
    }

    await reply(
      msg,
      [
        `Import für **${displayName}**. Die bisherige Liste dieses Spielers wird ersetzt, nicht ergänzt.`,
        `Saisonstart **${season.start_date || "?"}**. Zeilen schicken, dann \`done\`, \`fertig\` oder \`end\` (oder eine Datei anhängen).`,
      ].join("\n")
    );
  },

  async tryConsumePaste(ctx, msg) {
    const wait = pending.get(msg.author.id);
    if (!wait) return false;
    if (Date.now() > wait.expires) {
      pending.delete(msg.author.id);
      await reply(
        msg,
        "Import verworfen, die 15 Minuten sind um. /import neu starten. Nichts wurde ersetzt."
      );
      return true;
    }
    if (
      msg.content.startsWith(ctx.config.prefix) &&
      !DONE.test(msg.content.slice(ctx.config.prefix.length).trim())
    ) {
      return false;
    }

    const file = msg.attachments?.first();
    if (file) {
      try {
        const text = await readAttachmentText(file);
        if (!text) {
          await reply(msg, "Brauchst eine .tsv / .csv / .txt Anlage.");
          return true;
        }
        pending.delete(msg.author.id);
        return finalize(ctx, msg, wait, text);
      } catch (e) {
        await reply(msg, `Datei lesen fehlgeschlagen: ${e.message}`);
        return true;
      }
    }

    const body = msg.content.trim();
    if (DONE.test(body) || DONE.test(body.replace(ctx.config.prefix, "").trim())) {
      pending.delete(msg.author.id);
      const text = wait.chunks.join("\n");
      if (!text.trim()) {
        await reply(msg, "Keine Zeilen empfangen. Zeilen senden, dann `done`/`fertig`/`end`.");
        return true;
      }
      return finalize(ctx, msg, wait, text);
    }

    wait.chunks.push(body);
    wait.expires = Date.now() + 15 * 60 * 1000;
    const lineCount = wait.chunks.join("\n").split(/\n/).filter((l) => l.trim()).length;
    await reply(
      msg,
      [
        `Gepuffert (~${lineCount} Zeilen). Mehr senden, oder \`done\`/\`fertig\`/\`end\` zum Import.`,
        `Das hier ist der Import für ${wait.displayName}, nicht deine eigene Liste.`,
      ].join("\n")
    );
    return true;
  },
};

module.exports = cmd;
