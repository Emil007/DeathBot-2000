const axios = require("axios");
const db = require("../../db");
const { parseSheetTable } = require("../import-sheet");
const { queueCelebsForReview } = require("../celeb-review");

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

module.exports = {
  name: "import",
  admin: true,
  description: "Replace @User list; multi-paste until done, or upload file; then wiki review",
  async run(ctx, args, msg) {
    const mention = msg.mentions.users.first();
    if (!mention) {
      await msg.reply(
        [
          "Usage: `!import @User`",
          "Paste sheet rows (tab-separated). **Multiple messages** OK — finish with `done`.",
          "Or upload `.tsv` / `.csv` / `.txt`.",
          "Required: Name, Alter. Then wiki/age **review buttons** for new celebs.",
        ].join("\n")
      );
      return;
    }
    const season = db.getActiveSeason();
    const displayName = msg.mentions.members?.first()?.displayName || mention.username;
    pending.set(msg.author.id, {
      playerDiscordId: mention.id,
      displayName,
      chunks: [],
      expires: Date.now() + 15 * 60 * 1000,
    });
    await msg.reply(
      [
        `Import for **${displayName}** — replace mode.`,
        `Season start **${season.start_date || "?"}**. Paste chunks, then type \`done\` (or attach a file).`,
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
          await msg.reply("Need a .tsv / .csv / .txt attachment.");
          return true;
        }
        pending.delete(msg.author.id);
        return finalize(ctx, msg, wait, text);
      } catch (e) {
        await msg.reply(`Attachment read failed: ${e.message}`);
        return true;
      }
    }

    const body = msg.content.trim();
    if (DONE.test(body) || DONE.test(body.replace(ctx.config.prefix, "").trim())) {
      pending.delete(msg.author.id);
      const text = wait.chunks.join("\n");
      if (!text.trim()) {
        await msg.reply("No rows received. Send lines then `done`.");
        return true;
      }
      return finalize(ctx, msg, wait, text);
    }

    wait.chunks.push(body);
    wait.expires = Date.now() + 15 * 60 * 1000;
    const lineCount = wait.chunks.join("\n").split(/\n/).filter((l) => l.trim()).length;
    await msg.reply(`Buffered (~${lineCount} lines). Send more, or \`done\` to import.`);
    return true;
  },
};

async function finalize(ctx, msg, wait, text) {
  const parsed = parseSheetTable(text);
  if (parsed.error) {
    await msg.reply(`Import failed: ${parsed.error}`);
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
      `✅ List replaced for <@${wait.playerDiscordId}> (**${wait.displayName}**)`,
      `• Picks: **${added}**`,
      `• Sheet-dead + points: **${deadAwarded}**`,
      `• Points total: **${db.playerTotal(player.id)}**`,
      `• Queued for wiki/age review: **${reviewIds.length}**`,
      ageWarnings.length
        ? `• Age kept (first wins):\n` + ageWarnings.slice(0, 8).map((w) => `  – ${w}`).join("\n")
        : null,
      errors.length ? `• Errors: ${errors.slice(0, 5).join("; ")}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  );

  if (reviewIds.length) {
    const target = msg.author;
    try {
      await queueCelebsForReview(ctx, reviewIds, await msg.author.createDM());
    } catch {
      await queueCelebsForReview(ctx, reviewIds, msg.channel);
    }
  }
  return true;
}
