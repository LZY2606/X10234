import type { EntityKind } from "../shared/types";
import { SERIES_ID } from "../shared/ids";

export function eid(kind: EntityKind, key: string): string {
  return `${kind}:${key}`;
}

export const E = {
  scale: () => eid("pixelScale", SERIES_ID),
  param: (branch: string) => eid("parameterSet", branch),
  axisPolicy: (branch: string) => eid("tiltAxis", branch),
  candidate: (branch: string, model: string) => eid("registrationCandidate", `${branch}:${model}`),
  adjudication: (branch: string, model: string) => eid("adjudication", `${branch}:${model}`),
  lock: () => eid("lock", SERIES_ID),
  branch: (name: string) => eid("branch", name)
};

export function frameEntityId(frame: string) {
  return eid("rawFrame", frame);
}
export function angleEntityId(frame: string) {
  return eid("tiltAngle", frame);
}
export function doseEntityId(frame: string) {
  return eid("dose", frame);
}
export function obsEntityId(obs: string) {
  return eid("fiducialObservation", obs);
}
export function exclusionEntityId(frame: string) {
  return eid("manualExclusion", frame);
}
