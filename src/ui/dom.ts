/** Map known element IDs to their concrete DOM types. */
type IdMap = {
  // Layout
  panel: HTMLElement;
  composer: HTMLElement;

  // Chat
  chat: HTMLElement;
  status: HTMLElement;

  // Controls
  hold: HTMLButtonElement;
  micFab: HTMLButtonElement;
  endSession: HTMLButtonElement;
  composerPlus: HTMLButtonElement;
  reset: HTMLButtonElement;

  // Inputs/labels
  composerInput: HTMLElement;

  // Media
  remoteAudio: HTMLAudioElement;
  fallbackAudio: HTMLAudioElement;
};

/** Internal cache so repeated lookups are O(1) after first query. */
const cache = new Map<keyof IdMap, IdMap[keyof IdMap]>();

/** Get a typed element by ID or throw with a clear error if missing. */
export function getEl<K extends keyof IdMap>(id: K): IdMap[K] {
  if (cache.has(id)) return cache.get(id) as IdMap[K];
  const el = document.getElementById(id as string) as IdMap[K] | null;
  if (!el) {
    throw new Error(
      `DOM element #${String(id)} not found. ` +
      `Make sure the element exists in index.html and DOM is ready before calling getEl("${String(id)}").`
    );
  }
  cache.set(id, el);
  return el;
}

/** Get a typed element by ID or return null (no throw). */
export function maybeEl<K extends keyof IdMap>(id: K): IdMap[K] | null {
  try {
    return getEl(id);
  } catch {
    return null;
  }
}

/** Set textContent on an element or element ID. */
export function setText(target: keyof IdMap | Element, text: string) {
  const el = (typeof target === 'string') ? getEl(target) : target;
  (el as HTMLElement).textContent = text;
}

/** Show/hide an element or element ID (uses display: none). */
export function setVisible(target: keyof IdMap | Element, visible: boolean, display: string = 'block') {
  const el = (typeof target === 'string') ? getEl(target) : target;
  (el as HTMLElement).style.display = visible ? display : 'none';
}

/** Run a callback when DOM is ready (idempotent). */
export function onDomReady(fn: () => void) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    // DOM is already parsed
    queueMicrotask(fn);
  }
}

/** Optional: clear the cache (e.g., after a full UI re-render). */
export function resetDomCache() {
  cache.clear();
}