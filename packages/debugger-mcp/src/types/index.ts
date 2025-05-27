/**
 * Represents the state of a debug session
 */
export enum SessionState {
  INITIALIZING = 'initializing',
  CONFIGURED = 'configured',
  RUNNING = 'running',
  STOPPED = 'stopped',
  TERMINATED = 'terminated',
}

/**
 * Information about a debug session
 */
export interface SessionInfo {
  id: string;
  targetType: string;
  targetPath: string;
  state: SessionState;
  startTime: Date;
}

/**
 * Result of setting a breakpoint
 */
export interface BreakpointResult {
  breakpointId: string;
  verified: boolean;
  line: number;
  message?: string;
}

/**
 * Represents a breakpoint in a debug session
 */
export interface Breakpoint {
  id: string;
  filePath: string;
  line: number;
  verified: boolean;
  condition?: string;
  message?: string;
}

/**
 * Result of evaluating an expression
 */
export interface EvaluationResult {
  result: string;
  type?: string;
  variablesReference?: number;
  namedVariables?: number;
  indexedVariables?: number;
}

/**
 * Represents a source file in a debug session (sanitized model)
 */
export interface ModelSource {
  name?: string;
  path?: string;
  sourceReference?: number;
  adapterData?: unknown;
  // Potentially add other serializable properties from DebugProtocol.Source. e.g., presentationHint, origin
}

/**
 * Represents a stack frame in a call stack (sanitized model)
 */
export interface ModelStackFrame {
  id: number;
  name: string;
  source?: ModelSource;
  line: number;
  column: number;
  instructionPointerReference?: string;
  // Note: To prevent circular dependencies in JSON serialization, we omit direct references to a the parent Thread object.
}

/**
 * Represents a thread in a debug session (sanitized model)
 */
export interface ModelThread {
  id: number;
  name: string;
}

/**
 * Represents a variable in the debug session
 */
export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}

/**
 * Listener for session state changes
 */
export type StateChangeListener = (
  sessionId: string,
  newState: SessionState,
  oldState: SessionState,
) => void;

/**
 * Error codes specific to the debugger
 */
export enum DebuggerErrorCode {
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  INVALID_STATE = 'INVALID_STATE',
  BREAKPOINT_ERROR = 'BREAKPOINT_ERROR',
  EVALUATION_ERROR = 'EVALUATION_ERROR',
  ADAPTER_ERROR = 'ADAPTER_ERROR',
  TIMEOUT = 'TIMEOUT',
}

/**
 * Base class for debugger errors
 */
export class DebuggerError extends Error {
  constructor(
    message: string,
    public code: DebuggerErrorCode,
  ) {
    super(message);
    this.name = 'DebuggerError';
  }
}

/**
 * Error thrown when a session is not found
 */
export class SessionNotFoundError extends DebuggerError {
  constructor(sessionId: string) {
    super(
      `Debug session with ID ${sessionId} not found`,
      DebuggerErrorCode.SESSION_NOT_FOUND,
    );
    this.name = 'SessionNotFoundError';
  }
}

/**
 * Error thrown when a session is in an invalid state for an operation
 */
export class InvalidStateError extends DebuggerError {
  constructor(
    sessionId: string,
    currentState: SessionState,
    expectedStates: SessionState[],
  ) {
    super(
      `Session ${sessionId} is in state ${currentState}, expected one of: ${expectedStates.join(', ')}`,
      DebuggerErrorCode.INVALID_STATE,
    );
    this.name = 'InvalidStateError';
  }
}

/**
 * Error thrown when a breakpoint operation fails
 */
export class BreakpointError extends DebuggerError {
  constructor(
    message: string,
    public filePath: string,
    public line: number,
  ) {
    super(message, DebuggerErrorCode.BREAKPOINT_ERROR);
    this.name = 'BreakpointError';
  }
}

/**
 * Error thrown when an expression evaluation fails
 */
export class EvaluationError extends DebuggerError {
  constructor(
    message: string,
    public expression: string,
  ) {
    super(message, DebuggerErrorCode.EVALUATION_ERROR);
    this.name = 'EvaluationError';
  }
}

/**
 * Wrapper class for DebugSession from ergonomic-debugger-client
 * to hold additional metadata like targetType, targetPath, and startTime.
 */
import {
  DebugSession,
  DAPSessionHandler,
  LoggerInterface,
  SessionStatus,
} from '@bloopai/ergonomic-debugger-client';

export class WrappedDebugSession {
  public readonly originalSession: DebugSession;
  public readonly id: string;
  public readonly targetType: string;
  public readonly targetPath: string;
  public readonly startTime: Date;
  private readonly logger: LoggerInterface;

  constructor(
    mcpSessionId: string,
    originalSession: DebugSession,
    targetType: string,
    targetPath: string,
    startTime: Date,
    logger: LoggerInterface,
  ) {
    this.id = mcpSessionId;
    this.originalSession = originalSession;
    this.targetType = targetType;
    this.targetPath = targetPath;
    this.startTime = startTime;
    this.logger = logger;
  }

  public get dapSessionHandler(): DAPSessionHandler {
    return this.originalSession.sessionHandler;
  }

  public get status(): SessionStatus {
    const handler = this.dapSessionHandler;
    return handler ? handler.status : ('terminated' as SessionStatus);
  }
}
