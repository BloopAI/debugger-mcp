// Argument types for MCP tools, derived from their JSON schemas

export interface StartDebugSessionArgs {
  targetType?: 'node' | 'python';
  targetPath: string;
  stopOnEntry?: boolean;
  launchArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  // Additional properties
  [key: string]: unknown;
}

export interface SetBreakpointArgs {
  sessionId: string;
  filePath: string;
  lineNumber: number;
}

export interface EvaluateExpressionArgs {
  sessionId: string;
  expression: string;
  frameId?: number;
  context?: 'watch' | 'repl' | 'hover' | string;
}

export interface GetVariablesArgs {
  sessionId: string;
  variablesReference: number;
}

export interface GetCallStackArgs {
  sessionId: string;
  threadId?: number;
}

export interface ContinueArgs {
  sessionId: string;
  threadId?: number;
}

export interface StepOverArgs {
  sessionId: string;
  threadId?: number;
}

export interface TerminateSessionArgs {
  sessionId: string;
}

export interface StepInArgs {
  sessionId: string;
  threadId?: number;
}

export interface StepOutArgs {
  sessionId: string;
  threadId?: number;
}

export type ListSessionsArgs = Record<string, never> | undefined;

export type ListAdapterConfigsArgs = Record<string, never> | undefined;

export type GetPendingAsyncEventsArgs = Record<string, never> | undefined;

export interface GetSessionDetailsArgs {
  sessionId: string;
}
export type AnyToolArgs =
  | StartDebugSessionArgs
  | SetBreakpointArgs
  | EvaluateExpressionArgs
  | GetVariablesArgs
  | GetCallStackArgs
  | ContinueArgs
  | StepOverArgs
  | TerminateSessionArgs
  | StepInArgs
  | StepOutArgs
  | ListSessionsArgs
  | ListAdapterConfigsArgs
  | GetPendingAsyncEventsArgs
  | GetSessionDetailsArgs;
