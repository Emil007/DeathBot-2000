const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelType,
} = require("discord.js");
const db = require("../db");
const { logError } = require("../discord/log");
const { createNextSeasonChannel } = require("./year-rollover");

/**
 * Interaktives Deathpool-Kanal-Setup.
 *
 * Ersetzt die CHANNEL_DEATHPOOL-Konfiguration: Beim Start wird geprüft, ob die
 * aktive Saison bereits einen verknüpften Deathpool-Kanal hat. Falls ja, ist
 * nichts zu tun. Falls nein, wird auf der Guild nach einem Kanal namens
 * `deathpool-{Jahr}` gesucht:
 *
 *  - gefunden  → blockierende Admin-Frage (Buttons + Dropdown), ewig wartend.
 *  - nicht da  → direkt `deathpool-{Jahr}` anlegen (wie createNextSeasonChannel)
 *                und mit der aktiven Saison verknüpfen.
 *
 * WICHTIG: Der Setup läuft asynchron im Hintergrund und blockiert den Rest der
 * Start-Routine NICHT. Nur der Deathpool-Start-Nachhol (runYearRollover) wartet:
 * onDecided feuert GENAU EINMAL, sobald ein Zielkanal sicher ist (oder sofort
 * synchron, wenn die aktive Saison bereits einen Kanal hat).
 *
 * Die Setup-Läufe, deren Admin-Entscheid noch offen ist, werden in einem
 * Modul-Set registriert. Solange ein Lauf offen ist, werden eingehende
 * `dp:setup:*`-Interaktionen von handleChannelSetupInteraction() verarbeitet.
 */

// Season-Id -> laufender Setup-Zustand (noch nicht entschieden).
const openSetups = new Map();

function isChannelSetupCustomId(customId) {
  return (
    typeof customId === "string" &&
    (customId === "dp:setup:new" ||
      customId === "dp:setup:pick" ||
      customId.startsWith("dp:setup:use:") ||
      customId.startsWith("dp:setup:pick:"))
  );
}

function isOpen(seasonId) {
  return openSetups.has(String(seasonId));
}

/**
 * Die Guild des Bots ermitteln: zuerst explizite DISCORD_GUILD_ID, sonst die
 * erste Guild, die der Client sehen kann (Guilds-Intent gesetzt). null, wenn
 * keine Guild gefunden wird.
 */
async function resolveGuild(client, config) {
  if (config.discordGuildId) {
    const g = await client.guilds.fetch(config.discordGuildId).catch(() => null);
    if (g) return g;
  }
  try {
    const list = await client.guilds.fetch();
    let g = null;
    if (list?.first) g = list.first();
    else if (Array.isArray(list)) g = list[0];
    else if (list?.id) g = list; // Fake/robust: einzelne Guild-Instanz
    if (g) {
      // .fetch() über die Liste kann magere Objekte liefern — nachladen.
      if (g.channels?.cache) return g;
      const full = await client.guilds.fetch(g.id).catch(() => null);
      if (full) return full;
    }
  } catch {
    /* keine Guild erreichbar */
  }
  return null;
}

/** Alle GuildText-Kanäle der Guild (type 0), sortiert nach Namen. */
function listGuildTextChannels(guild) {
  const out = [];
  const cache = guild?.channels?.cache;
  if (cache?.values) {
    for (const c of cache.values()) {
      if (c?.type === ChannelType.GuildText) out.push(c);
    }
  } else if (Array.isArray(guild?.channels)) {
    for (const c of guild.channels) {
      if (c?.type === ChannelType.GuildText) out.push(c);
    }
  }
  out.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return out;
}

/**
 * Baut die blockierende Admin-Frage: Button „Diesen nehmen" (customId
 * `dp:setup:use:<channelId>`) + Button „Neuen Kanal anlegen" sowie ein
 * Dropdown mit allen GuildText-Kanälen der Guild (customId `dp:setup:pick`).
 */
