export type CountdownOptions = {
  /** Optional override in seconds — currently ignored in favor of ROLEPLAY_MINUTES */
  durationSec?: number;
  /** Optional custom mount resolver for the clock element */
  mount?: () => HTMLElement | null;
  /** Called exactly once when the timer reaches 0 */
  onExpire: () => Promise<void> | void;
};

// Configure the default role-play duration here (in minutes)
export const ROLEPLAY_MINUTES = 2;
export const DEFAULT_DURATION_SEC = ROLEPLAY_MINUTES * 60;

let remainingSec = DEFAULT_DURATION_SEC;
let intervalId: number | null = null;
let active = false;
let el: HTMLElement | null = null;
let mountFn: (() => HTMLElement | null) | null = null;
let onExpireFn: (() => Promise<void> | void) | null = null;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatMMSS(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${pad2(mm)}:${pad2(ss)}`;
}

function defaultMount(): HTMLElement | null {
  // Prefer the Annie/Animato stage if present
  const byId = document.getElementById('annieStage') || document.getElementById('annieRoot');
  if (byId) return byId;
  const stage = document.querySelector('.annie-stage') as HTMLElement | null;
  if (stage) return stage;
  const avatarPanel = document.getElementById('avatarPanel');
  if (avatarPanel) return avatarPanel;
  return document.body;
}

function ensureElement(): HTMLElement | null {
  if (el && document.body.contains(el)) return el;

  const host = (mountFn ? mountFn() : defaultMount()) || document.body;
  if (!host) return null;

  let existing = document.getElementById('countdownClock') as HTMLElement | null;
  if (!existing) {
    existing = document.createElement('div');
    existing.id = 'countdownClock';
    // Minimal inline styling so it works even without CSS/HTML changes.
    existing.style.position = 'absolute';
    existing.style.top = '10px';
    existing.style.left = '12px';
    existing.style.zIndex = '9999';
    existing.style.padding = '4px 8px';
    existing.style.borderRadius = '8px';
    existing.style.background = 'rgba(0,0,0,0.55)';
    existing.style.color = '#fff';
    existing.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    existing.style.fontSize = '28px';
    existing.style.fontWeight = '600';
    existing.style.letterSpacing = '0.5px';
    existing.style.userSelect = 'none';
    existing.setAttribute('role', 'timer');
    existing.setAttribute('aria-live', 'polite');
    host.appendChild(existing);
  }

  el = existing;
  return el;
}

function updateUI(): void {
  const node = ensureElement();
  if (!node) return;
  node.textContent = formatMMSS(remainingSec);
}

export function startCountdown(opts: CountdownOptions): void {
  stopCountdown();

  // Always use DEFAULT_DURATION_SEC derived from ROLEPLAY_MINUTES.
  // If you want a different duration, change ROLEPLAY_MINUTES above.
  remainingSec = DEFAULT_DURATION_SEC;
  active = true;
  mountFn = opts.mount ?? null;
  onExpireFn = opts.onExpire;

  updateUI();

  intervalId = window.setInterval(() => {
    if (!active) return;
    remainingSec -= 1;
    updateUI();

    if (remainingSec <= 0) {
      // Prevent re-entry on the next tick
      active = false;
      const expire = onExpireFn;

      // Stop ticking but keep the DOM showing 00:00 until we clean up
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      remainingSec = 0;
      updateUI();

      try {
        const r = expire?.();
        if (r && typeof (r as Promise<void>).then === 'function') {
          (r as Promise<void>).catch(() => void 0);
        }
      } catch {
        // swallow — session end path will surface errors elsewhere
      } finally {
        // Now clear DOM + internal state
        stopCountdown();
      }
    }
  }, 1000);
}

export function stopCountdown(): void {
  active = false;
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (el && el.parentElement) {
    el.parentElement.removeChild(el);
  }
  el = null;
  remainingSec = DEFAULT_DURATION_SEC;
  mountFn = null;
  onExpireFn = null;
}

export function isCountdownRunning(): boolean {
  return active;
}

export function getRemainingSec(): number {
  return remainingSec;
}