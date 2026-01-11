import Database from "better-sqlite3";
import path from "path";
import { OrderBookMeta, ResolvedTarget, TraderScore } from "./types";

export class StateStore {
  private db: InstanceType<typeof Database>;
  private targetCache = new Map<string, ResolvedTarget>();
  private conditionCache = new Map<string, string[]>();
  private tokenMetaCache = new Map<string, OrderBookMeta>();
  private lastSeenCache = new Map<string, number>();
  private processedCache = new Set<string>();

  constructor(dbPath = path.join(process.cwd(), "state.db")) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
    this.loadCaches();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS targets (
        target TEXT PRIMARY KEY,
        displayName TEXT NOT NULL,
        proxyWallet TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS condition_tokens (
        conditionId TEXT PRIMARY KEY,
        tokenIds TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS token_meta (
        tokenId TEXT PRIMARY KEY,
        tickSize TEXT NOT NULL,
        minOrderSize TEXT NOT NULL,
        negRisk INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS last_seen (
        proxyWallet TEXT PRIMARY KEY,
        lastSeenMs INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_trades (
        tradeKey TEXT PRIMARY KEY,
        processedAt INTEGER NOT NULL,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS scores (
        proxyWallet TEXT NOT NULL,
        score REAL NOT NULL,
        realizedPnlSum REAL NOT NULL,
        totalBoughtSum REAL NOT NULL,
        roi REAL NOT NULL,
        sample INTEGER NOT NULL,
        openPnlSum REAL NOT NULL,
        timestampMs INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leader_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        currentLeader TEXT,
        sinceMs INTEGER
      );
      CREATE TABLE IF NOT EXISTS topk_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        leadersJson TEXT,
        updatedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS switches (
        proxyWallet TEXT PRIMARY KEY,
        lastSwitchedAwayMs INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_notional (
        date TEXT PRIMARY KEY,
        notional REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS last_trade (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tradeKey TEXT,
        timestampMs INTEGER
      );
    `);
  }

  private loadCaches() {
    const targetRows = this.db.prepare("SELECT target, displayName, proxyWallet FROM targets").all();
    for (const row of targetRows) {
      this.targetCache.set(row.target, {
        target: row.target,
        displayName: row.displayName,
        proxyWallet: row.proxyWallet,
      });
    }

    const conditionRows = this.db.prepare("SELECT conditionId, tokenIds FROM condition_tokens").all();
    for (const row of conditionRows) {
      try {
        const tokenIds = JSON.parse(row.tokenIds);
        if (Array.isArray(tokenIds)) this.conditionCache.set(row.conditionId, tokenIds);
      } catch {
        // ignore
      }
    }

    const tokenMetaRows = this.db.prepare("SELECT tokenId, tickSize, minOrderSize, negRisk, updatedAt FROM token_meta").all();
    for (const row of tokenMetaRows) {
      this.tokenMetaCache.set(row.tokenId, {
        tokenId: row.tokenId,
        tickSize: row.tickSize,
        minOrderSize: row.minOrderSize,
        negRisk: Boolean(row.negRisk),
        updatedAtMs: row.updatedAt,
      });
    }

    const lastSeenRows = this.db.prepare("SELECT proxyWallet, lastSeenMs FROM last_seen").all();
    for (const row of lastSeenRows) {
      this.lastSeenCache.set(row.proxyWallet, row.lastSeenMs);
    }
  }

  getResolvedTarget(target: string): ResolvedTarget | undefined {
    return this.targetCache.get(target);
  }

  setResolvedTarget(resolved: ResolvedTarget) {
    this.targetCache.set(resolved.target, resolved);
    this.db
      .prepare("INSERT OR REPLACE INTO targets (target, displayName, proxyWallet, updatedAt) VALUES (?, ?, ?, ?)")
      .run(resolved.target, resolved.displayName, resolved.proxyWallet, Date.now());
  }

  getConditionTokenIds(conditionId: string): string[] | undefined {
    return this.conditionCache.get(conditionId);
  }

  setConditionTokenIds(conditionId: string, tokenIds: string[]) {
    this.conditionCache.set(conditionId, tokenIds);
    this.db
      .prepare("INSERT OR REPLACE INTO condition_tokens (conditionId, tokenIds, updatedAt) VALUES (?, ?, ?)")
      .run(conditionId, JSON.stringify(tokenIds), Date.now());
  }

  getTokenMeta(tokenId: string): OrderBookMeta | undefined {
    return this.tokenMetaCache.get(tokenId);
  }

  setTokenMeta(meta: OrderBookMeta) {
    this.tokenMetaCache.set(meta.tokenId, meta);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO token_meta (tokenId, tickSize, minOrderSize, negRisk, updatedAt) VALUES (?, ?, ?, ?, ?)"
      )
      .run(meta.tokenId, meta.tickSize, meta.minOrderSize, meta.negRisk ? 1 : 0, meta.updatedAtMs);
  }

  getLastSeen(proxyWallet: string): number {
    return this.lastSeenCache.get(proxyWallet) || 0;
  }

  setLastSeen(proxyWallet: string, lastSeenMs: number) {
    this.lastSeenCache.set(proxyWallet, lastSeenMs);
    this.db
      .prepare("INSERT OR REPLACE INTO last_seen (proxyWallet, lastSeenMs) VALUES (?, ?)")
      .run(proxyWallet, lastSeenMs);
  }

  hasProcessed(tradeKey: string): boolean {
    if (this.processedCache.has(tradeKey)) return true;
    const row = this.db.prepare("SELECT tradeKey FROM processed_trades WHERE tradeKey = ?").get(tradeKey);
    if (row) this.processedCache.add(tradeKey);
    return Boolean(row);
  }

  markProcessed(tradeKey: string, reason: string) {
    this.processedCache.add(tradeKey);
    this.db
      .prepare("INSERT OR REPLACE INTO processed_trades (tradeKey, processedAt, reason) VALUES (?, ?, ?)")
      .run(tradeKey, Date.now(), reason);
  }

  saveScore(score: TraderScore) {
    this.db
      .prepare(
        "INSERT INTO scores (proxyWallet, score, realizedPnlSum, totalBoughtSum, roi, sample, openPnlSum, timestampMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        score.proxyWallet,
        score.score,
        score.realizedPnlSum,
        score.totalBoughtSum,
        score.roi,
        score.sample,
        score.openPnlSum,
        score.timestampMs
      );
  }

  getLeaderState(): { currentLeader?: string; sinceMs?: number } {
    const row = this.db.prepare("SELECT currentLeader, sinceMs FROM leader_state WHERE id = 1").get();
    if (!row) return {};
    return { currentLeader: row.currentLeader || undefined, sinceMs: row.sinceMs || undefined };
  }

  setLeaderState(currentLeader: string | null, sinceMs: number | null) {
    this.db
      .prepare("INSERT OR REPLACE INTO leader_state (id, currentLeader, sinceMs) VALUES (1, ?, ?)")
      .run(currentLeader, sinceMs);
  }

  getTopKState(): { leaders: string[]; updatedAtMs?: number } {
    const row = this.db.prepare("SELECT leadersJson, updatedAt FROM topk_state WHERE id = 1").get();
    if (!row?.leadersJson) return { leaders: [] };
    try {
      const leaders = JSON.parse(row.leadersJson);
      return { leaders: Array.isArray(leaders) ? leaders : [], updatedAtMs: row.updatedAt || undefined };
    } catch {
      return { leaders: [] };
    }
  }

  setTopKState(leaders: string[]) {
    this.db
      .prepare("INSERT OR REPLACE INTO topk_state (id, leadersJson, updatedAt) VALUES (1, ?, ?)")
      .run(JSON.stringify(leaders), Date.now());
  }

  setSwitchedAway(proxyWallet: string, timestampMs: number) {
    this.db
      .prepare("INSERT OR REPLACE INTO switches (proxyWallet, lastSwitchedAwayMs) VALUES (?, ?)")
      .run(proxyWallet, timestampMs);
  }

  getLastSwitchedAway(proxyWallet: string): number {
    const row = this.db.prepare("SELECT lastSwitchedAwayMs FROM switches WHERE proxyWallet = ?").get(proxyWallet);
    return row?.lastSwitchedAwayMs || 0;
  }

  getDailyNotional(date: string): number {
    const row = this.db.prepare("SELECT notional FROM daily_notional WHERE date = ?").get(date);
    return row?.notional || 0;
  }

  addDailyNotional(date: string, notional: number) {
    const current = this.getDailyNotional(date);
    const next = current + notional;
    this.db
      .prepare("INSERT OR REPLACE INTO daily_notional (date, notional) VALUES (?, ?)")
      .run(date, next);
  }

  setLastTrade(tradeKey: string, timestampMs: number) {
    this.db
      .prepare("INSERT OR REPLACE INTO last_trade (id, tradeKey, timestampMs) VALUES (1, ?, ?)")
      .run(tradeKey, timestampMs);
  }

  getLastTrade(): { tradeKey?: string; timestampMs?: number } {
    const row = this.db.prepare("SELECT tradeKey, timestampMs FROM last_trade WHERE id = 1").get();
    if (!row) return {};
    return { tradeKey: row.tradeKey || undefined, timestampMs: row.timestampMs || undefined };
  }
}
