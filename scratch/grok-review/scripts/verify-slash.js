const { loadCommands } = require("../src/discord/commands");
const { buildSlashPayload } = require("../src/discord/slash");
const { uniqueCommands } = require("../src/discord/usage");

const cmds = loadCommands();
const body = buildSlashPayload(cmds);
const names = uniqueCommands(cmds)
  .map((c) => c.name)
  .sort();
console.log("commands", names.length, names.join(","));
console.log("slash", body.length);

const missing = [];
for (const c of uniqueCommands(cmds)) {
  if (!c.description) missing.push(`${c.name}:desc`);
  if (!c.usage) missing.push(`${c.name}:usage`);
  if (!c.group && c.name !== "help") missing.push(`${c.name}:group`);
  if (c.description && c.description.length > 100) missing.push(`${c.name}:desc>100`);
  if (typeof c.parseSlash !== "function" && (c.options?.length || c.subcommands?.length)) {
    missing.push(`${c.name}:parseSlash`);
  }
}
console.log("missing", missing.join("|") || "none");

// Validate slash JSON builds without throw (already did)
for (const j of body) {
  if (!j.name || !j.description) throw new Error(`bad slash ${JSON.stringify(j)}`);
  if (j.description.length > 100) throw new Error(`desc too long ${j.name}`);
}
console.log("slash-json-ok");

require("./verify-load");
