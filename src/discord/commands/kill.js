const db = require("../../db");
const { processDeathpoolHit } = require("../announce");
const { usageReply } = require("../usage");

const cmd = {
  name: "kill",
  admin: true,
  group: "match",
  description: "Markiert einen Celeb manuell als tot",
  usage: "/kill name:<Name>\n{prefix}kill <Name>",
  examples: ["/kill name:Ozzy Osbourne", "{prefix}kill Ozzy Osbourne"],
  options: [
    {
      name: "name",
      description: "Celeb-Name",
      type: "STRING",
      required: true,
    },
  ],
  parseSlash(interaction) {
    const name = interaction.options.getString("name");
    return name ? name.split(/\s+/) : [];
  },
  async run(ctx, args, msg) {
    const q = args.join(" ").trim();
    if (!q) {
      await msg.reply(usageReply(cmd, ctx.config));
      return;
    }
    const found = db.findCelebByName(q);
    if (!found.length) {
      await msg.reply("Nicht gefunden.");
      return;
    }
    if (found.length > 1) {
      await msg.reply("Mehrdeutig:\n" + found.map((c) => `• ${c.name} (id ${c.id})`).join("\n"));
      return;
    }
    const celeb = found[0];
    if (!celeb.is_alive) {
      await msg.reply("Ist schon tot.");
      return;
    }
    const entry = {
      id: `manual:${celeb.id}`,
      text: `${celeb.name}, ${celeb.age_at_pick ?? "?"}`,
      url: celeb.wiki_url || null,
      lang: "en",
    };
    const live = db.isLive();
    await processDeathpoolHit(
      ctx.client,
      ctx.config,
      { celeb, entry, wikiAge: celeb.age_at_pick },
      { announce: live, confirmed: !live, source: "manual" }
    );
    await msg.reply(
      live
        ? `Erledigt (live angekündigt): ${celeb.name}`
        : `Erledigt (Setup, ohne Channel-Ping): ${celeb.name}`
    );
  },
};

module.exports = cmd;
