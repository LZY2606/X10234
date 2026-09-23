import { ArchiveStore } from "../db/store";
import type {
  DossierEntry,
  IdentitySwap,
  ManualFrameExclusion,
  RegistrationParameters,
  TrackGap,
} from "../../shared/types";
import { contentId } from "../../shared/ids";
import { qty } from "../../shared/units";
import { buildCandidate, compareCandidates, estimateTiltAxis, resolveTrackIdentities } from "../../shared/registration";
import { DEFAULT_TILT_ANGLES, generateFrames, type SynthConfig } from "./synth-frames";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RuleVersion } from "../../shared/types";

/**
 * 固定案例包：倾转帧拼合室。
 * 叙事：电镜小组导入倾转序列、曝光剂量与 fiducial 轨迹，
 * 比较刚体 / 局部形变 / 排除坏帧三类方案，并走完七种反例情形。
 */

export const CASE_CODES = [
  "axis-eccentric",
  "identity-swap",
  "missing-high-tilt",
  "bad-frame-exclusion",
  "local-warp-overfit",
  "multi-solution",
  "concurrent-freeze",
] as const;

export interface BuildResult {
  store: ArchiveStore;
  caseDir: string;
  summary: Record<string, unknown>;
}

function baseConfig(overrides?: Partial<SynthConfig>): SynthConfig {
  return {
    width: 128,
    height: 96,
    // 轴线刻意偏离中心 (64,48)
    axisAnchor: { x: 40, y: 30 },
    axisDirectionDeg: 88,
    anglesDeg: [...DEFAULT_TILT_ANGLES],
    beads: [
      { label: "A", x0: 30, y0: 24, z0: -10 },
      { label: "B", x0: 96, y0: 20, z0: 6 },
      { label: "C", x0: 64, y0: 70, z0: -4 },
      { label: "D", x0: 100, y0: 72, z0: 12 },
      { label: "E", x0: 20, y0: 60, z0: 2 },
    ],
    blurFrames: [21], // +50 度那帧
    ...overrides,
  };
}

export interface Seeded {
  store: ArchiveStore;
  commitId: string;
  frameIds: string[];
  branch: { id: string; name: string; ruleVersionId: string };
  rule: RuleVersion;
}

