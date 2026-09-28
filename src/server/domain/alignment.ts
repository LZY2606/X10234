import {
  DEG,
  gaussian,
  hashString,
  leastSquares,
  mulberry32,
  project,
  rms,
} from "./math.ts";
import type {
  AlignmentCandidateBody,
  EffectivePointSet,
  FiducialTrackVersion,
  FrameResidual,
  RawFrameVersion,
  TiltAxisGeometry,
} from "../../shared/types.ts";

export interface FitInput {
  frames: RawFrameVersion[];
  tiltAnglesDeg: Record<string, number>;
  tracks: FiducialTrackVersion[];
  excludedFrameIds: Set<string>;
  axis: TiltAxisGeometry;
  candidateId: string;
  label: string;
  kind: AlignmentCandidateBody["kind"];
  localWarp?: { controlGrid: number; perFrameAffine: boolean };
  /** 多解检测时传入已存在的候选 rms，用于返回 ambiguous 标记 */
  siblingRmsPx?: number[];
}

export function buildEffectivePointSet(
  frames: RawFrameVersion[],
  tracks: FiducialTrackVersion[],
  excludedFrameIds: Set<string>,
): EffectivePointSet {
  const members: string[] = [];
  const excluded = [...excludedFrameIds].sort();
  for (const frame of frames) {
    if (!frame.present || excludedFrameIds.has(frame.frameId)) continue;
    for (const track of tracks) {
      const obs = track.observations.find((o) => o.frameId === frame.frameId);
      if (obs) members.push(`${frame.frameId}|${track.trackId}`);
    }
  }
  members.sort();
  return {
    members,
    hash: hashString(members.join(",")),
    excludedFrames: excluded,
  };
}

/**
 * 规则：不同候选用相同有效点集比较，不用少帧换低残差。
 * 点集不一致 -> incomparable，并指出是谁少用了帧。
 */
export function compareCandidates(
  a: AlignmentCandidateBody,
  b: AlignmentCandidateBody,
): { comparable: boolean; betterId: string | null; reasons: string[] } {
  const reasons: string[] = [];
  if (a.effectivePointSet.hash !== b.effectivePointSet.hash) {
    const onlyA = a.effectivePointSet.members.filter(
      (m) => !b.effectivePointSet.members.includes(m),
    );
    const onlyB = b.effectivePointSet.members.filter(
      (m) => !a.effectivePointSet.members.includes(m),
    );
    reasons.push("effective-point-set-mismatch");
    if (onlyA.length) reasons.push(`points-only-in:${a.candidateId}=${onlyA.length}`);
    if (onlyB.length) reasons.push(`points-only-in:${b.candidateId}=${onlyB.length}`);
    reasons.push("no-trading-fewer-frames-for-lower-residual");
    return { comparable: false, betterId: null, reasons };
  }
  // 相同点集上比较：先看 held-out（防局部形变过拟合），再看训练残差
  const aBetter = a.heldOutRmsPx < b.heldOutRmsPx - 1e-6;
  const bBetter = b.heldOutRmsPx < a.heldOutRmsPx - 1e-6;
  if (!aBetter && !bBetter) {
    if (Math.abs(a.trainRmsPx - b.trainRmsPx) < 1e-6) {
      reasons.push("tie-multiple-solutions-kept");
      return { comparable: true, betterId: null, reasons };
    }
    return {
      comparable: true,
      betterId: a.trainRmsPx < b.trainRmsPx ? a.candidateId : b.candidateId,
      reasons: ["decided-by-train-rms-on-identical-point-set"],
    };
  }
  return {
    comparable: true,
    betterId: aBetter ? a.candidateId : b.candidateId,
    reasons: ["decided-by-held-out-rms-on-identical-point-set"],
  };
}

interface Obs {
  frameId: string;
  trackId: string;
  u: number;
  v: number;
}

function collectObservations(input: FitInput): Obs[] {
  const obs: Obs[] = [];
  const presentFrames = new Set(
    input.frames.filter((f) => f.present && !input.excludedFrameIds.has(f.frameId)).map((f) => f.frameId),
  );
  for (const track of input.tracks) {
    for (const o of track.observations) {
      if (presentFrames.has(o.frameId)) {
        obs.push({ frameId: o.frameId, trackId: track.trackId, u: o.xPx, v: o.yPx });
      }
    }
  }
  return obs;
}

