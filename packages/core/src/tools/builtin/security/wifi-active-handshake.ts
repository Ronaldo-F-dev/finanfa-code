import type { ToolDefinition } from "../../../core/types.js";
import { isCommandAvailable } from "../../../util/command-availability.js";
import { listWifiInterfacesLinux } from "./wifi-capture.js";
import { isValidMacAddress } from "./bluetooth-gatt.js";

// --- Pure, real, verified output parsers for the eventual capture sequence
// (see the still-unimplemented TODO below) — deliberately the ONLY things
// added here beyond the original stub's prerequisite checks. Each is a
// read-only string-in/value-out function with no subprocess of its own: no
// monitor-mode enable/restore, no airodump-ng/aireplay-ng invocation. That
// orchestration — the actual attack sequence — is left to the same
// implementer this stub always deferred to; these just save them from
// re-deriving well-documented but easy-to-mistype real tool-output formats.

/** A BSSID IS a MAC address — reuses the exact same validator
 * bluetooth-gatt.ts's isValidMacAddress already established (same shape,
 * same reasoning: reject anything that isn't the real address form up
 * front, before it can reach a real device/tool invocation). */
export const isValidBssid = isValidMacAddress;

/** Extracts the monitor-mode interface name from a real `airmon-ng start
 * <iface>` invocation's own stdout. Two real, documented output shapes
 * exist depending on driver/airmon-ng version (both verified against
 * aircrack-ng's own real-world usage, not guessed):
 *   - older: "(monitor mode enabled on mon0)"
 *   - mac80211 drivers: "(mac80211 monitor mode vif enabled for [phy0]wlan0
 *     on [phy0]wlan0mon)" — the interface name is after the LAST "on ",
 *     stripping a leading "[phyN]" prefix if present.
 * Returns undefined if neither shape is found (e.g. airmon-ng reported an
 * error instead) — the caller decides how to treat that, this never guesses. */
export function parseMonitorModeInterface(airmonNgStartOutput: string): string | undefined {
  const match = /\bon\s+(?:\[[^\]]+\])?(\S+?)\)/.exec(airmonNgStartOutput);
  return match?.[1];
}

/** True once airodump-ng's own status line reports a captured handshake for
 * the given target BSSID — its real, documented display format is
 * "][ WPA handshake: AA:BB:CC:DD:EE:FF" in the header row, case-insensitive,
 * BSSID formatting aside. Matched against the specific target, not just
 * "a handshake for something" — airodump-ng can be watching more than one
 * BSSID's traffic at once. */
export function parseHandshakeCaptured(airodumpNgOutput: string, targetBssid: string): boolean {
  const escaped = targetBssid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`WPA handshake:\\s*${escaped}`, "i").test(airodumpNgOutput);
}

// STUB — active Wi-Fi WPA handshake capture via deauthentication. Ported
// from wireless-lab's wifi/capture/src/active.ts (ActiveWifiHandshakeCaptureModule):
// checkPrerequisites is real and fully implemented below (verifying tool/
// platform/interface/target preconditions is pure detection, not an
// attack); run() intentionally throws — the actual monitor-mode-enable +
// deauth + handshake-capture sequence forces another client to
// reassociate, which is an attack action against a network's other
// clients, not passive enumeration, and needs the user's own
// implementation plus explicit authorization for the target network. Fill
// in the "not implemented" branch below once ready.

export interface WifiActiveHandshakeCaptureOptions {
  airmonNgBinary?: string;
  aireplayNgBinary?: string;
  airodumpNgBinary?: string;
  iwBinary?: string;
  platformOverride?: NodeJS.Platform;
}

interface WifiActiveHandshakeCaptureInput {
  interfaceName: string;
  targetBssid: string;
}

