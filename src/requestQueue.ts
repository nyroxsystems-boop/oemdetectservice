/**
 * 🔄 REQUEST QUEUE — Serialized request processing + Circuit Breaker
 *
 * Ensures only ONE scraper request runs at a time (Playwright is NOT thread-safe).
 * Includes circuit breaker pattern to pause after repeated failures.
 */

import { logger } from './logger';

// ── Types ────────────────────────────────────────────────────────────────────

interface QueueItem<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
  label: string;
  addedAt: number;
}

export interface QueueStats {
  pending: number;
  isProcessing: boolean;
  circuitBreakerOpen: boolean;
  consecutiveFailures: number;
  totalProcessed: number;
  totalFailed: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

// ── Circuit Breaker ──────────────────────────────────────────────────────────

const CIRCUIT_BREAKER_THRESHOLD = 5;    // Open after 5 consecutive failures
const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000; // Reset after 5 minutes
const JOB_TIMEOUT_MS = 120_000;         // Max 120s per job

let consecutiveFailures = 0;
let circuitBreakerOpenedAt: number | null = null;
let totalProcessed = 0;
let totalFailed = 0;
let lastSuccessAt: number | null = null;
let lastFailureAt: number | null = null;

function isCircuitOpen(): boolean {
  if (consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false;
  if (!circuitBreakerOpenedAt) return false;

  const elapsed = Date.now() - circuitBreakerOpenedAt;
  if (elapsed >= CIRCUIT_BREAKER_RESET_MS) {
    // Half-open: allow one attempt
    logger.info('Circuit breaker half-open — allowing probe request');
    return false;
  }

  return true;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  circuitBreakerOpenedAt = null;
  totalProcessed++;
  lastSuccessAt = Date.now();
}

function recordFailure(): void {
  consecutiveFailures++;
  totalFailed++;
  lastFailureAt = Date.now();

  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !circuitBreakerOpenedAt) {
    circuitBreakerOpenedAt = Date.now();
    logger.error(`⛔ Circuit breaker OPEN — ${consecutiveFailures} consecutive failures. Pausing for ${CIRCUIT_BREAKER_RESET_MS / 1000}s`);
  }
}

export function resetCircuitBreaker(): void {
  consecutiveFailures = 0;
  circuitBreakerOpenedAt = null;
  logger.info('Circuit breaker manually reset');
}

// ── Queue ────────────────────────────────────────────────────────────────────

const queue: QueueItem<any>[] = [];
let isProcessing = false;

/**
 * Add a job to the serialized queue.
 * Only ONE job runs at a time — Playwright is NOT thread-safe.
 */
export function enqueue<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Check circuit breaker BEFORE queuing
    if (isCircuitOpen()) {
      const remainingMs = circuitBreakerOpenedAt
        ? CIRCUIT_BREAKER_RESET_MS - (Date.now() - circuitBreakerOpenedAt)
        : 0;
      reject(new Error(
        `Circuit breaker is OPEN — too many consecutive failures. ` +
        `Retry in ${Math.ceil(remainingMs / 1000)}s or POST /api/circuit-breaker/reset`
      ));
      return;
    }

    queue.push({ fn, resolve, reject, label, addedAt: Date.now() });
    logger.debug(`Queued job: "${label}" (queue size: ${queue.length})`);
    processNext();
  });
}

async function processNext(): Promise<void> {
  if (isProcessing || queue.length === 0) return;

  isProcessing = true;
  const item = queue.shift()!;

  const waitTime = Date.now() - item.addedAt;
  logger.info(`▶ Processing: "${item.label}" (waited ${waitTime}ms, remaining: ${queue.length})`);

  try {
    // Wrap with timeout
    const result = await Promise.race([
      item.fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Job timeout after ${JOB_TIMEOUT_MS / 1000}s`)), JOB_TIMEOUT_MS)
      ),
    ]);

    recordSuccess();
    item.resolve(result);

  } catch (err: any) {
    recordFailure();
    logger.error(`✗ Job failed: "${item.label}"`, { error: err.message });
    item.reject(err);

  } finally {
    isProcessing = false;
    // Process next job (with small delay to prevent CPU spinning)
    if (queue.length > 0) {
      setTimeout(() => processNext(), 100);
    }
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────

export function getQueueStats(): QueueStats {
  return {
    pending: queue.length,
    isProcessing,
    circuitBreakerOpen: isCircuitOpen(),
    consecutiveFailures,
    totalProcessed,
    totalFailed,
    lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
    lastFailureAt: lastFailureAt ? new Date(lastFailureAt).toISOString() : null,
  };
}
