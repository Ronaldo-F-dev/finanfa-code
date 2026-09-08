import React from "react";
import { Box, Text } from "ink";
import type { StatusInfo } from "@finanfa/core/src/ui/adapter.js";

export function StatusBar({ status }: { status: StatusInfo | undefined }) {
  if (!status) return null;
  return (
    <Box marginTop={1}>
      {status.planMode && (
        <Text color="yellow" bold>
          [PLAN MODE]{" "}
        </Text>
      )}
      <Text dimColor>tokens=</Text>
      <Text color="magenta">{status.tokens}</Text>
      <Text dimColor> cost=</Text>
      <Text color="green">${status.costUsd.toFixed(4)}</Text>
      <Text dimColor> model=</Text>
      <Text color="cyan">{status.model}</Text>
    </Box>
  );
}
