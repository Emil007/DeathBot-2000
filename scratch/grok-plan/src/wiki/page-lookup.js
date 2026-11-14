const axios = require("axios");

function createClient(userAgent) {
  return axios.create({
    timeout: 20000,
    headers: { "User-Agent": userAgent },
  });
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
  const { data } = await client.get(api, {
    params: {
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: 8,
      format: "json",
      origin: "*",
    },
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
  try {
    const api = `https://${lang}.wikipedia.org/w/api.php`;
    const { data } = await client.get(api, {
      params: {
        action: "query",
        titles: title,
        prop: "categories",
        cllimit: 50,
        clshow: "!hidden",
        format: "json",
        origin: "*",
        redirects: 1,
      },
    });
    const page = Object.values(data?.query?.pages || {})[0];
    return (page?.categories || []).map((c) => c.title || "");
  } catch {
    return [];
  }
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
 * Decide if a page is a person biography.
 * @returns {Promise<boolean>}
 */
async function isPersonPage(client, lang, title, entity) {
  if (titleLooksNonPerson(title)) return false;

  const human = entityIsHuman(entity);
  if (human === true) return true;
  if (human === false) return false;

  // No clear P31 — use categories + birth claim
  if (entity?.claims?.P569?.[0]) return true;
  const cats = await getPageCategories(client, lang, title);
  if (categoriesSuggestNonPerson(cats)) return false;
  if (categoriesSuggestPerson(cats)) return true;
  // Unknown: reject to avoid filmography/list false positives
  return false;
}

async function getWikidataEntity(client, qid) {
  if (!qid) return null;
  const { data } = await client.get("https://www.wikidata.org/w/api.php", {
    params: {
      action: "wbgetentities",
      ids: qid,
      props: "claims|sitelinks",
      format: "json",
      origin: "*",
    },
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
  const { data } = await client.get(api, {
    params: {
      action: "query",
      titles: title,
      prop: "pageprops|pageimages|info",
      inprop: "url",
      pithumbsize: 400,
      format: "json",
      origin: "*",
      redirects: 1,
    },
  });
  const page = Object.values(data?.query?.pages || {})[0];
  if (!page || page.missing != null) return null;
  if (titleLooksNonPerson(page.title)) return null;

  const qid = page.pageprops?.wikibase_item || null;
  const entity = qid ? await getWikidataEntity(client, qid) : null;
  const person = await isPersonPage(client, lang, page.title, entity);
  if (!person) return null;

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
 */
async function proposeWikiForName(userAgent, name, seasonStartDate, sheetAge) {
  const client = createClient(userAgent);
  const candidates = [];
  let primaryMeta = null;

  async function collect(lang, hits) {
    for (const hit of hits) {
      if (candidates.length >= 3) break;
      if (titleLooksNonPerson(hit.title)) continue;
      try {
        await new Promise((r) => setTimeout(r, 350));
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
      } catch (e) {
        console.warn(`[page-lookup] ${lang} candidate`, e.message);
      }
    }
  }

  try {
    const enHits = await searchWikipedia(client, "en", name);
    await collect("en", enHits);
  } catch (e) {
    console.warn("[page-lookup] EN search", e.message);
  }

  if (candidates.length < 3) {
    try {
      await new Promise((r) => setTimeout(r, 350));
      const deHits = await searchWikipedia(client, "de", name);
      await collect("de", deHits);
    } catch (e) {
      console.warn("[page-lookup] DE search", e.message);
    }
  }

  return proposalFromMeta(primaryMeta, seasonStartDate, sheetAge, candidates);
}

async function lookupUrl(userAgent, url, seasonStartDate, sheetAge) {
  const client = createClient(userAgent);
  const norm = normalizeWikiUrl(url);
  if (!norm) throw new Error("Need an en.wikipedia.org or de.wikipedia.org /wiki/ URL");
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

module.exports = {
  normalizeWikiUrl,
  ageAtDate,
  proposeWikiForName,
  lookupUrl,
  searchWikipedia,
  getPageMeta,
  titleLooksNonPerson,
  isPersonPage,
};
