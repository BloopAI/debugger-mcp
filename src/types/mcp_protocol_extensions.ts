import { DebugProtocol } from '@vscode/debugprotocol';
import { AdapterConfig } from 'ergonomic-debugger-client';

export type McpDebugErrorType =
  | 'dap_request_error'
  | 'adapter_process_error'
  | 'session_config_error'
  | 'tool_internal_error'
  | 'unexpected_session_termination'
  | 'operation_timeout'
  | 'session_not_found'
  | 'invalid_tool_arguments'
  | 'dap_handler_not_found'
  | 'no_threads_available'
  | 'no_stopped_thread_available';

export interface McpDebugErrorData {
  errorType: McpDebugErrorType;
  sessionId?: string;
  originalMessage?: string;
  originalName?: string;
  originalStack?: string;

  // For 'dap_request_error'
  dapRequestCommand?: string;
  dapResponseErrorBody?: DebugProtocol.ErrorResponse['body'];

  // For 'adapter_process_error'
  adapterType?: string;
  adapterConfig?: AdapterConfig;
  spawnErrorStage?: 'spawn' | 'early_exit' | 'stream_setup';
  spawnDetails?: {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    stderr?: string;
    exitCode?: number | null;
    signal?: string | null;
  };

  // For 'unexpected_session_termination'
  terminationReason?: string;
  terminationExitCode?: number | null;
  terminationSignal?: string | null;
  terminationUnderlyingError?: {
    message: string;
    name?: string;
    stack?: string;
  };

  // For 'session_config_error'
  configProblem?: string;

  // For 'operation_timeout'
  operation?: string;
  timeoutMs?: number;

  // For 'invalid_tool_arguments'
  argumentName?: string;
  problemDetail?: string;
  receivedPath?: string;
  asyncEvents?: McpAsyncEvent[];
}

export type McpAsyncEventType =
  | 'unexpected_session_termination'
  | 'dap_session_handler_error'
  | 'dap_event_output'
  | 'dap_event_stopped'
  | 'dap_event_continued'
  | 'dap_event_thread'
  | 'dap_event_module'
  | 'dap_event_loaded_source'
  | 'dap_event_process'
  | 'dap_event_capabilities'
  | 'dap_event_breakpoint'
  | 'dap_event_invalidated';
// Add other relevant DAP events as needed.

export interface McpAsyncEvent {
  eventId: string;
  timestamp: string;
  eventType: McpAsyncEventType;
  sessionId: string;
  data: unknown;
}
