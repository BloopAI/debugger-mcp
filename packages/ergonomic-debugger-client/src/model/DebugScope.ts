/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import * as NodeJS from 'events';
import { DebugProtocol } from '@vscode/debugprotocol';
import type { LoggerInterface } from '../logging';
import { DebugSource } from './DebugSource';
import { DebugVariable } from './DebugVariable';
import type {
  DAPSessionHandlerInterface,
  DebugStackFrameInterface,
} from './model.types';

/**
 * Events emitted by DebugScope.
 */
export interface DebugScopeEvents {
  /** Emitted when all variables for the scope have been successfully fetched and `this.variables` is updated. */
  variablesRefreshed: (variables: DebugVariable[]) => void;
  /** Emitted when a partial/filtered set of variables has been successfully fetched. `this.variables` is NOT updated. */
  partialVariablesFetched: (
    fetchedVariables: DebugVariable[],
    filter?: 'indexed' | 'named',
    start?: number,
    count?: number,
  ) => void;
  /** Emitted when fetching variables fails. */
  fetchFailed: (
    error: Error,
    context: {
      filter?: 'indexed' | 'named';
      start?: number;
      count?: number;
      wasFullFetchAttempt: boolean;
    },
  ) => void;
}

export declare interface DebugScope {
  on<U extends keyof DebugScopeEvents>(
    event: U,
    listener: DebugScopeEvents[U],
  ): this;
  emit<U extends keyof DebugScopeEvents>(
    event: U,
    ...args: Parameters<DebugScopeEvents[U]>
  ): boolean;
}

export class DebugScope extends NodeJS.EventEmitter {
  public readonly name: string;
  public readonly variablesReference: number;
  public readonly expensive: boolean;
  public readonly namedVariables?: number;
  public readonly indexedVariables?: number;
  public readonly source?: DebugSource;
  public readonly line?: number;
  public readonly column?: number;
  public readonly endLine?: number;
  public readonly endColumn?: number;
  public readonly presentationHint?: DebugProtocol.Scope['presentationHint'];

  public variables: DebugVariable[] = [];
  private _fetchPromises: Map<string, Promise<DebugVariable[]>> = new Map();
  private _lastVariablesError?: Error;

  constructor(
    private readonly scopeData: DebugProtocol.Scope,
    public readonly frame: DebugStackFrameInterface, // From model.types
    private readonly sessionHandler: DAPSessionHandlerInterface, // From model.types for sendRequest and passing to children
    private readonly logger: LoggerInterface,
  ) {
    super();
    this.name = scopeData.name;
    this.variablesReference = scopeData.variablesReference;
    this.expensive = scopeData.expensive;
    this.namedVariables = scopeData.namedVariables;
    this.indexedVariables = scopeData.indexedVariables;
    this.line = scopeData.line;
    this.column = scopeData.column;
    this.endLine = scopeData.endLine;
    this.endColumn = scopeData.endColumn;
    this.presentationHint = scopeData.presentationHint;

    if (scopeData.source) {
      this.source = new DebugSource(
        scopeData.source,
        this.sessionHandler,
        this.logger,
      );
    }
  }

  public get id(): string {
    return `scope:${this.frame.id}:${this.name}:${this.variablesReference}`;
  }

  private _isFullFetch(
    filter?: 'indexed' | 'named',
    start?: number,
    count?: number,
  ): boolean {
    return !filter && start === undefined && count === undefined;
  }

