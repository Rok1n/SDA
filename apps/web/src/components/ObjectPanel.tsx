import { memo } from "react";
import type { BinauralRenderMetadata, VisualObject } from "@sda/player";

interface ObjectPanelProps {
  objects: readonly VisualObject[];
  mutedIds: ReadonlySet<number>;
  soloTarget: number | null;
  binauralMetadata: BinauralRenderMetadata | null;
  onToggleMute: (id: number) => void;
  onToggleSolo: (id: number) => void;
}

export const ObjectPanel = memo(function ObjectPanel({
  objects,
  mutedIds,
  soloTarget,
  binauralMetadata,
  onToggleMute,
  onToggleSolo,
}: ObjectPanelProps) {
  return (
    <div className="panel">
      <h2>对象 ({objects.length})</h2>
      <ul className="objects">
        {objects.map((object) => (
          <li key={object.id} className={mutedIds.has(object.id) ? "obj-muted" : ""}>
            <b>#{object.id}</b>{" "}
            {object.hasPos
              ? `(${object.pos.map((value) => value.toFixed(2)).join(", ")})`
              : "—"}
            {object.gainDb !== 0 && ` ${object.gainDb}dB`}
            <span className="obj-metadata">
              {object.anchor}
              {object.distanceInfinite
                ? " · OAMD 物理距离：无限"
                : object.distanceM !== null
                  ? ` · OAMD 物理距离：${object.distanceM.toFixed(2)}m`
                  : ""}
              {" · 双耳模式："}
              {binauralMetadata?.available
                ? "DBMD ordinal 缺少 bed/object 元素映射"
                : "当前输入未携带可读取的 Binaural Render Mode"}
            </span>
            <span className="obj-ms">
              <button
                className={`obj-ms-btn ${mutedIds.has(object.id) ? "m-on" : ""}`}
                title={mutedIds.has(object.id) ? "取消静音" : "静音此对象"}
                onClick={() => onToggleMute(object.id)}
              >
                M
              </button>
              <button
                className={`obj-ms-btn ${soloTarget === object.id ? "s-on" : ""}`}
                title={soloTarget === object.id ? "取消独奏" : "独奏此对象（静音其他全部）"}
                onClick={() => onToggleSolo(object.id)}
              >
                S
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
});
