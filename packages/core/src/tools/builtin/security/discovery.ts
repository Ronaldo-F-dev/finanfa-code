import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { ToolDefinition } from "../../../core/types.js";
import { severityFromScore } from "./cvss.js";
import { formatScanOutput, type Finding, type PassedControl, type ScanOutput } from "./types.js";

// Faithful, full port of cyberlens's discovery.py — no crawler dependency
// at all (it only ever probes a fixed list of paths relative to the given
// target), so unlike most other ports in this project this one needed no
// scope reduction. Uses the same soft-404 baseline technique as bfla.ts:
// a random, definitely-nonexistent path is fetched first so a JS-SPA
// serving the same 200 shell for every path isn't misread as every
// sensitive path being exposed.
const LENGTH_TOLERANCE_BYTES = 32;

interface SensitivePathSpec {
  path: string;
  score: number;
  title: string;
  description: string;
  markers?: string[];
}

const SENSITIVE_PATHS: SensitivePathSpec[] = [
  { path: "/docs", score: 7.5, title: "API Documentation Exposed", description: "Interactive API documentation (Swagger UI/Redoc) is publicly reachable.", markers: ["swagger", "redoc", "openapi"] },
  { path: "/swagger", score: 7.5, title: "Swagger Specification Exposed", description: "The raw Swagger/OpenAPI specification is publicly reachable.", markers: ["swagger", "redoc", "openapi"] },
  { path: "/.env", score: 9.1, title: "Environment File Exposed", description: "A .env file (often containing secrets/credentials) is publicly reachable." },
  { path: "/.git/config", score: 7.5, title: "Git Repository Metadata Exposed", description: "The .git directory is publicly reachable, potentially allowing source code reconstruction.", markers: ["[core]", "repositoryformatversion"] },
  { path: "/admin", score: 4.3, title: "Admin Interface Reachable", description: "An administrative interface path responds without requiring authentication to be discovered." },
  { path: "/health", score: 2.0, title: "Health Check Endpoint Exposed", description: "A /health endpoint is publicly reachable and may leak server state/timing information." },
  { path: "/main.js.map", score: 5.3, title: "JavaScript Source Map Exposed", description: "A source map file is publicly reachable, allowing reconstruction of original (pre-bundled) source code.", markers: ['"sources"'] },
  { path: "/static/js/main.js.map", score: 5.3, title: "JavaScript Source Map Exposed", description: "A source map file is publicly reachable, allowing reconstruction of original (pre-bundled) source code.", markers: ['"sources"'] },
  { path: "/bundle.js.map", score: 5.3, title: "JavaScript Source Map Exposed", description: "A source map file is publicly reachable, allowing reconstruction of original (pre-bundled) source code.", markers: ['"sources"'] },
  { path: "/package-lock.json", score: 5.3, title: "Dependency Lockfile Exposed", description: "package-lock.json is publicly reachable, revealing the exact dependency tree (versions useful for finding known-vulnerable packages).", markers: ['"lockfileversion"'] },
  { path: "/yarn.lock", score: 5.3, title: "Dependency Lockfile Exposed", description: "yarn.lock is publicly reachable, revealing the exact dependency tree.", markers: ["# yarn lockfile"] },
  { path: "/composer.lock", score: 5.3, title: "Dependency Lockfile Exposed", description: "composer.lock is publicly reachable, revealing the exact PHP dependency tree.", markers: ['"packages"', '"content-hash"'] },
  { path: "/Pipfile.lock", score: 5.3, title: "Dependency Lockfile Exposed", description: "Pipfile.lock is publicly reachable, revealing the exact Python dependency tree.", markers: ['"_meta"'] },
  { path: "/uploads/", score: 4.3, title: "Directory Listing Enabled", description: "Directory listing is enabled, exposing the contents of a directory.", markers: ["index of /", "directory listing for", "parent directory"] },
  { path: "/static/", score: 4.3, title: "Directory Listing Enabled", description: "Directory listing is enabled, exposing the contents of a directory.", markers: ["index of /", "directory listing for", "parent directory"] },
  { path: "/backup/", score: 4.3, title: "Directory Listing Enabled", description: "Directory listing is enabled, exposing the contents of a directory.", markers: ["index of /", "directory listing for", "parent directory"] },
  { path: "/files/", score: 4.3, title: "Directory Listing Enabled", description: "Directory listing is enabled, exposing the contents of a directory.", markers: ["index of /", "directory listing for", "parent directory"] },
];

