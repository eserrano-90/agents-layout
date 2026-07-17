export interface HttpServerOptions {
  host: string;
  port?: number;
}

export interface HttpServerHandle {
  port: number;
}

export interface RouteOptions {
  auth?: boolean;
  schema?: object;
  bodyLimit?: number;
}

export type RouteHandler = (request: HttpRequest, reply: HttpResponse) => Promise<void> | void;
export type WsHandler = (socket: WebSocketConnection, request: HttpRequest) => void;

export interface HttpRequest {
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

export interface HttpResponse {
  send(data: unknown): void;
  code(status: number): HttpResponse;
  sendFile(path: string): void;
}

export interface WebSocketConnection {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface RouteRegistration {
  get(path: string, handler: RouteHandler, opts?: RouteOptions): void;
  post(path: string, handler: RouteHandler, opts?: RouteOptions): void;
  ws(path: string, handler: WsHandler): void;
}

export interface HttpServer {
  start(options: HttpServerOptions): Promise<HttpServerHandle>;
  stop(): Promise<void>;
  port(): number;
}
