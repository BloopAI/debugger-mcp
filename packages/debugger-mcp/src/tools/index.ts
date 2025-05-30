import * as path from 'path';
import {
  McpAsyncEvent,
  McpAsyncEventType,
} from '../types/mcp_protocol_extensions';
import {
  StartDebugSessionArgs,
  SetBreakpointArgs,
  EvaluateExpressionArgs,
  GetVariablesArgs,
  GetCallStackArgs,
  ContinueArgs,
  StepOverArgs,
  TerminateSessionArgs,
  ListSessionsArgs,
  ListAdapterConfigsArgs,
  GetPendingAsyncEventsArgs,
  GetSessionDetailsArgs,
  StepInArgs,
  StepOutArgs,
} from '../types/toolArgs';
import {
  TerminatedEventInfo,
  HandleGetSessionDetailsResult,
  HandleStepInResult,
  HandleStepOutResult,
  HandleStepOverResult,
  HandleTerminateSessionResult,
  HandleContinueResult,
  HandleStepOperationBaseResult,
} from '../types/toolResults';

export interface AdapterConfigDetail {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface SessionProvider {
  getSessionManager(): SessionManager;
  getDebugSession(sessionId: string): DebugSession | undefined;
  getDAPSessionHandler(sessionId: string): DAPSessionHandler | undefined;
  createDebugSession(
    dapHandler: DAPSessionHandler,
    targetType: string,
    targetPath: string,
    logger: LoggerInterface,
  ): DebugSession;
  storeDebugSession(
    mcpSessionId: string,
    session: DebugSession,
    startTime: Date,
    targetType: string,
    targetPath: string,
  ): void;
  removeDebugSession(sessionId: string): void;
  getLogger(): LoggerInterface;
  getAllSessionInfo(): ModelSessionInfo[];
  drainAsyncEventQueue(): McpAsyncEvent[];
  findAndConsumeSessionEvent(
    sessionId: string,
    eventType: McpAsyncEventType,
    removeIfFound?: boolean,
  ): McpAsyncEvent | undefined;
  getEventsForSession(sessionId: string): McpAsyncEvent[];
  queueAsyncEvent(
    sessionId: string,
    eventType: McpAsyncEventType,
    data: unknown,
  ): void;
}

import {
  SessionManager,
  DebugSession,
  DAPSessionHandler,
  LoggerInterface,
  SessionStatus,
  BreakpointResult,
  EvaluationResult,
  BreakpointConfigBuilder,
  AdapterConfig,
} from '@bloopai/ergonomic-debugger-client';

import {
  SessionInfo as ModelSessionInfo,
  BreakpointResult as ModelBreakpointResult,
  EvaluationResult as ModelEvaluationResult,
  ModelStackFrame,
  ModelThread,
  Variable as ModelVariable,
  SessionState as ModelSessionState,
} from '../types';

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { DebugProtocol } from '@vscode/debugprotocol';
import { McpErrorBuilder } from '../errorUtils';

export const DAP_DEFAULT_EVENT_TIMEOUT_MS = 15000;
const DAP_TERMINATION_RACE_TIMEOUT_MS = 15100;

// HELPER FUNCTIONS START

function validateRequiredToolArgs(
  args: Record<string, unknown>,
  requiredParams: Array<{
    key: string;
    type?: 'string' | 'number' | 'boolean' | 'object';
  }>,
  toolName: string,
  sessionProvider: SessionProvider,
  sessionIdForErrorContext?: string,
): void {
  for (const param of requiredParams) {
    const value = args[param.key];
    let isValid = true;
    if (value === undefined || value === null) {
      isValid = false;
    } else if (param.type) {
      // Simplified type check, can be expanded
      if (
        param.type === 'object' &&
        (typeof value !== 'object' || Array.isArray(value))
      ) {
        isValid = false;
      } else if (param.type !== 'object' && typeof value !== param.type) {
        isValid = false;
      }
    }

    if (!isValid) {
      throw new McpErrorBuilder()
        .error(
          new Error(
            `Missing or invalid parameter '${param.key}' for ${toolName}`,
          ),
        )
        .toolName(toolName)
        .mcpErrorCode(ErrorCode.InvalidParams)
        .mcpDebugErrorType('invalid_tool_arguments')
        .sessionProvider(sessionProvider)
        .sessionId(sessionIdForErrorContext)
        .additionalDebugData({
          argumentName: param.key,
          problemDetail: `Missing or invalid parameter '${param.key}'. Expected type: ${param.type || 'any'}.`,
        })
        .build();
    }
  }
}

async function getActiveDebugSessionOrThrow(
  sessionProvider: SessionProvider,
  sessionId: string | undefined,
  toolName: string,
  checkTermination = true,
): Promise<DebugSession> {
  if (!sessionId) {
    throw new McpErrorBuilder()
      .error(new Error(`Missing sessionId for ${toolName}`))
      .toolName(toolName)
      .mcpErrorCode(ErrorCode.InvalidParams)
      .mcpDebugErrorType('invalid_tool_arguments')
      .sessionProvider(sessionProvider)
      .additionalDebugData({
        argumentName: 'sessionId',
        problemDetail: `Missing sessionId for ${toolName}`,
      })
      .build();
  }

  if (checkTermination) {
    const terminatedEvent = sessionProvider.findAndConsumeSessionEvent(
      sessionId,
      'unexpected_session_termination',
      true,
    );
    if (terminatedEvent) {
      const eventData = terminatedEvent.data as
        | Record<string, unknown>
        | undefined;
      const reason = eventData?.reason as string | undefined;
      const exitCode = eventData?.exitCode as number | null | undefined;
      const signal = eventData?.signal as string | null | undefined;
      const underlyingError = eventData?.underlyingError;
      const originalMessage = `Session ${sessionId} terminated before ${toolName} could be executed. Reason: ${reason || 'Unknown'}. Exit Code: ${exitCode}, Signal: ${signal}.`;

      let structuredUnderlyingError:
        | { message: string; name?: string; stack?: string }
        | undefined;
      if (underlyingError instanceof Error) {
        structuredUnderlyingError = {
          message: underlyingError.message,
          name: underlyingError.name,
          stack: underlyingError.stack,
        };
      } else if (underlyingError) {
        structuredUnderlyingError = { message: String(underlyingError) };
      }

      throw new McpErrorBuilder()
        .error(new Error(originalMessage))
        .toolName(toolName)
        .mcpErrorCode(ErrorCode.InvalidRequest)
        .mcpDebugErrorType('unexpected_session_termination')
        .sessionProvider(sessionProvider)
        .sessionId(sessionId)
        .additionalDebugData({
          terminationReason: reason,
          terminationExitCode: exitCode,
          terminationSignal: signal,
          terminationUnderlyingError: structuredUnderlyingError,
          originalMessage: `Session ${sessionId} terminated before ${toolName} could be executed.`,
        })
        .build();
    }
  }

  const debugSession = sessionProvider.getDebugSession(sessionId);
  if (!debugSession) {
    throw new McpErrorBuilder()
      .error(new Error(`Debug session not found: ${sessionId}`))
      .toolName(toolName)
      .mcpErrorCode(ErrorCode.InvalidRequest)
      .mcpDebugErrorType('session_not_found')
      .sessionProvider(sessionProvider)
      .sessionId(sessionId)
      .build();
  }
  return debugSession;
}

/**
 * Waits for a 'stopped' event from the DAP handler after a step-like operation.
 * Includes a timeout and handles logging if the event is not received.
 * @param dapHandler The DAPSessionHandler to listen on.
 * @param toolName The name of the tool initiating the wait, for logging.
 * @param sessionId The ID of the session, for logging.
 * @param logger The logger instance.
 * @param timeoutMs The timeout duration in milliseconds.
 * @returns A promise that resolves with the StoppedEvent body, or undefined if a timeout occurs or an error is caught.
 */
async function _waitForStoppedEventAfterStep(
  dapHandler: DAPSessionHandler,
  toolName: string,
  sessionId: string,
  logger: LoggerInterface,
  timeoutMs: number = DAP_DEFAULT_EVENT_TIMEOUT_MS,
): Promise<DebugProtocol.StoppedEvent['body'] | undefined> {
  try {
    return await new Promise<DebugProtocol.StoppedEvent['body']>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Timeout waiting for 'stopped' event after ${toolName} for session ${sessionId}`,
              ),
            ),
          timeoutMs,
        );
        const listener = (eventBody: DebugProtocol.StoppedEvent['body']) => {
          clearTimeout(timeout);
          dapHandler.off('stopped', listener);
          resolve(eventBody);
        };
        dapHandler.on('stopped', listener);
      },
    );
  } catch (e) {
    logger.warn(
      `[${toolName}] Error waiting for stopped event for session ${sessionId}: ${
        (e as Error).message
      }`,
    );
    return undefined;
  }
}

/**
 * Resolves the target thread ID for an operation.
 * If requestedThreadId is provided, it's returned.
 * Otherwise, it defaults based on available threads and the requireStopped flag.
 * @param sessionProvider The session provider.
 * @param sessionId The session ID.
 * @param requestedThreadId The thread ID from the tool arguments, if any.
 * @param toolName The name of the tool calling this helper.
 * @param requireStopped If true, a stopped thread is required for defaulting.
 * @returns A promise resolving to the target thread ID.
 * @throws McpError if a suitable thread cannot be determined.
 */
async function _resolveTargetThreadId(
  sessionProvider: SessionProvider,
  sessionId: string,
  requestedThreadId: number | undefined,
  toolName: string,
  requireStopped: boolean,
): Promise<number> {
  if (requestedThreadId !== undefined) {
    return requestedThreadId;
  }

  const dapHandler = sessionProvider.getDAPSessionHandler(sessionId);
  if (!dapHandler) {
    throw new McpErrorBuilder()
      .error(
        new Error(
          `DAPSessionHandler not found for session ${sessionId} when resolving target threadId for ${toolName}`,
        ),
      )
      .toolName(toolName)
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('dap_handler_not_found')
      .sessionProvider(sessionProvider)
      .sessionId(sessionId)
      .build();
  }

  const threads = dapHandler.getThreads();
  if (threads.length === 0) {
    throw new McpErrorBuilder()
      .error(
        new Error(
          `No threads available in session ${sessionId} to default for ${toolName}.`,
        ),
      )
      .toolName(toolName)
      .mcpErrorCode(ErrorCode.InvalidRequest)
      .mcpDebugErrorType('no_threads_available')
      .sessionProvider(sessionProvider)
      .sessionId(sessionId)
      .build();
  }

  const stoppedThread = threads.find((t) => t.stoppedDetails);

  if (requireStopped) {
    if (!stoppedThread) {
      throw new McpErrorBuilder()
        .error(
          new Error(
            `No stopped thread available in session ${sessionId} to default for ${toolName}. An active thread must be paused.`,
          ),
        )
        .toolName(toolName)
        .mcpErrorCode(ErrorCode.InvalidRequest)
        .mcpDebugErrorType('no_stopped_thread_available')
        .sessionProvider(sessionProvider)
        .sessionId(sessionId)
        .additionalDebugData({
          problemDetail: `No stopped thread available to default for ${toolName}. Current threads: ${JSON.stringify(threads.map((t) => ({ id: t.id, name: t.name, stopped: !!t.stoppedDetails })))}`,
        })
        .build();
    }
    sessionProvider
      .getLogger()
      .info(
        `[${toolName}] threadId not provided, defaulted to stopped thread ${stoppedThread.id} for session ${sessionId}`,
      );
    return stoppedThread.id;
  } else {
    // For operations like get_call_stack, prefer a stopped thread, but any thread is fine.
    const targetThread = stoppedThread || threads[0];
    sessionProvider
      .getLogger()
      .info(
        `[${toolName}] threadId not provided, defaulted to thread ${targetThread.id} (stopped: ${!!stoppedThread}) for session ${sessionId}`,
      );
    return targetThread.id;
  }
}
// HELPER FUNCTIONS END

function _ensureThreadIsStopped(
  dapHandler: DAPSessionHandler,
  threadId: number,
  toolName: string,
  sessionId: string,
  sessionProvider: SessionProvider,
): void {
  const thread = dapHandler.getThread(threadId);
  if (!thread || !thread.stoppedDetails) {
    const sessionStatus = dapHandler.status;
    const allThreadsInfo = dapHandler.getThreads().map((t) => ({
      id: t.id,
      name: t.name,
      isStopped: !!t.stoppedDetails,
      stopReason: t.stoppedDetails?.reason,
    }));
    const problemDetailText = `Thread ${threadId} is not in a stopped state for operation '${toolName}'. It must be paused (e.g., at a breakpoint or after a previous step). Current session status: '${sessionStatus}'.`;
    sessionProvider
      .getLogger()
      .warn(
        `[${toolName}] Precondition failed for session ${sessionId}: ${problemDetailText} Thread states: ${JSON.stringify(allThreadsInfo)}`,
      );
    throw new McpErrorBuilder()
      .error(new Error(problemDetailText))
      .toolName(toolName)
      .mcpErrorCode(ErrorCode.InvalidRequest)
      .mcpDebugErrorType('invalid_tool_arguments')
      .sessionProvider(sessionProvider)
      .sessionId(sessionId)
      .additionalDebugData({
        operation: toolName,
        argumentName: 'threadState',
        problemDetail: `${problemDetailText} Expected thread state: 'stopped'. Actual session status: '${sessionStatus}'. Current thread ID: ${threadId}. All threads info: ${JSON.stringify(allThreadsInfo)}`,
      })
      .build();
  }
}

function mapDebuggerStackFrameToModel(
  debuggerFrame: DebugProtocol.StackFrame,
  threadId?: number,
): ModelStackFrame {
  return {
    id: debuggerFrame.id,
    name: debuggerFrame.name,
    source: debuggerFrame.source
      ? {
          name: debuggerFrame.source.name,
          path: debuggerFrame.source.path,
          sourceReference: debuggerFrame.source.sourceReference,
          adapterData: debuggerFrame.source.adapterData,
        }
      : undefined,
    line: debuggerFrame.line,
    column: debuggerFrame.column,
    instructionPointerReference: debuggerFrame.instructionPointerReference,
    threadId: threadId,
  };
}

/**
 * Generic helper to perform a step operation (over, in, out),
 * wait for the 'stopped' event, and handle common outcomes.
 */
async function _performStepOperation(
  toolName: string,
  debugSession: DebugSession,
  dapHandler: DAPSessionHandler,
  targetThreadId: number,
  sessionProvider: SessionProvider,
  localSessionId: string,
  stepActionFn: (threadId: number) => Promise<unknown>,
): Promise<HandleStepOperationBaseResult> {
  const outputEvents: DebugProtocol.OutputEvent['body'][] = [];
  const outputListener = (eventBody: DebugProtocol.OutputEvent['body']) => {
    outputEvents.push(eventBody);
  };
  dapHandler.on('output', outputListener);

  const stoppedPromise = _waitForStoppedEventAfterStep(
    dapHandler,
    toolName,
    localSessionId,
    sessionProvider.getLogger(),
  );

  await stepActionFn(targetThreadId);
  const stoppedEvent = await stoppedPromise;
  dapHandler.off('output', outputListener);

  if (!stoppedEvent) {
    sessionProvider
      .getLogger()
      .warn(
        `[${toolName}] Did not receive a stopped event for session ${localSessionId} after ${toolName}. The program might have continued or terminated.`,
      );
    const terminatedEventData = sessionProvider.findAndConsumeSessionEvent(
      localSessionId,
      'unexpected_session_termination',
      true,
    );
    if (terminatedEventData) {
      const eventData = terminatedEventData.data as TerminatedEventInfo;
      return {
        sessionState: ModelSessionState.TERMINATED,
        outputEvents,
        terminatedEvent: eventData,
        error: `Session terminated unexpectedly during ${toolName}. Reason: ${
          eventData?.reason || 'Unknown'
        }`,
      };
    }
    return {
      sessionState: mapStatusToSessionState(dapHandler.status),
      outputEvents,
      error: `No 'stopped' event received after ${toolName}. Current session status: ${dapHandler.status}.`,
    };
  }

  let topStackFrame: ModelStackFrame | undefined;

  if (stoppedEvent) {
    try {
      const stackFrames = await debugSession.getCallStack(
        stoppedEvent.threadId as number,
      );
      if (stackFrames.length > 0) {
        const topFrameFromDebugger = stackFrames[0];
        topStackFrame = mapDebuggerStackFrameToModel(
          topFrameFromDebugger,
          stoppedEvent.threadId,
        );
      }
    } catch (e) {
      sessionProvider
        .getLogger()
        .warn(
          `[${toolName}] Error getting stack frame for location: ${
            (e as Error).message
          }`,
        );
    }
  }

  return {
    sessionState: ModelSessionState.STOPPED,
    stoppedEvent,
    outputEvents,
    topStackFrame,
  };
}

export async function handleGetPendingAsyncEvents(
  sessionProvider: SessionProvider,
  _args: GetPendingAsyncEventsArgs,
): Promise<{ events: McpAsyncEvent[] }> {
  if (typeof sessionProvider.drainAsyncEventQueue !== 'function') {
    sessionProvider
      .getLogger()
      .error(
        '[handleGetPendingAsyncEvents] drainAsyncEventQueue method is not available on sessionProvider.',
      );
    return { events: [] };
  }
  const events = sessionProvider.drainAsyncEventQueue();
  sessionProvider
    .getLogger()
    .info(`[handleGetPendingAsyncEvents] Drained ${events.length} events.`);
  return { events };
}

export class LaunchArgumentsBuilder {
  private launchArgs: DebugProtocol.LaunchRequestArguments & {
    [key: string]: unknown;
  } = {
    noDebug: false,
    console: 'internalConsole',
    request: 'launch',
    type: '',
    name: '',
  };

  constructor(mcpArgs: StartDebugSessionArgs) {
    this.launchArgs.program = mcpArgs.targetPath;
    this.launchArgs.name = `Debug ${mcpArgs.targetPath}`;

    if (mcpArgs.launchArgs) {
      this.launchArgs.args = mcpArgs.launchArgs;
    }
    if (mcpArgs.stopOnEntry !== undefined) {
      this.launchArgs.stopOnEntry = mcpArgs.stopOnEntry;
    }
    if (mcpArgs.cwd) {
      this.launchArgs.cwd = mcpArgs.cwd;
    }
    if (mcpArgs.env) {
      this.launchArgs.env = mcpArgs.env;
    }

    const knownMcpArgs = [
      'targetType',
      'targetPath',
      'launchArgs',
      'stopOnEntry',
      'cwd',
      'env',
      'request',
      'type',
      'name',
      'program',
      'noDebug',
      'console',
    ];
    for (const key in mcpArgs) {
      if (Object.prototype.hasOwnProperty.call(mcpArgs, key)) {
        if (!knownMcpArgs.includes(key)) {
          const value = mcpArgs[key];
          if (value !== undefined) {
            this.launchArgs[key] = value;
          }
        }
      }
    }
  }

  public withProgram(program: string): this {
    this.launchArgs.program = program;
    return this;
  }

  public withRequestType(request: 'launch' | 'attach'): this {
    this.launchArgs.request = request;
    return this;
  }

  public withDebugType(type: string): this {
    this.launchArgs.type = type;
    return this;
  }

  public withName(name: string): this {
    this.launchArgs.name = name;
    return this;
  }

  public withLaunchArguments(args: string[]): this {
    this.launchArgs.args = args;
    return this;
  }

  public withStopOnEntry(stop: boolean): this {
    this.launchArgs.stopOnEntry = stop;
    return this;
  }

  public withCwd(cwd: string): this {
    this.launchArgs.cwd = cwd;
    return this;
  }

  public withEnv(env: Record<string, string | null | undefined>): this {
    const filteredEnv: Record<string, string | null> = {};
    for (const key in env) {
      if (env[key] !== undefined) {
        filteredEnv[key] = env[key] as string | null;
      }
    }
    this.launchArgs.env = filteredEnv;
    return this;
  }

  public withConsoleType(
    consoleType: 'internalConsole' | 'integratedTerminal' | 'externalTerminal',
  ): this {
    this.launchArgs.console = consoleType;
    return this;
  }

  public withNoDebug(noDebug: boolean): this {
    this.launchArgs.noDebug = noDebug;
    return this;
  }

  public withAdapterOption(key: string, value: unknown): this {
    if (
      key === 'request' ||
      key === 'type' ||
      key === 'name' ||
      key === 'program'
    ) {
      console.warn(
        `[LaunchArgumentsBuilder] Attempting to set reserved key "${key}" with withAdapterOption. Use dedicated method if available.`,
      );
    }
    this.launchArgs[key] = value;
    return this;
  }

  public build(): DebugProtocol.LaunchRequestArguments {
    if (!this.launchArgs.type) {
      console.warn(
        '[LaunchArgumentsBuilder] Debug type not set. This might be required by the adapter.',
      );
    }
    if (!this.launchArgs.name) {
      this.launchArgs.name = `Debug Session`;
    }
    return this.launchArgs as DebugProtocol.LaunchRequestArguments;
  }
}

function mapStatusToSessionState(status: SessionStatus): ModelSessionState {
  switch (status) {
    case 'pending':
      return ModelSessionState.INITIALIZING;
    case 'initializing':
      return ModelSessionState.INITIALIZING;
    case 'initialized':
      return ModelSessionState.CONFIGURED;
    case 'active':
      return ModelSessionState.RUNNING;
    case 'terminating':
      return ModelSessionState.TERMINATED;
    case 'terminated':
      return ModelSessionState.TERMINATED;
    default:
      return ModelSessionState.INITIALIZING;
  }
}

/**
 * Tool handler for starting a debug session
 */
export async function handleStartDebugSession(
  sessionProvider: SessionProvider,
  args: StartDebugSessionArgs,
): Promise<{
  sessionId: string;
  sessionInfo: ModelSessionInfo;
  stoppedEvent?: DebugProtocol.StoppedEvent['body'];
}> {
  try {
    const logger = sessionProvider.getLogger();
    // Runtime validation of targetType against available adapters
    const { adapters: availableAdapterConfigs } = await handleListAdapters(
      sessionProvider,
      {} as ListAdapterConfigsArgs,
    );
    const availableAdapterTypes = availableAdapterConfigs.map(
      (config) => config.type,
    );

    const targetTypeToUse = args.targetType || 'python';

    if (!availableAdapterTypes.includes(targetTypeToUse)) {
      logger.warn(
        `[handleStartDebugSession] Unsupported targetType: '${targetTypeToUse}'. Available: ${availableAdapterTypes.join(', ')}`,
      );
      throw new McpErrorBuilder()
        .error(
          new Error(
            `Unsupported targetType: '${targetTypeToUse}'. Available types are: ${availableAdapterTypes.join(', ')}.`,
          ),
        )
        .toolName('start_debug_session')
        .mcpErrorCode(ErrorCode.InvalidParams)
        .mcpDebugErrorType('invalid_tool_arguments')
        .sessionProvider(sessionProvider)
        .additionalDebugData({
          problemDetail: `Unsupported targetType: '${targetTypeToUse}'. Requested: '${targetTypeToUse}', Available: ${availableAdapterTypes.join(', ')}. Please use one of the available types.`,
        })
        .build();
    }
    logger.info(
      `[handleStartDebugSession] targetType '${targetTypeToUse}' validated against available adapters: ${availableAdapterTypes.join(', ')}.`,
    );

    // Validate required arguments (targetPath is primary here)
    validateRequiredToolArgs(
      args,
      [{ key: 'targetPath', type: 'string' }],
      'start_debug_session',
      sessionProvider,
      undefined,
    );

    if (!args.targetPath || !path.isAbsolute(args.targetPath)) {
      throw new McpErrorBuilder()
        .error(
          new Error(
            'Missing, invalid, or relative targetPath from MCP call. An absolute path is required.',
          ),
        )
        .toolName('start_debug_session')
        .mcpErrorCode(ErrorCode.InvalidParams)
        .mcpDebugErrorType('invalid_tool_arguments')
        .sessionProvider(sessionProvider)
        .additionalDebugData({
          argumentName: 'targetPath',
          problemDetail:
            'Missing, invalid, or relative targetPath. An absolute path is required.',
          receivedPath: args.targetPath,
        })
        .build();
    }
    const launchArgs = new LaunchArgumentsBuilder(args)
      .withDebugType(targetTypeToUse)
      .withRequestType('launch')
      .build();

    const edcSessionManager = sessionProvider.getSessionManager();
    const dapHandler = await edcSessionManager.startSession(
      targetTypeToUse,
      launchArgs,
      'launch',
    );

    const sessionId = dapHandler.sessionId;
    const startTime = new Date();

    const debugSession = sessionProvider.createDebugSession(
      dapHandler,
      targetTypeToUse,
      args.targetPath,
      logger,
    );
    sessionProvider.storeDebugSession(
      sessionId,
      debugSession,
      startTime,
      targetTypeToUse,
      args.targetPath,
    );
    const sessionInfo: ModelSessionInfo = {
      id: sessionId,
      targetType: targetTypeToUse,
      targetPath: args.targetPath,
      state: mapStatusToSessionState(dapHandler.status),
      startTime: startTime,
    };

    let stoppedEventBody: DebugProtocol.StoppedEvent['body'] | undefined;

    if (args.stopOnEntry) {
      logger.info(
        `[handleStartDebugSession] stopOnEntry is true for session ${sessionId}. Waiting for initial 'stopped' (entry) event...`,
      );
      try {
        stoppedEventBody = await new Promise<
          DebugProtocol.StoppedEvent['body']
        >((resolve, reject) => {
          const timeout = setTimeout(() => {
            dapHandler.off('stopped', entryStopListener);
            reject(
              new Error(
                `Timeout waiting for initial 'stopped' (entry) event for session ${sessionId}`,
              ),
            );
          }, DAP_DEFAULT_EVENT_TIMEOUT_MS);

          const entryStopListener = (
            eventBody: DebugProtocol.StoppedEvent['body'],
          ) => {
            if (eventBody.reason === 'entry' || eventBody.reason === 'step') {
              logger.info(
                `[handleStartDebugSession] Received initial 'stopped' event for session ${sessionId}:`,
                eventBody,
              );
              clearTimeout(timeout);
              dapHandler.off('stopped', entryStopListener);
              resolve(eventBody);
            } else {
              logger.debug(
                `[handleStartDebugSession] Received 'stopped' event for session ${sessionId} with reason '${eventBody.reason}', waiting for 'entry'.`,
              );
            }
          };
          dapHandler.on('stopped', entryStopListener);
        });
      } catch (eventErrorUnknown: unknown) {
        const eventErrorMessage =
          eventErrorUnknown instanceof Error
            ? eventErrorUnknown.message
            : String(eventErrorUnknown);
        logger.warn(
          `[handleStartDebugSession] Error or timeout waiting for initial 'stopped' event for session ${sessionId}: ${eventErrorMessage}`,
        );
      }
    }

    return { sessionId, sessionInfo, stoppedEvent: stoppedEventBody };
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName('start_debug_session')
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .build();
  }
}

/**
 * Tool handler for setting a breakpoint
 */
export async function handleSetBreakpoint(
  sessionProvider: SessionProvider,
  args: SetBreakpointArgs,
): Promise<ModelBreakpointResult> {
  try {
    validateRequiredToolArgs(
      args as unknown as Record<string, unknown>,
      [
        { key: 'sessionId', type: 'string' },
        { key: 'filePath', type: 'string' },
        { key: 'lineNumber', type: 'number' },
      ],
      'set_breakpoint',
      sessionProvider,
      args.sessionId,
    );

    const debugSession = await getActiveDebugSessionOrThrow(
      sessionProvider,
      args.sessionId,
      'set_breakpoint',
    );

    const configBuilder = new BreakpointConfigBuilder(
      args.filePath!,
      args.lineNumber!,
    );

    const resultFromDebugger: BreakpointResult =
      await debugSession.setBreakpoint(configBuilder.build());

    return {
      breakpointId: resultFromDebugger.id,
      verified: resultFromDebugger.verified,
      line: resultFromDebugger.line,
      message: resultFromDebugger.message,
    };
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName('set_breakpoint')
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .sessionId(args.sessionId)
      .build();
  }
}

/**
 * Tool handler for evaluating an expression
 */
export async function handleEvaluateExpression(
  sessionProvider: SessionProvider,
  args: EvaluateExpressionArgs,
): Promise<ModelEvaluationResult> {
  try {
    validateRequiredToolArgs(
      args as unknown as Record<string, unknown>,
      [
        { key: 'sessionId', type: 'string' },
        { key: 'expression', type: 'string' },
      ],
      'evaluate_expression',
      sessionProvider,
      args.sessionId,
    );

    const debugSession = await getActiveDebugSessionOrThrow(
      sessionProvider,
      args.sessionId,
      'evaluate_expression',
    );

    const validContexts = ['watch', 'repl', 'hover'];
    const evaluationContext =
      args.context && validContexts.includes(args.context)
        ? (args.context as 'watch' | 'repl' | 'hover')
        : 'repl';

    const resultFromDebugger: EvaluationResult =
      await debugSession.evaluateExpression(
        args.expression!,
        args.frameId,
        evaluationContext,
      );

    return {
      result: resultFromDebugger.result,
      type: resultFromDebugger.type,
      variablesReference: resultFromDebugger.variablesReference,
      namedVariables: resultFromDebugger.namedVariables,
      indexedVariables: resultFromDebugger.indexedVariables,
    };
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName('evaluate_expression')
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .sessionId(args.sessionId)
      .build();
  }
}

/**
 * Tool handler for getting variables
 */
export async function handleGetVariables(
  sessionProvider: SessionProvider,
  args: GetVariablesArgs,
): Promise<ModelVariable[]> {
  try {
    validateRequiredToolArgs(
      args as unknown as Record<string, unknown>,
      [
        { key: 'sessionId', type: 'string' },
        { key: 'variablesReference', type: 'number' },
      ],
      'get_variables',
      sessionProvider,
      args.sessionId,
    );

    const debugSession = await getActiveDebugSessionOrThrow(
      sessionProvider,
      args.sessionId,
      'get_variables',
    );

    const variablesFromDebugger: DebugProtocol.Variable[] =
      await debugSession.getVariables(args.variablesReference!);

    return variablesFromDebugger.map((v: DebugProtocol.Variable) => ({
      name: v.name,
      value: v.value,
      type: v.type,
      variablesReference: v.variablesReference,
      namedVariables: v.namedVariables,
      indexedVariables: v.indexedVariables,
    }));
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName('get_variables')
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .sessionId(args.sessionId)
      .build();
  }
}

/**
 * Tool handler for getting the call stack
 */
export async function handleGetCallStack(
  sessionProvider: SessionProvider,
  args: GetCallStackArgs,
): Promise<ModelStackFrame[]> {
  try {
    validateRequiredToolArgs(
      args as unknown as Record<string, unknown>,
      [{ key: 'sessionId', type: 'string' }],
      'get_call_stack',
      sessionProvider,
      args.sessionId,
    );

    const localSessionId = args.sessionId!;

    const debugSession = await getActiveDebugSessionOrThrow(
      sessionProvider,
      localSessionId,
      'get_call_stack',
    );

    const targetThreadId = await _resolveTargetThreadId(
      sessionProvider,
      localSessionId,
      args.threadId,
      'get_call_stack',
      false, // For get_call_stack, a stopped thread is preferred but not strictly required
    );

    const stackFramesFromDebugger =
      await debugSession.getCallStack(targetThreadId);

    return stackFramesFromDebugger.map((sf) =>
      mapDebuggerStackFrameToModel(sf, targetThreadId),
    );
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName('get_call_stack')
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .sessionId(args.sessionId)
      .build();
  }
}

/**
 * Tool handler for continuing execution
 */
export async function handleContinue(
  sessionProvider: SessionProvider,
  args: ContinueArgs,
): Promise<HandleContinueResult> {
  const toolName = 'continue';
  try {
    validateRequiredToolArgs(
      args as unknown as Record<string, unknown>,
      [{ key: 'sessionId', type: 'string' }],
      toolName,
      sessionProvider,
      args.sessionId,
    );

    const debugSession = await getActiveDebugSessionOrThrow(
      sessionProvider,
      args.sessionId,
      toolName,
      false,
    );

    const dapHandler = sessionProvider.getDAPSessionHandler(args.sessionId!);
    if (!dapHandler) {
      throw new McpErrorBuilder()
        .error(
          new Error(
            `DAPSessionHandler not available for session ${args.sessionId}`,
          ),
        )
        .toolName(toolName)
        .mcpErrorCode(ErrorCode.InternalError)
        .mcpDebugErrorType('dap_handler_not_found')
        .sessionProvider(sessionProvider)
        .sessionId(args.sessionId)
        .build();
    }

    const outputEvents: DebugProtocol.OutputEvent['body'][] = [];

    const outputListener = (eventBody: DebugProtocol.OutputEvent['body']) => {
      outputEvents.push(eventBody);
    };
    dapHandler.on('output', outputListener);

    // Before sending 'continue', set up listeners.
    // The session might stop again, or it might terminate.
    const stoppedPromise = _waitForStoppedEventAfterStep(
      dapHandler,
      toolName,
      args.sessionId!,
      sessionProvider.getLogger(),
      DAP_DEFAULT_EVENT_TIMEOUT_MS,
    );

    const terminatedPromise = new Promise<TerminatedEventInfo | undefined>(
      (resolve) => {
        const timeout = setTimeout(() => {
          dapHandler.off('sessionEnded', listener);
          resolve(undefined);
        }, DAP_TERMINATION_RACE_TIMEOUT_MS);

        const listener = (payload?: {
          exitCode?: number;
          signal?: string;
          error?: Error;
        }) => {
          clearTimeout(timeout);
          dapHandler.off('sessionEnded', listener);
          resolve({
            terminated: true,
            exitCode: payload?.exitCode,
            signal: payload?.signal,
            error: payload?.error,
          });
        };
        dapHandler.once('sessionEnded', listener);
      },
    );

    await debugSession.continue(args.threadId);

    // Wait for either a stopped event or a terminated event
    const raceResult = await Promise.race([
      stoppedPromise.then(
        (event) =>
          ({ type: 'stopped', event }) as {
            type: 'stopped';
            event: DebugProtocol.StoppedEvent['body'] | undefined;
          },
      ),
      terminatedPromise.then(
        (event) =>
          ({ type: 'terminated', event }) as {
            type: 'terminated';
            event: TerminatedEventInfo | undefined;
          },
      ),
    ]);

    let stoppedEvent: DebugProtocol.StoppedEvent['body'] | undefined;
    let terminatedEventInfo: TerminatedEventInfo | undefined;
    let topStackFrame: ModelStackFrame | undefined;

    if (raceResult.type === 'stopped' && raceResult.event) {
      stoppedEvent = raceResult.event;
      sessionProvider
        .getLogger()
        .info(
          `[${toolName}] Session ${args.sessionId} stopped. Reason: ${
            stoppedEvent.reason
          }`,
        );
      try {
        const stackFrames = await debugSession.getCallStack(
          stoppedEvent.threadId as number,
        );
        if (stackFrames.length > 0) {
          const topFrameFromDebugger = stackFrames[0];
          topStackFrame = mapDebuggerStackFrameToModel(
            topFrameFromDebugger,
            stoppedEvent.threadId,
          );
        }
      } catch (e) {
        sessionProvider
          .getLogger()
          .warn(
            `[${toolName}] Error getting stack frame for location after continue: ${
              (e as Error).message
            }`,
          );
      }
    } else if (raceResult.type === 'terminated' && raceResult.event) {
      terminatedEventInfo = raceResult.event;
      sessionProvider
        .getLogger()
        .info(
          `[${toolName}] Session ${
            args.sessionId
          } terminated after continue. ExitCode: ${
            terminatedEventInfo.exitCode
          }, Signal: ${terminatedEventInfo.signal}`,
        );
    } else {
      sessionProvider
        .getLogger()
        .info(
          `[${toolName}] Session ${
            args.sessionId
          } continued. It might be running or the 'stopped' event timed out (indicating it's running).`,
        );
    }
    dapHandler.off('output', outputListener);
    const sessionState = mapStatusToSessionState(dapHandler.status);

    return {
      success: true,
      sessionState,
      stoppedEvent,
      outputEvents,
      terminatedEvent: terminatedEventInfo,
      topStackFrame,
    };
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName('continue')
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .sessionId(args.sessionId)
      .build();
  }
}

