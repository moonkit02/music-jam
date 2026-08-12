// music-jam — synced YouTube listening rooms on Cloudflare.
// One Durable Object per room holds the authoritative playback state and fans
// changes out to every connected client over WebSockets.

import { capLog, parsePlaylistVideoIds, parseSearchResults, cleanTrackTitle, pickBestLyric, lyricKey, parseLrclibId } from "../public/lib.js";

const LYRICS_UA = { "user-agent": "Vibin (+https://github.com/moonkit02/my-claude-skill)" };

const PLAYLIST_CAP = 100; // max songs pulled from one playlist link (YouTube embeds ~100 in the initial page; beyond that needs continuation tokens we don't scrape)

// Auto-DJ (radio): once a genre is set, when the queue runs dry we scrape a keyless
// YouTube search for that genre and random-pick from the results. No genre set → no
// auto-play; the room stays idle and the client asks the user what to put on.
// ponytail: search-scrape, no API key, no playlist to rot.
const RADIO_MIN = 3; // radio keeps at least this many tracks queued up next
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const lobbyStub = (env) => env.LOBBY.get(env.LOBBY.idFromName("global"));

const YT_UA = { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" };

// One search page → the results embedded in its HTML (~20-25 clean items). Beyond
// that YouTube pages via an innertube "lockup" format that's fragile to parse, so
// we take the reliable first page and let the client reveal it in chunks.
async function searchFirst(q) {
  const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=en`, { headers: YT_UA });
  if (!r.ok) return { items: [] };
  return { items: parseSearchResults(await r.text(), 30) };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "lobby").slice(0, 64);
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(req);
    }
    if (url.pathname === "/rooms") {
      return lobbyStub(env).fetch("https://lobby/rooms"); // public room list for the landing page
    }
    if (url.pathname === "/lyrics") {
      return handleLyrics(url, env);
    }
    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") || "").slice(0, 80).trim();
      if (!q) return Response.json({ items: [] });
      try { return Response.json(await searchFirst(q)); } catch { return Response.json({ items: [] }); }
    }
    if (url.pathname === "/lyrics/set" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const id = parseLrclibId(b.url || "");
      const key = lyricKey(b.title || "", b.artist || "");
      if (!id || key === "|") return Response.json({ ok: false }, { status: 400 });
      await lobbyStub(env).fetch("https://lobby/override", { method: "POST", body: JSON.stringify({ key, trackId: id }) });
      return Response.json({ ok: true, id });
    }
    return new Response("not found", { status: 404 });
  },
};

// Keyless synced-lyrics lookup via LRCLIB, proxied here (no CORS, no key). If a user
// has pinned a specific LRCLIB track for this title+artist, that wins; otherwise we
// search and score. Edge-cached so listeners on the same track share one upstream hit.
async function handleLyrics(url, env) {
  const rawTitle = url.searchParams.get("title") || "";
  const rawArtist = url.searchParams.get("artist") || "";
  const title = cleanTrackTitle(rawTitle);
  const artist = rawArtist.replace(/\s*-\s*topic\s*$/i, "").trim();
  const dur = Number(url.searchParams.get("dur")) || 0;

  // user pin (global) for this song, if any
  let pinId = null;
  try {
    const o = await lobbyStub(env).fetch("https://lobby/override?key=" + encodeURIComponent(lyricKey(rawTitle, rawArtist)));
    if (o.ok) pinId = (await o.json()).trackId || null;
  } catch {}

  const cache = caches.default;
  const key = new Request("https://lyrics/v3?" + (pinId ? "id=" + pinId : url.searchParams.toString()));
  const hit = await cache.match(key);
  if (hit) return hit;

  let body = { found: false };
  try {
    if (pinId) {
      const r = await fetch(`https://lrclib.net/api/get/${pinId}`, { headers: LYRICS_UA });
      if (r.ok) { const g = await r.json(); if (g.syncedLyrics) body = { found: true, synced: g.syncedLyrics, track: g.trackName, artist: g.artistName, pinned: true }; }
    } else {
      const q = encodeURIComponent([title, artist].filter(Boolean).join(" "));
      const r = await fetch(`https://lrclib.net/api/search?q=${q}`, { headers: LYRICS_UA });
      if (r.ok) {
        const arr = await r.json();
        const synced = Array.isArray(arr) ? arr.filter((x) => x.syncedLyrics) : [];
        const best = pickBestLyric(synced, title.toLowerCase(), dur);
        if (best) body = { found: true, synced: best.syncedLyrics, track: best.trackName, artist: best.artistName };
      }
    }
  } catch {}
  // short client cache so a newly-set pin propagates quickly; edge dedups within it
  const resp = Response.json(body, { headers: { "cache-control": "public, max-age=300" } });
  await cache.put(key, resp.clone());
  return resp;
}

