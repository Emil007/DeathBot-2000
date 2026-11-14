const fs = require("fs");
const path = require("path");

function loadCommands() {
  const dir = __dirname;
  const map = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".js") || file === "index.js") continue;
    const mod = require(path.join(dir, file));
    if (!mod?.name || typeof mod.run !== "function") continue;
    map.set(mod.name, mod);
    for (const alias of mod.aliases || []) {
      map.set(alias, { ...mod, name: alias, _aliasOf: mod.name });
    }
  }
  return map;
}

module.exports = { loadCommands };
