module.exports = {
  name: "help",
  aliases: ["commands", "hilfe"],
  description: "Befehlsliste",
  async run(ctx, args, msg) {
    const isAdmin = msg.author.id === ctx.config.adminId;
    const lines = [];
    for (const cmd of ctx.commands.values()) {
      if (cmd.admin && !isAdmin) continue;
      if (cmd._aliasOf) continue;
      lines.push(
        `\`${ctx.config.prefix}${cmd.name}\`${cmd.admin ? " (admin)" : ""} — ${cmd.description || ""}`
      );
    }
    await msg.reply(lines.join("\n").slice(0, 1900));
  },
};
