const axios = require("axios");
const cheerio = require("cheerio");

(async () => {
  const url = "https://de.wikipedia.org/wiki/Sam_Neill";
  const r = await axios.get(url, {
    headers: { "User-Agent": "DeathBot-2000/1.0 (test)" },
    timeout: 20000,
  });
  const $ = cheerio.load(r.data);
  const href =
    $("li.interlanguage-link.interwiki-en a").attr("href") ||
    $('a[lang="en"][hreflang="en"]').attr("href") ||
    $('a[lang="en"]').attr("href") ||
    $(".interlanguage-link-en a").attr("href");
  console.log("en-href", href);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
