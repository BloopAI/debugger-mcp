import { expect } from 'chai';
import * as sinon from 'sinon';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DebugVariable } from '../../src/model/DebugVariable';
import { DebugScope } from '../../src/model/DebugScope';
import { DebugStackFrame } from '../../src/model/DebugStackFrame';
import { DebugThread } from '../../src/model/DebugThread';
import {
  MockDAPSessionHandler,
  createMockLogger,
} from './mocks/mockDAPSessionHandler';
import { LoggerInterface } from '../../src/logging';
import { DebugScopeInterface } from '../../src/model/model.types';

describe('DebugVariable', () => {
  let mockSessionHandler: MockDAPSessionHandler;
  let mockLogger: LoggerInterface;
  let mockParentScope: DebugScopeInterface;
  let variable: DebugVariable;

  const RAW_VARIABLE_DATA: DebugProtocol.Variable = {
    name: 'myVar',
    value: '"hello"',
    type: 'string',
    variablesReference: 0,
    evaluateName: 'myVar',
  };

  const EXPANDABLE_RAW_VARIABLE_DATA: DebugProtocol.Variable = {
    name: 'myObj',
    value: 'Object',
    type: 'object',
    variablesReference: 2001,
    namedVariables: 3,
    evaluateName: 'myObj',
  };

  beforeEach(() => {
    mockSessionHandler = new MockDAPSessionHandler();
    mockLogger = createMockLogger();

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
    const mockFrame = new DebugStackFrame(
      rawFrameData,
      mockThread,
      mockSessionHandler,
      mockLogger,
    );
    const rawScopeData: DebugProtocol.Scope = {
      name: 'Locals',
      variablesReference: 1001,
      expensive: false,
    };
    mockParentScope = new DebugScope(
      rawScopeData,
      mockFrame,
      mockSessionHandler,
      mockLogger,
    );

    variable = new DebugVariable(
      RAW_VARIABLE_DATA,
      mockParentScope,
      mockSessionHandler,
      mockLogger,
    );
  });

  afterEach(() => {
    sinon.restore();
    mockSessionHandler.reset();
  });

  describe('Constructor', () => {
    it('should initialize properties correctly from raw DAP Variable data', () => {
      expect(variable.name).to.equal(RAW_VARIABLE_DATA.name);
      expect(variable.value).to.equal(RAW_VARIABLE_DATA.value);
      expect(variable.type).to.equal(RAW_VARIABLE_DATA.type);
      expect(variable.variablesReference).to.equal(
        RAW_VARIABLE_DATA.variablesReference,
      );
      expect(variable.evaluateName).to.equal(RAW_VARIABLE_DATA.evaluateName);
      expect(variable.presentationHint).to.be.undefined;
      expect(variable.parentScopeOrVar).to.equal(mockParentScope);
      expect(variable.children).to.be.an('array').that.is.empty;
    });

    it('should initialize presentationHint if provided', () => {
      const dataWithHint: DebugProtocol.Variable = {
        ...RAW_VARIABLE_DATA,
        presentationHint: { kind: 'property', attributes: ['rawString'] },
      };
      const varWithHint = new DebugVariable(
        dataWithHint,
        mockParentScope,
        mockSessionHandler,
        mockLogger,
      );
      expect(varWithHint.presentationHint).to.deep.equal({
        kind: 'property',
        attributes: ['rawString'],
      });
    });
  });

  describe('setValue(value: string)', () => {
    const SET_VALUE = '"new value"';
    const mockSetVariableFullResponse: DebugProtocol.SetVariableResponse = {
      request_seq: 1,
      seq: 1,
      success: true,
      command: 'setVariable',
      type: 'response',
      body: {
        value: SET_VALUE,
        type: 'string',
        variablesReference: 0,
      },
    };

    it('should send setVariable request, update properties, and emit "valueChanged" if supported', async () => {
      const valueChangedSpy = sinon.spy();
      variable.on('valueChanged', valueChangedSpy);
      mockSessionHandler.capabilities.supportsSetVariable = true;
      const setVariableArgs: DebugProtocol.SetVariableArguments = {
        variablesReference: mockParentScope.variablesReference,
        name: RAW_VARIABLE_DATA.name,
        value: SET_VALUE,
      };
      mockSessionHandler.sendRequest
        .withArgs('setVariable', setVariableArgs)
        .resolves(mockSetVariableFullResponse);

      const resultBody = await variable.setValue(SET_VALUE);

      expect(resultBody).to.deep.equal(mockSetVariableFullResponse.body);
      expect(
        mockSessionHandler.sendRequest.calledOnceWith(
          'setVariable',
          setVariableArgs,
        ),
      ).to.be.true;
      expect(variable.value).to.equal(SET_VALUE);
      expect(variable.type).to.equal(mockSetVariableFullResponse.body.type);
      expect(variable.variablesReference).to.equal(
        mockSetVariableFullResponse.body.variablesReference,
      );

      expect(valueChangedSpy.calledOnce).to.be.true;
      const [emittedNewValue, emittedNewType, emittedNewVarRef] =
        valueChangedSpy.firstCall.args;
      expect(emittedNewValue).to.equal(SET_VALUE);
      expect(emittedNewType).to.equal(mockSetVariableFullResponse.body.type);
      expect(emittedNewVarRef).to.equal(
        mockSetVariableFullResponse.body.variablesReference,
      );
    });

    it('should reject, not send request, and emit "setValueFailed" if setVariable capability is false', async () => {
      const setValueFailedSpy = sinon.spy();
      variable.on('setValueFailed', setValueFailedSpy);
      mockSessionHandler.capabilities.supportsSetVariable = false;

      let caughtError: Error | undefined;
      try {
        await variable.setValue(SET_VALUE);
      } catch (e: unknown) {
        if (e instanceof Error) {
          caughtError = e;
        } else {
          caughtError = new Error(`Caught non-Error: ${String(e)}`);
        }
      }
      expect(caughtError).to.be.instanceOf(Error);
      const expectedErrorMsg =
        'Adapter does not support setting variable values.';
      expect(caughtError?.message).to.equal(expectedErrorMsg);
      expect(mockSessionHandler.sendRequest.called).to.be.false;

      expect(setValueFailedSpy.calledOnce).to.be.true;
      const [emittedError, emittedAttemptedValue] =
        setValueFailedSpy.firstCall.args;
      expect(emittedError.message).to.equal(expectedErrorMsg);
      expect(emittedAttemptedValue).to.equal(SET_VALUE);
    });

    it('should handle setVariable failure (DAP error from undefined response), not change properties, and emit "setValueFailed"', async () => {
      mockSessionHandler.capabilities.supportsSetVariable = true;
      const setVariableArgs: DebugProtocol.SetVariableArguments = {
        variablesReference: mockParentScope.variablesReference,
        name: RAW_VARIABLE_DATA.name,
        value: SET_VALUE,
      };
      const errorResponseUndefined = {
        request_seq: mockSetVariableFullResponse.request_seq,
        seq: mockSetVariableFullResponse.seq,
        type: 'response' as const,
        command: mockSetVariableFullResponse.command,
        success: false,
        body: undefined, // Body can be undefined for an error response
        message: 'DAP Error',
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .withArgs('setVariable', setVariableArgs)
        .resolves(errorResponseUndefined);

      const originalValue = variable.value;
      const originalType = variable.type;

      let eventEmitted = false;
      let emittedErrorFromEvent: Error | undefined;
      let emittedValueFromEvent: string | undefined;

      variable.on('setValueFailed', (err: Error, val: string) => {
        eventEmitted = true;
        emittedErrorFromEvent = err;
        emittedValueFromEvent = val;
      });

      let caughtError: Error | undefined;
      try {
        await variable.setValue(SET_VALUE);
      } catch (e: unknown) {
        if (e instanceof Error) {
          caughtError = e;
        } else {
          caughtError = new Error(`Caught non-Error: ${String(e)}`);
        }
      }

      expect(caughtError).to.be.instanceOf(Error);
      const expectedErrorMessage = `Adapter returned no response body for setVariable on '${variable.name}'.`;
      expect(caughtError?.message).to.equal(expectedErrorMessage);

      expect(variable.value).to.equal(originalValue);
      expect(variable.type).to.equal(originalType);

      expect(eventEmitted, 'setValueFailed event should have been emitted').to
        .be.true;
      if (eventEmitted) {
        // Check args only if event was emitted
        expect(emittedErrorFromEvent).to.be.instanceOf(Error);
        expect(emittedErrorFromEvent?.message).to.equal(expectedErrorMessage);
        expect(emittedValueFromEvent).to.equal(SET_VALUE);
      }
    });

    it('should handle setVariable failure (network/protocol error from sendRequest reject), re-throw and emit "setValueFailed"', async () => {
      mockSessionHandler.capabilities.supportsSetVariable = true;
      const networkError = new Error('Network issue');
      const setVariableArgs: DebugProtocol.SetVariableArguments = {
        variablesReference: mockParentScope.variablesReference,
        name: RAW_VARIABLE_DATA.name,
        value: SET_VALUE,
      };
      mockSessionHandler.sendRequest
        .withArgs('setVariable', setVariableArgs)
        .rejects(networkError);

      let caughtError: Error | undefined;
      try {
        await variable.setValue(SET_VALUE);
      } catch (e: unknown) {
        if (e instanceof Error) {
          caughtError = e;
        } else {
          caughtError = new Error(`Caught non-Error: ${String(e)}`);
        }
      }
      expect(caughtError).to.equal(networkError);

      const setValueFailedSpy = sinon.spy();
      variable.on('setValueFailed', setValueFailedSpy);

      // We need to re-trigger the call to ensure the event is emitted by the instance for this specific path
      try {
        await variable.setValue(SET_VALUE);
      } catch {
        // Error already caught and verified
      }

      expect(setValueFailedSpy.calledOnce).to.be.true;
      const [emittedError, emittedAttemptedValue] =
        setValueFailedSpy.firstCall.args;
      expect(emittedError).to.equal(networkError);
      expect(emittedAttemptedValue).to.equal(SET_VALUE);
    });
  });

  describe('getChildren()', () => {
    // Define mockChildVariablesFullResponse at the top of this describe block
    const mockChildVariablesFullResponse: DebugProtocol.VariablesResponse = {
      request_seq: 1,
      seq: 1,
      success: true,
      command: 'variables',
      type: 'response',
      body: {
        variables: [
          {
            name: 'child1',
            value: 'true',
            type: 'boolean',
            variablesReference: 0,
          },
          {
            name: 'child2',
            value: 'null',
            type: 'object',
            variablesReference: 0,
          },
        ],
      },
    };

    let expandableVariable: DebugVariable;

    beforeEach(() => {
      expandableVariable = new DebugVariable(
        EXPANDABLE_RAW_VARIABLE_DATA,
        mockParentScope,
        mockSessionHandler,
        mockLogger,
      );
    });

    it('should return empty array if variablesReference is 0', async () => {
      expect(variable.variablesReference).to.equal(0);
      const children = await variable.getChildren();
      expect(children).to.be.an('array').that.is.empty;
      expect(mockSessionHandler.sendRequest.called).to.be.false;
    });

    it('should fetch children successfully if variablesReference > 0, populate them, and emit "childrenRefreshed"', async () => {
      const childrenRefreshedSpy = sinon.spy();
      expandableVariable.on('childrenRefreshed', childrenRefreshedSpy);

      const expectedArgs: DebugProtocol.VariablesArguments = {
        variablesReference: EXPANDABLE_RAW_VARIABLE_DATA.variablesReference,
      };
      mockSessionHandler.sendRequest
        .withArgs('variables', expectedArgs)
        .resolves(mockChildVariablesFullResponse);

      const children = await expandableVariable.getChildren();

      expect(
        mockSessionHandler.sendRequest.calledOnceWith(
          'variables',
          expectedArgs,
        ),
      ).to.be.true;
      expect(children).to.be.an('array').with.lengthOf(2);
      expect(children[0]).to.be.instanceOf(DebugVariable);
      expect(children[0].name).to.equal('child1');
      expect(expandableVariable.children).to.deep.equal(children); // Internal state updated

      expect(childrenRefreshedSpy.calledOnce).to.be.true;
      const [emittedChildren] = childrenRefreshedSpy.firstCall.args;
      expect(emittedChildren).to.deep.equal(children);
    });

    it('should handle fetch children failure (DAP error from undefined response), clear children, emit "childrenFetchFailed", and resolve with empty array', async () => {
      mockSessionHandler.sendRequest
        .withArgs('variables', {
          variablesReference: EXPANDABLE_RAW_VARIABLE_DATA.variablesReference,
        })
        .onFirstCall()
        .resolves(mockChildVariablesFullResponse);
      await expandableVariable.getChildren();
      expect(expandableVariable.children).to.not.be.empty;

      mockSessionHandler.sendRequest.reset();

      const childrenFetchFailedSpy = sinon.spy();
      expandableVariable.on('childrenFetchFailed', childrenFetchFailedSpy);

      const errorResponseUndefined = {
        request_seq: mockChildVariablesFullResponse.request_seq,
        seq: mockChildVariablesFullResponse.seq,
        type: 'response' as const,
        command: mockChildVariablesFullResponse.command,
        success: false,
        body: undefined,
        message: 'DAP error',
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .withArgs('variables', {
          variablesReference: EXPANDABLE_RAW_VARIABLE_DATA.variablesReference,
        })
        .resolves(errorResponseUndefined);

      const result = await expandableVariable.getChildren();

      expect(result).to.be.an('array').that.is.empty;
      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true;
      expect(expandableVariable.children).to.be.an('array').that.is.empty; // Internal state cleared

      expect(childrenFetchFailedSpy.calledOnce).to.be.true;
      const [error] = childrenFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.equal(
        `Failed to retrieve children for variable reference ${expandableVariable.variablesReference}. Adapter returned no variables.`,
      );
    });

    it('should deduplicate concurrent getChildren calls and emit "childrenRefreshed" once', async () => {
      const delay = 50;
      const promise = new Promise<DebugProtocol.VariablesResponse>(
        (resolve) => {
          // Promise of full response
          setTimeout(() => resolve(mockChildVariablesFullResponse), delay);
        },
      );
      mockSessionHandler.sendRequest
        .withArgs('variables', {
          variablesReference: EXPANDABLE_RAW_VARIABLE_DATA.variablesReference,
        })
        .returns(promise);

      const p1 = expandableVariable.getChildren();
      const p2 = expandableVariable.getChildren();

      const childrenRefreshedSpy = sinon.spy();
      expandableVariable.on('childrenRefreshed', childrenRefreshedSpy);

      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true; // sendRequest still called once

      const results = await Promise.all([p1, p2]);
      expect(results[0]).to.be.an('array').with.lengthOf(2);
      expect(results[1]).to.be.an('array').with.lengthOf(2);

      expect(childrenRefreshedSpy.calledOnce).to.be.true; // Event emitted once
      const [emittedChildren] = childrenRefreshedSpy.firstCall.args;
      expect(emittedChildren).to.deep.equal(results[0]);
    });
  });

  describe('Sequential Fetch Operations for getChildren()', () => {
    let expandableVar: DebugVariable;
    // Define a base response for this specific describe block
    const baseSequentialMockVariablesResponse: DebugProtocol.VariablesResponse =
      {
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'variables',
        type: 'response',
        body: { variables: [] }, // Placeholder, will be overridden
      };
    const childVarsResponse1: DebugProtocol.VariablesResponse = {
      ...baseSequentialMockVariablesResponse,
      body: {
        variables: [
          { name: 'childA', value: '1', type: 'number', variablesReference: 0 },
        ],
      },
    };
    const childVarsResponse2: DebugProtocol.VariablesResponse = {
      ...baseSequentialMockVariablesResponse,
      body: {
        variables: [
          { name: 'childB', value: '2', type: 'number', variablesReference: 0 },
        ],
      },
    };
    const dapErrorResponseUndefined = {
      request_seq: baseSequentialMockVariablesResponse.request_seq,
      seq: baseSequentialMockVariablesResponse.seq,
      type: 'response' as const,
      command: baseSequentialMockVariablesResponse.command,
      success: false,
      body: undefined,
      message: 'DAP Error',
    } as DebugProtocol.Response;

    beforeEach(() => {
      expandableVar = new DebugVariable(
        EXPANDABLE_RAW_VARIABLE_DATA,
        mockParentScope,
        mockSessionHandler,
        mockLogger,
      );
    });

    it('should handle getChildren sequence: success -> DAP error -> success, emitting appropriate events', async () => {
      const childrenRefreshedSpy = sinon.spy();
      expandableVar.on('childrenRefreshed', childrenRefreshedSpy);
      const childrenFetchFailedSpy = sinon.spy();
      expandableVar.on('childrenFetchFailed', childrenFetchFailedSpy);

      mockSessionHandler.sendRequest
        .withArgs('variables', sinon.match.object) // General matcher for args in chained calls
        .onFirstCall()
        .resolves(childVarsResponse1)
        .withArgs('variables', sinon.match.object)
        .onSecondCall()
        .resolves(dapErrorResponseUndefined) // DAP error
        .withArgs('variables', sinon.match.object)
        .onThirdCall()
        .resolves(childVarsResponse2);

      // 1. First fetch (success)
      let children = await expandableVar.getChildren();
      expect(children).to.have.lengthOf(
        childVarsResponse1.body.variables.length,
      );
      expect(expandableVar.children).to.deep.equal(children);
      expect(childrenRefreshedSpy.calledOnceWith(children)).to.be.true;
      expect(childrenFetchFailedSpy.called).to.be.false;
      // @ts-expect-error Accessing private
      expect(expandableVar._lastChildrenError).to.be.undefined;

      childrenRefreshedSpy.resetHistory();
      childrenFetchFailedSpy.resetHistory();

      // 2. Second fetch (DAP error)
      children = await expandableVar.getChildren();
      expect(children).to.be.empty;
      expect(expandableVar.children).to.be.empty;
      expect(childrenRefreshedSpy.called).to.be.false;
      expect(childrenFetchFailedSpy.calledOnce).to.be.true;
      const [dapError] = childrenFetchFailedSpy.firstCall.args;
      expect(dapError).to.be.instanceOf(Error);
      expect(dapError.message).to.contain('Adapter returned no variables.');
      // @ts-expect-error Accessing private
      expect(expandableVar._lastChildrenError).to.equal(dapError);

      childrenRefreshedSpy.resetHistory();
      childrenFetchFailedSpy.resetHistory();

      // 3. Third fetch (success)
      children = await expandableVar.getChildren();
      expect(children).to.have.lengthOf(
        childVarsResponse2.body.variables.length,
      );
      expect(children[0].name).to.equal(
        childVarsResponse2.body.variables[0].name,
      );
      expect(expandableVar.children).to.deep.equal(children);
      expect(childrenRefreshedSpy.calledOnceWith(children)).to.be.true;
      expect(childrenFetchFailedSpy.called).to.be.false;
      // @ts-expect-error Accessing private
      expect(expandableVar._lastChildrenError).to.be.undefined;

      expect(mockSessionHandler.sendRequest.callCount).to.equal(3);
    });
  });

  describe('Edge Case DAP Responses for getChildren()', () => {
    let expandableVar: DebugVariable;
    const varRef = EXPANDABLE_RAW_VARIABLE_DATA.variablesReference;
    const expectedArgs = { variablesReference: varRef };

    // Define a base response for this specific describe block
    const baseEdgeCaseMockVariablesResponse: DebugProtocol.VariablesResponse = {
      request_seq: 1,
      seq: 1,
      success: true,
      command: 'variables',
      type: 'response',
      body: { variables: [] }, // Placeholder body
    };

    beforeEach(async () => {
      expandableVar = new DebugVariable(
        EXPANDABLE_RAW_VARIABLE_DATA,
        mockParentScope,
        mockSessionHandler,
        mockLogger,
      );
      // Pre-populate for tests that check clearing
      const initialFullResponse: DebugProtocol.VariablesResponse = {
        ...baseEdgeCaseMockVariablesResponse,
        body: {
          variables: [
            {
              name: 'pre-child',
              value: 'preVal',
              type: 'string',
              variablesReference: 0,
            },
          ],
        },
      };
      mockSessionHandler.sendRequest.resolves(initialFullResponse);
      await expandableVar.getChildren();
      mockSessionHandler.sendRequest.reset(); // Reset for the actual test call
      sinon.resetHistory(); // Reset all spies associated with the mock handler or variable
    });

    it('should handle response with empty variables array, emit "childrenRefreshed" with empty array', async () => {
      const childrenRefreshedSpy = sinon.spy();
      expandableVar.on('childrenRefreshed', childrenRefreshedSpy);
      const childrenFetchFailedSpy = sinon.spy();
      expandableVar.on('childrenFetchFailed', childrenFetchFailedSpy);

      const emptyVariablesFullResponse: DebugProtocol.VariablesResponse = {
        ...baseEdgeCaseMockVariablesResponse,
        body: { variables: [] },
      };
      mockSessionHandler.sendRequest
        .withArgs('variables', sinon.match(expectedArgs))
        .resolves(emptyVariablesFullResponse);

      const fetchedChildren = await expandableVar.getChildren();

      expect(fetchedChildren).to.be.an('array').that.is.empty;
      expect(expandableVar.children).to.be.an('array').that.is.empty;
      expect(childrenRefreshedSpy.calledOnceWith([])).to.be.true;
      expect(childrenFetchFailedSpy.called).to.be.false;
    });

    it('should handle response with null variables array, emit "childrenFetchFailed", and return empty array', async () => {
      const childrenRefreshedSpy = sinon.spy();
      expandableVar.on('childrenRefreshed', childrenRefreshedSpy);
      const childrenFetchFailedSpy = sinon.spy();
      expandableVar.on('childrenFetchFailed', childrenFetchFailedSpy);

      const nullVariablesFullResponse: DebugProtocol.VariablesResponse = {
        ...baseEdgeCaseMockVariablesResponse,
        body: { variables: null as unknown as DebugProtocol.Variable[] },
      };
      mockSessionHandler.sendRequest
        .withArgs('variables', sinon.match(expectedArgs))
        .resolves(nullVariablesFullResponse);

      const fetchedChildren = await expandableVar.getChildren();

      expect(fetchedChildren).to.be.an('array').that.is.empty;
      expect(expandableVar.children).to.be.an('array').that.is.empty; // Cleared on failure
      expect(childrenFetchFailedSpy.calledOnce).to.be.true;
      const [error] = childrenFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no variables.');
      expect(childrenRefreshedSpy.called).to.be.false;
    });

    it('should handle response with null body, emit "childrenFetchFailed", and return empty array', async () => {
      const childrenRefreshedSpy = sinon.spy();
      expandableVar.on('childrenRefreshed', childrenRefreshedSpy);
      const childrenFetchFailedSpy = sinon.spy();
      expandableVar.on('childrenFetchFailed', childrenFetchFailedSpy);

      const nullBodyFullResponse = {
        request_seq: baseEdgeCaseMockVariablesResponse.request_seq,
        seq: baseEdgeCaseMockVariablesResponse.seq,
        type: 'response' as const,
        command: baseEdgeCaseMockVariablesResponse.command,
        success: false,
        body: null,
        message: 'Null body',
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .withArgs('variables', sinon.match(expectedArgs))
        .resolves(nullBodyFullResponse);

      const fetchedChildren = await expandableVar.getChildren();

      expect(fetchedChildren).to.be.an('array').that.is.empty;
      expect(expandableVar.children).to.be.an('array').that.is.empty;
      expect(childrenFetchFailedSpy.calledOnce).to.be.true;
      const [error] = childrenFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no variables.');
      expect(childrenRefreshedSpy.called).to.be.false;
    });

    it('should handle response with empty body object, emit "childrenFetchFailed", and return empty array', async () => {
      const childrenRefreshedSpy = sinon.spy();
      expandableVar.on('childrenRefreshed', childrenRefreshedSpy);
      const childrenFetchFailedSpy = sinon.spy();
      expandableVar.on('childrenFetchFailed', childrenFetchFailedSpy);

      const emptyBodyFullResponse: DebugProtocol.VariablesResponse = {
        ...baseEdgeCaseMockVariablesResponse,
        body: {} as DebugProtocol.VariablesResponse['body'],
      };
      mockSessionHandler.sendRequest
        .withArgs('variables', sinon.match(expectedArgs))
        .resolves(emptyBodyFullResponse);

      const fetchedChildren = await expandableVar.getChildren();

      expect(fetchedChildren).to.be.an('array').that.is.empty;
      expect(expandableVar.children).to.be.an('array').that.is.empty;
      expect(childrenFetchFailedSpy.calledOnce).to.be.true;
      const [error] = childrenFetchFailedSpy.firstCall.args;
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Adapter returned no variables.');
      expect(childrenRefreshedSpy.called).to.be.false;
    });
  });

  describe('id property', () => {
    it('should generate a unique ID based on parent scope/variable and variable name/reference', () => {
      const id1 = variable.id;
      const parentScopeId = mockParentScope.id;
      expect(id1).to.equal(
        `var:${parentScopeId}:${RAW_VARIABLE_DATA.name}:${RAW_VARIABLE_DATA.variablesReference}`,
      );

      const otherRawVar: DebugProtocol.Variable = {
        name: 'anotherVar',
        value: '1',
        variablesReference: 0,
      };
      const otherVar = new DebugVariable(
        otherRawVar,
        mockParentScope,
        mockSessionHandler,
        mockLogger,
      );
      expect(otherVar.id).to.not.equal(id1);
      expect(otherVar.id).to.equal(`var:${parentScopeId}:anotherVar:0`);

      const parentVar = new DebugVariable(
        EXPANDABLE_RAW_VARIABLE_DATA,
        mockParentScope,
        mockSessionHandler,
        mockLogger,
      );
      const childOfVar = new DebugVariable(
        RAW_VARIABLE_DATA,
        parentVar,
        mockSessionHandler,
        mockLogger,
      );
      expect(childOfVar.id).to.equal(
        `var:${parentVar.id}:${RAW_VARIABLE_DATA.name}:${RAW_VARIABLE_DATA.variablesReference}`,
      );
    });
  });
});
