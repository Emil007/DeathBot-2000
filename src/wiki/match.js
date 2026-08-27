const db = require("../db");

function extractAge(text) {
  const match = String(text).match(/\b(\d{2,3})\b/);
  if (!match) return null;
  const age = parseInt(match[1], 10);
  if (age < 10 || age > 120) return null;
  return age;
}

function entryMatchesCeleb(entry, celeb, akas, blacklist) {
  const text = entry.text.toLowerCase();

  if (blacklist?.length) {
    for (const term of blacklist) {
      const parts = term.toLowerCase().split(/\s+/).filter(Boolean);
      if (parts.length && parts.every((p) => text.includes(p))) return false;
    }
  }

  if (akas?.length) {
    if (akas.some((a) => text.includes(a.toLowerCase()))) return true;
    if (text.includes(celeb.name.toLowerCase())) return true;
    return false;
  }

  const parts = celeb.name.split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => text.includes(p.toLowerCase()));
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

module.exports = { extractAge, entryMatchesCeleb, findPoolMatches };
