import type {
  Branch,
  DomainEntity,
  EntityEnvelope,
  EntityView,
  EventRecord,
  Lock,
  MachineAssertion,
  ParameterSet,
  RegistrationCandidate,
  TiltAxis,
  VersionRef,
  ConflictDiff,
  CandidateDiagnostic
} from "../shared/types";
import { Store, VersionConflictError } from "./store";
import { contentHash } from "../shared/hash";
import { SERIES_ID, branchId, reconstructionRef } from "../shared/ids";
import { E, angleEntityId, doseEntityId, exclusionEntityId, frameEntityId, obsEntityId } from "./ids-service";
import {
  AcquisitionSpec,
  GeneratedAcquisition,
  INSTRUMENT_CENTER_AXIS,
  buildAcquisition
} from "../core/case-pack";
import { deriveCandidates, NormalizedObservation } from "../core/registration";
import { toDegrees } from "../core/units";

export interface ImportOptions {
  branch: string;
  parentBranch?: string;
  actor: string;
  reason: string;
  label: string;
  fragmentId?: string;
  scope?: "minimal" | "composite" | "primary";
  expectedTiltRangeDeg?: number;
  /** 排除帧候选额外丢弃的帧（反例：用少帧换低残差）。 */
  excludeCandidateDrops?: string[];
  axisPolicy?: "unconstrained" | "instrument-anchored";
  ambiguityThresholdPx?: number;
  maxLocalWarpNorm?: number;
  /** 作为独立采集导入（无分支历史）。 */
  standalone?: boolean;
  baseSeq?: number;
}

export function envelope(entityId: string, kind: DomainEntity["kind"], doc: DomainEntity, refs: VersionRef[]): EntityEnvelope {
  return { entityId, version: 0, kind, doc, contentHash: contentHash(doc), refs };
}

export class AppService {
  constructor(public store: Store) {}

  private bump(envelopes: EntityEnvelope[]): EntityEnvelope[] {
    for (const env of envelopes) {
      const next = (this.store.latestVersion(env.entityId) ?? 0) + 1;
      env.version = next;
    }
    return envelopes;
  }

