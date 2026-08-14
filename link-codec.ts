// ---------------------------------------------------------------------------
// YLK1 — a next-occurrence link codec
//
// An implementation of the storage scheme in US 5,153,831 ("Electronic Text",
// Peter N. Yianilos, Franklin Electronic Publishers, filed 1990), for a
// head-to-head against the Re-Pair codec in repair-codec.ts on the same input
// and the same tokenizer.
//
// The idea: a searchable word is never written into the text stream at all.
// Each occurrence stores the distance forward to the *next* occurrence of the
// same word. The final occurrence stores the word's lexicon row instead. Every
// occurrence of a word is therefore on one chain that ends at the lexicon, and
// that chain is simultaneously the text and its inverted index — the patent's
// central claim is that you do not pay for the index twice.
//
// Three of the patent's four "types of linking signal" are the three cases in
// the stream: a forward delta, a terminal lexicon row, and the lexicon's own
// pointer to the first occurrence. The fourth — a periodic shortcut back to the
// lexicon, so that reading a very common word does not chase a chain thousands
// of entries long — is the `shortcutInterval` option.
//
// Where this departs from the patent, and why:
//
//   * The patent measures deltas in bytes into the file, which is
//     self-referential: the size of a delta depends on the sizes of the deltas
//     it skips over. This measures deltas in entries and resolves them to bytes
//     at read time. Simpler, and slightly smaller.
//   * The patent says only that terms "are encoded as bytes of codes" and
//     leaves the entropy coding to its Appendix A, which is not in the public
//     record. Two coders are provided here: a byte varint, and a canonical
//     Huffman code over the entry alphabet. The varint is the honest floor; the
//     Huffman is the fair comparison, since repair-codec.ts also spends its
//     cheapest codes on its most frequent tokens.
//   * The lexicon is stored with repair-codec.ts's suffix table and header
//     codebook rather than plain front coding. That machinery is orthogonal to
//     the linking scheme — it is how a word list is packed, not how the text
//     refers to it — so sharing it keeps the comparison between the two codecs
//     about the streams.
// ---------------------------------------------------------------------------

import {
  tokenize, detokenize,
  planLexiconSuffixes, planLexiconEntries, planLexiconHeaderCodebook, lexiconEntryTag,
  LEXICON_MODE, LEXICON_CHAIN_MORE, MAX_LEXICON_HEADER_CODES,
  type LexiconEntry, type LexiconHeader,
} from "./repair-codec";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type Coder = "varint" | "huffman";

export interface LinkConfig {
  /**
   * How many terms are written into the stream directly instead of being
   * linked. Zero is the FIG. 2 embodiment, where every term is linked,
   * punctuation included. Any positive count is FIG. 3, where "prepositions,
   * conjunctions, common verbs and other words that are extremely common are
   * not search words" and so never enter the lexicon.
   *
   * Candidates come from FUNCTION_WORDS and from terms with no letter in them,
   * never from ordinary vocabulary — see `chooseDirectTerms`.
   */
  directTermCount: number;
  /**
   * FIG. 4: split the text-file into a master-subfile (one entry per term: a
   * direct code, or a place holder) and a search-subfile (search words only).
   * Deltas then count search-subfile entries rather than text entries, so they
   * are smaller; the cost is the place holder.
   */
  split: boolean;
  /**
   * The fourth type of linking signal. Every Nth occurrence of a word also
   * carries its lexicon row, bounding the read-mode chase. Zero disables it.
   * The patent suggests "once in every one-thousand incidences".
   */
  shortcutInterval: number;
  /** How stream symbols are packed. */
  coder: Coder;
  /**
   * The ending table for the lexicon. Planning it is an exhaustive search over
   * candidate endings — by far the slowest part of an encode, and it depends
   * only on the word list, not on any other knob. Pass one from `planSuffixes`
   * to reuse it across encodes of the same corpus; omit it to plan the exact
   * best table for this configuration's lexicon.
   */
  suffixes?: readonly string[];
}

export const DEFAULT_LINK_CONFIG: LinkConfig = {
  directTermCount: 256,
  split: false,
  shortcutInterval: 0,
  coder: "huffman",
};

/**
 * The non-search class. The patent names "prepositions, conjunctions, common
 * verbs and other words that are extremely common"; this is that class for
 * early modern English, matched without regard to case.
 *
 * Frequency alone is the wrong rule, and it matters: "God" and "LORD" are among
 * the most frequent terms in the KJV, and the patent explicitly treats them as
 * lexicon words that need the fourth type of linking signal. Choosing direct
 * terms by frequency would make them unsearchable.
 */
const FUNCTION_WORDS = new Set(
  (
    "a an the and or but if for nor so yet of to in on at by with from into unto " +
    "upon over under out off up down through against among between about after " +
    "before while when where then than as that which who whom whose what this " +
    "these those there here it its he him his she her they them their we us our " +
    "you your ye thou thee thy thine i me my mine be am is are was were been being " +
    "have has had hath having do does did doth done shall should will would may " +
    "might must can could let not no all any both each every some such same " +
    "other another one two more most much many few own very also even only ever " +
    "never now still because since until though whether neither either"
  ).split(" "),
);

export interface LinkSectionSizes {
  header: number;
  directTable: number;
  lexicon: number;
  firstOccurrence: number;
  codeLengths: number;
  master: number;
  stream: number;
  total: number;
}

export interface LinkEncodeResult {
  bytes: Uint8Array;
  sizes: LinkSectionSizes;
  /** Terms encoded directly, in stream-code order. */
  directTerms: string[];
  /** Search words, in lexicon-row order (UTF-8 byte order). */
  lexicon: string[];
  /** Total terms in the text. */
  termCount: number;
  /** Terms that went on a chain rather than being written directly. */
  linkedCount: number;
  /** Extra lexicon rows emitted as shortcut signals. */
  shortcutCount: number;
}

export class LinkCodecError extends Error {}

// ---------------------------------------------------------------------------
// Bytes and bits
// ---------------------------------------------------------------------------

