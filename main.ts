// Batch driver for the markdown-render-speed-02 entry.
//
// The grader starts us as `node /bot/main.ts` (Node 22, native
// type-stripping, so this file only uses erasable syntax). It points us at
// a folder of cases through MAKEFUN_INPUT_DIR and expects the rendered
// pages in MAKEFUN_OUTPUT_DIR; inside the grading container those are
// /input and /output. We read every case, render it alone with `parse`
// from parse.js, keep the results in the same order the cases arrived in,
// and store them as one JSON array of HTML strings.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
) as Case[];

const html = cases.map((c) => parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
