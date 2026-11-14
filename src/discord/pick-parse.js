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
 * @returns {{ names: string[], error?: string, duplicates: string[] }}
 */
function parsePickList(text) {
  if (!text || !String(text).trim()) {
    return { names: [], error: "Keine Namen erkannt." };
  }
  const tokens = splitBySeparators(text);
  const names = [];
  const duplicates = [];
  const seen = new Set();
  for (const t of tokens) {
    const k = nameKey(t);
    if (!k) continue;
    if (seen.has(k)) {
      duplicates.push(t);
      continue;
    }
    seen.add(k);
    names.push(t);
  }
  return { names, duplicates };
}

module.exports = { parsePickList, nameKey };
