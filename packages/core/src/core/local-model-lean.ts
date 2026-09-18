/**
 * Real, reported finding (a code investigation of OpenClaw, a comparable
 * reference agent): it has a "local-model-lean" mode that strips
 * high-latency/channel-dependent tools (browser, automations, image/video/
 * audio generation, TTS, PDF, message) for local models, on top of its own
 * Tool Search reducing the total count sent per turn. Tool Search alone
 * still lets a local model *discover* (via search_tools) and attempt to
 * call any of these — several of which are slow, need real external
 * services (Slack/Discord/Telegram/etc. credentials, a real browser), or
 * are simply unlikely to matter for the kind of quick local-model session
 * this is aimed at. This is the finanfa-code equivalent: an explicit,
 * evidence-mapped exclusion list (not a heuristic against every tool's
 * name/description), applied in loop.ts's availableTools() so both a
 * direct call and Tool Search's search_tools/call_tool resolve against
 * the same trimmed set — a disabled-here tool is genuinely unreachable,
 * not just hidden from the schema list.
 */
export const LOCAL_MODEL_LEAN_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  // Browser automation — needs a real headless Chromium instance and is
  // one of the slowest tool categories to actually run.
  "browser_navigate",
  "browser_screenshot",
  "browser_click",
  "browser_fill",

  // Automations/scheduling — persistent background state a quick local
  // session is unlikely to need, and needless complexity for a model
  // already struggling with simpler single-shot tool calls.
  "schedule_task",
  "list_scheduled_tasks",
  "unschedule_task",
  "run_workflow",
  "list_workflows",

  // Image/video/audio generation and transcription — slow, and (generate_2d/
  // generate_3d, text_to_speech) call real paid/rate-limited external
  // services most local setups have no reason to be routing through a
  // local model's own tool selection in the first place.
  "generate_2d",
  "generate_3d",
  "text_to_speech",
  "transcribe_audio",
  "analyze_video",
  "view_video_frames",

  // PDF conversion — shells out to a headless browser or poppler-utils;
  // rarely the point of a quick local-model coding session.
  "convert_to_pdf",
  "convert_pdf_to_image",
  "split_pdf",
  "images_to_pdf",
  "merge_pdf",

  // Messaging/channel tools — every one of these needs its own configured
  // channel credentials (Slack/Discord/Telegram/...) and sends a real,
  // externally-visible message; not something a local coding session
  // should be one confused tool-call away from doing.
  "send_discord_message",
  "send_email",
  "send_feishu_message",
  "send_line_message",
  "send_matrix_message",
  "send_slack_message",
  "send_sms_message",
  "send_teams_message",
  "send_telegram_message",
  "send_whatsapp_message",
]);
