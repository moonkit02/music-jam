// music-jam — synced YouTube listening rooms on Cloudflare.
// One Durable Object per room holds the authoritative playback state and fans
// changes out to every connected client over WebSockets.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "lobby").slice(0, 64);
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
};

const FRESH = () => ({
  videoId: null,
  title: null,
  author: null,
  playing: false,
  time: 0, // playback position captured at updatedAt
  updatedAt: Date.now(),
  queue: [], // [{ videoId, title, author }]
});

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.data = null;
  }

  async load() {
    if (!this.data) this.data = (await this.state.storage.get("data")) || FRESH();
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
      playing: d.playing, time, queue: d.queue,
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
    this.broadcast({ type: "activity", name: this.actor(ws), action, detail: detail || "", at: Date.now() });
  }

  // Roster: count + nicknames, read from each socket's attachment.
  presence() {
    const names = this.state.getWebSockets().map((w) => {
      try { return w.deserializeAttachment()?.name || "anon"; } catch { return "anon"; }
    });
    return { type: "users", users: names.length, names };
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket")
      return new Response("expected websocket", { status: 426 });
    await this.load();
    await this.state.storage.deleteAlarm(); // someone's here → cancel any pending close
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server); // hibernatable: no bill while idle
    server.send(JSON.stringify(this.snapshot()));
    this.broadcast(this.presence());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const d = this.data;

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
      case "next": {
        // Ignore stale "ended" reports for a song we already moved past.
        if (m.videoId && m.videoId !== d.videoId) return;
        const skipped = d.title;
        this.advance();
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
        break;
      }
      case "hello":
        ws.serializeAttachment({ name: String(m.name || "anon").slice(0, 24) });
        this.broadcast(this.presence());
        return; // roster only, no state broadcast
      case "chat":
        this.broadcast({
          type: "chat",
          name: String(m.name || "anon").slice(0, 24),
          text: String(m.text || "").slice(0, 300),
        });
        return; // transient — not persisted, no state broadcast
      default:
        return;
    }

    await this.save();
    this.broadcast(this.snapshot());
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

  async webSocketClose() {
    this.broadcast(this.presence());
    await this.state.storage.setAlarm(Date.now() + 2 * 60 * 1000); // close room if still empty in 2 min
  }
  async webSocketError() {
    this.broadcast(this.presence());
    await this.state.storage.setAlarm(Date.now() + 2 * 60 * 1000);
  }

  // Fires 2 min after the last close. If nobody came back, wipe the room.
  async alarm() {
    if (this.state.getWebSockets().length === 0) {
      await this.state.storage.deleteAll();
      this.data = null; // next load() starts fresh
    }
  }

  // Resolve title + artist without an API key. oEmbed is keyless; falls back to the id.
  async meta(videoId) {
    try {
      const r = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
      );
      if (r.ok) {
        const j = await r.json();
        return { title: j.title || videoId, author: j.author_name || "" };
      }
    } catch {}
    return { title: videoId, author: "" };
  }
}
