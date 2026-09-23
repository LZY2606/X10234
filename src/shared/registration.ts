import { leastSquares, median } from "./math-linalg";
import type {
  FiducialObservation,
  FrameResidual,
  RawFrame,
  RegistrationCandidate,
  RegistrationParameters,
  TiltAngle,
  TiltAxisSpec,
  TrackIdentityMap,
  IdentitySwap,
} from "./types";
import { angleInDegrees } from "./units";
import { shortDigest } from "./ids";

export interface RegistrationInput {
  frames: RawFrame[];
  angles: TiltAngle[];
  observations: FiducialObservation[];
  params: RegistrationParameters;
  identityMap: TrackIdentityMap;
  branchId: string;
  ruleVersionId: string;
  label: string;
  comparisonGroup: string;
}

const DROP_PENALTY = 2.0;

export function rmsOf(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}

/** 参考帧：倾角绝对值最小的那一帧（通常是 0 度附近）。 */
export function referenceFrameId(frames: RawFrame[], angles: TiltAngle[]): string {
  const byFrame = new Map(angles.map((a) => [a.frameId, angleInDegrees(a.angle)]));
  let best = frames[0];
  let bestAbs = Infinity;
  for (const f of frames) {
    const deg = byFrame.get(f.id);
    const a = deg === null || deg === undefined ? Infinity : Math.abs(deg);
    if (a < bestAbs) {
      bestAbs = a;
      best = f;
    }
  }
  return best.id;
}

interface Pts {
  trackId: string;
  x: number;
  y: number;
}

function framePoints(
  observations: FiducialObservation[],
  frameId: string,
  identityMap: TrackIdentityMap,
): Pts[] {
  return observations
    .filter((o) => o.frameId === frameId && o.at.basis === "raw-frame-pixels")
    .map((o) => ({
      trackId: identityMap.assignments[o.trackLabel] ?? o.trackLabel,
      x: o.at.x,
      y: o.at.y,
    }));
}

function rigidFit(
  moving: Pts[],
  reference: Pts[],
): { shiftX: number; shiftY: number; rotationRad: number; residualPx: number; used: number } {
  const ref = new Map(reference.map((p) => [p.trackId, p]));
  const pairs = moving
    .map((p) => ({ m: p, r: ref.get(p.trackId) }))
    .filter((pair): pair is { m: Pts; r: Pts } => Boolean(pair.r));
  if (pairs.length < 2) {
    return { shiftX: 0, shiftY: 0, rotationRad: 0, residualPx: 0, used: pairs.length };
  }
  const mc = centroid(pairs.map((p) => p.m));
  const rc = centroid(pairs.map((p) => p.r));
  let num = 0;
  let den = 0;
  for (const { m, r } of pairs) {
    const dxm = m.x - mc.x;
    const dym = m.y - mc.y;
    const dxr = r.x - rc.x;
    const dyr = r.y - rc.y;
    num += dxm * dyr - dym * dxr;
    den += dxm * dxr + dym * dyr;
  }
  const rotationRad = Math.atan2(num, den);
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const residuals = pairs.map(({ m, r }) => {
    const xr = mc.x + cos * (m.x - mc.x) - sin * (m.y - mc.y);
    const yr = mc.y + sin * (m.x - mc.x) + cos * (m.y - mc.y);
    return Math.hypot(xr - r.x, yr - r.y);
  });
  return {
    shiftX: rc.x - mc.x,
    shiftY: rc.y - mc.y,
    rotationRad,
    residualPx: rmsOf(residuals),
    used: pairs.length,
  };
}

function centroid(pts: Pts[]): { x: number; y: number } {
  const n = pts.length || 1;
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / n,
    y: pts.reduce((s, p) => s + p.y, 0) / n,
  };
}

/**
 * local-deform：每帧在刚体结果之上叠加双线性网格自由度。
 * 使用留一交叉验证检测过拟合——训练残差很低但交叉验证残差更高时诊断 OVERFIT。
 */
