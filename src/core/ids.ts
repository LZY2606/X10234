let counter = 0;

export function stableId(prefix: string, material: string): string {
  counter += 1;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(36).padStart(4, '0');
  return `${prefix}_${material}_${time}${rand}${counter.toString(36)}`;
}

export function deterministicId(prefix: string, parts: (string | number)[]): string {
  return `${prefix}_${parts.join('_')}`;
}

export function eventId(seq: number): string {
  return `evt_${seq.toString(10).padStart(6, '0')}`;
}
