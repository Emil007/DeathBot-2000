const axios = require("axios");

function parseWikiUrl(pageUrl) {
  try {
    const u = new URL(pageUrl);
    if (!/wikipedia\.org$/i.test(u.hostname)) return null;
    const lang = u.hostname.split(".")[0];
    const title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, ""));
    if (!title) return null;
    return { lang, title, url: pageUrl };
  } catch {
    return null;
  }
}

async function fetchPageImage(pageUrl, userAgent) {
  if (!pageUrl) return null;
  try {
    const parsed = parseWikiUrl(pageUrl);
    if (!parsed) return null;
    const { lang, title } = parsed;
    const api = `https://${lang}.wikipedia.org/w/api.php`;
    const { data } = await axios.get(api, {
      timeout: 15000,
      headers: { "User-Agent": userAgent },
      params: {
        action: "query",
        titles: title,
        prop: "pageimages",
        piprop: "thumbnail|original|name",
        format: "json",
        pithumbsize: 800,
        pilicense: "any",
        redirects: 1,
        origin: "*",
      },
    });
    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    const fromApi = page?.thumbnail?.source || page?.original?.source || null;
    if (fromApi) return fromApi;

    // Fallback: HTML og:image (some bios lack pageimages)
    const html = await axios.get(pageUrl, {
      timeout: 15000,
      headers: { "User-Agent": userAgent },
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (typeof html.data === "string") {
      const m =
        html.data.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
        html.data.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i);
      if (m?.[1] && !/static\/images\/project-logos/i.test(m[1])) return m[1];
    }
    return null;
  } catch (e) {
    console.error("[page-image]", e.message);
    return null;
  }
}

/** Resolve sister-language article URL via langlinks (EN ↔ DE). */
async function resolveSisterUrl(pageUrl, targetLang, userAgent) {
  const parsed = parseWikiUrl(pageUrl);
  if (!parsed || parsed.lang === targetLang) return null;
  try {
    const api = `https://${parsed.lang}.wikipedia.org/w/api.php`;
    const { data } = await axios.get(api, {
      timeout: 15000,
      headers: { "User-Agent": userAgent },
      params: {
        action: "query",
        titles: parsed.title,
        prop: "langlinks",
        lllang: targetLang,
        lllimit: 1,
        redirects: 1,
        format: "json",
        origin: "*",
      },
    });
    const page = Object.values(data?.query?.pages || {})[0];
    const ll = page?.langlinks?.[0];
    if (!ll?.["*"]) return null;
    const sisterTitle = encodeURIComponent(String(ll["*"]).replace(/ /g, "_")).replace(/%2F/gi, "/");
    return `https://${targetLang}.wikipedia.org/wiki/${sisterTitle}`;
  } catch (e) {
    console.error("[page-image] langlink", e.message);
    return null;
  }
}

/**
 * Prefer EN image, then DE (or vice versa depending on args).
 * If only one side is known, resolve the other via langlinks and try that too.
 */
async function fetchBestImage(enUrl, deUrl, userAgent) {
  const tried = new Set();

  async function tryUrl(url) {
    if (!url || tried.has(url)) return null;
    tried.add(url);
    return fetchPageImage(url, userAgent);
  }

  // Normalize: if caller swapped / passed a DE url as enUrl, sort by host
  let en = enUrl || null;
  let de = deUrl || null;
  for (const u of [enUrl, deUrl].filter(Boolean)) {
    if (/de\.wikipedia/i.test(u)) de = de || u;
    else if (/en\.wikipedia/i.test(u)) en = en || u;
  }

  let img = (await tryUrl(en)) || (await tryUrl(de));
  if (img) return img;

  // Cross-wiki: EN missing → try DE sister; DE missing → try EN sister
  if (en && !de) {
    de = await resolveSisterUrl(en, "de", userAgent);
    img = await tryUrl(de);
    if (img) return img;
  }
  if (de && !en) {
    en = await resolveSisterUrl(de, "en", userAgent);
    img = await tryUrl(en);
    if (img) return img;
  }

  return null;
}

module.exports = { fetchPageImage, fetchBestImage, resolveSisterUrl };
