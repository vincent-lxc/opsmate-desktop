import type { CSSProperties } from "react";

type TerminalPromptIconProps = {
  size?: number;
  style?: CSSProperties;
  className?: string;
};

export function TerminalPromptIcon({
  size = 14,
  style,
  className,
}: TerminalPromptIconProps) {
  return (
    <span
      className={className}
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: size,
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: "-0.04em",
        ...style,
      }}
    >
      &gt;_
    </span>
  );
}