import type { Plugin, ViteDevServer } from "vite";
import type { Connect } from "vite";
import { Store } from "./store";
import { AppService } from "./app-service";
import { buildSeriesView } from "./state-view";
import { bootstrapIfEmpty } from "./bootstrap";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ApiDeps {
  dbPath: string;
}

function readBody(req: Connect.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text ? JSON.parse(text) : {});
    });
    req.on("error", reject);
  });
}

function send(res: any, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(json));
  res.end(json);
}

export function tiltApiPlugin(deps: ApiDeps): Plugin {
  let store: Store;
  let svc: AppService;

  return {
    name: "tilt-room-api",
    configureServer(server: ViteDevServer) {
      mkdirSync(dirname(deps.dbPath), { recursive: true });
      store = new Store(deps.dbPath);
      svc = new AppService(store);
      bootstrapIfEmpty(store);

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url!, "http://127.0.0.1");
        if (!url.pathname.startsWith("/api/")) return next();
        try {
          await route(req, res, url, { store, svc });
        } catch (err: any) {
          send(res, 500, { error: err?.message ?? String(err), stack: process.env.DEBUG ? err?.stack : undefined });
        }
      });
    }
  };
}

async function route(
  req: Connect.IncomingMessage,
  res: any,
  url: URL,
  ctx: { store: Store; svc: AppService }
): Promise<void> {
  const { store, svc } = ctx;
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/state") {
    const branch = url.searchParams.get("branch") ?? "main";
    const asOf = url.searchParams.get("asOfSeq");
    return send(res, 200, buildSeriesView(store, `branch:${branch}`, asOf ? Number(asOf) : undefined));
  }
  if (req.method === "GET" && p === "/api/branches") {
    return send(res, 200, store.listBranches());
  }
  if (req.method === "GET" && p.startsWith("/api/entity")) {
    const id = url.searchParams.get("id")!;
    const version = Number(url.searchParams.get("version")!);
    const view = store.getEntityVersion(id, version);
    if (!view) return send(res, 404, { error: "ENTITY_VERSION_NOT_FOUND", id, version });
    return send(res, 200, view);
  }
  if (req.method === "GET" && p === "/api/event") {
    const id = url.searchParams.get("id")!;
    const ev = store.getEvent(id);
    return send(res, ev ? 200 : 404, ev ?? { error: "EVENT_NOT_FOUND" });
  }
  if (req.method === "GET" && p === "/api/fragments") {
    return send(res, 200, store.allFragments());
  }
  if (req.method === "GET" && p === "/api/fragment") {
    const id = url.searchParams.get("id")!;
    const frag = store.getFragment(id);
    return send(res, frag ? 200 : 404, frag ?? { error: "FRAGMENT_NOT_FOUND" });
  }
  if (req.method === "GET" && p === "/api/blob") {
    const sha = url.searchParams.get("sha")!;
    const blob = store.getBlob(sha);
    if (!blob) {
      res.statusCode = 404;
      return res.end("blob not found");
    }
    res.statusCode = 200;
    res.setHeader("content-type", blob.mediaType);
    res.setHeader("cache-control", "immutable, max-age=31536000");
    return res.end(blob.bytes);
  }
  if (req.method === "GET" && p === "/api/export") {
    return send(res, 200, store.exportArchive());
  }
  if (req.method === "POST" && p === "/api/import") {
    const body = await readBody(req);
    const result = store.importArchive(body.archive ?? body);
    return send(res, 200, { ok: true, ...result });
  }
  if (req.method === "POST" && p === "/api/reset-bootstrap") {
    const result = bootstrapIfEmpty(store, true);
    return send(res, 200, { ok: true, ...result });
  }

  if (req.method === "POST" && p === "/api/adjudicate") {
    const b = await readBody(req);
    const outcome = svc.tryFreeze(() =>
      svc.adjudicate(b.branch, b.model, b.decision, b.reason, b.actor, b.baseSeq)
    );
    if (!outcome.ok) return send(res, 409, { error: "VERSION_CONFLICT", conflict: outcome.conflict });
    return send(res, 200, { ok: true, event: outcome.value });
  }
  if (req.method === "POST" && p === "/api/undo-adjudication") {
    const b = await readBody(req);
    const outcome = svc.tryFreeze(() => svc.undoAdjudication(b.branch, b.model, b.actor, b.baseSeq));
    if (!outcome.ok) return send(res, 409, { error: "VERSION_CONFLICT", conflict: outcome.conflict });
    return send(res, 200, { ok: true, event: outcome.value });
  }
  if (req.method === "POST" && p === "/api/lock") {
    const b = await readBody(req);
    const outcome = svc.tryFreeze(() => svc.lockRegistration(b.branch, b.model, b.reason, b.actor, b.baseSeq));
    if (!outcome.ok) return send(res, 409, { error: "VERSION_CONFLICT", conflict: outcome.conflict });
    return send(res, 200, { ok: true, event: outcome.value });
  }
  if (req.method === "POST" && p === "/api/revise-params") {
    const b = await readBody(req);
    const outcome = svc.tryFreeze(() =>
      svc.reviseParameters(b.branch, b.revision, b.actor, b.baseSeq, b.reason)
    );
    if (!outcome.ok) return send(res, 409, { error: "VERSION_CONFLICT", conflict: outcome.conflict });
    return send(res, 200, { ok: true, event: outcome.value });
  }
  if (req.method === "POST" && p === "/api/revise-angle") {
    const b = await readBody(req);
    const outcome = svc.tryFreeze(() =>
      svc.reviseFrameAngle(b.branch, b.frame, b.angleDeg, b.actor, b.baseSeq, b.reason)
    );
    if (!outcome.ok) return send(res, 409, { error: "VERSION_CONFLICT", conflict: outcome.conflict });
    return send(res, 200, { ok: true, event: outcome.value });
  }
  if (req.method === "POST" && p === "/api/set-frame-excluded") {
    const b = await readBody(req);
    const outcome = svc.tryFreeze(() =>
      svc.setFrameExcluded(b.branch, b.frame, b.excluded, b.reason, b.actor, b.baseSeq)
    );
    if (!outcome.ok) return send(res, 409, { error: "VERSION_CONFLICT", conflict: outcome.conflict });
    return send(res, 200, { ok: true, event: outcome.value });
  }
  if (req.method === "POST" && p === "/api/repair-swap") {
    const b = await readBody(req);
    const outcome = svc.tryFreeze(() => svc.repairTrackSwap(b.branch, b.actor, b.baseSeq, b.reason));
    if (!outcome.ok) return send(res, 409, { error: "VERSION_CONFLICT", conflict: outcome.conflict });
    return send(res, 200, { ok: true, event: outcome.value });
  }
  if (req.method === "POST" && p === "/api/fork") {
    const b = await readBody(req);
    const ev = svc.forkBranch(b.parent, b.child, b.label, b.reason, b.actor, b.baseSeq);
    return send(res, 200, { ok: true, event: ev });
  }
  if (req.method === "POST" && p === "/api/conflict-demo") {
    // 并发冻结演示：同一 baseSeq 连续提交两次不同裁定，第二次必然 409，并落一条 conflict 事件
    const b = await readBody(req);
    const first = svc.adjudicate(b.branch, "rigid", "accepted", "窗口 A：接受刚体", "window-A", b.baseSeq);
    let secondError: any = null;
    try {
      svc.adjudicate(b.branch, "local-warp", "accepted", "窗口 B：接受局部形变（过期基线）", "window-B", b.baseSeq);
    } catch (e: any) {
      secondError = e;
    }
    if (secondError && secondError.name === "VersionConflictError") {
      svc.recordConflict(
        b.branch,
        "window-B",
        b.baseSeq,
        { eventType: "adjudication-decided", targetEntityId: "cand:branch:" + b.branch + ":local-warp", summary: "窗口 B 想接受 local-warp" },
        { eventType: first.type, targetEntityId: first.id, summary: "窗口 A 已接受 rigid" },
        ["cand:branch:" + b.branch + ":rigid", "cand:branch:" + b.branch + ":local-warp"]
      );
      return send(res, 200, {
        ok: true,
        first,
        conflict: { expectedBase: b.baseSeq, actualHead: secondError.conflict.actualHead, otherEvent: secondError.conflict.otherEvent }
      });
    }
    return send(res, 200, { ok: true, first, note: "未触发冲突（基线已变）" });
  }

  send(res, 404, { error: "NOT_FOUND", path: p });
}
