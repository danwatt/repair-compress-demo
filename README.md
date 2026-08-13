# RPR1 — a generic Re-Pair word codec

![img.png](img.png)

RPR1 is a dependency-free TypeScript implementation of the text compression scheme used by the
1993 Game Boy KJV, generalized so the reserved single-byte range is configurable. It runs in Node
and the browser and includes an interactive demo for exploring how text is encoded.

For the codec pipeline, format design, algorithm trade-offs, experiments, and benchmarks, see
[DETAILS.md](DETAILS.md).

[ public demonstration is published to GitHub pages](https://danwatt.github.io/repair-compress-demo/demo.html).

Sources:
* [Decoding text compression on a Game Boy](https://www.danwatt.org/2024/10/decoding-text-compression-on-a-gameboy/)
* [Compressing a Word List on 1980's Hardware](https://www.danwatt.org/2023/11/compressing-a-word-list-on-1980s-hardware/)

## Project layout

| File                                            | What it is                                                          |
|-------------------------------------------------|---------------------------------------------------------------------|
| `repair-codec.ts`                               | The codec library.                                                  |
| `repair-codec.test.ts`                          | Round-trip tests across the configuration space, plus a timing run. |
| `demo.html`                                     | Interactive browser demo for inspecting encoded text byte by byte.  |
| `kjv.csv`                                       | Full King James Bible source data, one verse per row.               |
| `kjv-data.js` / `kjv-preencoded.js`             | Generated browser data used by the demo.                            |
| `build-kjv-data.js` / `build-kjv-preencoded.ts` | Scripts that regenerate the browser data.                           |
| `mise.toml`                                     | Pinned Node version and development tasks.                          |

## Development

Everything goes through [mise](https://mise.jdx.dev), which pins Node and manages the underlying
`npm` and `npx` commands. From the repository root:

```sh
mise run serve            # build, then serve the demo at http://localhost:8080
mise run test             # run round-trip tests and the timing run
mise run build            # bundle repair-codec.ts for the browser
mise run data             # regenerate browser data from kjv.csv
mise run clean            # remove generated build output
```

Run `mise tasks` to list all available tasks. After starting the server, open
<http://localhost:8080/demo.html>; browsers will not load the demo correctly over `file://`.

`demo.html` is hand-edited. After changing `repair-codec.ts`, run `mise run build` to regenerate
`repair-codec.js`. The build and data tasks use mise source/output tracking and skip unchanged work.
