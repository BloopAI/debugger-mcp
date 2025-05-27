import { expect } from 'chai';
import * as sinon from 'sinon';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DebugScope } from '../../src/model/DebugScope';
import { DebugVariable } from '../../src/model/DebugVariable';
import { DebugStackFrame } from '../../src/model/DebugStackFrame';
import { DebugThread } from '../../src/model/DebugThread';
import {
  MockDAPSessionHandler,
  createMockLogger,
} from './mocks/mockDAPSessionHandler';
import { LoggerInterface } from '../../src/logging';
import {
  DAPSessionHandlerInterface as _DAPSessionHandlerInterface,
  DebugStackFrameInterface,
} from '../../src/model/model.types';

describe('DebugScope', () => {
  let mockSessionHandler: MockDAPSessionHandler;
  let mockLogger: LoggerInterface;
  let mockParentFrame: DebugStackFrameInterface; // Use interface for parent
  let scope: DebugScope;

  const RAW_SCOPE_DATA: DebugProtocol.Scope = {
    name: 'Local',
    variablesReference: 1001,
    expensive: false,
    namedVariables: 10,
    indexedVariables: 0,
  };

  beforeEach(() => {
    mockSessionHandler = new MockDAPSessionHandler();
    mockLogger = createMockLogger();

    // Create a minimal mock parent stack frame
    const mockThread = new DebugThread(
      1,
      'MockThread',
      mockSessionHandler,
      mockLogger,
    );
    const rawFrameData: DebugProtocol.StackFrame = {
      id: 100,
      name: 'mockFrame',
      line: 1,
      column: 1,
      source: { name: 'mock.ts' },
    };
    mockParentFrame = new DebugStackFrame(
      rawFrameData,
      mockThread,
      mockSessionHandler,
      mockLogger,
    );

    scope = new DebugScope(
      RAW_SCOPE_DATA,
      mockParentFrame,
      mockSessionHandler,
      mockLogger,
    );
  });

  afterEach(() => {
    sinon.restore();
    mockSessionHandler.reset();
  });

  describe('Constructor', () => {
    it('should initialize properties correctly from raw DAP Scope data', () => {
      expect(scope.name).to.equal(RAW_SCOPE_DATA.name);
      expect(scope.variablesReference).to.equal(
        RAW_SCOPE_DATA.variablesReference,
      );
      expect(scope.expensive).to.equal(RAW_SCOPE_DATA.expensive);
      expect(scope.namedVariables).to.equal(RAW_SCOPE_DATA.namedVariables);
      expect(scope.indexedVariables).to.equal(RAW_SCOPE_DATA.indexedVariables);
      expect(scope.variables).to.be.an('array').that.is.empty;
      expect(scope.frame).to.equal(mockParentFrame);
    });
  });

  describe('getVariables()', () => {
    const mockVariablesResponse: DebugProtocol.VariablesResponse = {
      request_seq: 1,
      seq: 1,
      success: true,
      command: 'variables',
      type: 'response',
      body: {
        variables: [
          {
            name: 'varA',
            value: '10',
            type: 'number',
            variablesReference: 0,
            evaluateName: 'varA',
          },
          {
            name: 'objB',
            value: 'Object',
            type: 'object',
            variablesReference: 1002,
            evaluateName: 'objB',
          },
        ],
      },
    };

    const defaultVariablesArgsMatcher = sinon.match({
      variablesReference: RAW_SCOPE_DATA.variablesReference,
      filter: undefined,
      start: undefined,
      count: undefined,
    });

    it('should fetch variables successfully, populate DebugVariable instances, and emit "variablesRefreshed" (full fetch)', async () => {
      const variablesRefreshedSpy = sinon.spy();
      scope.on('variablesRefreshed', variablesRefreshedSpy);

      mockSessionHandler.sendRequest
        .withArgs('variables', defaultVariablesArgsMatcher)
        .resolves(mockVariablesResponse); // Full response

      const variables = await scope.getVariables();

      expect(
        mockSessionHandler.sendRequest.calledOnceWith(
          'variables',
          defaultVariablesArgsMatcher,
        ),
      ).to.be.true; // calledOnceWith can still check all potential args
      expect(variables).to.be.an('array').with.lengthOf(2);
      expect(variables[0]).to.be.instanceOf(DebugVariable);
      expect(variables[0].name).to.equal('varA');
      expect(variables[1]).to.be.instanceOf(DebugVariable);
      expect(variables[1].name).to.equal('objB');
      expect(scope.variables).to.deep.equal(variables); // Internal state should still be updated for full fetch

      expect(variablesRefreshedSpy.calledOnce).to.be.true;
      const [emittedVariables] = variablesRefreshedSpy.firstCall.args;
      expect(emittedVariables).to.deep.equal(variables);
    });

    it('should fetch variables with filter/pagination, return them, NOT overwrite internal list, and emit "partialVariablesFetched"', async () => {
      const filter: 'indexed' | 'named' = 'indexed';
      const start = 5;
      const count = 5;
      const paginatedDapArgsMatcher = sinon.match({
        variablesReference: RAW_SCOPE_DATA.variablesReference,
        filter,
        start,
        count,
      });
      const paginatedResponse: DebugProtocol.VariablesResponse = {
        ...mockVariablesResponse,
        body: {
          variables: [
            {
              name: 'arr[5]',
              value: '50',
              type: 'number',
              variablesReference: 0,
            },
          ],
        },
      };

      mockSessionHandler.sendRequest
        .withArgs('variables', defaultVariablesArgsMatcher)
        .resolves(mockVariablesResponse);
      await scope.getVariables();
      const initialInternalVariables = [...scope.variables];

      mockSessionHandler.sendRequest.resetHistory();

      const partialVariablesFetchedSpy = sinon.spy();
      scope.on('partialVariablesFetched', partialVariablesFetchedSpy);

      mockSessionHandler.sendRequest
        .withArgs('variables', paginatedDapArgsMatcher)
        .resolves(paginatedResponse); // Full response

      const fetchedVariables = await scope.getVariables(filter, start, count);

      expect(
        mockSessionHandler.sendRequest.calledOnceWith(
          'variables',
          paginatedDapArgsMatcher,
        ),
      ).to.be.true;
      expect(fetchedVariables).to.be.an('array').with.lengthOf(1);
      expect(fetchedVariables[0].name).to.equal('arr[5]');
      expect(scope.variables).to.deep.equal(initialInternalVariables); // Internal list not changed for partial

      expect(partialVariablesFetchedSpy.calledOnce).to.be.true;
      const [emittedFetchedVars, emittedFilter, emittedStart, emittedCount] =
        partialVariablesFetchedSpy.firstCall.args;
      expect(emittedFetchedVars).to.deep.equal(fetchedVariables);
      expect(emittedFilter).to.equal(filter);
      expect(emittedStart).to.equal(start);
      expect(emittedCount).to.equal(count);
    });

    it('should handle fetch failure (DAP error from undefined response), clear variables (if full fetch), emit "fetchFailed", and resolve with empty array', async () => {
      mockSessionHandler.sendRequest
        .withArgs('variables', defaultVariablesArgsMatcher)
        .resolves(mockVariablesResponse);

      await scope.getVariables();
      expect(scope.variables).to.not.be.empty;

      mockSessionHandler.sendRequest.reset();
      mockSessionHandler.sendRequest.resetHistory(); // Keep this to ensure sendRequest mock is clean for this test part

      const fetchFailedSpy = sinon.spy();
      scope.on('fetchFailed', fetchFailedSpy);

      const errorResponseUndefined = {
        request_seq: mockVariablesResponse.request_seq,
        seq: mockVariablesResponse.seq,
        type: 'response' as const,
        command: mockVariablesResponse.command,
        success: false, // Indicate failure
        message: 'Simulated DAP error - undefined body',
        body: undefined, // Simulate undefined body
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .withArgs('variables', defaultVariablesArgsMatcher)
        .resolves(errorResponseUndefined);

      const result = await scope.getVariables();

      expect(result).to.be.an('array').that.is.empty;
      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true;
      expect(scope.variables).to.be.an('array').that.is.empty; // Internal state cleared for full fetch failure

      expect(fetchFailedSpy.calledOnce).to.be.true;
      const [error, context] = fetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.equal(
        `Failed to retrieve variables for scope reference ${scope.variablesReference}. Adapter returned no variables.`,
      );
      expect(context.filter).to.be.undefined;
      expect(context.start).to.be.undefined;
      expect(context.count).to.be.undefined;
      expect(context.wasFullFetchAttempt).to.be.true;
    });

    it('should handle fetch failure (DAP error from undefined response) for partial fetch, NOT clear variables, emit "fetchFailed", and resolve with empty array', async () => {
      const filter: 'indexed' | 'named' = 'indexed';
      const start = 1;
      const count = 1;
      const paginatedDapArgsMatcher = sinon.match({
        variablesReference: RAW_SCOPE_DATA.variablesReference,
        filter,
        start,
        count,
      });

      mockSessionHandler.sendRequest
        .withArgs('variables', defaultVariablesArgsMatcher)
        .resolves(mockVariablesResponse);
      await scope.getVariables();
      const initialInternalVariables = [...scope.variables];
      mockSessionHandler.sendRequest.resetHistory();

      const fetchFailedSpy = sinon.spy();
      scope.on('fetchFailed', fetchFailedSpy);

      const errorResponseUndefinedPartial = {
        request_seq: mockVariablesResponse.request_seq,
        seq: mockVariablesResponse.seq,
        type: 'response' as const,
        command: mockVariablesResponse.command,
        success: false,
        message: 'Simulated DAP error - undefined body for partial fetch',
        body: undefined,
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .withArgs('variables', paginatedDapArgsMatcher)
        .resolves(errorResponseUndefinedPartial);

      const result = await scope.getVariables(filter, start, count);

      expect(result).to.be.an('array').that.is.empty;
      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true;
      expect(scope.variables).to.deep.equal(initialInternalVariables); // Internal state NOT cleared for partial fetch failure

      expect(fetchFailedSpy.calledOnce).to.be.true;
      const [error, context] = fetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.equal(
        `Failed to retrieve variables for scope reference ${scope.variablesReference}. Adapter returned no variables.`,
      );
      expect(context.filter).to.equal(filter);
      expect(context.start).to.equal(start);
      expect(context.count).to.equal(count);
      expect(context.wasFullFetchAttempt).to.be.false;
    });

    it('should handle fetch failure (network/protocol error from sendRequest reject), clear variables (if full fetch), emit "fetchFailed", and resolve with empty array', async () => {
      mockSessionHandler.sendRequest
        .withArgs('variables', defaultVariablesArgsMatcher)
        .resolves(mockVariablesResponse);
      await scope.getVariables();
      expect(scope.variables).to.not.be.empty;

      mockSessionHandler.sendRequest.reset();
      mockSessionHandler.sendRequest.resetHistory();

      const fetchFailedSpy = sinon.spy();
      scope.on('fetchFailed', fetchFailedSpy);

      const networkError = new Error('Network issue');
      mockSessionHandler.sendRequest
        .withArgs('variables', defaultVariablesArgsMatcher)
        .rejects(networkError);

      const result = await scope.getVariables();

      expect(result).to.be.an('array').that.is.empty;
      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true;
      expect(scope.variables).to.be.an('array').that.is.empty; // Internal state cleared for full fetch failure

      expect(fetchFailedSpy.calledOnce).to.be.true;
      const [error, context] = fetchFailedSpy.firstCall.args;
      expect(error).to.equal(networkError); // Should be the exact error instance
      expect(context.filter).to.be.undefined;
      expect(context.start).to.be.undefined;
      expect(context.count).to.be.undefined;
      expect(context.wasFullFetchAttempt).to.be.true;
    });

    it('should deduplicate concurrent getVariables calls (full fetch) and emit "variablesRefreshed" once', async () => {
      const delay = 50;
      const promise = new Promise<DebugProtocol.VariablesResponse>(
        (resolve) => {
          // Promise of full response
          setTimeout(() => resolve(mockVariablesResponse), delay);
        },
      );
      const expectedFullFetchArgsMatcher = sinon.match({
        variablesReference: RAW_SCOPE_DATA.variablesReference,
        filter: undefined,
        start: undefined,
        count: undefined,
      });
      mockSessionHandler.sendRequest
        .withArgs('variables', expectedFullFetchArgsMatcher)
        .returns(promise);

      const variablesRefreshedSpy = sinon.spy();
      scope.on('variablesRefreshed', variablesRefreshedSpy);

      const p1 = scope.getVariables();
      const p2 = scope.getVariables();

      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true; // sendRequest still called once

      const results = await Promise.all([p1, p2]);

      expect(results[0]).to.be.an('array').with.lengthOf(2);
      expect(results[1]).to.be.an('array').with.lengthOf(2);
      expect(results[0]?.[0].name).to.equal('varA');

      expect(variablesRefreshedSpy.calledOnce).to.be.true; // Event emitted once
      const [emittedVariables] = variablesRefreshedSpy.firstCall.args;
      expect(emittedVariables).to.deep.equal(results[0]); // Check payload
    });

    it('should NOT deduplicate concurrent getVariables calls with different arguments (partial fetches) and emit "partialVariablesFetched" for each', async () => {
      const filter1: 'named' | 'indexed' = 'named';
      const start1 = 0;
      const count1 = 1;
      const dapArgs1 = {
        variablesReference: RAW_SCOPE_DATA.variablesReference,
        filter: filter1,
        start: start1,
        count: count1,
      };

      const filter2: 'indexed' | 'indexed' = 'indexed';
      const start2 = 1;
      const count2 = 1;
      const dapArgs2 = {
        variablesReference: RAW_SCOPE_DATA.variablesReference,
        filter: filter2,
        start: start2,
        count: count2,
      };

      const response1: DebugProtocol.VariablesResponse = {
        ...mockVariablesResponse,
        body: { variables: [mockVariablesResponse.body.variables[0]] },
      };
      const response2: DebugProtocol.VariablesResponse = {
        ...mockVariablesResponse,
        body: { variables: [mockVariablesResponse.body.variables[1]] },
      };

      mockSessionHandler.sendRequest.reset();
      const dapArgs1Matcher = sinon.match(dapArgs1);
      const dapArgs2Matcher = sinon.match(dapArgs2);

      mockSessionHandler.sendRequest.callsFake(
        async (command: string, args: DebugProtocol.VariablesArguments) => {
          // Simpler fake for 2-arg calls
          if (command === 'variables') {
            if (dapArgs1Matcher.test(args)) {
              return Promise.resolve(response1);
            }
            if (dapArgs2Matcher.test(args)) {
              return Promise.resolve(response2);
            }
          }
          // Fallback for any other calls, though not expected in this specific test
          return Promise.reject(
            new Error(
              `Unexpected sendRequest call in test: ${command} with ${JSON.stringify(args)}`,
            ),
          );
        },
      );

      const partialVariablesFetchedSpy = sinon.spy();
      scope.on('partialVariablesFetched', partialVariablesFetchedSpy);

      const p1 = scope.getVariables(filter1, start1, count1);
      const p2 = scope.getVariables(filter2, start2, count2);

      const results = await Promise.all([p1, p2]);

      expect(mockSessionHandler.sendRequest.calledTwice).to.be.true;
      const expectedOptionsMatcher = sinon.match({
        allowedStates: ['stopped', 'active'],
      });
      expect(
        mockSessionHandler.sendRequest
          .getCall(0)
          .calledWithExactly(
            'variables',
            sinon.match(dapArgs1),
            expectedOptionsMatcher,
          ),
      ).to.be.true;
      expect(
        mockSessionHandler.sendRequest
          .getCall(1)
          .calledWithExactly(
            'variables',
            sinon.match(dapArgs2),
            expectedOptionsMatcher,
          ),
      ).to.be.true;

      expect(results[0]).to.be.an('array').with.lengthOf(1);
      expect(results[0]?.[0].name).to.equal('varA');
      expect(results[1]).to.be.an('array').with.lengthOf(1);
      expect(results[1]?.[0].name).to.equal('objB');

      expect(partialVariablesFetchedSpy.calledTwice).to.be.true;

      // Check first call's event payload
      const [
        emittedFetchedVars1,
        emittedFilter1,
        emittedStart1,
        emittedCount1,
      ] = partialVariablesFetchedSpy.getCall(0).args;
      expect(emittedFetchedVars1).to.deep.equal(results[0]);
      expect(emittedFilter1).to.equal(filter1);
      expect(emittedStart1).to.equal(start1);
      expect(emittedCount1).to.equal(count1);

      // Check second call's event payload
      const [
        emittedFetchedVars2,
        emittedFilter2,
        emittedStart2,
        emittedCount2,
      ] = partialVariablesFetchedSpy.getCall(1).args;
      expect(emittedFetchedVars2).to.deep.equal(results[1]);
      expect(emittedFilter2).to.equal(filter2);
      expect(emittedStart2).to.equal(start2);
      expect(emittedCount2).to.equal(count2);
    });
  });

  describe('Sequential Fetch Operations for getVariables() (full fetch)', () => {
    const mockFullVariablesResponse = {
      // Re-define for clarity in this block
      body: {
        variables: [
          {
            name: 'varFull1',
            value: 'val1',
            type: 'string',
            variablesReference: 0,
          },
          {
            name: 'varFull2',
            value: 'val2',
            type: 'string',
            variablesReference: 0,
          },
        ],
      },
    };
    const defaultFullFetchArgsMatcher = sinon.match({
      variablesReference: RAW_SCOPE_DATA.variablesReference,
      filter: undefined,
      start: undefined,
      count: undefined,
    });

    it('should handle full fetch sequence: success -> DAP error -> success, emitting appropriate events', async () => {
      const variablesRefreshedSpy = sinon.spy();
      scope.on('variablesRefreshed', variablesRefreshedSpy);
      const fetchFailedSpy = sinon.spy();
      scope.on('fetchFailed', fetchFailedSpy);

      const successResponse: DebugProtocol.VariablesResponse = {
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'variables',
        type: 'response', // Base properties
        body: mockFullVariablesResponse.body,
      };
      const dapErrorResponse = {
        request_seq: 1,
        seq: 1,
        success: false,
        command: 'variables',
        type: 'response' as const, // Base properties
        body: undefined,
        message: 'DAP Error',
      } as DebugProtocol.Response;

      mockSessionHandler.sendRequest
        .withArgs('variables', defaultFullFetchArgsMatcher) // Add withArgs for the first call in the chain
        .onFirstCall()
        .resolves(successResponse)
        .withArgs('variables', defaultFullFetchArgsMatcher) // And for subsequent chained calls
        .onSecondCall()
        .resolves(dapErrorResponse)
        .withArgs('variables', defaultFullFetchArgsMatcher)
        .onThirdCall()
        .resolves(successResponse);

      // 1. First fetch (success)
      let vars = await scope.getVariables();
      expect(vars).to.have.lengthOf(successResponse.body.variables.length);
      expect(scope.variables).to.deep.equal(vars);
      expect(variablesRefreshedSpy.calledOnceWith(vars)).to.be.true;
      expect(fetchFailedSpy.called).to.be.false;
      // @ts-expect-error Accessing private property
      expect(scope._lastVariablesError).to.be.undefined;

      variablesRefreshedSpy.resetHistory();
      fetchFailedSpy.resetHistory();

      // 2. Second fetch (DAP error)
      vars = await scope.getVariables();
      expect(vars).to.be.empty;
      expect(scope.variables).to.be.empty;
      expect(variablesRefreshedSpy.called).to.be.false;
      expect(fetchFailedSpy.calledOnce).to.be.true;
      const [dapError, dapErrorContext] = fetchFailedSpy.firstCall.args;
      expect(dapError).to.be.instanceOf(Error);
      expect(dapError.message).to.contain('Adapter returned no variables.');
      expect(dapErrorContext.wasFullFetchAttempt).to.be.true;
      // @ts-expect-error Accessing private property
      expect(scope._lastVariablesError).to.equal(dapError);

      variablesRefreshedSpy.resetHistory();
      fetchFailedSpy.resetHistory();

      // 3. Third fetch (success)
      vars = await scope.getVariables();
      expect(vars).to.have.lengthOf(successResponse.body.variables.length);
      expect(scope.variables).to.deep.equal(vars);
      expect(variablesRefreshedSpy.calledOnceWith(vars)).to.be.true;
      expect(fetchFailedSpy.called).to.be.false;
      // @ts-expect-error Accessing private property
      expect(scope._lastVariablesError).to.be.undefined; // Error should be cleared

      expect(mockSessionHandler.sendRequest.callCount).to.equal(3);
    });
  });

  describe('Edge Case DAP Responses for getVariables() (full fetch)', () => {
    const defaultFullFetchArgsMatcher = sinon.match({
      variablesReference: RAW_SCOPE_DATA.variablesReference,
      filter: undefined,
      start: undefined,
      count: undefined,
    });

    beforeEach(async () => {
      // Ensure a clean state for variables and spies before each edge case test
      scope.variables = []; // Clear any existing variables
      // Pre-populate for tests that check clearing
      const initialFullResponse: DebugProtocol.VariablesResponse = {
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'variables',
        type: 'response', // Base properties
        body: {
          variables: [
            {
              name: 'pre',
              value: 'preVal',
              type: 'string',
              variablesReference: 0,
            },
          ],
        },
      };
      mockSessionHandler.sendRequest.resolves(initialFullResponse);
      await scope.getVariables(); // Populate
      mockSessionHandler.sendRequest.reset(); // Reset for the actual test call
      sinon.resetHistory(); // Reset all spies
    });

    it('should handle response with empty variables array, emit "variablesRefreshed" with empty array', async () => {
      const variablesRefreshedSpy = sinon.spy();
      scope.on('variablesRefreshed', variablesRefreshedSpy);
      const fetchFailedSpy = sinon.spy();
      scope.on('fetchFailed', fetchFailedSpy);

      const emptyVariablesFullResponse: DebugProtocol.VariablesResponse = {
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'variables',
        type: 'response', // Base properties
        body: { variables: [] },
      };
      mockSessionHandler.sendRequest
        .withArgs('variables', defaultFullFetchArgsMatcher)
        .resolves(emptyVariablesFullResponse);

      const fetchedVars = await scope.getVariables();

      expect(fetchedVars).to.be.an('array').that.is.empty;
      expect(scope.variables).to.be.an('array').that.is.empty;
      expect(variablesRefreshedSpy.calledOnceWith([])).to.be.true;
      expect(fetchFailedSpy.called).to.be.false;
    });

    it('should handle response with null variables array, emit "fetchFailed", and return empty array', async () => {
      const variablesRefreshedSpy = sinon.spy();
      scope.on('variablesRefreshed', variablesRefreshedSpy);
      const fetchFailedSpy = sinon.spy();
      scope.on('fetchFailed', fetchFailedSpy);

      const nullVariablesFullResponse: DebugProtocol.VariablesResponse = {
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'variables',
        type: 'response', // Base properties
        body: { variables: null as unknown as DebugProtocol.Variable[] },
      };
      mockSessionHandler.sendRequest
        .withArgs('variables', defaultFullFetchArgsMatcher)
        .resolves(nullVariablesFullResponse);

      const fetchedVars = await scope.getVariables();

      expect(fetchedVars).to.be.an('array').that.is.empty;
      expect(scope.variables).to.be.an('array').that.is.empty; // Cleared on full fetch failure
      expect(fetchFailedSpy.calledOnce).to.be.true;
      const [error, context] = fetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no variables.');
      expect(context.wasFullFetchAttempt).to.be.true;
      expect(variablesRefreshedSpy.called).to.be.false;
    });

    it('should handle response with null body, emit "fetchFailed", and return empty array', async () => {
      const variablesRefreshedSpy = sinon.spy();
      scope.on('variablesRefreshed', variablesRefreshedSpy);
      const fetchFailedSpy = sinon.spy();
      scope.on('fetchFailed', fetchFailedSpy);

      const nullBodyFullResponse = {
        request_seq: 1,
        seq: 1,
        success: false,
        command: 'variables',
        type: 'response' as const, // Base properties
        body: null,
        message: 'Null body',
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .withArgs('variables', defaultFullFetchArgsMatcher)
        .resolves(nullBodyFullResponse);

      const fetchedVars = await scope.getVariables();

      expect(fetchedVars).to.be.an('array').that.is.empty;
      expect(scope.variables).to.be.an('array').that.is.empty;
      expect(fetchFailedSpy.calledOnce).to.be.true;
      const [error, context] = fetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no variables.');
      expect(context.wasFullFetchAttempt).to.be.true;
      expect(variablesRefreshedSpy.called).to.be.false;
    });

    it('should handle response with empty body object, emit "fetchFailed", and return empty array', async () => {
      const variablesRefreshedSpy = sinon.spy();
      scope.on('variablesRefreshed', variablesRefreshedSpy);
      const fetchFailedSpy = sinon.spy();
      scope.on('fetchFailed', fetchFailedSpy);

      const emptyBodyFullResponse: DebugProtocol.VariablesResponse = {
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'variables',
        type: 'response', // Base properties
        body: {} as DebugProtocol.VariablesResponse['body'],
      };
      mockSessionHandler.sendRequest
        .withArgs('variables', defaultFullFetchArgsMatcher)
        .resolves(emptyBodyFullResponse);

      const fetchedVars = await scope.getVariables();

      expect(fetchedVars).to.be.an('array').that.is.empty;
      expect(scope.variables).to.be.an('array').that.is.empty;
      expect(fetchFailedSpy.calledOnce).to.be.true;
      const [error, context] = fetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no variables.');
      expect(context.wasFullFetchAttempt).to.be.true;
      expect(variablesRefreshedSpy.called).to.be.false;
    });
  });
});