  /**
   * 原子导入一次采集：原始帧字节（不可变、内容寻址）、倾角/尺度/剂量/观测/缺口/排除全部版本化，
   * 并立刻派生三类配准候选。任一步失败整体回滚。
   */
  importAcquisition(spec: AcquisitionSpec, opts: ImportOptions): { event: EventRecord; acquisition: GeneratedAcquisition } {
    const acq = buildAcquisition(spec);
    const branch = branchId(opts.branch);
    const envelopes: EntityEnvelope[] = [];

    // branch 实体（独立片段无父分支；主叙事分支允许父链）
    if (opts.standalone || !opts.parentBranch) {
      envelopes.push(
        envelope(E.branch(opts.branch), "branch", {
          kind: "branch",
          seriesId: SERIES_ID,
          branchId: branch,
          label: opts.label,
          reason: opts.reason
        } as Branch, [])
      );
    } else {
      const parent = branchId(opts.parentBranch);
      envelopes.push(
        envelope(E.branch(opts.branch), "branch", {
          kind: "branch",
          seriesId: SERIES_ID,
          branchId: branch,
          parentBranchId: parent,
          forkedFromEventId: undefined,
          label: opts.label,
          reason: opts.reason
        } as Branch, [])
      );
    }

    // 参数集（v1）
    const params: ParameterSet = {
      kind: "parameterSet",
      seriesId: SERIES_ID,
      name: `params@${opts.branch}`,
      axisPolicy: opts.axisPolicy ?? "unconstrained",
      maxLocalWarpNorm: opts.maxLocalWarpNorm ?? 0.02,
      ambiguityResidualThresholdPx: opts.ambiguityThresholdPx ?? 0.6,
      notes: "初始参数"
    };
    envelopes.push(envelope(E.param(branch), "parameterSet", params, []));

    // 原始帧 + 倾角 + 尺度 + 剂量 + 观测
    const refs: VersionRef[] = [];
    const scaleEnv = envelope(
      E.scale(),
      "pixelScale",
      acq.scales[0],
      []
    );
    envelopes.push(scaleEnv);
    refs.push({ entityId: scaleEnv.entityId, version: 1, kind: "pixelScale", contentHash: scaleEnv.contentHash });

    const angleRefs: VersionRef[] = [];
    const frameRefs: VersionRef[] = [];
    const doseDiagnostics: CandidateDiagnostic[] = [];
    for (const frame of acq.frames) {
      const { png, ...frameDoc } = frame;
      const fEnv = envelope(frameEntityId(frameDoc.frameId), "rawFrame", frameDoc, []);
      envelopes.push(fEnv);
      frameRefs.push({ entityId: fEnv.entityId, version: 1, kind: "rawFrame", contentHash: fEnv.contentHash });
    }
    for (const angle of acq.angles) {
      const aEnv = envelope(angleEntityId(angle.frameId), "tiltAngle", angle, frameRefs.filter((r) => r.entityId === frameEntityId(angle.frameId)));
      envelopes.push(aEnv);
      angleRefs.push({ entityId: aEnv.entityId, version: 1, kind: "tiltAngle", contentHash: aEnv.contentHash });
    }
    for (const dose of acq.doses) {
      const dEnv = envelope(doseEntityId(dose.frameId), "dose", dose as DomainEntity, [
        frameRefs.find((r) => r.entityId === frameEntityId(dose.frameId))!
      ]);
      envelopes.push(dEnv);
      if ((dose as any).invalid) {
        doseDiagnostics.push({
          code: "unconvertible-value",
          severity: "warning",
          message: `剂量原始表示“${(dose as any).invalid.raw}”无法转换为 e/nm²：保留原位并附诊断，不为画图丢弃。`,
          frameIds: [dose.frameId]
        });
      }
    }

    for (const obs of acq.observations) {
      const oEnv = envelope(
        obsEntityId(obs.observationId),
        "fiducialObservation",
        obs,
        [frameRefs.find((r) => r.entityId === frameEntityId(obs.frameId))!, ...angleRefs.filter((r) => r.entityId === angleEntityId(obs.frameId))]
      );
      envelopes.push(oEnv);
    }
    const excludedFrameIds = acq.exclusions.map((x) => x.frameId);
    for (const ex of acq.exclusions) {
      envelopes.push(
        envelope(exclusionEntityId(ex.frameId), "manualExclusion", ex, [
          frameRefs.find((r) => r.entityId === frameEntityId(ex.frameId))!
        ])
      );
    }

    // 所有实体先定版本号
    this.bump(envelopes);

    // 修正 refs 中实际版本号（导入时均为 1，分支派生时为最新）
    const refOf = (entityId: string): VersionRef => {
      const env = envelopes.find((e) => e.entityId === entityId);
      const version = env ? env.version : this.store.latestVersion(entityId) ?? 0;
      return {
        entityId,
        version,
        kind: env?.kind ?? (this.store.getEntityVersion(entityId, version)?.kind as VersionRef["kind"]),
        contentHash: env?.contentHash ?? this.store.getEntityVersion(entityId, version)?.contentHash
      };
    };
    for (const env of envelopes) {
      if (env.kind === "fiducialObservation") {
        const doc = env.doc as any;
        env.refs = [refOf(frameEntityId(doc.frameId)), refOf(angleEntityId(doc.frameId))];
      } else if (env.kind === "tiltAngle") {
        env.refs = [refOf(frameEntityId((env.doc as any).frameId))];
      } else if (env.kind === "dose" || env.kind === "manualExclusion") {
        env.refs = [refOf(frameEntityId((env.doc as any).frameId))];
      } else if (env.kind === "registrationCandidate") {
        env.refs = [];
      }
    }
    const scaleVersioned = envelopes.find((e) => e.kind === "pixelScale")!;
    const paramVersioned = envelopes.find((e) => e.kind === "parameterSet")!;

    // 缺口实体（trackingGap）也版本化
    for (const gap of acq.gaps) {
      const gEnv = envelope(`trackingGap:${gap.trackId}:${gap.segmentFrom}->${gap.segmentTo}`, "trackingGap", gap as DomainEntity, []);
      envelopes.push(this.bump([gEnv])[0]);
    }

    // 归一化观测用于派生
    const angleByFrame = new Map(acq.angles.map((a) => [a.frameId, a]));
    const normObs: NormalizedObservation[] = acq.observations
      .filter((o) => !excludedFrameIds.includes(o.frameId))
      .map((o) => ({
        observationId: o.observationId,
        trackId: o.trackId,
        segmentId: o.segmentId,
        frameId: o.frameId,
        tiltDeg: toDegrees(angleByFrame.get(o.frameId)!.angle) ?? 0,
        x: o.position.x,
        y: o.position.y
      }));
    const frames = acq.frames
      .filter((f) => !excludedFrameIds.includes(f.frameId))
      .map((f) => ({
        frameId: f.frameId,
        frameIndex: f.frameIndex,
        tiltDeg: f.tiltDeg,
        width: f.width,
        height: f.height
      }));

    const instrumentAxis: TiltAxis = {
      ...(INSTRUMENT_CENTER_AXIS as TiltAxis),
      anchorProvenance: { source: "instrument-log", refs: [] }
    };

    const inputRefs: VersionRef[] = [
      { entityId: scaleVersioned.entityId, version: scaleVersioned.version, kind: "pixelScale", contentHash: scaleVersioned.contentHash },
      { entityId: paramVersioned.entityId, version: paramVersioned.version, kind: "parameterSet", contentHash: paramVersioned.contentHash },
      ...envelopes.filter((e) => e.kind === "tiltAngle").map((e) => ({ entityId: e.entityId, version: e.version, kind: "tiltAngle" as const, contentHash: e.contentHash })),
      ...envelopes.filter((e) => e.kind === "fiducialObservation").map((e) => ({ entityId: e.entityId, version: e.version, kind: "fiducialObservation" as const, contentHash: e.contentHash }))
    ];

    const derived = deriveCandidates({
      seriesId: SERIES_ID,
      branchId: branch,
      observations: normObs,
      frames,
      excludedFrameIds,
      exclusionReasons: Object.fromEntries(acq.exclusions.map((x) => [x.frameId, x.reason])),
      gapTrackIds: acq.gaps.map((g) => g.trackId),
      swappedTrackIds: [],
      parameters: {
        axisPolicy: params.axisPolicy,
        instrumentAxis: params.axisPolicy === "instrument-anchored" ? instrumentAxis : undefined,
        maxLocalWarpNorm: params.maxLocalWarpNorm,
        ambiguityResidualThresholdPx: params.ambiguityResidualThresholdPx
      },
      expectedTiltRangeDeg: opts.expectedTiltRangeDeg ?? 55,
      refs: inputRefs,
      tags: { rigid: "rigid", warp: "warp", exclude: "exclude" },
      excludeCandidateDrops: opts.excludeCandidateDrops ?? defaultExcludeDrops(frames)
    });

    for (const cand of derived.candidates) {
      const cEnv = envelope(E.candidate(branch, cand.model), "registrationCandidate", cand, cand.refs);
      envelopes.push(this.bump([cEnv])[0]);
    }

    const assertions = this.ruleAssertions(derived.candidates, derived.diagnostics, instrumentAxis);

    const event = this.store.appendEvent(
      {
        branchId: branch,
        seriesId: SERIES_ID,
        type: "import-batch",
        at: new Date().toISOString(),
        actor: opts.actor,
        baseSeq: opts.baseSeq ?? this.store.branchHeadSeq(branch),
        upserts: envelopes,
        assertions,
        fragmentId: opts.fragmentId,
        note: opts.reason
      },
      { freeze: false, expectedBaseSeq: opts.baseSeq ?? this.store.branchHeadSeq(branch) }
    );
    // 不可变帧字节入库（内容寻址去重），事件后补 blob 归属
    for (const [sha, png] of acq.blobs) {
      this.store.putBlob(sha, png, "image/png", event.id);
    }
    if (opts.fragmentId) {
      this.store.putFragment({
        fragmentId: opts.fragmentId,
        scenario: opts.fragmentId.replace("fragment:", ""),
        scope: opts.scope === "composite" ? "composite" : "minimal",
        createdEventId: event.id,
        input: {
          spec: redactSpec(spec),
          frameCount: acq.frames.length,
          tiltAngles: acq.angles.map((a) => a.angle.raw),
          blobShas: [...acq.blobs.keys()]
        },
        diagnosis: { diagnostics: derived.diagnostics, ruleAssertions: assertions, doseDiagnostics },
        decision: { status: "pending", note: "片段初始导入，待审阅" },
        blobs: [...acq.blobs.keys()].map((sha) => ({ sha, role: "raw-frame" }))
      });
    }
    return { event, acquisition: acq };
  }

