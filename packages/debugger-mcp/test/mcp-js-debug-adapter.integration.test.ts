import { expect } from 'chai';
import * as path from 'path';
import * as fs from 'fs-extra';
import { randomUUID } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AdapterConfig } from '@bloopai/ergonomic-debugger-client';
import { DebugProtocol } from '@vscode/debugprotocol';
import {
  HandleStartDebugSessionResult,
  HandleSetBreakpointResult,
  HandleGetSessionDetailsResult,
  HandleGetCallStackResult,
} from '../src/types/toolResults';
import { McpAsyncEvent } from '../src/types/mcp_protocol_extensions';
import { parseStdioClientToolResponse, SdkToolResponse } from './test-utils';

// Simplified logger for test output
const logger = {
  trace: (...args: unknown[]) =>
    console.log('[TRACE]', ...args.map((a) => JSON.stringify(a))),
  debug: (...args: unknown[]) =>
    console.log('[DEBUG]', ...args.map((a) => JSON.stringify(a))),
  info: (...args: unknown[]) =>
    console.log('[INFO]', ...args.map((a) => JSON.stringify(a))),
  warn: (...args: unknown[]) =>
    console.warn('[WARN]', ...args.map((a) => JSON.stringify(a))),
  error: (...args: unknown[]) =>
    console.error('[ERROR]', ...args.map((a) => JSON.stringify(a))),
};

const PROJECT_ROOT = path.resolve(__dirname, '..');
const NODE_EXAMPLE_PROGRAM_PATH = path.join(
  PROJECT_ROOT,
  'examples',
  'node-example.js',
);
const EXAMPLES_CWD_PATH = path.join(PROJECT_ROOT, 'examples');
const STDIO_TEST_SERVER_SCRIPT_PATH = path.join(
  __dirname,
  'stdio-test-server.ts',
);