function buildSetupComponents(guild, year, found) {
  const textChannels = listGuildTextChannels(guild);
  const buttonsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(found ? `dp:setup:use:${found.id}` : "dp:setup:new")
      .setLabel("Diesen nehmen")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("dp:setup:new")
      .setLabel("Neuen Kanal anlegen")
      .setStyle(ButtonStyle.Success)
  );
  const rows = [buttonsRow];
  if (textChannels.length) {
    const options = textChannels.slice(0, 25).map((c) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`#${String(c.name).slice(0, 100)}`)
        .setValue(String(c.id)) // Value = Kanal-ID (Spec)
    );
    const menu = new StringSelectMenuBuilder()
      .setCustomId("dp:setup:pick")
      .setPlaceholder(`Anderen Kanal wählen (${textChannels.length})`)
      .addOptions(options);
    rows.push(new ActionRowBuilder().addComponents(menu));
  }
  return rows;
}

/** Sende-Ziel der Setup-Frage: CHANNEL_ADMIN-Kanal, sonst DM an den Admin. */
async function resolveSetupTarget(client, config) {
  if (config.channelAdmin) {
    const ch = await client.channels.fetch(config.channelAdmin).catch(() => null);
    if (ch?.isTextBased?.() || ch?.send) return { channel: ch, dm: false };
  }
  if (config.adminId) {
    const user = await client.users.fetch(config.adminId).catch(() => null);
    if (user?.createDM) {
      const dm = await user.createDM().catch(() => null);
      if (dm?.send) return { channel: dm, dm: true };
    }
  }
  return null;
}

/** Verknüpft einen Kanal mit der aktiven Saison (best effort, loggt Fehler). */
async function linkChannel(client, config, seasonId, channelId, label) {
  try {
    db.setSeasonDeathpoolChannel(String(seasonId), String(channelId));
    console.log(`[channel-setup] Deathpool-Kanal ${label} (${channelId}) mit Saison verknüpft`);
  } catch (e) {
    console.error("[channel-setup] setSeasonDeathpoolChannel failed:", e.message);
    await logError(client, config, e, {
      where: "channel-setup link",
      detail: `season=${seasonId} channel=${channelId}`,
    });
  }
}

/** Feuert onDecided genau einmal — kapselt den Deathpool-Start-Nachhol. */
async function callDecided(client, config, onDecided, where) {
  if (typeof onDecided !== "function") return;
  try {
    await onDecided();
  } catch (e) {
    console.error(`[channel-setup] onDecided (${where}) failed:`, e.message);
    await logError(client, config, e, { where: `channel-setup onDecided ${where}` });
  }
}

/**
 * Führt den interaktiven Kanal-Setup aus. Antwortet SOFORT (löst onDecided),
 * wenn die aktive Saison bereits einen Deathpool-Kanal hat. Sonst: Kanal
 * `deathpool-{Jahr}` auf der Guild suchen — gefunden → blockierende Admin-Frage,
 * nicht gefunden → direkt anlegen+verknüpfen. In JEDEM Fall feuert onDecided
 * genau einmal (synchron im Fall 1, nach dem Anlegen bzw. nach der
 * Admin-Entscheidung).
 */
