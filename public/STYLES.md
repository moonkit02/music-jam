# Styling reference

All CSS lives in `public/styles.css` (linked from `public/index.html`). It is one
file, split into numbered sections by comment banners. To change something, jump
to the section, don't read the whole file.

## Sections (in order)

| # | Section | Selectors | What it controls |
|---|---------|-----------|------------------|
| 1 | base + design tokens | `:root`, `html, body`, `button` | Colors (CSS vars), fonts, the 3-row page grid (`64px 1fr 72px`), global scroll lock |
| 2 | top bar | `.topbar`, `.logo`, `.search`, `#users` | Header: logo, paste-a-link search, listener count |
| 3 | main 3 columns | `.main` | Desktop layout grid: `240px 1fr 340px` (nav / stage / side) |
| 4 | nav (left) | `nav`, `.navitem`, `.newbtn`, `.roommeta` | Left column: room controls |
| 5 | stage (center) | `.stage`, `.art`, `.nowmeta`, `.mute-controls` | Album art + now-playing + mute buttons |
| 6 | side panel (right) | `.side`, `.section-h`, `#queue*`, `#chat*`, `#activity*`, `.subtab` | Up-next queue, chat, activity feed |
| 7 | queue drag | `#queue li.*`, `.sink-ghost`, `body.out-of-list` | Drag-to-reorder + drag-out-to-remove visuals |
| 8 | transport (bottom) | `.transport`, `.np`, `.center`, `.btns`, `.scrub`, `#vol`, `.hidden-player` | Bottom playback bar + the off-screen YT iframe |
| 9 | nav extras | `.joinrow`, `.bigcode`, `.nickrow`, `.nickdot`, `.userlist` | Join-by-code, room code, nickname, roster |
| 10 | audio gate | `#gate`, `#gatebtn` | Tap-to-start overlay (browsers need one tap before audio) |
| 11 | mobile (`<=820px`) | `@media`, `.mtabbar`, `body.mtab-*` | Phone layout: one panel at a time + bottom tab bar |

## Design tokens (section 1)

Change these `:root` vars to re-theme globally: `--bg`, `--panel`, `--hover`,
`--line`, `--sub` (secondary text), `--red` (accent). Per-user chat colors are a
separate 8-color JS palette in `index.html` (`PALETTE`), not CSS.

## How mobile works (section 11)

- Below 820px the 3-column `.main` becomes a single scrollable block; `nav`,
  `.stage`, `.side` are all hidden by default.
- JS sets a `body.mtab-now | mtab-room | mtab-queue | mtab-chat` class (see
  `setMobileTab` in `index.html`); the matching panel is shown via those rules.
- The bottom tab bar is `.mtabbar` (hidden on desktop). Icons use a fixed 24px
  slot so mismatched glyphs (`▶ ≡`) and emoji (`👥 💬`) align.

## Gotchas

- `#chatpane.hidden` / `#activitypane.hidden` restate `display:none` because an ID
  selector beats the plain `.hidden` class.
- `.mtabbar` is defined twice: hidden at the end of the desktop rules, then shown
  inside the `@media` block. Edit the mobile look in section 11.
- New static assets dropped in `public/` are served automatically (see
  `wrangler.toml` `assets = { directory = "public" }`).
