import { describe, expect, it } from "vitest";
import { extractDefinitions } from "../../../src/tools/builtin/repo-map/parser.js";

describe("extractDefinitions (real tree-sitter parsing, real WASM grammars)", () => {
  it("extracts function/class/method definitions from real TypeScript source", async () => {
    const source = `
function greet(name: string): string {
  return "hi " + name;
}

class Greeter {
  greet(): string {
    return greet("world");
  }
}
`;
    const defs = await extractDefinitions("greeter.ts", source);
    expect(defs).toBeDefined();
    expect(defs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "greet", kind: "function" }),
        expect.objectContaining({ name: "Greeter", kind: "class" }),
        expect.objectContaining({ name: "greet", kind: "method" }),
      ]),
    );
  });

  it("extracts interface and type alias definitions from TypeScript", async () => {
    const source = `
interface Config {
  port: number;
}
type Handler = (req: Config) => void;
`;
    const defs = await extractDefinitions("types.ts", source);
    expect(defs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Config", kind: "interface" }),
        expect.objectContaining({ name: "Handler", kind: "type" }),
      ]),
    );
  });

  it("extracts real Python function/class definitions", async () => {
    const source = `
def hello(name):
    return "hi " + name

class Greeter:
    def greet(self):
        return hello("world")
`;
    const defs = await extractDefinitions("greeter.py", source);
    expect(defs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "hello", kind: "function" }),
        expect.objectContaining({ name: "Greeter", kind: "class" }),
        expect.objectContaining({ name: "greet", kind: "function" }),
      ]),
    );
  });

  it("extracts real Go function/method/type definitions", async () => {
    const source = `
package main

func Hello(name string) string {
	return "hi " + name
}

type Greeter struct{}

func (g Greeter) Greet() string {
	return Hello("world")
}
`;
    const defs = await extractDefinitions("greeter.go", source);
    expect(defs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Hello", kind: "function" }),
        expect.objectContaining({ name: "Greeter", kind: "type" }),
        expect.objectContaining({ name: "Greet", kind: "method" }),
      ]),
    );
  });

  it("extracts real Rust function/struct definitions", async () => {
    const source = `
fn hello(name: &str) -> String {
    format!("hi {}", name)
}

struct Greeter;
`;
    const defs = await extractDefinitions("greeter.rs", source);
    expect(defs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "hello", kind: "function" }),
        expect.objectContaining({ name: "Greeter", kind: "struct" }),
      ]),
    );
  });

  it("extracts real Java class/method/interface definitions", async () => {
    const source = `
public class Greeter {
    public String greet(String name) {
        return "hi " + name;
    }
}
`;
    const defs = await extractDefinitions("Greeter.java", source);
    expect(defs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Greeter", kind: "class" }),
        expect.objectContaining({ name: "greet", kind: "method" }),
      ]),
    );
  });

  it("returns undefined for an unsupported file extension", async () => {
    expect(await extractDefinitions("README.md", "# hello")).toBeUndefined();
  });

  it("returns line numbers (0-indexed) matching the real source position", async () => {
    const source = "\n\nfunction third() {}\n";
    const defs = await extractDefinitions("f.js", source);
    expect(defs).toEqual(expect.arrayContaining([expect.objectContaining({ name: "third", line: 2 })]));
  });
});