class ByteWriter {
  private bytes: number[] = [];
  u8(v: number): void {
    this.bytes.push(v & 0xff);
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

/** MSB-first bit writer appending into a ByteWriter. */
class BitWriter {
  private accumulator = 0;
  private bits = 0;
  constructor(private out: ByteWriter) {}
  write(value: number, width: number): void {
    for (let i = width - 1; i >= 0; i--) {
      this.accumulator = (this.accumulator << 1) | ((value >>> i) & 1);
      if (++this.bits === 8) {
        this.out.u8(this.accumulator);
        this.accumulator = 0;
        this.bits = 0;
      }
    }
  }
  flush(): void {
    if (this.bits > 0) {
      this.out.u8(this.accumulator << (8 - this.bits));
      this.accumulator = 0;
      this.bits = 0;
    }
  }
}

class BitReader {
  private bits = 0;
  private accumulator = 0;
  constructor(private input: ByteReader) {}
  bit(): number {
    if (this.bits === 0) {
      this.accumulator = this.input.u8();
      this.bits = 8;
    }
    this.bits--;
    return (this.accumulator >>> this.bits) & 1;
  }
  read(width: number): number {
    let value = 0;
    for (let i = 0; i < width; i++) value = (value << 1) | this.bit();
    return value >>> 0;
  }
  /** Drop the rest of the current byte, so byte-oriented reading can resume. */
  align(): void {
    this.bits = 0;
  }
}

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

const sharedPrefix = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length, 0xff);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
};

/** Width of a chain position for a chain of the given length. */
const chainPositionBits = (linkedCount: number): number => Math.max(1, bitWidth(Math.max(linkedCount - 1, 1)));

/** Bits needed to hold v, so bitWidth(1) is 1 and bitWidth(0) is 0. */
const bitWidth = (v: number): number => {
  let w = 0;
  while (v >>> w) w++;
  return w;
};

/**
 * Front-coded word list: shared-prefix length, then suffix length, then suffix
 * bytes. The same trick repair-codec.ts uses on its lexicon, so neither codec
 * wins the comparison on word-list packing alone.
 */
function writeWordList(out: ByteWriter, words: string[]): void {
  out.varint(words.length);
  let previous = new Uint8Array(0);
  for (const word of words) {
    const bytes = ENCODER.encode(word);
    const shared = sharedPrefix(previous, bytes);
    out.u8(shared);
    out.varint(bytes.length - shared);
    out.raw(bytes.subarray(shared));
    previous = bytes;
  }
}

function readWordList(input: ByteReader): string[] {
  const count = input.varint();
  const words: string[] = [];
  let previous = new Uint8Array(0);
  for (let i = 0; i < count; i++) {
    const shared = input.u8();
    const suffixLength = input.varint();
    const bytes = new Uint8Array(shared + suffixLength);
    bytes.set(previous.subarray(0, shared));
    bytes.set(input.raw(suffixLength), shared);
    words.push(DECODER.decode(bytes));
    previous = bytes;
  }
  return words;
}

// ---------------------------------------------------------------------------
// Lexicon block
//
// The search lexicon is sorted, so it front-codes well, and it is full of words
// that differ only in their ending. repair-codec.ts already solves that: a small
// table of common endings, a two-bit mode in the entry's length varint saying
// whether the rest is spelled out or coded, and a codebook over the repeated
// (shared-prefix, tag) headers. The planners and the tag encoding are imported
// rather than reimplemented, so both codecs pack a word list the same way and
// neither wins the comparison on this.
//
// The direct-term table keeps the plain writer above: it is ordered by stream
// code rather than alphabetically, so there is no shared-prefix structure to
// exploit and no ending table would pay for itself over 254 function words.
// ---------------------------------------------------------------------------

function writeLexiconBlock(out: ByteWriter, words: string[], supplied?: readonly string[]): void {
  const suffixes = supplied ?? planLexiconSuffixes(words);
  const entries = planLexiconEntries(words, suffixes);
  const codebook = planLexiconHeaderCodebook(entries);
  const codeOf = new Map<string, number>();
  codebook.forEach(([shared, tag], i) => codeOf.set(`${shared},${tag}`, i));

  out.varint(words.length);
  if (suffixes.length > 0xff) throw new LinkCodecError("the suffix table holds at most 255 codes");
  out.u8(suffixes.length);
  out.u8(codebook.length);
  for (const suffix of suffixes) {
    const bytes = ENCODER.encode(suffix);
    out.varint(bytes.length);
    out.raw(bytes);
  }
  for (const [shared, tag] of codebook) {
    out.varint(shared);
    out.varint(tag);
  }
  for (const entry of entries) {
    const tag = lexiconEntryTag(entry);
    const code = codeOf.get(`${entry.shared},${tag}`);
    if (code === undefined) {
      out.varint(entry.shared + codebook.length);
      out.varint(tag);
    } else {
      out.varint(code);
    }
    if (entry.codes.length > 1) {
      for (let i = 1; i < entry.codes.length; i++) {
        out.u8(entry.codes[i] | (i < entry.codes.length - 1 ? LEXICON_CHAIN_MORE : 0));
      }
    } else {
      out.raw(entry.literal);
      if (entry.codes.length === 1 && entry.literal.length > 0) out.u8(entry.codes[0]);
    }
  }
}