async function runDeathpoolChannelSetup(client, config, { onDecided } = {}) {
  const running = db.getActiveSeason();
  const seasonId = String(running.id);
  const year = running.year;

  // Fall 1: Saison hat bereits einen verknüpften Kanal → nichts tun, sofort fertig.
  if (running.deathpool_channel_id) {
    await callDecided(client, config, onDecided, "linked");
    return { mode: "linked", channelId: running.deathpool_channel_id };
  }

  let guild = null;
  try {
    guild = await resolveGuild(client, config);
  } catch (e) {
    await logError(client, config, e, { where: "channel-setup resolveGuild" });
  }
  if (!guild) {
    console.warn("[channel-setup] keine Guild gefunden — Deathpool-Kanal-Setup übersprungen");
    // Kein rausgeschobener Start-Nachhol möglich (kein Ziel). onDecided wird
    // trotzdem einmal aufgerufen, damit runYearRollover sauber „ohne Ziel"
    // durchlaufen kann (postReview loggt no-target false).
    await callDecided(client, config, onDecided, "no-guild");
    return { mode: "no-guild", channelId: null };
  }

  const needle = `deathpool-${year}`;

  // Kanal auf der Guild suchen (nur GuildText, Groß-/Kleinschreibung egal).
  let found = null;
  for (const c of listGuildTextChannels(guild)) {
    if (String(c.name).toLowerCase() === needle.toLowerCase()) {
      found = c;
      break;
    }
  }

  if (!found) {
    // Fall: Kein Kanal gefunden → direkt anlegen (wie createNextSeasonChannel)
    // und verknüpfen. Dann onDecided.
    console.log(`[channel-setup] kein #${needle} gefunden — lege Kanal an`);
    let channel = null;
    try {
      channel = await createNextSeasonChannel(client, config, year);
    } catch (e) {
      await logError(client, config, e, {
        where: "channel-setup createNextSeasonChannel",
        detail: `year=${year}`,
      });
    }
    if (channel?.id) {
      await linkChannel(client, config, seasonId, channel.id, `#${channel.name}`);
    } else {
      // Anlage fehlgeschlagen (z.B. fehlende Rechte) — kein sicherer Kanal.
      // Trotzdem einmal onDecided, damit der Start-Nachhol ohne Ziel läuft.
      console.warn("[channel-setup] Kanal-Anlage fehlgeschlagen — kein sicherer Deathpool-Kanal");
    }
    await callDecided(client, config, onDecided, "created");
    return { mode: "created", channelId: channel?.id || null };
  }

  // Fall: Kanal gefunden, keine Verknüpfung → blockierende Admin-Frage.
  console.log(`[channel-setup] #${needle} gefunden — Admin-Frage, bis eine Entscheidung fällt`);
  const target = await resolveSetupTarget(client, config);
  if (!target) {
    console.warn("[channel-setup] kein Admin-Ziel (kein CHANNEL_ADMIN, Admin-DM fehlgeschlagen) — nutze gefundenen Kanal");
    await linkChannel(client, config, seasonId, found.id, `#${needle}`);
    await callDecided(client, config, onDecided, "no-target-fallback");
    return { mode: "found-fallback", channelId: found.id };
  }

  const text =
    `Hey, da läuft schon eine Season (${year}) und ich hab den Kanal #${needle} gefunden — ` +
    "soll ich den nehmen, einen anderen, oder einen neuen machen?";
  let sent = null;
  try {
    sent = await target.channel.send({
      content: text,
      components: buildSetupComponents(guild, year, found),
    });
  } catch (e) {
    await logError(client, config, e, { where: "channel-setup send question" });
  }
  if (!sent) {
    // Frage konnte nicht gesendet werden → nicht ewig blockieren: Fallback
    // auf den gefundenen Kanal, dann onDecided.
    console.warn("[channel-setup] Admin-Frage nicht gesendet — nutze gefundenen Kanal als Fallback");
    await linkChannel(client, config, seasonId, found.id, `#${needle}`);
    await callDecided(client, config, onDecided, "no-send-fallback");
    return { mode: "found-fallback", channelId: found.id };
  }

  // Setup-Lauf registrieren: ewig warten, bis der Admin entscheidet. Solange
  // offen, wird der Deathpool-Start-Nachhol NICHT gestartet (kein onDecided).
  openSetups.set(seasonId, { guild, year, found, message: sent, onDecided });
  return { mode: "waiting", channelId: null };
}

/**
 * Bearbeitet eine `dp:setup:*`-Interaktion (Buttons + Select) im
 * interactionCreate-Handler — VOR handlePickInteraction. Gibt true zurück,
 * wenn die customId zu diesem Setup gehört (dann ist sie verarbeitet), sonst false.
 */
