// Domain quantities for cryo-EM tilt series.
// Import layer stores the raw representation verbatim; only the derived layer
// asks for a canonical value.  Values that cannot be converted stay in place
// with a diagnostic instead of being dropped or guessed.

export type QuantityKind = 'angle' | 'pixelScale' | 'dose';

export interface Quantity {
  kind: QuantityKind;
  rawText: string;
  rawUnit: string;
  value: number | null;
  unit: CanonicalUnit | 'unconvertible';
  diagnostic?: string;
}

export type CanonicalUnit = 'deg' | 'nm/px' | 'e/A^2';

const UNIT_PATTERN = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([^0-9.\s][^\s]*)?\s*$/;

function normUnitToken(token: string): string {
  return token
    .replace(/[μµ]/g, 'u')
    .replace(/[ÅÅ]/g, 'A')
    .replace(/[−–]/g, '-')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// factor maps a recognised unit token to the canonical unit of that kind.
const ANGLE: Record<string, number> = { deg: 1, degree: 1, degrees: 1, rad: 180 / Math.PI };
const PIXEL_SCALE: Record<string, number> = {
  'nm/px': 1,
  'nm/pixel': 1,
  'a/px': 0.1,
  'angstrom/px': 0.1,
  'a/pixel': 0.1,
  'um/px': 1000,
  'um/pixel': 1000
};
const DOSE: Record<string, number> = {
  'e/a^2': 1,
  'e-/a^2': 1,
  'e/a2': 1,
  'electrons/a^2': 1,
  'e/nm^2': 0.01,
  'e/nm2': 0.01,
  'e-/nm^2': 0.01,
  'e/um^2': 1e-6
};

function lookup(kind: QuantityKind, token: string): number | undefined {
  if (kind === 'angle') return ANGLE[token];
  if (kind === 'pixelScale') return PIXEL_SCALE[token];
  return DOSE[token];
}

const CANONICAL: Record<QuantityKind, CanonicalUnit> = {
  angle: 'deg',
  pixelScale: 'nm/px',
  dose: 'e/A^2'
};

export function parseQuantity(rawText: string, kind: QuantityKind): Quantity {
  const text = String(rawText);
  const match = UNIT_PATTERN.exec(text);
  if (!match) {
    return {
      kind,
      rawText: text,
      rawUnit: '',
      value: null,
      unit: 'unconvertible',
      diagnostic: `quantity/not-a-number: cannot parse "${text}" as ${kind}`
    };
  }
  const num = Number(match[1]);
  const rawUnit = match[2] ?? '';
  const token = normUnitToken(rawUnit);
  const factor = token === '' ? undefined : lookup(kind, token);
  if (factor === undefined) {
    return {
      kind,
      rawText: text,
      rawUnit,
      value: null,
      unit: 'unconvertible',
      diagnostic: `quantity/unknown-unit: "${rawUnit || '(none)'}" is not a known ${kind} unit`
    };
  }
  return {
    kind,
    rawText: text,
    rawUnit,
    value: num * factor,
    unit: CANONICAL[kind]
  };
}

// Image coordinates always carry their coordinate basis.  Derived layers use
// this rather than assuming an origin or a physical unit.
export interface ImagePoint {
  x: number;
  y: number;
  basis: 'image-pixels';
  origin: 'top-left';
}

export function px(x: number, y: number): ImagePoint {
  return { x, y, basis: 'image-pixels', origin: 'top-left' };
}
