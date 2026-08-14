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
    anchorFor: () => anchorFor,
    buildChainIndex: () => buildChainIndex,
    decode: () => decode,
    describeBits: () => describeBits,
    encode: () => encode,
    measureStream: () => measureStream,
    open: () => open,
    planSuffixes: () => planSuffixes,
    read: () => read,
    readAnchored: () => readAnchored,
    resolve: () => resolve,
    search: () => search,
    step: () => step
  });

  // repair-codec.ts
  var SUFFIX_CODE_COUNT = 158 - 130 + 1;
  var CodecError = class extends Error {
  };
  var ENCODER = new TextEncoder();
  function sharedPrefix(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }
  var varintSize = (v) => v < 128 ? 1 : v < 16384 ? 2 : 3;
  var utf8Length = (s) => ENCODER.encode(s).length;
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
  function planThesaurus(lexicon, groups) {
    const row = /* @__PURE__ */ new Map();
    lexicon.forEach((word, i) => {
      if (!row.has(word)) row.set(word, i);
    });
    const planned = [];
    for (const group of groups) {
      const rows = [...new Set(group.map((word) => row.get(word)).filter((r) => r !== void 0))];
      if (rows.length < 2) continue;
      rows.sort((a, b) => a - b);
      planned.push(rows);
    }
    planned.sort((a, b) => a.length - b.length || a[0] - b[0]);
    return planned;
  }
  function thesaurusClasses(groups) {
    const classes = [];
    let previousHead = 0;
    for (const group of groups) {
      let entry = classes[classes.length - 1];
      if (entry === void 0 || entry.size !== group.length) {
        entry = { size: group.length, count: 0, bytes: 0 };
        classes.push(entry);
        previousHead = 0;
      }
      entry.count++;
      entry.bytes += varintSize(group[0] - previousHead);
      for (let i = 1; i < group.length; i++) entry.bytes += varintSize(group[i] - group[i - 1]);
      previousHead = group[0];
    }
    return classes;
  }
  function encodeThesaurus(groups) {
    const w = new ByteWriter();
    w.varint(groups.length);
    if (groups.length === 0) return w.finish();
    const classes = thesaurusClasses(groups);
    w.varint(classes.length);
    for (const entry of classes) {
      w.varint(entry.size);
      w.varint(entry.count);
      w.varint(entry.bytes);
    }
    let previousHead = 0;
    let size = -1;
    for (const group of groups) {
      if (group.length !== size) {
        size = group.length;
        previousHead = 0;
      }
      w.varint(group[0] - previousHead);
      for (let i = 1; i < group.length; i++) w.varint(group[i] - group[i - 1]);
      previousHead = group[0];
    }
    return w.finish();
  }
  function decodeThesaurus(bytes, offset) {
    const r = new ByteReader(bytes, offset);
    const count = r.varint();
    if (count === 0) return { groups: [], next: r.position };
    const classCount = r.varint();
    const classes = [];
    for (let i = 0; i < classCount; i++) {
      const size = r.varint();
      const groupCount = r.varint();
      r.varint();
      classes.push({ size, count: groupCount });
    }
    const groups = [];
    for (const entry of classes) {
      let previousHead = 0;
      for (let i = 0; i < entry.count; i++) {
        const head = previousHead + r.varint();
        const group = [head];
        for (let member = 1; member < entry.size; member++) group.push(group[member - 1] + r.varint());
        groups.push(group);
        previousHead = head;
      }
    }
    if (groups.length !== count) throw new CodecError(`thesaurus has ${groups.length} groups, header says ${count}`);
    return { groups, next: r.position };
  }
  var MODE_LITERAL = 0;
  var MODE_SUFFIX = 1;
  var MODE_BOTH = 2;
  var MODE_CHAIN = 3;
  var CHAIN_MORE = 128;
  var MAX_CHAINABLE_CODE = 127;
  var MAX_LEXICON_HEADER_CODES = 127;
  function lexiconEntryTag(entry) {
    if (entry.codes.length > 1) return entry.codes[0] << 2 | MODE_CHAIN;
    if (entry.codes.length === 1 && entry.literal.length === 0) {
      return entry.codes[0] << 2 | MODE_SUFFIX;
    }
    if (entry.codes.length === 1) return entry.literal.length << 2 | MODE_BOTH;
    return entry.literal.length << 2 | MODE_LITERAL;
  }
  var LEXICON_MODE = {
    LITERAL: MODE_LITERAL,
    SUFFIX: MODE_SUFFIX,
    BOTH: MODE_BOTH,
    CHAIN: MODE_CHAIN
  };
  var LEXICON_CHAIN_MORE = CHAIN_MORE;
  var lexiconHeaderKey = (shared, tag) => `${shared},${tag}`;
  function planLexiconHeaderCodebook(entries) {
    const byKey = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const tag = lexiconEntryTag(entry);
      const key = lexiconHeaderKey(entry.shared, tag);
      const candidate = byKey.get(key);
      if (candidate) candidate.count++;
      else byKey.set(key, { shared: entry.shared, tag, count: 1 });
    }
    const candidates = [...byKey.values()];
    let best = [];
    let bestBytes = Infinity;
    const limit = Math.min(MAX_LEXICON_HEADER_CODES, candidates.length);
    for (let count = 0; count <= limit; count++) {
      const ranked = candidates.map((candidate) => {
        const rawBytes = varintSize(candidate.shared + count) + varintSize(candidate.tag);
        const tableBytes = varintSize(candidate.shared) + varintSize(candidate.tag);
        return {
          candidate,
          saving: candidate.count * (rawBytes - 1) - tableBytes
        };
      }).sort((a, b) => b.saving - a.saving || b.candidate.count - a.candidate.count || a.candidate.shared - b.candidate.shared || a.candidate.tag - b.candidate.tag);
      const chosen = ranked.slice(0, count);
      const chosenKeys = new Set(chosen.map(({ candidate }) => lexiconHeaderKey(candidate.shared, candidate.tag)));
      let bytes = 0;
      for (const candidate of candidates) {
        if (chosenKeys.has(lexiconHeaderKey(candidate.shared, candidate.tag))) {
          bytes += varintSize(candidate.shared) + varintSize(candidate.tag) + candidate.count;
        } else {
          bytes += candidate.count * (varintSize(candidate.shared + count) + varintSize(candidate.tag));
        }
      }
      if (bytes < bestBytes) {
        bestBytes = bytes;
        best = chosen.map(({ candidate }) => candidate);
      }
    }
    return best.map(({ shared, tag }) => [shared, tag]);
  }
  function storedEntryBytes(entry, index, codebookLength) {
    const tag = lexiconEntryTag(entry);
    const code = index.get(lexiconHeaderKey(entry.shared, tag));
    const oldHeaderBytes = varintSize(entry.shared) + varintSize(tag);
    const newHeaderBytes = code === void 0 ? varintSize(entry.shared + codebookLength) + varintSize(tag) : varintSize(code);
    return entry.bytes - oldHeaderBytes + newHeaderBytes;
  }
  var headerIndexOf = (codebook) => {
    const index = /* @__PURE__ */ new Map();
    codebook.forEach(([shared, tag], i) => index.set(lexiconHeaderKey(shared, tag), i));
    return index;
  };
  function measureLexiconStorage(entries, codebook) {
    const index = headerIndexOf(codebook);
    let bytes = 0;
    for (const [shared, tag] of codebook) bytes += varintSize(shared) + varintSize(tag);
    for (const entry of entries) bytes += storedEntryBytes(entry, index, codebook.length);
    return bytes;
  }
  function matchesAt(haystack, offset, needle) {
    if (needle.length === 0 || offset < 0 || offset + needle.length > haystack.length) return false;
    for (let i = 0; i < needle.length; i++) {
      if (haystack[offset + i] !== needle[i]) return false;
    }
    return true;
  }
  function endsWith(haystack, needle) {
    return matchesAt(haystack, haystack.length - needle.length, needle);
  }
  var suffixTableCost = (suffix) => {
    const n = utf8Length(suffix);
    return varintSize(n) + n;
  };
  function planLexiconEntries(lexicon, suffixes) {
    return planLexicon(lexicon, suffixes, false).entries;
  }
  function planLexicon(lexicon, suffixes, keepLinks) {
    const table = suffixes.map((s) => ENCODER.encode(s));
    const chainable = table.length > 0 && table.length - 1 <= MAX_CHAINABLE_CODE;
    const entries = [];
    const allLinks = [];
    let previous = EMPTY;
    const links = [];
    const choice = [];
    for (const word of lexicon) {
      const bytes = ENCODER.encode(word);
      const maxShared = sharedPrefix(previous, bytes);
      let shared = maxShared;
      let literalEnd = bytes.length;
      let codes = [];
      let size = varintSize(maxShared) + varintSize(bytes.length - maxShared << 2 | MODE_LITERAL) + (bytes.length - maxShared);
      for (let code = 0; code < table.length; code++) {
        if (!endsWith(bytes, table[code])) continue;
        const cut = bytes.length - table[code].length;
        const start = Math.min(maxShared, cut);
        const remainder = cut - start;
        const candidate = remainder === 0 ? varintSize(start) + varintSize(code << 2 | MODE_SUFFIX) : varintSize(start) + varintSize(remainder << 2 | MODE_BOTH) + remainder + 1;
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
        for (let cut = Math.min(maxShared, bytes.length); cut >= 0; cut--) {
          for (let code = 0; code < table.length; code++) {
            const end = cut + table[code].length;
            if (end > bytes.length || links[end] === unreachable) continue;
            if (!matchesAt(bytes, cut, table[code])) continue;
            const count = links[end] + 1;
            if (count < 2) continue;
            const candidate = varintSize(cut) + varintSize(code << 2 | MODE_CHAIN) + (count - 1);
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
  function planLexiconSuffixes(lexicon, options = {}) {
    if (lexicon.length === 0) return [];
    const maxChars = options.maxSuffixLength ?? 4;
    const decoder = new TextDecoder();
    const codeTagSize = varintSize(SUFFIX_CODE_COUNT - 1 << 2 | MODE_SUFFIX);
    const words = lexicon.map((w) => ENCODER.encode(w));
    const maxShared = words.map((w, i) => i === 0 ? 0 : sharedPrefix(words[i - 1], w));
    const endings = /* @__PURE__ */ new Set();
    for (const bytes of words) {
      let chars = 0;
      for (let start = bytes.length - 1; start >= 0 && chars < maxChars; start--) {
        if ((bytes[start] & 192) === 128) continue;
        chars++;
        endings.add(decoder.decode(bytes.subarray(start)));
      }
    }
    const SITE_SCALE = 256;
    const sites = /* @__PURE__ */ new Map();
    for (let i = 0; i < words.length; i++) {
      const bytes = words[i];
      for (let start = 0; start < bytes.length && start < SITE_SCALE; start++) {
        if ((bytes[start] & 192) === 128) continue;
        let chars = 0;
        for (let end = start + 1; end <= bytes.length && chars < maxChars; end++) {
          if (end < bytes.length && (bytes[end] & 192) === 128) continue;
          chars++;
          const piece = decoder.decode(bytes.subarray(start, end));
          if (!endings.has(piece)) continue;
          let list = sites.get(piece);
          if (!list) sites.set(piece, list = []);
          list.push(i * SITE_SCALE + start);
        }
      }
    }
    for (const [piece, list] of sites) if (list.length < 2) sites.delete(piece);
    const chosen = [];
    let plan = planLexicon(lexicon, chosen, true);
    let total = measureLexiconStorage(plan.entries, planLexiconHeaderCodebook(plan.entries));
    for (let round = 0; round < SUFFIX_CODE_COUNT; round++) {
      let best = "";
      let bestScore = 0;
      for (const [piece, list] of sites) {
        const length = ENCODER.encode(piece).length;
        let score = -suffixTableCost(piece);
        let entry = -1;
        let bestHere = 0;
        for (const site of list) {
          const i = site / SITE_SCALE | 0;
          if (i !== entry) {
            score += bestHere;
            bestHere = 0;
            entry = i;
          }
          const at = site % SITE_SCALE;
          const rest = plan.links[i][at + length];
          if (rest < 0) continue;
          const count = rest + 1;
          let cost = at <= maxShared[i] ? varintSize(at) + codeTagSize + (count - 1) : Infinity;
          if (count === 1) {
            const shared = Math.min(maxShared[i], at);
            const remainder = at - shared;
            cost = Math.min(cost, varintSize(shared) + varintSize(remainder << 2 | MODE_BOTH) + remainder + 1);
          }
          const saving = plan.entries[i].bytes - cost;
          if (saving > bestHere) bestHere = saving;
        }
        score += bestHere;
        if (score > bestScore || score === bestScore && best !== "" && (piece.length > best.length || piece.length === best.length && piece < best)) {
          bestScore = score;
          best = piece;
        }
      }
      if (best === "") break;
      const trial = planLexicon(lexicon, [...chosen, best], true);
      const trialTotal = measureLexiconStorage(trial.entries, planLexiconHeaderCodebook(trial.entries));
      if (trialTotal + suffixTableCost(best) >= total) break;
      chosen.push(best);
      sites.delete(best);
      plan = trial;
      total = trialTotal;
    }
    return chosen;
  }
  var ByteWriter = class {
    constructor() {
      __publicField(this, "bytes", []);
    }
    u8(v) {
      this.bytes.push(v & 255);
    }
    u16(v) {
      this.bytes.push(v >> 8 & 255, v & 255);
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
    constructor(data, offset = 0) {
      __publicField(this, "data", data);
      __publicField(this, "offset", offset);
    }
    get position() {
      return this.offset;
    }
    seek(offset) {
      this.offset = offset;
    }
    u8() {
      return this.data[this.offset++];
    }
    u16() {
      return this.u8() << 8 | this.u8();
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

  // link-codec.ts
  var ENCODER2 = new TextEncoder();
  var DECODER = new TextDecoder();
  var DEFAULT_LINK_CONFIG = {
    directTermCount: 256,
    split: false,
    shortcutInterval: 0,
    coder: "huffman",
    contextDirectTerms: 0
  };
  var FUNCTION_WORDS = new Set(
    "a an the and or but if for nor so yet of to in on at by with from into unto upon over under out off up down through against among between about after before while when where then than as that which who whom whose what this these those there here it its he him his she her they them their we us our you your ye thou thee thy thine i me my mine be am is are was were been being have has had hath having do does did doth done shall should will would may might must can could let not no all any both each every some such same other another one two more most much many few own very also even only ever never now still because since until though whether neither either".split(" ")
  );
  var LinkCodecError = class extends Error {
  };
  var ByteWriter2 = class {
    constructor() {
      __publicField(this, "bytes", []);
    }
    u8(v) {
      this.bytes.push(v & 255);
    }
    u16(v) {
      this.bytes.push(v >> 8 & 255, v & 255);
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
  var ByteReader2 = class {
    constructor(data) {
      __publicField(this, "data", data);
      __publicField(this, "offset", 0);
    }
    get position() {
      return this.offset;
    }
    seek(offset) {
      this.offset = offset;
    }
    u8() {
      return this.data[this.offset++];
    }
    u16() {
      return this.u8() << 8 | this.u8();
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
    /** Bits written so far, counted from the start of the ByteWriter. */
    get position() {
      return this.out.length * 8 + this.bits;
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
      __publicField(this, "start");
      this.start = input.position;
    }
    /** Bits consumed since construction — what a reader has actually paid. */
    get position() {
      return (this.input.position - this.start) * 8 - this.bits;
    }
    /** Drop `count` bits, for landing mid-byte on an anchor. */
    skip(count) {
      for (let i = 0; i < count; i++) this.bit();
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
  var sharedPrefix2 = (a, b) => {
    const n = Math.min(a.length, b.length, 255);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  };
  var chainPositionBits = (linkedCount) => Math.max(1, bitWidth(Math.max(linkedCount - 1, 1)));
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
      const shared = sharedPrefix2(previous, bytes);
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
  function writeLexiconBlock(out, words, supplied) {
    const suffixes = supplied ?? planLexiconSuffixes(words);
    const entries = planLexiconEntries(words, suffixes);
    const codebook = planLexiconHeaderCodebook(entries);
    const codeOf = /* @__PURE__ */ new Map();
    codebook.forEach(([shared, tag], i) => codeOf.set(`${shared},${tag}`, i));
    out.varint(words.length);
    if (suffixes.length > 255) throw new LinkCodecError("the suffix table holds at most 255 codes");
    out.u8(suffixes.length);
    out.u8(codebook.length);
    for (const suffix of suffixes) {
      const bytes = ENCODER2.encode(suffix);
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
      if (code === void 0) {
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
  function readLexiconBlock(input) {
    const count = input.varint();
    const suffixCount = input.u8();
    const codebookSize = input.u8();
    if (codebookSize > MAX_LEXICON_HEADER_CODES) {
      throw new LinkCodecError(`lexicon header table has ${codebookSize} codes; maximum is ${MAX_LEXICON_HEADER_CODES}`);
    }
    const suffixes = [];
    for (let i = 0; i < suffixCount; i++) suffixes.push(input.raw(input.varint()));
    const codebook = [];
    for (let i = 0; i < codebookSize; i++) codebook.push([input.varint(), input.varint()]);
    const ending = (code, at) => {
      if (code >= suffixes.length) throw new LinkCodecError(`lexicon entry ${at} uses undefined suffix code ${code}`);
      return suffixes[code];
    };
    const words = [];
    let previous = new Uint8Array(0);
    for (let i = 0; i < count; i++) {
      const header = input.varint();
      let shared;
      let tag;
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
      let endings = [];
      if (mode === LEXICON_MODE.LITERAL) {
        literal = input.raw(n);
      } else if (mode === LEXICON_MODE.SUFFIX) {
        endings = [ending(n, i)];
      } else if (mode === LEXICON_MODE.BOTH) {
        literal = input.raw(n);
        endings = [ending(input.u8(), i)];
      } else {
        endings = [ending(n, i)];
        for (; ; ) {
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
  var MAX_CODE_LENGTH = 31;
  var EMPTY_CODES = new Int32Array(0);
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
  function canonical(lengths, withCodes = true) {
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
    const codes = withCodes ? new Int32Array(lengths.length).fill(-1) : EMPTY_CODES;
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      const length = lengths[symbol];
      if (length === 0) continue;
      const slot = nextSlot[length]++;
      sorted[slot] = symbol;
      if (withCodes) codes[symbol] = firstCode[length] + (slot - firstIndex[length]);
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
    for (const l of lengths) {
      bits.write(l > 0 ? 1 : 0, 1);
      if (l > 0) bits.write(l, 5);
    }
    bits.flush();
  }
  function readCodeLengths(input) {
    const count = input.varint();
    const bits = new BitReader(input);
    const lengths = new Uint8Array(count);
    for (let i = 0; i < count; i++) lengths[i] = bits.bit() === 1 ? bits.read(5) : 0;
    bits.align();
    return lengths;
  }
  var ENTRY_DELTA = 0 /* Delta */;
  var ENTRY_TERMINAL = 1 /* Terminal */;
  function contextOf(previousSymbol, contextTerms, directCount) {
    if (previousSymbol < 0) return contextTerms + 3;
    if (previousSymbol < contextTerms) return previousSymbol;
    if (previousSymbol < directCount) return contextTerms;
    if (previousSymbol === directCount) return contextTerms + 1;
    return contextTerms + 2;
  }
  var contextCountFor = (contextTerms) => contextTerms > 0 ? contextTerms + 4 : 1;
  var DELTA_SUBBUCKETS = 4;
  var DELTA_SUBBUCKET_BITS = 2;
  var DELTA_BUCKETS = 32 * DELTA_SUBBUCKETS;
  var DELTA_BUCKET_BITS = 7;
  var PLACEHOLDER_BYTE = 255;
  function deltaBucket(delta) {
    const width = bitWidth(delta);
    const base = 1 << width - 1;
    const part = (delta - base) * DELTA_SUBBUCKETS >>> width - 1;
    return (width - 1) * DELTA_SUBBUCKETS + part;
  }
  function deltaPayloadBits(delta) {
    return Math.max(0, bitWidth(delta) - 1 - DELTA_SUBBUCKET_BITS);
  }
  function writeDelta(bits, delta) {
    const payload = deltaPayloadBits(delta);
    if (payload > 0) bits.write(delta & (1 << payload) - 1, payload);
  }
  function readDelta(bits, bucket) {
    const width = (bucket / DELTA_SUBBUCKETS | 0) + 1;
    const part = bucket % DELTA_SUBBUCKETS;
    const base = 1 << width - 1;
    const floor = base + (part * base >>> DELTA_SUBBUCKET_BITS);
    const payload = Math.max(0, width - 1 - DELTA_SUBBUCKET_BITS);
    return payload > 0 ? floor | bits.read(payload) : floor;
  }
  function writeAnchors(out, anchors) {
    let previousTerm = 0;
    let previousBit = 0;
    for (const anchor of anchors) {
      out.varint(anchor.term - previousTerm);
      out.varint(anchor.bit - previousBit);
      out.varint(anchor.previous + 1);
      previousTerm = anchor.term;
      previousBit = anchor.bit;
    }
  }
  function readAnchors(input, count) {
    const anchors = [];
    let term = 0;
    let bit = 0;
    for (let i = 0; i < count; i++) {
      term += input.varint();
      bit += input.varint();
      anchors.push({ term, bit, previous: input.varint() - 1 });
    }
    return anchors;
  }
  function anchorFor(anchors, term) {
    let low = 0;
    let high = anchors.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = low + high >> 1;
      if (anchors[mid].term <= term) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }
  var MAGIC = [89, 76, 75, 49];
  var FORMAT_VERSION = 6;
  var HEADER_BYTES = 18;
  var hasLetter = (term) => /\p{L}/u.test(term);
  function chooseDirectTerms(frequency, firstSeen, budget) {
    if (budget <= 0) return [];
    const byFrequency = (a, b) => frequency.get(b) - frequency.get(a) || firstSeen.get(a) - firstSeen.get(b);
    const symbols = [...frequency.keys()].filter((t) => !hasLetter(t)).sort(byFrequency);
    const functionWords = [...frequency.keys()].filter((t) => hasLetter(t) && FUNCTION_WORDS.has(t.toLowerCase())).sort(byFrequency);
    return [...symbols, ...functionWords].slice(0, budget);
  }
  function planSuffixes(text) {
    const words = [...new Set(tokenize(text))].filter(hasLetter);
    words.sort((a, b) => compareBytes(ENCODER2.encode(a), ENCODER2.encode(b)));
    return planLexiconSuffixes(words);
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
    const thesaurus = planThesaurus(searchWords, config.thesaurus ?? []);
    const out = new ByteWriter2();
    for (const b of MAGIC) out.u8(b);
    out.u8(FORMAT_VERSION);
    out.u8((config.split ? 1 : 0) | (config.coder === "huffman" ? 2 : 0));
    out.u8(config.split ? 0 : Math.min(config.contextDirectTerms, directTerms.length, 255));
    out.u8(0);
    out.u32(terms.length);
    out.u32(linkedTerm.length);
    const anchorPositions = config.anchors ?? [];
    if (anchorPositions.length > 0 && config.split) {
      throw new LinkCodecError("anchors need the unsplit stream: a term sits in two subfiles at once");
    }
    for (let i = 1; i < anchorPositions.length; i++) {
      if (anchorPositions[i] <= anchorPositions[i - 1]) throw new LinkCodecError("anchor positions must ascend");
    }
    if (anchorPositions.length > 65535) throw new LinkCodecError("the anchor table holds at most 65535 entries");
    out.u16(anchorPositions.length);
    if (out.length !== HEADER_BYTES) throw new LinkCodecError(`header is ${out.length} bytes, expected ${HEADER_BYTES}`);
    const afterHeader = out.length;
    writeWordList(out, directTerms);
    const afterDirect = out.length;
    writeLexiconBlock(out, searchWords, config.suffixes);
    const afterLexicon = out.length;
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
    const deltaSymbol = (delta) => directTerms.length + 2 + deltaBucket(delta);
    const symbols = new Int32Array(config.split ? entries.length : terms.length);
    {
      let cursor = 0;
      let at = 0;
      for (const term of terms) {
        const direct = directIndex.get(term);
        if (direct !== void 0) {
          if (!config.split) symbols[at++] = direct;
          continue;
        }
        const entry = entries[cursor++];
        symbols[at++] = entry.kind === 1 /* Terminal */ ? TERMINAL : entry.shortcutRow >= 0 ? SHORTCUT : deltaSymbol(entry.value);
      }
    }
    const contextTerms = config.split ? 0 : Math.min(config.contextDirectTerms, directTerms.length, 255);
    const contextCount = contextCountFor(contextTerms);
    const symbolCount = directTerms.length + 2 + DELTA_BUCKETS;
    let streamCodes = [];
    let masterCode = null;
    if (config.coder === "huffman") {
      if (config.split) {
        const masterFrequency = new Array(directTerms.length + 1).fill(0);
        for (const term of terms) masterFrequency[directIndex.get(term) ?? directTerms.length]++;
        masterCode = canonical(huffmanLengths(masterFrequency));
        writeCodeLengths(out, masterCode.lengths);
      }
      const frequencies = [];
      for (let i = 0; i < contextCount; i++) frequencies.push(new Array(symbolCount).fill(0));
      let previous = -1;
      for (const symbol of symbols) {
        frequencies[contextTerms > 0 ? contextOf(previous, contextTerms, directTerms.length) : 0][symbol]++;
        previous = symbol;
      }
      streamCodes = frequencies.map((f) => canonical(huffmanLengths(f)));
      for (const code of streamCodes) writeCodeLengths(out, code.lengths);
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
    const streamOut = new ByteWriter2();
    const anchors = [];
    let nextAnchor = 0;
    if (config.coder === "huffman") {
      const bits = new BitWriter(streamOut);
      let cursor = 0;
      let at = 0;
      let previous = -1;
      for (let i = 0; i < terms.length; i++) {
        const term = terms[i];
        const direct = directIndex.get(term);
        if (direct !== void 0 && config.split) continue;
        while (nextAnchor < anchorPositions.length && anchorPositions[nextAnchor] === i) {
          anchors.push({ term: i, bit: bits.position, previous });
          nextAnchor++;
        }
        const symbol = symbols[at++];
        const table = streamCodes[contextTerms > 0 ? contextOf(previous, contextTerms, directTerms.length) : 0];
        writeCode(bits, table, symbol);
        previous = symbol;
        if (direct !== void 0) continue;
        const entry = entries[cursor++];
        if (entry.kind === 1 /* Terminal */) {
          bits.write(entry.value, rowBits);
        } else if (entry.shortcutRow >= 0) {
          bits.write(entry.shortcutRow, rowBits);
          bits.write(deltaBucket(entry.value), DELTA_BUCKET_BITS);
          writeDelta(bits, entry.value);
        } else {
          writeDelta(bits, entry.value);
        }
      }
      bits.flush();
    } else {
      const base = config.split ? 0 : directTerms.length;
      let cursor = 0;
      for (let i = 0; i < terms.length; i++) {
        const term = terms[i];
        while (nextAnchor < anchorPositions.length && anchorPositions[nextAnchor] === i) {
          anchors.push({ term: i, bit: streamOut.length * 8, previous: -1 });
          nextAnchor++;
        }
        const direct = directIndex.get(term);
        if (direct !== void 0) {
          if (!config.split) streamOut.varint(direct);
          continue;
        }
        const entry = entries[cursor++];
        if (entry.kind === 1 /* Terminal */) {
          streamOut.varint(base);
          streamOut.varint(entry.value);
        } else if (entry.shortcutRow >= 0) {
          streamOut.varint(base + 1);
          streamOut.varint(entry.shortcutRow);
          streamOut.varint(entry.value);
        } else {
          streamOut.varint(base + 1 + entry.value);
        }
      }
    }
    if (nextAnchor < anchorPositions.length) {
      throw new LinkCodecError(`anchor position ${anchorPositions[nextAnchor]} is past the ${terms.length} terms`);
    }
    writeAnchors(out, anchors);
    const afterAnchors = out.length;
    out.raw(encodeThesaurus(thesaurus));
    const afterThesaurus = out.length;
    out.raw(streamOut.finish());
    const bytes = out.finish();
    return {
      bytes,
      anchors,
      thesaurus,
      sizes: {
        header: afterHeader,
        directTable: afterDirect - afterHeader,
        lexicon: afterLexicon - afterDirect,
        firstOccurrence: afterFirst - afterLexicon,
        codeLengths: afterCodeLengths - afterFirst,
        master: afterMaster - afterCodeLengths,
        anchors: afterAnchors - afterMaster,
        thesaurus: afterThesaurus - afterAnchors,
        stream: bytes.length - afterThesaurus,
        total: bytes.length
      },
      directTerms,
      lexicon: searchWords,
      termCount: terms.length,
      linkedCount: linkedTerm.length,
      shortcutCount
    };
  }
  function readPrologue(input) {
    for (const b of MAGIC) {
      if (input.u8() !== b) throw new LinkCodecError("not a YLK1 container");
    }
    const version = input.u8();
    if (version !== FORMAT_VERSION) throw new LinkCodecError(`unsupported format version ${version}`);
    const flags = input.u8();
    const split = (flags & 1) !== 0;
    const coder = (flags & 2) !== 0 ? "huffman" : "varint";
    const contextDirectTerms = split ? 0 : input.u8();
    if (split) input.u8();
    input.u8();
    const termCount = input.u32();
    const linkedCount = input.u32();
    const anchorCount = input.u16();
    const directTerms = readWordList(input);
    const lexicon = readLexiconBlock(input);
    const firstOccurrence = [];
    {
      const positionBits = chainPositionBits(linkedCount);
      const bits = new BitReader(input);
      for (let i = 0; i < lexicon.length; i++) firstOccurrence.push(bits.read(positionBits));
      bits.align();
    }
    const contextCount = contextCountFor(contextDirectTerms);
    let masterCode = null;
    const streamCodes = [];
    if (coder === "huffman") {
      if (split) masterCode = canonical(readCodeLengths(input), false);
      for (let i = 0; i < contextCount; i++) streamCodes.push(canonical(readCodeLengths(input), false));
    }
    return {
      split,
      coder,
      contextDirectTerms,
      termCount,
      linkedCount,
      anchorCount,
      directTerms,
      lexicon,
      firstOccurrence,
      rowBits: Math.max(1, bitWidth(Math.max(lexicon.length - 1, 1))),
      masterCode,
      streamCodes
    };
  }
  function tableSelector(prologue) {
    const { streamCodes, contextDirectTerms, directTerms } = prologue;
    return (previous) => streamCodes[contextDirectTerms > 0 ? contextOf(previous, contextDirectTerms, directTerms.length) : 0];
  }
  function open(bytes) {
    const input = new ByteReader2(bytes);
    const prologue = readPrologue(input);
    const {
      split,
      coder,
      contextDirectTerms,
      termCount,
      anchorCount,
      directTerms,
      lexicon,
      firstOccurrence,
      rowBits,
      masterCode,
      streamCodes
    } = prologue;
    const TERMINAL = directTerms.length;
    const SHORTCUT = directTerms.length + 1;
    const tableFor = tableSelector(prologue);
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
    const anchors = readAnchors(input, anchorCount);
    const { groups: thesaurus, next } = decodeThesaurus(bytes, input.position);
    input.seek(next);
    const streamStart = input.position;
    if (coder === "huffman") {
      const bits = new BitReader(input);
      let previous = -1;
      if (split) {
        for (let i = 0; i < termIndex.length; i++) {
          entries.push(continueHuffmanEntry(bits, readCode(bits, streamCodes[0]), TERMINAL, SHORTCUT, rowBits));
        }
      } else {
        for (let i = 0; i < termCount; i++) {
          const symbol = readCode(bits, tableFor(previous));
          previous = symbol;
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
      anchors,
      thesaurus,
      streamStart,
      contextDirectTerms,
      streamLengths: streamCodes.length > 0 ? streamCodes.map((code) => code.lengths) : null,
      masterLengths: masterCode ? masterCode.lengths : null
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
      return { kind: 0 /* Delta */, value: readDelta(bits, bits.read(DELTA_BUCKET_BITS)), shortcutRow: row };
    }
    return { kind: 0 /* Delta */, value: readDelta(bits, symbol - shortcut - 1), shortcutRow: -1 };
  }
  var varintBits = (v) => {
    let bits = 8;
    let x = v;
    while (x >= 128) {
      bits += 8;
      x >>>= 7;
    }
    return bits;
  };
  function measureStream(container) {
    if (container.cost) return container.cost;
    const D = container.directTerms.length;
    const TERMINAL = D;
    const SHORTCUT = D + 1;
    const rowBits = Math.max(1, bitWidth(Math.max(container.lexicon.length - 1, 1)));
    const base = container.split ? 0 : D;
    const huffman = container.coder === "huffman";
    const streamLengths = container.streamLengths;
    const masterLengths = container.masterLengths;
    const contextTerms = container.contextDirectTerms;
    const lengthsFor = (previous) => streamLengths[contextTerms > 0 ? contextOf(previous, contextTerms, D) : 0];
    const bits = new Uint32Array(container.termCount);
    const totals = {
      directCodes: 0,
      deltaCodes: 0,
      deltaPayload: 0,
      terminalCodes: 0,
      terminalRows: 0,
      shortcuts: 0,
      master: 0
    };
    let chainIndex = 0;
    let previousSymbol = -1;
    for (let i = 0; i < container.termCount; i++) {
      let spent = 0;
      if (container.split) {
        const symbol = container.directCodes[i] >= 0 ? container.directCodes[i] : D;
        const master = huffman ? masterLengths[symbol] : 8;
        totals.master += master;
        spent += master;
      }
      const direct = container.directCodes[i];
      if (direct >= 0) {
        if (!container.split) {
          const code = huffman ? lengthsFor(previousSymbol)[direct] : varintBits(direct);
          totals.directCodes += code;
          spent += code;
          previousSymbol = direct;
        }
        bits[i] = spent;
        continue;
      }
      const entry = container.entries[chainIndex++];
      if (entry.kind === 1 /* Terminal */) {
        const code = huffman ? lengthsFor(previousSymbol)[TERMINAL] : varintBits(base);
        previousSymbol = TERMINAL;
        const row = huffman ? rowBits : varintBits(entry.value);
        totals.terminalCodes += code;
        totals.terminalRows += row;
        spent += code + row;
      } else if (entry.shortcutRow >= 0) {
        const cost = huffman ? lengthsFor(previousSymbol)[SHORTCUT] + rowBits + DELTA_BUCKET_BITS + deltaPayloadBits(entry.value) : varintBits(base + 1) + varintBits(entry.shortcutRow) + varintBits(entry.value);
        previousSymbol = SHORTCUT;
        totals.shortcuts += cost;
        spent += cost;
      } else if (huffman) {
        const symbol = D + 2 + deltaBucket(entry.value);
        const code = lengthsFor(previousSymbol)[symbol];
        previousSymbol = symbol;
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
  var codeCache = /* @__PURE__ */ new WeakMap();
  function codesFor(container) {
    let cached = codeCache.get(container);
    if (cached) return cached;
    const D = container.directTerms.length;
    let symbolAt = null;
    if (!container.split && container.contextDirectTerms > 0) {
      symbolAt = new Int32Array(container.termCount);
      let chain = 0;
      for (let i = 0; i < container.termCount; i++) {
        const direct = container.directCodes[i];
        if (direct >= 0) {
          symbolAt[i] = direct;
          continue;
        }
        const entry = container.entries[chain++];
        symbolAt[i] = entry.kind === 1 /* Terminal */ ? D : entry.shortcutRow >= 0 ? D + 1 : D + 2 + deltaBucket(entry.value);
      }
    }
    cached = {
      stream: container.streamLengths ? container.streamLengths.map((l) => canonical(l)) : [],
      master: container.masterLengths ? canonical(container.masterLengths) : null,
      symbolAt
    };
    codeCache.set(container, cached);
    return cached;
  }
  var bitString = (value, width) => width <= 0 ? "" : (value >>> 0).toString(2).padStart(width, "0").slice(-width);
  function varintFields(value, label) {
    const bytes = [];
    let x = value;
    while (x >= 128) {
      bytes.push(x & 127 | 128);
      x >>>= 7;
    }
    bytes.push(x);
    return [{ label, bits: bytes.map((b) => bitString(b, 8)).join(" "), kind: "code" }];
  }
  function describeBits(container, termIndex) {
    const D = container.directTerms.length;
    const TERMINAL = D;
    const SHORTCUT = D + 1;
    const rowBits = Math.max(1, bitWidth(Math.max(container.lexicon.length - 1, 1)));
    const base = container.split ? 0 : D;
    const huffman = container.coder === "huffman";
    const { stream, master, symbolAt } = codesFor(container);
    const contextTerms = container.split ? 0 : container.contextDirectTerms;
    const previous = symbolAt && termIndex > 0 ? symbolAt[termIndex - 1] : -1;
    const tableIndex = contextTerms > 0 ? contextOf(previous, contextTerms, D) : 0;
    const table = stream.length > 0 ? stream[tableIndex] : null;
    let choice = null;
    if (table) {
      let live = 0;
      for (let i = 0; i < table.lengths.length; i++) if (table.lengths[i] > 0) live++;
      const reason = contextTerms === 0 ? "the only table" : previous < 0 ? "start of the stream" : previous < contextTerms ? `after ${JSON.stringify(container.directTerms[previous])}` : previous < D ? "after any other direct term" : previous === D ? "after a terminal link" : "after a delta";
      choice = { index: tableIndex, reason, liveSymbols: live };
    }
    const fields = [];
    const code = (from, symbol, label) => ({ label, bits: bitString(from.codes[symbol], from.lengths[symbol]), kind: "code" });
    if (container.split) {
      const symbol = container.directCodes[termIndex] >= 0 ? container.directCodes[termIndex] : D;
      const label = symbol === D ? "master: place holder" : "master: direct code";
      fields.push(huffman ? code(master, symbol, label) : { label, bits: bitString(symbol === D ? 255 : symbol, 8), kind: "code" });
    }
    const direct = container.directCodes[termIndex];
    if (direct >= 0) {
      if (!container.split) {
        fields.push(huffman ? code(table, direct, "direct term") : varintFields(direct, "direct term")[0]);
      }
      return { table: choice, fields };
    }
    const chainIndex = buildChainIndex(container)[termIndex];
    const entry = container.entries[chainIndex];
    if (entry.kind === 1 /* Terminal */) {
      if (huffman) {
        fields.push(code(table, TERMINAL, "terminal"));
        fields.push({ label: "lexicon row", bits: bitString(entry.value, rowBits), kind: "raw" });
      } else {
        fields.push(...varintFields(base, "terminal"), ...varintFields(entry.value, "lexicon row"));
      }
      return { table: choice, fields };
    }
    if (entry.shortcutRow >= 0) {
      if (huffman) {
        fields.push(code(table, SHORTCUT, "shortcut"));
        fields.push({ label: "lexicon row", bits: bitString(entry.shortcutRow, rowBits), kind: "raw" });
        fields.push({ label: "delta bucket", bits: bitString(deltaBucket(entry.value), DELTA_BUCKET_BITS), kind: "raw" });
        const payload = deltaPayloadBits(entry.value);
        if (payload > 0) fields.push({ label: "delta low bits", bits: bitString(entry.value, payload), kind: "raw" });
      } else {
        fields.push(
          ...varintFields(base + 1, "shortcut"),
          ...varintFields(entry.shortcutRow, "lexicon row"),
          ...varintFields(entry.value, "delta")
        );
      }
      return { table: choice, fields };
    }
    if (huffman) {
      fields.push(code(table, D + 2 + deltaBucket(entry.value), "delta bucket"));
      const payload = deltaPayloadBits(entry.value);
      if (payload > 0) fields.push({ label: "delta low bits", bits: bitString(entry.value, payload), kind: "raw" });
    } else {
      fields.push(...varintFields(base + 1 + entry.value, "delta"));
    }
    return { table: choice, fields };
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
  function readAnchored(bytes, anchorIndex, count, skip = 0) {
    const input = new ByteReader2(bytes);
    const prologue = readPrologue(input);
    if (prologue.split) throw new LinkCodecError("anchors need the unsplit stream");
    const anchors = readAnchors(input, prologue.anchorCount);
    const anchor = anchors[anchorIndex];
    if (anchor === void 0) throw new LinkCodecError(`no anchor ${anchorIndex}`);
    input.seek(decodeThesaurus(bytes, input.position).next);
    const streamStart = input.position;
    const { directTerms, lexicon, rowBits, coder } = prologue;
    const D = directTerms.length;
    const TERMINAL = D;
    const SHORTCUT = D + 1;
    const huffman = coder === "huffman";
    const tableFor = tableSelector(prologue);
    input.seek(streamStart + (anchor.bit >> 3));
    const bits = new BitReader(input);
    bits.skip(anchor.bit & 7);
    const from = input.position;
    let previous = anchor.previous;
    let decoded = 0;
    const nextTerm = () => {
      if (decoded++ >= prologue.termCount) throw new LinkCodecError("the chain ran off the end of the stream");
      if (huffman) {
        const symbol = readCode(bits, tableFor(previous));
        previous = symbol;
        if (symbol < D) return { direct: symbol, entry: null };
        return { direct: -1, entry: continueHuffmanEntry(bits, symbol, TERMINAL, SHORTCUT, rowBits) };
      }
      const value = input.varint();
      if (value < D) return { direct: value, entry: null };
      return { direct: -1, entry: continueVarintEntry(input, D, value) };
    };
    for (let i = 0; i < skip; i++) nextTerm();
    const scanBits = huffman ? bits.position : (input.position - from) * 8;
    const terms = [];
    const chainAt = [];
    const chain = [];
    while (terms.length < count) {
      const { direct, entry } = nextTerm();
      if (entry === null) {
        terms.push(directTerms[direct]);
        chainAt.push(-1);
      } else {
        terms.push(null);
        chainAt.push(chain.length);
        chain.push(entry);
      }
    }
    let hops = 0;
    for (let i = 0; i < terms.length; i++) {
      if (terms[i] !== null) continue;
      let at = chainAt[i];
      for (; ; ) {
        while (at >= chain.length) {
          const { entry: entry2 } = nextTerm();
          if (entry2 !== null) chain.push(entry2);
        }
        const entry = chain[at];
        if (entry.kind === 1 /* Terminal */) {
          terms[i] = lexicon[entry.value];
          break;
        }
        if (entry.shortcutRow >= 0) {
          terms[i] = lexicon[entry.shortcutRow];
          break;
        }
        at += entry.value;
        hops++;
      }
    }
    const spent = huffman ? bits.position : (input.position - from) * 8;
    return {
      terms,
      scanBits,
      readBits: spent - scanBits,
      entriesDecoded: chain.length,
      hops
    };
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
