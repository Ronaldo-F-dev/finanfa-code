import React from "react";
import { Box, Text } from "ink";
import type { CommandInfo } from "@finanfa/core/src/ui/adapter.js";

export function CommandSuggestions({
  suggestions,
  selectedIndex,
}: {
  suggestions: CommandInfo[];
  selectedIndex: number;
}) {
  if (suggestions.length === 0) return null;

  return (
    <Box flexDirection="column">
      {suggestions.map((cmd, i) => (
        <Text key={cmd.name} color={i === selectedIndex ? "cyan" : undefined} dimColor={i !== selectedIndex}>
          {i === selectedIndex ? "› " : "  "}/{cmd.name}
          {cmd.description ? ` — ${cmd.description}` : ""}
        </Text>
      ))}
    </Box>
  );
}
