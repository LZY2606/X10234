interface ResidualPanelProps {
  candidate: any;
  frames: any[];
}

export function ResidualPanel({ candidate, frames }: ResidualPanelProps) {
  const residuals = candidate.body.perFrameResiduals ?? [];
  const max = Math.max(0.0001, ...residuals.map((entry: any) => entry.rmsResidualPx));
  const tiltBySeq = new Map(
    frames.map((frame) => [frame.body.sequenceIndex, frame])
  );
  return (
    <div className="panel">
      <h2>
        每帧残差
        <span className="id-badge" style={{ marginLeft: 8 }}>
          {candidate.body.effectivePointSetFingerprint}
        </span>
      </h2>
      <table className="residuals">
        <thead>
          <tr>
            <th>帧#</th>
            <th>纳入</th>
            <th>点数</th>
            <th>RMS(px)</th>
            <th>max(px)</th>
            <th style={{ width: 90 }}>残差条</th>
          </tr>
        </thead>
        <tbody>
          {residuals.map((entry: any) => {
            const frame = tiltBySeq.get(entry.sequenceIndex);
            return (
              <tr
                key={entry.sequenceIndex}
                style={{ opacity: entry.included ? 1 : 0.45 }}
                title={entry.excludedReason ?? ''}
              >
                <td>
                  #{entry.sequenceIndex}
                  {frame && (
                    <span className="small muted">
                      {' '}
                      {frame.body.tiltDeg ?? ''}°
                    </span>
                  )}
                </td>
                <td>{entry.included ? '✓' : `× ${entry.excludedReason ?? ''}`}</td>
                <td>{entry.pointCount}</td>
                <td>{entry.rmsResidualPx.toFixed(3)}</td>
                <td>{entry.maxResidualPx.toFixed(3)}</td>
                <td>
                  <div
                    className="bar"
                    style={{
                      width: `${(entry.rmsResidualPx / max) * 100}%`,
                      background: entry.included ? undefined : '#555'
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {candidate.body.excludedFrames?.length > 0 && (
        <p className="small" style={{ color: 'var(--warn)' }}>
          已排除帧：
          {candidate.body.excludedFrames
            .map((frame: any) => `${frame.frameId}（${frame.reason}）`)
            .join('；')}
        </p>
      )}
    </div>
  );
}
