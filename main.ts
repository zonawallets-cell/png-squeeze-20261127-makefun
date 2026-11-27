// A valid entry that compresses nothing: it copies each screenshot's stored PNG (/input/<id>/image.png) to
// /output/<id>/image.png. The copy is exact and in the stated format, and at the stored size it earns no points. The
// kit's scorer/checker/png.mjs is the decoder your PNG is read with (its header lists what it accepts) and holds a
// stored-PNG writer and the five PNG filters to start from. Local run on the practice set:
//   mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node starter/main.ts
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  mkdirSync(join(O, id), { recursive: true });
  copyFileSync(join(I, id, 'image.png'), join(O, id, 'image.png'));
}
