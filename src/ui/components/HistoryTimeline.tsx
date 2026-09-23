import type { StateDto } from '../api';

interface HistoryTimelineProps {
  state: StateDto | null;
  timeSeq: number | undefined;
  onTravel: (seq: number) => void;
  onReturn: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  entity_recorded: '实体版本',
  material_set_committed: '材料集修订',
  rule_asserted: '规则登记',
  rule_outcome_recorded: '规则判定',
  candidate_proposed: '候选提出',
  candidate_invalidated: '范围失效',
  decision_recorded: '人工裁定',
  decision_undone: '撤销裁定',
  locked_for_reconstruction: '锁定重建',
  case_annotation: '案例叙述',
  scenario_boundary_recorded: '边界情形',
  branch_created: '分支创建'
};

export function HistoryTimeline({ state, timeSeq, onTravel, onReturn }: HistoryTimelineProps) {
  if (!state) return null;
  const events = state.events;
  return (
    <div className="panel">
      <h2>历史与时间旅行</h2>
      <label className="flex small muted">
        <span>回到事件 #</span>
        <span>
          {timeSeq ?? state.headSeq} / {state.headSeq}
        </span>
      </label>
      <input
        type="range"
        min={1}
        max={state.headSeq}
        value={timeSeq ?? state.headSeq}
        onChange={(event) => onTravel(Number(event.target.value))}
      />
      <button onClick={onReturn} style={{ marginBottom: 6 }}>
        返回分支头部最新视图
      </button>
      <div className="scroll">
        {events.map((event) => {
          const entityId =
            (event.payload as any)?.entityId ??
            (event.payload as any)?.candidateId ??
            (event.payload as any)?.decisionId ??
            (event.payload as any)?.reconstructionHandle ??
            '';
          const active = (timeSeq ?? state.headSeq) === event.seq;
          return (
            <div key={event.eventId} className={`event ${active ? 'active' : ''}`}>
              <div className="small">
                <span className="mono">#{event.seq}</span>{' '}
                {TYPE_LABEL[event.type] ?? event.type}{' '}
                <span className="muted">· {event.author}</span>
              </div>
              {entityId && (
                <div className="id-badge" title={entityId}>
                  {String(entityId).slice(0, 32)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="small muted">
        回到旧事件时恢复当时依赖版本与可见结论，不用最新计算覆盖历史。
      </p>
    </div>
  );
}