/**
 * 拟合：给定轴线 (phi, x0, y0)，求每个 fiducial 的 3D 坐标与每帧平移（线性）。
 * 局部形变额外为每帧吸收 4 参数残差校正（等价控制点网格），自由度显著增加。
 */
export function fitCandidate(input: FitInput): AlignmentCandidateBody {
  const diagnostics: string[] = [];
  const epsilon = 1e-6;
  if (input.axis.centerAssumed) {
    diagnostics.push("tilt-axis-must-not-default-to-image-center");
  }
  if (
    Math.abs(input.axis.x0Px - 0) < epsilon &&
    Math.abs(input.axis.y0Px - 0) < epsilon
  ) {
    diagnostics.push("tilt-axis-position-is-zero-origin-check");
  }

  const allObs = collectObservations(input);
  const trackIds = [...new Set(allObs.map((o) => o.trackId))].sort();
  const frameIds = [...new Set(allObs.map((o) => o.frameId))].sort(
    (a, b) => frameIndex(a) - frameIndex(b),
  );

  // 训练 / 保留集划分（确定性，按 frameId|trackId 哈希选 1/5 观测做 held-out）
  const heldOut = new Set<string>();
  for (const key of allObs.map((o) => `${o.frameId}|${o.trackId}`).sort()) {
    if (hashString(key).charCodeAt(0) % 5 === 0) heldOut.add(key);
  }
  const trainObs = allObs.filter((o) => !heldOut.has(`${o.frameId}|${o.trackId}`));

  const phi = input.axis.phiDeg;
  const x0 = input.axis.x0Px;
  const y0 = input.axis.y0Px;

  // 设计矩阵列：每轨迹 3 个 3D 坐标 + 每帧 2 个平移。
  // U、V 方程拼接成一个线性最小二乘一次求解（对 X,Y,Z 联合约束）。
  const colOfTrack = new Map(trackIds.map((t, i) => [t, i * 3]));
  const colOfFrame = new Map(frameIds.map((f, i) => [f, trackIds.length * 3 + i * 2]));
  const nCols = trackIds.length * 3 + frameIds.length * 2;
  const Abig: number[][] = [];
  const bbig: number[] = [];
  const cp = Math.cos(phi * DEG);
  const sp = Math.sin(phi * DEG);
  for (const o of trainObs) {
    const theta = input.tiltAnglesDeg[o.frameId];
    const ct = Math.cos(theta * DEG);
    const st = Math.sin(theta * DEG);
    const tc = colOfTrack.get(o.trackId)!;
    const fc = colOfFrame.get(o.frameId)!;
    const ru = new Array(nCols).fill(0);
    ru[tc] = cp * ct; ru[tc + 1] = -sp; ru[tc + 2] = cp * st; ru[fc] = 1;
    Abig.push(ru); bbig.push(o.u - x0);
    const rv = new Array(nCols).fill(0);
    rv[tc] = sp * ct; rv[tc + 1] = cp; rv[tc + 2] = sp * st; rv[fc + 1] = 1;
    Abig.push(rv); bbig.push(o.v - y0);
  }
  const { x: params, residual: trainResid } = leastSquares(Abig, bbig);

  // 局部形变：每帧再吸收一个 4 参数残差仿射校正（仅作用于训练集），
  // 训练残差被人为压低；held-out 不受益甚至变差 -> 暴露过拟合。
  let localBoost = 0;
  if (input.kind === "local_deformation") {
    localBoost = frameIds.length * 4;
    for (let i = 0; i < trainResid.length; i++) trainResid[i] *= 0.35;
  }

  function predict(o: Obs): { u: number; v: number } {
    const tc = colOfTrack.get(o.trackId)!;
    const X = params[tc];
    const Y = params[tc + 1];
    const Z = params[tc + 2];
    const fc = colOfFrame.get(o.frameId)!;
    const tx = params[fc];
    const ty = params[fc + 1];
    return project(X, Y, Z, input.tiltAnglesDeg[o.frameId], phi, x0, y0, tx, ty);
  }

  const trainRmsPx = rms(trainResid);

  // held-out 残差（不参与拟合的观测）
  const holdResid: number[] = [];
  for (const o of allObs.filter((o) => heldOut.has(`${o.frameId}|${o.trackId}`))) {
    const pred = predict(o);
    holdResid.push(pred.u - o.u, pred.v - o.v);
  }
  const heldOutRmsPx = rms(holdResid);

  // 每帧残差
  const byFrame = new Map<string, number[]>();
  for (let i = 0; i < trainObs.length; i++) {
    const o = trainObs[i];
    const arr = byFrame.get(o.frameId) ?? [];
    const k = i * 2;
    arr.push(trainResid[k], trainResid[k + 1]);
    byFrame.set(o.frameId, arr);
  }
  const frameResiduals: Record<string, FrameResidual> = {};
  for (const f of frameIds) {
    const arr = byFrame.get(f) ?? [];
    frameResiduals[f] = {
      frameId: f,
      rmsPx: rms(arr),
      maxPx: arr.length ? Math.max(...arr.map(Math.abs)) : 0,
      usedPoints: arr.length / 2,
    };
  }

  const effectivePointSet = buildEffectivePointSet(
    input.frames,
    input.tracks,
    input.excludedFrameIds,
  );

  let status: AlignmentCandidateBody["status"] = "legal";
  if (input.kind === "local_deformation") {
    // 过拟合判据：自由度高且 held-out 明显差于训练
    const dofRatio = localBoost / Math.max(1, trainObs.length * 2);
    if (heldOutRmsPx > trainRmsPx * 1.35 || dofRatio > 0.25) {
      status = "overfit";
      diagnostics.push(
        `local-deformation-overfit:heldout=${heldOutRmsPx.toFixed(3)}px>train*1.35`,
      );
    }
  }

  return {
    candidateId: input.candidateId,
    kind: input.kind,
    label: input.label,
    axis: input.axis,
    degreesOfFreedom: nCols + localBoost,
    localWarp: input.localWarp,
    effectivePointSet,
    frameResiduals,
    trainRmsPx,
    heldOutRmsPx,
    status,
    diagnostics,
  };
}

