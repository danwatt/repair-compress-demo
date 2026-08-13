/**
 * repair-codec — a generic implementation of the text compression scheme used by
 * the Game Boy KJV (Wisdom Tree, 1993), reverse engineered in:
 * https://www.danwatt.org/2024/10/decoding-text-compression-on-a-gameboy/
 *
 * The scheme is an early Re-Pair (recursive pairing) grammar compressor over word
 * tokens, plus a single-byte escape range for the hottest symbols.
 *
 * Pipeline (each stage is a pure function and can be inspected in isolation):
 *
 *   ENCODE  text
 *     1 tokenize        -> string[]            words, punctuation, separators
 *     2 buildLexicon    -> lexicon + id[]      frequency-ordered terminal ids
 *     3 repair          -> sequence + rules    replace frequent adjacent pairs
 *     4 assignSingleBytes -> escape table      top-N symbols get a 1-byte code
 *     5 emitStream      -> Uint8Array          1 byte if < N, else 2 bytes
 *     6 serialize       -> Uint8Array          header + lexicon + tables + stream
 *
 *   DECODE  bytes
 *     1 deserialize     -> container
 *     2 readStream      -> token ids
 *     3 expand          -> terminal ids        iterative stack over the rule DAG
 *     4 detokenize      -> text
 *
 * Byte framing, following the original: a lead byte below the threshold N is an
 * index into the escape table. Otherwise a second byte is read and the token is
 * ((lead - N) << 8) | second. So the largest addressable token id is
 * (256 - N) * 256 - 1: every byte reserved for single-byte codes costs 256
 * addresses in the two-byte space. That trade-off is the point of making N a knob.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodecConfig {
  /** Reserved single-byte codes for whole symbols. The original used 0x55 (85). */
  singleByteCount: number;
  /** Byte codes reserved for suffix markers. The cartridge used roughly 20. */
  suffixCount: number;
  /** A pair must occur at least this many times to earn a rule. Original: 3. */
  minPairCount: number;
  /** Hard cap on grammar rules, on top of the cap implied by the id space. */
  maxPairs: number;
  /** Longest suffix the splitter will consider. */
  maxSuffixLength: number;
  /** Shortest stem the splitter will leave behind. */
  minStemLength: number;
}

export const DEFAULT_CONFIG: CodecConfig = {
  singleByteCount: 0x55,
  suffixCount: 20,
  minPairCount: 3,
  maxPairs: 65535,
  maxSuffixLength: 4,
  minStemLength: 3,
};

/** left/right token ids of one grammar rule (a "4 byte block" in the ROM). */
export type Rule = readonly [number, number];

export interface Container {
  threshold: number;
  lexicon: string[];
  escapeTable: number[];
  rules: Rule[];
  stream: Uint8Array;
}

export interface SectionSizes {
  header: number;
  /** Section A in the ROM: the word list. */
  lexicon: number;
  /** The single-byte escape table. */
  escapeTable: number;
  /** Section B in the ROM: 4 bytes per rule. */
  rules: number;
  /** Section C in the ROM: the compressed token stream. */
  stream: number;
  total: number;
}

export interface EncodeResult {
  bytes: Uint8Array;
  container: Container;
  stages: {
    /** Tokens before suffix splitting. */
    rawTokens: string[];
    /** Tokens after suffix splitting — what the lexicon is built from. */
    tokens: string[];
    terminalIds: number[];
    sequence: number[];
    rules: Rule[];
    escapeTable: number[];
    suffixPlan: SuffixPlan;
  };
  stats: {
    originalBytes: number;
    rawTokenCount: number;
    suffixes: string[];
    /** Suffix markers that earned a byte code (some get swallowed by rules). */
    suffixCodesUsed: number;
    splitOccurrences: number;
    wordsFolded: number;
    lexiconBytesSaved: number;
    tokenCount: number;
    distinctTerminals: number;
    sequenceLength: number;
    ruleCount: number;
    threshold: number;
    singleByteTokens: number;
    twoByteTokens: number;
    maxTokenId: number;
    maxExpansionDepth: number;
    maxExpansionWidth: number;
    sizes: SectionSizes;
    ratio: number;
    streamOnlyRatio: number;
  };
}

