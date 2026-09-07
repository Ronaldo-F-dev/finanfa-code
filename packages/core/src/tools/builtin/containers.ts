import type { ToolDefinition } from "../../core/types.js";
import { createGenericCliTool } from "./generic-cli-wrapper.js";

// Docker/Kubernetes — a real, standalone capability rather than only
// reachable indirectly via run_mydevops (which requires the user's own
// separate mydevops CLI to be installed). Wraps the real, standard tools
// (same "wrap, don't reimplement" call as every other CLI-wrapper tool in
// this project) rather than re-implementing the Docker Engine API or
// Kubernetes API client — both are large, versioned, evolving APIs where
// the real CLIs already handle auth/context/version-skew correctly.
const DEFAULT_TIMEOUT_MS = 300_000; // an image pull/build or a rollout can take a while

export interface ContainerToolOptions {
  dockerBinary?: string;
  kubectlBinary?: string;
}

export function createContainerTools(options: ContainerToolOptions = {}): ToolDefinition[] {
  const docker = createGenericCliTool(
    "run_docker",
    "docker",
    "Run a Docker CLI subcommand — ps/images/logs/inspect (read-only), build/pull/run/exec/stop/rm/rmi " +
      "(state-changing), compose (compose up/down for multi-container apps), and more. Pass the subcommand as " +
      "args[0] (e.g. ['ps', '-a'], ['build', '-t', 'myapp', '.'], ['run', '-d', '-p', '8080:80', 'nginx'], " +
      "['logs', '-f', 'container_name']). " +
      "IMPORTANT: build/run/rm/rmi/system prune modify real local state (images, containers, volumes) and can " +
      "be destructive/irreversible (rm -f, system prune -a deletes data) — confirm with the user before " +
      "running one of those unless they've explicitly asked for it.",
    { binaryOverride: options.dockerBinary, defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
  );

  const kubectl = createGenericCliTool(
    "run_kubectl",
    "kubectl",
    "Run a kubectl subcommand against whatever cluster/context the user's kubeconfig currently points at — " +
      "get/describe/logs (read-only), apply/create/delete/scale/rollout (state-changing), and more. Pass the " +
      "subcommand as args[0] (e.g. ['get', 'pods', '-n', 'default'], ['apply', '-f', 'deployment.yaml'], " +
      "['logs', '-f', 'my-pod'], ['delete', 'pod', 'my-pod']). " +
      "IMPORTANT: apply/delete/scale/rollout modify a REAL cluster (which may be a real production " +
      "environment, not a sandbox) and can be destructive/irreversible — confirm with the user before " +
      "running one of those, and double-check which context/namespace is active (kubectl config " +
      "current-context) if that isn't already clear.",
    { binaryOverride: options.kubectlBinary, defaultTimeoutMs: DEFAULT_TIMEOUT_MS },
  );

  return [docker, kubectl];
}
