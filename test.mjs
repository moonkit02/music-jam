// Runnable check for the two pieces of non-trivial pure logic.
// Run: node test.mjs
import { parseVideoId, expectedTime } from "./public/lib.js";
import assert from "node:assert/strict";

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

console.log("ok");
