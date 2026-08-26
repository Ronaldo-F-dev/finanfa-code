import React from "react";
import { Box, Text } from "ink";

function colorForLine(line: string): string | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) return "green";
  if (line.startsWith("-") && !line.startsWith("---")) return "red";
  if (line.startsWith("@@")) return "cyan";
  return undefined;
}

/** Renders multi-line text as separate <Text> rows, coloring unified-diff +/- lines. */
export function MultilineText({ text, dimColor }: { text: string; dimColor?: boolean }) {
  const lines = text.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <Text key={i} color={colorForLine(line)} dimColor={dimColor}>
          {line.length > 0 ? line : " "}
        </Text>
      ))}
    </Box>
  );
}
