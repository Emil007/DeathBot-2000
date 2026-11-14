const { sendChunks, chunkLines, sanitizeDisplayName } = require("./liste");
const { readScoreboard } = require("./scores");

const EMPTY = "Noch keine Spieler im Pool.";

const cmd = {
  name: "players",
  admin: false,
  group: "everyone",
  description: "Alle Spieler und ihre Punkte",
  usage: "/players\n{prefix}players",
  examples: ["/players", "{prefix}players"],
  details: "Für `/liste` mit Mention oder Snowflake.",
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const rows = readScoreboard()
      .slice()
      .sort((a, b) =>
        String(a.display_name).localeCompare(String(b.display_name), "de", { sensitivity: "base" })
      );
    if (!rows.length) {
      await sendChunks(msg, [EMPTY]);
      return;
    }
    const lines = rows.map(
      (p) => `• **${sanitizeDisplayName(p.display_name)}** <@${p.discord_user_id}> — ${p.total} Punkte`
    );
    await sendChunks(msg, chunkLines("", lines));
  },
};

module.exports = cmd;
module.exports.EMPTY = EMPTY;
