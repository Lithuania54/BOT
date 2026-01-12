export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLogLevel(raw: string | undefined): LogLevel {
  if (!raw) return "info";
  const last = raw.split(/[,\s]+/).filter(Boolean).pop();
  const normalized = (last || "").toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized as LogLevel;
  }
  return "info";
}

const currentLevel: LogLevel = normalizeLogLevel(process.env.LOG_LEVEL);

function shouldLog(level: LogLevel): boolean {
  return levelOrder[level] >= levelOrder[currentLevel];
}

function format(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
  const base = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  return JSON.stringify(fields ? { ...base, ...fields } : base);
}

export const logger = {
  debug(msg: string, fields?: Record<string, unknown>) {
    if (!shouldLog("debug")) return;
    console.log(format("debug", msg, fields));
  },
  info(msg: string, fields?: Record<string, unknown>) {
    if (!shouldLog("info")) return;
    console.log(format("info", msg, fields));
  },
  warn(msg: string, fields?: Record<string, unknown>) {
    if (!shouldLog("warn")) return;
    console.warn(format("warn", msg, fields));
  },
  error(msg: string, fields?: Record<string, unknown>) {
    if (!shouldLog("error")) return;
    console.error(format("error", msg, fields));
  },
};
