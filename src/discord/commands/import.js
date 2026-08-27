const axios = require("axios");
const db = require("../../db");
const { parseSheetTable } = require("../import-sheet");
const { queueCelebsForReview } = require("../celeb-review");
const { usageReply } = require("../usage");

const pending = new Map();
const DONE = /^(done|fertig|end)$/i;

function applyImportRows(player, rows) {
  const season = db.getActiveSeason();
  let added = 0;
  let deadAwarded = 0;
  const errors = [];
  const ageWarnings = [];
  const reviewIds = [];

  db.clearPicksForPlayer(player.id, season.id);

  const tx = db.getDb().transaction(() => {
    for (const row of rows) {
      try {
        const { celeb, ageConflict, created } = db.findOrCreateCeleb({
          name: row.name,
          age: row.age,
          description: row.description,
        });
        if (ageConflict) {
          ageWarnings.push(
            `${row.name}: kept age ${ageConflict.existing}, ignored ${ageConflict.incoming}`
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

        if (row.diedAt && fresh.is_alive) {
          const result = db.applyDeath(celeb.id, {
            confirmed: true,
            source: "sheet",
            diedAt: row.diedAt,
          });
          if (result.awards.some((a) => a.player.id === player.id)) deadAwarded++;
        } else if (row.diedAt && !fresh.is_alive) {
          const existing = db
            .getDb()
            .prepare("SELECT 1 FROM death_awards WHERE celeb_id = ? AND player_id = ?")
            .get(celeb.id, player.id);
          if (!existing) {
            const score = db.scoreForAge(fresh.age_at_pick ?? fresh.sheet_age_hint);
            if (score > 0) {
              db.addPoints(player.id, score);
              db.getDb()
                .prepare(
                  `INSERT INTO death_awards (celeb_id, player_id, points) VALUES (?, ?, ?)`
                )
                .run(celeb.id, player.id, score);
              deadAwarded++;
            }
          }
        }
      } catch (e) {
        errors.push(`${row.name}: ${e.message}`);
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
    await msg.reply(`Import fehlgeschlagen: ${parsed.error}`);
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

  await msg.reply(
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

  if (reviewIds.length) {
    const { resolveAdminTarget } = require("../admin-notify");
    const target = await resolveAdminTarget(ctx, {
      preferDmUser: msg.author,
      fallbackChannel: msg.channel,
    });
    await queueCelebsForReview(ctx, reviewIds, target || msg.channel);
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
      await msg.reply(usageReply(cmd, ctx.config));
      return;
    }
    const season = db.getActiveSeason();
    const displayName = msg.mentions.members?.first()?.displayName || mention.username;
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
          await msg.reply("Brauchst eine .tsv / .csv / .txt Anlage.");
          return;
        }
        pending.delete(msg.author.id);
        await msg.reply(
          `Import für **${displayName}** — Datei wird eingelesen (Saisonstart **${season.start_date || "?"}**).`
        );
        await finalize(ctx, msg, wait, text);
        return;
      } catch (e) {
        pending.delete(msg.author.id);
        await msg.reply(`Datei lesen fehlgeschlagen: ${e.message}`);
        return;
      }
    }

    await msg.reply(
      [
        `Import für **${displayName}** — Ersetzen-Modus.`,
        `Saisonstart **${season.start_date || "?"}**. Chunks pasten, dann \`done\` / \`fertig\` / \`end\` (oder Datei anhängen).`,
      ].join("\n")
    );
  },

  async tryConsumePaste(ctx, msg) {
    const wait = pending.get(msg.author.id);
    if (!wait) return false;
    if (Date.now() > wait.expires) {
      pending.delete(msg.author.id);
      return false;
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
          await msg.reply("Brauchst eine .tsv / .csv / .txt Anlage.");
          return true;
        }
        pending.delete(msg.author.id);
        return finalize(ctx, msg, wait, text);
      } catch (e) {
        await msg.reply(`Datei lesen fehlgeschlagen: ${e.message}`);
        return true;
      }
    }

    const body = msg.content.trim();
    if (DONE.test(body) || DONE.test(body.replace(ctx.config.prefix, "").trim())) {
      pending.delete(msg.author.id);
      const text = wait.chunks.join("\n");
      if (!text.trim()) {
        await msg.reply("Keine Zeilen empfangen. Zeilen senden, dann `done`/`fertig`/`end`.");
        return true;
      }
      return finalize(ctx, msg, wait, text);
    }

    wait.chunks.push(body);
    wait.expires = Date.now() + 15 * 60 * 1000;
    const lineCount = wait.chunks.join("\n").split(/\n/).filter((l) => l.trim()).length;
    await msg.reply(
      `Gepuffert (~${lineCount} Zeilen). Mehr senden, oder \`done\`/\`fertig\`/\`end\` zum Import.`
    );
    return true;
  },
};

module.exports = cmd;
