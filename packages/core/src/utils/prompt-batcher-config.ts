/**
 * Validates the `PROMPT_BATCHER_*` runtime configuration before the
 * AgentRuntime constructs its PromptBatcher/PromptDispatcher singletons.
 *
 * The generic `Environment.getNumber()` reader only guards `NaN`, so a
 * malformed deployment value such as `PROMPT_BATCHER_MAX_PARALLEL_CALLS=Infinity`
 * previously flowed straight into the dispatcher's Semaphore and silently
 * disabled the concurrency bound (`Math.max(1, Infinity) === Infinity`),
 * turning a bounded model-call path into unbounded fan-out. This module is the
 * single validated source of truth for those settings: it resolves each knob
 * from the environment, applies the documented default when the setting is
 * absent, and rejects any explicit value that is non-finite or outside the
 * setting's supported domain with an actionable, typed configuration error.
 *
 * Scope is deliberately narrow — it does not change the generic
 * `Environment.getNumber()` contract (that would require a separate
 * compatibility audit).
 */
import { ElizaError } from "../errors.js";
import { getEnvironment } from "./environment.js";

/**
 * Fully-resolved, validated prompt-batcher configuration. Every field maps
 * directly onto a `PromptDispatcherSettings` / `PromptBatcherSettings` option.
 */
export interface PromptBatcherConfig {
	packingDensity: number;
	maxTokensPerCall: number;
	maxParallelCalls: number;
	modelSeparation: number;
	maxSectionsPerCall: number;
	batchSize: number;
	maxDrainIntervalMs: number;
}

/** Stable classification code for an invalid prompt-batcher setting. */
export const PROMPT_BATCHER_CONFIG_ERROR_CODE = "INVALID_PROMPT_BATCHER_CONFIG";

function configError(
	setting: string,
	rawValue: string,
	reason: string,
): ElizaError {
	// Only the offending setting name, its own value, and the constraint are
	// surfaced — no unrelated environment data is exposed.
	return new ElizaError(
		`Invalid ${setting}=${JSON.stringify(rawValue)}: ${reason}.`,
		{
			code: PROMPT_BATCHER_CONFIG_ERROR_CODE,
			severity: "fatal",
			context: { setting, value: rawValue, reason },
		},
	);
}

/**
 * Read a setting's explicit string value, or `undefined` when it is absent or
 * blank (blank is treated as absent so an empty deployment override falls back
 * to the default instead of parsing to a surprising `0`).
 */
function readSetting(key: string): string | undefined {
	const raw = getEnvironment().get(key);
	if (raw === undefined) {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Resolve a positive-integer setting. Absent → default. Present values must be
 * finite integers `>= min`; anything else (including `Infinity`, `-Infinity`,
 * `NaN`, fractions, and out-of-range numbers) throws a typed config error.
 */
function resolveInteger(
	key: string,
	defaultValue: number,
	min: number,
): number {
	const raw = readSetting(key);
	if (raw === undefined) {
		return defaultValue;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		throw configError(key, raw, "must be a finite number");
	}
	if (!Number.isInteger(parsed)) {
		throw configError(key, raw, "must be an integer");
	}
	if (parsed < min) {
		throw configError(key, raw, `must be an integer >= ${min}`);
	}
	return parsed;
}

/** Bounds for a ratio setting, with explicit endpoint inclusivity. */
interface RatioBounds {
	min: number;
	max: number;
	minInclusive: boolean;
	maxInclusive: boolean;
}

/**
 * Resolve a ratio setting constrained to `bounds`. Absent → default. Present
 * values must be finite and within range (respecting endpoint inclusivity);
 * anything else throws a typed config error.
 */
function resolveRatio(
	key: string,
	defaultValue: number,
	bounds: RatioBounds,
): number {
	const raw = readSetting(key);
	if (raw === undefined) {
		return defaultValue;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		throw configError(key, raw, "must be a finite number");
	}
	const belowMin = bounds.minInclusive
		? parsed < bounds.min
		: parsed <= bounds.min;
	const aboveMax = bounds.maxInclusive
		? parsed > bounds.max
		: parsed >= bounds.max;
	if (belowMin || aboveMax) {
		const lo = bounds.minInclusive ? `[${bounds.min}` : `(${bounds.min}`;
		const hi = bounds.maxInclusive ? `${bounds.max}]` : `${bounds.max})`;
		throw configError(key, raw, `must be a ratio in the range ${lo}, ${hi}`);
	}
	return parsed;
}

/**
 * Resolve and validate every `PROMPT_BATCHER_*` numeric setting once, returning
 * a typed config the runtime feeds into both the PromptDispatcher and the
 * PromptBatcher. Throws {@link ElizaError} (code
 * {@link PROMPT_BATCHER_CONFIG_ERROR_CODE}) on the first invalid explicit value.
 */
export function resolvePromptBatcherConfig(): PromptBatcherConfig {
	return {
		// (0, 1]: 0 would still pack (densityFloor 0.35) but is semantically
		// meaningless as a "density"; the dispatcher clamps to [0, 1] so values
		// > 1 are silently discarded — reject them instead of accepting a lie.
		packingDensity: resolveRatio("PROMPT_BATCHER_PACKING_DENSITY", 0.85, {
			min: 0,
			max: 1,
			minInclusive: false,
			maxInclusive: true,
		}),
		maxTokensPerCall: resolveInteger(
			"PROMPT_BATCHER_MAX_TOKENS_PER_CALL",
			24_000,
			1,
		),
		maxParallelCalls: resolveInteger("PROMPT_BATCHER_MAX_PARALLEL_CALLS", 2, 1),
		// modelSeparation is a [0, 1] ratio in the dispatcher (0 allowed: no
		// small/large separation). Reject non-finite and out-of-range values.
		modelSeparation: resolveRatio("PROMPT_BATCHER_MODEL_SEPARATION", 1, {
			min: 0,
			max: 1,
			minInclusive: true,
			maxInclusive: true,
		}),
		maxSectionsPerCall: resolveInteger(
			"PROMPT_BATCHER_MAX_SECTIONS_PER_CALL",
			8,
			1,
		),
		batchSize: resolveInteger("PROMPT_BATCHER_BATCH_SIZE", 8, 1),
		maxDrainIntervalMs: resolveInteger(
			"PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS",
			30_000,
			1,
		),
	};
}
