import type { ToolRegistry } from "../registry.js";
import type { LlmProvider } from "../../core/types.js";
import type { PermissionManager } from "../../permissions/manager.js";
import type { UIAdapter } from "../../ui/adapter.js";
import type { BrowserManager } from "../../browser/manager.js";
import type { SandboxConfig } from "../../util/sandbox.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { multiEditFileTool } from "./multi-edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { createBashTool } from "./bash.js";
import { webSearchTool } from "./web-search.js";
import { webFetchTool } from "./web-fetch.js";
import { todoWriteTool } from "./todo-write.js";
import { exitPlanModeTool } from "./exit-plan-mode.js";
import { viewImageTool } from "./view-image.js";
import { gitTools } from "./git.js";
import { repoMapTool } from "./repo-map.js";
import { createMydevopsTool } from "./mydevops.js";
import { createFirmwareFlashTools } from "./firmware-flash.js";
import { createEmbeddedDevTools } from "./embedded-dev.js";
import { createContainerTools } from "./containers.js";
import { recallSessionsTool } from "./recall-sessions.js";
import { readTracesTool } from "./read-traces.js";
import { createSchedulerTools } from "./scheduler.js";
import { createSendEmailTool, emailConfigFromEnv } from "./send-email.js";
import { createSendSlackMessageTool, slackConfigFromEnv } from "./send-slack-message.js";
import { createSendTelegramMessageTool, telegramConfigFromEnv } from "./send-telegram-message.js";
import { createSendDiscordMessageTool, discordConfigFromEnv } from "./send-discord-message.js";
import { mqttPublishTool, mqttSubscribeTool } from "./mqtt.js";
import { coapRequestTool } from "./coap.js";
import { createGpioTools } from "./gpio.js";
import { GpioManager } from "../../gpio/manager.js";
import { isCommandAvailable } from "../../util/command-availability.js";
import { runTestsTool } from "./run-tests.js";
import {
  readDocumentTool,
  writeSpreadsheetTool,
  editSpreadsheetTool,
  mergeSpreadsheetsTool,
  mergePdfTool,
  writeDocumentTool,
  editDocumentTool,
} from "./documents.js";
import { readNotebookTool, editNotebookTool } from "./notebook.js";
import { checkPythonTypesTool } from "./check-python-types.js";
import { checkTypescriptTypesTool } from "./check-typescript-types.js";
import { lintPythonTool } from "./lint-python.js";
import { resizeImageTool } from "./resize-image.js";
import { queryDatabaseTool } from "./query-database.js";
import { httpRequestTool } from "./http-request.js";
import { waitForPortTool } from "./wait-for-port.js";
import { lintJavascriptTool } from "./lint-javascript.js";
import { createTaskTool } from "./task.js";
import { createWorkflowTools } from "./workflow.js";
import { createBrowserTools } from "./browser.js";
import { createSerialTools } from "./serial.js";
import { SerialManager } from "../../serial/manager.js";
import { createBackgroundProcessTools } from "./background-process.js";
import { BackgroundProcessManager } from "../../core/background-process.js";
import { createPythonReplTool } from "./python-repl.js";
import { PythonReplManager } from "../../core/python-repl.js";
import { createPreviewHtmlTool } from "./preview-html.js";
import { createArtifactTool } from "./create-artifact.js";
import { PreviewServer } from "../../core/preview-server.js";
import { generate3dTool } from "./generate-3d.js";
import { generate2dTool } from "./generate-2d.js";
import { translateTextTool } from "./translate.js";
import { textToSpeechTool } from "./text-to-speech.js";
import { convertSpreadsheetTool } from "./convert-spreadsheet.js";
import { createConvertToPdfTool } from "./convert-to-pdf.js";
import { convertPdfToImageTool } from "./convert-pdf-to-image.js";
import { splitPdfTool } from "./split-pdf.js";
import { imagesToPdfTool } from "./images-to-pdf.js";
import { ocrImageTool } from "./ocr-image.js";
import { securityScanHeadersTool } from "./security/headers.js";
import { securityScanTlsTool } from "./security/tls.js";
import { securityScanWafTool } from "./security/waf.js";
import { securityScanClickjackingTool } from "./security/clickjacking.js";
import { securityScanSriTool } from "./security/sri.js";
import { securityScanOpenRedirectTool } from "./security/open-redirect.js";
import { securityScanCrlfInjectionTool } from "./security/crlf-injection.js";
import { securityScanSubdomainTakeoverTool } from "./security/subdomain-takeover.js";
import { securityScanEmailSecurityTool } from "./security/email-security.js";
import { securityScanDnsHardeningTool } from "./security/dns-hardening.js";
import { securityScanHostHeaderInjectionTool } from "./security/host-header-injection.js";
import { securityScanCsrfTool } from "./security/csrf.js";
import { securityScanSsrfTool } from "./security/ssrf.js";
import { securityScanXxeTool } from "./security/xxe.js";
import { securityScanLfiTool } from "./security/lfi.js";
import { securityScanReconTool } from "./security/recon.js";
import { securityScanCachePoisoningTool } from "./security/cache-poisoning.js";
import { securityScanIdorTool } from "./security/idor.js";
import { securityScanJwtAuthTool } from "./security/jwt-auth.js";
import { securityScanBflaTool } from "./security/bfla.js";
import { securityScanXssTool } from "./security/xss.js";
import { securityScanInfraExposureTool } from "./security/infra-exposure.js";
import { securityScanParamFuzzingTool } from "./security/param-fuzzing.js";
import { securityScanWebsocketTool } from "./security/websocket.js";
import { securityScanSqliTool } from "./security/sqli.js";
import { securityScanNosqlInjectionTool } from "./security/nosql-injection.js";
import { securityScanSstiTool } from "./security/ssti.js";
import { securityScanCommandInjectionTool } from "./security/command-injection.js";
import { securityScanLdapInjectionTool } from "./security/ldap-injection.js";
import { securityScanDiscoveryTool } from "./security/discovery.js";
import { securityScanSecretsTool } from "./security/secrets.js";
import { securityScanStorageTool } from "./security/storage.js";
import { securityScanAccountCreationTool } from "./security/account-creation.js";
import { securityScanCrawlerTool } from "./security/crawler.js";
import { createPromptInjectionScanTool } from "./security/prompt-injection.js";
import { createPiiLeakageScanTool } from "./security/pii-leakage.js";
import { createExcessiveAgencyScanTool } from "./security/excessive-agency.js";
import { createSystemPromptLeakScanTool } from "./security/system-prompt-leak.js";
import { createJailbreakScanTool } from "./security/jailbreak.js";
import type { SubagentType } from "../../agents/loader.js";