function localWarpFit(
  moving: Pts[],
  reference: Pts[],
  gridSpacing: number,
): { warpNorm: number; trainRms: number; cvRms: number } {
  const ref = new Map(reference.map((p) => [p.trackId, p]));
  const pairs = moving
    .map((p) => ({ m: p, r: ref.get(p.trackId) }))
    .filter((pair): pair is { m: Pts; r: Pts } => Boolean(pair.r));
  if (pairs.length < 5) {
    const rigid = rigidFit(moving, reference);
    return { warpNorm: 0, trainRms: rigid.residualPx, cvRms: rigid.residualPx };
  }
  const trainRes: number[] = [];
  const cvRes: number[] = [];
  for (let hold = -1; hold < pairs.length; hold++) {
    const train = pairs.filter((_, i) => i !== hold);
    const rows: number[][] = [];
    const rhsX: number[] = [];
    const rhsY: number[] = [];
    for (const { m, r } of train) {
      const gx = Math.round(m.x / gridSpacing) * gridSpacing;
      const gy = Math.round(m.y / gridSpacing) * gridSpacing;
      rows.push([1, m.x - gx, m.y - gy, (m.x - gx) * (m.y - gy)]);
      rhsX.push(r.x);
      rhsY.push(r.y);
    }
    let pred: (p: Pts) => { x: number; y: number };
    try {
      const fx = leastSquares(rows, rhsX).params;
      const fy = leastSquares(rows, rhsY).params;
      pred = (p) => {
        const gx = Math.round(p.x / gridSpacing) * gridSpacing;
        const gy = Math.round(p.y / gridSpacing) * gridSpacing;
        const basis = [1, p.x - gx, p.y - gy, (p.x - gx) * (p.y - gy)];
        return {
          x: basis.reduce((s, b, i) => s + b * fx[i], 0),
          y: basis.reduce((s, b, i) => s + b * fy[i], 0),
        };
      };
    } catch {
      const rigid = rigidFit(moving, reference);
      return { warpNorm: 0, trainRms: rigid.residualPx, cvRms: rigid.residualPx };
    }
    const targets = hold === -1 ? train : [pairs[hold]];
    for (const { m, r } of targets) {
      const p = pred(m);
      const d = Math.hypot(p.x - r.x, p.y - r.y);
      if (hold === -1) trainRes.push(d);
      else cvRes.push(d);
    }
  }
  const warpNorm = rmsOf(trainRes) === 0 ? 0 : Math.max(0, rmsOf(cvRes) - rmsOf(trainRes)) * 2;
  return { warpNorm, trainRms: rmsOf(trainRes), cvRms: rmsOf(cvRes) };
}

/**
 * 从 fiducial 轨迹估计倾转轴：沿轨迹走向做 PCA 得方向；
 * 轴线上的点锚定通过沿法向的一维搜索完成。
 * 返回的 anchor 绝不等于图像中心，除非 estimatedFromCenter 被显式置位。
 */
