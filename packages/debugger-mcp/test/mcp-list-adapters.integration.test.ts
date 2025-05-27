import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AdapterConfig } from 'ergonomic-debugger-client';
import { AdapterConfigDetail } from '../src/tools';
import { McpAsyncEvent } from '../src/types/mcp_protocol_extensions';

interface LoggerInterface {
  trace: (message: string, ...meta: unknown[]) => void;
  debug: (message: string, ...meta: unknown[]) => void;
  info: (message: string, ...meta: unknown[]) => void;
  warn: (message: string, ...meta: unknown[]) => void;
  error: (message: string, ...meta: unknown[]) => void;
}

interface McpToolTestResponse {
  success: boolean;
  error?: string;
  code?: number;
  result: unknown;
  events: McpAsyncEvent[];
}

const logger: LoggerInterface = {
  trace: (message, ...meta) => console.log(`[TRACE] ${message}`, ...meta),
  debug: (message, ...meta) => console.log(`[DEBUG] ${message}`, ...meta),
  info: (message, ...meta) => console.log(`[INFO] ${message}`, ...meta),
  warn: (message, ...meta) => console.warn(`[WARN] ${message}`, ...meta),
  error: (message, ...meta) => console.error(`[ERROR] ${message}`, ...meta),
};

const PROJECT_ROOT = path.resolve(__dirname, '..');

let mcpClient: Client | null = null;
let tempAdapterConfigPath: string | null = null;

async function callMcpTool(
  client: Client,
  toolName: string,
  serverName: string,
  toolArgs: Record<string, unknown> | undefined,
): Promise<McpToolTestResponse> {
  if (!client) {
    logger.error('MCP Client is null. Cannot call tool.');
    return {
      success: false,
      error: 'MCP Client is null',
      result: null,
      events: [],
    };
  }
  logger.debug(
    `Calling MCP Tool via StdioClient: ${serverName}/${toolName} with toolArgs:`,
    toolArgs,
  );
  try {
    const rawMcpResponse = await client.callTool({
      serverName: serverName,
      name: toolName,
      arguments: toolArgs,
    });
    logger.debug(
      `Raw MCP Response from client.callTool for ${toolName}:`,
      rawMcpResponse,
    );

    if (
      rawMcpResponse &&
      typeof rawMcpResponse === 'object' &&
      rawMcpResponse.error
    ) {
      logger.error(
        `MCP tool call returned an error object for ${toolName}:`,
        rawMcpResponse.error,
      );
      const errorMessage =
        typeof rawMcpResponse.error === 'object' &&
        rawMcpResponse.error &&
        'message' in rawMcpResponse.error
          ? String(rawMcpResponse.error.message)
          : 'Unknown MCP error in response';
      return {
        success: false,
        error: errorMessage,
        result: null,
        events: Array.isArray(rawMcpResponse.events)
          ? rawMcpResponse.events
          : [],
      };
    }

    if (
      rawMcpResponse &&
      Array.isArray(rawMcpResponse.content) &&
      rawMcpResponse.content.length > 0
    ) {
      const firstContent = rawMcpResponse.content[0];
      if (
        firstContent.type === 'text' &&
        typeof firstContent.text === 'string'
      ) {
        try {
          const parsedToolResult = JSON.parse(firstContent.text);
          if (
            typeof parsedToolResult === 'object' &&
            parsedToolResult !== null &&
            'success' in parsedToolResult &&
            parsedToolResult.success === false
          ) {
            logger.warn(
              `Tool handler for ${toolName} indicated failure:`,
              parsedToolResult,
            );
            return {
              success: false,
              error: parsedToolResult.error || 'Tool handler failed',
              result: parsedToolResult.result,
              events: Array.isArray(rawMcpResponse.events)
                ? rawMcpResponse.events
                : [],
            };
          }
          return {
            success: true,
            result: parsedToolResult,
            events: Array.isArray(rawMcpResponse.events)
              ? rawMcpResponse.events
              : [],
          };
        } catch (parseErrorUnknown: unknown) {
          const parseErrorMessage =
            parseErrorUnknown instanceof Error
              ? parseErrorUnknown.message
              : String(parseErrorUnknown);
          logger.error(
            `Failed to parse JSON from tool response content for ${toolName}: ${firstContent.text}`,
            parseErrorUnknown,
          );
          return {
            success: false,
            error: `Failed to parse JSON response: ${parseErrorMessage}`,
            result: null,
            events: Array.isArray(rawMcpResponse.events)
              ? rawMcpResponse.events
              : [],
          };
        }
      } else {
        logger.warn(
          `Unexpected content type in tool response for ${toolName}. Expected 'text', got:`,
          firstContent,
        );
        return {
          success: false,
          error: `Unexpected content type: ${firstContent.type}`,
          result: rawMcpResponse,
          events: Array.isArray(rawMcpResponse.events)
            ? rawMcpResponse.events
            : [],
        };
      }
    } else {
      logger.warn(
        `Unexpected or empty content in tool response for ${toolName}:`,
        rawMcpResponse,
      );
      return {
        success: false,
        error: 'Unexpected or empty content in tool response',
        result: rawMcpResponse,
        events: Array.isArray(rawMcpResponse.events)
          ? rawMcpResponse.events
          : [],
      };
    }
  } catch (errorUnknown: unknown) {
    logger.error(
      `Exception during MCP tool call ${serverName}/${toolName} via StdioClient:`,
      errorUnknown,
    );
    let errorMessage = 'Unknown error during StdioClient tool call';
    let errorCode: number | undefined;

    if (errorUnknown instanceof Error) {
      errorMessage = errorUnknown.message;
      if (
        'code' in errorUnknown &&
        typeof (errorUnknown as { code: unknown }).code === 'number'
      ) {
        errorCode = (errorUnknown as { code: number }).code;
      }
    } else if (typeof errorUnknown === 'object' && errorUnknown !== null) {
      if (
        'message' in errorUnknown &&
        typeof (errorUnknown as { message: unknown }).message === 'string'
      ) {
        errorMessage = (errorUnknown as { message: string }).message;
      }
      if (
        'code' in errorUnknown &&
        typeof (errorUnknown as { code: unknown }).code === 'number'
      ) {
        errorCode = (errorUnknown as { code: number }).code;
      }
      if (
        'error' in errorUnknown &&
        typeof (errorUnknown as { error: unknown }).error === 'object' &&
        (errorUnknown as { error: object }).error !== null
      ) {
        const nestedError = (errorUnknown as { error: Record<string, unknown> })
          .error;
        if (
          'message' in nestedError &&
          typeof nestedError.message === 'string'
        ) {
          errorMessage = nestedError.message;
        }
        if ('code' in nestedError && typeof nestedError.code === 'number') {
          errorCode = nestedError.code;
        }
      }
    } else {
      errorMessage = String(errorUnknown);
    }

    return {
      success: false,
      error: errorMessage,
      code: errorCode,
      result: null,
      events: [],
    };
  }
}

