import React from "react";
import { Box, Text } from "ink";
import { renderMarkdown } from "../../markdown.js";

/** Renders markdown to ANSI (tables, bold/italic, code, headings, ...) and splits it into Ink Text lines. */
export function RenderedMarkdown({ text }: { text: string }) {
  const rendered = renderMarkdown(text);
  const lines = rendered.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <Text key={i}>{line.length > 0 ? line : " "}</Text>
      ))}
    </Box>
  );
}
