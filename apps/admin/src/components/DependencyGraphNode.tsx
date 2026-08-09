import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Tag, theme } from "antd";
import { useTranslation } from "react-i18next";
import { CATEGORY_LABEL_KEYS } from "../utils/discovery-types";
import type { DependencyNodeData } from "../utils/dependency-graph";
import { categoryColor, chunkPortNumbers } from "../utils/dependency-graph";

function PortConnectorIcon({ color, size = 13 }: { color: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0, display: "block" }}
    >
      <circle cx="4" cy="7" r="2.25" stroke={color} strokeWidth="1.25" />
      <path d="M6.25 7h4.5" stroke={color} strokeWidth="1.25" strokeLinecap="round" />
      <path
        d="M11.75 5.25v3.5"
        stroke={color}
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function entryKindLabel(
  category: string,
  t: (key: string) => string,
): string | undefined {
  if (category === "entry_external") return t("servers.dependencies.entryExternal");
  if (category === "entry_internal") return t("servers.dependencies.entryInternal");
  return undefined;
}

export function DependencyGraphNode({ data, selected }: NodeProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const nodeData = data as DependencyNodeData;
  const accent = categoryColor(nodeData.category);
  const categoryKey = CATEGORY_LABEL_KEYS[nodeData.category];
  const categoryLabel = categoryKey ? t(categoryKey) : nodeData.category;
  const selectionRing = `0 0 0 3px ${token.colorWarning}`;
  const entryLabel = entryKindLabel(nodeData.category, t);
  const isEntryNode = nodeData.category === "entry_external" || nodeData.category === "entry_internal";
  const portChunks = nodeData.portNumbers?.length ? chunkPortNumbers(nodeData.portNumbers) : [];
  const showPortSection = portChunks.length > 0 || Boolean(entryLabel);
  const showCategoryTag = !isEntryNode;

  return (
    <div
      style={{
        width: 196,
        minHeight: 76,
        padding: "10px 12px",
        borderRadius: token.borderRadiusLG,
        border: `2px solid ${accent}`,
        background: selected ? token.colorWarningBg : token.colorBgContainer,
        boxShadow: selected ? `${selectionRing}, ${token.boxShadowSecondary}` : token.boxShadowTertiary,
        boxSizing: "border-box",
        transition: "box-shadow 0.15s ease, background 0.15s ease",
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="tgt-l"
        style={{ background: accent, width: 10, height: 10 }}
      />
      <Handle
        type="target"
        position={Position.Top}
        id="tgt-t"
        style={{ background: accent, width: 10, height: 10 }}
      />
      {nodeData.label ? (
        <div
          style={{
            fontWeight: 600,
            fontSize: 13,
            lineHeight: 1.3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {nodeData.label}
        </div>
      ) : null}
      {showPortSection ? (
        <div style={{ marginTop: nodeData.label ? 5 : 0 }}>
          {portChunks.length > 0 ? (
            portChunks.map((chunk, index) => {
              const isLast = index === portChunks.length - 1;
              return (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    marginTop: index > 0 ? 3 : 0,
                    lineHeight: 1.3,
                    flexWrap: "wrap",
                  }}
                >
                  {index === 0 ? (
                    <PortConnectorIcon color={token.colorTextSecondary} />
                  ) : (
                    <span style={{ width: 13, flexShrink: 0 }} />
                  )}
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: token.colorText,
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                      letterSpacing: "0.02em",
                    }}
                  >
                    {chunk.join(",")}
                  </span>
                  {isLast && entryLabel ? (
                    <Tag
                      color={accent}
                      style={{ margin: 0, fontSize: 10, lineHeight: "18px", flexShrink: 0 }}
                    >
                      {entryLabel}
                    </Tag>
                  ) : null}
                </div>
              );
            })
          ) : entryLabel ? (
            <div style={{ display: "flex", alignItems: "center", gap: 5, lineHeight: 1.3 }}>
              <PortConnectorIcon color={token.colorTextSecondary} />
              <Tag color={accent} style={{ margin: 0, fontSize: 10, lineHeight: "18px" }}>
                {entryLabel}
              </Tag>
            </div>
          ) : null}
        </div>
      ) : null}
      {nodeData.sublabel && !isEntryNode ? (
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color: token.colorTextSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {nodeData.sublabel}
        </div>
      ) : null}
      {showCategoryTag ? (
        <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
          <Tag color={accent} style={{ margin: 0, fontSize: 10, lineHeight: "18px" }}>
            {categoryLabel}
          </Tag>
          {nodeData.isExternal ? (
            <Tag style={{ margin: 0, fontSize: 10, lineHeight: "18px" }}>external</Tag>
          ) : null}
          {nodeData.isPendingHost ? (
            <Tag color="orange" style={{ margin: 0, fontSize: 10, lineHeight: "18px" }}>
              pending
            </Tag>
          ) : null}
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Right}
        id="src-r"
        style={{ background: accent, width: 10, height: 10 }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="src-b"
        style={{ background: accent, width: 10, height: 10 }}
      />
    </div>
  );
}