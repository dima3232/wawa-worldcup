# World Cup 2026 — Playoff Bracket ⚽

A self-contained web page with the FIFA World Cup 2026 (USA / Canada / Mexico)
knockout bracket: the playoff tree, a "When to watch" schedule, and the group
tables. It updates itself automatically — no backend, no API keys, no build step.

## Features

- **Single file** — [`index.html`](index.html) is plain HTML + CSS + JS, no
  dependencies and nothing to compile.
- **Auto-updating data** — pulls the public-domain **openfootball** JSON and
  refreshes every 60 seconds, redrawing scores, winners and the bracket on its own.
- **Bracket connectors** — each pair connects to its own next-round match with
  clean, parallel lines, so you can see at a glance who plays whom (and when) next.
- **LIVE badge** — lights up only during a match's time window (clock-driven,
  independent of the data feed).
- **Local time & language** — times and dates are shown in the visitor's **own
  timezone and locale** (via `Intl`), not a hard-coded zone. The UI language is
  auto-detected from the browser (**Ukrainian / English**) with a manual switcher
  in the header; the choice is remembered in `localStorage`.
- **Add to calendar** — clicking a match opens a details popup with three options:
  - **Google** and **Outlook** open a pre-filled "new event" page (no download);
  - **Apple** uses `webcal://` to the site's `/event.ics` endpoint so iOS/macOS
    Calendar opens the event directly (a plain `.ics` download is offered as a
    fallback).
  Each event carries the full description — who plays whom, round, kick-off time,
  venue, score (if played) — plus a 30-minute reminder.

## How it works

- Data source: `https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json`
- The page polls it with cache-busting every minute and re-renders the bracket,
  schedule and group standings from the result.
- Provisional slots (e.g. "Winner 1/8", group placeholders) resolve to real teams
  as results come in.

> Note: openfootball is volunteer-maintained data committed to git, not a
> minute-by-minute live feed. Scores appear with a small delay (plus ~5 min of
> GitHub CDN caching). The LIVE badge is clock-based, so it's always reliable.

## Local development

Opening the file with a double-click can block `fetch`, so run a tiny local server:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

The calendar `webcal://` endpoint (`/event.ics`) is served by the Cloudflare
Worker and won't run under `python -m http.server`; the `.ics` download fallback
works everywhere.

## Deployment

Hosted on **Cloudflare Workers** with static assets, deployed automatically from
this GitHub repo on every push to `main`.

- [`index.html`](index.html) and other static files are served as assets.
- [`worker.js`](worker.js) handles the single dynamic route `/event.ics`, returning
  the calendar event with `Content-Type: text/calendar` (needed for the Apple
  `webcal://` flow).
- [`wrangler.jsonc`](wrangler.jsonc) wires the Worker to the assets binding;
  [`.assetsignore`](.assetsignore) keeps source/config files out of the public asset set.

The static part also works on any plain static host (GitHub Pages, Netlify, etc.);
only the `/event.ics` calendar endpoint requires the Worker.

---

made for Football | WAWA ⚽
