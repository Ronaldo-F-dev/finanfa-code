import React from "react";
import { Box, Text } from "ink";
import { MultilineText } from "./MultilineText.js";

/** A bordered dialog around a permission prompt's summary/diff preview — previously just dim inline text, indistinguishable from any other system message even though it's the one place the user is asked to make a real decision. */
export function ConfirmPrompt({ text }: { text: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Text color="yellow" bold>
        ⚠ Confirm
      </Text>
      <MultilineText text={text} />
    </Box>
  );
}
