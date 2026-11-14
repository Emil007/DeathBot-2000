const axios = require("axios");
const { withWikiSlot } = require("./gate");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One client per User-Agent. resolveEnglishArticle is called once per DE row;
// building a new client each time is what this cache avoids.
const clients = new Map();

function createClient(userAgent) {
  if (!clients.has(userAgent)) {
    clients.set(
      userAgent,
      axios.create({
        timeout: 20000,
        headers: { "User-Agent": userAgent },
      })
    );
  }
  return clients.get(userAgent);
}

/**
 * 429 backoff matches death-brief.js getRetry: three tries, then the error.
 * That helper is not exported; this package does not edit death-brief.js.
 * Each attempt holds a wiki slot. The pause between attempts does not.
 */
async function getRetry(client, url, params, { tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await withWikiSlot(() => client.get(url, { params }));
      if (r.status === 429) {
        throw Object.assign(new Error("HTTP 429 (rate-limited)"), { response: { status: 429 } });
      }
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

function normalizeWikiUrl(url) {
  if (!url) return null;
  try {
    let u = String(url).trim();
    if (u.startsWith("//")) u = "https:" + u;
    const parsed = new URL(u);
    if (!/\.wikipedia\.org$/i.test(parsed.hostname)) return null;
    const lang = parsed.hostname.split(".")[0];
    let path = parsed.pathname;
    if (!path.startsWith("/wiki/")) return null;
    const title = decodeURIComponent(path.replace(/^\/wiki\//, "")).replace(/ /g, "_");
    return {
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title).replace(/%2F/gi, "/")}`,
      norm: `${lang}:${title.toLowerCase()}`,
      lang,
      title: title.replace(/_/g, " "),
      path: `/wiki/${title}`,
    };
  } catch {
    return null;
  }
}

function ageAtDate(birthIso, onDateIso) {
  if (!birthIso || !onDateIso) return null;
  const b = new Date(birthIso + (birthIso.length === 10 ? "T00:00:00Z" : ""));
  const on = new Date(onDateIso + "T00:00:00Z");
  if (Number.isNaN(b.getTime()) || Number.isNaN(on.getTime())) return null;
  let age = on.getUTCFullYear() - b.getUTCFullYear();
  const m = on.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < b.getUTCDate())) age--;
  if (age < 0 || age > 130) return null;
  return age;
}

function parseWikidataTime(time) {
  if (!time) return null;
  const m = String(time).match(/([+-]?\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1].replace("+", "").padStart(4, "0")}-${m[2]}-${m[3]}`;
}

async function searchWikipedia(client, lang, query) {
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const { data } = await getRetry(client, api, {
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: 8,
    format: "json",
    origin: "*",
  });
  const hits = data?.query?.search || [];
  return hits.map((h) => ({
    title: h.title,
    snippet: (h.snippet || "").replace(/<[^>]+>/g, ""),
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, "_"))}`,
    lang,
  }));
}

/** Titles that are almost never a biography page */
const NON_PERSON_TITLE =
  /\b(discography|filmography|bibliography|videography|soundtrack|album|ep\)|singles|songs|film\)|tv series|list of|tournament|election|disambiguation)\b/i;

function titleLooksNonPerson(title) {
  return NON_PERSON_TITLE.test(String(title || ""));
}

function instanceOfIds(entity) {
  const claims = entity?.claims?.P31 || [];
  return claims
    .map((c) => c?.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}

/** Wikidata: human = Q5 */
function entityIsHuman(entity) {
  if (!entity) return null;
  const ids = instanceOfIds(entity);
  if (!ids.length) return null;
  if (ids.includes("Q5")) return true;
  // Common non-person types that sneak into search
  const reject = new Set([
    "Q11424", // film
    "Q5398426", // TV series
    "Q482994", // album
    "Q7366", // song
    "Q134556", // single
    "Q7889", // video game
    "Q4167410", // disambiguation
    "Q13406463", // Wikimedia list article
    "Q5", // (human — already handled)
    "Q43229", // organization
    "Q7278", // political party
    "Q215380", // band — bands sometimes wanted but death-pool is people; skip
  ]);
  if (ids.some((id) => reject.has(id))) return false;
  // Has birth date → almost certainly a person even if P31 odd
  if (entity.claims?.P569?.[0]) return true;
  return false;
}

async function getPageCategories(client, lang, title) {
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const { data } = await getRetry(client, api, {
    action: "query",
    titles: title,
    prop: "categories",
    cllimit: 50,
    clshow: "!hidden",
    format: "json",
    origin: "*",
    redirects: 1,
  });
  const page = Object.values(data?.query?.pages || {})[0];
  return (page?.categories || []).map((c) => c.title || "");
}

function categoriesSuggestPerson(cats) {
  return cats.some((c) =>
    /\d{4} births|\d{4} deaths|living people|people from|geborene|gestorben|\d{4} gestorben|männlich|weiblich|biograph/i.test(
      c
    )
  );
}

function categoriesSuggestNonPerson(cats) {
  return cats.some((c) =>
    /discograph|filmograph|bibliograph|albums|film stubs|songs |lists of|soundtracks|video games/i.test(
      c
    )
  );
}

/**
 * Person decision plus whether the hit is unambiguous.
 * Unambiguous means entityIsHuman, or person-categories without non-person
 * categories. A birth date alone is still a person, but the search keeps going.
 * @returns {Promise<{person: boolean, unambiguous: boolean}>}
 */
async function classifyPerson(client, lang, title, entity) {
  if (titleLooksNonPerson(title)) return { person: false, unambiguous: false };

  const human = entityIsHuman(entity);
  if (human === true) return { person: true, unambiguous: true };
  if (human === false) return { person: false, unambiguous: false };

  // Birth date accepts the page (same as before) but is not by itself
  // "eindeutig". Categories decide whether the search may stop.
  if (entity?.claims?.P569?.[0]) {
    let unambiguous = false;
    try {
      const cats = await getPageCategories(client, lang, title);
      unambiguous = categoriesSuggestPerson(cats) && !categoriesSuggestNonPerson(cats);
    } catch (e) {
      console.warn("[page-lookup] categories", e.message);
      unambiguous = false;
    }
    return { person: true, unambiguous };
  }

  const cats = await getPageCategories(client, lang, title);
  if (categoriesSuggestNonPerson(cats)) return { person: false, unambiguous: false };
  if (categoriesSuggestPerson(cats) && !categoriesSuggestNonPerson(cats)) {
    return { person: true, unambiguous: true };
  }
  // Unknown: reject to avoid filmography/list false positives
  return { person: false, unambiguous: false };
}

/**
 * Decide if a page is a person biography.
 * @returns {Promise<boolean>}
 */
async function isPersonPage(client, lang, title, entity) {
  const classified = await classifyPerson(client, lang, title, entity);
  return classified.person;
}

async function getWikidataEntity(client, qid) {
  if (!qid) return null;
  const { data } = await getRetry(client, "https://www.wikidata.org/w/api.php", {
    action: "wbgetentities",
    ids: qid,
    props: "claims|sitelinks",
    format: "json",
    origin: "*",
  });
  return data?.entities?.[qid] || null;
}

function sitelinksFromEntity(entity) {
  if (!entity?.sitelinks) return { en: null, de: null };
  const en = entity.sitelinks.enwiki;
  const de = entity.sitelinks.dewiki;
  return {
    en: en
      ? {
          title: en.title,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(en.title.replace(/ /g, "_"))}`,
          norm: `en:${en.title.replace(/ /g, "_").toLowerCase()}`,
        }
      : null,
    de: de
      ? {
          title: de.title,
          url: `https://de.wikipedia.org/wiki/${encodeURIComponent(de.title.replace(/ /g, "_"))}`,
          norm: `de:${de.title.replace(/ /g, "_").toLowerCase()}`,
        }
      : null,
  };
}

async function getPageMeta(client, lang, titleOrUrl) {
  let title = titleOrUrl;
  const norm = normalizeWikiUrl(titleOrUrl);
  if (norm) {
    title = norm.title;
    lang = norm.lang;
  }
  if (titleLooksNonPerson(title)) return null;

  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const { data } = await getRetry(client, api, {
    action: "query",
    titles: title,
    prop: "pageprops|pageimages|info",
    inprop: "url",
    pithumbsize: 400,
    format: "json",
    origin: "*",
    redirects: 1,
  });
  const page = Object.values(data?.query?.pages || {})[0];
  if (!page || page.missing != null) return null;
  if (titleLooksNonPerson(page.title)) return null;

  const qid = page.pageprops?.wikibase_item || null;
  const entity = qid ? await getWikidataEntity(client, qid) : null;
  const classified = await classifyPerson(client, lang, page.title, entity);
  if (!classified.person) return null;

  const birth = parseWikidataTime(
    entity?.claims?.P569?.[0]?.mainsnak?.datavalue?.value?.time
  );
  const links = sitelinksFromEntity(entity);
  const fullUrl =
    page.fullurl ||
    `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`;
  const n = normalizeWikiUrl(fullUrl);
  return {
    title: page.title,
    url: n?.url || fullUrl,
    norm: n?.norm || null,
    lang,
    qid,
    birthDate: birth,
    thumb: page.thumbnail?.source || null,
    enLink: links.en,
    deLink: links.de,
    isPerson: true,
    unambiguous: classified.unambiguous,
  };
}

function proposalFromMeta(meta, seasonStartDate, sheetAge, candidates = []) {
  if (!meta) {
    return {
      wikiUrl: null,
      wikiNorm: null,
      wikiUrlDe: null,
      lang: null,
      qid: null,
      birthDate: null,
      proposedAge: sheetAge ?? null,
      sheetAge: sheetAge ?? null,
      thumb: null,
      title: null,
      candidates,
    };
  }
  const wikiAge = meta.birthDate ? ageAtDate(meta.birthDate, seasonStartDate) : null;
  // Prefer EN biography URL when sitelink available
  let wikiUrl = meta.url;
  let wikiNorm = meta.norm;
  let lang = meta.lang;
  let wikiUrlDe = meta.deLink?.url || null;
  if (meta.lang === "de" && meta.enLink) {
    wikiUrl = meta.enLink.url;
    wikiNorm = meta.enLink.norm;
    lang = "en";
    wikiUrlDe = meta.url;
  } else if (meta.lang === "en") {
    wikiUrlDe = meta.deLink?.url || null;
  }
  return {
    wikiUrl,
    wikiNorm,
    wikiUrlDe,
    lang,
    qid: meta.qid || null,
    birthDate: meta.birthDate || null,
    proposedAge: wikiAge ?? sheetAge ?? null,
    sheetAge: sheetAge ?? null,
    thumb: meta.thumb || null,
    title: meta.title || null,
    candidates,
  };
}

/**
 * Propose EN (preferred) or DE wiki + age; include top **person** candidates only.
 * Stops at the first unambiguous person instead of filling three slots.
 * An HTTP failure with no person is `{ error: "lookup-failed" }`. A finished
 * search that simply found nobody keeps `{ wikiUrl: null }` and no error.
 */
async function proposeWikiForName(userAgent, name, seasonStartDate, sheetAge) {
  const client = createClient(userAgent);
  const candidates = [];
  let primaryMeta = null;
  let httpFailed = false;
  let stopped = false;

  async function collect(lang, hits) {
    for (const hit of hits) {
      if (stopped || candidates.length >= 3) break;
      if (titleLooksNonPerson(hit.title)) continue;
      try {
        await sleep(350);
        const meta = await getPageMeta(client, lang, hit.title);
        if (!meta) continue;
        const wikiAge = meta.birthDate ? ageAtDate(meta.birthDate, seasonStartDate) : null;
        candidates.push({
          title: meta.title,
          url: meta.enLink?.url || meta.url,
          norm: meta.enLink?.norm || meta.norm,
          lang: meta.enLink ? "en" : meta.lang,
          qid: meta.qid,
          proposedAge: wikiAge ?? sheetAge ?? null,
          thumb: meta.thumb,
          snippet: hit.snippet || "",
        });
        if (!primaryMeta) primaryMeta = meta;
        if (meta.unambiguous) {
          stopped = true;
          break;
        }
      } catch (e) {
        httpFailed = true;
        console.warn(`[page-lookup] ${lang} candidate`, e.message);
      }
    }
  }

  try {
    const enHits = await searchWikipedia(client, "en", name);
    await collect("en", enHits);
  } catch (e) {
    httpFailed = true;
    console.warn("[page-lookup] EN search", e.message);
  }

  if (!stopped && candidates.length < 3) {
    try {
      await sleep(350);
      const deHits = await searchWikipedia(client, "de", name);
      await collect("de", deHits);
    } catch (e) {
      httpFailed = true;
      console.warn("[page-lookup] DE search", e.message);
    }
  }

  const proposal = proposalFromMeta(primaryMeta, seasonStartDate, sheetAge, candidates);
  // A hit wins over a failed sibling request. No hit plus any HTTP error is
  // not a miss: callers leave the row pending instead of marking it unlinked.
  if (!primaryMeta && httpFailed) {
    return { ...proposal, error: "lookup-failed" };
  }
  return proposal;
}

async function lookupUrl(userAgent, url, seasonStartDate, sheetAge) {
  const norm = normalizeWikiUrl(url);
  if (!norm) throw new Error("Keine Wikipedia-URL.");
  const client = createClient(userAgent);
  const meta = await getPageMeta(client, norm.lang, norm.url);
  if (!meta) {
    throw new Error(
      "Wikipedia page not found or not a person page (filtered discography/filmography/lists/…)"
    );
  }
  return proposalFromMeta(meta, seasonStartDate, sheetAge, [
    {
      title: meta.title,
      url: meta.enLink?.url || meta.url,
      norm: meta.enLink?.norm || meta.norm,
      lang: meta.enLink ? "en" : meta.lang,
      qid: meta.qid,
      proposedAge: meta.birthDate ? ageAtDate(meta.birthDate, seasonStartDate) : sheetAge,
      thumb: meta.thumb,
      snippet: "",
    },
  ]);
}

/**
 * EN-Variante eines DE-Artikels über die MediaWiki langlinks-API (zuverlässiger
 * als der HTML-Interlanguage-Scrape, F17). Liefert die en.wikipedia.org-URL
 * ODER null, wenn die Seite kein EN-Sitelink hat. Netz-/HTTP-Fehler werfen —
 * ein vorübergehender Hänger ist NICHT "kein EN" (dann vertagt der Poller).
 */
async function resolveEnglishArticle(userAgent, germanUrl) {
  const norm = normalizeWikiUrl(germanUrl);
  if (!norm || norm.lang !== "de") throw new Error("resolveEnglish braucht de.wikipedia.org /wiki/ URL");
  const client = createClient(userAgent);
  const api = "https://de.wikipedia.org/w/api.php";
  const { data } = await getRetry(client, api, {
    action: "query",
    prop: "langlinks",
    lllang: "en",
    redirects: 1,
    titles: norm.title,
    format: "json",
    origin: "*",
  });
  const page = Object.values(data?.query?.pages || {})[0];
  const enTitle = page?.langlinks?.[0]?.["*"];
  if (!enTitle) return null;
  const n = normalizeWikiUrl(`https://en.wikipedia.org/wiki/${encodeURIComponent(enTitle.replace(/ /g, "_"))}`);
  return n ? n.url : null;
}

module.exports = {
  normalizeWikiUrl,
  ageAtDate,
  proposeWikiForName,
  lookupUrl,
  resolveEnglishArticle,
  searchWikipedia,
  getPageMeta,
  titleLooksNonPerson,
  isPersonPage,
};
