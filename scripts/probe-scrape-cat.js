const { scrapeEn } = require("../src/wiki/scraper-en");
const { scrapeDe } = require("../src/wiki/scraper-de");
const { checkUrlDead } = require("../src/wiki/category-death");

const ua =
  "DeathBot-2000/1.0 (test; +https://github.com/Emil007/DeathBot-2000)";

(async () => {
  const en = await scrapeEn(ua, { scope: "recent" });
  const de = await scrapeDe(ua, { scope: "recent" });
  console.log("en", en.length, en[0]?.text?.slice(0, 80));
  console.log("de", de.entries.length, de.entries[0]?.text?.slice(0, 80));
  if (en.length < 50) throw new Error("EN scrape too low");
  if (de.entries.length < 20) throw new Error("DE scrape too low");

  // Living person should be false; known dead if we pick from list
  const living = await checkUrlDead(ua, "https://en.wikipedia.org/wiki/Xi_Jinping");
  console.log("xi dead?", living);

  const sampleDead = en.find((e) => /Mladić|Mladic|Cullen|Curry/i.test(e.text));
  if (sampleDead) {
    const d = await checkUrlDead(ua, sampleDead.url);
    console.log("sample from list", sampleDead.text.slice(0, 60), "cat-dead?", d.dead, d.category);
  }
  console.log("scrape-cat-ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
