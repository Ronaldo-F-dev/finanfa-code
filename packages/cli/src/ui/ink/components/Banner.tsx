import React from "react";
import { Box, Text } from "ink";
import gradient from "gradient-string";

// gradient-string mirrors chalk's own color-support detection (no color
// when stdout isn't a real TTY — same convention markdown.ts's
// marked-terminal already follows), so this degrades to plain text in a
// non-interactive/piped run exactly like everything else in this UI.
const TITLE_GRADIENT = gradient(["#22d3ee", "#a855f7"]); // cyan -> purple

export function Banner({ version }: { version: string }) {
  return (
    <Box
      flexDirection="column"
      alignSelf="flex-start"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      marginBottom={1}
    >
      <Text>
        <Text color="cyan" bold>
          {"ƒ "}
        </Text>
        <Text bold>{TITLE_GRADIENT("finanfa-code")}</Text>
        <Text dimColor> v{version}</Text>
      </Text>
      <Text dimColor italic>
        your own coding agent — code, design, docs, data
      </Text>
    </Box>
  );
}
