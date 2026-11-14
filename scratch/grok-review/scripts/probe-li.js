const axios = require("axios");
const cheerio = require("cheerio");

const ua =
  "DeathBot-2000/1.0 (test; +https://github.com/Emil007/DeathBot-2000)";

(async () => {
  const url = "https://en.wikipedia.org/wiki/Deaths_in_2026";
  const response = await axios.get(url, { headers: { "User-Agent": ua }, timeout: 30000 });
  const $ = cheerio.load(response.data);
  let shown = 0;
  $(".mw-parser-output > ul > li, .mw-parser-output ul > li").each((_, el) => {
    if (shown >= 5) return;
    const $el = $(el);
    if ($el.parents("#toc, .navbox").length > 0) return;
    const html = $.html($el).slice(0, 400);
    const anchors = $el
      .find("a")
      .map((i, a) => $(a).attr("href"))
      .get()
      .slice(0, 6);
    const text = $el.text().trim().slice(0, 100);
    if (!text || text.length < 10) return;
    console.log("---");
    console.log("text:", text);
    console.log("hrefs:", anchors);
    console.log("html:", html.replace(/\s+/g, " "));
    shown++;
  });
})();