export function estimateTiltAxis(input: {
  frames: RawFrame[];
  angles: TiltAngle[];
  observations: FiducialObservation[];
  identityMap: TrackIdentityMap;
  imageCenterAssumption: boolean;
}): { axis: TiltAxisSpec; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const tracks = collectTracks(input.observations, input.identityMap);
  const allPoints = [...tracks.values()].flat();
  if (allPoints.length < 4) {
    diagnostics.push("AXIS_UNDERDETERMINED: 轨迹点不足，无法估计倾转轴");
  }
  let meanX = 0;
  let meanY = 0;
  for (const p of allPoints) {
    meanX += p.x;
    meanY += p.y;
  }
  meanX /= allPoints.length || 1;
  meanY /= allPoints.length || 1;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of allPoints) {
    sxx += (p.x - meanX) ** 2;
    syy += (p.y - meanY) ** 2;
    sxy += (p.x - meanX) * (p.y - meanY);
  }
  const directionRad = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(directionRad);
  const ny = Math.cos(directionRad);

  const referenceId = referenceFrameId(input.frames, input.angles);
  const refZeroDeg = input.angles.find((a) => a.frameId === referenceId);
  const highTiltCount = input.frames.filter((f) => {
    const found = input.angles.find((a) => a.frameId === f.id);
    const d = found ? angleInDegrees(found.angle) : null;
    return d !== null && Math.abs(d) >= 55;
  }).length;
  if (highTiltCount < 2) diagnostics.push("AXIS_UNCERTAIN_HIGH_TILT_MISSING: 高倾角帧缺失，轴线位置不确定");

  let anchorX: number | null = null;
  let anchorY: number | null = null;
  if (input.imageCenterAssumption) {
    const w = input.frames[0]?.width ?? 0;
    const h = input.frames[0]?.height ?? 0;
    anchorX = w / 2;
    anchorY = h / 2;
    diagnostics.push("AXIS_CENTER_ASSUMED: 规则把轴钉在图像中心——这是被禁止的默认假设");
  } else if (refZeroDeg && tracks.size >= 2) {
    // 沿法向搜索锚点：让所有轨迹中点到候选轴线距离的方差最小
    const mids = [...tracks.values()].map((pts) => centroid(pts));
    let bestC = 0;
    let bestScore = Infinity;
    for (let c = -Math.max(meanX, meanY) * 1.5; c <= Math.max(meanX, meanY) * 1.5; c += 0.5) {
      const dist = mids.map((m) => nxC(nx, ny, m, c));
      const score = dist.reduce((s, v) => s + v * v, 0);
      if (score < bestScore) {
        bestScore = score;
        bestC = c;
      }
    }
    anchorX = meanX + nx * bestC;
    anchorY = meanY + ny * bestC;
  } else {
    diagnostics.push("AXIS_ANCHOR_MISSING: 拒绝把轴线默认固定在图像中心，锚点未知");
  }
  return {
    axis: {
      anchorX,
      anchorY,
      directionDeg: (directionRad * 180) / Math.PI,
      assumedImageCenter: input.imageCenterAssumption,
      estimationMethod: input.imageCenterAssumption ? "image-center-assumption" : "track-pca-normal-search",
    },
    diagnostics,
  };
}

function nxC(nx: number, ny: number, m: { x: number; y: number }, c: number): number {
  return nx * m.x + ny * m.y - c;
}

function collectTracks(observations: FiducialObservation[], identityMap: TrackIdentityMap) {
  const tracks = new Map<string, Pts[]>();
  for (const o of observations) {
    if (o.at.basis !== "raw-frame-pixels") continue;
    const trackId = identityMap.assignments[o.trackLabel] ?? o.trackLabel;
    if (!tracks.has(trackId)) tracks.set(trackId, []);
    tracks.get(trackId)!.push({ trackId, x: o.at.x, y: o.at.y });
  }
  return tracks;
}

/**
 * 解析 fiducial 轨迹身份：在轨迹身份交换的帧上，用几何最近邻纠正标签。
 * 对称导致多组等价方案时返回 ambiguity=true 与全部候选。
 */
export function resolveTrackIdentities(input: {
  frames: RawFrame[];
  angles: TiltAngle[];
  observations: FiducialObservation[];
  knownSwaps: IdentitySwap[];
}): TrackIdentityMap {
  const referenceId = referenceFrameId(input.frames, input.angles);
  const refPoints = framePoints(input.observations, referenceId, { assignments: {}, swaps: [], ambiguity: false });
  const labels = [...new Set(input.observations.map((o) => o.trackLabel))].sort();
  const assignments: Record<string, string> = {};
  const swaps: IdentitySwap[] = input.knownSwaps;
  for (const swap of input.knownSwaps) {
    assignments[`${swap.trackLabelA}`] = `trk_${swap.trackLabelB.replace(/^trk_/, "")}`;
    assignments[`${swap.trackLabelB}`] = `trk_${swap.trackLabelA.replace(/^trk_/, "")}`;
  }
  // 检测几何对称性：若参考帧中有两对以上标记点间距几乎相等，则身份不可唯一决定
  const d: number[] = [];
  for (let i = 0; i < refPoints.length; i++) {
    for (let j = i + 1; j < refPoints.length; j++) {
      d.push(Math.hypot(refPoints[i].x - refPoints[j].x, refPoints[i].y - refPoints[j].y));
    }
  }
  let ambiguous = false;
  const alternatives: Record<string, string>[] = [];
  for (let i = 0; i < d.length; i++) {
    for (let j = i + 1; j < d.length; j++) {
      if (d[i] > 1e-6 && Math.abs(d[i] - d[j]) / d[i] < 0.02) {
        ambiguous = true;
      }
    }
  }
  if (ambiguous && labels.length >= 2) {
    const alt = { ...assignments };
    alt[labels[0]] = `trk_${labels[1].replace(/^trk_/, "")}`;
    alt[labels[1]] = `trk_${labels[0].replace(/^trk_/, "")}`;
    alternatives.push(alt);
  }
  return { assignments, swaps, ambiguity: ambiguous, ambiguousAlternatives: alternatives };
}

