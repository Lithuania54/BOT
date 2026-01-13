import { promises as fs } from "fs";
import path from "path";
import { toMs } from "./utils/time";

type CursorFile = {
  version: number;
  updatedAtMs: number;
  cursors: Record<string, number>;
};

export class MirrorCursorStore {
  private filePath: string;
  private bootstrapLookbackMs: number;
  private startFromNow: boolean;
  private cursors = new Map<string, number>();
  private dirty = false;
  private baseTimestampMs = 0;

  constructor(filePath: string, bootstrapLookbackMs: number, startFromNow: boolean) {
    this.filePath = filePath;
    this.bootstrapLookbackMs = bootstrapLookbackMs;
    this.startFromNow = startFromNow;
  }

  async load(): Promise<void> {
    const now = Date.now();
    this.baseTimestampMs = this.startFromNow ? now : Math.max(0, now - this.bootstrapLookbackMs);
    if (this.startFromNow) {
      this.cursors.clear();
      this.dirty = true;
      return;
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as CursorFile;
      if (parsed?.cursors && typeof parsed.cursors === "object") {
        for (const [wallet, value] of Object.entries(parsed.cursors)) {
          const ts = toMs(value as any);
          if (ts !== null) {
            this.cursors.set(wallet, ts);
          }
        }
      }
    } catch {
      // file missing or unreadable -> start from bootstrap window
    }
  }

  ensureCursor(proxyWallet: string): number {
    const existing = this.cursors.get(proxyWallet);
    if (existing !== undefined) return existing;
    this.cursors.set(proxyWallet, this.baseTimestampMs);
    this.dirty = true;
    return this.baseTimestampMs;
  }

  getCursor(proxyWallet: string): number | undefined {
    return this.cursors.get(proxyWallet);
  }

  updateCursor(proxyWallet: string, timestampMs: number) {
    const normalized = toMs(timestampMs) ?? null;
    if (normalized === null) return;
    const current = this.cursors.get(proxyWallet) ?? this.baseTimestampMs;
    if (normalized > current) {
      this.cursors.set(proxyWallet, normalized);
      this.dirty = true;
    }
  }

  async persist(): Promise<void> {
    if (!this.dirty) return;
    const payload: CursorFile = {
      version: 1,
      updatedAtMs: Date.now(),
      cursors: Object.fromEntries(this.cursors),
    };
    const resolved = path.resolve(this.filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    const tmpPath = `${resolved}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    try {
      await fs.unlink(resolved);
    } catch {
      // ignore if missing
    }
    await fs.rename(tmpPath, resolved);
    this.dirty = false;
  }
}
