// Define context types for better type safety
export interface ScopesFetchErrorContext {
  errorType: 'scopesFetch';
}

export interface EvaluationErrorContext {
  errorType: 'evaluation';
  expression: string;
  dapContext?: DebugProtocol.EvaluateArguments['context'];
}

export interface ScopeVariableFetchErrorContext {
  errorType: 'scopeVariableFetch';
  scope: DebugScope;
  scopeErrContext?: {
    filter?: 'indexed' | 'named' | undefined;
    start?: number | undefined;
    count?: number | undefined;
    wasFullFetchAttempt: boolean;
  };
}

export type FrameErrorContext =
  | ScopesFetchErrorContext
  | EvaluationErrorContext
  | ScopeVariableFetchErrorContext;

/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { IDAPProtocolClient, DAPRequestError } from './dapProtocolClient';
import { LoggerInterface } from './logging';
import {
  DAPRequestBuilder,
  DAPRequestBuilderOptions,
} from './dapRequestBuilder';
import {
  CancellationToken,
  CancellationTokenSource,
  CancellationError,
} from './common/cancellation';
import { DebugThread } from './model/DebugThread';
import { DebugSource } from './model/DebugSource';
import {
  DAPSessionHandlerInterface,
  DebugStackFrameInterface,
  DebugScopeInterface,
  DebugVariableInterface,
} from './model/model.types';
import { DebugStackFrame } from './model/DebugStackFrame';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DebugScope, DebugScopeEvents } from './model/DebugScope';
import { DebugVariable } from './model/DebugVariable';

export type SessionStatus =
  | 'pending'
  | 'initializing'
  | 'initialized'
  | 'active'
  | 'stopped'
  | 'terminating'
  | 'terminated';

/**
 * Defines the structure for events emitted by DAPSessionHandler.
 */
export interface DAPSessionHandlerEvents {
  sessionStarted: (payload: {
    sessionId: string;
    capabilities: DebugProtocol.Capabilities;
  }) => void;
  sessionEnded: (payload: {
    sessionId: string;
    reason?: string;
    restart?: unknown;
    underlyingError?: { message: string; name?: string; stack?: string };
    exitCode?: number | null;
    signal?: string | null;
  }) => void;
  capabilitiesUpdated: (payload: {
    sessionId: string;
    capabilities: DebugProtocol.Capabilities;
  }) => void;
  output: (payload: {
    sessionId: string;
    category: string | undefined;
    output: string;
    data?: unknown;
  }) => void;
  error: (payload: { sessionId: string; error: Error }) => void;

  threadAdded: (payload: {
    sessionId: string;
    threadId: number;
    threadName: string;
  }) => void;
  threadRemoved: (payload: {
    sessionId: string;
    threadId: number;
    reason?: string;
  }) => void;
  stopped: (payload: {
    sessionId: string;
    threadId: number;
    reason: string;
    allThreadsStopped?: boolean;
    description?: string;
    text?: string;
    hitBreakpointIds?: number[];
  }) => void;
  continued: (payload: {
    sessionId: string;
    threadId?: number;
    allThreadsContinued?: boolean;
  }) => void;
  callStackChanged: (payload: {
    sessionId: string;
    threadId: number;
    callStack: DebugStackFrameInterface[];
  }) => void;
  scopesChanged: (payload: {
    sessionId: string;
    threadId: number;
    frameId: number;
    scopes: DebugScopeInterface[];
  }) => void;
  variablesChanged: (
    payload:
      | {
          sessionId: string;
          variablesReference: number;
          variables: DebugVariableInterface[];
        }
      | {
          sessionId: string;
          variablesReference: number;
          variable: DebugVariableInterface;
        },
  ) => void;
  stateInvalidated: (payload: {
    sessionId: string;
    areas?: DebugProtocol.InvalidatedAreas[];
  }) => void;
  stateFetchError: (payload: {
    sessionId: string;
    command?: string;
    resourceType?: StateFetchErrorResourceType;
    resourceId?: string | number;
    message: string;
    error?: Error;
    details?: unknown;
  }) => void;
  /** Emitted if the 'configurationDone' request fails when automatically sent after the adapter's 'initialized' event. */
  configurationDoneFailed: (payload: {
    sessionId: string;
    error: unknown;
  }) => void;
  /** Emitted when the adapter has sent its 'initialized' event and 'configurationDone' has been attempted (if supported). */
  adapterInitializedAndConfigured: (payload: { sessionId: string }) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface DAPSessionHandler {
  on<U extends keyof DAPSessionHandlerEvents>(
    event: U,
    listener: DAPSessionHandlerEvents[U],
  ): this;
  emit<U extends keyof DAPSessionHandlerEvents>(
    event: U,
    ...args: Parameters<DAPSessionHandlerEvents[U]>
  ): boolean;
}

type StateFetchErrorResourceType =
  | 'threads'
  | 'sourceContent'
  | 'callStack'
  | 'scopes'
  | 'variables'
  | 'setVariable'
  | 'getChildren'
  | 'evaluate'
  | 'stepping';
type StateFetchErrorResourceDetails = {
  sourceReference?: number;
  path?: string;
  threadId?: number;
  frameId?: number;
  scopeVariablesReference?: number;
  variableVariablesReference?: number;
  variableName?: string;
  expression?: string;
  filter?: 'indexed' | 'named';
  start?: number;
  count?: number;
  wasFullFetchAttempt?: boolean;
  evalContext?: DebugProtocol.EvaluateArguments['context'];
  parentVariableVariablesReference?: number;
};

interface FrameErrorContextEvaluation {
  expression: string;
  context?: DebugProtocol.EvaluateArguments['context'];
}

interface FrameErrorContextScopeVariableFetch {
  scope: DebugScope;
  scopeErrContext: Parameters<DebugScopeEvents['fetchFailed']>[1];
}

type _FrameErrorContext =
  | FrameErrorContextEvaluation
  | FrameErrorContextScopeVariableFetch;

export class StateFetchErrorNotifier {
  private _command?: string;
  private _resourceType?: StateFetchErrorResourceType;
  private _resourceDetails?: StateFetchErrorResourceDetails;
  private _error?: Error;
  private _message?: string;
  private _resourceId?: string | number;

  constructor(private sessionHandlerInstance: DAPSessionHandler) {}

  public command(cmd: string): this {
    this._command = cmd;
    return this;
  }

  public resourceType(type: StateFetchErrorResourceType): this {
    this._resourceType = type;
    return this;
  }

  public resourceId(id: string | number): this {
    this._resourceId = id;
    return this;
  }

  public details(details: StateFetchErrorResourceDetails): this {
    this._resourceDetails = details;
    return this;
  }

  public error(err: Error): this {
    this._error = err;
    return this;
  }

  public message(msg?: string): this {
    this._message = msg;
    return this;
  }

