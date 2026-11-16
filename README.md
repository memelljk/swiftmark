# swiftmark

![make.fun competition](https://make.fun/badge/markdown-render-speed-02.svg)
![rank on make.fun](https://make.fun/badge/markdown-render-speed-02/memelljk/swiftmark/rank.svg)
![reward on make.fun](https://make.fun/badge/markdown-render-speed-02/memelljk/swiftmark/reward.svg)

swiftmark is a small, dependency-free Markdown parser. Feed it one
Markdown document and it returns exactly the HTML that
[marked](https://github.com/markedjs/marked) 18.1.3 emits with its
default options (GFM on, hard breaks off) — the same string, byte for
byte — only noticeably faster than marked itself.

It was built for the
[markdown-render-speed-02](https://make.fun/c/markdown-render-speed-02)
competition on [make.fun](https://make.fun), where entries are graded on
byte-identical output across 720 cases and on CPU time.

## Quick start

```js
import { parse } from './parse.js';

console.log(parse('# hello'));
```

## Layout

- `parse.js` — the parser. A zero-dependency ES module; a single
  `parse(markdown)` call returns the HTML string.
- `main.ts` — the batch runner the grader uses. It loads `cases.json`
  from the input folder, renders every case with `parse`, and stores the
  HTML strings as one JSON array in `html.json` under the output folder.
- `LICENSE` — the MIT license text for this code.

## License

MIT — see [LICENSE](LICENSE).