export class CodecError extends Error {}

// ---------------------------------------------------------------------------
// Stage 1 — tokenize / detokenize
// ---------------------------------------------------------------------------

const TOKEN_RE = /\s+|[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;

/**
 * Closing punctuation the cartridge assumed English grammar for: no space
 * before it, one space after. Spacing that deviates from that on the way in
 * \u2014 a space before the mark, or none after \u2014 is not preserved; every other
 * gap (including whitespace around any other character) round-trips exactly.
 */
const ATTACHED_PUNCTUATION = new Set([",", ".", ";", ":", "!", "?"]);

/**
 * Structural markers (book/chapter/verse boundaries \u2014 see build-kjv-data.js):
 * always flush on both sides, no assumed space either direction. Unlike
 * ATTACHED_PUNCTUATION, a space around one of these on the way in is not
 * preserved on either side.
 */
const STRUCTURE_MARKERS = new Set(["%", "$", "#", "@", "{", "}"]);

const attachesLeft = (token: string): boolean => ATTACHED_PUNCTUATION.has(token) || STRUCTURE_MARKERS.has(token);

/** A separator token: whitespace to reproduce literally, or "" meaning "no space". */
export function isSeparator(token: string): boolean {
  return token === "" || /^\s+$/.test(token);
}

/**
 * Split text into content tokens (words, numbers, single punctuation marks) and
 * separator tokens. A single space between two content tokens is implicit and
 * costs nothing; every other gap is an explicit separator token, including the
 * empty string for "these two tokens touch" \u2014 except a mark in
 * ATTACHED_PUNCTUATION or STRUCTURE_MARKERS never needs that glue token before
 * it, and a STRUCTURE_MARKERS token never needs it after either: both are
 * always assumed to sit flush against their neighbors.
 */
export function tokenize(text: string): string[] {
  const matches = text.match(TOKEN_RE) ?? [];
  const tokens: string[] = [];
  let prevWasContent = false;
  let prevWasMarker = false;

  for (let i = 0; i < matches.length; i++) {
    const piece = matches[i];
    if (/^\s+$/.test(piece)) {
      const implicit = piece === " " && prevWasContent && i < matches.length - 1;
      if (!implicit) tokens.push(piece);
      prevWasContent = false;
      prevWasMarker = false;
    } else {
      if (prevWasContent && !prevWasMarker && !attachesLeft(piece)) tokens.push("");
      tokens.push(piece);
      prevWasContent = true;
      prevWasMarker = STRUCTURE_MARKERS.has(piece);
    }
  }
  return tokens;
}

export function detokenize(tokens: string[]): string {
  let out = "";
  let pendingSpace = false;
  let prevWasMarker = false;
  for (const token of tokens) {
    if (isSuffixMarker(token)) {
      out += token.slice(1);
      pendingSpace = true;
      prevWasMarker = false;
    } else if (isSeparator(token)) {
      out += token;
      pendingSpace = false;
      prevWasMarker = false;
    } else {
      if (pendingSpace && !prevWasMarker && !attachesLeft(token)) out += " ";
      out += token;
      pendingSpace = true;
      prevWasMarker = STRUCTURE_MARKERS.has(token);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 1b — suffix splitting
// ---------------------------------------------------------------------------

/**
 * Marker prefix for suffix tokens. A marker is NUL followed by at least one
 * character, so it can never collide with anything the tokenizer produces: a
 * literal NUL in the input comes out as a one-character token of its own.
 */
export const SUFFIX_MARK = "\u0000";

export function isSuffixMarker(token: string): boolean {
  return token.length > 1 && token.charCodeAt(0) === 0;
}

export function suffixOf(token: string): string {
  return token.slice(1);
}

/** Print a token the way a person reads it: "-ing" for markers, "␀" for glue. */
export function describeToken(token: string): string {
  if (isSuffixMarker(token)) return "-" + suffixOf(token);
  if (token === "") return "␀";
  return token.replace(/\n/g, "⏎").replace(/\t/g, "⇥");
}

export interface SuffixPlan {
  /** Chosen suffixes, best first. */
  suffixes: string[];
  /** word -> [stem, suffix] for every word the splitter will break up. */
  mapping: Map<string, [string, string]>;
  /** Token occurrences that will gain a marker byte. */
  splitOccurrences: number;
  /** Lexicon entries the split removes. */
  wordsFolded: number;
  /** Net lexicon bytes reclaimed, before the markers' own entries. */
  lexiconBytesSaved: number;
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;
/** A lexicon entry costs its UTF-8 bytes plus a varint length. */
const entryCost = (s: string): number => {
  const n = utf8Length(s);
  return n + (n < 0x80 ? 1 : 2);
};

/**
 * Pick the suffixes worth reserving a byte code for, the way the cartridge did:
 * "testing" becomes the token for "test" followed by an -ing marker, so the
 * lexicon carries one entry instead of two.
 *
 * A split is only taken when it pays. Dropping a word's lexicon entry saves
 * entryCost(word) bytes once; the marker costs one byte at every occurrence. So
 * splitting rare long words wins and splitting common ones loses, which is why
 * this helps the tail of the vocabulary rather than the head.
 *
 * The stem must already exist as a standalone token — this never invents
 * vocabulary, matching a decoder that just concatenates.
 */
export function planSuffixes(
  tokens: string[],
  options: { count: number; maxSuffixLength?: number; minStemLength?: number },
): SuffixPlan {
  const empty: SuffixPlan = {
    suffixes: [],
    mapping: new Map(),
    splitOccurrences: 0,
    wordsFolded: 0,
    lexiconBytesSaved: 0,
  };
  if (options.count <= 0) return empty;

  const maxLen = options.maxSuffixLength ?? 4;
  const minStem = options.minStemLength ?? 3;

  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (isSeparator(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  // Candidate splits, grouped by suffix, keeping only the ones that pay.
  type Candidate = { word: string; stem: string; gain: number };
  const candidates = new Map<string, Candidate[]>();
  for (const [word, count] of counts) {
    for (let len = 1; len <= maxLen; len++) {
      if (word.length - len < minStem) break;
      const stem = word.slice(0, word.length - len);
      if (!counts.has(stem)) continue;
      const suffix = word.slice(word.length - len);
      const gain = entryCost(word) - count;
      if (gain <= 0) continue;
      const list = candidates.get(suffix);
      if (list) list.push({ word, stem, gain });
      else candidates.set(suffix, [{ word, stem, gain }]);
    }
  }

  // A suffix has to cover its own lexicon entry and its escape-table slot.
  const scored = [...candidates.entries()]
    .map(([suffix, list]) => ({
      suffix,
      list,
      score: list.reduce((sum, c) => sum + c.gain, 0) - entryCost(SUFFIX_MARK + suffix) - 2,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.suffix.length - b.suffix.length)
    .slice(0, options.count);

  // One word can match several chosen suffixes; take the longest, which strips
  // the most from the lexicon entry.
  const mapping = new Map<string, [string, string]>();
  const bestLength = new Map<string, number>();
  for (const { suffix, list } of scored) {
    for (const { word, stem } of list) {
      if ((bestLength.get(word) ?? 0) >= suffix.length) continue;
      bestLength.set(word, suffix.length);
      mapping.set(word, [stem, suffix]);
    }
  }

  let splitOccurrences = 0;
  let lexiconBytesSaved = 0;
  for (const word of mapping.keys()) {
    splitOccurrences += counts.get(word) ?? 0;
    lexiconBytesSaved += entryCost(word);
  }
  for (const { suffix } of scored) lexiconBytesSaved -= entryCost(SUFFIX_MARK + suffix);

  return {
    suffixes: scored.map((s) => s.suffix),
    mapping,
    splitOccurrences,
    wordsFolded: mapping.size,
    lexiconBytesSaved,
  };
}

export function applySuffixes(tokens: string[], mapping: Map<string, [string, string]>): string[] {
  if (mapping.size === 0) return tokens;
  const out: string[] = [];
  for (const token of tokens) {
    const split = mapping.get(token);
    if (split && !isSeparator(token)) {
      out.push(split[0], SUFFIX_MARK + split[1]);
    } else {
      out.push(token);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 2 — lexicon
// ---------------------------------------------------------------------------

/**
 * Assign terminal ids ordered by descending frequency, so the commonest words sit
 * at the low end of the id space. (The ROM does the same: 0x0248 "And", 0x3018 "the".)
 */
export function buildLexicon(tokens: string[]): { lexicon: string[]; ids: number[] } {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  const lexicon = [...counts.keys()].sort((a, b) => {
    const diff = counts.get(b)! - counts.get(a)!;
    return diff !== 0 ? diff : a < b ? -1 : 1;
  });

  const index = new Map<string, number>();
  lexicon.forEach((word, i) => index.set(word, i));
  return { lexicon, ids: tokens.map((t) => index.get(t)!) };
}

// ---------------------------------------------------------------------------
// Stage 3 — Re-Pair
// ---------------------------------------------------------------------------

/** Lazily-validated max-heap over (count, pairKey). */
class PairHeap {
  private counts: number[] = [];
  private keys: number[] = [];

  push(count: number, key: number): void {
    let i = this.counts.length;
    this.counts.push(count);
    this.keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.counts[parent] >= this.counts[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): { count: number; key: number } | undefined {
    if (this.counts.length === 0) return undefined;
    const top = { count: this.counts[0], key: this.keys[0] };
    const lastCount = this.counts.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.counts.length > 0) {
      this.counts[0] = lastCount;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < this.counts.length && this.counts[l] > this.counts[best]) best = l;
        if (r < this.counts.length && this.counts[r] > this.counts[best]) best = r;
        if (best === i) break;
        this.swap(best, i);
        i = best;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.counts[a], this.counts[b]] = [this.counts[b], this.counts[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

export interface RepairOptions {
  minPairCount: number;
  maxPairs: number;
  /** Largest token id the byte framing can address. */
  maxTokenId: number;
  /** First id available for rules (i.e. the lexicon size). */
  firstRuleId: number;
}

export interface RepairResult {
  sequence: number[];
  rules: Rule[];
}

/**
 * Repeatedly replace the most frequent adjacent pair with a new non-terminal,
 * until no pair repeats often enough or the id space runs out. Uses a doubly
 * linked list over the sequence with an occurrence index per pair, so each
 * replacement costs time proportional to the number of occurrences, not the
 * length of the text.
 */
export function repair(ids: number[], options: RepairOptions): RepairResult {
  const n = ids.length;
  const rules: Rule[] = [];
  if (n < 2) return { sequence: [...ids], rules };

  const sym = new Int32Array(n);
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const alive = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    sym[i] = ids[i];
    prev[i] = i - 1;
    next[i] = i + 1 < n ? i + 1 : -1;
    alive[i] = 1;
  }

  const KEY_SHIFT = 65536;
  const positions = new Map<number, Set<number>>();
  const heap = new PairHeap();

  const addOccurrence = (a: number, b: number, at: number): void => {
    const key = a * KEY_SHIFT + b;
    let set = positions.get(key);
    if (!set) {
      set = new Set<number>();
      positions.set(key, set);
    }
    set.add(at);
    heap.push(set.size, key);
  };

  const removeOccurrence = (a: number, b: number, at: number): void => {
    const key = a * KEY_SHIFT + b;
    const set = positions.get(key);
    if (!set) return;
    set.delete(at);
    if (set.size === 0) positions.delete(key);
    else heap.push(set.size, key);
  };

  for (let i = 0; i + 1 < n; i++) addOccurrence(sym[i], sym[i + 1], i);

  const minCount = Math.max(2, options.minPairCount);

  while (rules.length < options.maxPairs) {
    const newId = options.firstRuleId + rules.length;
    if (newId > options.maxTokenId) break;

    // Pop until we find an entry whose recorded count is still current.
    let key = -1;
    for (;;) {
      const top = heap.pop();
      if (!top) break;
      const set = positions.get(top.key);
      if (set && set.size === top.count && set.size >= minCount) {
        key = top.key;
        break;
      }
    }
    if (key < 0) break;

    const left = Math.floor(key / KEY_SHIFT);
    const right = key % KEY_SHIFT;
    const occurrences = [...positions.get(key)!].sort((a, b) => a - b);
    positions.delete(key);

    let replaced = 0;
    for (const i of occurrences) {
      if (!alive[i] || sym[i] !== left) continue;
      const j = next[i];
      if (j === -1 || !alive[j] || sym[j] !== right) continue;

      const before = prev[i];
      const after = next[j];
      if (before !== -1) removeOccurrence(sym[before], left, before);
      if (after !== -1) removeOccurrence(right, sym[after], j);

      sym[i] = newId;
      alive[j] = 0;
      next[i] = after;
      if (after !== -1) prev[after] = i;

      if (before !== -1) addOccurrence(sym[before], newId, before);
      if (after !== -1) addOccurrence(newId, sym[after], i);
      replaced++;
    }

    if (replaced < minCount) {
      // Overlaps ate some occurrences; the rule is not worth its 4 bytes.
      if (replaced === 0) continue;
    }
    rules.push([left, right]);
  }

  const sequence: number[] = [];
  for (let i = 0; i !== -1; i = next[i]) sequence.push(sym[i]);
  return { sequence, rules };
}

// ---------------------------------------------------------------------------
// Stage 4 — single-byte escape table
// ---------------------------------------------------------------------------

/**
 * Give the N most frequent symbols in the sequence a one-byte code. Each entry
 * costs 2 bytes in the table and saves 1 byte per occurrence, so this is a pure
 * frequency pick. The original biased toward stop-word phrases, plausibly so the
 * search code could skip them; that heuristic is not reproduced here.
 */
export function assignSingleBytes(
  sequence: number[],
  singleByteCount: number,
  exclude: ReadonlySet<number> = new Set(),
): number[] {
  if (singleByteCount <= 0) return [];
  const counts = new Map<number, number>();
  for (const id of sequence) {
    if (exclude.has(id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .slice(0, singleByteCount)
    .map(([id]) => id);
}

/**
 * Suffix markers get their codes reserved up front rather than competing on
 * frequency, so the suffix budget is a knob you can turn independently. Markers
 * the grammar swallowed whole never appear alone, so they do not take a slot.
 */
export function pinSuffixCodes(
  sequence: number[],
  lexicon: string[],
  suffixCount: number,
): number[] {
  if (suffixCount <= 0) return [];
  const counts = new Map<number, number>();
  for (const id of sequence) {
    if (id < lexicon.length && isSuffixMarker(lexicon[id])) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .slice(0, suffixCount)
    .map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Stage 5 — byte framing
// ---------------------------------------------------------------------------

export function emitStream(
  sequence: number[],
  escapeTable: number[],
  threshold: number,
): { stream: Uint8Array; singleByteTokens: number; twoByteTokens: number } {
  const escapeIndex = new Map<number, number>();
  escapeTable.forEach((id, i) => escapeIndex.set(id, i));

  const out: number[] = [];
  let single = 0;
  let two = 0;
  for (const id of sequence) {
    const code = escapeIndex.get(id);
    if (code !== undefined) {
      out.push(code);
      single++;
    } else {
      const hi = (id >> 8) + threshold;
      if (hi > 0xff) throw new CodecError(`token ${id} is outside the two-byte space`);
      out.push(hi, id & 0xff);
      two++;
    }
  }
  return { stream: Uint8Array.from(out), singleByteTokens: single, twoByteTokens: two };
}

export function readStream(stream: Uint8Array, escapeTable: number[], threshold: number): number[] {
  const tokens: number[] = [];
  for (let i = 0; i < stream.length; ) {
    const lead = stream[i++];
    if (lead < threshold) {
      const id = escapeTable[lead];
      if (id === undefined) throw new CodecError(`escape code ${lead} is not in the table`);
      tokens.push(id);
    } else {
      if (i >= stream.length) throw new CodecError("stream ends mid-token");
      tokens.push(((lead - threshold) << 8) | stream[i++]);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Expansion — walk the rule DAG back to terminals
// ---------------------------------------------------------------------------

export function expand(
  tokens: number[],
  rules: Rule[],
  lexiconSize: number,
): { terminals: number[]; maxDepth: number; maxWidth: number } {
  const terminals: number[] = [];
  const stack: number[] = [];
  const depths: number[] = [];
  let maxDepth = 0;
  let maxWidth = 0;

  for (const token of tokens) {
    if (token < lexiconSize) {
      terminals.push(token);
      continue;
    }
    stack.push(token);
    depths.push(1);
    while (stack.length > 0) {
      maxWidth = Math.max(maxWidth, stack.length);
      const id = stack.pop()!;
      const depth = depths.pop()!;
      if (id < lexiconSize) {
        terminals.push(id);
        maxDepth = Math.max(maxDepth, depth);
        continue;
      }
      const rule = rules[id - lexiconSize];
      if (!rule) throw new CodecError(`token ${id} has no rule`);
      stack.push(rule[1], rule[0]);
      depths.push(depth + 1, depth + 1);
    }
  }
  return { terminals, maxDepth, maxWidth };
}

/** Expand one token to its words — handy for tooltips and debugging. */
export function expandToWords(token: number, container: Container): string[] {
  const { terminals } = expand([token], container.rules, container.lexicon.length);
  return terminals.map((t) => container.lexicon[t]);
}

// ---------------------------------------------------------------------------
// Stage 6 — container serialization
// ---------------------------------------------------------------------------

const MAGIC = [0x52, 0x50, 0x52, 0x31]; // "RPR1"
const HEADER_BYTES = 14;

class ByteWriter {
  private bytes: number[] = [];
  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }
  u16(v: number): void {
    this.bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  u32(v: number): void {
    this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  varint(v: number): void {
    let x = v;
    while (x >= 0x80) {
      this.bytes.push((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    this.bytes.push(x);
  }
  raw(data: Uint8Array): void {
    for (const b of data) this.bytes.push(b);
  }
  get length(): number {
    return this.bytes.length;
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

class ByteReader {
  private offset = 0;
  constructor(private data: Uint8Array) {}
  u8(): number {
    return this.data[this.offset++];
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  }
  raw(length: number): Uint8Array {
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }
}

export function measure(container: Container): SectionSizes {
  const encoder = new TextEncoder();
  let lexicon = 0;
  for (const word of container.lexicon) {
    const len = encoder.encode(word).length;
    lexicon += len + (len < 0x80 ? 1 : 2);
  }
  const escapeTable = container.escapeTable.length * 2;
  const rules = container.rules.length * 4;
  const stream = container.stream.length;
  return {
    header: HEADER_BYTES,
    lexicon,
    escapeTable,
    rules,
    stream,
    total: HEADER_BYTES + lexicon + escapeTable + rules + stream,
  };
}

export function serialize(container: Container): Uint8Array {
  const w = new ByteWriter();
  const encoder = new TextEncoder();
  for (const b of MAGIC) w.u8(b);
  w.u8(1); // format version
  w.u8(container.threshold);
  w.u16(container.lexicon.length);
  w.u16(container.rules.length);
  w.u32(container.stream.length);
  for (const word of container.lexicon) {
    const bytes = encoder.encode(word);
    w.varint(bytes.length);
    w.raw(bytes);
  }
  for (const id of container.escapeTable) w.u16(id);
  for (const [left, right] of container.rules) {
    w.u16(left);
    w.u16(right);
  }
  w.raw(container.stream);
  return w.finish();
}

export function deserialize(bytes: Uint8Array): Container {
  const r = new ByteReader(bytes);
  for (const expected of MAGIC) {
    if (r.u8() !== expected) throw new CodecError("not an RPR1 container");
  }
  const version = r.u8();
  if (version !== 1) throw new CodecError(`unsupported version ${version}`);
  const threshold = r.u8();
  const lexiconSize = r.u16();
  const ruleCount = r.u16();
  const streamLength = r.u32();

  const decoder = new TextDecoder();
  const lexicon: string[] = [];
  for (let i = 0; i < lexiconSize; i++) {
    const len = r.varint();
    lexicon.push(decoder.decode(r.raw(len)));
  }
  const escapeTable: number[] = [];
  for (let i = 0; i < threshold; i++) escapeTable.push(r.u16());
  const rules: Rule[] = [];
  for (let i = 0; i < ruleCount; i++) rules.push([r.u16(), r.u16()]);
  return { threshold, lexicon, escapeTable, rules, stream: r.raw(streamLength) };
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

export function maxTokenIdFor(threshold: number): number {
  return (256 - threshold) * 256 - 1;
}

export function encode(text: string, config: Partial<CodecConfig> = {}): EncodeResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (cfg.singleByteCount < 0 || cfg.suffixCount < 0) {
    throw new CodecError("byte budgets cannot be negative");
  }
  const reserved = cfg.singleByteCount + cfg.suffixCount;
  if (reserved > 255) {
    throw new CodecError(
      `single-byte codes (${cfg.singleByteCount}) plus suffix codes (${cfg.suffixCount}) must leave room for two-byte tokens`,
    );
  }

  const rawTokens = tokenize(text);
  const plan = planSuffixes(rawTokens, {
    count: cfg.suffixCount,
    maxSuffixLength: cfg.maxSuffixLength,
    minStemLength: cfg.minStemLength,
  });
  const tokens = applySuffixes(rawTokens, plan.mapping);
  const { lexicon, ids } = buildLexicon(tokens);

  // The id ceiling depends on the configured budgets, not the effective ones, so
  // a partly-filled escape table can never push a token out of range.
  const ceiling = maxTokenIdFor(reserved);
  if (lexicon.length > ceiling + 1) {
    throw new CodecError(
      `${lexicon.length} distinct tokens exceeds the ${ceiling + 1} addressable ids with ${reserved} reserved byte codes`,
    );
  }

  const { sequence, rules } = repair(ids, {
    minPairCount: cfg.minPairCount,
    maxPairs: cfg.maxPairs,
    maxTokenId: ceiling,
    firstRuleId: lexicon.length,
  });

  const pinned = pinSuffixCodes(sequence, lexicon, cfg.suffixCount);
  const escapeTable = [
    ...pinned,
    ...assignSingleBytes(sequence, cfg.singleByteCount, new Set(pinned)),
  ];
  const threshold = escapeTable.length;
  const { stream, singleByteTokens, twoByteTokens } = emitStream(sequence, escapeTable, threshold);

  const container: Container = { threshold, lexicon, escapeTable, rules, stream };
  const bytes = serialize(container);
  const sizes = measure(container);
  const originalBytes = new TextEncoder().encode(text).length;
  const { maxDepth, maxWidth } = expand(sequence, rules, lexicon.length);

  return {
    bytes,
    container,
    stages: { rawTokens, tokens, terminalIds: ids, sequence, rules, escapeTable, suffixPlan: plan },
    stats: {
      originalBytes,
      rawTokenCount: rawTokens.length,
      suffixes: plan.suffixes,
      suffixCodesUsed: pinned.length,
      splitOccurrences: plan.splitOccurrences,
      wordsFolded: plan.wordsFolded,
      lexiconBytesSaved: plan.lexiconBytesSaved,
      tokenCount: tokens.length,
      distinctTerminals: lexicon.length,
      sequenceLength: sequence.length,
      ruleCount: rules.length,
      threshold,
      singleByteTokens,
      twoByteTokens,
      maxTokenId: ceiling,
      maxExpansionDepth: maxDepth,
      maxExpansionWidth: maxWidth,
      sizes,
      ratio: originalBytes === 0 ? 1 : sizes.total / originalBytes,
      streamOnlyRatio: originalBytes === 0 ? 1 : sizes.stream / originalBytes,
    },
  };
}

export function decode(bytes: Uint8Array): string {
  const container = deserialize(bytes);
  const tokens = readStream(container.stream, container.escapeTable, container.threshold);
  const { terminals } = expand(tokens, container.rules, container.lexicon.length);
  return detokenize(terminals.map((id) => container.lexicon[id]));
}

/** Decode straight from an in-memory container, skipping the byte round trip. */
export function decodeContainer(container: Container): string {
  const tokens = readStream(container.stream, container.escapeTable, container.threshold);
  const { terminals } = expand(tokens, container.rules, container.lexicon.length);
  return detokenize(terminals.map((id) => container.lexicon[id]));
}

export interface SweepPoint {
  n: number;
  /** Effective threshold, clamped to the number of distinct symbols. */
  threshold: number;
  total: number;
  stream: number;
  escapeTable: number;
  /** False when the grammar no longer fits the id space this N leaves behind. */
  fits: boolean;
}

/**
 * Size for every N over a range, from one Re-Pair result.
 *
 * No re-encoding needed: with symbol counts sorted descending, the stream is
 * 2*symbols - (occurrences covered by the escape table), so a prefix sum gives
 * the exact size at every N at once. The only thing that can change the grammar
 * is running out of id space, which is reported as fits=false.
 */
export function sweepSingleByteCount(
  text: string,
  config: Partial<CodecConfig> = {},
  range: { from?: number; to?: number; step?: number } = {},
): { points: SweepPoint[]; ruleCount: number; sequenceLength: number; lexiconSize: number } {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const plan = planSuffixes(tokenize(text), {
    count: cfg.suffixCount,
    maxSuffixLength: cfg.maxSuffixLength,
    minStemLength: cfg.minStemLength,
  });
  const tokens = applySuffixes(tokenize(text), plan.mapping);
  const { lexicon, ids } = buildLexicon(tokens);
  const { sequence, rules } = repair(ids, {
    minPairCount: cfg.minPairCount,
    maxPairs: cfg.maxPairs,
    maxTokenId: maxTokenIdFor((range.from ?? 0) + cfg.suffixCount),
    firstRuleId: lexicon.length,
  });
  const pinned = pinSuffixCodes(sequence, lexicon, cfg.suffixCount);
  return sweepFromGrammar(lexicon, sequence, rules, { ...range, pinned, reserved: cfg.suffixCount });
}

/**
 * The same sweep, reusing a grammar you already built (e.g. from encode()).
 * `pinned` holds ids whose codes are already spoken for — the suffix markers —
 * and `reserved` is the configured suffix budget that shrinks the id space.
 */
export function sweepFromGrammar(
  lexicon: string[],
  sequence: number[],
  rules: Rule[],
  options: {
    from?: number;
    to?: number;
    step?: number;
    pinned?: readonly number[];
    reserved?: number;
  } = {},
): { points: SweepPoint[]; ruleCount: number; sequenceLength: number; lexiconSize: number } {
  const from = Math.max(0, options.from ?? 0);
  const step = options.step ?? 1;
  const pinned = options.pinned ?? [];
  const reserved = options.reserved ?? pinned.length;
  const to = Math.min(255 - reserved, options.to ?? 255);

  const pinnedSet = new Set(pinned);
  const counts = new Map<number, number>();
  let pinnedOccurrences = 0;
  for (const id of sequence) {
    if (pinnedSet.has(id)) pinnedOccurrences++;
    else counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const sorted = [...counts.values()].sort((a, b) => b - a);
  const prefix = new Float64Array(sorted.length + 1);
  for (let i = 0; i < sorted.length; i++) prefix[i + 1] = prefix[i] + sorted[i];

  const base = measure({
    threshold: 0,
    lexicon,
    escapeTable: [],
    rules,
    stream: new Uint8Array(0),
  }).total;
  const highestId = lexicon.length + rules.length - 1;

  const points: SweepPoint[] = [];
  for (let n = from; n <= to; n += step) {
    const picked = Math.min(n, sorted.length);
    const threshold = pinned.length + picked;
    const stream = 2 * sequence.length - pinnedOccurrences - prefix[picked];
    points.push({
      n,
      threshold,
      stream,
      escapeTable: threshold * 2,
      total: base + threshold * 2 + stream,
      fits: highestId <= maxTokenIdFor(n + reserved),
    });
  }
  return { points, ruleCount: rules.length, sequenceLength: sequence.length, lexiconSize: lexicon.length };
}
