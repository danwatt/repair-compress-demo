import {
  encode,
  decode,
  tokenize,
  detokenize,
  expandToWords,
  sweepSingleByteCount,
  planLexiconSuffixes,
  planLexiconEntries,
  tokenize as tok,
  describeToken,
  buildLexicon,
  serialize,
  deserialize,
  measure,
  plainLexiconBytes,
  CodecError,
} from "./repair-codec";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const samples: Record<string, string> = {
  empty: "",
  one: "word",
  punct: "Don't stop, he said---\"really!\"  (ok?)\n\nNew paragraph\tafter a tab. ",
  leading: "   leading and trailing   ",
  unicode: "café naïve — em dash, “curly quotes”, emoji 🎵 twice 🎵",
  repetitive: "and begat sons and daughters: ".repeat(40),
  genesis: `In the beginning God created the heaven and the earth. And the earth was without form, and void; and darkness was upon the face of the deep. And the Spirit of God moved upon the face of the waters. And God said, Let there be light: and there was light. And God saw the light, that it was good: and God divided the light from the darkness. And God called the light Day, and the darkness he called Night. And the evening and the morning were the first day.`,
};

for (const [name, text] of Object.entries(samples)) {
  check(`tokenize round trip: ${name}`, detokenize(tokenize(text)) === text);
  const result = encode(text);
  const back = decode(result.bytes);
  check(
    `codec round trip: ${name}`,
    back === text,
    back === text ? "" : `\n  want ${JSON.stringify(text.slice(0, 80))}\n  got  ${JSON.stringify(back.slice(0, 80))}`,
  );
}

// Closing punctuation always sits flush against the previous token: a space
// before it is not preserved, whether or not one was actually there.
for (const input of ["hello, world", "hello , world"]) {
  check(`punctuation normalizes: ${JSON.stringify(input)}`, detokenize(tok(input)) === "hello, world", detokenize(tok(input)));
}
// A missing space after the mark is a real, rare deviation and still round-trips exactly.
check("no space after punctuation still round trips", detokenize(tok("hello,world")) === "hello,world");
// Structure markers are flush on both sides: no glue token needed either
// direction, and no lexicon entry for the glue token at all in text built
// entirely from touching markers.
check("marker touching both sides", detokenize(tok("sins.$%Now")) === "sins.$%Now");
check("marker glue-free", !tok("sins.$%Now").includes(""));
// A real space around a marker is not preserved either (flush, not "attached").
check("marker spacing normalized", detokenize(tok("a % b")) === "a%b");

// Vary the knobs.
for (const n of [0, 1, 16, 85, 128, 200, 235]) {
  for (const minPairCount of [2, 3, 5]) {
    for (const maxSuffixLength of [1, 4, 8]) {
      const text = samples.genesis + samples.repetitive;
      const result = encode(text, { singleByteCount: n, minPairCount, maxSuffixLength });
      check(
        `round trip N=${n} min=${minPairCount} suffixLen=${maxSuffixLength}`,
        decode(result.bytes) === text,
        `threshold=${result.stats.threshold}`,
      );
    }
  }
}

// Byte budgets must stay inside a byte.
let threw = false;
try {
  encode(samples.genesis, { singleByteCount: 300 });
} catch {
  threw = true;
}
check("rejects an impossible byte budget", threw);

// The suffix table should find the obvious morphology.
const morph =
  "test tests tested testing walk walks walked walking talk talks talked talking " +
  "jump jumps jumped jumping work works worked working ".repeat(3);
const morphLexicon = buildLexicon(tok(morph)).lexicon;
const morphSuffixes = planLexiconSuffixes(morphLexicon);
check("finds -ing / -ed / -s", ["ing", "ed", "s"].every((s) => morphSuffixes.includes(s)), morphSuffixes.join(","));
check("glue token renders readably", describeToken("") === "␀");

// Suffix codes are a lexicon device. The same grammar stored without the table
// must give byte-for-byte the same stream, and must never come out smaller.
for (const [name, text] of Object.entries(samples)) {
  const withSuffix = encode(text);
  const bare = { ...withSuffix.container, suffixes: [] };
  const without = measure(bare);
  check(`suffix round trip: ${name}`, decode(withSuffix.bytes) === text);
  check(`suffix-free round trip: ${name}`, decode(serialize(bare)) === text);
  check(
    `suffix table leaves the stream alone: ${name}`,
    withSuffix.stats.sizes.stream === without.stream,
    `${without.stream} vs ${withSuffix.stats.sizes.stream}`,
  );
  check(
    `suffix table never costs bytes: ${name}`,
    withSuffix.stats.sizes.total <= without.total,
    `${without.total} -> ${withSuffix.stats.sizes.total}`,
  );
  if (text.length > 200) {
    console.log(
      `     ${name}: suffixes ${withSuffix.stats.suffixes.slice(0, 6).join(" ") || "none"} · ` +
        `${withSuffix.stats.entriesSuffixed} entries coded · ` +
        `${without.total} -> ${withSuffix.stats.sizes.total} bytes`,
    );
  }
}

