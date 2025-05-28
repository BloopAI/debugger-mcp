import * as path from 'path';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  AdapterConfig,
  DebugProtocol,
} from '@bloopai/ergonomic-debugger-client';
import { McpAsyncEvent } from '../src/types/mcp_protocol_extensions';
import {
  HandleStartDebugSessionResult,
  HandleSetBreakpointResult,
  HandleContinueResult,
  HandleGetCallStackResult,
  HandleGetSessionDetailsResult,
  HandleGetPendingAsyncEventsResult,
  HandleTerminateSessionResult,
} from '../src/types/toolResults';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENV_PATH = path.join(PROJECT_ROOT, '.test_python_mcp_venv_integration');
const PYTHON_EXECUTABLE_IN_VENV =
  process.platform === 'win32'
    ? path.join(VENV_PATH, 'Scripts', 'python.exe')
    : path.join(VENV_PATH, 'bin', 'python');
const PYTHON_COMMAND = process.env.PYTHON_COMMAND || 'python3';

const STDIO_TEST_SERVER_SCRIPT_PATH = path.join(
  __dirname,
  'stdio-test-server.ts',
);

let pythonExecutableInVenv: string;
let mcpClient: Client | null = null;
let tempAdapterConfigPath: string | null = null;

function setupPythonVirtualEnv(): string {
  console.log(
    `[INFO] Setting up Python virtual environment for MCP integration tests at: ${VENV_PATH}`,
  );
  if (fs.existsSync(VENV_PATH)) {
    console.log(
      `[INFO] Removing existing test virtual environment at: ${VENV_PATH}`,
    );
    fs.rmSync(VENV_PATH, { recursive: true, force: true });
  }
  try {
    execSync(`${PYTHON_COMMAND} -m venv ${VENV_PATH}`, {
      stdio: 'inherit',
      cwd: PROJECT_ROOT,
    });
    console.log('[INFO] Test virtual environment created.');
    execSync(`${PYTHON_EXECUTABLE_IN_VENV} -m pip install debugpy`, {
      stdio: 'inherit',
      cwd: PROJECT_ROOT,
    });
    console.log('[INFO] debugpy installed in test virtual environment.');
  } catch (error) {
    console.error(
      '[ERROR] Failed to set up Python virtual environment:',
      error,
    );
    throw error;
  }
  return PYTHON_EXECUTABLE_IN_VENV;
}

function cleanupPythonVirtualEnv(): void {
  if (fs.existsSync(VENV_PATH)) {
    console.log(
      `[INFO] Cleaning up Python virtual environment at: ${VENV_PATH}`,
    );
    fs.rmSync(VENV_PATH, { recursive: true, force: true });
    console.log('[INFO] Python virtual environment cleaned up.');
  }
}

import { parseStdioClientToolResponse, SdkToolResponse } from './test-utils';

