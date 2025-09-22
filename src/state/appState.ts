export type AppState = {
  isConnected: boolean;
  isConnecting: boolean;
  isRecording: boolean;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  micStream: MediaStream | null;
  assistantBuf: string;
  activeResponseId: string | null;
  responseRequested: boolean;
};
export const state: AppState = {
  isConnected: false, isConnecting: false, isRecording: false,
  pc: null, dc: null, micStream: null,
  assistantBuf: "", activeResponseId: null, responseRequested: false,
};