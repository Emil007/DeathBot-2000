const db = require("../db");

/**
 * Darf der User an der announced-Saison teilnehmen?
 *
 * Prüft gegen die ANNOUNCED-Saison (2027): Kanal vorhanden, `live = 0`,
 * User hat `ViewChannel` auf genau diesem Kanal. Die running-Saison (2026)
 * geht NICHT in diese Funktion ein — 2026 live lässt den Assistenten offen,
 * sobald 2027 announced ist und einen Kanal hat.
 *
 * Admin (config.adminId) darf auch ohne ViewChannel (Flow vor erstem echten
 * Teilnehmer prüfbar) — announced-Saison muss trotzdem live=0 und Kanal haben.
 *
 * @returns {{ ok: boolean, reason?: "closed"|"channel"|"not-member", season?: object }}
 */
async function canParticipate(client, config, userId) {
  const season = db.getAnnouncedSeason();
  if (!season || !season.announce_channel_id || season.phase !== "announced" || season.live !== 0) {
    return { ok: false, reason: "closed" };
  }

  const channel = await client.channels.fetch(season.announce_channel_id).catch(() => null);
  if (!channel?.guild) {
    return { ok: false, reason: "channel" };
  }

  try {
    const member = await channel.guild.members.fetch(userId);
    if (member) {
      const isAdmin = String(userId) === String(config.adminId);
      const perms = channel.permissionsFor(member);
      // Admin darf auch ohne ViewChannel durch (Test-/Prüfflow vor echtem
      // Teilnehmer). Sonst braucht es die Kanalsichtbarkeit (F12).
      if (isAdmin || perms?.has("ViewChannel")) {
        return { ok: true, season };
      }
      return { ok: false, reason: "not-member" };
    }
  } catch (e) {
    // 10007 = Unknown Member: echtes "kein Mitglied". Andere Fetch-Fehler
    // (429/Timeout/Recht) sind KEINE Ablehnung — sonst lehnt eine kurze
    // Discord-Störung jede Anmeldung ab (F27).
    if (e?.code === 10007 || e?.message?.includes("Unknown Member")) {
      if (String(userId) === String(config.adminId)) return { ok: true, season };
      return { ok: false, reason: "not-member" };
    }
    return { ok: false, reason: "unavailable" };
  }

  // Admin-Fallback für sonstige Edge-Fälle (fetch lieferte keinen Member)
  if (String(userId) === String(config.adminId)) return { ok: true, season };
  return { ok: false, reason: "not-member" };
}

module.exports = { canParticipate };
