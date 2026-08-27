# DeathBot-2000 — Gregg the Grim Reaper

Discord bot for celebrity death-pool games. Scrapes English + German Wikipedia death lists, announces pool hits with points and winner pings, optionally announces every new death in a separate channel, and stores everything in SQLite on a NAS volume.

No LLM. Sarcasm comes from a built-in German phrase bank (Death’s voice) plus an optional `custom_phrases.txt`.

## Quick start (NAS)

1. Create two Discord channels (deathpool required; all-deaths optional).
2. Invite the bot with permissions to read/send messages and use embeds. Enable **Message Content Intent** in the Discord Developer Portal.
3. On the NAS:

```bash
mkdir -p deathbot-2000/data/{backups,restore}
cd deathbot-2000
# copy docker-compose.yml from the repo, fill in environment values (no .env file)
docker compose pull
docker compose up -d
```

Image: `ghcr.io/emil007/deathbot-2000:latest` (built by GitHub Actions on push to `main`).

## Data mount

```
./data/
  deathbot.sqlite
  custom_phrases.txt      # optional; see CUSTOM_PHRASES
  backups/                # !new-year + auto backups
  restore/                # drop a zip here, then !restore
```

All durable state lives here. The container image is disposable.

## Environment (docker-compose)

| Variable | Required | Meaning |
|----------|----------|---------|
| `TOKEN` | yes | Discord bot token |
| `ADMIN_ID` | yes | Your Discord user id |
| `CHANNEL_DEATHPOOL` | yes | Pool hit announcements (pings winners) |
| `CHANNEL_ALL_DEATHS` | no | Every new wiki death (never pings) |
| `PREFIX` | no | Default `!` |
| `WIKI_POLLER_MINUTES` | no | Default `30` |
| `DAILY_SUMMARY_HOUR` | no | Default `9` (server `TZ`) |
| `CUSTOM_PHRASES` | no | `no` (default) / `mix` / `only` |
| `TZ` | no | e.g. `Europe/Berlin` |

`CUSTOM_PHRASES`:

- `no` — ignore `custom_phrases.txt`
- `mix` — built-in + custom
- `only` — custom only (falls back to built-in if file empty)

## Commands

**Everyone**

- `!liste` / `!mylist` — your picks (DM if possible)
- `!scores` — leaderboard
- `!celeb Name` — lookup
- `!help`

**Admin**

- `!import @User` — then paste a Google Sheets TSV (columns Name + Alter required; Beschreibung / gestorben optional)
- `!check` — run wiki poll now
- `!kill Name` / `!resurrect Name`
- `!add-points @User N` / `!set-points @User N`
- `!players`
- `!new-year confirm` — writes a zip package under `data/backups/`, resets season
- `!restore` / `!restore confirm file.zip` — restore from `data/restore/` or `data/backups/`

## Scoring

`points = max(1, 100 - age)` when age is known; otherwise `0`.

## Local / rebuild

```bash
docker build -t deathbot-2000 .
docker compose up -d
```

## Notes

- First poll after start **seeds** the wiki cache (no spam). Later polls announce only new rows.
- Deathpool matching still runs against the full current lists so imported celebs are caught when they appear.
- Year history lives in backup packages; `!new-year` clears celebs/picks for a clean import.
