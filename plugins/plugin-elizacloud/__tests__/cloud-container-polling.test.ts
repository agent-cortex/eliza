/**
 * Regression coverage for CloudContainerService deployment polling resilience.
 *
 * Exercises the real private startPolling() loop with fake timers and a live
 * process 'unhandledRejection' listener. Guards the contract that a transient
 * API error (network blip, 5xx, timeout) during the documented ~8-12 minute
 * deployment window must not permanently stop the poller nor escape as an
 * unhandled promise rejection (elizaOS/eliza#29718).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudContainerService } from "../src/services/cloud-container";
import type { CloudContainer } from "../src/types/cloud";

type GetImpl = (path: string) => Promise<unknown>;

interface TrackedInternals {
  container: CloudContainer;
  pollingTimer: ReturnType<typeof setTimeout> | null;
  healthTimer: ReturnType<typeof setInterval> | null;
}

function baseContainer(status: CloudContainer["status"]): CloudContainer {
  return {
    id: "c1",
    name: "svc",
    project_name: "proj",
    description: null,
    organization_id: "org",
    user_id: "user",
    status,
    image_tag: null,
    port: 3000,
    desired_count: 1,
    cpu: 512,
    memory: 1024,
    architecture: "arm64",
    environment_vars: {},
    health_check_path: "/health",
    load_balancer_url: status === "running" ? "https://c1.example" : null,
    ecr_repository_uri: null,
    ecr_image_tag: null,
    cloudformation_stack_name: null,
    billing_status: "active",
    total_billed: "0",
    last_deployed_at: null,
    last_health_check: null,
    deployment_log: null,
    error_message: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Build a service with a stub auth/client and one "deploying" tracked
 * container, then invoke the private startPolling for it.
 */
function seedPolling(get: GetImpl): {
  service: CloudContainerService;
  tracked: () => TrackedInternals | undefined;
} {
  const service = new CloudContainerService({} as never);
  const client = {
    get,
    post: async () => ({}),
    delete: async () => ({}),
  };
  (service as unknown as { authService: unknown }).authService = {
    isAuthenticated: () => true,
    getClient: () => client,
  };
  const map = (service as unknown as { tracked: Map<string, TrackedInternals> }).tracked;
  map.set("c1", {
    container: baseContainer("deploying"),
    pollingTimer: null,
    healthTimer: null,
  });

  (service as unknown as { startPolling: (id: string) => void }).startPolling("c1");

  return { service, tracked: () => map.get("c1") };
}

describe("CloudContainerService.startPolling resilience (#29718)", () => {
  let unhandled: unknown[];
  let onUnhandled: (reason: unknown) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    unhandled = [];
    onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("retries after a transient API error and reaches the running terminal state", async () => {
    let calls = 0;
    const { tracked } = seedPolling(async (path: string) => {
      if (path.endsWith("/health")) {
        return { success: true, data: { status: "ok", healthy: true, lastCheck: null, uptime: 1 } };
      }
      calls++;
      if (calls === 1) {
        throw new Error("ETIMEDOUT");
      }
      return { success: true, data: baseContainer("running") };
    });

    // First poll (5s) hits the transient failure; a second poll must be
    // scheduled by the catch path with backoff and observe status=running.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(1);
    expect(tracked()?.container.status).toBe("deploying");

    await vi.advanceTimersByTimeAsync(10_000);

    // Polling recovered: get was called at least twice, the container reached
    // its terminal running state, health monitoring started, and crucially no
    // unhandled rejection escaped the process.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(tracked()?.container.status).toBe("running");
    expect(tracked()?.healthTimer).not.toBeNull();
    expect(unhandled).toEqual([]);
  });

  it("stops after exactly maxAttempts when every poll fails, with no unhandled rejection", async () => {
    let calls = 0;
    const { tracked } = seedPolling(async (path: string) => {
      if (path.endsWith("/health")) {
        return { success: true, data: { status: "ok", healthy: true, lastCheck: null, uptime: 1 } };
      }
      calls++;
      throw new Error("ECONNRESET");
    });

    // Advance well past the full backoff budget (~1 hour worst case) so every
    // scheduled retry fires and the loop terminates itself at maxAttempts (120).
    await vi.advanceTimersByTimeAsync(4_000_000);

    expect(calls).toBe(120);
    // The loop gave up: no poll timer is left pending to re-check forever, and
    // health monitoring never started (status never reached running).
    expect(vi.getTimerCount()).toBe(0);
    expect(tracked()?.healthTimer).toBeNull();
    expect(unhandled).toEqual([]);
  });
});
