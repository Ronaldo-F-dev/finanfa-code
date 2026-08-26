import React, { useEffect, useState } from "react";
import { Box, Static, Text } from "ink";
import TextInput from "ink-text-input";
import type { UiStore } from "./store.js";
import { LogLine } from "./components/LogLine.js";
import { MultilineText } from "./components/MultilineText.js";
import { StatusBar } from "./components/StatusBar.js";

export function App({
  store,
  onSubmit,
}: {
  store: UiStore;
  onSubmit: (value: string) => void;
}) {
  const [, forceRender] = useState(0);
  const [input, setInput] = useState("");

  useEffect(() => {
    const handler = () => forceRender((n) => n + 1);
    store.on("change", handler);
    return () => {
      store.off("change", handler);
    };
  }, [store]);

  const showPromptLabel = store.prompt?.kind === "confirm" && store.prompt.text.trim().length > 0;

  return (
    <Box flexDirection="column">
      <Static items={store.log}>
        {(item, i) => <LogLine key={i} item={item} />}
      </Static>

      {store.streaming.length > 0 && <MultilineText text={store.streaming} />}

      <Box marginTop={1} flexDirection="column">
        {showPromptLabel && <MultilineText text={store.prompt!.text} dimColor />}
        <Box>
          <Text color="cyan">{"> "}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={(value) => {
              setInput("");
              onSubmit(value);
            }}
          />
        </Box>
      </Box>

      <StatusBar status={store.status} />
    </Box>
  );
}
