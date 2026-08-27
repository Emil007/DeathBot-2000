const db = require("../../db");
const { parseSheetTable } = require("../import-sheet");

const pending = new Map();

module.exports = {
  name: "import",
  admin: true,
  description: "Importiere Sheet-Liste für @User (Name+Alter; Punkte=100−Alter)",
  async run(ctx, args, msg) {
    const mention = msg.mentions.users.first();
    if (!mention) {
      await msg.reply(
        "Usage: `!import @DiscordUser` — danach TSV pasten.\nSpalten: **Name**, **Alter** (zum Saison-Start). Punkte-Spalte wird ignoriert (=100−Alter). Optional: Beschreibung, gestorben."
      );
      return;
    }
    const season = db.getActiveSeason();
    const displayName = msg.mentions.members?.first()?.displayName || mention.username;
    pending.set(msg.author.id, {
      playerDiscordId: mention.id,
      displayName,
      expires: Date.now() + 5 * 60 * 1000,
    });
    await msg.reply(
      [
        `Ok. Paste die Liste für **${displayName}** (<@${mention.id}>).`,
        `Saison-Start: **${season.start_date || "?"}** — Alter = Stand dieses Tags.`,
        `Punkte werden als \`max(1, 100 − Alter)\` berechnet (Sheet-Punkte egal).`,
        `Timeout 5 Min.`,
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

          // Sheet already marks dead — trusted/confirmed, score from age_at_pick
          if (row.diedAt && celeb.is_alive) {
            const fresh = db.getDb().prepare("SELECT * FROM celebs WHERE id = ?").get(celeb.id);
            if (fresh.is_alive) {
              const result = db.applyDeath(celeb.id, {
                confirmed: true,
                source: "sheet",
                diedAt: row.diedAt,
              });
              // applyDeath awards ALL current winners; if this player was just added
              // they are included. If celeb already dead from another import, award only this player:
              if (result.awards.some((a) => a.player.id === player.id)) {
                deadAwarded++;
              }
            }
          } else if (row.diedAt && !celeb.is_alive) {
            // Already dead from prior import — ensure this player got points once
            const existing = db
              .getDb()
              .prepare("SELECT 1 FROM death_awards WHERE celeb_id = ? AND player_id = ?")
              .get(celeb.id, player.id);
            if (!existing) {
              const score = db.scoreForAge(row.age ?? celeb.age_at_pick);
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

    await msg.reply(
      [
        `✅ Import für <@${wait.playerDiscordId}> (**${wait.displayName}**)`,
        `• Picks: **${added}**`,
        `• Bereits tot (Sheet) + Punkte: **${deadAwarded}**`,
        `• Punkte jetzt: **${db.playerTotal(player.id)}**`,
        season.live
          ? null
          : "_Setup-Modus: Wiki-Nachzug mit `!check`, danach `!go`._",
        errors.length ? `• Fehler: ${errors.slice(0, 5).join("; ")}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
    return true;
  },
};
