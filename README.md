# DeathBot-2000

A Discord bot for celebrity death-pool games. It watches Wikipedia death lists, keeps score for your group’s picks, and posts updates when someone on the list dies.

**In Discord:** start with **`/help`** (slash is the main UX). Prefix (`!`, configurable) stays as fallback — especially for multi-message paste and “send the wiki URL next”.

## What you need

1. A Discord bot token with **Message Content Intent** enabled
2. A Discord server where the bot can read and send messages
3. Channel IDs:
   - **Deathpool channel** — when a picked celebrity dies (pings winners only)
   - **All-deaths channel** (optional) — every newly listed Wikipedia death (never pings)
4. Your Discord user ID as admin
5. Your **server (guild) ID** as `DISCORD_GUILD_ID` (fast slash registration in that server; commands also register globally so they work in **DMs with the bot**)
6. Docker (published image) or Node 20+ from source

Copy `docker-compose.yml`, fill in the `environment:` values (no `.env` file), mount `./data`, then:

```bash
docker compose pull
docker compose up -d
```

Image: `ghcr.io/emil007/deathbot-2000:latest`

Admin season flow works in a **DM with the bot** (`/…` or `!…`). Announcement channels are only for public posts.

---

## What it does

- One **celeb row per person** (identity = confirmed Wikipedia URL when set); players share via picks
- After import: **wiki/age review** with Discord buttons before auto-matching
- Scores hits as **100 − age at season start** (wiki birth date preferred; sheet age is a hint)
- Deathpool announcements with portrait, dark Death-voice line, scores, winner @mentions
- Optional all-deaths channel (no pings)
- Frequent polls = **recent months** for near-realtime; **nightly full-year scrape** catches late edits on older month pages and runs retract checks safely
- Late-start safe: `/go` silent-reconciles before live
- Retract window (`DEATH_CONFIRM_DAYS`): undoes a hit **only if** the person leaves the wiki death lists within that window — not an auto-unkill while still listed

---

## Season workflow

1. `/new-year confirm:true` (optional `start_date`) — setup mode  
2. `/import user:@Player` — paste sheet chunks, finish with **`done`** (or attach a file). Replaces that player’s picks.  
3. **Review queue** (DM/buttons): Confirm · Wrong link · Set age · No wiki (manual only) · Skip  
4. `/go` — silent full-year catch-up → seed all-deaths → live  

Optional: `/check` before `/go`. Resume review with `/review`.  
Prefix equivalents: `!new-year confirm …`, `!import @User`, `!go`, …

Details for any command: `/help command:import` or `!help import`.

---

## Commands

Use **`/help`** in Discord for the live grouped list. Non-admins only see player commands there.

### Everyone

| Slash | Prefix | What it does |
|-------|--------|----------------|
| `/liste` | `!liste` | Your picks |
| `/scores` | `!scores` | Leaderboard |
| `/celeb` | `!celeb` | Lookup |
| `/help` | `!help` | Help |

### Admin (see `/help` when you’re `ADMIN_ID`)

Season: `/import`, `/review`, `/wiki`, `/age`, `/check`, `/go`, `/season`, `/new-year`, `/unlink`, `/restore`  
Matching: `/aka`, `/blacklist`, `/exclude`, `/include`, `/kill`, `/resurrect`, …  
Points: `/add-points`, `/set-points`, `/bonus`, `/players`

In DMs, if a User option fails, many commands accept a `user_id` snowflake option / argument.

---

## Phrases

Built-in bank is dark first-person Death humor (German).  
For lines too vicious to keep in the image, use:

- `data/custom_phrases.txt` (one line per phrase)  
- `CUSTOM_PHRASES=only` (or `mix`)

Placeholders: `{name}` `{age}` `{score}` `{winners}` `{losers}`

---

## Settings

| Setting | Purpose |
|---------|---------|
| `TOKEN` / `ADMIN_ID` / `CHANNEL_DEATHPOOL` | Required |
| `DISCORD_GUILD_ID` | Guild for instant slash sync (recommended) |
| `CHANNEL_ALL_DEATHS` | Optional all-deaths |
| `PREFIX` | Prefix fallback (default `!`) |
| `WIKI_POLLER_MINUTES` | Recent-month poll interval (default `30`) |
| `NIGHTLY_FULL_SCRAPE_HOUR` | Full-year scrape hour (default `3`) |
| `DAILY_SUMMARY_HOUR` | Daily digest hour (default `9`) |
| `DEATH_CONFIRM_DAYS` | Retract window if off wiki lists (default `7`) |
| `CUSTOM_PHRASES` | `no` / `mix` / `only` |
| `TZ` | Timezone for cron jobs |

---

## Scoring

`max(1, 100 − age_at_pick)`.  
After wiki confirm, age comes from birth date + season start when available. Sheet “Punkte” ignored. Manual-only celebs never auto-kill — use `/kill` or sheet death dates.
