import React from "react";
import { Box, Text } from "ink";

export function Banner({ version }: { version: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1}>
      <Text>
        <Text color="cyan" bold>
          {"ƒ "}
        </Text>
        <Text bold>finanfa-code</Text>
        <Text dimColor> v{version}</Text>
      </Text>
      <Text dimColor italic>
        your own coding agent — code, design, docs, data
      </Text>
    </Box>
  );
}
