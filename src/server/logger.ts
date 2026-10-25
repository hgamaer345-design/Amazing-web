// Minimal structured logger. Never pass API keys or audio contents to it.

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;
const silent = process.env.NODE_ENV === 'test' && !process.env.LOG_LEVEL;

function write(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (silent || ORDER[level] < threshold) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...fields }, (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v,
  );
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};
