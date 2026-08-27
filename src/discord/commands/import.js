const db = require("../../db");
const { parseSheetTable } = require("../import-sheet");

const pending = new Map(); // adminId -> { playerDiscordId, displayName, expires }

module.exports = {
  name: "import",
  admin: true,
  description: "Importiere eine Google-Sheet-Liste für @User (nächste Nachricht = TSV)",
  async run(ctx, args, msg) {
    const mention = msg.mentions.users.first();
    if (!mention) {
      await msg.reply("Usage: `!import @DiscordUser` — danach die Tabelle pasten.");
      return;
    }
    const displayName = msg.mentions.members?.first()?.displayName || mention.username;
    pending.set(msg.author.id, {
      playerDiscordId: mention.id,
      displayName,
      expires: Date.now() + 5 * 60 * 1000,
    });
    await msg.reply(
      `Ok. Paste jetzt die Liste für **${displayName}** (<@${mention.id}>) als nächste Nachricht (Tab-getrennt aus Sheets). Timeout 5 Min.`
    );
  },
  /** @returns {Promise<boolean>} true if consumed */
  async tryConsumePaste(ctx, msg) {
    const wait = pending.get(msg.author.id);
    if (!wait) return false;
    if (Date.now() > wait.expires) {
      pending.delete(msg.author.id);
      return false;
    }
    if (msg.content.startsWith(ctx.config.prefix)) return false;

    pending.delete(msg.author.id);
    const parsed = parseSheetTable(msg.content);
    if (parsed.error) {
      await msg.reply(`Import fehlgeschlagen: ${parsed.error}`);
      return true;
    }

    const season = db.getActiveSeason();
    const player = db.upsertPlayer({
      displayName: wait.displayName,
      discordUserId: wait.playerDiscordId,
    });

    let added = 0;
    let deadAwarded = 0;
    const errors = [];

    const tx = db.getDb().transaction(() => {
      for (const row of parsed.rows) {
        try {
          const celeb = db.findOrCreateCeleb({
            name: row.name,
            age: row.age,
            description: row.description,
          });
          db.setPick(player.id, celeb.id, season.id);
          added++;

          if (row.diedAt) {
            const wasAlive = celeb.is_alive;
            if (wasAlive) {
              db.markCelebDead(celeb.id, row.diedAt, null);
            }
            const score = db.scoreForAge(row.age ?? celeb.age_at_pick);
            if (score > 0) {
              db.addPoints(player.id, score);
              deadAwarded++;
            }
          }
        } catch (e) {
          errors.push(`${row.name}: ${e.message}`);
        }
      }
    });
    tx();

    await msg.reply(
      [
        `✅ Import für <@${wait.playerDiscordId}> (**${wait.displayName}**)`,
        `• Zeilen/Picks: **${added}**`,
        `• Bereits tot + Punkte vergeben: **${deadAwarded}**`,
        `• Aktuelle Punkte: **${db.playerTotal(player.id)}**`,
        errors.length ? `• Fehler: ${errors.slice(0, 5).join("; ")}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
    return true;
  },
};
