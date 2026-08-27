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

Durable files live under the data mount: database, backups, optional custom phrases, restore packages.

---

## What it does

- Tracks each player’s celebrity list for the season
- Scores hits as **100 − age** (age at season start; minimum 1). Sheet “points” columns are ignored
- Announces deathpool hits with a Wikipedia portrait, a dark line, scores, and winner @mentions
- Optionally announces every new Wikipedia death (English first, then German-only leftovers)
- Daily “new since yesterday” summary (configurable hour)
- Late-start safe: `!go` silently catches up history **before** going live (no Channel A spam)
- Can retract a live hit if the person drops off Wikipedia death lists within a confirmation window (default 7 days). It does **not** auto-unkill someone who is still listed after 7 days — that window only locks the hit in

Ambiguous names: prefer wiki link-title matches; otherwise name tokens with particles like *van* / *de* / *bin* stripped. For stubborn false positives use AKA, blacklist, or exclude (below).

---

## Season workflow

### New season or late join

1. **Start a season** (setup — no public announcements yet):

   ```
   !new-year confirm
   !new-year confirm 2026-01-01
   ```

   The date is the season start. List ages should be as of that day.

2. **Import each player’s list** (replaces that player’s picks for the season):

   ```
   !import @User
   ```

   Paste a spreadsheet (tab-separated). You can send **several messages**, then `done`, or upload a `.tsv` / `.csv` / `.txt` file.  
   Required: **Name**, **Alter**. Optional: description, death date (`28.02.2026` or `YYYY-MM-DD`).

3. **Optional silent check**

   ```
   !check
   ```

   Same catch-up as step 4’s first phase. Summary by DM.

4. **Go live** (auto-reconciles even if you skipped `!check`):

   ```
   !go
   ```

   Runs a full-year silent reconcile, seeds all-deaths so history is not dumped, then turns announcements on.

### During the year

The bot polls recent Wikipedia months on an interval. Force a live poll with `!check`.

Year end: `!new-year confirm [YYYY-MM-DD]` writes a backup package, then starts a fresh season in setup mode.

---

## Commands

### Everyone

| Command | What it does |
|---------|----------------|
| `!liste` / `!mylist` | Your picks (prefers DM) |
| `!scores` | Leaderboard |
| `!celeb Name` | Lookup (shows AKA / blacklist / exclude) |
| `!help` | Command list |

### Admin — season & lists

| Command | What it does |
|---------|----------------|
| `!import @User` | Replace that user’s list (multi-paste or file) |
| `!check` | Setup: silent reconcile. Live: poll now |
| `!go` | Silent reconcile → seed all-deaths → live |
| `!season` / `!season YYYY-MM-DD` | Status / set start date |
| `!new-year confirm [date]` | Backup + new season (setup) |
| `!unlink @User` | Clear that user’s picks for the active season |

### Admin — false positives

| Command | What it does |
|---------|----------------|
| `!aka Name Alias…` / `!aka list Name` / `!unaka …` | Aliases for matching |
| `!blacklist Name term…` / `!blacklist list Name` / `!unblacklist …` | Block match when all term words appear |
| `!exclude Name` / `!include Name` | Stop / resume auto wiki matching |

Without blacklist/exclude, a bad match can be `!resurrect`ed and then killed again on the next poll.

### Admin — scoring & misc

| Command | What it does |
|---------|----------------|
| `!kill Name` / `!resurrect Name` | Manual death / undo (reverses points) |
| `!add-points` / `!set-points` | Adjust base points |
| `!bonus list` / `define` / `award` / `revoke` | Bonus definitions and awards |
| `!players` | List players |
| `!restore` / `!restore confirm file.zip` | Restore a backup package |

Admin commands work in a server channel or in a DM with the bot.

---

## Backups and restore

- Automatic backups under `data/backups/`
- `!new-year` also writes a season package there
- Restore: put a `.zip` in `data/restore/` (or use a backups name), then `!restore confirm filename.zip`

---

## Custom phrases

Optional: `data/custom_phrases.txt` (one line per phrase).  
Placeholders: `{name}` `{age}` `{score}` `{winners}` `{losers}`

`CUSTOM_PHRASES`: `no` (default) · `mix` · `only`

---

## Settings (`environment` in compose)

| Setting | Purpose |
|---------|---------|
| `TOKEN` | Bot token |
| `ADMIN_ID` | Admin Discord user id |
| `CHANNEL_DEATHPOOL` | Deathpool announcements |
| `CHANNEL_ALL_DEATHS` | Optional all-deaths (empty = off) |
| `PREFIX` | Default `!` |
| `WIKI_POLLER_MINUTES` | Default `30` |
| `DAILY_SUMMARY_HOUR` | Default `9` |
| `DEATH_CONFIRM_DAYS` | Days a live hit stays retractable if it leaves wiki lists (default `7`) |
| `CUSTOM_PHRASES` | `no` / `mix` / `only` |
| `TZ` | Timezone for the daily summary |
| `DATA_DIR` | Default `/app/data` |

---

## Scoring note

Points always use **age at season start**: `max(1, 100 − age)`.  
If two imports disagree on age, the **first** stored age wins (admin gets a warning). Wikipedia’s age at death is comparison-only in messages.
