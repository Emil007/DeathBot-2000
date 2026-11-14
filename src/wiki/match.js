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

function tokenPattern(token) {
  const t = String(token).toLowerCase();
  if (!t) return null;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(t)}(?:[^a-z0-9]|$)`, "i");
}

/** Whole-token match — avoids "un" hitting "under"/"June" (Kim Jong Un false positives). */
function tokenInText(token, text) {
  const re = tokenPattern(token);
  if (!re) return false;
  return re.test(text);
}

/**
 * Same folding as db.nameKey. Entry titles, aka titles and stored wiki paths
 * use this local copy so a poll calls db.nameKey once per celeb (the display
 * name), not once per list entry. Must stay aligned with db.nameKey.
 */
function foldKey(name) {
  return String(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function wikiUrlPathKey(url) {
  if (!url) return "";
  try {
    const storedPath = new URL(url).pathname.replace(/^\/wiki\//, "").replace(/_/g, " ").toLowerCase();
    return foldKey(storedPath);
  } catch {
    return "";
  }
}

function entryTitleKey(entry) {
  if (!entry || !entry.wikiPath) return "";
  const title = titleFromWikiPath(entry.wikiPath).toLowerCase();
  if (!title) return "";
  return foldKey(title);
}

function sideList(map, id) {
  if (map == null) return [];
  let value;
  if (typeof map.get === "function") {
    value = map.has(id) ? map.get(id) : map.get(String(id));
  } else {
    value = Object.prototype.hasOwnProperty.call(map, id)
      ? map[id]
      : map[String(id)];
  }
  return Array.isArray(value) ? value : [];
}

function addId(map, key, id) {
  if (!key) return;
  let bucket = map.get(key);
  if (!bucket) {
    bucket = [];
    map.set(key, bucket);
  }
  if (!bucket.includes(id)) bucket.push(id);
}

function compileBlacklist(terms) {
  const partsList = [];
  for (const term of terms || []) {
    const parts = term.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length) partsList.push(parts);
  }
  return partsList;
}

function discardedByAuto(celeb) {
  return celeb.wiki_confirmed != 1 || celeb.exclude_from_auto == 1;
}

function buildFuzzyPlan(rec) {
  const nameLower = rec.celeb.name.toLowerCase();
  const akas = rec.akas;
  if (akas.length) {
    return {
      akasLower: akas.map((a) => a.toLowerCase()),
      nameLower,
      regexes: null,
    };
  }
  const tokens = significantTokens(rec.celeb.name);
  const usable =
    tokens.length > 0 &&
    !(tokens.length === 1 && tokens[0].length < 4) &&
    tokens.some((t) => t.length >= 3);
  let regexes = null;
  if (usable) {
    const built = tokens.map((t) => tokenPattern(t)).filter(Boolean);
    regexes = built.length ? built : null;
  }
  return { akasLower: null, nameLower, regexes };
}

function compileEligibleFuzzy(index, auto) {
  const fuzzy = [];
  for (const rec of index.records) {
    // Auto drops unconfirmed / excluded celebs before any token regexp exists.
    if (auto && discardedByAuto(rec.celeb)) continue;
    // Confirmed identities never fuzzy-match (same truthiness as entryMatchesCeleb).
    // That exclusion happens before tokenInText; paths were already parsed once.
    if (rec.celeb.wiki_confirmed) continue;
    if (!rec.fuzzy) rec.fuzzy = buildFuzzyPlan(rec);
    fuzzy.push(rec);
  }
  return fuzzy;
}

function isBlacklisted(rec, textLower) {
  for (const parts of rec.blacklistParts) {
    if (parts.every((p) => textLower.includes(p))) return true;
  }
  return false;
}

function fuzzyHit(rec, textLower) {
  const plan = rec.fuzzy;
  if (plan.akasLower) {
    if (plan.akasLower.some((a) => textLower.includes(a))) return true;
    return textLower.includes(plan.nameLower);
  }
  if (plan.nameLower.length >= 5 && textLower.includes(plan.nameLower)) return true;
  if (!plan.regexes) return false;
  return plan.regexes.every((re) => re.test(textLower));
}

function makeHit(rec, entry) {
  const celeb = rec.celeb;
  return {
    celeb,
    entry,
    age: extractAge(entry.text) ?? celeb.age_at_pick ?? null,
    payable: celeb.wiki_confirmed == 1,
  };
}

/**
 * One nameKey and one normalized wiki path per celeb. Aka list and blacklist
 * hang on the celeb record; path and nameKey maps point at celeb ids.
 * wiki_url and wiki_url_de are each normalized once here (not per entry).
 */
function buildPoolIndex(celebs, opts) {
  const akaById = opts && opts.akaById;
  const blacklistById = opts && opts.blacklistById;
  const byPath = new Map();
  const byName = new Map();
  const byId = new Map();
  const records = [];

  for (const celeb of celebs) {
    const akas = sideList(akaById, celeb.id);
    const rec = {
      celeb,
      akas,
      blacklistParts: compileBlacklist(sideList(blacklistById, celeb.id)),
      fuzzy: null,
    };
    records.push(rec);
    byId.set(celeb.id, rec);

    const keyed = db.nameKey(celeb.name);
    const folded = foldKey(celeb.name);
    if (keyed) addId(byName, keyed, celeb.id);
    if (folded && folded !== keyed) addId(byName, folded, celeb.id);
    for (const alias of akas) {
      const akaKey = foldKey(alias);
      if (akaKey) addId(byName, akaKey, celeb.id);
    }

    const enPath = wikiUrlPathKey(celeb.wiki_url);
    if (enPath) addId(byPath, enPath, celeb.id);
    const dePath = wikiUrlPathKey(celeb.wiki_url_de);
    if (dePath) addId(byPath, dePath, celeb.id);
  }

  return { byPath, byName, byId, records };
}

/**
 * One pass over entries. Confirmed non-matches never reach `new URL` or
 * tokenInText — those keys were built once in buildPoolIndex. Stays synchronous;
 * only the poll may yield between chunks.
 */
function matchEntriesToIndex(index, entries, opts) {
  const mode = (opts && opts.mode) || "auto";
  const auto = mode !== "announced";
  const fuzzy = compileEligibleFuzzy(index, auto);
  const hitById = new Map();
  const matched = new Set();

  const consider = (ids, entry, textLower) => {
    if (!ids) return textLower;
    for (const id of ids) {
      if (matched.has(id)) continue;
      const rec = index.byId.get(id);
      if (!rec) continue;
      if (auto && discardedByAuto(rec.celeb)) continue;
      if (textLower === undefined) textLower = entry.text.toLowerCase();
      if (isBlacklisted(rec, textLower)) continue;
      matched.add(id);
      hitById.set(id, makeHit(rec, entry));
    }
    return textLower;
  };

  for (const entry of entries) {
    let textLower;
    const titleKey = entryTitleKey(entry);
    if (titleKey) {
      textLower = consider(index.byPath.get(titleKey), entry, textLower);
      textLower = consider(index.byName.get(titleKey), entry, textLower);
    }
    if (!fuzzy.length) continue;
    if (textLower === undefined) textLower = entry.text.toLowerCase();
    for (const rec of fuzzy) {
      const id = rec.celeb.id;
      if (matched.has(id)) continue;
      if (isBlacklisted(rec, textLower)) continue;
      if (!fuzzyHit(rec, textLower)) continue;
      matched.add(id);
      hitById.set(id, makeHit(rec, entry));
    }
  }

  const out = [];
  for (const rec of index.records) {
    const hit = hitById.get(rec.celeb.id);
    if (hit) out.push(hit);
  }
  return out;
}

function loadSides(celebs) {
  const akaById = new Map();
  const blacklistById = new Map();
  for (const celeb of celebs) {
    akaById.set(celeb.id, db.getAkas(celeb.id));
    blacklistById.set(celeb.id, db.getBlacklist(celeb.id));
  }
  return { akaById, blacklistById };
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
  if (!celebs.length) return [];
  const index = buildPoolIndex(celebs, loadSides(celebs));
  return matchEntriesToIndex(index, entries, { mode: "auto" });
}

/**
 * R2-8: gleiche Matchlogik, aber gegen die ANNOUNCED-Saison-Picks (2027).
 * Fängt Tode von 2027-only-Celebs, die der 2026er-Auto-Pool nie sieht —
 * sonst stirbt im Dezember unbemerkt und wird am 1.1. verworfen.
 */
function findPoolMatchesForAnnounced(entries) {
  const celebs = db.getAliveCelebsForAnnounced();
  if (!celebs.length) return [];
  const index = buildPoolIndex(celebs, loadSides(celebs));
  return matchEntriesToIndex(index, entries, { mode: "announced" });
}

module.exports = {
  extractAge,
  entryMatchesCeleb,
  findPoolMatches,
  findPoolMatchesForAnnounced,
  significantTokens,
  titleFromWikiPath,
  tokenInText,
  NAME_PARTICLES,
  buildPoolIndex,
  matchEntriesToIndex,
};
