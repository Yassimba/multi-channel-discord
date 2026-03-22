const MAX_BACKOFF_MS = 30_000 as const

/** Compute exponential backoff delay for a given attempt (0-indexed). */
export function computeBackoff(attempt: number): number {
  const delay = 1000 * Math.pow(2, attempt)
  return Math.min(delay, MAX_BACKOFF_MS)
}