/**
 * 构造一个配准候选。关键规则：
 *  - 被排除帧标记 used=false 但仍然输出残差行，不允许“少帧换低残差”。
 *  - pointSetDigest 覆盖候选实际使用的有效点集；同 comparisonGroup 的候选必须一致。
 *  - local-deform 用交叉验证暴露过拟合，并施加复杂度惩罚。
 */
export function buildCandidate(input: RegistrationInput): RegistrationCandidate {
  const diagnostics = [...input.params.tiltAxis.assumedImageCenter
    ? ["AXIS_CENTER_ASSUMED: 该候选依赖被禁止的图像中心轴假设"]
    : []];

  const referenceId = referenceFrameId(input.frames, input.angles);
  const dropped = new Set(input.params.droppedFrameIds);
  const refPoints = framePoints(input.observations, referenceId, input.identityMap);

  const perFrame: FrameResidual[] = [];
  const usedResiduals: number[] = [];
  const usedCv: number[] = [];
  let warpMax = 0;

  for (const frame of input.frames) {
    const pts = framePoints(input.observations, frame.id, input.identityMap);
    const excludedReason = dropped.has(frame.id)
      ? "rule-dropped"
      : pts.length < 2
        ? "insufficient-fiducials"
        : null;
    const rigid = rigidFit(pts, refPoints);
    let localWarpNorm: number | null = null;
    let cv: number | null = null;
    if (input.params.model === "local-deform" && !excludedReason) {
      const w = localWarpFit(pts, refPoints, input.params.warpGridSpacingPx);
      localWarpNorm = w.warpNorm;
      cv = w.cvRms;
      warpMax = Math.max(warpMax, w.warpNorm);
      usedCv.push(w.cvRms);
      if (w.cvRms > w.trainRms * 1.5 + 0.5) {
        diagnostics.push(`OVERFIT frame=${frame.id}: 交叉验证残差 ${w.cvRms.toFixed(2)}px 远高于训练 ${w.trainRms.toFixed(2)}px`);
      }
    }
    if (Math.hypot(rigid.shiftX, rigid.shiftY) > input.params.maxShiftPx) {
      diagnostics.push(`SHIFT_LIMIT frame=${frame.id}: 平移 ${Math.hypot(rigid.shiftX, rigid.shiftY).toFixed(2)}px 超过上限 ${input.params.maxShiftPx}px`);
    }
    if (!excludedReason) usedResiduals.push(rigid.residualPx);
    perFrame.push({
      frameId: frame.id,
      used: !excludedReason,
      excludedReason,
      shiftX: rigid.shiftX,
      shiftY: rigid.shiftY,
      rotationRad: rigid.rotationRad,
      residualPx: rigid.residualPx,
      nPoints: rigid.used,
      localWarpNorm,
      crossValidationPx: cv,
    });
  }

  const validFrameIds = input.frames.filter((f) => !dropped.has(f.id)).map((f) => f.id);
  const pointSetDigest = shortDigest(
    input.observations
      .filter((o) => validFrameIds.includes(o.frameId))
      .map((o) => [o.frameId, o.trackLabel, o.at.x, o.at.y, o.at.basis]),
  );

  const nFrames = input.frames.length;
  const nDropped = dropped.size;
  const dropRatio = nFrames === 0 ? 0 : nDropped / nFrames;
  const rmsPx = rmsOf(usedResiduals);
  const maxPx = usedResiduals.reduce((m, v) => Math.max(m, v), 0);
  const cvRmsPx = usedCv.length ? rmsOf(usedCv) : null;
  const complexityPenalty =
    input.params.model === "local-deform"
      ? input.params.warpDegreesOfFreedom * 0.05
      : 0;

  const score =
    rmsPx + complexityPenalty + (cvRmsPx !== null && cvRmsPx > rmsPx ? cvRmsPx - rmsPx : 0) + dropRatio * DROP_PENALTY;

  if (nDropped > 0) {
    diagnostics.push(`DROPPED_FRAMES_PENALTY: 排除 ${nDropped}/${nFrames} 帧，分数惩罚 ${(dropRatio * DROP_PENALTY).toFixed(2)}`);
  }
  const med = median(usedResiduals);
  const droppedRows = perFrame.filter((r) => !r.used);
  for (const row of droppedRows) {
    if (row.residualPx > med * 1.5) {
      diagnostics.push(`DROP_HIDES_OUTLIER frame=${row.frameId}: 被排除帧自身残差偏高，排除并非不合理但不能只报更少帧的低残差`);
    }
  }

  const id = `cand_${shortDigest({
    branch: input.branchId,
    rule: input.ruleVersionId,
    model: input.params.model,
    group: input.comparisonGroup,
    pointSet: pointSetDigest,
  })}`;

  return {
    id,
    branchId: input.branchId,
    ruleVersionId: input.ruleVersionId,
    label: input.label,
    model: input.params.model,
    validFrameIds,
    pointSetDigest,
    identityMap: input.identityMap,
    perFrame,
    rmsPx,
    maxPx,
    cvRmsPx,
    complexityPenalty,
    score,
    diagnostics,
    comparisonGroup: input.comparisonGroup,
  };
}

