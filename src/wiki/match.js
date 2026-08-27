const db = require("../db");

const NAME_PARTICLES = new Set([
  "de", "da", "di", "du", "del", "della", "der", "den", "des", "la", "le", "el",
  "van", "von", "vom", "zu", "zum", "zur", "ten", "ter", "bin", "bint", "ibn",
  "al", "ul", "abu", "abd", "mc", "mac", "st", "saint", "san", "santa",
  "of", "the", "y", "e", "und", "and",
]);

function extractAge(text) {
  const match = String(text).match(/\b(\d{2,3})\b/);
  if (!match) return null;
  const age = parseInt(match[1], 10);
  if (age < 10 || age > 120) return null;
  return age;
}

function significantTokens(name) {
  return String(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !NAME_PARTICLES.has(t) && t.length > 1);
}

function titleFromWikiPath(wikiPath) {
  if (!wikiPath) return "";
  return decodeURIComponent(String(wikiPath).replace(/^\/wiki\//, "").replace(/_/g, " "));
}

function entryMatchesCeleb(entry, celeb, akas, blacklist) {
  const text = entry.text.toLowerCase();
  const nameLower = celeb.name.toLowerCase();

  if (blacklist?.length) {
    for (const term of blacklist) {
      const parts = term.toLowerCase().split(/\s+/).filter(Boolean);
      if (parts.length && parts.every((p) => text.includes(p))) return false;
    }
  }

  // Prefer wiki link title equality when available
  const linkTitle = titleFromWikiPath(entry.wikiPath).toLowerCase();
  if (linkTitle) {
    const celebKey = db.nameKey(celeb.name);
    const titleKey = db.nameKey(linkTitle);
    if (celebKey && titleKey && celebKey === titleKey) return true;
    if (akas?.length) {
      for (const a of akas) {
        if (db.nameKey(a) === titleKey) return true;
      }
    }
  }

  if (akas?.length) {
    if (akas.some((a) => text.includes(a.toLowerCase()))) return true;
    if (text.includes(nameLower)) return true;
    return false;
  }

  // Full name substring (strong)
  if (nameLower.length >= 5 && text.includes(nameLower)) return true;

  // Significant tokens (particles stripped) — all must appear
  const tokens = significantTokens(celeb.name);
  if (tokens.length === 0) return false;
  // Require at least 2 significant tokens for AND match, or 1 if that's all they have
  if (tokens.length === 1 && tokens[0].length < 4) return false;
  return tokens.every((t) => text.includes(t));
}

function findPoolMatches(entries) {
  const celebs = db.getAliveCelebsForAuto();
  const matches = [];

  for (const celeb of celebs) {
    const akas = db.getAkas(celeb.id);
    const blacklist = db.getBlacklist(celeb.id);
    for (const entry of entries) {
      if (entryMatchesCeleb(entry, celeb, akas, blacklist)) {
        matches.push({
          celeb,
          entry,
          age: extractAge(entry.text) ?? celeb.age_at_pick ?? null,
        });
        break;
      }
    }
  }
  return matches;
}

module.exports = {
  extractAge,
  entryMatchesCeleb,
  findPoolMatches,
  significantTokens,
  titleFromWikiPath,
  NAME_PARTICLES,
};
