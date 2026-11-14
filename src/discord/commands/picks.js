const { canParticipate, participationSentence } = require("../membership");
const { respondPick } = require("../pick-assistant");
const { logError } = require("../log");

function mentionOpts() {
  try {
    return require("../safe-text").mentionOpts();
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND") return { allowedMentions: { parse: [] } };
    throw e;
  }
}

const cmd = {
  name: "picks",
  admin: false,
  group: "everyone",
  description: "Deine Namen für die nächste Runde",
  usage: "/picks\n{prefix}picks",
  examples: ["/picks", "{prefix}picks"],
  details:
    "Öffnet die Tipp-Liste für die kommende Saison. Namen per Direktnachricht an den Bot schicken.",
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const part = await canParticipate(ctx.client, ctx.config, msg.author.id);
    if (!part.ok) {
      await msg.reply({ content: participationSentence(part), ...mentionOpts() });
      return;
    }
    const season = part.season;
    let target = msg.channel;
    if (msg.guildId) {
      try {
        const dm = await msg.author.createDM();
        if (dm) target = dm;
      } catch (e) {
        await logError(ctx.client, ctx.config, e, { where: "/picks createDM", userId: msg.author.id });
        await msg.reply({
          content:
            "Ich kann dir keine DM schreiben (DMs zu). Öffne die Direktnachricht an Gregg und ruf `/picks` noch einmal auf.",
          ...mentionOpts(),
        });
        return;
      }
    }
    await respondPick(ctx, target, msg.author.id, season, [], msg.author.username);
    if (msg.guildId && target !== msg.channel) {
      await msg.reply({
        content: "Tipp-Liste ist in deiner DM. Namen dorthin, nicht in diesen Kanal.",
        ...mentionOpts(),
      });
    }
  },
};

module.exports = cmd;