/** Stateless builtins — no shared instance state, safe to register in any order. */
export function registerBuiltins(registry: ToolRegistry, opts?: { sandbox?: SandboxConfig }): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(multiEditFileTool);
  registry.register(globTool);
  registry.register(repoMapTool);
  // Optional external-CLI wrappers: only registered when the underlying
  // binary is actually installed — otherwise the model would see a tool
  // that can never work on this machine and waste a turn discovering
  // that at call time instead of the tool simply not being offered.
  if (isCommandAvailable("mydevops")) registry.register(createMydevopsTool());
  const [esptoolTool, avrdudeTool] = createFirmwareFlashTools();
  if (isCommandAvailable("esptool")) registry.register(esptoolTool!);
  if (isCommandAvailable("avrdude")) registry.register(avrdudeTool!);
  const [arduinoCliTool, platformioTool] = createEmbeddedDevTools();
  if (isCommandAvailable("arduino-cli")) registry.register(arduinoCliTool!);
  if (isCommandAvailable("pio")) registry.register(platformioTool!);
  const [dockerTool, kubectlTool] = createContainerTools();
  if (isCommandAvailable("docker")) registry.register(dockerTool!);
  if (isCommandAvailable("kubectl")) registry.register(kubectlTool!);
  registry.register(mqttPublishTool);
  registry.register(mqttSubscribeTool);
  registry.register(coapRequestTool);
  for (const tool of createGpioTools(new GpioManager())) registry.register(tool);
  registry.register(recallSessionsTool);
  registry.register(readTracesTool);
  for (const tool of createSchedulerTools()) registry.register(tool);
  registry.register(createSendEmailTool(emailConfigFromEnv()));
  registry.register(createSendSlackMessageTool(slackConfigFromEnv()));
  registry.register(createSendTelegramMessageTool(telegramConfigFromEnv()));
  registry.register(createSendDiscordMessageTool(discordConfigFromEnv()));
  registry.register(grepTool);
  registry.register(createBashTool(opts?.sandbox));
  registry.register(webSearchTool);
  registry.register(webFetchTool);
  registry.register(todoWriteTool);
  registry.register(exitPlanModeTool);
  registry.register(viewImageTool);
  registry.register(runTestsTool);
  registry.register(readDocumentTool);
  registry.register(writeSpreadsheetTool);
  registry.register(editSpreadsheetTool);
  registry.register(mergeSpreadsheetsTool);
  registry.register(mergePdfTool);
  registry.register(writeDocumentTool);
  registry.register(editDocumentTool);
  registry.register(readNotebookTool);
  registry.register(editNotebookTool);
  registry.register(checkPythonTypesTool);
  registry.register(checkTypescriptTypesTool);
  registry.register(lintPythonTool);
  registry.register(resizeImageTool);
  registry.register(queryDatabaseTool);
  registry.register(httpRequestTool);
  registry.register(lintJavascriptTool);
  registry.register(waitForPortTool);
  registry.register(generate3dTool);
  registry.register(generate2dTool);
  registry.register(translateTextTool);
  registry.register(textToSpeechTool);
  registry.register(convertSpreadsheetTool);
  registry.register(convertPdfToImageTool);
  registry.register(splitPdfTool);
  registry.register(imagesToPdfTool);
  registry.register(ocrImageTool);
  registry.register(securityScanHeadersTool);
  registry.register(securityScanTlsTool);
  registry.register(securityScanWafTool);
  registry.register(securityScanClickjackingTool);
  registry.register(securityScanSriTool);
  registry.register(securityScanOpenRedirectTool);
  registry.register(securityScanCrlfInjectionTool);
  registry.register(securityScanSubdomainTakeoverTool);
  registry.register(securityScanEmailSecurityTool);
  registry.register(securityScanDnsHardeningTool);
  registry.register(securityScanHostHeaderInjectionTool);
  registry.register(securityScanCsrfTool);
  registry.register(securityScanSsrfTool);
  registry.register(securityScanXxeTool);
  registry.register(securityScanLfiTool);
  registry.register(securityScanReconTool);
  registry.register(securityScanCachePoisoningTool);
  registry.register(securityScanIdorTool);
  registry.register(securityScanJwtAuthTool);
  registry.register(securityScanBflaTool);
  registry.register(securityScanXssTool);
  registry.register(securityScanInfraExposureTool);
  registry.register(securityScanParamFuzzingTool);
  registry.register(securityScanWebsocketTool);
  registry.register(securityScanSqliTool);
  registry.register(securityScanNosqlInjectionTool);
  registry.register(securityScanSstiTool);
  registry.register(securityScanCommandInjectionTool);
  registry.register(securityScanLdapInjectionTool);
  registry.register(securityScanDiscoveryTool);
  registry.register(securityScanSecretsTool);
  registry.register(securityScanStorageTool);
  registry.register(securityScanAccountCreationTool);
  registry.register(securityScanCrawlerTool);
  for (const tool of gitTools) registry.register(tool);
}