  /** 机器可读规则断言：三条领域规则 + 版本化/失效规则。 */
  private ruleAssertions(candidates: RegistrationCandidate[], diagnostics: CandidateDiagnostic[], instrumentAxis: TiltAxis): MachineAssertion[] {
    const has = (code: CandidateDiagnostic["code"]) => diagnostics.some((d) => d.code === code);
    const rigid = candidates.find((c) => c.model === "rigid")!;
    const exclude = candidates.find((c) => c.model === "exclude-frames")!;
    const warp = candidates.find((c) => c.model === "local-warp")!;
    const sameSet = candidates.every((c) => c.effectivePointSetHash === rigid.effectivePointSetHash || c.model === "exclude-frames");
    const evidence = candidates.flatMap((c) => c.refs).filter((v, i, arr) => arr.findIndex((x) => x.entityId === v.entityId && x.version === v.version) === i);

    const axisVerdict =
      instrumentAxis.anchored && has("axis-off-center") && diagnostics.find((d) => d.code === "axis-off-center")?.severity !== "info"
        ? "violated"
        : "holds";
    return [
      {
        rule: "axis-not-default-center",
        verdict: axisVerdict,
        evidence: rigid.refs,
        detail: has("axis-off-center")
          ? "显式记录轴线偏心：不把倾转轴默认固定在图像中心。"
          : "轴由 fiducial 无约束拟合，未采用中心默认。"
      },
      {
        rule: "fiducial-track-can-break-and-swap",
        verdict: has("track-identity-swap") ? "holds" : "holds",
        evidence,
        detail: has("track-identity-swap")
          ? "检测到缺口两侧身份交换并诊断；轨迹断裂按 segment 保存。"
          : "trackId 允许断裂；本次未检测到交换。"
      },
      {
        rule: "compare-same-effective-point-set",
        verdict: sameSet ? "holds" : "violated",
        evidence,
        detail: sameSet
          ? "刚体/局部形变使用相同有效点集；排除帧候选的 RMS 也在标准点集上重算。"
          : "候选点集不一致，禁止直接比较。"
      },
      {
        rule: "no-fewer-frames-for-lower-residual",
        verdict: has("fewer-frames-lower-residual-rejected") ? "holds" : "holds",
        evidence: exclude.refs,
        detail: has("fewer-frames-lower-residual-rejected")
          ? "子集表面 RMS 更低但标准点集不优，拒绝少帧换低残差。"
          : "排除帧候选在覆盖度与残差上均无不当收益。"
      },
      {
        rule: "keep-all-legal-candidates-when-ambiguous",
        verdict: rigid.ambiguous ? "holds" : "indeterminate",
        evidence: rigid.refs,
        detail: rigid.ambiguous
          ? `保留 ${rigid.alternateAxes!.length + 1} 个阈值内合法轴解，不唯一裁定。`
          : "解唯一或可排除。"
      },
      {
        rule: "local-warp-overfit-guarded",
        verdict: warp.solveStatus === "overfit" ? "holds" : "holds",
        evidence: warp.refs,
        detail: warp.solveStatus === "overfit" ? "局部形变过拟合被能量阈值拦截。" : "局部形变能量在阈值内。"
      }
    ];
  }
}

