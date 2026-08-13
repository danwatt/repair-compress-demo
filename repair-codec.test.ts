import {
  encode,
  decode,
  tokenize,
  detokenize,
  expandToWords,
  sweepSingleByteCount,
  planSuffixes,
  applySuffixes,
  tokenize as tok,
  describeToken,
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
    for (const suffixCount of [0, 8, 20]) {
      const text = samples.genesis + samples.repetitive;
      const result = encode(text, { singleByteCount: n, minPairCount, suffixCount });
      check(
        `round trip N=${n} min=${minPairCount} suffix=${suffixCount}`,
        decode(result.bytes) === text,
        `threshold=${result.stats.threshold}`,
      );
    }
  }
}

// Suffix budgets must not overflow the byte space.
let threw = false;
try {
  encode(samples.genesis, { singleByteCount: 200, suffixCount: 100 });
} catch {
  threw = true;
}
check("rejects an impossible byte budget", threw);

// The splitter should find the obvious morphology and stay lossless.
const morph =
  "test tests tested testing walk walks walked walking talk talks talked talking " +
  "jump jumps jumped jumping work works worked working ".repeat(3);
const plan = planSuffixes(tok(morph), { count: 20 });
check("finds -ing / -ed / -s", ["ing", "ed", "s"].every((s) => plan.suffixes.includes(s)), plan.suffixes.join(","));
check("suffix split round trips", detokenize(applySuffixes(tok(morph), plan.mapping)) === morph);
check("marker renders readably", describeToken("\u0000ing") === "-ing");

for (const [name, text] of Object.entries(samples)) {
  const withSuffix = encode(text, { suffixCount: 20 });
  const without = encode(text, { suffixCount: 0 });
  check(`suffix round trip: ${name}`, decode(withSuffix.bytes) === text);
  if (text.length > 200) {
    console.log(
      `     ${name}: suffixes ${withSuffix.stats.suffixes.slice(0, 6).join(" ") || "none"} · ` +
        `${withSuffix.stats.wordsFolded} words folded · ` +
        `${without.stats.sizes.total} -> ${withSuffix.stats.sizes.total} bytes`,
    );
  }
}

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
