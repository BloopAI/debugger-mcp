import { EventEmitter } from 'events';

/**
 * An event emitter interface that is compatible with NodeJS.EventEmitter.
 */
export interface Event<T> {
  (listener: (e: T) => void): { dispose: () => void };
}

export class Emitter<T> {
  private eventEmitter = new EventEmitter();
  private _event?: Event<T>;

  get event(): Event<T> {
    if (!this._event) {
      this._event = (listener: (e: T) => void) => {
        this.eventEmitter.on('event', listener);
        return {
          dispose: () => this.eventEmitter.removeListener('event', listener),
        };
      };
    }
    return this._event;
  }

  fire(data: T): void {
    this.eventEmitter.emit('event', data);
  }

  dispose(): void {
    this.eventEmitter.removeAllListeners();
  }
}

/**
 * A CancellationToken is passed to an asynchronous operation to signal cancellation.
 */
export interface CancellationToken {
  /**
   * A flag signalling is cancellation has been requested.
   */
  readonly isCancellationRequested: boolean;

  /**
   * An event which fires when cancellation is requested. This event
   * only ever fires `once` as cancellation can only happen once. Listeners
   * that are registered after cancellation will be called immediately.
   */
  readonly onCancellationRequested: Event<unknown>;
}

const shortcutEvent: Event<unknown> = Object.freeze(function (
  callback,
  context?: unknown,
): { dispose: () => void } {
  const handle = setTimeout(callback.bind(context), 0);
  return {
    dispose(): void {
      clearTimeout(handle);
    },
  };
} as Event<unknown>);

export class CancellationTokenSource {
  private _token?: CancellationToken;
  private _isCancelled: boolean = false;
  private _emitter?: Emitter<unknown>;

  constructor(parent?: CancellationToken) {
    if (parent) {
      parent.onCancellationRequested(() => this.cancel());
    }
  }

  get token(): CancellationToken {
    if (!this._token) {
      // If we don't have a token, create one.
      // To prevent unnecessary memory allocation,
      // we only create the token and emitter when needed.
      this._token = {
        isCancellationRequested: this._isCancelled,
        onCancellationRequested: this._isCancelled
          ? shortcutEvent
          : (this._emitter || (this._emitter = new Emitter<unknown>())).event,
      };
    }
    return this._token;
  }

  cancel(): void {
    if (!this._isCancelled) {
      this._isCancelled = true;
      if (this._token) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this._token as any).isCancellationRequested = true; // Update existing token instance
      }
      if (this._emitter) {
        this._emitter.fire(undefined); // Signal cancellation
        this.disposeEmitter();
      }
    }
  }

  dispose(): void {
    this.disposeEmitter();
  }

  private disposeEmitter(): void {
    if (this._emitter) {
      this._emitter.dispose();
      this._emitter = undefined;
    }
  }
}

/**
 * Error thrown when an operation is cancelled.
 */
export class CancellationError extends Error {
  constructor(message: string = 'Operation Canceled') {
    super(message);
    this.name = 'CancellationError';
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, CancellationError.prototype);
  }
}
