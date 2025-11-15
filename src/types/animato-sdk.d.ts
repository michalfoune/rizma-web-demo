declare global {
  interface Window {
    AnimatoSDK?: {
      Animato: new (opts: {
        token: string;
        animatoId: string;
        userId: string;
        userName?: string;
      }) => {
        connect(): Promise<void>;
        disconnect(): void;
        setHTMLRoot(el: HTMLElement): void;
        setLang(lang: string): void;
        setMicrophoneEnabled(enabled: boolean): Promise<void> | void;
        sendMessage(text: string): void;
        on?: (event: 'data-received', cb: (payload: any) => void) => void;
        onDataReceived?: (payload: any) => void;
        off?: (event: 'data-received', cb: (payload: any) => void) => void;
      };
    };
  }
}
export {};