/**
 * 候选公平比较：不同候选必须使用相同有效点集。
 * 任何 pointSetDigest 不一致的对比都必须返回违例，而不是安静地选残差最小者。
 */
export function compareCandidates(
  candidates: RegistrationCandidate[],
): { winner: RegistrationCandidate | null; violations: string[]; table: CandidateScore[] } {
  const violations: string[] = [];
  const groups = new Map<string, RegistrationCandidate[]>();
  for (const c of candidates) {
    const list = groups.get(c.comparisonGroup) ?? [];
    list.push(c);
    groups.set(c.comparisonGroup, list);
  }
  const table: CandidateScore[] = [];
  let winner: RegistrationCandidate | null = null;
  for (const [group, list] of groups) {
    const digests = new Set(list.map((c) => c.pointSetDigest));
    if (digests.size > 1) {
      violations.push(
        `UNEQUAL_POINT_SETS group=${group}: 候选有效点集不一致 ${[...digests].join(", ")}，禁止用少帧换低残差`,
      );
    }
    for (const c of list) {
      table.push({
        candidateId: c.id,
        label: c.label,
        model: c.model,
        group,
        validFrames: c.validFrameIds.length,
        rmsPx: c.rmsPx,
        cvRmsPx: c.cvRmsPx,
        score: c.score,
      });
    }
    const eligible = digests.size === 1 ? list : [];
    const localWinner = eligible
      .filter((c) => !c.diagnostics.some((d) => d.startsWith("OVERFIT") || d.startsWith("AXIS_CENTER_ASSUMED")))
      .sort((a, b) => a.score - b.score)[0];
    if (localWinner && (!winner || localWinner.score < winner.score)) winner = localWinner;
  }
  return { winner, violations, table };
}

export interface CandidateScore {
  candidateId: string;
  label: string;
  model: string;
  group: string;
  validFrames: number;
  rmsPx: number;
  cvRmsPx: number | null;
  score: number;
}