const OPENAPI_PATHS = ["/openapi.json", "/swagger.json", "/swagger/v1/swagger.json", "/api-docs"];
const GRAPHQL_PATHS = ["/graphql", "/api/graphql", "/graphql/console"];
const INTROSPECTION_QUERY = { query: "query { __schema { types { name } } }" };

function finding(score: number, rest: Omit<Finding, "severity" | "cvssScore">): Finding {
  return { ...rest, severity: severityFromScore(score), cvssScore: score };
}

interface Baseline {
  status: number;
  length: number;
  hash: string;
}

async function fetchSoft404Baseline(target: string): Promise<Baseline | undefined> {
  const probePath = `/finanfa-nonexistent-${randomUUID().slice(0, 12)}`;
  try {
    const response = await fetch(new URL(probePath, target).toString(), { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, length: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    return undefined;
  }
}

async function probeGenuineResponse(url: string, baseline: Baseline | undefined, markers: string[] | undefined): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    return undefined;
  }
  if (response.status !== 200) return undefined;

  const bytes = Buffer.from(await response.arrayBuffer());
  if (baseline && baseline.status === 200) {
    const bodyHash = createHash("sha256").update(bytes).digest("hex");
    if (bodyHash === baseline.hash) return undefined;
    if (Math.abs(bytes.length - baseline.length) < LENGTH_TOLERANCE_BYTES) return undefined;
  }

  const body = bytes.toString("utf-8");
  if (markers && !markers.some((m) => body.toLowerCase().includes(m))) return undefined;

  return body;
}

async function checkSensitivePaths(target: string, baseline: Baseline | undefined): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const spec of SENSITIVE_PATHS) {
    const url = new URL(spec.path, target).toString();
    const body = await probeGenuineResponse(url, baseline, spec.markers);
    if (body === undefined) continue;

    findings.push(
      finding(spec.score, {
        id: `discovery-exposed-${spec.path.replace(/^\/|\/$/g, "").replace(/\//g, "-") || "root"}`,
        title: spec.title,
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
        cwe: "CWE-200",
        description: spec.description,
        evidence: `GET ${url} returned HTTP 200 with content distinct from the site's not-found response.`,
        impact: "Exposes internal structure/configuration that helps an attacker plan further attacks against the discovered surface.",
        remediation: `Restrict or remove public access to ${spec.path} in production (auth wall, IP allow-list, or delete the route entirely).`,
        affectedEndpoint: url,
      }),
    );
  }
  return findings;
}

async function checkOpenApiSpec(target: string): Promise<Finding | undefined> {
  for (const path of OPENAPI_PATHS) {
    const url = new URL(path, target).toString();
    let spec: unknown;
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
      if (response.status !== 200) continue;
      spec = await response.json();
    } catch {
      continue;
    }
    if (typeof spec !== "object" || spec === null || !("paths" in spec)) continue;

    const endpoints = Object.keys((spec as { paths: Record<string, unknown> }).paths ?? {});
    return finding(7.5, {
      id: "discovery-openapi-full-schema",
      title: "Full API Schema Exposed via OpenAPI Specification",
      cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
      cwe: "CWE-200",
      description: `The OpenAPI specification at ${path} is publicly accessible and documents ${endpoints.length} endpoints, including request/response schemas and authentication methods.`,
      evidence: `GET ${url} — HTTP 200, ${endpoints.length} paths documented.`,
      impact: "Gives an attacker a complete map of the attack surface, drastically easing the development of targeted exploits against every documented endpoint.",
      remediation: "Disable the OpenAPI/Swagger spec route in production, or restrict it to authenticated internal users / an IP allow-list.",
      affectedEndpoint: url,
    });
  }
  return undefined;
}

