export function retryDelay(
  attempt: number,
  baseSeconds: number,
  maximum: number,
): number | null {
  if (
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    attempt >= Math.max(1, Math.min(10, maximum))
  )
    return null;
  return Math.min(
    60_000,
    Math.max(1, Math.min(60, baseSeconds)) * 1000 * 2 ** attempt,
  );
}
