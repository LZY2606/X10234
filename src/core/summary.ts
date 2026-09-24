import type { EntityKind } from './types';

/** 每个显示值带稳定身份时使用的简短内容摘要。 */
export function summarize(kind: EntityKind, payload: any): string {
  switch (kind) {
    case 'frame':
      return `frame#${payload.frame_index} ${payload.width}x${payload.height} ${payload.hash_sha256.slice(0, 12)}`;
    case 'tilt_angle':
      return `tilt frame#${payload.frame_index} raw=${payload.angle.raw}${payload.angle.unit}`;
    case 'pixel_scale':
      return `pixel_scale ${payload.scale.raw}${payload.scale.unit}${payload.scope === 'series' ? ' series' : ` frame#${payload.scope.frame_index}`}`;
    case 'exposure_dose':
      return `dose frame#${payload.frame_index} raw=${payload.dose.raw}${payload.dose.unit}`;
    case 'fiducial_observation':
      return `obs frame#${payload.frame_index} label=${payload.observed_label} (${payload.x},${payload.y})px`;
    case 'tracking_gap':
      return `gap track=${payload.track_id} frames ${payload.first_missing_frame}-${payload.last_missing_frame}`;
    case 'manual_exclusion':
      return `exclusion ${payload.target_kind} ${payload.reason_code} by ${payload.reviewer}`;
    case 'tilt_axis':
      return `axis anchor=(${payload.anchor_x.toFixed(1)},${payload.anchor_y.toFixed(1)}) dir=${payload.direction_deg.toFixed(2)}deg${payload.assumed_centered ? ' ASSUMED-CENTER' : ''}${payload.ambiguous ? ' AMBIGUOUS' : ''}`;
    case 'fiducial_track':
      return `track ${payload.track_id} seg${payload.segment_index} frames ${payload.frame_from}-${payload.frame_to}${payload.broken ? ' BROKEN' : ''}`;
    case 'track_identity_swap':
      return `swap frame#${payload.frame_index} ${payload.track_a}<->${payload.track_b}`;
    case 'registration_candidate':
      return `candidate ${payload.candidate_id} ${payload.model} frames=${payload.effective_frame_set.length} rms=${payload.summary_rms_residual_px.toFixed(3)}px [${payload.status}]`;
    case 'candidate_residual':
      return `residual ${payload.candidate_id} frame#${payload.frame_index} ${payload.residual_px.toFixed(3)}px${payload.excluded ? ' EXCLUDED' : ''}`;
    case 'adjudication':
      return `adjudication ${payload.decision} [${payload.candidate_ids.join(',')}] by ${payload.reviewer}`;
    case 'registration_lock':
      return `lock ${payload.active ? 'ACTIVE' : 'RELEASED'} -> ${payload.candidate_id}`;
    case 'rule_set':
      return `rules ${payload.rule_set_id} v-embedded`;
    case 'study':
      return `study ${payload.study_id} ${payload.name}`;
    case 'scenario_case':
      return `case ${payload.case_id} ${payload.scenario}/${payload.kind}`;
    default:
      return `${kind}`;
  }
}
