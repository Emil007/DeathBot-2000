const db = require("../../db");
const { usageReply } = require("../usage");

async function sendChunks(msg, chunks) {
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) await msg.reply({ content: chunks[i], allowedMentions: { parse: [] } });
    else await msg.channel.send({ content: chunks[i], allowedMentions: { parse: [] } });
  }
}

function chunkLines(header, lines) {
  const chunks = [];
  let body = header;
  for (const line of lines) {
    if ((body + line + "\n").length > 1800) {
      chunks.push(body);
      body = "";
    }
    body += line + "\n";
  }
  if (body) chunks.push(body);
  return chunks;
}

const cmd = {
  name: "liste",
  aliases: ["mylist", "mypicks", "list"],
  admin: false,
  group: "everyone",
  description: "Zeigt Picks — eigene oder von jedem anderen Spieler",
  usage: "/liste [user:@Spieler]\n{prefix}liste [@User|Name]",
  examples: [
    "/liste",
    "/liste user:@Spieler",
    "{prefix}liste Emil",
  ],
  options: [
    {
      name: "user",
      description: "Spieler dessen Liste du sehen willst",
      type: "USER",
      required: false,
    },
    {
      name: "user_id",
      description: "Discord-ID (Fallback in DMs)",
      type: "STRING",
      required: false,
    },
    {
      name: "name",
      description: "Anzeigename des Spielers",
      type: "STRING",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const user = interaction.options.getUser("user");
    const id = interaction.options.getString("user_id");
    const name = interaction.options.getString("name");
    if (user) return [];
    if (id) return [id];
    if (name) return name.split(/\s+/);
    return [];
  },
  async run(ctx, args, msg) {
    let discordId = msg.author.id;
    let label = null;

    const mention = msg.mentions.users.first();
    if (mention) {
      discordId = mention.id;
    } else if (args.length) {
      const q = args.join(" ").trim();
      if (/^\d{16,20}$/.test(q)) {
        discordId = q;
      } else {
        const player = db.findPlayerByQuery(q);
        if (!player) {
          await msg.reply(
            `Kein Spieler „${q}“. Namen siehe \`/players\` (Admin) oder \`/scores\`.`
          );
          return;
        }
        discordId = player.discord_user_id;
        label = player.display_name;
      }
    }

    const data = db.getPlayerPicks(discordId);
    if (!data) {
      await msg.reply(
        discordId === msg.author.id
          ? "Keine Picks gefunden. Admin muss dich per `/import` anlegen."
          : `Keine Picks für ${label || `<@${discordId}>`}.`
      );
      return;
    }

    const lines = data.picks.map((c) => {
      const flag = c.is_alive ? "🟢" : "💀";
      const age = c.age_at_pick != null ? ` (${c.age_at_pick})` : "";
      const desc = c.description ? ` — _${c.description}_` : "";
      return `${flag} **${c.name}**${age}${desc}`;
    });

    const whose =
      discordId === msg.author.id ? "Deine Liste" : `Liste **${data.player.display_name}**`;
    const header = `${whose} — ${data.picks.length} Picks | Punkte **${data.total}**\n`;
    await sendChunks(msg, chunkLines(header, lines));
  },
};

module.exports = cmd;