async function handleChannelSetupInteraction(interaction, client, config) {
  if (typeof interaction.customId !== "string") return false;
  const customId = interaction.customId;
  if (!isChannelSetupCustomId(customId)) return false;

  const running = db.getActiveSeason();
  const seasonId = String(running.id);
  const year = running.year;
  const setup = openSetups.get(seasonId);

  if (!setup) {
    // Kein offener Lauf (z.B. nach Bot-Restart) — bestätigen und verwerfen.
    if (interaction.isRepliable?.()) {
      const content = "Kanal-Setup ist nicht mehr offen (vermutlich Neustart).";
      await interaction
        .update?.({ content, components: [] })
        .catch(async () => {
          await interaction.reply?.({ content, ephemeral: true }).catch(() => {});
        });
    }
    return true;
  }
  const { guild, found } = setup;

  // Die Antworten dürfen nur der Admin ausführen — die Nachricht liegt im
  // Admin-Kanal/DM, jeder Druck dort gilt (Gruppen-DM-Härtung: nur der
  // konfigurierte Admin darf entscheiden).
  if (interaction.user?.id && config.adminId && String(interaction.user.id) !== String(config.adminId)) {
    await interaction
      .reply?.({ content: "Nur der Admin kann das Kanal-Setup entscheiden.", ephemeral: true })
      .catch(() => {});
    return true;
  }

  let action = null; // { kind: 'use'|'new'|'pick', channelId? }
  if (customId === "dp:setup:new") {
    action = { kind: "new" };
  } else if (customId.startsWith("dp:setup:use:")) {
    action = { kind: "use", channelId: customId.slice("dp:setup:use:".length) };
  } else if (customId === "dp:setup:pick") {
    // StringSelectMenu: die customId ist die Menü-ID, die gewählte Option kommt
    // in values[0]. Spec: Value = Kanal-ID direkt (tolerant auch für
    // `dp:setup:pick:<channelId>`-Werte).
    const chosen = Array.isArray(interaction.values) ? interaction.values[0] : null;
    action = { kind: "pick", channelId: String(chosen || "").replace(/^dp:setup:pick:/, "") };
  } else if (customId.startsWith("dp:setup:pick:")) {
    // toleranter Fallback (falls jemand die Option customId direkt sendet)
    action = { kind: "pick", channelId: customId.slice("dp:setup:pick:".length) };
  }

  try {
    if (action.kind === "new") {
      // Neuen Kanal anlegen (inkl. Overwrites für alle Spieler) + verknüpfen.
      await interaction
        .update?.({ content: `Lege neues #deathpool-${year} an…`, components: [] })
        .catch(() => {});
      let channel = null;
      try {
        channel = await createNextSeasonChannel(client, config, year);
      } catch (e) {
        await logError(client, config, e, {
          where: "channel-setup new create",
          detail: `year=${year}`,
        });
      }
      if (channel?.id) {
        await linkChannel(client, config, seasonId, channel.id, `#${channel.name}`);
        await interaction
          .editReply?.({ content: `Lege neues #${channel.name} an…` })
          .catch(() => {});
        finishSetup(seasonId, client, config);
      } else {
        // Kein Kanal entstanden — Setup offen lassen (Admin kann nach Fehler
        // erneut klicken) oder auf „Diesen nehmen" zurückgreifen.
        await interaction
          .editReply?.({
            content: `Kanal-Anlage für deathpool-${year} fehlgeschlagen (Details in den Logs).`,
            components: [],
          })
          .catch(() => {});
        return true;
      }
    } else {
      const channelId = action.channelId;
      const chosen =
        channelId === found?.id
          ? found
          : listGuildTextChannels(guild).find((c) => String(c.id) === String(channelId));
      const label = chosen?.name ? `#${chosen.name}` : `Kanal ${channelId}`;
      await linkChannel(client, config, seasonId, channelId, label);
      await interaction
        .update?.({ content: `Nutze ${label}`, components: [] })
        .catch(() => {});
      finishSetup(seasonId, client, config);
    }
  } catch (e) {
    await logError(client, config, e, { where: "channel-setup interaction", customId });
  }
  return true;
}

/** Setup abschließen: open-Set entfernen und onDecided (genau einmal) feuern. */
function finishSetup(seasonId, client, config) {
  const entry = openSetups.get(String(seasonId));
  if (!entry) return;
  openSetups.delete(String(seasonId));
  callDecided(client, config, entry.onDecided, "decided");
}

module.exports = {
  runDeathpoolChannelSetup,
  handleChannelSetupInteraction,
  isOpen,
  _openSetups: openSetups,
};
