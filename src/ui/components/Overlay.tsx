import { useEffect, useRef } from 'react';
import { frameImageUrl, type EntityDto } from '../api';

interface OverlayProps {
  frames: EntityDto[];
  tracks: EntityDto[];
  axis: EntityDto | null;
  selectedSequence: number;
  showOverlay: boolean;
}

/**
 * 帧叠影审阅：
 * - 画出当前原始帧（PGM）；
 * - 叠加倾转轴（含图像中心十字 + 偏心位移，直观证明轴不在中心）；
 * - 叠加 fiducial 轨迹点；断裂区间不连线（track_gap）。
 */
export function Overlay({
  frames,
  tracks,
  axis,
  selectedSequence,
  showOverlay
}: OverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const frameEntity = frames.find(
    (entity) => entity.body.sequenceIndex === selectedSequence
  );
  const blobId: string | undefined = frameEntity?.body.blobContentId;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d')!;
    let cancelled = false;

    const draw = () => {
      if (cancelled) return;
      const width = frameEntity?.body.width ?? 256;
      const height = frameEntity?.body.height ?? 256;
      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      if (imageRef.current && showOverlay === false) {
        context.drawImage(imageRef.current, 0, 0);
      } else if (imageRef.current) {
        context.drawImage(imageRef.current, 0, 0);
      } else {
        context.fillStyle = '#111';
        context.fillRect(0, 0, width, height);
      }
      if (!showOverlay) return;

      // 图像中心
      const cx = width / 2;
      const cy = height / 2;
      context.strokeStyle = '#666';
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(cx - 8, cy);
      context.lineTo(cx + 8, cy);
      context.moveTo(cx, cy - 8);
      context.lineTo(cx, cy + 8);
      context.stroke();
      context.setLineDash([]);

      // 倾转轴
      if (axis) {
        const a = axis.body;
        const angle = (a.angleDeg * Math.PI) / 180;
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        context.strokeStyle = '#4da3ff';
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(a.position.x - ux * 220, a.position.y - uy * 220);
        context.lineTo(a.position.x + ux * 220, a.position.y + uy * 220);
        context.stroke();
        // 中心 -> 轴位置的偏心向量
        context.strokeStyle = '#bc8cff';
        context.beginPath();
        context.moveTo(cx, cy);
        context.lineTo(a.position.x, a.position.y);
        context.stroke();
        context.fillStyle = '#bc8cff';
        context.font = '10px monospace';
        context.fillText(
          `Δaxis=${a.offsetFromCenterPx.toFixed(1)}px`,
          a.position.x + 4,
          a.position.y - 4
        );
      }

      // 轨迹点：当前帧观测；缺口区间用空心方块
      const palette = ['#3fb950', '#f0883e', '#56d4dd', '#db61a2', '#d29922', '#7ee787', '#ffa657', '#79c0ff'];
      tracks.forEach((trackEntity, trackIndex) => {
        const observations = trackEntity.body.observations ?? {};
        const observation = observations[String(selectedSequence)];
        const color = palette[trackIndex % palette.length];
        // 连接相邻有效观测（断裂处断开）
        const keys = Object.keys(observations)
          .map(Number)
          .sort((a, b) => a - b);
        context.strokeStyle = color + '88';
        context.beginPath();
        let pen = false;
        for (const key of keys) {
          const point = observations[key];
          if (point.invalidReason) {
            pen = false;
            continue;
          }
          const x = point.at.x;
          const y = point.at.y;
          if (!pen) {
            context.moveTo(x, y);
            pen = true;
          } else {
            context.lineTo(x, y);
          }
        }
        context.stroke();
        if (observation) {
          context.fillStyle = observation.invalidReason ? '#000' : color;
          context.strokeStyle = color;
          context.beginPath();
          context.arc(observation.at.x, observation.at.y, 3.5, 0, Math.PI * 2);
          if (observation.invalidReason) context.stroke();
          else context.fill();
          context.fillStyle = color;
          context.font = '9px monospace';
          context.fillText(trackEntity.body.trackId, observation.at.x + 4, observation.at.y - 4);
        }
      });
    };

    if (blobId) {
      const image = new Image();
      image.onload = () => {
        imageRef.current = image;
        draw();
      };
      image.src = frameImageUrl(blobId);
    } else {
      imageRef.current = null;
      draw();
    }
    draw();
    return () => {
      cancelled = true;
    };
  }, [blobId, axis, tracks, selectedSequence, showOverlay, frameEntity]);

  if (!frameEntity) {
    return (
      <div className="panel">
        <h2>帧叠影</h2>
        <p className="muted">该倾角帧物理缺失（缺失高倾角帧）。</p>
      </div>
    );
  }
  return (
    <div className="panel">
      <h2>
        帧叠影 · #{frameEntity.body.sequenceIndex}
        <span className="id-badge" style={{ marginLeft: 8 }}>
          {frameEntity.entityId}
        </span>
      </h2>
      <canvas ref={canvasRef} className="overlay" width={256} height={256} />
      <p className="small muted" style={{ marginTop: 6 }}>
        蓝线=估计倾转轴；紫线=图像中心→轴的偏心向量；缺口/未决身份观测以空心点显示。
      </p>
    </div>
  );
}