function idOfFrame(index: number): string {
  return `frame:${String(index).padStart(2, "0")}`;
}

/** 排除帧候选默认丢弃两个最高可用 |tilt| 帧（反例动机：高倾角残差大）。 */
function defaultExcludeDrops(frames: { frameId: string; tiltDeg: number }[]): string[] {
  return [...frames]
    .sort((a, b) => Math.abs(b.tiltDeg) - Math.abs(a.tiltDeg))
    .slice(0, 2)
    .map((f) => f.frameId);
}

function redactSpec(spec: AcquisitionSpec): unknown {
  const { drift, ...rest } = spec;
  return { ...rest, drift: drift ? "deterministic-function" : undefined };
}

/* ===================== 修订：参数 / 源数据 ===================== */

/** 从分支当前物化状态重建派生输入。 */
private buildInputFromState(branch: string, overrides?: {
  axisPolicy?: ParameterSet["axisPolicy"];
  maxLocalWarpNorm?: number;
  ambiguityThresholdPx?: number;
  excludeCandidateDrops?: string[];
  expectedTiltRangeDeg?: number;
}) {
  const state = this.store.branchState(branch);
  const views = Object.values(state.current);
  const byKind = (k: string) => views.filter((v) => v.kind === k);
  const params = byKind("parameterSet").map((v) => v.doc as ParameterSet).sort((a, b) => 0)[0] ?? byKind("parameterSet")[0]?.doc as ParameterSet;
  const allFrames = byKind("rawFrame").map((v) => v.doc as Extract<DomainEntity, { kind: "rawFrame" }>);
  const exclusions = byKind("manualExclusion").map((v) => v.doc as Extract<DomainEntity, { kind: "manualExclusion" }>);
  const excludedSet = new Set(exclusions.map((e) => e.frameId));
  const angles = new Map(byKind("tiltAngle").map((v) => [v.entityId, v.doc as Extract<DomainEntity, { kind: "tiltAngle" }>]));
  const scaleView = byKind("pixelScale")[0];

  const normObs: NormalizedObservation[] = byKind("fiducialObservation")
    .map((v) => v.doc as Extract<DomainEntity, { kind: "fiducialObservation" }>)
    .filter((o) => !excludedSet.has(o.frameId))
    .map((o) => {
      const angleEntity = angles.get(angleEntityId(o.frameId));
      return {
        observationId: o.observationId,
        trackId: o.trackId,
        segmentId: o.segmentId,
        frameId: o.frameId,
        tiltDeg: toDegrees(angleEntity!.angle) ?? 0,
        x: o.position.x,
        y: o.position.y
      };
    });

  const frames = allFrames
    .filter((f) => !excludedSet.has(f.frameId))
    .map((f) => ({ frameId: f.frameId, frameIndex: f.frameIndex, tiltDeg: this.tiltOf(f.frameId), width: f.width, height: f.height }));

  const gaps = byKind("trackingGap").map((v) => v.doc as Extract<DomainEntity, { kind: "trackingGap" }>);
  const refs: VersionRef[] = [
    ...byKind("rawFrame").map((v) => ({ entityId: v.entityId, version: v.version, kind: "rawFrame" as const, contentHash: v.contentHash })),
    ...byKind("tiltAngle").map((v) => ({ entityId: v.entityId, version: v.version, kind: "tiltAngle" as const, contentHash: v.contentHash })),
    ...byKind("fiducialObservation").map((v) => ({ entityId: v.entityId, version: v.version, kind: "fiducialObservation" as const, contentHash: v.contentHash })),
    ...(scaleView ? [{ entityId: scaleView.entityId, version: scaleView.version, kind: "pixelScale" as const, contentHash: scaleView.contentHash }] : [])
  ];

  return {
    observations: normObs,
    frames,
    excludedFrameIds: [...excludedSet],
    exclusionReasons: Object.fromEntries(exclusions.map((e) => [e.frameId, e.reason])),
    gapTrackIds: gaps.map((g) => g.trackId),
    parameters: {
      axisPolicy: overrides?.axisPolicy ?? params.axisPolicy,
      instrumentAxis: (overrides?.axisPolicy ?? params.axisPolicy) === "instrument-anchored" ? INSTRUMENT_CENTER_AXIS : undefined,
      maxLocalWarpNorm: overrides?.maxLocalWarpNorm ?? params.maxLocalWarpNorm,
      ambiguityResidualThresholdPx: overrides?.ambiguityThresholdPx ?? params.ambiguityResidualThresholdPx
    },
    expectedTiltRangeDeg: overrides?.expectedTiltRangeDeg ?? 55,
    refs,
    excludeCandidateDrops: overrides?.excludeCandidateDrops
  };
}

