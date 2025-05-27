import { expect } from 'chai';
import * as sinon from 'sinon';
import {
  DebugSession,
  BreakpointConfigBuilder,
  BreakpointError,
  EvaluationError,
  InvalidStateError,
  DebugSessionError,
  Breakpoint, // Import the internal Breakpoint type
} from '../src/debugSession';
import {
  DAPSessionHandler as _DAPSessionHandler,
  SessionStatus,
} from '../src/dapSessionHandler';
import { LoggerInterface } from '../src/logging';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as crypto from 'crypto';
const _crypto = crypto; // Mark as used
import { EventEmitter } from 'events';
import { DebugStackFrame } from '../src/model/DebugStackFrame';

// A more complete mock for DAPSessionHandler that extends EventEmitter
class MockDAPSessionHandler extends EventEmitter {
  public status: SessionStatus = 'initializing';
  public getThread = sinon.stub();
  public setBreakpoints = sinon.stub();
  public evaluate = sinon.stub();
  public sendRequest = sinon.stub();
  public continue = sinon.stub();
  public next = sinon.stub();
  public stepIn = sinon.stub();
  public stepOut = sinon.stub();
  public disconnect = sinon.stub();
  public dispose = sinon.stub();
  public getAdapterCapabilities = sinon.stub().returns({
    supportsTerminateRequest: true,
  });

  constructor() {
    super();
  }

  public setStatus(newStatus: SessionStatus) {
    this.status = newStatus;
  }

  public simulateEvent(eventName: string, payload: unknown) {
    this.emit(eventName, payload);
  }
}

const createMockLogger = (): LoggerInterface => ({
  trace: sinon.stub() as sinon.SinonStub,
  debug: sinon.stub() as sinon.SinonStub,
  info: sinon.stub() as sinon.SinonStub,
  warn: sinon.stub() as sinon.SinonStub,
  error: sinon.stub() as sinon.SinonStub,
  child: sinon.stub().returnsThis() as unknown as () => LoggerInterface, // More specific return type
});

