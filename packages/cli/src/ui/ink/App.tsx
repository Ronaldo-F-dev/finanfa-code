import React, { useEffect, useMemo, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { UiStore } from "./store.js";
import { LogLine } from "./components/LogLine.js";
import { RenderedMarkdown } from "./components/RenderedMarkdown.js";
import { StatusBar } from "./components/StatusBar.js";
import { CommandSuggestions } from "./components/CommandSuggestions.js";
import { ConfirmPrompt } from "./components/ConfirmPrompt.js";

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

  // Ticks the elapsed-time display on the busy spinner once a second — the
  // store itself only emits "change" when something actually happens
  // (a delta, a tool call starting), so without this a long silent stretch
  // (a slow local model composing a big response) renders the exact same
  // "thinking..." forever, indistinguishable from a hung process.
  useEffect(() => {
    if (!store.busy) return;
    const interval = setInterval(() => forceRender((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [store.busy]);

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

      {store.streaming.length > 0 && <RenderedMarkdown text={store.streaming} />}

      {store.busy && (
        <Text color="cyan" bold>
          <Spinner type="dots" />
          {" "}{store.busyLabel ?? "working"}...
          {store.busySince !== undefined && ` ${Math.floor((Date.now() - store.busySince) / 1000)}s`}
        </Text>
      )}

      <Box marginTop={1} flexDirection="column">
        {showPromptLabel && <ConfirmPrompt text={store.prompt!.text} />}
        <Box>
          <Text color="cyan">{"> "}</Text>
          <TextInput
            value={input}
            onChange={handleChange}
            onSubmit={(value) => {
              // Real reported bug: arrowing to a highlighted suggestion and
              // pressing Enter submitted the raw typed text ("/") instead of
              // the highlighted command — only Tab (above) actually applied
              // a suggestion; Enter went straight to ink-text-input's own
              // onSubmit with whatever was literally typed, ignoring
              // selectedIndex entirely. While a suggestion list is showing,
              // Enter now submits the highlighted one, same as Tab already
              // does — this is what a user arrowing through a dropdown
              // expects either key to do.
              const chosen = suggestions.length > 0 ? suggestions[clampedIndex] : undefined;
              setInput("");
              setSelectedIndex(0);
              onSubmit(chosen ? `/${chosen.name}` : value);
            }}
          />
        </Box>
        <CommandSuggestions suggestions={suggestions} selectedIndex={clampedIndex} />
      </Box>

      <StatusBar status={store.status} />
    </Box>
  );
}
