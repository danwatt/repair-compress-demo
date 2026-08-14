// Round-trip, search, and read-mode checks for link-codec.ts, then a
// head-to-head against repair-codec.ts on the full KJV.
//
//   npx esbuild link-codec.bench.ts --bundle --platform=node --format=cjs \
//     --outfile=/tmp/link-bench.cjs && node /tmp/link-bench.cjs
import fs from "node:fs";
import { encode as repairEncode, tokenize } from "./repair-codec";
import { decode, encode, open, read, search, type LinkConfig } from "./link-codec";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${label}${detail ? " - " + detail : ""}`);
  }
}

const describe = (c: LinkConfig): string =>
  `D=${c.directTermCount} ${c.coder}${c.split ? " split" : ""}${c.shortcutInterval ? " sc=" + c.shortcutInterval : ""}`;

// ---------------------------------------------------------------------------
// Correctness across the configuration space
// ---------------------------------------------------------------------------

const CONFIGS: LinkConfig[] = [];
for (const coder of ["varint", "huffman"] as const) {
  for (const directTermCount of [0, 8, 64, 254]) {
    for (const split of [false, true]) {
      for (const shortcutInterval of [0, 3, 1000]) {
        CONFIGS.push({ directTermCount, split, shortcutInterval, coder });
      }
    }
  }
}

const SAMPLES = [
  "the quick brown fox jumps over the lazy dog and the dog barks",
  "In the beginning God created the heaven and the earth.",
  "a a a a b a b a b b b a",
  "%And God said, Let there be light: and there was light.@And God saw the light, that it was good.$",
  "one",
  "x, y; z! q? r: s",
];

console.log("round trip, search, and read");
for (const sample of SAMPLES) {
  const terms = tokenize(sample);
  const expected = new Map<string, number[]>();
  terms.forEach((t, i) => {
    const list = expected.get(t);
    if (list) list.push(i);
    else expected.set(t, [i]);
  });

  for (const config of CONFIGS) {
    const label = `${describe(config)} ${JSON.stringify(sample.slice(0, 24))}`;
    const result = encode(sample, config);
    check(label, decode(result.bytes) === sample, "decode mismatch");

    const container = open(result.bytes);
    for (const word of container.lexicon) {
      const got = search(container, word).positions;
      const want = expected.get(word)!;
      check(label, JSON.stringify(got) === JSON.stringify(want), `search ${JSON.stringify(word)} ${got} != ${want}`);
    }
    check(label, search(container, "nosuchwordanywhere").positions.length === 0, "phantom search hit");

    const window = read(container, 0, Math.min(terms.length, 40));
    check(label, JSON.stringify(window.terms) === JSON.stringify(terms.slice(0, window.terms.length)), "read mismatch");
  }
}
console.log(failures === 0 ? `  ${CONFIGS.length} configs x ${SAMPLES.length} samples, all correct` : `  ${failures} failures`);

// ---------------------------------------------------------------------------
// Full KJV
// ---------------------------------------------------------------------------

const source = fs.readFileSync("kjv-data.js", "utf8").trim();
const prefix = "window.KJV_TEXT = ";
const text = JSON.parse(source.slice(prefix.length, -1)) as string;
const inputBytes = Buffer.byteLength(text, "utf8");
const terms = tokenize(text);

const pad = (s: string | number, w: number) => String(s).padStart(w);
const padEnd = (s: string, w: number) => s.padEnd(w);
const fmt = (n: number) => n.toLocaleString("en-US");

console.log(`\nfull KJV: ${fmt(inputBytes)} input bytes, ${fmt(terms.length)} terms\n`);

const repairStarted = performance.now();
const repair = repairEncode(text, { singleByteCount: 0x55, minPairCount: 3, maxPairs: 65535 });
const repairMs = Math.round(performance.now() - repairStarted);

console.log(
  padEnd("config", 26) + pad("total", 10) + pad("stream", 10) + pad("master", 9) +
  pad("lexicon", 9) + pad("direct", 8) + pad("first", 8) + pad("bits/term", 11) + pad("ms", 7),
);
console.log("-".repeat(98));

const SWEEP: LinkConfig[] = [];
for (const coder of ["varint", "huffman"] as const) {
  for (const directTermCount of [0, 64, 128, 254]) {
    SWEEP.push({ directTermCount, split: false, shortcutInterval: 0, coder });
  }
  SWEEP.push({ directTermCount: 128, split: true, shortcutInterval: 0, coder });
  SWEEP.push({ directTermCount: 254, split: true, shortcutInterval: 0, coder });
}

let best = { total: Infinity, config: SWEEP[0] };
for (const config of SWEEP) {
  const t0 = performance.now();
  const result = encode(text, config);
  const ms = Math.round(performance.now() - t0);
  const s = result.sizes;
  const bitsPerTerm = ((s.stream + s.master) * 8) / result.termCount;
  console.log(
    padEnd(describe(config), 26) + pad(fmt(s.total), 10) + pad(fmt(s.stream), 10) +
    pad(fmt(s.master), 9) + pad(fmt(s.lexicon), 9) + pad(fmt(s.directTable), 8) +
    pad(fmt(s.firstOccurrence), 8) + pad(bitsPerTerm.toFixed(2), 11) + pad(ms, 7),
  );
  if (s.total < best.total) best = { total: s.total, config };
}

console.log(
  "\n" + padEnd("RPR1 repair-codec", 26) + pad(fmt(repair.bytes.length), 10) +
  pad(fmt(repair.stats.sizes.stream), 10) + pad("-", 9) +
  pad(fmt(repair.stats.sizes.lexicon), 9) + pad("-", 8) + pad("-", 8) +
  pad(((repair.stats.sizes.stream * 8) / repair.stats.tokenCount).toFixed(2), 11) + pad(repairMs, 7),
);

const winner = encode(text, best.config);
const decodeStarted = performance.now();
check("kjv round trip", decode(winner.bytes) === text, "decode mismatch");
const decodeMs = Math.round(performance.now() - decodeStarted);
console.log(
  `\nbest link config: ${describe(best.config)} at ${fmt(winner.sizes.total)} bytes, ` +
  `${fmt(winner.lexicon.length)} searchable words, full decode in ${decodeMs} ms`,
);

// ---------------------------------------------------------------------------
// Search: the chain is the posting list
// ---------------------------------------------------------------------------

const container = open(winner.bytes);
const bruteForce = new Map<string, number[]>();
terms.forEach((t, i) => {
  const list = bruteForce.get(t);
  if (list) list.push(i);
  else bruteForce.set(t, [i]);
});

const probes = ["meek", "God", "LORD", "Jesus", "beginning", "Melchizedek", "peppers", "earth"];
console.log("\nsearch, with no auxiliary index");
for (const word of probes) {
  const t0 = performance.now();
  const { positions, hops } = search(container, word);
  const micros = Math.round((performance.now() - t0) * 1000);
  const want = bruteForce.get(word) ?? [];
  const ok = JSON.stringify(positions) === JSON.stringify(want);
  if (!ok) check("search " + word, false, `${positions.length} hits, expected ${want.length}`);
  console.log(
    `  ${padEnd(word, 14)}${pad(fmt(positions.length), 7)} hits ${pad(fmt(hops), 7)} hops ` +
    `${pad(micros, 6)} us  ${ok ? "ok" : "MISMATCH"}`,
  );
}

let searchFailures = 0;
for (const word of container.lexicon) {
  const got = search(container, word).positions;
  const want = bruteForce.get(word)!;
  if (got.length !== want.length || got[0] !== want[0] || got[got.length - 1] !== want[want.length - 1]) {
    searchFailures++;
  }
}
check("exhaustive search", searchFailures === 0, `${searchFailures} of ${container.lexicon.length} words wrong`);
console.log(`  all ${fmt(container.lexicon.length)} lexicon words verified against a brute-force concordance`);

// ---------------------------------------------------------------------------
// The claim under test
//
// RPR1 stores text and nothing else. To search it you need an inverted index,
// which is what the patent says the prior art paid for twice: "two substantial
// files which are essentially redundant". So price one, on the same word set,
// with the same coder the link stream uses: gap-coded posting lists, Huffman
// over the gap bit-widths, low bits raw, plus a varint occurrence count per
// word.
//
// The gaps in a posting list for a word are the same numbers as that word's
// chain deltas. That is the whole trick: the patent spends those bits once and
// reads them as both the text and the index.
// ---------------------------------------------------------------------------

function invertedIndexBytes(postings: number[][]): number {
  const bucketFrequency = new Array<number>(33).fill(0);
  let payloadBits = 0;
  let countBytes = 0;
  for (const list of postings) {
    let count = list.length;
    do {
      countBytes++;
      count >>>= 7;
    } while (count > 0);
    for (let i = 1; i < list.length; i++) {
      const gap = list[i] - list[i - 1];
      let width = 0;
      while (gap >>> width) width++;
      bucketFrequency[width]++;
      payloadBits += width - 1;
    }
  }
  // Shannon cost of the bucket symbols, which is what a Huffman code over them
  // reaches to within a fraction of a bit per symbol.
  const total = bucketFrequency.reduce((a, b) => a + b, 0);
  let bucketBits = 0;
  for (const f of bucketFrequency) if (f > 0) bucketBits += f * Math.log2(total / f);
  return Math.ceil((bucketBits + payloadBits) / 8) + countBytes;
}

const postings = container.lexicon.map((word) => bruteForce.get(word)!);
const indexBytes = invertedIndexBytes(postings);
const repairPlusIndex = repair.bytes.length + indexBytes;

console.log("\ntext plus search, both able to answer the same queries");
console.log(`  ${padEnd("RPR1 text", 30)}${pad(fmt(repair.bytes.length), 11)} bytes`);
console.log(`  ${padEnd("inverted index over it", 30)}${pad(fmt(indexBytes), 11)} bytes`);
console.log(`  ${padEnd("RPR1 + index", 30)}${pad(fmt(repairPlusIndex), 11)} bytes`);
console.log(`  ${padEnd("YLK1 link codec", 30)}${pad(fmt(winner.sizes.total), 11)} bytes` +
  `   ${((1 - winner.sizes.total / repairPlusIndex) * 100).toFixed(1)}% smaller`);

// ---------------------------------------------------------------------------
// Read mode: what the fourth type of linking signal is for
// ---------------------------------------------------------------------------

console.log("\nread mode: link hops to fill one 40-term screen, mean over 500 starts");
for (const shortcutInterval of [0, 1000, 100, 20]) {
  const config = { ...best.config, shortcutInterval };
  const built = encode(text, config);
  const c = open(built.bytes);
  let hops = 0;
  let worst = 0;
  for (let i = 0; i < 500; i++) {
    const start = Math.floor((i / 500) * (c.termCount - 40));
    const taken = read(c, start, 40).hops;
    hops += taken;
    worst = Math.max(worst, taken);
  }
  console.log(
    `  sc=${padEnd(String(shortcutInterval), 6)}${pad((hops / 500).toFixed(1), 10)} mean ${pad(fmt(worst), 9)} worst ` +
    `${pad(fmt(built.sizes.total), 10)} bytes  +${fmt(built.sizes.total - winner.sizes.total)}`,
  );
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