  public notify(): void {
    if (!this._resourceType)
      throw new Error('StateFetchErrorNotifier: resourceType is required.');
    if (!this._error)
      throw new Error('StateFetchErrorNotifier: error is required.');

    this.sessionHandlerInstance._handleNotifyStateFetchError({
      command: this._command,
      resourceType: this._resourceType,
      resourceId: this._resourceId,
      resourceDetails: this._resourceDetails || {},
      error: this._error,
      message: this._message,
    });
  }
}

export class DAPSessionHandler
  extends EventEmitter
  implements DAPSessionHandlerInterface
{
  private _status: SessionStatus;
  private _adapterCapabilities: DebugProtocol.Capabilities = {};
  private _configurationDoneSent: boolean = false;
  private readonly _protocolClient: IDAPProtocolClient;
  private readonly _logger: LoggerInterface;
  private readonly _sessionId: string;

  private _threadRequestCancellationSources = new Map<
    number,
    Set<CancellationTokenSource>
  >();
  private _globalRequestCancellationSources =
    new Set<CancellationTokenSource>();

  private _threads: Map<number, DebugThread> = new Map();
  private _sources: Map<string | number, DebugSource> = new Map();
  private _currentStoppedThreadId?: number;

  private _optimisticallyContinuedThreadId?: number;
  private _optimisticallyContinuedAll: boolean = false;

  private _fetchThreadsDebounceTimer: NodeJS.Timeout | undefined;
  private _fetchThreadsDebounceDelayMs = 100;

  constructor(protocolClient: IDAPProtocolClient, logger: LoggerInterface) {
    super();
    this._protocolClient = protocolClient;
    this._logger = logger;
    this._sessionId = randomUUID();
    this._status = 'pending';
    this._logger.info(
      `[DAPSessionHandler] Created with sessionId: ${this._sessionId}`,
    );
    this.registerDAPEventHandlers();
  }

  private registerDAPEventHandlers(): void {
    this._protocolClient.on('output', (event: DebugProtocol.OutputEvent) => {
      this._logger.debug(
        '[DAPSessionHandler] Received "output" event from DAPProtocolClient',
        event.body,
      );
      this.emit('output', {
        sessionId: this.sessionId,
        category: event.body.category,
        output: event.body.output,
        data: event.body.data,
      });
    });

    this._protocolClient.on(
      'terminated',
      (event: DebugProtocol.TerminatedEvent) => {
        this._logger.info(
          `[DAPSessionHandler] Received "terminated" event from DAPProtocolClient. Status: ${this._status}`,
          event.body,
        );
        this.handleSessionTermination({
          reason: 'terminatedByAdapter',
          restart: event.body?.restart,
        });
      },
    );

    this._protocolClient.on('exited', (event: DebugProtocol.ExitedEvent) => {
      this._logger.info(
        `[DAPSessionHandler] Received "exited" event from DAPProtocolClient. Exit code: ${event.body.exitCode}`,
      );
      if (this._status !== 'terminating' && this._status !== 'terminated') {
        this.handleSessionTermination({
          reason: `adapterProcessExited Unexpectedly (Code: ${event.body.exitCode})`,
          exitCode: event.body.exitCode,
        });
      }
    });

    this._protocolClient.on(
      'initialized',
      async (_event: DebugProtocol.InitializedEvent) => {
        try {
          this._logger.debug(
            `[DAPSessionHandler] Received initialized event for session: ${this.sessionId}. Current status: ${this._status}`,
          );
          this._logger.info(
            '[DAPSessionHandler] Received "initialized" event from DAPProtocolClient (adapter is ready for configuration)',
          );
          if (this._status === 'initializing') {
            this._logger.debug(
              '[DAPSessionHandler] Status is "initializing", proceeding with configuration.',
            );
            this.updateStatus('initialized');

            const capabilities = this.getAdapterCapabilities();
            if (
              !this._configurationDoneSent &&
              capabilities.supportsConfigurationDoneRequest
            ) {
              this._logger.info(
                `Adapter supports 'configurationDone' and it hasn't been sent yet. Sending request upon 'initialized' event for session '${this.sessionId}'.`,
              );
              try {
                await this.configurationDone();
                this._logger.info(
                  `'configurationDone' request sent successfully upon 'initialized' event for session '${this.sessionId}'.`,
                );
              } catch (configDoneError) {
                this._logger.error(
                  `Error sending 'configurationDone' upon 'initialized' event for session '${this.sessionId}'. This may cause issues.`,
                  { configDoneError },
                );
                this.emit('configurationDoneFailed', {
                  sessionId: this.sessionId,
                  error: configDoneError,
                });
              }
            } else if (this._configurationDoneSent) {
              this._logger.info(
                `'configurationDone' was already sent for session '${this.sessionId}'. Skipping in 'initialized' event handler.`,
              );
            } else {
              this._logger.info(
                `Adapter does not support 'configurationDone'. Skipping for session '${this.sessionId}' upon 'initialized' event.`,
              );
            }
            this._logger.debug(
              `[DAPSessionHandler] Emitting 'adapterInitializedAndConfigured' for session: ${this.sessionId}`,
            );
            this.emit('adapterInitializedAndConfigured', {
              sessionId: this.sessionId,
            });
          } else {
            this._logger.warn(
              `[DAPSessionHandler] Initialized event for session ${this.sessionId}: status is '${this._status}', not 'initializing'.`,
            );
            this._logger.warn(
              `[DAPSessionHandler] Received "initialized" event in unexpected state: ${this._status}. Not sending configurationDone or emitting ready.`,
            );
          }
        } catch (error) {
          this._logger.error(
            { err: error },
            '[DAPSessionHandler] Error in "initialized" event handler',
          );
        }
      },
    );

    this._protocolClient.on('error', (err: Error) => {
      this._logger.error(
        '[DAPSessionHandler] Received "error" event from DAPProtocolClient',
        err,
      );
      this.emit('error', { sessionId: this.sessionId, error: err });
      const underlyingError = {
        message: err.message,
        name: err.name,
        stack: err.stack,
      };
      this.handleSessionTermination({
        reason: `protocolClientError: ${err.message}`,
        underlyingError,
      });
    });

    this._protocolClient.on('close', () => {
      this._logger.info(
        '[DAPSessionHandler] DAPProtocolClient connection closed.',
      );
      if (this._status !== 'terminating' && this._status !== 'terminated') {
        this.handleSessionTermination({ reason: 'protocolClientClosed' });
      }
    });

    this._protocolClient.on(
      'capabilities',
      (event: DebugProtocol.CapabilitiesEvent) => {
        this._logger.info(
          '[DAPSessionHandler] Received "capabilities" event from DAPProtocolClient',
          event.body,
        );
        if (event.body.capabilities) {
          const stringifyWithSortedKeys = (obj: object) =>
            JSON.stringify(obj, Object.keys(obj).sort());
          const oldCapabilitiesJson = stringifyWithSortedKeys(
            this._adapterCapabilities,
          );
          this._adapterCapabilities = {
            ...this._adapterCapabilities,
            ...event.body.capabilities,
          };
          const newCapabilitiesJson = stringifyWithSortedKeys(
            this._adapterCapabilities,
          );
          this._logger.info(
            '[DAPSessionHandler] Adapter capabilities potentially updated via "capabilities" event.',
            this._adapterCapabilities,
          );
          if (oldCapabilitiesJson !== newCapabilitiesJson) {
            this._logger.info(
              '[DAPSessionHandler] Adapter capabilities changed. Emitting "capabilitiesUpdated".',
            );
            this.emit('capabilitiesUpdated', {
              sessionId: this.sessionId,
              capabilities: this._adapterCapabilities,
            });
          } else {
            this._logger.debug(
              '[DAPSessionHandler] Adapter capabilities received via "capabilities" event, but no change detected. Not emitting "capabilitiesUpdated".',
            );
          }
        }
      },
    );

    this._protocolClient.on(
      'invalidated',
      (event: DebugProtocol.InvalidatedEvent) => {
        const areas = event.body.areas || [];
        this._logger.info(
          `[DAPSessionHandler] Received "invalidated" event. Areas: ${areas.join(', ')}`,
          event.body,
        );
        if (areas.includes('threads')) {
          const removedThreadIds = Array.from(this._threads.keys());
          this._threads.clear();
          this._logger.info(
            `[DAPSessionHandler] Cleared all threads due to 'invalidated' event (threads area). ${removedThreadIds.length} threads removed.`,
          );
          removedThreadIds.forEach((threadId) => {
            this.emit('threadRemoved', {
              sessionId: this.sessionId,
              threadId,
              reason: 'invalidation',
            });
          });
          if (
            this._currentStoppedThreadId &&
            !this._threads.has(this._currentStoppedThreadId)
          ) {
            this._logger.info(
              `[DAPSessionHandler] Current stopped thread ID ${this._currentStoppedThreadId} was removed due to invalidation.`,
            );
            this._currentStoppedThreadId = undefined;
          }
        }
        if (areas.includes('stacks')) {
          this._logger.info(
            "[DAPSessionHandler] Invalidating all thread call stacks due to 'invalidated' event (stacks area).",
          );
          this._threads.forEach((thread) => {
            // The clearCallStack method in DebugThread now emits 'callStackRefreshed'
            thread.clearCallStack();
          });
        }
        if (areas.includes('variables')) {
          this._logger.info(
            "[DAPSessionHandler] Invalidating all variables in all scopes due to 'invalidated' event (variables area).",
          );
          this._threads.forEach((thread) => {
            thread.callStack.forEach((frame) => {
              // Ensure frame.scopes is an array and each scope has invalidateVariablesModel
              if (Array.isArray(frame.scopes)) {
                frame.scopes.forEach((scope) => {
                  // Check if scope is a DebugScope instance and has the method
                  if (
                    scope instanceof DebugScope &&
                    typeof scope.invalidateVariablesModel === 'function'
                  ) {
                    scope.invalidateVariablesModel();
                  } else {
                    this._logger.warn(
                      `[DAPSessionHandler] Scope '${scope.name}' (ref: ${scope.variablesReference}) on frame ${frame.id} cannot be invalidated or is not a full DebugScope instance.`,
                    );
                  }
                });
              }
            });
          });
        }
        this.emit('stateInvalidated', { sessionId: this.sessionId, areas });
      },
    );

    this._protocolClient.on('stopped', (event: DebugProtocol.StoppedEvent) =>
      this._onStoppedEvent(event),
    );
    this._protocolClient.on(
      'continued',
      (event: DebugProtocol.ContinuedEvent) => this._onContinuedEvent(event),
    );
    this._protocolClient.on('thread', (event: DebugProtocol.ThreadEvent) =>
      this._onThreadEvent(event),
    );
  }

  private updateStatus(newStatus: SessionStatus): void {
    if (this._status !== newStatus) {
      this._logger.info(
        `[DAPSessionHandler] Status changed: ${this._status} -> ${newStatus}`,
      );
      this._status = newStatus;
    }
  }

  private handleSessionTermination(args: {
    reason: string;
    restart?: unknown;
    underlyingError?: { message: string; name?: string; stack?: string };
    exitCode?: number | null;
    signal?: string | null;
  }): void {
    const { reason, restart, underlyingError, exitCode, signal } = args;
    if (this._status === 'terminated') {
      this._logger.info(
        `[DAPSessionHandler] Session already 'terminated'. Ignoring further termination for reason: ${reason}`,
      );
      return;
    }
    this._logger.info(
      `[DAPSessionHandler] Handling session termination. Current status: ${this._status}. Reason: ${reason}`,
      { exitCode, signal, underlyingError: underlyingError?.message },
    );
    if (this._fetchThreadsDebounceTimer) {
      clearTimeout(this._fetchThreadsDebounceTimer);
      this._fetchThreadsDebounceTimer = undefined;
      this._logger.debug(
        '[DAPSessionHandler] Cleared fetch threads debounce timer during session termination.',
      );
    }
    this.cancelAllOperations(); // Cancel pending requests
    this.updateStatus('terminated');
    this._adapterCapabilities = {};
    this._threads.forEach((thread) => this._detachListenersFromThread(thread)); // Detach listeners
    this._threads.clear();
    this._sources.clear(); // Assuming DebugSource doesn't have listeners to detach for now
    this._currentStoppedThreadId = undefined;

    // Remove all listeners from the protocol client to prevent leaks
    if (this._protocolClient) {
      this._protocolClient.removeAllListeners();
      this._logger.debug(
        '[DAPSessionHandler] Removed all listeners from protocol client during session termination.',
      );
    }

    this.emit('sessionEnded', {
      sessionId: this.sessionId,
      reason,
      restart,
      underlyingError,
      exitCode,
      signal,
    });
    this._logger.info(
      `[DAPSessionHandler] Emitted 'sessionEnded'. Reason: ${reason}`,
      { exitCode, signal },
    );
  }

  // --- Cancellation Token Management ---

  /**
   * Registers a CancellationTokenSource for an operation.
   * The caller is responsible for creating the CancellationTokenSource and disposing it
   * when the operation completes (successfully or with error), in addition to calling
   * the returned deregister function.
   * @param source The CancellationTokenSource to register.
   * @param threadId Optional threadId if the operation is thread-specific.
   * @returns A dispose function to deregister the source.
   */
  public registerCancellableOperation(
    source: CancellationTokenSource,
    threadId?: number,
  ): () => void {
    if (threadId !== undefined) {
      if (!this._threadRequestCancellationSources.has(threadId)) {
        this._threadRequestCancellationSources.set(threadId, new Set());
      }
      this._threadRequestCancellationSources.get(threadId)!.add(source);
      this._logger.debug(
        `[DAPSessionHandler] Registered cancellable operation for thread ${threadId}. Source count: ${this._threadRequestCancellationSources.get(threadId)!.size}`,
      );
      return () => {
        const sources = this._threadRequestCancellationSources.get(threadId);
        if (sources) {
          sources.delete(source);
          this._logger.debug(
            `[DAPSessionHandler] Deregistered cancellable operation for thread ${threadId}. Remaining: ${sources.size}`,
          );
          if (sources.size === 0) {
            this._threadRequestCancellationSources.delete(threadId);
          }
        }
      };
    } else {
      this._globalRequestCancellationSources.add(source);
      this._logger.debug(
        `[DAPSessionHandler] Registered global cancellable operation. Global source count: ${this._globalRequestCancellationSources.size}`,
      );
      return () => {
        this._globalRequestCancellationSources.delete(source);
        this._logger.debug(
          `[DAPSessionHandler] Deregistered global cancellable operation. Remaining: ${this._globalRequestCancellationSources.size}`,
        );
      };
    }
  }

  private _cancelAndDisposeSources(
    sourcesCollection: Set<CancellationTokenSource>,
  ): void {
    sourcesCollection.forEach((source) => {
      if (!source.token.isCancellationRequested) {
        try {
          source.cancel();
        } catch (e) {
          this._logger.error(
            '[DAPSessionHandler] Error cancelling a CancellationTokenSource',
            e,
          );
        }
      }
      try {
        source.dispose();
      } catch (e) {
        this._logger.error(
          '[DAPSessionHandler] Error disposing a CancellationTokenSource',
          e,
        );
      }
    });
    sourcesCollection.clear();
  }

  /**
   * Cancels all pending operations associated with a specific thread.
   * @param threadId The ID of the thread.
   */
  public cancelOperationsForThread(threadId: number): void {
    const sources = this._threadRequestCancellationSources.get(threadId);
    if (sources && sources.size > 0) {
      this._logger.info(
        `[DAPSessionHandler] Cancelling ${sources.size} operations for thread ${threadId}.`,
      );
      this._cancelAndDisposeSources(sources); // This will also clear the set
      this._threadRequestCancellationSources.delete(threadId);
    } else {
      this._logger.debug(
        `[DAPSessionHandler] No operations to cancel for thread ${threadId}.`,
      );
    }
  }

  /**
   * Cancels all pending operations managed by this session handler.
   */
  public cancelAllOperations(): void {
    this._logger.info(
      `[DAPSessionHandler] Cancelling all operations. ${this._globalRequestCancellationSources.size} global, ${this._threadRequestCancellationSources.size} threads with operations.`,
    );
    this._cancelAndDisposeSources(this._globalRequestCancellationSources);

    this._threadRequestCancellationSources.forEach((sources, threadId) => {
      this._logger.debug(
        `[DAPSessionHandler] Cancelling ${sources.size} operations for thread ${threadId} during cancelAll.`,
      );
      this._cancelAndDisposeSources(sources);
    });
    this._threadRequestCancellationSources.clear();
  }

  // --- Listener Management for Model Events ---

  private _attachListenersToThread(thread: DebugThread): void {
    this._logger.debug(
      `[DAPSessionHandler._attachListenersToThread] Attaching listeners to thread ${thread.id}`,
    );
    thread.on(
      'callStackRefreshed',
      this._handleThreadCallStackRefreshed.bind(this, thread),
    );
    thread.on(
      'callStackFetchFailed',
      this._handleThreadCallStackFetchFailed.bind(this, thread),
    );
    thread.on(
      'stoppedStateChanged',
      this._handleThreadStoppedStateChanged.bind(this, thread),
    );
    thread.on(
      'stackFrameError',
      this._handleThreadStackFrameError.bind(this, thread),
    );
  }

  private _detachListenersFromThread(thread: DebugThread): void {
    this._logger.debug(
      `[DAPSessionHandler._detachListenersFromThread] Detaching listeners from thread ${thread.id}`,
    );
    thread.removeAllListeners();
    thread.callStack.forEach((frame) =>
      this._detachListenersFromStackFrame(frame),
    );
  }

  private _attachListenersToStackFrame(frame: DebugStackFrame): void {
    this._logger.debug(
      `[DAPSessionHandler._attachListenersToStackFrame] Attaching listeners to frame ${frame.id} (thread ${frame.thread.id})`,
    );
    frame.on(
      'scopesRefreshed',
      this._handleFrameScopesRefreshed.bind(this, frame),
    );
    frame.on(
      'scopesFetchFailed',
      this._handleFrameScopesFetchFailed.bind(this, frame),
    );
    frame.on(
      'evaluationFailed',
      this._handleFrameEvaluationFailed.bind(this, frame),
    );
    // scopeVariableFetchFailed is handled by DebugThread's stackFrameError
  }

  private _detachListenersFromStackFrame(frame: DebugStackFrame): void {
    this._logger.debug(
      `[DAPSessionHandler._detachListenersFromStackFrame] Detaching listeners from frame ${frame.id}`,
    );
    frame.removeAllListeners();
    frame.scopes.forEach((scope) => this._detachListenersFromScope(scope));
  }

  private _attachListenersToScope(scope: DebugScope): void {
    this._logger.debug(
      `[DAPSessionHandler._attachListenersToScope] Attaching listeners to scope '${scope.name}' (ref: ${scope.variablesReference}, frame: ${scope.frame.id})`,
    );
    scope.on(
      'variablesRefreshed',
      this._handleScopeVariablesRefreshed.bind(this, scope),
    );
    // fetchFailed from scope is handled by DebugStackFrame's scopeVariableFetchFailed -> DebugThread's stackFrameError
  }

  private _detachListenersFromScope(scope: DebugScope): void {
    this._logger.debug(
      `[DAPSessionHandler._detachListenersFromScope] Detaching listeners from scope '${scope.name}' (ref: ${scope.variablesReference})`,
    );
    scope.removeAllListeners();
    scope.variables.forEach((variable) =>
      this._detachListenersFromVariable(variable),
    );
  }

  private _attachListenersToVariable(
    variable: DebugVariable,
    parentScopeOrVar: DebugScope | DebugVariable,
  ): void {
    const parentType =
      parentScopeOrVar instanceof DebugScope ? 'Scope' : 'Variable';
    this._logger.debug(
      `[DAPSessionHandler._attachListenersToVariable] Attaching listeners to variable '${variable.name}' (ref: ${variable.variablesReference}, parent ${parentType}: '${parentScopeOrVar.name}')`,
    );
    variable.on(
      'childrenRefreshed',
      this._handleVariableChildrenRefreshed.bind(this, variable),
    );
    variable.on(
      'childrenFetchFailed',
      this._handleVariableChildrenFetchFailed.bind(this, variable),
    );
    variable.on(
      'valueChanged',
      this._handleVariableValueChanged.bind(this, variable),
    );
    variable.on(
      'setValueFailed',
      this._handleVariableSetValueFailed.bind(this, variable),
    );
  }

  private _detachListenersFromVariable(variable: DebugVariable): void {
    this._logger.debug(
      `[DAPSessionHandler._detachListenersFromVariable] Detaching listeners from variable '${variable.name}' (ref: ${variable.variablesReference})`,
    );
    variable.removeAllListeners();
    variable.children.forEach((child) =>
      this._detachListenersFromVariable(child),
    );
  }

  // --- Model Event Handlers ---

  private _handleThreadCallStackRefreshed(
    thread: DebugThread,
    frames: DebugStackFrame[],
  ): void {
    this._logger.debug(
      `[DAPSessionHandler._handleThreadCallStackRefreshed] Thread ${thread.id} call stack refreshed with ${frames.length} frames.`,
    );
    this.emit('callStackChanged', {
      sessionId: this.sessionId,
      threadId: thread.id,
      callStack: frames,
    });
    frames.forEach((frame) => this._attachListenersToStackFrame(frame));
  }

  private _handleThreadCallStackFetchFailed(
    thread: DebugThread,
    error: Error,
  ): void {
    this._logger.warn(
      `[DAPSessionHandler._handleThreadCallStackFetchFailed] Thread ${thread.id} call stack fetch failed.`,
      { error },
    );
    new StateFetchErrorNotifier(this)
      .command('stackTrace')
      .resourceType('callStack')
      .details({ threadId: thread.id })
      .error(error)
      .message(error.message)
      .notify();
    this.emit('callStackChanged', {
      sessionId: this.sessionId,
      threadId: thread.id,
      callStack: [],
    });
  }

  private _handleThreadStoppedStateChanged(
    thread: DebugThread,
    stopped: boolean,
    details?: DebugProtocol.StoppedEvent['body'],
  ): void {
    this._logger.debug(
      `[DAPSessionHandler._handleThreadStoppedStateChanged] Thread ${thread.id} stopped state changed to ${stopped}.`,
      { details },
    );

    if (stopped) {
      // If this thread stops, the overall session is considered stopped.
      this.updateStatus('stopped');
    } else {
      // This thread continued. Check if other threads are still stopped.
      const anyOtherThreadStopped = Array.from(this._threads.values()).some(
        (t) => t.id !== thread.id && t.stopped,
      );

      if (anyOtherThreadStopped) {
        // Other threads are still stopped; session remains stopped.
        // If the continued thread was the current one, find a new current stopped thread.
        if (this._currentStoppedThreadId === thread.id) {
          this._currentStoppedThreadId = Array.from(
            this._threads.values(),
          ).find((t) => t.stopped)?.id;
        }
      } else {
        // No other threads are stopped, and this one continued. Session becomes active.
        this.updateStatus('active');
        this._currentStoppedThreadId = undefined;
      }
    }
  }

  private _handleThreadStackFrameError(
    thread: DebugThread,
    frame: DebugStackFrame,
    errorType: 'scopesFetch' | 'evaluation' | 'scopeVariableFetch',
    error: Error,
    context?: FrameErrorContext,
  ): void {
    this._logger.warn(
      `[DAPSessionHandler._handleThreadStackFrameError] Error in frame ${frame.id} of thread ${thread.id}. Type: ${errorType}`,
      { error, context },
    );

    if (context && context.errorType !== errorType) {
      this._logger.error(
        `[DAPSessionHandler._handleThreadStackFrameError] Mismatch between errorType parameter ('${errorType}') and context.errorType ('${context.errorType}'). Using errorType parameter as primary guide.`,
        { frame, error, receivedContext: context },
      );
    }

    switch (errorType) {
      case 'scopesFetch':
        this._handleFrameScopesFetchFailed(frame, error);
        break;
      case 'evaluation':
        if (context && context.errorType === 'evaluation') {
          this._handleFrameEvaluationFailed(
            frame,
            error,
            context.expression,
            context.dapContext,
          );
        } else {
          this._logger.error(
            `[DAPSessionHandler._handleThreadStackFrameError] Evaluation error for frame ${frame.id}. Expected 'evaluation' context but received incompatible or no context.`,
            { frame, error, receivedContext: context },
          );
          new StateFetchErrorNotifier(this)
            .command('evaluate')
            .resourceType('evaluate')
            .details({ frameId: frame.id, threadId: thread.id })
            .error(error)
            .message(error.message)
            .notify();
        }
        break;
      case 'scopeVariableFetch':
        if (context && context.errorType === 'scopeVariableFetch') {
          if (context.scopeErrContext) {
            this._handleFrameScopeVariableFetchFailed(
              frame,
              context.scope,
              error,
              context.scopeErrContext,
            );
          } else {
            this._logger.error(
              `[DAPSessionHandler._handleThreadStackFrameError] Scope variable fetch error for frame ${frame.id}: 'scopeErrContext' is missing within the provided 'scopeVariableFetch' context.`,
              { frame, error, receivedContext: context },
            );
            new StateFetchErrorNotifier(this)
              .command('variables')
              .resourceType('variables')
              .details({ frameId: frame.id, threadId: thread.id })
              .error(error)
              .message(
                'Context for scope variable fetch error was incomplete (scopeErrContext undefined).',
              )
              .notify();
          }
        } else {
          this._logger.error(
            `[DAPSessionHandler._handleThreadStackFrameError] Scope variable fetch error for frame ${frame.id}. Expected 'scopeVariableFetch' context but received incompatible or no context.`,
            { frame, error, receivedContext: context },
          );
          new StateFetchErrorNotifier(this)
            .command('variables')
            .resourceType('variables')
            .details({ frameId: frame.id, threadId: thread.id })
            .error(error)
            .message(error.message)
            .notify();
        }
        break;
    }
  }

  private _handleFrameScopesRefreshed(
    frame: DebugStackFrame,
    scopes: DebugScope[],
  ): void {
    this._logger.debug(
      `[DAPSessionHandler._handleFrameScopesRefreshed] Frame ${frame.id} (thread ${frame.thread.id}) scopes refreshed with ${scopes.length} scopes.`,
    );
    this.emit('scopesChanged', {
      sessionId: this.sessionId,
      threadId: frame.thread.id,
      frameId: frame.id,
      scopes,
    });
    scopes.forEach((scope) => this._attachListenersToScope(scope));
  }

  private _handleFrameScopesFetchFailed(
    frame: DebugStackFrame,
    error: Error,
  ): void {
    this._logger.warn(
      `[DAPSessionHandler._handleFrameScopesFetchFailed] Frame ${frame.id} (thread ${frame.thread.id}) scopes fetch failed.`,
      { error },
    );
    new StateFetchErrorNotifier(this)
      .command('scopes')
      .resourceType('scopes')
      .details({ frameId: frame.id, threadId: frame.thread.id })
      .error(error)
      .message(error.message)
      .notify();
    this.emit('scopesChanged', {
      sessionId: this.sessionId,
      threadId: frame.thread.id,
      frameId: frame.id,
      scopes: [],
    });
  }

  private _handleFrameEvaluationFailed(
    frame: DebugStackFrame,
    error: Error,
    expression: string,
    evalContext?: DebugProtocol.EvaluateArguments['context'],
  ): void {
    this._logger.warn(
      `[DAPSessionHandler._handleFrameEvaluationFailed] Frame ${frame.id} (thread ${frame.thread.id}) evaluation failed for expression: ${expression}`,
      { error, evalContext },
    );
    new StateFetchErrorNotifier(this)
      .command('evaluate')
      .resourceType('evaluate')
      .details({
        frameId: frame.id,
        threadId: frame.thread.id,
        expression,
        evalContext: evalContext,
      })
      .error(error)
      .message(error.message)
      .notify();
  }

  private _handleFrameScopeVariableFetchFailed(
    frame: DebugStackFrame,
    scope: DebugScope,
    error: Error,
    scopeErrorContext: Parameters<DebugScopeEvents['fetchFailed']>[1],
  ): void {
    this._logger.warn(
      `[DAPSessionHandler._handleFrameScopeVariableFetchFailed] Scope '${scope.name}' (ref: ${scope.variablesReference}, frame: ${frame.id}, thread: ${frame.thread.id}) variable fetch failed.`,
      { error, scopeErrorContext },
    );
    new StateFetchErrorNotifier(this)
      .command('variables') // Assuming, could be refined if scopeErrorContext provides original command
      .resourceType('variables')
      .details({
        scopeVariablesReference: scope.variablesReference,
        frameId: frame.id,
        threadId: frame.thread.id,
        filter: scopeErrorContext.filter,
        start: scopeErrorContext.start,
        count: scopeErrorContext.count,
        wasFullFetchAttempt: scopeErrorContext.wasFullFetchAttempt,
      })
      .error(error)
      .message(error.message)
      .notify();
  }

  private _handleScopeVariablesRefreshed(
    scope: DebugScope,
    variables: DebugVariable[],
  ): void {
    this._logger.debug(
      `[DAPSessionHandler._handleScopeVariablesRefreshed] Scope '${scope.name}' (ref: ${scope.variablesReference}, frame: ${scope.frame.id}) variables refreshed with ${variables.length} variables.`,
    );
    this.emit('variablesChanged', {
      sessionId: this.sessionId,
      variablesReference: scope.variablesReference,
      variables,
    });
    variables.forEach((variable) =>
      this._attachListenersToVariable(variable, scope),
    );
  }

  private _handleVariableChildrenRefreshed(
    variable: DebugVariable,
    children: DebugVariable[],
  ): void {
    this._logger.debug(
      `[DAPSessionHandler._handleVariableChildrenRefreshed] Variable '${variable.name}' (ref: ${variable.variablesReference}) children refreshed with ${children.length} children.`,
    );
    // This event implies that the 'variables' property of a 'variablesReference' (which belongs to the parent variable) has changed.
    this.emit('variablesChanged', {
      sessionId: this.sessionId,
      variablesReference: variable.variablesReference,
      variables: children,
    });
    children.forEach((child) =>
      this._attachListenersToVariable(child, variable),
    );
  }

  private _handleVariableChildrenFetchFailed(
    variable: DebugVariable,
    error: Error,
  ): void {
    this._logger.warn(
      `[DAPSessionHandler._handleVariableChildrenFetchFailed] Variable '${variable.name}' (ref: ${variable.variablesReference}) children fetch failed.`,
      { error },
    );
    new StateFetchErrorNotifier(this)
      .command('variables') // Command for fetching children is 'variables'
      .resourceType('getChildren')
      .details({
        variableVariablesReference: variable.variablesReference,
        variableName: variable.name,
        // Attempt to get parent scope/variable reference for more context
        ...(variable.parentScopeOrVar instanceof DebugScope && {
          scopeVariablesReference: variable.parentScopeOrVar.variablesReference,
        }),
        ...(variable.parentScopeOrVar instanceof DebugVariable && {
          parentVariableVariablesReference: (
            variable.parentScopeOrVar as DebugVariable
          ).variablesReference,
        }),
      })
      .error(error)
      .message(error.message)
      .notify();
    // Notify that the children list for this variable's reference is now empty (or unchanged but failed)
    this.emit('variablesChanged', {
      sessionId: this.sessionId,
      variablesReference: variable.variablesReference,
      variables: [],
    });
  }

  private _handleVariableValueChanged(
    variable: DebugVariable,
    newValue: string,
    newType?: string,
    newVarRef?: number,
  ): void {
    this._logger.debug(
      `[DAPSessionHandler._handleVariableValueChanged] Variable '${variable.name}' value changed. New value: ${newValue}, Type: ${newType}, VarRef: ${newVarRef}`,
    );

    let containerVariablesReference: number;
    if (variable.parentScopeOrVar instanceof DebugScope) {
      containerVariablesReference =
        variable.parentScopeOrVar.variablesReference;
    } else {
      // Parent is DebugVariable
      containerVariablesReference =
        variable.parentScopeOrVar.variablesReference;
    }

    // Emit that a single variable within the container (identified by containerVariablesReference) has changed.
    // The DAP spec for 'variablesChanged' event doesn't exist.
    // VS Code typically re-requests variables for a scope/reference if it thinks they might have changed.
    // For now, we'll emit our custom 'variablesChanged' with a single variable.
    // Clients can use this to selectively update or mark the parent container as dirty.
    this.emit('variablesChanged', {
      sessionId: this.sessionId,
      variablesReference: containerVariablesReference, // This is the reference of the *container*
      variable: variable, // Send the updated variable itself
    });

    // If the variable's own variablesReference changed, its children structure is now invalid.
    // The DebugVariable itself clears its children. DAPSessionHandler might need to detach listeners from old children if any were attached.
    // This is handled by _detachListenersFromVariable if called when the parent (scope/var) refreshes.
  }

  private _handleVariableSetValueFailed(
    variable: DebugVariable,
    error: Error,
    attemptedValue: string,
  ): void {
    this._logger.warn(
      `[DAPSessionHandler._handleVariableSetValueFailed] Variable '${variable.name}' set value failed. Attempted: ${attemptedValue}`,
      { error },
    );

    let containerVariablesReference: number | undefined;
    if (variable.parentScopeOrVar instanceof DebugScope) {
      containerVariablesReference =
        variable.parentScopeOrVar.variablesReference;
    } else {
      // Parent is DebugVariable
      containerVariablesReference =
        variable.parentScopeOrVar.variablesReference;
    }

    new StateFetchErrorNotifier(this)
      .command('setVariable')
      .resourceType('setVariable')
      .details({
        variableName: variable.name,
        variableVariablesReference: variable.variablesReference, // The ref of the variable being set
        scopeVariablesReference: containerVariablesReference, // The ref of its container
        // attemptedValue: attemptedValue // Not a standard field in StateFetchErrorResourceDetails yet
      })
      .error(error)
      .message(error.message)
      .notify();
  }

  // --- Public API for State Access ---

  public get sessionId(): string {
    return this._sessionId;
  }

  public get status(): SessionStatus {
    return this._status;
  }

  public getAdapterCapabilities(): DebugProtocol.Capabilities {
    return this._adapterCapabilities;
  }

  public get capabilities(): DebugProtocol.Capabilities {
    // Alias for getAdapterCapabilities
    return this.getAdapterCapabilities();
  }

  public getThreads(): DebugThread[] {
    return Array.from(this._threads.values());
  }

  public getThread(threadId: number): DebugThread | undefined {
    return this._threads.get(threadId);
  }

  public getActiveThread(): DebugThread | undefined {
    if (this._currentStoppedThreadId !== undefined) {
      return this._threads.get(this._currentStoppedThreadId);
    }
    return this._threads.size > 0
      ? this._threads.values().next().value
      : undefined;
  }

  public getSource(sourceData: DebugProtocol.Source): DebugSource | undefined {
    const hasValidRef =
      sourceData.sourceReference && sourceData.sourceReference > 0;
    const hasValidPath =
      typeof sourceData.path === 'string' && sourceData.path.length > 0;
    let key: string | number | undefined;

    if (hasValidRef) {
      key = sourceData.sourceReference;
    } else if (hasValidPath) {
      key = sourceData.path;
    }

    if (key === undefined) {
      this._logger.warn(
        '[DAPSessionHandler.getSource] Attempted to get source without a valid path or non-zero sourceReference.',
        { sourceData },
      );
      return undefined;
    }

    let source = this._sources.get(key);
    if (!source) {
      source = new DebugSource(sourceData, this, this._logger);
      this._sources.set(key, source);
      this._logger.debug(
        `[DAPSessionHandler.getSource] Created and cached new DebugSource for key: ${key}`,
        { sourceData },
      );
    }
    return source;
  }

  public get currentStoppedThreadId(): number | undefined {
    return this._currentStoppedThreadId;
  }

  // --- End Public API for State Access ---

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private _requestBuilder<TResp extends DebugProtocol.Response>() {
    return new DAPRequestBuilder<TResp>(
      this,
      this._protocolClient,
      this._logger,
    );
  }

  async initialize(
    args: DebugProtocol.InitializeRequestArguments,
  ): Promise<DebugProtocol.Capabilities | null> {
    if (this._status !== 'pending') {
      const errorMsg = `[DAPSessionHandler] initialize() called in invalid state: ${this._status}. Expected 'pending'.`;
      this._logger.error(errorMsg);
      const err = new Error(errorMsg);
      this.emit('error', { sessionId: this.sessionId, error: err });
      throw err;
    }
    this.updateStatus('initializing');
    const builder = this._requestBuilder<DebugProtocol.InitializeResponse>()
      .command('initialize')
      .args(args)
      .allowedStates(['initializing'])
      .callerOptions({
        isTerminatingFailure: true,
        failureReasonPrefix: 'initialization',
      });
    try {
      const response = await builder.send(); // Send the initialize request
      const options = builder.getCallerOptions();

      if (response.success && response.body) {
        this._adapterCapabilities = response.body;
        // DO NOT update status to 'initialized' here. This will be done when the adapter's 'initialized' event is received.
        // this.updateStatus('initialized');
        this._logger.info(
          '[DAPSessionHandler] "initialize" DAP request successful. Capabilities stored. Status remains "initializing".',
          this._adapterCapabilities,
        );
        this.emit('sessionStarted', {
          sessionId: this.sessionId,
          capabilities: this._adapterCapabilities,
        }); // It's okay to emit sessionStarted
        this.emit('capabilitiesUpdated', {
          sessionId: this.sessionId,
          capabilities: this._adapterCapabilities,
        });
        return this._adapterCapabilities;
      } else {
        const terminateMsg = `${options.failureReasonPrefix}Failed: ${response.message || 'Adapter error'}`;
        if (options.isTerminatingFailure) {
          this.handleSessionTermination({ reason: terminateMsg });
        }
        // If _rejectAdapterIsReady was used, it would be called here, but we're removing that specific promise from this direct flow.
        return null;
      }
    } catch (error: unknown) {
      const options = builder.getCallerOptions();
      const errorMsg = `${options.failureReasonPrefix}Error: ${this.getErrorMessage(error)}`;
      if (options.isTerminatingFailure) {
        const underlyingError =
          error instanceof Error
            ? { message: error.message, name: error.name, stack: error.stack }
            : { message: this.getErrorMessage(error) };
        this.handleSessionTermination({ reason: errorMsg, underlyingError });
      }
      // If _rejectAdapterIsReady was used, it would be called here.
      throw error;
    }
  }

  async launch(
    args: DebugProtocol.LaunchRequestArguments,
  ): Promise<DebugProtocol.Response> {
    const builder = this._requestBuilder<DebugProtocol.LaunchResponse>()
      .command('launch')
      .args(args)
      .allowedStates(['initializing', 'initialized']) // Allow 'initializing' for debugpy-like adapters
      .callerOptions({
        successStateUpdate: 'active',
        isTerminatingFailure: true,
        failureReasonPrefix: 'launch',
      });
    try {
      const response = await builder.send();
      const options = builder.getCallerOptions();
      if (response.success) {
        if (options.successStateUpdate) {
          this.updateStatus(options.successStateUpdate);
        }
      } else {
        if (options.isTerminatingFailure) {
          this.handleSessionTermination({
            reason: `${options.failureReasonPrefix}Failed: ${response.message || 'Adapter error'}`,
          });
        }
      }
      return response;
    } catch (error: unknown) {
      const options = builder.getCallerOptions();
      if (options.isTerminatingFailure) {
        const underlyingError =
          error instanceof Error
            ? { message: error.message, name: error.name, stack: error.stack }
            : { message: this.getErrorMessage(error) };
        this.handleSessionTermination({
          reason: `${options.failureReasonPrefix}Error: ${this.getErrorMessage(error)}`,
          underlyingError,
        });
      }
      throw error;
    }
  }

  async attach(
    args: DebugProtocol.AttachRequestArguments,
  ): Promise<DebugProtocol.Response> {
    const builder = this._requestBuilder<DebugProtocol.AttachResponse>()
      .command('attach')
      .args(args)
      .allowedStates(['initializing', 'initialized']) // Allow 'initializing' for debugpy-like adapters
      .callerOptions({
        successStateUpdate: 'active',
        isTerminatingFailure: true,
        failureReasonPrefix: 'attach',
      });
    try {
      const response = await builder.send();
      const options = builder.getCallerOptions();
      if (response.success) {
        if (options.successStateUpdate) {
          this.updateStatus(options.successStateUpdate);
        }
      } else {
        if (options.isTerminatingFailure) {
          this.handleSessionTermination({
            reason: `${options.failureReasonPrefix}Failed: ${response.message || 'Adapter error'}`,
          });
        }
      }
      return response;
    } catch (error: unknown) {
      const options = builder.getCallerOptions();
      if (options.isTerminatingFailure) {
        const underlyingError =
          error instanceof Error
            ? { message: error.message, name: error.name, stack: error.stack }
            : { message: this.getErrorMessage(error) };
        this.handleSessionTermination({
          reason: `${options.failureReasonPrefix}Error: ${this.getErrorMessage(error)}`,
          underlyingError,
        });
      }
      throw error;
    }
  }

  async configurationDone(): Promise<DebugProtocol.Response> {
    if (this._configurationDoneSent) {
      this._logger.info(
        `[DAPSessionHandler.configurationDone] Request already sent for session '${this.sessionId}'. Returning mock success.`,
      );
      // Return a generic success response as the actual request was handled previously.
      return {
        request_seq: -1, // Indicate it's not a direct response to a new request_seq
        seq: -1,
        type: 'response',
        command: 'configurationDone',
        success: true,
      };
    }

    const builder =
      this._requestBuilder<DebugProtocol.ConfigurationDoneResponse>()
        .command('configurationDone')
        .args(undefined)
        // Allow 'initializing' if SessionManager calls it right after initialize() and before launch() response sets to 'active'.
        // Allow 'active' if SessionManager calls it after launch() response.
        // Allow 'initialized' if this is called from the 'initialized' event handler.
        .allowedStates(['initializing', 'initialized', 'active'])
        .callerOptions({
          isTerminatingFailure: false, // Typically, failure here isn't fatal for the session start
          failureReasonPrefix: 'configurationDone',
        });
    try {
      this._logger.info(
        `[DAPSessionHandler.configurationDone] Sending 'configurationDone' for session '${this.sessionId}'. Current status: ${this.status}`,
      );
      // Set flag optimistically before sending to prevent re-entrancy from the 'initialized' event handler
      // if the 'initialized' event arrives and is processed before this 'await' completes.
      this._configurationDoneSent = true;
      const response = await builder.send();
      const options = builder.getCallerOptions();

      if (response.success) {
        // _configurationDoneSent is already true.
        this._logger.info(
          `[DAPSessionHandler.configurationDone] Successfully sent 'configurationDone' for session '${this.sessionId}'.`,
        );
      } else {
        // If it failed, _configurationDoneSent remains true, which is fine.
        // The 'initialized' event handler will see it as true and not try to send again.
        this._logger.warn(
          `[DAPSessionHandler.configurationDone] 'configurationDone' request failed for session '${this.sessionId}'. Response:`,
          response,
        );
        if (options.isTerminatingFailure) {
          // This is typically false for configurationDone
          this.handleSessionTermination({
            reason: `${options.failureReasonPrefix}Failed: ${response.message || 'Adapter error'}`,
          });
        }
      }
      return response;
    } catch (error: unknown) {
      const options = builder.getCallerOptions();
      this._logger.error(
        `[DAPSessionHandler.configurationDone] Error sending 'configurationDone' for session '${this.sessionId}'.`,
        { error: this.getErrorMessage(error) },
      );
      if (options.isTerminatingFailure) {
        // This is typically false for configurationDone
        const underlyingError =
          error instanceof Error
            ? { message: error.message, name: error.name, stack: error.stack }
            : { message: this.getErrorMessage(error) };
        this.handleSessionTermination({
          reason: `${options.failureReasonPrefix}Error: ${this.getErrorMessage(error)}`,
          underlyingError,
        });
      }
      throw error; // Re-throw to allow SessionManager to potentially handle it
    }
  }

  async disconnect(
    args?: DebugProtocol.DisconnectArguments,
  ): Promise<DebugProtocol.Response> {
    this._logger.info('[DAPSessionHandler] disconnect() called', args);
    if (this._status === 'terminating' || this._status === 'terminated') {
      this._logger.warn(
        `[DAPSessionHandler] disconnect() called when session already ${this._status}.`,
      );
      return {
        request_seq: -1,
        seq: -1,
        success: true,
        command: 'disconnect',
        type: 'response',
      };
    }
    this.updateStatus('terminating');
    try {
      const response =
        await this._protocolClient.sendRequest<DebugProtocol.DisconnectResponse>(
          'disconnect',
          args,
        );
      if (response.success) {
        this._logger.info(
          '[DAPSessionHandler] Disconnect request acknowledged by adapter.',
        );
      } else {
        const dapErrorMessage =
          response.message || 'Disconnect request failed.';
        this._logger.error(
          `[DAPSessionHandler] Disconnect request failed: ${dapErrorMessage}`,
          response,
        );
        this.emit('error', {
          sessionId: this.sessionId,
          error: new Error(dapErrorMessage),
        });
        this.handleSessionTermination({
          reason: `disconnectRequestFailed: ${dapErrorMessage}`,
        });
      }
      return response;
    } catch (error: unknown) {
      const errorMessage = this.getErrorMessage(error);
      this._logger.error(
        `[DAPSessionHandler] Error during disconnect request: ${errorMessage}`,
        error,
      );
      const err = error instanceof Error ? error : new Error(errorMessage);
      const underlyingError = {
        message: err.message,
        name: err.name,
        stack: err.stack,
      };
      this.emit('error', { sessionId: this.sessionId, error: err });
      this.handleSessionTermination({
        reason: `disconnectError: ${errorMessage}`,
        underlyingError,
      });
      throw err;
    }
  }

  async setBreakpoints(
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<DebugProtocol.SetBreakpointsResponse> {
    // Breakpoints can be set when the session is initialized (before running), active (while running), or stopped.
    if (
      this._status !== 'active' &&
      this._status !== 'initialized' &&
      this._status !== 'stopped'
    ) {
      const errorMsg = `[DAPSessionHandler] setBreakpoints() called in invalid state: ${this._status}. Expected 'active', 'initialized', or 'stopped'.`;
      this._logger.error(errorMsg);
      this.emit('error', {
        sessionId: this.sessionId,
        error: new Error(errorMsg),
      });
      return {
        request_seq: -1,
        seq: -1,
        success: false,
        command: 'setBreakpoints',
        type: 'response',
        message: errorMsg,
        body: { breakpoints: [] },
      };
    }
    const builder = this._requestBuilder<DebugProtocol.SetBreakpointsResponse>()
      .command('setBreakpoints')
      .args(args)
      .allowedStates(['initialized', 'active', 'stopped'])
      .callerOptions({
        isTerminatingFailure: false,
      });
    return await builder.send();
  }

  async evaluate(
    args: DebugProtocol.EvaluateArguments,
  ): Promise<DebugProtocol.EvaluateResponse> {
    // Evaluation is typically done when stopped. Allow 'active' for potential future use cases like logpoints.
    if (this._status !== 'stopped' && this._status !== 'active') {
      const errorMsg = `[DAPSessionHandler] evaluate() called in invalid state: ${this._status}. Expected 'stopped' or 'active'.`;
      this._logger.error(errorMsg);
      this.emit('error', {
        sessionId: this.sessionId,
        error: new Error(errorMsg),
      });
      return {
        request_seq: -1,
        seq: -1,
        success: false,
        command: 'evaluate',
        type: 'response',
        message: errorMsg,
        body: {
          result: `Error: Session not in 'stopped' or 'active' state. Current state: ${this._status}`,
          variablesReference: 0,
        },
      };
    }
    const builder = this._requestBuilder<DebugProtocol.EvaluateResponse>()
      .command('evaluate')
      .args(args)
      .allowedStates(['stopped', 'active'])
      .callerOptions({
        isTerminatingFailure: false,
      });
    return await builder.send();
  }

  // --- Stepping Commands ---

  private async _executeSteppingCommand(
    command: 'next' | 'stepIn' | 'stepOut' | 'continue',
    threadId?: number, // This is the logical/intended threadId for the operation
    // args here are any *additional* arguments for the specific stepping command (e.g., granularity)
    // It should NOT include threadId, as that's handled by the `threadId` parameter above.
    args?:
      | Omit<DebugProtocol.NextArguments, 'threadId'>
      | Omit<DebugProtocol.StepInArguments, 'threadId'>
      | Omit<DebugProtocol.StepOutArguments, 'threadId'>
      | Omit<DebugProtocol.ContinueArguments, 'threadId'>,
  ): Promise<DebugProtocol.Response> {
    // Stepping commands are only valid when the debugger is stopped.
    // The session status should reflect this.
    if (this._status !== 'stopped') {
      const errorMsg = `[DAPSessionHandler.${command}] called in invalid state: ${this._status}. Expected 'stopped'.`;
      this._logger.error(errorMsg);
      this.emit('error', {
        sessionId: this.sessionId,
        error: new Error(errorMsg),
      });
      return {
        request_seq: -1,
        seq: -1,
        success: false,
        command,
        type: 'response',
        message: errorMsg,
      };
    }

    const requestArgs: Record<string, unknown> = { ...args };
    const effectiveThreadId = threadId;

    // --- Argument Construction Logic for DAP Request ---
    if (command === 'continue') {
      if (effectiveThreadId !== undefined) {
        requestArgs.threadId = effectiveThreadId;
        this._logger.debug(
          `[DAPSessionHandler.${command}] Preparing single thread continue for threadId: ${effectiveThreadId}.`,
        );
      } else {
        this._logger.debug(
          `[DAPSessionHandler.${command}] Preparing global continue (all threads). requestArgs will not include threadId unless already in ...args`,
        );
        // Ensure threadId is not part of requestArgs if it was accidentally in `...args` for a global continue
        if (args && 'threadId' in args) {
          delete requestArgs.threadId;
        }
      }
    } else {
      // For next, stepIn, stepOut
      if (effectiveThreadId === undefined) {
        const errorMsg = `[DAPSessionHandler.${command}] threadId is strictly required for this command.`;
        this._logger.error(errorMsg);
        this.emit('error', {
          sessionId: this.sessionId,
          error: new Error(errorMsg),
        });
        return {
          request_seq: -1,
          seq: -1,
          success: false,
          command,
          type: 'response',
          message: errorMsg,
        };
      }
      requestArgs.threadId = effectiveThreadId;
    }

    const builder = this._requestBuilder<DebugProtocol.Response>()
      .command(command)
      .args(requestArgs)
      .allowedStates(['stopped']) // Stepping commands must be issued when stopped
      .callerOptions({
        isTerminatingFailure: false,
        failureReasonPrefix: command,
      });

    try {
      const response = await builder.send();
      if (response.success) {
        this._logger.info(
          `[DAPSessionHandler.${command}] DAP request successful for effectiveThreadId: ${effectiveThreadId}.`,
        );
        this._performOptimisticContinue(
          effectiveThreadId,
          command === 'continue' && effectiveThreadId === undefined,
        );
      } else {
        this._logger.error(
          `[DAPSessionHandler.${command}] DAP request failed for effectiveThreadId: ${effectiveThreadId}. Message: ${response.message}`,
          response,
        );
      }
      return response;
    } catch (error: unknown) {
      this._logger.error(
        `[DAPSessionHandler.${command}] Error during DAP request for effectiveThreadId: ${effectiveThreadId}.`,
        error,
      );
      const err = error instanceof Error ? error : new Error(String(error));
      const notifier = new StateFetchErrorNotifier(this)
        .command(command)
        .resourceType('stepping')
        .details({ threadId: effectiveThreadId })
        .error(err)
        .message(err.message);
      if (effectiveThreadId !== undefined) {
        notifier.resourceId(effectiveThreadId);
      }
      notifier.notify();
      throw error;
    }
  }

  /**
   * Helper method to perform optimistic state updates when a continue-like action occurs.
   * @param continuedThreadId The specific thread that continued, or undefined if all threads continued.
   * @param allThreadsContinued Indicates if all threads were affected by a global continue.
   */
  private _performOptimisticContinue(
    continuedThreadId?: number,
    allThreadsContinued?: boolean,
  ): void {
    this._logger.debug(
      `[DAPSessionHandler._performOptimisticContinue] Updating state. Thread: ${continuedThreadId}, AllThreads: ${allThreadsContinued}`,
    );

    // Set flags for optimistic update
    this._optimisticallyContinuedAll = !!allThreadsContinued;
    this._optimisticallyContinuedThreadId = allThreadsContinued
      ? undefined
      : continuedThreadId;

    if (allThreadsContinued) {
      this._logger.info(
        `[DAPSessionHandler] Optimistically updating all threads as continued.`,
      );
      this._threads.forEach((thread) => {
        thread.clearCallStack();
        thread.stoppedDetails = undefined;
      });
      this._currentStoppedThreadId = undefined;
    } else if (continuedThreadId !== undefined) {
      const targetThread = this._threads.get(continuedThreadId);
      if (targetThread) {
        this._logger.info(
          `[DAPSessionHandler] Optimistically updating thread ${continuedThreadId} as continued.`,
        );
        targetThread.clearCallStack();
        targetThread.stoppedDetails = undefined;
        if (this._currentStoppedThreadId === continuedThreadId) {
          this._currentStoppedThreadId = undefined;
        }
      } else {
        this._logger.warn(
          `[DAPSessionHandler] Optimistic update: Thread ${continuedThreadId} not found.`,
        );
      }
    }
    this.emit('continued', {
      sessionId: this.sessionId,
      threadId: continuedThreadId,
      allThreadsContinued,
    });
  }

  public async continue(threadId?: number): Promise<DebugProtocol.Response> {
    return this._executeSteppingCommand('continue', threadId, undefined);
  }

  public async next(
    threadId: number,
    args?: Omit<DebugProtocol.NextArguments, 'threadId'>,
  ): Promise<DebugProtocol.Response> {
    return this._executeSteppingCommand('next', threadId, args);
  }

  public async stepIn(
    threadId: number,
    args?: Omit<DebugProtocol.StepInArguments, 'threadId'>,
  ): Promise<DebugProtocol.Response> {
    return this._executeSteppingCommand('stepIn', threadId, args);
  }

  public async stepOut(
    threadId: number,
    args?: Omit<DebugProtocol.StepOutArguments, 'threadId'>,
  ): Promise<DebugProtocol.Response> {
    return this._executeSteppingCommand('stepOut', threadId, args);
  }

  // --- End Stepping Commands ---

  // --- Interface Methods for DAPSessionHandlerInterface ---

  public async sendRequest<TResponse extends DebugProtocol.Response>(
    command: string,
    args?: DebugProtocol.Request['arguments'],
    options?: DAPRequestBuilderOptions,
    cancellationToken?: CancellationToken,
  ): Promise<TResponse> {
    this._logger.debug(
      `[DAPSessionHandler.sendRequest] Sending command: ${command}`,
      { args, options },
    );

    const builder = this._requestBuilder<TResponse>()
      .command(command)
      .args(args)
      .callerOptions(options || {});

    // Use allowedStates from options if provided, otherwise default
    const effectiveAllowedStates: SessionStatus[] =
      options?.allowedStates && options.allowedStates.length > 0
        ? options.allowedStates
        : ([
            'pending',
            'initializing',
            'initialized',
            'active',
            'stopped',
          ] as SessionStatus[]);
    builder.allowedStates(effectiveAllowedStates);

    if (cancellationToken) {
      builder.withCancellationToken(cancellationToken);
    }

    try {
      // DAPRequestBuilder.send() now returns the full TResponse
      const response = await builder.send();

      // DAPRequestBuilder's send method already logs success/failure.
      // DAPSessionHandler's sendRequest is now more of a passthrough to the builder
      // for sending, but it's the responsibility of the calling method (e.g., in DebugThread)
      // to interpret the response.success and response.body.

      // If the request itself failed at the builder level (e.g. cancellation, wrong state), it would throw.
      // If the DAP response indicates failure (response.success === false), the builder returns it as is.
      return response;
    } catch (error) {
      // Error already logged by DAPRequestBuilder or protocolClient
      // Re-throw to allow specific handling by the original caller
      if (error instanceof CancellationError) {
        this._logger.info(
          `[DAPSessionHandler.sendRequest] Request "${command}" was cancelled.`,
        );
      } else if (error instanceof DAPRequestError) {
        this._logger.warn(
          `[DAPSessionHandler.sendRequest] Re-throwing DAPRequestError for command '${command}'.`,
          { error },
        );
      } else {
        const genericErrorMessage = `Error sending command '${command}' via DAPSessionHandler`;
        this._logger.error(
          `[DAPSessionHandler.sendRequest] ${genericErrorMessage}.`,
          { error },
        );
        // Ensure we throw an Error instance
        throw error instanceof Error
          ? error
          : new Error(`${genericErrorMessage}: ${String(error)}`);
      }
      throw error;
    }
  }

  // This method is called by StateFetchErrorNotifier
  public _handleNotifyStateFetchError(data: {
    command?: string;
    resourceType: StateFetchErrorResourceType;
    resourceId?: string | number;
    resourceDetails: StateFetchErrorResourceDetails;
    error: Error;
    message?: string;
  }): void {
    const payload: DAPSessionHandlerEvents['stateFetchError'] extends (
      payload: infer P,
    ) => void
      ? P
      : never = {
      sessionId: this.sessionId,
      command: data.command,
      resourceType: data.resourceType,
      resourceId: data.resourceId,
      error: data.error,
      message: data.message ?? data.error.message,
      details: data.resourceDetails,
    };
    this._logger.warn(
      `[DAPSessionHandler._handleNotifyStateFetchError] State fetch error for command '${data.command}', resourceType '${data.resourceType}'.`,
      payload,
    );
    this.emit('stateFetchError', payload);
  }

  // --- End Model Event Handlers ---

  // --- Event Handlers for Stopped, Continued, Thread (from DAP) ---

  private async _onStoppedEvent(
    event: DebugProtocol.StoppedEvent,
  ): Promise<void> {
    const { body } = event;
    this._logger.info(
      `[DAPSessionHandler._onStoppedEvent] Received "stopped" event. Reason: ${body.reason}, Thread ID: ${body.threadId}, All Stopped: ${body.allThreadsStopped}`,
      body,
    );

    // Reset optimistic continue flags as a "stopped" event supersedes any optimistic "continued" state.
    this._optimisticallyContinuedAll = false;
    this._optimisticallyContinuedThreadId = undefined;

    if (typeof body.threadId !== 'number') {
      this._logger.error(
        '[DAPSessionHandler._onStoppedEvent] "stopped" event received without a valid threadId. Aborting event processing.',
        body,
      );
      return;
    }

    this._currentStoppedThreadId = body.threadId;

    try {
      const threadsResponse =
        await this._protocolClient.sendRequest<DebugProtocol.ThreadsResponse>(
          'threads',
          {},
        );
      if (
        threadsResponse.success &&
        threadsResponse.body &&
        threadsResponse.body.threads
      ) {
        this._updateThreadsFromAdapterResponse(threadsResponse.body.threads);
      } else {
        this._logger.error(
          '[DAPSessionHandler._onStoppedEvent] "threads" request failed or returned invalid body.',
          threadsResponse,
        );
        new StateFetchErrorNotifier(this)
          .command('threads')
          .resourceType('threads')
          .resourceId(body.threadId)
          .details({ threadId: body.threadId })
          .error(
            new Error(
              threadsResponse.message ||
                'Failed to fetch threads during stopped event',
            ),
          )
          .message(threadsResponse.message)
          .notify();
      }
    } catch (error) {
      this._logger.error(
        '[DAPSessionHandler._onStoppedEvent] Error sending "threads" request.',
        error,
      );
      const err = error instanceof Error ? error : new Error(String(error));
      new StateFetchErrorNotifier(this)
        .command('threads')
        .resourceType('threads')
        .resourceId(body.threadId)
        .details({ threadId: body.threadId })
        .error(err)
        .message(err.message)
        .notify();
    }

    const primaryThread = this._threads.get(body.threadId);
    if (primaryThread) {
      // primaryThread.stoppedDetails = body; // This is now handled by primaryThread.updateStoppedState via its event
      primaryThread.updateStoppedState(true, body); // This will emit 'stoppedStateChanged'
      // primaryThread.clearCallStack(); // This is handled by fetchCallStack or if stoppedStateChanged implies it
      this._logger.info(
        `[DAPSessionHandler._onStoppedEvent] Fetching call stack for primary stopped thread ${body.threadId}.`,
      );
      // The fetchCallStack will now trigger 'callStackRefreshed' or 'callStackFetchFailed'
      // which are handled by _handleThreadCallStackRefreshed/_handleThreadCallStackFetchFailed.
      primaryThread.fetchCallStack().catch((e) => {
        this._logger.error(
          `[DAPSessionHandler._onStoppedEvent] Error during primaryThread.fetchCallStack() for thread ${body.threadId}. This should have been handled by the thread itself.`,
          e,
        );
      });
    } else {
      this._logger.error(
        `[DAPSessionHandler._onStoppedEvent] Primary stopped thread ${body.threadId} not found in _threads map after "threads" update. This is unexpected.`,
      );
    }

    if (body.allThreadsStopped) {
      this._logger.info(
        '[DAPSessionHandler._onStoppedEvent] All threads stopped. Updating state and clearing call stacks for other threads.',
      );
      this._threads.forEach((thread) => {
        thread.updateStoppedState(
          true,
          thread.id === body.threadId ? body : undefined,
        ); // Mark all as stopped
        if (thread.id !== body.threadId) {
          thread.clearCallStack(); // This will emit 'callStackRefreshed' with empty for other threads
        }
      });
    }

    const stoppedEventPayload: DAPSessionHandlerEvents['stopped'] extends (
      payload: infer P,
    ) => void
      ? P
      : never = {
      sessionId: this.sessionId,
      threadId: body.threadId,
      reason: body.reason,
      allThreadsStopped: body.allThreadsStopped,
      description: body.description,
      text: body.text,
      hitBreakpointIds: body.hitBreakpointIds,
    };
    this.emit('stopped', stoppedEventPayload);
  }

  private _onContinuedEvent(event: DebugProtocol.ContinuedEvent): void {
    const { body } = event;
    this._logger.info(
      `[DAPSessionHandler._onContinuedEvent] Received "continued" event. Thread ID: ${body.threadId}, All Continued: ${body.allThreadsContinued}`,
      body,
    );

    const continuedThreadId = body.threadId;
    const allContinuedByEvent = !!body.allThreadsContinued;

    // Cancel pending operations for the continued thread(s)
    if (allContinuedByEvent) {
      this._logger.info(
        '[DAPSessionHandler._onContinuedEvent] Cancelling all operations due to all threads continued.',
      );
      this.cancelAllOperations();
    } else if (continuedThreadId !== undefined) {
      this._logger.info(
        `[DAPSessionHandler._onContinuedEvent] Cancelling operations for thread ${continuedThreadId} due to continued event.`,
      );
      this.cancelOperationsForThread(continuedThreadId);
    }

    // Check if this event matches a recent optimistic update
    if (this._optimisticallyContinuedAll && allContinuedByEvent) {
      this._logger.info(
        '[DAPSessionHandler._onContinuedEvent] Event confirms optimistic "allThreadsContinued". No further action.',
      );
      this._optimisticallyContinuedAll = false; // Reset flag
      this._optimisticallyContinuedThreadId = undefined;
      return;
    }
    if (
      this._optimisticallyContinuedThreadId === continuedThreadId &&
      !allContinuedByEvent
    ) {
      this._logger.info(
        `[DAPSessionHandler._onContinuedEvent] Event confirms optimistic "continued" for thread ${continuedThreadId}. No further action.`,
      );
      this._optimisticallyContinuedThreadId = undefined; // Reset flag
      return;
    }

    // If not an exact match for an optimistic update, or if no optimistic update was pending, process normally.
    this._logger.info(
      '[DAPSessionHandler._onContinuedEvent] Processing event (not an exact optimistic match or no optimistic pending).',
    );

    if (allContinuedByEvent) {
      this._logger.info(
        '[DAPSessionHandler._onContinuedEvent] All threads continued (as per event). Clearing all call stacks and current stopped ID.',
      );
      this._threads.forEach((thread) => {
        // thread.clearCallStack(); // Handled by updateStoppedState if it implies stack invalidation
        thread.updateStoppedState(false); // Mark as not stopped. This emits 'stoppedStateChanged'.
      });
      this._currentStoppedThreadId = undefined;
    } else if (continuedThreadId !== undefined) {
      const targetThread = this._threads.get(continuedThreadId);
      if (targetThread) {
        // targetThread.clearCallStack(); // Handled by updateStoppedState
        targetThread.updateStoppedState(false); // Mark as not stopped
        this._logger.debug(
          `[DAPSessionHandler._onContinuedEvent] Updated stopped state for continued thread ${continuedThreadId}.`,
        );
        if (this._currentStoppedThreadId === continuedThreadId) {
          this._logger.info(
            `[DAPSessionHandler._onContinuedEvent] Previously stopped thread ${continuedThreadId} continued. Clearing current stopped ID.`,
          );
          this._currentStoppedThreadId = undefined;
        }
      } else {
        this._logger.warn(
          `[DAPSessionHandler._onContinuedEvent] "continued" event for thread ID ${continuedThreadId}, but thread not found in local cache.`,
        );
      }
    } else {
      this._logger.warn(
        '[DAPSessionHandler._onContinuedEvent] "continued" event without allThreadsContinued and without a threadId. This is unusual.',
      );
    }

    // Reset optimistic flags regardless, as this event might be unrelated or supersede a stale optimistic update.
    this._optimisticallyContinuedAll = false;
    this._optimisticallyContinuedThreadId = undefined;

    this.emit('continued', {
      sessionId: this.sessionId,
      threadId: continuedThreadId,
      allThreadsContinued: allContinuedByEvent,
    });
  }

  private _onThreadEvent(event: DebugProtocol.ThreadEvent): void {
    const { body } = event;
    this._logger.info(
      `[DAPSessionHandler._onThreadEvent] Received "thread" event. Reason: ${body.reason}, Thread ID: ${body.threadId}`,
      body,
    );

    if (body.reason === 'started') {
      if (!this._threads.has(body.threadId)) {
        const threadName = `Thread ${body.threadId}`;
        const newThread = new DebugThread(
          body.threadId,
          threadName,
          this,
          this._logger,
        );
        this._attachListenersToThread(newThread); // Attach listeners
        this._threads.set(body.threadId, newThread);
        this._logger.info(
          `[DAPSessionHandler._onThreadEvent] Added new thread ${body.threadId} ('${threadName}') due to "thread" event (started).`,
        );
        this.emit('threadAdded', {
          sessionId: this.sessionId,
          threadId: body.threadId,
          threadName,
        });
      } else {
        this._logger.warn(
          `[DAPSessionHandler._onThreadEvent] Received "thread" event (started) for already existing thread ID ${body.threadId}.`,
        );
      }
    } else if (body.reason === 'exited') {
      this.cancelOperationsForThread(body.threadId); // Cancel requests for the exited thread
      const existingThread = this._threads.get(body.threadId);
      if (existingThread) {
        this._detachListenersFromThread(existingThread); // Detach listeners
        this._threads.delete(body.threadId);
        this._logger.info(
          `[DAPSessionHandler._onThreadEvent] Removed thread ${body.threadId} due to "thread" event (exited).`,
        );
        this.emit('threadRemoved', {
          sessionId: this.sessionId,
          threadId: body.threadId,
          reason: 'exited',
        });

        if (this._currentStoppedThreadId === body.threadId) {
          this._logger.info(
            `[DAPSessionHandler._onThreadEvent] Current stopped thread ${body.threadId} exited. Clearing current stopped ID.`,
          );
          this._currentStoppedThreadId = undefined;
        }
      } else {
        this._logger.warn(
          `[DAPSessionHandler._onThreadEvent] Received "thread" event (exited) for non-existent thread ID ${body.threadId}.`,
        );
      }
    } else {
      this._logger.warn(
        `[DAPSessionHandler._onThreadEvent] Received "thread" event with unknown reason: ${body.reason}`,
      );
    }
  }

  private _updateThreadsFromAdapterResponse(
    adapterThreads: DebugProtocol.Thread[],
  ): void {
    const newThreadIds = new Set(adapterThreads.map((t) => t.id));
    const existingThreadIds = new Set(this._threads.keys());

    adapterThreads.forEach((protocolThread) => {
      const existingThread = this._threads.get(protocolThread.id);
      if (existingThread) {
        if (existingThread.name !== protocolThread.name) {
          this._logger.info(
            `[DAPSessionHandler._updateThreadsFromAdapterResponse] Updating name for thread ${protocolThread.id} from "${existingThread.name}" to "${protocolThread.name}".`,
          );
          existingThread.name = protocolThread.name;
          // Potentially emit a 'threadNameChanged' event if needed
        }
      } else {
        const newThread = new DebugThread(
          protocolThread.id,
          protocolThread.name,
          this,
          this._logger,
        );
        this._attachListenersToThread(newThread); // Attach listeners
        this._threads.set(protocolThread.id, newThread);
        this._logger.info(
          `[DAPSessionHandler._updateThreadsFromAdapterResponse] Added new thread ${protocolThread.id} ('${protocolThread.name}') from adapter response.`,
        );
        this.emit('threadAdded', {
          sessionId: this.sessionId,
          threadId: protocolThread.id,
          threadName: protocolThread.name,
        });
      }
    });

    existingThreadIds.forEach((existingId) => {
      if (!newThreadIds.has(existingId)) {
        const threadToRemove = this._threads.get(existingId);
        if (threadToRemove) {
          this._detachListenersFromThread(threadToRemove); // Detach listeners
          this._threads.delete(existingId);
          this._logger.info(
            `[DAPSessionHandler._updateThreadsFromAdapterResponse] Removed thread ${existingId} as it was not in the adapter's latest thread list.`,
          );
          this.emit('threadRemoved', {
            sessionId: this.sessionId,
            threadId: existingId,
            reason: 'notInThreadsResponseAfterUpdate',
          });
          if (this._currentStoppedThreadId === existingId) {
            this._logger.warn(
              `[DAPSessionHandler._updateThreadsFromAdapterResponse] Current stopped thread ${existingId} was removed after threads refresh.`,
            );
            // _currentStoppedThreadId should be cleared if the active thread is removed.
            // This might be better handled when processing 'stopped' events or if a thread explicitly becomes non-current.
          }
        }
      }
    });
  }
}
