# DeathBot-2000 — Gregg the Grim Reaper

Discord bot for celebrity death-pool games. Scrapes English + German Wikipedia death lists, announces pool hits with points and winner pings, optionally announces every new death in a separate channel, and stores everything in SQLite on a NAS volume.

No LLM. Sarcasm comes from a built-in German phrase bank (Death’s voice) plus an optional `custom_phrases.txt`.

## Late start (your August case)

Pool started 1 Jan, bot joins later:

1. `!new-year confirm 2026-01-01` — setup mode, start date set (ages = as of that day)
2. `!import @User` for each sheet (Name + Alter; **Punkte column ignored**, score = `100 − age`)
3. `!check` — silent wiki reconcile: marks already-dead picks, awards points, **DM summary**, no channel spam
4. `!go` — go live; reseeds all-deaths so only deaths **from now on** are announced

Admin commands work in DMs or any channel the bot can see.

## Quick start (NAS)

1. Create channels (deathpool required; all-deaths optional).
2. Enable **Message Content Intent**. Invite the bot.
3. On the NAS:

```bash
mkdir -p deathbot-2000/data/{backups,restore}
cd deathbot-2000
# edit docker-compose.yml environment values (no .env file)
docker compose pull
docker compose up -d
```

Image: `ghcr.io/emil007/deathbot-2000:latest`

## Data mount

```
./data/
  deathbot.sqlite
  custom_phrases.txt
  backups/
  restore/
```

## Environment

| Variable | Required | Meaning |
|----------|----------|---------|
| `TOKEN` | yes | Discord bot token |
| `ADMIN_ID` | yes | Your Discord user id |
| `CHANNEL_DEATHPOOL` | yes | Pool hits (pings winners) |
| `CHANNEL_ALL_DEATHS` | no | Every new wiki death (never pings) |
| `WIKI_POLLER_MINUTES` | no | Default `30` |
| `DAILY_SUMMARY_HOUR` | no | Default `9` |
| `DEATH_CONFIRM_DAYS` | no | Default `7` — retract if wiki hit disappears within this window |
| `CUSTOM_PHRASES` | no | `no` / `mix` / `only` |
| `TZ` | no | e.g. `Europe/Berlin` |

## Commands

**Everyone:** `!liste`, `!scores`, `!celeb`, `!help`

**Admin**

- `!new-year confirm [YYYY-MM-DD]` — archive + new pool in setup
- `!season` / `!season YYYY-MM-DD` — status / set start date
- `!import @User` — paste TSV (Name, Alter required)
- `!check` — setup: silent reconcile + DM; live: poll now
- `!go` — start live run
- `!kill` / `!resurrect`, points, `!players`, `!restore`

## Scoring

Always `max(1, 100 − age_at_pick)`. Age is the age **at season start**, not the wiki death age (wiki age is only shown for comparison).

## False positives

Live wiki kills stay **unconfirmed** for `DEATH_CONFIRM_DAYS`. If the person drops off the Wikipedia death lists within that window, Gregg **retracts** (marks alive again, reverses points, announces). After the window, the death is locked.

Reconcile / sheet / setup kills are confirmed immediately (historical catch-up).

## Notes

- While not live, the interval poll only seeds the wiki cache (no announcements).
- `!go` reseeds all-deaths so history is not dumped into the channel.
