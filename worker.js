// Cloudflare Worker перед статичними ассетами.
// /event.ics → подія матчу як text/calendar (для webcal:// на iOS/macOS).
// /stats     → статистика матчу (Highlightly) з кешу KV; ліниво добирає завершені.
// cron       → фонове опитування живих матчів + фіналізація + backfill (бюджет 90/добу).
// Решта      → статичні ассети (env.ASSETS).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/event.ics") return eventIcs(url);
    if (url.pathname === "/stats")     return statsRoute(url, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollLive(env));
  }
};

// ===================== Highlightly stats =====================
const HL_BASE = "https://soccer.highlightly.net";
const WC_LEAGUE = 1635, WC_SEASON = 2026;
const MATCH_MS = 150 * 60 * 1000;      // вікно «йде матч»
const FINAL_MS = 180 * 60 * 1000;      // після цього вважаємо матч завершеним (з ЕТ/пенальті)
const DAILY_BUDGET = 90;               // з 100/добу лишаємо запас
const LIST_TTL_MS = 12 * 3600 * 1000;  // кеш списку матчів Highlightly

// які показники залишаємо (за displayName у відповіді Highlightly)
const WANT = {
  "Possession": "possession",
  "Expected Goals": "xg",
  "Shots on target": "sot",
  "Total shots": "shots", "Total Shots": "shots",
  "Big Chances Created": "bigch",
  "Corners": "corners",
  "Offsides": "offsides",
  "Fouls": "fouls",
  "Yellow cards": "yellow",
  "Red cards": "red"
};

function json(obj, status = 200, cacheSec = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheSec ? `public, max-age=${cacheSec}` : "no-store"
    }
  });
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// набір слів назви (регістр/порядок неважливі): "DR Congo" == "Congo DR"
const tokset = s => ((s || "").toLowerCase().match(/[a-z]+/g) || []).sort().join(" ");
const pairKey = (a, b) => [tokset(a), tokset(b)].sort().join("|");

