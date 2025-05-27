/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import * as NodeJS from 'events';
import { DebugProtocol } from '@vscode/debugprotocol';
import type { LoggerInterface } from '../logging';
import { DebugSource } from './DebugSource';
import { DebugScope, DebugScopeEvents } from './DebugScope';
import type {
  DAPSessionHandlerInterface,
  DebugThreadInterface,
} from './model.types';

/**
 * Events emitted by DebugStackFrame.
 */
export interface DebugStackFrameEvents {
  /** Emitted when all scopes for the stack frame have been successfully fetched and `this.scopes` is updated. */
  scopesRefreshed: (scopes: DebugScope[]) => void;
  /** Emitted when fetching scopes fails. */
  scopesFetchFailed: (error: Error) => void;
  /** Emitted when an expression evaluation completes successfully. */
  evaluationCompleted: (
    responseBody: DebugProtocol.EvaluateResponse['body'],
    expression: string,
    context?: DebugProtocol.EvaluateArguments['context'],
  ) => void;
  /** Emitted when an expression evaluation fails. */
  evaluationFailed: (
    error: Error,
    expression: string,
    context?: DebugProtocol.EvaluateArguments['context'],
  ) => void;
  /** Emitted when a variable fetch within one of this frame's scopes fails. */
  scopeVariableFetchFailed: (
    scope: DebugScope,
    error: Error,
    context: Parameters<DebugScopeEvents['fetchFailed']>[1],
  ) => void;
}

export declare interface DebugStackFrame {
  on<U extends keyof DebugStackFrameEvents>(
    event: U,
    listener: DebugStackFrameEvents[U],
  ): this;
  emit<U extends keyof DebugStackFrameEvents>(
    event: U,
    ...args: Parameters<DebugStackFrameEvents[U]>
  ): boolean;
}

export class DebugStackFrame extends NodeJS.EventEmitter {
  public readonly id: number;
  public readonly name: string;
  public readonly source?: DebugSource;
  public readonly line: number;
  public readonly column: number;
  public readonly endLine?: number;
  public readonly endColumn?: number;
  public readonly presentationHint?: string; // This is DebugProtocol.StackFrame['presentationHint'] which is string | undefined
  public readonly instructionPointerReference?: string;

  public scopes: DebugScope[] = [];
  private _isFetchingScopes: boolean = false;
  private _fetchScopesPromise: Promise<DebugScope[]> | null = null;
  private _lastScopesError?: Error;

  constructor(
    private readonly frameData: DebugProtocol.StackFrame,
    public readonly thread: DebugThreadInterface, // From model.types
    private readonly sessionHandler: DAPSessionHandlerInterface, // From model.types for sendRequest and passing to children
    private readonly logger: LoggerInterface,
  ) {
    super();
    this.id = frameData.id;
    this.name = frameData.name;
    this.line = frameData.line;
    this.column = frameData.column;
    this.endLine = frameData.endLine;
    this.endColumn = frameData.endColumn;
    this.presentationHint = frameData.presentationHint;
    this.instructionPointerReference = frameData.instructionPointerReference;

    if (frameData.source) {
      this.source = new DebugSource(
        frameData.source,
        this.sessionHandler,
        this.logger,
      );
    }
  }

  public async getScopes(): Promise<DebugScope[]> {
    if (this._isFetchingScopes && this._fetchScopesPromise) {
      this.logger.debug(
        `[DebugStackFrame.getScopes] Deduplicating scopes fetch for frame ID: ${this.id}`,
      );
      return this._fetchScopesPromise;
    }

    this.logger.info(
      `[DebugStackFrame.getScopes] Fetching scopes for frame ID: ${this.id}`,
    );
    this._isFetchingScopes = true;
    this._lastScopesError = undefined;
    this._fetchScopesPromise = this._doFetchScopes();

    try {
      const fetchedScopes = await this._fetchScopesPromise;
      this.scopes = fetchedScopes;
      // Remove previous listeners before adding new ones
      this.scopes.forEach((scope) => scope.removeAllListeners('fetchFailed'));
      // Add listeners to new scopes
      this.scopes.forEach((scope) => {
        scope.on('fetchFailed', (err, fetchContext) => {
          this.logger.warn(
            `[DebugStackFrame] Variable fetch failed in scope '${scope.name}' (ref: ${scope.variablesReference}) for frame ID ${this.id}`,
            { error: err, fetchContext },
          );
          this.emit('scopeVariableFetchFailed', scope, err, fetchContext);
        });
      });

      this.logger.info(
        `[DebugStackFrame.getScopes] Successfully fetched ${this.scopes.length} scopes for frame ID: ${this.id}`,
      );
      this.emit('scopesRefreshed', this.scopes);
      return this.scopes;
    } catch (error) {
      this.logger.error(
        `[DebugStackFrame.getScopes] Failed to fetch scopes for frame ID: ${this.id}`,
        { error },
      );
      this.scopes = []; // Clear internal state on failure

      let processedError: Error;
      if (error instanceof Error) {
        processedError = error;
      } else {
        processedError = new Error(String(error));
      }
      this._lastScopesError = processedError;
      this.emit('scopesFetchFailed', processedError);
      return [];
    } finally {
      this._isFetchingScopes = false;
      this._fetchScopesPromise = null;
    }
  }

