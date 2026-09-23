// 生成仓库内离线案例包 fixtures/cases/tilt-room-case。
// 领域材料：原始帧(PGM)、倾角、像素尺度、剂量、标记点坐标、跟踪缺口、手工排除原因。
// 所有量携带单位/坐标基准；原始表示(rawRepresentation)逐字保留。
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TILTS,
  WIDTH,
  HEIGHT,
  FIDUCIALS,
  GAP,
  SWAP,
  BAD_FRAMES,
  MISSING_HIGH_TILTS,
  AXIS_ANGLE_DEG,
  AXIS_OFFSET_PX,
  projectPoint,
  renderFrame,
  hashBytes
} from './case-geometry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const caseRoot = join(here, '..', 'fixtures', 'cases', 'tilt-room-case');
rmSync(caseRoot, { recursive: true, force: true });
mkdirSync(join(caseRoot, 'raw'), { recursive: true });

const blobs = [];
const writeBlob = (name, buffer, contentType) => {
  const sha = hashBytes(buffer);
  const path = join('raw', name);
  writeFileSync(join(caseRoot, path), buffer);
  blobs.push({
    name,
    path,
    sha256: sha,
    byteLength: buffer.length,
    contentType
  });
};

// 同一物理帧的不同解释共享同一份不可变原始字节：只渲染一次。
for (let index = 0; index < TILTS.length; index++) {
  const tilt = TILTS[index];
  const frameId = `frame_${String(index).padStart(2, '0')}`;
  const bad = BAD_FRAMES.has(tilt);
  // 缺失高倾角帧：不生成 blob（物理缺失）。
  if (MISSING_HIGH_TILTS.has(tilt)) continue;
  const buffer = renderFrame(tilt, index, { bad });
  writeBlob(`${frameId}.pgm`, buffer, 'image/x-portable-graymap');
}

const frames = [];
const tiltAngles = [];
const doses = [];
const markers = [];
let markerIndex = 0;

for (let index = 0; index < TILTS.length; index++) {
  const tilt = TILTS[index];
  const frameId = `frame_${String(index).padStart(2, '0')}`;
  const missing = MISSING_HIGH_TILTS.has(tilt);
  const blob = blobs.find((entry) => entry.name === `${frameId}.pgm`);
  frames.push({
    frameId,
    sequenceIndex: index,
    tiltDeg: tilt,
    width: WIDTH,
    height: HEIGHT,
    present: !missing,
    blob: blob
      ? {
          path: blob.path,
          sha256: blob.sha256,
          byteLength: blob.byteLength,
          contentType: blob.contentType
        }
      : null,
    missingReason: missing ? '高倾角帧未采集（dose-symmetric 序列末端缺失）' : null,
    badFrame: BAD_FRAMES.has(tilt),
    acquisitionNote: BAD_FRAMES.has(tilt)
      ? '载网跳动 + 条带污染（手工标记疑似坏帧）'
      : '正常曝光'
  });

  tiltAngles.push({
    frameId,
    sequenceIndex: index,
    angle: {
      value: tilt,
      unit: 'degree',
      coordinateFrame: 'stage',
      rawRepresentation: `${tilt >= 0 ? '+' : ''}${tilt}deg`,
      provenance: `tilt-series.csv:L${index + 2}`
    }
  });

  // 剂量：从原始 e-/A^2 文本导入，保留原始表示。
  const doseValue = Number((1.8 + Math.abs(tilt) * 0.012).toFixed(3));
  doses.push({
    frameId,
    sequenceIndex: index,
    exposure: {
      value: doseValue,
      unit: 'e-/A^2',
      coordinateFrame: undefined,
      rawRepresentation: `${doseValue.toFixed(3)} e-/A^2`,
      provenance: `dose-log.txt:L${index + 1}`
    }
  });

  if (missing) continue;
  for (const fiducial of FIDUCIALS) {
    if (
      index >= GAP.from &&
      index <= GAP.to &&
      fiducial.id === GAP.track
    ) {
      continue;
    }
    let physical = fiducial;
    let rawLabel = fiducial.id;
    if (
      index >= SWAP.from &&
      index <= SWAP.to &&
      (fiducial.id === SWAP.a || fiducial.id === SWAP.b)
    ) {
      physical = FIDUCIALS.find(
        (other) => other.id === (fiducial.id === SWAP.a ? SWAP.b : SWAP.a)
      );
    }
    const point = projectPoint(physical, tilt);
    markers.push({
      markerId: `marker_${String(markerIndex++).padStart(4, '0')}`,
      frameId,
      sequenceIndex: index,
      trackId: fiducial.id,
      rawLabel,
      coordinate: {
        value: { x: Number(point.x.toFixed(3)), y: Number(point.y.toFixed(3)) },
        unit: 'pixel',
        coordinateFrame: 'image-pixel',
        rawRepresentation: `(${point.x.toFixed(2)},${point.y.toFixed(2)})px`,
        provenance: `fiducials-${fiducial.id}.csv:L${index + 1}`
      }
    });
  }
}

