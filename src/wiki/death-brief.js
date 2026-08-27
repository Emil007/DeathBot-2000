const axios = require("axios");
const { fetchBestImage } = require("./page-image");

function createClient(userAgent) {
  return axios.create({
    timeout: 20000,
    headers: { "User-Agent": userAgent },
    validateStatus: (s) => s >= 200 && s < 500,
  });
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

function firstSentences(text, maxChars = 280) {
  if (!text) return null;
  let t = String(text).replace(/\s+/g, " ").trim();
  if (!t) return null;
  // Drop pronunciation / IPA clutter at start
  t = t.replace(/^\([^)]{0,80}\)\s*/, "");
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
    ? String(listText).split(",")[0].trim()
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
  };

  if (!parsed) return fallback;

  const client = createClient(userAgent);
  try {
    const api = `https://${parsed.lang}.wikipedia.org/w/api.php`;
    const { data, status } = await client.get(api, {
      params: {
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
      },
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

    if (qid) {
      const { data: wd } = await client.get("https://www.wikidata.org/w/api.php", {
        params: {
          action: "wbgetentities",
          ids: qid,
          props: "claims|descriptions",
          languages: `${parsed.lang}|en|de`,
          format: "json",
          origin: "*",
        },
      });
      const entity = wd?.entities?.[qid];
      birth = parseWikidataTime(entity?.claims?.P569?.[0]?.mainsnak?.datavalue?.value?.time);
      death = parseWikidataTime(entity?.claims?.P570?.[0]?.mainsnak?.datavalue?.value?.time);
      const occIds = (entity?.claims?.P106 || [])
        .map((c) => c?.mainsnak?.datavalue?.value?.id)
        .filter(Boolean)
        .slice(0, 4);
      occupations = await labelEntities(client, occIds, parsed.lang === "de" ? "de" : "en");
      const descs = entity?.descriptions || {};
      wdDesc =
        descs[parsed.lang]?.value || descs.en?.value || descs.de?.value || null;
    }

    const age =
      ageBetween(birth?.iso, death?.iso) ??
      ageFromListText(listText, name) ??
      fallback.age;

    const birthYear = birth?.year ?? null;
    const deathYear = death?.year ?? null;
    let lifespan = null;
    if (birthYear && deathYear) lifespan = `${birthYear}–${deathYear}`;
    else if (deathYear) lifespan = `† ${deathYear}`;
    else if (birthYear) lifespan = `* ${birthYear}`;

    const knownFor =
      (occupations.length ? occupations.join(", ") : null) || pageDesc || wdDesc || null;

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
      thumb,
      url: fullUrl,
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
};
