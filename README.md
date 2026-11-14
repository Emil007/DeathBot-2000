# DeathBot-2000

A Discord bot for a **celebrity death pool**: players submit a list of people; the bot watches Wikipedia; when someone on a list dies, it announces it, awards points, and keeps the scoreboard.

Talk to the bot with **slash commands** (`/help`). The prefix (`!` by default) still works as a fallback — useful for pasting multi-line lists.

The bot supports **multiple seasons**: a running season stays live while the next one is announced and players sign up via DM; on the start day the old season is archived (points snapshot kept) and the new one goes live.

---

## What you get in Discord

| Channel | What happens there |
|---------|-------------------|
| **Announce channel** (`/announce-season`) | The sign-up call for the **next** season; being able to see it = eligible to play |
| **Deathpool** | Someone on a player list died → sarcastic announce, **@winners**, points |
| **All-deaths** (optional) | Every new Wikipedia death list entry → short **factual** bio card, no pings |
| **DM with the bot** | **Pick submission** (the Tipp-Assistent), import, wiki/age review, long summaries, ops (`/status`) |

Private DMs to the bot are where players hand in their picks — see *For players* below.

---

## For players

You don’t need to run the wiki poller. To join the **next** season:

1. **Be able to see the announce channel** — that’s the eligibility check.
2. Send the bot a **direct message** with your picks: names, one per line or `;`-separated. Max **50** per submission; paste more and the rest is truncated (and you’re told).
3. The bot links each name to **Wikipedia** itself and shows you your list. If a name is ambiguous (two people), it offers a picker.
4. Tweak until done: `entfernen 3`, `ändern 3 Neuer Name`, then `fertig` / `done` to freeze. `unlock` reopens a frozen list until the season starts.
5. If one of your picks dies **before** the season starts, the bot DMs you a heads-up — swap the name while you still can.

Player-facing commands:

| Command | What it does |
|---------|----------------|
| `/scores` | Current standings |
| `/liste` | Anyone’s pick list (`user` / name) |
| `/celebs` | All celebs in the pool (alive / dead) |
| `/players` | Who’s in the game |
| `/help` | Command help |

When a pick dies, winners are pinged in the deathpool channel. Points = **`max(1, 100 − age at season start)`** (younger = more points). The bot double-checks dedup/link quality before posting (no double-cards for DE/EN duplicates, no swallowed deaths).

---

## For admins — open the next season (M4/M5 flow)

Seasons are **announced** while the current one is still running:

1. **`/announce-season announce_channel:#Kanal`** — creates the announced season (e.g. 2027), saves the channel, posts the sign-up embed. **The running season is untouched.** Players can now DM their picks.
2. Players submit via DM (see *For players*). The bot auto-links names; new/unconfirmed celebs land in the **review queue**.
3. **Review each celeb** (`/review`, DM or admin channel): confirm the Wikipedia person, pick another candidate, fix the URL, set the season age, mark “no wiki”, or skip. Confirmation is season-aware — a 2026 pick is never thrown out by a 2027 confirm.
4. **`/new-year activate:true`** (on/after the start date) — archives the running season (points snapshot kept), activates the announced season, does a silent reconcile. Old wipe (`/new-year wipe:true`) is only an emergency for an empty setup pool.

Need to re-post the sign-up embed? **`/announce-season repost:true`** (channel can be changed and is saved).

---

## For admins — while the season runs

### Check that everything’s healthy
- **`/status`** — last poll, counts, recent hits, errors, channel config, seasons | 
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
2. **Pre-season filter:** death category year before the season (or already on the page before start) → ignored + auto-excluded; announced-season picks are additionally scanned pre-start so a December death is caught and the player warned
3. **Backup:** Wikipedia “deaths in …” list matching (confirmed wiki celebs match by article, not fuzzy name mentions). DE entries are resolved to their EN article via the MediaWiki API before posting.
4. **Dedup:** same QID / EN↔DE bridge / non-person cards posted against a person are merged — one post per dead human, no double cards.
5. **Retract window:** for a few days (`DEATH_CONFIRM_DAYS`) a hit can be undone if the signal disappears; then it locks

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
| `CHANNEL_LOG` | Optional log channel for inputs/changes/errors (no scan-run logs) |
| `CUSTOM_PHRASES` | `no` / `mix` / `only` (+ `data/custom_phrases.txt`) |
| `TZ` | Cron + “killed today” status day boundary |

Bot presence: **Already N People killed today!** after the first all-deaths post; at **0** → `lurking.... bloody cats!`. Resets at local midnight (`TZ`).

Nightly DB zip backup at **02:00** under `data/backups/` — keeps the **last 14** files.

---

## Quick mental model

**Admin** announces the next season (`/announce-season`) → **players** hand in picks via DM → the bot auto-links names and reviews the unsure ones → **Admin** confirms (`/review`) → on the start day **`/new-year activate:true`** archives the old / activates the new season → bot watches Wikipedia → deathpool scores the pool, all-deaths (optional) shows the wider list → use **`/status`** / **`/invalidate`** when something looks wrong.
