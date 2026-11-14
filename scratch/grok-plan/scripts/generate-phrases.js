const fs = require("fs");
const path = require("path");

/**
 * Optional helper to expand phrase templates.
 * Shipped corpus is src/phrases/builtin-phrases.json (curated).
 * Run: node scripts/generate-phrases.js  (does not overwrite by default)
 */
const curatedPath = path.join(__dirname, "..", "src", "phrases", "builtin-phrases.json");
const data = JSON.parse(fs.readFileSync(curatedPath, "utf8"));
console.log(`builtin-phrases.json has ${data.length} lines`);
console.log("This script does not regenerate the corpus. Edit builtin-phrases.json directly.");
