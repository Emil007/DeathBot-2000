function uniqueCommands(commands) {
  const out = [];
  const seen = new Set();
  for (const cmd of commands.values()) {
    if (cmd._aliasOf) continue;
    if (seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    out.push(cmd);
  }
  return out;
}

function usageReply(cmd, config) {
  const p = config?.prefix || "!";
  const lines = ["So geht’s:"];
  if (cmd.usage) {
    lines.push(cmd.usage.replaceAll("{prefix}", p));
  } else {
    lines.push(`\`${p}${cmd.name}\``);
  }
  const ex = (cmd.examples || [])[0];
  if (ex) lines.push(`Beispiel: \`${ex.replaceAll("{prefix}", p)}\``);
  return lines.join("\n");
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function suggestCommands(query, commands, { admin = false, limit = 3 } = {}) {
  const q = String(query || "").toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const cmd of uniqueCommands(commands)) {
    if (cmd.admin && !admin) continue;
    const names = [cmd.name, ...(cmd.aliases || [])];
    let best = Infinity;
    for (const n of names) {
      const d = levenshtein(q, n.toLowerCase());
      if (d < best) best = d;
      if (n.toLowerCase().startsWith(q) || q.startsWith(n.toLowerCase())) {
        best = Math.min(best, 1);
      }
    }
    if (best <= Math.max(3, Math.floor(q.length / 2))) {
      scored.push({ name: cmd.name, dist: best });
    }
  }
  scored.sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

module.exports = { uniqueCommands, usageReply, suggestCommands, levenshtein };
