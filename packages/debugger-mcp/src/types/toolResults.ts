import { DebugProtocol } from '@vscode/debugprotocol';
import { AdapterConfig } from '@bloopai/ergonomic-debugger-client';
import {
  SessionInfo as ModelSessionInfo,
  BreakpointResult as ModelBreakpointResult,
  EvaluationResult as ModelEvaluationResult,
  ModelStackFrame,
  ModelThread,
  Variable as ModelVariable,
  SessionState,
} from './index';
import { McpAsyncEvent } from './mcp_protocol_extensions';

export interface TerminatedEventInfo {
  terminated: true;
  reason?: string;
  exitCode?: number;
  signal?: string;
  error?: Error;
}

export interface HandleGetPendingAsyncEventsResult {
  events: McpAsyncEvent[];
}

export interface HandleStartDebugSessionResult {
  sessionId: string;
  sessionInfo: ModelSessionInfo;
  stoppedEvent?: DebugProtocol.StoppedEvent['body'];
}

export type HandleSetBreakpointResult = ModelBreakpointResult;

export type HandleEvaluateExpressionResult = ModelEvaluationResult;

export type HandleGetVariablesResult = ModelVariable[];

export type HandleGetCallStackResult = ModelStackFrame[];

export interface HandleStepOperationBaseResult {
  stoppedEvent?: DebugProtocol.StoppedEvent['body'];
  sessionState?: SessionState;
  outputEvents?: DebugProtocol.OutputEvent['body'][];
  terminatedEvent?: TerminatedEventInfo;
  error?: string;
}
export interface HandleContinueResult {
  success: boolean;
  sessionState?: SessionState;
  stoppedEvent?: DebugProtocol.StoppedEvent['body'];
  outputEvents?: DebugProtocol.OutputEvent['body'][];
  terminatedEvent?: TerminatedEventInfo;
}

export interface HandleStepOverResult extends HandleStepOperationBaseResult {
  success: boolean;
}

export interface HandleStepInResult extends HandleStepOperationBaseResult {
  success: boolean;
}

export interface HandleStepOutResult extends HandleStepOperationBaseResult {
  success: boolean;
}

export interface HandleTerminateSessionResult {
  success: boolean;
}

export interface HandleListSessionsResult {
  sessions: ModelSessionInfo[];
}

export interface HandleListAdaptersResult {
  adapters: {
    type: string;
    config: Partial<AdapterConfig>;
  }[];
}

export interface HandleGetSessionDetailsResult {
  sessionInfo: ModelSessionInfo;
  threads?: ModelThread[];
  callStack?: ModelStackFrame[]; // For the primary/active thread if paused
  breakpoints?: ModelBreakpointResult[];
  pendingEventsForSession?: McpAsyncEvent[];
}
export type AnyToolResult =
  | HandleGetPendingAsyncEventsResult
  | HandleStartDebugSessionResult
  | HandleSetBreakpointResult
  | HandleEvaluateExpressionResult
  | HandleGetVariablesResult
  | HandleGetCallStackResult
  | HandleContinueResult
  | HandleStepOverResult
  | HandleStepInResult
  | HandleStepOutResult
  | HandleTerminateSessionResult
  | HandleListSessionsResult
  | HandleListAdaptersResult
  | HandleGetSessionDetailsResult;