/**
 * Tool handler for stepping over
 */
export async function handleStepOver(
  sessionProvider: SessionProvider,
  args: StepOverArgs,
): Promise<HandleStepOverResult> {
  const toolName = 'step_over';
  try {
    validateRequiredToolArgs(
      args as unknown as Record<string, unknown>,
      [{ key: 'sessionId', type: 'string' }],
      toolName,
      sessionProvider,
      args.sessionId,
    );
    const localSessionId = args.sessionId!;

    const debugSession = await getActiveDebugSessionOrThrow(
      sessionProvider,
      localSessionId,
      toolName,
    );
    const dapHandler = sessionProvider.getDAPSessionHandler(localSessionId);
    if (!dapHandler) {
      throw new McpErrorBuilder()
        .error(
          new Error(
            `DAPSessionHandler not available for session ${localSessionId} in ${toolName}`,
          ),
        )
        .toolName(toolName)
        .mcpErrorCode(ErrorCode.InternalError)
        .mcpDebugErrorType('dap_handler_not_found')
        .sessionProvider(sessionProvider)
        .sessionId(localSessionId)
        .build();
    }

    const targetThreadId = await _resolveTargetThreadId(
      sessionProvider,
      localSessionId,
      args.threadId,
      toolName,
      true, // Step operations require a stopped thread
    );

    _ensureThreadIsStopped(
      dapHandler,
      targetThreadId,
      toolName,
      localSessionId,
      sessionProvider,
    );

    const stepResult = await _performStepOperation(
      toolName,
      debugSession,
      dapHandler,
      targetThreadId,
      sessionProvider,
      localSessionId,
      async (thrId: number) => debugSession.stepOver(thrId),
    );

    return {
      success:
        !!stepResult.stoppedEvent &&
        !stepResult.error &&
        !stepResult.terminatedEvent,
      ...stepResult,
    };
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName(toolName)
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .sessionId(args.sessionId)
      .build();
  }
}

