// Cloudflare Pages Function → маршрут /event.ics
// Віддає одну подію матчу як text/calendar, щоб webcal:// відкривав її
// одразу в Apple Calendar (без завантаження файлу). Дані приходять у query.
export function onRequestGet({ request }) {
  const q = new URL(request.url).searchParams;
  const get = (k, d = "") => (q.get(k) || d);
  const esc = s => String(s)
    .replace(/\\/g, "\\\\").replace(/\n/g, "\\n")
    .replace(/,/g, "\\,").replace(/;/g, "\\;");

  const start = get("start");                 // 20260704T210000Z
  const end   = get("end");
  const title = get("title", "Матч ЧС-2026");
  const desc  = get("desc");
  const loc   = get("loc");
  const uid   = (get("uid", "wc2026-" + start)) + "@wawa-worldcup";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

  // мінімальна валідація часу (…T…Z), щоб не віддавати сміття
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
