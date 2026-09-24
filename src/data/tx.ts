import type { Database } from './db';

/** 在事务中执行；抛错即整体回滚，不留下半份记录。 */
export function transaction<T>(db: Database, fn: () => T): T {
  db.run('BEGIN');
  try {
    const out = fn();
    db.run('COMMIT');
    return out;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

/** 模拟“导入失败”：写入部分源数据后抛出，确认无残留。 */
export function simulateFailingImport(db: Database, tiltSeriesId: string): never {
  transaction(db, () => {
    db.run(
      `INSERT INTO tilt_series(tilt_series_id,name,source_version,width_px,height_px,pixel_scale_json,sign_convention,created_at_iso)
       VALUES($id,$nm,1,4,4,'{}','s','t')`,
      { $id: tiltSeriesId, $nm: 'partial' }
    );
    db.run(
      `INSERT INTO frames(tilt_series_id,frame_seq,source_version,blob_sha,byte_length,dose_per_frame_json,angle_json)
       VALUES($id,0,1,'sha-x',4,'{}','{}')`,
      { $id: tiltSeriesId }
    );
    throw new Error('injected import failure');
  });
  throw new Error('unreachable');
}
