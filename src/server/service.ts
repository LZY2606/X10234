/**
 * 应用编排服务：导入 / 解释 / 候选 / 裁定 / 失效范围 / 导出导入。
 * 所有写操作经 store.tx 包裹，失败即回滚，不留半份记录。
 */
import { createHash } from 'node:crypto';
import { Store, contentHash } from './store.js';
import { loadCase, type CaseFile } from './case-loader.js';
import { sid } from '../domain/types.js';
import type {
  EntityEnvelope, EntityKind, RawFrame, TiltAngle, PixelScale, Dose,
  FiducialObservation, TrackGap, ManualExclusionReason, Diagnostic,
} from '../domain/types.js';

export interface ImportOptions {
  label: string;
  kind: string;
  branchId: string;
  branchName: string;
  /** 缺失帧（不导入对应帧/角度/剂量/观测），用于 missing_high_tilt_frames */
  omitFrameIds?: string[];
  parentRevisionId?: string;
  /** 源数据修订：覆盖单个观测坐标（只影响局部依赖） */
  observationPatches?: Record<string, { x: number; y: number; note: string }>;
  /** 坐标覆盖（无法转换值留在原位并附诊断的演示） */
  scaleOverride?: { value: number | string; unit: string; rawText: string };
  correlationId?: string;
}

