var RePair = (() => {
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

  // repair-codec.ts
  var repair_codec_exports = {};
  __export(repair_codec_exports, {
    CodecError: () => CodecError,
    DEFAULT_CONFIG: () => DEFAULT_CONFIG,
    SUFFIX_CODE_COUNT: () => SUFFIX_CODE_COUNT,
    assignSingleBytes: () => assignSingleBytes,
    buildLexicon: () => buildLexicon,
    decode: () => decode,
    decodeContainer: () => decodeContainer,
    describeToken: () => describeToken,
    deserialize: () => deserialize,
    detokenize: () => detokenize,
    emitStream: () => emitStream,
    encode: () => encode,
    expand: () => expand,
    expandToWords: () => expandToWords,
    isSeparator: () => isSeparator,
    maxTokenIdFor: () => maxTokenIdFor,
    measure: () => measure,
    plainLexiconBytes: () => plainLexiconBytes,
    planLexiconEntries: () => planLexiconEntries,
    planLexiconSuffixes: () => planLexiconSuffixes,
    readStream: () => readStream,
    repair: () => repair,
    serialize: () => serialize,
    sweepFromGrammar: () => sweepFromGrammar,
    sweepSingleByteCount: () => sweepSingleByteCount,
    tokenize: () => tokenize
  });
  var SUFFIX_CODE_COUNT = 158 - 130 + 1;
  var DEFAULT_CONFIG = {
    singleByteCount: 85,
    minPairCount: 3,
    maxPairs: 65535,
    maxSuffixLength: 4
  };
  var CodecError = class extends Error {
  };
  var ENCODER = new TextEncoder();
  function compareBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  }
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
  function describeToken(token) {
    if (token === "") return "\u2400";
    return token.replace(/\n/g, "\u23CE").replace(/\t/g, "\u21E5");
  }
  function buildLexicon(tokens) {
    const entries = [...new Set(tokens)].map((word) => ({ word, bytes: ENCODER.encode(word) }));
    entries.sort((a, b) => compareBytes(a.bytes, b.bytes));
    const lexicon = entries.map((e) => e.word);
    const index = /* @__PURE__ */ new Map();
    lexicon.forEach((word, i) => index.set(word, i));
    return { lexicon, ids: tokens.map((t) => index.get(t)) };
  }
  var RULE_BYTES = 4;
  var SYMBOL_BYTES = 2;
  var PairHeap = class {
    constructor() {
      __publicField(this, "counts", []);
      __publicField(this, "keys", []);
    }
    push(count, key) {
      let i = this.counts.length;
      this.counts.push(count);
      this.keys.push(key);
      while (i > 0) {
        const parent = i - 1 >> 1;
        if (this.counts[parent] >= this.counts[i]) break;
        this.swap(parent, i);
        i = parent;
      }
    }
    pop() {
      if (this.counts.length === 0) return void 0;
      const top = { count: this.counts[0], key: this.keys[0] };
      const lastCount = this.counts.pop();
      const lastKey = this.keys.pop();
      if (this.counts.length > 0) {
        this.counts[0] = lastCount;
        this.keys[0] = lastKey;
        let i = 0;
        for (; ; ) {
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
    swap(a, b) {
      [this.counts[a], this.counts[b]] = [this.counts[b], this.counts[a]];
      [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    }
  };
  function repair(ids, options) {
    const n = ids.length;
    const rules = [];
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
    const positions = /* @__PURE__ */ new Map();
    const heap = new PairHeap();
    const addOccurrence = (a, b, at) => {
      const key = a * KEY_SHIFT + b;
      let set = positions.get(key);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        positions.set(key, set);
      }
      set.add(at);
      heap.push(set.size, key);
    };
    const removeOccurrence = (a, b, at) => {
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
      let key = -1;
      for (; ; ) {
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
      const occurrences = [...positions.get(key)].sort((a, b) => a - b);
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
    const sequence = [];
    for (let i = 0; i !== -1; i = next[i]) sequence.push(sym[i]);
    return { sequence, rules };
  }
  function assignSingleBytes(sequence, singleByteCount, exclude = /* @__PURE__ */ new Set()) {
    if (singleByteCount <= 0) return [];
    const counts = /* @__PURE__ */ new Map();
    for (const id of sequence) {
      if (exclude.has(id)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, singleByteCount).map(([id]) => id);
  }
  function emitStream(sequence, escapeTable, threshold) {
    const escapeIndex = /* @__PURE__ */ new Map();
    escapeTable.forEach((id, i) => escapeIndex.set(id, i));
    const out = [];
    let single = 0;
    let two = 0;
    for (const id of sequence) {
      const code = escapeIndex.get(id);
      if (code !== void 0) {
        out.push(code);
        single++;
      } else {
        const hi = (id >> 8) + threshold;
        if (hi > 255) throw new CodecError(`token ${id} is outside the two-byte space`);
        out.push(hi, id & 255);
        two++;
      }
    }
    return { stream: Uint8Array.from(out), singleByteTokens: single, twoByteTokens: two };
  }
  function readStream(stream, escapeTable, threshold) {
    const tokens = [];
    for (let i = 0; i < stream.length; ) {
      const lead = stream[i++];
      if (lead < threshold) {
        const id = escapeTable[lead];
        if (id === void 0) throw new CodecError(`escape code ${lead} is not in the table`);
        tokens.push(id);
      } else {
        if (i >= stream.length) throw new CodecError("stream ends mid-token");
        tokens.push(lead - threshold << 8 | stream[i++]);
      }
    }
    return tokens;
  }
  function expand(tokens, rules, lexiconSize) {
    const terminals = [];
    const stack = [];
    const depths = [];
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
        const id = stack.pop();
        const depth = depths.pop();
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
  function expandToWords(token, container) {
    const { terminals } = expand([token], container.rules, container.lexicon.length);
    return terminals.map((t) => container.lexicon[t]);
  }
  var MODE_LITERAL = 0;
  var MODE_SUFFIX = 1;
  var MODE_BOTH = 2;
  var MODE_CHAIN = 3;
  var CHAIN_MORE = 128;
  var MAX_CHAINABLE_CODE = 127;
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
    let total = 0;
    for (const entry of plan.entries) total += entry.bytes;
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
  var MAGIC = [82, 80, 82, 49];
  var FORMAT_VERSION = 4;
  var HEADER_BYTES = 15;
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
    constructor(data) {
      __publicField(this, "data", data);
      __publicField(this, "offset", 0);
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
  function plainLexiconBytes(lexicon) {
    let total = 0;
    for (const word of lexicon) {
      const len = ENCODER.encode(word).length;
      total += len + varintSize(len);
    }
    return total;
  }
  function measure(container, entries) {
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
      total: HEADER_BYTES + suffixTable + lexicon + escapeTable + rules + stream
    };
  }
  function serialize(container) {
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
    for (const entry of planLexiconEntries(container.lexicon, container.suffixes)) {
      w.varint(entry.shared);
      if (entry.codes.length > 1) {
        w.varint(entry.codes[0] << 2 | MODE_CHAIN);
        for (let i = 1; i < entry.codes.length; i++) {
          w.u8(entry.codes[i] | (i < entry.codes.length - 1 ? CHAIN_MORE : 0));
        }
      } else if (entry.codes.length === 1 && entry.literal.length === 0) {
        w.varint(entry.codes[0] << 2 | MODE_SUFFIX);
      } else if (entry.codes.length === 1) {
        w.varint(entry.literal.length << 2 | MODE_BOTH);
        w.raw(entry.literal);
        w.u8(entry.codes[0]);
      } else {
        w.varint(entry.literal.length << 2 | MODE_LITERAL);
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
  function deserialize(bytes) {
    const r = new ByteReader(bytes);
    for (const expected of MAGIC) {
      if (r.u8() !== expected) throw new CodecError("not an RPR1 container");
    }
    const version = r.u8();
    if (version !== FORMAT_VERSION) {
      throw new CodecError(
        version < FORMAT_VERSION ? `version ${version} stored the lexicon differently; re-encode to read it` : `unsupported version ${version}`
      );
    }
    const threshold = r.u8();
    const lexiconSize = r.u16();
    const ruleCount = r.u16();
    const streamLength = r.u32();
    const decoder = new TextDecoder();
    const suffixCount = r.u8();
    const suffixBytes = [];
    const suffixes = [];
    for (let i = 0; i < suffixCount; i++) {
      const bytes2 = r.raw(r.varint());
      suffixBytes.push(bytes2);
      suffixes.push(decoder.decode(bytes2));
    }
    const lexicon = [];
    let previous = EMPTY;
    for (let i = 0; i < lexiconSize; i++) {
      const shared = r.varint();
      if (shared > previous.length) {
        throw new CodecError(`lexicon entry ${i} shares ${shared} bytes with a ${previous.length}-byte entry`);
      }
      const tag = r.varint();
      const mode = tag & 3;
      const n = tag >>> 2;
      const ending = (code) => {
        if (code >= suffixBytes.length) throw new CodecError(`lexicon entry ${i} uses undefined suffix code ${code}`);
        return suffixBytes[code];
      };
      let literal = EMPTY;
      let endings = [];
      if (mode === MODE_LITERAL) {
        literal = r.raw(n);
      } else if (mode === MODE_SUFFIX) {
        endings = [ending(n)];
      } else if (mode === MODE_BOTH) {
        literal = r.raw(n);
        endings = [ending(r.u8())];
      } else {
        endings = [ending(n)];
        for (; ; ) {
          const code = r.u8();
          endings.push(ending(code & ~CHAIN_MORE));
          if ((code & CHAIN_MORE) === 0) break;
        }
      }
      let length = shared + literal.length;
      for (const end of endings) length += end.length;
      const bytes2 = new Uint8Array(length);
      bytes2.set(previous.subarray(0, shared));
      bytes2.set(literal, shared);
      let at = shared + literal.length;
      for (const end of endings) {
        bytes2.set(end, at);
        at += end.length;
      }
      lexicon.push(decoder.decode(bytes2));
      previous = bytes2;
    }
    const escapeTable = [];
    for (let i = 0; i < threshold; i++) escapeTable.push(r.u16());
    const rules = [];
    for (let i = 0; i < ruleCount; i++) rules.push([r.u16(), r.u16()]);
    return { threshold, suffixes, lexicon, escapeTable, rules, stream: r.raw(streamLength) };
  }
  function maxTokenIdFor(threshold) {
    return (256 - threshold) * 256 - 1;
  }
  function encode(text, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    if (cfg.singleByteCount < 0) {
      throw new CodecError("byte budgets cannot be negative");
    }
    if (cfg.singleByteCount > 255) {
      throw new CodecError(`${cfg.singleByteCount} single-byte codes leaves no room for two-byte tokens`);
    }
    const tokens = tokenize(text);
    const { lexicon, ids } = buildLexicon(tokens);
    const ceiling = maxTokenIdFor(cfg.singleByteCount);
    if (lexicon.length > ceiling + 1) {
      throw new CodecError(
        `${lexicon.length} distinct tokens exceeds the ${ceiling + 1} addressable ids with ${cfg.singleByteCount} reserved byte codes`
      );
    }
    const { sequence, rules } = repair(ids, {
      minPairCount: cfg.minPairCount,
      maxPairs: cfg.maxPairs,
      maxTokenId: ceiling,
      firstRuleId: lexicon.length
    });
    const escapeTable = assignSingleBytes(sequence, cfg.singleByteCount);
    const threshold = escapeTable.length;
    const { stream, singleByteTokens, twoByteTokens } = emitStream(sequence, escapeTable, threshold);
    const suffixes = planLexiconSuffixes(lexicon, { maxSuffixLength: cfg.maxSuffixLength });
    const container = { threshold, suffixes, lexicon, escapeTable, rules, stream };
    const lexiconEntries = planLexiconEntries(lexicon, suffixes);
    const bytes = serialize(container);
    const sizes = measure(container, lexiconEntries);
    const originalBytes = ENCODER.encode(text).length;
    const { maxDepth, maxWidth } = expand(sequence, rules, lexicon.length);
    let frontCodedOnly = 0;
    for (const entry of planLexiconEntries(lexicon, [])) frontCodedOnly += entry.bytes;
    const codesUsed = /* @__PURE__ */ new Set();
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
        streamOnlyRatio: originalBytes === 0 ? 1 : sizes.stream / originalBytes
      }
    };
  }
  function decode(bytes) {
    const container = deserialize(bytes);
    const tokens = readStream(container.stream, container.escapeTable, container.threshold);
    const { terminals } = expand(tokens, container.rules, container.lexicon.length);
    return detokenize(terminals.map((id) => container.lexicon[id]));
  }
  function decodeContainer(container) {
    const tokens = readStream(container.stream, container.escapeTable, container.threshold);
    const { terminals } = expand(tokens, container.rules, container.lexicon.length);
    return detokenize(terminals.map((id) => container.lexicon[id]));
  }
  function sweepSingleByteCount(text, config = {}, range = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const tokens = tokenize(text);
    const { lexicon, ids } = buildLexicon(tokens);
    const { sequence, rules } = repair(ids, {
      minPairCount: cfg.minPairCount,
      maxPairs: cfg.maxPairs,
      maxTokenId: maxTokenIdFor(range.from ?? 0),
      firstRuleId: lexicon.length
    });
    const suffixes = planLexiconSuffixes(lexicon, { maxSuffixLength: cfg.maxSuffixLength });
    return sweepFromGrammar(lexicon, sequence, rules, { ...range, suffixes });
  }
  function sweepFromGrammar(lexicon, sequence, rules, options = {}) {
    const from = Math.max(0, options.from ?? 0);
    const step = options.step ?? 1;
    const to = Math.min(255, options.to ?? 255);
    const counts = /* @__PURE__ */ new Map();
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
      stream: new Uint8Array(0)
    }).total;
    const highestId = lexicon.length + rules.length - 1;
    const points = [];
    for (let n = from; n <= to; n += step) {
      const threshold = Math.min(n, sorted.length);
      const stream = 2 * sequence.length - prefix[threshold];
      points.push({
        n,
        threshold,
        stream,
        escapeTable: threshold * 2,
        total: base + threshold * 2 + stream,
        fits: highestId <= maxTokenIdFor(n)
      });
    }
    return { points, ruleCount: rules.length, sequenceLength: sequence.length, lexiconSize: lexicon.length };
  }
  return __toCommonJS(repair_codec_exports);
})();