/**
 * Tool handler for terminating a debug session
 */
export async function handleTerminateSession(
  sessionProvider: SessionProvider,
  args: TerminateSessionArgs,
): Promise<HandleTerminateSessionResult> {
  const toolName = 'terminate_session';
  try {
    validateRequiredToolArgs(
      args as unknown as Record<string, unknown>,
      [{ key: 'sessionId', type: 'string' }],
      toolName,
      sessionProvider,
      args.sessionId,
    );

    const debugSession = sessionProvider.getDebugSession(args.sessionId!);
    if (!debugSession) {
      sessionProvider
        .getLogger()
        .warn(
          `[${toolName}] Session ${args.sessionId!} not found. Assuming already terminated or never existed.`,
        );
      return { success: true }; // Session already gone, consider it a success.
    }

    await debugSession.terminate();
    sessionProvider
      .getLogger()
      .info(`[${toolName}] Terminated session ${args.sessionId}.`);
    return { success: true };
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName(toolName)
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .sessionId(args.sessionId)
      .build();
  }
}

/**
 * Tool handler for listing all active debug sessions
 */
export async function handleListSessions(
  sessionProvider: SessionProvider,
  _args: ListSessionsArgs,
): Promise<{ sessions: ModelSessionInfo[] }> {
  try {
    const sessions = sessionProvider.getAllSessionInfo();
    return { sessions };
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName('list_sessions')
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .build();
  }
}

