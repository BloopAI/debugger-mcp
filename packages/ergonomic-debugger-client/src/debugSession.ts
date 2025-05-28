/**
 * @file Debug Session
 *
 * This file provides a high-level API for managing debug sessions.
 * It wraps the DAPSessionHandler to provide a more ergonomic interface
 * for common debugging operations.
 *
 * @module ergonomic-debugger-client/debugSession
 */

import { randomUUID } from 'crypto';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DAPSessionHandler } from './dapSessionHandler';
import { LoggerInterface } from './logging';
import { SessionStatus } from './dapSessionHandler';

/**
 * Configuration for a breakpoint
 */
export interface BreakpointConfig {
  /**
   * The path to the file
   */
  filePath: string;

  /**
   * The line number
   */
  line: number;

  /**
   * Optional condition for the breakpoint
   */
  condition?: string;

  /**
   * Optional hit condition for the breakpoint
   */
  hitCondition?: string;

  /**
   * Optional log message for the breakpoint
   */
  logMessage?: string;

  /**
   * Optional client-side ID of another breakpoint that, when hit, should trigger the activation of this breakpoint.
   */
  triggeredByBreakpointId?: string;
}

/**
 * Result of setting a breakpoint
 */
export interface BreakpointResult {
  /**
   * The ID of the breakpoint, generated client-side.
   */
  id: string;

  /**
   * Whether the breakpoint was verified by the debug adapter.
   */
  verified: boolean;

  /**
   * The actual line number of the breakpoint, as reported by the debug adapter.
   * This may differ from the requested line.
   */
  line: number;

  /**
   * Optional message from the debug adapter about the breakpoint.
   */
  message?: string;
}

/**
 * Represents a breakpoint managed by the DebugSession.
 */
export interface Breakpoint extends BreakpointResult {
  /**
   * The path to the file where the breakpoint is set.
   */
  filePath: string;

  /**
   * Optional condition for the breakpoint.
   */
  condition?: string;

  /**
   * Optional hit condition for the breakpoint.
   */
  hitCondition?: string;

  /**
   * Optional log message for the breakpoint.
   */
  logMessage?: string;

  /**
   * Optional client-side ID of another breakpoint that, when hit, should trigger the activation of this breakpoint.
   */
  triggeredByBreakpointId?: string;

  /**
   * Whether this breakpoint is currently active (i.e., it has been sent to the debug adapter
   * or is intended to be active). Dependent breakpoints might be initially `false`.
   */
  isEnabled: boolean;

  /**
   * The ID assigned by the debug adapter for this breakpoint, if set and verified.
   * This is used to correlate with events like 'stopped' which report hit breakpoints by adapter ID.
   */
  adapterId?: number;
}

/**
 * Result of evaluating an expression
 */
export interface EvaluationResult {
  /**
   * The result of the evaluation as a string.
   */
  result: string;

  /**
   * The type of the result, if available.
   */
  type?: string;

  /**
   * If the result has children (e.g., it's an object or array), this is a reference
   * to fetch those children variables. A value of 0 means no children.
   */
  variablesReference?: number;

  /**
   * The number of named child variables, if the result is structured.
   */
  namedVariables?: number;

  /**
   * The number of indexed child variables, if the result is structured (e.g., an array).
   */
  indexedVariables?: number;
}

/**
 * Builder for creating breakpoint configurations
 */
export class BreakpointConfigBuilder {
  private config: BreakpointConfig;

  /**
   * Creates a new BreakpointConfigBuilder
   *
   * @param filePath The path to the file
   * @param line The line number
   */
  constructor(filePath: string, line: number) {
    this.config = {
      filePath,
      line,
    };
  }

  /**
   * Sets the condition for the breakpoint
   *
   * @param condition The condition
   * @returns The builder instance for chaining
   */
  withCondition(condition: string): BreakpointConfigBuilder {
    this.config.condition = condition;
    return this;
  }

  /**
   * Sets the hit condition for the breakpoint
   *
   * @param hitCondition The hit condition
   * @returns The builder instance for chaining
   */
  withHitCondition(hitCondition: string): BreakpointConfigBuilder {
    this.config.hitCondition = hitCondition;
    return this;
  }

  /**
   * Sets the log message for the breakpoint
   *
   * @param logMessage The log message
   * @returns The builder instance for chaining
   */
  withLogMessage(logMessage: string): BreakpointConfigBuilder {
    this.config.logMessage = logMessage;
    return this;
  }

  /**
   * Specifies that this breakpoint should be triggered by another breakpoint.
   * The breakpoint will be initially disabled and only enabled (and sent to the adapter)
   * when the `breakpointId` specified here is hit.
   *
   * @param breakpointId The client-side ID of the breakpoint that should trigger this one.
   * @returns The builder instance for chaining.
   */
  isTriggeredBy(breakpointId: string): BreakpointConfigBuilder {
    this.config.triggeredByBreakpointId = breakpointId;
    return this;
  }

  /**
   * Builds the breakpoint configuration
   *
   * @returns The breakpoint configuration
   */
  build(): BreakpointConfig {
    return { ...this.config };
  }
}

/**
 * Error thrown when a debug session operation fails
 */
export class DebugSessionError extends Error {
  /**
   * Creates a new DebugSessionError
   *
   * @param message The error message
   * @param cause The cause of the error
   */
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'DebugSessionError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DebugSessionError);
    }
  }
}

/**
 * Error thrown when a breakpoint operation fails
 */
