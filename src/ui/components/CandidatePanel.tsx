interface CandidatePanelProps {
  candidates: any[];
  selectedEntityId: string | null;
  onSelect: (entityId: string) => void;
  onAccept: () => void;
  onReject: () => void;
  onUndo: () => void;
  onLock: () => void;
  outcomes: any[];
  locks: any[];
}

const STRATEGY_LABEL: Record<string, string> = {
  rigid: '刚体',
  local_warp: '局部形变',
  exclude_bad_frames: '排除坏帧'
};

export function CandidatePanel({
  candidates,
  selectedEntityId,
  onSelect,
  onAccept,
  onReject,
  onUndo,
  onLock,
  outcomes,
  locks
}: CandidatePanelProps) {
  const fingerprints = new Set(candidates.map((c) => c.body.effectivePointSetFingerprint));
  const samePointSet = fingerprints.size <= 1;
  const selected = candidates.find((c) => c.entityId === selectedEntityId);

  return (
    <div className="panel">
      <h2>配准候选与裁定</h2>
      <p className="small muted">
        有效点集{samePointSet ? '一致，可直接比较残差' : '不一致：禁止用少帧/少点换低残差'}（
        {fingerprints.size} 个指纹）
      </p>
      {candidates.map((candidate) => {
        const body = candidate.body;
        const locked = locks.some((lock) => lock.ref.entityId === candidate.entityId);
        const relevant = outcomes.filter(
          (outcome) =>
            outcome.affectedEntityIds?.includes(body.candidateId) ||
            outcome.affectedEntityIds?.includes(candidate.entityId)
        );
        return (
          <div
            key={candidate.entityId}
            className={`candidate ${candidate.entityId === selectedEntityId ? 'selected' : ''}`}
            onClick={() => onSelect(candidate.entityId)}
          >
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3>{body.label ?? STRATEGY_LABEL[body.strategy]}</h3>
              <span className={`pill ${body.status}`}>{body.status}</span>
            </div>
            <div className="small">
              RMS <span className="mono">{body.aggregateRmsPx?.toFixed(3)} px</span> ·
              自由度 {body.degreesOfFreedom} · 有效点 {body.pointCount} ·
              有效帧 {body.effectiveFrameSequence?.length}
              {body.ambiguityGroup && (
                <> · <span style={{ color: 'var(--warn)' }}>等价多解 {body.ambiguityGroup}</span></>
              )}
              {locked && <> · <span style={{ color: 'var(--ok)' }}>已钉版供重建</span></>}
            </div>
            <div className="id-badge" style={{ marginTop: 4 }}>
              {candidate.contentId.slice(0, 28)}… v{candidate.version}
            </div>
            {body.diagnostics?.map((line: string, index: number) => (
              <div
                key={index}
                className={`diag ${line.includes('过拟合') || line.includes('禁止') ? 'badtone' : ''}`}
              >
                ⚠ {line}
              </div>
            ))}
            {relevant.map((outcome, index) => (
              <div
                key={index}
                className="small"
                style={{ color: outcome.passed ? 'var(--ok)' : 'var(--warn)' }}
              >
                {outcome.passed ? '✓' : '✗'} {outcome.rule}: {outcome.message}
              </div>
            ))}
          </div>
        );
      })}

      {selected && (
        <div className="panel" style={{ background: 'var(--panel-2)' }}>
          <h2>候选差分 / 复核操作</h2>
          <DiffTable candidates={candidates} selected={selected} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={onAccept} disabled={selected.body.status === 'accepted'}>
              接受（新事件）
            </button>
            <button className="danger" onClick={onReject} disabled={selected.body.status === 'rejected'}>
              否定
            </button>
            <button onClick={onUndo}>撤销裁定</button>
            <button onClick={onLock} disabled={selected.body.status !== 'accepted'}>
              锁定供重建
            </button>
          </div>
          <p className="small muted" style={{ marginTop: 6 }}>
            任何操作都不改写原数据；接受/否定追加新版本事件，撤销恢复前一分支。
          </p>
        </div>
      )}
    </div>
  );
}

function DiffTable({ candidates, selected }: { candidates: any[]; selected: any }) {
  const fields: Array<[string, (body: any) => string]> = [
    ['RMS(px)', (body) => body.aggregateRmsPx?.toFixed(4)],
    ['有效帧', (body) => String(body.effectiveFrameSequence?.length)],
    ['有效点', (body) => String(body.pointCount)],
    ['自由度', (body) => String(body.degreesOfFreedom)],
    ['点集指纹', (body) => body.effectivePointSetFingerprint?.slice(5, 13)],
    ['偏心(px)', () => '']
  ];
  return (
    <table className="residuals">
      <thead>
        <tr>
          <th>指标</th>
          {candidates.map((candidate) => (
            <th
              key={candidate.entityId}
              style={{
                color: candidate.entityId === selected.entityId ? 'var(--accent)' : undefined
              }}
            >
              {STRATEGY_LABEL[candidate.body.strategy]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {fields.map(([label, getter]) => (
          <tr key={label}>
            <td>{label}</td>
            {candidates.map((candidate) => (
              <td
                key={candidate.entityId}
                style={{
                  color: candidate.entityId === selected.entityId ? 'var(--accent)' : undefined
                }}
              >
                {getter(candidate.body)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
