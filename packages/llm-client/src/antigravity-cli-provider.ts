/**
 * Antigravity CLI provider — calls Antigravity via the `agy` command.
 *
 * This provider implements the same client contract used by Claude providers:
 * a `complete()` method returning plain text and optional token usage.
 *
 * ## Execution policy compilation
 *
 * The provider compiles an {@link ExecutionPolicy} into Antigravity-specific CLI
 * flags using the currently supported surface (`--sandbox`, `--dangerously-skip-permissions`).
 * This keeps the n-dx policy object as the single source of truth for permission intent.
 *
 * @see packages/llm-client/src/runtime-contract.ts — policy types
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type {
  ClaudeClient,
  CompletionRequest,
  CompletionResult,
} from "./types.js";
import { ClaudeClientError } from "./types.js";
import type { AntigravityConfig } from "./llm-types.js";
import type { ExecutionPolicy } from "./runtime-contract.js";
import { DEFAULT_EXECUTION_POLICY } from "./runtime-contract.js";

const AUTH_PATTERNS = /unauthorized|invalid api key|api key was rejected|forbidden|not logged in|login required|auth failed|\b401\b/i;
const RATE_LIMIT_PATTERNS = /rate.limit|429|too many requests|overloaded/i;
const TRANSIENT_PATTERNS = [
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b529\b/,
  /\b429\b/,
  /overloaded/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /socket hang up/i,
  /stream disconnected/i,
];

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10000;
const DEFAULT_ANTIGRAVITY_BINARY = "agy";

export interface AntigravityCliProviderOptions {
  antigravityConfig?: AntigravityConfig;
  /** Execution policy to compile into Antigravity CLI flags. Defaults to DEFAULT_EXECUTION_POLICY. */
  policy?: ExecutionPolicy;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Called before each rate-limit retry sleep.
   * Receives the upcoming attempt number (1-based, so 2 = first retry),
   * the total attempt count, and the delay in milliseconds.
   * When omitted, a default message is written to stderr.
   */
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number) => void;
}

// ── Policy flag compilation ──────────────────────────────────────────────

/**
 * Compile an n-dx {@link ExecutionPolicy} into Antigravity CLI flags.
 *
 * Mapping:
 * - `workspace-write + never` → `--dangerously-skip-permissions`
 * - `danger-full-access + never` → `--dangerously-skip-permissions`
 * - all other combinations → `--sandbox`
 */
export function compileAntigravityPolicyFlags(policy: ExecutionPolicy): string[] {
  if (policy.approvals === "never") {
    if (policy.sandbox === "workspace-write" || policy.sandbox === "danger-full-access") {
      return ["--dangerously-skip-permissions"];
    }
  }

  return ["--sandbox"];
}

function isDebugEnabled(): boolean {
  const v = process.env.NDX_DEBUG_LLM ?? process.env.NDX_DEBUG;
  return v === "1" || v === "true" || v === "yes";
}

function debugLog(message: string): void {
  if (isDebugEnabled()) {
    // eslint-disable-next-line no-console
    console.error(`[ndx:llm:antigravity] ${message}`);
  }
}

function resolveAntigravityCliPath(antigravityConfig?: AntigravityConfig): string {
  return antigravityConfig?.cli_path ?? DEFAULT_ANTIGRAVITY_BINARY;
}

function resolveAntigravityModel(antigravityConfig?: AntigravityConfig): string | undefined {
  return antigravityConfig?.model;
}

function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

function classifyStderr(stderr: string): { reason: "auth" | "rate-limit" | "unknown"; retryable: boolean } {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errorLines = lines.filter((line) => /^error:/i.test(line));
  const classificationText = (errorLines.length > 0 ? errorLines.join("\n") : stderr).toLowerCase();

  if (AUTH_PATTERNS.test(classificationText)) {
    return { reason: "auth", retryable: false };
  }
  if (RATE_LIMIT_PATTERNS.test(classificationText)) {
    return { reason: "rate-limit", retryable: true };
  }
  return { reason: "unknown", retryable: isTransientError(classificationText) };
}

