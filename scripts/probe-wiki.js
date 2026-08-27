const axios = require("axios");
const cheerio = require("cheerio");

const ua =
  "DeathBot-2000/1.0 (test; +https://github.com/Emil007/DeathBot-2000)";

async function probe(url) {
  const r = await axios.get(url, { headers: { "User-Agent": ua }, timeout: 30000 });
  const $ = cheerio.load(r.data);
  const redirectA = $(".redirectText a, .redirectMsg a").first().attr("href");
  const soft = $("#softredirect a").first().attr("href");
  const lis = $(".mw-parser-output > ul > li, .mw-parser-output ul > li").length;
  const tables = $(".mw-parser-output table").length;
  console.log(
    JSON.stringify({
      url: url.split("/wiki/")[1],
      lis,
      tables,
      redirectA,
      soft,
      title: $("h1").first().text().trim().slice(0, 60),
    })
  );
}

(async () => {
  for (const u of [
    "https://en.wikipedia.org/wiki/Deaths_in_2026",
    "https://en.wikipedia.org/wiki/Deaths_in_August_2026",
    "https://en.wikipedia.org/wiki/Deaths_in_January_2026",
    "https://de.wikipedia.org/wiki/Nekrolog_2026",
    "https://de.wikipedia.org/wiki/Nekrolog_August_2026",
    "https://de.wikipedia.org/wiki/Nekrolog_Januar_2026",
  ]) {
    try {
      await probe(u);
    } catch (e) {
      console.log(u, e.response?.status || e.message);
    }
  }
})();
