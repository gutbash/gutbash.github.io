// Subsets fonts to printable ASCII and writes them to src/.
// Rerun with `pnpm font` after upgrading a font package or widening CHARS.
import { readFile, writeFile } from 'node:fs/promises';
import subsetFont from 'subset-font';

// [source under node_modules, extra subset options]
const FONTS = {
  // Variable; the page uses 400 and 600, so the weight axis is cut to that range.
  geist: ['geist/dist/fonts/geist-sans/Geist-Variable.woff2', { variationAxes: { wght: { min: 400, max: 600 } } }],
};
const CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');

for (const [name, [path, options]] of Object.entries(FONTS)) {
  const input = await readFile(new URL(`../node_modules/${path}`, import.meta.url));
  const output = await subsetFont(input, CHARS, { targetFormat: 'woff2', ...options });
  await writeFile(new URL(`../src/${name}.woff2`, import.meta.url), output);
  console.log(`${name}.woff2: ${input.length} -> ${output.length} bytes`);
}
