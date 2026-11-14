const db = require("../../db");
const { processDeathpoolHit } = require("../announce");
const { usageReply } = require("../usage");
const { mentionOpts, sanitizeDisplayName } = loadSafeText();

function loadSafeText() {
  try {
    const t = require("../safe-text");
    if (typeof t.mentionOpts === "function" && typeof t.sanitizeDisplayName === "function") return t;
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
  }
  return {
    mentionOpts: () => ({ allowedMentions: { parse: [] } }),
    sanitizeDisplayName(raw) {
      let s = raw == null ? "" : String(raw);
      s = s.replace(/\p{Cc}/gu, "").replace(/[\u2028\u2029]/g, "");
      s = s.replace(/[*_~|`<>@()[\]]/g, "");
      s = s.replace(/\s+/gu, " ").trim();
      const chars = Array.from(s);
      if (chars.length > 80) s = chars.slice(0, 80).join("").trim();
      return s || "\u201EUnbenannt\u201C";
    },
  };
}

async function say(msg, content) {
  await msg.reply({ content, ...mentionOpts() });
}

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
      await say(msg, usageReply(cmd, ctx.config));
      return;
    }
    const found = db.findCelebByName(q);
    if (!found.length) {
      await say(msg, "Nicht gefunden.");
      return;
    }
    if (found.length > 1) {
      await say(
        msg,
        "Mehrdeutig:\n" + found.map((c) => `• ${sanitizeDisplayName(c.name)} (id ${c.id})`).join("\n")
      );
      return;
    }
    const celeb = found[0];
    if (!celeb.is_alive) {
      await say(msg, "Ist schon tot.");
      return;
    }
    const entry = {
      id: `manual:${celeb.id}`,
      text: `${celeb.name}, ${celeb.age_at_pick ?? "?"}`,
      url: celeb.wiki_url || null,
      lang: "en",
    };
    const live = db.isLive();
    const result = await processDeathpoolHit(
      ctx.client,
      ctx.config,
      { celeb, entry, wikiAge: celeb.age_at_pick },
      { announce: live, confirmed: !live, source: "manual" }
    );
    const name = sanitizeDisplayName(celeb.name);
    if (result?.skipped) {
      await say(
        msg,
        "Nicht angekündigt: der Celeb ist nicht bestätigt oder von der Automatik ausgenommen."
      );
      return;
    }
    if (!live) {
      await say(msg, `Erledigt (Setup, ohne Channel-Ping): ${name}`);
      return;
    }
    if (result?.announced) {
      await say(msg, `Erledigt (live angekündigt): ${name}`);
      return;
    }
    // ANNAHME: ohne gelaufenen markDeathAnnounced kein Erfolgs-Satz, auch wenn der Send durchging.
    await say(msg, "Nicht angekündigt: der Send ist nicht bestätigt.");
  },
};

module.exports = cmd;
