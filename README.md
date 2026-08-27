# DeathBot-2000

A Discord bot for celebrity death-pool games. It watches Wikipedia death lists, keeps score for your group’s picks, and posts updates when someone on the list dies.

**In Discord:** start with **`/help`** (slash is the main UX). Prefix (`!`, configurable) stays as fallback — especially for multi-message paste and “send the wiki URL next”.

## What you need

1. A Discord bot token with **Message Content Intent** enabled  
2. A Discord server where the bot can read and send messages  
3. Channel IDs:
   - **Deathpool channel** — when a picked celebrity dies (pings winners only)
   - **All-deaths channel** (optional) — every newly listed Wikipedia death (never pings)
   - **Admin channel** (optional `CHANNEL_ADMIN`) — wiki/age review cards + long admin summaries; empty = DM-first
4. Your Discord user ID as admin  
5. Your **server (guild) ID** as `DISCORD_GUILD_ID` (fast slash sync; commands also register globally for **DMs with the bot**)  
6. Docker (published image) or Node 20+ from source  

### Discord Developer Portal checklist

- **Message Content Intent** on  
- Bot invited with scopes **`bot`** + **`applications.commands`**  
- For slash in DMs: enable **User Install** / DM contexts if you use user-installable apps (guild install + Bot DM contexts are set in code)  
- Bot member of the guild; set `DISCORD_GUILD_ID` for instant command updates  

Copy `docker-compose.yml`, fill in the `environment:` values (no `.env` file), mount `./data`, then:

```bash
docker compose pull
docker compose up -d
```

Image: `ghcr.io/emil007/deathbot-2000:latest`

Admin season flow works in a **DM with the bot** (`/…` or `!…`). Announcement channels are only for public posts; `CHANNEL_ADMIN` is optional ops.

**Slash visibility:** Discord cannot hide commands by `ADMIN_ID`. Non-admins may see admin commands in the picker but get an ephemeral deny. Runtime checks `ADMIN_ID` only (`ADMIN_ROLE_ID` is documented, not a hard filter).

---

## What it does

- One **celeb row per person** — identity = **Wikidata QID** when available, else confirmed Wikipedia URL (`wiki_url_norm`); EN preferred, DE secondary  
- Same display name can be **two people** (homonyms): import creates a new provisional for review instead of silently reusing a confirmed row  
- After import: **wiki/age review** with top search candidates + buttons before auto-matching  
- Scores hits as **100 − age at season start**  
- `/go` **blocks** while reviews/unconfirmed picks remain (override: `/go force:true`)  
- Frequent polls = recent months; **nightly full-year scrape** (retries if a live poll was busy)  
- Pool deaths: primarily check each confirmed wiki page for `Category:YYYY deaths` / `Kategorie:Gestorben YYYY` (same approach as the old link watcher); death-list scrape is backup + all-deaths channel  
- All-deaths channel: factual bio cards (age, lifespan, known-for / short summary) — no sarcastic phrases  
- Retract window (`DEATH_CONFIRM_DAYS`) on nightly only  

---

## Season workflow

1. `/new-year confirm:true` (optional `start_date`) — setup  
2. `/import user:@Player` — paste until **`done`**, or attach a file  
3. Review (DM or `CHANNEL_ADMIN`): Confirm · pick other candidate · Wrong link (modal) · Set age · No wiki · Skip  
4. `/go` — blocked until reviews done (or `force:true`) → silent reconcile → seed → live  

Details: `/help command:import`.

---

## Settings

| Setting | Purpose |
|---------|---------|
| `TOKEN` / `ADMIN_ID` / `CHANNEL_DEATHPOOL` | Required |
| `DISCORD_GUILD_ID` | Instant slash sync (recommended) |
| `CHANNEL_ALL_DEATHS` | Optional all-deaths |
| `CHANNEL_ADMIN` | Optional review/ops channel (else DM-first) |
| `PREFIX` | Prefix fallback (default `!`) |
| `WIKI_POLLER_MINUTES` | Recent-month poll (default `30`) |
| `NIGHTLY_FULL_SCRAPE_HOUR` | Full-year scrape hour (default `3`) |
| `DAILY_SUMMARY_HOUR` | Daily digest (default `9`) |
| `DEATH_CONFIRM_DAYS` | Retract window (default `7`) |
| `CUSTOM_PHRASES` | `no` / `mix` / `only` |
| `TZ` | Cron timezone |

---

## Scoring

`max(1, 100 − age_at_pick)`.  
Manual-only celebs never auto-kill — use `/kill` or sheet death dates.