describe('MCP Python Debugger Integration Test', function () {
  this.timeout(60000);

  before(async function () {
    this.timeout(90000);
    console.log('[INFO] Starting before hook for MCP Python tests...');
    try {
      pythonExecutableInVenv = setupPythonVirtualEnv();

      const pythonAdapterConfig: AdapterConfig = {
        type: 'python',
        command: pythonExecutableInVenv,
        args: ['-m', 'debugpy.adapter'],
      };
      const rootConfigObject = {
        adapters: {
          python: pythonAdapterConfig,
        },
      };
      const tempDir = path.join(PROJECT_ROOT, '.tmp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      tempAdapterConfigPath = path.join(
        tempDir,
        `test-adapterConfig-${randomUUID()}.json`,
      );
      fs.writeFileSync(
        tempAdapterConfigPath,
        JSON.stringify(rootConfigObject, null, 2),
      );
      console.log(
        `[INFO] Temporary adapter config for stdio server written to: ${tempAdapterConfigPath}`,
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
        name: 'mcp-test-client-stdio',
        version: '1.0.0',
      };
      mcpClient = new Client(clientIdentityArg);

      console.log('[INFO] Connecting MCP Client to StdioClientTransport...');
      await mcpClient.connect(transport);
      console.log(
        '[INFO] MCP Client connect() call completed (session should be initialized).',
      );
    } catch (e) {
      console.error('[ERROR] Critical error in before hook:', e);
      if (mcpClient) {
        await mcpClient
          .close()
          .catch((clientCloseErr) =>
            console.error(
              '[ERROR] Error closing MCP client during error handling:',
              clientCloseErr,
            ),
          );
      }
      if (tempAdapterConfigPath && fs.existsSync(tempAdapterConfigPath)) {
        try {
          fs.unlinkSync(tempAdapterConfigPath);
        } catch (err) {
          console.warn(
            '[WARN] Failed to cleanup temp config in error path',
            err,
          );
        }
      }
      throw e;
    }
    console.log('[INFO] Before hook completed.');
  });

  after(async function () {
    this.timeout(30000);
    console.log('[INFO] Starting after hook for MCP Python tests...');
    if (mcpClient) {
      console.log(
        '[INFO] Closing MCP Client (this should terminate the stdio server)...',
      );
      await mcpClient
        .close()
        .catch((err) =>
          console.warn('[WARN] Error closing MCP client in after hook:', err),
        );
      console.log('[INFO] MCP Client closed.');
    }
    mcpClient = null;

    if (tempAdapterConfigPath && fs.existsSync(tempAdapterConfigPath)) {
      try {
        fs.unlinkSync(tempAdapterConfigPath);
        console.log(
          `[INFO] Cleaned up temporary adapter config file: ${tempAdapterConfigPath}`,
        );
      } catch (cleanupError) {
        console.warn(
          `[WARN] Failed to clean up temp adapter config file ${tempAdapterConfigPath}:`,
          cleanupError,
        );
      }
      tempAdapterConfigPath = null;
    }
    cleanupPythonVirtualEnv();
    console.log('[INFO] After hook completed.');
  });

  it('should run a full Python debug session via MCP tools', async function () {
    this.timeout(45000);

    const programPath = path.join(
      PROJECT_ROOT,
      'examples',
      'python-example.py',
    );
    const programDir = path.dirname(programPath);
    let dapSessionId: string | null = null;

    expect(mcpClient, 'MCP Client must be initialized and exist').to.exist;

    // 1. Start Debug Session
    console.log('[INFO] Test: Attempting to start debug session...');
    const startResponseRaw: SdkToolResponse = await mcpClient!.callTool({
      serverName: 'interactive-debugger',
      name: 'start_debug_session',
      arguments: {
        targetType: 'python',
        targetPath: programPath,
        stopOnEntry: true,
        cwd: programDir,
        env: {
          PATH: `${path.dirname(pythonExecutableInVenv)}${path.delimiter}${process.env.PATH}`,
        },
        launchArgs: [],
      },
    });
    const startResponse =
      parseStdioClientToolResponse<HandleStartDebugSessionResult>(
        startResponseRaw,
        'start_debug_session',
      );

    expect(
      startResponse.success,
      `start_debug_session failed: ${startResponse.error}`,
    ).to.be.true;
    expect(startResponse.result, 'start_debug_session result should exist').to
      .exist;
    const startResult = startResponse.result!;
    expect(startResult.sessionId, 'DAP sessionId should be returned').to.be.a(
      'string',
    );
    dapSessionId = startResult.sessionId;
    console.log(
      `[INFO] Test: DAP Debug session started with ID: ${dapSessionId}`,
    );

    const initialStopEvent =
      startResult.stoppedEvent ||
      (startResponse.asyncEvents?.find(
        (e) =>
          e.eventType === 'dap_event_stopped' && e.sessionId === dapSessionId,
      )?.data as DebugProtocol.StoppedEvent['body']);
    expect(
      initialStopEvent,
      'Initial stopped event (entry/step) not found in startResponse.result.stoppedEvent',
    ).to.exist;
    // Allow 'entry' or 'step' for the initial stop.
    expect(
      initialStopEvent!.reason,
      `Initial stop reason should be 'entry' or 'step', but was '${initialStopEvent!.reason}'`,
    ).to.be.oneOf(['entry', 'step']);

    console.log(
      '[INFO] Test: Getting session details to find main thread ID...',
    );
    const sessionDetailsRaw: SdkToolResponse = await mcpClient!.callTool({
      serverName: 'interactive-debugger',
      name: 'get_session_details',
      arguments: {
        sessionId: dapSessionId!,
      },
    });
    const sessionDetailsResponse = parseStdioClientToolResponse(
      sessionDetailsRaw,
      'get_session_details',
    );
    expect(sessionDetailsResponse.success, 'get_session_details should succeed')
      .to.be.true;

    const sessionResult =
      sessionDetailsResponse.result as HandleGetSessionDetailsResult;
    expect(sessionResult?.threads, 'Should have threads').to.exist;
    expect(
      sessionResult!.threads!.length,
      'Should have at least one thread',
    ).to.be.greaterThan(0);

    const mainThreadId = sessionResult!.threads![0].id;
    console.log(`[INFO] Test: Found main thread ID: ${mainThreadId}`);

    // 2. Set Breakpoint
    const breakpointLine = 10;
    console.log(
      `[INFO] Test: Setting breakpoint at ${programPath}:${breakpointLine}`,
    );
    const bpResponseRaw: SdkToolResponse = await mcpClient!.callTool({
      serverName: 'interactive-debugger',
      name: 'set_breakpoint',
      arguments: {
        sessionId: dapSessionId!,
        filePath: programPath,
        lineNumber: breakpointLine,
      },
    });
    const bpResponse = parseStdioClientToolResponse<HandleSetBreakpointResult>(
      bpResponseRaw,
      'set_breakpoint',
    );
    expect(bpResponse.success, `set_breakpoint failed: ${bpResponse.error}`).to
      .be.true;
    const bpResult = bpResponse.result!;
    expect(bpResult.verified, 'Breakpoint should be verified').to.be.true;
    console.log('[INFO] Test: Breakpoint set and verified.');

    // 3. Continue execution (to hit the breakpoint)
    console.log('[INFO] Test: Continuing execution to hit breakpoint...');
    const continueToBpResponseRaw: SdkToolResponse = await mcpClient!.callTool({
      serverName: 'interactive-debugger',
      name: 'continue',
      arguments: {
        sessionId: dapSessionId!,
        threadId: mainThreadId!,
        waitForStop: true,
      },
    });
    const continueToBpResponse =
      parseStdioClientToolResponse<HandleContinueResult>(
        continueToBpResponseRaw,
        'continue_to_bp',
      );
    expect(
      continueToBpResponse.success,
      `First continue failed: ${continueToBpResponse.error}`,
    ).to.be.true;
    const continueToBpResult = continueToBpResponse.result!;
    // Check asyncEvents for the stopped event if not directly in result
    const breakpointStopEvent =
      continueToBpResult.stoppedEvent ||
      (continueToBpResponse.asyncEvents?.find(
        (e) =>
          e.eventType === 'dap_event_stopped' && e.sessionId === dapSessionId,
      )?.data as DebugProtocol.StoppedEvent['body']);
    expect(
      breakpointStopEvent,
      'Breakpoint stop event not found in continueToBpResponse.result.stoppedEvent',
    ).to.exist;
    expect(breakpointStopEvent!.reason).to.equal('breakpoint');
    expect(breakpointStopEvent!.threadId).to.equal(mainThreadId);
    console.log(`[INFO] Test: Stopped at breakpoint.`);

    // 4. Get Call Stack (to verify breakpoint line)
    console.log('[INFO] Test: Getting call stack to verify breakpoint line...');
    const stackResponseRaw: SdkToolResponse = await mcpClient!.callTool({
      serverName: 'interactive-debugger',
      name: 'get_call_stack',
      arguments: {
        sessionId: dapSessionId!,
        threadId: mainThreadId!,
      },
    });
    const stackResponse = parseStdioClientToolResponse<{
      value: HandleGetCallStackResult;
    }>(stackResponseRaw, 'get_call_stack_at_bp');
    expect(
      stackResponse.success,
      `get_call_stack failed: ${stackResponse.error}`,
    ).to.be.true;
    // The tool returns an object { value: ModelStackFrame[] }, so result is that object.
    const stackResult = stackResponse.result!.value;
    expect(
      stackResult,
      'get_call_stack result.value should be an array of stack frames',
    )
      .to.be.an('array')
      .with.length.greaterThan(0);
    const topFrame = stackResult[0];
    expect(topFrame.name).to.equal('calculate_sum');
    expect(
      topFrame.line,
      `Top frame line should be ${breakpointLine} for breakpoint stop`,
    ).to.equal(breakpointLine);
    expect(topFrame.source?.path).to.equal(programPath);
    console.log(
      `[INFO] Test: Call stack verified, stopped at line ${topFrame.line}.`,
    );

    // 5. Continue execution (to let the program finish or error out)
    console.log('[INFO] Test: Continuing execution to completion/error...');
    const finalContinueResponseRaw: SdkToolResponse = await mcpClient!.callTool(
      {
        serverName: 'interactive-debugger',
        name: 'continue',
        arguments: {
          sessionId: dapSessionId!,
          threadId: mainThreadId!,
        },
      },
    );
    const finalContinueResponse =
      parseStdioClientToolResponse<HandleContinueResult>(
        finalContinueResponseRaw,
        'continue_to_completion',
      );
    expect(
      finalContinueResponse.success,
      `Second continue failed: ${finalContinueResponse.error}`,
    ).to.be.true;

    // 6. Verify Output
    let errorOutputReceived = false;
    const allAsyncEvents: McpAsyncEvent[] = [];
    const _finalContinueResult = finalContinueResponse.result;

    // Check events piggybacked on the continue response
    if (
      finalContinueResponse.asyncEvents &&
      Array.isArray(finalContinueResponse.asyncEvents)
    ) {
      allAsyncEvents.push(...finalContinueResponse.asyncEvents);
    }

    for (const event of allAsyncEvents) {
      if (event.eventType === 'dap_event_output') {
        const outputEventBody = event.data as DebugProtocol.OutputEvent['body'];
        if (
          outputEventBody?.output?.includes(
            'Error occurred: list index out of range',
          )
        ) {
          errorOutputReceived = true;
          console.log(
            '[INFO] Test: Expected error output received from Python script via piggybacked asyncEvents.',
          );
          break;
        }
      }
    }

    // If not found in piggybacked events, call get_pending_async_events
    if (!errorOutputReceived) {
      console.log(
        '[INFO] Test: Error output not found in continue response, calling get_pending_async_events...',
      );
      const pendingEventsResponseRaw: SdkToolResponse =
        await mcpClient!.callTool({
          serverName: 'interactive-debugger',
          name: 'get_pending_async_events',
          arguments: {},
        });
      const pendingEventsResponse =
        parseStdioClientToolResponse<HandleGetPendingAsyncEventsResult>(
          pendingEventsResponseRaw,
          'get_pending_async_events_for_error',
        );
      expect(
        pendingEventsResponse.success,
        `get_pending_async_events failed: ${pendingEventsResponse.error}`,
      ).to.be.true;
      const pendingEventsResult = pendingEventsResponse.result!;
      const pendingEvents = pendingEventsResult.events || [];
      allAsyncEvents.push(...pendingEvents);

      for (const event of pendingEvents) {
        if (event.eventType === 'dap_event_output') {
          const outputEventBody =
            event.data as DebugProtocol.OutputEvent['body'];
          if (
            outputEventBody?.output?.includes(
              'Error occurred: list index out of range',
            )
          ) {
            errorOutputReceived = true;
            console.log(
              '[INFO] Test: Expected error output received from Python script via get_pending_async_events.',
            );
            break;
          }
        }
      }
    }
    expect(
      errorOutputReceived,
      'Expected error output from Python script was not received in asyncEvents or get_pending_async_events',
    ).to.be.true;
    console.log('[INFO] Test: Program has run and error output was received.');

    // 7. Terminate Session
    console.log('[INFO] Test: Terminating debug session explicitly...');
    const terminateResponseRaw: SdkToolResponse = await mcpClient!.callTool({
      serverName: 'interactive-debugger',
      name: 'terminate_session',
      arguments: {
        sessionId: dapSessionId!,
      },
    });
    const terminateResponse =
      parseStdioClientToolResponse<HandleTerminateSessionResult>(
        terminateResponseRaw,
        'terminate_session_explicit',
      );
    expect(
      terminateResponse.success,
      `terminate_session failed: ${terminateResponse.error}`,
    ).to.be.true;
    const _terminateResult = terminateResponse.result;
    console.log('[INFO] Test: Debug session termination acknowledged by tool.');

    // 8. Verify that an 'unexpected_session_termination' event was generated due to the termination.
    // This event should now be available after the terminate_session call.
    console.log(
      '[INFO] Test: Checking for session termination event after explicit terminate call...',
    );
    let terminationEventFound = false;

    // Check asyncEvents from the terminateResponse itself
    if (
      terminateResponse.asyncEvents &&
      Array.isArray(terminateResponse.asyncEvents)
    ) {
      allAsyncEvents.push(...terminateResponse.asyncEvents);
    }

    // Call get_pending_async_events to fetch any further events generated by the termination.
    const postTerminateEventsResponseRaw: SdkToolResponse =
      await mcpClient!.callTool({
        serverName: 'interactive-debugger',
        name: 'get_pending_async_events',
        arguments: {},
      });
    const postTerminateEventsResponse =
      parseStdioClientToolResponse<HandleGetPendingAsyncEventsResult>(
        postTerminateEventsResponseRaw,
        'get_pending_events_after_terminate_explicit',
      );
    expect(
      postTerminateEventsResponse.success,
      `get_pending_async_events after terminate failed: ${postTerminateEventsResponse.error}`,
    ).to.be.true;
    const postTerminateEventsResult = postTerminateEventsResponse.result!;
    const postTerminatePendingEvents = postTerminateEventsResult.events || [];
    allAsyncEvents.push(...postTerminatePendingEvents);

    for (const event of allAsyncEvents) {
      if (
        event.eventType === 'unexpected_session_termination' &&
        event.sessionId === dapSessionId
      ) {
        terminationEventFound = true;
        console.log(
          '[INFO] Test: "unexpected_session_termination" event found for the session.',
          event.data,
        );
        const terminationData = event.data as {
          reason?: string;
          [key: string]: unknown;
        };
        expect(terminationData.reason).to.be.a('string');
        break;
      }
    }
    expect(
      terminationEventFound,
      'Session termination event ("unexpected_session_termination") not found after explicit terminate call.',
    ).to.be.true;
    console.log(
      '[INFO] Test: Program termination and session cleanup confirmed through events.',
    );
  });
});
