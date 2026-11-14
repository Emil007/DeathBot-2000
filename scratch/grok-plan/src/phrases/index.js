const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let builtin = null;
let customCache = { mtimeMs: 0, lines: [] };

function loadBuiltin() {
  if (builtin) return builtin;
  const p = path.join(__dirname, "builtin-phrases.json");
  builtin = JSON.parse(fs.readFileSync(p, "utf8"));
  return builtin;
}

function loadCustom(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const st = fs.statSync(filePath);
    if (st.mtimeMs === customCache.mtimeMs) return customCache.lines;
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    customCache = { mtimeMs: st.mtimeMs, lines };
    return lines;
  } catch (e) {
    console.warn("[phrases] custom file error:", e.message);
    return [];
  }
}

function resolveBank(config) {
  const built = loadBuiltin();
  const custom = loadCustom(config.customPhrasesPath);
  const mode = config.customPhrasesMode;

  if (mode === "no") return built;
  if (mode === "only") {
    if (!custom.length) {
      console.warn("[phrases] CUSTOM_PHRASES=only but custom file empty/missing — falling back to built-in");
      return built;
    }
    return custom;
  }
  // mix
  if (!custom.length) {
    console.warn("[phrases] CUSTOM_PHRASES=mix but custom file empty/missing — using built-in only");
    return built;
  }
  return [...built, ...custom];
}

function fill(template, vars) {
  return template
    .replace(/\{name\}/gi, vars.name || "?")
    .replace(/\{age\}/gi, vars.age != null ? String(vars.age) : "?")
    .replace(/\{score\}/gi, vars.score != null ? String(vars.score) : "?")
    .replace(/\{winners\}/gi, vars.winners || "niemand")
    .replace(/\{losers\}/gi, vars.losers || "niemand");
}

function hashPhrase(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function pickPhrase(config, dbApi, vars, { short = false } = {}) {
  let bank = resolveBank(config);
  if (short) {
    bank = bank.filter((p) => p.length <= 160);
    if (!bank.length) bank = resolveBank(config);
  }
  const recent = dbApi.recentPhraseHashes(100);
  const candidates = bank
    .map((t) => fill(t, vars))
    .map((text) => ({ text, hash: hashPhrase(text) }))
    .filter((c) => !recent.has(c.hash));

  const pool = candidates.length ? candidates : bank.map((t) => {
    const text = fill(t, vars);
    return { text, hash: hashPhrase(text) };
  });

  const chosen = pool[Math.floor(Math.random() * pool.length)];
  dbApi.recordPhraseUse(chosen.hash);
  return chosen.text;
}

module.exports = { pickPhrase, resolveBank, loadBuiltin, loadCustom };
