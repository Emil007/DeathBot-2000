const { ChannelType } = require("discord.js");

/**
 * Optional CHANNEL_ADMIN for review cards + long admin summaries.
 * Falls back to DM with preferDmUser, then fallbackChannel.
 */
async function resolveAdminTarget(ctx, { preferDmUser = null, fallbackChannel = null } = {}) {
  const id = ctx.config.channelAdmin;
  if (id) {
    try {
      const ch = await ctx.client.channels.fetch(id);
      if (ch && (ch.isTextBased?.() || ch.type === ChannelType.GuildText || ch.send)) {
        return ch;
      }
    } catch (e) {
      console.warn("[admin-notify] CHANNEL_ADMIN fetch failed:", e.message);
    }
  }
  if (preferDmUser) {
    try {
      return await preferDmUser.createDM();
    } catch {
      /* fall through */
    }
  }
  return fallbackChannel;
}

async function sendAdmin(ctx, payload, opts = {}) {
  const target = await resolveAdminTarget(ctx, opts);
  if (!target?.send) return null;
  return target.send(typeof payload === "string" ? { content: payload } : payload);
}

module.exports = { resolveAdminTarget, sendAdmin };
