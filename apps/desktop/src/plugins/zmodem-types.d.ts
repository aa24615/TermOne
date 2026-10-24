declare module "zmodem.js" {
  export interface Transfer {
    send(bytes: Uint8Array): void;
    end(bytes?: Uint8Array): Promise<void>;
  }
  export interface Offer {
    get_details(): { name: string; size: number };
    on(event: "input", cb: (bytes: Uint8Array) => void): void;
    skip(): void;
    accept(): Promise<Uint8Array[]>;
  }
  export interface Session {
    type: "send" | "receive";
    on(event: "offer", cb: (offer: Offer) => void): void;
    on(event: "session_end", cb: () => void): void;
    start(): void;
    abort(): void;
    close(): Promise<void>;
    send_offer(options: {
      name: string;
      size: number;
      mtime: Date;
    }): Promise<Transfer | undefined>;
  }
  export interface Detection {
    is_valid(): boolean;
    confirm(): Session;
    deny(): void;
    get_session_role(): string;
  }
  class Sentry {
    constructor(options: {
      to_terminal: (bytes: number[]) => void;
      sender: (bytes: number[]) => void;
      on_detect: (detection: Detection) => void;
      on_retract: () => void;
    });
    consume(bytes: Uint8Array): void;
    get_confirmed_session(): Session | undefined;
  }
  const Zmodem: { Sentry: typeof Sentry };
  export default Zmodem;
}
