import 'package:flutter_test/flutter_test.dart';
import 'package:finanfa/core/models/session_models.dart';
import 'package:finanfa/screens/tools_screen.dart';

// The Tools screen filters by name and risk level; the pure helper is tested
// directly so the combination (a search that narrows a risk-filtered list)
// is covered without pumping the whole screen.
void main() {
  const tools = [
    ToolStatus(name: "read_file", riskLevel: "safe", enabled: true),
    ToolStatus(name: "write_file", riskLevel: "ask", enabled: true),
    ToolStatus(name: "bash", riskLevel: "dangerous", enabled: false),
  ];

  test("filters by name, case-insensitively and on substrings", () {
    expect(
      filterTools(tools, query: "WRITE").map((tool) => tool.name),
      ["write_file"],
    );
    expect(
      filterTools(tools, query: " file").map((tool) => tool.name),
      ["read_file", "write_file"],
    );
  });

  test("filters by risk level", () {
    expect(
      filterTools(tools, query: "", risk: "safe").map((tool) => tool.name),
      ["read_file"],
    );
    expect(
      filterTools(tools, query: "", risk: "dangerous").map((tool) => tool.name),
      ["bash"],
    );
  });

  test("combines both filters", () {
    expect(
      filterTools(tools, query: "file", risk: "ask").map((tool) => tool.name),
      ["write_file"],
    );
  });

  test("an empty query and no risk keeps every tool in order", () {
    expect(filterTools(tools, query: "").map((tool) => tool.name), [
      "read_file",
      "write_file",
      "bash",
    ]);
  });
}
