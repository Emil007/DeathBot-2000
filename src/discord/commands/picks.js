const db = require("../../db");
const { canParticipate } = require("../membership");
const { respondPick } = require("../pick-assistant");
const { logError } = require("../log");

const cmd = {
  name: "picks",
  admin: false,
  group: "everyone",
  description: "Zeigt deine Tipp-Liste für die nächste (angekündigte) Runde",
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
      await msg.reply(
        part.reason === "not-member"
          ? "Die Anmeldung ist an den angekündigten Kanal gebunden. Wer den Kanal nicht sehen kann, gibt keine Tipps ab."
          : "Für die kommende Runde ist die Anmeldung noch nicht geöffnet."
      );
      return;
    }
    const season = part.season;
    // DM öffnen und Liste dorthin — wenn wir schon im DM sind, antworten
    let target = msg.channel;
    if (msg.guildId) {
      try {
        const dm = await msg.author.createDM();
        if (dm) target = dm;
      } catch (e) {
        await logError(ctx.client, ctx.config, e, { where: "/picks createDM", userId: msg.author.id });
        await msg.reply("Ich kann dir keine DM schreiben (DM-geschlossen?). Öffne die DM zu Gregg.");
        return;
      }
    }
    await respondPick(ctx, target, msg.author.id, season);
    if (msg.guildId && target !== msg.channel) {
      await msg.reply("Ich habe dir deine Tipp-Liste per DM geschickt — Namen einfach dort hin schreiben.");
    }
  },
};

module.exports = cmd;
