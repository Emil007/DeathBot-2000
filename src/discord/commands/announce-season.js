const {
  EmbedBuilder,
} = require("discord.js");
const { createPackage } = require("../../backup");
const db = require("../../db");
const { logEvent, logError } = require("../log");

/**
 * Standard-Ankündigungstext (Gregg, Variante B, ohne ersten Satz). Nur Platz-
 * halter — Jahreszahlen/Daten kommen zur Laufzeit aus der DB/Config, damit der
 * Text jedes Jahr wieder verwendbar ist.
 */
const DEFAULT_ANNOUNCE_TITLE = "Ich weiß, wer stirbt. Du tippst.";

const DEFAULT_ANNOUNCE_TEMPLATE = `Ich bin Gregg, der Tod in Text, und der Buchhalter, bei dem dein Ende schon steht. Wer stirbt, weiß ich. Du tippst nur und nennst das Mut. Es ist erbärmlich. Deine Liste ändert an meinem Ergebnis nichts.

Deathpool **{YEAR}** ist offen. Ich will deine Namen. Du wettest, welche Prominenten ich abhole. Liegt du richtig, gibt es Punkte, und die Gruppe sieht deinen Namen neben der Leiche. Das ist der Ruhm hier und das aufregendste Spiel in diesem Haufen. Ein Jahr Spannung, von mir verkauft, von dir bezahlt. Den Ausgang habe ich. Du kaufst das Zittern.

Sitzt du bei den Alten im Deathpool, kenne ich deine Liste. Dieselben Feiglinge, Instinkt nennst du das. Bist du neu, lies bis unten. Trost gibt es nicht. **{RUNNING_YEAR}** läuft weiter, getrennt. Nichts wird auf **{YEAR}** umgebucht.

**Anleitung. Einmal. Kein zweites Wort.**

**Sicht.** Diesen Kanal sehen heißt, du darfst mitmachen. Den Deathpool-Kanal musst du sehen, dort lege ich die Treffer hin. Siehst du ihn nicht, bist du raus. Keine Hintertür. Eine Direktnachricht ersetzt die Sicht nicht.

**Namen.** Per Direktnachricht an mich, Gregg. In diesen Kanal sind sie Müll.

**Format.** Ein Name pro Zeile, oder mehrere mit \`;\` getrennt. Ein Komma trennt nicht: \`Meier, Müller\` ist eine Person, die es nicht gibt. Ein Bindestrich schneidet nur mit Leerzeichen links und rechts. \`Jean-Luc\` bleibt ein Name. Doppelte zählen einmal, ich sage dir welche. Maximal **{MAX_PICKS}** Namen, über alle Direktnachrichten, nicht pro Nachricht. Den Rest schneide ich ab und melde ihn. Die Antwort zeigt, was bleibt.

**Wikipedia.** Ich ordne jeden Namen zu. Namensvetter: ich frage, du wählst aus den Treffern. Ohne Wahl bleibt der Eintrag offen, \`fertig\` friert ihn nicht ein.

**Schloss.** Du siehst die Liste als Antwort. \`fertig\` oder \`done\` friert sie ein. Bis **{START_DATE}** darfst du kneifen. Wie immer. \`unlock\`, dann \`entfernen 3\`, \`ändern 3 Neuer Name\`, oder neue Namen, danach wieder \`fertig\`, sonst bleibt sie offen. Die Zahl ist die Stelle. Der Admin bestätigt, \`/review\`, im Hintergrund. Am **{START_DATE}** schalte ich live. Dann zu.

**Vor dem Start.** Stirbt jemand vor **{START_DATE}** auf deiner Liste, schreibe ich dir. Tauschen geht. Punkte gibt es dafür nicht.

**Tarif.** Alter am **{START_DATE}**: \`max(1, 100 - Alter)\`. Jünger bringt mehr. Weniger als **1** gibt es nicht.`;

/**
 * Ersetzt die Template-Platzhalter des Announcement-Texts durch Werte aus der
 * Season-DB / Config. NUR diese vier — keine Jahreszahlen im Code.
 * {YEAR}, {RUNNING_YEAR}, {START_DATE}, {MAX_PICKS}
 */
function renderSeasonTemplate(template, { year, runningYear, startDate, maxPicks }) {
  const NP = Number.isFinite(Number(maxPicks)) ? Number(maxPicks) : 50;
  return String(template ?? "")
    .split("{YEAR}").join(String(year))
    .split("{RUNNING_YEAR}").join(String(runningYear ?? ""))
    .split("{START_DATE}").join(String(startDate))
    .split("{MAX_PICKS}").join(String(NP));
}