async function checkGraphqlIntrospection(target: string): Promise<Finding | undefined> {
  for (const path of GRAPHQL_PATHS) {
    const url = new URL(path, target).toString();
    let body: unknown;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(INTROSPECTION_QUERY),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) continue;
      body = await response.json();
    } catch {
      continue;
    }
    const types = (body as { data?: { __schema?: { types?: unknown[] } } })?.data?.__schema?.types;
    if (!types || types.length === 0) continue;

    return finding(6.5, {
      id: "discovery-graphql-introspection",
      title: "GraphQL Introspection Enabled",
      cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
      cwe: "CWE-200",
      description: `The GraphQL endpoint at ${path} answers introspection queries, revealing ${types.length} schema types.`,
      evidence: `POST ${url} with an introspection query returned ${types.length} schema types.`,
      impact: "Exposes the complete GraphQL schema (queries, mutations, field names, types), giving an attacker a full map of the API's data model.",
      remediation: "Disable introspection in production (e.g. via the GraphQL server's introspection flag), or require authentication for schema access.",
      affectedEndpoint: url,
    });
  }
  return undefined;
}

// fetch() (undici) hard-forbids the TRACE method — "'TRACE' HTTP method is
// unsupported", always throws, verified directly — same restriction
// browsers place on it. node:http/https allow it via a raw request.
function sendTraceRequest(target: string): Promise<{ status: number; body: string } | undefined> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      resolve(undefined);
      return;
    }
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      { hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search, method: "TRACE", timeout: 10_000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

async function checkTraceMethod(target: string): Promise<{ finding?: Finding; passed?: PassedControl }> {
  const response = await sendTraceRequest(target);
  if (!response) return {};
  const { status, body } = response;
  if (status === 200 && body.toUpperCase().includes("TRACE")) {
    return {
      finding: finding(4.3, {
        id: "discovery-trace-method-enabled",
        title: "HTTP TRACE Method Enabled",
        cvssVector: "AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:N/A:N",
        cwe: "CWE-16",
        description: "The server accepts the HTTP TRACE method and echoes the request back in the response.",
        evidence: `TRACE ${target} -> HTTP ${status}, request echoed back in body.`,
        impact: "Enables Cross-Site Tracing (XST), which can be combined with other vulnerabilities to read HttpOnly cookies or other request headers.",
        remediation: "Disable the TRACE method at the web server/proxy level.",
        affectedEndpoint: target,
      }),
    };
  }
  return { passed: { label: "TRACE method disabled", detail: `TRACE ${target} did not return an echoed request body.` } };
}

async function checkDangerousMethods(target: string): Promise<{ finding?: Finding; passed?: PassedControl }> {
  let response: Response;
  try {
    response = await fetch(target, { method: "OPTIONS", redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    return {};
  }
  const allowHeader = response.headers.get("allow") ?? "";
  const allowedMethods = new Set(allowHeader.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean));
  const dangerous = [...allowedMethods].filter((m) => ["PUT", "DELETE", "CONNECT"].includes(m));

  if (dangerous.length > 0) {
    const score = 5.3;
    return {
      finding: finding(score, {
        id: "discovery-dangerous-http-methods",
        title: "Dangerous HTTP Methods Advertised",
        cvssVector: "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N",
        cwe: "CWE-16",
        description: `The server advertises support for ${dangerous.sort().join(", ")} via the Allow header.`,
        evidence: `OPTIONS ${target} -> Allow: ${allowHeader}`,
        impact: "If actually enabled (rather than just advertised) on write-capable routes, PUT/DELETE can allow unauthorized file upload/modification/deletion, and CONNECT can enable proxying through the server.",
        remediation: "Restrict the Allow header / actual method handling to only the methods each route genuinely needs; disable PUT/DELETE/CONNECT globally unless explicitly required and authenticated.",
        affectedEndpoint: target,
      }),
    };
  }
  return { passed: { label: "No dangerous HTTP methods advertised", detail: `OPTIONS ${target} -> Allow: ${allowHeader || "(absent)"}` } };
}

async function checkRobotsTxt(target: string): Promise<Finding | undefined> {
  const url = new URL("/robots.txt", target).toString();
  let body: string;
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) return undefined;
    body = await response.text();
  } catch {
    return undefined;
  }

  const disallowed = body
    .split("\n")
    .filter((line) => line.toLowerCase().startsWith("disallow:"))
    .map((line) => line.split(":", 2)[1]?.trim() ?? "")
    .filter((value) => value !== "" && value !== "/");

  if (disallowed.length === 0) return undefined;

  return {
    id: "discovery-robots-txt-disclosure",
    title: "robots.txt Discloses Internal Paths",
    severity: "INFO",
    description: `robots.txt lists ${disallowed.length} Disallow entries, which reveals paths the site owner considers sensitive enough to hide from search engines (but which are still publicly reachable).`,
    evidence: `GET ${url} -> Disallow entries: ${disallowed.slice(0, 15).join(", ")}${disallowed.length > 15 ? " ..." : ""}`,
    impact: "robots.txt is a convention respected by well-behaved crawlers only — it provides a ready-made list of paths for an attacker to check first.",
    remediation: "Don't rely on robots.txt to hide sensitive paths; enforce real authentication/authorization on them instead.",
    affectedEndpoint: url,
  };
}

