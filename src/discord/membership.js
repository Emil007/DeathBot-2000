const db = require("../db");

/**
 * Darf der User an der announced-Saison teilnehmen?
 *
 * - keine announced-Saison und aktive Saison live → closed
 * - keine announced-Saison und aktive Saison nicht live → not-open
 * - announced-Saison, Phase nicht announced → not-open
 * - Fetch 10003 → channel-missing
 * - 429, 5xx, Timeout, guild.available === false → unavailable
 * - kein Member / keine Sicht → not-member
 * - Admin (config.adminId) darf auch ohne ViewChannel, sobald die
 *   announced-Saison live=0 ist und einen Kanal hat.
 *
 * @returns {{ ok: boolean, reason?: "closed"|"not-open"|"channel-missing"|"unavailable"|"not-member", season?: object }}
 */
async function canParticipate(client, config, userId) {
  const announced = db.getAnnouncedSeason();
  if (!announced) {
    const active = safeActiveSeason();
    if (active && Number(active.live) === 1) {
      return { ok: false, reason: "closed", season: active };
    }
    return { ok: false, reason: "not-open", season: active || undefined };
  }
  if (announced.phase !== "announced") {
    return { ok: false, reason: "not-open", season: announced };
  }
  if (Number(announced.live) !== 0) {
    return { ok: false, reason: "closed", season: announced };
  }
  if (!announced.announce_channel_id) {
    return { ok: false, reason: "closed", season: announced };
  }

  let channel;
  try {
    channel = await client.channels.fetch(announced.announce_channel_id);
  } catch (e) {
    const reason = isUnknownChannel(e) ? "channel-missing" : "unavailable";
    return { ok: false, reason, season: announced };
  }
  if (!channel?.guild) {
    return { ok: false, reason: "channel-missing", season: announced };
  }
  if (channel.guild.available === false) {
    return { ok: false, reason: "unavailable", season: announced };
  }

  const isAdmin = String(userId) === String(config.adminId);
  let member = null;
  try {
    member = await channel.guild.members.fetch(userId);
  } catch (e) {
    if (isUnknownMember(e)) {
      if (isAdmin) return { ok: true, season: announced };
      return { ok: false, reason: "not-member", season: announced };
    }
    return { ok: false, reason: "unavailable", season: announced };
  }

  if (!member) {
    if (isAdmin) return { ok: true, season: announced };
    return { ok: false, reason: "not-member", season: announced };
  }
  const perms = channel.permissionsFor(member);
  if (isAdmin || perms?.has?.("ViewChannel")) {
    return { ok: true, season: announced };
  }
  return { ok: false, reason: "not-member", season: announced };
}

function safeActiveSeason() {
  try {
    return db.getActiveSeason();
  } catch {
    return null;
  }
}

function isUnknownChannel(e) {
  const code = e?.code ?? e?.rawError?.code;
  return code === 10003 || /unknown channel/i.test(String(e?.message || ""));
}

function isUnknownMember(e) {
  const code = e?.code ?? e?.rawError?.code;
  return code === 10007 || /unknown member/i.test(String(e?.message || ""));
}

/** Satz zu einem canParticipate-Grund. Dieselben Sätze in DM und /picks. */
function participationSentence(part) {
  const jahr = part?.season?.year ?? part?.year ?? "?";
  switch (part?.reason) {
    case "closed":
      return `Die Tippzeit für ${jahr} ist vorbei, deine Liste ist zu.`;
    case "not-open":
      return "Die Anmeldung ist noch nicht offen. Sobald sie aufgeht, schreibst du die Namen hierher.";
    case "channel-missing":
      return "Den Anmeldekanal gibt es nicht mehr. Sag einem Admin Bescheid, ich habe nichts gespeichert.";
    case "unavailable":
      return "Discord ist gerade nicht erreichbar. Ich habe die Zeile behalten und versuche sie beim nächsten Mal.";
    case "not-member":
      return "Keine Sicht auf den Anmeldekanal, keine Tipps. Eine DM ersetzt die Sicht nicht.";
    default:
      return "Die Anmeldung ist noch nicht offen. Sobald sie aufgeht, schreibst du die Namen hierher.";
  }
}

module.exports = { canParticipate, participationSentence };
