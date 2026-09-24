/** 稳定身份：所有显示值都带稳定身份，导出/删除/重导入后保持不变。 */

export const ID_PREFIX = {
  archive: "arc",
  branch: "br",
  frame: "frm",
  frameContent: "blob",
  revision: "rev",
  track: "trk",
  segment: "seg",
  gap: "gap",
  exclusion: "excl",
  marker: "mk",
  candidate: "cand",
  adjudication: "adj",
  lock: "lock",
  event: "evt",
  rules: "rules"
} as const;

let counter = 0;

export function newId(kind: keyof typeof ID_PREFIX): string {
  counter = (counter + 1) % 0xffff;
  const rand = Math.random().toString(16).slice(2, 10);
  const time = Date.now().toString(36);
  return `${ID_PREFIX[kind]}-${time}-${rand}${counter.toString(16).padStart(4, "0")}`;
}

/** 确定性身份：案例包与测试用，保证重放可断言。 */
export function deterministicId(kind: keyof typeof ID_PREFIX, seed: string): string {
  return `${ID_PREFIX[kind]}-${simpleHash(seed)}`;
}

export function simpleHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
