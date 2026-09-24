import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AlignmentCandidate,
  Branch,
  Event,
  EventBasis,
  EventType,
  Interpretation,
  LockedAlignment,
  SourceKind,
  SourceRecord,
  SourceVersionRef,
} tojson
} from "./domain.js";
