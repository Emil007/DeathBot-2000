/**
 * Log-Kanal-Helfer.
 *
 * Schreibt Eingaben, Änderungen und Fehler (inkl. technischer Details) in einen
 * konfigurierbaren Discord-Kanal (CHANNEL_LOG). Ausdrücklich KEINE Logs über die
 * Wiki-Scan-Runs (Poll-Läufe, Scrape-Zähler) — die bleiben auf stdout.
 *
 * Verhalten:
 * - CHANNEL_LOG leer oder Kanal nicht erreichbar: console.warn und zurückkehren —
 *   der Aufrufer läuft immer weiter (Failsafe wie sendAdmin).
 * - In-Memory-Queue mit einem Consumer und Mindestabstand, damit ein Fehlersturm
 *   das Gateway nicht mit Discord-Rate-Limits trifft.
 * - scrub() entfernt Tokens/Secrets aus Nachricht und Stack.
 * - kind === "scan" wird verworfen (Regel: keine Scan-Logs im Logkanal).
 */
const { EmbedBuilder } = require("discord.js");

const QUEUE_INTERVAL_MS = 1000;
let queue = [];
let consumerRunning = false;
const warnedOnce = new Set();
let safeTextCache = null;

function isMissingModule(err, request) {
  if (!err || err.code !== "MODULE_NOT_FOUND") return false;
  const first = String(err.message || "").split("\n")[0];
  return first.includes(request);
}

