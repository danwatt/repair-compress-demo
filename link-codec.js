var Ylk1 = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // link-codec.ts
  var link_codec_exports = {};
  __export(link_codec_exports, {
    DEFAULT_LINK_CONFIG: () => DEFAULT_LINK_CONFIG,
    ENTRY_DELTA: () => ENTRY_DELTA,
    ENTRY_TERMINAL: () => ENTRY_TERMINAL,
    LinkCodecError: () => LinkCodecError,
    buildChainIndex: () => buildChainIndex,
    decode: () => decode,
    encode: () => encode,
    open: () => open,
    read: () => read,
    resolve: () => resolve,
    search: () => search,
    step: () => step
  });

  // repair-codec.ts
  var SUFFIX_CODE_COUNT = 158 - 130 + 1;
  var ENCODER = new TextEncoder();
  var EMPTY = new Uint8Array(0);
  var TOKEN_RE = /\s+|[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;
  var ATTACHED_PUNCTUATION = /* @__PURE__ */ new Set([",", ".", ";", ":", "!", "?"]);
  var STRUCTURE_MARKERS = /* @__PURE__ */ new Set(["%", "$", "#", "@", "{", "}"]);
  var attachesLeft = (token) => ATTACHED_PUNCTUATION.has(token) || STRUCTURE_MARKERS.has(token);
  function isSeparator(token) {
    return token === "" || /^\s+$/.test(token);
  }
  function tokenize(text) {
    const matches = text.match(TOKEN_RE) ?? [];
    const tokens = [];
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
  function detokenize(tokens) {
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

  // link-codec.ts
  var ENCODER2 = new TextEncoder();
  var DECODER = new TextDecoder();
  var DEFAULT_LINK_CONFIG = {
    directTermCount: 256,
    split: false,
    shortcutInterval: 0,
    coder: "huffman"
  };
  var FUNCTION_WORDS = new Set(
    "a an the and or but if for nor so yet of to in on at by with from into unto upon over under out off up down through against among between about after before while when where then than as that which who whom whose what this these those there here it its he him his she her they them their we us our you your ye thou thee thy thine i me my mine be am is are was were been being have has had hath having do does did doth done shall should will would may might must can could let not no all any both each every some such same other another one two more most much many few own very also even only ever never now still because since until though whether neither either".split(" ")
  );
  var LinkCodecError = class extends Error {
  };
  var ByteWriter = class {
    constructor() {
      __publicField(this, "bytes", []);
    }
    u8(v) {
      this.bytes.push(v & 255);
    }
    u32(v) {
      this.bytes.push(v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255);
    }
    varint(v) {
      let x = v;
      while (x >= 128) {
        this.bytes.push(x & 127 | 128);
        x >>>= 7;
      }
      this.bytes.push(x);
    }
    raw(data) {
      for (const b of data) this.bytes.push(b);
    }
    get length() {
      return this.bytes.length;
    }
    finish() {
      return Uint8Array.from(this.bytes);
    }
  };
  var ByteReader = class {
    constructor(data) {
      __publicField(this, "data", data);
      __publicField(this, "offset", 0);
    }
    u8() {
      return this.data[this.offset++];
    }
    u32() {
      return (this.u8() << 24 | this.u8() << 16 | this.u8() << 8 | this.u8()) >>> 0;
    }
    varint() {
      let result = 0;
      let shift = 0;
      for (; ; ) {
        const b = this.u8();
        result |= (b & 127) << shift;
        if ((b & 128) === 0) return result >>> 0;
        shift += 7;
      }
    }
    raw(length) {
      const slice = this.data.subarray(this.offset, this.offset + length);
      this.offset += length;
      return slice;
    }
  };
  var BitWriter = class {
    constructor(out) {
      __publicField(this, "out", out);
      __publicField(this, "accumulator", 0);
      __publicField(this, "bits", 0);
    }
    write(value, width) {
      for (let i = width - 1; i >= 0; i--) {
        this.accumulator = this.accumulator << 1 | value >>> i & 1;
        if (++this.bits === 8) {
          this.out.u8(this.accumulator);
          this.accumulator = 0;
          this.bits = 0;
        }
      }
    }
    flush() {
      if (this.bits > 0) {
        this.out.u8(this.accumulator << 8 - this.bits);
        this.accumulator = 0;
        this.bits = 0;
      }
    }
  };
  var BitReader = class {
    constructor(input) {
      __publicField(this, "input", input);
      __publicField(this, "bits", 0);
      __publicField(this, "accumulator", 0);
    }
    bit() {
      if (this.bits === 0) {
        this.accumulator = this.input.u8();
        this.bits = 8;
      }
      this.bits--;
      return this.accumulator >>> this.bits & 1;
    }
    read(width) {
      let value = 0;
      for (let i = 0; i < width; i++) value = value << 1 | this.bit();
      return value >>> 0;
    }
    /** Drop the rest of the current byte, so byte-oriented reading can resume. */
    align() {
      this.bits = 0;
    }
  };
  var compareBytes = (a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  };
  var sharedPrefix = (a, b) => {
    const n = Math.min(a.length, b.length, 255);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  };
  var bitWidth = (v) => {
    let w = 0;
    while (v >>> w) w++;
    return w;
  };
  function writeWordList(out, words) {
    out.varint(words.length);
    let previous = new Uint8Array(0);
    for (const word of words) {
      const bytes = ENCODER2.encode(word);
      const shared = sharedPrefix(previous, bytes);
      out.u8(shared);
      out.varint(bytes.length - shared);
      out.raw(bytes.subarray(shared));
      previous = bytes;
    }
  }
  function readWordList(input) {
    const count = input.varint();
    const words = [];
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
  var MAX_CODE_LENGTH = 31;
  function huffmanLengths(frequencies) {
    const lengths = new Array(frequencies.length).fill(0);
    const leaves = [];
    frequencies.forEach((weight, symbol) => {
      if (weight > 0) leaves.push({ weight, left: null, right: null, symbol });
    });
    if (leaves.length === 0) return lengths;
    if (leaves.length === 1) {
      lengths[leaves[0].symbol] = 1;
      return lengths;
    }
    leaves.sort((a, b) => a.weight - b.weight);
    const merged = [];
    let leafAt = 0;
    let mergedAt = 0;
    const take = () => {
      const takeLeaf = mergedAt >= merged.length || leafAt < leaves.length && leaves[leafAt].weight <= merged[mergedAt].weight;
      return takeLeaf ? leaves[leafAt++] : merged[mergedAt++];
    };
    while (leaves.length - leafAt + merged.length - mergedAt > 1) {
      const left = take();
      const right = take();
      merged.push({ weight: left.weight + right.weight, left, right, symbol: -1 });
    }
    const stack = [{ node: merged[merged.length - 1], depth: 0 }];
    while (stack.length > 0) {
      const { node, depth } = stack.pop();
      if (node.symbol >= 0) {
        if (depth > MAX_CODE_LENGTH) throw new LinkCodecError(`code length ${depth} exceeds ${MAX_CODE_LENGTH}`);
        lengths[node.symbol] = Math.max(depth, 1);
        continue;
      }
      stack.push({ node: node.left, depth: depth + 1 }, { node: node.right, depth: depth + 1 });
    }
    return lengths;
  }
  function canonical(lengths) {
    let maxLength = 0;
    for (const l of lengths) maxLength = Math.max(maxLength, l);
    const countByLength = new Int32Array(maxLength + 2);
    for (const l of lengths) if (l > 0) countByLength[l]++;
    const firstCode = new Int32Array(maxLength + 2);
    const firstIndex = new Int32Array(maxLength + 2);
    let code = 0;
    let index = 0;
    for (let length = 1; length <= maxLength; length++) {
      code = code + countByLength[length - 1] << 1;
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
  function writeCode(bits, code, symbol) {
    const length = code.lengths[symbol];
    if (length === 0) throw new LinkCodecError(`symbol ${symbol} has no code`);
    bits.write(code.codes[symbol], length);
  }
  function readCode(bits, code) {
    let value = 0;
    for (let length = 1; length <= code.maxLength; length++) {
      value = value << 1 | bits.bit();
      const offset = value - code.firstCode[length];
      if (offset >= 0 && offset < code.countByLength[length]) {
        return code.sorted[code.firstIndex[length] + offset];
      }
    }
    throw new LinkCodecError("no symbol matches the bits read");
  }
  function writeCodeLengths(out, lengths) {
    out.varint(lengths.length);
    const bits = new BitWriter(out);
    for (const l of lengths) bits.write(l, 5);
    bits.flush();
  }
  function readCodeLengths(input) {
    const count = input.varint();
    const bits = new BitReader(input);
    const lengths = [];
    for (let i = 0; i < count; i++) lengths.push(bits.read(5));
    bits.align();
    return lengths;
  }
  var ENTRY_DELTA = 0 /* Delta */;
  var ENTRY_TERMINAL = 1 /* Terminal */;
  var DELTA_BUCKETS = 32;
  var PLACEHOLDER_BYTE = 255;
  var MAGIC = [89, 76, 75, 49];
  var FORMAT_VERSION = 1;
  var HEADER_BYTES = 12;
  var hasLetter = (term) => /\p{L}/u.test(term);
  function chooseDirectTerms(frequency, firstSeen, budget) {
    if (budget <= 0) return [];
    const byFrequency = (a, b) => frequency.get(b) - frequency.get(a) || firstSeen.get(a) - firstSeen.get(b);
    const symbols = [...frequency.keys()].filter((t) => !hasLetter(t)).sort(byFrequency);
    const functionWords = [...frequency.keys()].filter((t) => hasLetter(t) && FUNCTION_WORDS.has(t.toLowerCase())).sort(byFrequency);
    return [...symbols, ...functionWords].slice(0, budget);
  }
  function encode(text, config = DEFAULT_LINK_CONFIG) {
    const terms = tokenize(text);
    const frequency = /* @__PURE__ */ new Map();
    const firstSeen = /* @__PURE__ */ new Map();
    terms.forEach((term, i) => {
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
      if (!firstSeen.has(term)) firstSeen.set(term, i);
    });
    const directTerms = chooseDirectTerms(frequency, firstSeen, config.directTermCount);
    const directIndex = new Map(directTerms.map((t, i) => [t, i]));
    const searchWords = [...frequency.keys()].filter((t) => !directIndex.has(t));
    searchWords.sort((a, b) => compareBytes(ENCODER2.encode(a), ENCODER2.encode(b)));
    const lexiconRow = new Map(searchWords.map((w, i) => [w, i]));
    const linkedTerm = [];
    for (const term of terms) if (!directIndex.has(term)) linkedTerm.push(term);
    const occurrences = /* @__PURE__ */ new Map();
    linkedTerm.forEach((term, i) => {
      const list = occurrences.get(term);
      if (list) list.push(i);
      else occurrences.set(term, [i]);
    });
    const entries = new Array(linkedTerm.length);
    const firstOccurrence = new Array(searchWords.length).fill(0);
    let shortcutCount = 0;
    for (const [term, positions] of occurrences) {
      const row = lexiconRow.get(term);
      firstOccurrence[row] = positions[0];
      for (let i = 0; i < positions.length; i++) {
        const at = positions[i];
        if (i === positions.length - 1) {
          entries[at] = { kind: 1 /* Terminal */, value: row, shortcutRow: -1 };
          continue;
        }
        const wantsShortcut = config.shortcutInterval > 0 && i > 0 && i % config.shortcutInterval === 0;
        if (wantsShortcut) shortcutCount++;
        entries[at] = {
          kind: 0 /* Delta */,
          value: positions[i + 1] - at,
          shortcutRow: wantsShortcut ? row : -1
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
    if (out.length !== HEADER_BYTES) throw new LinkCodecError(`header is ${out.length} bytes, expected ${HEADER_BYTES}`);
    const afterHeader = out.length;
    writeWordList(out, directTerms);
    const afterDirect = out.length;
    writeWordList(out, searchWords);
    const afterLexicon = out.length;
    for (const position of firstOccurrence) out.varint(position);
    const afterFirst = out.length;
    const rowBits = Math.max(1, bitWidth(Math.max(searchWords.length - 1, 1)));
    const TERMINAL = directTerms.length;
    const SHORTCUT = directTerms.length + 1;
    const deltaSymbol = (delta) => directTerms.length + 2 + bitWidth(delta) - 1;
    let streamCode = null;
    let masterCode = null;
    if (config.coder === "huffman") {
      if (config.split) {
        const masterFrequency = new Array(directTerms.length + 1).fill(0);
        for (const term of terms) masterFrequency[directIndex.get(term) ?? directTerms.length]++;
        masterCode = canonical(huffmanLengths(masterFrequency));
        writeCodeLengths(out, masterCode.lengths);
      }
      const streamFrequency = new Array(directTerms.length + 2 + DELTA_BUCKETS).fill(0);
      let cursor = 0;
      for (const term of terms) {
        const direct = directIndex.get(term);
        if (direct !== void 0) {
          if (!config.split) streamFrequency[direct]++;
          continue;
        }
        const entry = entries[cursor++];
        if (entry.kind === 1 /* Terminal */) streamFrequency[TERMINAL]++;
        else if (entry.shortcutRow >= 0) streamFrequency[SHORTCUT]++;
        else streamFrequency[deltaSymbol(entry.value)]++;
      }
      streamCode = canonical(huffmanLengths(streamFrequency));
      writeCodeLengths(out, streamCode.lengths);
    }
    const afterCodeLengths = out.length;
    if (config.split) {
      if (config.coder === "huffman") {
        const bits = new BitWriter(out);
        for (const term of terms) writeCode(bits, masterCode, directIndex.get(term) ?? directTerms.length);
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
        if (direct !== void 0) {
          if (!config.split) writeCode(bits, streamCode, direct);
          continue;
        }
        const entry = entries[cursor++];
        if (entry.kind === 1 /* Terminal */) {
          writeCode(bits, streamCode, TERMINAL);
          bits.write(entry.value, rowBits);
        } else if (entry.shortcutRow >= 0) {
          writeCode(bits, streamCode, SHORTCUT);
          bits.write(entry.shortcutRow, rowBits);
          const width = bitWidth(entry.value);
          bits.write(width, 5);
          bits.write(entry.value & (1 << width - 1) - 1, width - 1);
        } else {
          writeCode(bits, streamCode, deltaSymbol(entry.value));
          const width = bitWidth(entry.value);
          bits.write(entry.value & (1 << width - 1) - 1, width - 1);
        }
      }
      bits.flush();
    } else {
      const base = config.split ? 0 : directTerms.length;
      let cursor = 0;
      for (const term of terms) {
        const direct = directIndex.get(term);
        if (direct !== void 0) {
          if (!config.split) out.varint(direct);
          continue;
        }
        const entry = entries[cursor++];
        if (entry.kind === 1 /* Terminal */) {
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
        total: bytes.length
      },
      directTerms,
      lexicon: searchWords,
      termCount: terms.length,
      linkedCount: linkedTerm.length,
      shortcutCount
    };
  }
  function open(bytes) {
    const input = new ByteReader(bytes);
    for (const b of MAGIC) {
      if (input.u8() !== b) throw new LinkCodecError("not a YLK1 container");
    }
    const version = input.u8();
    if (version !== FORMAT_VERSION) throw new LinkCodecError(`unsupported format version ${version}`);
    const flags = input.u8();
    const split = (flags & 1) !== 0;
    const coder = (flags & 2) !== 0 ? "huffman" : "varint";
    input.u8();
    input.u8();
    const termCount = input.u32();
    const directTerms = readWordList(input);
    const lexicon = readWordList(input);
    const firstOccurrence = [];
    for (let i = 0; i < lexicon.length; i++) firstOccurrence.push(input.varint());
    const rowBits = Math.max(1, bitWidth(Math.max(lexicon.length - 1, 1)));
    const TERMINAL = directTerms.length;
    const SHORTCUT = directTerms.length + 1;
    let masterCode = null;
    let streamCode = null;
    if (coder === "huffman") {
      if (split) masterCode = canonical(readCodeLengths(input));
      streamCode = canonical(readCodeLengths(input));
    }
    const directCodes = new Int32Array(termCount).fill(-1);
    const termIndex = [];
    const entries = [];
    if (split) {
      if (coder === "huffman") {
        const bits = new BitReader(input);
        for (let i = 0; i < termCount; i++) {
          const symbol = readCode(bits, masterCode);
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
          entries.push(continueHuffmanEntry(bits, readCode(bits, streamCode), TERMINAL, SHORTCUT, rowBits));
        }
      } else {
        for (let i = 0; i < termCount; i++) {
          const symbol = readCode(bits, streamCode);
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
      termIndexOf: Int32Array.from(termIndex)
    };
  }
  function continueVarintEntry(input, base, value) {
    if (value === base) return { kind: 1 /* Terminal */, value: input.varint(), shortcutRow: -1 };
    if (value === base + 1) {
      const row = input.varint();
      return { kind: 0 /* Delta */, value: input.varint(), shortcutRow: row };
    }
    return { kind: 0 /* Delta */, value: value - base - 1, shortcutRow: -1 };
  }
  function continueHuffmanEntry(bits, symbol, terminal, shortcut, rowBits) {
    if (symbol === terminal) return { kind: 1 /* Terminal */, value: bits.read(rowBits), shortcutRow: -1 };
    if (symbol === shortcut) {
      const row = bits.read(rowBits);
      const width = bits.read(5);
      return { kind: 0 /* Delta */, value: readDelta(bits, width), shortcutRow: row };
    }
    return { kind: 0 /* Delta */, value: readDelta(bits, symbol - shortcut), shortcutRow: -1 };
  }
  function readDelta(bits, width) {
    return width === 1 ? 1 : 1 << width - 1 | bits.read(width - 1);
  }
  function resolve(container, position) {
    let at = position;
    let hops = 0;
    for (; ; ) {
      const entry = container.entries[at];
      if (entry === void 0) throw new LinkCodecError(`chain ran off the end at ${at}`);
      if (entry.kind === 1 /* Terminal */) return { word: container.lexicon[entry.value], hops };
      if (entry.shortcutRow >= 0) return { word: container.lexicon[entry.shortcutRow], hops };
      at += entry.value;
      hops++;
    }
  }
  function buildChainIndex(container) {
    if (container.chainOf === void 0) {
      const chainOf = new Int32Array(container.termCount).fill(-1);
      container.termIndexOf.forEach((termIndex, chainIndex) => {
        chainOf[termIndex] = chainIndex;
      });
      container.chainOf = chainOf;
    }
    return container.chainOf;
  }
  function step(container, position) {
    const entry = container.entries[position];
    if (entry === void 0) throw new LinkCodecError(`chain ran off the end at ${position}`);
    if (entry.kind === 1 /* Terminal */) return { next: -1, word: container.lexicon[entry.value] };
    if (entry.shortcutRow >= 0) return { next: -1, word: container.lexicon[entry.shortcutRow] };
    return { next: position + entry.value, word: null };
  }
  function read(container, start, count) {
    buildChainIndex(container);
    const terms = [];
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
  function decode(bytes) {
    const container = open(bytes);
    const words = new Array(container.entries.length);
    for (let i = container.entries.length - 1; i >= 0; i--) {
      const entry = container.entries[i];
      words[i] = entry.kind === 1 /* Terminal */ ? container.lexicon[entry.value] : words[i + entry.value];
      if (words[i] === void 0) throw new LinkCodecError(`unresolved chain entry at ${i}`);
    }
    const terms = new Array(container.termCount);
    let chainIndex = 0;
    for (let i = 0; i < container.termCount; i++) {
      const code = container.directCodes[i];
      terms[i] = code >= 0 ? container.directTerms[code] : words[chainIndex++];
    }
    return detokenize(terms);
  }
  function search(container, word) {
    const target = ENCODER2.encode(word);
    let low = 0;
    let high = container.lexicon.length - 1;
    let row = -1;
    while (low <= high) {
      const mid = low + high >> 1;
      const order = compareBytes(ENCODER2.encode(container.lexicon[mid]), target);
      if (order === 0) {
        row = mid;
        break;
      }
      if (order < 0) low = mid + 1;
      else high = mid - 1;
    }
    if (row < 0) return { positions: [], hops: 0 };
    const positions = [];
    let hops = 0;
    let at = container.firstOccurrence[row];
    for (; ; ) {
      positions.push(container.termIndexOf[at]);
      const entry = container.entries[at];
      if (entry.kind === 1 /* Terminal */) break;
      at += entry.value;
      hops++;
    }
    return { positions, hops };
  }
  return __toCommonJS(link_codec_exports);
})();
