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
 *     2 buildLexicon    -> lexicon + id[]      byte-sorted terminal ids
 *     3 repair          -> sequence + rules    replace frequent adjacent pairs
 *     4 assignSingleBytes -> escape table      top-N symbols get a 1-byte code
 *     5 emitStream      -> Uint8Array          1 byte if < N, else 2 bytes
 *     6 planLexiconSuffixes -> suffix table    endings worth a code of their own
 *     7 serialize       -> Uint8Array          header + lexicon + tables + stream
 *
 * The lexicon is stored front-coded: entries are sorted by their UTF-8 bytes and
 * each one records how many leading bytes it shares with its predecessor, so
 * "beget"/"begettest"/"begetting" pay for their common stem once. That is why
 * terminal ids are in byte order rather than frequency order — the id is the
 * position in the stored list, and front coding needs that list sorted.
 *
 * Suffix codes are part of that same storage layer and nothing else. "testing"
 * is its own lexicon entry with its own id, written as "share 4 bytes with the
 * previous entry, then apply the -ing code". The token stream never sees a
 * suffix: it addresses "testing" with one id exactly as it would any other word.
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
  /**
   * Size of the lexicon's suffix table. Costs nothing in the token stream — these
   * codes live in the lexicon section. The cartridge had roughly 20 (0x82–0x9E).
   */
  suffixCount: number;
  /** A pair must occur at least this many times to earn a rule. Original: 3. */
  minPairCount: number;
  /** Hard cap on grammar rules, on top of the cap implied by the id space. */
  maxPairs: number;
  /** Longest suffix, in characters, the lexicon writer will consider. */
  maxSuffixLength: number;
}

export const DEFAULT_CONFIG: CodecConfig = {
  singleByteCount: 0x55,
  suffixCount: 20,
  minPairCount: 3,
  maxPairs: 65535,
  maxSuffixLength: 4,
};

/** left/right token ids of one grammar rule (a "4 byte block" in the ROM). */
export type Rule = readonly [number, number];

export interface Container {
  threshold: number;
  /** Endings the lexicon can reference by code instead of spelling out. */
  suffixes: string[];
  lexicon: string[];
  escapeTable: number[];
  rules: Rule[];
  stream: Uint8Array;
}