function readLexiconBlock(input: ByteReader): string[] {
  const count = input.varint();
  const suffixCount = input.u8();
  const codebookSize = input.u8();
  if (codebookSize > MAX_LEXICON_HEADER_CODES) {
    throw new LinkCodecError(`lexicon header table has ${codebookSize} codes; maximum is ${MAX_LEXICON_HEADER_CODES}`);
  }
  const suffixes: Uint8Array[] = [];
  for (let i = 0; i < suffixCount; i++) suffixes.push(input.raw(input.varint()));
  const codebook: LexiconHeader[] = [];
  for (let i = 0; i < codebookSize; i++) codebook.push([input.varint(), input.varint()]);

  const ending = (code: number, at: number): Uint8Array => {
    if (code >= suffixes.length) throw new LinkCodecError(`lexicon entry ${at} uses undefined suffix code ${code}`);
    return suffixes[code];
  };

  const words: string[] = [];
  let previous = new Uint8Array(0);
  for (let i = 0; i < count; i++) {
    const header = input.varint();
    let shared: number;
    let tag: number;
    if (header < codebookSize) {
      [shared, tag] = codebook[header];
    } else {
      shared = header - codebookSize;
      tag = input.varint();
    }
    if (shared > previous.length) {
      throw new LinkCodecError(`lexicon entry ${i} shares ${shared} bytes with a ${previous.length}-byte entry`);
    }

    const mode = tag & 3;
    const n = tag >>> 2;
    let literal = new Uint8Array(0);
    let endings: Uint8Array[] = [];
    if (mode === LEXICON_MODE.LITERAL) {
      literal = input.raw(n);
    } else if (mode === LEXICON_MODE.SUFFIX) {
      endings = [ending(n, i)];
    } else if (mode === LEXICON_MODE.BOTH) {
      literal = input.raw(n);
      endings = [ending(input.u8(), i)];
    } else {
      endings = [ending(n, i)];
      for (;;) {
        const code = input.u8();
        endings.push(ending(code & ~LEXICON_CHAIN_MORE, i));
        if ((code & LEXICON_CHAIN_MORE) === 0) break;
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
    words.push(DECODER.decode(bytes));
    previous = bytes;
  }
  return words;
}

// ---------------------------------------------------------------------------
// Canonical Huffman
// ---------------------------------------------------------------------------

const MAX_CODE_LENGTH = 31;

interface HuffmanNode {
  weight: number;
  left: HuffmanNode | null;
  right: HuffmanNode | null;
  symbol: number;
}

/** Code length per symbol; zero for symbols that never occur. */
function huffmanLengths(frequencies: number[]): number[] {
  const lengths = new Array<number>(frequencies.length).fill(0);
  const leaves: HuffmanNode[] = [];
  frequencies.forEach((weight, symbol) => {
    if (weight > 0) leaves.push({ weight, left: null, right: null, symbol });
  });
  if (leaves.length === 0) return lengths;
  if (leaves.length === 1) {
    lengths[leaves[0].symbol] = 1;
    return lengths;
  }

  // Two-queue Huffman: leaves sorted once, and merged nodes come out in
  // nondecreasing weight order, so no heap is needed.
  leaves.sort((a, b) => a.weight - b.weight);
  const merged: HuffmanNode[] = [];
  let leafAt = 0;
  let mergedAt = 0;
  const take = (): HuffmanNode => {
    const takeLeaf =
      mergedAt >= merged.length || (leafAt < leaves.length && leaves[leafAt].weight <= merged[mergedAt].weight);
    return takeLeaf ? leaves[leafAt++] : merged[mergedAt++];
  };
  while (leaves.length - leafAt + merged.length - mergedAt > 1) {
    const left = take();
    const right = take();
    merged.push({ weight: left.weight + right.weight, left, right, symbol: -1 });
  }

  const stack: Array<{ node: HuffmanNode; depth: number }> = [{ node: merged[merged.length - 1], depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node.symbol >= 0) {
      if (depth > MAX_CODE_LENGTH) throw new LinkCodecError(`code length ${depth} exceeds ${MAX_CODE_LENGTH}`);
      lengths[node.symbol] = Math.max(depth, 1);
      continue;
    }
    stack.push({ node: node.left!, depth: depth + 1 }, { node: node.right!, depth: depth + 1 });
  }
  return lengths;
}

interface HuffmanCode {
  lengths: number[];
  codes: Int32Array;
  /** Decode tables indexed by code length. */
  firstCode: Int32Array;
  firstIndex: Int32Array;
  countByLength: Int32Array;
  sorted: Int32Array;
  maxLength: number;
}

function canonical(lengths: number[]): HuffmanCode {
  let maxLength = 0;
  for (const l of lengths) maxLength = Math.max(maxLength, l);
  const countByLength = new Int32Array(maxLength + 2);
  for (const l of lengths) if (l > 0) countByLength[l]++;

  const firstCode = new Int32Array(maxLength + 2);
  const firstIndex = new Int32Array(maxLength + 2);
  let code = 0;
  let index = 0;
  for (let length = 1; length <= maxLength; length++) {
    code = (code + countByLength[length - 1]) << 1;
    firstCode[length] = code;
    firstIndex[length] = index;
    index += countByLength[length];
  }

  const sorted = new Int32Array(index);
  const nextSlot = Int32Array.from(firstIndex);
  const codes = new Int32Array(lengths.length).fill(-1);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol];
    if (length === 0) continue;
    const slot = nextSlot[length]++;
    sorted[slot] = symbol;
    codes[symbol] = firstCode[length] + (slot - firstIndex[length]);
  }
  return { lengths, codes, firstCode, firstIndex, countByLength, sorted, maxLength };
}

function writeCode(bits: BitWriter, code: HuffmanCode, symbol: number): void {
  const length = code.lengths[symbol];
  if (length === 0) throw new LinkCodecError(`symbol ${symbol} has no code`);
  bits.write(code.codes[symbol], length);
}

function readCode(bits: BitReader, code: HuffmanCode): number {
  let value = 0;
  for (let length = 1; length <= code.maxLength; length++) {
    value = (value << 1) | bits.bit();
    const offset = value - code.firstCode[length];
    if (offset >= 0 && offset < code.countByLength[length]) {
      return code.sorted[code.firstIndex[length] + offset];
    }
  }
  throw new LinkCodecError("no symbol matches the bits read");
}

/** Five bits per symbol, flat. Small next to any stream it describes. */
function writeCodeLengths(out: ByteWriter, lengths: number[]): void {
  out.varint(lengths.length);
  const bits = new BitWriter(out);
  for (const l of lengths) bits.write(l, 5);
  bits.flush();
}

function readCodeLengths(input: ByteReader): number[] {
  const count = input.varint();
  const bits = new BitReader(input);
  const lengths: number[] = [];
  for (let i = 0; i < count; i++) lengths.push(bits.read(5));
  bits.align();
  return lengths;
}

// ---------------------------------------------------------------------------
// Stream symbols
//
// For the varint coder, one unsigned varint per entry, partitioned so the
// reader can tell the cases apart without a tag field:
//
//   0 .. D-1   a direct term, index into the direct table
//   D          terminal link: the next varint is a lexicon row
//   D + 1      shortcut link: the next two varints are a lexicon row and a
//              forward delta (the fourth type of linking signal)
//   D + 1 + k  a forward delta of k entries (k >= 1)
//
// Delta zero is impossible — nothing is zero entries away from itself — so the
// delta range starts at one and nothing is wasted. Terminals cost an escape
// each, but there is exactly one per distinct word, which is far cheaper than
// spending a sign bit on every entry in the file.
//
// The Huffman coder uses the same cases as symbols, except that a delta becomes
// a bucket (a symbol) plus its low bits (raw). That bucketing is what makes the
// coder practical: the KJV has 44,008 distinct delta values but only 21 distinct
// bit widths. It also fixes a real flaw in the varint layout, where a larger
// direct table pushes every delta up the value space and can cost more than the
// direct terms save.
//
// A bucket is a bit width split into DELTA_SUBBUCKETS equal parts, not the bare
// width. Deltas are not uniform inside an octave — short gaps dominate — so the
// extra resolution lets the Huffman code see that shape instead of spending
// uniform payload bits on it. Measured on the KJV: one part per octave costs
// 1,101,551 bytes, two 1,100,981, four 1,100,776, eight 1,100,799 — the code
// table starts outgrowing the gain past four.
// ---------------------------------------------------------------------------

