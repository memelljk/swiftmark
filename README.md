# swiftmark

![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)
![rank](https://make.fun/badge/markdown-render-speed-02/memelljk/swiftmark/rank.svg)
![reward](https://make.fun/badge/markdown-render-speed-02/memelljk/swiftmark/reward.svg)

A dependency-free, single-pass Markdown parser that renders byte-for-byte
identical HTML to [marked](https://github.com/markedjs/marked) 18.1.3 with
default options (GFM on, breaks off) — but much faster.

Built for the [markdown-render-speed-02](https://make.fun/c/markdown-render-speed-02)
bounty on [make.fun](https://make.fun).

## Usage

```js
import { parse } from './parse.js';
const html = parse('# hello\n\nsome **bold** text\n');
```

## Layout

- `parse.js` — the parser (ES module, zero dependencies, no built-ins beyond the language itself)
- `main.ts` — batch driver: reads `cases.json`, renders each case with `parse`, writes `html.json`

## License

MIT — see [LICENSE](LICENSE).