export class BreakpointError extends DebugSessionError {
  /**
   * Creates a new BreakpointError
   *
   * @param message The error message
   * @param filePath The file path
   * @param line The line number
   * @param cause The cause of the error
   */
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly line: number,
    cause?: Error,
  ) {
    super(`Breakpoint error at ${filePath}:${line}: ${message}`, cause);
    this.name = 'BreakpointError';
  }
}

/**
 * Error thrown when an evaluation operation fails
 */
export class EvaluationError extends DebugSessionError {
  /**
   * Creates a new EvaluationError
   *
   * @param message The error message
   * @param expression The expression that failed to evaluate
   * @param cause The cause of the error
   */
  constructor(
    message: string,
    public readonly expression: string,
    cause?: Error,
  ) {
    super(`Evaluation error for '${expression}': ${message}`, cause);
    this.name = 'EvaluationError';
  }
}

/**
 * Error thrown when an operation is attempted in an invalid state
 */
export class InvalidStateError extends DebugSessionError {
  /**
   * Creates a new InvalidStateError
   *
   * @param message The error message
   * @param currentState The current state
   * @param expectedStates The expected states
   */
  constructor(
    message: string,
    public readonly currentState: SessionStatus,
    public readonly expectedStates: SessionStatus[],
  ) {
    super(
      `Invalid state: ${message}. Current state: ${currentState}, expected one of: ${expectedStates.join(', ')}`,
    );
    this.name = 'InvalidStateError';
  }
}

/**
 * Listener for session state changes
 */
export type StateChangeListener = (
  sessionId: string,
  newState: SessionStatus,
  oldState: SessionStatus,
) => void;

/**
 * High-level debug session class
 *
 * This class provides a more ergonomic interface for common debugging operations
 * by wrapping the DAPSessionHandler. It maintains some client-side state, such as
 * a list of breakpoints, and provides methods to interact with the debug target.
 */
export class DebugSession {
  /**
   * The unique ID of this DebugSession instance, generated client-side.
   */
  readonly id: string;

  /**
   * Informational type of the debug target (e.g., 'node', 'python'),
   * as provided during session creation.
   */
  readonly targetType: string;

  /**
   * Informational path of the debug target (e.g., path to the main script),
   * as provided during session creation.
   */
  readonly targetPath: string;

  private _breakpoints: Map<string, Breakpoint[]> = new Map();
  private _stateListeners: StateChangeListener[] = [];
  private _startTime: Date = new Date();
  private _currentThreadId?: number;
  private readonly _logger: LoggerInterface;
  private _activatingDependentBreakpointsPromise: Promise<void> | null = null;

  /**
   * Creates a new DebugSession.
   *
   * @param targetType Informational type of the debug target (e.g., 'node', 'python').
   * @param targetPath Informational path of the debug target (e.g., path to main script).
   * @param sessionHandler The underlying DAPSessionHandler instance that manages protocol communication.
   * @param logger The logger instance to use for this session.
   */
  constructor(
    targetType: string,
    targetPath: string,
    private readonly _sessionHandler: DAPSessionHandler,
    logger: LoggerInterface,
  ) {
    this.id = randomUUID();
    this.targetType = targetType;
    this.targetPath = targetPath;
    this._logger = logger.child
      ? logger.child({ className: 'DebugSession', sessionId: this.id })
      : logger;
    this._setupEventListeners();

    this._logger.info(
      `Debug session created for ${targetType} target: ${targetPath}`,
    );
  }

  /**
   * Gets the current state of the debug session, reflecting the underlying DAPSessionHandler's status.
   */
  get state(): SessionStatus {
    return this._sessionHandler.status;
  }

  /**
   * Gets the start time of the debug session.
   */
  get startTime(): Date {
    return this._startTime;
  }

  /**
   * Gets the current thread ID if the session is stopped on a specific thread.
   * Returns `undefined` if the session is not stopped or if stopped globally without a specific thread focus.
   */
  get currentThreadId(): number | undefined {
    return this._currentThreadId;
  }

  /**
   * Gets all breakpoints currently managed by this session, across all files.
   * This reflects the client-side cache of breakpoints.
   */
  get breakpoints(): Breakpoint[] {
    const allBreakpoints: Breakpoint[] = [];
    for (const fileBreakpoints of this._breakpoints.values()) {
      allBreakpoints.push(...fileBreakpoints);
    }
    return allBreakpoints;
  }

  /**
   * Gets breakpoints for a specific file path.
   *
   * @param filePath The path to the file.
   * @returns An array of breakpoints for the specified file, or an empty array if none exist.
   */
  getBreakpointsForFile(filePath: string): Breakpoint[] {
    return this._breakpoints.get(filePath) || [];
  }

  /**
   * Adds a listener for state changes in this debug session.
   *
   * @param listener The listener function to be called when the session state changes.
   */
  onStateChanged(listener: StateChangeListener): void {
    this._stateListeners.push(listener);
  }