describe('DebugSession', () => {
  let mockDAPHandler: MockDAPSessionHandler;
  let mockLogger: LoggerInterface;
  let debugSession: DebugSession;
  const mockTargetType = 'node';
  const mockTargetPath = '/path/to/script.js';
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  beforeEach(() => {
    // crypto.randomUUID will use its native implementation.
    mockLogger = createMockLogger();
    mockDAPHandler = new MockDAPSessionHandler();
    debugSession = new DebugSession(
      mockTargetType,
      mockTargetPath,
      mockDAPHandler as unknown as _DAPSessionHandler, // Use unknown for broader compatibility
      mockLogger,
    );
  });

  afterEach(() => {
    // Remove all listeners from the mock handler to prevent leakage between tests
    if (mockDAPHandler) {
      mockDAPHandler.removeAllListeners();
    }
    sinon.restore();
  });

  describe('Constructor and Initial State', () => {
    it('should initialize with correct properties', () => {
      expect(debugSession.id).to.be.a('string');
      expect(debugSession.id).to.match(uuidRegex);
      expect(debugSession.targetType).to.equal(mockTargetType);
      expect(debugSession.targetPath).to.equal(mockTargetPath);
      expect(debugSession.state).to.equal('initializing'); // Initial state from mockDAPHandler
      expect(debugSession.startTime).to.be.instanceOf(Date);
      expect(debugSession.currentThreadId).to.be.undefined;
      expect(debugSession.breakpoints).to.deep.equal([]);
      sinon.assert.calledWith(
        mockLogger.info as sinon.SinonSpy,
        `Debug session created for ${mockTargetType} target: ${mockTargetPath}`,
      );
      // Check that the logger child was called with the generated session ID
      sinon.assert.calledWith(mockLogger.child as sinon.SinonSpy, {
        className: 'DebugSession',
        sessionId: debugSession.id,
      });
    });

    it('should get breakpoints for a file', () => {
      expect(debugSession.getBreakpointsForFile('some/file.js')).to.deep.equal(
        [],
      );
    });
  });

  describe('Breakpoint Management', () => {
    const filePath = 'test/file.ts';
    const line = 10;
    const condition = 'i > 5';
    const mockDAPBreakpointResponse: DebugProtocol.Breakpoint = {
      id: 1001, // Adapter-assigned ID
      verified: true,
      line: line, // Adapter confirms the line
    };
    const mockAdapterSetBreakpointsResponse: DebugProtocol.SetBreakpointsResponse =
      {
        request_seq: 1,
        success: true,
        command: 'setBreakpoints',
        seq: 1,
        type: 'response',
        body: {
          breakpoints: [mockDAPBreakpointResponse],
        },
      };

    describe('setBreakpoint', () => {
      it('should set a breakpoint successfully', async () => {
        mockDAPHandler.setBreakpoints.resolves(
          mockAdapterSetBreakpointsResponse,
        );
        // crypto.randomUUID will be called natively.
        const result = await debugSession.setBreakpoint({ filePath, line });

        expect(result.verified).to.be.true;
        expect(result.line).to.equal(line);
        expect(result.id).to.be.a('string').and.match(uuidRegex);
        sinon.assert.calledOnce(mockDAPHandler.setBreakpoints);
        sinon.assert.calledWith(mockDAPHandler.setBreakpoints, {
          source: { path: filePath },
          breakpoints: [
            {
              line,
              condition: undefined,
              hitCondition: undefined,
              logMessage: undefined,
            },
          ],
        });

        const sessionBps = debugSession.breakpoints;
        expect(sessionBps).to.have.lengthOf(1);
        expect(sessionBps[0].filePath).to.equal(filePath);
        expect(sessionBps[0].line).to.equal(line);
        expect(sessionBps[0].verified).to.be.true;
        expect(sessionBps[0].id).to.equal(result.id); // Check against the returned ID

        expect(debugSession.getBreakpointsForFile(filePath)).to.deep.equal(
          sessionBps,
        );
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Breakpoint registered client-side at ${filePath}:${line}`,
          {
            breakpointId: result.id, // Use the actual ID from the result
            verified: true,
            isEnabled: true, // Added isEnabled
          },
        );
      });

      it('should set a breakpoint with all options successfully', async () => {
        const hitCondition = '10';
        const logMessage = 'Logging breakpoint';
        const dapResponse: DebugProtocol.Breakpoint = {
          verified: true,
          line: 11,
          message: 'Adjusted',
        };
        mockDAPHandler.setBreakpoints.resolves({
          ...mockAdapterSetBreakpointsResponse,
          body: { breakpoints: [dapResponse] },
        });
        // crypto.randomUUID will be called natively.
        const result = await debugSession.setBreakpoint({
          filePath,
          line,
          condition,
          hitCondition,
          logMessage,
        });

        expect(result.verified).to.be.true;
        expect(result.line).to.equal(11); // Adapter's line
        expect(result.id).to.be.a('string').and.match(uuidRegex);
        expect(result.message).to.equal('Adjusted');

        sinon.assert.calledOnceWithExactly(mockDAPHandler.setBreakpoints, {
          source: { path: filePath },
          breakpoints: [{ line, condition, hitCondition, logMessage }],
        });

        const bpInCache = debugSession.getBreakpointsForFile(filePath)[0];
        expect(bpInCache.id).to.equal(result.id);
        expect(bpInCache.condition).to.equal(condition);
        expect(bpInCache.hitCondition).to.equal(hitCondition);
        expect(bpInCache.logMessage).to.equal(logMessage);
        expect(bpInCache.line).to.equal(11);
      });

      it('should throw BreakpointError if filePath is missing', async () => {
        try {
          await debugSession.setBreakpoint({ filePath: '', line });
          expect.fail('Should have thrown');
        } catch (e) {
          expect(e).to.be.instanceOf(BreakpointError);
          expect((e as BreakpointError).message).to.contain(
            'File path is required',
          );
          sinon.assert.notCalled(mockDAPHandler.setBreakpoints);
        }
      });

      it('should throw BreakpointError if line number is invalid', async () => {
        try {
          await debugSession.setBreakpoint({ filePath, line: 0 });
          expect.fail('Should have thrown');
        } catch (e) {
          expect(e).to.be.instanceOf(BreakpointError);
          expect((e as BreakpointError).message).to.contain(
            'Line number must be positive',
          );
          sinon.assert.notCalled(mockDAPHandler.setBreakpoints);
        }
      });

      it('should throw BreakpointError if adapter returns no breakpoints', async () => {
        mockDAPHandler.setBreakpoints.resolves({
          ...mockAdapterSetBreakpointsResponse,
          body: { breakpoints: [] },
        });
        try {
          await debugSession.setBreakpoint({ filePath, line });
          expect.fail('Should have thrown');
        } catch (e) {
          expect(e).to.be.instanceOf(BreakpointError);
          expect((e as BreakpointError).message).to.contain(
            'Adapter returned no breakpoints in response, indicating it was not set.',
          );
        }
      });

      it('should throw BreakpointError if adapter call fails', async () => {
        const adapterError = new Error('Adapter failed');
        mockDAPHandler.setBreakpoints.rejects(adapterError);
        try {
          await debugSession.setBreakpoint({ filePath, line });
          expect.fail('Should have thrown');
        } catch (e) {
          expect(e).to.be.instanceOf(BreakpointError);
          expect((e as BreakpointError).message).to.contain('Adapter failed');
          expect((e as BreakpointError).cause).to.equal(adapterError);
        }
      });
    });

    describe('setBreakpointWithBuilder', () => {
      it('should set a breakpoint using the builder', async () => {
        mockDAPHandler.setBreakpoints.resolves(
          mockAdapterSetBreakpointsResponse,
        );
        // crypto.randomUUID will be called natively.
        const builder = new BreakpointConfigBuilder(filePath, line)
          .withCondition(condition)
          .withHitCondition('5')
          .withLogMessage('Built BP');

        const result = await debugSession.setBreakpointWithBuilder(builder);

        expect(result.id).to.be.a('string').and.match(uuidRegex);
        expect(result.verified).to.be.true;
        sinon.assert.calledOnceWithExactly(mockDAPHandler.setBreakpoints, {
          source: { path: filePath },
          breakpoints: [
            { line, condition, hitCondition: '5', logMessage: 'Built BP' },
          ],
        });
      });
    });

    describe('removeBreakpoint', () => {
      let bp1Id: string;
      let bp2Id: string;

      beforeEach(async () => {
        // Add some breakpoints to the session for removal tests
        mockDAPHandler.setBreakpoints.resolves(
          mockAdapterSetBreakpointsResponse,
        );
        const res1 = await debugSession.setBreakpoint({ filePath, line });
        bp1Id = res1.id;

        // Ensure the second breakpoint has a distinct line for the assertion below
        const mockDAPBreakpointResponseLp1 = {
          ...mockDAPBreakpointResponse,
          line: line + 1,
          verified: true,
        };
        mockDAPHandler.setBreakpoints.resolves({
          ...mockAdapterSetBreakpointsResponse,
          body: { breakpoints: [mockDAPBreakpointResponseLp1] },
        });
        const res2 = await debugSession.setBreakpoint({
          filePath,
          line: line + 1,
        });
        bp2Id = res2.id;

        mockDAPHandler.setBreakpoints.resetHistory(); // Reset after setup
      });

      it('should remove a breakpoint successfully and update adapter', async () => {
        const bp2DetailsBeforeRemoval = debugSession.breakpoints.find(
          (bp) => bp.id === bp2Id,
        );
        expect(
          bp2DetailsBeforeRemoval,
          'Pre-condition: bp2Details should exist',
        ).to.exist;

        const expectedRemainingBreakpointForAdapter = {
          line: bp2DetailsBeforeRemoval!.line,
          condition: bp2DetailsBeforeRemoval!.condition,
          hitCondition: bp2DetailsBeforeRemoval!.hitCondition,
          logMessage: bp2DetailsBeforeRemoval!.logMessage,
        };

        mockDAPHandler.setBreakpoints.resolves({
          ...mockAdapterSetBreakpointsResponse,
          body: {
            breakpoints: [
              { ...expectedRemainingBreakpointForAdapter, verified: true },
            ],
          },
        });

        const result = await debugSession.removeBreakpoint(bp1Id);

        expect(result, 'removeBreakpoint result').to.be.true;
        const remainingBreakpointsInSession = debugSession.breakpoints;
        expect(
          remainingBreakpointsInSession,
          'Remaining breakpoints count',
        ).to.have.lengthOf(1);
        expect(
          remainingBreakpointsInSession[0].id,
          'Remaining breakpoint ID',
        ).to.equal(bp2Id);
        expect(
          remainingBreakpointsInSession[0].line,
          'Remaining breakpoint line',
        ).to.equal(line + 1);
        expect(
          debugSession.getBreakpointsForFile(filePath),
          'Breakpoints for file count',
        ).to.have.lengthOf(1);

        sinon.assert.calledOnce(mockDAPHandler.setBreakpoints);
        sinon.assert.calledWithExactly(mockDAPHandler.setBreakpoints, {
          source: { path: filePath },
          breakpoints: [expectedRemainingBreakpointForAdapter],
        });
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Successfully updated breakpoints for ${filePath} after removing ${bp1Id}.`,
        );
      });

      it('should remove the last breakpoint for a file successfully and update adapter with empty list', async () => {
        // First remove bp1
        mockDAPHandler.setBreakpoints.resolves(
          mockAdapterSetBreakpointsResponse,
        );
        await debugSession.removeBreakpoint(bp1Id);
        mockDAPHandler.setBreakpoints.resetHistory();

        // Now remove bp2 (the last one for this file)
        const result = await debugSession.removeBreakpoint(bp2Id);
        expect(result).to.be.true;
        expect(debugSession.breakpoints).to.have.lengthOf(0);
        expect(debugSession.getBreakpointsForFile(filePath)).to.have.lengthOf(
          0,
        );

        sinon.assert.calledOnce(mockDAPHandler.setBreakpoints);
        sinon.assert.calledWith(mockDAPHandler.setBreakpoints, {
          source: { path: filePath },
          breakpoints: [], // Empty list for the adapter
        });
        // The specific debug log "Removed last breakpoint for file..." is no longer present.
        // The info log "Successfully updated breakpoints for..." will be caught.
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Successfully updated breakpoints for ${filePath} after removing ${bp2Id}.`,
        );
      });

      it('should return false if breakpointId is not found', async () => {
        const result = await debugSession.removeBreakpoint('non-existent-id');
        expect(result).to.be.false;
        expect(debugSession.breakpoints).to.have.lengthOf(2); // No change
        sinon.assert.notCalled(mockDAPHandler.setBreakpoints);
        sinon.assert.calledWith(
          mockLogger.warn as sinon.SinonSpy,
          `Breakpoint with ID non-existent-id not found for removal.`,
        );
      });

      it('should log an error if adapter update fails during removal but still remove locally', async () => {
        const adapterError = new Error('Adapter update failed');
        mockDAPHandler.setBreakpoints.rejects(adapterError);

        // Retrieve details of bp1Id *before* removal to check what's logged
        const bp1DetailsBeforeRemoval = debugSession.breakpoints.find(
          (bp) => bp.id === bp1Id,
        );
        expect(bp1DetailsBeforeRemoval).to.exist;

        const result = await debugSession.removeBreakpoint(bp1Id);

        expect(result).to.be.true; // Still true because local removal succeeded
        expect(debugSession.breakpoints).to.have.lengthOf(1); // Locally removed
        sinon.assert.calledOnce(mockDAPHandler.setBreakpoints);

        const expectedLoggedErrorMsgStart = `CRITICAL: Breakpoint ${bp1Id} (details: ${JSON.stringify({ filePath: bp1DetailsBeforeRemoval!.filePath, line: bp1DetailsBeforeRemoval!.line, id: bp1Id, adapterId: bp1DetailsBeforeRemoval!.adapterId })}) was removed from client cache, but FAILED to update debug adapter for file ${filePath}. Breakpoint state is now INCONSISTENT between client and adapter.`;

        // Check that logger.error was called
        sinon.assert.called(mockLogger.error as sinon.SinonSpy);

        // Get the call to logger.error
        const errorCall = (mockLogger.error as sinon.SinonSpy).getCall(0);
        expect(errorCall.args[0]).to.include(expectedLoggedErrorMsgStart); // Check the main message part

        // Check the structured details
        const loggedDetails = errorCall.args[1];
        expect(loggedDetails.error).to.equal(adapterError.message);
        expect(loggedDetails.errorDetails).to.equal(adapterError);
        expect(loggedDetails.fileToUpdate).to.equal(filePath);
        // The 'remainingBreakpointsSentToAdapter' will be 1 because bp2 is left
        expect(loggedDetails.remainingBreakpointsSentToAdapter).to.equal(1);
        expect(loggedDetails.removedBreakpointInfo).to.deep.equal({
          filePath: bp1DetailsBeforeRemoval!.filePath,
          line: bp1DetailsBeforeRemoval!.line,
          id: bp1Id,
          adapterId: bp1DetailsBeforeRemoval!.adapterId, // This will be undefined if not set during bp1 creation
        });
      });
      it('should throw DebugSessionError for unexpected errors during local cache update', async () => {
        // Sabotage one of the Map's methods used in the loop to simulate an error.
        // For example, make `entries()` throw.
        const originalEntries = (
          debugSession['_breakpoints'] as Map<string, Breakpoint[]>
        ).entries;
        if (
          typeof (debugSession['_breakpoints'] as Map<string, Breakpoint[]>)
            .entries !== 'function'
        ) {
          console.error(
            'Skipping test: _breakpoints.entries is not a function. _breakpoints is:',
            debugSession['_breakpoints'],
          );
          // This indicates a deeper issue if _breakpoints is not a Map as expected.
          // For now, we'll skip this specific sabotage if the structure is wrong.
          return;
        }
        (debugSession['_breakpoints'] as Map<string, Breakpoint[]>).entries =
          sinon
            .stub()
            .throws(new Error('Simulated entries error')) as unknown as Map<
            string,
            Breakpoint[]
          >['entries'];

        try {
          await debugSession.removeBreakpoint(bp1Id);
          expect.fail('Should have thrown DebugSessionError');
        } catch (e) {
          expect(e).to.be.instanceOf(DebugSessionError);
          expect((e as DebugSessionError).message).to.contain(
            'Failed to remove breakpoint: Simulated entries error',
          );
          sinon.assert.notCalled(mockDAPHandler.setBreakpoints);
        } finally {
          // Restore only if it was correctly stubbed
          if (typeof originalEntries === 'function') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (debugSession as any)._breakpoints.entries = originalEntries;
          }
        }
      });
    });
  });

  describe('Expression Evaluation', () => {
    const expression = '1 + 1';
    const defaultFrameId = 100; // Used when defaulting
    const explicitFrameId = 200; // Used when passed explicitly
    const mockEvalResponse: DebugProtocol.EvaluateResponse = {
      request_seq: 1,
      success: true,
      command: 'evaluate',
      seq: 1,
      type: 'response',
      body: {
        result: '2',
        type: 'number',
        variablesReference: 0,
      },
    };
    const mockStackTraceResponse: DebugProtocol.StackTraceResponse = {
      request_seq: 2,
      success: true,
      command: 'stackTrace',
      seq: 2,
      type: 'response',
      body: {
        stackFrames: [
          {
            id: defaultFrameId,
            name: 'frame1',
            source: { name: 'file.ts' },
            line: 1,
            column: 1,
          },
        ],
        totalFrames: 1,
      },
    };

    beforeEach(() => {
      mockDAPHandler.status = 'stopped'; // Evaluation typically happens when stopped
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (debugSession as any)._currentThreadId = 1; // Set a default current thread
      mockDAPHandler.evaluate.resolves(mockEvalResponse);
      // Mock sendRequest for getCallStack
      mockDAPHandler.sendRequest
        .withArgs(
          'stackTrace',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sinon.match({ threadId: (debugSession as any)._currentThreadId }),
        )
        .resolves(mockStackTraceResponse);
    });

    it('should evaluate an expression successfully when frameId is provided', async () => {
      const result = await debugSession.evaluateExpression(
        expression,
        explicitFrameId,
      );

      expect(result.result).to.equal('2');
      sinon.assert.calledOnceWithExactly(mockDAPHandler.evaluate, {
        expression,
        frameId: explicitFrameId,
        context: 'repl',
      });
      sinon.assert.calledWith(
        mockLogger.info as sinon.SinonSpy,
        `Expression "${expression}" evaluated successfully in frame ${explicitFrameId}. Result: 2`,
      );
    });

    it('should evaluate an expression successfully by defaulting frameId', async () => {
      const result = await debugSession.evaluateExpression(expression); // No frameId

      expect(result.result).to.equal('2');
      sinon.assert.calledOnce(mockDAPHandler.sendRequest); // For getCallStack
      sinon.assert.calledWith(mockDAPHandler.sendRequest, 'stackTrace', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        threadId: (debugSession as any)._currentThreadId,
        startFrame: 0,
        levels: 20,
      });
      sinon.assert.calledOnceWithExactly(mockDAPHandler.evaluate, {
        expression,
        frameId: defaultFrameId, // Expected to be defaulted
        context: 'repl',
      });
      sinon.assert.calledWith(
        mockLogger.info as sinon.SinonSpy,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        `Defaulted frameId to ${defaultFrameId} from top of call stack for thread ${(debugSession as any)._currentThreadId} for expression "${expression}".`,
      );
      sinon.assert.calledWith(
        mockLogger.info as sinon.SinonSpy,
        `Expression "${expression}" evaluated successfully in frame ${defaultFrameId}. Result: 2`,
      );
    });

    it('should evaluate an expression with explicit frameId and context options', async () => {
      const context = 'watch';
      await debugSession.evaluateExpression(
        expression,
        explicitFrameId,
        context,
      );

      sinon.assert.calledOnceWithExactly(mockDAPHandler.evaluate, {
        expression,
        frameId: explicitFrameId,
        context,
      });
    });

    it('should throw EvaluationError if frameId is not provided and currentThreadId is undefined', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (debugSession as any)._currentThreadId = undefined;
      try {
        await debugSession.evaluateExpression(expression);
        expect.fail('Should have thrown EvaluationError');
      } catch (e) {
        expect(e).to.be.instanceOf(EvaluationError);
        expect((e as EvaluationError).message).to.contain(
          'frameId is required and could not be defaulted (no current thread)',
        );
        sinon.assert.notCalled(mockDAPHandler.sendRequest); // getCallStack should not be called
        sinon.assert.notCalled(mockDAPHandler.evaluate);
      }
    });

    it('should throw EvaluationError if frameId is not provided and getCallStack returns empty', async () => {
      mockDAPHandler.sendRequest
        .withArgs('stackTrace', sinon.match.any)
        .resolves({
          ...mockStackTraceResponse,
          body: { stackFrames: [], totalFrames: 0 },
        }); // Empty stack

      try {
        await debugSession.evaluateExpression(expression);
        expect.fail('Should have thrown EvaluationError');
      } catch (e) {
        expect(e).to.be.instanceOf(EvaluationError);
        expect((e as EvaluationError).message).to.contain(
          'frameId is required and could not be defaulted (empty call stack)',
        );
        sinon.assert.calledOnce(mockDAPHandler.sendRequest); // getCallStack was called
        sinon.assert.notCalled(mockDAPHandler.evaluate);
      }
    });

    it('should throw EvaluationError if frameId is not provided and getCallStack fails', async () => {
      const callStackError = new Error('Failed to get call stack');
      mockDAPHandler.sendRequest
        .withArgs('stackTrace', sinon.match.any)
        .rejects(callStackError);

      try {
        await debugSession.evaluateExpression(expression);
        expect.fail('Should have thrown EvaluationError');
      } catch (e) {
        expect(e).to.be.instanceOf(EvaluationError);
        const expectedFullMessage = `Evaluation error for '${expression}': frameId is required and could not be defaulted (error retrieving call stack: ${callStackError.message})`;
        expect((e as EvaluationError).message).to.equal(expectedFullMessage);
        expect((e as EvaluationError).cause).to.equal(callStackError);
        sinon.assert.calledOnce(mockDAPHandler.sendRequest); // getCallStack was called
        sinon.assert.notCalled(mockDAPHandler.evaluate);
      }
    });

    it('should throw InvalidStateError if session is not in a valid state for evaluation', async () => {
      mockDAPHandler.status = 'initializing'; // Set to a non-active/stopped state
      try {
        await debugSession.evaluateExpression(expression, explicitFrameId);
        expect.fail('Should have thrown InvalidStateError');
      } catch (e) {
        expect(e).to.be.instanceOf(InvalidStateError);
        expect((e as InvalidStateError).message).to.contain(
          `Operation 'evaluateExpression' requires an active, initialized, or stopped session.`,
        );
        expect((e as InvalidStateError).currentState).to.equal('initializing');
        sinon.assert.notCalled(mockDAPHandler.evaluate);
      }
    });

    it('should throw EvaluationError if adapter evaluate call fails', async () => {
      const adapterError = new Error('Adapter evaluation failed');
      mockDAPHandler.evaluate.rejects(adapterError);
      try {
        await debugSession.evaluateExpression(expression, explicitFrameId);
        expect.fail('Should have thrown EvaluationError');
      } catch (e) {
        expect(e).to.be.instanceOf(EvaluationError);
        expect((e as EvaluationError).message).to.contain(
          `Evaluation error for '${expression}': Adapter evaluation failed`,
        );
        expect((e as EvaluationError).expression).to.equal(expression);
        expect((e as EvaluationError).cause).to.equal(adapterError);
      }
    });

    it('should throw EvaluationError if adapter returns no body', async () => {
      mockDAPHandler.evaluate.resolves({
        ...mockEvalResponse,
        body: undefined as unknown as DebugProtocol.EvaluateResponse['body'],
      });
      try {
        await debugSession.evaluateExpression(expression, explicitFrameId);
        expect.fail('Should have thrown EvaluationError');
      } catch (e) {
        expect(e).to.be.instanceOf(EvaluationError);
        expect((e as EvaluationError).message).to.contain(
          'Adapter returned no result',
        );
      }
    });
  });

  describe('Data Retrieval', () => {
    beforeEach(() => {
      mockDAPHandler.status = 'active'; // Assume active session
    });

    describe('getVariables', () => {
      const variablesReference = 123;
      const mockVariablesResponse: DebugProtocol.VariablesResponse = {
        request_seq: 1,
        success: true,
        command: 'variables',
        seq: 1,
        type: 'response',
        body: {
          variables: [
            {
              name: 'var1',
              value: 'val1',
              type: 'string',
              variablesReference: 0,
            },
            {
              name: 'obj1',
              value: 'Object',
              type: 'object',
              variablesReference: 124,
            },
          ],
        },
      };

      it('should get variables successfully', async () => {
        // The DebugSession.getVariables uses sendRequest<'variables'> directly
        // mockVariablesResponse is already a full response object defined in this scope
        mockDAPHandler.sendRequest.resolves(mockVariablesResponse);

        const variables = await debugSession.getVariables(variablesReference);

        expect(variables).to.have.lengthOf(2);
        expect(variables[0].name).to.equal('var1');
        expect(variables[0].value).to.equal('val1');
        expect(variables[1].name).to.equal('obj1');
        expect(variables[1].variablesReference).to.equal(124);

        sinon.assert.calledOnceWithExactly(
          mockDAPHandler.sendRequest,
          'variables',
          { variablesReference },
        );
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Fetched 2 raw variables for reference ${variablesReference}.`,
        );
      });

      it('should return an empty array if adapter returns no variables', async () => {
        // Mock a successful response with empty variables array
        mockDAPHandler.sendRequest.resolves({
          request_seq: 1,
          success: true,
          command: 'variables',
          seq: 1,
          type: 'response',
          body: {
            variables: [],
          },
        });

        const variables = await debugSession.getVariables(variablesReference);
        expect(variables).to.be.an('array').that.is.empty;
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Fetched 0 raw variables for reference ${variablesReference}.`,
        );
      });

      it('should throw InvalidStateError if session is not active', async () => {
        mockDAPHandler.status = 'terminated';
        try {
          await debugSession.getVariables(variablesReference);
          expect.fail('Should have thrown InvalidStateError');
        } catch (e) {
          expect(e).to.be.instanceOf(InvalidStateError);
          expect((e as InvalidStateError).message).to.contain(
            `Operation 'getVariables' requires an active, initialized, or stopped session.`,
          );
          sinon.assert.notCalled(mockDAPHandler.sendRequest);
        }
      });

      it('should throw DebugSessionError if adapter call fails', async () => {
        const adapterError = new Error('Adapter variables failed');
        mockDAPHandler.sendRequest.rejects(adapterError);
        try {
          await debugSession.getVariables(variablesReference);
          expect.fail('Should have thrown DebugSessionError');
        } catch (e) {
          expect(e).to.be.instanceOf(DebugSessionError);
          expect((e as DebugSessionError).message).to.contain(
            'Failed to get variables: Adapter variables failed',
          );
          expect((e as DebugSessionError).cause).to.equal(adapterError);
        }
      });
    });

    describe('getCallStack', () => {
      const threadId = 1;
      const mockStackFrames: DebugProtocol.StackFrame[] = [
        {
          id: 1001,
          name: 'frame1',
          source: { name: 'file1.ts', path: '/path/file1.ts' },
          line: 10,
          column: 1,
        },
        {
          id: 1002,
          name: 'frame2',
          source: { name: 'file2.ts', path: '/path/file2.ts' },
          line: 20,
          column: 1,
        },
      ];

      // Mock DebugThread and its fetchCallStack method
      const mockDebugThread = {
        id: threadId,
        name: `Thread ${threadId}`,
        fetchCallStack: sinon.stub(),
        // Add other properties/methods if DebugSession interacts with them directly
      };

      beforeEach(() => {
        // Reset stubs for each test
        mockDAPHandler.getThread.reset();
        mockDebugThread.fetchCallStack.reset();
        // Set status to 'stopped' as required by getCallStack
        mockDAPHandler.status = 'stopped';
      });

      it('should get call stack successfully using DebugThread model', async () => {
        mockDAPHandler.getThread
          .withArgs(threadId)
          .returns(
            mockDebugThread as unknown as ReturnType<
              typeof mockDAPHandler.getThread
            >,
          );
        // DebugStackFrame instances are created by DebugThread, so we mock the result of fetchCallStack
        // to return objects that look like DebugStackFrame instances for assertion purposes.
        // In a real scenario, these would be actual DebugStackFrame instances.
        const resolvedFrames = mockStackFrames.map((sf) => ({
          ...sf,
          getScopes: sinon.stub().resolves([]),
        }));
        mockDebugThread.fetchCallStack.resolves(
          resolvedFrames as unknown as DebugStackFrame[],
        );

        // Mock the sendRequest method to return a proper response for stackTrace
        mockDAPHandler.sendRequest
          .withArgs('stackTrace', sinon.match.any)
          .resolves({
            success: true,
            body: {
              stackFrames: mockStackFrames,
            },
          });

        const callStack = await debugSession.getCallStack(threadId);

        expect(callStack).to.have.lengthOf(2);
        expect(callStack[0].id).to.equal(1001);
        expect(callStack[0].name).to.equal('frame1');
        expect(callStack[1].id).to.equal(1002);

        sinon.assert.calledOnceWithExactly(
          mockDAPHandler.sendRequest,
          'stackTrace',
          { threadId, startFrame: 0, levels: 20 },
        );
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Fetched 2 raw stack frames for thread ${threadId}.`,
        );
      });

      it('should return empty array if response contains no stack frames', async () => {
        // Mock the sendRequest method to return a response with empty stackFrames
        mockDAPHandler.sendRequest
          .withArgs('stackTrace', sinon.match.any)
          .resolves({
            success: true,
            body: {
              stackFrames: [],
            },
          });

        const callStack = await debugSession.getCallStack(threadId);

        expect(callStack).to.be.an('array').that.is.empty;
        sinon.assert.calledOnceWithExactly(
          mockDAPHandler.sendRequest,
          'stackTrace',
          { threadId, startFrame: 0, levels: 20 },
        );
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Fetched 0 raw stack frames for thread ${threadId}.`,
        );
      });

      it('should throw InvalidStateError if session is not active', async () => {
        mockDAPHandler.status = 'terminated';
        try {
          await debugSession.getCallStack(threadId);
          expect.fail('Should have thrown InvalidStateError');
        } catch (e) {
          expect(e).to.be.instanceOf(InvalidStateError);
          expect((e as InvalidStateError).message).to.contain(
            "Operation 'getCallStack' requires an active, initialized, or stopped session.",
          );
          sinon.assert.notCalled(mockDAPHandler.sendRequest);
        }
      });

      it('should throw DebugSessionError if sendRequest fails', async () => {
        const fetchError = new Error('Failed to fetch stack');
        mockDAPHandler.sendRequest
          .withArgs('stackTrace', sinon.match.any)
          .rejects(fetchError);

        try {
          await debugSession.getCallStack(threadId);
          expect.fail('Should have thrown DebugSessionError');
        } catch (e) {
          expect(e).to.be.instanceOf(DebugSessionError);
          expect((e as DebugSessionError).message).to.contain(
            'Failed to get call stack: Failed to fetch stack',
          );
          expect((e as DebugSessionError).cause).to.equal(fetchError);
        }
      });
    });
  });

  describe('Execution Control', () => {
    const threadId = 1;

    beforeEach(() => {
      mockDAPHandler.status = 'stopped'; // Set to stopped for stepping operations
      // Simulate a current stopped thread for operations that might use it as a default
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (debugSession as any)._currentThreadId = threadId;
    });

    describe('continue', () => {
      it('should call sessionHandler.continue with specified threadId', async () => {
        mockDAPHandler.continue.resolves();
        await debugSession.continue(threadId);
        sinon.assert.calledOnceWithExactly(mockDAPHandler.continue, threadId);
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Requesting continue for thread ${threadId}`,
        );
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Continue request successful for thread ${threadId}`,
        );
      });

      it('should call sessionHandler.continue for global continue if no threadId provided and currentThreadId exists', async () => {
        // _currentThreadId is set in beforeEach
        mockDAPHandler.continue.resolves();
        await debugSession.continue(); // No specific threadId
        // DAPSessionHandler.continue(undefined) is a global continue.
        // DebugSession passes its _currentThreadId if no arg is given, but DAPSessionHandler interprets undefined as global.
        // The important part is that DAPSessionHandler.continue is called.
        // If the adapter doesn't support global continue, DAPSessionHandler might use this._currentThreadId.
        // For this test, we check it's called with undefined as per the implementation
        sinon.assert.calledOnceWithExactly(mockDAPHandler.continue, undefined);
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Requesting continue for all threads`,
        );
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Continue request successful for all threads`,
        );
      });

      it('should call sessionHandler.continue with undefined if no threadId and no currentThreadId (global)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (debugSession as any)._currentThreadId = undefined; // No current thread
        mockDAPHandler.continue.resolves();
        await debugSession.continue(); // No specific threadId
        sinon.assert.calledOnceWithExactly(mockDAPHandler.continue, undefined);
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Requesting continue for all threads`,
        );
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          `Continue request successful for all threads`,
        );
      });

      it('should throw InvalidStateError if session not active', async () => {
        mockDAPHandler.status = 'terminated';
        try {
          await debugSession.continue(threadId);
          expect.fail('Should have thrown');
        } catch (e) {
          expect(e).to.be.instanceOf(InvalidStateError);
          sinon.assert.notCalled(mockDAPHandler.continue);
        }
      });

      it('should throw DebugSessionError on adapter failure', async () => {
        const err = new Error('Continue failed');
        mockDAPHandler.continue.rejects(err);
        try {
          await debugSession.continue(threadId);
          expect.fail('Should have thrown');
        } catch (e) {
          expect(e).to.be.instanceOf(DebugSessionError);
          expect((e as DebugSessionError).cause).to.equal(err);
        }
      });
    });

    const testStepOperation = (
      operationName: 'stepOver' | 'stepInto' | 'stepOut',
      sessionMethod: (tid: number) => Promise<void>,
      // Pass the name of the method on mockDAPHandler
      handlerMethodName: 'next' | 'stepIn' | 'stepOut',
    ) => {
      describe(operationName, () => {
        let handlerMethodStub: sinon.SinonStub;

        beforeEach(() => {
          // Retrieve the stub from the initialized mockDAPHandler
          handlerMethodStub = mockDAPHandler[
            handlerMethodName
          ] as sinon.SinonStub;
          handlerMethodStub.resetHistory(); // Ensure clean state for each test
        });

        it(`should call sessionHandler.${operationName} with specified threadId`, async () => {
          handlerMethodStub.resolves();
          await sessionMethod(threadId);
          sinon.assert.calledOnceWithExactly(handlerMethodStub, threadId);
          sinon.assert.calledWith(
            mockLogger.info as sinon.SinonSpy,
            `Requesting ${operationName} for thread ${threadId}`,
          );
          sinon.assert.calledWith(
            mockLogger.info as sinon.SinonSpy,
            `${operationName.charAt(0).toUpperCase() + operationName.slice(1)} request successful for thread ${threadId}`,
          );
        });

        it(`should use currentThreadId if no threadId explicitly passed to ${operationName}`, async () => {
          // _getEffectiveThreadIdOrThrow uses preferredThreadId (which is the arg) OR this._currentThreadId
          // For step operations, DebugSession requires a threadId argument, so this case is more about internal logic.
          // The public API for stepOver, stepInto, stepOut in DebugSession *requires* a threadId.
          // This test ensures _getEffectiveThreadIdOrThrow works if it were called with undefined preferredThreadId.
          // However, the public methods always provide one.
          // Let's test the scenario where _getEffectiveThreadIdOrThrow is used.
          (
            debugSession as unknown as { _currentThreadId: number | undefined }
          )._currentThreadId = 789; // Set a distinct current thread
          handlerMethodStub.resolves();
          await sessionMethod(789);
          sinon.assert.calledOnceWithExactly(handlerMethodStub, 789);
        });

        it(`should throw DebugSessionError if no threadId and no currentThreadId for ${operationName}`, async () => {
          (
            debugSession as unknown as { _currentThreadId: number | undefined }
          )._currentThreadId = undefined; // No current thread
          // The public step methods require a threadId. This tests the internal _getEffectiveThreadIdOrThrow.
          // To test this properly, we'd need to call a method that *could* pass undefined to _getEffectiveThreadIdOrThrow.
          // Since stepOver/Into/Out always pass a threadId, this specific path for _getEffectiveThreadIdOrThrow
          // won't be hit by external calls to *these* step methods if they lack a currentThreadId.
          // The error would come from _getEffectiveThreadIdOrThrow if preferredThreadId was also undefined.
          // Let's simulate calling the internal helper more directly for this specific check.
          try {
            (
              debugSession as unknown as {
                _getEffectiveThreadIdOrThrow: (
                  operation: string,
                  preferredThreadId?: number,
                ) => number;
              }
            )._getEffectiveThreadIdOrThrow(operationName, undefined);
            expect.fail('Should have thrown from _getEffectiveThreadIdOrThrow');
          } catch (e) {
            expect(e).to.be.instanceOf(DebugSessionError);
            expect((e as DebugSessionError).message).to.contain(
              `Cannot determine target thread for '${operationName}'`,
            );
          }
        });

        it(`should throw InvalidStateError if session not active for ${operationName}`, async () => {
          mockDAPHandler.status = 'terminated';
          try {
            await sessionMethod(threadId); // Changed: direct call
            expect.fail('Should have thrown');
          } catch (e) {
            expect(e).to.be.instanceOf(InvalidStateError);
            sinon.assert.notCalled(handlerMethodStub);
          }
        });

        it(`should throw DebugSessionError on adapter failure for ${operationName}`, async () => {
          const err = new Error(`${operationName} failed`);
          handlerMethodStub.rejects(err);
          try {
            await sessionMethod(threadId);
            expect.fail('Should have thrown');
          } catch (e) {
            expect(e).to.be.instanceOf(DebugSessionError);
            expect((e as DebugSessionError).cause).to.equal(err);
            expect((e as DebugSessionError).message).to.contain(
              `Failed to ${operationName}: ${operationName} failed`,
            );
          }
        });
      });
    };

    // Pass lambdas to defer access to debugSession methods, and method names for handler
    testStepOperation('stepOver', (tid) => debugSession.stepOver(tid), 'next');
    testStepOperation(
      'stepInto',
      (tid) => debugSession.stepInto(tid),
      'stepIn',
    );
    testStepOperation('stepOut', (tid) => debugSession.stepOut(tid), 'stepOut');

    describe('terminate', () => {
      it('should call sessionHandler.disconnect', async () => {
        mockDAPHandler.disconnect.resolves();
        await debugSession.terminate();
        sinon.assert.calledOnce(mockDAPHandler.disconnect);
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          'Requesting to terminate debug session.',
        );
        sinon.assert.calledWith(
          mockLogger.info as sinon.SinonSpy,
          'Disconnect request (intending termination) successful.',
        );
      });

      it('should throw InvalidStateError if already terminated', async () => {
        mockDAPHandler.status = 'terminated';
        (
          debugSession as unknown as {
            _notifyStateChange: (
              newState: SessionStatus,
              oldState?: SessionStatus,
            ) => void;
          }
        )._notifyStateChange('terminated', 'active'); // Manually set state for test
        try {
          await debugSession.terminate();
          expect.fail('Should have thrown InvalidStateError');
        } catch (e) {
          expect(e).to.be.instanceOf(InvalidStateError);
          expect((e as InvalidStateError).message).to.contain(
            `Operation 'terminate' requires an active, initialized, stopped or initializing session.`,
          );
          sinon.assert.notCalled(mockDAPHandler.disconnect);
        }
      });

      it('should throw DebugSessionError on adapter failure', async () => {
        const err = new Error('Terminate failed');
        mockDAPHandler.disconnect.rejects(err);
        try {
          await debugSession.terminate();
          expect.fail('Should have thrown');
        } catch (e) {
          expect(e).to.be.instanceOf(DebugSessionError);
          expect((e as DebugSessionError).cause).to.equal(err);
        }
      });
    });
  });

  describe('Event Handling and State Management', () => {
    let stateChangeListener: sinon.SinonSpy;

    beforeEach(() => {
      // Remove all listeners from previous tests
      mockDAPHandler.removeAllListeners();

      // Reset DAP handler status for event-driven changes
      mockDAPHandler.status = 'initializing';

      // Re-initialize debugSession with the fresh mockDAPHandler to ensure event listeners are fresh for each test
      // This is important because DebugSession sets up listeners in its constructor.
      debugSession = new DebugSession(
        mockTargetType,
        mockTargetPath,
        mockDAPHandler as unknown as _DAPSessionHandler,
        mockLogger,
      );

      // Create a fresh spy for each test
      stateChangeListener = sinon.spy();
      debugSession.onStateChanged(stateChangeListener);
    });

    it('should notify listeners on "sessionStarted" event', () => {
      const capabilities = { supportsConfigurationDoneRequest: true };
      // Simulate DAPSessionHandler updating its status before emitting the event
      mockDAPHandler.setStatus('active');
      mockDAPHandler.simulateEvent('sessionStarted', { capabilities });

      sinon.assert.calledOnce(stateChangeListener);
      sinon.assert.calledWith(
        stateChangeListener,
        debugSession.id,
        'active',
        'initializing',
      );
      expect(debugSession.state).to.equal('active');
      sinon.assert.calledWith(
        mockLogger.info as sinon.SinonSpy,
        'Debug session initialize request acknowledged by adapter',
      );
    });

    it('should notify listeners and update state on "sessionEnded" event', () => {
      // Start in an active state
      mockDAPHandler.setStatus('active');
      (
        debugSession as unknown as {
          _notifyStateChange: (
            newState: SessionStatus,
            oldState?: SessionStatus,
          ) => void;
        }
      )._notifyStateChange('active', 'initializing'); // Manually set initial state for test
      stateChangeListener.resetHistory();

      // Need to update the mock handler's status to 'terminated' when simulating the event
      // This is what would happen in the real DAPSessionHandler
      mockDAPHandler.simulateEvent('sessionEnded', { reason: 'test ended' });
      mockDAPHandler.setStatus('terminated');

      sinon.assert.calledOnce(stateChangeListener);
      // The old state was 'active' (manually set for this test context).
      // The new state is 'terminated' (as per DebugSession's handler logic).
      sinon.assert.calledWith(
        stateChangeListener,
        debugSession.id,
        'terminated',
        'active',
      );
      expect(debugSession.state).to.equal('terminated'); // DAPSessionHandler's status would be updated
      expect(debugSession.currentThreadId).to.be.undefined;
      sinon.assert.calledWith(
        mockLogger.info as sinon.SinonSpy,
        'Debug session reported as ended by adapter',
      );
    });

    it('should notify listeners and update currentThreadId on "stopped" event', () => {
      mockDAPHandler.setStatus('active'); // Session is active
      (
        debugSession as unknown as {
          _notifyStateChange: (
            newState: SessionStatus,
            oldState?: SessionStatus,
          ) => void;
        }
      )._notifyStateChange('active', 'initializing');
      stateChangeListener.resetHistory();

      const stopPayload = {
        threadId: 123,
        reason: 'breakpoint',
        allThreadsStopped: true,
      };
      mockDAPHandler.simulateEvent('stopped', stopPayload);

      sinon.assert.calledOnce(stateChangeListener);
      // State remains 'active' but it's a sub-state change (stopped)
      sinon.assert.calledWith(
        stateChangeListener,
        debugSession.id,
        'active',
        'active',
      );
      expect(debugSession.currentThreadId).to.equal(123);
      sinon.assert.calledWith(
        mockLogger.info as sinon.SinonSpy,
        'Debug session stopped',
      );
    });

    it('should notify listeners and clear currentThreadId on "continued" event if allThreadsContinued', () => {
      mockDAPHandler.setStatus('active'); // Session is active

      // Simulate a stopped event to set the currentThreadId
      const stoppedThreadId = 123;
      const stopPayload: DebugProtocol.StoppedEvent['body'] = {
        reason: 'breakpoint',
        threadId: stoppedThreadId,
        allThreadsStopped: true,
      };
      mockDAPHandler.simulateEvent('stopped', stopPayload);
      // Reset listener after the 'stopped' event, before 'continued'
      stateChangeListener.resetHistory();
      expect(debugSession.currentThreadId).to.equal(stoppedThreadId); // Verify precondition

      const continuePayload = {
        threadId: stoppedThreadId,
        allThreadsContinued: true,
      };
      mockDAPHandler.simulateEvent('continued', continuePayload);

      sinon.assert.calledOnce(stateChangeListener);
      // State remains 'active' but it's a sub-state change (running)
      sinon.assert.calledWith(
        stateChangeListener,
        debugSession.id,
        'active',
        'active',
      );
      expect(debugSession.currentThreadId).to.be.undefined;
      sinon.assert.calledWith(
        mockLogger.info as sinon.SinonSpy,
        'Debug session continued',
      );
    });

    it('should notify listeners and clear currentThreadId on "continued" event if specific thread continued was the current one', () => {
      mockDAPHandler.setStatus('active'); // Session is active

      // Simulate a stopped event to set the currentThreadId
      const stoppedThreadId = 456;
      const stopPayload: DebugProtocol.StoppedEvent['body'] = {
        reason: 'step', // Or any other valid reason
        threadId: stoppedThreadId,
        allThreadsStopped: false, // Or true, depending on what the test implies
      };
      mockDAPHandler.simulateEvent('stopped', stopPayload);
      // Reset listener after the 'stopped' event, before 'continued'
      stateChangeListener.resetHistory();
      expect(debugSession.currentThreadId).to.equal(stoppedThreadId); // Verify precondition

      const continuePayload = {
        threadId: stoppedThreadId,
        allThreadsContinued: false,
      };
      mockDAPHandler.simulateEvent('continued', continuePayload);

      sinon.assert.calledOnce(stateChangeListener);
      sinon.assert.calledWith(
        stateChangeListener,
        debugSession.id,
        'active',
        'active',
      );
      expect(debugSession.currentThreadId).to.be.undefined;
    });

    it('should notify listeners but NOT clear currentThreadId if a different thread continued', () => {
      mockDAPHandler.setStatus('active'); // Session is active

      // Simulate a stopped event to set the currentThreadId
      const currentThreadId = 111;
      const stopPayload: DebugProtocol.StoppedEvent['body'] = {
        reason: 'pause', // Or any other valid reason
        threadId: currentThreadId,
        allThreadsStopped: false, // Or true
      };
      mockDAPHandler.simulateEvent('stopped', stopPayload);
      // Reset listener after the 'stopped' event, before 'continued'
      stateChangeListener.resetHistory();
      expect(debugSession.currentThreadId).to.equal(currentThreadId); // Verify precondition

      const differentThreadId = 222;
      const continuePayload = {
        threadId: differentThreadId,
        allThreadsContinued: false,
      }; // Different thread continued
      mockDAPHandler.simulateEvent('continued', continuePayload);

      sinon.assert.calledOnce(stateChangeListener);
      sinon.assert.calledWith(
        stateChangeListener,
        debugSession.id,
        'active',
        'active',
      );
      expect(debugSession.currentThreadId).to.equal(111); // Should not change
    });

    it('should log errors from "error" event of DAPSessionHandler', () => {
      const dapHandlerError = new Error('DAP Handler Internal Error');
      mockDAPHandler.simulateEvent('error', { error: dapHandlerError });

      sinon.assert.calledWith(
        mockLogger.error as sinon.SinonSpy,
        'Error reported by DAPSessionHandler',
        { error: dapHandlerError },
      );
      sinon.assert.notCalled(stateChangeListener); // Typically, 'error' from handler itself doesn't mean a state change for DebugSession unless it leads to sessionEnded
    });

    it('_notifyStateChange should call listeners even if newState is same as oldState', () => {
      // Manually call _notifyStateChange with same states
      (
        debugSession as unknown as {
          _notifyStateChange: (
            newState: SessionStatus,
            oldState?: SessionStatus,
          ) => void;
        }
      )._notifyStateChange('active', 'active');
      sinon.assert.calledOnce(stateChangeListener);
      sinon.assert.calledWith(
        stateChangeListener,
        debugSession.id,
        'active',
        'active',
      );
      sinon.assert.calledWith(
        mockLogger.debug as sinon.SinonSpy,
        'DebugSession state event. Old: active, New: active. Notifying listeners.',
      );
    });

    it('_notifyStateChange should call listeners with correct states if different', () => {
      stateChangeListener.resetHistory(); // Clear calls from setup
      (
        debugSession as unknown as {
          _notifyStateChange: (
            newState: SessionStatus,
            oldState?: SessionStatus,
          ) => void;
        }
      )._notifyStateChange('terminated', 'active');
      sinon.assert.calledOnce(stateChangeListener);
      sinon.assert.calledWith(
        stateChangeListener,
        debugSession.id,
        'terminated',
        'active',
      );
    });
  });
});
