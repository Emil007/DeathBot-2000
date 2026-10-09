const axios = require("axios");
const { fetchBestImage } = require("./page-image");

function createClient(userAgent) {
  return axios.create({
    timeout: 20000,
    headers: { "User-Agent": userAgent },
    validateStatus: (s) => s >= 200 && s < 500,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polite GET with retry/backoff on 429 + small jitter (Wikidata is rate-limit heavy). */
async function getRetry(client, url, params, { tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await client.get(url, { params });
      if (r.status === 429) throw { response: { status: 429 } };
      return r;
    } catch (e) {
      const code = e?.response?.status;
      if (code === 429 && i < tries - 1) {
        await sleep(600 * (i + 1) + Math.random() * 400);
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

function parseWikiUrl(url) {
  try {
    const u = new URL(url);
    if (!/\.wikipedia\.org$/i.test(u.hostname)) return null;
    const lang = u.hostname.split(".")[0];
    const title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, "")).replace(/_/g, " ");
    return { lang, title };
  } catch {
    return null;
  }
}

function parseWikidataTime(time) {
  if (!time) return null;
  const m = String(time).match(/([+-]?\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return {
    iso: `${m[1].replace("+", "").padStart(4, "0")}-${m[2]}-${m[3]}`,
    year: parseInt(m[1].replace("+", ""), 10),
  };
}

function ageBetween(birthIso, deathIso) {
  if (!birthIso || !deathIso) return null;
  const b = new Date(`${birthIso}T00:00:00Z`);
  const d = new Date(`${deathIso}T00:00:00Z`);
  if (Number.isNaN(b.getTime()) || Number.isNaN(d.getTime())) return null;
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const m = d.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && d.getUTCDate() < b.getUTCDate())) age--;
  if (age < 0 || age > 130) return null;
  return age;
}

/** Age often appears as "Name, 72," or "Name (72)" in death-list blurbs. */
function ageFromListText(text, name) {
  if (!text) return null;
  let s = String(text);
  if (name) {
    const re = new RegExp(`^\\s*${escapeRegExp(name)}\\s*[,:\\-–]?\\s*`, "i");
    s = s.replace(re, "");
  }
  const m =
    s.match(/^\(?\s*(\d{2,3})\s*\)?\s*[,;]/) ||
    s.match(/,\s*(\d{2,3})\s*[,;]/) ||
    s.match(/\((\d{2,3})\)/);
  if (!m) return null;
  const age = parseInt(m[1], 10);
  return age >= 10 && age <= 120 ? age : null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DE_MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];
const EN_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Recognize "8. Oktober" / "8 Oktober" / "8 October 2026" inside entry text
 * (DE death lines carry the day-of-death tag at the end: "…, 8. Oktober").
 * @returns {{day:number, month:number, year?:number}|null}
 */
function parseDeathDateText(text) {
  if (!text) return null;
  const t = String(text);
  for (const months of [DE_MONTH_NAMES, EN_MONTH_NAMES]) {
    for (let i = 0; i < months.length; i++) {
      const re = new RegExp(
        `\\b(\\d{1,2})\\s*\\.?\\s*${months[i]}(?:\\s+(\\d{4}))?\\b`,
        "i"
      );
      const m = t.match(re);
      if (m) {
        const day = parseInt(m[1], 10);
        if (day >= 1 && day <= 31) {
          const out = { day, month: i };
          if (m[2]) out.year = parseInt(m[2], 10);
          return out;
        }
      }
    }
  }
  return null;
}

/**
 * Main name of a death-list line (the person, before any ", age,") with
 * trailing artifact junk stripped: orphaned combining diacritics and stray
 * trailing punctuation/symbols (the "Sonderzeichen am Namensende"). A
 * "(...)" disambiguation suffix is dropped.
 */
function personNameFromText(text) {
  if (!text) return "";
  return String(text)
    .trim()
    .replace(/[\u200b-\u200f\u00ad\ufeff]/g, "") // zero-width / format chars
    .replace(/\[\d+\]/g, "")
    .split(",")[0]
    .split("(")[0]
    .replace(/[\u0300-\u036f]+$/g, "") // orphan combining marks at end
    .replace(/[*†‡"'+]+$/g, "") // stray symbol artifacts at end
    .trim();
}

/** Accent-insensitive, alphanumeric-only key for cross-language dedup. */
function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function firstSentences(text, maxChars = 280) {
  if (!text) return null;
  let t = String(text).replace(/\s+/g, " ").trim();
  if (!t) return null;
  // Drop pronunciation / IPA clutter that follows the name, e.g.
  // "Hubert Colin de Verdière (French: [ybˈɛʁ …]) was…" -> keep what's useful
  t = t.replace(/^\([^)]{0,120}\)\s*/g, "");
  t = t.replace(/\s*\((?:French|German|English|Spanish|Italian|Russian|Dutch|Portuguese|Polish|Hungarian|Czech|Turkish|Arabic|Hebrew|Chinese|Japanese|Korean|Danish|Swedish|Norwegian|Finnish):\s*\[[^)]{0,120}\]\)/, "")
     .replace(/\s*\((?:French|German|English|Spanish|Italian|Russian|Dutch|Portuguese|Polish|Hungarian|Czech|Turkish|Arabic|Hebrew|Chinese|Japanese|Korean|Danish|Swedish|Norwegian|Finnish)\s*/i, " ");
  const parts = t.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const p of parts) {
    if (!p) continue;
    const next = out ? `${out} ${p}` : p;
    if (next.length > maxChars && out) break;
    out = next;
    if (out.length >= 120) break;
  }
  if (out.length > maxChars) out = out.slice(0, maxChars - 1).trim() + "…";
  return out || null;
}

/** Wikidata P18 filename -> Commons thumbnail URL via Special:FilePath. */
function commonsThumbUrl(filename, width = 400) {
  if (!filename) return null;
  const safe = String(filename).replace(/ /g, "_");
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(safe)}?width=${width}`;
}

function wikidataP18(claims) {
  const c = claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  return typeof c === "string" && c.trim() ? c.trim() : null;
}

async function labelEntities(client, ids, langPrefer = "en") {
  const unique = [...new Set(ids.filter(Boolean))].slice(0, 8);
  if (!unique.length) return [];
  const { data, status } = await client.get("https://www.wikidata.org/w/api.php", {
    params: {
      action: "wbgetentities",
      ids: unique.join("|"),
      props: "labels",
      languages: `${langPrefer}|en|de`,
      format: "json",
      origin: "*",
    },
  });
  if (status !== 200) return [];
  const out = [];
  for (const id of unique) {
    const labels = data?.entities?.[id]?.labels || {};
    const label =
      labels[langPrefer]?.value || labels.en?.value || labels.de?.value || null;
    if (label) out.push(label);
  }
  return out;
}

/**
 * Informative bio card for all-deaths (no sarcasm).
 * @returns {Promise<{
 *   name: string,
 *   summary: string|null,
 *   knownFor: string|null,
 *   age: number|null,
 *   birthYear: number|null,
 *   deathYear: number|null,
 *   lifespan: string|null,
 *   thumb: string|null,
 *   url: string,
 * }>}
 */
async function fetchDeathBrief(pageUrl, userAgent, { listText = null } = {}) {
  const parsed = parseWikiUrl(pageUrl);
  const nameGuess = listText
    ? personNameFromText(listText)
    : parsed?.title || "Unbekannt";

  const fallback = {
    name: nameGuess,
    summary: null,
    knownFor: null,
    age: ageFromListText(listText, nameGuess),
    birthYear: null,
    deathYear: null,
    lifespan: null,
    thumb: null,
    url: pageUrl,
    isHuman: null,
  };

  if (!parsed) return fallback;

  const client = createClient(userAgent);
  try {
    const api = `https://${parsed.lang}.wikipedia.org/w/api.php`;
    const { data, status } = await getRetry(client, api, {
      action: "query",
      titles: parsed.title,
      prop: "extracts|pageprops|pageimages|description|info",
      exintro: 1,
      explaintext: 1,
      exchars: 400,
      pithumbsize: 500,
      piprop: "thumbnail",
      pilicense: "any",
      inprop: "url",
      redirects: 1,
      format: "json",
      origin: "*",
    });
    if (status !== 200) return fallback;

    const page = Object.values(data?.query?.pages || {})[0];
    if (!page || page.missing != null) return fallback;

    const name = page.title || nameGuess;
    const extract = firstSentences(page.extract);
    const pageDesc = page.description || null;
    const thumb = page.thumbnail?.source || null;
    const qid = page.pageprops?.wikibase_item || null;
    const fullUrl = page.fullurl || pageUrl;

    let birth = null;
    let death = null;
    let occupations = [];
    let wdDesc = null;
    let p18File = null;
    let isHuman = null;

    if (qid) {
      const { data: wd } = await getRetry(client, "https://www.wikidata.org/w/api.php", {
        action: "wbgetentities",
        ids: qid,
        props: "claims|descriptions",
        languages: `${parsed.lang}|en|de`,
        format: "json",
        origin: "*",
      });
      const entity = wd?.entities?.[qid];
      // Wikidata portrait as image fallback when the article has no lead image
      p18File = wikidataP18(entity?.claims);
      birth = parseWikidataTime(entity?.claims?.P569?.[0]?.mainsnak?.datavalue?.value?.time);
      death = parseWikidataTime(entity?.claims?.P570?.[0]?.mainsnak?.datavalue?.value?.time);
      // Person check (instance-of human). A band/organization article linked from
      // a death line must not supply the card name (Chris Welsh / "Died Pretty").
      const p31 = (entity?.claims?.P31 || [])
        .map((c) => c?.mainsnak?.datavalue?.value?.id)
        .filter(Boolean);
      isHuman = p31.includes("Q5") ? true : p31.length ? false : null;
      const occIds = (entity?.claims?.P106 || [])
        .map((c) => c?.mainsnak?.datavalue?.value?.id)
        .filter(Boolean)
        .slice(0, 4);
      occupations = await labelEntities(client, occIds, parsed.lang === "de" ? "de" : "en");
      const descs = entity?.descriptions || {};
      wdDesc =
        descs[parsed.lang]?.value || descs.en?.value || descs.de?.value || null;
    }

    let age =
      (birth && death && ageBetween(birth.iso, death.iso)) ??
      ageFromListText(listText, name) ??
      fallback.age;

    let birthYear = birth?.year ?? null;
    const deathYear = death?.year ?? null;

    // Plausibilize the Wikidata birth year (P569) so a bad value can never
    // render as "* 2000 · gestorben mit 84". With a death year the birth must
    // be sane (<= death year, span <= 115). Without one, derive from the age.
    if (deathYear != null) {
      if (birthYear != null && (birthYear > deathYear || deathYear - birthYear > 115)) {
        birthYear = null;
      }
    } else if (birthYear != null && age != null && age > 0) {
      const implied = new Date().getUTCFullYear() - age;
      if (Math.abs(implied - birthYear) > 15) {
        birthYear = implied >= 1900 ? implied : null;
      }
    }

    let lifespan = null;
    if (birthYear && deathYear) lifespan = `${birthYear}–${deathYear}`;
    else if (deathYear) lifespan = `† ${deathYear}`;
    else if (birthYear) lifespan = `* ${birthYear}`;

    const imgUrl = commonsThumbUrl(p18File);

    const knownFor =
      (occupations.length ? occupations.join(", ") : null) ||
      pageDesc ||
      wdDesc ||
      (extract ? firstSentences(extract, 160) : null) ||
      null;

    // Prefer a short factual line that isn't just repeating the name
    let summary = wdDesc || pageDesc || extract;
    if (summary && knownFor && summary.toLowerCase() === knownFor.toLowerCase()) {
      summary = extract && extract.toLowerCase() !== knownFor.toLowerCase() ? extract : summary;
    }

    return {
      name,
      summary,
      knownFor,
      age,
      birthYear,
      deathYear,
      lifespan,
      thumb: thumb || imgUrl,
      url: fullUrl,
      isHuman,
    };
  } catch (e) {
    console.warn("[death-brief]", e.message);
    return fallback;
  }
}

/**
 * Resolve image: brief thumb → EN/DE pageimages fallback.
 */
async function resolveDeathImage(brief, entry, userAgent) {
  if (brief?.thumb) return brief.thumb;
  return fetchBestImage(
    entry?.lang === "en" ? entry.url : null,
    entry?.lang === "de" ? entry.url : null,
    userAgent
  );
}

module.exports = {
  fetchDeathBrief,
  resolveDeathImage,
  ageFromListText,
  firstSentences,
  personNameFromText,
  normalizeName,
  parseDeathDateText,
};
