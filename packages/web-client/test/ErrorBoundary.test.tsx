// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ErrorBoundary } from "../src/ErrorBoundary";
import { LanguageProvider } from "../src/i18n/LanguageContext";

// The web UI's first component test, for the one component that must work
// when nothing else does: a render error anywhere below used to unmount the
// whole tree (a blank page), so the boundary is exercised against a child
// that always throws.
function Boom(): never {
  throw new Error("kaboom");
}

function wrap(children: ReactNode) {
  // LanguageProvider picks navigator.language; jsdom reports en-US, so the
  // assertions below read the English strings.
  return render(<LanguageProvider>{children}</LanguageProvider>);
}

describe("ErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    wrap(
      <ErrorBoundary>
        <div>still fine</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText("still fine")).toBeTruthy();
  });

  it("shows a reloadable screen instead of blanking the page", () => {
    // React logs the caught error itself; silenced so the test output stays
    // about the assertion.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    wrap(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();

    logged.mockRestore();
  });
});
