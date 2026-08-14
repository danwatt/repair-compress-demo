// Pre-encode kjv-data.js with the demo defaults so the browser can decode the
// corpus at startup instead of spending several seconds rebuilding its grammar.
import fs from "node:fs";
import { decode, encode } from "./repair-codec";
import { planSuffixes } from "./link-codec";

const source = fs.readFileSync("kjv-data.js", "utf8").trim();
const prefix = "window.KJV_TEXT = ";
if (!source.startsWith(prefix) || !source.endsWith(";")) {
  throw new Error("kjv-data.js does not have the expected window.KJV_TEXT assignment");
}

const text = JSON.parse(source.slice(prefix.length, -1)) as string;
const config = { singleByteCount: 0x55, minPairCount: 3, maxPairs: 65535 };
const started = performance.now();
const result = encode(text, config);
if (decode(result.bytes) !== text) throw new Error("pre-encoded KJV failed its round trip");
const artifact = {
  config,
  bytes: Buffer.from(result.bytes).toString("base64"),
  stats: result.stats,
};

fs.writeFileSync(
  "kjv-preencoded.js",
  `window.KJV_PREENCODED = ${JSON.stringify(artifact)};\n`,
);

// The YLK1 demo encodes live rather than shipping an artifact — it is fast
// enough — except for the lexicon's ending table, whose exhaustive search runs
// several seconds cold in a browser. It depends only on the corpus, so plan it
// here and let the page start from it.
const suffixStarted = performance.now();
const suffixes = planSuffixes(text);
fs.writeFileSync("kjv-suffixes.js", `window.KJV_SUFFIXES = ${JSON.stringify(suffixes)};\n`);
console.log(
  `${suffixes.length} lexicon endings in ${Math.round(performance.now() - suffixStarted)} ms -> kjv-suffixes.js`,
);
console.log(
  `${result.stats.originalBytes} input bytes -> ${result.bytes.length} RPR1 bytes ` +
  `in ${Math.round(performance.now() - started)} ms -> kjv-preencoded.js`,
);
