const axios = require("axios");

async function fetchPageImage(pageUrl, userAgent) {
  try {
    const u = new URL(pageUrl);
    const lang = u.hostname.startsWith("de.") ? "de" : "en";
    const title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, ""));
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

    // Fallback: HTML og:image (some DE bios lack pageimages)
    const html = await axios.get(pageUrl, {
      timeout: 15000,
      headers: { "User-Agent": userAgent },
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (typeof html.data === "string") {
      const m =
        html.data.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
        html.data.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i);
      if (m?.[1]) return m[1];
    }
    return null;
  } catch (e) {
    console.error("[page-image]", e.message);
    return null;
  }
}

async function fetchBestImage(enUrl, deUrl, userAgent) {
  if (enUrl) {
    const img = await fetchPageImage(enUrl, userAgent);
    if (img) return img;
  }
  if (deUrl) {
    const img = await fetchPageImage(deUrl, userAgent);
    if (img) return img;
  }
  return null;
}

module.exports = { fetchPageImage, fetchBestImage };
