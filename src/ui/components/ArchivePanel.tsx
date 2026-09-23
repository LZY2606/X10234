import { useState } from 'react';
import { api } from '../api';

interface ArchivePanelProps {
  onChanged: () => void;
}

export function ArchivePanel({ onChanged }: ArchivePanelProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMessage(ok);
      onChanged();
    } catch (err: any) {
      if (err.status === 422) {
        setError(`损坏被拒绝：${err.data?.code} — ${err.data?.error}`);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const exportAndDownload = async () => {
    const bundle = await api.exportArchive();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'tilt-room-archive.trarc.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage('已导出反例档案（含全部分支、事件顺序、blob 与内容摘要）');
  };

  const importFromDisk = async (file: File) => {
    const text = await file.text();
    const bundle = JSON.parse(text);
    await run(
      () => api.importArchive(bundle),
      '档案已重新导入：身份、顺序与来源关系按 contentId/序号校验通过'
    );
  };

  const roundTrip = async () => {
    // 导出 -> 删除本地数据库 -> 重新导入，验证身份/顺序/来源关系仍保持。
    const bundle = await api.exportArchive();
    await run(async () => {
      await api.reset();
      return api.importArchive(bundle);
    }, '导出→删除本地数据库→重导入完成，身份与顺序保持');
  };

  return (
    <div className="panel">
      <h2>反例档案（.trarc）</h2>
      <div className="row">
        <button onClick={exportAndDownload} disabled={busy}>
          导出档案
        </button>
        <button onClick={roundTrip} disabled={busy}>
          导出→删库→重导入
        </button>
      </div>
      <label className="small muted" style={{ marginTop: 6, display: 'block' }}>
        从磁盘导入档案：
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importFromDisk(file);
          }}
        />
      </label>
      {message && <div className="ok-box">{message}</div>}
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