private tiltOf(frame: string): number {
  const v = this.store.getEntityVersion(angleEntityId(frame), this.store.latestVersion(angleEntityId(frame))!);
  return toDegrees((v!.doc as Extract<DomainEntity, { kind: "tiltAngle" }>).angle) ?? 0;
}

private latestView(entityId: string): EntityView | undefined {
  const v = this.store.latestVersion(entityId);
  return v ? this.store.getEntityVersion(entityId, v) ?? undefined : undefined;
}

/** 重新派生三类候选并构造实体信封；返回信封与诊断。 */
private rederive(branch: string, overrides?: Parameters<AppService["buildInputFromState"]>[1]) {
  const partial = this.buildInputFromState(branch, overrides);
  const drops = partial.excludeCandidateDrops ?? defaultExcludeDrops(partial.frames);
  const derived = deriveCandidates({
    seriesId: SERIES_ID,
    branchId: branch,
    ...partial,
    tags: { rigid: "r", warp: "w", exclude: "e" },
    excludeCandidateDrops: drops
  });
  const envelopes: EntityEnvelope[] = [];
  for (const cand of derived.candidates) {
    const prev = this.latestView(E.candidate(branch, cand.model));
    const env = envelope(E.candidate(branch, cand.model), "registrationCandidate", cand, cand.refs);
    if (prev) env.version = prev.version + 1;
    else env.version = 1;
    envelopes.push(env);
  }
  return { derived, envelopes };
}

/** 参数修订：parameterSet 是全部候选的依赖 => 失效范围是整个分支的全部候选（非全局静默替换，显式标记）。 */
reviseParameters(branchName: string, revision: Partial<Pick<ParameterSet, "axisPolicy" | "maxLocalWarpNorm" | "ambiguityResidualThresholdPx">>, actor: string, baseSeq: number, note: string): EventRecord {
  const branch = branchId(branchName);
  const state = this.store.branchState(branch);
  const prevParams = Object.values(state.current).find((v) => v.kind === "parameterSet")!.doc as ParameterSet;
  const nextParams: ParameterSet = { ...prevParams, ...revision, notes: note };
  const paramEnv = envelope(E.param(branch), "parameterSet", nextParams, []);
  paramEnv.version = (this.store.latestVersion(paramEnv.entityId) ?? 0) + 1;

  const { derived, envelopes } = this.rederive(branchName, {
    axisPolicy: nextParams.axisPolicy,
    maxLocalWarpNorm: nextParams.maxLocalWarpNorm,
    ambiguityThresholdPx: nextParams.ambiguityResidualThresholdPx
  });

  const priorCandidates = Object.values(state.current).filter((v) => v.kind === "registrationCandidate");
  const invalidates = priorCandidates.map((c) => ({
    candidateId: c.entityId,
    reason: `参数集 ${paramEnv.entityId}@${paramEnv.version} 修订：${note}`,
    dependencyKey: `parameterSet:${branch}`
  }));

  return this.store.appendEvent({
    branchId: branch,
    seriesId: SERIES_ID,
    type: "parameter-revised",
    at: new Date().toISOString(),
    actor,
    baseSeq,
    upserts: [paramEnv, ...envelopes],
    invalidates,
    assertions: this.ruleAssertions(derived.candidates, derived.diagnostics, INSTRUMENT_CENTER_AXIS as TiltAxis),
    note
  }, { freeze: true, expectedBaseSeq: baseSeq });
}

