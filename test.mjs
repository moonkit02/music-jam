// Runnable check for the two pieces of non-trivial pure logic.
// Run: node test.mjs
import { parseVideoId, parsePlaylistId, parsePlaylistVideoIds, parseSearchResults, cleanTrackTitle, parseLrc, activeLineIndex, pickBestLyric, lyricKey, parseLrclibId, expectedTime, capLog, parseArtistCmd, parseChannelVideos, parseChannelId, parseYtMusicSongs } from "./public/lib.js";
import assert from "node:assert/strict";

// --- parseSearchResults (id/title/author per renderer, dedup, cap) ---
{
  const s = '"videoRenderer":{"videoId":"aaaaaaaaaaa","title":{"runs":[{"text":"Song A \\u0026 more"}]},"ownerText":{"runs":[{"text":"Artist A"}]}}"videoRenderer":{"videoId":"bbbbbbbbbbb","title":{"runs":[{"text":"Song B"}]},"ownerText":{"runs":[{"text":"Artist B"}]}}';
  assert.deepEqual(parseSearchResults(s), [
    { videoId: "aaaaaaaaaaa", title: "Song A & more", author: "Artist A" },
    { videoId: "bbbbbbbbbbb", title: "Song B", author: "Artist B" },
  ]);
  assert.equal(parseSearchResults(s, 1).length, 1); // cap
}

