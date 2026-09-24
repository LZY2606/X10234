/** 离线案例包读取（仓库内 cases/tilt-assembly-room）。 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CaseFile {
  schema: string;
  title: string;
  coordinateBasis: string;
  frameGeometry: { widthPx: number; heightPx: number };
  assumedImageCenter: { x: number; y: number };
  groundTruth: unknown;
  frames: {
    frameId: string; index: number; angle: number; file: string;
    sha256: string; byteLength: number;
  }[];
  tiltAngles: { angleId: string; frameId: string; raw: unknown; value: number; unit: string; signConvention: string }[];
  pixelScales: { scaleId: string; frameId: string | null; raw: unknown; value: number; unit: string }[];
  doses: {
    doseId: string; frameId: string; raw: unknown;
    electronsPerAngstrom2: { value: number; unit: string };
    cumulative: { value: number; unit: string };
  }[];
  observations: {
    observationId: string; frameId: string; observedTrackId: string;
    x: number; y: number; basis: string; uncertaintyPx: number; physicalTruth?: string;
  }[];
  trackGaps: { gapId: string; observedTrackId: string; missingFrameIds: string[]; reason: string; raw: unknown }[];
  manualExclusionReasons: { reasonId: string; frameId: string; reason: string; author: string; raw: unknown }[];
  scenarios: Record<string, unknown>;
  narrative: Record<string, string>;
}

export function loadCase(caseDir: string): { caseData: CaseFile; frameBytes: Map<string, Buffer> } {
  const manifestPath = join(caseDir, 'case.json');
  if (!existsSync(manifestPath)) throw new Error(`case package missing: ${manifestPath}`);
  const caseData = JSON.parse(readFileSync(manifestPath, 'utf8')) as CaseFile;
  const frameBytes = new Map<string, Buffer>();
  for (const f of caseData.frames) {
    const buf = readFileSync(join(caseDir, f.file));
    frameBytes.set(f.frameId, buf);
  }
  return { caseData, frameBytes };
}