const enum EntryKind {
  Delta,
  Terminal,
}

/** The `kind` values, exported so a UI can read `entries` without magic numbers. */
export const ENTRY_DELTA: number = EntryKind.Delta;
export const ENTRY_TERMINAL: number = EntryKind.Terminal;

interface Entry {
  kind: EntryKind;
  /** Forward delta, or lexicon row for a terminal. */
  value: number;
  /** Lexicon row carried alongside a delta by a shortcut signal, else -1. */
  shortcutRow: number;
}

/** Parts per octave. Must be a power of two; the bucket math shifts by its log2. */
const DELTA_SUBBUCKETS = 4;
const DELTA_SUBBUCKET_BITS = 2;
const DELTA_BUCKETS = 32 * DELTA_SUBBUCKETS;
/** Enough bits to name any bucket, for the shortcut signal's out-of-band delta. */
const DELTA_BUCKET_BITS = 7;
const PLACEHOLDER_BYTE = 0xff;

/** Which bucket a delta of at least 1 falls in. */
function deltaBucket(delta: number): number {
  const width = bitWidth(delta);
  const base = 1 << (width - 1);
  const part = ((delta - base) * DELTA_SUBBUCKETS) >>> (width - 1);
  return (width - 1) * DELTA_SUBBUCKETS + part;
}

/** Bits left to write raw once the bucket is known. */
function deltaPayloadBits(delta: number): number {
  return Math.max(0, bitWidth(delta) - 1 - DELTA_SUBBUCKET_BITS);
}

function writeDelta(bits: BitWriter, delta: number): void {
  const payload = deltaPayloadBits(delta);
  if (payload > 0) bits.write(delta & ((1 << payload) - 1), payload);
}