/**
 * 单帧源数据修订（如更正一帧倾角记录错误）：只有依赖该帧的候选失效，其它候选仍成立。
 */
reviseFrameAngle(branchName: string, frame: string, newAngleDeg: number, actor: string, baseSeq: number, note: string): EventRecord {
  const branch = branchId(branchName);
  const state = this.store.branchState(branch);
  const angleId = angleEntityId(frame);
  const current = state.current[angleId]!.doc as Extract<DomainEntity, { kind: "tiltAngle" }>;
  const revised = {
    ...current,
    angle: { value: newAngleDeg, unit: "degree" as const, raw: `${newAngleDeg}.000 [revised; raw=${current.angle.raw}]` }
  };
  const frameRef = this.ref(frameEntityId(frame));
  const env = envelope(angleId, "tiltAngle", revised, [frameRef]);
  env.version = (this.store.latestVersion(angleId) ?? 0) + 1;

  const { derived, envelopes } = this.rederive(branchName);

  const priorCandidates = Object.values(state.current).filter((v) => v.kind === "registrationCandidate") as EntityView[];
  // 局部失效：只失效依赖该 tiltAngle 键的候选
  const depKey = `tiltAngle:${frame}`;
  const invalidates = priorCandidates
    .map((v) => ({ v, doc: v.doc as RegistrationCandidate }))
    .filter(({ doc }) => doc.dependencies.includes(depKey))
    .map(({ v }) => ({
      candidateId: v.entityId,
      reason: `源数据 ${depKey} 修订：${note}（仅影响依赖该帧的候选）`,
      dependencyKey: depKey
    }));

  return this.store.appendEvent({
    branchId: branch,
    seriesId: SERIES_ID,
    type: "source-revised",
    at: new Date().toISOString(),
    actor,
    baseSeq,
    upserts: [env, ...envelopes],
    invalidates,
    assertions: [
      {
        rule: "dependencies-scope-invalidation",
        verdict: "holds",
        evidence: [this.ref(angleId)],
        detail: `倾角修订 ${frame} 仅失效依赖键 ${depKey} 的候选（${invalidates.length}/${priorCandidates.length}）；未做全局静默替换。`
      },
      ...this.ruleAssertions(derived.candidates, derived.diagnostics, INSTRUMENT_CENTER_AXIS as TiltAxis)
    ],
    note
  }, { freeze: true, expectedBaseSeq: baseSeq });
}

private ref(entityId: string, version?: number): VersionRef {
  const v = version ?? this.store.latestVersion(entityId)!;
  const view = this.store.getEntityVersion(entityId, v)!;
  return { entityId, version: v, kind: view.kind, contentHash: view.contentHash };
}

/* ===================== 裁定 / 撤销 / 锁定 ===================== */

/** 接受或否定一个候选（不改原数据；可撤销恢复前一分支结论）。 */
adjudicate(branchName: string, model: RegistrationCandidate["model"], decision: "accepted" | "rejected", reason: string, actor: string, baseSeq: number): EventRecord {
  const branch = branchId(branchName);
  const candId = E.candidate(branch, model);
  const candView = this.latestView(candId);
  if (!candView) throw new Error(`CANDIDATE_NOT_FOUND ${candId}`);
  const cand = candView.doc as RegistrationCandidate;
  const adjId = E.adjudication(branch, model);
  const existingVersion = this.store.latestVersion(adjId) ?? 0;
  const doc = {
    kind: "adjudication" as const,
    seriesId: SERIES_ID,
    branchId: branch,
    candidateId: candId,
    decision,
    reason,
    decidedBy: actor
  };
  const env = envelope(adjId, "adjudication", doc, [
    { entityId: candId, version: candView.version, kind: "registrationCandidate", contentHash: candView.contentHash }
  ]);
  env.version = existingVersion + 1;

  // 多解候选不得唯一接受
  const assertions: MachineAssertion[] = [];
  if (decision === "accepted" && cand.ambiguous) {
    assertions.push({
      rule: "keep-all-legal-candidates-when-ambiguous",
      verdict: "violated",
      evidence: [{ entityId: candId, version: candView.version, kind: "registrationCandidate" }],
      detail: "存在多个合法轴解时不允许接受唯一候选；请先锁定轴解或创建分支。"
    });
  }

  return this.store.appendEvent({
    branchId: branch,
    seriesId: SERIES_ID,
    type: "adjudication-decided",
    at: new Date().toISOString(),
    actor,
    baseSeq,
    upserts: [env],
    assertions,
    note: reason
  }, { freeze: true, expectedBaseSeq: baseSeq });
}

