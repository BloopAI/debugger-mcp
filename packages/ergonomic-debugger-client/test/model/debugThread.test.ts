import { expect } from 'chai';
import * as sinon from 'sinon';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DebugThread } from '../../src/model/DebugThread';
import { DebugStackFrame } from '../../src/model/DebugStackFrame';
import {
  MockDAPSessionHandler,
  createMockLogger,
} from './mocks/mockDAPSessionHandler';
import { LoggerInterface } from '../../src/logging';
// StateFetchErrorNotifier is used internally by model classes, we'll spy on the session handler's method it calls.

describe('DebugThread', () => {
  let mockSessionHandler: MockDAPSessionHandler;
  let mockLogger: LoggerInterface;
  let thread: DebugThread;

  const THREAD_ID = 1;
  const THREAD_NAME = 'MainThread';

  // Define mockStackTraceResponse at a higher scope
  const mockStackTraceResponse: DebugProtocol.StackTraceResponse = {
    request_seq: 1,
    seq: 1,
    success: true,
    command: 'stackTrace',
    type: 'response',
    body: {
      stackFrames: [
        {
          id: 100,
          name: 'Frame1',
          source: { name: 'source1.ts', path: '/path/to/source1.ts' },
          line: 10,
          column: 1,
        },
        {
          id: 101,
          name: 'Frame2',
          source: { name: 'source2.ts', path: '/path/to/source2.ts' },
          line: 20,
          column: 1,
        },
      ],
      totalFrames: 2,
    },
  };

  beforeEach(() => {
    mockSessionHandler = new MockDAPSessionHandler();
    mockLogger = createMockLogger();
    // Corrected constructor arguments: id, name, sessionHandler, logger
    thread = new DebugThread(
      THREAD_ID,
      THREAD_NAME,
      mockSessionHandler,
      mockLogger,
    );
  });

  afterEach(() => {
    sinon.restore(); // Restores all stubs, spies, and mocks
    mockSessionHandler.reset(); // Reset history on the mock handler's stubs
  });

  describe('Constructor', () => {
    it('should initialize properties correctly', () => {
      expect(thread.id).to.equal(THREAD_ID);
      expect(thread.name).to.equal(THREAD_NAME);
      expect(thread.callStack).to.be.an('array').that.is.empty;
      expect(thread.stopped).to.be.false;
      expect(thread.stoppedDetails).to.be.undefined;
    });
  });

  describe('fetchCallStack()', () => {
    // Define the matcher once for this describe block
    const expectedOptionsMatcher = sinon.match({
      allowedStates: ['active', 'stopped', 'initialized'],
    });

    it('should fetch call stack successfully, populate DebugStackFrame instances, and emit "callStackRefreshed"', async () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);

      const expectedArgsMatcher = sinon.match({
        threadId: THREAD_ID,
        startFrame: 0,
        levels: undefined,
      });
      mockSessionHandler.sendRequest
        .withArgs(
          'stackTrace',
          expectedArgsMatcher,
          expectedOptionsMatcher,
          sinon.match.any,
        )
        .resolves(mockStackTraceResponse); // Resolve with full response

      const stackFrames = await thread.fetchCallStack();

      expect(
        mockSessionHandler.sendRequest.calledOnceWith(
          'stackTrace',
          expectedArgsMatcher,
        ),
      ).to.be.true;
      expect(stackFrames).to.be.an('array').with.lengthOf(2);
      expect(stackFrames[0]).to.be.instanceOf(DebugStackFrame);
      expect(stackFrames[0].id).to.equal(100);
      expect(stackFrames[0].name).to.equal('Frame1');
      expect(stackFrames[1]).to.be.instanceOf(DebugStackFrame);
      expect(stackFrames[1].id).to.equal(101);
      expect(thread.callStack).to.deep.equal(stackFrames); // Internal state updated

      expect(callStackRefreshedSpy.calledOnce).to.be.true;
      const [emittedFrames] = callStackRefreshedSpy.firstCall.args;
      expect(emittedFrames).to.deep.equal(stackFrames);
    });

    it('should use specified startFrame and levels when provided and emit "callStackRefreshed"', async () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);

      const expectedArgs = { threadId: THREAD_ID, startFrame: 5, levels: 10 };
      mockSessionHandler.sendRequest
        .withArgs(
          'stackTrace',
          sinon.match(expectedArgs),
          expectedOptionsMatcher,
          sinon.match.any,
        )
        .resolves(mockStackTraceResponse); // Resolve with full response

      await thread.fetchCallStack(5, 10);

      expect(
        mockSessionHandler.sendRequest.calledOnceWith(
          'stackTrace',
          sinon.match(expectedArgs),
        ),
      ).to.be.true;
      expect(callStackRefreshedSpy.calledOnce).to.be.true; // Ensure event is still emitted
    });

    it('should handle fetch failure (DAP error from undefined response), clear call stack, emit "callStackFetchFailed", and resolve with empty array', async () => {
      const defaultArgsMatcher = sinon.match({
        threadId: THREAD_ID,
        startFrame: 0,
        levels: undefined,
      });
      mockSessionHandler.sendRequest
        .withArgs(
          'stackTrace',
          defaultArgsMatcher,
          expectedOptionsMatcher,
          sinon.match.any,
        )
        .resolves(mockStackTraceResponse);

      await thread.fetchCallStack();
      expect(thread.callStack).to.not.be.empty;

      mockSessionHandler.sendRequest.reset();

      const callStackFetchFailedSpy = sinon.spy();
      thread.on('callStackFetchFailed', callStackFetchFailedSpy);

      // Simulate DAP error by resolving with a response where success is false or body is missing
      const errorResponse = {
        request_seq: mockStackTraceResponse.request_seq,
        seq: mockStackTraceResponse.seq,
        type: 'response' as const,
        command: mockStackTraceResponse.command,
        success: false,
        message: 'Adapter error for undefined body test',
        body: undefined, // Simulate undefined body
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .withArgs(
          'stackTrace',
          defaultArgsMatcher,
          expectedOptionsMatcher,
          sinon.match.any,
        )
        .resolves(errorResponse);

      const resultOfFailingCall = await thread.fetchCallStack();

      expect(resultOfFailingCall).to.be.an('array').that.is.empty;
      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true;
      expect(thread.callStack).to.be.an('array').that.is.empty; // Internal state cleared

      expect(callStackFetchFailedSpy.calledOnce).to.be.true;
      const [error] = callStackFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.equal(
        `Failed to retrieve stack frames for thread ID ${THREAD_ID}. Adapter returned no stack frames.`,
      );
    });

    it('should handle fetch failure (network/protocol error from sendRequest reject), clear stack, emit "callStackFetchFailed", and resolve with empty array', async () => {
      const defaultArgsMatcher = sinon.match({
        threadId: THREAD_ID,
        startFrame: 0,
        levels: undefined,
      });
      mockSessionHandler.sendRequest
        .withArgs(
          'stackTrace',
          defaultArgsMatcher,
          expectedOptionsMatcher,
          sinon.match.any,
        )
        .resolves(mockStackTraceResponse);
      await thread.fetchCallStack();
      expect(thread.callStack).to.not.be.empty;

      mockSessionHandler.sendRequest.reset();

      const callStackFetchFailedSpy = sinon.spy();
      thread.on('callStackFetchFailed', callStackFetchFailedSpy);

      const networkError = new Error('Network issue');
      mockSessionHandler.sendRequest
        .withArgs(
          'stackTrace',
          defaultArgsMatcher,
          expectedOptionsMatcher,
          sinon.match.any,
        )
        .rejects(networkError);

      const result = await thread.fetchCallStack();

      expect(result).to.be.an('array').that.is.empty;
      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true;
      expect(thread.callStack).to.be.an('array').that.is.empty; // Internal state cleared

      expect(callStackFetchFailedSpy.calledOnce).to.be.true;
      const [error] = callStackFetchFailedSpy.firstCall.args;
      expect(error).to.equal(networkError);
    });

    it('should deduplicate concurrent fetchCallStack calls and emit "callStackRefreshed" once', async () => {
      const delay = 50;
      const promise = new Promise<DebugProtocol.StackTraceResponse>(
        (resolve) => {
          // Promise of full response
          setTimeout(() => resolve(mockStackTraceResponse), delay);
        },
      );
      mockSessionHandler.sendRequest
        .withArgs(
          'stackTrace',
          sinon.match.any,
          expectedOptionsMatcher,
          sinon.match.any,
        )
        .returns(promise);

      const p1 = thread.fetchCallStack();
      const p2 = thread.fetchCallStack();
      const p3 = thread.fetchCallStack();

      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);

      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true; // sendRequest still called once

      const results = await Promise.all([p1, p2, p3]);

      expect(results[0]).to.be.an('array').with.lengthOf(2);
      expect(results[1]).to.be.an('array').with.lengthOf(2);
      expect(results[2]).to.be.an('array').with.lengthOf(2);
      expect(results[0]?.[0].id).to.equal(
        mockStackTraceResponse.body.stackFrames[0].id,
      );

      expect(callStackRefreshedSpy.calledOnce).to.be.true; // Event emitted once
      const [emittedFrames] = callStackRefreshedSpy.firstCall.args;
      expect(emittedFrames).to.deep.equal(results[0]); // Check payload
    });

    it('should allow a new fetch after a previous one completed, emitting "callStackRefreshed" each time', async () => {
      mockSessionHandler.sendRequest
        .onFirstCall()
        .resolves(mockStackTraceResponse)
        .onSecondCall()
        .resolves({
          ...mockStackTraceResponse,
          body: {
            ...mockStackTraceResponse.body,
            stackFrames: [mockStackTraceResponse.body.stackFrames[0]],
          },
        });

      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);

      await thread.fetchCallStack(); // First call
      expect(mockSessionHandler.sendRequest.callCount).to.equal(1);
      expect(thread.callStack).to.have.lengthOf(2);
      expect(callStackRefreshedSpy.callCount).to.equal(1);
      expect(callStackRefreshedSpy.firstCall.args[0]).to.have.lengthOf(2);

      callStackRefreshedSpy.resetHistory(); // Reset for second call

      const newStackFrames = await thread.fetchCallStack(); // Second call
      expect(mockSessionHandler.sendRequest.callCount).to.equal(2);
      expect(newStackFrames).to.have.lengthOf(1);
      expect(thread.callStack).to.have.lengthOf(1);
      expect(callStackRefreshedSpy.callCount).to.equal(1);
      expect(callStackRefreshedSpy.firstCall.args[0]).to.have.lengthOf(1);
    });

    it('should allow a new fetch after a previous one failed (DAP error from undefined response), emitting appropriate events', async () => {
      const errorResponseUndefinedBody = {
        request_seq: mockStackTraceResponse.request_seq,
        seq: mockStackTraceResponse.seq,
        type: 'response' as const,
        command: mockStackTraceResponse.command,
        success: false,
        body: undefined, // Simulate undefined body
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .onFirstCall()
        .resolves(errorResponseUndefinedBody)
        .onSecondCall()
        .resolves(mockStackTraceResponse);

      const callStackFetchFailedSpy = sinon.spy();
      thread.on('callStackFetchFailed', callStackFetchFailedSpy);
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);

      await thread.fetchCallStack(); // First call (fails)

      expect(mockSessionHandler.sendRequest.callCount).to.equal(1);
      expect(thread.callStack).to.be.empty;
      expect(callStackFetchFailedSpy.calledOnce).to.be.true;
      expect(callStackRefreshedSpy.called).to.be.false;

      callStackFetchFailedSpy.resetHistory(); // Reset for second call

      const stackFrames = await thread.fetchCallStack(); // Second call (succeeds)
      expect(mockSessionHandler.sendRequest.callCount).to.equal(2);
      expect(stackFrames).to.be.an('array').with.lengthOf(2);
      expect(thread.callStack).to.deep.equal(stackFrames);
      expect(callStackFetchFailedSpy.called).to.be.false;
      expect(callStackRefreshedSpy.calledOnce).to.be.true;
    });

    it('should allow a new fetch after a previous one failed (network error), emitting appropriate events', async () => {
      const networkError = new Error('First fetch network error');
      mockSessionHandler.sendRequest
        .onFirstCall()
        .rejects(networkError)
        .onSecondCall()
        .resolves(mockStackTraceResponse);

      const callStackFetchFailedSpy = sinon.spy();
      thread.on('callStackFetchFailed', callStackFetchFailedSpy);
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);

      await thread.fetchCallStack(); // First call (fails)

      expect(mockSessionHandler.sendRequest.callCount).to.equal(1);
      expect(thread.callStack).to.be.empty;
      expect(callStackFetchFailedSpy.calledOnce).to.be.true;
      expect(callStackRefreshedSpy.called).to.be.false;

      callStackFetchFailedSpy.resetHistory(); // Reset for second call

      const stackFrames = await thread.fetchCallStack(); // Second call (succeeds)
      expect(mockSessionHandler.sendRequest.callCount).to.equal(2);
      expect(stackFrames).to.be.an('array').with.lengthOf(2);
      expect(thread.callStack).to.deep.equal(stackFrames);
      expect(callStackFetchFailedSpy.called).to.be.false;
      expect(callStackRefreshedSpy.calledOnce).to.be.true;
    });
  });

  describe('Edge Case DAP Responses for fetchCallStack()', () => {
    it('should handle response with empty stackFrames array, emit "callStackRefreshed" with empty array', async () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);
      const callStackFetchFailedSpy = sinon.spy();
      thread.on('callStackFetchFailed', callStackFetchFailedSpy);

      const emptyFramesFullResponse: DebugProtocol.StackTraceResponse = {
        ...mockStackTraceResponse,
        body: {
          stackFrames: [],
          totalFrames: 0,
        },
      };
      mockSessionHandler.sendRequest.resolves(emptyFramesFullResponse);

      // Populate first to ensure 'callStackRefreshed' is for the new empty state
      mockSessionHandler.sendRequest.resolves(mockStackTraceResponse);
      await thread.fetchCallStack();
      callStackRefreshedSpy.resetHistory();
      mockSessionHandler.sendRequest.reset(); // Reset for the actual test call
      mockSessionHandler.sendRequest.withArgs(
        'stackTrace',
        sinon.match.any,
        undefined,
        sinon.match.any,
      ); // Re-apply withArgs for the next call

      mockSessionHandler.sendRequest.resolves(emptyFramesFullResponse);
      const stackFrames = await thread.fetchCallStack();

      expect(stackFrames).to.be.an('array').that.is.empty;
      expect(thread.callStack).to.be.an('array').that.is.empty;
      expect(callStackRefreshedSpy.calledOnceWith([])).to.be.true;
      expect(callStackFetchFailedSpy.called).to.be.false;
    });

    it('should handle response with null stackFrames, emit "callStackFetchFailed", and return empty array', async () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);
      const callStackFetchFailedSpy = sinon.spy();
      thread.on('callStackFetchFailed', callStackFetchFailedSpy);

      const nullFramesFullResponse: DebugProtocol.StackTraceResponse = {
        ...mockStackTraceResponse,
        body: {
          // @ts-expect-error Testing invalid DAP response
          stackFrames: null,
          totalFrames: 0,
        },
      };
      mockSessionHandler.sendRequest.resolves(nullFramesFullResponse);

      const stackFrames = await thread.fetchCallStack();

      expect(stackFrames).to.be.an('array').that.is.empty;
      expect(thread.callStack).to.be.an('array').that.is.empty;
      expect(callStackFetchFailedSpy.calledOnce).to.be.true;
      const [error] = callStackFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no stack frames');
      expect(callStackRefreshedSpy.called).to.be.false;
    });

    it('should handle response with null body, emit "callStackFetchFailed", and return empty array', async () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);
      const callStackFetchFailedSpy = sinon.spy();
      thread.on('callStackFetchFailed', callStackFetchFailedSpy);

      // This is effectively the same as mockSessionHandler.sendRequest.resolves(undefined)
      // which is already tested, but this ensures the model's internal check for `responseBody` handles it.
      const nullBodyResponse = {
        request_seq: mockStackTraceResponse.request_seq,
        seq: mockStackTraceResponse.seq,
        type: 'response' as const,
        command: mockStackTraceResponse.command,
        success: false,
        body: null, // Body can be null for an error response
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest.resolves(nullBodyResponse);

      const stackFrames = await thread.fetchCallStack();

      expect(stackFrames).to.be.an('array').that.is.empty;
      expect(thread.callStack).to.be.an('array').that.is.empty;
      expect(callStackFetchFailedSpy.calledOnce).to.be.true;
      const [error] = callStackFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no stack frames');
      expect(callStackRefreshedSpy.called).to.be.false;
    });

    it('should handle response with empty body object, emit "callStackFetchFailed", and return empty array', async () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);
      const callStackFetchFailedSpy = sinon.spy();
      thread.on('callStackFetchFailed', callStackFetchFailedSpy);

      const emptyBodyFullResponse: DebugProtocol.StackTraceResponse = {
        ...mockStackTraceResponse,
        body: {} as DebugProtocol.StackTraceResponse['body'], // Cast to bypass type check for test
      };
      mockSessionHandler.sendRequest.resolves(emptyBodyFullResponse);

      const stackFrames = await thread.fetchCallStack();

      expect(stackFrames).to.be.an('array').that.is.empty;
      expect(thread.callStack).to.be.an('array').that.is.empty;
      expect(callStackFetchFailedSpy.calledOnce).to.be.true;
      const [error] = callStackFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no stack frames');
      expect(callStackRefreshedSpy.called).to.be.false;
    });
  });

  describe('Sequential Fetch and Clear Operations', () => {
    it('should handle fetch (success) -> clear -> fetch (success with different data)', async () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);

      const firstFullResponse = mockStackTraceResponse;
      const secondResponseFrames = [
        {
          id: 200,
          name: 'FrameNew1',
          source: { name: 'new1.ts', path: '/path/to/new1.ts' },
          line: 1,
          column: 1,
        },
      ];
      const secondFullResponse: DebugProtocol.StackTraceResponse = {
        ...mockStackTraceResponse,
        body: {
          ...mockStackTraceResponse.body,
          stackFrames: secondResponseFrames,
          totalFrames: 1,
        },
      };

      mockSessionHandler.sendRequest
        .onFirstCall()
        .resolves(firstFullResponse)
        .onSecondCall()
        .resolves(secondFullResponse);

      // 1. First fetch (success)
      let stackFrames = await thread.fetchCallStack();
      expect(stackFrames).to.have.lengthOf(
        firstFullResponse.body.stackFrames.length,
      );
      expect(thread.callStack).to.deep.equal(stackFrames);
      expect(callStackRefreshedSpy.calledOnceWith(stackFrames)).to.be.true;
      callStackRefreshedSpy.resetHistory();

      // 2. Clear call stack
      thread.clearCallStack();
      expect(thread.callStack).to.be.empty;
      expect(callStackRefreshedSpy.calledOnceWith([])).to.be.true; // Emits with empty array
      callStackRefreshedSpy.resetHistory();

      // 3. Second fetch (success with different data)
      stackFrames = await thread.fetchCallStack();
      expect(stackFrames).to.have.lengthOf(secondResponseFrames.length);
      expect(stackFrames[0].id).to.equal(secondResponseFrames[0].id);
      expect(thread.callStack).to.deep.equal(stackFrames);
      expect(callStackRefreshedSpy.calledOnceWith(stackFrames)).to.be.true;

      expect(mockSessionHandler.sendRequest.callCount).to.equal(2);
    });

    it('should handle fetch (success) -> clear -> fetch (DAP error)', async () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);
      const callStackFetchFailedSpy = sinon.spy();
      thread.on('callStackFetchFailed', callStackFetchFailedSpy);

      const firstFullResponse = mockStackTraceResponse;
      const errorResponseUndefinedBody = {
        request_seq: mockStackTraceResponse.request_seq,
        seq: mockStackTraceResponse.seq,
        type: 'response' as const,
        command: mockStackTraceResponse.command,
        success: false,
        body: undefined, // Body can be undefined for an error response
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .onFirstCall()
        .resolves(firstFullResponse)
        .onSecondCall()
        .resolves(errorResponseUndefinedBody); // DAP error

      // 1. First fetch (success)
      let stackFrames = await thread.fetchCallStack();
      expect(stackFrames).to.have.lengthOf(
        firstFullResponse.body.stackFrames.length,
      );
      expect(callStackRefreshedSpy.calledOnce).to.be.true;
      callStackRefreshedSpy.resetHistory();

      // 2. Clear call stack
      thread.clearCallStack();
      expect(thread.callStack).to.be.empty;
      expect(callStackRefreshedSpy.calledOnceWith([])).to.be.true;
      callStackRefreshedSpy.resetHistory();

      // 3. Second fetch (DAP error)
      stackFrames = await thread.fetchCallStack();
      expect(stackFrames).to.be.empty;
      expect(thread.callStack).to.be.empty;
      expect(callStackFetchFailedSpy.calledOnce).to.be.true;
      expect(callStackRefreshedSpy.called).to.be.false; // No refresh on failure

      expect(mockSessionHandler.sendRequest.callCount).to.equal(2);
    });

    it('should handle fetch (DAP error) -> clear -> fetch (success)', async () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);
      const callStackFetchFailedSpy = sinon.spy();
      thread.on('callStackFetchFailed', callStackFetchFailedSpy);

      const successFullResponse = mockStackTraceResponse;
      const errorResponseUndefinedBody = {
        request_seq: mockStackTraceResponse.request_seq,
        seq: mockStackTraceResponse.seq,
        type: 'response' as const,
        command: mockStackTraceResponse.command,
        success: false,
        body: undefined, // Body can be undefined for an error response
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .onFirstCall()
        .resolves(errorResponseUndefinedBody) // DAP error
        .onSecondCall()
        .resolves(successFullResponse);

      // 1. First fetch (DAP error)
      let stackFrames = await thread.fetchCallStack();
      expect(stackFrames).to.be.empty;
      expect(thread.callStack).to.be.empty;
      expect(callStackFetchFailedSpy.calledOnce).to.be.true;
      expect(callStackRefreshedSpy.called).to.be.false;
      callStackFetchFailedSpy.resetHistory();

      // 2. Clear call stack (should not emit if already empty and cleared by error handling)
      thread.clearCallStack();
      expect(thread.callStack).to.be.empty;
      expect(callStackRefreshedSpy.called).to.be.false; // No emission if already empty

      // 3. Second fetch (success)
      stackFrames = await thread.fetchCallStack();
      expect(stackFrames).to.have.lengthOf(
        successFullResponse.body.stackFrames.length,
      );
      expect(thread.callStack).to.deep.equal(stackFrames);
      expect(callStackRefreshedSpy.calledOnceWith(stackFrames)).to.be.true;
      expect(callStackFetchFailedSpy.called).to.be.false;

      expect(mockSessionHandler.sendRequest.callCount).to.equal(2);
    });
  });

  describe('clearCallStack()', () => {
    it('should clear the call stack and emit "callStackRefreshed" if it was not empty', async () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);

      mockSessionHandler.sendRequest.resolves(mockStackTraceResponse);
      await thread.fetchCallStack(); // Populate the stack
      expect(thread.callStack).to.not.be.empty;
      callStackRefreshedSpy.resetHistory(); // Reset spy after initial fetch

      thread.clearCallStack();

      expect(thread.callStack).to.be.an('array').that.is.empty;
      expect(callStackRefreshedSpy.calledOnceWith([])).to.be.true;
    });

    it('should not emit "callStackRefreshed" if call stack is already empty', () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);

      expect(thread.callStack).to.be.empty;
      thread.clearCallStack();
      expect(callStackRefreshedSpy.called).to.be.false;
    });

    it('should clear call stack and prevent an in-flight fetch from repopulating it, emitting "callStackRefreshed" for clear', async () => {
      const callStackRefreshedSpy = sinon.spy();
      thread.on('callStackRefreshed', callStackRefreshedSpy);

      let resolveFetch: (value: DebugProtocol.StackTraceResponse) => void; // Resolves with full response
      const fetchPromise = new Promise<DebugProtocol.StackTraceResponse>(
        (resolve) => {
          // Promise of full response
          resolveFetch = resolve;
        },
      );
      mockSessionHandler.sendRequest
        .withArgs('stackTrace', sinon.match.any, undefined, sinon.match.any)
        .returns(fetchPromise);

      // Start the fetch, but don't let it complete yet
      const fetchCallStackPromise = thread.fetchCallStack();

      // Ensure fetch has started and is waiting
      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true;
      // Assuming fetchCallStack sets an internal flag like _isFetchingCallStack.

      callStackRefreshedSpy.resetHistory(); // Reset spy before clear

      // Now, clear the call stack while the fetch is "in-flight"
      // Pre-populate the stack to ensure clearCallStack has something to clear and emits.
      const frameData: DebugProtocol.StackFrame = {
        id: 100,
        name: 'InitialFrame',
        source: { name: 's.ts', path: 's.ts' },
        line: 1,
        column: 1,
      };
      const dummyFrame = new DebugStackFrame(
        frameData,
        thread,
        mockSessionHandler,
        mockLogger,
      );
      thread.callStack = [dummyFrame]; // Manually set for the test scenario

      thread.clearCallStack();

      expect(thread.callStack).to.be.an('array').that.is.empty;
      // clearCallStack should emit 'callStackRefreshed' with an empty array
      expect(callStackRefreshedSpy.calledOnceWith([])).to.be.true;
      callStackRefreshedSpy.resetHistory(); // Reset for any potential future emissions

      // Now, let the original fetch complete
      resolveFetch!(mockStackTraceResponse); // Resolve with the full response object
      await fetchCallStackPromise;

      // The call stack should STILL be empty because clearCallStack took precedence.
      // The fetch, upon completion, should check if its operation was cancelled or state was reset.
      expect(thread.callStack).to.be.an('array').that.is.empty;

      // No further 'callStackRefreshed' event should have been emitted by the stale fetch.
      expect(callStackRefreshedSpy.called).to.be.false;
    });
  });

  describe('updateStoppedState()', () => {
    it('should update stopped state and details, and emit "stoppedStateChanged"', () => {
      const stoppedDetails: DebugProtocol.StoppedEvent['body'] = {
        reason: 'breakpoint',
        threadId: THREAD_ID,
        allThreadsStopped: true,
      };
      const stoppedStateChangedSpy = sinon.spy();
      thread.on('stoppedStateChanged', stoppedStateChangedSpy);

      thread.updateStoppedState(true, stoppedDetails);

      expect(thread.stopped).to.be.true;
      expect(thread.stoppedDetails).to.deep.equal(stoppedDetails);
      expect(stoppedStateChangedSpy.calledOnceWith(true, stoppedDetails)).to.be
        .true;
    });

    it('should update stopped state to false, clear details, and emit "stoppedStateChanged"', () => {
      const stoppedStateChangedSpy = sinon.spy();
      thread.on('stoppedStateChanged', stoppedStateChangedSpy);

      thread.updateStoppedState(true, { reason: 'step', threadId: THREAD_ID }); // Initial state
      stoppedStateChangedSpy.resetHistory(); // Reset for the call we are testing

      thread.updateStoppedState(false);

      expect(thread.stopped).to.be.false;
      expect(thread.stoppedDetails).to.be.undefined;
      expect(stoppedStateChangedSpy.calledOnceWith(false, undefined)).to.be
        .true;
    });

    it('should not emit "stoppedStateChanged" if state does not actually change', () => {
      const stoppedDetails: DebugProtocol.StoppedEvent['body'] = {
        reason: 'breakpoint',
        threadId: THREAD_ID,
      };
      thread.updateStoppedState(true, stoppedDetails); // Set initial state

      const stoppedStateChangedSpy = sinon.spy();
      thread.on('stoppedStateChanged', stoppedStateChangedSpy);

      thread.updateStoppedState(true, stoppedDetails); // Call again with same state

      expect(stoppedStateChangedSpy.called).to.be.false;
    });
  });
});
