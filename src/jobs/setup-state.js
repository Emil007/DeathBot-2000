/**
 * Offene Kanal-Setup-Frage, pro Saison-Id.
 *
 * Kein Import von year-rollover.js oder channel-setup.js (kein Kreis).
 * M6 liest und schreibt nur über diese Funktionen.
 */

const open = new Map();

function keyOf(seasonId) {
  return String(seasonId);
}

function markOpen(seasonId, data) {
  const id = keyOf(seasonId);
  const src = data && typeof data === "object" ? data : {};
  const offered =
    src.offeredChannelIds instanceof Set
      ? src.offeredChannelIds
      : new Set(src.offeredChannelIds || []);
  open.set(id, {
    ...src,
    components: src.components || [],
    offeredChannelIds: offered,
    year: src.year,
    deciding: false,
  });
  return open.get(id);
}

function getOpen(seasonId) {
  return open.get(keyOf(seasonId)) || null;
}

function isAnyOpen() {
  return open.size > 0;
}

function clearOpen(seasonId) {
  open.delete(keyOf(seasonId));
}

/**
 * Verschiebt den Eintrag, wenn die aktive Saison während der Frage gewechselt hat.
 * Ohne Eintrag unter der alten Id: no-op.
 */
function retarget(oldSeasonId, newSeasonId) {
  const oldId = keyOf(oldSeasonId);
  const newId = keyOf(newSeasonId);
  if (!open.has(oldId)) return null;
  if (oldId === newId) return open.get(newId);
  const entry = open.get(oldId);
  open.delete(oldId);
  open.set(newId, entry);
  return entry;
}

/** Synchron. false, wenn kein Eintrag oder schon deciding. */
function tryBeginDecide(seasonId) {
  const entry = open.get(keyOf(seasonId));
  if (!entry || entry.deciding) return false;
  entry.deciding = true;
  return true;
}

/** deciding zurücknehmen. Der Eintrag bleibt. */
function abortDecide(seasonId) {
  const entry = open.get(keyOf(seasonId));
  if (!entry) return;
  entry.deciding = false;
}

module.exports = {
  markOpen,
  getOpen,
  isAnyOpen,
  clearOpen,
  retarget,
  tryBeginDecide,
  abortDecide,
};
