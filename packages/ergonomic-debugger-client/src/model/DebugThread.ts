/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import * as NodeJS from 'events';
import { DebugProtocol } from '@vscode/debugprotocol';
import type { LoggerInterface } from '../logging';
import { DebugStackFrame } from './DebugStackFrame';
import type { DAPSessionHandlerInterface } from './model.types';
import type {
  FrameErrorContext,
  EvaluationErrorContext,
  ScopeVariableFetchErrorContext,
  ScopesFetchErrorContext,
} from '../dapSessionHandler'; // Import the union and its members
import {
  CancellationToken,
  CancellationTokenSource,
  CancellationError,
} from '../common/cancellation';

/**
 * Events emitted by DebugThread.
 */
export interface DebugThreadEvents {
  /** Emitted when the call stack has been successfully fetched or cleared, and `this.callStack` is updated. */
  callStackRefreshed: (frames: DebugStackFrame[]) => void;
  /** Emitted when fetching the call stack fails. */
  callStackFetchFailed: (error: Error) => void;
  /** Emitted when the thread's stopped state or details are updated. */
  stoppedStateChanged: (
    stopped: boolean,
    details?: DebugProtocol.StoppedEvent['body'],
  ) => void;
  /** Emitted when an error occurs within one of this thread's stack frames (e.g., scope fetch, evaluation, or variable fetch failure). */
  stackFrameError: (
    frame: DebugStackFrame,
    errorType: 'scopesFetch' | 'evaluation' | 'scopeVariableFetch',
    error: Error,
    context?: FrameErrorContext,
  ) => void;
}

export declare interface DebugThread {
  on<U extends keyof DebugThreadEvents>(
    event: U,
    listener: DebugThreadEvents[U],
  ): this;
  emit<U extends keyof DebugThreadEvents>(
    event: U,
    ...args: Parameters<DebugThreadEvents[U]>
  ): boolean;
}

export class DebugThread extends NodeJS.EventEmitter {
  public callStack: DebugStackFrame[] = [];
  public stopped: boolean = false;
  public stoppedDetails?: DebugProtocol.StoppedEvent['body'];

  private _isFetchingCallStack: boolean = false;
  private _fetchCallStackPromise: Promise<DebugStackFrame[]> | null = null;
  private _lastCallStackError?: Error;

  constructor(
    public readonly id: number,
    public name: string,
    private readonly sessionHandler: DAPSessionHandlerInterface, // From model.types for sendRequest and passing to children
    private readonly logger: LoggerInterface,
  ) {
    super();
  }

  private _detachStackFrameListeners(frames: DebugStackFrame[]): void {
    frames.forEach((frame) => {
      frame.removeAllListeners('scopesFetchFailed');
      frame.removeAllListeners('evaluationFailed');
      frame.removeAllListeners('scopeVariableFetchFailed');
    });
  }

  private _attachStackFrameListeners(frames: DebugStackFrame[]): void {
    frames.forEach((frame) => {
      frame.on('scopesFetchFailed', (err) => {
        this.logger.warn(
          `[DebugThread] Scopes fetch failed in frame ${frame.id} for thread ID ${this.id}`,
          { error: err },
        );
        const contextObj: ScopesFetchErrorContext = {
          errorType: 'scopesFetch',
        };
        this.emit('stackFrameError', frame, 'scopesFetch', err, contextObj);
      });

      frame.on('evaluationFailed', (err, expression, evalArgsContext) => {
        this.logger.warn(
          `[DebugThread] Evaluation failed in frame ${frame.id} for thread ID ${this.id}`,
          { error: err, expression, evalArgsContext },
        );
        const contextObj: EvaluationErrorContext = {
          errorType: 'evaluation',
          expression,
          dapContext: evalArgsContext,
        };
        this.emit('stackFrameError', frame, 'evaluation', err, contextObj);
      });

      frame.on('scopeVariableFetchFailed', (scope, err, scopeErrContext) => {
        this.logger.warn(
          `[DebugThread] Variable fetch failed in scope '${scope.name}' of frame ${frame.id} for thread ID ${this.id}`,
          { error: err, scopeErrContext },
        );
        const contextObj: ScopeVariableFetchErrorContext = {
          errorType: 'scopeVariableFetch',
          scope,
          scopeErrContext,
        };
        this.emit(
          'stackFrameError',
          frame,
          'scopeVariableFetch',
          err,
          contextObj,
        );
      });
    });
  }

