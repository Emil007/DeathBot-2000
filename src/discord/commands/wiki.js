const db = require("../../db");
const { lookupUrl } = require("../../wiki/page-lookup");
const { usageReply } = require("../usage");

const cmd = {
  name: "wiki",
  admin: true,
  group: "season",
  description: "Wiki-URL setzen oder Celeb auf manuell (none)",
  usage: "/wiki name:<Name> url:<URL|none>\n{prefix}wiki <Name> <url|none>",
  examples: [
    "/wiki name:Ozzy Osbourne url:https://en.wikipedia.org/wiki/Ozzy_Osbourne",
    "/wiki name:Foo url:none",
    "{prefix}wiki Ozzy Osbourne none",
  ],
  options: [
    {
      name: "name",
      description: "Celeb-Name",
      type: "STRING",
      required: true,
    },
    {
      name: "url",
      description: "Wikipedia-URL oder none (nur manuell)",
      type: "STRING",
      required: true,
    },
  ],
  parseSlash(interaction) {
    const name = interaction.options.getString("name");
    const url = interaction.options.getString("url");
    return [name, url].filter((x) => x != null && x !== "");
  },
  async run(ctx, args, msg) {
    if (args.length < 2) {
      await msg.reply(usageReply(cmd, ctx.config));
      return;
    }
    const last = args[args.length - 1];
    const name = args.slice(0, -1).join(" ");
    const found = db.findCelebByName(name);
    if (found.length !== 1) {
      await msg.reply(found.length ? "Mehrdeutiger Name." : "Nicht gefunden.");
      return;
    }
    const celeb = found[0];

    if (/^none$/i.test(last)) {
      db.applyWikiConfirm(celeb.id, {
        age: celeb.age_at_pick ?? celeb.sheet_age_hint,
        manualOnly: true,
      });
      await msg.reply(`**${celeb.name}** auf manuell gesetzt (kein Auto-Wiki-Match).`);
      return;
    }

    const season = db.getActiveSeason();
    try {
      const proposal = await lookupUrl(
        ctx.config.userAgent,
        last,
        season.start_date,
        celeb.sheet_age_hint
      );
      const confirmed = db.applyWikiConfirm(celeb.id, {
        wikiUrl: proposal.wikiUrl,
        wikiNorm: proposal.wikiNorm,
        age: proposal.proposedAge ?? celeb.age_at_pick,
        manualOnly: false,
      });
      await msg.reply(
        `Wiki für **${confirmed.name}**: ${confirmed.wiki_url}\nAlter zum Saisonstart: **${confirmed.age_at_pick ?? "?"}** (Auto-Match an).`
      );
    } catch (e) {
      await msg.reply(`Fehlgeschlagen: ${e.message}`);
    }
  },
};

module.exports = cmd;
