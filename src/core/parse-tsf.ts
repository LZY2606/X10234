// Parser for .tsf (Tilt-Stitch Fragment) plates.
// The original representation of every value is preserved; normalization is
// a separate derived step. Unconvertible values stay in place with a diagnostic.
import type {
  ParsedPlate,
  AngleRecord,
  PixelScaleRecord,
  DoseRecord,
  FiducialObservation,
  GapRecord,
  SwapRecord,
  ExclusionRecord,
  AxisRecord
} from './model.js';

export interface EmbeddedImage {
  name: string;
  bytes: Uint8Array;
}

export interface TsfParseResult {
  plate: ParsedPlate;
  embeddedImages: EmbeddedImage[];
}

function toAngleDeg(rawValue: string, rawUnit: string): { valueDeg?: number; unit: string; diagnostic?: string } {
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return { unit: 'unknown', diagnostic: `unparseable tilt angle "${rawValue}"` };
  if (rawUnit === 'deg' || rawUnit === 'degree' || rawUnit === 'degrees') return { valueDeg: n, unit: 'degree' };
  if (rawUnit === 'rad' || rawUnit === 'radian' || rawUnit === 'radians') return { valueDeg: (n * 180) / Math.PI, unit: 'radian' };
  return { unit: 'unknown', diagnostic: `unconvertible tilt unit "${rawUnit}", raw value retained` };
}

function toAngstromPerPx(rawValue: string, rawUnit: string, binning: number | undefined): { v?: number; diagnostic?: string } {
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return { diagnostic: `unparseable pixel scale "${rawValue}"` };
  let base = n;
  if (rawUnit === 'A/px' || rawUnit === 'angstrom/pixel') base = n;
  else if (rawUnit === 'nm/px') base = n * 10;
  else return { diagnostic: `unconvertible pixel scale unit "${rawUnit}", raw value retained` };
  return { v: binning ? base * binning : base };
}

function toDose(rawValue: string, rawUnit: string): { v?: number; diagnostic?: string } {
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return { diagnostic: `unparseable dose "${rawValue}"` };
  if (rawUnit === 'e-/A^2') return { v: n };
  if (rawUnit === 'e-/nm^2') return { v: n / 100 };
  return { diagnostic: `unconvertible dose unit "${rawUnit}", raw value retained` };
}

