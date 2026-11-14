const db = require("../../db");
const { announceRetraction } = require("../announce");
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
  name: "resurrect",
  admin: true,
  group: "match",
  description: "Belebt einen Celeb wieder (Punkte-Rückbuchung wie Retract)",
  usage: "/resurrect name:<Name>\n{prefix}resurrect <Name>",
  examples: ["/resurrect name:Ozzy Osbourne", "{prefix}resurrect Ozzy Osbourne"],
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
    if (found.length !== 1) {
      await say(msg, found.length ? "Mehrdeutig — genauer bitte." : "Nicht gefunden.");
      return;
    }
    const celeb = found[0];
    if (celeb.is_alive) {
      await say(msg, "Lebt bereits.");
      return;
    }
    const result = db.retractDeath(celeb.id);
    if (!result) {
      await say(msg, "Lebt bereits.");
      return;
    }
    try {
      await announceRetraction(ctx.client, ctx.config, result);
    } catch {
      await say(msg, "Punkte sind zurück, die Nachricht nicht. Der nächste Poll holt sie nach.");
      return;
    }
    const name = sanitizeDisplayName(result.celeb.name);
    await say(msg, `${name} lebt wieder. ${result.awards.length} Punkte-Buchungen rückgängig.`);
  },
};

module.exports = cmd;