export interface StatefulToolDeps {
  provider: LlmProvider;
  permissions: PermissionManager;
  ui: UIAdapter;
  model: string;
  cwd: string;
  browser: BrowserManager;
  designContract: string;
  /** The session's real system prompt — used by the LLM self-red-team tools (security_scan_prompt_injection/system_prompt_leak/jailbreak) to test what THIS agent actually does, not a stand-in. */
  systemPrompt: string;
  /** Custom subagent types (see agents/loader.ts), selectable by the task tool's agentType input. */
  agentTypes?: SubagentType[];
}

/**
 * Builtins that need a shared manager instance (task delegation needs the
 * registry itself; browser/background-process/python-repl/preview_html each
 * own a long-lived resource reused across calls in the session). Kept
 * separate from registerBuiltins so that function stays a flat list with no
 * constructor arguments — but both are called together from cli.ts, and
 * this is the single place that shows the full builtin tool surface.
 */
export function registerStatefulBuiltins(registry: ToolRegistry, deps: StatefulToolDeps): void {
  registry.register(createTaskTool({ ...deps, tools: registry }));
  for (const tool of createWorkflowTools({ ...deps, tools: registry })) registry.register(tool);
  const redteamDeps = { provider: deps.provider, model: deps.model, systemPrompt: deps.systemPrompt };
  registry.register(createPromptInjectionScanTool(redteamDeps));
  registry.register(createSystemPromptLeakScanTool(redteamDeps));
  registry.register(createJailbreakScanTool(redteamDeps));
  registry.register(createPiiLeakageScanTool(redteamDeps));
  registry.register(createExcessiveAgencyScanTool(redteamDeps));
  for (const tool of createBrowserTools(deps.browser)) registry.register(tool);
  for (const tool of createSerialTools(new SerialManager())) registry.register(tool);
  for (const tool of createBackgroundProcessTools(new BackgroundProcessManager())) registry.register(tool);
  registry.register(createPythonReplTool(new PythonReplManager()));
  // Shared between the two so a preview_html-opened file and a
  // create_artifact-opened file are served from the same origin/port.
  const previewServer = new PreviewServer();
  registry.register(createPreviewHtmlTool(previewServer));
  registry.register(createArtifactTool(previewServer, deps.designContract));
  registry.register(createConvertToPdfTool(deps.browser));
}
