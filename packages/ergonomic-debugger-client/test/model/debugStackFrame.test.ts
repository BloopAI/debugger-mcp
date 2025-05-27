import { expect } from 'chai';
import * as sinon from 'sinon';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DebugStackFrame } from '../../src/model/DebugStackFrame';
import { DebugScope } from '../../src/model/DebugScope';
import { DebugThread } from '../../src/model/DebugThread';
import { DebugSource } from '../../src/model/DebugSource';
import {
  MockDAPSessionHandler,
  createMockLogger,
} from './mocks/mockDAPSessionHandler';
import { LoggerInterface } from '../../src/logging';
import { DAPSessionHandlerInterface } from '../../src/model/model.types';

describe('DebugStackFrame', () => {
  let mockSessionHandler: MockDAPSessionHandler;
  let mockLogger: LoggerInterface;
  let mockParentThread: DebugThread;
  let stackFrame: DebugStackFrame;

  const FRAME_ID = 100;
  const FRAME_NAME = 'myFunction';
  const RAW_SOURCE: DebugProtocol.Source = {
    name: 'test.ts',
    path: '/sources/test.ts',
    sourceReference: 0,
  };
  const FRAME_LINE = 10;
  const FRAME_COLUMN = 5;

  const RAW_FRAME_DATA: DebugProtocol.StackFrame = {
    id: FRAME_ID,
    name: FRAME_NAME,
    source: RAW_SOURCE,
    line: FRAME_LINE,
    column: FRAME_COLUMN,
  };

  const mockScopesResponse: DebugProtocol.ScopesResponse = {
    // Changed to full response
    request_seq: 1,
    seq: 1,
    success: true,
    command: 'scopes',
    type: 'response',
    body: {
      scopes: [
        {
          name: 'Local',
          variablesReference: 1001,
          expensive: false,
          namedVariables: 5,
        },
        {
          name: 'Global',
          variablesReference: 1002,
          expensive: true,
          namedVariables: 100,
        },
      ],
    },
  };

  beforeEach(() => {
    mockSessionHandler = new MockDAPSessionHandler();
    mockLogger = createMockLogger();
    mockParentThread = new DebugThread(
      1,
      'MockThread',
      mockSessionHandler as DAPSessionHandlerInterface,
      mockLogger,
    );
    stackFrame = new DebugStackFrame(
      RAW_FRAME_DATA,
      mockParentThread,
      mockSessionHandler as DAPSessionHandlerInterface,
      mockLogger,
    );
  });

  afterEach(() => {
    sinon.restore();
    mockSessionHandler.reset();
  });

  describe('Constructor', () => {
    it('should initialize properties correctly from raw DAP StackFrame data', () => {
      expect(stackFrame.id).to.equal(FRAME_ID);
      expect(stackFrame.name).to.equal(FRAME_NAME);
      expect(stackFrame.line).to.equal(FRAME_LINE);
      expect(stackFrame.column).to.equal(FRAME_COLUMN);
      expect(stackFrame.source).to.be.instanceOf(DebugSource);
      expect(stackFrame.source!.name).to.equal(RAW_SOURCE.name);
      expect(stackFrame.source!.path).to.equal(RAW_SOURCE.path);
      expect(stackFrame.scopes).to.be.an('array').that.is.empty;
      expect(stackFrame.thread).to.equal(mockParentThread);
    });

    it('should handle missing optional source properties', () => {
      const frameDataNoSourcePath: DebugProtocol.StackFrame = {
        ...RAW_FRAME_DATA,
        source: { name: 'noPath.ts' },
      };
      const frame = new DebugStackFrame(
        frameDataNoSourcePath,
        mockParentThread,
        mockSessionHandler,
        mockLogger,
      );
      expect(frame.source).to.be.instanceOf(DebugSource);
      expect(frame.source!.path).to.be.undefined;
    });

    it('should have undefined source if raw frame data source is undefined', () => {
      const frameDataNoSource: DebugProtocol.StackFrame = {
        ...RAW_FRAME_DATA,
        source: undefined,
      };
      const frame = new DebugStackFrame(
        frameDataNoSource,
        mockParentThread,
        mockSessionHandler,
        mockLogger,
      );
      expect(frame.source).to.be.undefined;
    });
  });

  describe('getScopes()', () => {
    it('should fetch scopes successfully, populate DebugScope instances, and emit "scopesRefreshed"', async () => {
      const scopesRefreshedSpy = sinon.spy();
      stackFrame.on('scopesRefreshed', scopesRefreshedSpy);

      mockSessionHandler.sendRequest
        .withArgs('scopes', { frameId: FRAME_ID })
        .resolves(mockScopesResponse); // Full response

      const scopes = await stackFrame.getScopes();

      expect(
        mockSessionHandler.sendRequest.calledOnceWith('scopes', {
          frameId: FRAME_ID,
        }),
      ).to.be.true;
      expect(scopes).to.be.an('array').with.lengthOf(2);
      expect(scopes[0]).to.be.instanceOf(DebugScope);
      expect(scopes[0].name).to.equal('Local');
      expect(scopes[0].variablesReference).to.equal(1001);
      expect(scopes[1]).to.be.instanceOf(DebugScope);
      expect(scopes[1].name).to.equal('Global');
      expect(stackFrame.scopes).to.deep.equal(scopes); // Internal state still updated

      expect(scopesRefreshedSpy.calledOnce).to.be.true;
      const [emittedScopes] = scopesRefreshedSpy.firstCall.args;
      expect(emittedScopes).to.deep.equal(scopes);
    });

    it('should handle fetch failure (DAP error from undefined response), clear scopes, emit "scopesFetchFailed", and resolve with empty array', async () => {
      mockSessionHandler.sendRequest
        .withArgs('scopes', { frameId: FRAME_ID })
        .onFirstCall()
        .resolves(mockScopesResponse);
      await stackFrame.getScopes();
      expect(stackFrame.scopes).to.not.be.empty;

      mockSessionHandler.sendRequest.reset();

      const scopesFetchFailedSpy = sinon.spy();
      stackFrame.on('scopesFetchFailed', scopesFetchFailedSpy);

      const errorResponseUndefined: DebugProtocol.ScopesResponse = {
        ...mockScopesResponse,
        success: false,
        body: undefined as unknown as DebugProtocol.ScopesResponse['body'],
        message: 'DAP Error',
      };
      mockSessionHandler.sendRequest
        .withArgs('scopes', { frameId: FRAME_ID })
        .resolves(errorResponseUndefined);

      const result = await stackFrame.getScopes();

      expect(result).to.be.an('array').that.is.empty;
      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true;
      expect(stackFrame.scopes).to.be.an('array').that.is.empty; // Internal state cleared

      expect(scopesFetchFailedSpy.calledOnce).to.be.true;
      const [error] = scopesFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.equal(
        `Failed to retrieve scopes for frame ID ${FRAME_ID}. Adapter returned no scopes.`,
      );
    });

    it('should handle fetch failure (network/protocol error from sendRequest reject), clear scopes, emit "scopesFetchFailed", and resolve with empty array', async () => {
      mockSessionHandler.sendRequest
        .withArgs('scopes', { frameId: FRAME_ID })
        .resolves(mockScopesResponse);
      await stackFrame.getScopes();
      expect(stackFrame.scopes).to.not.be.empty;

      mockSessionHandler.sendRequest.reset();

      const scopesFetchFailedSpy = sinon.spy();
      stackFrame.on('scopesFetchFailed', scopesFetchFailedSpy);

      const networkError = new Error('Network issue');
      mockSessionHandler.sendRequest
        .withArgs('scopes', { frameId: FRAME_ID })
        .rejects(networkError);

      const result = await stackFrame.getScopes();

      expect(result).to.be.an('array').that.is.empty;
      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true;
      expect(stackFrame.scopes).to.be.an('array').that.is.empty; // Internal state cleared

      expect(scopesFetchFailedSpy.calledOnce).to.be.true;
      const [error] = scopesFetchFailedSpy.firstCall.args;
      expect(error).to.equal(networkError);
    });

    it('should deduplicate concurrent getScopes calls and emit "scopesRefreshed" once', async () => {
      const delay = 50;
      const promise = new Promise<DebugProtocol.ScopesResponse>((resolve) => {
        // Promise of full response
        setTimeout(() => resolve(mockScopesResponse), delay);
      });
      mockSessionHandler.sendRequest
        .withArgs('scopes', { frameId: FRAME_ID })
        .returns(promise);

      const scopesRefreshedSpy = sinon.spy();
      stackFrame.on('scopesRefreshed', scopesRefreshedSpy);

      const p1 = stackFrame.getScopes();
      const p2 = stackFrame.getScopes();

      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true; // sendRequest still called once

      const results = await Promise.all([p1, p2]);

      expect(results[0]).to.be.an('array').with.lengthOf(2);
      expect(results[1]).to.be.an('array').with.lengthOf(2);
      expect(results[0]?.[0].name).to.equal('Local');

      expect(scopesRefreshedSpy.calledOnce).to.be.true; // Event emitted once
      const [emittedScopes] = scopesRefreshedSpy.firstCall.args;
      expect(emittedScopes).to.deep.equal(results[0]); // Check payload
    });

    it('should allow a new fetch after a previous one completed, emitting "scopesRefreshed" each time', async () => {
      mockSessionHandler.sendRequest
        .onFirstCall()
        .resolves(mockScopesResponse)
        .onSecondCall()
        .resolves({
          ...mockScopesResponse,
          body: { scopes: [mockScopesResponse.body.scopes[0]] },
        });

      const scopesRefreshedSpy = sinon.spy();
      stackFrame.on('scopesRefreshed', scopesRefreshedSpy);

      await stackFrame.getScopes(); // First call
      expect(mockSessionHandler.sendRequest.callCount).to.equal(1);
      expect(stackFrame.scopes).to.have.lengthOf(2);
      expect(scopesRefreshedSpy.callCount).to.equal(1);
      expect(scopesRefreshedSpy.firstCall.args[0]).to.have.lengthOf(2);

      scopesRefreshedSpy.resetHistory(); // Reset spy for the second call

      const newScopes = await stackFrame.getScopes(); // Second call
      expect(mockSessionHandler.sendRequest.callCount).to.equal(2);
      expect(newScopes).to.have.lengthOf(1);
      expect(stackFrame.scopes).to.have.lengthOf(1);
      expect(scopesRefreshedSpy.callCount).to.equal(1);
      expect(scopesRefreshedSpy.firstCall.args[0]).to.have.lengthOf(1);
    });

    it('should handle sequential fetches: success -> DAP error -> success, emitting appropriate events', async () => {
      const scopesRefreshedSpy = sinon.spy();
      stackFrame.on('scopesRefreshed', scopesRefreshedSpy);
      const scopesFetchFailedSpy = sinon.spy();
      stackFrame.on('scopesFetchFailed', scopesFetchFailedSpy);

      const successFullResponse = mockScopesResponse;
      const dapErrorFullResponse: DebugProtocol.ScopesResponse = {
        ...mockScopesResponse,
        success: false,
        body: undefined as unknown as DebugProtocol.ScopesResponse['body'],
        message: 'DAP Error',
      };

      mockSessionHandler.sendRequest
        .onFirstCall()
        .resolves(successFullResponse)
        .onSecondCall()
        .resolves(dapErrorFullResponse)
        .onThirdCall()
        .resolves(successFullResponse);

      // 1. First fetch (success)
      let scopes = await stackFrame.getScopes();
      expect(scopes).to.have.lengthOf(successFullResponse.body.scopes.length);
      expect(stackFrame.scopes).to.deep.equal(scopes);
      expect(scopesRefreshedSpy.calledOnceWith(scopes)).to.be.true;
      expect(scopesFetchFailedSpy.called).to.be.false;
      // @ts-expect-error Accessing private property for test verification
      expect(stackFrame._lastScopesError).to.be.undefined;

      scopesRefreshedSpy.resetHistory();
      scopesFetchFailedSpy.resetHistory();

      // 2. Second fetch (DAP error)
      scopes = await stackFrame.getScopes();
      expect(scopes).to.be.empty;
      expect(stackFrame.scopes).to.be.empty;
      expect(scopesRefreshedSpy.called).to.be.false;
      expect(scopesFetchFailedSpy.calledOnce).to.be.true;
      const [dapError] = scopesFetchFailedSpy.firstCall.args;
      expect(dapError).to.be.instanceOf(Error);
      expect(dapError.message).to.contain('Adapter returned no scopes');
      // @ts-expect-error Accessing private property for test verification
      expect(stackFrame._lastScopesError).to.equal(dapError);

      scopesRefreshedSpy.resetHistory();
      scopesFetchFailedSpy.resetHistory();

      // 3. Third fetch (success)
      scopes = await stackFrame.getScopes();
      expect(scopes).to.have.lengthOf(successFullResponse.body.scopes.length);
      expect(stackFrame.scopes).to.deep.equal(scopes);
      expect(scopesRefreshedSpy.calledOnceWith(scopes)).to.be.true;
      expect(scopesFetchFailedSpy.called).to.be.false;
      // @ts-expect-error Accessing private property for test verification
      expect(stackFrame._lastScopesError).to.be.undefined; // Error should be cleared

      expect(mockSessionHandler.sendRequest.callCount).to.equal(3);
    });
  });

  describe('Edge Case DAP Responses for getScopes()', () => {
    it('should handle response with empty scopes array, emit "scopesRefreshed" with empty array', async () => {
      const scopesRefreshedSpy = sinon.spy();
      stackFrame.on('scopesRefreshed', scopesRefreshedSpy);
      const scopesFetchFailedSpy = sinon.spy();
      stackFrame.on('scopesFetchFailed', scopesFetchFailedSpy);

      const emptyScopesFullResponse: DebugProtocol.ScopesResponse = {
        ...mockScopesResponse,
        body: { scopes: [] },
      };
      // Ensure there's something to clear for the event to be meaningful
      mockSessionHandler.sendRequest
        .withArgs('scopes', { frameId: FRAME_ID })
        .resolves(mockScopesResponse);
      await stackFrame.getScopes();
      scopesRefreshedSpy.resetHistory();
      mockSessionHandler.sendRequest.reset();
      mockSessionHandler.sendRequest.withArgs('scopes', { frameId: FRAME_ID }); // Re-apply withArgs

      mockSessionHandler.sendRequest.resolves(emptyScopesFullResponse);
      const scopes = await stackFrame.getScopes();

      expect(scopes).to.be.an('array').that.is.empty;
      expect(stackFrame.scopes).to.be.an('array').that.is.empty;
      expect(scopesRefreshedSpy.calledOnceWith([])).to.be.true;
      expect(scopesFetchFailedSpy.called).to.be.false;
    });

    it('should handle response with null scopes, emit "scopesFetchFailed", and return empty array', async () => {
      const scopesRefreshedSpy = sinon.spy();
      stackFrame.on('scopesRefreshed', scopesRefreshedSpy);
      const scopesFetchFailedSpy = sinon.spy();
      stackFrame.on('scopesFetchFailed', scopesFetchFailedSpy);

      const nullScopesFullResponse: DebugProtocol.ScopesResponse = {
        ...mockScopesResponse,
        body: { scopes: null as unknown as DebugProtocol.Scope[] },
      };
      mockSessionHandler.sendRequest.resolves(nullScopesFullResponse);

      const scopes = await stackFrame.getScopes();

      expect(scopes).to.be.an('array').that.is.empty;
      expect(stackFrame.scopes).to.be.an('array').that.is.empty;
      expect(scopesFetchFailedSpy.calledOnce).to.be.true;
      const [error] = scopesFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no scopes');
      expect(scopesRefreshedSpy.called).to.be.false;
    });

    it('should handle response with null body, emit "scopesFetchFailed", and return empty array', async () => {
      const scopesRefreshedSpy = sinon.spy();
      stackFrame.on('scopesRefreshed', scopesRefreshedSpy);
      const scopesFetchFailedSpy = sinon.spy();
      stackFrame.on('scopesFetchFailed', scopesFetchFailedSpy);

      const nullBodyFullResponse = {
        ...mockScopesResponse,
        success: false,
        body: null as unknown as DebugProtocol.ScopesResponse['body'],
        message: 'Null body',
      } as unknown as DebugProtocol.ScopesResponse;
      mockSessionHandler.sendRequest.resolves(nullBodyFullResponse);

      const scopes = await stackFrame.getScopes();

      expect(scopes).to.be.an('array').that.is.empty;
      expect(stackFrame.scopes).to.be.an('array').that.is.empty;
      expect(scopesFetchFailedSpy.calledOnce).to.be.true;
      const [error] = scopesFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no scopes');
      expect(scopesRefreshedSpy.called).to.be.false;
    });

    it('should handle response with empty body object, emit "scopesFetchFailed", and return empty array', async () => {
      const scopesRefreshedSpy = sinon.spy();
      stackFrame.on('scopesRefreshed', scopesRefreshedSpy);
      const scopesFetchFailedSpy = sinon.spy();
      stackFrame.on('scopesFetchFailed', scopesFetchFailedSpy);

      const emptyBodyFullResponse: DebugProtocol.ScopesResponse = {
        ...mockScopesResponse,
        body: {} as DebugProtocol.ScopesResponse['body'],
      };
      mockSessionHandler.sendRequest.resolves(emptyBodyFullResponse);

      const scopes = await stackFrame.getScopes();

      expect(scopes).to.be.an('array').that.is.empty;
      expect(stackFrame.scopes).to.be.an('array').that.is.empty;
      expect(scopesFetchFailedSpy.calledOnce).to.be.true;
      const [error] = scopesFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no scopes');
      expect(scopesRefreshedSpy.called).to.be.false;
    });
  });

  it('should store and expose presentationHint if provided in raw frame data', () => {
    const frameDataWithHint: DebugProtocol.StackFrame = {
      ...RAW_FRAME_DATA,
      presentationHint: 'subtle',
    };
    const frameWithHint = new DebugStackFrame(
      frameDataWithHint,
      mockParentThread,
      mockSessionHandler,
      mockLogger,
    );
    expect(frameWithHint.presentationHint).to.equal('subtle');
  });

  it('should have undefined presentationHint if not provided', () => {
    expect(stackFrame.presentationHint).to.be.undefined;
  });

  describe('evaluate()', () => {
    const EXPRESSION = 'myVar + 1';
    const mockEvaluateResponse: DebugProtocol.EvaluateResponse = {
      request_seq: 2,
      seq: 2,
      success: true,
      command: 'evaluate',
      type: 'response',
      body: {
        result: '124',
        variablesReference: 0, // 0 means not structured
        type: 'number',
      },
    };

    it('should evaluate expression successfully, return response body, and emit "evaluationCompleted"', async () => {
      const evaluationCompletedSpy = sinon.spy();
      stackFrame.on('evaluationCompleted', evaluationCompletedSpy);

      const expectedArgs: DebugProtocol.EvaluateArguments = {
        expression: EXPRESSION,
        frameId: FRAME_ID,
        context: undefined, // Default context
        format: undefined,
      };
      mockSessionHandler.sendRequest
        .withArgs('evaluate', sinon.match(expectedArgs))
        .resolves(mockEvaluateResponse); // Full response

      const resultBody = await stackFrame.evaluate(EXPRESSION);

      expect(
        mockSessionHandler.sendRequest.calledOnceWith(
          'evaluate',
          sinon.match(expectedArgs),
        ),
      ).to.be.true;
      expect(resultBody).to.deep.equal(mockEvaluateResponse.body);
      expect(evaluationCompletedSpy.calledOnce).to.be.true;
      const [emittedBody, emittedExpression, emittedContext] =
        evaluationCompletedSpy.firstCall.args;
      expect(emittedBody).to.deep.equal(mockEvaluateResponse.body);
      expect(emittedExpression).to.equal(EXPRESSION);
      expect(emittedContext).to.be.undefined;
    });

    it('should evaluate expression with specified context and format, return response body, and emit "evaluationCompleted"', async () => {
      const evaluationCompletedSpy = sinon.spy();
      stackFrame.on('evaluationCompleted', evaluationCompletedSpy);
      const context = 'watch';
      const format: DebugProtocol.ValueFormat = { hex: true };

      const expectedArgs: DebugProtocol.EvaluateArguments = {
        expression: EXPRESSION,
        frameId: FRAME_ID,
        context: context,
        format: format,
      };
      mockSessionHandler.sendRequest
        .withArgs('evaluate', sinon.match(expectedArgs))
        .resolves(mockEvaluateResponse); // Full response

      const resultBody = await stackFrame.evaluate(EXPRESSION, context, format);

      expect(
        mockSessionHandler.sendRequest.calledOnceWith(
          'evaluate',
          sinon.match(expectedArgs),
        ),
      ).to.be.true;
      expect(resultBody).to.deep.equal(mockEvaluateResponse.body);
      expect(evaluationCompletedSpy.calledOnce).to.be.true;
      const [emittedBody, emittedExpression, emittedContext, _emittedFormat] =
        evaluationCompletedSpy.firstCall.args;
      expect(emittedBody).to.deep.equal(mockEvaluateResponse.body);
      expect(emittedExpression).to.equal(EXPRESSION);
      expect(emittedContext).to.equal(context);
      // format is not part of the 'evaluationCompleted' event payload
    });

    it('should handle evaluation failure (DAP error - undefined response body) and return undefined, not emitting "evaluationFailed"', async () => {
      // Based on current implementation, undefined body logs a warning but doesn't emit 'evaluationFailed'
      const evaluationFailedSpy = sinon.spy();
      stackFrame.on('evaluationFailed', evaluationFailedSpy);
      const evaluationCompletedSpy = sinon.spy();
      stackFrame.on('evaluationCompleted', evaluationCompletedSpy);

      const errorResponseUndefinedBody: DebugProtocol.EvaluateResponse = {
        ...mockEvaluateResponse,
        success: true,
        body: undefined as unknown as DebugProtocol.EvaluateResponse['body'], // Simulate success true but no body
      };
      mockSessionHandler.sendRequest
        .withArgs('evaluate', sinon.match.any)
        .resolves(errorResponseUndefinedBody);

      const resultBody = await stackFrame.evaluate(EXPRESSION);

      expect(resultBody).to.be.undefined;
      expect(evaluationFailedSpy.called).to.be.false; // As per current code, no event for undefined body
      expect(evaluationCompletedSpy.called).to.be.false;
    });

    it('should handle evaluation failure (network/protocol error - sendRequest rejects), re-throw error, and emit "evaluationFailed"', async () => {
      const evaluationFailedSpy = sinon.spy();
      stackFrame.on('evaluationFailed', evaluationFailedSpy);
      const evaluationCompletedSpy = sinon.spy();
      stackFrame.on('evaluationCompleted', evaluationCompletedSpy);

      const networkError = new Error('Network issue during evaluate');
      mockSessionHandler.sendRequest
        .withArgs('evaluate', sinon.match.any)
        .rejects(networkError);

      let thrownError;
      try {
        await stackFrame.evaluate(EXPRESSION);
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).to.equal(networkError);
      expect(evaluationFailedSpy.calledOnce).to.be.true;
      const [emittedError, emittedExpression, emittedContext] =
        evaluationFailedSpy.firstCall.args;
      expect(emittedError).to.equal(networkError);
      expect(emittedExpression).to.equal(EXPRESSION);
      expect(emittedContext).to.be.undefined;
      expect(evaluationCompletedSpy.called).to.be.false;
    });
  });
});
