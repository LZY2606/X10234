// 领域词汇直接建模：不把一切压成 name/value。
export type SourceKind =
  | 'raw_frames'
  | 'tilt_angles'
  | 'pixel_scale'
  | 'dose'
  | 'fiducial_coordinates'
  | 'tracking_gaps'
  | 'exclusion_reasons'

export const SOURCE_KINDS: SourceKind[] = [
  'raw_frames',
  'tilt_angles',
  'pixel_scale',
  'dose',
  'fiducial_coordinates',
  'tracking_gaps',
  'exclusion_reasons'
]

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  raw_frames: '原始帧',
  tilt_angles: '倾角',
  pixel_scale: '像素尺度',
  dose: '曝光剂量',
  fiducial_coordinates: '标记点坐标',
  tracking_gaps: '跟踪缺口',
  exclusion_reasons: '手工排除原因'
}

export type Engine = 'rigid' | 'local_deform' | 'exclude_bad'

export const ENGINE_LABELS: Record<Engine, string> = {
  rigid: '刚体配准',
  local_deform: '局部形变',
  exclude_bad: '排除坏帧'
}

// 各配准引擎实际消费的来源种类 —— 失效范围按此依赖图计算。
export const ENGINE_DEPENDENCIES: Record<Engine, SourceKind[]> = {
  rigid: ['raw_frames', 'tilt_angles', 'pixel_scale', 'fiducial_coordinates', 'tracking_gaps'],
  local_deform: ['raw_frames', 'tilt_angles', 'pixel_scale', 'dose', 'fiducial_coordinates', 'tracking_gaps'],
  exclude_bad: ['raw_frames', 'tilt_angles', 'pixel_scale', 'fiducial_coordinates', 'tracking_gaps', 'exclusion_reasons']
}

export type ScenarioName =
  | 'axis_eccentricity'
  | 'trajectory_identity_swap'
  | 'missing_high_tilt'
  | 'bad_frame_exclusion'
  | 'local_deformation_overfit'
  | 'multi_solution'
  | 'concurrent_freeze'

export const SCENARIOS: ScenarioName[] = [
  'axis_eccentricity',
  'trajectory_identity_swap',
  'missing_high_tilt',
  'bad_frame_exclusion',
  'local_deformation_overfit',
  'multi_solution',
  'concurrent_freeze'
]

export const SCENARIO_LABELS: Record<ScenarioName, string> = {
  axis_eccentricity: '轴线偏心',
  trajectory_identity_swap: '轨迹身份交换',
  missing_high_tilt: '缺失高倾角帧',
  bad_frame_exclusion: '坏帧排除',
  local_deformation_overfit: '局部形变过拟合',
  multi_solution: '多解',
  concurrent_freeze: '并发冻结'
}

export interface SourceVersionRef {
  sourceId: string
  kind: SourceKind
  versionNo: number
  digest: string
}

export interface DomainEvent {
  seq: number
  id: string
  branchId: string | null
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface ConflictInfo {
  error: 'VERSION_CONFLICT'
  branchId: string
  expectedHead: number
  actualHead: number
  incoming: { action: string; candidateId: string; rationale: string }
  current: { lastEvent: DomainEvent | null; candidateStatus: Record<string, string> }
  diff: string[]
}

export class VersionConflict extends Error {
  constructor(public info: ConflictInfo) {
    super('版本冲突：另一窗口已提交新裁定')
  }
}

export class CorruptionError extends Error {
  constructor(public missing: { kind: string; id: string; digest: string }[]) {
    super(`CORRUPT: 缺少引用内容 ${missing.map((m) => `${m.kind}:${m.id}#${m.digest.slice(0, 12)}`).join(', ')}`)
  }
}
