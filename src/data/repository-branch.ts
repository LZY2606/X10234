import type { Database } from './db';
import { queryAll, queryOne } from './db';
import { stableId, nowIso } from '../domain/ids';
import { appendEvent } from './repository-import';
import type { Branch, TiltAxis, FiducialTrack } from '../domain/types';

export class RevisionConflict extends Error {
  expected: number;
  actual: number;
  diff: unknown;
  constructor(expected: number, actual: number, diff: unknown) {
    super(`revision conflict: expected ${expected}, current ${actual}`);
    this.name = 'RevisionConflict';
    this.expected = expected;
    this.actual = actual;
    this.diff = diff;
  }
}

export function getBranch(db: Database, branchId: string): Branch | null {
  const row = queryOne(db, `SELECT * FROM branches WHERE branch_id=$id`, { $id: branchId });
  if (!row) return null;
  return {
    branchId: String(row.branch_id), tiltSeriesId: String(row.tilt_series_id),
    parentBranchId: (row.parent_branch_id as string) ?? null, name: String(row.name),
    forkEventId: (row.fork_event_id as string) ?? null, headEventId: (row.head_event_id as string) ?? null,
    createdAtIso: String(row.created_at_iso), revision: Number(row.revision), frozen: !!row.frozen
  };
}

export function listBranches(db: Database, tiltSeriesId: string): Branch[] {
  return queryAll(db, `SELECT * FROM branches WHERE tilt_series_id=$id ORDER BY created_at_iso`,
    { $id: tiltSeriesId }).map((r) => getBranch(db, String(r.branch_id))!);
}

/** 对同一份材料重新解释时新建分支；旧分支、裁定与原始字节继续可读。 */
export function forkBranch(
  db: Database,
  args: { tiltSeriesId: string; name: string; parentBranchId?: string | null; author?: string; forkEventId?: string | null }
): Branch {
  const parentId = args.parentBranchId ?? null;
  const branchId = stableId('br', args.tiltSeriesId, args.name, parentId ?? 'root');
  const existing = getBranch(db, branchId);
  if (existing) return existing;
  const createdAt = nowIso();
  db.run(
    `INSERT INTO branches(branch_id,tilt_series_id,parent_branch_id,name,fork_event_id,head_event_id,revision,frozen,created_at_iso)
     VALUES($id,$ts,$par,$nm,$fk,NULL,1,0,$at)`,
    { $id: branchId, $ts: args.tiltSeriesId, $par: parentId, $nm: args.name, $fk: args.forkEventId ?? null, $at: createdAt }
  );
  const evt = appendEvent(db, {
    code: 'branch.fork', branchId, atIso: createdAt, author: args.author ?? 'reviewer',
    refs: [{ ref: branchId, version: 1, kind: 'branch', summary: `fork branch ${args.name}` },
           ...(parentId ? [{ ref: parentId, version: 1, kind: 'branch', summary: 'parent branch' }] : [])],
    rationaleCodes: [], payload: { tiltSeriesId: args.tiltSeriesId, name: args.name, parentBranchId: parentId }
  });
  db.run(`UPDATE branches SET fork_event_id=$fk, head_event_id=$h, revision=revision+1 WHERE branch_id=$id`,
    { $fk: evt.eventId, $h: evt.eventId, $id: branchId });
  return getBranch(db, branchId)!;
}

export function saveAxis(db: Database, axis: TiltAxis, author = 'reviewer'): void {
  const evt = appendEvent(db, {
    code: 'interpret.tilt-axis', branchId: axis.branchId, atIso: nowIso(), author,
    refs: [{ ref: axis.branchId, version: 1, kind: 'branch', summary: `axis basis=${axis.basis}` }],
    rationaleCodes: axis.basis === 'unresolved'
      ? ['AXIS_NOT_CENTER_DEFAULT']
      : ['AXIS_NOT_CENTER_DEFAULT'],
    payload: { orientationDeg: axis.orientationDeg, interceptXPx: axis.interceptXPx,
               basis: axis.basis, originFrameSeq: axis.originFrameSeq,
               evidenceMarkerIds: axis.evidenceMarkerIds, unresolvedReason: axis.unresolvedReason ?? null }
  });
  db.run(
    `INSERT INTO tilt_axis_interpretations(branch_id,event_id,orientation_deg,intercept_x_px,basis,origin_frame_seq,evidence_json,unresolved_reason)
     VALUES($b,$e,$o,$i,$ba,$fr,$ev,$un)`,
    { $b: axis.branchId, $e: evt.eventId, $o: axis.orientationDeg, $i: axis.interceptXPx,
      $ba: axis.basis, $fr: axis.originFrameSeq, $ev: JSON.stringify(axis.evidenceMarkerIds),
      $un: axis.unresolvedReason ?? null }
  );
  advanceHead(db, axis.branchId, evt.eventId);
}