const LOG_CAP = 50; // per-room ring buffer for chat + activity replayed to joiners

const FRESH = () => ({
  videoId: null,
  title: null,
  author: null,
  playing: false,
  time: 0, // playback position captured at updatedAt
  updatedAt: Date.now(),
  queue: [], // [{ videoId, title, author }]
  chatLog: [], // last LOG_CAP chats: { name, text }
  activityLog: [], // last LOG_CAP activity events: { name, action, detail, at }
  code: null, // this room's 4-digit code (learned from the first connect)
  public: null, // null = never created via UI (treated private); true/false set by creator
  radio: true, // auto-DJ: always keep the queue fed while listeners are present
  radioQuery: "", // genre/keyword the room chose for radio ("" → RADIO_QUERY default)
  radioPool: [], // shuffled, not-yet-played ids for the current radio session
});

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.data = null;
  }

  async load() {
    if (!this.data) this.data = (await this.state.storage.get("data")) || FRESH();
    this.data.chatLog ||= []; // rooms saved before history existed
    this.data.activityLog ||= [];
    return this.data;
  }

  save() {
    return this.state.storage.put("data", this.data);
  }

  // Current state with `time` projected to now so late joiners land in sync.
  snapshot() {
    const d = this.data;
    let time = d.time;
    if (d.playing && d.videoId != null) time += (Date.now() - d.updatedAt) / 1000;
    return {
      type: "state",
      videoId: d.videoId, title: d.title, author: d.author,
      playing: d.playing, time, queue: d.queue, radio: d.radio, radioQuery: d.radioQuery,
    };
  }

  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws !== except) {
        try { ws.send(s); } catch {}
      }
    }
  }

  actor(ws) {
    try { return ws.deserializeAttachment()?.name || "someone"; } catch { return "someone"; }
  }
  // Transient activity feed event (not persisted), stamped with server time.
  logActivity(ws, action, detail) {
    const ev = { name: this.actor(ws), action, detail: detail || "", at: Date.now() };
    capLog(this.data.activityLog, ev, LOG_CAP); // callers fall through to save()
    this.broadcast({ type: "activity", ...ev });
  }

  // Roster: count + nicknames, read from each socket's attachment. `except` drops
  // the socket that's closing (getWebSockets() still lists it during webSocketClose).
  presence(except) {
    const names = this.state.getWebSockets().filter((w) => w !== except).map((w) => {
      try { return w.deserializeAttachment()?.name || "anon"; } catch { return "anon"; }
    });
    return { type: "users", users: names.length, names };
  }

  // Upsert or remove this room in the global lobby. Only public rooms with at
  // least one listener are listed. Fire-and-forget: the lobby is best-effort.
  reportLobby(closing) {
    const d = this.data;
    if (!d.code) return;
    const count = this.state.getWebSockets().filter((s) => s !== closing).length;
    const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName("global"));
    const body = d.public && count > 0
      ? { op: "upsert", code: d.code, count, title: d.title }
      : { op: "remove", code: d.code };
    this.state.waitUntil?.(stub.fetch("https://lobby/report", { method: "POST", body: JSON.stringify(body) }).catch(() => {}));
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket")
      return new Response("expected websocket", { status: 426 });
    await this.load();
    const url = new URL(req.url);
    const code = (url.searchParams.get("room") || "").slice(0, 64);
    if (code) this.data.code = code; // learn our own code from the connect
    // creator's visibility choice sticks; honored only while still unset
    if (this.data.public === null && url.searchParams.has("public"))
      this.data.public = url.searchParams.get("public") === "1";
    await this.save();
    await this.state.storage.deleteAlarm(); // someone's here → cancel any pending close
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server); // hibernatable: no bill while idle
    server.send(JSON.stringify(this.snapshot()));
    server.send(JSON.stringify({ type: "history", chat: this.data.chatLog, activity: this.data.activityLog }));
    this.broadcast(this.presence());
    this.reportLobby();
    if (this.data.radio) this.state.waitUntil?.(this.radioTick()); // idle radio room woke up → feed it
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const d = this.data;
    const titleBefore = d.title;

    switch (m.type) {
      case "play":
        d.playing = true;
        if (typeof m.time === "number") d.time = m.time;
        d.updatedAt = Date.now();
        this.logActivity(ws, "resumed");
        break;
      case "pause":
        d.time = typeof m.time === "number" ? m.time : this.snapshot().time;
        d.playing = false;
        d.updatedAt = Date.now();
        this.logActivity(ws, "paused");
        break;
      case "seek":
        d.time = Number(m.time) || 0;
        d.updatedAt = Date.now();
        break;
      case "enqueue": {
        const videoId = String(m.videoId || "").slice(0, 16);
        if (!videoId) return;
        const meta = await this.meta(videoId);
        d.queue.push({ videoId, ...meta });
        if (d.videoId == null) this.advance(); // nothing playing → start now
        this.logActivity(ws, "added", meta.title);
        break;
      }
      case "enqueue_playlist": {
        const list = String(m.list || "");
        if (!/^(PL|OLAK5uy_)[\w-]+$/.test(list)) return; // real playlists only
        const ids = await this.fetchPlaylist(list.slice(0, 64));
        if (!ids.length) return;
        const metas = await this.metaBatch(ids); // limited concurrency so oEmbed doesn't throttle
        ids.forEach((videoId, i) => d.queue.push({ videoId, ...metas[i] }));
        if (d.videoId == null) this.advance(); // nothing playing → start now
        this.logActivity(ws, "added", `${ids.length} song${ids.length > 1 ? "s" : ""} from a playlist`);
        break;
      }
      case "next": {
        // Ignore stale "ended" reports for a song we already moved past.
        if (m.videoId && m.videoId !== d.videoId) return;
        const skipped = d.title;
        this.advance();
        await this.radioFill(); // radio on + queue ran dry → top it back up
        if (m.manual) this.logActivity(ws, "skipped", skipped); // song-ended auto-next isn't logged
        break;
      }
      case "reorder": {
        // Rebuild the queue to match the client's videoId order. Pulls one
        // matching item per id so duplicate tracks reorder correctly.
        const order = Array.isArray(m.order) ? m.order.map(String) : [];
        const pool = d.queue.slice();
        const next = [];
        for (const vid of order) {
          const i = pool.findIndex((x) => x.videoId === vid);
          if (i >= 0) next.push(pool.splice(i, 1)[0]);
        }
        d.queue = next.concat(pool); // keep any leftovers (shouldn't happen)
        break;
      }
      case "remove": {
        const i = Number(m.index), vid = String(m.videoId || "");
        let removed = null;
        if (Number.isInteger(i) && d.queue[i] && d.queue[i].videoId === vid) removed = d.queue.splice(i, 1)[0];
        else { const j = d.queue.findIndex((x) => x.videoId === vid); if (j >= 0) removed = d.queue.splice(j, 1)[0]; }
        if (removed) this.logActivity(ws, "removed", removed.title);
        await this.radioFill(); // dropped below RADIO_MIN → top the list back up
        break;
      }
      case "hello":
        ws.serializeAttachment({ name: String(m.name || "anon").slice(0, 24) });
        this.broadcast(this.presence());
        return; // roster only, no state broadcast
      case "chat": {
        const name = String(m.name || "anon").slice(0, 24);
        const text = String(m.text || "").slice(0, 300);
        if (!text) return;
        capLog(d.chatLog, { name, text }, LOG_CAP);
        await this.save();
        this.broadcast({ type: "chat", name, text });
        return; // handled here, skip the trailing state broadcast
      }
      case "radio": {
        // Radio is always on; this just sets/changes the genre keyword.
        const q = String(m.query || "").slice(0, 80).trim();
        if (q && q !== d.radioQuery) { d.radioQuery = q; d.radioPool = []; } // new keyword → fresh pool
        await this.radioFill();
        this.logActivity(ws, `radio → ${d.radioQuery || "mix"} 📻`);
        break;
      }
      case "duration": {
        // A client resolved a queued track's real length (hidden player). Stamp it
        // onto every matching queue item so late joiners get it in the snapshot,
        // then broadcast the patch so current listeners update without a re-resolve.
        const vid = String(m.videoId || "").slice(0, 16);
        const secs = Math.min(24 * 3600, Math.max(0, Math.round(Number(m.secs) || 0)));
        if (!vid || !secs) return;
        let hit = false;
        for (const q of d.queue) if (q.videoId === vid && !q.secs) { q.secs = secs; hit = true; }
        if (!hit) return; // already known, or the item's gone
        await this.save();
        this.broadcast({ type: "duration", videoId: vid, secs });
        return;
      }
      default:
        return;
    }

    await this.save();
    this.broadcast(this.snapshot());
    if (d.title !== titleBefore) this.reportLobby(); // now-playing changed → refresh the lobby entry
  }

  advance() {
    const d = this.data;
    const next = d.queue.shift();
    d.videoId = next ? next.videoId : null;
    d.title = next ? next.title : null;
    d.author = next ? next.author : null;
    d.time = 0;
    d.playing = !!next;
    d.updatedAt = Date.now();
  }

  async webSocketClose(ws) {
    this.broadcast(this.presence(ws), ws);
    this.reportLobby(ws); // count dropped (or hit 0 → delist)
    await this.state.storage.setAlarm(Date.now() + 2 * 60 * 1000); // close room if still empty in 2 min
  }
  async webSocketError(ws) {
    this.broadcast(this.presence(ws), ws);
    this.reportLobby(ws);
    await this.state.storage.setAlarm(Date.now() + 2 * 60 * 1000);
  }

  // Fires 2 min after the last close. If nobody came back, wipe the room.
  async alarm() {
    if (this.state.getWebSockets().length === 0) {
      await this.load();
      this.reportLobby(); // count is 0 → removes it from the lobby
      await this.state.storage.deleteAll();
      this.data = null; // next load() starts fresh
    }
  }

  // Resolve title + artist without an API key. oEmbed is keyless. Retries transient
  // failures (429 / 5xx / network) with backoff — a burst of playlist lookups can get
  // throttled, which otherwise leaves a track showing its raw video id. Falls back to
  // the id only after retries, and doesn't retry permanent errors (404/private/embed-off).
  async meta(videoId) {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url);
        if (r.ok) {
          const j = await r.json();
          return { title: j.title || videoId, author: j.author_name || "" };
        }
        if (r.status !== 429 && r.status < 500) break; // permanent → stop retrying
      } catch {}
      await new Promise((res) => setTimeout(res, 200 * (i + 1)));
    }
    return { title: videoId, author: "" };
  }

  // Resolve metas with capped concurrency so we don't fire dozens of oEmbed
  // requests at once (the burst is what gets throttled).
  async metaBatch(ids, limit = 6) {
    const out = new Array(ids.length);
    let next = 0;
    const worker = async () => { while (next < ids.length) { const i = next++; out[i] = await this.meta(ids[i]); } };
    await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, worker));
    return out;
  }

  // ---- auto-DJ (radio) ----
  // Scrape a pool of video ids from a keyless search (reuses the playlist parser's
  // fallback videoId scan). Fixed host → the query can't be used for SSRF.
  async radioIds() {
    try {
      const q = this.data.radioQuery;
      if (!q) return [];
      const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=en`, {
        headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" },
      });
      if (!r.ok) return [];
      return parsePlaylistVideoIds(await r.text(), 200);
    } catch { return []; }
  }

  // Keep one track playing + one on deck while radio is on and someone's listening.
  // Only fills the gap, so a user's own queued songs always take priority. Returns
  // whether it changed anything (so callers know to broadcast).
  async radioFill() {
    const d = this.data;
    if (!d.radio || !d.radioQuery || this.state.getWebSockets().length === 0) return false; // no genre → don't auto-play, let the user pick
    let changed = false;
    while (d.queue.length < RADIO_MIN) { // keep RADIO_MIN tracks in the up-next list
      if (!d.radioPool?.length) {
        d.radioPool = shuffle(await this.radioIds());
        if (!d.radioPool.length) break; // scrape failed → give up this round, retry next tick
      }
      const videoId = d.radioPool.shift();
      const meta = await this.meta(videoId);
      d.queue.push({ videoId, ...meta });
      if (d.videoId == null) this.advance(); // first track → start playing now
      changed = true;
    }
    return changed;
  }

  // Fill + persist + broadcast. Used from paths that don't already fall through to
  // the message loop's trailing save/broadcast (e.g. a listener joining).
  async radioTick() {
    if (await this.radioFill()) { await this.save(); this.broadcast(this.snapshot()); this.reportLobby(); }
  }

  // Keyless playlist expansion: fetch the public playlist page and scrape video
  // ids from its embedded data. Fixed host, so the validated list id can't be
  // used for SSRF. Empty on any failure (caller no-ops).
  async fetchPlaylist(list) {
    try {
      const r = await fetch(`https://www.youtube.com/playlist?list=${list}&hl=en`, {
        headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" },
      });
      if (!r.ok) return [];
      return parsePlaylistVideoIds(await r.text(), PLAYLIST_CAP);
    } catch {
      return [];
    }
  }
}