export interface SectionSizes {
  header: number;
  /** The lexicon's suffix table. */
  suffixTable: number;
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
    tokens: string[];
    terminalIds: number[];
    sequence: number[];
    rules: Rule[];
    escapeTable: number[];
    lexiconEntries: LexiconEntry[];
  };
  stats: {
    originalBytes: number;
    /** The suffix table, best first. */
    suffixes: string[];
    /** Table entries at least one lexicon entry actually references. */
    suffixCodesUsed: number;
    /** Lexicon entries written with a suffix code. */
    entriesSuffixed: number;
    /** Lexicon bytes the suffix table saves, net of what the table itself costs. */
    lexiconBytesSaved: number;
    tokenCount: number;
    distinctTerminals: number;
    /** What the lexicon would have cost stored in full, for the front-coding delta. */
    lexiconPlainBytes: number;
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
// Byte helpers — the lexicon is ordered and front-coded in UTF-8 byte space
// ---------------------------------------------------------------------------

const ENCODER = new TextEncoder();

/** Byte order, which for UTF-8 is also code point order. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Length of the longest common prefix, in bytes. */
function sharedPrefix(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

const varintSize = (v: number): number => (v < 0x80 ? 1 : v < 0x4000 ? 2 : 3);

const utf8Length = (s: string): number => ENCODER.encode(s).length;

const EMPTY = new Uint8Array(0);

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
    if (isSeparator(token)) {
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

/** Print a token the way a person reads it: "␀" for the glue token. */
export function describeToken(token: string): string {
  if (token === "") return "␀";
  return token.replace(/\n/g, "⏎").replace(/\t/g, "⇥");
}

// ---------------------------------------------------------------------------
// Stage 2 — lexicon
// ---------------------------------------------------------------------------

/**
 * Assign terminal ids in UTF-8 byte order, which puts words sharing a stem next
 * to each other so serialize() can front-code them. An id is a position in this
 * list, so the sort order is part of the format, not a presentation choice.
 *
 * The ROM ordered its ids by frequency instead (0x0248 "And", 0x3018 "the") and
 * front-coded a separately sorted word list. Nothing here reads ids as a
 * frequency ranking — the escape table carries that — so one ordering does both
 * jobs and no mapping table is needed.
 */
export function buildLexicon(tokens: string[]): { lexicon: string[]; ids: number[] } {
  const entries = [...new Set(tokens)].map((word) => ({ word, bytes: ENCODER.encode(word) }));
  entries.sort((a, b) => compareBytes(a.bytes, b.bytes));
  const lexicon = entries.map((e) => e.word);

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
// Stage 6 — lexicon storage: front coding plus suffix codes
// ---------------------------------------------------------------------------

/**
 * How one lexicon entry is written. Rebuilt as
 * `previous[0 .. shared] + literal + (suffix < 0 ? "" : suffixes[suffix])`.
 */
export interface LexiconEntry {
  /** Leading bytes taken from the entry before this one. */
  shared: number;
  /** Bytes spelled out. */
  literal: Uint8Array;
  /** Index into the suffix table, or -1. */
  suffix: number;
  /** Encoded size, including both varints and the code byte where there is one. */
  bytes: number;
}

/**
 * Two bits of the length varint say how the rest of the entry is spelled:
 * literal bytes, a suffix code alone, or literal bytes then a code. A code in
 * MODE_SUFFIX rides in the varint itself, so a table of up to 32 endings makes
 * "testing" cost two bytes after "tested": share 4, apply -ing.
 */
const MODE_LITERAL = 0;
const MODE_SUFFIX = 1;
const MODE_BOTH = 2;

function endsWith(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  const offset = haystack.length - needle.length;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[offset + i] !== needle[i]) return false;
  }
  return true;
}

/** What a suffix costs to carry in the table. */
const suffixTableCost = (suffix: string): number => {
  const n = utf8Length(suffix);
  return varintSize(n) + n;
};

/**
 * Decide how every lexicon entry is written, given the suffix table. Pure
 * arithmetic: for each entry take the cheapest of the three modes. serialize()
 * and measure() both go through here, so what is counted is what is written.
 */
export function planLexiconEntries(
  lexicon: readonly string[],
  suffixes: readonly string[],
): LexiconEntry[] {
  const table = suffixes.map((s) => ENCODER.encode(s));
  const entries: LexiconEntry[] = [];
  let previous = EMPTY;

  for (const word of lexicon) {
    const bytes = ENCODER.encode(word);
    const shared = sharedPrefix(previous, bytes);
    const rest = bytes.subarray(shared);
    const sharedSize = varintSize(shared);

    let suffix = -1;
    let literal = rest.length;
    let size = sharedSize + varintSize((rest.length << 2) | MODE_LITERAL) + rest.length;

    for (let code = 0; code < table.length; code++) {
      if (!endsWith(rest, table[code])) continue;
      const remainder = rest.length - table[code].length;
      const candidate = remainder === 0
        ? sharedSize + varintSize((code << 2) | MODE_SUFFIX)
        : sharedSize + varintSize((remainder << 2) | MODE_BOTH) + remainder + 1;
      if (candidate < size) {
        size = candidate;
        suffix = code;
        literal = remainder;
      }
    }

    entries.push({ shared, literal: rest.subarray(0, literal), suffix, bytes: size });
    previous = bytes;
  }
  return entries;
}

/**
 * Pick the endings worth a code of their own.
 *
 * Front coding has already stripped what each entry shares with its predecessor,
 * so what is left — the "rest" — is usually short: sorted neighbours differ in
 * their tails. Giving the commonest tails a code turns those bytes into nothing
 * at all, since a MODE_SUFFIX code rides inside the varint that would have held
 * the length.
 *
 * Greedy with exclusive assignment: score every candidate by what it would save
 * across the entries it covers, take the best, then subtract those entries from
 * every other candidate's score so overlapping endings ("ing", "ng", "g") do not
 * all get counted for the same word.
 *
 * Unlike the token-level splitter this replaced, nothing here has to exist as a
 * word. The prefix comes from the neighbouring entry rather than from a lexicon
 * lookup, so "waters" can be coded off "water..." whether or not "water" is in
 * the text at all.
 */
export function planLexiconSuffixes(
  lexicon: readonly string[],
  options: { count: number; maxSuffixLength?: number },
): string[] {
  if (options.count <= 0 || lexicon.length === 0) return [];
  const maxChars = options.maxSuffixLength ?? 4;
  const decoder = new TextDecoder();
  // What a code will cost inside the tag once the table is full.
  const codeTagSize = varintSize(((options.count - 1) << 2) | MODE_SUFFIX);

  type Match = { suffix: string; saving: number };
  const matches: Match[][] = [];
  const totals = new Map<string, number>();

  let previous = EMPTY;
  for (const word of lexicon) {
    const bytes = ENCODER.encode(word);
    const rest = bytes.subarray(sharedPrefix(previous, bytes));
    previous = bytes;

    const literalCost = varintSize((rest.length << 2) | MODE_LITERAL) + rest.length;
    const list: Match[] = [];
    let chars = 0;
    for (let start = rest.length - 1; start >= 0 && chars < maxChars; start--) {
      if ((rest[start] & 0xc0) === 0x80) continue; // mid-character, not a boundary
      chars++;
      const remainder = start; // bytes left over once this ending is coded
      const coded = remainder === 0
        ? codeTagSize
        : varintSize((remainder << 2) | MODE_BOTH) + remainder + 1;
      const saving = literalCost - coded;
      if (saving <= 0) continue;
      const suffix = decoder.decode(rest.subarray(start));
      list.push({ suffix, saving });
      totals.set(suffix, (totals.get(suffix) ?? 0) + saving);
    }
    matches.push(list);
  }

  const chosen: string[] = [];
  const spokenFor = new Uint8Array(lexicon.length);
  for (let round = 0; round < options.count; round++) {
    let best = "";
    let bestScore = 0;
    for (const [suffix, total] of totals) {
      const score = total - suffixTableCost(suffix);
      if (score < bestScore) continue;
      if (score > bestScore || best === "" || suffix.length > best.length ||
          (suffix.length === best.length && suffix < best)) {
        bestScore = score;
        best = suffix;
      }
    }
    if (best === "" || bestScore <= 0) break;

    chosen.push(best);
    totals.delete(best);
    for (let i = 0; i < matches.length; i++) {
      if (spokenFor[i] || !matches[i].some((m) => m.suffix === best)) continue;
      spokenFor[i] = 1;
      for (const m of matches[i]) {
        const remaining = totals.get(m.suffix);
        if (remaining !== undefined) totals.set(m.suffix, remaining - m.saving);
      }
    }
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Stage 7 — container serialization
// ---------------------------------------------------------------------------

const MAGIC = [0x52, 0x50, 0x52, 0x31]; // "RPR1"
/** 3 adds the lexicon suffix table; 2 front-coded only; 1 stored entries in full. */
const FORMAT_VERSION = 3;
const HEADER_BYTES = 15;

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

/** Lexicon size without front coding: every entry in full, varint length each. */
export function plainLexiconBytes(lexicon: readonly string[]): number {
  let total = 0;
  for (const word of lexicon) {
    const len = ENCODER.encode(word).length;
    total += len + varintSize(len);
  }
  return total;
}

export function measure(container: Container, entries?: readonly LexiconEntry[]): SectionSizes {
  const planned = entries ?? planLexiconEntries(container.lexicon, container.suffixes);
  let lexicon = 0;
  for (const entry of planned) lexicon += entry.bytes;
  let suffixTable = 0;
  for (const suffix of container.suffixes) suffixTable += suffixTableCost(suffix);
  const escapeTable = container.escapeTable.length * 2;
  const rules = container.rules.length * 4;
  const stream = container.stream.length;
  return {
    header: HEADER_BYTES,
    suffixTable,
    lexicon,
    escapeTable,
    rules,
    stream,
    total: HEADER_BYTES + suffixTable + lexicon + escapeTable + rules + stream,
  };
}

export function serialize(container: Container): Uint8Array {
  const w = new ByteWriter();
  for (const b of MAGIC) w.u8(b);
  w.u8(FORMAT_VERSION);
  w.u8(container.threshold);
  w.u16(container.lexicon.length);
  w.u16(container.rules.length);
  w.u32(container.stream.length);
  if (container.suffixes.length > 255) throw new CodecError("the suffix table holds at most 255 codes");
  w.u8(container.suffixes.length);
  for (const suffix of container.suffixes) {
    const bytes = ENCODER.encode(suffix);
    w.varint(bytes.length);
    w.raw(bytes);
  }
  // Front-coded: shared prefix length, then a tagged length, then the rest.
  for (const entry of planLexiconEntries(container.lexicon, container.suffixes)) {
    w.varint(entry.shared);
    if (entry.suffix >= 0 && entry.literal.length === 0) {
      w.varint((entry.suffix << 2) | MODE_SUFFIX);
    } else if (entry.suffix >= 0) {
      w.varint((entry.literal.length << 2) | MODE_BOTH);
      w.raw(entry.literal);
      w.u8(entry.suffix);
    } else {
      w.varint((entry.literal.length << 2) | MODE_LITERAL);
      w.raw(entry.literal);
    }
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
  if (version !== FORMAT_VERSION) {
    throw new CodecError(
      version < FORMAT_VERSION
        ? `version ${version} stored the lexicon differently; re-encode to read it`
        : `unsupported version ${version}`,
    );
  }
  const threshold = r.u8();
  const lexiconSize = r.u16();
  const ruleCount = r.u16();
  const streamLength = r.u32();

  const decoder = new TextDecoder();
  const suffixCount = r.u8();
  const suffixBytes: Uint8Array[] = [];
  const suffixes: string[] = [];
  for (let i = 0; i < suffixCount; i++) {
    const bytes = r.raw(r.varint());
    suffixBytes.push(bytes);
    suffixes.push(decoder.decode(bytes));
  }

  const lexicon: string[] = [];
  let previous = EMPTY;
  for (let i = 0; i < lexiconSize; i++) {
    const shared = r.varint();
    if (shared > previous.length) {
      throw new CodecError(`lexicon entry ${i} shares ${shared} bytes with a ${previous.length}-byte entry`);
    }
    const tag = r.varint();
    const mode = tag & 3;
    const n = tag >>> 2;

    let literal: Uint8Array = EMPTY;
    let suffix: Uint8Array = EMPTY;
    if (mode === MODE_LITERAL) {
      literal = r.raw(n);
    } else if (mode === MODE_SUFFIX) {
      if (n >= suffixBytes.length) throw new CodecError(`lexicon entry ${i} uses undefined suffix code ${n}`);
      suffix = suffixBytes[n];
    } else if (mode === MODE_BOTH) {
      literal = r.raw(n);
      const code = r.u8();
      if (code >= suffixBytes.length) throw new CodecError(`lexicon entry ${i} uses undefined suffix code ${code}`);
      suffix = suffixBytes[code];
    } else {
      throw new CodecError(`lexicon entry ${i} has an unknown storage mode`);
    }

    const bytes = new Uint8Array(shared + literal.length + suffix.length);
    bytes.set(previous.subarray(0, shared));
    bytes.set(literal, shared);
    bytes.set(suffix, shared + literal.length);
    lexicon.push(decoder.decode(bytes));
    previous = bytes;
  }
  const escapeTable: number[] = [];
  for (let i = 0; i < threshold; i++) escapeTable.push(r.u16());
  const rules: Rule[] = [];
  for (let i = 0; i < ruleCount; i++) rules.push([r.u16(), r.u16()]);
  return { threshold, suffixes, lexicon, escapeTable, rules, stream: r.raw(streamLength) };
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
  if (cfg.singleByteCount > 255) {
    throw new CodecError(`${cfg.singleByteCount} single-byte codes leaves no room for two-byte tokens`);
  }
  if (cfg.suffixCount > 255) {
    throw new CodecError("the suffix table holds at most 255 codes");
  }

  const tokens = tokenize(text);
  const { lexicon, ids } = buildLexicon(tokens);

  // The id ceiling depends on the configured budget, not the effective one, so a
  // partly-filled escape table can never push a token out of range. Suffix codes
  // do not appear in it: they are spent in the lexicon, not the stream.
  const ceiling = maxTokenIdFor(cfg.singleByteCount);
  if (lexicon.length > ceiling + 1) {
    throw new CodecError(
      `${lexicon.length} distinct tokens exceeds the ${ceiling + 1} addressable ids with ${cfg.singleByteCount} reserved byte codes`,
    );
  }

  const { sequence, rules } = repair(ids, {
    minPairCount: cfg.minPairCount,
    maxPairs: cfg.maxPairs,
    maxTokenId: ceiling,
    firstRuleId: lexicon.length,
  });

  const escapeTable = assignSingleBytes(sequence, cfg.singleByteCount);
  const threshold = escapeTable.length;
  const { stream, singleByteTokens, twoByteTokens } = emitStream(sequence, escapeTable, threshold);

  const suffixes = planLexiconSuffixes(lexicon, {
    count: cfg.suffixCount,
    maxSuffixLength: cfg.maxSuffixLength,
  });
  const container: Container = { threshold, suffixes, lexicon, escapeTable, rules, stream };
  const lexiconEntries = planLexiconEntries(lexicon, suffixes);
  const bytes = serialize(container);
  const sizes = measure(container, lexiconEntries);
  const originalBytes = ENCODER.encode(text).length;
  const { maxDepth, maxWidth } = expand(sequence, rules, lexicon.length);

  // What the suffix table bought, against front coding alone.
  let frontCodedOnly = 0;
  for (const entry of planLexiconEntries(lexicon, [])) frontCodedOnly += entry.bytes;
  const codesUsed = new Set<number>();
  let entriesSuffixed = 0;
  for (const entry of lexiconEntries) {
    if (entry.suffix < 0) continue;
    entriesSuffixed++;
    codesUsed.add(entry.suffix);
  }

  return {
    bytes,
    container,
    stages: { tokens, terminalIds: ids, sequence, rules, escapeTable, lexiconEntries },
    stats: {
      originalBytes,
      suffixes,
      suffixCodesUsed: codesUsed.size,
      entriesSuffixed,
      lexiconBytesSaved: frontCodedOnly - sizes.lexicon - sizes.suffixTable,
      tokenCount: tokens.length,
      distinctTerminals: lexicon.length,
      lexiconPlainBytes: plainLexiconBytes(lexicon),
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
  const tokens = tokenize(text);
  const { lexicon, ids } = buildLexicon(tokens);
  const { sequence, rules } = repair(ids, {
    minPairCount: cfg.minPairCount,
    maxPairs: cfg.maxPairs,
    maxTokenId: maxTokenIdFor(range.from ?? 0),
    firstRuleId: lexicon.length,
  });
  const suffixes = planLexiconSuffixes(lexicon, {
    count: cfg.suffixCount,
    maxSuffixLength: cfg.maxSuffixLength,
  });
  return sweepFromGrammar(lexicon, sequence, rules, { ...range, suffixes });
}

/**
 * The same sweep, reusing a grammar you already built (e.g. from encode()).
 * The lexicon and its suffix table are the same at every N, so they land in the
 * fixed base that each point is measured on top of.
 */
export function sweepFromGrammar(
  lexicon: string[],
  sequence: number[],
  rules: Rule[],
  options: {
    from?: number;
    to?: number;
    step?: number;
    suffixes?: string[];
  } = {},
): { points: SweepPoint[]; ruleCount: number; sequenceLength: number; lexiconSize: number } {
  const from = Math.max(0, options.from ?? 0);
  const step = options.step ?? 1;
  const to = Math.min(255, options.to ?? 255);

  const counts = new Map<number, number>();
  for (const id of sequence) counts.set(id, (counts.get(id) ?? 0) + 1);
  const sorted = [...counts.values()].sort((a, b) => b - a);
  const prefix = new Float64Array(sorted.length + 1);
  for (let i = 0; i < sorted.length; i++) prefix[i + 1] = prefix[i] + sorted[i];

  const base = measure({
    threshold: 0,
    suffixes: options.suffixes ?? [],
    lexicon,
    escapeTable: [],
    rules,
    stream: new Uint8Array(0),
  }).total;
  const highestId = lexicon.length + rules.length - 1;

  const points: SweepPoint[] = [];
  for (let n = from; n <= to; n += step) {
    const threshold = Math.min(n, sorted.length);
    const stream = 2 * sequence.length - prefix[threshold];
    points.push({
      n,
      threshold,
      stream,
      escapeTable: threshold * 2,
      total: base + threshold * 2 + stream,
      fits: highestId <= maxTokenIdFor(n),
    });
  }
  return { points, ruleCount: rules.length, sequenceLength: sequence.length, lexiconSize: lexicon.length };
}
