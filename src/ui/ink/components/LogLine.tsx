import React from "react";
import { Text } from "ink";
import type { LogItem } from "../store.js";
import { MultilineText } from "./MultilineText.js";
import { RenderedMarkdown } from "./RenderedMarkdown.js";
import { Banner } from "./Banner.js";

export function LogLine({ item }: { item: LogItem }) {
  switch (item.kind) {
    case "user":
      return <Text color="cyan">{"> "}{item.text}</Text>;
    case "assistant":
      return <RenderedMarkdown text={item.text} />;
    case "system":
      return <MultilineText text={item.text} dimColor />;
    case "error":
      return <Text color="red">{item.text}</Text>;
    case "banner":
      return <Banner version={item.version} />;
    default:
      return null;
  }
}
