# DeathBot-2000

A Discord bot for celebrity death-pool games. It watches Wikipedia death lists, keeps score for your group’s picks, and posts updates when someone on the list dies.

## What you need

1. A Discord bot application (token) with **Message Content Intent** enabled
2. A Discord server where the bot can read and send messages
3. Two channel IDs if you want both features:
   - **Deathpool channel** — when a picked celebrity dies (pings the winners)
   - **All-deaths channel** (optional) — every newly listed death on Wikipedia (no pings)
4. Your Discord user ID as admin
5. Docker (to run the published image), or Node 20+ to run from source

Copy `docker-compose.yml`, fill in the environment values (no `.env` file), mount a `./data` folder, then:

```bash
docker compose pull
docker compose up -d
```

Image: `ghcr.io/emil007/deathbot-2000:latest`

Put durable files in the mounted data folder: database, backups, optional custom phrases, restore packages.

---

## What it does

- Tracks each player’s celebrity list for the current season
- Scores hits as **100 − age** (age as of the season start date; minimum 1)
- Announces deathpool hits with a Wikipedia portrait, a dark one-liner, who scored how much, and @mentions for winners
- Optionally announces every new Wikipedia death (English first, then German-only leftovers)
- Posts a daily “new since yesterday” summary (configurable hour)
- Can catch up a season that already started earlier in the year without spamming old announcements
- Can undo a deathpool hit if the person disappears from Wikipedia death lists within a confirmation window (default 7 days)

---

## Season workflow

### New season (or late join)

1. **Start a season** (setup mode — no public announcements yet):

   ```
   !new-year confirm
   !new-year confirm 2026-01-01
   ```

   The date is the season start. Ages in your lists should be as of that day.

2. **Import each player’s list**

   ```
   !import @User
   ```

   Then paste the table from a spreadsheet (tab-separated). Required columns: **Name**, **Alter**.  
   A points column is ignored (always calculated). Optional: description, death date.

3. **Catch up silently**

   ```
   !check
   ```

   Compares the lists to Wikipedia, marks who already died, awards points, and sends you a summary (DM when possible). Nothing is posted to the announcement channels.

4. **Go live**

   ```
   !go
   ```

   From this moment the bot announces new deathpool hits and (if configured) new all-deaths. Past Wikipedia entries are not dumped into the all-deaths channel.

### During the year

The bot polls Wikipedia on an interval. You can force a run with `!check`.

At year end:

```
!new-year confirm [YYYY-MM-DD]
```

That writes a backup package under `data/backups/`, then starts a fresh season in setup mode.

---

## Commands

### Everyone

| Command | What it does |
|---------|----------------|
| `!liste` / `!mylist` | Your picks (prefers DM) |
| `!scores` | Leaderboard |
| `!celeb Name` | Look up someone on the list |
| `!help` | Command list |

### Admin

| Command | What it does |
|---------|----------------|
| `!import @User` | Load that user’s list (next message = paste) |
| `!check` | Setup: silent catch-up. Live: poll now |
| `!go` | Leave setup and start announcing |
| `!season` | Show season status |
| `!season YYYY-MM-DD` | Set / change season start date |
| `!new-year confirm [date]` | Backup + new season (setup) |
| `!kill Name` | Mark dead manually |
| `!resurrect Name` | Undo a death and reverse points |
| `!add-points @User N` / `!set-points @User N` | Adjust score |
| `!players` | List players |
| `!restore` / `!restore confirm file.zip` | Restore a backup package |

Admin commands work in a server channel or in a DM with the bot.

---

## Backups and restore

- Automatic backups go to `data/backups/`
- `!new-year` also writes a full season package there
- To restore: put a `.zip` in `data/restore/` (or use a name from `backups/`), then `!restore confirm filename.zip`  
  A safety backup of the current database is created first.

---

## Custom phrases

Optional file: `data/custom_phrases.txt` (one line per phrase).  
Placeholders: `{name}` `{age}` `{score}` `{winners}` `{losers}`

In compose, set `CUSTOM_PHRASES` to:

- `no` — built-in phrases only (default)
- `mix` — built-in + your file
- `only` — your file only

---

## Settings (compose `environment`)

| Setting | Purpose |
|---------|---------|
| `TOKEN` | Bot token |
| `ADMIN_ID` | Admin Discord user id |
| `CHANNEL_DEATHPOOL` | Deathpool announcements |
| `CHANNEL_ALL_DEATHS` | Optional all-deaths channel (empty = off) |
| `PREFIX` | Command prefix (default `!`) |
| `WIKI_POLLER_MINUTES` | How often to poll (default `30`) |
| `DAILY_SUMMARY_HOUR` | Hour for the daily digest (default `9`) |
| `DEATH_CONFIRM_DAYS` | Days before a live hit is locked in (default `7`) |
| `CUSTOM_PHRASES` | `no` / `mix` / `only` |
| `TZ` | Timezone for cron (e.g. `Europe/Berlin`) |
| `DATA_DIR` | Data path inside the container (default `/app/data`) |

---

## Scoring note

Points always use **age at season start**: `max(1, 100 − age)`.  
Wikipedia’s listed age at death is only used for matching / comparison in messages, not for the score.