export function parseTsf(text: string): TsfParseResult {
  const lines = text.split(/\r?\n/);
  const plate: ParsedPlate = {
    seriesSlug: '',
    title: '',
    coordinateFrame: 'pixel_center_upper_left',
    frames: [],
    angles: [],
    doses: [],
    fiducials: [],
    gaps: [],
    swaps: [],
    exclusions: [],
    unconvertible: []
  };
  const embeddedImages: EmbeddedImage[] = [];

  let inImage = false;
  let imageName = '';
  const imageBuf: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (inImage) {
      if (line === 'END_IMAGE') {
        embeddedImages.push({ name: imageName, bytes: new TextEncoder().encode(imageBuf.join('\n')) });
        inImage = false;
        imageName = '';
        imageBuf.length = 0;
      } else {
        imageBuf.push(rawLine);
      }
      continue;
    }

    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1).trim();
    const fields = rest ? splitFields(rest) : [];
    const rawRepr = rest;

    try {
      switch (key) {
        case 'TSF_VERSION':
          if (!rest.startsWith('1.')) throw new Error(`unsupported TSF_VERSION ${rest}`);
          break;
        case 'SERIES':
          plate.seriesSlug = fields[0] ?? '';
          break;
        case 'TITLE':
          plate.title = rest.replace(/^"|"$/g, '');
          break;
        case 'COORDINATE_FRAME':
          plate.coordinateFrame = rest;
          break;
        case 'FRAME': {
          const ordinal = Number(fields[0]);
          const imageFile = stripQuotes(fields[1] ?? '');
          plate.frames.push({ ordinal, imageName: imageFile });
          break;
        }
        case 'ANGLE': {
          const ordinal = Number(fields[0]);
          const rawValue = fields[1] ?? '';
          const rawUnit = fields[2] ?? '';
          const direction = fields[3] ?? 'unsigned';
          const conv = toAngleDeg(rawValue, rawUnit);
          const rec: AngleRecord = {
            frameOrdinal: ordinal,
            rawValue,
            unit: conv.unit,
            valueDeg: conv.valueDeg,
            direction
          };
          if (conv.diagnostic) {
            rec.diagnostic = conv.diagnostic;
            plate.unconvertible.push({ lineNo: i + 1, line, diagnostic: conv.diagnostic });
          }
          plate.angles.push(rec);
          break;
        }
        case 'PIXEL_SCALE': {
          const rawValue = fields[0] ?? '';
          const rawUnit = fields[1] ?? '';
          const basis = fields[2] ?? 'image_pixel';
          const binning = fields[3] ? Number(fields[3]) : undefined;
          const conv = toAngstromPerPx(rawValue, rawUnit, binning);
          const rec: PixelScaleRecord = {
            rawValue,
            rawUnit,
            coordinateBasis: basis,
            binning
          };
          if (conv.v !== undefined) rec.angstromPerPx = conv.v;
          if (conv.diagnostic) {
            rec.diagnostic = conv.diagnostic;
            plate.unconvertible.push({ lineNo: i + 1, line, diagnostic: conv.diagnostic });
          }
          plate.pixelScale = rec;
          break;
        }
        case 'DOSE': {
          const ordinal = Number(fields[0]);
          const rawValue = fields[1] ?? '';
          const rawUnit = fields[2] ?? '';
          const conv = toDose(rawValue, rawUnit);
          const rec: DoseRecord = { frameOrdinal: ordinal, rawValue, rawUnit };
          if (conv.v !== undefined) rec.electronsPerAngstrom2 = conv.v;
          if (conv.diagnostic) {
            rec.diagnostic = conv.diagnostic;
            plate.unconvertible.push({ lineNo: i + 1, line, diagnostic: conv.diagnostic });
          }
          plate.doses.push(rec);
          break;
        }
        case 'FIDUCIAL': {
          const rec: FiducialObservation = {
            label: fields[0] ?? '',
            frameOrdinal: Number(fields[1]),
            xPx: Number(fields[2]),
            yPx: Number(fields[3])
          };
          if (!Number.isFinite(rec.xPx) || !Number.isFinite(rec.yPx)) {
            throw new Error(`unparseable fiducial coordinate: ${rawRepr}`);
          }
          plate.fiducials.push(rec);
          break;
        }
        case 'GAP': {
          const rec: GapRecord = {
            label: fields[0] ?? '',
            frameOrdinal: Number(fields[1]),
            reasonCode: fields[2] ?? 'untracked'
          };
          plate.gaps.push(rec);
          break;
        }
        case 'SWAP': {
          const rec: SwapRecord = {
            labelA: fields[0] ?? '',
            labelB: fields[1] ?? '',
            betweenOrdinal: Number(fields[2]),
            confidence: (fields[3] === 'confirmed' ? 'confirmed' : 'ambiguous')
          };
          plate.swaps.push(rec);
          break;
        }
        case 'EXCLUDE': {
          const rec: ExclusionRecord = {
            frameOrdinal: Number(fields[0]),
            reasonCode: fields[1] ?? 'unknown',
            reasonDetail: stripQuotes(fields.slice(2).join(' ')),
            author: 'microscopy_team'
          };
          plate.exclusions.push(rec);
          break;
        }
        case 'AXIS': {
          // AXIS angle_deg pivot pivot_x pivot_y  OR  AXIS angle_deg center_assumed
          const angleDeg = Number(fields[0]);
          if (fields[1] === 'center_assumed') {
            const rec: AxisRecord = {
              angleDeg, pivotXPx: undefined, pivotYPx: undefined,
              assumedCenter: true, eccentricityKnown: false,
              rawRepr,
              diagnostic: 'tilt axis pivot defaulted to image center without evidence'
            };
            plate.axis = rec;
          } else if (fields[1] === 'pivot') {
            plate.axis = {
              angleDeg,
              pivotXPx: Number(fields[2]),
              pivotYPx: Number(fields[3]),
              assumedCenter: false,
              eccentricityKnown: true,
              rawRepr
            };
          } else {
            plate.axis = {
              angleDeg, pivotXPx: undefined, pivotYPx: undefined,
              assumedCenter: false, eccentricityKnown: false, rawRepr,
              diagnostic: 'tilt axis pivot unknown; must not be replaced by image center'
            };
          }
          break;
        }
        case 'BEGIN_IMAGE':
          inImage = true;
          imageName = stripQuotes(rest);
          break;
        default:
          plate.unconvertible.push({ lineNo: i + 1, line, diagnostic: `unknown directive "${key}" retained` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      plate.unconvertible.push({ lineNo: i + 1, line, diagnostic: message });
    }
  }

  return { plate, embeddedImages };
}

function splitFields(rest: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of rest) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (/\s/.test(ch) && !inQuote) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function stripQuotes(s: string): string {
  return s.replace(/^"|"$/g, '');
}
