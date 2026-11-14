const deathBrief = require("./death-brief");

const SUFFIX_RE = /\s*\[[a-zA-Z]{2,3}\]\s*$/;

/** nameKey-Analogon ohne Netz — nur für den Namensvergleich Nicht-Mensch vs Mensch.
 *  Nimmt den ersten Komma-Teil („Young L, 39, Rapper“ → „Young L“) + Suffix-Strip. */
function normName(s) {
  const first = String(s || "").split(",")[0] || "";
  return first
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(SUFFIX_RE, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Reine, netzfreie Dedup-Entscheidung VOR dem Posten der All-Deaths-Karten.
 *
 * Eingabe: aufgelöste Entries (Auflösung in wiki-poll.js → fetchDeathBrief).
 * @param {Array<object>} entries Aufzulösende Entries:
 *   { id, lang, url, text, redName, listUrl, resolved: { qid, isHuman, url, pageMissing, error } }
 * @param {{ qids: Set<string>, humanNames: Set<string> }} history
 *   QIDs + Namen der zuletzt geposteten Karten.
 * @returns {{ post: object[], bind: Array<{loserId:string, winnerId:string}>, defer: object[] }}
 */
function planAnnouncements(entries, history) {
  const post = [];
  const bind = [];
  const defer = [];
  const qids = new Set(history?.qids || []);
  const historyNames = new Set([...(history?.humanNames || [])].map((n) => normName(n)));
  const postedHumanNames = new Map(); // normName -> winner entry

  // Auflösungs-Fehler sind KEIN "kein EN": sie werden vertagt (nicht gepostet,
  // nicht gestempelt) und beim nächsten Poll erneut versucht.
  const resolveErrors = entries.filter((e) => e?.resolved?.error);
  defer.push(...resolveErrors);

  // ----- Pass 1: Menschen -----
  // 1a) Mit QID: pro QID eine Karte (EN vor de, nicht-redName vor redName).
  const byQid = new Map();
  for (const e of entries) {
    if (e.resolved?.error) continue;
    if (e.resolved?.qid && e.resolved?.isHuman === true) {
      if (!byQid.has(e.resolved.qid)) byQid.set(e.resolved.qid, []);
      byQid.get(e.resolved.qid).push(e);
    }
  }
  for (const [qid, group] of byQid) {
    if (qids.has(qid)) {
      // historisch schon gepostet — nichts posten; alle stempeln
      for (const e of group) bind.push({ loserId: e.id, winnerId: e.id });
      continue;
    }
    const rank = (e) => {
      let r = 0;
      if (e.lang === "en") r += 100;
      if (!e.redName) r += 10;
      if (e.lang === "en" && e.url && /en\.wikipedia/i.test(e.url)) r += 1;
      return r;
    };
    group.sort((a, b) => rank(b) - rank(a));
    const winner = group[0];
    post.push(winner);
    postedHumanNames.set(normName(deathBrief.personNameFromText(winner.text)), winner);
    for (const e of group.slice(1)) bind.push({ loserId: e.id, winnerId: winner.id });
    qids.add(qid);
  }

  // 1b) Menschen ohne QID: werden gepostet (kein QID-Dedup), Name für Nicht-Mensch-Match merken.
  const soloHumans = [];
  for (const e of entries) {
    if (e.resolved?.error) continue;
    if (e.resolved?.qid && e.resolved?.isHuman === true) continue; // in 1a
    if (e.resolved?.isHuman !== true) continue;
    const nk = normName(deathBrief.personNameFromText(e.text));
    if (nk) postedHumanNames.set(nk, e);
    soloHumans.push(e);
  }
  post.push(...soloHumans);

  // ----- Pass 2: Nicht-Menschen / redName ohne Personenseite -----
  for (const e of entries) {
    if (e.resolved?.error) continue; // schon in defer
    if (e.resolved?.qid && e.resolved?.isHuman === true) continue; // in Pass 1
    if (e.resolved?.isHuman === true) continue; // solo human in 1b
    const nk = normName(deathBrief.personNameFromText(e.text));
    // Regel 4: Nicht-Mensch/redName nur posten, wenn der Name keinem Menschen
    // aus diesem Batch und keinem recentHistory entspricht.
    if (nk && (postedHumanNames.has(nk) || historyNames.has(nk))) {
      const winner = postedHumanNames.get(nk);
      bind.push(winner ? { loserId: e.id, winnerId: winner.id } : { loserId: e.id, winnerId: e.id });
      continue;
    }
    post.push(e);
  }

  return { post, bind, defer };
}

module.exports = { planAnnouncements, normName };
