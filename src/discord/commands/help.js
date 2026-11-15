const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { uniqueCommands, suggestCommands } = require("../usage");

const GROUP_ORDER = [
  { id: "everyone", title: "Für alle" },
  { id: "season", title: "Admin · Saison & Listen" },
  { id: "match", title: "Admin · Matching & Celebs" },
  { id: "points", title: "Admin · Punkte" },
];

function groupOf(cmd) {
  if (cmd.group) return cmd.group;
  return cmd.admin ? "season" : "everyone";
}

function buildOverviewPages(ctx, isAdmin, isDm) {
  const p = ctx.config.prefix;
  const inDm = Boolean(isDm);
  const all = uniqueCommands(ctx.commands);
  const sections = [];

  for (const g of GROUP_ORDER) {
    if (g.id !== "everyone" && !isAdmin) continue;
    const cmds = all
      .filter((c) => groupOf(c) === g.id)
      .filter((c) => !c.admin || isAdmin)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!cmds.length) continue;
    const lines = [`**${g.title}**`];
    for (const c of cmds) {
      // In der DM gibt es keine Slash-Commands — nur den Prefix-Weg nennen.
      lines.push(
        inDm ? `\`${p}${c.name}\` — ${c.description || ""}` : `\`/${c.name}\` · \`${p}${c.name}\` — ${c.description || ""}`
      );
    }
    sections.push(lines.join("\n"));
  }

  // Any admin command without a known group
  if (isAdmin) {
    const known = new Set(GROUP_ORDER.map((g) => g.id));
    const orphans = all
      .filter((c) => c.admin && !known.has(groupOf(c)))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (orphans.length) {
      const lines = ["**Admin · Sonstiges**"];
      for (const c of orphans) {
        lines.push(
          inDm ? `\`${p}${c.name}\` — ${c.description || ""}` : `\`/${c.name}\` · \`${p}${c.name}\` — ${c.description || ""}`
        );
      }
      sections.push(lines.join("\n"));
    }
  }

  const header = inDm
    ? [
        "**DeathBot Hilfe** — Tipp deine Namen einfach so hin, ein pro Zeile. Für Befehle: `" +
          ctx.config.prefix +
          "hilfe`.",
        `Detail: \`${p}help <befehl>\`.`,
        "",
      ].join("\n")
    : isAdmin
    ? [
        "**DeathBot Hilfe** — Befehle als `/` (Slash, aus der Vorschlagsliste) oder mit dem Präfix `" +
          ctx.config.prefix +
          "` in der DM.",
        `Detail: \`/help command:import\` oder \`${p}help import\`.`,
        `Noch nicht live: \`/import\` → \`/review\` → \`/go\`. Nächstes Jahr: \`/announce-season\`, am Start \`/new-year activate:true\`.`,
        "",
      ].join("\n")
    : [
        "**DeathBot Hilfe** — Tipp deine Namen einfach so hin, ein pro Zeile. Für Befehle: `" +
          ctx.config.prefix +
          "hilfe` oder wähl in der Guild-Slash-Liste `/help`.",
        `Detail: \`${p}help <befehl>\` oder in der Guild-Slash-Liste \`/help command:<name>\`.`,
        "",
      ].join("\n");

  const pages = [];
  let current = header;
  for (const section of sections) {
    if ((current + "\n\n" + section).length > 1800) {
      pages.push(current.trim());
      current = section;
    } else {
      current = current ? `${current}\n\n${section}` : section;
    }
  }
  if (current.trim()) pages.push(current.trim());
  if (!pages.length) pages.push("Keine Befehle.");
  return pages;
}

