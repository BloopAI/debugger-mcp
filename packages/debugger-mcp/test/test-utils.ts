import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpAsyncEvent } from '../src/types/mcp_protocol_extensions';

export interface McpToolTestResponse<TResult = unknown> {
  success: boolean;
  error?: string;
  code?: number;
  result: TResult | null;
  asyncEvents?: McpAsyncEvent[];
}

export interface SdkToolResponse {
  content?: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  error?: {
    message: string;
    code?: number;
    data?: unknown;
  };
  events?: McpAsyncEvent[];
  success?: boolean;
  result?: unknown;
  [key: string]: unknown;
}

interface ParsedToolPayload {
  success?: boolean;
  error?: string | { message: string; [key: string]: unknown };
  result?: unknown;
  asyncEvents?: McpAsyncEvent[];
  [key: string]: unknown;
}

export function parseStdioClientToolResponse<TResult = unknown>(
  rawMcpResponse: SdkToolResponse,
  toolName: string,
): McpToolTestResponse<TResult> {
  const logger = {
    debug: (message: string, ...meta: unknown[]) =>
      console.log(`[DEBUG][parseResponse][${toolName}] ${message}`, ...meta),
    error: (message: string, ...meta: unknown[]) =>
      console.error(`[ERROR][parseResponse][${toolName}] ${message}`, ...meta),
    warn: (message: string, ...meta: unknown[]) =>
      console.warn(`[WARN][parseResponse][${toolName}] ${message}`, ...meta),
  };

  logger.debug(
    `Raw MCP Response from client.callTool for ${toolName}:`,
    rawMcpResponse,
  );

  // 1. Check for top-level MCP SDK error
  if (
    rawMcpResponse.error &&
    typeof rawMcpResponse.error.message === 'string'
  ) {
    logger.error(
      `MCP SDK returned an error object for ${toolName}:`,
      rawMcpResponse.error,
    );
    return {
      success: false,
      error: rawMcpResponse.error.message,
      code: rawMcpResponse.error.code,
      result: null,
      asyncEvents: rawMcpResponse.events || [],
    };
  }

  // 2. Check for content-based response
  if (rawMcpResponse.content && rawMcpResponse.content.length > 0) {
    const firstContent = rawMcpResponse.content[0];
    if (firstContent.type === 'text' && typeof firstContent.text === 'string') {
      try {
        const parsedPayload = JSON.parse(
          firstContent.text,
        ) as ParsedToolPayload;

        if (parsedPayload.success === false) {
          logger.warn(
            `Tool ${toolName} payload indicated failure:`,
            parsedPayload,
          );
          let errorMessage = `Tool ${toolName} failed.`;
          if (typeof parsedPayload.error === 'string') {
            errorMessage = parsedPayload.error;
          } else if (
            parsedPayload.error &&
            typeof parsedPayload.error.message === 'string'
          ) {
            errorMessage = parsedPayload.error.message;
          }
          return {
            success: false,
            error: errorMessage,
            result: (parsedPayload.result !== undefined
              ? parsedPayload.result
              : null) as TResult,
            asyncEvents:
              parsedPayload.asyncEvents || rawMcpResponse.events || [],
          };
        }

        // If success is not explicitly false, assume true.
        // The actual 'result' for TResult is typically parsedPayload.result if it exists,
        // or the whole parsedPayload if 'result' key is absent.
        const finalResult =
          'result' in parsedPayload ? parsedPayload.result : parsedPayload;

        return {
          success: true,
          result: finalResult as TResult,
          asyncEvents: parsedPayload.asyncEvents || rawMcpResponse.events || [],
        };
      } catch (parseError: unknown) {
        const parseErrorMessage =
          parseError instanceof Error ? parseError.message : String(parseError);
        logger.error(
          `Failed to parse JSON from tool response content for ${toolName}: ${firstContent.text}`,
          parseError,
        );
        return {
          success: false,
          error: `Failed to parse JSON response: ${parseErrorMessage}`,
          result: null,
          asyncEvents: rawMcpResponse.events || [],
        };
      }
    } else {
      logger.warn(
        `Unexpected content type in tool response for ${toolName}. Expected 'text', got:`,
        firstContent.type,
      );
      return {
        success: false,
        error: `Unexpected content type: ${firstContent.type}`,
        result: null,
        asyncEvents: rawMcpResponse.events || [],
      };
    }
  }

  // 3. Fallback for direct success/failure indication on rawMcpResponse
  if (typeof rawMcpResponse.success === 'boolean') {
    logger.debug(
      `Response for ${toolName} has direct success field.`,
      rawMcpResponse,
    );
    return {
      success: rawMcpResponse.success,
      error:
        typeof rawMcpResponse.error === 'string'
          ? rawMcpResponse.error
          : rawMcpResponse.error?.message,
      code: rawMcpResponse.error?.code,
      result: (rawMcpResponse.result !== undefined
        ? rawMcpResponse.result
        : null) as TResult,
      asyncEvents: rawMcpResponse.events || [],
    };
  }

  // 4. If none of the above, it's an unexpected structure
  logger.warn(
    `Unexpected or empty overall response structure for ${toolName}:`,
    rawMcpResponse,
  );
  return {
    success: false,
    error: 'Unexpected or empty overall response structure',
    result: null,
    asyncEvents: rawMcpResponse.events || [],
  };
}

const ROOT_DIR_FOR_UTILS = path.resolve(__dirname, '../');
const MCP_SERVER_SCRIPT_FOR_UTILS = path.join(
  ROOT_DIR_FOR_UTILS,
  'dist',
  'index.js',
);

export interface TestClientSetup {
  client: Client;
  transport: StdioClientTransport;
}

export async function setupMcpClient(
  clientName = 'mcp-test-client',
): Promise<TestClientSetup> {
  console.log(`[INFO][test-utils] Setting up MCP Client: ${clientName}`);
  const transportParams: StdioServerParameters = {
    command: 'node',
    args: [MCP_SERVER_SCRIPT_FOR_UTILS],
    cwd: ROOT_DIR_FOR_UTILS,
    env: { ...process.env, LOG_LEVEL: 'debug' },
  };
  const transport = new StdioClientTransport(transportParams);

  const clientIdentityArg = {
    name: clientName,
    version: '0.1.0',
  };
  const client = new Client(clientIdentityArg);

  console.log(
    `[INFO][test-utils] Connecting ${clientName} to StdioClientTransport...`,
  );
  await client.connect(transport);
  console.log(`[INFO][test-utils] ${clientName} connect() call completed.`);
  return { client, transport };
}

export async function cleanupMcpClient(
  setup: TestClientSetup | null,
): Promise<void> {
  if (!setup) return;
  const { client, transport } = setup;

  console.log('[INFO][test-utils] Cleaning up MCP Client...');
  if (client) {
    await client
      .close()
      .catch((err) =>
        console.error('[Test][test-utils] Error closing MCP client:', err),
      );
    console.log('[INFO][test-utils] MCP Client closed.');
  }
  if (transport && typeof transport.close === 'function') {
    try {
      console.log(
        '[INFO][test-utils] Explicitly closing StdioClientTransport...',
      );
      await transport.close();
      console.log('[INFO][test-utils] StdioClientTransport explicitly closed.');
    } catch (transportCloseErr) {
      console.error(
        '[WARN][test-utils] Error explicitly closing StdioClientTransport:',
        transportCloseErr,
      );
    }
  } else {
    console.log(
      '[INFO][test-utils] StdioClientTransport does not have a close method or transport is null.',
    );
  }
  console.log('[INFO][test-utils] Cleanup MCP Client completed.');
}
