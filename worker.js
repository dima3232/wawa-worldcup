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
    if (url.pathname === "/scores")    return scoresRoute(env);
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
// статистику тягнемо лише для плей-офф (нокаут), груповий етап пропускаємо
const isKO = r => !!r && !/group/i.test(r);
// набір слів назви (регістр/порядок неважливі): "DR Congo" == "Congo DR"
const tokset = s => ((s || "").toLowerCase().match(/[a-z]+/g) || []).sort().join(" ");
const pairKey = (a, b) => [tokset(a), tokset(b)].sort().join("|");

// ---- денний бюджет: за РЕАЛЬНИМ залишком з відповіді Highlightly (без власного лічильника) ----
const today = () => new Date().toISOString().slice(0, 10);
async function budgetLeft(env) {
  const v = await env.WC_STATS.get("hl:remaining", "json");
  return v && v.d === today() ? v.rem : DAILY_BUDGET;   // невідомо/новий день → дозволяємо
}
// ключ працює і як звичайний Secret (рядок), і як прив'язка Secrets Store (об'єкт з .get())
async function hlKey(env) {
  const b = env.HIGHLIGHTLY_KEY;
  if (!b) return null;
  return typeof b.get === "function" ? await b.get() : b;
}
async function hlFetch(env, path) {
  const key = await hlKey(env);
  if (!key) return null;
  try {
    const r = await fetch(HL_BASE + path, { headers: { "x-rapidapi-key": key } });
    const rem = r.headers.get("x-ratelimit-requests-remaining");
    if (rem != null) await env.WC_STATS.put("hl:remaining", JSON.stringify({ d: today(), rem: +rem }), { expirationTtl: 172800 });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

// "2 - 1" | {current:"2 - 1"} | null  ->  [2,1] | null
function parseScorePair(v) {
  if (!v) return null;
  const s = typeof v === "string" ? v : (v.current || "");
  const mt = String(s).match(/(\d+)\s*[-:]\s*(\d+)/);
  return mt ? [+mt[1], +mt[2]] : null;
}
// коротший кеш списку, поки хоч один матч у прямому ефірі (свіжий рахунок), інакше довгий
function listTtl(matches) {
  const now = Date.now();
  const live = matches.some(m => m.ts && now >= m.ts && now < m.ts + FINAL_MS);
  return live ? 3 * 60 * 1000 : LIST_TTL_MS;
}

// ---- список матчів ЧС (маппінг назв → matchId + рахунок/статус), кеш у KV ----
async function getMatchList(env) {
  const cached = await env.WC_STATS.get("hl:matches", "json");
  // кеш валідний лише якщо він v2 і НЕ порожній (порожній не віддаємо і не тримаємо)
  const validCache = cached && cached.v === 2 && cached.matches && cached.matches.length ? cached.matches : null;
  if (validCache && (Date.now() - cached.ts) < listTtl(validCache)) return validCache;
  if ((await budgetLeft(env)) <= 2) return validCache || [];
  const r = await hlFetch(env, `/matches?leagueId=${WC_LEAGUE}&season=${WC_SEASON}&limit=100`);
  if (!r || !Array.isArray(r.data)) return validCache || [];
  const matches = r.data.map(m => {
    const st = m.state || {}, sc = st.score || {};
    return {
      id: m.id, round: m.round || "",
      home: (m.homeTeam || {}).name, away: (m.awayTeam || {}).name,
      date: (m.date || "").slice(0, 10), ts: Date.parse(m.date) || 0,
      score: parseScorePair(sc.current), pens: parseScorePair(sc.penalties),
      status: st.description || "", clock: st.clock == null ? null : st.clock
    };
  });
  if (matches.length) await env.WC_STATS.put("hl:matches", JSON.stringify({ v: 2, ts: Date.now(), matches }));
  return matches;
}

// ---- бекап рахунків: увесь список зі свіжими рахунками/статусами (1 запит на всі матчі) ----
async function scoresRoute(env) {
  const matches = await getMatchList(env);
  const out = matches
    .filter(m => m.score || m.status)
    .map(m => ({ home: m.home, away: m.away, date: m.date, ts: m.ts, score: m.score, pens: m.pens, status: m.status, clock: m.clock }));
  return json({ matches: out }, 200, 30);
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
  let backfilled = 0;                                   // не більше N добору завершених за прогін
  for (const m of matches) {
    if ((await budgetLeft(env)) <= 4) break;            // лишаємо запас на список і лайв
    if (!isKO(m.round)) continue;                      // тільки плей-офф
    if (!m.ts || now < m.ts) continue;                 // ще не почався
    const rec = await env.WC_STATS.get("stats:" + m.id, "json");
    if (now < m.ts + FINAL_MS) {                        // йде (враховуючи ЕТ/пенальті)
      if (!rec || (now - rec.updated) >= intervalMs) await fetchStats(env, m, false);
    } else {                                            // завершено → добираємо поступово (≤5/прогін)
      if ((!rec || !rec.final) && backfilled < 5) { await fetchStats(env, m, true); backfilled++; }
    }
  }
}

// ---- клієнтський маршрут ----
async function statsRoute(url, env) {
  const home = url.searchParams.get("home") || "";
  const away = url.searchParams.get("away") || "";
  const date = url.searchParams.get("date") || "";
  if (!home || !away) return json({ error: "bad-params" }, 400);
  const matches = await getMatchList(env);
  const want = pairKey(home, away);
  let m = matches.find(x => pairKey(x.home, x.away) === want && (!date || x.date === date))
       || matches.find(x => pairKey(x.home, x.away) === want);
  if (!m) return json({ status: "no-match" }, 200, 300);
  if (!isKO(m.round)) return json({ status: "group" }, 200, 3600);   // груповий етап — без стат
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
