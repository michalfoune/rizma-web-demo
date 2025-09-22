// Minimal leveled logger for browser apps (Vite/ESM). No deps.

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: Record<LogLevel, number> = {
  silent: 0, error: 10, warn: 20, info: 30, debug: 40, trace: 50
};

// Detect env (Vite) with safe fallbacks
const MODE =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.MODE) ||
  ((globalThis as any)?.process?.env?.NODE_ENV) ||
  'production';

// Default: verbose in dev, quieter in prod
let currentLevel: LogLevel = MODE === 'development' ? 'debug' : 'info';

// Allow URL override: ?log=trace|debug|info|warn|error|silent
try {
  if (typeof window !== 'undefined' && window.location?.search) {
    const q = new URLSearchParams(window.location.search).get('log') as LogLevel | null;
    if (q && q in ORDER) currentLevel = q;
  }
} catch { /* ignore */ }

export function getLevel(): LogLevel { return currentLevel; }
export function setLevel(level: LogLevel): void {
  if (level in ORDER) currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return ORDER[level] <= ORDER[currentLevel];
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number, l = 2) => n.toString().padStart(l, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export interface Logger {
  readonly scope: string;
  level(): LogLevel;
  setLevel(level: LogLevel): void;
  child(scope: string): Logger;

  error(...args: any[]): void;
  warn(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
  trace(...args: any[]): void;

  group(label?: string): void;
  groupEnd(): void;

  time(label: string): void;
  timeEnd(label: string): void;
}

export function createLogger(scope = 'app'): Logger {
  const prefix = scope ? `[${scope}]` : '';

  const call = (level: LogLevel, con: keyof Console, args: any[]) => {
    if (!shouldLog(level)) return;
    const c = console as any;
    const stamp = nowStamp();
    if (typeof c[con] === 'function') c[con](`[${stamp}] ${prefix}`, ...args);
    else c.log?.(`[${stamp}] ${prefix}`, ...args);
  };

  return {
    scope,
    level: () => currentLevel,
    setLevel,

    child(sub: string) { return createLogger(scope ? `${scope}:${sub}` : sub); },

    error(...args: any[]) { call('error', 'error', args); },
    warn (...args: any[]) { call('warn',  'warn',  args); },
    info (...args: any[]) { call('info',  'info',  args); },
    debug(...args: any[]) { call('debug', 'debug', args); },
    trace(...args: any[]) { call('trace', 'debug', args); }, // keep stack spam out; use debug pipe

    group(label?: string) {
      if (!shouldLog('debug')) return;
      if (console.groupCollapsed) console.groupCollapsed(`[${nowStamp()}] ${prefix}`, label ?? '');
      else this.debug(label ?? '');
    },
    groupEnd() {
      if (!shouldLog('debug')) return;
      console.groupEnd?.();
    },

    time(label: string) {
      if (!shouldLog('debug')) return;
      try { console.time?.(`${prefix}:${label}`); } catch {}
    },
    timeEnd(label: string) {
      if (!shouldLog('debug')) return;
      try { console.timeEnd?.(`${prefix}:${label}`); } catch {}
    }
  };
}

// A convenient default logger
export const log = createLogger('app');