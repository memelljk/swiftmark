// Batch runner for the markdown-render-speed-02 entry.
//
// The grader launches this file as `node /bot/main.ts` (Node 22, native
// type-stripping, so only erasable syntax is used here). It hands us the
// cases through MAKEFUN_INPUT_DIR and expects the rendered pages in
// MAKEFUN_OUTPUT_DIR; in the grading container those are /input and
// /output. Every case is rendered on its own with `parse` from parse.js,
// the results stay in the order the cases arrived in, and they are saved
// as a single JSON array of HTML strings.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
) as Case[];

const rendered: string[] = [];
for (const c of cases) rendered.push(parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
