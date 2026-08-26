import React, { useEffect, useMemo, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { UiStore } from "./store.js";
import { LogLine } from "./components/LogLine.js";
import { MultilineText } from "./components/MultilineText.js";
import { StatusBar } from "./components/StatusBar.js";
import { CommandSuggestions } from "./components/CommandSuggestions.js";

export function App({
  store,
  onSubmit,
}: {
  store: UiStore;
  onSubmit: (value: string) => void;
}) {
  const [, forceRender] = useState(0);
  const [input, setInput] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const handler = () => forceRender((n) => n + 1);
    store.on("change", handler);
    return () => {
      store.off("change", handler);
    };
  }, [store]);

  const isChatInput = (store.prompt?.kind ?? "input") === "input";
  const suggestions = useMemo(() => {
    if (!isChatInput || !input.startsWith("/")) return [];
    const query = input.slice(1).toLowerCase();
    return store.commands.filter((c) => c.name.toLowerCase().startsWith(query));
  }, [isChatInput, input, store.commands]);

  const clampedIndex = Math.min(selectedIndex, Math.max(0, suggestions.length - 1));

  // Ink's raw mode swallows the terminal's own Ctrl+C -> SIGINT handling, so
  // we translate it back into a real signal ourselves — this lets cli.ts's
  // process.on("SIGINT", ...) shutdown handler run the same way it does for
  // the readline UI (persist the session, close MCP connections, exit).
  useInput((keyInput, key) => {
    if (key.ctrl && keyInput === "c") {
      process.kill(process.pid, "SIGINT");
    }
  });

  useInput(
    (_char, key) => {
      if (key.tab) {
        const chosen = suggestions[clampedIndex];
        if (chosen) setInput(`/${chosen.name} `);
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(suggestions.length - 1, i + 1));
      }
    },
    { isActive: suggestions.length > 0 },
  );

  function handleChange(value: string): void {
    setInput(value);
    setSelectedIndex(0);
  }

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
            onChange={handleChange}
            onSubmit={(value) => {
              setInput("");
              setSelectedIndex(0);
              onSubmit(value);
            }}
          />
        </Box>
        <CommandSuggestions suggestions={suggestions} selectedIndex={clampedIndex} />
      </Box>

      <StatusBar status={store.status} />
    </Box>
  );
}
