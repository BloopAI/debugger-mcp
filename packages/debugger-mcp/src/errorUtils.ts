import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  McpDebugErrorData,
  McpDebugErrorType,
} from './types/mcp_protocol_extensions';
import { SessionProvider } from './tools';

interface NormalizedError {
  message: string;
  name?: string;
  stack?: string;
  originalError: unknown;
}

export class McpErrorBuilder {
  private _error?: unknown;
  private _toolName?: string;
  private _mcpErrorCode?: ErrorCode;
  private _mcpDebugErrorType?: McpDebugErrorType;
  private _sessionProvider?: SessionProvider;
  private _sessionId?: string;
  private _additionalDebugData?: Partial<McpDebugErrorData>;

  constructor() {}

  private static normalizeErrorObject(error: unknown): NormalizedError {
    if (error instanceof Error) {
      return {
        message: error.message,
        name: error.name,
        stack: error.stack,
        originalError: error,
      };
    }
    return {
      message: String(error),
      originalError: error,
    };
  }

  private static createMcpErrorFromError(
    error: unknown,
    toolName: string,
    mcpErrorCode: ErrorCode,
    mcpDebugErrorType: McpDebugErrorType,
    sessionProvider: SessionProvider,
    sessionId?: string,
    additionalDebugData?: Partial<McpDebugErrorData>,
  ): McpError {
    const normalized = McpErrorBuilder.normalizeErrorObject(error);
    const asyncEvents = sessionProvider.drainAsyncEventQueue();

    const debugData: McpDebugErrorData = {
      errorType: mcpDebugErrorType,
      sessionId: sessionId,
      originalMessage: normalized.message,
      originalName: normalized.name,
      originalStack: normalized.stack,
      asyncEvents: asyncEvents,
      ...additionalDebugData,
    };

    let errorMessage = `Error in tool ${toolName}: ${normalized.message}`;
    if (
      mcpDebugErrorType === 'invalid_tool_arguments' &&
      additionalDebugData?.problemDetail
    ) {
      errorMessage = `${additionalDebugData.problemDetail}`;
    } else if (mcpDebugErrorType === 'session_not_found' && sessionId) {
      errorMessage = `Debug session not found: ${sessionId}`;
    }

    return new McpError(mcpErrorCode, errorMessage, debugData);
  }

  public error(error: unknown): this {
    this._error = error;
    return this;
  }

  public toolName(toolName: string): this {
    this._toolName = toolName;
    return this;
  }

  public mcpErrorCode(mcpErrorCode: ErrorCode): this {
    this._mcpErrorCode = mcpErrorCode;
    return this;
  }

  public mcpDebugErrorType(mcpDebugErrorType: McpDebugErrorType): this {
    this._mcpDebugErrorType = mcpDebugErrorType;
    return this;
  }

  public sessionProvider(sessionProvider: SessionProvider): this {
    this._sessionProvider = sessionProvider;
    return this;
  }

  public sessionId(sessionId?: string): this {
    this._sessionId = sessionId;
    return this;
  }

  public additionalDebugData(
    additionalDebugData?: Partial<McpDebugErrorData>,
  ): this {
    this._additionalDebugData = additionalDebugData;
    return this;
  }

  public build(): McpError {
    if (this._error === undefined)
      throw new Error("McpErrorBuilder: 'error' is required.");
    if (!this._toolName)
      throw new Error("McpErrorBuilder: 'toolName' is required.");
    if (!this._mcpErrorCode)
      throw new Error("McpErrorBuilder: 'mcpErrorCode' is required.");
    if (!this._mcpDebugErrorType)
      throw new Error("McpErrorBuilder: 'mcpDebugErrorType' is required.");
    if (!this._sessionProvider)
      throw new Error("McpErrorBuilder: 'sessionProvider' is required.");

    return McpErrorBuilder.createMcpErrorFromError(
      this._error,
      this._toolName,
      this._mcpErrorCode,
      this._mcpDebugErrorType,
      this._sessionProvider,
      this._sessionId,
      this._additionalDebugData,
    );
  }
}
