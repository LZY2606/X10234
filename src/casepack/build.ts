/**
 * 离线案例包构建：npm run build:pack
 * 产物全部进仓库 data/casepack（领域材料，非通用表格）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex, stableId } from "../core/hashing.ts";
import { generateSeries, type GeneratedSeries } from "./series.ts";
import {
  MINIMAL_SCENARIOS,
  COMBINED_SPEC,
  type ScenarioDef,
} from "./scenarios.ts";
import type { SourceEntity } from "../core/types.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const outDir = join(root, "data", "casepack");
const blobDir = join(outDir, "blobs");

mkdirSync(blobDir, { recursive: true });

interface PackedVariant {
  scenario: string;
  variant: "minimal" | "combined";
  seriesId: string;
  batchId: string;
  truth: { axisX: number; axisY: number; axisAngleDeg: number };
  frameIds: { frameId: string; ordinal: number; tiltDeg: number; blobSha256: string }[];
  entities: SourceEntity[];
}

function packVariant(scenario: string, variant: "minimal" | "combined", generated: GeneratedSeries): PackedVariant {
  const batchId = stableId("batch", scenario, variant, generated.seriesId);
  const blobHashes = new Set<string>();
  for (const f of generated.frames) {
    if (!blobHashes.has(f.blobSha256)) {
      writeFileSync(join(blobDir, `${f.blobSha256}.png`), f.bytes);
      blobHashes.add(f.blobSha256);
    }
  }
  return {
    scenario,
    variant,
    seriesId: generated.seriesId,
    batchId,
    truth: generated.truth,
    frameIds: generated.frames.map((f) => ({
      frameId: f.frameId,
      ordinal: f.ordinal,
      tiltDeg: f.tiltDeg,
      blobSha256: f.blobSha256,
    })),
    entities: generated.entities,
  };
}

const variants: PackedVariant[] = [];
for (const def of MINIMAL_SCENARIOS) {
  variants.push(packVariant(def.key, "minimal", generateSeries(def.minimal)));
}
variants.push(packVariant("combined", "combined", generateSeries(COMBINED_SPEC)));

// blob 去重统计：最小输入与组合输入共享的原始片段只存一份
const allBlobs = new Set(variants.flatMap((v) => v.frameIds.map((f) => f.blobSha256)));
const sharedBy = new Map<string, string[]>();
for (const v of variants) {
  for (const f of v.frameIds) {
    const list = sharedBy.get(f.blobSha256) ?? [];
    list.push(`${v.scenario}:${v.variant}`);
    sharedBy.set(f.blobSha256, list);
  }
}

const manifest = {
  pack: "tilt-frames-assembly-room",
  title: "倾转帧拼合室：电镜 tilt-series 轴线、fiducial 轨迹与配准分支",
  builtAt: new Date().toISOString(),
  scenarios: MINIMAL_SCENARIOS.map((d: ScenarioDef) => ({ key: d.key, title: d.title })),
  variants: variants.map((v) => ({
    scenario: v.scenario,
    variant: v.variant,
    seriesId: v.seriesId,
    batchId: v.batchId,
    truth: v.truth,
    frames: v.frameIds,
  })),
  blobSharing: [...sharedBy.entries()]
    .filter(([, users]) => users.length > 1)
    .map(([sha, users]) => ({ blobSha256: sha, sharedBy: users })),
  blobCount: allBlobs.size,
};

// 主叙事基线：组合包的来源版本（原始帧/倾角/像素尺度/剂量/标记/缺口/排除原因）
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
for (const v of variants) {
  writeFileSync(
    join(outDir, `${v.scenario}.${v.variant}.json`),
    JSON.stringify({ batchId: v.batchId, seriesId: v.seriesId, truth: v.truth, entities: v.entities }, null, 2),
  );
}

console.log(
  `casepack built: ${variants.length} variants, ${allBlobs.size} unique blobs ` +
    `(${manifest.blobSharing.length} shared across minimal/combined)`,
);