/** 初始导入：原始帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口、手工排除原因，全部版本化。 */
export function seedInitialSeries(store: ArchiveStore, opts: {
  config?: Partial<SynthConfig>;
  materialVersion?: string;
  rationale?: string;
  parentCommitId?: string | null;
  seqHint?: number;
  identitySwaps?: IdentitySwap[];
  excludeFrameReasons?: { angle: number; reasonCode: ManualFrameExclusion["reasonCode"]; reason: string }[];
  gaps?: { track: string; missingAngle: number; reason: TrackGap["reason"] }[];
  badDoseAngles?: number[];
  badScale?: boolean;
  idHint?: string;
  importedAt: string;
  labelPrefix?: string;
}): Seeded {
  const cfg = baseConfig(opts.config);
  const frames = generateFrames(cfg);
  const entityIds: string[] = [];
  const frameIds: string[] = [];
  const observations: { frameId: string; trackLabel: string; x: number; y: number }[] = [];

  for (const frame of frames) {
    const frameId = store.putBlob("RawFrameBytes", frame.pixels, `tilt_${String(frame.index).padStart(2, "0")}.uint8`, cfg.width, cfg.height);
    frameIds.push(frameId);
    entityIds.push(frameId);
  }

  const angleByFrame = new Map<string, number>();
  frames.forEach((frame, i) => {
    const tilt = {
      frameId: frameIds[i],
      indexOrder: frame.index,
      angle: qty(frame.angleDeg, "degree", `${frame.angleDeg}deg`),
      sourceLabel: "mdoc:TiltAngle",
    };
    const tiltId = store.putObject("TiltAngle", tilt);
    entityIds.push(tiltId);
    angleByFrame.set(frameIds[i], frame.angleDeg);

    const scaleValue = opts.badScale ? null : 1.12;
    const scale = {
      frameId: frameIds[i],
      indexOrder: frame.index,
      scale: opts.badScale
        ? qty(null, "px@mag22k", `scale mag 22000`)
        : qty(scaleValue, "nm/pixel", `1.12nm/px`),
      sourceLabel: "microscope:pixel-size",
    };
    const scaleId = store.putObject("PixelScale", scale);
    entityIds.push(scaleId);

    const cosineDose = 2.4 * Math.max(0.5, Math.cos((frame.angleDeg * Math.PI) / 180));
    const doseQty = (opts.badDoseAngles ?? []).includes(frame.angleDeg)
      ? qty(null, "e/A^2", "n/a (dosimeter glitch)")
      : qty(Number(cosineDose.toFixed(3)), "e/A^2", `${cosineDose.toFixed(3)} e/A^2`);
    const dose = {
      frameId: frameIds[i],
      indexOrder: frame.index,
      dose: doseQty,
      exposureSeconds: frame.angleDeg >= 50 ? 1.6 : 1.0,
      sourceLabel: "serialem:DoseRecord",
    };
    const doseId = store.putObject("FrameDose", dose);
    entityIds.push(doseId);

    for (const bead of frame.beadPixels) {
      const obs = {
        frameId: frameIds[i],
        trackLabel: bead.label,
        at: { basis: "raw-frame-pixels" as const, x: round(bead.x), y: round(bead.y) },
        sourceLabel: "imod:seed-and-track",
      };
      const obsId = store.putObject("FiducialObservation", obs);
      entityIds.push(obsId);
      observations.push({ frameId: frameIds[i], trackLabel: bead.label, x: round(bead.x), y: round(bead.y) });
    }
  });

  for (const gap of opts.gaps ?? []) {
    const missing = frames.filter((f) => f.angleDeg === gap.missingAngle).map((f) => frameIds[f.index]);
    const gapId = store.putObject("TrackGap", {
      trackLabel: gap.track,
      missingFrameIds: missing,
      reason: gap.reason,
      note: `${gap.track} 在 ${gap.missingAngle}° 丢失（${gap.reason}）`,
    });
    entityIds.push(gapId);
  }

  for (const exc of opts.excludeFrameReasons ?? []) {
    const idx = frames.findIndex((f) => f.angleDeg === exc.angle);
    if (idx < 0) continue;
    const id = store.putObject("ManualFrameExclusion", {
      frameId: frameIds[idx],
      reasonCode: exc.reasonCode,
      reason: exc.reason,
      decidedBy: "em-team",
    });
    entityIds.push(id);
  }

  const commit = store.createCommit({
    rationale: opts.rationale ?? "初始导入：电镜小组的 25 帧倾转序列、剂量与 fiducial 轨迹",
    materialVersion: opts.materialVersion ?? "material/2026-09-23-v1",
    parentCommitId: opts.parentCommitId ?? null,
    entityIds,
    importedAt: opts.importedAt,
    seqHint: opts.seqHint,
    idHint: opts.idHint,
  });

  const rule = makeRule(store, "rules/rigid-v1", rigidParams(false, []), opts.importedAt, "刚体基线：轴线由轨迹估计，禁止默认图像中心");
  const branch = store.createBranch({
    name: `${opts.labelPrefix ?? "initial"}-rigid`,
    commitId: commit.id,
    ruleVersionId: rule.id,
    createdAt: opts.importedAt,
  });
  return { store, commitId: commit.id, frameIds, branch, rule };
}

