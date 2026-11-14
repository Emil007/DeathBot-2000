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

## For admins — open the next season

Seasons are **announced** while the current one is still running:

1. **`/announce-season announce_channel:#Kanal`** — creates the announced season (e.g. 2027), saves the channel, posts the sign-up embed. **The running season is untouched.** Players can now DM their picks.
2. Players submit via DM (see *For players*). The bot auto-links names; new/unconfirmed celebs land in the **review queue**.
3. **Review each celeb** (`/review`, DM or admin channel): confirm the Wikipedia person, pick another candidate, fix the URL, set the season age, mark “no wiki”, or skip. Confirmation is season-aware — a 2026 pick is never thrown out by a 2027 confirm.
4. **`/new-year activate:true`** (on/after the start date) — archives the running season (points snapshot kept), activates the announced season, does a silent reconcile. Old wipe (`/new-year wipe:true`) is only an emergency for an empty setup pool.

Need to re-post the sign-up embed? **`/announce-season repost:true`** (channel can be changed and is saved).

**First start / missing deathpool channel (interactive setup):** if the bot starts and no deathpool channel is linked yet (no `CHANNEL_DEATHPOOL` env, nothing stored in the DB), it asks in the **announce channel** which channel should be the deathpool for the new season. After you pick one, the year rollover continues automatically. `/status` shows which channel is linked (`_(per Start-Setup, noch keiner verknüpft)_` until then).

**Automatic reminders (not actions):** on **Nov 1st** and **Dec 1st** (in the configured `TZ`, default `Europe/Vienna`), the bot pings the admin if the next season has not been opened yet — a nudge to run `/announce-season` before the new year. It never announces for you; opening + seeding + channel choice stays manual.

**Automatic year rollover (Jan 1st):** at **00:00 config `TZ`** the bot posts a year-review of the just-finished season, archives it, activates the announced season, **creates a fresh `deathpool-{YEAR}` channel** (name uses the new year) and gives **every player** view/send access. The Discord server is resolved automatically from the configured/DB-stored deathpool channel (same server the announcement went to). If no guild is resolvable at all, the switch still runs and just reuses the configured deathpool channel. **At this moment the bot also writes a permanent `season-start` backup** (see *Backups* below) so the picks of the new season are safe no matter what.

---

## For admins — while the season runs

### Check that everything’s healthy
- **`/status`** — last poll, counts, recent hits, errors, channel config, seasons | 
- **`/check`** — run a wiki check now (setup = quiet reconcile; live = full poll)
- **`/season`** — season start date / live flag

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
- Celeb tools: `/celeb`, `/age`, `/wiki`, `/aka`, `/alias`, `/import` (sheet/name import), `/blacklist` …
- Points: `/add-points`, `/set-points`, `/bonus`
- Season control: `/go` (go live), `/ungo` (pause), `/kill`, `/resurrect`

---

## Backups

Two independent layers keep your data safe:

- **Nightly (02:00, config `TZ`):** a ZIP under `data/backups/` containing `deathbot.sqlite` (WAL checkpointed) plus a `manifest.json` (season, stats, reason). **Keeps the last 14**, older ones are pruned.
- **Season-start (permanent):** whenever a new season is activated via the year rollover (Jan 1st cron or `/new-year`), the bot writes an additional ZIP into `data/backups/season-start/`. This one is **never pruned** — it stays for the whole year (and beyond) as the fallback that holds at least the tipps/picks of the new season, even if everything else fails.

Restore: `/restore` lets you pick a backup (from `data/restore/`).

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
4. Set at least: `TOKEN`, `ADMIN_ID`. Recommended: **`DISCORD_GUILD_ID`** (instant slash updates). `CHANNEL_DEATHPOOL` is now **optional** — if empty, the one-time interactive channel setup picks it (see above).

```bash
docker compose pull
docker compose up -d
```

Image: `ghcr.io/emil007/deathbot-2000:latest`

Non-admins may **see** admin slash commands in Discord’s picker (Discord limitation) but get denied at runtime. Only `ADMIN_ID` is enforced.

### Environment variables

| Variable | Meaning / values |
|----------|------------------|
| `TOKEN` | Discord bot token (**required**) |
| `ADMIN_ID` | Discord user ID with admin rights (**required**) |
| `PREFIX` | Legacy text-command prefix (`!` by default) |
| `DATA_DIR` | Data folder inside the container (`/app/data`) |
| `DISCORD_GUILD_ID` | Guild for instant slash-command updates (recommended) |
| `CHANNEL_DEATHPOOL` | Deathpool channel ID — **optional now**; empty → interactive start setup |
| `CHANNEL_ALL_DEATHS` | Optional factual feed |
| `CHANNEL_ADMIN` | Optional ops channel; empty = DM-first |
| `CHANNEL_LOG` | Optional log channel for inputs/changes/errors (no scan-run logs) |
| `ADMIN_ROLE_ID` | Optional role id with admin rights |
| `ALERT_EMOJI` / `ALERT_EMOJI_REPEAT` | Death-announce branding (default `⚰️`, repeat `3`) |
| `TZ` | Time zone for cron (“killed today” boundary, rollover, reminders). Default `Europe/Vienna` |
| `WIKI_POLLER_MINUTES` | How often to poll recent deaths (`30`) |
| `NIGHTLY_FULL_SCRAPE_HOUR` | Full-year scrape (`3`) |
| `DAILY_SUMMARY_HOUR` | Daily digest (`9`) |
| `DEATH_CONFIRM_DAYS` | Days before a hit is locked (`7`) |
| `MAX_PICKS_PER_PLAYER` | Max names per player list (whole draft, across DMs) (`50`) |
| `USER_AGENT` | Wikipedia User-Agent (own repo + contact recommended) |
| `CUSTOM_PHRASES` | `no` / `mix` / `only` (+ `data/custom_phrases.txt`) |
| `PHRASES_BANK` | Built-in roast bank: **`new`** (default, ~241 gemeine Sätze) / `old` (legacy 542) / `custom` |

Bot presence: **Already N People killed today!** after the first all-deaths post; at **0** → `lurking.... bloody cats!`. Resets at local midnight (`TZ`).

Nightly DB zip backup at **02:00** (`TZ`) under `data/backups/` — keeps the **last 14** files (see *Backups* for the permanent season-start copy).

---

## Quick mental model

**Admin** announces the next season (`/announce-season`) → **players** hand in picks via DM → the bot auto-links names and reviews the unsure ones → **Admin** confirms (`/review`) → on the start day **`/new-year activate:true`** archives the old / activates the new season and writes the permanent season-start backup → bot watches Wikipedia → deathpool scores the pool, all-deaths (optional) shows the wider list → use **`/status`** / **`/invalidate`** when something looks wrong.
