const axios = require("axios");
const db = require("../../db");
const { parseSheetTable } = require("../import-sheet");

const pending = new Map();
const DONE = /^(done|fertig|end|import)$/i;

function applyImportRows(player, rows) {
  const season = db.getActiveSeason();
  let added = 0;
  let deadAwarded = 0;
  const errors = [];
  const ageWarnings = [];

  // Replace semantics: drop old picks for this season, then insert
  db.clearPicksForPlayer(player.id, season.id);

  const tx = db.getDb().transaction(() => {
    for (const row of rows) {
      try {
        const { celeb, ageConflict } = db.findOrCreateCeleb({
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
            const score = db.scoreForAge(fresh.age_at_pick);
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

  return { added, deadAwarded, errors, ageWarnings, season };
}

async function readAttachmentText(attachment) {
  const name = (attachment.name || "").toLowerCase();
  if (!/\.(tsv|csv|txt)$/i.test(name) && attachment.contentType && !/text|csv/i.test(attachment.contentType)) {
    return null;
  }
  const { data } = await axios.get(attachment.url, { responseType: "text", timeout: 20000 });
  return String(data);
}

module.exports = {
  name: "import",
  admin: true,
  description: "Replace @User list: paste TSV (multi-message OK) or upload .tsv/.csv/.txt",
  async run(ctx, args, msg) {
    const mention = msg.mentions.users.first();
    if (!mention) {
      await msg.reply(
        [
          "Usage: `!import @User`",
          "Then paste the sheet (tab-separated). You can send **multiple messages**; finish with `done`.",
          "Or upload a `.tsv` / `.csv` / `.txt` file.",
          "Required: **Name**, **Alter**. Points column ignored (`100 − age`). Optional: description, death date.",
          "**Replaces** that player's picks for the active season.",
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
      expires: Date.now() + 10 * 60 * 1000,
    });
    await msg.reply(
      [
        `Import for **${displayName}** (<@${mention.id}>) — **replace** mode.`,
        `Season start: **${season.start_date || "?"}**. Paste rows, more messages OK, then \`done\`. Or attach a file.`,
        `Timeout 10 min.`,
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
    if (msg.content.startsWith(ctx.config.prefix) && !DONE.test(msg.content.slice(ctx.config.prefix.length).trim())) {
      return false;
    }

    // Attachment?
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
        await msg.reply("No rows received.");
        return true;
      }
      return finalize(ctx, msg, wait, text);
    }

    wait.chunks.push(body);
    wait.expires = Date.now() + 10 * 60 * 1000;
    const combined = wait.chunks.join("\n");
    const lineCount = combined.split(/\n/).filter((l) => l.trim()).length;
    // Auto-finish when it already looks like a full table paste
    if (lineCount >= 3 || (body.includes("\t") && body.includes("\n"))) {
      pending.delete(msg.author.id);
      return finalize(ctx, msg, wait, combined);
    }
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

  const { added, deadAwarded, errors, ageWarnings, season } = applyImportRows(
    player,
    parsed.rows
  );

  await msg.reply(
    [
      `✅ Import replaced list for <@${wait.playerDiscordId}> (**${wait.displayName}**)`,
      `• Picks now: **${added}**`,
      `• Already dead (sheet) + points: **${deadAwarded}**`,
      `• Points total: **${db.playerTotal(player.id)}**`,
      season.live ? null : "_Setup: `!check` optional; `!go` auto-reconciles before live._",
      ageWarnings.length
        ? `• Age kept (first wins):\n` + ageWarnings.slice(0, 8).map((w) => `  – ${w}`).join("\n")
        : null,
      errors.length ? `• Errors: ${errors.slice(0, 5).join("; ")}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  );
  return true;
}
