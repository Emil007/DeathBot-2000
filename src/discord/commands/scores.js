const db = require("../../db");
const { sendChunks, chunkLines } = require("./liste");

const HEADER = "📊 **Rangliste** — wer richtig gelegen hat";
const EMPTY = "Noch keine Spieler mit Picks. Die Tafel ist leer.";

function num(v, fallback = 0) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRow(row) {
  const p = row?.player && typeof row.player === "object" ? row.player : row || {};
  return {
    id: p.id ?? row.id,
    display_name: p.display_name ?? row.display_name ?? row.name ?? "",
    discord_user_id: String(p.discord_user_id ?? row.discord_user_id ?? ""),
    total: num(row.total ?? row.points ?? p.total ?? p.points ?? p.base_points),
    pickCount: num(row.pickCount ?? row.pick_count ?? p.pickCount ?? p.pick_count),
  };
}

function fallbackScoreboard() {
  const season = db.getActiveSeason();
  return db
    .getDb()
    .prepare(
      `SELECT
         p.id,
         p.display_name,
         p.discord_user_id,
         p.base_points,
         (
           p.base_points + COALESCE((
             SELECT SUM(b.points * pb.times)
             FROM player_bonuses pb
             INNER JOIN bonuses b ON b.id = pb.bonus_id
             WHERE pb.player_id = p.id
           ), 0)
         ) AS total,
         (
           SELECT COUNT(*)
           FROM picks pk
           WHERE pk.player_id = p.id AND pk.season_id = ?
         ) AS pick_count
       FROM players p
       ORDER BY total DESC, p.display_name COLLATE NOCASE`
    )
    .all(season.id);
}

function readScoreboard() {
  const raw = typeof db.listScoreboard === "function" ? db.listScoreboard() : fallbackScoreboard();
  const list = Array.isArray(raw) ? raw : [];
  return list.map(normalizeRow).filter((r) => r.discord_user_id);
}

const cmd = {
  name: "scores",
  aliases: ["score", "scoreboard"],
  admin: false,
  group: "everyone",
  description: "Rangliste: wer richtig gelegen hat",
  usage: "/scores\n{prefix}scores",
  examples: ["/scores", "{prefix}scores"],
  parseSlash() {
    return [];
  },
  async run(ctx, args, msg) {
    const rows = readScoreboard().filter((p) => p.pickCount > 0);
    if (!rows.length) {
      await sendChunks(msg, [EMPTY]);
      return;
    }
    const lines = rows.map(
      (p, i) =>
        `**${i + 1}.** <@${p.discord_user_id}> — **${p.total}** Punkte (${p.pickCount} Picks)`
    );
    await sendChunks(msg, chunkLines(`${HEADER}\n`, lines));
  },
};

module.exports = cmd;
module.exports.readScoreboard = readScoreboard;
module.exports.HEADER = HEADER;
module.exports.EMPTY = EMPTY;
