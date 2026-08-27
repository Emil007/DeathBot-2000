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
      srlimit: 5,
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

async function getWikidataBirth(client, qid) {
  const entity = await getWikidataEntity(client, qid);
  const claim = entity?.claims?.P569?.[0]?.mainsnak?.datavalue?.value;
  return parseWikidataTime(claim?.time);
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
  const entity = qid ? await getWikidataEntity(client, qid) : null;
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
 * Propose EN (preferred) or DE wiki + age; include top search candidates.
 */
async function proposeWikiForName(userAgent, name, seasonStartDate, sheetAge) {
  const client = createClient(userAgent);
  const candidates = [];
  let primaryMeta = null;

  try {
    const enHits = await searchWikipedia(client, "en", name);
    for (const hit of enHits.slice(0, 3)) {
      try {
        const meta = await getPageMeta(client, "en", hit.title);
        if (!meta) continue;
        const wikiAge = meta.birthDate ? ageAtDate(meta.birthDate, seasonStartDate) : null;
        candidates.push({
          title: meta.title,
          url: meta.url,
          norm: meta.norm,
          lang: "en",
          qid: meta.qid,
          proposedAge: wikiAge ?? sheetAge ?? null,
          thumb: meta.thumb,
          snippet: hit.snippet || "",
        });
        if (!primaryMeta) primaryMeta = meta;
      } catch (e) {
        console.warn("[page-lookup] EN candidate", e.message);
      }
    }
  } catch (e) {
    console.warn("[page-lookup] EN search", e.message);
  }

  if (!primaryMeta) {
    try {
      const deHits = await searchWikipedia(client, "de", name);
      for (const hit of deHits.slice(0, 3)) {
        try {
          const meta = await getPageMeta(client, "de", hit.title);
          if (!meta) continue;
          const wikiAge = meta.birthDate ? ageAtDate(meta.birthDate, seasonStartDate) : null;
          candidates.push({
            title: meta.title,
            url: meta.enLink?.url || meta.url,
            norm: meta.enLink?.norm || meta.norm,
            lang: meta.enLink ? "en" : "de",
            qid: meta.qid,
            proposedAge: wikiAge ?? sheetAge ?? null,
            thumb: meta.thumb,
            snippet: hit.snippet || "",
          });
          if (!primaryMeta) primaryMeta = meta;
        } catch (e) {
          console.warn("[page-lookup] DE candidate", e.message);
        }
      }
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
  if (!meta) throw new Error("Wikipedia page not found");
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
};
