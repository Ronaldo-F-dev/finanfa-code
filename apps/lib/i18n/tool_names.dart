/// Display names for the agent's tools: what a person reads instead of the id
/// (ask_user, write_file...). Mirrors packages/web-client/src/i18n/toolNames.ts:
/// hand-written French for the tools people meet most, and the id turned into
/// words for every other tool, which is already readable ("Ask user").
const Map<String, String> _frenchToolNames = {
  'ask_user': 'Poser une question',
  'bash': 'Terminal',
  'read_file': 'Lire un fichier',
  'write_file': 'Écrire un fichier',
  'edit_file': 'Modifier un fichier',
  'multi_edit_file': 'Modifier plusieurs passages',
  'glob': 'Chercher des fichiers',
  'grep': 'Chercher dans les fichiers',
  'repo_map': 'Plan du projet',
  'web_fetch': 'Ouvrir une page web',
  'web_search': 'Recherche web',
  'todo_write': 'Liste de tâches',
  'task': 'Sous-agent',
  'exit_plan_mode': 'Valider le plan',
  'python_repl': 'Python',
  'run_tests': 'Lancer les tests',
  'read_document': 'Lire un document',
  'write_document': 'Écrire un document',
  'edit_document': 'Modifier un document',
  'read_notebook': 'Lire un notebook',
  'edit_notebook': 'Modifier un notebook',
  'view_image': 'Voir une image',
  'ocr_image': "Lire le texte d'une image",
  'text_to_speech': 'Synthèse vocale',
  'transcribe_audio': 'Transcrire un audio',
  'translate_text': 'Traduire un texte',
  'schedule_task': 'Planifier une tâche',
  'list_scheduled_tasks': 'Tâches planifiées',
  'send_email': 'Envoyer un e-mail',
  'send_sms_message': 'Envoyer un SMS',
  'send_slack_message': 'Envoyer sur Slack',
  'send_telegram_message': 'Envoyer sur Telegram',
  'send_whatsapp_message': 'Envoyer sur WhatsApp',
  'git_status': 'Git : état',
  'git_diff': 'Git : différences',
  'git_log': 'Git : historique',
  'git_add': 'Git : ajouter',
  'git_commit': 'Git : valider',
  'git_push': 'Git : envoyer',
  'git_pull': 'Git : récupérer',
  'git_branch': 'Git : branches',
  'git_checkout': 'Git : changer de branche',
  'query_database': 'Interroger la base de données',
  'http_request': 'Requête HTTP',
  'start_background_process': 'Lancer en arrière-plan',
  'stop_background_process': 'Arrêter un processus',
  'list_background_processes': 'Processus en arrière-plan',
  'recall_past_sessions': "Retrouver d'anciennes discussions",
};

String _humanize(String id) {
  final words = id
      .replaceFirst(RegExp(r'^mcp__'), '')
      .split(RegExp(r'__|_'))
      .where((w) => w.isNotEmpty)
      .toList();
  if (words.isEmpty) return id;
  final text = words.join(' ');
  return text[0].toUpperCase() + text.substring(1);
}

/// "mcp__github__create_issue" -> "github: Create issue".
String? _mcpLabel(String id) {
  final m = RegExp(r'^mcp__([^_].*?)__(.+)$').firstMatch(id);
  return m == null ? null : '${m.group(1)}: ${_humanize(m.group(2)!)}';
}

/// [language] is "en" or "fr".
String toolLabel(String id, String language) {
  if (language == 'fr' && _frenchToolNames.containsKey(id)) {
    return _frenchToolNames[id]!;
  }
  return _mcpLabel(id) ?? _humanize(id);
}
