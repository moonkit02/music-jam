# music-jam

Synced YouTube listening rooms. Open a room, share the link, and everyone hears
the same track at the same timestamp. Anyone can play/pause/seek, queue songs, and
chat — a jam session, not a broadcast.

## How it works

- **Client** (`public/`) — one static page using the YouTube IFrame API. Its own
  controls drive playback (native controls hidden) so every action is explicit.
- **Server** (`src/worker.js`) — a Cloudflare Worker with one **Durable Object per
  room**. The DO holds the authoritative state (current video, playing, position,
  queue) and fans changes to all clients over WebSockets. Late joiners get the
  position projected to *now*, and clients self-correct drift > ~1.5s.
- No API keys: track titles come from YouTube's keyless oEmbed endpoint.

## Run locally

```bash
npm install
npm run dev        # wrangler dev, then open the printed localhost URL
```

## Deploy (Cloudflare)

```bash
npx wrangler login
npm run deploy
```

Durable Objects use the SQLite storage backend (`new_sqlite_classes` in
`wrangler.toml`), which works on the **free** Workers plan. First deploy applies
the `v1` migration automatically.

## Test

```bash
npm test           # checks the id parser + drift-time math
```

## Limits / add later

- Anyone can control anything (no host lock); add a host role if a room needs one.
- Empty rooms self-close: a Durable Object alarm wipes room state 2 min after the last listener leaves (canceled if someone rejoins).
- Chat is transient (not stored) and has no auth; names are self-assigned.
