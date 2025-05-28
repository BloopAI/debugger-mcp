#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  StreamableHTTPServerTransport,
  StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as http from 'http';
import * as path from 'path';
import { randomUUID } from 'crypto';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
  SessionInfo as ModelSessionInfo,
  SessionState as ModelSessionState,
  WrappedDebugSession,
} from './types';
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
  AnyToolArgs,
} from './types/toolArgs';
import {
  HandleStartDebugSessionResult,
  HandleSetBreakpointResult,
  HandleEvaluateExpressionResult,
  HandleGetVariablesResult,
  HandleGetCallStackResult,
  HandleContinueResult,
  HandleStepOverResult,
  HandleTerminateSessionResult,
  HandleListSessionsResult,
  HandleListAdaptersResult,
  HandleGetPendingAsyncEventsResult,
  HandleGetSessionDetailsResult,
  HandleStepInResult,
  HandleStepOutResult,
  AnyToolResult,
} from './types/toolResults';
import {
  McpDebugErrorData,
  McpAsyncEvent,
  McpAsyncEventType,
} from './types/mcp_protocol_extensions';
import {
  SessionManager,
  DebugSession,
  DAPSessionHandler,
  LoggerInterface,
  SessionStatus,
  AdapterConfig,
  AdapterConfigLoader,
  AdapterProcessError,
  DAPRequestError,
} from '@bloopai/ergonomic-debugger-client';

import {
  handleStartDebugSession,
  handleSetBreakpoint,
  handleEvaluateExpression,
  handleGetVariables,
  handleGetCallStack,
  handleContinue,
  handleStepOver,
  handleStepIn,
  handleStepOut,
  handleTerminateSession,
  handleListSessions,
  SessionProvider,
  handleListAdapters,
  handleGetPendingAsyncEvents,
  handleGetSessionDetails,
} from './tools';
import { McpErrorBuilder } from './errorUtils';
import {
  startDebugSessionSchema,
  setBreakpointSchema,
  evaluateExpressionSchema,
  getVariablesSchema,
  getCallStackSchema,
  continueSchema,
  stepOverSchema,
  terminateSessionSchema,
  listSessionsSchema,
  listAdaptersSchema,
  getPendingAsyncEventsSchema,
  getSessionDetailsSchema,
  stepInSchema,
  stepOutSchema,
} from './schemas';

// Constants for HTTP and JSON-RPC
const MCP_HTTP_ENDPOINT = '/mcp';
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE = 415;

const JSONRPC_ERROR_METHOD_NOT_FOUND = -32601;
const JSONRPC_ERROR_PARSE_ERROR = -32700;
const JSONRPC_ERROR_INVALID_REQUEST = -32600;

// Union type for all possible tool schemas
type AnyToolSchema =
  | typeof startDebugSessionSchema
  | typeof setBreakpointSchema
  | typeof evaluateExpressionSchema
  | typeof getVariablesSchema
  | typeof getCallStackSchema
  | typeof continueSchema
  | typeof stepOverSchema
  | typeof terminateSessionSchema
  | typeof listSessionsSchema
  | typeof listAdaptersSchema
  | typeof getPendingAsyncEventsSchema
  | typeof getSessionDetailsSchema
  | typeof stepInSchema
  | typeof stepOutSchema;

interface McpToolResponsePayload extends Record<string, unknown> {
  asyncEvents: McpAsyncEvent[];
  success?: boolean;
  value?: unknown;
}

type ToolHandler<
  TArgs extends AnyToolArgs,
  TResult extends AnyToolResult | void,
> = (sessionProvider: SessionProvider, args: TArgs) => Promise<TResult>;

interface ToolRegistryEntry<
  TArgs extends AnyToolArgs,
  TResult extends AnyToolResult | void,
> {
  description: string;
  schema: AnyToolSchema;
  handler: ToolHandler<TArgs, TResult>;
}

const toolRegistry = new Map<
  string,
  ToolRegistryEntry<AnyToolArgs, AnyToolResult | void>
>();

function registerTool<
  TArgs extends AnyToolArgs,
  TResult extends AnyToolResult | void,
