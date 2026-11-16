// Entry point for the grading harness.
//
// The harness starts this file with `node /bot/main.ts` on Node 22,
// whose native type stripping means only erasable TypeScript syntax
// may appear here. The cases arrive as JSON in the input directory
// (MAKEFUN_INPUT_DIR, or /input inside the grading container) and the
// rendered HTML must land as one JSON array in the output directory
// (MAKEFUN_OUTPUT_DIR, or /output). Each case is rendered on its own
// with parse() from ./parse.js, in the order the cases were given.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface InputCase {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as InputCase[];

const htmlPages: string[] = new Array(cases.length);
for (let k = 0; k < cases.length; k++) {
  htmlPages[k] = parse(cases[k].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(htmlPages));