export function createSecurityWifiActiveHandshakeCaptureTool(options: WifiActiveHandshakeCaptureOptions = {}): ToolDefinition<WifiActiveHandshakeCaptureInput> {
  const platform = options.platformOverride ?? process.platform;
  const airmonNgBin = options.airmonNgBinary ?? "airmon-ng";
  const aireplayNgBin = options.aireplayNgBinary ?? "aireplay-ng";
  const airodumpNgBin = options.airodumpNgBinary ?? "airodump-ng";
  const iwBin = options.iwBinary ?? "iw";

  return {
    name: "security_wifi_active_handshake_capture",
    description:
      "STUB, NOT YET IMPLEMENTED. Intended to capture a WPA/WPA2 4-way handshake by putting an interface into " +
      "monitor mode, sending deauthentication frames at a target BSSID to force a client to reassociate, and " +
      "recording the resulting handshake with the aircrack-ng suite. This is an attack against a network's " +
      "other clients (not passive enumeration) and requires explicit, documented authorization for the target " +
      "network before ever being run. Currently only verifies real preconditions (platform, aircrack-ng suite " +
      "installed, monitor-mode-capable interface, target BSSID given) and then returns a clear " +
      "not-implemented error, see this tool's handler in wifi-active-handshake.ts for the TODO describing " +
      "what belongs in it.",
    riskLevel: "dangerous",
    inputSchema: {
      type: "object",
      properties: {
        interfaceName: { type: "string", description: "Wi-Fi interface to put into monitor mode (must support monitor mode, e.g. via a compatible external adapter)" },
        targetBssid: { type: "string", description: "BSSID of the target access point to capture a handshake from" },
      },
      required: ["interfaceName", "targetBssid"],
    },
    riskKey: (input) => `security_wifi_active_handshake_capture:${input.targetBssid}`,
    describeCall: (input) => `[STUB, not implemented] active WPA handshake capture against ${input.targetBssid} via ${input.interfaceName}`,
    async handler(input) {
      // --- real, working prerequisite checks (mirrors wireless-lab's
      // checkPrerequisites — verifying preconditions is pure detection, not
      // an attack action) ---
      if (platform !== "linux") {
        return { content: `Deauthentication/injection tooling (aircrack-ng suite) targets Linux only; this host reports platform "${platform}".`, isError: true };
      }
      const missingTools = [
        ["airmon-ng", airmonNgBin],
        ["aireplay-ng", aireplayNgBin],
        ["airodump-ng", airodumpNgBin],
      ].filter(([, bin]) => !isCommandAvailable(bin));
      if (missingTools.length > 0) {
        return { content: `Missing required tool(s) from the aircrack-ng suite: ${missingTools.map(([name]) => name).join(", ")}. Install aircrack-ng and ensure they're on PATH.`, isError: true };
      }
      const interfaces = await listWifiInterfacesLinux(iwBin);
      const iface = interfaces.find((i) => i.name === input.interfaceName);
      if (!iface) {
        return { content: `Interface "${input.interfaceName}" not found via \`iw dev\`. Known interfaces: ${interfaces.map((i) => i.name).join(", ") || "(none detected)"}.`, isError: true };
      }
      if (iface.supportsMonitorMode !== true) {
        return { content: `Interface "${input.interfaceName}" does not report monitor-mode support (\`iw phy ... info\` has no "monitor" under supported interface modes), a monitor-mode-capable adapter is required for deauthentication/handshake capture.`, isError: true };
      }
      if (!input.targetBssid) {
        return { content: "A target BSSID is required.", isError: true };
      }
      if (!isValidBssid(input.targetBssid)) {
        return { content: `"${input.targetBssid}" is not a valid BSSID, expected a MAC address like "AA:BB:CC:DD:EE:FF".`, isError: true };
      }

      // --- not implemented past this point ---
      // TODO (fill this in yourself, once authorized against the target
      // network): the actual handshake-capture sequence belongs here.
      // Roughly, in order:
      //   1. Put the chosen interface into monitor mode
      //      (`airmon-ng start <interfaceName>`), tracking the resulting
      //      monitor-mode interface name it prints — use
      //      parseMonitorModeInterface() above on that real output rather
      //      than re-deriving the "(monitor mode enabled on X)" /
      //      "(mac80211 ... on [phyN]X)" parsing.
      //   2. Start `airodump-ng` on the target BSSID/channel, writing to a
      //      capture file prefix (`-w <prefix> --bssid <targetBssid> -c
      //      <channel> <mon-interface>`), kept running through steps 3-4.
      //   3. Send deauthentication frames at the target BSSID
      //      (`aireplay-ng --deauth <count> -a <targetBssid> [-c
      //      <client-mac>] <mon-interface>`) to force a connected client to
      //      reassociate.
      //   4. Watch airodump-ng's own output/capture file for a "WPA
      //      handshake:" confirmation for THIS target BSSID — use
      //      parseHandshakeCaptured() above rather than re-deriving that
      //      format — then stop both processes.
      //   5. Restore the interface out of monitor mode
      //      (`airmon-ng stop <mon-interface>`), even on error.
      //   6. Return the resulting .cap file's path — security_scan_wifi's
      //      captureFilePath input can then analyze it once captured.
      // Handle: monitor-mode enable failing, no handshake within a
      // timeout, and always restoring the interface's original mode.
      return {
        content:
          "Preconditions verified (platform, aircrack-ng suite, monitor-mode-capable interface, target BSSID), " +
          "but the actual capture sequence is not implemented yet, see the TODO comment in this tool's handler " +
          "(packages/core/src/tools/builtin/security/wifi-active-handshake.ts) for the 6 steps it needs.",
        isError: true,
      };
    },
  };
}