/**
 * Embed für die Teilnahme-Ankündigung der nächsten Runde.
 * Feste Sätze — der Tipp-Assistent (M4) erklärt exakt diese Schritte.
 * Exportiert für Tests.
 */
function buildSeasonEmbed({ year, startDate, channelName, note, runningYear, maxPicks, template, title }) {
  const NP = Number.isFinite(Number(maxPicks)) ? Number(maxPicks) : 50;
  const vars = { year, runningYear, startDate, maxPicks: NP };
  const useTemplate = template || DEFAULT_ANNOUNCE_TEMPLATE;
  const useTitle = title || DEFAULT_ANNOUNCE_TITLE;
  let description = renderSeasonTemplate(useTemplate, vars);
  if (note) description += `\n\n📝 **Notiz:** ${note}`;
  return new EmbedBuilder()
    .setColor(0x2a9d3f)
    .setTitle(useTitle ? renderSeasonTemplate(useTitle, vars) : `Nächste Runde: ${year}`)
    .setDescription(description)
    .setTimestamp(new Date());
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
      // F23: auch ein geänderter Kanal wird gespeichert — vorher blieb
      // announce_channel_id der alte, obwohl das Embed im neuen landete.
      const chanChanged = chanId !== announced.announce_channel_id;
      if (chanChanged || (note && note !== announced.announce_note)) {
        db.setSeasonAnnounce(announced.id, {
          channelId: chanId,
          note: note ?? announced.announce_note,
        });
      }
      const channel = await ctx.client.channels.fetch(chanId).catch(() => null);
      if (!channel?.send) {
        await msg.reply("Kanal nicht erreichbar.");
        return;
      }
      const running = db.getActiveSeason();
      // F26: fehlgeschlagenes Embed darf NICHT als Erfolg gemeldet werden
      try {
        const embed = buildSeasonEmbed({
          year: announced.year,
          startDate: announced.start_date,
          channelName: channel.name,
          note: announced.announce_note || note || null,
          runningYear: running?.year,
          maxPicks: ctx.config.maxPicksPerPlayer,
        });
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      } catch (e) {
        await logError(ctx.client, ctx.config, e, {
          where: "announce-season repost",
          userId: ctx.config.adminId,
        });
        await msg.reply(`Embed-Repost fehlgeschlagen: ${e.message}`);
        return;
      }
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
    let embedSent = false;
    if (channel?.send) {
      try {
        const embed = buildSeasonEmbed({
          year: season.year,
          startDate: season.start_date,
          channelName: channel.name,
          note: season.announce_note,
          runningYear: running?.year,
          maxPicks: ctx.config.maxPicksPerPlayer,
        });
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        embedSent = true;
      } catch (e) {
        await logError(ctx.client, ctx.config, e, { where: "announce-season send" });
      }
    }

    await logEvent(ctx.client, ctx.config, {
      kind: "season-announce",
      summary: `Saison ${season.year} angekündigt (Start ${season.start_date}, Kanal ${channelId})`,
      userId: ctx.config.adminId,
      detail: `season_id=${season.id} backup=${pkg?.name || "-"} embed_sent=${embedSent}`,
    });
    await msg.reply(
      [
        `🆕 **Saison ${season.year} angekündigt** (id ${season.id})`,
        `• Start: **${season.start_date}** · live: **nein**`,
        `• Kanal: <#${channelId}>`,
        embedSent
          ? `• ${running?.year ?? "Die laufende Runde"} läuft unverändert weiter (Punkte/Kills).`
          : "• ⚠️ Embed-Posten **fehlgeschlagen** — Saison ist trotzdem angelegt, `repost:true` nutzen.",
        "",
        `Anleitung zum Tippen steht im Embed. ${announced ? "Repost: `/announce-season repost:true`" : ""}`,
      ].join("\n")
    );
  },
};

module.exports = cmd;
module.exports.buildSeasonEmbed = buildSeasonEmbed;
module.exports.renderSeasonTemplate = renderSeasonTemplate;
module.exports.DEFAULT_ANNOUNCE_TEMPLATE = DEFAULT_ANNOUNCE_TEMPLATE;
module.exports.DEFAULT_ANNOUNCE_TITLE = DEFAULT_ANNOUNCE_TITLE;
