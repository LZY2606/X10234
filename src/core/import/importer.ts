import type {
  ConversionDiagnostic,
  EntityRef,
  FiducialObservation,
  ManualExclusion,
  RawQuantity,
  TiltFrame,
  TiltSeriesMeta,
  TrackingGap,
} from '../../shared/domain';
import { decodePgm } from '../../shared/pgm';
import { normalizeQuantity } from '../../shared/units';
import type { Database } from '../db/database';
import { ContentStore } from '../store/contentStore';
import { EventLog } from '../store/eventLog';

/** 电镜小组导入的倾转序列负载：原始帧 + 倾角 + 像素尺度 + 剂量 + 标记点 + 缺口 + 排除原因。 */
export interface TiltSeriesImportPayload {
  series: TiltSeriesMeta;
  frames: Array<{
    frameId: string;
    tiltIndex: number;
    tiltAngle: RawQuantity;
    pixelSize: RawQuantity;
    dose: RawQuantity;
    imagePgmBase64: string;
  }>;
  fiducials: Array<{
    observationId: string;
    frameId: string;
    trackId: string;
    x: RawQuantity;
    y: RawQuantity;
  }>;
  gaps: TrackingGap[];
  exclusions: ManualExclusion[];
}

export interface ImportResult {
  seriesRef: EntityRef;
  frameRefs: EntityRef[];
  observationRefs: EntityRef[];
  diagnostics: ConversionDiagnostic[];
}

/**
 * 导入管线：
 *  - 原始表示原样保留（RawQuantity 原值+原单位、帧字节内容寻址）；
 *  - 禁止在导入时做不可逆清洗（轨迹断裂/身份交换/可疑帧全部保留）；
 *  - 失败回滚本次全部变更，不留半份记录。
 */
export function importTiltSeries(db: Database, payload: TiltSeriesImportPayload): ImportResult {
  const store = new ContentStore(db);
  const events = new EventLog(db);
  return db.transaction(() => {
    const diagnostics: ConversionDiagnostic[] = [];

    const seriesRef = store.putEntity('tilt-series', payload.series.seriesId, payload.series);
    if (!db.get('SELECT branch_id FROM branches WHERE branch_id = ?', 'main')) {
      db.run(
        'INSERT INTO branches(branch_id, series_id, name, parent_branch_id, head_seq) VALUES (?, ?, ?, NULL, 0)',
        'main',
        payload.series.seriesId,
        'main',
      );
    }

    const frameRefs: EntityRef[] = [];
    for (const f of payload.frames) {
      const bytes = Uint8Array.from(atob(f.imagePgmBase64), (c) => c.charCodeAt(0));
      const { width, height } = decodePgm(bytes); // 校验失败 -> 抛错 -> 整体回滚
      const imageBlobHash = store.putBlob(bytes, 'image/x-portable-graymap');
      const frame: TiltFrame = {
        frameId: f.frameId,
        seriesId: payload.series.seriesId,
        tiltIndex: f.tiltIndex,
        tiltAngle: f.tiltAngle,
        pixelSize: f.pixelSize,
        dose: f.dose,
        imageBlobHash,
        widthPx: width,
        heightPx: height,
      };
      frameRefs.push(store.putEntity('tilt-frame', f.frameId, frame));
      for (const [q, target] of [
        [f.tiltAngle, 'deg'],
        [f.pixelSize, 'nm'],
        [f.dose, 'e-/A2'],
      ] as Array<[RawQuantity, 'deg' | 'nm' | 'e-/A2']>) {
        const n = normalizeQuantity(q, target);
        if (!n.ok) diagnostics.push(n.diagnostic);
      }
    }

    const observationRefs: EntityRef[] = [];
    for (const o of payload.fiducials) {
      const obs: FiducialObservation = {
        observationId: o.observationId,
        seriesId: payload.series.seriesId,
        frameId: o.frameId,
        trackId: o.trackId,
        position: { x: o.x, y: o.y },
      };
      observationRefs.push(store.putEntity('fiducial-observation', o.observationId, obs));
    }
    for (const g of payload.gaps) store.putEntity('tracking-gap', g.gapId, g);
    for (const e of payload.exclusions) store.putEntity('manual-exclusion', e.exclusionId, e);

    events.append('main', 'series-imported', {
      seriesRef,
      frameRefs,
      observationRefs,
      rule: '原始帧/倾角/像素尺度/剂量/标记点坐标/跟踪缺口/手工排除原因全部版本化；导入不做不可逆清洗',
    });
    for (const d of diagnostics) {
      events.append('main', 'diagnostic-raised', { diagnostic: d });
    }
    return { seriesRef, frameRefs, observationRefs, diagnostics };
  });
}
