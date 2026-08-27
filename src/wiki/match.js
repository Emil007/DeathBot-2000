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

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-token match — avoids "un" hitting "under"/"June" (Kim Jong Un false positives). */
function tokenInText(token, text) {
  const t = String(token).toLowerCase();
  if (!t) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(t)}(?:[^a-z0-9]|$)`, "i").test(text);
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

  // Prefer stored wiki identity: death-list link title vs confirmed wiki path
  const linkTitle = titleFromWikiPath(entry.wikiPath).toLowerCase();
  if (celeb.wiki_url && linkTitle) {
    try {
      const storedPath = new URL(celeb.wiki_url).pathname.replace(/^\/wiki\//, "").replace(/_/g, " ").toLowerCase();
      const storedKey = db.nameKey(storedPath);
      const titleKey = db.nameKey(linkTitle);
      if (storedKey && titleKey && storedKey === titleKey) return true;
    } catch {
      /* ignore */
    }
  }
  if (celeb.wiki_url_de && linkTitle) {
    try {
      const storedPath = new URL(celeb.wiki_url_de).pathname.replace(/^\/wiki\//, "").replace(/_/g, " ").toLowerCase();
      const storedKey = db.nameKey(storedPath);
      const titleKey = db.nameKey(linkTitle);
      if (storedKey && titleKey && storedKey === titleKey) return true;
    } catch {
      /* ignore */
    }
  }

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

  // Confirmed wiki identity: only match via article title/path above.
  // Mentions in another person's death blurb ("… advisor to Kim Jong Un") must not kill the pick.
  if (celeb.wiki_confirmed) return false;

  if (akas?.length) {
    if (akas.some((a) => text.includes(a.toLowerCase()))) return true;
    if (text.includes(nameLower)) return true;
    return false;
  }

  if (nameLower.length >= 5 && text.includes(nameLower)) return true;

  const tokens = significantTokens(celeb.name);
  if (tokens.length === 0) return false;
  if (tokens.length === 1 && tokens[0].length < 4) return false;
  // Require at least one "solid" token so short leftovers (Un, Li, …) can't carry a hit alone
  if (!tokens.some((t) => t.length >= 3)) return false;
  return tokens.every((t) => tokenInText(t, text));
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
  tokenInText,
  NAME_PARTICLES,
};
