import React from "react";
import { Box, Text } from "ink";
import type { StatusInfo } from "@finanfa/core/src/ui/adapter.js";

export function StatusBar({ status }: { status: StatusInfo | undefined }) {
  if (!status) return null;
  return (
    <Box marginTop={1}>
      <Text dimColor>
        tokens={status.tokens} cost=${status.costUsd.toFixed(4)} model={status.model}
      </Text>
    </Box>
  );
}
