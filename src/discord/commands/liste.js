const db = require("../../db");

const cmd = {
  name: "liste",
  aliases: ["mylist", "mypicks"],
  admin: false,
  group: "everyone",
  description: "Zeigt deine Picks (per DM wenn möglich; Admin: fremde Liste)",
  usage: "/liste [user:@Spieler]\n{prefix}liste [@User]",
  examples: ["/liste", "{prefix}liste", "/liste user:@Spieler"],
  options: [
    {
      name: "user",
      description: "Spieler (nur Admin sieht fremde Listen)",
      type: "USER",
      required: false,
    },
  ],
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const target =
      msg.mentions.users.first() && msg.author.id === ctx.config.adminId
        ? msg.mentions.users.first()
        : msg.author;

    const data = db.getPlayerPicks(target.id);
    if (!data) {
      await msg.reply(
        "Keine Picks gefunden. Admin muss dich per `/import` bzw. `{prefix}import @User` anlegen.".replace(
          "{prefix}",
          ctx.config.prefix
        )
      );
      return;
    }

    const lines = data.picks.map((c) => {
      const flag = c.is_alive ? "🟢" : "💀";
      const age = c.age_at_pick != null ? ` (${c.age_at_pick})` : "";
      const desc = c.description ? ` — _${c.description}_` : "";
      return `${flag} **${c.name}**${age}${desc}`;
    });

    const header = `**${data.player.display_name}** — ${data.picks.length} Picks | Punkte **${data.total}**\n`;
    let body = header;
    const chunks = [];
    for (const line of lines) {
      if ((body + line + "\n").length > 1800) {
        chunks.push(body);
        body = "";
      }
      body += line + "\n";
    }
    if (body) chunks.push(body);

    try {
      for (const chunk of chunks) await msg.author.send(chunk);
      await msg.reply("Liste per DM geschickt.");
    } catch {
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) await msg.reply(chunks[i]);
        else await msg.channel.send(chunks[i]);
      }
    }
  },
};

module.exports = cmd;
