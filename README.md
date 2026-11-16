# swiftmark

![make.fun competition](https://make.fun/badge/markdown-render-speed-02.svg)
![rank on make.fun](https://make.fun/badge/markdown-render-speed-02/memelljk/swiftmark/rank.svg)
![reward on make.fun](https://make.fun/badge/markdown-render-speed-02/memelljk/swiftmark/reward.svg)

swiftmark is a fast Markdown parser with no dependencies. It takes one
Markdown document and returns exactly the HTML that
[marked](https://github.com/markedjs/marked) 18.1.3 produces with its
default settings (GFM enabled, hard breaks off) — the same string, byte
for byte — while doing the work noticeably quicker than marked itself.

It was written for the
[markdown-render-speed-02](https://make.fun/c/markdown-render-speed-02)
competition on [make.fun](https://make.fun), where entries are graded on
producing identical output to marked across 720 cases and on CPU time.

## Trying it out

```js
import { parse } from './parse.js';

console.log(parse('# hello\n\nsome **bold** text\n'));
```

## What is in this repo

- `parse.js` — the parser. An ES module with zero dependencies; one
  `parse(markdown)` call returns the HTML string.
- `main.ts` — the batch runner the grader uses. It reads `cases.json`
  from the input folder, renders each case with `parse`, and writes the
  HTML strings as a JSON array to `html.json` in the output folder.
- `LICENSE` — the MIT license text for this code.

## License

MIT — see [LICENSE](LICENSE).
