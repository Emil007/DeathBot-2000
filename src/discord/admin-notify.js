const { ChannelType } = require("discord.js");

const TEXT_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.DM,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
  ChannelType.GuildAnnouncement,
]);

function mentionOpts() {
  try {
    return require("./safe-text").mentionOpts();
  } catch {
    return { allowedMentions: { parse: [] } };
  }
}

function withMentions(payload) {
  const opts = mentionOpts();
  if (typeof payload === "string") return { content: payload, ...opts };
  if (!payload || typeof payload !== "object") return { content: String(payload ?? ""), ...opts };
  if (payload.allowedMentions) return payload;
  return { ...payload, ...opts };
}

function isTextChannel(ch) {
  if (!ch || typeof ch.send !== "function") return false;
  if (typeof ch.isTextBased === "function") {
    try {
      return ch.isTextBased() !== false;
    } catch {
      return false;
    }
  }
  if (ch.type == null) return true;
  return TEXT_TYPES.has(ch.type);
}

async function fetchAdminUser(ctx) {
  const adminId = ctx?.config?.adminId;
  if (!adminId || typeof ctx?.client?.users?.fetch !== "function") return null;
  try {
    const user = await ctx.client.users.fetch(adminId);
    return user || null;
  } catch (e) {
    console.warn("[admin-notify] admin user fetch failed:", e.message);
    return null;
  }
}

/**
 * CHANNEL_ADMIN, sonst DM an preferDmUser, sonst fallbackChannel.
 * Fetch-Fehler liefert nicht null, solange der DM-User da ist.
 */
async function resolveAdminTarget(ctx, { preferDmUser = null, fallbackChannel = null } = {}) {
  const id = ctx?.config?.channelAdmin;
  if (id && typeof ctx?.client?.channels?.fetch === "function") {
    try {
      const ch = await ctx.client.channels.fetch(id);
      if (isTextChannel(ch)) return ch;
    } catch (e) {
      console.warn("[admin-notify] CHANNEL_ADMIN fetch failed:", e.message);
    }
  }
  const dmUser = preferDmUser || (await fetchAdminUser(ctx));
  if (dmUser?.createDM) {
    try {
      const dm = await dmUser.createDM();
      if (dm) return dm;
    } catch {
      /* fall through */
    }
  }
  return fallbackChannel || null;
}

/**
 * Erst der Admin-Kanal. Wirft send oder ist der Kanal kein Textkanal:
 * genau ein DM-Versuch. Nie beide Ziele beliefern, kein zweiter Kanalversuch.
 * Der Admin-User wird aufgelöst, sobald config.adminId gesetzt ist —
 * auch bei gesetztem CHANNEL_ADMIN.
 */
async function sendAdmin(ctx, payload, opts = {}) {
  const preferDmUser = opts.preferDmUser || (await fetchAdminUser(ctx));
  const body = withMentions(payload);
  const id = ctx?.config?.channelAdmin;

  if (id && typeof ctx?.client?.channels?.fetch === "function") {
    let ch = null;
    try {
      ch = await ctx.client.channels.fetch(id);
    } catch (e) {
      console.warn("[admin-notify] CHANNEL_ADMIN fetch failed:", e.message);
      ch = null;
    }
    if (isTextChannel(ch)) {
      try {
        return await ch.send(body);
      } catch (e) {
        console.warn("[admin-notify] CHANNEL_ADMIN send failed:", e.message);
      }
    }
  }

  if (preferDmUser?.createDM) {
    try {
      const dm = await preferDmUser.createDM();
      if (dm?.send) return await dm.send(body);
    } catch (e) {
      console.warn("[admin-notify] admin DM failed:", e.message);
    }
  }

  if (opts.fallbackChannel?.send) {
    try {
      return await opts.fallbackChannel.send(body);
    } catch (e) {
      console.warn("[admin-notify] fallback send failed:", e.message);
    }
  }
  return null;
}

module.exports = { resolveAdminTarget, sendAdmin };
