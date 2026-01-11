import { logger } from "../logger";

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelay = options.retryDelayMs ?? 500;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
    try {
      const resp = await fetch(url, {
        method: options.method || "GET",
        headers: {
          Accept: "application/json",
          ...options.headers,
        },
        body: options.body,
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text}`);
      }
      return (await resp.json()) as T;
    } catch (err) {
      clearTimeout(timeout);
      if (attempt >= retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
      logger.warn("fetch retry", { url, attempt, delay, error: (err as Error).message });
      await sleep(delay);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("unreachable");
}
