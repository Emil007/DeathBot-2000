/**
 * Tipp-Liste parsen (Selbstbedienung per PM).
 *
 * Trenner:
 * - Zeilenumbruch trennt immer.
 * - Innerhalb einer Zeile: `;`, ` – `, ` — `, ` - ` (Bindestrich NUR mit Leerzeichen beiderseits).
 * - Komma und Binnen-Bindestrich trennen NICHT (Müller, Hans bleibt ein Name; Jean-Luc bleibt ein Name).
 *
 * Eigenschaften:
 * - Leere Tokens werden verworfen.
 * - Doppelte Namen in derselben Paste (nach nameKey) werden zusammengelegt und gemeldet.
 */

/** Normalisierter Schlüssel für Duplikat-Erkennung in derselben Paste. */
function nameKey(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function splitBySeparators(text) {
  const t = String(text || "");
  // Zeilen, dann in Zeilen an ; und Dash-mit-Space trennen
  const tokens = [];
  for (const line of t.split(/\n+/)) {
    const parts = line
      .split(/;\s*|(?<=[–—])\s|\s+[-–—]\s+/u)
      .map((s) => s.replace(/^[;\s\-–—]+|[;\s\-–—]+$/g, "").trim())
      .filter(Boolean);
    tokens.push(...parts);
  }
  return tokens;
}

/**
 * @param {string} text
 * @param {{ maxNames?: number }} [opts] maxNames: Karten-Obergrenze pro Einreichung
 *   (Default 50; steuerbar via MAX_PICKS_PER_PLAYER, gelangt von der DM hierhin).
 * @returns {{ names: string[], error?: string, duplicates: string[], truncated?: boolean }}
 */
function parsePickList(text, opts = {}) {
  if (!text || !String(text).trim()) {
    return { names: [], error: "Keine Namen erkannt." };
  }
  const tokens = splitBySeparators(text);
  const names = [];
  const duplicates = [];
  const seen = new Set();
  // Maximale Kartenzahl pro Spieler: 50 (Default). Mehr Namen in einer Paste
  // werden sauber gekappt (auf die Obergrenze), Discord-fähig. Als Env
  // MAX_PICKS_PER_PLAYER übersteuerbar.
  const MAX_NAMES = Number.isFinite(Number(opts.maxNames)) ? Number(opts.maxNames) : 50;
  for (const t of tokens) {
    const k = nameKey(t);
    if (!k) continue;
    if (seen.has(k)) {
      duplicates.push(t);
      continue;
    }
    if (names.length >= MAX_NAMES) {
      return { names, duplicates, truncated: true };
    }
    seen.add(k);
    names.push(t);
  }
  return { names, duplicates };
}

module.exports = { parsePickList, nameKey };
