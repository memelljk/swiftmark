# swiftmark

![make.fun competition](https://make.fun/badge/markdown-render-speed-02.svg)
![rank on make.fun](https://make.fun/badge/markdown-render-speed-02/memelljk/swiftmark/rank.svg)
![reward on make.fun](https://make.fun/badge/markdown-render-speed-02/memelljk/swiftmark/reward.svg)

swiftmark renders Markdown to exactly the HTML that
[marked](https://github.com/markedjs/marked) 18.1.3 produces with its
default options — GFM enabled, hard line breaks disabled — and it does
so faster than marked itself. The output is not merely similar: for
every input the two strings agree byte for byte, quirks of marked
included, which makes swiftmark a drop-in replacement wherever marked's
precise output is part of the contract.

The parser is a single dependency-free ES module written from scratch
for the
[markdown-render-speed-02](https://make.fun/c/markdown-render-speed-02)
competition on [make.fun](https://make.fun). Entries there are scored
on byte-identical output across 720 cases (the CommonMark and GFM spec
examples plus forty long generated documents) and then ranked by CPU
time.

## Usage

```js
import { parse } from './parse.js';

const html = parse('# hello\n\nsome *emphasis*');
```

`parse(markdown)` takes one document and returns its HTML string.
Calls are independent: no state is shared between them.

## Files

- `parse.js` — the whole parser: a block-level pass (headings, lists,
  tables, quotes, code, HTML blocks, link reference definitions) and an
  inline engine (emphasis delimiter stack, links, autolinks, code
  spans, raw HTML) that mirrors marked's behaviour.
- `main.ts` — the batch driver the grader runs: it reads `cases.json`
  from the input directory, renders each case with `parse`, and writes
  the results as one JSON array to `html.json` in the output directory.
- `LICENSE` — MIT.

## License

MIT — see [LICENSE](LICENSE).
