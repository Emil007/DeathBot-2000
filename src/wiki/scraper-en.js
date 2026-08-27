const axios = require("axios");
const cheerio = require("cheerio");

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function createClient(userAgent) {
  return axios.create({
    timeout: 30000,
    headers: { "User-Agent": userAgent },
  });
}

async function scrapeUrl(client, url) {
  try {
    const response = await client.get(url);
    const $ = cheerio.load(response.data);
    const entries = [];
    $(".mw-parser-output ul li").each((_, el) => {
      const $el = $(el);
      if ($el.parents("#toc, .mw-headline, .navbox").length > 0) return;
      const href = $el.find("a").first().attr("href");
      if (href && href.startsWith("/wiki/") && !href.includes(":")) {
        const text = $el.text().replace(/\[\d+\]/g, "").trim();
        entries.push({
          id: `en:${href}`,
          wikiPath: href,
          text,
          url: `https://en.wikipedia.org${href}`,
          lang: "en",
        });
      }
    });
    return entries;
  } catch (e) {
    console.error("[wiki-en]", url, e.message);
    return [];
  }
}

async function scrapeEn(userAgent) {
  const client = createClient(userAgent);
  const year = new Date().getFullYear();
  const monthIndex = new Date().getMonth();
  const urls = [`https://en.wikipedia.org/wiki/Deaths_in_${year}`];
  for (let i = 0; i <= monthIndex; i++) {
    urls.push(`https://en.wikipedia.org/wiki/Deaths_in_${MONTHS[i]}_${year}`);
  }
  const results = await Promise.all(urls.map((u) => scrapeUrl(client, u)));
  const seen = new Set();
  const unique = [];
  for (const e of results.flat()) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      unique.push(e);
    }
  }
  return unique;
}

module.exports = { scrapeEn };
