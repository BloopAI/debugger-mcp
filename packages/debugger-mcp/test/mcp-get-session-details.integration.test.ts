import { expect } from 'chai';
import * as path from 'path';
import type { DebugProtocol } from '@bloopai/ergonomic-debugger-client';
import {
  StartDebugSessionArgs,
  GetSessionDetailsArgs,
  TerminateSessionArgs,
} from '../src/types/toolArgs';
import { HandleGetSessionDetailsResult } from '../src/types/toolResults';
import { SessionState } from '../src/types';
import { McpAsyncEvent } from '../src/types/mcp_protocol_extensions';
import {
  parseStdioClientToolResponse,
  setupMcpClient,
  cleanupMcpClient,
  TestClientSetup,
  SdkToolResponse,
} from './test-utils';

const PYTHON_EXAMPLE_PATH = path.join(
  path.resolve(__dirname, '../'),
  'examples',
  'python-example.py',
);

describe('MCP Get Session Details Integration Test (uv)', function () {
  this.timeout(60000);

  let testClientSetup: TestClientSetup | null = null;

  before(async function () {
    console.log(
      '[INFO] Starting before hook for MCP Get Session Details tests (uv)...',
    );
    testClientSetup = await setupMcpClient(
      'mcp-get-session-details-uv-test-client',
    );
    console.log('[INFO] Before hook completed using shared setupMcpClient.');
  });

  after(async function () {
    console.log(
      '[INFO] Starting after hook for MCP Get Session Details tests (uv)...',
    );
    await cleanupMcpClient(testClientSetup);
    console.log('[INFO] After hook completed using shared cleanupMcpClient.');
  });

  it('should retrieve detailed information for an active (paused) debug session using uv adapter', async function () {
    expect(testClientSetup).to.exist;
    expect(testClientSetup?.client).to.exist;
    const client = testClientSetup!.client!;

    const startArgs: StartDebugSessionArgs = {
      targetPath: PYTHON_EXAMPLE_PATH,
      targetType: 'python',
      stopOnEntry: true,
    };
    console.log(
      `[Test] Calling start_debug_session with args: ${JSON.stringify(startArgs)}`,
    );
    const startResponseRaw: SdkToolResponse = await client.callTool({
      serverName: 'interactive-debugger',
      name: 'start_debug_session',
      arguments: { ...startArgs },
    });
    const startResponse = parseStdioClientToolResponse<{
      sessionId: string;
      stoppedEvent?: DebugProtocol.StoppedEvent['body'];
    }>(startResponseRaw, 'start_debug_session');

    console.log(
      `[Test] start_debug_session response: ${JSON.stringify(startResponse, null, 2)}`,
    );
    expect(
      startResponse.success,
      `start_debug_session failed: ${startResponse.error}`,
    ).to.be.true;
    expect(startResponse.result?.sessionId).to.be.a('string');
    const sessionId = startResponse.result!.sessionId;

    const stoppedEventInResponse = startResponse.asyncEvents?.find(
      (e: McpAsyncEvent) =>
        e.eventType === 'dap_event_stopped' && e.sessionId === sessionId,
    );
    if (!startResponse.result?.stoppedEvent && !stoppedEventInResponse) {
      console.warn(
        '[Test] dap_event_stopped not found in initial response or asyncEvents. Proceeding, assuming session is paused due to stopOnEntry.',
      );
    } else {
      console.log(
        '[Test] Session stopped on entry (either via direct result or asyncEvents).',
      );
    }

    const getDetailsArgs: GetSessionDetailsArgs = { sessionId };
    console.log(
      `[Test] Calling get_session_details for session ${sessionId}...`,
    );
    const getDetailsResponseRaw: SdkToolResponse = await client.callTool({
      serverName: 'interactive-debugger',
      name: 'get_session_details',
      arguments: { ...getDetailsArgs },
    });
    const getDetailsResponse =
      parseStdioClientToolResponse<HandleGetSessionDetailsResult>(
        getDetailsResponseRaw,
        'get_session_details',
      );

    console.log(
      `[Test] get_session_details response: ${JSON.stringify(getDetailsResponse, null, 2)}`,
    );
    expect(
      getDetailsResponse.success,
      `get_session_details failed: ${getDetailsResponse.error}`,
    ).to.be.true;

    let details = getDetailsResponse.result;
    expect(details).to.exist;

    // If stopOnEntry is true, the session should ideally be stopped.
    // If it's still initializing, wait a bit and retry get_session_details.
    if (details && startArgs.stopOnEntry) {
      const MAX_RETRIES = 5;
      const RETRY_DELAY_MS = 300;
      let retries = MAX_RETRIES;

      // Poll if state is INITIALIZING or even ACTIVE, waiting for it to become STOPPED
      while (
        details!.sessionInfo.state !== SessionState.STOPPED &&
        retries > 0
      ) {
        console.log(
          `[Test] Session state is ${details!.sessionInfo.state}, expecting STOPPED. Retrying get_session_details (retries left: ${retries}, delay: ${RETRY_DELAY_MS}ms)...`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

        const retryGetDetailsResponseRaw: SdkToolResponse =
          await client.callTool({
            serverName: 'interactive-debugger',
            name: 'get_session_details',
            arguments: { sessionId },
          });
        const retryGetDetailsResponse =
          parseStdioClientToolResponse<HandleGetSessionDetailsResult>(
            retryGetDetailsResponseRaw,
            'get_session_details',
          );
        details = retryGetDetailsResponse.result;
        expect(
          retryGetDetailsResponse.success,
          `Retry get_session_details failed: ${retryGetDetailsResponse.error}`,
        ).to.be.true;
        expect(details).to.exist;
        retries--;
      }
      console.log(
        `[Test] Final get_session_details response state after ${MAX_RETRIES - retries} retries: ${details?.sessionInfo.state}`,
      );
    }

    if (details) {
      expect(details.sessionInfo.id).to.equal(sessionId);
      expect(details.sessionInfo.targetPath).to.equal(PYTHON_EXAMPLE_PATH);
      expect(details.sessionInfo.targetType).to.equal('python');

      // If stopOnEntry was true, we now expect it to be STOPPED after the potential retry.
      // If stopOnEntry was false, it would be RUNNING.
      if (startArgs.stopOnEntry) {
        expect(
          details.sessionInfo.state,
          `Expected session to be STOPPED after polling (stopOnEntry:true). Final state: ${details.sessionInfo.state}`,
        ).to.equal(SessionState.STOPPED);
      } else {
        expect(
          details.sessionInfo.state,
          'Expected session to be RUNNING (stopOnEntry:false or not specified)',
        ).to.equal(SessionState.RUNNING);
      }
      expect(details.threads).to.be.an('array').with.length.greaterThan(0);
      if (details.threads && details.threads.length > 0) {
        expect(details.threads[0].id).to.be.a('number');
        expect(details.threads[0].name).to.be.a('string');
      }

      const wasActuallyStopped =
        details.sessionInfo.state === SessionState.STOPPED ||
        startResponse.result?.stoppedEvent ||
        stoppedEventInResponse;
      if (wasActuallyStopped) {
        expect(
          details.callStack,
          'Expected callStack for a paused session',
        ).to.be.an('array');
        if (details.callStack && details.callStack.length > 0) {
          const topFrame = details.callStack[0];
          expect(topFrame.id).to.be.a('number');
          expect(topFrame.name).to.be.a('string');
          expect(topFrame.line).to.be.a('number');
          expect(topFrame.source).to.exist;
          if (topFrame.source) {
            expect(topFrame.source.path).to.be.a('string');
          }
        } else if (details.sessionInfo.state === SessionState.STOPPED) {
          console.warn(
            '[Test] Session is STOPPED but no call stack was returned.',
          );
        }
      } else {
        console.warn(
          '[Test] Session was not confirmed stopped, skipping call stack check details.',
        );
      }
    }

    const terminateArgs: TerminateSessionArgs = { sessionId };
    console.log(`[Test] Terminating session: ${sessionId}`);
    const terminateResponseRaw: SdkToolResponse = await client.callTool({
      serverName: 'interactive-debugger',
      name: 'terminate_session',
      arguments: { ...terminateArgs },
    });
    const terminateResponse = parseStdioClientToolResponse<unknown>(
      terminateResponseRaw,
      'terminate_session',
    );
    expect(
      terminateResponse.success,
      `terminate_session failed: ${terminateResponse.error}`,
    ).to.be.true;
    console.log('[Test] Session terminated.');
  });
});
