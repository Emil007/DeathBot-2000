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
    // Decode then re-encode consistently
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
  // +1947-09-14T00:00:00Z
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
      srlimit: 5,
      format: "json",
      origin: "*",
    },
  });
  const hits = data?.query?.search || [];
  return hits.map((h) => ({
    title: h.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, "_"))}`,
    lang,
  }));
}

async function getWikidataBirth(client, qid) {
  if (!qid) return null;
  const { data } = await client.get("https://www.wikidata.org/w/api.php", {
    params: {
      action: "wbgetentities",
      ids: qid,
      props: "claims",
      format: "json",
      origin: "*",
    },
  });
  const claim = data?.entities?.[qid]?.claims?.P569?.[0]?.mainsnak?.datavalue?.value;
  return parseWikidataTime(claim?.time);
}

async function getPageMeta(client, lang, titleOrUrl) {
  let title = titleOrUrl;
  const norm = normalizeWikiUrl(titleOrUrl);
  if (norm) {
    title = norm.title;
    lang = norm.lang;
  }
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
  const qid = page.pageprops?.wikibase_item || null;
  const birth = await getWikidataBirth(client, qid);
  const fullUrl = page.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`;
  const n = normalizeWikiUrl(fullUrl);
  return {
    title: page.title,
    url: n?.url || fullUrl,
    norm: n?.norm || null,
    lang,
    qid,
    birthDate: birth,
    thumb: page.thumbnail?.source || null,
  };
}

/**
 * Propose EN (preferred) or DE wiki + age at season start.
 */
async function proposeWikiForName(userAgent, name, seasonStartDate, sheetAge) {
  const client = createClient(userAgent);
  let meta = null;
  let lang = "en";

  try {
    const enHits = await searchWikipedia(client, "en", name);
    if (enHits[0]) meta = await getPageMeta(client, "en", enHits[0].title);
  } catch (e) {
    console.warn("[page-lookup] EN search", e.message);
  }

  if (!meta) {
    try {
      const deHits = await searchWikipedia(client, "de", name);
      if (deHits[0]) {
        meta = await getPageMeta(client, "de", deHits[0].title);
        lang = "de";
      }
    } catch (e) {
      console.warn("[page-lookup] DE search", e.message);
    }
  }

  // If DE page, try EN interwiki via sitelinks would need another call; keep DE for now
  const wikiAge = meta?.birthDate ? ageAtDate(meta.birthDate, seasonStartDate) : null;
  return {
    wikiUrl: meta?.url || null,
    wikiNorm: meta?.norm || null,
    lang: meta?.lang || lang,
    birthDate: meta?.birthDate || null,
    proposedAge: wikiAge ?? sheetAge ?? null,
    sheetAge: sheetAge ?? null,
    thumb: meta?.thumb || null,
    title: meta?.title || null,
  };
}

async function lookupUrl(userAgent, url, seasonStartDate, sheetAge) {
  const client = createClient(userAgent);
  const norm = normalizeWikiUrl(url);
  if (!norm) throw new Error("Need an en.wikipedia.org or de.wikipedia.org /wiki/ URL");
  const meta = await getPageMeta(client, norm.lang, norm.url);
  if (!meta) throw new Error("Wikipedia page not found");
  const wikiAge = meta.birthDate ? ageAtDate(meta.birthDate, seasonStartDate) : null;
  return {
    wikiUrl: meta.url,
    wikiNorm: meta.norm,
    lang: meta.lang,
    birthDate: meta.birthDate,
    proposedAge: wikiAge ?? sheetAge ?? null,
    sheetAge: sheetAge ?? null,
    thumb: meta.thumb,
    title: meta.title,
  };
}

module.exports = {
  normalizeWikiUrl,
  ageAtDate,
  proposeWikiForName,
  lookupUrl,
  searchWikipedia,
  getPageMeta,
};
