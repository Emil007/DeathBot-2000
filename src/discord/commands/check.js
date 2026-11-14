const db = require("../../db");
const { runWikiPoll } = require("../../jobs/wiki-poll");
const { formatReconcileSummary } = require("../announce");
const { logError } = require("../log");

function mentionOpts() {
  try {
    return require("../safe-text").mentionOpts();
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes("safe-text")) throw e;
    return { allowedMentions: { parse: [] } };
  }
}

function isTokenBurned(err) {
  const code = err?.code ?? err?.rawError?.code;
  return Number(code) === 50027;
}

const cmd = {
  name: "check",
  aliases: ["reconcile"],
  admin: true,
  group: "season",
  description: "Wiki-Check: Setup=stiller Abgleich, Live=sofortiger Poll",
  usage: "/check\n{prefix}check",
  examples: ["/check", "{prefix}check"],
  details: "Im Setup keine Channel-Ankündigungen; Zusammenfassung per DM.",
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const season = db.getActiveSeason();
    const done = async (content, where) => {
      try {
        await msg.reply({ content, ...mentionOpts() });
      } catch (e) {
        if (isTokenBurned(e)) {
          await logError(ctx.client, ctx.config, e, { where, userId: msg.author?.id });
          return;
        }
        throw e;
      }
    };

    if (!season.live) {
      await msg.reply(
        `Setup-Abgleich läuft (Start **${season.start_date || "?"}**) — keine Channel-Ankündigungen…`
      );
      const { hits } = await runWikiPoll(ctx.client, ctx.config, { mode: "reconcile" });
      const summary = formatReconcileSummary(hits, db.getActiveSeason());
      let dmSent = false;
      try {
        await msg.author.send({ content: summary, ...mentionOpts() });
        dmSent = true;
      } catch (e) {
        if (isTokenBurned(e)) {
          await logError(ctx.client, ctx.config, e, { where: "check dm", userId: msg.author?.id });
          return;
        }
      }
      if (dmSent) {
        await done(
          `Fertig: **${hits.length}** Todesfälle nachgetragen. Zusammenfassung per DM. Danach \`/scores\` / \`/go\`.`,
          "check done"
        );
        return;
      }
      await done(summary, "check summary");
      return;
    }

    await msg.reply("Live-Wiki-Check…");
    try {
      const { hits } = await runWikiPoll(ctx.client, ctx.config, { mode: "live" });
      await done(
        `Wiki-Check fertig. Neue Pool-Treffer in diesem Lauf: **${hits.length}**.`,
        "check live done"
      );
    } catch (e) {
      if (isTokenBurned(e)) {
        await logError(ctx.client, ctx.config, e, { where: "check live", userId: msg.author?.id });
        return;
      }
      await msg.reply(`Fehler: ${e.message}`);
    }
  },
};

module.exports = cmd;