const materials = {
  caseId: 'tilt-room-case',
  title: '倾转帧拼合室：电镜 tilt-series 轴线、fiducial 轨迹与配准分支',
  domain: 'electron-tomography-tilt-series-registration',
  image: { width: WIDTH, height: HEIGHT },
  axisHint: { angleDeg: AXIS_ANGLE_DEG, knownOffsetPx: AXIS_OFFSET_PX },
  pixelScale: {
    scope: 'series',
    scale: {
      value: 0.84,
      unit: 'nm/pixel',
      coordinateFrame: undefined,
      rawRepresentation: '0.84 nm/pixel',
      provenance: 'microscope-header.txt'
    }
  },
  frames,
  tiltAngles,
  doses,
  markers,
  trackGaps: [
    {
      trackId: GAP.track,
      fromSequenceIndex: GAP.from,
      toSequenceIndex: GAP.to,
      reason: '高倾角下标记点与金颗粒重叠，自动跟踪丢失',
      provenance: 'track-gap-review.md#F3'
    }
  ],
  manualExclusions: [
    {
      frameId: `frame_${String(TILTS.indexOf(-42)).padStart(2, '0')}`,
      sequenceIndex: TILTS.indexOf(-42),
      reason: '载网跳动导致整体漂移且有条带污染，电镜操作员建议排除',
      provenance: 'operator-notes.txt#L7'
    }
  ],
  identitySwapQuestion: {
    questionId: 'swap_F6_F7',
    trackIdA: SWAP.a,
    trackIdB: SWAP.b,
    fromSequenceIndex: SWAP.from,
    toSequenceIndex: SWAP.to,
    evidence: '该倾角区间 F6/F7 投影交叉，自动跟踪标签互换，需要裁定'
  },
  missingHighTilts: {
    sequenceIndices: TILTS.map((tilt, index) =>
      MISSING_HIGH_TILTS.has(tilt) ? index : -1
    ).filter((index) => index >= 0),
    reason: 'dose-symmetric 采集末端高倾角帧缺失'
  }
};

writeFileSync(
  join(caseRoot, 'materials.json'),
  JSON.stringify(materials, null, 2)
);

const readme = `# 倾转帧拼合室 · 离线领域案例包

这不是通用表格，而是电子断层 tilt-series 配准的领域材料：

- raw/ ：21 个计划倾角中实际采集到的原始 PGM 帧（+54/+60 高倾角帧物理缺失）。
- materials.json ：倾角（degree, stage 基准）、像素尺度（nm/pixel）、曝光剂量
  （e-/A^2）、fiducial 标记点坐标（image-pixel 基准）、跟踪缺口、手工排除原因，
  全部携带单位/坐标基准与 rawRepresentation。
- 轴已知存在约 ${AXIS_OFFSET_PX}px 偏心，用于检验“轴不能默认固定在图像中心”。
- F3 轨迹在 +36°..+48° 断裂；F6/F7 在一段高倾角区间发生身份交换。
- -42° 帧为坏帧（漂移+条带），但是否排除必须由复核裁定。

反例情形（最小输入 + 组合输入）由应用重放生成，见 src/domain/case-scenarios.ts。
`;
writeFileSync(join(caseRoot, 'README.md'), readme);

console.log(`case package generated: ${blobs.length} raw frames`);