// ---- денний бюджет запитів у KV ----
function budgetKey() { return "budget:" + new Date().toISOString().slice(0, 10); }
async function budgetLeft(env) { return DAILY_BUDGET - (+(await env.WC_STATS.get(budgetKey())) || 0); }
async function spend(env, n = 1) {
  const k = budgetKey(), cur = +(await env.WC_STATS.get(k)) || 0;
  await env.WC_STATS.put(k, String(cur + n), { expirationTtl: 172800 });
}
async function hlFetch(env, path) {
  if (!env.HIGHLIGHTLY_KEY) return null;
  await spend(env, 1);
  try {
    const r = await fetch(HL_BASE + path, { headers: { "x-rapidapi-key": env.HIGHLIGHTLY_KEY } });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

// ---- список матчів ЧС (для маппінгу назв → Highlightly matchId), кеш у KV ----
async function getMatchList(env) {
  const cached = await env.WC_STATS.get("hl:matches", "json");
  if (cached && (Date.now() - cached.ts) < LIST_TTL_MS) return cached.matches;
  if ((await budgetLeft(env)) <= 2) return cached ? cached.matches : [];
  const r = await hlFetch(env, `/matches?leagueId=${WC_LEAGUE}&season=${WC_SEASON}&limit=100`);
  if (!r || !Array.isArray(r.data)) return cached ? cached.matches : [];
  const matches = r.data.map(m => ({
    id: m.id,
    home: (m.homeTeam || {}).name, away: (m.awayTeam || {}).name,
    date: (m.date || "").slice(0, 10),
    ts: Date.parse(m.date) || 0
  }));
  await env.WC_STATS.put("hl:matches", JSON.stringify({ ts: Date.now(), matches }));
  return matches;
}

function extractSide(arr) {
  const o = {};
  for (const s of (arr || [])) {
    const key = WANT[s.displayName || s.type];
    if (key && o[key] === undefined) o[key] = s.value;
  }
  return o;
}
async function fetchStats(env, m, isFinal) {
  const r = await hlFetch(env, `/statistics/${m.id}`);
  if (!Array.isArray(r) || r.length < 2) return null;
  const rec = {
    updated: Date.now(), final: !!isFinal,
    home: { name: (r[0].team || {}).name, s: extractSide(r[0].statistics) },
    away: { name: (r[1].team || {}).name, s: extractSide(r[1].statistics) }
  };
  await env.WC_STATS.put("stats:" + m.id, JSON.stringify(rec)); // без TTL = вічна історія
  return rec;
}

// ---- фонове опитування (cron) ----
async function pollLive(env) {
  const matches = await getMatchList(env);
  if (!matches.length) return;
  const now = Date.now();
  const todayYmd = new Date().toISOString().slice(0, 10);
  const todayCount = matches.filter(m => m.date === todayYmd).length || 1;
  const intervalMs = clamp(Math.ceil(todayCount * 120 / 80), 5, 10) * 60 * 1000;
  for (const m of matches) {
    if ((await budgetLeft(env)) <= 2) break;
    if (!m.ts || now < m.ts) continue;                 // ще не почався
    const rec = await env.WC_STATS.get("stats:" + m.id, "json");
    if (now < m.ts + FINAL_MS) {                        // йде (враховуючи ЕТ/пенальті)
      if (!rec || (now - rec.updated) >= intervalMs) await fetchStats(env, m, false);
    } else {                                            // завершено → фіналізуємо один раз
      if (!rec || !rec.final) await fetchStats(env, m, true);
    }
  }
}

// ---- клієнтський маршрут ----
async function statsRoute(url, env) {
  if (url.searchParams.get("debug") === "1") {
    const hasKey = !!env.HIGHLIGHTLY_KEY;
    let listCount = -1, fetchStatus = "skip";
    if (hasKey) {
      try {
        const r = await fetch(HL_BASE + `/matches?leagueId=${WC_LEAGUE}&season=${WC_SEASON}&limit=100`,
          { headers: { "x-rapidapi-key": env.HIGHLIGHTLY_KEY } });
        fetchStatus = r.status;
        const j = await r.json();
        listCount = (j.data || []).length;
      } catch (e) { fetchStatus = "err:" + e.message; }
    }
    return json({ hasKey, hasKV: !!env.WC_STATS, budgetLeft: await budgetLeft(env), listCount, fetchStatus });
  }
  const home = url.searchParams.get("home") || "";
  const away = url.searchParams.get("away") || "";
  const date = url.searchParams.get("date") || "";
  if (!home || !away) return json({ error: "bad-params" }, 400);
  const matches = await getMatchList(env);
  const want = pairKey(home, away);
  let m = matches.find(x => pairKey(x.home, x.away) === want && (!date || x.date === date))
       || matches.find(x => pairKey(x.home, x.away) === want);
  if (!m) return json({ status: "no-match" }, 200, 300);
  let rec = await env.WC_STATS.get("stats:" + m.id, "json");
  const now = Date.now(), started = m.ts && now >= m.ts;
  // лінивий добір: не було зовсім / застаріле лайв / завершено-але-не-фінал
  if (started && (!rec || (!rec.final && (now - rec.updated) > 120000))) {
    if ((await budgetLeft(env)) > 2) {
      const fresh = await fetchStats(env, m, now >= m.ts + FINAL_MS);
      if (fresh) rec = fresh;
    }
  }
  if (!rec) return json({ status: started ? "pending" : "notstarted" }, 200, 60);
  return json({ status: "ok", matchId: m.id, final: rec.final, updated: rec.updated, home: rec.home, away: rec.away }, 200, 60);
}

function eventIcs(url) {
  const q = url.searchParams;
  const get = (k, d = "") => (q.get(k) || d);
  const esc = s => String(s)
    .replace(/\\/g, "\\\\").replace(/\n/g, "\\n")
    .replace(/,/g, "\\,").replace(/;/g, "\\;");

  const start = get("start");                 // 20260704T210000Z
  const end   = get("end");
  const title = get("title", "Матч ЧС-2026");
  const desc  = get("desc");
  const loc   = get("loc");
  const uid   = get("uid", "wc2026-" + start) + "@wawa-worldcup";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

  const okTime = t => /^\d{8}T\d{6}Z$/.test(t);
  if (!okTime(start) || !okTime(end)) {
    return new Response("bad start/end", { status: 400 });
  }

  const body = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WAWA//WorldCup2026//UK",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:" + uid,
    "DTSTAMP:" + stamp,
    "DTSTART:" + start,
    "DTEND:" + end,
    "SUMMARY:" + esc(title),
    desc ? "DESCRIPTION:" + esc(desc) : "",
    loc ? "LOCATION:" + esc(loc) : "",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(title), "TRIGGER:-PT30M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"
  ].filter(Boolean).join("\r\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="wc2026.ics"',
      "Cache-Control": "public, max-age=300"
    }
  });
}