// All three storage modes have to survive the round trip, including
// literal-plus-code, where an ending is coded onto bytes that are spelled out.
const modeSample = "testing tested tester zooming boomed loomed gnarling flying";
const modeResult = encode(modeSample);
const modeEntries = planLexiconEntries(modeResult.container.lexicon, modeResult.container.suffixes);
check(
  "planLexiconEntries sizes match what serialize writes",
  modeEntries.reduce((n, e) => n + e.bytes, 0) === modeResult.stats.sizes.lexicon,
);
check(
  "every storage mode gets exercised",
  modeEntries.some((e) => e.suffix < 0) &&
    modeEntries.some((e) => e.suffix >= 0 && e.literal.length === 0) &&
    modeEntries.some((e) => e.suffix >= 0 && e.literal.length > 0),
  modeEntries.map((e) => `${e.shared}/${e.literal.length}/${e.suffix}`).join(" "),
);
check("mixed-mode round trip", decode(modeResult.bytes) === modeSample);

// Front coding: the lexicon must be in UTF-8 byte order, since an id is a
// position in that list and each entry is a delta against the one before it.
const utf8 = (s: string) => new TextEncoder().encode(s);
const byteOrder = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
const stemmy = "begat beget begets begetting begotten beginning begin " +
  "café cafés caffeine 🎵 🎶 zebra".repeat(2);
const { lexicon: sortedLexicon } = buildLexicon(tok(stemmy));
check(
  "lexicon is in byte order",
  sortedLexicon.every((w, i) => i === 0 || byteOrder(utf8(sortedLexicon[i - 1]), utf8(w)) < 0),
  sortedLexicon.map((w) => JSON.stringify(w)).join(" "),
);

// Shared stems have to actually pay: the KJV-ish sample above is the case for it.
const stemResult = encode(stemmy);
check(
  "front coding shrinks a stem-heavy lexicon",
  stemResult.stats.sizes.lexicon < stemResult.stats.lexiconPlainBytes,
  `${stemResult.stats.lexiconPlainBytes} -> ${stemResult.stats.sizes.lexicon}`,
);
check("stem-heavy round trip", decode(stemResult.bytes) === stemmy);

// A prefix boundary can fall inside a multi-byte character ("café"/"cafés" share
// four bytes of a five-byte string). Reassembly is in byte space, so that is fine.
check(
  "multi-byte prefixes round trip",
  decode(encode("café cafés naïve naïveté 🎵 🎵🎶").bytes) === "café cafés naïve naïveté 🎵 🎵🎶",
);

// Container-level checks: the serializer is the only thing that front-codes, so
// deserialize has to rebuild the exact strings, and a v1 file must be rejected.
const roundTrippedLexicon = deserialize(serialize(stemResult.container)).lexicon;
check(
  "deserialize rebuilds every entry",
  roundTrippedLexicon.length === sortedLexicon.length &&
    roundTrippedLexicon.every((w, i) => w === stemResult.container.lexicon[i]),
);
const older = Uint8Array.from(stemResult.bytes);
older[4] = 2;
let rejected = "";
try {
  deserialize(older);
} catch (e) {
  rejected = e instanceof CodecError ? e.message : "wrong error type";
}
check("rejects an older container", rejected.includes("re-encode"), rejected);
check("plainLexiconBytes measures the old format", plainLexiconBytes(["ab", "cd"]) === 6);

// A big synthetic corpus: repeated structure, the case Re-Pair is built for.
const words = ["and", "the", "of", "God", "said", "unto", "him", "shall", "be", "a", "man"];
let corpus = "";
for (let i = 0; i < 4000; i++) {
  corpus += `${words[i % words.length]} ${words[(i * 7) % words.length]} ${words[(i * 3) % words.length]}, `;
  if (i % 12 === 0) corpus += "\n";
}
const t0 = Date.now();
const big = encode(corpus);
const elapsed = Date.now() - t0;
check("round trip: synthetic corpus", decode(big.bytes) === corpus);
console.log(
  `\ncorpus: ${big.stats.originalBytes} bytes -> ${big.stats.sizes.total} bytes ` +
    `(${(big.stats.ratio * 100).toFixed(1)}%), ${big.stats.tokenCount} tokens -> ` +
    `${big.stats.sequenceLength} symbols, ${big.stats.ruleCount} rules, ` +
    `depth ${big.stats.maxExpansionDepth}, stack ${big.stats.maxExpansionWidth}, ${elapsed} ms`,
);
console.log("sizes:", JSON.stringify(big.stats.sizes));

const hottest = big.container.escapeTable[0];
const hottestWords = expandToWords(hottest, big.container);
console.log(`hottest single-byte code covers ${hottestWords.length} words: ${JSON.stringify(hottestWords.slice(0, 12).join(" "))}…`);

const sweep = sweepSingleByteCount(corpus).points;
const best = sweep.filter((s) => s.fits).sort((a, b) => a.total - b.total)[0];
console.log(`best N over sweep: ${best.n} at ${best.total} bytes (N=85 gives ${sweep[85].total})`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