/** Rebuild a delta from its bucket, reading the payload bits it implies. */
function readDelta(bits: BitReader, bucket: number): number {
  const width = (bucket / DELTA_SUBBUCKETS | 0) + 1;
  const part = bucket % DELTA_SUBBUCKETS;
  const base = 1 << (width - 1);
  const floor = base + ((part * base) >>> DELTA_SUBBUCKET_BITS);
  const payload = Math.max(0, width - 1 - DELTA_SUBBUCKET_BITS);
  return payload > 0 ? floor | bits.read(payload) : floor;
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

const MAGIC = [0x59, 0x4c, 0x4b, 0x31]; // "YLK1"
/** 2 packed the lexicon with a suffix table and bit-packed the first-occurrence array. */
const FORMAT_VERSION = 2;
const HEADER_BYTES = 16;

const hasLetter = (term: string): boolean => /\p{L}/u.test(term);

/**
 * The non-search terms. Everything without a letter in it — separators,
 * punctuation, the structure markers from build-kjv-data.js — is never worth
 * searching, so those come first; function words fill the rest of the budget in
 * frequency order. Ordinary vocabulary is never a candidate at any budget.
 */
function chooseDirectTerms(frequency: Map<string, number>, firstSeen: Map<string, number>, budget: number): string[] {
  if (budget <= 0) return [];
  const byFrequency = (a: string, b: string) =>
    frequency.get(b)! - frequency.get(a)! || firstSeen.get(a)! - firstSeen.get(b)!;
  const symbols = [...frequency.keys()].filter((t) => !hasLetter(t)).sort(byFrequency);
  const functionWords = [...frequency.keys()]
    .filter((t) => hasLetter(t) && FUNCTION_WORDS.has(t.toLowerCase()))
    .sort(byFrequency);
  return [...symbols, ...functionWords].slice(0, budget);
}

/**
 * The ending table for every word in `text` that could ever reach the lexicon.
 * A superset of any one configuration's lexicon, so the result is reusable as
 * `LinkConfig.suffixes` no matter where the direct-term knob sits.
 */
export function planSuffixes(text: string): string[] {
  const words = [...new Set(tokenize(text))].filter(hasLetter);
  words.sort((a, b) => compareBytes(ENCODER.encode(a), ENCODER.encode(b)));
  return planLexiconSuffixes(words);
}

export function encode(text: string, config: LinkConfig = DEFAULT_LINK_CONFIG): LinkEncodeResult {
  const terms = tokenize(text);

  const frequency = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  terms.forEach((term, i) => {
    frequency.set(term, (frequency.get(term) ?? 0) + 1);
    if (!firstSeen.has(term)) firstSeen.set(term, i);
  });

  const directTerms = chooseDirectTerms(frequency, firstSeen, config.directTermCount);
  const directIndex = new Map(directTerms.map((t, i) => [t, i]));

  // Search words go in the lexicon, sorted in UTF-8 byte order so the list
  // front-codes well and search can binary-search it.
  const searchWords = [...frequency.keys()].filter((t) => !directIndex.has(t));
  searchWords.sort((a, b) => compareBytes(ENCODER.encode(a), ENCODER.encode(b)));
  const lexiconRow = new Map(searchWords.map((w, i) => [w, i]));

  // Chain positions, in stream order. Without the split these line up with term
  // indices; with it they are search-subfile indices.
  const linkedTerm: string[] = [];
  for (const term of terms) if (!directIndex.has(term)) linkedTerm.push(term);
  const occurrences = new Map<string, number[]>();
  linkedTerm.forEach((term, i) => {
    const list = occurrences.get(term);
    if (list) list.push(i);
    else occurrences.set(term, [i]);
  });

  // Build the chains. Each occurrence points forward to the next; the last
  // points at the lexicon row. Every Nth occurrence also carries its row.
  const entries = new Array<Entry>(linkedTerm.length);
  const firstOccurrence = new Array<number>(searchWords.length).fill(0);
  let shortcutCount = 0;
  for (const [term, positions] of occurrences) {
    const row = lexiconRow.get(term)!;
    firstOccurrence[row] = positions[0];
    for (let i = 0; i < positions.length; i++) {
      const at = positions[i];
      if (i === positions.length - 1) {
        entries[at] = { kind: EntryKind.Terminal, value: row, shortcutRow: -1 };
        continue;
      }
      const wantsShortcut = config.shortcutInterval > 0 && i > 0 && i % config.shortcutInterval === 0;
      if (wantsShortcut) shortcutCount++;
      entries[at] = {
        kind: EntryKind.Delta,
        value: positions[i + 1] - at,
        shortcutRow: wantsShortcut ? row : -1,
      };
    }
  }

  const out = new ByteWriter();
  for (const b of MAGIC) out.u8(b);
  out.u8(FORMAT_VERSION);
  out.u8((config.split ? 1 : 0) | (config.coder === "huffman" ? 2 : 0));
  out.u8(0);
  out.u8(0);
  out.u32(terms.length);
  out.u32(linkedTerm.length);
  if (out.length !== HEADER_BYTES) throw new LinkCodecError(`header is ${out.length} bytes, expected ${HEADER_BYTES}`);

  const afterHeader = out.length;
  writeWordList(out, directTerms);
  const afterDirect = out.length;
  writeLexiconBlock(out, searchWords, config.suffixes);
  const afterLexicon = out.length;

  // The third type of linking signal: lexicon row to first occurrence. The
  // lexicon is alphabetical rather than textual, so these are scattered over the
  // chain and neither sort nor delta-code usefully. They are, however, all
  // bounded by the chain length, so a fixed-width bit field beats a varint: no
  // value pays for a continuation bit it does not need.
  const positionBits = chainPositionBits(linkedTerm.length);
  {
    const bits = new BitWriter(out);
    for (const position of firstOccurrence) bits.write(position, positionBits);
    bits.flush();
  }
  const afterFirst = out.length;

  const rowBits = Math.max(1, bitWidth(Math.max(searchWords.length - 1, 1)));
  const TERMINAL = directTerms.length;
  const SHORTCUT = directTerms.length + 1;
  const deltaSymbol = (delta: number) => directTerms.length + 2 + deltaBucket(delta);

  let streamCode: HuffmanCode | null = null;
  let masterCode: HuffmanCode | null = null;

  if (config.coder === "huffman") {
    if (config.split) {
      // Master alphabet: the direct codes plus one place holder.
      const masterFrequency = new Array<number>(directTerms.length + 1).fill(0);
      for (const term of terms) masterFrequency[directIndex.get(term) ?? directTerms.length]++;
      masterCode = canonical(huffmanLengths(masterFrequency));
      writeCodeLengths(out, masterCode.lengths);
    }
    const streamFrequency = new Array<number>(directTerms.length + 2 + DELTA_BUCKETS).fill(0);
    let cursor = 0;
    for (const term of terms) {
      const direct = directIndex.get(term);
      if (direct !== undefined) {
        if (!config.split) streamFrequency[direct]++;
        continue;
      }
      const entry = entries[cursor++];
      if (entry.kind === EntryKind.Terminal) streamFrequency[TERMINAL]++;
      else if (entry.shortcutRow >= 0) streamFrequency[SHORTCUT]++;
      else streamFrequency[deltaSymbol(entry.value)]++;
    }
    streamCode = canonical(huffmanLengths(streamFrequency));
    writeCodeLengths(out, streamCode.lengths);
  }
  const afterCodeLengths = out.length;

  // FIG. 4's master-subfile: one entry per term, a direct code or a place
  // holder, saying which stream the next term comes from.
  if (config.split) {
    if (config.coder === "huffman") {
      const bits = new BitWriter(out);
      for (const term of terms) writeCode(bits, masterCode!, directIndex.get(term) ?? directTerms.length);
      bits.flush();
    } else {
      if (directTerms.length >= PLACEHOLDER_BYTE) {
        throw new LinkCodecError(`the varint split needs fewer than 255 direct terms, got ${directTerms.length}`);
      }
      for (const term of terms) out.u8(directIndex.get(term) ?? PLACEHOLDER_BYTE);
    }
  }
  const afterMaster = out.length;

  if (config.coder === "huffman") {
    const bits = new BitWriter(out);
    let cursor = 0;
    for (const term of terms) {
      const direct = directIndex.get(term);
      if (direct !== undefined) {
        if (!config.split) writeCode(bits, streamCode!, direct);
        continue;
      }
      const entry = entries[cursor++];
      if (entry.kind === EntryKind.Terminal) {
        writeCode(bits, streamCode!, TERMINAL);
        bits.write(entry.value, rowBits);
      } else if (entry.shortcutRow >= 0) {
        writeCode(bits, streamCode!, SHORTCUT);
        bits.write(entry.shortcutRow, rowBits);
        bits.write(deltaBucket(entry.value), DELTA_BUCKET_BITS);
        writeDelta(bits, entry.value);
      } else {
        writeCode(bits, streamCode!, deltaSymbol(entry.value));
        writeDelta(bits, entry.value);
      }
    }
    bits.flush();
  } else {
    const base = config.split ? 0 : directTerms.length;
    let cursor = 0;
    for (const term of terms) {
      const direct = directIndex.get(term);
      if (direct !== undefined) {
        if (!config.split) out.varint(direct);
        continue;
      }
      const entry = entries[cursor++];
      if (entry.kind === EntryKind.Terminal) {
        out.varint(base);
        out.varint(entry.value);
      } else if (entry.shortcutRow >= 0) {
        out.varint(base + 1);
        out.varint(entry.shortcutRow);
        out.varint(entry.value);
      } else {
        out.varint(base + 1 + entry.value);
      }
    }
  }

  const bytes = out.finish();
  return {
    bytes,
    sizes: {
      header: afterHeader,
      directTable: afterDirect - afterHeader,
      lexicon: afterLexicon - afterDirect,
      firstOccurrence: afterFirst - afterLexicon,
      codeLengths: afterCodeLengths - afterFirst,
      master: afterMaster - afterCodeLengths,
      stream: bytes.length - afterMaster,
      total: bytes.length,
    },
    directTerms,
    lexicon: searchWords,
    termCount: terms.length,
    linkedCount: linkedTerm.length,
    shortcutCount,
  };
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface LinkContainer {
  split: boolean;
  coder: Coder;
  termCount: number;
  directTerms: string[];
  lexicon: string[];
  /** Lexicon row to first chain position. */
  firstOccurrence: number[];
  /** Direct code per term index, -1 where the term is on a chain. */
  directCodes: Int32Array;
  /** The chain, one entry per linked term. */
  entries: Entry[];
  /**
   * Chain position to term index. Without the split these agree on the linked
   * positions; with it the two subfiles advance at different rates.
   */
  termIndexOf: Int32Array;
  /** Term index to chain position, built on demand by read(). */
  chainOf?: Int32Array;
  /** Stream code lengths by symbol; null for the varint coder, whose costs are derivable. */
  streamLengths: number[] | null;
  /** Master-subfile code lengths by symbol; null unless split and Huffman-coded. */
  masterLengths: number[] | null;
  /** Per-term cost, built on demand by measureStream(). */
  cost?: StreamCost;
}

export function open(bytes: Uint8Array): LinkContainer {
  const input = new ByteReader(bytes);
  for (const b of MAGIC) {
    if (input.u8() !== b) throw new LinkCodecError("not a YLK1 container");
  }
  const version = input.u8();
  if (version !== FORMAT_VERSION) throw new LinkCodecError(`unsupported format version ${version}`);
  const flags = input.u8();
  const split = (flags & 1) !== 0;
  const coder: Coder = (flags & 2) !== 0 ? "huffman" : "varint";
  input.u8();
  input.u8();
  const termCount = input.u32();
  const linkedCount = input.u32();

  const directTerms = readWordList(input);
  const lexicon = readLexiconBlock(input);
  const firstOccurrence: number[] = [];
  {
    const positionBits = chainPositionBits(linkedCount);
    const bits = new BitReader(input);
    for (let i = 0; i < lexicon.length; i++) firstOccurrence.push(bits.read(positionBits));
    bits.align();
  }

  const rowBits = Math.max(1, bitWidth(Math.max(lexicon.length - 1, 1)));
  const TERMINAL = directTerms.length;
  const SHORTCUT = directTerms.length + 1;

  let masterCode: HuffmanCode | null = null;
  let streamCode: HuffmanCode | null = null;
  if (coder === "huffman") {
    if (split) masterCode = canonical(readCodeLengths(input));
    streamCode = canonical(readCodeLengths(input));
  }

  const directCodes = new Int32Array(termCount).fill(-1);
  const termIndex: number[] = [];
  const entries: Entry[] = [];

  if (split) {
    if (coder === "huffman") {
      const bits = new BitReader(input);
      for (let i = 0; i < termCount; i++) {
        const symbol = readCode(bits, masterCode!);
        if (symbol < directTerms.length) directCodes[i] = symbol;
        else termIndex.push(i);
      }
      bits.align();
    } else {
      const master = input.raw(termCount);
      for (let i = 0; i < termCount; i++) {
        if (master[i] === PLACEHOLDER_BYTE) termIndex.push(i);
        else directCodes[i] = master[i];
      }
    }
  }

  if (coder === "huffman") {
    const bits = new BitReader(input);
    if (split) {
      for (let i = 0; i < termIndex.length; i++) {
        entries.push(continueHuffmanEntry(bits, readCode(bits, streamCode!), TERMINAL, SHORTCUT, rowBits));
      }
    } else {
      for (let i = 0; i < termCount; i++) {
        const symbol = readCode(bits, streamCode!);
        if (symbol < directTerms.length) {
          directCodes[i] = symbol;
          continue;
        }
        termIndex.push(i);
        entries.push(continueHuffmanEntry(bits, symbol, TERMINAL, SHORTCUT, rowBits));
      }
    }
    bits.align();
  } else {
    const base = split ? 0 : directTerms.length;
    if (split) {
      for (let i = 0; i < termIndex.length; i++) entries.push(continueVarintEntry(input, base, input.varint()));
    } else {
      for (let i = 0; i < termCount; i++) {
        const value = input.varint();
        if (value < base) {
          directCodes[i] = value;
          continue;
        }
        termIndex.push(i);
        entries.push(continueVarintEntry(input, base, value));
      }
    }
  }

  return {
    split,
    coder,
    termCount,
    directTerms,
    lexicon,
    firstOccurrence,
    directCodes,
    entries,
    termIndexOf: Int32Array.from(termIndex),
    streamLengths: streamCode ? streamCode.lengths : null,
    masterLengths: masterCode ? masterCode.lengths : null,
  };
}

function continueVarintEntry(input: ByteReader, base: number, value: number): Entry {
  if (value === base) return { kind: EntryKind.Terminal, value: input.varint(), shortcutRow: -1 };
  if (value === base + 1) {
    const row = input.varint();
    return { kind: EntryKind.Delta, value: input.varint(), shortcutRow: row };
  }
  return { kind: EntryKind.Delta, value: value - base - 1, shortcutRow: -1 };
}

function continueHuffmanEntry(
  bits: BitReader,
  symbol: number,
  terminal: number,
  shortcut: number,
  rowBits: number,
): Entry {
  if (symbol === terminal) return { kind: EntryKind.Terminal, value: bits.read(rowBits), shortcutRow: -1 };
  if (symbol === shortcut) {
    const row = bits.read(rowBits);
    return { kind: EntryKind.Delta, value: readDelta(bits, bits.read(DELTA_BUCKET_BITS)), shortcutRow: row };
  }
  return { kind: EntryKind.Delta, value: readDelta(bits, symbol - shortcut - 1), shortcutRow: -1 };
}

// ---------------------------------------------------------------------------
// Cost accounting
//
// What each term actually spends in the stream. The interesting property of
// this format is that the cost is not uniform and not arbitrary: a delta to a
// nearby occurrence is cheap and a delta to a distant one is dear, in direct
// proportion to how surprising the word is at that point. Being able to point
// at one term and say how many bits it cost is the whole argument made visible,
// so the codec reports it rather than leaving a UI to guess.
// ---------------------------------------------------------------------------

export interface StreamCostTotals {
  /** Codes for directly encoded terms. */
  directCodes: number;
  /** Codes naming a delta's bucket. */
  deltaCodes: number;
  /** Raw low bits completing a delta inside its bucket. */
  deltaPayload: number;
  /** Codes marking the last occurrence of a word. */
  terminalCodes: number;
  /** Lexicon rows carried by those terminals. */
  terminalRows: number;
  /** The fourth type of linking signal, code and payload together. */
  shortcuts: number;
  /** The FIG. 4 master subfile, if there is one. */
  master: number;
}

export interface StreamCost {
  /** Bits spent on each term index, code and payload together. */
  bits: Uint32Array;
  totals: StreamCostTotals;
  /** Every bit in the two stream sections, so the totals can be checked against it. */
  total: number;
}

const varintBits = (v: number): number => {
  let bits = 8;
  let x = v;
  while (x >= 0x80) {
    bits += 8;
    x >>>= 7;
  }
  return bits;
};

/**
 * Bits per term index. Exact for both coders: the Huffman path reads the code
 * lengths the container already carries, and the varint path re-derives the
 * byte counts from the values, which is deterministic.
 */
export function measureStream(container: LinkContainer): StreamCost {
  if (container.cost) return container.cost;

  const D = container.directTerms.length;
  const TERMINAL = D;
  const SHORTCUT = D + 1;
  const rowBits = Math.max(1, bitWidth(Math.max(container.lexicon.length - 1, 1)));
  const base = container.split ? 0 : D;
  const huffman = container.coder === "huffman";
  const streamLengths = container.streamLengths;
  const masterLengths = container.masterLengths;

  const bits = new Uint32Array(container.termCount);
  const totals: StreamCostTotals = {
    directCodes: 0, deltaCodes: 0, deltaPayload: 0,
    terminalCodes: 0, terminalRows: 0, shortcuts: 0, master: 0,
  };

  let chainIndex = 0;
  for (let i = 0; i < container.termCount; i++) {
    let spent = 0;

    if (container.split) {
      const symbol = container.directCodes[i] >= 0 ? container.directCodes[i] : D;
      const master = huffman ? masterLengths![symbol] : 8;
      totals.master += master;
      spent += master;
    }

    const direct = container.directCodes[i];
    if (direct >= 0) {
      if (!container.split) {
        const code = huffman ? streamLengths![direct] : varintBits(direct);
        totals.directCodes += code;
        spent += code;
      }
      bits[i] = spent;
      continue;
    }

    const entry = container.entries[chainIndex++];
    if (entry.kind === EntryKind.Terminal) {
      const code = huffman ? streamLengths![TERMINAL] : varintBits(base);
      const row = huffman ? rowBits : varintBits(entry.value);
      totals.terminalCodes += code;
      totals.terminalRows += row;
      spent += code + row;
    } else if (entry.shortcutRow >= 0) {
      const cost = huffman
        ? streamLengths![SHORTCUT] + rowBits + DELTA_BUCKET_BITS + deltaPayloadBits(entry.value)
        : varintBits(base + 1) + varintBits(entry.shortcutRow) + varintBits(entry.value);
      totals.shortcuts += cost;
      spent += cost;
    } else if (huffman) {
      const code = streamLengths![D + 2 + deltaBucket(entry.value)];
      const payload = deltaPayloadBits(entry.value);
      totals.deltaCodes += code;
      totals.deltaPayload += payload;
      spent += code + payload;
    } else {
      const code = varintBits(base + 1 + entry.value);
      totals.deltaCodes += code;
      spent += code;
    }
    bits[i] = spent;
  }

  let total = 0;
  for (const value of Object.values(totals)) total += value;
  container.cost = { bits, totals, total };
  return container.cost;
}

/** One run of bits in the stream, labelled with what it says. */
export interface BitField {
  /** What this run encodes, for a caption. */
  label: string;
  /** The bits themselves, most significant first. */
  bits: string;
  /** A code is chosen by the coder; raw bits are written as they are. */
  kind: "code" | "raw";
}

/** Rebuilt canonical codes, kept beside their container rather than inside it. */
const codeCache = new WeakMap<LinkContainer, { stream: HuffmanCode | null; master: HuffmanCode | null }>();

function codesFor(container: LinkContainer) {
  let cached = codeCache.get(container);
  if (!cached) {
    cached = {
      stream: container.streamLengths ? canonical(container.streamLengths) : null,
      master: container.masterLengths ? canonical(container.masterLengths) : null,
    };
    codeCache.set(container, cached);
  }
  return cached;
}

const bitString = (value: number, width: number): string =>
  width <= 0 ? "" : (value >>> 0).toString(2).padStart(width, "0").slice(-width);

/** A varint's bytes, most significant bit of each byte first. */
function varintFields(value: number, label: string): BitField[] {
  const bytes: number[] = [];
  let x = value;
  while (x >= 0x80) {
    bytes.push((x & 0x7f) | 0x80);
    x >>>= 7;
  }
  bytes.push(x);
  return [{ label, bits: bytes.map((b) => bitString(b, 8)).join(" "), kind: "code" }];
}

/**
 * The literal bits one term occupies, split into the runs that mean something.
 * This is the same walk the encoder does, so what comes back is what is in the
 * file — not a reconstruction of what it ought to be.
 */
export function describeBits(container: LinkContainer, termIndex: number): BitField[] {
  const D = container.directTerms.length;
  const TERMINAL = D;
  const SHORTCUT = D + 1;
  const rowBits = Math.max(1, bitWidth(Math.max(container.lexicon.length - 1, 1)));
  const base = container.split ? 0 : D;
  const huffman = container.coder === "huffman";
  const { stream, master } = codesFor(container);
  const fields: BitField[] = [];

  const code = (table: HuffmanCode, symbol: number, label: string) =>
    ({ label, bits: bitString(table.codes[symbol], table.lengths[symbol]), kind: "code" as const });

  if (container.split) {
    const symbol = container.directCodes[termIndex] >= 0 ? container.directCodes[termIndex] : D;
    const label = symbol === D ? "master: place holder" : "master: direct code";
    fields.push(huffman ? code(master!, symbol, label) : { label, bits: bitString(symbol === D ? 0xff : symbol, 8), kind: "code" });
  }

  const direct = container.directCodes[termIndex];
  if (direct >= 0) {
    if (!container.split) {
      fields.push(huffman ? code(stream!, direct, "direct term") : varintFields(direct, "direct term")[0]);
    }
    return fields;
  }

  const chainIndex = buildChainIndex(container)[termIndex];
  const entry = container.entries[chainIndex];

  if (entry.kind === EntryKind.Terminal) {
    if (huffman) {
      fields.push(code(stream!, TERMINAL, "terminal"));
      fields.push({ label: "lexicon row", bits: bitString(entry.value, rowBits), kind: "raw" });
    } else {
      fields.push(...varintFields(base, "terminal"), ...varintFields(entry.value, "lexicon row"));
    }
    return fields;
  }

  if (entry.shortcutRow >= 0) {
    if (huffman) {
      fields.push(code(stream!, SHORTCUT, "shortcut"));
      fields.push({ label: "lexicon row", bits: bitString(entry.shortcutRow, rowBits), kind: "raw" });
      fields.push({ label: "delta bucket", bits: bitString(deltaBucket(entry.value), DELTA_BUCKET_BITS), kind: "raw" });
      const payload = deltaPayloadBits(entry.value);
      if (payload > 0) fields.push({ label: "delta low bits", bits: bitString(entry.value, payload), kind: "raw" });
    } else {
      fields.push(
        ...varintFields(base + 1, "shortcut"),
        ...varintFields(entry.shortcutRow, "lexicon row"),
        ...varintFields(entry.value, "delta"),
      );
    }
    return fields;
  }

  if (huffman) {
    fields.push(code(stream!, D + 2 + deltaBucket(entry.value), "delta bucket"));
    const payload = deltaPayloadBits(entry.value);
    if (payload > 0) fields.push({ label: "delta low bits", bits: bitString(entry.value, payload), kind: "raw" });
  } else {
    fields.push(...varintFields(base + 1 + entry.value, "delta"));
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Read mode — the device's forward chase
//
// This is what FIG. 5 describes and what the hardware did: from a chain
// position, follow deltas forward until an entry names a lexicon row, then
// display that word. It touches no index and no auxiliary structure, and its
// cost is the hop count — which is exactly why the fourth type of linking
// signal exists.
// ---------------------------------------------------------------------------

export interface ReadResult {
  terms: string[];
  /** Total link hops taken, i.e. what the device pays to fill a screen. */
  hops: number;
}

/** Resolve one chain position to its word by chasing forward. */
export function resolve(container: LinkContainer, position: number): { word: string; hops: number } {
  let at = position;
  let hops = 0;
  for (;;) {
    const entry = container.entries[at];
    if (entry === undefined) throw new LinkCodecError(`chain ran off the end at ${at}`);
    if (entry.kind === EntryKind.Terminal) return { word: container.lexicon[entry.value], hops };
    if (entry.shortcutRow >= 0) return { word: container.lexicon[entry.shortcutRow], hops };
    at += entry.value;
    hops++;
  }
}

/**
 * Term index to chain position, or -1 for a directly encoded term. Built once
 * and cached on the container.
 */
export function buildChainIndex(container: LinkContainer): Int32Array {
  if (container.chainOf === undefined) {
    const chainOf = new Int32Array(container.termCount).fill(-1);
    container.termIndexOf.forEach((termIndex, chainIndex) => {
      chainOf[termIndex] = chainIndex;
    });
    container.chainOf = chainOf;
  }
  return container.chainOf;
}

/**
 * One step of the forward chase, for stepping through a chain in a UI. Returns
 * the next chain position, or the resolved word once the chase lands on a
 * lexicon pointer.
 */
export function step(container: LinkContainer, position: number): { next: number; word: string | null } {
  const entry = container.entries[position];
  if (entry === undefined) throw new LinkCodecError(`chain ran off the end at ${position}`);
  if (entry.kind === EntryKind.Terminal) return { next: -1, word: container.lexicon[entry.value] };
  if (entry.shortcutRow >= 0) return { next: -1, word: container.lexicon[entry.shortcutRow] };
  return { next: position + entry.value, word: null };
}

/** Read `count` terms from term index `start`, the way FIG. 5 does. */
export function read(container: LinkContainer, start: number, count: number): ReadResult {
  buildChainIndex(container);

  const terms: string[] = [];
  let hops = 0;
  for (let i = start; i < Math.min(start + count, container.termCount); i++) {
    const chainIndex = container.chainOf[i];
    if (chainIndex < 0) {
      terms.push(container.directTerms[container.directCodes[i]]);
      continue;
    }
    const resolved = resolve(container, chainIndex);
    terms.push(resolved.word);
    hops += resolved.hops;
  }
  return { terms, hops };
}

// ---------------------------------------------------------------------------
// Bulk decode — one reverse pass
//
// The forward chase is right for a screenful and catastrophic for a whole file:
// resolving every occurrence of a common word independently is quadratic in the
// length of its chain. Walking the stream backwards makes it linear. A delta at
// position p points to p + delta, which is to the right and therefore already
// resolved, so its word is copied back. Same format, same data, different
// traversal order.
// ---------------------------------------------------------------------------

export function decode(bytes: Uint8Array): string {
  const container = open(bytes);
  const words = new Array<string>(container.entries.length);
  for (let i = container.entries.length - 1; i >= 0; i--) {
    const entry = container.entries[i];
    words[i] = entry.kind === EntryKind.Terminal ? container.lexicon[entry.value] : words[i + entry.value];
    if (words[i] === undefined) throw new LinkCodecError(`unresolved chain entry at ${i}`);
  }

  const terms = new Array<string>(container.termCount);
  let chainIndex = 0;
  for (let i = 0; i < container.termCount; i++) {
    const code = container.directCodes[i];
    terms[i] = code >= 0 ? container.directTerms[code] : words[chainIndex++];
  }
  return detokenize(terms);
}

// ---------------------------------------------------------------------------
// Search mode — FIG. 6
//
// The lexicon gives the first occurrence; the chain gives the rest. There is no
// posting list, because the chain is the posting list.
// ---------------------------------------------------------------------------

export interface SearchResult {
  /** Term indices of every occurrence, in text order. */
  positions: number[];
  /** Link hops taken: one per occurrence after the first. */
  hops: number;
}

export function search(container: LinkContainer, word: string): SearchResult {
  const target = ENCODER.encode(word);
  let low = 0;
  let high = container.lexicon.length - 1;
  let row = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const order = compareBytes(ENCODER.encode(container.lexicon[mid]), target);
    if (order === 0) {
      row = mid;
      break;
    }
    if (order < 0) low = mid + 1;
    else high = mid - 1;
  }
  if (row < 0) return { positions: [], hops: 0 };

  const positions: number[] = [];
  let hops = 0;
  let at = container.firstOccurrence[row];
  for (;;) {
    positions.push(container.termIndexOf[at]);
    const entry = container.entries[at];
    if (entry.kind === EntryKind.Terminal) break;
    at += entry.value;
    hops++;
  }
  return { positions, hops };
}
