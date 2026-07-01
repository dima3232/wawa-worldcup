# World Cup 2026 — Playoff Bracket ⚽

A self-updating web page for the FIFA World Cup 2026 (USA / Canada / Mexico)
knockout stage: the playoff bracket, a "When to watch" schedule, and the group
tables. The core runs with no backend and no keys; an optional tiny Cloudflare
Worker adds calendar events and live match statistics.

## Features

- **Single-file core** — [`index.html`](index.html) is plain HTML + CSS + JS, no
  dependencies and nothing to compile.
- **Auto-updating data** — pulls the public-domain **openfootball** JSON and
  refreshes every 60 seconds, redrawing scores, winners and the bracket on its own.
  Matches decided in extra time show the after-ET score; penalties are noted separately.
- **Bracket connectors** — each pair connects to its own next-round match with
  clean, parallel lines, so you can see at a glance who plays whom (and when) next.
- **LIVE badge** — lights up only during a match's time window (clock-driven,
  independent of the data feed).
- **Local time & language** — times and dates use the visitor's **own timezone and
  locale** (via `Intl`). The UI language is auto-detected from the browser
  (**Ukrainian / English**) with a manual switcher; the choice is kept in `localStorage`.
- **Add to calendar** — the match popup offers three options:
  - **Google** and **Outlook** open a pre-filled "new event" page (no download);
  - **Apple** uses `webcal://` to the site's `/event.ics` endpoint so iOS/macOS
    Calendar opens the event directly (a plain `.ics` download is offered as a fallback).
  Each event has a full description (who plays whom, round, kick-off, venue, score)
  plus a 30-minute reminder.
- **Match statistics** (playoff matches) — clicking a knockout match shows possession,
  shots on target, xG, big chances, corners, offsides, fouls and cards, pulled from
  **Highlightly** through the Worker and cached in Workers KV.
- **Score backup** — the same Highlightly feed backs up openfootball: where the JSON
  hasn't posted a result yet, the bracket fills the score/winner from Highlightly so it
  never lags. openfootball stays the primary source and is never overridden.

## How it works

- Primary data: `https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json`,
  polled with cache-busting every minute; the bracket, schedule and standings are
  rebuilt from it. Provisional slots (e.g. "Winner 1/8") resolve to real teams as
  results come in.
- Statistics/backup layer (optional): the Worker calls Highlightly's free tier,
  **for knockout matches only**, on a cron. Live matches refresh every few minutes;
  a finished match is fetched once and frozen in KV forever. A per-day request budget
  keeps it inside the free tier.
- If Highlightly is unavailable, everything degrades gracefully — the stats block just
  shows "unavailable" and scores fall back to openfootball. Nothing else breaks.

> Note: openfootball is volunteer-maintained data committed to git, not a
> minute-by-minute live feed. The LIVE badge is clock-based, so it's always reliable.

## Local development

Opening the file with a double-click can block `fetch`, so run a tiny local server:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

The Worker routes (`/event.ics`, `/stats`, `/scores`) don't run under
`python -m http.server`; the page handles their absence gracefully (calendar `.ics`
download still works, stats/backup simply don't load).

## Deployment

Hosted on **Cloudflare Workers** with static assets, deployed automatically from this
GitHub repo on every push to `main`.

- [`index.html`](index.html) and other static files are served as assets.
- [`worker.js`](worker.js) handles the dynamic routes:
  - `/event.ics` — calendar event as `text/calendar` (for the Apple `webcal://` flow);
  - `/stats` — match statistics from KV (lazy-fetches a finished match on demand);
  - `/scores` — all match scores/status in one call (openfootball backup);
  - a **cron trigger** polls live knockout matches and backfills finished ones.
- [`wrangler.jsonc`](wrangler.jsonc) wires the assets binding, the `WC_STATS` KV
  namespace and the cron; [`.assetsignore`](.assetsignore) keeps source/config files
  out of the public asset set.
- The Highlightly API key is stored as the Worker secret `HIGHLIGHTLY_KEY` (never in
  the repo).

The static part also works on any plain static host (GitHub Pages, Netlify, etc.);
only the calendar and statistics endpoints require the Worker.

---

made for Football | WAWA ⚽
