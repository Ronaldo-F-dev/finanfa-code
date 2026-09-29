import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../../core/types.js";
import { resolveAllowedPath } from "./path-guard.js";
import { runSubprocess } from "../../util/process.js";

// Real, working docker-compose.yml definitions for the two most common
// "just get monitoring/logging running locally" stacks, written to disk
// and started via the real `docker compose` CLI — same "wrap the real
// CLI, don't reimplement the Docker Engine API" call as containers.ts.
// Deliberately one solid default file per stack (not a templating
// engine): the scope here is "a genuinely functional minimal stack",
// not reproducing mydevops' full template system.
export type MonitoringStack = "grafana-prometheus" | "elk";

const COMPOSE_FILENAME = "docker-compose.yml";

const PROMETHEUS_CONFIG = `global:
  scrape_interval: 15s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
`;

const GRAFANA_PROMETHEUS_COMPOSE = `services:
  prometheus:
    image: prom/prometheus:v2.55.1
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"
  grafana:
    image: grafana/grafana:11.3.1
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    depends_on:
      - prometheus
`;

const LOGSTASH_PIPELINE = `input {
  tcp {
    port => 5000
    codec => json_lines
  }
}

output {
  elasticsearch {
    hosts => ["http://elasticsearch:9200"]
  }
}
`;

const ELK_COMPOSE = `services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.15.3
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - ES_JAVA_OPTS=-Xms512m -Xmx512m
    ports:
      - "9200:9200"
  logstash:
    image: docker.elastic.co/logstash/logstash:8.15.3
    volumes:
      - ./logstash.conf:/usr/share/logstash/pipeline/logstash.conf:ro
    ports:
      - "5000:5000"
    depends_on:
      - elasticsearch
  kibana:
    image: docker.elastic.co/kibana/kibana:8.15.3
    ports:
      - "5601:5601"
    depends_on:
      - elasticsearch
`;

/** The files each stack needs alongside docker-compose.yml, keyed by filename. */
function stackFiles(stack: MonitoringStack): Record<string, string> {
  if (stack === "grafana-prometheus") {
    return { [COMPOSE_FILENAME]: GRAFANA_PROMETHEUS_COMPOSE, "prometheus.yml": PROMETHEUS_CONFIG };
  }
  return { [COMPOSE_FILENAME]: ELK_COMPOSE, "logstash.conf": LOGSTASH_PIPELINE };
}

export interface MonitoringStackToolOptions {
  /** Overridable so tests can point this at a fake stand-in script instead of the real `docker` binary. */
  dockerBinary?: string;
}

interface StartMonitoringStackInput {
  stack: MonitoringStack;
  directory?: string;
}

interface StopMonitoringStackInput {
  directory?: string;
}

export function createMonitoringStackTools(options: MonitoringStackToolOptions = {}): ToolDefinition[] {
  const binary = options.dockerBinary ?? "docker";

  const start: ToolDefinition<StartMonitoringStackInput> = {
    name: "start_monitoring_stack",
    description:
      'Write a real, working docker-compose.yml (+ config) for "grafana-prometheus" (Prometheus scraping ' +
      'itself, Grafana on :3000) or "elk" (Elasticsearch, Logstash listening on :5000 for JSON lines, Kibana on ' +
      ":5601) to `directory` (default: the project root), then run `docker compose up -d` there. Starts REAL " +
      "running containers/infra — confirm with the user before running unless they've explicitly asked for it.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        stack: { type: "string", enum: ["grafana-prometheus", "elk"], description: "Which monitoring/logging stack to start" },
        directory: { type: "string", description: "Directory to write the compose file into and run it from (defaults to the project root)" },
      },
      required: ["stack"],
    },
    riskKey: (input) => `start_monitoring_stack:${input.stack}:${input.directory ?? "."}`,
    describeCall: (input) => `start ${input.stack} monitoring stack in ${input.directory ?? "."}`,
    async handler(input, ctx) {
      const directory = input.directory ? resolveAllowedPath(ctx.cwd, input.directory) : ctx.cwd;
      await mkdir(directory, { recursive: true });
      const files = stackFiles(input.stack);
      for (const [name, content] of Object.entries(files)) {
        await writeFile(path.join(directory, name), content, "utf-8");
      }
      const result = await runSubprocess(binary, {
        cwd: directory,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
        timeoutMs: 120_000,
        args: ["compose", "-f", COMPOSE_FILENAME, "up", "-d"],
      });
      return { ...result, content: `Wrote ${Object.keys(files).join(", ")} to ${directory}\n\n${result.content}` };
    },
  };

  const stop: ToolDefinition<StopMonitoringStackInput> = {
    name: "stop_monitoring_stack",
    description: "Run `docker compose down` for a monitoring stack previously started with start_monitoring_stack, in `directory` (default: the project root).",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory containing the docker-compose.yml to bring down (defaults to the project root)" },
      },
    },
    riskKey: (input) => `stop_monitoring_stack:${input.directory ?? "."}`,
    describeCall: (input) => `stop monitoring stack in ${input.directory ?? "."}`,
    async handler(input, ctx) {
      const directory = input.directory ? resolveAllowedPath(ctx.cwd, input.directory) : ctx.cwd;
      return runSubprocess(binary, {
        cwd: directory,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
        timeoutMs: 60_000,
        args: ["compose", "-f", COMPOSE_FILENAME, "down"],
      });
    },
  };

  return [start, stop];
}
