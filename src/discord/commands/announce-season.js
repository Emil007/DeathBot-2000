const {
  EmbedBuilder,
} = require("discord.js");
const { createPackage } = require("../../backup");
const db = require("../../db");
const { logEvent, logError } = require("../log");

/**
 * Embed für die Teilnahme-Ankündigung der nächsten Runde.
 * Feste Sätze — der Tipp-Assistent (M4) erklärt exakt diese Schritte.
 * Exportiert für Tests.
 */
function buildSeasonEmbed({ year, startDate, channelName, note, runningYear }) {
  const lines = [
    `🆕 **Neue Runde ${year}** — Tipp-Phase gestartet!`,
    "",
    `**Start:** ${startDate}. Die laufende Runde **${runningYear}** läuft bis dahin ganz normal weiter (Punkte gelten für **${year}**, nicht für den laufenden Stand).`,
    "",
    `Wer in **${channelName || "diesem Kanal"}** dabei ist, schickt mir eine **Direktnachricht** mit seinen Tipps.`,
    "Wer den Kanal nicht sehen kann, nimmt nicht teil.",
    "",
    "**So gibst du deine Tipps ab:**",
    "1. Schreib mir eine **DM** — Namen einzeln **oder als Liste** (eine pro Zeile, oder getrennt durch `;` bzw. Strich mit Leerzeichen ` - `).",
    "2. Ich verknüpfe jeden Namen mit **Wikipedia** und zeige dir deine Liste.",
    "3. Du kannst Namen `entfernen 3` / `ändern 3 Neuer Name` oder weitere hinzufügen — bis du `fertig`/`done` sagst.",
    "",
    `**Punkte:** Alter zum **${startDate}** → \`max(1, 100 − Alter)\` (jünger = mehr Punkte).`,
    "",
    "Danach bestätigt der Admin die Wikipedia-Zuordnung (`/review`) und schaltet am Starttag live (`/new-year activate:true`).",
  ];
  if (note) lines.push("", `📝 **Notiz:** ${note}`);
  const embed = new EmbedBuilder()
    .setColor(0x2a9d3f)
    .setTitle(`Nächste Runde: ${year}`)
    .setDescription(lines.join("\n"))
    .setTimestamp(new Date());
  return embed;
}

const DEFAULT_YEAR = () => {
  const now = new Date();
  return now.getUTCMonth() >= 10 ? now.getUTCFullYear() + 1 : now.getUTCFullYear() + 1;
};

