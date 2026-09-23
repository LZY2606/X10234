import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCasePack } from "../src/data/pack-builder.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pack = buildCasePack();
const outDir = resolve(root, "src/data/casepack");
mkdirSync(outDir, { recursive: true });
mkdirSync(resolve(outDir, "fragments"), { recursive: true });

let totalBytes = 0;
for (const f of pack.manifest.fragmentFiles) {
  const bytes = pack.fragmentBinaries[f.hash];
  writeFileSync(resolve(outDir, f.file), bytes);
  totalBytes += bytes.length;
}
const { fragmentBinaries: _drop, ...jsonPack } = pack;
void _drop;
writeFileSync(resolve(outDir, "pack.json"), JSON.stringify(jsonPack, null, 2));
console.log(`casepack generated: ${pack.manifest.fragmentFiles.length} fragments, ${(totalBytes / 1024).toFixed(1)} KiB`);