  /**
   * Sets a breakpoint in the debug session.
   * This involves sending a `setBreakpoints` request to the debug adapter
   * and updating the internal cache of breakpoints.
   *
   * @param config The breakpoint configuration.
   * @returns A promise that resolves to the breakpoint result, including its client-side ID and verification status.
   * @throws BreakpointError if the breakpoint cannot be set or if the adapter returns an error.
   */
  async setBreakpoint(config: BreakpointConfig): Promise<BreakpointResult> {
    this._logger.debug(
      `Setting breakpoint at ${config.filePath}:${config.line}`,
      { config },
    );

    try {
      if (!config.filePath) {
        throw new BreakpointError(
          'File path is required',
          config.filePath,
          config.line,
        );
      }
      if (config.line <= 0) {
        throw new BreakpointError(
          'Line number must be positive',
          config.filePath,
          config.line,
        );
      }

      const isInitiallyEnabled = !config.triggeredByBreakpointId;
      const dapSourceBreakpointsToSend: DebugProtocol.SourceBreakpoint[] = [];

      if (isInitiallyEnabled) {
        dapSourceBreakpointsToSend.push({
          line: config.line,
          condition: config.condition,
          hitCondition: config.hitCondition,
          logMessage: config.logMessage,
        });
      }

      let dapBreakpointResponse: DebugProtocol.Breakpoint | undefined;
      if (isInitiallyEnabled && dapSourceBreakpointsToSend.length > 0) {
        const breakpointRequest: DebugProtocol.SetBreakpointsArguments = {
          source: { path: config.filePath },
          breakpoints: dapSourceBreakpointsToSend,
        };
        const response =
          await this._sessionHandler.setBreakpoints(breakpointRequest);

        if (!response.body || !Array.isArray(response.body.breakpoints)) {
          this._logger.warn(
            'SetBreakpoints response from adapter did not contain a valid breakpoints array.',
            { responseBody: response.body },
          );
          if (dapSourceBreakpointsToSend.length > 0) {
            throw new BreakpointError(
              'Adapter returned an invalid or missing breakpoints array in response',
              config.filePath,
              config.line,
            );
          }
          // If dapSourceBreakpointsToSend was empty (e.g. dependent BP initially), and adapter returns invalid, it's not an error for *this* call.
        } else if (
          response.body.breakpoints.length === 0 &&
          dapSourceBreakpointsToSend.length > 0
        ) {
          // We sent a breakpoint to be set, but the adapter returned an empty list.
          // This implies the breakpoint was not set/verified by the adapter.
          this._logger.warn(
            `SetBreakpoints response for ${config.filePath}:${config.line} returned an empty breakpoints array. This may indicate an adapter issue.`,
            { responseBody: response.body },
          );
          throw new BreakpointError(
            'Adapter returned no breakpoints in response, indicating it was not set.',
            config.filePath,
            config.line,
          );
        } else if (
          response.body.breakpoints.length > 0 &&
          dapSourceBreakpointsToSend.length > 0
        ) {
          // We sent one, and got at least one back. Try to find the one matching our requested line.
          // This is more robust than just taking [0] if the adapter *could* return multiple.
          dapBreakpointResponse = response.body.breakpoints.find(
            (bp) => bp.line === config.line,
          );
          if (
            !dapBreakpointResponse &&
            response.body.breakpoints.length === 1
          ) {
            // If not found by line but only one was returned, assume it's ours.
            // The line number might have been adjusted by the adapter.
            dapBreakpointResponse = response.body.breakpoints[0];
            this._logger.debug(
              `Breakpoint for ${config.filePath}:${config.line} matched by single response item, adapter line: ${dapBreakpointResponse.line}`,
              { dapBreakpointResponse },
            );
          } else if (!dapBreakpointResponse) {
            // Multiple returned, none match our exact line. This is ambiguous.
            // For now, log and take the first one as a best guess, but this highlights the need for better multi-BP handling.
            dapBreakpointResponse = response.body.breakpoints[0];
            this._logger.warn(
              `Could not find exact line match for ${config.filePath}:${config.line} in SetBreakpoints response. Using first returned breakpoint. Line may have been adjusted.`,
              { dapBreakpointResponse, requestedLine: config.line },
            );
          }
        }
      }

      const breakpointId = randomUUID();
      const breakpoint: Breakpoint = {
        id: breakpointId,
        filePath: config.filePath,
        line: dapBreakpointResponse?.line || config.line,
        verified: dapBreakpointResponse?.verified || false,
        message: dapBreakpointResponse?.message,
        adapterId: dapBreakpointResponse?.id, // Store adapter-generated ID
        condition: config.condition,
        hitCondition: config.hitCondition,
        logMessage: config.logMessage,
        triggeredByBreakpointId: config.triggeredByBreakpointId,
        isEnabled: isInitiallyEnabled,
      };

      // Store the breakpoint in the client-side cache
      const fileBreakpoints = this._breakpoints.get(config.filePath) || [];
      fileBreakpoints.push(breakpoint);
      this._breakpoints.set(config.filePath, fileBreakpoints);

      this._logger.info(
        `Breakpoint registered client-side at ${breakpoint.filePath}:${breakpoint.line}`,
        {
          breakpointId,
          verified: breakpoint.verified,
          isEnabled: breakpoint.isEnabled,
        },
      );

      return {
        id: breakpointId,
        verified: breakpoint.verified,
        line: breakpoint.line,
        message: breakpoint.message,
      };
    } catch (error) {
      if (error instanceof BreakpointError) throw error;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this._logger.error(
        `Failed to set breakpoint at ${config.filePath}:${config.line}`,
        { error },
      );
      throw new BreakpointError(
        errorMessage,
        config.filePath,
        config.line,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Sets a breakpoint in the debug session using a builder.
   *
   * @param builder The breakpoint configuration builder.
   * @returns A promise that resolves to the breakpoint result.
   * @throws BreakpointError if the breakpoint cannot be set.
   */
  async setBreakpointWithBuilder(
    builder: BreakpointConfigBuilder,
  ): Promise<BreakpointResult> {
    return this.setBreakpoint(builder.build());
  }

  /**
   * Removes a breakpoint from the debug session.
   * This updates the local cache and attempts to update the debug adapter by
   * resending all remaining breakpoints for the affected file.
   *
   * @param breakpointId The client-side ID of the breakpoint to remove.
   * @returns A promise that resolves to true if the breakpoint was found and removed locally.
   *          Note: This is true even if the subsequent adapter update fails (an error will be logged in that case).
   *          Returns false if the breakpointId was not found in the local cache.
   * @throws DebugSessionError if an unexpected error occurs during local cache update.
   */
  async removeBreakpoint(breakpointId: string): Promise<boolean> {
    this._logger.debug(`Removing breakpoint with ID: ${breakpointId}`);
    let filePathToRemoveFrom: string | null = null;
    let foundAndRemoved = false;
    let removedBreakpointDetails: Breakpoint | undefined;

    try {
      // Find the breakpoint in the local cache
      for (const [filePath, breakpoints] of this._breakpoints.entries()) {
        const index = breakpoints.findIndex((bp) => bp.id === breakpointId);
        if (index !== -1) {
          removedBreakpointDetails = breakpoints[index]; // Capture details before removal
          breakpoints.splice(index, 1);
          if (breakpoints.length === 0) {
            this._breakpoints.delete(filePath);
            this._logger.debug(
              `Removed last breakpoint for file ${filePath}, deleting entry from map.`,
            );
          }
          filePathToRemoveFrom = filePath;
          foundAndRemoved = true;
          break;
        }
      }

      if (!foundAndRemoved) {
        this._logger.warn(
          `Breakpoint with ID ${breakpointId} not found for removal.`,
        );
        return false;
      }

      if (filePathToRemoveFrom) {
        const remainingEnabledBreakpointsInFile = (
          this._breakpoints.get(filePathToRemoveFrom) || []
        )
          .filter((bp) => bp.isEnabled)
          .map(
            (bp) =>
              ({
                line: bp.line,
                condition: bp.condition,
                hitCondition: bp.hitCondition,
                logMessage: bp.logMessage,
              }) as DebugProtocol.SourceBreakpoint,
          );

        try {
          this._logger.debug(
            `Updating breakpoints for file ${filePathToRemoveFrom} after removal. Sending ${remainingEnabledBreakpointsInFile.length} breakpoints.`,
          );
          await this.sessionHandler.setBreakpoints({
            source: { path: filePathToRemoveFrom },
            breakpoints: remainingEnabledBreakpointsInFile,
          });
          this._logger.info(
            `Successfully updated breakpoints for ${filePathToRemoveFrom} after removing ${breakpointId}.`,
          );
        } catch (error) {
          const errorObj =
            error instanceof Error ? error : new Error(String(error));
          const removedBpInfo = removedBreakpointDetails
            ? {
                filePath: removedBreakpointDetails.filePath,
                line: removedBreakpointDetails.line,
                id: removedBreakpointDetails.id,
                adapterId: removedBreakpointDetails.adapterId,
              }
            : { id: breakpointId };
          this._logger.error(
            // Changed to error as this is a significant state divergence
            `CRITICAL: Breakpoint ${breakpointId} (details: ${JSON.stringify(removedBpInfo)}) was removed from client cache, but FAILED to update debug adapter for file ${filePathToRemoveFrom}. Breakpoint state is now INCONSISTENT between client and adapter.`,
            {
              error: errorObj.message,
              errorDetails: errorObj,
              fileToUpdate: filePathToRemoveFrom,
              remainingBreakpointsSentToAdapter:
                remainingEnabledBreakpointsInFile.length,
              removedBreakpointInfo: removedBpInfo,
            },
          );
          // Local removal was successful. The method should still return true even if adapter update fails.
        }
      }
      return true;
    } catch (error) {
      // This catch is for unexpected errors during the find/local removal phase.
      // Errors from sessionHandler.setBreakpoints are caught and logged by the inner try-catch.
      const errorObj =
        error instanceof Error ? error : new Error(String(error));
      this._logger.error(
        `Unexpected error during breakpoint removal for ID ${breakpointId}: ${errorObj.message}`,
        { error: errorObj },
      );
      throw new DebugSessionError(
        `Failed to remove breakpoint: ${errorObj.message}`,
        errorObj,
      );
    }
  }

  /**
   * Evaluates an expression in the debug session.
   * Requires the session to be in an 'active', 'initialized', or 'stopped' state.
   * If `frameId` is not provided, it attempts to default to the top frame of the `currentThreadId`.
   *
   * @param expression The expression to evaluate.
   * @param frameId Optional ID of the stack frame in which to evaluate the expression.
   *                If not provided, defaults to the top frame of the current thread.
   * @param context The context in which the expression is evaluated (e.g., 'watch', 'repl', 'hover'). Defaults to 'repl'.
   * @returns A promise that resolves to the evaluation result.
   * @throws EvaluationError if the expression cannot be evaluated or adapter returns an error.
   * @throws InvalidStateError if the session is not in a state where evaluation is possible.
   */
  async evaluateExpression(
    expression: string,
    frameId?: number,
    context: 'watch' | 'repl' | 'hover' | string = 'repl',
  ): Promise<EvaluationResult> {
    const operationName = 'evaluateExpression';
    this._ensureActiveState(operationName);

    let internalFrameId: number;

    if (frameId !== undefined) {
      internalFrameId = frameId;
    } else {
      this._logger.debug(
        `frameId not provided for evaluateExpression, attempting to default for expression: "${expression}".`,
      );
      if (this.currentThreadId === undefined) {
        this._logger.warn(
          `Cannot default frameId for "${expression}": currentThreadId is undefined.`,
        );
        throw new EvaluationError(
          'frameId is required and could not be defaulted (no current thread).',
          expression,
        );
      }
      try {
        this._logger.debug(
          `Attempting to fetch call stack for thread ${this.currentThreadId} to default frameId for "${expression}".`,
        );
        const callStack = await this.getCallStack(this.currentThreadId);
        if (callStack.length === 0) {
          this._logger.warn(
            `Cannot default frameId for "${expression}": call stack for thread ${this.currentThreadId} is empty.`,
          );
          throw new EvaluationError(
            'frameId is required and could not be defaulted (empty call stack).',
            expression,
          );
        }
        internalFrameId = callStack[0].id;
        this._logger.info(
          `Defaulted frameId to ${internalFrameId} from top of call stack for thread ${this.currentThreadId} for expression "${expression}".`,
        );
      } catch (error) {
        const baseLogMessage = `Cannot default frameId for "${expression}": error getting call stack for thread ${this.currentThreadId}`;
        const baseExceptionMessage =
          'frameId is required and could not be defaulted (error retrieving call stack';
        let detailMessage = 'an unknown error occurred';
        let exceptionCause: Error | undefined = undefined;

        if (
          error instanceof DebugSessionError &&
          error.cause instanceof Error
        ) {
          detailMessage = error.cause.message;
          exceptionCause = error.cause;
        } else if (error instanceof Error) {
          detailMessage = error.message;
          exceptionCause = error;
        } else {
          detailMessage = String(error);
        }

        this._logger.warn(`${baseLogMessage}: ${detailMessage}`, { error });
        throw new EvaluationError(
          `${baseExceptionMessage}: ${detailMessage})`,
          expression,
          exceptionCause,
        );
      }
    }

    this._logger.debug(
      `Evaluating expression: "${expression}" in frame ${internalFrameId}`,
      { context },
    );
    try {
      const response = await this.sessionHandler.evaluate({
        expression,
        frameId: internalFrameId,
        context,
      });
      if (!response.body) {
        this._logger.warn(`Evaluation of "${expression}" returned no body.`, {
          response,
        });
        throw new EvaluationError('Adapter returned no result', expression);
      }
      this._logger.info(
        `Expression "${expression}" evaluated successfully in frame ${internalFrameId}. Result: ${response.body.result}`,
      );
      return {
        result: response.body.result,
        type: response.body.type,
        variablesReference: response.body.variablesReference,
        namedVariables: response.body.namedVariables,
        indexedVariables: response.body.indexedVariables,
      };
    } catch (error) {
      if (error instanceof EvaluationError) throw error;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this._logger.error(
        `Failed to evaluate expression "${expression}" in frame ${internalFrameId}: ${errorMessage}`,
        { error },
      );
      throw new EvaluationError(
        errorMessage,
        expression,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Retrieves child variables for a given variables reference.
   * Requires the session to be in an 'active', 'initialized', or 'stopped' state.
   *
   * @param reference The `variablesReference` obtained from a `StackFrame`, `Scope`, or a parent `Variable`.
   * @returns A promise that resolves to an array of raw DAP `Variable` objects.
   * @throws DebugSessionError if fetching variables fails or the adapter returns an error.
   * @throws InvalidStateError if the session is not in a valid state.
   */
  async getVariables(reference: number): Promise<DebugProtocol.Variable[]> {
    const operationName = 'getVariables';
    this._ensureActiveState(operationName);
    this._logger.debug(`Fetching raw variables for reference: ${reference}`);
    try {
      const response =
        await this.sessionHandler.sendRequest<DebugProtocol.VariablesResponse>(
          'variables',
          { variablesReference: reference },
        );
      if (
        !response.success ||
        !response.body ||
        !Array.isArray(response.body.variables)
      ) {
        const message = `Failed to fetch variables for reference ${reference}: ${response.message || 'Invalid response from adapter'}`;
        this._logger.warn(message, { response });
        throw new DebugSessionError(message);
      }
      this._logger.info(
        `Fetched ${response.body.variables.length} raw variables for reference ${reference}.`,
      );
      return response.body.variables;
    } catch (error) {
      if (error instanceof DebugSessionError) throw error;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this._logger.error(
        `Error fetching variables for reference ${reference}: ${errorMessage}`,
        { error },
      );
      throw new DebugSessionError(
        `Failed to get variables: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Retrieves the call stack for a given thread ID.
   * Requires the session to be in an 'active', 'initialized', or 'stopped' state.
   *
   * @param threadId The ID of the thread for which to retrieve the call stack.
   * @returns A promise that resolves to an array of raw DAP `StackFrame` objects.
   * @throws DebugSessionError if fetching the call stack fails or the adapter returns an error.
   * @throws InvalidStateError if the session is not in a valid state.
   */
  async getCallStack(threadId: number): Promise<DebugProtocol.StackFrame[]> {
    const operationName = 'getCallStack';
    this._ensureActiveState(operationName);
    this._logger.debug(`Fetching raw call stack for thread: ${threadId}`);
    try {
      const response =
        await this.sessionHandler.sendRequest<DebugProtocol.StackTraceResponse>(
          'stackTrace',
          { threadId, startFrame: 0, levels: 20 },
        );
      if (
        !response.success ||
        !response.body ||
        !Array.isArray(response.body.stackFrames)
      ) {
        const message = `Failed to fetch call stack for thread ${threadId}: ${response.message || 'Invalid response from adapter'}`;
        this._logger.warn(message, { response });
        throw new DebugSessionError(message);
      }
      this._logger.info(
        `Fetched ${response.body.stackFrames.length} raw stack frames for thread ${threadId}.`,
      );
      return response.body.stackFrames;
    } catch (error) {
      if (error instanceof DebugSessionError) throw error;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this._logger.error(
        `Error fetching call stack for thread ${threadId}: ${errorMessage}`,
        { error },
      );
      throw new DebugSessionError(
        `Failed to get call stack: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Resumes execution of the debug target.
   * Requires the session to be in an 'active', 'initialized', or 'stopped' state.
   *
   * @param preferredThreadId Optional ID of the thread to continue. If not provided,
   *                          and the session is stopped on a specific thread, that thread is continued.
   *                          Otherwise (or if explicitly undefined), all threads are continued.
   * @returns A promise that resolves when the continue request is acknowledged.
   * @throws DebugSessionError if the continue operation fails.
   * @throws InvalidStateError if the session is not in a valid state.
   */
  async continue(preferredThreadId?: number): Promise<void> {
    const operationName = 'continue';
    this._ensureActiveState(operationName);

    let effectiveThreadId: number | undefined = undefined;

    if (preferredThreadId !== undefined) {
      // If a specific thread is preferred, use it. _getEffectiveThreadIdOrThrow will validate or use currentThreadId.
      // However, for 'continue', a global continue (all threads) is also valid if no specific thread is stopped.
      effectiveThreadId = this._getEffectiveThreadIdOrThrow(
        operationName,
        preferredThreadId,
      );
    } else if (
      this.state === 'stopped' &&
      this._currentThreadId !== undefined
    ) {
      // If stopped on a specific thread and no preference given, default to that thread.
      // This makes `continue()` without args continue the current thread if stopped.
      // If stopped on a specific thread and no preference given, default to that thread for `continue()`.
      // To continue all threads when stopped, the adapter handles it if no threadId is sent.
      // `continue()` without args means "continue all" if not stopped, or "continue current thread" if stopped.
      // For explicit global continue, or specific thread continue, pass the threadId or undefined.
      this._logger.debug(
        `Operation '${operationName}' is global as no specific thread is preferred. Adapter will continue all threads.`,
      );
      effectiveThreadId = undefined; // Explicitly global
    } else {
      // Not stopped, or no specific current thread, and no preferred ID -> global continue
      this._logger.debug(
        `Operation '${operationName}' is global. Adapter will continue all threads.`,
      );
      effectiveThreadId = undefined;
    }

    await this._awaitDependentBreakpoints(operationName);

    const logMessageSuffix =
      effectiveThreadId !== undefined
        ? `thread ${effectiveThreadId}`
        : 'all threads';
    this._logger.info(`Requesting continue for ${logMessageSuffix}`);
    try {
      await this.sessionHandler.continue(effectiveThreadId);
      this._logger.info(`Continue request successful for ${logMessageSuffix}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this._logger.error(`Failed to continue: ${errorMessage}`, { error });
      throw new DebugSessionError(
        `Failed to continue: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Steps over the current line in the specified thread.
   * Requires the session to be 'stopped'.
   *
   * @param threadId The ID of the thread to step over. Can be obtained from `currentThreadId` if stopped.
   * @returns A promise that resolves when the stepOver request is acknowledged.
   * @throws DebugSessionError if the stepOver operation fails.
   * @throws InvalidStateError if the session is not stopped or not in a valid state.
   */
  async stepOver(threadId: number): Promise<void> {
    const operationName = 'stepOver';
    this._ensureActiveState(operationName);
    if (this.state !== 'stopped') {
      throw new InvalidStateError(
        'Session must be stopped to step over.',
        this.state,
        ['stopped'],
      );
    }
    const effectiveThreadId = this._getEffectiveThreadIdOrThrow(
      operationName,
      threadId,
    );

    await this._awaitDependentBreakpoints(operationName);

    this._logger.info(`Requesting stepOver for thread ${effectiveThreadId}`);
    try {
      await this.sessionHandler.next(effectiveThreadId);
      this._logger.info(
        `StepOver request successful for thread ${effectiveThreadId}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this._logger.error(
        `Failed to stepOver thread ${effectiveThreadId}: ${errorMessage}`,
        { error },
      );
      throw new DebugSessionError(
        `Failed to stepOver: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Steps into the current line/function in the specified thread.
   * Requires the session to be 'stopped'.
   *
   * @param threadId The ID of the thread to step into. Can be obtained from `currentThreadId` if stopped.
   * @returns A promise that resolves when the stepInto request is acknowledged.
   * @throws DebugSessionError if the stepInto operation fails.
   * @throws InvalidStateError if the session is not stopped or not in a valid state.
   */
  async stepInto(threadId: number): Promise<void> {
    const operationName = 'stepInto';
    this._ensureActiveState(operationName);
    if (this.state !== 'stopped') {
      throw new InvalidStateError(
        'Session must be stopped to step into.',
        this.state,
        ['stopped'],
      );
    }
    const effectiveThreadId = this._getEffectiveThreadIdOrThrow(
      operationName,
      threadId,
    );

    await this._awaitDependentBreakpoints(operationName);

    this._logger.info(`Requesting stepInto for thread ${effectiveThreadId}`);
    try {
      await this.sessionHandler.stepIn(effectiveThreadId);
      this._logger.info(
        `StepInto request successful for thread ${effectiveThreadId}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this._logger.error(
        `Failed to stepInto thread ${effectiveThreadId}: ${errorMessage}`,
        { error },
      );
      throw new DebugSessionError(
        `Failed to stepInto: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Steps out of the current function in the specified thread.
   * Requires the session to be 'stopped'.
   *
   * @param threadId The ID of the thread to step out. Can be obtained from `currentThreadId` if stopped.
   * @returns A promise that resolves when the stepOut request is acknowledged.
   * @throws DebugSessionError if the stepOut operation fails.
   * @throws InvalidStateError if the session is not stopped or not in a valid state.
   */
  async stepOut(threadId: number): Promise<void> {
    const operationName = 'stepOut';
    this._ensureActiveState(operationName);
    if (this.state !== 'stopped') {
      throw new InvalidStateError(
        'Session must be stopped to step out.',
        this.state,
        ['stopped'],
      );
    }
    const effectiveThreadId = this._getEffectiveThreadIdOrThrow(
      operationName,
      threadId,
    );

    await this._awaitDependentBreakpoints(operationName);

    this._logger.info(`Requesting stepOut for thread ${effectiveThreadId}`);
    try {
      await this.sessionHandler.stepOut(effectiveThreadId);
      this._logger.info(
        `StepOut request successful for thread ${effectiveThreadId}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this._logger.error(
        `Failed to stepOut thread ${effectiveThreadId}: ${errorMessage}`,
        { error },
      );
      throw new DebugSessionError(
        `Failed to stepOut: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Terminates the debug session and, if supported and configured, the debuggee.
   * This operation attempts to gracefully disconnect from the debug adapter.
   * Valid in 'active', 'initialized', 'stopped', or 'initializing' states.
   *
   * @returns A promise that resolves when the terminate/disconnect request is acknowledged.
   * @throws DebugSessionError if the termination fails.
   * @throws InvalidStateError if the session is not in a state where termination is allowed.
   */
  async terminate(): Promise<void> {
    const operationName = 'terminate';
    const validStatesForTerminate: SessionStatus[] = [
      'active',
      'initialized',
      'stopped',
      'initializing',
    ];
    if (!validStatesForTerminate.includes(this.state)) {
      throw new InvalidStateError(
        `Operation '${operationName}' requires an active, initialized, stopped or initializing session.`,
        this.state,
        validStatesForTerminate,
      );
    }

    this._logger.info('Requesting to terminate debug session.');
    try {
      const capabilities = this.sessionHandler.getAdapterCapabilities();
      // Always use disconnect, but respect supportsTerminateRequest for the terminateDebuggee flag's intent.
      // If supportsTerminateRequest is true, we definitely want to terminate the debuggee.
      // If false, we still might want to for a "terminate" operation, so default to true.
      const terminateDebuggee =
        capabilities.supportsTerminateRequest !== undefined
          ? capabilities.supportsTerminateRequest
          : true;
      await this.sessionHandler.disconnect({
        terminateDebuggee: terminateDebuggee,
      });
      this._logger.info(
        'Disconnect request (intending termination) successful.',
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this._logger.error(`Failed to terminate debug session: ${errorMessage}`, {
        error,
      });
      throw new DebugSessionError(
        `Failed to terminate session: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private _setupEventListeners(): void {
    this._sessionHandler.once('sessionStarted', (payload) => {
      try {
        const oldState = 'initializing' as SessionStatus;
        this._logger.info(
          'Debug session initialize request acknowledged by adapter',
          { capabilities: payload.capabilities },
        );
        const currentState = this.state;
        this._notifyStateChange(currentState, oldState);
      } catch (error) {
        this._logger.error(
          'Unexpected error in "sessionStarted" event handler',
          { error },
        );
      }
    });

    this._sessionHandler.once('sessionEnded', (payload) => {
      try {
        const oldState = this.state;
        this._logger.info('Debug session reported as ended by adapter', {
          reason: payload.reason,
        });
        this._currentThreadId = undefined;
        this._activatingDependentBreakpointsPromise = null;
        this._notifyStateChange('terminated', oldState);
      } catch (error) {
        this._logger.error('Unexpected error in "sessionEnded" event handler', {
          error,
        });
      }
    });

    this._sessionHandler.on('stopped', (payload) => {
      try {
        const oldState = this.state;
        this._currentThreadId = payload.threadId;
        this._logger.info('Debug session stopped', {
          reason: payload.reason,
          threadId: payload.threadId,
          allThreadsStopped: payload.allThreadsStopped,
          hitBreakpointIds: payload.hitBreakpointIds,
        });

        const hitBreakpointAdapterIds = payload.hitBreakpointIds || [];

        if (
          hitBreakpointAdapterIds.length > 0 &&
          !this._activatingDependentBreakpointsPromise
        ) {
          const allClientBreakpoints = this.breakpoints;
          const hitAdapterBreakpointIdsSet = new Set(hitBreakpointAdapterIds);

          const dependentToActivate: Breakpoint[] = [];
          allClientBreakpoints.forEach((bp) => {
            if (bp.triggeredByBreakpointId && !bp.isEnabled) {
              const triggerBreakpoint = allClientBreakpoints.find(
                (triggerBp) => triggerBp.id === bp.triggeredByBreakpointId,
              );

              if (
                triggerBreakpoint &&
                triggerBreakpoint.adapterId !== undefined
              ) {
                if (
                  hitAdapterBreakpointIdsSet.has(triggerBreakpoint.adapterId)
                ) {
                  dependentToActivate.push(bp);
                }
              } else if (triggerBreakpoint) {
                this._logger.warn(
                  `Potential trigger breakpoint ${triggerBreakpoint.id} for dependent breakpoint ${bp.id} does not have an adapterId. Cannot determine if it was hit. This might happen if the trigger breakpoint was not verified or set by an older version of the client.`,
                );
              }
            }
          });

          if (dependentToActivate.length > 0) {
            this._logger.info(
              `Activating ${dependentToActivate.length} dependent breakpoint(s).`,
            );
            this._activatingDependentBreakpointsPromise = (async () => {
              try {
                for (const depBp of dependentToActivate) {
                  depBp.isEnabled = true;
                  this._logger.debug(
                    `Enabled dependent breakpoint ${depBp.id} for ${depBp.filePath}:${depBp.line}`,
                  );
                }

                const filesWithChangedActivation = new Set<string>(
                  dependentToActivate.map((bp) => bp.filePath),
                );
                const setPromises: Promise<unknown>[] = [];

                filesWithChangedActivation.forEach((filePath) => {
                  const allEnabledBpsInFile = this.getBreakpointsForFile(
                    filePath,
                  )
                    .filter((b) => b.isEnabled)
                    .map(
                      (b) =>
                        ({
                          line: b.line,
                          condition: b.condition,
                          hitCondition: b.hitCondition,
                          logMessage: b.logMessage,
                        }) as DebugProtocol.SourceBreakpoint,
                    );

                  this._logger.debug(
                    `Resending ${allEnabledBpsInFile.length} enabled breakpoints for ${filePath} due to dependent activation.`,
                  );
                  setPromises.push(
                    this.sessionHandler.setBreakpoints({
                      source: { path: filePath },
                      breakpoints: allEnabledBpsInFile,
                    }),
                  );
                });

                await Promise.all(setPromises);
                this._logger.info(
                  'Successfully activated and sent dependent breakpoints.',
                );
              } catch (error) {
                this._logger.error(
                  'Error activating or sending dependent breakpoints:',
                  error,
                );
              } finally {
                this._activatingDependentBreakpointsPromise = null;
                this._logger.debug(
                  'Finished dependent breakpoint activation process.',
                );
              }
            })();
          }
        }
        this._notifyStateChange(this.state, oldState);
      } catch (error) {
        this._logger.error('Unexpected error in "stopped" event handler', {
          error,
        });
      }
    });

    this._sessionHandler.on('continued', (payload) => {
      try {
        const oldState = this.state;
        if (
          payload.allThreadsContinued ||
          payload.threadId === this._currentThreadId
        ) {
          this._currentThreadId = undefined;
        }
        if (this._activatingDependentBreakpointsPromise) {
          this._logger.debug(
            'Session continued, clearing pending dependent breakpoint activation promise.',
          );
          this._activatingDependentBreakpointsPromise = null;
        }
        this._logger.info('Debug session continued', {
          threadId: payload.threadId,
          allThreadsContinued: payload.allThreadsContinued,
        });
        this._notifyStateChange(this.state, oldState);
      } catch (error) {
        this._logger.error('Unexpected error in "continued" event handler', {
          error,
        });
      }
    });

    this._sessionHandler.on('error', (payload) => {
      try {
        this._logger.error('Error reported by DAPSessionHandler', {
          error: payload.error,
        });
      } catch (error) {
        console.error(
          // Use console.error as a last resort if logger fails
          'CRITICAL: Unexpected error in "error" event handler itself:',
          error,
        );
      }
    });
  }

  private _notifyStateChange(
    newState: SessionStatus,
    oldState: SessionStatus,
  ): void {
    this._logger.debug(
      `DebugSession state event. Old: ${oldState}, New: ${newState}. Notifying listeners.`,
    );
    for (const listener of this._stateListeners) {
      try {
        listener(this.id, newState, oldState);
      } catch (err) {
        this._logger.error('Error in state change listener', { error: err });
      }
    }
  }

  private _ensureActiveState(operationName: string): void {
    const validStates: SessionStatus[] = ['active', 'initialized', 'stopped'];
    if (!validStates.includes(this.state)) {
      throw new InvalidStateError(
        `Operation '${operationName}' requires an active, initialized, or stopped session.`,
        this.state,
        validStates,
      );
    }
  }

  private _getEffectiveThreadIdOrThrow(
    operationName: string,
    preferredThreadId?: number,
  ): number {
    if (preferredThreadId !== undefined) {
      return preferredThreadId;
    }
    if (this._currentThreadId !== undefined) {
      return this._currentThreadId;
    }
    // If neither preferredThreadId nor _currentThreadId is available, throw.
    throw new DebugSessionError(
      `Cannot determine target thread for '${operationName}'. Session may not be stopped on a specific thread, or a specific threadId was not provided.`,
    );
  }

  private async _awaitDependentBreakpoints(
    operationName: string,
  ): Promise<void> {
    if (this._activatingDependentBreakpointsPromise) {
      this._logger.debug(
        `Waiting for dependent breakpoints to be activated before ${operationName}...`,
      );
      try {
        await this._activatingDependentBreakpointsPromise;
        this._logger.debug(
          `Dependent breakpoints activation complete for ${operationName}.`,
        );
      } catch (error) {
        // Log the error but allow the operation to proceed.
        // The promise itself handles logging its internal errors.
        this._logger.error(
          `Error during dependent breakpoint activation, but proceeding with ${operationName} anyway. See previous logs for activation error details.`,
          { operationName, error },
        );
      }
    }
  }

  /**
   * Gets the underlying DAPSessionHandler instance.
   * This provides access to the raw DAP event emitters and request methods
   * if more advanced control or direct protocol interaction is needed.
   */
  public get sessionHandler(): DAPSessionHandler {
    return this._sessionHandler;
  }
}