function detailCard(cmd, config, isDm) {
  const p = config.prefix;
  const slash = !isDm;
  const invoke = slash ? "/" + cmd.name : p + cmd.name;
  const lines = [
    `**${invoke}**${cmd.admin ? " _(Admin)_" : ""}`,
    cmd.description || "",
    "",
    "**Aufruf**",
    slash
      ? (cmd.usage || `\`/${cmd.name}\`\n\`${p}${cmd.name}\``).replaceAll("{prefix}", p)
      : `\`${p}${cmd.name}\``,
  ];
  if (cmd.examples?.length) {
    lines.push("", "**Beispiele**");
    for (const ex of cmd.examples.slice(0, 3)) {
      lines.push(`• \`${ex.replaceAll("{prefix}", p)}\``);
    }
  }
  if (cmd.aliases?.length) {
    lines.push("", `**Aliases (Prefix):** ${cmd.aliases.map((a) => `\`${p}${a}\``).join(", ")}`);
  }
  if (cmd.details) {
    lines.push("", "**Hinweis**", cmd.details.replaceAll("{prefix}", p));
  }
  return lines.join("\n").slice(0, 1900);
}

function findCommand(commands, name) {
  if (!name) return null;
  const key = String(name).toLowerCase().replace(/^\//, "");
  const hit = commands.get(key);
  if (!hit) return null;
  if (hit._aliasOf) return commands.get(hit._aliasOf) || hit;
  return hit;
}

function pageRow(page, total) {
  if (total <= 1) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`help:page:${page - 1}`)
        .setLabel("Zurück")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId("help:noop")
        .setLabel(`${page + 1}/${total}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`help:page:${page + 1}`)
        .setLabel("Weiter")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= total - 1)
    ),
  ];
}

function isDmContext(msg) {
  // DM: keine Guild (msg.guildId fehlt/null). Auch bei einer Interaction ist
  // msg.guild null, wenn kein Serverkontext (z.B. help:-Buttons haben aber immer Guild).
  return msg?.guildId == null && !(msg?.guild);
}

async function sendOverview(ctx, msg, isAdmin, page = 0) {
  const pages = buildOverviewPages(ctx, isAdmin, isDmContext(msg));
  const i = Math.max(0, Math.min(page, pages.length - 1));
  await msg.reply({
    content: pages[i],
    components: pageRow(i, pages.length),
    allowedMentions: { parse: [] },
  });
}

module.exports = {
  name: "help",
  aliases: ["commands", "hilfe"],
  admin: false,
  group: "everyone",
  description: "Hilfe zu einem Befehl, bevor du daneben tippst",
  usage: "/help [command:<name>]\n{prefix}help [befehl]",
  examples: ["/help", "/help command:import", "{prefix}help go"],
  options: [
    {
      name: "command",
      description: "Befehl, zu dem du Details willst",
      type: "STRING",
      required: false,
    },
  ],
  parseSlash(interaction) {
    const c = interaction.options.getString("command");
    return c ? [c] : [];
  },
  async run(ctx, args, msg) {
    const isAdmin = msg.author.id === ctx.config.adminId;
    const inDm = isDmContext(msg);
    const target = (args[0] || "").toLowerCase();

    if (target) {
      const cmd = findCommand(ctx.commands, target);
      if (!cmd || (cmd.admin && !isAdmin)) {
        const suggestions = suggestCommands(target, ctx.commands, { admin: isAdmin });
        const hint = suggestions.length
          ? `Meintest du: ${suggestions.map((s) => `\`${inDm ? ctx.config.prefix : "/"}${s}\``).join(", ")}?`
          : inDm
          ? `Schau unter \`${ctx.config.prefix}hilfe\`.`
          : "Schau unter `/help`.";
        await msg.reply({
          content: `Befehl \`${target}\` gibt es nicht. ${hint}`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      await msg.reply({
        content: detailCard(cmd, ctx.config, inDm),
        allowedMentions: { parse: [] },
      });
      return;
    }

    await sendOverview(ctx, msg, isAdmin, 0);
  },

  async handleButton(ctx, interaction) {
    if (!interaction.isButton()) return false;
    if (interaction.customId === "help:noop") {
      await interaction.deferUpdate();
      return true;
    }
    const m = /^help:page:(\d+)$/.exec(interaction.customId);
    if (!m) return false;
    const page = parseInt(m[1], 10);
    const admin = interaction.user.id === ctx.config.adminId;
    const pages = buildOverviewPages(ctx, admin, isDmContext({ guildId: interaction.guildId, guild: interaction.guild }));
    const i = Math.max(0, Math.min(page, pages.length - 1));
    await interaction.update({
      content: pages[i],
      components: pageRow(i, pages.length),
      allowedMentions: { parse: [] },
    });
    return true;
  },
};
