import express, { type Express } from 'express';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, migrate, type DB } from './db.js';
import * as store from './store.js';
import { replayCasepack, importBaseline, interpret } from './casepack.js';

export interface AppContext { db: DB; packDir: string; dbPath: string }

export function createApp(dbPath: string, packDir: string): { app: Express; ctx: AppContext } {
  if (dbPath !== ':memory:') mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = openDb(dbPath);
  migrate(db);
  const ctx: AppContext = { db, packDir, dbPath };
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const wrap = (fn: (req: any, res: any) => void) => (req: any, res: any) => {
    try { fn(req, res); } catch (e: any) {
      if (e instanceof store.ConflictError) {
        res.status(409).json({ error: 'VERSION_CONFLICT', currentHead: e.currentHead, serverEvents: e.serverEvents, yourPayload: e.yourPayload });
      } else if (e instanceof store.CorruptionError) {
        res.status(409).json({ error: 'CORRUPT', message: e.message });
      } else {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    }
  };

  app.get('/api/state', wrap((req, res) => {
    const atSeq = req.query.atSeq ? Number(req.query.atSeq) : undefined;
    res.json(store.getState(db, { atSeq }));
  }));

  app.post('/api/casepack/load', wrap((req, res) => {
    if (!existsSync(join(packDir, 'manifest.json'))) throw new Error(`casepack not found at ${packDir}`);
    const r = replayCasepack(db, packDir);
    res.json({ ok: true, ...r, state: store.getState(db) });
  }));

  app.post('/api/casepack/import-baseline', wrap((req, res) => {
    res.json(importBaseline(db, packDir, req.body?.actor ?? 'em-group'));
  }));

  app.post('/api/branches/:id/interpret', wrap((req, res) => {
    res.json(interpret(db, req.params.id, req.body?.actor ?? 'reviewer', req.body?.opts ?? {}));
  }));

  app.post('/api/branches', wrap((req, res) => {
    res.json({ branchId: store.createBranch(db, req.body.name, req.body.baseSeq) });
  }));

  app.get('/api/entities/:id', wrap((req, res) => {
    const branch = String(req.query.branch);
    const version = req.query.version ? Number(req.query.version) : undefined;
    res.json(store.getEntity(db, req.params.id, branch, version));
  }));

  app.get('/api/sources/:id', wrap((req, res) => {
    const version = req.query.version ? Number(req.query.version) : undefined;
    res.json(store.getSource(db, req.params.id, version));
  }));

  app.get('/api/blobs/:hash', wrap((req, res) => {
    const row = db.prepare('SELECT * FROM blobs WHERE hash = ?').get(req.params.hash) as any;
    if (!row) throw new store.CorruptionError(`CORRUPT: 缺少 blob ${req.params.hash}`);
    res.type(row.media_type).send(row.content);
  }));

  app.post('/api/branches/:id/adjudicate', wrap((req, res) => {
    const seq = store.adjudicate(db, req.params.id, req.body);
    res.json({ ok: true, seq, head: store.getBranch(db, req.params.id).head_seq });
  }));

  app.post('/api/branches/:id/revoke', wrap((req, res) => {
    const seq = store.revokeAdjudication(db, req.params.id, Number(req.body.adjudicationSeq), req.body.actor ?? 'reviewer');
    res.json({ ok: true, seq });
  }));

  app.post('/api/branches/:id/lock', wrap((req, res) => {
    const lockId = store.lockAlignment(db, req.params.id, req.body);
    res.json({ ok: true, lockId });
  }));

  app.get('/api/export', wrap((_req, res) => res.json(store.exportArchive(db))));

  app.post('/api/import-archive', wrap((req, res) => {
    store.importArchive(db, req.body);
    res.json({ ok: true, state: store.getState(db) });
  }));

  return { app, ctx };
}