/**
 * Tool handler for listing all registered debug adapter configurations.
 */
/**
 * Tool handler for getting detailed information about a specific debug session
 */
export async function handleGetSessionDetails(
  sessionProvider: SessionProvider,
  args: GetSessionDetailsArgs,
): Promise<HandleGetSessionDetailsResult> {
  try {
    validateRequiredToolArgs(
      args as unknown as Record<string, unknown>,
      [{ key: 'sessionId', type: 'string' }],
      'get_session_details',
      sessionProvider,
      args.sessionId,
    );

    const sessionId = args.sessionId!;
    const logger = sessionProvider.getLogger();
    logger.info(
      `[handleGetSessionDetails] Getting details for session: ${sessionId}`,
    );

    const allSessions = sessionProvider.getAllSessionInfo();
    const modelSessionInfo = allSessions.find((s) => s.id === sessionId);

    if (!modelSessionInfo) {
      throw new McpErrorBuilder()
        .error(new Error(`Debug session not found: ${sessionId}`))
        .toolName('get_session_details')
        .mcpErrorCode(ErrorCode.InvalidRequest)
        .mcpDebugErrorType('session_not_found')
        .sessionProvider(sessionProvider)
        .sessionId(sessionId)
        .build();
    }

    const result: HandleGetSessionDetailsResult = {
      sessionInfo: modelSessionInfo,
      threads: [],
      callStack: [],
      breakpoints: [],
      pendingEventsForSession: sessionProvider.getEventsForSession(sessionId),
    };

    const debugSession = sessionProvider.getDebugSession(sessionId);
    const dapHandler = sessionProvider.getDAPSessionHandler(sessionId);

    if (debugSession && dapHandler) {
      try {
        const threadsFromDapHandler = dapHandler.getThreads();
        result.threads = threadsFromDapHandler.map(
          (t): ModelThread => ({
            id: t.id,
            name: t.name,
          }),
        );

        if (threadsFromDapHandler && threadsFromDapHandler.length > 0) {
          let stoppedThreadId: number | undefined = undefined;
          for (const debugThread of threadsFromDapHandler) {
            if (debugThread.stoppedDetails) {
              stoppedThreadId = debugThread.id;
              logger.info(
                `[handleGetSessionDetails] Thread ${stoppedThreadId} is stopped.`,
              );
              break;
            }
          }

          if (stoppedThreadId !== undefined) {
            logger.info(
              `[handleGetSessionDetails] Session ${sessionId} has a stopped thread (${stoppedThreadId}). Attempting to get call stack.`,
            );
            const callStackFromDebugSession =
              await debugSession.getCallStack(stoppedThreadId);

            result.callStack = callStackFromDebugSession.map((frame) => {
              const modelFrame = mapDebuggerStackFrameToModel(
                frame,
                stoppedThreadId,
              );
              return modelFrame;
            });
          }
        }
      } catch (err) {
        logger.warn(
          `[handleGetSessionDetails] Error fetching dynamic details for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Do not re-throw; return basic info if dynamic parts fail
      }
    } else {
      logger.info(
        `[handleGetSessionDetails] No active debugSession or dapHandler for session ${sessionId}, returning basic info.`,
      );
    }

    return result;
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    const toolName = 'get_session_details';
    throw new McpErrorBuilder()
      .error(error)
      .toolName(toolName)
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .sessionId(args.sessionId)
      .build();
  }
}

export async function handleStepIn(
  sessionProvider: SessionProvider,
  args: StepInArgs,
): Promise<HandleStepInResult> {
  const toolName = 'step_in';
  try {
    validateRequiredToolArgs(
      args as unknown as Record<string, unknown>,
      [{ key: 'sessionId', type: 'string' }],
      toolName,
      sessionProvider,
      args.sessionId,
    );
    const localSessionId = args.sessionId!;

    const debugSession = await getActiveDebugSessionOrThrow(
      sessionProvider,
      localSessionId,
      toolName,
    );
    const dapHandler = sessionProvider.getDAPSessionHandler(localSessionId);
    if (!dapHandler) {
      throw new McpErrorBuilder()
        .error(
          new Error(
            `DAPSessionHandler not available for session ${localSessionId} in ${toolName}`,
          ),
        )
        .toolName(toolName)
        .mcpErrorCode(ErrorCode.InternalError)
        .mcpDebugErrorType('dap_handler_not_found')
        .sessionProvider(sessionProvider)
        .sessionId(localSessionId)
        .build();
    }

    const targetThreadId = await _resolveTargetThreadId(
      sessionProvider,
      localSessionId,
      args.threadId,
      toolName,
      true, // Step operations require a stopped thread
    );

    _ensureThreadIsStopped(
      dapHandler,
      targetThreadId,
      toolName,
      localSessionId,
      sessionProvider,
    );

    const stepResult = await _performStepOperation(
      toolName,
      debugSession,
      dapHandler,
      targetThreadId,
      sessionProvider,
      localSessionId,
      async (thrId: number) => debugSession.stepInto(thrId),
    );

    return {
      success:
        !!stepResult.stoppedEvent &&
        !stepResult.error &&
        !stepResult.terminatedEvent,
      ...stepResult,
    };
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName(toolName)
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .sessionId(args.sessionId)
      .build();
  }
}

export async function handleStepOut(
  sessionProvider: SessionProvider,
  args: StepOutArgs,
): Promise<HandleStepOutResult> {
  const toolName = 'step_out';
  try {
    validateRequiredToolArgs(
      args as unknown as Record<string, unknown>,
      [{ key: 'sessionId', type: 'string' }],
      toolName,
      sessionProvider,
      args.sessionId,
    );
    const localSessionId = args.sessionId!;

    const debugSession = await getActiveDebugSessionOrThrow(
      sessionProvider,
      localSessionId,
      toolName,
    );
    const dapHandler = sessionProvider.getDAPSessionHandler(localSessionId);
    if (!dapHandler) {
      throw new McpErrorBuilder()
        .error(
          new Error(
            `DAPSessionHandler not available for session ${localSessionId} in ${toolName}`,
          ),
        )
        .toolName(toolName)
        .mcpErrorCode(ErrorCode.InternalError)
        .mcpDebugErrorType('dap_handler_not_found')
        .sessionProvider(sessionProvider)
        .sessionId(localSessionId)
        .build();
    }

    const targetThreadId = await _resolveTargetThreadId(
      sessionProvider,
      localSessionId,
      args.threadId,
      toolName,
      true, // Step operations require a stopped thread
    );

    _ensureThreadIsStopped(
      dapHandler,
      targetThreadId,
      toolName,
      localSessionId,
      sessionProvider,
    );

    const stepResult = await _performStepOperation(
      toolName,
      debugSession,
      dapHandler,
      targetThreadId,
      sessionProvider,
      localSessionId,
      async (thrId: number) => debugSession.stepOut(thrId),
    );

    return {
      success:
        !!stepResult.stoppedEvent &&
        !stepResult.error &&
        !stepResult.terminatedEvent,
      ...stepResult,
    };
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName(toolName)
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .sessionId(args.sessionId)
      .build();
  }
}

export async function handleListAdapters(
  sessionProvider: SessionProvider,
  _args: ListAdapterConfigsArgs,
): Promise<{ adapters: { type: string; config: Partial<AdapterConfig> }[] }> {
  try {
    const edcSessionManager = sessionProvider.getSessionManager();
    const configsMapToUse = edcSessionManager.adapterConfigurations;

    if (!configsMapToUse || !(configsMapToUse instanceof Map)) {
      sessionProvider
        .getLogger()
        .warn(
          '[handleListAdapters] Could not retrieve adapter configurations from SessionManager or it is not a Map.',
        );
      return { adapters: [] };
    }

    const adapters: { type: string; config: Partial<AdapterConfig> }[] = [];
    configsMapToUse.forEach((config: AdapterConfig, type: string) => {
      adapters.push({
        type,
        config: {
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
        },
      });
    });

    return { adapters };
  } catch (error: unknown) {
    if (error instanceof McpError) throw error;
    throw new McpErrorBuilder()
      .error(error)
      .toolName('list_adapters')
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType('tool_internal_error')
      .sessionProvider(sessionProvider)
      .build();
  }
}
