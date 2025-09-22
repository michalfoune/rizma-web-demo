// Small runtime/type guards for WebRTC + DOM state.

/** True if channel exists and is open. Narrows type to RTCDataChannel. */
export function isOpen(dc: RTCDataChannel | null | undefined): dc is RTCDataChannel {
  return !!dc && dc.readyState === 'open';
}

/** True if channel exists and is closing/closed. */
export function isClosed(dc: RTCDataChannel | null | undefined): boolean {
  return !!dc && (dc.readyState === 'closing' || dc.readyState === 'closed');
}

/** ICE is connected or completed (most robust for media flowing). */
export function isPCIceConnected(pc: RTCPeerConnection | null | undefined): pc is RTCPeerConnection {
  return !!pc && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed');
}

/** PeerConnection overall connection state is connected. */
export function isPCConnected(pc: RTCPeerConnection | null | undefined): pc is RTCPeerConnection {
  return !!pc && pc.connectionState === 'connected';
}

/** PC is not failed/closed. */
export function isPCLive(pc: RTCPeerConnection | null | undefined): pc is RTCPeerConnection {
  return !!pc && pc.connectionState !== 'failed' && pc.connectionState !== 'closed';
}

/** True if a MediaStreamTrack exists, is audio, enabled, and live. Narrows to MediaStreamTrack. */
export function isLive(track: MediaStreamTrack | null | undefined): boolean {
  return !!track && track.kind === 'audio' && track.enabled && track.readyState === 'live';
}

/** First audio track from a stream, if any. */
export function firstAudioTrack(stream: MediaStream | null | undefined): MediaStreamTrack | null {
  if (!stream) return null;
  const t = stream.getAudioTracks?.()[0];
  return t ?? null;
}

/** PC has at least one audio receiver track attached. */
export function hasRemoteAudio(pc: RTCPeerConnection | null | undefined): boolean {
  if (!pc) return false;
  return pc.getReceivers().some(r => !!r.track && r.track.kind === 'audio');
}

/** PC is sending a non-muted local audio track. */
export function hasSendingAudio(pc: RTCPeerConnection | null | undefined): boolean {
  if (!pc) return false;
  return pc.getSenders().some(s => !!s.track && s.track.kind === 'audio' && s.track.enabled);
}

/** Not null/undefined; helpful for Array.prototype.filter(isDefined). Narrows T. */
export function isDefined<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

/** Null or undefined. */
export function isNil(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

/** Non-empty string after trim. Narrows to string. */
export function isNonEmptyString(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

/** Safe check for an HTMLAudioElement with a MediaStream srcObject. */
export function hasMediaStream(el: HTMLMediaElement | null | undefined): el is HTMLMediaElement {
  return !!el && (el as any).srcObject instanceof MediaStream;
}

/** True if document is in a state where user gestures are likely allowed (best-effort). */
export function userGestureLikelyAllowed(): boolean {
  // Heuristic: focus exists and visibility is visible
  return typeof document !== 'undefined' && document.visibilityState === 'visible';
}