>(
  name: string,
  description: string,
  schema: AnyToolSchema,
  handler: ToolHandler<TArgs, TResult>,
) {
  toolRegistry.set(name, {
    description,
    schema,
    handler: handler as ToolHandler<AnyToolArgs, AnyToolResult | void>,
  });
}

/**
 * AI Debugger MCP Server
 *
 * Provides debugging capabilities to AI agents through the Model Context Protocol (MCP)
 */
export class InteractiveDebuggerMcpServer implements SessionProvider {
  private server: Server;
  private readonly serverInfo: { name: string; version: string };
  private edcSessionManager: SessionManager;
  private logger: LoggerInterface;
  private activeSessions: Map<string, WrappedDebugSession> = new Map();
  private asyncEventQueue: McpAsyncEvent[] = [];
  private readonly MAX_ASYNC_EVENT_QUEUE_SIZE = 100;

  constructor() {
    this.serverInfo = { name: 'interactive-debugger', version: '0.1.0' };
    this.server = new Server(this.serverInfo, {
      capabilities: { resources: {}, tools: {} },
    });

    this.logger = this._createLogger();
    this.edcSessionManager = new SessionManager(this.logger, {});
    this._loadAdapterConfigurations();
    this._initializeServerComponents();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', this.handleShutdown.bind(this));
  }

  private _createLogger(): LoggerInterface {
    const createChildLogger = (
      parentContext: Record<string, unknown> = {},
    ): LoggerInterface => {
      return {
        trace: (...args: unknown[]) =>
          console.error('[TRACE]', JSON.stringify(parentContext), ...args),
        debug: (...args: unknown[]) =>
          console.error('[DEBUG]', JSON.stringify(parentContext), ...args),
        info: (...args: unknown[]) =>
          console.error('[INFO]', JSON.stringify(parentContext), ...args),
        warn: (...args: unknown[]) =>
          console.warn('[WARN]', JSON.stringify(parentContext), ...args),
        error: (...args: unknown[]) =>
          console.error('[ERROR]', JSON.stringify(parentContext), ...args),
        child: (options: Record<string, unknown>): LoggerInterface => {
          const newContext = { ...parentContext, ...options };
          return createChildLogger(newContext); // Recursively create a new logger with the new context
        },
      };
    };
    return createChildLogger();
  }

