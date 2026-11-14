const fs = require("fs");
const path = require("path");
const db = require("../../db");
const { sendNextReview } = require("../celeb-review");
const { resolveAdminTarget } = require("../admin-notify");

// ANNAHME: siehe celeb-review.js — mentionOpts kommt aus M1, sonst vertragsgleicher Fallback.
function mentionOpts() {
  const abs = path.join(__dirname, "..", "safe-text.js");
  if (!fs.existsSync(abs)) return { allowedMentions: { parse: [] } };
  const mod = require(abs);
  if (typeof mod.mentionOpts !== "function") {
    throw new Error("safe-text.js must export mentionOpts");
  }
  return mod.mentionOpts();
}

const SCOPE_REJECT = "`anmeldung` oder `pool`.";

function scopeValue(arg) {
  const lower = String(arg ?? "").trim().toLowerCase();
  if (!lower) return "";
  if (lower.startsWith("scope:")) return lower.slice("scope:".length).trim();
  return lower;
}

/**
 * Leere Argumentliste = Anmeldung (bisheriger Default).
 * Genau `anmeldung` oder `pool` (auch als scope:-Prefix, exakt, nicht als Präfix).
 * Alles andere — auch `poool` / `scope:poool` — ist ungültig. Kein stilles Default.
 * ANNAHME: Mehrere Tokens sind nur gültig, wenn sie alle dasselbe Scope nennen.
 */
function resolveReviewScope(args) {
  const list = Array.isArray(args) ? args : [];
  if (list.length === 0) return "anmeldung";
  const values = list.map(scopeValue);
  if (values.some((v) => v !== "anmeldung" && v !== "pool")) return null;
  if (values.every((v) => v === "pool")) return "pool";
  if (values.every((v) => v === "anmeldung")) return "anmeldung";
  return null;
}

const cmd = {
  name: "review",
  admin: true,
  group: "season",
  description: "Setzt die Wiki-/Alter-Review-Warteschlange fort",
  usage: "/review [scope:anmeldung|pool]\n{prefix}review",
  examples: ["/review", "/review scope:anmeldung", "/review scope:pool", "{prefix}review"],
  details:
    "Ohne Argument die Anmeldungs-Queue der angekündigten Runde. scope:anmeldung dieselbe Queue, scope:pool der laufende Pool. Andere Werte (auch Tippfehler wie poool) werden abgelehnt. Nach /import erscheinen Karten mit Buttons; /review zeigt die nächste. Mit CHANNEL_ADMIN landen Karten dort, sonst DM, sonst der aktuelle Kanal.",
  options: [
    {
      name: "scope",
      description: "anmeldung (angekündigte Runde) oder pool (laufender Pool)",
      type: "STRING",
      required: false,
      choices: [
        { name: "Anmeldung", value: "anmeldung" },
        { name: "Pool", value: "pool" },
      ],
    },
  ],
  parseSlash(interaction) {
    const s = interaction.options.getString("scope");
    return s ? [`scope:${s}`] : [];
  },
  async run(ctx, args, msg) {
    const scope = resolveReviewScope(args);
    if (!scope) {
      await msg.reply({ content: SCOPE_REJECT, ...mentionOpts() });
      return;
    }
    // pool = laufender Pool (seasonId undefined). anmeldung = Queue der angekündigten Runde.
    const wantPool = scope === "pool";
    const announced = db.getAnnouncedSeason();
    const effSeasonId = wantPool ? undefined : announced?.id ?? undefined;
    const n = db.countPendingReviews({ seasonId: effSeasonId });
    if (!n) {
      await msg.reply({ content: "Review-Warteschlange ist leer.", ...mentionOpts() });
      return;
    }
    const target = await resolveAdminTarget(ctx, {
      preferDmUser: msg.author || null,
      fallbackChannel: msg.channel,
    });
    const label =
      effSeasonId && announced?.id === effSeasonId
        ? `${announced.year}-Anmeldung`
        : "laufender Pool";
    await msg.reply({
      content:
        `${n} offen (${label}). Nächste Karte` +
        (ctx.config.channelAdmin && target?.id === ctx.config.channelAdmin
          ? " im Admin-Kanal."
          : ":"),
      ...mentionOpts(),
    });
    if (effSeasonId && announced?.id === effSeasonId) {
      await sendNextReview(ctx, target || msg.channel, { season: announced, seasonId: effSeasonId });
    } else {
      await sendNextReview(ctx, target || msg.channel);
    }
  },
};

module.exports = cmd;