export function saveTracks(db: Database, branchId: string, tracks: FiducialTrack[], author = 'reviewer'): string {
  const broken = tracks.some((t) => t.status === 'broken' || t.segments.length > 1);
  const swapped = tracks.some((t) => t.status === 'swapped' || t.swappedWith);
  const ambiguous = tracks.some((t) => t.status === 'ambiguous' || t.possibleIdentities.length > 1);
  const rationaleCodes = [
    ...(broken ? ['TRACK_CAN_BREAK' as const] : []),
    ...(swapped ? ['TRACK_IDENTITY_CAN_SWAP' as const] : []),
    ...(ambiguous ? ['KEEP_ALL_LEGAL_CANDIDATES' as const] : [])
  ];
  const evt = appendEvent(db, {
    code: 'interpret.tracks', branchId, atIso: nowIso(), author,
    refs: [{ ref: branchId, version: 1, kind: 'branch', summary: `tracks=${tracks.length}` }],
    rationaleCodes,
    payload: { tracks: tracks.map((t) => ({ markerId: t.markerId, status: t.status,
      segments: t.segments, swappedWith: t.swappedWith, possibleIdentities: t.possibleIdentities })) }
  });
  for (const t of tracks) {
    db.run(
      `INSERT INTO track_interpretations(branch_id,event_id,marker_id,status,segments_json,swapped_with,possible_identities_json)
       VALUES($b,$e,$mk,$st,$sg,$sw,$pi)`,
      { $b: branchId, $e: evt.eventId, $mk: t.markerId, $st: t.status,
        $sg: JSON.stringify(t.segments), $sw: t.swappedWith, $pi: JSON.stringify(t.possibleIdentities) }
    );
  }
  advanceHead(db, branchId, evt.eventId);
  return evt.eventId;
}

/** 乐观并发：expectedRevision 不匹配时抛 RevisionConflict（后提交者看到冲突与双方差异）。 */
export function advanceHead(db: Database, branchId: string, eventId: string, expectedRevision?: number): number {
  if (expectedRevision !== undefined) {
    const cur = getBranch(db, branchId);
    if (!cur) throw new Error(`unknown branch ${branchId}`);
    if (cur.revision !== expectedRevision) {
      const diff = diffBranchState(db, branchId, expectedRevision, cur.revision);
      throw new RevisionConflict(expectedRevision, cur.revision, diff);
    }
  }
  db.run(`UPDATE branches SET head_event_id=$h, revision=revision+1 WHERE branch_id=$id`,
    { $h: eventId, $id: branchId });
  return getBranch(db, branchId)!.revision;
}

function diffBranchState(db: Database, branchId: string, revA: number, revB: number) {
  const evs = queryAll<{ seq: number; code: string; payload_json: string }>(
    db, `SELECT seq,code,payload_json FROM events WHERE branch_id=$b ORDER BY seq`, { $b: branchId });
  // 简化但真实可用：以修订号为界切分事件，展示双方各提交了什么
  const pivot = Math.min(revA, revB);
  return {
    branchId, expectedRevision: revA, currentRevision: revB,
    eventsSinceExpected: evs.slice(Math.max(0, pivot - 1)).map((e) => ({ seq: e.seq, code: e.code })),
    theirEvents: evs.slice(Math.max(0, revB - revA)).map((e) => ({ seq: e.seq, code: e.code })),
    note: '另一窗口已提交；请 rebase 后重放你的裁定，禁止静默覆盖'
  };
}