export function rigidParams(centerAssumed: boolean, droppedFrameIds: string[]): RegistrationParameters {
  return {
    model: "rigid",
    tiltAxis: {
      anchorX: centerAssumed ? 64 : null,
      anchorY: centerAssumed ? 48 : null,
      directionDeg: 0,
      assumedImageCenter: centerAssumed,
      estimationMethod: centerAssumed ? "image-center-assumption" : "track-pca-normal-search",
    },
    maxShiftPx: 14,
    warpGridSpacingPx: 24,
    warpDegreesOfFreedom: 8,
    droppedFrameIds,
  };
}

export function makeRule(
  store: ArchiveStore,
  version: string,
  parameters: RegistrationParameters,
  at: string,
  note: string,
): RuleVersion {
  return store.putRuleVersion({ version, parameters, note, createdAt: at });
}

export function buildCandidatesFor(store: ArchiveStore, seeded: Seeded, at: string, models: ("rigid" | "local-deform" | "rigid-drop-frames")[], knownSwaps: IdentitySwap[] = []) {
  const fullFrames = seeded.frameIds.map((fid, i) => {
    const content = store.getObject(fid)!.content as import("../../shared/types").RawFrame;
    return { ...content, id: fid, indexOrder: i };
  });
  const angles = seeded.frameIds.map((fid) => store.listByKind("TiltAngle").find((e) => (e.content as { frameId: string }).frameId === fid)!.content as import("../../shared/types").TiltAngle);
  const allObs = store.listByKind("FiducialObservation").map((e) => e.content as import("../../shared/types").FiducialObservation);
  const obs = allObs.filter((o) => seeded.frameIds.includes(o.frameId));
  const identity = resolveTrackIdentities({ frames: fullFrames, angles, observations: obs, knownSwaps });
  const axis = estimateTiltAxis({ frames: fullFrames, angles, observations: obs, identityMap: identity, imageCenterAssumption: false });

  return models.map((model, i) => {
    const rule = makeRule(
      store,
      `rules/${model}-v1`,
      {
        ...rigidParams(false, model === "rigid-drop-frames" ? store.listByKind("ManualFrameExclusion").map((e) => (e.content as ManualFrameExclusion).frameId) : []),
        model,
        tiltAxis: axis.axis,
      },
      at,
      `${model} 候选规则`,
    );
    const candidate = buildCandidate({
      frames: fullFrames,
      angles,
      observations: obs,
      params: rule.parameters,
      identityMap: identity,
      branchId: seeded.branch.id,
      ruleVersionId: rule.id,
      label: `candidate-${model}`,
      comparisonGroup: "fair-table",
    });
    store.putCandidate(candidate, seeded.branch.id);
    return candidate;
  });
}

function round(v: number) {
  return Math.round(v * 1000) / 1000;
}

/**
 * 写离线案例包到磁盘（仓库自带，启动时从 SQLite 读；这里同时导出 JSON 供审阅与离线检查）。
 */
export function writeCasePack(build: BuildResult) {
  mkdirSync(build.caseDir, { recursive: true });
  mkdirSync(join(build.caseDir, "objects"), { recursive: true });
  const bundle = build.store.exportBundle();
  writeFileSync(join(build.caseDir, "tilt-series-room.case.json"), JSON.stringify(bundle, null, 2));
  writeFileSync(
    join(build.caseDir, "case-manifest.json"),
    JSON.stringify(
      {
        title: "倾转帧拼合室：电镜 tilt-series 轴线、fiducial 轨迹与配准分支",
        format: bundle.format,
        generatedAt: build.summary.generatedAt,
        caseCodes: CASE_CODES,
        domainQuantities: "所有角度=degree、像素尺度=nm/pixel、剂量=e/A^2；导入保留原始 raw 表示，派生层才规范化",
        narrative: [
          "1. 初始导入并核对版本化材料",
          "2. 参数修订（刚体 -> 局部形变 -> 排除坏帧）",
          "3. 只影响局部依赖的源数据改动",
          "4. 互相冲突的人工决定（并发冻结）",
        ],
      },
      null,
      2,
    ),
  );
}
