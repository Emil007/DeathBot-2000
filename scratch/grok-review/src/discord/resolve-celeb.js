const db = require("../db");

/** Parse trailing celeb name from args; returns { celeb, rest } or { error } */
function resolveCelebArgs(args) {
  if (!args.length) return { error: "Missing celebrity name." };
  // Try longest suffix match: join all, then peel from left
  for (let i = 0; i < args.length; i++) {
    const name = args.slice(i).join(" ");
    const found = db.findCelebByName(name);
    if (found.length === 1) {
      return { celeb: found[0], rest: args.slice(0, i) };
    }
    if (found.length > 1 && i === 0) {
      return {
        error:
          "Ambiguous name:\n" + found.map((c) => `• ${c.name} (id ${c.id})`).join("\n"),
      };
    }
  }
  // Prefer: celeb is everything except last tokens for term — try first N as name
  for (let len = args.length; len >= 1; len--) {
    const name = args.slice(0, len).join(" ");
    const found = db.findCelebByName(name);
    if (found.length === 1) {
      return { celeb: found[0], rest: args.slice(len) };
    }
    if (found.length > 1) {
      return {
        error:
          "Ambiguous name:\n" + found.map((c) => `• ${c.name} (id ${c.id})`).join("\n"),
      };
    }
  }
  return { error: `Celebrity not found: ${args.join(" ")}` };
}

module.exports = { resolveCelebArgs };
