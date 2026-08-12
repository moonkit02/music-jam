// Pure helpers shared by the client, the worker, and the test. Kept API-free so all can import.

// Append to a ring buffer in place, keeping only the newest `cap` entries.
export function capLog(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  return arr;
}


export function parseVideoId(input) {
  if (!input) return null;
  input = String(input).trim();
  if (/^[\w-]{11}$/.test(input)) return input; // bare id
  const m = input.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// Extract a real playlist id from a URL (user playlists PL…, album playlists
// OLAK5uy_…). Skips auto-generated mixes/radio (RD/UL/LL) which are endless.
export function parsePlaylistId(input) {
  if (!input) return null;
  const m = String(input).match(/[?&]list=([\w-]+)/);
  const id = m && m[1];
  return id && /^(PL|OLAK5uy_)[\w-]+$/.test(id) ? id.slice(0, 64) : null;
}

// Pull video ids from a fetched playlist page, in order, deduped, capped.
// Prefers the precise playlist-item shape; falls back to any videoId if that
// yields nothing (YouTube markup drift). ponytail: regex on HTML, known ceiling.
export function parsePlaylistVideoIds(html, cap = 50) {
  const ids = [], seen = new Set();
  const push = (id) => { if (!seen.has(id)) { seen.add(id); ids.push(id); } };
  const scan = (re) => { let m; while ((m = re.exec(html))) push(m[1]); };
  scan(/"playlistVideoRenderer":\{"videoId":"([\w-]{11})"/g);
  if (ids.length === 0) scan(/"videoId":"([\w-]{11})"/g);
  return ids.slice(0, cap);
}

// Parse a YouTube search-results page into [{videoId, title, author}] for a pick
// list. Each result is a "videoRenderer" block; we take id + title + channel from
// it. ponytail: regex on HTML, tolerant of missing author, capped.
export function parseSearchResults(html, cap = 10) {
  const out = [], seen = new Set();
  const dec = (s) => { try { return JSON.parse('"' + s + '"'); } catch { return s; } };
  const re = /"videoRenderer":\{([\s\S]*?)(?="videoRenderer":\{|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < cap) {
    const c = m[1];
    const vid = c.match(/"videoId":"([\w-]{11})"/);
    const title = c.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
    if (!vid || !title || seen.has(vid[1])) continue;
    const author = c.match(/"ownerText":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
    seen.add(vid[1]);
    out.push({ videoId: vid[1], title: dec(title[1]), author: author ? dec(author[1]) : "" });
  }
  return out;
}

// Best-effort cleanup of a YouTube title into something a lyrics DB can match:
// drop bracketed junk and trailing tags like "(Official Video)", "[MV]", "feat. …".
export function cleanTrackTitle(title) {
  return String(title || "")
    .replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】|「[^」]*」/g, " ")
    .replace(/\b(official|lyrics?|audio|video|m\/?v|hd|4k|remaster(?:ed)?|visualizer|feat|ft)\b.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Stable key for a track's lyrics override: cleaned title + normalized artist.
export function lyricKey(title, artist) {
  const t = cleanTrackTitle(title).toLowerCase().trim();
  const a = String(artist || "").replace(/\s*-\s*topic\s*$/i, "").toLowerCase().trim();
  return t + "|" + a;
}

// Pull an LRCLIB track id from a pasted URL (lrclib.net/tracks/123, /api/get/123, or bare id).
export function parseLrclibId(url) {
  const m = String(url || "").match(/(?:tracks\/|get\/)?(\d{3,})/);
  return m ? m[1] : null;
}

const LYRIC_VARIANT = /instrumental|off ?vocal|karaoke|remix|sped ?up|slowed|nightcore|8d/i;
const CJK = /[぀-ヿ一-鿿]/; // hiragana, katakana, kanji

// Choose the best synced LRCLIB result: closest duration (strong signal — we know the
// real playback length), title that matches the video, native Japanese script over
// romaji transliteration, and NOT an instrumental / karaoke / remix variant.
export function pickBestLyric(list, wantTitleLower, dur) {
  const wantsJP = CJK.test(wantTitleLower || "");
  const anyJP = list.some((x) => CJK.test(x.syncedLyrics || ""));
  let best = null, bestScore = -Infinity;
  for (const x of list) {
    const name = (x.trackName || "").toLowerCase();
    let s = 0;
    if (dur && x.duration) s += Math.max(0, 20 - Math.abs(x.duration - dur)); // 0..20, closer = better
    if (wantTitleLower && (wantTitleLower.includes(name) || name.includes(wantTitleLower))) s += 10;
    if ((wantsJP || anyJP) && CJK.test(x.syncedLyrics || "")) s += 12; // real 漢字/かな beats romaji
    if (LYRIC_VARIANT.test(name) && !LYRIC_VARIANT.test(wantTitleLower || "")) s -= 15;
    if (s > bestScore) { bestScore = s; best = x; }
  }
  return best;
}

// Parse LRC text into time-sorted lines: [{ t: seconds, line }]. Skips metadata
// tags ([ar:…]); a bare timestamp with no words becomes an empty line (a pause).
export function parseLrc(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)\]/g)];
    if (!tags.length) continue;
    const line = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of tags) out.push({ t: +m[1] * 60 + parseFloat(m[2].replace(":", ".")), line });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Index of the last line whose timestamp is <= t (-1 before the first line).
export function activeLineIndex(lines, t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

// Where playback *should* be right now, given the last server state.
export function expectedTime(state, now = Date.now()) {
  if (!state || state.videoId == null) return 0;
  const elapsed = state.playing ? (now - state.baseAt) / 1000 : 0;
  return state.baseTime + elapsed;
}