async function scanDiscovery(target: string): Promise<ScanOutput> {
  const findings: Finding[] = [];
  const passed: PassedControl[] = [];

  const baseline = await fetchSoft404Baseline(target);
  findings.push(...(await checkSensitivePaths(target, baseline)));

  const openapi = await checkOpenApiSpec(target);
  if (openapi) findings.push(openapi);

  const graphql = await checkGraphqlIntrospection(target);
  if (graphql) findings.push(graphql);

  const trace = await checkTraceMethod(target);
  if (trace.finding) findings.push(trace.finding);
  else if (trace.passed) passed.push(trace.passed);

  const methods = await checkDangerousMethods(target);
  if (methods.finding) findings.push(methods.finding);
  else if (methods.passed) passed.push(methods.passed);

  const robots = await checkRobotsTxt(target);
  if (robots) findings.push(robots);

  if (findings.length === 0) {
    passed.push({ label: "No sensitive paths exposed", detail: `None of ${SENSITIVE_PATHS.length} commonly sensitive paths were reachable.` });
  }

  return { findings, passedControls: passed };
}

interface SecurityScanDiscoveryInput {
  url: string;
}

export const securityScanDiscoveryTool: ToolDefinition<SecurityScanDiscoveryInput> = {
  name: "security_scan_discovery",
  description:
    "Security tool. Checks a target for commonly sensitive exposed paths (.env, .git/config, source maps, " +
    "dependency lockfiles, directory listings, admin/health endpoints, Swagger/OpenAPI docs), a full OpenAPI " +
    "spec, GraphQL introspection, HTTP TRACE method, dangerous HTTP methods (PUT/DELETE/CONNECT advertised), " +
    "and robots.txt Disallow entries. Uses a soft-404 baseline (a random nonexistent path) so a JS-SPA serving " +
    "the same shell for every path isn't misread as every sensitive path being exposed. GET/OPTIONS/TRACE, " +
    "safe to run. A faithful, complete port of the user's own cyberlens scanner's discovery check (this one " +
    "needed no crawler — every check probes a fixed path relative to the target). " +
    "IMPORTANT: only scan a target the user owns or has explicit, documented authorization to test.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Target base URL, e.g. https://example.com" } },
    required: ["url"],
  },
  describeCall: (input) => `discover exposed paths/endpoints: ${input.url}`,
  async handler(input) {
    try {
      let target: string;
      try {
        target = new URL(input.url).toString();
      } catch {
        return { content: `"${input.url}" is not a valid URL.`, isError: true };
      }
      const output = await scanDiscovery(target);
      return { content: formatScanOutput(input.url, output), isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