// Vertrag von M1 (src/discord/safe-text.js). Nur wenn das Modul in diesem
// Workspace noch fehlt — nach dem Merge gewinnt der echte Export.
function fallbackSanitizeDisplayName(raw) {
  let s = String(raw ?? "");
  s = s.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ");
  s = s.replace(/[*_~|`<>@\[\]()]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || "Unbenannt";
}

function safeText() {
  if (safeTextCache) return safeTextCache;
  let mod = null;
  try {
    mod = require("./safe-text");
  } catch (e) {
    if (!isMissingModule(e, "./safe-text")) throw e;
  }
  if (mod) {
    if (typeof mod.sanitizeDisplayName !== "function" || typeof mod.mentionOpts !== "function") {
      throw new Error("src/discord/safe-text.js must export sanitizeDisplayName and mentionOpts");
    }
    safeTextCache = mod;
    return safeTextCache;
  }
  safeTextCache = {
    sanitizeDisplayName: fallbackSanitizeDisplayName,
    mentionOpts() {
      return { allowedMentions: { parse: [] } };
    },
  };
  return safeTextCache;
}

/**
 * Log-Summaries dürfen Roh-Namen enthalten (`raw_name`, Display-Name, `<@id>`).
 * Jeder solche Abschnitt geht durch sanitizeDisplayName (eine Zeile, keine
 * Mention-/Markdown-Zeichen). Der umgebende Satz bleibt stehen.
 */
function sanitizeLogSummary(summary) {
  const { sanitizeDisplayName } = safeText();
  const flat = String(summary ?? "")
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  if (!/[*_~|`<>@\[\]()]/.test(flat)) return flat;
  const parts = flat.split(/(\s*→\s*|:\s*|\(|\))/);
  const out = parts
    .map((part) => {
      if (!part) return "";
      if (part === "(" || part === ")" || /^\s*→\s*$/.test(part) || /^:\s*$/.test(part)) return part;
      if (/[*_~|`<>@\[\]()]/.test(part)) return sanitizeDisplayName(part);
      return part;
    })
    .join("");
  return out.replace(/\s+/g, " ").trim();
}

function scrubText(text, config) {
  let s = String(text ?? "");
  const secrets = new Set();
  if (config?.token && String(config.token).length >= 8) secrets.add(String(config.token));
  if (process.env.TOKEN && String(process.env.TOKEN).length >= 8) secrets.add(String(process.env.TOKEN));
  for (const secret of secrets) s = s.split(secret).join("[REDACTED]");
  return s.replace(
    /\b(mfa\.[A-Za-z0-9_-]{80,}|[A-Za-z0-9_-]{20,26}\.[\w-]{5,}\.[\w-]{30,40})\b/g,
    "[REDACTED]"
  );
}

async function drain() {
  consumerRunning = true;
  while (queue.length) {
    const item = queue.shift();
    const target = await item.client.channels.fetch(item.config.channelLog).catch(() => null);
    if (!target?.isTextBased?.(false)) {
      const key = "no-channel";
      if (!warnedOnce.has(key)) {
        warnedOnce.add(key);
        console.warn("[log] CHANNEL_LOG nicht erreichbar — Log-Events entfallen.");
      }
      continue;
    }
    try {
      await target.send({
        content: item.content || null,
        embeds: item.embeds && item.embeds.length ? item.embeds : undefined,
        ...safeText().mentionOpts(),
      });
    } catch (e) {
      console.warn("[log] send failed", e.message);
    }
    if (queue.length) await new Promise((r) => setTimeout(r, QUEUE_INTERVAL_MS));
  }
  consumerRunning = false;
}

function enqueue(client, config, { kind, content, embeds }) {
  if (kind === "scan") return;
  if (!config?.channelLog) return; // leeres CHANNEL_LOG = No-Op, Bot bleibt startbar
  queue.push({ client, config, kind, content, embeds });
  if (!consumerRunning) drain().catch((e) => console.warn("[log] drain failed", e.message));
}

function buildErrorEmbed(err, { where, userId, config } = {}) {
  const scrubbed = scrubText(err && err.stack ? err.stack : String(err), config);
  const message = scrubText(String(err?.message || err || "Unbekannter Fehler"), config);
  let stack = err && err.stack ? scrubbed : "";
  const status = err?.response?.status ?? err?.status;
  const code = err?.code ?? err?.rawError?.code;
  const lines = [
    `**Wo:** ${where || "?"}`,
    userId ? `**User:** ${userId}` : null,
    status ? `**HTTP:** ${status}` : null,
    code ? `**Code:** ${code}` : null,
    "",
    `\`\`\`\n${message.slice(0, 1500)}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n");
  const embed = new EmbedBuilder()
    .setColor(0xd0342c)
    .setTitle("Fehler")
    .setDescription(lines.slice(0, 1800))
    .setTimestamp(new Date());
  if (stack) embed.addFields({ name: "Stack", value: `\`\`\`\n${stack.slice(0, 1500)}\n\`\`\`` });
  return embed;
}

/**
 * Logge ein Ereignis (Eingabe/Änderung) in den Logkanal.
 * kind === "scan" wird verworfen.
 */
async function logEvent(client, config, { kind, summary, userId, detail }) {
  if (kind === "scan") return;
  if (!config?.channelLog) return;
  const parts = [
    `**${kind}**`,
    userId ? `(User ${userId})` : null,
    sanitizeLogSummary(scrubText(summary, config)),
    detail ? `\`\`\`\n${scrubText(detail, config).slice(0, 1400)}\n\`\`\`` : null,
  ].filter(Boolean);
  enqueue(client, config, { kind, content: parts.join(" ") });
}

/** Logge einen Fehler inkl. Stack + HTTP-Status in den Logkanal. */
async function logError(client, config, err, { where, userId } = {}) {
  if (!err) return;
  if (!config?.channelLog) return;
  const canonErr = err && typeof err === "object" ? err : new Error(String(err));
  enqueue(client, config, {
    kind: "error",
    embeds: [buildErrorEmbed(canonErr, { where, userId, config })],
  });
}

/** Für Tests: Queue leeren und Zustand zurücksetzen. */
function _resetForTest() {
  queue = [];
  consumerRunning = false;
  warnedOnce.clear();
  safeTextCache = null;
}

module.exports = { logEvent, logError, scrubText, _resetForTest };
