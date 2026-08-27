# DeathBot-2000

A Discord bot for a **celebrity death pool**: players submit a list of people; the bot watches Wikipedia; when someone on a list dies, it announces it, awards points, and keeps the scoreboard.

Talk to the bot with **slash commands** (`/help`). The prefix (`!` by default) still works as a fallback — useful for pasting multi-line lists.

---

## What you get in Discord

| Channel | What happens there |
|---------|-------------------|
| **Deathpool** | Someone on a player list died → sarcastic announce, **@winners**, points |
| **All-deaths** (optional) | Every new Wikipedia death list entry → short **factual** bio card, no pings |
| **DM / admin channel** | Import, wiki/age review, long summaries, ops (`/status`) |

Admin work is fine in a **DM with the bot**. Public channels are only for announcements.

---

## For players

You don’t need to run the wiki poller. Day to day:

| Command | What it does |
|---------|----------------|
| `/scores` | Current standings |
| `/liste` | Anyone’s pick list (`user` / name) |
| `/celebs` | All celebs in the pool (alive / dead) |
| `/players` | Who’s in the game |
| `/help` | Command help |

When a pick dies, winners are pinged in the deathpool channel. Points = **`max(1, 100 − age at season start)`** (younger = more points).

---

## For admins — start a season

1. **`/new-year confirm:true`**  
   Optional `start_date` (`YYYY-MM-DD`). Bot goes into setup (not live yet).

2. **`/import user:@Player`**  
   Paste the sheet (or attach a file), then send **`done`**.  
   Details: `/help command:import`.

3. **Review each celeb** (DM or admin channel)  
   Confirm the Wikipedia person, pick another candidate, fix the URL, set age, mark “no wiki”, or skip.  
   Same display name can be **two different people** — review keeps them separate.

4. **`/go`**  
   Blocked while reviews are open (override: `/go force:true`).  
   Then: silent reconcile of already-dead picks → seed wiki cache → **live**.

After go, the bot polls Wikipedia on a timer and does a full-year scrape at night.

---

## For admins — while the season runs

### Check that everything’s healthy
- **`/status`** — last poll, counts, recent hits, errors, channel config  
- **`/check`** — run a wiki check now (setup = quiet reconcile; live = full poll)  
- **`/season`** — season start / live flag

### Fix bad hits (no full restart)
| Situation | Command |
|-----------|---------|
| False death / undo points | `/resurrect` or **`/invalidate`** (also turns off auto-match) |
| Cheat / void the pick entirely | `/invalidate … remove_picks:true` |
| Stop auto-matching someone | `/exclude` → later `/include` |
| Manually mark dead | `/kill` |
| Test announce only (no DB) | `/simulate url:…` (names + points, **no @pings**) |
| Pause live + reseed quietly | `/ungo confirm:true` |

### Lists, wiki, points
- Celeb tools: `/celeb`, `/age`, `/wiki`, `/aka`, `/blacklist`, …  
- Points: `/add-points`, `/set-points`, `/bonus`  
- Backup/restore: `/restore` (see `/help`)

---

## How the bot decides someone died

1. **Primary:** each confirmed celeb’s Wikipedia page gets `Category:YYYY deaths` / `Kategorie:Gestorben YYYY`  
2. **Pre-season filter:** death category year before the season (or already on the page before start) → ignored + auto-excluded  
3. **Backup:** Wikipedia “deaths in …” list matching (confirmed wiki celebs match by article, not fuzzy name mentions)  
4. **Retract window:** for a few days (`DEATH_CONFIRM_DAYS`) a hit can be undone if the signal disappears; then it locks

Deathpool messages use the roast phrase bank. **All-deaths** stays informative (age, lifespan, known-for, short summary).

---

## Run it (Docker)

1. Discord app with **Message Content Intent**  
2. Invite with scopes **`bot`** + **`applications.commands`**  
3. Copy `docker-compose.yml`, fill `environment:` (no `.env` file), mount `./data`  
4. Set at least: `TOKEN`, `ADMIN_ID`, `CHANNEL_DEATHPOOL`, **`DISCORD_GUILD_ID`** (instant slash updates)

```bash
docker compose pull
docker compose up -d
```

Image: `ghcr.io/emil007/deathbot-2000:latest`

Non-admins may **see** admin slash commands in Discord’s picker (Discord limitation) but get denied at runtime. Only `ADMIN_ID` is enforced.

### Useful settings

| Setting | Default idea |
|---------|----------------|
| `WIKI_POLLER_MINUTES` | How often to poll recent deaths (`30`) |
| `NIGHTLY_FULL_SCRAPE_HOUR` | Full-year scrape (`3`) |
| `DAILY_SUMMARY_HOUR` | Daily digest (`9`) |
| `DEATH_CONFIRM_DAYS` | Days before a hit is locked (`7`) |
| `CHANNEL_ALL_DEATHS` | Optional factual feed |
| `CHANNEL_ADMIN` | Optional ops channel; empty = DM-first |
| `CUSTOM_PHRASES` | `no` / `mix` / `only` (+ `data/custom_phrases.txt`) |
| `TZ` | Cron + “killed today” status day boundary |

Bot presence: **Already N People killed today!** — counts all-deaths posts since local midnight (`TZ`), resets at 00:00.

---

## Quick mental model

**Players** pick people → **Admin** imports & confirms wiki links → **`/go`** → bot watches Wikipedia → deathpool scores the pool, all-deaths (optional) shows the wider list → use **`/status`** / **`/invalidate`** when something looks wrong.
