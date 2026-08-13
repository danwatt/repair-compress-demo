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

/**
 * Size of the lexicon's suffix table, fixed at the byte range the original set
 * aside for endings: 0x82–0x9E, so 29 codes. Not a knob. The table costs nothing
 * in the token stream — these codes live in the lexicon section — and the writer
 * stops early anyway once no remaining ending pays for its own table entry, so
 * there is nothing to tune: taking the whole range can only help.
 */
export const SUFFIX_CODE_COUNT = 0x9e - 0x82 + 1;

export interface CodecConfig {
  /** Reserved single-byte codes for whole symbols. The original used 0x55 (85). */
  singleByteCount: number;
  /**
   * A pair must occur at least this many times to earn a rule. Original: 3,
   * which is also where a rule first pays for itself — two replacements save
   * exactly the four bytes the table entry costs — so setting this below 3 buys
   * nothing: repair() drops the break-even rules on savings anyway.
   */
  minPairCount: number;
  /** Hard cap on grammar rules, on top of the cap implied by the id space. */
  maxPairs: number;
  /** Longest suffix, in characters, the lexicon writer will consider. */
  maxSuffixLength: number;
}

export const DEFAULT_CONFIG: CodecConfig = {
  singleByteCount: 0x55,
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
    /** Lexicon entries written with at least one suffix code. */
    entriesSuffixed: number;
    /** Of those, the ones that apply two or more codes in sequence. */
    entriesChained: number;
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

/** What one rule costs in section B: two ids, two bytes each. */
const RULE_BYTES = 4;

/**
 * What one symbol costs in the stream, before the escape table shortens the
 * hottest ones to a single byte. Every replacement a rule makes drops one
 * symbol, so this is also what a replacement earns.
 */
const SYMBOL_BYTES = 2;

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
 *
 * Selection is by raw frequency, but a candidate has to clear its table entry
 * on measured savings before it is taken. Ranking by savings instead was tried
 * and lost: scoring a pair by what its symbols really cost in the stream — one
 * byte once the escape table gets to them, not two — demotes exactly the hot
 * stop-word pairs, and the grammar that comes back is 36–45 KB worse on the KJV.
 * The escape table is picked after this stage and wants short symbols to point
 * at, so folding the hot pairs feeds it rather than competing with it.
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

    // The index counts occurrences; the pass below can only take some of them,
    // because a self-overlapping pair ("aa" inside "aaa") eats its own next
    // occurrence. Score the rule on what will really be replaced. The pair stays
    // in the index when it fails — it costs nothing there, and a later merge can
    // grow it back into contention.
    let replaceable = 0;
    let eaten = -1;
    for (const i of occurrences) {
      if (i === eaten || !alive[i] || sym[i] !== left) continue;
      const j = next[i];
      if (j === -1 || !alive[j] || sym[j] !== right) continue;
      replaceable++;
      eaten = j;
    }
    if (replaceable * SYMBOL_BYTES - RULE_BYTES <= 0) continue;
    positions.delete(key);

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
 * `previous[0 .. shared] + literal + codes.map(c => suffixes[c]).join("")`.
 */
export interface LexiconEntry {
  /** Leading bytes taken from the entry before this one. */
  shared: number;
  /** Bytes spelled out. */
  literal: Uint8Array;
  /** Suffix table indices, applied in order. Empty when the entry uses none. */
  codes: number[];
  /** Encoded size, including the varints and any code bytes. */
  bytes: number;
}

/**
 * Two bits of the length varint say how the rest of the entry is spelled:
 * literal bytes, a suffix code alone, literal bytes then a code, or a chain of
 * codes. A code in MODE_SUFFIX rides in the varint itself, and a table of up to
 * 32 endings keeps that varint one byte — which is why SUFFIX_CODE_COUNT's 29 is
 * free. So "testing" costs two bytes after "tested": share 4, apply -ing.
 *
 * MODE_CHAIN spends the same varint on the first code and follows it with one
 * byte per further code, so "Aramitess" is share 4, then -ites, then -s. The high
 * bit of a code byte says another follows, which is free while the table stays
 * under 128 codes — chains are therefore any length, not just two.
 */
const MODE_LITERAL = 0;
const MODE_SUFFIX = 1;
const MODE_BOTH = 2;
const MODE_CHAIN = 3;

/** Chained codes are written as raw bytes, so bit 7 is the continuation flag. */
const CHAIN_MORE = 0x80;
const MAX_CHAINABLE_CODE = 0x7f;

function matchesAt(haystack: Uint8Array, offset: number, needle: Uint8Array): boolean {
  if (needle.length === 0 || offset < 0 || offset + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[offset + i] !== needle[i]) return false;
  }
  return true;
}

