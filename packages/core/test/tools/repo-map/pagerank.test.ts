import { describe, expect, it } from "vitest";
import { personalizedPageRank } from "../../../src/tools/builtin/repo-map/pagerank.js";

describe("personalizedPageRank (pure)", () => {
  it("ranks a hub file (referenced by many others) above a leaf nobody references", () => {
    // a, b, c all reference "hub"; hub references nothing; leaf is referenced by nobody.
    const nodes = ["a", "b", "c", "hub", "leaf"];
    const edges = [
      { from: "a", to: "hub", weight: 1 },
      { from: "b", to: "hub", weight: 1 },
      { from: "c", to: "hub", weight: 1 },
    ];
    const ranks = personalizedPageRank(nodes, edges);
    expect(ranks.get("hub")!).toBeGreaterThan(ranks.get("leaf")!);
    expect(ranks.get("hub")!).toBeGreaterThan(ranks.get("a")!);
  });

  it("gives every node a rank even with zero edges (uniform)", () => {
    const nodes = ["x", "y", "z"];
    const ranks = personalizedPageRank(nodes, []);
    expect(ranks.size).toBe(3);
    expect(ranks.get("x")).toBeCloseTo(ranks.get("y")!, 5);
    expect(ranks.get("x")).toBeCloseTo(ranks.get("z")!, 5);
  });

  it("returns an empty map for an empty node list", () => {
    expect(personalizedPageRank([], []).size).toBe(0);
  });

  it("weighs a heavier edge more than a lighter one", () => {
    const nodes = ["a", "heavy_target", "light_target"];
    const edges = [
      { from: "a", to: "heavy_target", weight: 10 },
      { from: "a", to: "light_target", weight: 1 },
    ];
    const ranks = personalizedPageRank(nodes, edges);
    expect(ranks.get("heavy_target")!).toBeGreaterThan(ranks.get("light_target")!);
  });

  it("personalization boosts the given node's rank over plain PageRank", () => {
    const nodes = ["a", "b", "c"];
    const edges = [
      { from: "a", to: "b", weight: 1 },
      { from: "b", to: "c", weight: 1 },
      { from: "c", to: "a", weight: 1 },
    ];
    const plain = personalizedPageRank(nodes, edges);
    const boosted = personalizedPageRank(nodes, edges, new Map([["c", 1]]));
    expect(boosted.get("c")!).toBeGreaterThan(plain.get("c")!);
  });

  it("ranks sum to approximately 1 (a valid probability distribution)", () => {
    const nodes = ["a", "b", "c", "d"];
    const edges = [
      { from: "a", to: "b", weight: 1 },
      { from: "b", to: "c", weight: 2 },
      { from: "c", to: "a", weight: 1 },
    ];
    const ranks = personalizedPageRank(nodes, edges);
    const total = [...ranks.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 3);
  });
});
