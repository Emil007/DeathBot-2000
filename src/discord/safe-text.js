/**
 * Anzeigenamen für Discord: eine Zeile, ohne Markdown- und Mention-Zeichen.
 * Aufrufer dieses Pakets gibt es noch nicht; spätere Pakete importieren hier.
 */

// Vertragstext: leeres Ergebnis ist genau „Unbenannt“ (U+201E … U+201C).
const UNNAMED = "\u201EUnbenannt\u201C";

const MARKDOWN_MENTION = /[*_~|`<>@()[\]]/g;

function sanitizeDisplayName(raw) {
  let s = raw == null ? "" : String(raw);
  // Steuerzeichen (inkl. CR/LF/TAB) und Unicode-Zeilentrenner ersatzlos weg.
  s = s.replace(/\p{Cc}/gu, "");
  s = s.replace(/[\u2028\u2029]/g, "");
  s = s.replace(MARKDOWN_MENTION, "");
  s = s.replace(/\s+/gu, " ").trim();
  const chars = Array.from(s);
  if (chars.length > 80) s = chars.slice(0, 80).join("").trim();
  return s || UNNAMED;
}

function mentionOpts() {
  return { allowedMentions: { parse: [] } };
}

module.exports = { sanitizeDisplayName, mentionOpts };
