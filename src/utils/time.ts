export function toMs(input: number | string | Date | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (input instanceof Date) {
    const time = input.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return input < 1e12 ? input * 1000 : input;
  }
  const raw = String(input).trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (!Number.isNaN(numeric)) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}
