import 'package:flutter_test/flutter_test.dart';
import 'package:finanfa/core/models/session_models.dart';

// The memory/skill payloads come from /api/memory and /api/skills, whose
// responses the web panel already consumes; the app must tolerate a missing
// description (or type/scope) instead of failing to parse the whole list.
void main() {
  test("MemoryEntry parses a full payload and round-trips it back", () {
    final entry = MemoryEntry.fromJson({
      "name": "stack",
      "description": "tech stack",
      "type": "project",
      "content": "Flutter + Riverpod",
      "scope": "project",
    });

    expect(entry.name, "stack");
    expect(entry.type, "project");
    expect(entry.toJson(), {
      "name": "stack",
      "description": "tech stack",
      "type": "project",
      "content": "Flutter + Riverpod",
      "scope": "project",
    });
  });

  test("MemoryEntry fills in defaults for the optional fields", () {
    final entry = MemoryEntry.fromJson({"name": "note"});

    expect(entry.description, "");
    expect(entry.type, "user");
    expect(entry.content, "");
    expect(entry.scope, "global");
  });

  test("SkillEntry parses and defaults the same way, without a type", () {
    final skill = SkillEntry.fromJson({
      "name": "review",
      "content": "# Steps",
      "scope": "project",
    });

    expect(skill.description, "");
    expect(skill.content, "# Steps");
    expect(skill.scope, "project");
    expect(skill.toJson(), {
      "name": "review",
      "description": "",
      "content": "# Steps",
      "scope": "project",
    });
  });
}