async function spawnOnce(
  cliBinary: string,
  request: CompletionRequest,
  antigravityConfig?: AntigravityConfig,
  envOverride?: NodeJS.ProcessEnv,
  policy?: ExecutionPolicy,
): Promise<CompletionResult> {
  const dir = await mkdtemp(join(tmpdir(), "ndx-antigravity-"));
  const outputPath = join(dir, "last-message.txt");

  try {
    const effectivePolicy = policy ?? DEFAULT_EXECUTION_POLICY;
    const policyFlags = compileAntigravityPolicyFlags(effectivePolicy);
    const model = request.model || resolveAntigravityModel(antigravityConfig);
    
    // Command shape assumption:
    // agy -p "<prompt>" --model <model> --sandbox -o <outputPath>
    const args = [
      ...policyFlags,
      "-o",
      outputPath,
    ];

    if (model) {
      args.push("--model", model);
    }
    
    if (request.cliFlags) {
      args.push(...request.cliFlags);
    }

    // Pass the prompt
    args.push("-p", request.prompt);

    debugLog(`spawn start cli="${cliBinary}" model="${model ?? 'default'}" promptChars=${request.prompt.length}`);
    debugLog(`spawn args: ${JSON.stringify(args)}`);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cliBinary, args, {
        stdio: ["ignore", "ignore", "pipe"],
        env: envOverride ?? process.env,
        shell: process.platform === "win32",
      });

      let stderr = "";
      let timeoutId: NodeJS.Timeout | undefined;
      let timedOut = false;
      const timeoutMs = request.timeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
        }, timeoutMs);
      }

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (err) => {
        if (timeoutId) clearTimeout(timeoutId);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          const pathNote = cliBinary !== DEFAULT_ANTIGRAVITY_BINARY
            ? `Antigravity CLI not found at configured path: ${cliBinary}. Check 'n-dx config llm.antigravity.cli_path'.`
            : "Antigravity CLI (agy) not found. Install it and/or set a custom path: n-dx config llm.antigravity.cli_path /path/to/agy";
          reject(new ClaudeClientError(pathNote, "not-found", false));
          return;
        }
        reject(new ClaudeClientError(err.message, "unknown", isTransientError(err.message)));
      });

      proc.on("close", (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (timedOut) {
          reject(new ClaudeClientError(`antigravity cli timed out after ${timeoutMs}ms`, "timeout", true));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const detail = stderr.trim() || `antigravity cli exited with code ${code}`;
        const classified = classifyStderr(detail);
        debugLog(`spawn close code=${code} classified=${classified.reason} retryable=${classified.retryable}`);
        if (detail) {
          debugLog(`stderr: ${detail}`);
        }
        reject(new ClaudeClientError(detail, classified.reason, classified.retryable));
      });
    });

    let rawText: string;
    try {
      rawText = await readFile(outputPath, "utf-8");
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        throw new ClaudeClientError(
          "antigravity cli exited successfully but did not write output file. Wait, does it support -o?",
          "unknown",
          true,
        );
      }
      throw err;
    }

    const text = rawText.trim();
    debugLog(`spawn success outputChars=${text.length}`);

    if (text.length === 0) {
      throw new ClaudeClientError(
        "antigravity cli produced empty output",
        "unknown",
        true,
      );
    }

    return { text };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function defaultRateLimitOnRetry(attempt: number, maxAttempts: number, delayMs: number): void {
  const delaySec = Math.round(delayMs / 1000);
  process.stderr.write(`Rate limited — retrying in ${delaySec}s… (attempt ${attempt} of ${maxAttempts})\n`);
}

export function createAntigravityCliClient(options: AntigravityCliProviderOptions): ClaudeClient {
  const cliBinary = resolveAntigravityCliPath(options.antigravityConfig);
  const defaultModel = resolveAntigravityModel(options.antigravityConfig);
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const onRetry = options.onRetry ?? defaultRateLimitOnRetry;

  return {
    mode: "cli",

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      let lastError: Error | undefined;
      const finalRequest: CompletionRequest = {
        ...request,
        model: request.model || defaultModel || "gemini-default",
      };

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        debugLog(`complete attempt=${attempt + 1}/${maxRetries + 1} model="${finalRequest.model ?? 'default'}"`);
        try {
          return await spawnOnce(cliBinary, finalRequest, options.antigravityConfig, undefined, options.policy);
        } catch (err) {
          lastError = err as Error;
          if (err instanceof ClaudeClientError) {
            debugLog(`attempt failed reason=${err.reason} retryable=${err.retryable} message="${err.message}"`);
          } else {
            debugLog(`attempt failed unknown error="${(err as Error).message}"`);
          }

          if (err instanceof ClaudeClientError && !err.retryable) {
            debugLog("non-retryable error; aborting retries");
            throw err;
          }

          if (attempt < maxRetries) {
            const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
            debugLog(`sleeping before retry delayMs=${delay}`);

            if (err instanceof ClaudeClientError && err.reason === "rate-limit") {
              onRetry(attempt + 2, maxRetries + 1, delay);
            }

            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      debugLog(`exhausted retries; throwing last error: ${lastError?.message ?? "unknown"}`);

      if (lastError instanceof ClaudeClientError && lastError.reason === "rate-limit") {
        throw new ClaudeClientError(
          `Antigravity rate limit exceeded — all ${maxRetries + 1} attempts failed. ` +
          "Wait a few minutes and try again, or reduce request frequency.",
          "rate-limit",
          false,
        );
      }

      throw lastError;
    },
  };
}