  private _loadAdapterConfigurations(): void {
    const adapterConfigLoader = new AdapterConfigLoader(this.logger);
    const mergedAdapterConfigs = new Map<string, AdapterConfig>();

    // Load default configurations
    const defaultConfigsPath = path.join(
      __dirname,
      'config',
      'defaultAdapterConfigs.json',
    );
    try {
      this.logger.info(
        `Loading default adapter configurations from: ${defaultConfigsPath}`,
      );
      const defaultConfigs =
        adapterConfigLoader.loadFromFile(defaultConfigsPath);
      defaultConfigs.forEach((config: AdapterConfig) => {
        mergedAdapterConfigs.set(config.type, config);
      });
      this.logger.info(
        `Loaded ${defaultConfigs.length} default adapter configurations.`,
      );
    } catch (error) {
      this.logger.warn(
        `Could not load default adapter configurations from ${defaultConfigsPath}. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Process CLI arguments and merge user configurations
    this._processCliArgumentsAndMergeConfigs(
      adapterConfigLoader,
      mergedAdapterConfigs,
    );

    // Register final configurations
    if (mergedAdapterConfigs.size > 0) {
      this.logger.info(
        `Registering ${mergedAdapterConfigs.size} final adapter configurations with SessionManager.`,
      );
      mergedAdapterConfigs.forEach((config) => {
        this.edcSessionManager.registerAdapterConfiguration(config);
      });
    } else {
      this.logger.warn(
        'No adapter configurations were loaded or defined. Debugging functionality might be limited.',
      );
    }
  }

  private _processCliArgumentsAndMergeConfigs(
    adapterConfigLoader: AdapterConfigLoader,
    mergedAdapterConfigs: Map<string, AdapterConfig>,
  ): void {
    const cliArgs = yargs(hideBin(process.argv))
      .option('adapter-config', {
        alias: 'ac',
        type: 'string',
        description:
          'Path to a custom adapter configurations JSON file (overrides defaults)',
      })
      .help(false)
      .version(false)
      .parseSync();

    if (cliArgs.adapterConfig) {
      const userConfigPath = cliArgs.adapterConfig;
      try {
        this.logger.info(
          `Loading user-defined adapter configurations from: ${userConfigPath}`,
        );
        const userConfigs = adapterConfigLoader.loadFromFile(userConfigPath);
        userConfigs.forEach((config: AdapterConfig) => {
          this.logger.info(
            `User config for '${config.type}' will override default if present.`,
          );
          mergedAdapterConfigs.set(config.type, config);
        });
        this.logger.info(
          `Loaded and merged ${userConfigs.length} user-defined adapter configurations.`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to load user-defined adapter configurations from ${userConfigPath}. Error: ${error instanceof Error ? error.message : String(error)}. Proceeding with defaults (if any).`,
        );
      }
    } else {
      this.logger.info(
        'No custom adapter configuration file provided via CLI. Using defaults (if loaded).',
      );
    }
  }

  private _initializeServerComponents(): void {
    this.initializeTools();
    this.setupToolHandlers();
  }

  private async handleShutdown() {
    console.error('Shutting down AI Debugger MCP Server (SIGINT)...');
    await this.edcSessionManager.disposeAllSessions();
    this.activeSessions.clear();
    if (this.server) {
      await this.server.close();
    }
    console.error('AI Debugger MCP Server shutdown complete.');
    process.exit(0);
  }

  public getServerInstance(): Server {
    return this.server;
  }

  public getSessionManager(): SessionManager {
    return this.edcSessionManager;
  }

  public getDebugSession(sessionId: string): DebugSession | undefined {
    this.logger.info(
      `[getDebugSession] Attempting to retrieve session with ID: ${sessionId}. Current active session IDs: ${Array.from(this.activeSessions.keys()).join(', ')}`,
    );
    const wrappedSession = this.activeSessions.get(sessionId);
    if (!wrappedSession) {
      this.logger.warn(
        `[getDebugSession] Session not found for ID: ${sessionId}`,
      );
      return undefined;
    }
    this.logger.info(`[getDebugSession] Session found for ID: ${sessionId}`);
    return wrappedSession?.originalSession;
  }

  public getDAPSessionHandler(
    sessionId: string,
  ): DAPSessionHandler | undefined {
    this.logger.info(
      `[getDAPSessionHandler] Attempting to retrieve DAPSessionHandler for session ID: ${sessionId}.`,
    );
    const wrappedSession = this.activeSessions.get(sessionId);
    if (!wrappedSession) {
      this.logger.warn(
        `[getDAPSessionHandler] No WrappedDebugSession found for ID: ${sessionId}`,
      );
      return undefined;
    }
    const dapHandler = wrappedSession.dapSessionHandler;
    if (!dapHandler) {
      this.logger.warn(
        `[getDAPSessionHandler] WrappedDebugSession for ID: ${sessionId} does not have a DAPSessionHandler.`,
      );
    }
    return dapHandler;
  }

  public createDebugSession(
    dapHandler: DAPSessionHandler,
    targetType: string,
    targetPath: string,
    logger: LoggerInterface,
  ): DebugSession {
    return new DebugSession(targetType, targetPath, dapHandler, logger);
  }

  public storeDebugSession(
    mcpSessionId: string,
    session: DebugSession,
    startTime: Date,
    targetType: string,
    targetPath: string,
  ): void {
    this.logger.info(
      `[storeDebugSession] Storing session with MCP ID: ${mcpSessionId} (DebugClientSession ID: ${session.id}), Type: ${targetType}, Path: ${targetPath}`,
    );
    const wrappedSession = new WrappedDebugSession(
      mcpSessionId,
      session,
      targetType,
      targetPath,
      startTime,
      this.logger,
    );
    this.activeSessions.set(mcpSessionId, wrappedSession);
    this.logger.info(
      `[storeDebugSession] Session ${mcpSessionId} stored. Current active session IDs: ${Array.from(this.activeSessions.keys()).join(', ')}`,
    );

    const dapHandler = wrappedSession.dapSessionHandler;
    this.logger.debug(
      `[storeDebugSession] Setting up event handlers for session ${mcpSessionId}. DapHandler: ${!!dapHandler}`,
    );
    if (dapHandler && typeof dapHandler.on === 'function') {
      dapHandler.on('sessionEnded', (payload) => {
        this.logger.info(
          `[DAPEvent] SessionEnded for mcpSessionId: ${mcpSessionId}, dcSessionId: ${payload.sessionId}. Reason: ${payload.reason}`,
        );

        const wasActive = this.activeSessions.delete(mcpSessionId);
        if (wasActive) {
          this.logger.info(
            `[storeDebugSession - dapHandler.on('sessionEnded')] Session ${mcpSessionId} removed from activeSessions.`,
          );
        } else {
          this.logger.warn(
            `[storeDebugSession - dapHandler.on('sessionEnded')] Session ${mcpSessionId} was already removed or not found when 'sessionEnded' received.`,
          );
        }

        this._queueAsyncEvent(mcpSessionId, 'unexpected_session_termination', {
          reason: payload.reason,
          restart: payload.restart,
          underlyingError: payload.underlyingError,
          exitCode: payload.exitCode,
          signal: payload.signal,
        });
      });

      dapHandler.on('error', (payload: { sessionId: string; error: Error }) => {
        if (payload.sessionId === session.id) {
          this.logger.error(
            `[storeDebugSession - dapHandler.on('error')] Received for debugClientSessionId: ${payload.sessionId} (MCP ID: ${mcpSessionId})`,
            payload.error,
          );
          this._queueAsyncEvent(mcpSessionId, 'dap_session_handler_error', {
            message: payload.error.message,
            name: payload.error.name,
            stack: payload.error.stack,
          });
        }
      });

      dapHandler.on('output', (payload) => {
        if (payload.sessionId === mcpSessionId) {
          this.logger.debug(
            `[DAPEvent] Output for mcpSessionId: ${mcpSessionId}, dcSessionId: ${payload.sessionId}, category: ${payload.category}`,
          );
          this._queueAsyncEvent(mcpSessionId, 'dap_event_output', {
            category: payload.category,
            output: payload.output,
            data: payload.data,
          });
        }
      });
      dapHandler.on('stopped', (payload) => {
        if (payload.sessionId === mcpSessionId) {
          this._queueAsyncEvent(mcpSessionId, 'dap_event_stopped', payload);
        }
      });
      dapHandler.on('continued', (payload) => {
        if (payload.sessionId === mcpSessionId) {
          this._queueAsyncEvent(mcpSessionId, 'dap_event_continued', payload);
        }
      });
      dapHandler.on(
        'threadAdded',
        (payload: {
          sessionId: string;
          threadId: number;
          threadName: string;
        }) => {
          if (payload.sessionId === mcpSessionId) {
            this._queueAsyncEvent(mcpSessionId, 'dap_event_thread', {
              event: 'started',
              ...payload,
            });
          }
        },
      );
      dapHandler.on(
        'threadRemoved',
        (payload: { sessionId: string; threadId: number; reason?: string }) => {
          if (payload.sessionId === mcpSessionId) {
            this._queueAsyncEvent(mcpSessionId, 'dap_event_thread', {
              event: 'exited',
              ...payload,
            });
          }
        },
      );
      dapHandler.on('capabilitiesUpdated', (payload) => {
        if (payload.sessionId === mcpSessionId) {
          this._queueAsyncEvent(
            mcpSessionId,
            'dap_event_capabilities',
            payload,
          );
        }
      });
      // Add more listeners as defined in McpAsyncEventType and DAPSessionHandlerEvents.
    }
  }

  private _queueAsyncEvent(
    sessionId: string,
    eventType: McpAsyncEventType,
    data: unknown,
  ): void {
    if (this.asyncEventQueue.length >= this.MAX_ASYNC_EVENT_QUEUE_SIZE) {
      const oldestEvent = this.asyncEventQueue.shift();
      this.logger.warn(
        `Async event queue full. Dropped oldest event: ${oldestEvent?.eventId} (${oldestEvent?.eventType})`,
      );
    }
    const event: McpAsyncEvent = {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId,
      eventType,
      data,
    };
    this.asyncEventQueue.push(event);
    this.logger.info(
      `[AsyncEventQueued] Event: ${eventType}, SessionID: ${sessionId}, EventID: ${event.eventId}, QueueSize: ${this.asyncEventQueue.length}`,
    );
  }

  public queueAsyncEvent(
    sessionId: string,
    eventType: McpAsyncEventType,
    data: unknown,
  ): void {
    this._queueAsyncEvent(sessionId, eventType, data);
  }

  public drainAsyncEventQueue(): McpAsyncEvent[] {
    const events = [...this.asyncEventQueue];
    this.asyncEventQueue = [];
    this.logger.info(`Drained ${events.length} async events.`);
    return events;
  }

  /**
   * Finds and optionally removes the first occurrence of a specific event type for a given session ID.
   * @param sessionId The session ID to check for.
   * @param eventType The type of event to look for.
   * @param removeIfFound If true, removes the event from the queue.
   * @returns The found McpAsyncEvent or undefined.
   */
  public findAndConsumeSessionEvent(
    sessionId: string,
    eventType: McpAsyncEventType,
    removeIfFound: boolean = true,
  ): McpAsyncEvent | undefined {
    const eventIndex = this.asyncEventQueue.findIndex(
      (event) => event.sessionId === sessionId && event.eventType === eventType,
    );
    if (eventIndex > -1) {
      const foundEvent = this.asyncEventQueue[eventIndex];
      if (removeIfFound) {
        this.asyncEventQueue.splice(eventIndex, 1);
        this.logger.info(
          `[findAndConsumeSessionEvent] Found and removed event ${foundEvent.eventId} (${foundEvent.eventType}) for session ${sessionId}. Queue size: ${this.asyncEventQueue.length}`,
        );
      } else {
        this.logger.info(
          `[findAndConsumeSessionEvent] Found event ${foundEvent.eventId} (${foundEvent.eventType}) for session ${sessionId} (did not remove).`,
        );
      }
      return foundEvent;
    }
    return undefined;
  }

  public getEventsForSession(sessionId: string): McpAsyncEvent[] {
    return this.asyncEventQueue.filter(
      (event) => event.sessionId === sessionId,
    );
  }

  public removeDebugSession(sessionId: string): void {
    this.logger.info(
      `[removeDebugSession] Attempting to remove session with ID: ${sessionId}`,
    );
    const deleted = this.activeSessions.delete(sessionId);
    if (deleted) {
      this.logger.info(
        `[removeDebugSession] Session ${sessionId} removed. Current active session IDs: ${Array.from(this.activeSessions.keys()).join(', ')}`,
      );
    } else {
      this.logger.warn(
        `[removeDebugSession] Session ${sessionId} not found for removal.`,
      );
    }
  }

  public getLogger(): LoggerInterface {
    return this.logger;
  }

  private mapStatusToSessionState(status: SessionStatus): ModelSessionState {
    switch (status) {
      case 'pending':
        return ModelSessionState.INITIALIZING;
      case 'initializing':
        return ModelSessionState.INITIALIZING;
      case 'initialized':
        return ModelSessionState.CONFIGURED;
      case 'active':
        return ModelSessionState.RUNNING;
      case 'stopped':
        return ModelSessionState.STOPPED;
      case 'terminating':
        return ModelSessionState.TERMINATED;
      case 'terminated':
        return ModelSessionState.TERMINATED;
      default:
        // This case should not be hit if all SessionStatus enum members are covered.
        // If a new status is added to SessionStatus, it needs mapping here.
        this.logger.warn(
          `Unknown ergonomic-debugger-client SessionStatus: '${status}', defaulting to ModelSessionState.INITIALIZING. Please map this state.`,
        );
        return ModelSessionState.INITIALIZING;
    }
  }

  public getAllSessionInfo(): ModelSessionInfo[] {
    const infos: ModelSessionInfo[] = [];
    for (const wrappedSession of this.activeSessions.values()) {
      infos.push({
        id: wrappedSession.id,
        targetType: wrappedSession.targetType,
        targetPath: wrappedSession.targetPath,
        state: this.mapStatusToSessionState(wrappedSession.status),
        startTime: wrappedSession.startTime,
      });
    }
    return infos;
  }

  private initializeTools() {
    registerTool<StartDebugSessionArgs, HandleStartDebugSessionResult>(
      'start_debug_session',
      'Starts a new debug session for a target program, returning session ID and initial state.',
      startDebugSessionSchema,
      handleStartDebugSession,
    );
    registerTool<SetBreakpointArgs, HandleSetBreakpointResult>(
      'set_breakpoint',
      'Sets a breakpoint in a file at a given line, with optional conditions or log messages.',
      setBreakpointSchema,
      handleSetBreakpoint,
    );
    registerTool<EvaluateExpressionArgs, HandleEvaluateExpressionResult>(
      'evaluate_expression',
      'Evaluates an expression in the context of a debug session.',
      evaluateExpressionSchema,
      handleEvaluateExpression,
    );
    registerTool<GetVariablesArgs, HandleGetVariablesResult>(
      'get_variables',
      'Retrieves child variables for a given scope or structured variable reference.',
      getVariablesSchema,
      handleGetVariables,
    );
    registerTool<GetCallStackArgs, HandleGetCallStackResult>(
      'get_call_stack',
      'Retrieves the current call stack for a thread in a debug session.',
      getCallStackSchema,
      handleGetCallStack,
    );
    registerTool<ContinueArgs, HandleContinueResult>(
      'continue',
      'Continues execution of the debug target and returns the current state of the debug session.',
      continueSchema,
      handleContinue,
    );
    registerTool<StepOverArgs, HandleStepOverResult>(
      'step_over',
      'Steps over the current line.',
      stepOverSchema,
      handleStepOver,
    );
    registerTool<StepInArgs, HandleStepInResult>(
      'step_in',
      'Steps into the function call at the current execution line.',
      stepInSchema,
      handleStepIn,
    );
    registerTool<StepOutArgs, HandleStepOutResult>(
      'step_out',
      'Steps out of the current function.',
      stepOutSchema,
      handleStepOut,
    );
    registerTool<TerminateSessionArgs, HandleTerminateSessionResult>(
      'terminate_session',
      'Terminates a debug session and the debuggee process.',
      terminateSessionSchema,
      handleTerminateSession,
    );
    registerTool<ListSessionsArgs, HandleListSessionsResult>(
      'list_sessions',
      'Lists all active debug sessions.',
      listSessionsSchema,
      handleListSessions,
    );
    registerTool<ListAdapterConfigsArgs, HandleListAdaptersResult>(
      'list_adapters',
      'Lists all registered debug adapter configurations.',
      listAdaptersSchema,
      handleListAdapters,
    );
    registerTool<GetPendingAsyncEventsArgs, HandleGetPendingAsyncEventsResult>(
      'get_pending_async_events',
      'Retrieves any pending asynchronous debug events queued on the server.',
      getPendingAsyncEventsSchema,
      handleGetPendingAsyncEvents,
    );
    registerTool<GetSessionDetailsArgs, HandleGetSessionDetailsResult>(
      'get_session_details',
      'Retrieves detailed information about a specific debug session, including its state (e.g., running, paused, terminated), active threads, and the call stack if the session is paused. Useful for understanding the current execution context, inspecting variables, or deciding the next debugging step.',
      getSessionDetailsSchema,
      handleGetSessionDetails,
    );
  }

  private formatToolResponse(
    result: AnyToolResult | undefined | null | void,
    eventsToReturn?: McpAsyncEvent[],
  ): { content: { type: 'text'; text: string }[] } {
    let baseProperties: Record<string, unknown>;

    if (result === undefined || result === null) {
      baseProperties = { success: true };
    } else if (Array.isArray(result)) {
      baseProperties = { value: result };
    } else if (typeof result === 'object') {
      baseProperties = { ...result };
    } else {
      baseProperties = { value: result };
    }

    const finalPayload: McpToolResponsePayload = {
      ...baseProperties,
      asyncEvents: eventsToReturn || [],
    };

    if (eventsToReturn && eventsToReturn.length > 0) {
      this.logger.info(
        `[formatToolResponse] Added ${eventsToReturn.length} async events to the response payload.`,
      );
    }

    // If the only information is 'success: true' and there are no async events,
    // standardize to a minimal success response.
    // This covers cases where the tool handler returns void, null, or {success: true}
    if (
      finalPayload.asyncEvents.length === 0 &&
      finalPayload.success === true &&
      Object.keys(finalPayload).filter(
        (k) => k !== 'asyncEvents' && k !== 'success',
      ).length === 0
    ) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              asyncEvents: [] as McpAsyncEvent[],
            }),
          },
        ],
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(finalPayload) }],
    };
  }

  private handleToolError(
    toolName: string,
    error: unknown,
    sessionId?: string,
  ) {
    this.logger.error(
      `[MCP Tool Error] ${toolName} (Session: ${sessionId || 'N/A'}):`,
      error,
    );

    if (error instanceof McpError) {
      throw error;
    }

    let mcpDebugErrorType: McpDebugErrorData['errorType'] =
      'tool_internal_error';
    let additionalDebugData: Partial<McpDebugErrorData> = {};

    if (error instanceof AdapterProcessError) {
      mcpDebugErrorType = 'adapter_process_error';
      additionalDebugData = {
        adapterType: error.adapterType,
        adapterConfig: error.adapterConfig,
        spawnErrorStage: error.stage,
        spawnDetails: {
          command: error.adapterConfig.command,
          args: error.adapterConfig.args,
          cwd: error.adapterConfig.cwd,
          env: error.adapterConfig.env,
          stderr: error.stderrOutput,
          exitCode: error.exitCode,
          signal: error.signal,
        },
      };
    } else if (error instanceof DAPRequestError) {
      mcpDebugErrorType = 'dap_request_error';
      additionalDebugData = {
        dapRequestCommand: error.request?.command,
        dapResponseErrorBody: error.response?.body,
      };
    } else if (
      error instanceof Error &&
      (error.name === 'TimeoutError' ||
        error.message.toLowerCase().includes('timeout'))
    ) {
      mcpDebugErrorType = 'operation_timeout';
    }

    throw new McpErrorBuilder()
      .error(error)
      .toolName(toolName)
      .mcpErrorCode(ErrorCode.InternalError)
      .mcpDebugErrorType(mcpDebugErrorType)
      .sessionProvider(this)
      .sessionId(sessionId)
      .additionalDebugData(additionalDebugData)
      .build();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Array.from(toolRegistry.entries()).map(
        ([name, { description, schema }]) => ({
          name,
          description,
          inputSchema: schema,
        }),
      ),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const toolInfo = toolRegistry.get(name);
        if (!toolInfo) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        const result = await toolInfo.handler(this, args as AnyToolArgs);

        const eventsToReturn = [...this.asyncEventQueue];
        this.asyncEventQueue = [];
        if (eventsToReturn.length > 0) {
          this.logger.info(
            `[CallToolRequestSchema] Piggybacking ${eventsToReturn.length} async events with tool response for '${name}'.`,
          );
        }

        return this.formatToolResponse(result, eventsToReturn);
      } catch (error: unknown) {
        let currentSessionId: string | undefined = undefined;
        if (
          args &&
          typeof args === 'object' &&
          args !== null &&
          'sessionId' in args &&
          typeof args.sessionId === 'string'
        ) {
          currentSessionId = args.sessionId;
        }
        this.handleToolError(name, error, currentSessionId);
        // This throw is technically unreachable because handleToolError always throws.
        throw new McpError(
          ErrorCode.InternalError,
          `Unhandled error in tool ${name}`,
        );
      }
    });
  }

  private _parseRequestBody(
    rawBody: string,
    contentType?: string,
  ): unknown | McpError {
    if (contentType && contentType.toLowerCase().includes('application/json')) {
      if (!rawBody) {
        // Allow empty body for GET or if no body is expected for POST/PUT
        return undefined;
      }
      try {
        return JSON.parse(rawBody);
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        this.logger.error('Failed to parse JSON request body:', errorMessage);
        return new McpError(JSONRPC_ERROR_PARSE_ERROR, 'Parse error');
      }
    } else if (rawBody) {
      // If there's a body but not JSON
      this.logger.error(
        `Received request with non-JSON content type: ${contentType} and a body.`,
      );
      return new McpError(
        JSONRPC_ERROR_INVALID_REQUEST,
        'Invalid Request: Content-Type must be application/json for requests with a body',
      );
    }
    return undefined;
  }

  /**
   * Handles incoming HTTP requests for the MCP server.
   * This method is called by the HTTP server created in the `run` method.
   */
  private async _handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    mcpTransport: StreamableHTTPServerTransport,
  ) {
    if (req.url !== MCP_HTTP_ENDPOINT) {
      res.writeHead(HTTP_STATUS_NOT_FOUND, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: JSONRPC_ERROR_METHOD_NOT_FOUND,
            message: 'Method not found',
          },
          id: null,
        }),
      );
      return;
    }

    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk.toString();
    });

    req.on('end', async () => {
      let bodyForTransport: unknown;

      if (req.method === 'POST' || req.method === 'PUT') {
        const parsedResult = this._parseRequestBody(
          rawBody,
          req.headers['content-type'],
        );
        if (parsedResult instanceof McpError) {
          res.writeHead(
            parsedResult.code === JSONRPC_ERROR_PARSE_ERROR
              ? HTTP_STATUS_BAD_REQUEST
              : HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
            { 'Content-Type': 'application/json' },
          );
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: parsedResult.code, message: parsedResult.message },
              id: null,
            }),
          );
          return;
        }
        bodyForTransport = parsedResult;
      } else {
        bodyForTransport = undefined;
      }
      await mcpTransport.handleRequest(req, res, bodyForTransport);
    });
  }

  /**
   * Runs the MCP server
   */
  async run() {
    let mcpTransport: StdioServerTransport | StreamableHTTPServerTransport;
    let httpServer: http.Server | undefined;

    const runArgv = yargs(hideBin(process.argv))
      .option('port', {
        alias: 'p',
        type: 'number',
        description:
          'Port to run the HTTP server on for StreamableHTTPServerTransport.',
      })
      .option('adapter-config', {
        alias: 'ac',
        type: 'string',
        description: 'Path to the adapter configurations JSON file.',
      })
      .usage('Usage: $0 [options]')
      .help()
      .alias('help', 'h')
      .version(this.serverInfo.version)
      .alias('version', 'v')
      .parseSync();

    const port: number | undefined = runArgv.port;

    console.error('AI Debugger MCP Server initializing...');

    if (port && !isNaN(port)) {
      const transportOptions: StreamableHTTPServerTransportOptions = {
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId: string) => {
          this.logger.info(
            `HTTP Session initialized by transport: ${sessionId}`,
          );
        },
      };

      const httpTransportInstance = new StreamableHTTPServerTransport(
        transportOptions,
      );
      mcpTransport = httpTransportInstance;

      httpTransportInstance.onclose = () => {
        this.logger.info(`HTTP Transport closed.`);
      };

      await this.server.connect(httpTransportInstance);

      httpServer = http.createServer((req, res) => {
        this._handleHttpRequest(req, res, httpTransportInstance);
      });

      httpServer.listen(port, () => {
        console.error(`AI Debugger MCP Server started on port ${port}`);
      });

      // Ensure SIGINT is handled gracefully for HTTP server
      process.removeAllListeners('SIGINT');
      process.on('SIGINT', async () => {
        this.logger.info('SIGINT received. Closing HTTP server first...');
        if (httpServer) {
          httpServer.close(async () => {
            this.logger.info('HTTP server closed.');
            await this.handleShutdown();
          });
        } else {
          await this.handleShutdown();
        }
      });
    } else {
      mcpTransport = new StdioServerTransport();
      await this.server.connect(mcpTransport);
      console.error('AI Debugger MCP Server running on stdio');
    }
  }
}

// Create and run the server only if this script is executed directly
if (require.main === module) {
  const server = new InteractiveDebuggerMcpServer();
  server.run().catch((error) => {
    console.error('Failed to start AI Debugger MCP Server:', error);
    process.exit(1);
  });
}
