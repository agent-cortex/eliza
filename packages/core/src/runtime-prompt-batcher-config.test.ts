/**
 * Contract test for the PROMPT_BATCHER_* configuration boundary in the
 * AgentRuntime constructor. Before the fix, `getNumberEnv` only rejected `NaN`,
 * so `PROMPT_BATCHER_MAX_PARALLEL_CALLS=Infinity` flowed into the dispatcher's
 * Semaphore (`Math.max(1, Infinity) === Infinity`) and silently disabled the
 * concurrency bound. These cases exercise the real constructor path: malformed
 * explicit values must fail fast with a typed error naming the setting, while
 * absent settings and valid explicit values must still construct.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isElizaError } from "./errors";
import { AgentRuntime } from "./runtime";
import type { Character } from "./types";
import { getEnvironment } from "./utils/environment";
import { PROMPT_BATCHER_CONFIG_ERROR_CODE } from "./utils/prompt-batcher-config";

const PROMPT_BATCHER_KEYS = [
	"PROMPT_BATCHER_PACKING_DENSITY",
	"PROMPT_BATCHER_MAX_TOKENS_PER_CALL",
	"PROMPT_BATCHER_MAX_PARALLEL_CALLS",
	"PROMPT_BATCHER_MODEL_SEPARATION",
	"PROMPT_BATCHER_MAX_SECTIONS_PER_CALL",
	"PROMPT_BATCHER_BATCH_SIZE",
	"PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS",
] as const;

function resetPromptBatcherEnv(): void {
	for (const key of PROMPT_BATCHER_KEYS) {
		delete process.env[key];
	}
	// The environment reader caches per key; clear so each case reads fresh.
	getEnvironment().clearCache();
}

function setEnv(key: string, value: string): void {
	process.env[key] = value;
	getEnvironment().clearCache();
}

function constructRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: { name: "prompt-batcher-config-test" } as Character,
	});
}

describe("AgentRuntime PROMPT_BATCHER_* configuration boundary", () => {
	afterEach(resetPromptBatcherEnv);

	it("rejects Infinity for a parallelism setting with a typed, named error", () => {
		setEnv("PROMPT_BATCHER_MAX_PARALLEL_CALLS", "Infinity");
		let caught: unknown;
		try {
			constructRuntime();
		} catch (error) {
			caught = error;
		}
		expect(isElizaError(caught)).toBe(true);
		if (isElizaError(caught)) {
			expect(caught.code).toBe(PROMPT_BATCHER_CONFIG_ERROR_CODE);
			expect(caught.message).toContain("PROMPT_BATCHER_MAX_PARALLEL_CALLS");
			expect(caught.message).toContain("finite");
			expect(caught.context?.setting).toBe("PROMPT_BATCHER_MAX_PARALLEL_CALLS");
		}
	});

	it("rejects -Infinity as well", () => {
		setEnv("PROMPT_BATCHER_MAX_TOKENS_PER_CALL", "-Infinity");
		expect(() => constructRuntime()).toThrowError(
			/PROMPT_BATCHER_MAX_TOKENS_PER_CALL/,
		);
	});

	it("rejects a non-integer value for an integer setting", () => {
		setEnv("PROMPT_BATCHER_MAX_PARALLEL_CALLS", "1.5");
		expect(() => constructRuntime()).toThrowError(/must be an integer/);
	});

	it("rejects a non-positive value for a count setting", () => {
		setEnv("PROMPT_BATCHER_BATCH_SIZE", "0");
		expect(() => constructRuntime()).toThrowError(/PROMPT_BATCHER_BATCH_SIZE/);
	});

	it("rejects a ratio setting above its supported range", () => {
		setEnv("PROMPT_BATCHER_PACKING_DENSITY", "1.5");
		expect(() => constructRuntime()).toThrowError(
			/PROMPT_BATCHER_PACKING_DENSITY/,
		);
	});

	it("rejects a garbage non-numeric value instead of silently defaulting", () => {
		setEnv("PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS", "not-a-number");
		expect(() => constructRuntime()).toThrowError(
			/PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS/,
		);
	});

	it("does not expose unrelated environment data in the error", () => {
		process.env.UNRELATED_SECRET_TOKEN = "super-secret-value";
		setEnv("PROMPT_BATCHER_MAX_PARALLEL_CALLS", "Infinity");
		try {
			constructRuntime();
			throw new Error("expected construction to throw");
		} catch (error) {
			if (isElizaError(error)) {
				expect(error.message).not.toContain("super-secret-value");
				expect(JSON.stringify(error.context)).not.toContain(
					"super-secret-value",
				);
			}
		} finally {
			delete process.env.UNRELATED_SECRET_TOKEN;
		}
	});

	it("preserves defaults when every setting is absent", () => {
		resetPromptBatcherEnv();
		expect(() => constructRuntime()).not.toThrow();
	});

	it("accepts valid explicit values (current-default-equivalent and overrides)", () => {
		setEnv("PROMPT_BATCHER_MAX_PARALLEL_CALLS", "4");
		setEnv("PROMPT_BATCHER_PACKING_DENSITY", "0.5");
		setEnv("PROMPT_BATCHER_MODEL_SEPARATION", "0");
		expect(() => constructRuntime()).not.toThrow();
	});
});
