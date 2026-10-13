export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

export class CdpError extends Error {
  readonly method: string;
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
    this.code = code;
  }
}

export class CdpClosedError extends Error {
  constructor(message = 'CDP connection closed') {
    super(message);
    this.name = 'CdpClosedError';
  }
}

export interface CdpConnection {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<Record<string, unknown>>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  waitForEvent(
    method: string,
    options: {
      readonly sessionId?: string;
      readonly timeoutMs: number;
      readonly predicate?: (event: CdpEvent) => boolean;
    }
  ): Promise<CdpEvent>;
  readonly closed: Promise<void>;
  dispose(): void;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

export function connectPipe(
  toChrome: NodeJS.WritableStream,
  fromChrome: NodeJS.ReadableStream
): CdpConnection {
  let nextId = 1;
  let isClosed = false;

  const pendingRequests = new Map<number, PendingRequest>();
  const eventListeners = new Set<(event: CdpEvent) => void>();

  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function handleClose(): void {
    if (isClosed) return;
    isClosed = true;

    for (const pending of pendingRequests.values()) {
      pending.reject(new CdpClosedError('CDP connection closed'));
    }
    pendingRequests.clear();

    if (
      'removeListener' in fromChrome &&
      typeof fromChrome.removeListener === 'function'
    ) {
      fromChrome.removeListener('data', onData);
    }

    resolveClosed();
  }

  toChrome.on('error', () => {
    handleClose();
  });

  fromChrome.on('error', () => {
    handleClose();
  });

  fromChrome.on('end', () => {
    handleClose();
  });

  fromChrome.on('close', () => {
    handleClose();
  });

  toChrome.on('close', () => {
    handleClose();
  });

  let pendingBuffers: Buffer[] = [];
  let pendingLength = 0;

  function handleFrame(frameBuffer: Buffer): void {
    let raw: unknown;
    try {
      raw = JSON.parse(frameBuffer.toString('utf8'));
    } catch {
      return;
    }
    if (typeof raw !== 'object' || raw === null) return;

    const msg = raw as {
      id?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
      method?: unknown;
      params?: unknown;
      sessionId?: unknown;
    };

    if (typeof msg.id === 'number') {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        pendingRequests.delete(msg.id);
        if (msg.error && typeof msg.error === 'object') {
          const code = typeof msg.error.code === 'number' ? msg.error.code : 0;
          const message =
            typeof msg.error.message === 'string'
              ? msg.error.message
              : 'CDP command failed';
          pending.reject(new CdpError(pending.method, code, message));
        } else {
          const result =
            msg.result && typeof msg.result === 'object'
              ? (msg.result as Record<string, unknown>)
              : {};
          pending.resolve(result);
        }
      }
      return;
    }

    if (typeof msg.method === 'string') {
      const event: CdpEvent = {
        method: msg.method,
        params:
          msg.params && typeof msg.params === 'object'
            ? (msg.params as Record<string, unknown>)
            : {},
        ...(typeof msg.sessionId === 'string'
          ? { sessionId: msg.sessionId }
          : {}),
      };

      for (const listener of eventListeners) {
        try {
          listener(event);
        } catch {
          // Event listener errors should not break connection processing
        }
      }
    }
  }

  function onData(chunk: Buffer | Uint8Array | string): void {
    if (isClosed) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    let start = 0;
    while (start < buf.length) {
      const nulIndex = buf.indexOf(0, start);
      if (nulIndex === -1) {
        const slice = buf.subarray(start);
        pendingBuffers.push(slice);
        pendingLength += slice.length;
        break;
      }

      const slice = buf.subarray(start, nulIndex);
      let frameBuffer: Buffer;
      if (pendingBuffers.length > 0) {
        pendingBuffers.push(slice);
        pendingLength += slice.length;
        frameBuffer = Buffer.concat(pendingBuffers, pendingLength);
        pendingBuffers = [];
        pendingLength = 0;
      } else {
        frameBuffer = slice;
      }

      start = nulIndex + 1;
      if (frameBuffer.length > 0) {
        handleFrame(frameBuffer);
      }
    }
  }

  fromChrome.on('data', onData);

  function send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<Record<string, unknown>> {
    if (isClosed) {
      return Promise.reject(new CdpClosedError('CDP connection closed'));
    }

    const id = nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      pendingRequests.set(id, { method, resolve, reject });

      const message: Record<string, unknown> = { id, method };
      if (params !== undefined) {
        message.params = params;
      }
      if (sessionId !== undefined) {
        message.sessionId = sessionId;
      }

      const payload = Buffer.from(`${JSON.stringify(message)}\0`, 'utf8');

      try {
        toChrome.write(payload, (err) => {
          if (err) {
            handleClose();
          }
        });
      } catch {
        handleClose();
      }
    });
  }

  function onEvent(listener: (event: CdpEvent) => void): () => void {
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  }

  function waitForEvent(
    method: string,
    options: {
      readonly sessionId?: string;
      readonly timeoutMs: number;
      readonly predicate?: (event: CdpEvent) => boolean;
    }
  ): Promise<CdpEvent> {
    if (isClosed) {
      return Promise.reject(new CdpClosedError('CDP connection closed'));
    }

    return new Promise<CdpEvent>((resolve, reject) => {
      let timer: NodeJS.Timeout | number | undefined;
      let unsubscribe: (() => void) | undefined;
      let settled = false;

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (unsubscribe !== undefined) {
          unsubscribe();
          unsubscribe = undefined;
        }
      };

      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };

      const listener = (event: CdpEvent) => {
        if (event.method !== method) return;
        if (
          options.sessionId !== undefined &&
          event.sessionId !== options.sessionId
        ) {
          return;
        }
        if (options.predicate && !options.predicate(event)) {
          return;
        }
        settle(() => resolve(event));
      };

      unsubscribe = onEvent(listener);

      closed
        .then(() => {
          settle(() =>
            reject(
              new CdpClosedError(
                `CDP connection closed while waiting for event ${method}`
              )
            )
          );
        })
        .catch(() => {});

      if (options.timeoutMs > 0) {
        timer = setTimeout(() => {
          settle(() =>
            reject(
              new Error(
                `Timed out waiting for event ${method} after ${options.timeoutMs}ms`
              )
            )
          );
        }, options.timeoutMs);
      }
    });
  }

  function dispose(): void {
    handleClose();
    try {
      const writable = toChrome as {
        destroy?: () => void;
        end?: () => void;
      };
      if (typeof writable.destroy === 'function') {
        writable.destroy();
      } else if (typeof writable.end === 'function') {
        writable.end();
      }
    } catch {
      // Best-effort cleanup
    }
    try {
      const readable = fromChrome as { destroy?: () => void };
      if (typeof readable.destroy === 'function') {
        readable.destroy();
      }
    } catch {
      // Best-effort cleanup
    }
  }

  return {
    send,
    onEvent,
    waitForEvent,
    closed,
    dispose,
  };
}
