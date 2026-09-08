import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Banner } from "../../src/ui/ink/components/Banner.js";

describe("Banner", () => {
  it("shows the name, version, and tagline", () => {
    const { lastFrame } = render(<Banner version="1.2.3" />);
    const frame = lastFrame();

    expect(frame).toContain("finanfa-code");
    expect(frame).toContain("v1.2.3");
    expect(frame).toContain("your own coding agent");
  });

  it("renders inside a bordered box", () => {
    const { lastFrame } = render(<Banner version="1.2.3" />);
    expect(lastFrame()).toMatch(/[╭╮╯╰─│]/);
  });
});
