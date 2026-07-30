// Pure helpers shared by the client and the test. Kept API-free so both can import.

export function parseVideoId(input) {
  if (!input) return null;
  input = String(input).trim();
  if (/^[\w-]{11}$/.test(input)) return input; // bare id
  const m = input.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// Where playback *should* be right now, given the last server state.
export function expectedTime(state, now = Date.now()) {
  if (!state || state.videoId == null) return 0;
  const elapsed = state.playing ? (now - state.baseAt) / 1000 : 0;
  return state.baseTime + elapsed;
}