  public async fetchCallStack(
    startFrame: number = 0,
    levels?: number,
  ): Promise<DebugStackFrame[]> {
    if (this._isFetchingCallStack && this._fetchCallStackPromise) {
      this.logger.debug(
        `[DebugThread.fetchCallStack] Deduplicating call stack fetch for thread ID: ${this.id}`,
      );
      return this._fetchCallStackPromise;
    }

    this.logger.info(
      `[DebugThread.fetchCallStack] Initiating call stack fetch for thread ID: ${this.id}`,
      { startFrame, levels },
    );
    this._isFetchingCallStack = true;
    this._lastCallStackError = undefined;

    const cts = new CancellationTokenSource();
    const deregisterOperation =
      this.sessionHandler.registerCancellableOperation(cts, this.id);

    const localFetchPromise = this._doFetchCallStack(
      startFrame,
      levels,
      cts.token,
    );
    this._fetchCallStackPromise = localFetchPromise;

    try {
      const newFrames = await localFetchPromise;

      if (cts.token.isCancellationRequested) {
        this.logger.info(
          `[DebugThread.fetchCallStack] Fetch for thread ID ${this.id} was cancelled. Not updating call stack.`,
        );
        // Return current callStack as another operation might have modified it.
        return this.callStack;
      }

      // Check if this fetch operation is still the current one.
      if (this._fetchCallStackPromise !== localFetchPromise) {
        this.logger.info(
          `[DebugThread.fetchCallStack] Fetch for thread ID ${this.id} was superseded or cleared. Not updating call stack from this fetch.`,
        );
        return this.callStack;
      }

      this._detachStackFrameListeners(this.callStack);
      this.callStack = newFrames;
      this._attachStackFrameListeners(this.callStack);
      this.logger.info(
        `[DebugThread.fetchCallStack] Successfully fetched ${this.callStack.length} stack frames for thread ID: ${this.id}`,
      );
      this.emit('callStackRefreshed', this.callStack);
      return this.callStack;
    } catch (error) {
      if (error instanceof CancellationError) {
        this.logger.info(
          `[DebugThread.fetchCallStack] Call stack fetch for thread ID ${this.id} was cancelled.`,
          { error },
        );
        // Don't emit 'callStackFetchFailed' for explicit cancellation if the promise was rejected by CancellationError.
        // The state of callStack should reflect whatever it was before this cancelled operation, or if it was cleared.
        return this.callStack;
      }

      if (
        this._fetchCallStackPromise !== localFetchPromise &&
        this._fetchCallStackPromise !== null
      ) {
        this.logger.warn(
          `[DebugThread.fetchCallStack] Error for superseded fetch for thread ID ${this.id}. Ignoring.`,
          { error },
        );
        return this.callStack;
      }

      this.logger.error(
        `[DebugThread.fetchCallStack] Failed to fetch call stack for thread ID: ${this.id}`,
        { error },
      );
      this._detachStackFrameListeners(this.callStack);
      this.callStack = [];

      const processedError: Error =
        error instanceof Error ? error : new Error(String(error));
      this._lastCallStackError = processedError;
      this.emit('callStackFetchFailed', processedError);
      return [];
    } finally {
      this._isFetchingCallStack = false;
      // Only nullify _fetchCallStackPromise if it's the one we were managing.
      // This prevents a newer fetch from being incorrectly nullified by an older, superseded one.
      if (this._fetchCallStackPromise === localFetchPromise) {
        this._fetchCallStackPromise = null;
      }
      deregisterOperation(); // Deregister from DAPSessionHandler
      cts.dispose(); // Dispose the CancellationTokenSource
    }
  }

  private async _doFetchCallStack(
    startFrame: number,
    levels: number | undefined,
    cancellationToken: CancellationToken,
  ): Promise<DebugStackFrame[]> {
    const args: DebugProtocol.StackTraceArguments = {
      threadId: this.id,
      startFrame,
      levels,
    };

    const response =
      await this.sessionHandler.sendRequest<DebugProtocol.StackTraceResponse>(
        'stackTrace',
        args,
        {
          // stackTrace is typically called when stopped, but can also be called when active (e.g. before a stop)
          // or even initialized if the adapter supports it pre-run.
          allowedStates: ['active', 'stopped', 'initialized'],
        },
        cancellationToken,
      );

    if (cancellationToken.isCancellationRequested) {
      this.logger.info(
        `[DebugThread._doFetchCallStack] Stack trace request for thread ${this.id} cancelled during or after send.`,
      );
      throw new CancellationError(
        `Stack trace request for thread ${this.id} cancelled.`,
      );
    }

    if (response && response.body && Array.isArray(response.body.stackFrames)) {
      return response.body.stackFrames.map(
        (sf: DebugProtocol.StackFrame) =>
          new DebugStackFrame(sf, this, this.sessionHandler, this.logger),
      );
    } else {
      this.logger.warn(
        `[DebugThread._doFetchCallStack] Received no stack frames or invalid response for thread ID: ${this.id}`,
        { response },
      );
      throw new Error(
        `Failed to retrieve stack frames for thread ID ${this.id}. Adapter returned no stack frames.`,
      );
    }
  }

  public clearCallStack(): void {
    this.logger.info(
      `[DebugThread.clearCallStack] Clearing call stack for thread ID: ${this.id}`,
    );
    const oldCallStackLength = this.callStack.length;
    this._detachStackFrameListeners(this.callStack);
    this.callStack = [];
    this._lastCallStackError = undefined; // Clear last error on explicit clear
    this._isFetchingCallStack = false; // Cancel any ongoing fetch state
    this._fetchCallStackPromise = null; // Invalidate any ongoing fetch promise

    if (oldCallStackLength > 0) {
      this.emit('callStackRefreshed', this.callStack); // Notify with empty stack
    }
  }

  public updateStoppedState(
    stopped: boolean,
    details?: DebugProtocol.StoppedEvent['body'],
  ): void {
    this.logger.info(
      `[DebugThread.updateStoppedState] Updating stopped state for thread ID: ${this.id} to ${stopped}`,
      { details },
    );
    const oldStopped = this.stopped;
    const oldDetails = this.stoppedDetails;

    this.stopped = stopped;
    this.stoppedDetails = details;
    if (!stopped) {
      this.stoppedDetails = undefined;
    }

    if (
      oldStopped !== this.stopped ||
      JSON.stringify(oldDetails) !== JSON.stringify(this.stoppedDetails)
    ) {
      this.emit('stoppedStateChanged', this.stopped, this.stoppedDetails);
    }
  }

  public getTopStackFrame(): DebugStackFrame | undefined {
    return this.callStack.length > 0 ? this.callStack[0] : undefined;
  }
}
