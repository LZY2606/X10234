import type { SourceEntity } from "../types.ts";

export interface PreparedSeries {
  frameIdsInOrder: string[];
  frameById: Map<string, { ordinal: number; tiltRad: number; tiltRaw: string }>;
  observations: Map<string, Map<string, { x: number; y: number; segmentId: string; confidence: number }>>;
  trackIds: string[];
  gaps: { gapId: string; trackId: string; fromFrameId: string; toFrameId: string; reason: string }[];
  manualExclusions: Map<string, { reasonCode: string; reason: string }>;
  unconvertible: { frameId: string; field: string; raw: string; diagnostic: string }[];
}

/**
 * 解释层规范化：原始 QuantifiedValue 保留在来源层；这里只取可转换的值。
 * 无法转换的值留在原位置并产生诊断，绝不静默丢弃。
 */
export function prepareSeries(entities: SourceEntity[]): PreparedSeries {
  const frameById = new Map<string, { ordinal: number; tiltRad: number; tiltRaw: string }>();
  const order: { frameId: string; ordinal: number }[] = [];
  const observations = new Map<string, Map<string, { x: number; y: number; segmentId: string; confidence: number }>>();
  const trackSet = new Set<string>();
  const gaps: PreparedSeries["gaps"] = [];
  const manualExclusions = new Map<string, { reasonCode: string; reason: string }>();
  const unconvertible: PreparedSeries["unconvertible"] = [];

  for (const e of entities) {
    if (e.kind === "TiltFrame") {
      order.push({ frameId: e.frameId, ordinal: e.ordinal });
      frameById.set(e.frameId, { ordinal: e.ordinal, tiltRad: NaN, tiltRaw: "" });
    } else if (e.kind === "TiltAngle") {
      const row = frameById.get(e.frameId);
      if (!row) {
        unconvertible.push({ frameId: e.frameId, field: "tiltAngle", raw: e.angle.raw, diagnostic: "dangling-frame-reference" });
        continue;
      }
      row.tiltRaw = e.angle.raw;
      if (e.angle.value === null) {
        unconvertible.push({ frameId: e.frameId, field: "tiltAngle", raw: e.angle.raw, diagnostic: e.angle.diagnostic ?? "unconvertible" });
      } else {
        row.tiltRad = e.angle.value;
      }
    } else if (e.kind === "ExposureDose" && e.electronsPerSquareAngstrom.value === null) {
      unconvertible.push({
        frameId: e.frameId,
        field: "exposureDose",
        raw: e.electronsPerSquareAngstrom.raw,
        diagnostic: e.electronsPerSquareAngstrom.diagnostic ?? "unconvertible",
      });
    } else if (e.kind === "PixelScale" && e.nmPerPixel.value === null) {
      unconvertible.push({
        frameId: e.frameId,
        field: "pixelScale",
        raw: e.nmPerPixel.raw,
        diagnostic: e.nmPerPixel.diagnostic ?? "unconvertible",
      });
    } else if (e.kind === "MarkerObservation") {
      if (e.x.value === null || e.y.value === null) {
        unconvertible.push({ frameId: e.frameId, field: `marker:${e.trackId}`, raw: `${e.x.raw},${e.y.raw}`, diagnostic: "unconvertible-coordinate" });
        continue;
      }
      let row = observations.get(e.frameId);
      if (!row) {
        row = new Map();
        observations.set(e.frameId, row);
      }
      row.set(e.trackId, { x: e.x.value, y: e.y.value, segmentId: e.segmentId, confidence: e.confidence });
      trackSet.add(e.trackId);
    } else if (e.kind === "TrackingGap") {
      gaps.push({ gapId: e.gapId, trackId: e.trackId, fromFrameId: e.fromFrameId, toFrameId: e.toFrameId, reason: e.reason });
    } else if (e.kind === "ManualExclusion") {
      manualExclusions.set(e.frameId, { reasonCode: e.reasonCode, reason: e.reason });
    }
  }

  order.sort((a, b) => a.ordinal - b.ordinal);
  return {
    frameIdsInOrder: order.map((o) => o.frameId),
    frameById,
    observations,
    trackIds: [...trackSet].sort(),
    gaps,
    manualExclusions,
    unconvertible,
  };
}
