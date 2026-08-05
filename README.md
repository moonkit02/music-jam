# music-jam

Synced YouTube listening rooms. Open a room, share the link, and everyone hears
the same track at the same timestamp. Anyone can play/pause/seek, queue songs, and
chat — a jam session, not a broadcast.

## How it works

- **Client** (`public/`) — one static page (`index.html`) using the YouTube IFrame
  API. Its own controls drive playback (native controls hidden) so every action is
  explicit. Styles live in `public/styles.css` (not inline); see
  [`public/STYLES.md`](public/STYLES.md) for the section map when changing CSS.
- **Server** (`src/worker.js`) — a Cloudflare Worker with one **Durable Object per
  room**. The DO holds the authoritative state (current video, playing, position,
  queue) and fans changes to all clients over WebSockets. Late joiners get the
  position projected to *now*, and clients self-correct drift > ~1.5s.
- **Landing + lobby** — with no `room` in the URL you get a landing page: a list of
  live **public** rooms, plus Create (public/private, always asked) and Join-by-code.
  A single **`Lobby` Durable Object** is the registry; each room reports its
  count/now-playing when public and delists itself when it empties. Private rooms
  never hit the lobby and stay code-only.
- No API keys: track titles come from YouTube's keyless oEmbed endpoint; playlist
  links are expanded by scraping the public playlist page server-side (cap 50).
- **Synced lyrics** — the worker proxies [LRCLIB](https://lrclib.net) (keyless) at
  `/lyrics`, edge-cached per track. The client shows the LRC lines beside the album art
  and highlights the active one off the same shared clock, so the room stays in sync.
  Matching scores by duration, title, native script (prefers 漢字/かな over romaji),
  and skips instrumental/karaoke variants. If it still picks wrong, "wrong lyrics?"
  lets anyone paste an LRCLIB track URL; the pin is saved globally per title+artist in
  the `Lobby` DO and reused for everyone.

## Run locally

```bash
npm install
npm run dev        # wrangler dev, then open the printed localhost URL
```

Quick public URL for testing on a phone (no LAN setup) — point it at the port
`wrangler dev` prints:

```bash
cloudflared tunnel --url http://localhost:8787
```

## Deploy (Cloudflare)

```bash
npx wrangler login
npm run deploy
```

Durable Objects use the SQLite storage backend (`new_sqlite_classes` in
`wrangler.toml`), which works on the **free** Workers plan. Migrations `v1` (Room)
and `v2` (Lobby) apply automatically on deploy.

## Test

```bash
npm test           # checks the id parser + drift-time math
```

## Limits / add later

- Anyone can control anything (no host lock); add a host role if a room needs one.
- One device can join as multiple users (each tab = a new user). TODO: add a
  per-browser `localStorage` client id sent on `hello`, and dedupe on the server
  (kick the old socket) so one browser = one presence. Won't cover incognito /
  other browsers / other devices — those legitimately look like new users.
- Empty rooms self-close: a Durable Object alarm wipes room state 2 min after the last listener leaves (canceled if someone rejoins).
- Chat + activity are kept in room state (last 50 each) so joiners get the
  session history; they're wiped when the room self-closes, and never persisted
  beyond that. No auth; names are self-assigned.

## Changelog

Newest first. Short entries so features are easy to track.

- **Lyrics UX** — lyrics panel sits beside the album art (stacks below on mobile).
  Active line highlights and stays centered; early lines rise from the top, last
  lines still reach center (top/bottom spacers). Scrolling the panel pauses
  auto-scroll for 4s so you can read ahead. "Fix lyrics" button (next to the mute
  buttons) pins a specific LRCLIB track per song for everyone.
- **Synced lyrics** — keyless LRCLIB proxy at `/lyrics`; duration/title/native-script
  scoring, skips instrumental/karaoke variants.
- **Rooms landing + lobby** — public room list, Create (public/private), Join-by-code;
  `Lobby` Durable Object registry. Entering a room no longer needs a second "tap to
  start" (the landing click unlocks audio); shared links still show the gate.
- **Playlists** — paste a YouTube/YT-Music playlist link to enqueue up to 50 tracks
  (server-side scrape, keyless); titles resolved with retry + capped concurrency.
- **Chat notifications** — a "ding" for messages that arrive while the tab is
  unfocused, with a mute toggle in the chat header.
- **Branding** — renamed to **Vibin** (Runethia wordmark, yellow→green gradient, 🎷
  favicon). Note: Runethia is a personal-use-only demo font — swap before any public
  launch.
- **Mobile fixes** — bottom tab bar is horizontal and fits the viewport (`100dvh`);
  pull-down-to-refresh; chat input no longer pushed off-screen; now-playing title
  marquees when too long.
