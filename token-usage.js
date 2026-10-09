const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const DAY = 24 * 60 * 60 * 1000;
const FIELDS = ["total_tokens", "input_tokens", "output_tokens", "cached_input_tokens",
  "reasoning_output_tokens"];
const MAX_LINE = 1024 * 1024;
const ZERO = () => FIELDS.map(() => 0);

function newFile() {
  return { offset: 0, size: 0, mtime: null, identity: null, checkedAt: -Infinity,
    decoder: new StringDecoder("utf8"), tail: "", tailParsed: false, dropping: false,
    checkpoint: Buffer.alloc(0), verify: null,
    high: ZERO(), samples: [], anchor: null, first: null, session: null,
    latestAt: -Infinity, partial: false, unreadable: false };
}

// Read only the outer type, skipping strings/containers without decoding
// dialogue. JSON.parse below still validates the relevant event as a whole.
function envelopeType(line) {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else if (char === '"') {
      const start = i;
      for (i++; i < line.length; i++) {
        if (line[i] === "\\") i++;
        else if (line[i] === '"') break;
      }
      if (depth !== 1 || line.slice(start, i + 1) !== '"type"') continue;
      const match = /^\s*:\s*("(?:[^"\\]|\\.)*")/.exec(line.slice(i + 1));
      if (match) {
        try { return JSON.parse(match[1]); } catch { return null; }
      }
    }
  }
  return null;
}

function parseLine(line, state, cutoff) {
  if (!line.trim()) return true;
  if (!line.trimEnd().endsWith("}")) { state.partial = true; return false; }
  const type = envelopeType(line);
  if (type !== "event_msg" && type !== "session_meta") return true;
  if (type !== "session_meta" && !/"type"\s*:\s*"token_count"/.test(line)) return true;
  let event;
  try { event = JSON.parse(line); }
  catch { state.partial = true; return false; }
  if (event.type === "session_meta") {
    if (typeof event.payload?.id === "string" && event.payload.id) {
      if (state.session && state.session !== event.payload.id) state.partial = true;
      else state.session = event.payload.id;
    }
    return true;
  }
  if (event.type !== "event_msg" || event.payload?.type !== "token_count") return true;
  const usage = event.payload.info?.total_token_usage;
  // Null info is a rate-limit-only event, not a usage observation.
  if (usage == null) return true;
  const counters = FIELDS.map(field => usage[field]);
  if (!counters.every(value => Number.isSafeInteger(value) && value >= 0)) {
    state.partial = true;
    return true;
  }
  if (counters.some((value, i) => value < state.high[i])) {
    // A lower series may be compaction, a stale event, or a replay. There is
    // no reliable reset boundary in token_count alone; retain the high-water.
    state.partial = true;
    return true;
  }
  if (counters.every((value, i) => value === state.high[i])) return true;
  const timestamp = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
  const at = Number.isFinite(timestamp) ? timestamp : 0;
  if (!Number.isFinite(timestamp)) state.partial = true;
  if (at < state.latestAt) state.partial = true;
  state.latestAt = Math.max(state.latestAt, at);
  if (!state.first && counters[0] > 0 && Number.isFinite(timestamp)) {
    state.first = JSON.stringify([at, ...counters]);
  }
  state.high = counters;
  const sample = { at, counters };
  if (at < cutoff) state.anchor = sample;
  else state.samples.push(sample);
  return true;
}

function consume(buffer, state, cutoff) {
  const decoded = state.decoder.write(buffer);
  let start = 0;
  for (let end = decoded.indexOf("\n"); end !== -1; end = decoded.indexOf("\n", start)) {
    const part = decoded.slice(start, end);
    if (!state.dropping && state.tail.length + part.length <= MAX_LINE) {
      parseLine(state.tail + part, state, cutoff);
    } else state.partial = true;
    state.tail = "";
    state.tailParsed = false;
    state.dropping = false;
    start = end + 1;
  }
  if (!state.dropping) {
    if (decoded.slice(start)) state.tailParsed = false;
    state.tail += decoded.slice(start);
    if (state.tail.length > MAX_LINE) {
      state.tail = "";
      state.dropping = true;
      state.partial = true;
    }
  }
}

/**
 * Reads selected local rollouts only. Top-level input/output/cache totals cover
 * the same seven calendar dates as tokens7d. updatedAt is the last scan time
 * (ISO UTC), unreadableFiles is a count, and loading totals are provisional.
 * Counters cannot identify forks/reset boundaries conclusively: ambiguous
 * decreases are lower-bound partial results, never speculative reset sums.
 */
