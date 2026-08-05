# History

Development log for Vibin (synced YouTube listening rooms). Newest first.

## Synced lyrics

- Keyless LRCLIB proxy at `/lyrics`, edge cached per track. Client shows LRC
  lines beside the album art and highlights the active line off the shared clock.
- Matching scores by duration closeness, title match, and native script
  (prefers 漢字 / かな over romaji for Japanese songs), and skips
  instrumental / karaoke variants. Logic lives in `pickBestLyric` in
  `public/lib.js` with asserts in `test.mjs`.
- "Fix lyrics" button (next to the mute controls) lets anyone paste an LRCLIB
  track URL. The pin is stored globally per cleaned title plus artist in the
  `Lobby` Durable Object (`/override`) and reused for everyone on future plays.
  Pins persist indefinitely; there is no unpin UI yet.
- Lyrics UX: active line stays centered, early lines rise from the top, last
  lines still reach center (top and bottom spacers). Scrolling the panel pauses
  auto scroll for 4s so you can read ahead. Panel sits beside the art on desktop
  and stacks below on mobile.

## Rooms and lobby

- Landing page with no `room` in the URL: live public room list, Create
  (public or private, always asked) and Join by code.
- A single `Lobby` Durable Object is the registry. Each public room reports its
  count and now playing, and delists itself when it empties. Private rooms never
  hit the lobby and stay code only.
- Fixed room not delisting on leave: `getWebSockets()` still includes the
  closing socket during `webSocketClose`, so `presence` and `reportLobby`
  now exclude it.
- Entering a room no longer needs a second "tap to start"; the landing click
  unlocks audio. Shared links still show the gate.
- Empty rooms self close via a Durable Object alarm 2 min after the last
  listener leaves (canceled if someone rejoins).

## Playlists

- Paste a YouTube or YouTube Music playlist link to enqueue up to 50 tracks.
  Server side scrapes the public playlist page (keyless).
- Titles resolved with retry plus capped concurrency (`meta` retry, `metaBatch`
  limit 6) after raw video IDs showed up under a parallel oEmbed burst.

## Playback sync

- One Durable Object per room holds authoritative state (video, playing,
  position, queue) and fans changes over WebSockets. Late joiners get the
  position projected to now; clients self correct drift over ~1.5s.
- Fixed unintended skips: drift seek past duration triggered ENDED. Guarded
  ENDED with `!applyingRemote` and skip seeks within 0.5s of the end.

## Branding and UI

- Renamed to Vibin. Runethia wordmark with yellow to green gradient, 🎷 favicon.
  Note: Runethia is a personal use only demo font, swap before any public launch.
- Now playing title marquees when it overflows (seamless two copy loop, rebuild
  guarded so the scroll does not stutter on every state broadcast).
- CSS extracted from inline into `public/styles.css` with a section map in
  `public/STYLES.md`.
- Stable per user colors (no longer reshuffle when the user count changes).
- Chinese and IME input guard: hitting Enter mid composition no longer sends the
  half typed romanization.
- Chat notification ding for messages while the tab is unfocused, with a mute
  toggle.

## Mobile

- Bottom tab bar is horizontal and fits the viewport (`100dvh`).
- Pull down to refresh.
- Chat input no longer pushed off screen (`#chat { min-height: 0 }`).

## Base

- Cloudflare Worker plus Durable Objects on the free plan (SQLite storage
  backend). Static client in `public/`, YouTube IFrame API, audio only.
- No API keys: titles from YouTube oEmbed, playlists by scraping.
- `npm test` checks the pure helpers in `public/lib.js`.
