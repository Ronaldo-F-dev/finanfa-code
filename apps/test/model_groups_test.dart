import 'package:finanfa/core/model_groups.dart';
import 'package:finanfa/core/models/session_models.dart';
import 'package:flutter_test/flutter_test.dart';

ModelOption _m(
  String id, {
  String family = 'openai-compatible',
  String? provider,
  String? baseUrl,
  String? localModelId,
  bool local = false,
  bool configured = true,
}) => ModelOption(
  id: id,
  label: id,
  family: family,
  provider: provider,
  baseUrl: baseUrl,
  localModelId: localModelId,
  local: local,
  configured: configured,
);

void main() {
  final models = [
    _m('claude-sonnet-5', family: 'anthropic', configured: false),
    _m('deepseek-v4-pro', provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com'),
    _m('grok-4', provider: 'Grok (xAI)', configured: false),
    _m('Ollama: llama3', localModelId: 'llama3', baseUrl: 'http://localhost:11434/v1'),
    _m('Ternary-Bonsai-4B', local: true),
    _m('my-model'),
  ];

  test('orders Claude, the cloud providers, this machine, then the rest', () {
    expect(groupModels(models).map((g) => g.key), [
      'claude',
      'cloud:DeepSeek',
      'cloud:Grok (xAI)',
      'local',
      'configured',
    ]);
  });

  test('puts detected and config-defined local models together', () {
    final local = groupModels(models).firstWhere((g) => g.key == 'local');
    expect(local.items.map((m) => m.id), ['Ollama: llama3', 'Ternary-Bonsai-4B']);
  });

  test('filters by name or provider and drops empty groups', () {
    expect(groupModels(models, 'grok').map((g) => g.key), ['cloud:Grok (xAI)']);
    expect(
      groupModels(models, 'deepseek').expand((g) => g.items).map((m) => m.id),
      ['deepseek-v4-pro'],
    );
    expect(groupModels(models, 'zzz'), isEmpty);
  });

  test('reads configured and provider from the server, defaulting to usable', () {
    final parsed = ModelOption.fromJson({
      'id': 'grok-4',
      'family': 'openai-compatible',
      'configured': false,
      'provider': 'Grok (xAI)',
    });
    expect(parsed.configured, isFalse);
    expect(parsed.provider, 'Grok (xAI)');
    expect(ModelOption.fromJson({'id': 'x'}).configured, isTrue);
  });
}