function endsWith(haystack: Uint8Array, needle: Uint8Array): boolean {
  return matchesAt(haystack, haystack.length - needle.length, needle);
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
 *
 * The shared prefix is a maximum, not an obligation. Sharing every byte on
 * offer is the cheapest way to spell an entry out, but it can bury the ending
 * a code would have paid for: "Harness" after "Harnepher" shares "Harn", which
 * leaves "ess" — and no code, so three bytes. Give one byte back and the rest is
 * "ness", which has a code, so two. So each ending is measured at the deepest
 * prefix it can keep rather than only against what maximal sharing left over,
 * and the entry takes whichever spelling is smaller. Nothing in the format
 * changes: a smaller `shared` is one the reader already accepts.
 *
 * Endings also compose. "Aramitess" follows "Aram", so a single code still has to
 * spell out five bytes; -ites then -s spells none of them, and the second code is
 * one byte. `links` below is a backward pass giving the fewest codes that cover
 * the word from each position on, which is what a chain costs past its first.
 */
export function planLexiconEntries(
  lexicon: readonly string[],
  suffixes: readonly string[],
): LexiconEntry[] {
  return planLexicon(lexicon, suffixes, false).entries;
}

/** What one planning pass produces. `links` is only filled in when asked for. */
interface PlannedLexicon {
  entries: LexiconEntry[];
  /**
   * Per entry, the fewest codes that can cover the word from each byte position
   * to its end, or -1 where no chain reaches. planLexiconSuffixes scores a
   * candidate against these: a code landing at `p` finishes the entry in
   * `1 + links[p + code.length]` codes, which is what "chains past it" means.
   */
  links: Int16Array[];
}

function planLexicon(
  lexicon: readonly string[],
  suffixes: readonly string[],
  keepLinks: boolean,
): PlannedLexicon {
  const table = suffixes.map((s) => ENCODER.encode(s));
  // Chained codes are written as bare bytes, so bit 7 has to stay a flag.
  const chainable = table.length > 0 && table.length - 1 <= MAX_CHAINABLE_CODE;
  const entries: LexiconEntry[] = [];
  const allLinks: Int16Array[] = [];
  let previous = EMPTY;

  // Scratch for the chain pass; only the first bytes.length + 1 cells are live.
  const links: number[] = [];
  const choice: number[] = [];

  for (const word of lexicon) {
    const bytes = ENCODER.encode(word);
    const maxShared = sharedPrefix(previous, bytes);

    // Baseline: share everything on offer, spell out what is left.
    let shared = maxShared;
    let literalEnd = bytes.length;
    let codes: number[] = [];
    let size = varintSize(maxShared) +
      varintSize(((bytes.length - maxShared) << 2) | MODE_LITERAL) + (bytes.length - maxShared);

    for (let code = 0; code < table.length; code++) {
      if (!endsWith(bytes, table[code])) continue;
      const cut = bytes.length - table[code].length; // where the coded ending starts
      const start = Math.min(maxShared, cut); // the code may claim shared bytes back
      const remainder = cut - start;
      const candidate = remainder === 0
        ? varintSize(start) + varintSize((code << 2) | MODE_SUFFIX)
        : varintSize(start) + varintSize((remainder << 2) | MODE_BOTH) + remainder + 1;
      if (candidate < size) {
        size = candidate;
        shared = start;
        literalEnd = cut;
        codes = [code];
      }
    }

    if (chainable) {
      const unreachable = bytes.length + 1;
      links[bytes.length] = 0;
      for (let pos = bytes.length - 1; pos >= 0; pos--) {
        links[pos] = unreachable;
        choice[pos] = -1;
        for (let code = 0; code < table.length; code++) {
          const end = pos + table[code].length;
          if (end > bytes.length || links[end] === unreachable) continue;
          if (!matchesAt(bytes, pos, table[code])) continue;
          if (links[end] + 1 < links[pos]) {
            links[pos] = links[end] + 1;
            choice[pos] = code;
          }
        }
      }
      // A chain starts where sharing stops, so try every prefix the neighbour can
      // still cover. One code is MODE_SUFFIX and already priced above.
      for (let cut = Math.min(maxShared, bytes.length); cut >= 0; cut--) {
        for (let code = 0; code < table.length; code++) {
          const end = cut + table[code].length;
          if (end > bytes.length || links[end] === unreachable) continue;
          if (!matchesAt(bytes, cut, table[code])) continue;
          const count = links[end] + 1;
          if (count < 2) continue;
          const candidate = varintSize(cut) + varintSize((code << 2) | MODE_CHAIN) + (count - 1);
          if (candidate >= size) continue;
          size = candidate;
          shared = cut;
          literalEnd = cut;
          codes = [code];
          for (let pos = end; pos < bytes.length; pos += table[choice[pos]].length) {
            codes.push(choice[pos]);
          }
        }
      }
    }

    if (keepLinks) {
      const kept = new Int16Array(bytes.length + 1).fill(-1);
      if (chainable) {
        const unreachable = bytes.length + 1;
        for (let pos = 0; pos <= bytes.length; pos++) {
          if (links[pos] !== unreachable) kept[pos] = links[pos];
        }
      } else {
        kept[bytes.length] = 0;
      }
      allLinks.push(kept);
    }

    entries.push({ shared, literal: bytes.subarray(shared, literalEnd), codes, bytes: size });
    previous = bytes;
  }
  return { entries, links: allLinks };
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
 * Candidates are not limited to that rest, because planLexiconEntries is free to
 * share fewer bytes than it could, nor to the end of a word, because codes chain.
 * An ending is scored wherever it can land: as the whole tail, as a tail reaching
 * back into the shared prefix — the "ness" of "Harness", whose neighbour
 * "Harnepher" shares the "n" — or as a link some later code chains past, the
 * "ites" of "Aramitess". The `links` array from a planning pass gives the fewest
 * codes covering a word from any position on, so what a candidate costs where it
 * lands is arithmetic rather than a guess.
 *
 * Greedy, one code per round, with the table and the entry plans chosen together:
 * each round re-plans the whole lexicon against the codes taken so far, so a
 * candidate is scored on what it saves *given* them. That is what replaced the
 * exclusive-assignment bookkeeping this used to need — overlapping endings
 * ("ing", "ng", "g") stop competing over the same word by construction, since
 * once "ing" is taken the entries it covers are already cheap.
 *
 * A pick is then confirmed against the exact plan and dropped if it did not
 * really pay, so the table cannot cost bytes: the worst case is no codes at all.
 *
 * Unlike the token-level splitter this replaced, nothing here has to exist as a
 * word. The prefix comes from the neighbouring entry rather than from a lexicon
 * lookup, so "waters" can be coded off "water..." whether or not "water" is in
 * the text at all.
 */
export function planLexiconSuffixes(
  lexicon: readonly string[],
  options: { maxSuffixLength?: number } = {},
): string[] {
  if (lexicon.length === 0) return [];
  const maxChars = options.maxSuffixLength ?? 4;
  const decoder = new TextDecoder();
  // What a code costs inside the tag once the table is full.
  const codeTagSize = varintSize(((SUFFIX_CODE_COUNT - 1) << 2) | MODE_SUFFIX);

  const words = lexicon.map((w) => ENCODER.encode(w));
  const maxShared = words.map((w, i) => (i === 0 ? 0 : sharedPrefix(words[i - 1], w)));

  // Only a string some word actually ends with can be an ending. A code may still
  // land mid-word as a chain link, but the chain it starts has to reach the end.
  const endings = new Set<string>();
  for (const bytes of words) {
    let chars = 0;
    for (let start = bytes.length - 1; start >= 0 && chars < maxChars; start--) {
      if ((bytes[start] & 0xc0) === 0x80) continue; // mid-character, not a boundary
      chars++;
      endings.add(decoder.decode(bytes.subarray(start)));
    }
  }

  // Every position each of those could be applied at, packed as
  // entry * SITE_SCALE + offset and built in entry order, so one scan sees a
  // given entry's sites together and can keep only its best.
  const SITE_SCALE = 256;
  const sites = new Map<string, number[]>();
  for (let i = 0; i < words.length; i++) {
    const bytes = words[i];
    for (let start = 0; start < bytes.length && start < SITE_SCALE; start++) {
      if ((bytes[start] & 0xc0) === 0x80) continue;
      let chars = 0;
      for (let end = start + 1; end <= bytes.length && chars < maxChars; end++) {
        if (end < bytes.length && (bytes[end] & 0xc0) === 0x80) continue;
        chars++;
        const piece = decoder.decode(bytes.subarray(start, end));
        if (!endings.has(piece)) continue;
        let list = sites.get(piece);
        if (!list) sites.set(piece, (list = []));
        list.push(i * SITE_SCALE + start);
      }
    }
  }
  for (const [piece, list] of sites) if (list.length < 2) sites.delete(piece);

  const chosen: string[] = [];
  let plan = planLexicon(lexicon, chosen, true);
  let total = 0;
  for (const entry of plan.entries) total += entry.bytes;

  for (let round = 0; round < SUFFIX_CODE_COUNT; round++) {
    let best = "";
    let bestScore = 0;

    for (const [piece, list] of sites) {
      const length = ENCODER.encode(piece).length;
      let score = -suffixTableCost(piece);
      let entry = -1;
      let bestHere = 0; // the best this code can do for the entry being scanned

      for (const site of list) {
        const i = (site / SITE_SCALE) | 0;
        if (i !== entry) {
          score += bestHere;
          bestHere = 0;
          entry = i;
        }
        const at = site % SITE_SCALE;
        const rest = plan.links[i][at + length];
        if (rest < 0) continue; // nothing in the table finishes the word from here
        const count = rest + 1;

        // Share up to this point, then let the chain carry the rest.
        let cost = at <= maxShared[i] ? varintSize(at) + codeTagSize + (count - 1) : Infinity;
        if (count === 1) {
          // A lone code can also ride behind bytes that are spelled out.
          const shared = Math.min(maxShared[i], at);
          const remainder = at - shared;
          cost = Math.min(cost, varintSize(shared) + varintSize((remainder << 2) | MODE_BOTH) + remainder + 1);
        }
        const saving = plan.entries[i].bytes - cost;
        if (saving > bestHere) bestHere = saving;
      }
      score += bestHere;

      if (score > bestScore || (score === bestScore && best !== "" &&
          (piece.length > best.length || (piece.length === best.length && piece < best)))) {
        bestScore = score;
        best = piece;
      }
    }
    if (best === "") break;

    // The score is an estimate: it prices one code against a plan that does not
    // have it yet. Confirm against the real plan, and stop if it did not pay.
    const trial = planLexicon(lexicon, [...chosen, best], true);
    let trialTotal = 0;
    for (const entry of trial.entries) trialTotal += entry.bytes;
    if (trialTotal + suffixTableCost(best) >= total) break;

    chosen.push(best);
    sites.delete(best);
    plan = trial;
    total = trialTotal;
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Stage 7 — container serialization
// ---------------------------------------------------------------------------

const MAGIC = [0x52, 0x50, 0x52, 0x31]; // "RPR1"
/** 4 chains suffix codes; 3 added the table; 2 front-coded only; 1 stored entries in full. */
const FORMAT_VERSION = 4;
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
    if (entry.codes.length > 1) {
      w.varint((entry.codes[0] << 2) | MODE_CHAIN);
      for (let i = 1; i < entry.codes.length; i++) {
        w.u8(entry.codes[i] | (i < entry.codes.length - 1 ? CHAIN_MORE : 0));
      }
    } else if (entry.codes.length === 1 && entry.literal.length === 0) {
      w.varint((entry.codes[0] << 2) | MODE_SUFFIX);
    } else if (entry.codes.length === 1) {
      w.varint((entry.literal.length << 2) | MODE_BOTH);
      w.raw(entry.literal);
      w.u8(entry.codes[0]);
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
    const ending = (code: number): Uint8Array => {
      if (code >= suffixBytes.length) throw new CodecError(`lexicon entry ${i} uses undefined suffix code ${code}`);
      return suffixBytes[code];
    };

    let literal: Uint8Array = EMPTY;
    let endings: Uint8Array[] = [];
    if (mode === MODE_LITERAL) {
      literal = r.raw(n);
    } else if (mode === MODE_SUFFIX) {
      endings = [ending(n)];
    } else if (mode === MODE_BOTH) {
      literal = r.raw(n);
      endings = [ending(r.u8())];
    } else {
      // A chain: the tag holds the first code, then a byte each while bit 7 is set.
      endings = [ending(n)];
      for (;;) {
        const code = r.u8();
        endings.push(ending(code & ~CHAIN_MORE));
        if ((code & CHAIN_MORE) === 0) break;
      }
    }

    let length = shared + literal.length;
    for (const end of endings) length += end.length;
    const bytes = new Uint8Array(length);
    bytes.set(previous.subarray(0, shared));
    bytes.set(literal, shared);
    let at = shared + literal.length;
    for (const end of endings) {
      bytes.set(end, at);
      at += end.length;
    }
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
  if (cfg.singleByteCount < 0) {
    throw new CodecError("byte budgets cannot be negative");
  }
  if (cfg.singleByteCount > 255) {
    throw new CodecError(`${cfg.singleByteCount} single-byte codes leaves no room for two-byte tokens`);
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

  const suffixes = planLexiconSuffixes(lexicon, { maxSuffixLength: cfg.maxSuffixLength });
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
  let entriesChained = 0;
  for (const entry of lexiconEntries) {
    if (entry.codes.length === 0) continue;
    entriesSuffixed++;
    if (entry.codes.length > 1) entriesChained++;
    for (const code of entry.codes) codesUsed.add(code);
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
      entriesChained,
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
  const suffixes = planLexiconSuffixes(lexicon, { maxSuffixLength: cfg.maxSuffixLength });
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
