# DeathBot-2000

A Discord bot for celebrity death-pool games. It watches Wikipedia death lists, keeps score for your group’s picks, and posts updates when someone on the list dies.

## What you need

1. A Discord bot token with **Message Content Intent** enabled
2. A Discord server where the bot can read and send messages
3. Channel IDs:
   - **Deathpool channel** — when a picked celebrity dies (pings winners only)
   - **All-deaths channel** (optional) — every newly listed Wikipedia death (never pings)
4. Your Discord user ID as admin
5. Docker (published image) or Node 20+ from source

Copy `docker-compose.yml`, fill in the `environment:` values (no `.env` file), mount `./data`, then:

```bash
docker compose pull
docker compose up -d
```

Image: `ghcr.io/emil007/deathbot-2000:latest`

---

## What it does

- One **celeb row per person** (identity = confirmed Wikipedia URL when set); players share via picks
- After import: **wiki/age review** with Discord buttons before auto-matching
- Scores hits as **100 − age at season start** (wiki birth date preferred; sheet age is a hint)
- Deathpool announcements with portrait, dark Death-voice line, scores, winner @mentions
- Optional all-deaths channel (no pings)
- Frequent polls = **recent months** for near-realtime; **nightly full-year scrape** catches late edits on older month pages and runs retract checks safely
- Late-start safe: `!go` silent-reconciles before live
- Retract window (`DEATH_CONFIRM_DAYS`): undoes a hit **only if** the person leaves the wiki death lists within that window — not an auto-unkill while still listed

---

## Season workflow

1. `!new-year confirm 2026-01-01` — setup mode, season start date  
2. `!import @User` — paste sheet chunks, finish with **`done`** (or upload a file). Replaces that player’s picks.  
3. **Review queue** (DM/buttons): Confirm · Wrong link · Set age · No wiki (manual only) · Skip  
   - Until confirmed, celebs are **not** auto-matched  
   - Same person on another list reuses the existing celeb row  
4. `!go` — silent full-year catch-up → seed all-deaths → live  

Optional: `!check` before `!go`. Resume review anytime with `!review`.

---

## Commands

### Everyone

| Command | What it does |
|---------|----------------|
| `!liste` / `!mylist` | Your picks |
| `!scores` | Leaderboard |
| `!celeb Name` | Lookup |
| `!help` | Help |

### Admin — season & lists

| Command | What it does |
|---------|----------------|
| `!import @User` | Replace list (multi-message until `done`, or file) + queue review |
| `!review` | Resume wiki/age review queue |
| `!wiki Name <url\|none>` | Set/replace Wikipedia link, or manual-only |
| `!age Name N` | Override age (blocked if death awards already exist) |
| `!check` / `!go` / `!season` / `!new-year` / `!unlink` | As before |

### Admin — false positives

| Command | What it does |
|---------|----------------|
| `!aka` / `!unaka` / `!blacklist` / `!unblacklist` | Aliases / block terms |
| `!exclude` / `!include` | Stop / resume auto match |

### Admin — scoring

`!kill` / `!resurrect` / `!add-points` / `!set-points` / `!bonus` / `!players` / `!restore`

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
| `CHANNEL_ALL_DEATHS` | Optional all-deaths |
| `WIKI_POLLER_MINUTES` | Recent-month poll interval (default `30`) |
| `NIGHTLY_FULL_SCRAPE_HOUR` | Full-year scrape hour (default `3`) |
| `DAILY_SUMMARY_HOUR` | Daily digest hour (default `9`) |
| `DEATH_CONFIRM_DAYS` | Retract window if off wiki lists (default `7`) |
| `CUSTOM_PHRASES` | `no` / `mix` / `only` |
| `TZ` | Timezone for cron jobs |

---

## Scoring

`max(1, 100 − age_at_pick)`.  
After wiki confirm, age comes from birth date + season start when available. Sheet “Punkte” ignored. Manual-only celebs never auto-kill — use `!kill` or sheet death dates.
