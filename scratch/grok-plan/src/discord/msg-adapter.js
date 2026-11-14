/**
 * Normalize Message and ChatInputCommandInteraction into one shape for command.run().
 */
function fromMessage(msg) {
  return msg;
}

function fromInteraction(interaction) {
  let firstEditDone = false;

  const api = {
    author: interaction.user,
    guild: interaction.guild,
    channel: interaction.channel,
    content: "",
    _interaction: interaction,
    attachments: {
      first() {
        try {
          return interaction.options.getAttachment("file") || null;
        } catch {
          return null;
        }
      },
    },
    mentions: {
      users: {
        first() {
          try {
            return (
              interaction.options.getUser("user") ||
              interaction.options.getUser("spieler") ||
              null
            );
          } catch {
            return null;
          }
        },
      },
      members: {
        first() {
          try {
            return interaction.options.getMember("user") || null;
          } catch {
            return null;
          }
        },
      },
    },
    async reply(payload) {
      const data = typeof payload === "string" ? { content: payload } : { ...payload };
      if (!interaction.deferred && !interaction.replied) {
        return interaction.reply(data);
      }
      if (interaction.deferred && !firstEditDone) {
        firstEditDone = true;
        return interaction.editReply(data);
      }
      return interaction.followUp(data);
    },
  };

  return api;
}

module.exports = { fromMessage, fromInteraction };