describe('MCP List Adapters Integration Test', function () {
  this.timeout(30000);

  before(async function () {
    this.timeout(45000); // Longer timeout for setup
    logger.info('Starting before hook for MCP List Adapters tests...');
    try {
      const defaultPythonAdapter: AdapterConfig = {
        type: 'python',
        command: 'python3',
        args: ['-m', 'debugpy.adapter'],
        env: { TEST_ENV_VAR: 'TestValueFromConfig' },
        cwd: '/tmp/py',
      };
      const defaultNodeAdapter: AdapterConfig = {
        type: 'node',
        command: 'node',
        args: [],
        env: {},
        cwd: '/tmp/node',
      };
      const rootConfigObject = {
        adapters: {
          python: defaultPythonAdapter,
          node: defaultNodeAdapter,
        },
      };
      const tempDir = path.join(PROJECT_ROOT, '.tmp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      tempAdapterConfigPath = path.join(
        tempDir,
        `test-list-adapters-config-${randomUUID()}.json`,
      );
      fs.writeFileSync(
        tempAdapterConfigPath,
        JSON.stringify(rootConfigObject, null, 2),
      );
      logger.info(
        `Temporary adapter config for stdio server written to: ${tempAdapterConfigPath}`,
      );

      const serverBuildPath = path.join(PROJECT_ROOT, 'dist', 'index.js');
      if (!fs.existsSync(serverBuildPath)) {
        logger.warn(
          `Server build file not found at ${serverBuildPath}. Attempting to run 'npm run build'...`,
        );
        try {
          execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
          if (!fs.existsSync(serverBuildPath)) {
            const buildErrorMsg = `Server build file still not found at ${serverBuildPath} after attempting build. Please check build process.`;
            logger.error(buildErrorMsg);
            throw new Error(buildErrorMsg);
          }
          logger.info('Project built successfully.');
        } catch (buildErrorUnknown: unknown) {
          const buildErrorMessage =
            buildErrorUnknown instanceof Error
              ? buildErrorUnknown.message
              : String(buildErrorUnknown);
          const errorMsg = `Failed to build project: ${buildErrorMessage}. Server build file not found at ${serverBuildPath}.`;
          logger.error(errorMsg, buildErrorUnknown);
          throw new Error(errorMsg);
        }
      }

      const transportParams = {
        command: 'node',
        args: [serverBuildPath, `--adapter-config=${tempAdapterConfigPath}`],
        cwd: PROJECT_ROOT,
      };
      const transport = new StdioClientTransport(transportParams);

      const clientIdentityArg = {
        name: 'mcp-list-adapters-test-client',
        version: '1.0.0',
      };
      mcpClient = new Client(clientIdentityArg);

      logger.info('Connecting MCP Client to StdioClientTransport...');
      await mcpClient.connect(transport);
      logger.info('MCP Client connect() call completed.');
    } catch (e) {
      logger.error('Critical error in before hook:', e);
      if (mcpClient) {
        await mcpClient
          .close()
          .catch((clientCloseErr) =>
            logger.error(
              'Error closing MCP client during error handling:',
              clientCloseErr,
            ),
          );
      }
      if (tempAdapterConfigPath && fs.existsSync(tempAdapterConfigPath)) {
        try {
          fs.unlinkSync(tempAdapterConfigPath);
        } catch (err) {
          logger.warn('Failed to cleanup temp config in error path', err);
        }
      }
      throw e;
    }
    logger.info('Before hook completed.');
  });

  after(async function () {
    this.timeout(20000);
    logger.info('Starting after hook for MCP List Adapters tests...');
    if (mcpClient) {
      logger.info(
        'Closing MCP Client (this should terminate the stdio server)...',
      );
      await mcpClient
        .close()
        .catch((err) =>
          logger.warn('Error closing MCP client in after hook:', err),
        );
      logger.info('MCP Client closed.');
    }
    mcpClient = null;

    if (tempAdapterConfigPath && fs.existsSync(tempAdapterConfigPath)) {
      try {
        fs.unlinkSync(tempAdapterConfigPath);
        logger.info(
          `Cleaned up temporary adapter config file: ${tempAdapterConfigPath}`,
        );
      } catch (cleanupError) {
        logger.warn(
          `Failed to clean up temp adapter config file ${tempAdapterConfigPath}:`,
          cleanupError,
        );
      }
      tempAdapterConfigPath = null;
    }
    logger.info('After hook completed.');
  });

  it('should list registered adapter configurations', async function () {
    expect(mcpClient, 'MCP Client must be initialized').to.exist;

    logger.info('Test: Calling list_adapters tool...');
    const response = await callMcpTool(
      mcpClient!,
      'list_adapters',
      'interactive-debugger',
      {},
    );

    logger.info(
      'Test: list_adapters response:',
      JSON.stringify(response, null, 2),
    );

    expect(
      response.success,
      `list_adapters tool call failed: ${response.error}`,
    ).to.be.true;
    expect(response.result, 'list_adapters result should exist').to.exist;

    interface ListAdaptersToolResult {
      adapters: {
        type: string;
        config: AdapterConfigDetail;
      }[];
    }

    const toolResult = response.result as ListAdaptersToolResult;

    expect(
      toolResult.adapters,
      'response.result.adapters should be an array',
    ).to.be.an('array');
    const adaptersArray = toolResult.adapters as {
      type: string;
      config: AdapterConfigDetail;
    }[];

    const pythonAdapter = adaptersArray.find((a) => a.type === 'python');
    expect(pythonAdapter, 'Python adapter configuration should exist').to.exist;
    expect(pythonAdapter!.config.command).to.equal('python3');
    expect(pythonAdapter!.config.args).to.deep.equal(['-m', 'debugpy.adapter']);

    const nodeAdapter = adaptersArray.find((a) => a.type === 'node');
    expect(nodeAdapter, 'Node adapter configuration should exist').to.exist;
    expect(nodeAdapter!.config.command).to.equal('node');
    expect(nodeAdapter!.config.args).to.deep.equal([]);

    logger.info(
      'Test: list_adapters tool call successful and response verified.',
    );
  });
});