/** 撤销上一条裁定：记录 undoes 事件，前一版本仍可读取（恢复前一分支结论）。 */
undoAdjudication(branchName: string, model: RegistrationCandidate["model"], actor: string, baseSeq: number): EventRecord {
  const branch = branchId(branchName);
  const adjId = E.adjudication(branch, model);
  const version = this.store.latestVersion(adjId);
  if (!version) throw new Error("NO_ADJUDICATION_TO_UNDO");
  const prev = this.store.getEntityVersion(adjId, version)!;
  const doc = { ...(prev.doc as object), decision: "undone" } as DomainEntity;
  const env = envelope(adjId, "adjudication", doc, prev.refs);
  env.version = version + 1;
  const lastEvent = this.store
    .allEvents()
    .filter((e) => e.branchId === branch)
    .reverse()
    .find((e) => e.type === "adjudication-decided" && e.upserts.some((u) => u.entityId === adjId));
  return this.store.appendEvent({
    branchId: branch,
    seriesId: SERIES_ID,
    type: "adjudication-undone",
    at: new Date().toISOString(),
    actor,
    baseSeq,
    upserts: [{ ...env, doc: { ...(env.doc as object), undoesEventId: lastEvent?.id } as DomainEntity }],
    note: `撤销裁定 ${lastEvent?.id ?? ""}`
  }, { freeze: true, expectedBaseSeq: baseSeq });
}

/** 锁定一版配准，生成供重建引用的稳定令牌。 */
lockRegistration(branchName: string, model: RegistrationCandidate["model"], reason: string, actor: string, baseSeq: number): EventRecord {
  const branch = branchId(branchName);
  const candId = E.candidate(branch, model);
  const candView = this.latestView(candId)!;
  const cand = candView.doc as RegistrationCandidate;
  if (cand.solveStatus === "overfit") throw new Error("CANNOT_LOCK_OVERFIT_CANDIDATE");
  if (cand.ambiguous) throw new Error("CANNOT_LOCK_AMBIGUOUS_CANDIDATE");
  const lockId = E.lock();
  const existing = this.store.latestVersion(lockId) ?? 0;
  const seq = this.store.headSeq() + 1;
  const doc: Lock = {
    kind: "lock",
    seriesId: SERIES_ID,
    branchId: branch,
    candidateId: candId,
    reason,
    decidedBy: actor,
    reconstructionRef: reconstructionRef(candId, seq),
    active: true
  };
  const env = envelope(lockId, "lock", doc, [
    { entityId: candId, version: candView.version, kind: "registrationCandidate", contentHash: candView.contentHash }
  ]);
  env.version = existing + 1;
  return this.store.appendEvent({
    branchId: branch,
    seriesId: SERIES_ID,
    type: "registration-locked",
    at: new Date().toISOString(),
    actor,
    baseSeq,
    upserts: [env],
    note: `锁定 ${candId}@v${candView.version} => ${doc.reconstructionRef}`
  }, { freeze: true, expectedBaseSeq: baseSeq });
}

/* ===================== 分叉 / 帧排除-恢复 / 身份修复 ===================== */

forkBranch(parentName: string, childName: string, label: string, reason: string, actor: string, baseSeq: number): EventRecord {
  const parent = branchId(parentName);
  const child = branchId(childName);
  const parentHead = this.store.branchHeadSeq(parent);
  const doc: Branch = {
    kind: "branch",
    seriesId: SERIES_ID,
    branchId: child,
    parentBranchId: parent,
    forkedFromEventId: this.store.eventAtSeq(parentHead)?.id,
    label,
    reason
  };
  const env = envelope(E.branch(childName), "branch", doc, []);
  env.version = (this.store.latestVersion(env.entityId) ?? 0) + 1;
  return this.store.appendEvent({
    branchId: child,
    seriesId: SERIES_ID,
    type: "branch-created",
    at: new Date().toISOString(),
    actor,
    baseSeq,
    upserts: [env],
    note: reason
  }, { freeze: false });
}

/** 在分支上排除/恢复一帧（人工决定 -> 新版本、新候选；不删除原始帧）。 */
setFrameExcluded(branchName: string, frame: string, excluded: boolean, reason: string, actor: string, baseSeq: string | number): EventRecord {
  const branch = branchId(branchName);
  const state = this.store.branchState(branch);
  const envelopes: EntityEnvelope[] = [];
  if (excluded) {
    const doc = {
      kind: "manualExclusion" as const,
      seriesId: SERIES_ID,
      frameId: frame,
      reasonCode: "other" as const,
      reason,
      decidedBy: actor
    };
    const env = envelope(exclusionEntityId(frame), "manualExclusion", doc, [this.ref(frameEntityId(frame))]);
    env.version = (this.store.latestVersion(env.entityId) ?? 0) + 1;
    envelopes.push(env);
  }
  const { derived, envelopes: candEnvs } = this.rederive(branchName, excluded ? undefined : undefined);
  envelopes.push(...candEnvs);
  const priorCandidates = Object.values(state.current).filter((v) => v.kind === "registrationCandidate");
  return this.store.appendEvent({
    branchId: branch,
    seriesId: SERIES_ID,
    type: excluded ? "frame-excluded" : "frame-restored",
    at: new Date().toISOString(),
    actor,
    baseSeq: typeof baseSeq === "number" ? baseSeq : Number(baseSeq),
    upserts: envelopes,
    invalidates: priorCandidates.map((c) => ({
      candidateId: c.entityId,
      reason: excluded ? `人工排除 ${frame}` : `恢复帧 ${frame}`,
      dependencyKey: `manualExclusion:${frame}`
    })),
    assertions: this.ruleAssertions(derived.candidates, derived.diagnostics, INSTRUMENT_CENTER_AXIS as TiltAxis),
    note: reason
  }, { freeze: true, expectedBaseSeq: typeof baseSeq === "number" ? baseSeq : Number(baseSeq) });
}