  private async _doFetchScopes(): Promise<DebugScope[]> {
    const args: DebugProtocol.ScopesArguments = {
      frameId: this.id,
    };

    const response =
      await this.sessionHandler.sendRequest<DebugProtocol.ScopesResponse>(
        'scopes',
        args,
        {
          // Scopes are typically fetched when stopped.
          allowedStates: ['stopped', 'active'], // 'active' might be needed if pre-fetching or for some adapters
        },
      );

    if (response && response.body && Array.isArray(response.body.scopes)) {
      // Detach listeners from old scopes if any to prevent memory leaks
      this.scopes.forEach((s) => s.removeAllListeners());

      return response.body.scopes.map((s: DebugProtocol.Scope) => {
        const newScope = new DebugScope(
          s,
          this,
          this.sessionHandler,
          this.logger,
        );
        // Listen for variable fetch failures within this new scope
        newScope.on('fetchFailed', (err, context) => {
          this.logger.warn(
            `[DebugStackFrame] Variable fetch failed in scope '${newScope.name}' (ref: ${newScope.variablesReference}) for frame ID ${this.id}`,
            { error: err, context },
          );
          this.emit('scopeVariableFetchFailed', newScope, err, context);
        });
        // Potentially listen to 'variablesRefreshed' or 'partialVariablesFetched' if DebugStackFrame needs to react
        return newScope;
      });
    } else {
      this.logger.warn(
        `[DebugStackFrame._doFetchScopes] Received no scopes or invalid response for frame ID: ${this.id}`,
        { response },
      );
      throw new Error(
        `Failed to retrieve scopes for frame ID ${this.id}. Adapter returned no scopes.`,
      );
    }
  }

  public async evaluate(
    expression: string,
    context?: DebugProtocol.EvaluateArguments['context'], // Use type from DebugProtocol
    format?: DebugProtocol.ValueFormat,
  ): Promise<DebugProtocol.EvaluateResponse['body'] | undefined> {
    this.logger.info(
      `[DebugStackFrame.evaluate] Evaluating expression in frame ID ${this.id}: "${expression}"`,
      { context, format },
    );
    const args: DebugProtocol.EvaluateArguments = {
      expression,
      frameId: this.id,
      context,
      format,
    };

    try {
      const response =
        await this.sessionHandler.sendRequest<DebugProtocol.EvaluateResponse>(
          'evaluate',
          args,
        );
      if (response && response.body) {
        this.logger.info(
          `[DebugStackFrame.evaluate] Successfully evaluated expression: "${expression}". Result: ${response.body.result}`,
        );
        this.emit('evaluationCompleted', response.body, expression, context);
        return response.body;
      } else {
        this.logger.warn(
          `[DebugStackFrame.evaluate] Evaluate request for expression "${expression}" returned no body or invalid response.`,
        );
        return undefined;
      }
    } catch (error) {
      this.logger.error(
        `[DebugStackFrame.evaluate] Failed to evaluate expression "${expression}" in frame ID ${this.id}`,
        { error },
      );
      let processedError: Error;
      if (error instanceof Error) {
        processedError = error;
      } else {
        processedError = new Error(String(error));
      }
      this.emit('evaluationFailed', processedError, expression, context);
      throw processedError; // Re-throw to allow caller to handle
    }
  }
}
