declare module 'ws' {
  import { EventEmitter } from 'node:events';
  import type { ClientRequest, IncomingMessage } from 'node:http';

  export interface ClientOptions {
    headers?: Record<string, string>;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: {
      server?: unknown;
      path?: string;
      host?: string;
      port?: number;
    });
    on(
      event: 'connection',
      listener: (socket: WebSocket, request: unknown) => void,
    ): this;
    close(callback?: () => void): void;
  }

  export default class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    static readonly CLOSED: number;

    constructor(url: string, options?: ClientOptions);

    readonly readyState: number;

    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
    terminate(): void;

    on(event: 'open', listener: () => void): this;
    on(
      event: 'message',
      listener: (data: Buffer, isBinary: boolean) => void,
    ): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(
      event: 'unexpected-response',
      listener: (request: ClientRequest, response: IncomingMessage) => void,
    ): this;
  }
}
