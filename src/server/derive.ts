import { createHash } from 'node:crypto';
import type {
  AlignmentCandidateContent,
  AlignmentModel,
  AlignmentParamsContent,
  CandidateDiffContent,
  Diagnostic,
  FiducialObservation,
  FrameDose,
  TiltAngle,
  TiltAxisFitContent,
  TrackGraphContent,
} from '../shared/types';

/** 派生层规范化：原始表示保留在 blob 中，这里只做换算；无法转换返回 null。 */
export function normalizeDose(d: FrameDose): { value: number; unit: 'e-/A^2' } | null {
  const v = typeof d.dose === 'number' ? d.dose : Number(d.dose);
  if (!Number.isFinite(v)) return null;
  switch (d.unit) {
    case 'e-/A^2':
      return { value: v, unit: 'e-/A^2' };
    case 'e-/nm^2':
      return { value: v / 100, unit: 'e-/A^2' };
    default:
      return null;
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update=text as never as string;
}