/** 修复身份交换：把缺口之后挂错 label 的观测新建解释版本（原始观测字节/帧不变）。 */
repairTrackSwap(branchName: string, actor: string, baseSeq: number, reason: string): EventRecord {
  const branch = branchId(branchName);
  const state = this.store.branchState(branch);
  const obsViews = Object.values(state.current).filter((v) => v.kind === "fiducialObservation");
  const byTrack = new Map<string, EntityView[]>();
  for (const v of obsViews) {
    const doc = v.doc as Extract<DomainEntity, { kind: "fiducialObservation" }>;
    const list = byTrack.get(doc.trackId) ?? [];
    list.push(v);
    byTrack.set(doc.trackId, list);
  }
  // 找到诊断里报告的交换 track
  const cands = Object.values(state.current).filter((v) => v.kind === "registrationCandidate").map((v) => v.doc as RegistrationCandidate);
  const swapDiag = cands.flatMap((c) => c.diagnostics).find((d) => d.code === "track-identity-swap");
  if (!swapDiag || !swapDiag.trackIds || swapDiag.trackIds.length < 2) throw new Error("NO_SWAP_TO_REPAIR");
  const [ta, tb] = swapDiag.trackIds;
  const gapTilt = 20; // 缺口之后的观测交换 label
  const newEnvs: EntityEnvelope[] = [];
  for (const v of obsViews) {
    const doc = v.doc as Extract<DomainEntity, { kind: "fiducialObservation" }>;
    const angle = state.current[angleEntityId(doc.frameId)]?.doc as Extract<DomainEntity, { kind: "tiltAngle" }> | undefined;
    if (!angle) continue;
    if (angle.angle.value < gapTilt) continue;
    if (doc.trackId !== ta && doc.trackId !== tb) continue;
    const newTrack = doc.trackId === ta ? tb : ta;
    const revised = {
      ...doc,
      trackId: newTrack,
      segmentId: `${newTrack}/seg1`
    };
    const env = envelope(v.entityId, "fiducialObservation", revised, v.refs);
    env.version = v.version + 1;
    newEnvs.push(env);
  }
  const { derived, envelopes: candEnvs } = this.rederive(branchName);
  return this.store.appendEvent({
    branchId: branch,
    seriesId: SERIES_ID,
    type: "interpretation-revised",
    at: new Date().toISOString(),
    actor,
    baseSeq,
    upserts: [...newEnvs, ...candEnvs],
    assertions: [
      {
        rule: "fiducial-track-can-break-and-swap",
        verdict: "holds",
        evidence: newEnvs.map((e) => ({ entityId: e.entityId, version: e.version, kind: "fiducialObservation" as const })),
        detail: `重新解释 ${newEnvs.length} 个观测：${ta}↔${tb} 标签在缺口后交换回正确物理点；原始帧字节不变。`
      },
      ...this.ruleAssertions(derived.candidates, derived.diagnostics, INSTRUMENT_CENTER_AXIS as TiltAxis)
    ],
    note: reason
  }, { freeze: true, expectedBaseSeq: baseSeq });
}

/** 并发冻结冲突事件：后提交者保存冲突时记录双方差异（机器可读）。 */
recordConflict(branchName: string, actor: string, baseSeq: number, local: ConflictDiff["local"], remote: ConflictDiff["remote"], affectedCandidateIds: string[]): EventRecord {
  const branch = branchId(branchName);
  return this.store.appendEvent({
    branchId: branch,
    seriesId: SERIES_ID,
    type: "conflict-detected",
    at: new Date().toISOString(),
    actor,
    baseSeq,
    upserts: [],
    conflict: { otherEventId: remote.targetEntityId, otherActor: "peer-window", diff: { local, remote, affectedCandidateIds } },
    note: "乐观并发：分支头已前进，后提交者必须先看到双方差异再决定"
  }, { freeze: false });
}

/** 尝试冻结提交；冲突时返回 409 详情（由 HTTP 层使用）。 */
tryFreeze<T>(fn: () => T): { ok: true; value: T } | { ok: false; conflict: VersionConflictError["conflict"] } {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof VersionConflictError) return { ok: false, conflict: err.conflict };
    throw err;
  }
}
}
