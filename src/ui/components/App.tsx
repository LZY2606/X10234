import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type BranchInfo, type StateDto } from '../api';
import { Overlay } from './Overlay';
import { CandidatePanel } from './CandidatePanel';
import { ResidualPanel } from './ResidualPanel';
import { HistoryTimeline } from './HistoryTimeline';
import { ArchivePanel } from './ArchivePanel';
import { SourcePanel } from './SourcePanel';

const BRANCH_LABELS: Record<string, string> = {
  main: '基线 / 完整叙事',
  scenario_axis_offset: '轴线偏心',
  scenario_identity_swap: '身份交换',
  scenario_missing_high_tilt: '缺失高倾角',
  scenario_bad_frames: '坏帧排除',
  scenario_warp_overfit: '形变过拟合',
  scenario_ambiguity: '多解',
  scenario_concurrent_freeze: '并发冻结',
  scenario_combined: '组合输入'
};

export function App() {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchId, setBranchId] = useState('main');
  const [state, setState] = useState<StateDto | null>(null);
  const [selectedSeq, setSelectedSeq] = useState(10);
  const [selectedCandidate, setSelectedCandidate] = useState<string | null>(null);
  const [timeSeq, setTimeSeq] = useState<number | undefined>(undefined);
  const [conflict, setConflict] = useState<any | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (branch: string, atSeq?: number) => {
    const next = await api.state(branch, atSeq);
    setState(next);
    setTimeSeq(atSeq);
    setConflict(null);
  }, []);

  useEffect(() => {
    api.branches().then((data) => setBranches(data.branches)).catch(console.error);
  }, []);

  useEffect(() => {
    refresh(branchId).catch(console.error);
  }, [branchId, refresh]);

  const entities = useMemo(() => state?.entities ?? [], [state]);
  const byKind = useCallback(
    (kind: string) => entities.filter((entity) => entity.kind === kind),
    [entities]
  );
  const frames = byKind('raw_frame').sort(
    (a, b) => a.body.sequenceIndex - b.body.sequenceIndex
  );
  const tracks = byKind('track');
  const axes = byKind('tilt_axis');
  const candidates = byKind('registration_candidate') as any[];
  const selected = candidates.find((candidate) => candidate.entityId === selectedCandidate)
    ?? candidates[0]
    ?? null;

  const runDecision = async (accepted: boolean, reason: string) => {
    if (!selected || !state) return;
    try {
      await api.decide({
        branchId,
        candidateId: selected.entityId,
        accepted,
        reason,
        expectedHeadSeq: state.headSeq
      });
      setNotice(accepted ? '已接受候选（新版本事件，已可锁定）' : '已否定候选（原数据未改写，可撤销）');
      await refresh(branchId);
    } catch (error: any) {
      if (error.status === 409) setConflict(error.data);
      else setNotice(error.message);
    }
  };

  const runUndo = async () => {
    if (!selected || !state) return;
    try {
      await api.undo({
        branchId,
        candidateId: selected.entityId,
        expectedHeadSeq: state.headSeq
      });
      setNotice('已撤销裁定：恢复到前一分支状态（历史事件仍保留）');
      await refresh(branchId);
    } catch (error: any) {
      if (error.status === 409) setConflict(error.data);
      else setNotice(error.message);
    }
  };

  const runLock = async () => {
    if (!selected || !state) return;
    try {
      const result = await api.lock({
        branchId,
        candidateId: selected.entityId,
        expectedHeadSeq: state.headSeq
      });
      setNotice(`已锁定供重建引用：句柄 ${result.handle}（钉住版本，读回不退回最新）`);
      await refresh(branchId);
    } catch (error: any) {
      if (error.status === 409) setConflict(error.data);
      else setNotice(error.message);
    }
  };

  return (
    <>
      <header className="topbar">
        <h1>倾转帧拼合室</h1>
        <div className="branch-tabs">
          {branches.map((branch) => (
            <button
              key={branch.branchId}
              className={`branch-tab ${branch.branchId === branchId ? 'active' : ''}`}
              onClick={() => setBranchId(branch.branchId)}
              title={branch.branchId}
            >
              {BRANCH_LABELS[branch.branchId] ?? branch.branchId}
            </button>
          ))}
        </div>
        <span className="small muted" style={{ marginLeft: 'auto' }}>
          分支头 #{state?.headSeq ?? '-'}
        </span>
      </header>

      {conflict && (
        <div className="error-box" style={{ margin: 10 }}>
          <strong>版本冲突（并发冻结）</strong>
          <div>{conflict.error}</div>
          <div className="small">
            你基于 #{conflict.expectedSeq}，服务器已到 #{conflict.actualSeq}。
            对方新增事件：
            <ul>
              {(conflict.serverEvents ?? []).map((event: any) => (
                <li key={event.eventId}>
                  <span className="mono">{event.type}</span> · {event.author}
                </li>
              ))}
            </ul>
            请刷新审阅最新差异后再提交。
          </div>
          <button className="primary" onClick={() => refresh(branchId)}>
            拉取双方差异并刷新
          </button>
        </div>
      )}
      {notice && (
        <div className="ok-box" style={{ margin: 10 }} onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      <div className="layout">
        <div>
          <SourcePanel state={state} frames={frames} selectedSeq={selectedSeq} onSelect={setSelectedSeq} />
          <ArchivePanel onChanged={() => refresh(branchId)} />
        </div>

        <div>
          <Overlay
            frames={frames}
            tracks={tracks}
            axis={axes[0] ?? null}
            selectedSequence={selectedSeq}
            showOverlay
          />
          {selected && <ResidualPanel candidate={selected} frames={frames} />}
          <HistoryTimeline
            state={state}
            timeSeq={timeSeq}
            onTravel={(seq) => refresh(branchId, seq)}
            onReturn={() => refresh(branchId)}
          />
        </div>

        <div>
          <CandidatePanel
            candidates={candidates}
            selectedEntityId={selected?.entityId ?? null}
            onSelect={setSelectedCandidate}
            onAccept={() => runDecision(true, '审阅页接受：相同有效点集下残差最优')}
            onReject={() => runDecision(false, '审阅页否定：存在坏帧/过拟合/多解风险')}
            onUndo={runUndo}
            onLock={runLock}
            outcomes={state?.ruleOutcomes ?? []}
            locks={state?.locks ?? []}
          />
        </div>
      </div>
    </>
  );
}
