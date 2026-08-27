const path = require("path");

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

function loadConfig() {
  const dataDir = optional("DATA_DIR", path.join(process.cwd(), "data"));
  const customPhrases = optional("CUSTOM_PHRASES", "no").toLowerCase();
  if (!CUSTOM_MODES.has(customPhrases)) {
    throw new Error(`CUSTOM_PHRASES must be one of: no, mix, only (got ${customPhrases})`);
  }

  return {
    token: required("TOKEN"),
    prefix: optional("PREFIX", "!"),
    adminId: required("ADMIN_ID"),
    channelDeathpool: required("CHANNEL_DEATHPOOL"),
    channelAllDeaths: optional("CHANNEL_ALL_DEATHS", ""),
    wikiPollerMinutes: intEnv("WIKI_POLLER_MINUTES", 30),
    dailySummaryHour: intEnv("DAILY_SUMMARY_HOUR", 9),
    dataDir,
    dbPath: path.join(dataDir, "deathbot.sqlite"),
    customPhrasesPath: path.join(dataDir, "custom_phrases.txt"),
    backupsDir: path.join(dataDir, "backups"),
    restoreDir: path.join(dataDir, "restore"),
    customPhrasesMode: customPhrases,
    alertEmoji: optional("ALERT_EMOJI", "⚰️"),
    alertEmojiRepeat: intEnv("ALERT_EMOJI_REPEAT", 3),
    deathConfirmDays: intEnv("DEATH_CONFIRM_DAYS", 7),
    userAgent: optional(
      "USER_AGENT",
      "DeathBot-2000/1.0 (Discord death pool bot; +https://github.com/Emil007/DeathBot-2000)"
    ),
  };
}

module.exports = { loadConfig };
