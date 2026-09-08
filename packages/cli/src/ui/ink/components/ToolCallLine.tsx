import React from "react";
import { Text } from "ink";
import type { ToolRiskLevel } from "@finanfa/core/src/core/types.js";

const RISK_STYLE: Record<ToolRiskLevel, { icon: string; color: string }> = {
  safe: { icon: "›", color: "cyan" },
  ask: { icon: "◆", color: "yellow" },
  dangerous: { icon: "▲", color: "red" },
};

/** One line per tool call, styled by risk level so a glance at the transcript shows what kind of thing just ran — not just that something did. */
export function ToolCallLine({ toolName, description, riskLevel }: { toolName: string; description: string; riskLevel: ToolRiskLevel }) {
  const { icon, color } = RISK_STYLE[riskLevel];
  return (
    <Text>
      <Text color={color} bold>
        {icon} {toolName}
      </Text>
      {description ? <Text dimColor>{"  "}{description}</Text> : null}
    </Text>
  );
}