// --- parseVideoId ---
assert.equal(parseVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5s"), "dQw4w9WgXcQ");
assert.equal(parseVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(parseVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(parseVideoId("not a link"), null);
assert.equal(parseVideoId(""), null);

// --- expectedTime ---
const now = 1_000_000;
assert.equal(expectedTime({ videoId: "x", playing: false, baseTime: 30, baseAt: now - 5000 }, now), 30);
assert.equal(expectedTime({ videoId: "x", playing: true, baseTime: 30, baseAt: now - 5000 }, now), 35);
assert.equal(expectedTime({ videoId: null, playing: true, baseTime: 30, baseAt: now }, now), 0);

// --- capLog (ring buffer for chat/activity history) ---
const log = [];
for (let i = 0; i < 5; i++) capLog(log, i, 3);
assert.deepEqual(log, [2, 3, 4]); // keeps newest 3, drops oldest, preserves order
assert.equal(capLog([], "a", 3).length, 1); // under cap: just appends

// --- parsePlaylistId (real playlists only; skip mixes/radio) ---
assert.equal(parsePlaylistId("https://www.youtube.com/playlist?list=PLabc123_-"), "PLabc123_-");
assert.equal(parsePlaylistId("https://youtube.com/watch?v=dQw4w9WgXcQ&list=OLAK5uy_xyz"), "OLAK5uy_xyz");
assert.equal(parsePlaylistId("https://youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ"), null); // mix
assert.equal(parsePlaylistId("https://youtu.be/dQw4w9WgXcQ"), null); // no list
assert.equal(parsePlaylistId(""), null);

// --- parsePlaylistVideoIds (order, dedup, cap; precise shape then fallback) ---
const page = '"playlistVideoRenderer":{"videoId":"aaaaaaaaaaa"}x"playlistVideoRenderer":{"videoId":"bbbbbbbbbbb"}x"playlistVideoRenderer":{"videoId":"aaaaaaaaaaa"}';
assert.deepEqual(parsePlaylistVideoIds(page), ["aaaaaaaaaaa", "bbbbbbbbbbb"]); // order + dedup
assert.deepEqual(parsePlaylistVideoIds('"videoId":"ccccccccccc"'), ["ccccccccccc"]); // fallback when no precise match
assert.equal(parsePlaylistVideoIds(page, 1).length, 1); // cap

// --- cleanTrackTitle ---
assert.equal(cleanTrackTitle("Never Gonna Give You Up (Official Video)"), "Never Gonna Give You Up");
assert.equal(cleanTrackTitle("Song [MV] feat. X"), "Song"); // trailing tag + bracket stripped
assert.equal(cleanTrackTitle("曖昧ナ希望/氷雨"), "曖昧ナ希望/氷雨"); // non-latin untouched

// --- parseLrc + activeLineIndex ---
const lrc = parseLrc("[ar:Someone]\n[00:10.00] first\n[00:12.50] second\n[00:15.00]");
assert.deepEqual(lrc, [{ t: 10, line: "first" }, { t: 12.5, line: "second" }, { t: 15, line: "" }]); // meta skipped, empty pause kept
assert.equal(activeLineIndex(lrc, 5), -1);   // before first
assert.equal(activeLineIndex(lrc, 11), 0);   // on first
assert.equal(activeLineIndex(lrc, 13), 1);   // on second
assert.equal(activeLineIndex(lrc, 99), 2);   // last

// --- pickBestLyric (duration + native-script + variant scoring) ---
const cands = [
  { trackName: "Chained", duration: 186, syncedLyrics: "[00:01.00] Saiai wa" },            // romaji
  { trackName: "Chained", duration: 186, syncedLyrics: "[00:01.00] 最愛は振りほどいた" },   // native JP
  { trackName: "Chained (Instrumental)", duration: 186, syncedLyrics: "[00:01.00] 最愛は" }, // JP but instrumental
  { trackName: "いらないもの - Chained", duration: 186, syncedLyrics: "[00:01.00] 最愛は" }, // JP, title mismatch
];
assert.equal(pickBestLyric(cands, "tatsuya kitani - chained", 186).syncedLyrics.includes("最愛"), true); // native wins over romaji
assert.equal(pickBestLyric(cands, "tatsuya kitani - chained", 186).trackName, "Chained");               // plain, not instrumental/変
// English song: no JP candidates, closest duration + title wins
const eng = [
  { trackName: "Never Gonna Give You Up", duration: 213, syncedLyrics: "[00:01.00] We're no strangers" },
  { trackName: "Never Gonna Give You Up (Instrumental)", duration: 213, syncedLyrics: "[00:01.00] la la" },
];
assert.equal(pickBestLyric(eng, "never gonna give you up", 213).trackName, "Never Gonna Give You Up");

// --- lyricKey + parseLrclibId (lyrics pin) ---
assert.equal(lyricKey("Chained (Official Video)", "Tatsuya Kitani - Topic"), "chained|tatsuya kitani"); // cleaned + topic stripped
assert.equal(parseLrclibId("https://lrclib.net/tracks/36317191"), "36317191");
assert.equal(parseLrclibId("https://lrclib.net/api/get/36317191"), "36317191");
assert.equal(parseLrclibId("36317191"), "36317191"); // bare id
assert.equal(parseLrclibId("not a url"), null);

// --- ad/stall episode counter (mirrors the tick logic in index.html) ---
// One count per frozen episode, regardless of how many ticks it lasts.
function countAds(times) { // times = getCurrentTime() per tick while playing
  let last = 0, stall = 0, ads = 0;
  for (const t of times) {
    if (t > last + 0.05) stall = 0;
    else if (t > 0 && ++stall === 2) ads++;
    last = t;
  }
  return ads;
}
assert.equal(countAds([1, 1.4, 1.8, 2.2]), 0);          // smooth playback, no ad
assert.equal(countAds([1, 1, 1, 1.4, 1.8]), 1);         // one 3-tick freeze = one ad
assert.equal(countAds([1, 2, 2, 2, 3, 3, 3, 4]), 2);    // two separate freezes
assert.equal(countAds([1, 1]), 0);                       // single frozen tick is not enough

// --- song-end quorum (mirrors the "next" vote logic in worker.js) ---
// advance only when every socket has voted for the current video; manual/force bypass.
function shouldAdvance(votesForThisVid, totalSockets, { manual = false, force = false } = {}) {
  if (manual || force) return true;
  return votesForThisVid >= totalSockets;
}
assert.equal(shouldAdvance(1, 1), true);                    // solo listener → immediate
assert.equal(shouldAdvance(2, 3), false);                   // 2 of 3 finished → hold
assert.equal(shouldAdvance(3, 3), true);                    // everyone finished → go
assert.equal(shouldAdvance(1, 3, { force: true }), true);   // grace-timeout forces past stragglers
assert.equal(shouldAdvance(1, 3, { manual: true }), true);  // manual skip ignores the wait

// --- /artist command: pull a channel handle from arg (bare, or a channel URL) ---
assert.equal(parseArtistCmd("/artist @ReoMusicCH"), "ReoMusicCH");
assert.equal(parseArtistCmd("/artist https://music.youtube.com/@ReoMusicCH"), "ReoMusicCH");
assert.equal(parseArtistCmd("/artist https://www.youtube.com/@ReoMusicCH"), "ReoMusicCH");
assert.equal(parseArtistCmd("/artist Reo"), "");         // no @handle → not channel mode
assert.equal(parseArtistCmd("lofi"), "");                // no command → plain search

// --- parseChannelVideos: lockupViewModel layout (id + title + channel author) ---
const chanHtml = `pre"channelMetadataRenderer":{"title":"Reo","x":1}mid`
  + `"lockupViewModel":{"a":1,"contentId":"gV2Av0y0WLI","metadata":{"lockupMetadataViewModel":{"title":{"content":"Lively Beach Town"}}}}`
  + `"lockupViewModel":{"contentId":"ABCDEFGHIJK","metadata":{"lockupMetadataViewModel":{"title":{"content":"Second Song"}}}}`;
const chanItems = parseChannelVideos(chanHtml);
assert.equal(chanItems.length, 2);
assert.deepEqual(chanItems[0], { videoId: "gV2Av0y0WLI", title: "Lively Beach Town", author: "Reo" });
assert.equal(chanItems[1].videoId, "ABCDEFGHIJK");

// --- parseChannelId: browseId + name from a youtube.com channel page ---
assert.deepEqual(
  parseChannelId(`z"channelMetadataRenderer":{"title":"Reo"}z"externalId":"UC7diLYdTVp-jYqSIo--SJBA"z`),
  { browseId: "UC7diLYdTVp-jYqSIo--SJBA", author: "Reo" });

// --- parseYtMusicSongs: songs from list rows + video cards, albums skipped ---
const ytm = {
  contents: [
    { musicResponsiveListItemRenderer: {
        flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Starry Night" }] } } }],
        overlay: { play: { navigationEndpoint: { watchEndpoint: { videoId: "w_PcZWLjYoQ" } } } } } },
    { musicTwoRowItemRenderer: { title: { runs: [{ text: "A Music Video" }] },
        navigationEndpoint: { watchEndpoint: { videoId: "vYLUZNhT-oY" } } } },
    { musicTwoRowItemRenderer: { title: { runs: [{ text: "An Album" }] }, // album card → no videoId → skipped
        navigationEndpoint: { browseEndpoint: { browseId: "MPREb_xxx" } } } },
  ],
};
const ytmSongs = parseYtMusicSongs(ytm, "Reo");
assert.equal(ytmSongs.length, 2);                        // album card skipped
assert.deepEqual(ytmSongs[0], { videoId: "w_PcZWLjYoQ", title: "Starry Night", author: "Reo" });
assert.equal(ytmSongs[1].videoId, "vYLUZNhT-oY");
assert.deepEqual(parseYtMusicSongs("not json", "Reo"), []); // bad input → empty, no throw

console.log("ok");