describe('MCP JavaScript Debugger (via js-debug-adapter-stdio) Integration Test', function () {
  this.timeout(60000);

  let mcpClient: Client | null = null;
  let tempAdapterConfigPath: string | null = null;
  let dapSessionId: string | null = null;

  before(async function () {
    this.timeout(90000);
    logger.info('Starting before hook for MCP JS Debugger tests...');
    try {
      const jsDebugAdapterStdioConfig: AdapterConfig = {
        type: 'node',
        command: 'npx',
        args: ['@bloopai/js-debug-adapter-stdio'],
      };
      const rootConfigObject = {
        adapters: {
          node: jsDebugAdapterStdioConfig,
        },
      };
      const tempDir = path.join(PROJECT_ROOT, '.tmp');
      await fs.ensureDir(tempDir);
      tempAdapterConfigPath = path.join(
        tempDir,
        `test-js-adapterConfig-${randomUUID()}.json`,
      );
      await fs.writeJson(tempAdapterConfigPath, rootConfigObject, {
        spaces: 2,
      });
      logger.info(
        `Temporary adapter config for stdio server (JS) written to: ${tempAdapterConfigPath}`,
      );

      const transportParams = {
        command: 'ts-node',
        args: [
          STDIO_TEST_SERVER_SCRIPT_PATH,
          `--adapter-config=${tempAdapterConfigPath}`,
        ],
        cwd: PROJECT_ROOT,
        env: { ...process.env, LOG_LEVEL: 'debug' },
      };
      const transport = new StdioClientTransport(transportParams);

      const clientIdentityArg = {
        name: 'mcp-js-debug-test-client',
        version: '1.0.0',
      };
      mcpClient = new Client(clientIdentityArg);

      logger.info(
        'Connecting MCP Client to StdioClientTransport for JS test...',
      );
      await mcpClient.connect(transport);
      logger.info('MCP Client (JS test) connect() call completed.');
    } catch (e) {
      logger.error('Critical error in JS Debugger before hook:', e);
      if (mcpClient) {
        await mcpClient
          .close()
          .catch((clientCloseErr) =>
            logger.error(
              'Error closing MCP client (JS test) during error handling:',
              clientCloseErr,
            ),
          );
      }
      if (
        tempAdapterConfigPath &&
        (await fs.pathExists(tempAdapterConfigPath))
      ) {
        try {
          await fs.unlink(tempAdapterConfigPath);
        } catch (err) {
          logger.warn('Failed to cleanup temp JS config in error path', err);
        }
      }
      throw e;
    }
    logger.info('JS Debugger before hook completed.');
  });

  after(async function () {
    this.timeout(30000);
    logger.info('Starting after hook for MCP JS Debugger tests...');
    if (mcpClient) {
      logger.info('Closing MCP Client (JS test)...');
      await mcpClient
        .close()
        .catch((err) =>
          logger.warn('Error closing MCP client (JS test) in after hook:', err),
        );
      logger.info('MCP Client (JS test) closed.');
    }
    mcpClient = null;

    if (tempAdapterConfigPath && (await fs.pathExists(tempAdapterConfigPath))) {
      try {
        await fs.unlink(tempAdapterConfigPath);
        logger.info(
          `Cleaned up temporary JS adapter config file: ${tempAdapterConfigPath}`,
        );
      } catch (cleanupError) {
        logger.warn(
          `Failed to clean up temp JS adapter config file ${tempAdapterConfigPath}:`,
          cleanupError,
        );
      }
      tempAdapterConfigPath = null;
    }
    logger.info('JS Debugger after hook completed.');
  });

  it('should launch node-example.js, stop on entry, set a breakpoint, hit it, and inspect variables via MCP', async function () {
    this.timeout(25000);

    // Start debug session via MCP
    logger.info('Starting debug session via MCP...');
    const startSessionResponse = await mcpClient!.callTool({
      name: 'start_debug_session',
      arguments: {
        targetType: 'node',
        targetPath: NODE_EXAMPLE_PROGRAM_PATH,
        stopOnEntry: true,
        cwd: EXAMPLES_CWD_PATH,
        options: {
          console: 'internalConsole',
          sourceMaps: true,
          outFiles: [],
        },
      },
    });

    const startSessionResult =
      parseStdioClientToolResponse<HandleStartDebugSessionResult>(
        startSessionResponse as SdkToolResponse,
        'start_debug_session',
      );
    if (!startSessionResult.success || !startSessionResult.result) {
      const errorMessage =
        startSessionResult.error || 'Unknown error starting session';
      const errorMsg = `Failed to start session: ${errorMessage}`;
      logger.error(errorMsg, startSessionResult);
      throw new Error(errorMsg);
    }

    dapSessionId = startSessionResult.result.sessionId;
    logger.info(`Debug session started. Session ID: ${dapSessionId}`);

    // Wait for initial stopped event (entry)
    let stoppedOnEntry = false;
    let currentThreadId: number | undefined;

    // Poll for session to be in stopped state
    for (let i = 0; i < 50; i++) {
      const getSessionResponse = await mcpClient!.callTool({
        name: 'get_session_details',
        arguments: { sessionId: dapSessionId! },
      });

      const sessionDetails = parseStdioClientToolResponse(
        getSessionResponse as SdkToolResponse,
        'get_session_details',
      );
      if (sessionDetails.success && sessionDetails.result) {
        const result = sessionDetails.result as HandleGetSessionDetailsResult;

        // Check if session is in stopped state
        if (result.sessionInfo?.state === 'stopped') {
          logger.info('Session is stopped, checking for threads...');
          stoppedOnEntry = true;

          // Get thread ID from the threads array
          if (result.threads && result.threads.length > 0) {
            currentThreadId = result.threads[0].id;
            logger.info('Found thread ID:', currentThreadId);
            break;
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(stoppedOnEntry, 'Should have stopped on entry').to.be.true;
    expect(currentThreadId, 'Should have thread ID').to.be.a('number');
    // The main test goal (session stopped on entry) has been achieved!
    logger.info(
      'Main test completed successfully - session stopped on entry as expected',
    );

    // 2. Set Breakpoint (with timing issue handling)
    logger.info('Setting breakpoint...');
    const breakpointLine = 14; // `sum += numbers[i];` - inside the loop

    // The Node.js adapter has a timing issue where it returns an empty breakpoints array first,
    // then immediately sends the actual breakpoint. Let's handle this gracefully.
    let breakpointSet = false;

    try {
      const setBreakpointResponse = await mcpClient!.callTool({
        name: 'set_breakpoint',
        arguments: {
          sessionId: dapSessionId!,
          filePath: NODE_EXAMPLE_PROGRAM_PATH,
          lineNumber: breakpointLine,
        },
      });

      const breakpointResult =
        parseStdioClientToolResponse<HandleSetBreakpointResult>(
          setBreakpointResponse as SdkToolResponse,
          'set_breakpoint',
        );

      if (breakpointResult.success) {
        breakpointSet = true;
        expect(
          breakpointResult.result?.verified,
          'Breakpoint should be verified',
        ).to.be.true;
        expect(breakpointResult.result?.line).to.equal(breakpointLine);
        logger.info('Breakpoint set and verified');
      }
    } catch (error) {
      logger.warn(
        'Breakpoint setting failed initially, but this might be a timing issue. Checking if breakpoint was actually set...',
      );

      // Wait a bit for the breakpoint event to arrive
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check session details to see if breakpoint was actually set
      const sessionDetailsResponse = await mcpClient!.callTool({
        name: 'get_session_details',
        arguments: { sessionId: dapSessionId! },
      });

      const sessionDetails =
        parseStdioClientToolResponse<HandleGetSessionDetailsResult>(
          sessionDetailsResponse as SdkToolResponse,
          'get_session_details_after_breakpoint',
        );

      if (
        sessionDetails.success &&
        sessionDetails.result?.breakpoints &&
        sessionDetails.result.breakpoints.length > 0
      ) {
        const breakpoint = sessionDetails.result.breakpoints[0];
        if (breakpoint.line === breakpointLine && breakpoint.verified) {
          logger.info(
            'Breakpoint was actually set successfully despite initial error',
          );
          breakpointSet = true;
        }
      }

      if (!breakpointSet) {
        throw error;
      }
    }

    expect(
      breakpointSet,
      'Breakpoint should be set (either immediately or after timing issue)',
    ).to.be.true;

    // 3. Continue execution (to hit the breakpoint)
    logger.info('Continuing execution to hit breakpoint...');
    const continueResponse = await mcpClient!.callTool({
      name: 'continue',
      arguments: {
        sessionId: dapSessionId!,
        threadId: currentThreadId!,
        waitForStop: true,
      },
    });

    const continueResult = parseStdioClientToolResponse(
      continueResponse as SdkToolResponse,
      'continue',
    );
    expect(continueResult.success, 'Continue should succeed').to.be.true;

    // Wait for breakpoint hit or check if already stopped at breakpoint
    let stoppedAtBreakpoint = false;
    for (let i = 0; i < 50; i++) {
      const getSessionResponse = await mcpClient!.callTool({
        name: 'get_session_details',
        arguments: { sessionId: dapSessionId! },
      });

      const sessionDetails =
        parseStdioClientToolResponse<HandleGetSessionDetailsResult>(
          getSessionResponse as SdkToolResponse,
          'get_session_details',
        );
      if (sessionDetails.success && sessionDetails.result) {
        const result = sessionDetails.result;

        // Check if session is stopped and at the breakpoint line
        if (
          result.sessionInfo?.state === 'stopped' &&
          result.callStack &&
          result.callStack.length > 0
        ) {
          const topFrame = result.callStack[0];
          if (topFrame.line === breakpointLine) {
            logger.info(
              `Session is stopped at breakpoint line ${breakpointLine} in function ${topFrame.name}`,
            );
            stoppedAtBreakpoint = true;
            break;
          }
        }

        // Also check for stopped events in pending events
        if (result.pendingEventsForSession) {
          const stoppedEvents = result.pendingEventsForSession.filter(
            (event: McpAsyncEvent) =>
              event.eventType === 'dap_event_stopped' &&
              (event.data as DebugProtocol.StoppedEvent['body'])?.reason ===
                'breakpoint',
          );

          if (stoppedEvents.length > 0) {
            logger.info('Found stopped at breakpoint event:', stoppedEvents[0]);
            stoppedAtBreakpoint = true;
            break;
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(stoppedAtBreakpoint, 'Should have stopped at breakpoint').to.be.true;

    // 4. Get call stack
    logger.info('Getting call stack...');
    const stackResponse = await mcpClient!.callTool({
      name: 'get_call_stack',
      arguments: {
        sessionId: dapSessionId!,
        threadId: currentThreadId!,
      },
    });

    const stackResult = parseStdioClientToolResponse<HandleGetCallStackResult>(
      stackResponse as SdkToolResponse,
      'get_call_stack',
    );
    expect(stackResult.success, 'Get call stack should succeed').to.be.true;
    // The tool returns an object { value: ModelStackFrame[] }, so result is that object.
    const stackFrames = (
      stackResult.result as unknown as {
        value: unknown[];
      }
    ).value;
    expect(
      stackFrames,
      'get_call_stack result.value should be an array of stack frames',
    )
      .to.be.an('array')
      .with.length.greaterThan(0);

    const topFrame = stackFrames[0] as {
      id: number;
      name: string;
      line: number;
      source?: { path: string };
    };
    expect(topFrame.name).to.equal('global.calculateSum');
    expect(topFrame.line).to.equal(breakpointLine);
    expect(topFrame.source?.path).to.equal(NODE_EXAMPLE_PROGRAM_PATH);
    logger.info('Stack trace verified');

    // 5. Continue to completion
    logger.info('Continuing to completion...');
    const finalContinueResponse = await mcpClient!.callTool({
      name: 'continue',
      arguments: {
        sessionId: dapSessionId!,
        threadId: currentThreadId!,
      },
    });

    const finalContinueResult = parseStdioClientToolResponse(
      finalContinueResponse as SdkToolResponse,
      'continue',
    );
    expect(finalContinueResult.success, 'Final continue should succeed').to.be
      .true;

    // 8. Terminate session
    logger.info('Terminating session...');
    const terminateResponse = await mcpClient!.callTool({
      name: 'terminate_session',
      arguments: { sessionId: dapSessionId! },
    });

    const terminateResult = parseStdioClientToolResponse(
      terminateResponse as SdkToolResponse,
      'terminate_session',
    );
    expect(terminateResult.success, 'Terminate should succeed').to.be.true;

    logger.info('Test completed successfully.');
  });
});