const cmd = {
  name: "announce-season",
  admin: true,
  group: "season",
  description: "Öffnet die Anmeldung für die nächste (angekündigte) Saison",
  usage:
    "/announce-season announce_channel:#Kanal [note:…] [year:2027] [start_date:2027-01-01] [repost:true]",
  examples: [
    "/announce-season announce_channel:#wettbuero",
    "/announce-season announce_channel:#wettbuero note:Wer will mitmachen?",
    "/announce-season repost:true",
  ],
  details:
    "Legt eine announced-Saison (2027) an, speichert den Kanal und postet das Teilnahme-Embed. Die laufende Saison bleibt unangetastet. repost postet nur das Embed erneut. Wechsel am Saisonstart: /new-year activate:true.",
  options: [
    {
      name: "announce_channel",
      description: "Kanal, in dem die Runde angekündigt wird (Teilnahme-Recht = ViewChannel)",
      type: "CHANNEL",
      required: false,
    },
    {
      name: "note",
      description: "Optionale Notiz/Zusatz im Embed",
      type: "STRING",
      required: false,
    },
    {
      name: "year",
      description: "Jahr der neuen Runde (Default: nächstes Jahr)",
      type: "INTEGER",
      required: false,
    },
    {
      name: "start_date",
      description: "Startdatum YYYY-MM-DD (Default: 1. Januar des Jahres)",
      type: "STRING",
      required: false,
    },
    {
      name: "repost",
      description: "Embed noch einmal posten, ohne etwas anzulegen/löschen",
      type: "BOOLEAN",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const args = [];
    const ch = interaction.options.getChannel("announce_channel");
    if (ch) args.push(`channel:${ch.id}`);
    const note = interaction.options.getString("note");
    if (note) args.push(`note:${note}`);
    const year = interaction.options.getInteger("year");
    if (year) args.push(`year:${year}`);
    const sd = interaction.options.getString("start_date");
    if (sd) args.push(`start:${sd}`);
    if (interaction.options.getBoolean("repost")) args.push("repost");
    return args;
  },
  async run(ctx, args, msg) {
    const isRepost = args.includes("repost");
    const getArg = (key) => {
      const a = args.find((x) => x.startsWith(`${key}:`));
      return a ? a.slice(key.length + 1) : null;
    };
    const channelMention = msg.mentions?.channels?.first?.();
    const year = Number(getArg("year") || DEFAULT_YEAR());
    const startDate = getArg("start") || `${year}-01-01`;
    const note = getArg("note");

    // Kanal aus Option, aus Erwähnung oder bestehendem announced-Kanal
    let channelId = getArg("channel");
    if (!channelId && channelMention) channelId = channelMention.id;

    const announced = db.getAnnouncedSeason();

    if (isRepost) {
      if (!announced) {
        await msg.reply("Keine announced-Saison vorhanden — zuerst `/announce-season announce_channel:#Kanal`.");
        return;
      }
      if (announced.live !== 0) {
        await msg.reply("Saison ist schon live — Repost nicht nötig.");
        return;
      }
      const chanId = channelId || announced.announce_channel_id;
      if (!chanId) {
        await msg.reply("Kein Kanal gespeichert. `announce_channel:#Kanal` mitgeben.");
        return;
      }
      if (note && note !== announced.announce_note) {
        db.setSeasonAnnounce(announced.id, { channelId: chanId, note });
      }
      const channel = await ctx.client.channels.fetch(chanId).catch(() => null);
      if (!channel?.send) {
        await msg.reply("Kanal nicht erreichbar.");
        return;
      }
      const running = db.getActiveSeason();
      await channel.send({
        embeds: [
          buildSeasonEmbed({
            year: announced.year,
            startDate: announced.start_date,
            channelName: channel.name,
            note: announced.announce_note || note || null,
            runningYear: running?.year,
          }),
        ],
        allowedMentions: { parse: [] },
      });
      await logEvent(ctx.client, ctx.config, {
        kind: "season-repost",
        summary: `Embed für ${announced.year} erneut gepostet in Kanal ${chanId}`,
        userId: ctx.config.adminId,
      });
      await msg.reply("Embed erneut gepostet — nichts wurde angelegt oder gelöscht.");
      return;
    }

    if (!channelId) {
      await msg.reply(
        "Kanal fehlt. `announce_channel:#Kanal` (Slash) oder `!announce-season #Kanal` — oder `repost:true`."
      );
      return;
    }

    // Backup der ganzen DB vor dem Anlegen (enthält laufende + kommende Zeile)
    let pkg = null;
    try {
      pkg = createPackage(ctx.config, { reason: "announce-season" });
    } catch (e) {
      await logError(ctx.client, ctx.config, e, { where: "announce-season backup", userId: ctx.config.adminId });
      await msg.reply(`Backup fehlgeschlagen: ${e.message}`);
      return;
    }

    let season;
    try {
      season = db.openAnnouncedSeason({ year, startDate, channelId, note }).season;
    } catch (e) {
      await msg.reply(`Saisoneröffnung fehlgeschlagen: ${e.message} (Backup bleibt: \`${pkg.name}\`)`);
      return;
    }

    const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
    const running = db.getActiveSeason();
    if (channel?.send) {
      await channel
        .send({
          embeds: [
            buildSeasonEmbed({
              year: season.year,
              startDate: season.start_date,
              channelName: channel.name,
              note: season.announce_note,
              runningYear: running?.year,
            }),
          ],
          allowedMentions: { parse: [] },
        })
        .catch(async (e) => {
          await logError(ctx.client, ctx.config, e, { where: "announce-season send" });
          await msg.reply(`Embed-Posten fehlgeschlagen: ${e.message} — Saison ist angelegt, \`repost:true\` nutzen.`);
        });
    }

    await logEvent(ctx.client, ctx.config, {
      kind: "season-announce",
      summary: `Saison ${season.year} angekündigt (Start ${season.start_date}, Kanal ${channelId})`,
      userId: ctx.config.adminId,
      detail: `season_id=${season.id} backup=${pkg?.name || "-"}`,
    });
    await msg.reply(
      [
        `🆕 **Saison ${season.year} angekündigt** (id ${season.id})`,
        `• Start: **${season.start_date}** · live: **nein**`,
        `• Kanal: <#${channelId}>`,
        "• 2026 läuft unverändert weiter (Punkte/Kills).",
        "",
        `Anleitung zum Tippen steht im Embed. ${announced ? "Repost: `/announce-season repost:true`" : ""}`,
      ].join("\n")
    );
  },
};

module.exports = cmd;
module.exports.buildSeasonEmbed = buildSeasonEmbed;
