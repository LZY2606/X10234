/** 稳定、可读的领域身份。 */
export const SERIES_ID = "tilt-series:demo-tomogram-01";

export function frameId(index: number): string {
  return `frame:${String(index).padStart(2, "0")}`;
}
export function trackId(n: number): string {
  return `fid:${String(n).padStart(2, "0")}`;
}
export function segmentId(track: string, seg: number): string {
  return `${track}/seg${seg}`;
}
export function obsId(track: string, frame: string): string {
  return `obs:${track}@${frame}`;
}
export function candidateId(model: string, tag: string): string {
  return `cand:${model}:${tag}`;
}
export function branchId(name: string): string {
  return `branch:${name}`;
}
export function reconstructionRef(candidate: string, lockSeq: number): string {
  return `recon://${SERIES_ID}/${candidate}@lock${lockSeq}`;
}
