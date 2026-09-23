let counter = 0;

export function rid(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function resetIdCounterForTest(value = 0): void {
  counter = value;
}
