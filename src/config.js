const path = require("path");
const { isValidTimeZone } = require("./db/time");

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return String(v).trim();
}

function optional(name, fallback = "") {
  const v = process.env[name];
  return v == null || !String(v).trim() ? fallback : String(v).trim();
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || !String(raw).trim()) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be an integer`);
  return n;
}

const CUSTOM_MODES = new Set(["no", "mix", "only"]);

// Fehlendes TZ ist der Default (Europe/Vienna), kein Fehler. Gesetzt, aber
// leer oder ungültig, wird ernst geloggt und fällt auf Europe/Vienna zurück.
// process.env.TZ wird hier nicht geschrieben.
function resolveTimeZone() {
  const raw = process.env.TZ;
  if (raw == null) return "Europe/Vienna";
  const trimmed = String(raw).trim();
  if (!trimmed) {
    console.error("[config] TZ is empty. Using Europe/Vienna.");
    return "Europe/Vienna";
  }
  if (!isValidTimeZone(trimmed)) {
    console.error(`[config] Invalid time zone "${trimmed}". Using Europe/Vienna.`);
    return "Europe/Vienna";
  }
  return trimmed;
}

// PHRASES_BANK wählt, welche eingebaute Phrasebank geladen wird:
//   new    = src/phrases/builtin-phrases.json      (Standard, die gemeine 241er-Bank)
//   old    = src/phrases/builtin-phrases_old.json  (die bisherige 542er-Bank)
//   custom = nur die data/custom_phrases.txt (CUSTOM_PHRASES=only-äquivalent)
const PHRASES_BANKS = new Set(["new", "old", "custom"]);

function loadConfig() {
  const dataDir = optional("DATA_DIR", path.join(process.cwd(), "data"));
  const customPhrases = optional("CUSTOM_PHRASES", "no").toLowerCase();
  if (!CUSTOM_MODES.has(customPhrases)) {
    throw new Error(`CUSTOM_PHRASES must be one of: no, mix, only (got ${customPhrases})`);
  }
  const phrasesBank = optional("PHRASES_BANK", "new").toLowerCase();
  if (!PHRASES_BANKS.has(phrasesBank)) {
    throw new Error(`PHRASES_BANK must be one of: new, old, custom (got ${phrasesBank})`);
  }

  return {
    token: required("TOKEN"),
    prefix: optional("PREFIX", "!"),
    adminId: required("ADMIN_ID"),
    discordGuildId: optional("DISCORD_GUILD_ID", ""),
    // Seit dem interaktiven Kanal-Setup (src/jobs/channel-setup.js) ist
    // CHANNEL_DEATHPOOL OPTIONAL: Der Deathpool-Kanal wird beim Start
    // automatisch gefunden/angelegt oder per Admin-Frage gewählt. Leer =
    // der Bot startet ohne festes Ziel (Versand dann ohne Ziel, siehe docs).
    channelDeathpool: optional("CHANNEL_DEATHPOOL", ""),
    channelAllDeaths: optional("CHANNEL_ALL_DEATHS", ""),
    channelAdmin: optional("CHANNEL_ADMIN", ""),
    channelLog: optional("CHANNEL_LOG", ""),
    adminRoleId: optional("ADMIN_ROLE_ID", ""),
    wikiPollerMinutes: intEnv("WIKI_POLLER_MINUTES", 30),
    dailySummaryHour: intEnv("DAILY_SUMMARY_HOUR", 9),
    dataDir,
    dbPath: path.join(dataDir, "deathbot.sqlite"),
    customPhrasesPath: path.join(dataDir, "custom_phrases.txt"),
    backupsDir: path.join(dataDir, "backups"),
    restoreDir: path.join(dataDir, "restore"),
    customPhrasesMode: customPhrases,
    phrasesBank,
    alertEmoji: optional("ALERT_EMOJI", "⚰️"),
    alertEmojiRepeat: intEnv("ALERT_EMOJI_REPEAT", 3),
    // Maximale Namen/Karten pro Spieler-Einreichung — der Tipp-Assistent kappt
    // darüber (per Paste). Global über die compose/env steuerbar (Default 50).
    maxPicksPerPlayer: intEnv("MAX_PICKS_PER_PLAYER", 50),
    deathConfirmDays: intEnv("DEATH_CONFIRM_DAYS", 7),
    nightlyFullScrapeHour: intEnv("NIGHTLY_FULL_SCRAPE_HOUR", 3),
    userAgent: optional(
      "USER_AGENT",
      "DeathBot-2000/1.0 (Discord death pool bot; +https://github.com/Emil007/DeathBot-2000)"
    ),
    // Der Wert gilt für Kalender, Crons und, nach applyProcessTimezone, für die
    // Prozesszone. Der Container ist sonst UTC.
    tz: resolveTimeZone(),
  };
}

module.exports = { loadConfig };
