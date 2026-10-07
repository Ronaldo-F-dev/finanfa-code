import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { createMonitoringStackTools } from "../../src/tools/builtin/monitoring-stack.js";

const FAKE_DOCKER_COMPOSE = fileURLToPath(new URL("../fixtures/fake-docker-compose.mjs", import.meta.url));

const ctx = (dir: string) => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

describe("monitoring-stack tools (real docker-compose.yml written to disk, fake docker binary)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-monitoring-stack-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("has 'ask' risk level for both tools", () => {
    const [start, stop] = createMonitoringStackTools({ dockerBinary: FAKE_DOCKER_COMPOSE });
    expect(start.riskLevel).toBe("ask");
    expect(stop.riskLevel).toBe("ask");
  });

  it("start_monitoring_stack (grafana-prometheus) writes a real, well-formed docker-compose.yml + prometheus.yml and invokes 'docker compose -f docker-compose.yml up -d'", async () => {
    const [start] = createMonitoringStackTools({ dockerBinary: FAKE_DOCKER_COMPOSE });
    const result = await start.handler({ stack: "grafana-prometheus", directory: "." }, ctx(dir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Creating containers from docker-compose.yml");

    const composeRaw = await readFile(path.join(dir, "docker-compose.yml"), "utf-8");
    const compose = yaml.load(composeRaw) as any;
    expect(compose.services.prometheus.image).toMatch(/^prom\/prometheus:/);
    expect(compose.services.grafana.image).toMatch(/^grafana\/grafana:/);
    expect(compose.services.prometheus.volumes).toContain("./prometheus.yml:/etc/prometheus/prometheus.yml:ro");
    expect(compose.services.grafana.ports).toContain("3000:3000");

    const prometheusRaw = await readFile(path.join(dir, "prometheus.yml"), "utf-8");
    const prometheusConfig = yaml.load(prometheusRaw) as any;
    expect(prometheusConfig.scrape_configs[0].job_name).toBe("prometheus");
  });

  it("start_monitoring_stack (elk) writes a real, well-formed docker-compose.yml + logstash.conf", async () => {
    const [start] = createMonitoringStackTools({ dockerBinary: FAKE_DOCKER_COMPOSE });
    const result = await start.handler({ stack: "elk", directory: "." }, ctx(dir));
    expect(result.isError).toBe(false);

    const composeRaw = await readFile(path.join(dir, "docker-compose.yml"), "utf-8");
    const compose = yaml.load(composeRaw) as any;
    expect(compose.services.elasticsearch.image).toMatch(/^docker\.elastic\.co\/elasticsearch\/elasticsearch:/);
    expect(compose.services.logstash.image).toMatch(/^docker\.elastic\.co\/logstash\/logstash:/);
    expect(compose.services.kibana.image).toMatch(/^docker\.elastic\.co\/kibana\/kibana:/);
    expect(compose.services.logstash.depends_on).toContain("elasticsearch");

    const logstashConf = await readFile(path.join(dir, "logstash.conf"), "utf-8");
    expect(logstashConf).toContain("elasticsearch:9200");
  });

  it("stop_monitoring_stack invokes 'docker compose -f docker-compose.yml down'", async () => {
    const [start, stop] = createMonitoringStackTools({ dockerBinary: FAKE_DOCKER_COMPOSE });
    await start.handler({ stack: "elk", directory: "." }, ctx(dir));
    const result = await stop.handler({ directory: "." }, ctx(dir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Stopping containers from docker-compose.yml");
  });

  it("gives a clear error (not a thrown exception) when the docker binary is missing", async () => {
    const [start] = createMonitoringStackTools({ dockerBinary: "this-binary-does-not-exist-anywhere" });
    const result = await start.handler({ stack: "grafana-prometheus", directory: "." }, ctx(dir));
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("this-binary-does-not-exist-anywhere");
  });
});
