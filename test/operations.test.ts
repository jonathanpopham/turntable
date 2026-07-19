import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { GqlConfig } from "../src/gql-request.js";
import { RailwayApiError } from "../src/gql-request.js";
import {
  MANAGED_IMAGE,
  MANAGED_SERVICE_NAME,
  createService,
  deleteService,
  getProjectServices,
} from "../src/operations.js";

interface Captured {
  variables: Record<string, unknown>;
  query: string;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server | null = null;

function serveOnce(body: unknown): Promise<{ config: GqlConfig; captured: Captured[] }> {
  const captured: Captured[] = [];
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString()) as {
          query: string;
          variables: Record<string, unknown>;
        };
        captured.push({ query: parsed.query, variables: parsed.variables, headers: req.headers });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        config: { endpoint: `http://127.0.0.1:${port}/`, token: "test-token", auth: "project" },
        captured,
      });
    });
  });
}

afterEach(() => {
  server?.close();
  server = null;
});

const target = { projectId: "proj-1", environmentId: "env-1" };

describe("createService", () => {
  it("sends fixed name and digest-pinned image as variables, returns parsed result", async () => {
    const { config, captured } = await serveOnce({
      data: { serviceCreate: { id: "svc-9", name: MANAGED_SERVICE_NAME } },
    });
    const result = await createService(config, target);
    expect(result).toEqual({ id: "svc-9", name: MANAGED_SERVICE_NAME });
    const call = captured[0];
    expect(call?.variables).toEqual({
      projectId: "proj-1",
      environmentId: "env-1",
      name: MANAGED_SERVICE_NAME,
      image: MANAGED_IMAGE,
    });
    expect(MANAGED_IMAGE).toContain("@sha256:");
  });

  it("uses the Project-Access-Token header when auth is project", async () => {
    const { config, captured } = await serveOnce({
      data: { serviceCreate: { id: "svc-9", name: MANAGED_SERVICE_NAME } },
    });
    await createService(config, target);
    expect(captured[0]?.headers["project-access-token"]).toBe("test-token");
    expect(captured[0]?.headers["authorization"]).toBeUndefined();
  });

  it("throws RailwayApiError on a shape mismatch", async () => {
    const { config } = await serveOnce({ data: { serviceCreate: { wrong: true } } });
    await expect(createService(config, target)).rejects.toBeInstanceOf(RailwayApiError);
  });
});

describe("getProjectServices", () => {
  it("returns parsed services with latest deployment", async () => {
    const { config, captured } = await serveOnce({
      data: {
        project: {
          services: {
            edges: [
              {
                node: {
                  id: "svc-9",
                  name: MANAGED_SERVICE_NAME,
                  deployments: {
                    edges: [
                      { node: { id: "d1", status: "SUCCESS", createdAt: "2026-07-18T00:00:00Z" } },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    });
    const result = await getProjectServices(config, target);
    expect(result.services).toHaveLength(1);
    expect(result.services[0]?.latestDeployment?.status).toBe("SUCCESS");
    expect(captured[0]?.variables).toEqual({ projectId: "proj-1" });
  });
});

describe("deployService", () => {
  it("sends serviceId and environmentId, returns acceptance boolean", async () => {
    const { config, captured } = await serveOnce({ data: { serviceInstanceDeploy: true } });
    const { deployService } = await import("../src/operations.js");
    const result = await deployService(config, target, "svc-9");
    expect(result).toBe(true);
    expect(captured[0]?.variables).toEqual({ serviceId: "svc-9", environmentId: "env-1" });
  });
});

describe("deleteService", () => {
  it("sends id and environmentId, returns acceptance boolean", async () => {
    const { config, captured } = await serveOnce({ data: { serviceDelete: true } });
    const result = await deleteService(config, target, "svc-9");
    expect(result).toBe(true);
    expect(captured[0]?.variables).toEqual({ id: "svc-9", environmentId: "env-1" });
  });
});