function createUsageCollector({ timeZone = "Asia/Shanghai", maxBytesPerRead = 2 * 1024 * 1024,
  scanIntervalMs = 5000 } = {}) {
  if (!Number.isSafeInteger(maxBytesPerRead) || maxBytesPerRead <= 0) {
    throw new RangeError("maxBytesPerRead must be a positive safe integer");
  }
  if (!Number.isFinite(scanIntervalMs) || scanIntervalMs < 0) {
    throw new RangeError("scanIntervalMs must be nonnegative");
  }
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone,
    year: "numeric", month: "2-digit", day: "2-digit" });
  function dateKey(at) {
    const parts = formatter.formatToParts(at);
    const get = type => parts.find(part => part.type === type).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  const files = new Map();
  let cursor = 0;
  let updatedAt = null;

  function read(rows, { now = Date.now() } = {}) {
    if (!Number.isFinite(now)) throw new RangeError("now must be a finite timestamp");
    const selected = new Set();
    let missingPaths = 0;
    for (const row of rows || []) {
      if (typeof row?.rollout_path !== "string" || !row.rollout_path.trim()) missingPaths++;
      else selected.add(path.resolve(row.rollout_path));
    }
    for (const file of files.keys()) if (!selected.has(file)) files.delete(file);
    for (const file of selected) if (!files.has(file)) files.set(file, newFile());
    const cutoff = now - 8 * DAY;
    for (const [file, previous] of files) {
      let state = previous;
      if (state.verify || state.offset < state.size || now - state.checkedAt >= scanIntervalMs || now < state.checkedAt) {
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile()) throw new Error("not a file");
          const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
          if (stat.size < state.offset || (state.identity && state.identity !== identity) ||
              (state.mtime !== null && stat.size === state.offset && stat.mtimeMs !== state.mtime)) {
            state = newFile();
            files.set(file, state);
          } else if (state.mtime !== null && state.mtime !== stat.mtimeMs && state.checkpoint.length) {
            // Verify previously read bytes before trusting an apparent append.
            // Truncate-and-regrow can otherwise hide behind a larger file size.
            state.verify = { offset: 0 };
          }
          state.size = stat.size;
          state.mtime = stat.mtimeMs;
          state.identity = identity;
          state.unreadable = false;
        } catch { state.unreadable = true; }
        state.checkedAt = now;
        updatedAt = new Date(now).toISOString();
      }
      // Keep an old cumulative anchor, not a full lifetime event history.
      const retained = [];
      for (const sample of state.samples) {
        if (sample.at < cutoff) {
          if (!state.anchor || sample.counters[0] > state.anchor.counters[0]) state.anchor = sample;
        } else retained.push(sample);
      }
      state.samples = retained;
    }

    const entries = [...files.entries()];
    let budget = maxBytesPerRead;
    let visited = 0;
    while (visited < entries.length && budget > 0) {
      const index = cursor % entries.length;
      const file = entries[index][0];
      let state = entries[index][1];
      cursor = (index + 1) % entries.length;
      visited++;
      if (state.unreadable || (!state.verify && state.offset >= state.size)) continue;
      let fd;
      try {
        fd = fs.openSync(file, "r");
        while (budget > 0 && state.verify) {
          const position = state.verify.offset;
          const size = Math.min(budget, state.checkpoint.length - position);
          const buffer = Buffer.allocUnsafe(size);
          const count = fs.readSync(fd, buffer, 0, size,
            state.offset - state.checkpoint.length + position);
          budget -= count;
          if (!count || !buffer.subarray(0, count).equals(state.checkpoint.subarray(position, position + count))) {
            const fresh = newFile();
            for (const key of ["size", "mtime", "identity", "checkedAt"]) fresh[key] = state[key];
            state = fresh;
            files.set(file, state);
            entries[index][1] = state;
          } else {
            state.verify.offset += count;
            if (state.verify.offset === state.checkpoint.length) state.verify = null;
          }
        }
        while (budget > 0 && state.offset < state.size) {
          const size = Math.min(64 * 1024, budget, state.size - state.offset);
          const buffer = Buffer.allocUnsafe(size);
          const count = fs.readSync(fd, buffer, 0, size, state.offset);
          if (!count) { state.size = state.offset; state.partial = true; break; }
          budget -= count;
          state.offset += count;
          state.checkpoint = count >= 256 ? Buffer.from(buffer.subarray(count - 256, count)) :
            Buffer.from(Buffer.concat([state.checkpoint, buffer.subarray(0, count)]).subarray(-256));
          consume(buffer.subarray(0, count), state, cutoff);
        }
        updatedAt = new Date(now).toISOString();
      } catch { state.unreadable = true; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }

    const today = dateKey(now);
    const calendar = Date.parse(`${today}T12:00:00Z`);
    const days = Array.from({ length: 7 }, (_, i) => ({
      date: new Date(calendar - (6 - i) * DAY).toISOString().slice(0, 10),
      tokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
    }));
    const byDate = new Map(days.map(day => [day.date, day]));
    let partial = missingPaths > 0;
    let loading = false;
    let unreadableFiles = missingPaths;

    // Explicit identities take precedence over inferred copied prefixes.
    const states = entries.map(([, state]) => state);
    for (const state of states) {
      if (state.offset === state.size && !state.dropping && !state.tailParsed &&
          state.tail.trimEnd().endsWith("}")) {
        const previousPartial = state.partial;
        state.tailParsed = parseLine(state.tail, state, cutoff);
        // An EOF fragment can end at an inner brace. Do not permanently mark
        // it malformed until a newline confirms the record is complete.
        if (!state.tailParsed) state.partial = previousPartial;
      }
    }
    const roots = states.map((_, i) => i);
    const sessions = states.map(state => state.session);
    function root(i) {
      while (roots[i] !== i) { roots[i] = roots[roots[i]]; i = roots[i]; }
      return i;
    }
    function join(i, j) {
      const a = root(i);
      const b = root(j);
      if (a === b) return;
      // Check component identities, not just the two files: an unidentified
      // prefix must never bridge components with different known sessions.
      if (sessions[a] && sessions[b] && sessions[a] !== sessions[b]) return;
      roots[a] = b;
      sessions[b] = sessions[b] || sessions[a];
    }
    const identities = new Map();
    states.forEach((state, i) => {
      if (state.unreadable) unreadableFiles++;
      if (!state.unreadable && (state.verify || state.offset < state.size)) loading = true;
      if (state.partial || state.unreadable || (state.tail.trim() && !state.tailParsed) || state.dropping) partial = true;
      if (!state.session) return;
      if (identities.has(state.session)) join(i, identities.get(state.session));
      else identities.set(state.session, i);
    });
    const prefixes = new Map();
    states.forEach((state, i) => {
      if (!state.first) return;
      if (!prefixes.has(state.first)) { prefixes.set(state.first, i); return; }
      const candidate = prefixes.get(state.first);
      if (root(i) === root(candidate)) return;
      // One matching sample cannot prove identity when metadata is absent.
      // Recompute this uncertainty each poll so later metadata can clear it.
      if (!state.session || !states[candidate].session) partial = true;
      join(i, candidate);
    });
    const groups = new Map();
    states.forEach((state, i) => {
      const key = root(i);
      if (!groups.has(key)) groups.set(key, []);
      const group = groups.get(key);
      if (state.anchor) group.push(state.anchor);
      for (const sample of state.samples) group.push(sample);
    });
    let tokens24h = 0;
    function add(target, key, delta) {
      if (Number.isSafeInteger(target[key] + delta)) target[key] += delta;
      else partial = true;
    }
    for (const samples of groups.values()) {
      samples.sort((a, b) => a.at - b.at || a.counters[0] - b.counters[0]);
      const high = ZERO();
      for (const sample of samples) {
        const delta = sample.counters.map((value, i) => Math.max(0, value - high[i]));
        for (let i = 0; i < high.length; i++) high[i] = Math.max(high[i], sample.counters[i]);
        if (sample.at > now) { partial = true; continue; }
        if (sample.at >= now - DAY) {
          const holder = { tokens24h };
          add(holder, "tokens24h", delta[0]);
          tokens24h = holder.tokens24h;
        }
        const day = byDate.get(dateKey(sample.at));
        if (day) {
          for (const [i, key] of ["tokens", "inputTokens", "outputTokens", "cachedInputTokens"].entries()) {
            add(day, key, delta[i]);
          }
        }
      }
    }
    const totals = { tokens7d: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    for (const day of days) {
      add(totals, "tokens7d", day.tokens);
      for (const key of ["inputTokens", "outputTokens", "cachedInputTokens"]) add(totals, key, day[key]);
    }
    return { status: loading ? "loading" : partial ? "partial" : "ready", timeZone,
      tokensToday: days[6].tokens, ...totals, tokens24h, days, updatedAt, unreadableFiles };
  }
  return { read };
}

module.exports = { createUsageCollector };
