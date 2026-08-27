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
        format: "json",
        pithumbsize: 800,
        origin: "*",
      },
    });
    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    return page?.thumbnail?.source || page?.original?.source || null;
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
