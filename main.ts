// swiftmark driver: reads the case list, renders each markdown document
// through ./parse.js one at a time, and writes the HTML strings back out
// in the same order. Paths come from MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// outside a container, and default to /input and /output inside one.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inDir, 'cases.json'), 'utf8');
const docs = JSON.parse(raw) as Array<{ id: string; markdown: string }>;

const rendered: string[] = new Array(docs.length);
for (let i = 0; i < docs.length; i++) {
  rendered[i] = parse(docs[i].markdown);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(rendered));