const ROOM_TTL = 4 * 60 * 1000; // drop lobby entries not refreshed within 4 min (crash safety net)

// Single global registry of public rooms. Rooms POST upsert/remove; the landing
// page GETs the list. Entries carry a timestamp so a room that dies without
// delisting is filtered out after ROOM_TTL.
export class Lobby {
  constructor(state) {
    this.state = state;
    this.rooms = null; // { [code]: { count, title, at } }
  }

  async load() {
    if (!this.rooms) this.rooms = (await this.state.storage.get("rooms")) || {};
    return this.rooms;
  }

  fresh() {
    const now = Date.now();
    const out = [];
    for (const [code, r] of Object.entries(this.rooms)) {
      if (now - r.at > ROOM_TTL) delete this.rooms[code];
      else out.push({ code, count: r.count, title: r.title || null });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  async fetch(req) {
    await this.load();
    const url = new URL(req.url);

    // user lyric pins: { [title|artist key]: lrclibTrackId }
    if (url.pathname === "/override") {
      this.overrides ||= (await this.state.storage.get("overrides")) || {};
      if (req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        if (b.key) {
          if (b.trackId) this.overrides[b.key] = String(b.trackId);
          else delete this.overrides[b.key];
          await this.state.storage.put("overrides", this.overrides);
        }
        return new Response("ok");
      }
      return Response.json({ trackId: this.overrides[url.searchParams.get("key") || ""] || null });
    }

    if (req.method === "POST" && url.pathname === "/report") {
      const b = await req.json().catch(() => ({}));
      const code = String(b.code || "").slice(0, 64);
      if (code) {
        if (b.op === "remove" || !b.count) delete this.rooms[code];
        else this.rooms[code] = { count: b.count, title: b.title || null, at: Date.now() };
        await this.state.storage.put("rooms", this.rooms);
      }
      return new Response("ok");
    }

    // GET /rooms → { rooms: [...] }, stale entries pruned
    const list = this.fresh();
    await this.state.storage.put("rooms", this.rooms); // persist any pruning
    return Response.json({ rooms: list });
  }
}