  public async getVariables(
    filter?: 'indexed' | 'named',
    start?: number,
    count?: number,
  ): Promise<DebugVariable[]> {
    if (this.variablesReference === 0) {
      this.logger.debug(
        `[DebugScope.getVariables] Scope '${this.name}' (ref: ${this.variablesReference}) has no variables or variables cannot be fetched.`,
      );
      return [];
    }

    const promiseKey = JSON.stringify({ filter, start, count });

    if (this._fetchPromises.has(promiseKey)) {
      this.logger.debug(
        `[DebugScope.getVariables] Deduplicating variables fetch for scope '${this.name}' (ref: ${this.variablesReference}) with key: ${promiseKey}`,
      );
      return this._fetchPromises.get(promiseKey)!; // Safe due to .has() check
    }

    this.logger.info(
      `[DebugScope.getVariables] Fetching variables for scope '${this.name}' (ref: ${this.variablesReference}) with key: ${promiseKey}`,
      { filter, start, count },
    );
    this._lastVariablesError = undefined;

    const fetchPromise = this._doFetchVariables(filter, start, count);
    this._fetchPromises.set(promiseKey, fetchPromise);

    try {
      const fetchedVariables = await fetchPromise;
      const isFull = this._isFullFetch(filter, start, count);

      if (isFull) {
        this.variables = fetchedVariables;
        this.logger.info(
          `[DebugScope.getVariables] Successfully fetched and updated all ${fetchedVariables.length} variables for scope '${this.name}' (ref: ${this.variablesReference})`,
        );
        this.emit('variablesRefreshed', this.variables);
      } else {
        this.logger.info(
          `[DebugScope.getVariables] Successfully fetched ${fetchedVariables.length} (partial/filtered) variables for scope '${this.name}' (ref: ${this.variablesReference}). Instance variables not updated.`,
        );
        this.emit(
          'partialVariablesFetched',
          fetchedVariables,
          filter,
          start,
          count,
        );
      }
      return fetchedVariables;
    } catch (error) {
      this.logger.error(
        `[DebugScope.getVariables] Failed to fetch variables for scope '${this.name}' (ref: ${this.variablesReference})`,
        { error },
      );

      const wasFullAttempt = this._isFullFetch(filter, start, count);
      if (wasFullAttempt) {
        const oldVariablesLength = this.variables.length;
        this.variables = []; // Clear internal state on full fetch failure
        if (oldVariablesLength > 0) {
          // 'fetchFailed' event context (wasFullFetchAttempt) allows listeners to know the main list is now implicitly empty.
        }
      }

      let processedError: Error;
      if (error instanceof Error) {
        processedError = error;
      } else {
        processedError = new Error(String(error));
      }
      this._lastVariablesError = processedError;

      this.emit('fetchFailed', processedError, {
        filter,
        start,
        count,
        wasFullFetchAttempt: wasFullAttempt,
      });
      return []; // Return empty array on failure as per previous behavior
    } finally {
      this._fetchPromises.delete(promiseKey);
    }
  }

  private async _doFetchVariables(
    filter?: 'indexed' | 'named',
    start?: number,
    count?: number,
  ): Promise<DebugVariable[]> {
    const args: DebugProtocol.VariablesArguments = {
      variablesReference: this.variablesReference,
      filter,
      start,
      count,
    };

    const response =
      await this.sessionHandler.sendRequest<DebugProtocol.VariablesResponse>(
        'variables',
        args,
        {
          // Variables are typically fetched when stopped.
          allowedStates: ['stopped', 'active'], // 'active' might be needed for logpoints or watch expressions
        },
      );

    if (response && response.body && Array.isArray(response.body.variables)) {
      return response.body.variables.map(
        (v: DebugProtocol.Variable) =>
          new DebugVariable(v, this, this.sessionHandler, this.logger),
      );
    } else {
      this.logger.warn(
        `[DebugScope._doFetchVariables] Received no variables or invalid response for reference: ${this.variablesReference}`,
        { response },
      );
      throw new Error(
        `Failed to retrieve variables for scope reference ${this.variablesReference}. Adapter returned no variables.`,
      );
    }
  }

  /**
   * Invalidates the current variable model for this scope.
   * This clears all fetched variables, cancels ongoing fetches,
   * and notifies listeners that the variables have been "refreshed" to an empty state.
   * It's intended to be called when the debugger signals that variable state is no longer valid.
   */
  public invalidateVariablesModel(): void {
    this.logger.info(
      `[DebugScope.invalidateVariablesModel] Invalidating variables for scope '${this.name}' (ref: ${this.variablesReference})`,
    );

    // Cancel any ongoing fetch promises.
    // This doesn't abort DAP requests already sent but prevents their results from updating state.
    // The `finally` block in getVariables also clears the map.
    this._fetchPromises.forEach((_promise) => {
      // Promises don't have a standard cancel method.
    });
    this._fetchPromises.clear();

    const oldVariablesToDispose = this.variables; // Capture before clearing
    this.variables = [];
    this._lastVariablesError = undefined;

    // Dispose of old variables to clean up their children and listeners
    if (oldVariablesToDispose && oldVariablesToDispose.length > 0) {
      this.logger.trace(
        `[DebugScope.invalidateVariablesModel] Disposing ${oldVariablesToDispose.length} old variables for scope '${this.name}'`,
      );
      oldVariablesToDispose.forEach((variable) => {
        if (typeof variable.dispose === 'function') {
          variable.dispose();
        } else {
          // Should not happen if all variables are DebugVariable instances.
          this.logger.warn(
            `[DebugScope.invalidateVariablesModel] Variable '${variable.name}' in scope '${this.name}' does not have a dispose method.`,
          );
        }
      });
    }

    this.logger.debug(
      `[DebugScope.invalidateVariablesModel] Emitting 'variablesRefreshed' with empty array for scope '${this.name}'`,
    );
    this.emit('variablesRefreshed', []);
  }
}