function frameIndex(frameId: string): number {
  const m = frameId.match(/F-(\d+)/);
  return m ? Number(m[1]) : 999;
}

/**
 * 轨迹身份交换检测：缺口两侧 (fromFrame, toFrame) 的观测若更符合对方轨迹的
 * 3D 模型，且残差异常尖峰，则标记 swapped。
 */
export function detectIdentitySwaps(
  candidate: AlignmentCandidateBody,
  swapSuspects: { trackId: string; fromFrameId: string; toFrameId: string }[],
): { trackId: string; fromFrameId: string; toFrameId: string; evidence: string }[] {
  const found: { trackId: string; fromFrameId: string; toFrameId: string; evidence: string }[] = [];
  for (const s of swapSuspects) {
    const before = candidate.frameResiduals[s.fromFrameId];
    const after = candidate.frameResiduals[s.toFrameId];
    if (!before || !after) continue;
    // 缺口后第一帧残差尖峰即身份交换证据（配合显式 continuity=swapped）
    if (after.maxPx > before.maxPx * 1.8 && after.maxPx > 2.5) {
      found.push({
        ...s,
        evidence: `post-gap residual spike ${after.maxPx.toFixed(2)}px vs ${before.maxPx.toFixed(2)}px`,
      });
    }
  }
  return found;
}

/** 生成带相关噪声的合成观测（仅离线案例包构建时使用） */
export function synthesizeObservation(opts: {
  X: number; Y: number; Z: number;
  thetaDeg: number; phiDeg: number; x0: number; y0: number;
  tx: number; ty: number; noiseSigma: number; rng: () => number;
}): { u: number; v: number } {
  const p = project(opts.X, opts.Y, opts.Z, opts.thetaDeg, opts.phiDeg, opts.x0, opts.y0, opts.tx, opts.ty);
  return { u: p.u + gaussian(opts.rng) * opts.noiseSigma, v: p.v + gaussian(opts.rng) * opts.noiseSigma };
}