let monotonic = 0;
function uid(prefix: string): string {
  monotonic += 1;
  return `${prefix}-${Date.now().toString(36)}-${monotonic}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export class AppService {
  constructor(public store: Store) {
    store.ensureRepository();
  }

  get nextRevisionNo(): number { return this.store.currentRevisionNo() + 1; }

  private envelope<T extends { revisionId: string }>(
    kind: EntityKind, id: string, version: number, payload: T, summary: string, refs: string[],
  ): EntityEnvelope<T> {
    return {
      id: sid(kind, id), kind, version, contentHash: contentHash(payload),
      summary, refs, payload, createdAt: new Date().toISOString(),
    };
  }

  /** 导入整份案例材料（来源层）。返回 revisionId 与诊断；任何校验失败整体回滚。 */
  importCase(
    caseData: CaseFile,
    frameBytes: Map<string, Buffer>,
    opts: ImportOptions,
  ): { revisionId: string; diagnostics: Diagnostic[]; eventIds: string[] } {
    const diagnostics: Diagnostic[] = [];
    const revisionNo = this.nextRevisionNo;
    const revisionId = `revision/${revisionNo}`;
    const eventIds: string[] = [];
    const omit = new Set(opts.omitFrameIds ?? []);

    this.store.tx(() => {
      this.store.addRevision({ revisionId, revisionNo, kind: opts.kind, label: opts.label, parentRevisionId: opts.parentRevisionId });
      if (revisionNo === 1) {
        this.store.addBranch({ branchId: opts.branchId, revisionId, name: opts.branchName, note: '初始基线分支' });
      } else {
        this.store.addBranch({ branchId: opts.branchId, revisionId, parentBranchId: 'branch/main', name: opts.branchName });
      }

      const v = revisionNo;
      const E = <T extends { revisionId: string }>(
        kind: EntityKind, id: string, payloadNoRev: Omit<T, 'revisionId'>, summary: string, refs: string[] = [],
      ): EntityEnvelope<T> => {
        const payload = { ...(payloadNoRev as object), revisionId } as T;
        const env = this.envelope<T>(kind, id, v, payload, summary, refs);
        this.store.putEntity(env, opts.branchId);
        return env;
      };

      // 材料锚实体
      const material = E<{ revisionId: string; key: string; title: string }>(
        'material', 'tilt-series',
        { key: 'tilt-series', title: caseData.title },
        `材料：${caseData.title} @ rev${v}`,
      );

      // 像素尺度（含无法规范化演示）
      for (const sc of caseData.pixelScales) {
        const value = opts.scaleOverride ? opts.scaleOverride.value : sc.value;
        const unit = opts.scaleOverride ? opts.scaleOverride.unit : sc.unit;
        const rawText = opts.scaleOverride ? opts.scaleOverride.rawText : JSON.stringify(sc.raw);
        const dim = this.dimensioned(value, unit, rawText, 'nm_per_px');
        if (!dim.normalized) diagnostics.push({ code: 'UNCONVERTIBLE_SCALE', severity: 'warning', message: `尺度 ${rawText} 无法规范化，保留原位`, entityId: sid('pixel_scale', sc.scaleId) });
        E<PixelScale & { revisionId: string }>('pixel_scale', sc.scaleId, {
          scaleId: sid('pixel_scale', sc.scaleId),
          frameId: sc.frameId ?? undefined,
          scale: dim,
        }, `像素尺度 ${rawText}`);
      }

      for (const f of caseData.frames) {
        if (omit.has(f.frameId)) {
          diagnostics.push({ code: 'FRAME_MISSING', severity: 'warning', message: `缺失高倾角帧 ${f.frameId} 已显式标记，不做静默插值`, entityId: f.frameId });
          continue;
        }
        const bytes = frameBytes.get(f.frameId);
        if (!bytes) throw new Error(`import integrity: bytes missing for ${f.frameId}`);
        const { blobId, sha256, deduplicated } = this.store.putBlob(bytes, 'image/x-portable-graymap');
        if (sha256 !== f.sha256) throw new Error(`import integrity: sha256 mismatch for ${f.frameId}`);
        E<RawFrame>('raw_frame', f.frameId, {
          frameId: f.frameId, index: f.index, blobId, sha256,
          widthPx: caseData.frameGeometry.widthPx, heightPx: caseData.frameGeometry.heightPx,
          encoding: 'P5/pgm', raw: { file: f.file, byteLength: f.byteLength, deduplicated },
        }, `原始帧 ${f.frameId} ${caseData.frameGeometry.widthPx}x${caseData.frameGeometry.heightPx} sha=${sha256.slice(0, 12)}`, [blobId]);

        const ang = caseData.tiltAngles.find(a => a.frameId === f.frameId)!;
        E<TiltAngle>('tilt_angle', ang.angleId, {
          angleId: ang.angleId, frameId: f.frameId,
          angle: this.dimensioned(ang.value, 'degree', JSON.stringify(ang.raw), 'degree'),
          signConvention: 'ccw_positive_in_xy',
        }, `倾角 ${f.frameId}=${ang.value}°`, [sid('raw_frame', f.frameId)]);

        const dose = caseData.doses.find(d => d.frameId === f.frameId)!;
        E<Dose>('dose', dose.doseId, {
          doseId: dose.doseId, frameId: f.frameId,
          electronsPerAngstrom2: this.dimensioned(dose.electronsPerAngstrom2.value, 'e-/A^2', JSON.stringify(dose.raw), 'e-/A^2'),
          cumulative: this.dimensioned(dose.cumulative.value, 'e-/A^2', `cumulative ${dose.cumulative.value} e-/A^2`, 'e-/A^2'),
        }, `剂量 ${f.frameId} ${dose.electronsPerAngstrom2.value} e-/A²`, [sid('raw_frame', f.frameId)]);
      }

      // fiducial 观测
      for (const o of caseData.observations) {
        if (omit.has(o.frameId)) continue;
        const patch = opts.observationPatches?.[o.observationId];
        const x = patch ? patch.x : o.x;
        const y = patch ? patch.y : o.y;
        E<FiducialObservation>('fiducial_observation', o.observationId, {
          observationId: o.observationId, frameId: o.frameId, observedTrackId: o.observedTrackId,
          point: { x, y, frame: o.frameId, basis: 'image_px_top_left' },
          uncertaintyPx: o.uncertaintyPx,
          raw: { trackerX: o.x, trackerY: o.y, patched: patch ? { ...patch } : undefined, basis: o.basis },
        }, `标记点 ${o.observedTrackId}@${o.frameId} (${x.toFixed(1)},${y.toFixed(1)})${patch ? ' [patched]' : ''}`, [sid('raw_frame', o.frameId)]);
      }

      // 跟踪缺口
      for (const g of caseData.trackGaps) {
        const liveMissing = g.missingFrameIds.filter(id => !omit.has(id));
        E<TrackGap>('track_gap', g.gapId, {
          gapId: g.gapId, observedTrackId: g.observedTrackId, missingFrameIds: liveMissing,
          reason: g.reason, raw: g.raw,
        }, `跟踪缺口 ${g.observedTrackId}: ${liveMissing.join(',')}`,
        liveMissing.map(id => sid('raw_frame', id)));
      }

      // 手工排除原因
      for (const r of caseData.manualExclusionReasons) {
        if (omit.has(r.frameId)) continue;
        E<ManualExclusionReason>('manual_exclusion_reason', r.reasonId, {
          reasonId: r.reasonId, frameId: r.frameId, reason: r.reason, author: r.author, raw: r.raw,
        }, `手工排除 ${r.frameId}: ${r.reason.slice(0, 40)}`, [sid('raw_frame', r.frameId)]);
      }

      // 事件（机器可读）
      const wv = this.store.bumpWorld();
      const evt = this.store.appendEvent({
        eventId: `event/material-imported-r${revisionNo}`,
        revisionId, branchId: opts.branchId, type: 'material.imported', subjectId: sid('material', 'tilt-series'),
        payload: {
          revision: revisionNo, label: opts.label, omittedFrames: [...omit],
          patchedObservations: Object.keys(opts.observationPatches ?? {}),
          frameCount: caseData.frames.filter(f => !omit.has(f.frameId)).length,
          diagnostics: diagnostics.map(d => d.code),
        },
        createdAt: new Date().toISOString(), correlationId: opts.correlationId,
      });
      eventIds.push(evt.eventId);
      void wv; void material;
    });

    return { revisionId, diagnostics, eventIds };
  }

  private dimensioned(value: number | string, unit: string, rawText: string, canonicalUnit: string) {
    const out = { value, unit, rawRepresentation: rawText } as {
      value: number | string; unit: string; rawRepresentation: string;
      normalized?: { value: number; unit: string };
    };
    if (typeof value === 'number' && unit === canonicalUnit) {
      out.normalized = { value, unit: canonicalUnit };
    } else if (typeof value === 'number') {
      const converted = UNIT_CONVERSIONS[unit]?.[canonicalUnit];
      if (converted) out.normalized = { value: converted(value), unit: canonicalUnit };
    }
    return out;
  }
}

export const UNIT_CONVERSIONS: Record<string, Record<string, (v: number) => number>> = {
  'degree': { degree: v => v, radian: v => (v * Math.PI) / 180 },
  'radian': { radian: v => v, degree: v => (v * 180) / Math.PI },
  'angstrom_per_px': { nm_per_px: v => v / 10 },
  'e/A^2': { 'e-/A^2': v => v },
  'e-/A^2': { 'e/A^2': v => v },
};

export function sha(buf: Buffer): string { return createHash('sha256').update(buf).digest('hex'); }
export { uid };
