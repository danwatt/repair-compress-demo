# RPR1 — a generic Re-Pair word codec

A TypeScript rebuild of the text compression scheme used by the 1993 Game Boy KJV, generalized so
the reserved single-byte range is a tunable knob.

Source: [Decoding text compression on a Game Boy](https://www.danwatt.org/2024/10/decoding-text-compression-on-a-gameboy/)

## Files

| File | What it is |
| --- | --- |
| `repair-codec.ts` | The library. No dependencies, no DOM, works in Node and the browser. |
| `repair-codec.test.ts` | Round-trip tests across the config space, plus a timing run. |
| `demo.html` | Self-contained lab page — paste text, move N, see every byte accounted for. Open it directly, no server needed. |
| `kjv.csv` | Full King James Bible, one verse per row (`book_name,book_number,chapter_number,verse_number,verse_text`). |
| `kjv-data.js` | `kjv.csv` flattened into one marker-annotated string (`%` book start, `$` book end, `#` chapter end, `@` verse end — no newlines, no chapter/verse numbers) and assigned to `window.KJV_TEXT`. Lazy-loaded by demo.html's "Load full KJV" button. |
| `build-kjv-data.js` | Regenerates `kjv-data.js` from `kjv.csv`. Run with `node build-kjv-data.js`. |

## Pipeline

Each stage is a pure exported function, so you can stop anywhere and look at the intermediate.

```
encode(text)
  tokenize          text        -> string[]        words, punctuation, separators
  planSuffixes      string[]    -> suffix plan     which suffixes earn a byte code
  applySuffixes     string[]    -> string[]        "testing" -> "test" + -ing marker
  buildLexicon      string[]    -> lexicon, ids    terminals in UTF-8 byte order
  repair            ids         -> sequence, rules fold frequent adjacent pairs
  pinSuffixCodes    sequence    -> pinned ids      suffix markers claim their codes
  assignSingleBytes sequence    -> escapeTable     top-N remaining symbols get one
  emitStream        sequence    -> Uint8Array      1 byte if < N, else 2
  serialize         container   -> Uint8Array      header + front-coded lexicon + tables + stream

decode(bytes)
  deserialize -> readStream -> expand -> detokenize
```

## The N trade-off

A lead byte below `N` indexes the escape table; otherwise a second byte follows and the token is
`((lead - N) << 8) | second`. So the largest addressable id is `(256 - N) * 256 - 1`: every reserved
byte buys one-byte codes at the cost of 256 addresses in the two-byte space, and each escape entry
costs 2 bytes in the table while saving 1 byte per occurrence.

`sweepSingleByteCount(text)` returns the exact total for every N from one Re-Pair run. It does not
re-encode 256 times — with symbol counts sorted descending, the stream is
`2 * symbols - (occurrences the escape table covers)`, so a prefix sum gives all 256 answers at once.
Points where the grammar would no longer fit the shrinking id space come back with `fits: false`.

## Suffixes

`suffixCount` (S) reserves byte codes for suffix markers, as the cartridge did with roughly 20 of
them: "testing" is stored as the token for "test" followed by an -ing code, so the lexicon carries
one entry instead of two.

Candidate suffixes are found in the text rather than hardcoded, scored by what they actually save,
and taken only when the arithmetic works: dropping a word's lexicon entry saves whatever front
coding was charging for it, while the marker costs one byte at every occurrence. So splitting rare
long words wins and splitting common ones loses — the feature works on the tail of the vocabulary,
not the head. The stem must already exist as a standalone token, so this never invents words a
concatenating decoder could not produce.

Front coding and suffix splitting attack the same redundancy, so the scoring has to account for it.
`lexiconRemovalGains` charges each entry what it costs *in place*: "begetting" sits right next to
"beget" in sorted order and already shares five bytes with it, so folding it away frees far less
than its length suggests, and the estimate subtracts what the following entry loses when its
neighbour disappears. With the old flat cost model the planner over-valued every split and took
roughly 40% more of them than paid off.

Markers are ordinary terminals, which means Re-Pair can fold a stem-plus-suffix pair into a single
rule where that is cheaper, and a marker swallowed entirely by rules does not consume a byte code.

**Nothing about the container format changes.** A suffix code is just an escape-table entry pointing
at a marker terminal, and the decoder concatenates during detokenization. Files written without
suffixes and files written with them are the same format.

On the full KJV (`kjv-data.js`, 4,137,743 bytes, N=85) the effect looks like this, and the shape of
it is the interesting part:

| S | total | lexicon | words folded | suffixes chosen |
| --- | --- | --- | --- | --- |
| 0 | 984,829 | 65,942 | 0 | — |
| 5 | 982,287 | 61,341 | 1,212 | ing s eth ed 's |
| 10 | 981,629 | 59,173 | 1,693 | + est ness st ites th |
| 20 | 983,026 | 57,804 | 2,067 | + ly d er ers edst … |
| 80 | 1,008,853 | 56,194 | 2,515 | no more ever earn a code |

Most of the win arrives in the first five suffixes and it is flat by ten. Past that the lexicon
still shrinks but the total climbs: every reserved code is 256 addresses out of the two-byte space,
and at S=80 the grammar loses so much room that the stream and rules give back more than the
lexicon saves. Before front coding the sweet spot sat nearer twenty, roughly where the cartridge
stopped — front coding has already collected part of what suffix splitting used to be paid for.

## Deviations from the cartridge

- **Tokenizer.** Runs of whitespace that are not a single space become explicit tokens, and an empty
  token means "these two touch". Round-trips arbitrary text exactly, including newlines and Unicode
  — with two intentional exceptions, both matching the English-grammar assumption the ROM made (it
  only ever had to reproduce the KJV, which formats punctuation and structure consistently):
  closing punctuation (`,.;:!?`) always sits flush against whatever precedes it — a source space
  before one of these marks is not preserved, though a space after it still round-trips exactly —
  and the structure markers `%$#@{}` (see `build-kjv-data.js`) are always flush on *both* sides, no
  assumed space either direction.
- **Escape table.** Suffix codes are pinned first; the rest is filled purely by frequency. The
  original biased toward stop words, plausibly so the search code could skip them cheaply.
- **Suffix rules.** Derived from the corpus by measured savings. The ROM implemented its suffixes in
  code rather than as a table, so its set was fixed at build time and the same for every text.
- **Structure markers.** `%` `$` `#` `@` `{` `}` were reserved terminals for book/chapter/verse
  boundaries. Nothing here reserves them; they are ordinary tokens if they appear — which is how
  `kjv-data.js` uses `%` `$` `#` `@` to mark book/chapter/verse boundaries in place of newlines and
  verse numbers (see `build-kjv-data.js`). `{` `}` (subheadings, e.g. Psalm titles) go unused: this
  `kjv.csv` has no subheading rows to place them around.
- **No memory banking.** Ids are flat, with no 32 KB blocks or `0x0150` headers to skip.

## Rebuilding demo.html

`demo.html` is `src/demo.html` with the compiled codec inlined at the `/*__CODEC__*/` marker.

```sh
npm i -D esbuild
npx esbuild repair-codec.ts --bundle --format=iife --global-name=RePair --target=es2020 \
  --outfile=repair-codec.iife.js
node -e "const fs=require('fs');fs.writeFileSync('demo.html',
  fs.readFileSync('demo-template.html','utf8').replace('/*__CODEC__*/',
  fs.readFileSync('repair-codec.iife.js','utf8')))"
```

Tests:

```sh
npx esbuild repair-codec.test.ts --bundle --platform=node --format=cjs --outfile=test.cjs && node test.cjs
```

## Ideas worth trying

- Score rules by actual savings (`(occurrences - 1) * cost - 4`) instead of raw frequency, and drop
  rules whose occurrences got eaten by overlap.
- Let `minPairCount` fall to 2 once the id space is nearly full — the last rules are the cheap ones.
- Allow suffix stems that do not appear standalone, paying for the new lexicon entry once. "waters"
  without "water" is currently left alone.
- Prefixes, and suffix chains ("-ing" then "-s"), both of which fit the same marker mechanism.
- Reserve a second escape range for 3-byte tokens to see whether a bigger grammar pays for itself.

## Benchmarks

Full KJV, 4,137,743 bytes in, 85 single-byte codes, 20 suffix codes.

1. V1: No lexicon encoding — **1,012,726 total**: 84,047 lexicon, 111,108 rules, 210 escape, 817,347 stream, 14 header
2. Front-encode lexicon — **983,026 total**: 57,804 lexicon, 107,700 rules, 210 escape, 817,298 stream, 14 header
3. Suffix codes are mostly a lexicon lever, but not only: each marker is a stream byte at every
   occurrence, and each reserved code costs 256 addresses of two-byte id space, which squeezes the
   grammar at high S. Front coding shifts the best S from ~20 down to ~10 (981,629 total).... next pass