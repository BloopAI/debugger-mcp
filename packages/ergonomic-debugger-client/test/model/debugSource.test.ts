import { expect } from 'chai';
import * as sinon from 'sinon';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DebugSource } from '../../src/model/DebugSource';
import {
  MockDAPSessionHandler,
  createMockLogger,
} from './mocks/mockDAPSessionHandler';
import { LoggerInterface } from '../../src/logging';
import { DAPSessionHandlerInterface } from '../../src/model/model.types';

describe('DebugSource', () => {
  let mockSessionHandler: MockDAPSessionHandler;
  let mockLogger: LoggerInterface;
  let source: DebugSource;

  const RAW_SOURCE_DATA_PATH: DebugProtocol.Source = {
    name: 'test.ts',
    path: '/project/src/test.ts',
    sourceReference: 0,
    adapterData: 'adapter-specific-path-data',
  };

  const RAW_SOURCE_DATA_REF: DebugProtocol.Source = {
    name: 'runtimeGenerated.js',
    sourceReference: 1001,
    origin: 'JIT',
    adapterData: 'adapter-specific-ref-data',
  };

  beforeEach(() => {
    mockSessionHandler = new MockDAPSessionHandler();
    mockLogger = createMockLogger();
    source = new DebugSource(
      RAW_SOURCE_DATA_PATH,
      mockSessionHandler as DAPSessionHandlerInterface,
      mockLogger,
    );
  });

  afterEach(() => {
    sinon.restore();
    mockSessionHandler.reset();
  });

  describe('Constructor', () => {
    it('should initialize properties correctly from raw DAP Source data (with path)', () => {
      expect(source.name).to.equal(RAW_SOURCE_DATA_PATH.name);
      expect(source.path).to.equal(RAW_SOURCE_DATA_PATH.path);
      expect(source.sourceReference).to.equal(
        RAW_SOURCE_DATA_PATH.sourceReference,
      );
      expect(source.presentationHint).to.be.undefined;
      expect(source.origin).to.be.undefined;
      expect(source.adapterData).to.equal(RAW_SOURCE_DATA_PATH.adapterData);
    });

    it('should initialize properties correctly from raw DAP Source data (with sourceReference)', () => {
      const refSource = new DebugSource(
        RAW_SOURCE_DATA_REF,
        mockSessionHandler,
        mockLogger,
      );
      expect(refSource.name).to.equal(RAW_SOURCE_DATA_REF.name);
      expect(refSource.path).to.be.undefined;
      expect(refSource.sourceReference).to.equal(
        RAW_SOURCE_DATA_REF.sourceReference,
      );
      expect(refSource.origin).to.equal(RAW_SOURCE_DATA_REF.origin);
      expect(refSource.adapterData).to.equal(RAW_SOURCE_DATA_REF.adapterData);
    });

    it('should handle optional fields like presentationHint', () => {
      const dataWithHint: DebugProtocol.Source = {
        ...RAW_SOURCE_DATA_PATH,
        presentationHint: 'deemphasize',
      };
      const sourceWithHint = new DebugSource(
        dataWithHint,
        mockSessionHandler,
        mockLogger,
      );
      expect(sourceWithHint.presentationHint).to.equal('deemphasize');
    });
  });

  describe('getContent()', () => {
    // Define mockSourceResponse at the top of this describe block
    const mockSourceResponse: DebugProtocol.SourceResponse = {
      request_seq: 1,
      seq: 1,
      success: true,
      command: 'source',
      type: 'response',
      body: {
        content: 'console.log("Hello from source");',
        mimeType: 'text/javascript',
      },
    };

    it('should return a message and not fetch if sourceReference is 0 or undefined', async () => {
      expect(source.sourceReference).to.equal(0);
      const content = await source.getContent();
      expect(content).to.contain(
        'Content for /project/src/test.ts (reference: 0) is not available from adapter.',
      );
      expect(mockSessionHandler.sendRequest.called).to.be.false;
    });

    it('should fetch source content successfully if sourceReference > 0', async () => {
      const refSource = new DebugSource(
        RAW_SOURCE_DATA_REF,
        mockSessionHandler,
        mockLogger,
      );
      const expectedArgs: DebugProtocol.SourceArguments = {
        sourceReference: RAW_SOURCE_DATA_REF.sourceReference!,
      };
      mockSessionHandler.sendRequest
        .withArgs('source', {
          sourceReference: RAW_SOURCE_DATA_REF.sourceReference!,
        })
        .resolves(mockSourceResponse);

      const content = await refSource.getContent();

      expect(
        mockSessionHandler.sendRequest.calledOnceWith('source', expectedArgs),
      ).to.be.true;
      expect(content).to.equal(mockSourceResponse.body.content);
    });

    it('should re-throw DAP error (from undefined response) and notify for fetch failure when sourceReference > 0', async () => {
      const refSource = new DebugSource(
        RAW_SOURCE_DATA_REF,
        mockSessionHandler,
        mockLogger,
      );
      const errorResponseUndefined = {
        request_seq: mockSourceResponse.request_seq,
        seq: mockSourceResponse.seq,
        type: 'response' as const,
        command: mockSourceResponse.command,
        success: false,
        message: 'Simulated DAP error - undefined body',
        body: undefined,
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .withArgs('source', {
          sourceReference: RAW_SOURCE_DATA_REF.sourceReference!,
        })
        .resolves(errorResponseUndefined);

      let caughtError: Error | undefined;
      try {
        await refSource.getContent();
      } catch (e: unknown) {
        if (e instanceof Error) {
          caughtError = e;
        } else {
          caughtError = new Error(`Caught non-Error: ${String(e)}`);
        }
      }

      expect(caughtError).to.be.instanceOf(Error);
      const expectedErrorMessage = `Failed to retrieve source content for reference ${RAW_SOURCE_DATA_REF.sourceReference}. Adapter returned no content.`;
      expect(caughtError?.message).to.equal(expectedErrorMessage);

      expect(mockSessionHandler.notifyFetchError.calledOnce).to.be.true;
      const [payload] = mockSessionHandler.notifyFetchError.firstCall.args;
      expect(payload.resourceType).to.equal('sourceContent');
      expect(payload.resourceDetails).to.deep.equal({
        sourceReference: RAW_SOURCE_DATA_REF.sourceReference,
      });
      expect(payload.command).to.equal('source');
      expect(payload.message).to.equal(expectedErrorMessage);
    });

    it('should re-throw network/protocol error (from sendRequest reject) and notify for fetch failure when sourceReference > 0', async () => {
      const refSource = new DebugSource(
        RAW_SOURCE_DATA_REF,
        mockSessionHandler,
        mockLogger,
      );
      const networkError = new Error('Network issue');
      mockSessionHandler.sendRequest
        .withArgs('source', {
          sourceReference: RAW_SOURCE_DATA_REF.sourceReference!,
        })
        .rejects(networkError);

      let caughtError: Error | undefined;
      try {
        await refSource.getContent();
      } catch (e: unknown) {
        if (e instanceof Error) {
          caughtError = e;
        } else {
          caughtError = new Error(`Caught non-Error: ${String(e)}`);
        }
      }
      expect(caughtError).to.equal(networkError);

      expect(mockSessionHandler.notifyFetchError.calledOnce).to.be.true;
      const [payload] = mockSessionHandler.notifyFetchError.firstCall.args;
      expect(payload.resourceType).to.equal('sourceContent');
      expect(payload.resourceDetails).to.deep.equal({
        sourceReference: RAW_SOURCE_DATA_REF.sourceReference,
      });
      expect(payload.command).to.equal('source');
      expect(payload.message).to.equal(networkError.message);
    });

    it('should deduplicate concurrent getContent calls for the same sourceReference', async () => {
      const refSource = new DebugSource(
        RAW_SOURCE_DATA_REF,
        mockSessionHandler,
        mockLogger,
      );
      const delay = 50;

      mockSessionHandler.sendRequest.reset();
      const slowPromise = new Promise<DebugProtocol.SourceResponse>(
        (resolve) => {
          // Promise of full response
          setTimeout(() => resolve(mockSourceResponse), delay); // Use the common mockSourceResponse
        },
      );
      mockSessionHandler.sendRequest.returns(slowPromise);

      const promise1 = refSource.getContent();
      const promise2 = refSource.getContent();

      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true;

      const results = await Promise.all([promise1, promise2]);
      expect(results[0]).to.equal(mockSourceResponse.body.content); // Use the common mockSourceResponse
      expect(results[1]).to.equal(mockSourceResponse.body.content); // Use the common mockSourceResponse
      expect(mockSessionHandler.sendRequest.calledOnce).to.be.true;
    });
  });

  describe('Sequential Fetch Operations for getContent()', () => {
    let refSource: DebugSource;
    const sourceRef = RAW_SOURCE_DATA_REF.sourceReference!;
    // Define a base response for this specific describe block
    const baseSequentialMockResponse: DebugProtocol.SourceResponse = {
      request_seq: 1,
      seq: 1,
      success: true,
      command: 'source',
      type: 'response',
      body: { content: '', mimeType: 'text/plain' }, // Placeholder body
    };

    const successResponse1: DebugProtocol.SourceResponse = {
      ...baseSequentialMockResponse,
      body: { content: 'content1', mimeType: 'text/plain' },
    };
    const successResponse2: DebugProtocol.SourceResponse = {
      ...baseSequentialMockResponse,
      body: { content: 'content2', mimeType: 'text/plain' },
    };
    const errorResponseUndefined = {
      request_seq: baseSequentialMockResponse.request_seq,
      seq: baseSequentialMockResponse.seq,
      type: 'response' as const,
      command: baseSequentialMockResponse.command,
      success: false,
      body: undefined,
      message: 'DAP Error',
    } as DebugProtocol.Response;

    beforeEach(() => {
      refSource = new DebugSource(
        RAW_SOURCE_DATA_REF,
        mockSessionHandler,
        mockLogger,
      );
    });

    it('should handle getContent sequence: success -> DAP error -> success', async () => {
      mockSessionHandler.sendRequest
        .withArgs('source', { sourceReference: sourceRef })
        .onFirstCall()
        .resolves(successResponse1)
        .withArgs('source', { sourceReference: sourceRef })
        .onSecondCall()
        .resolves(errorResponseUndefined) // DAP error
        .withArgs('source', { sourceReference: sourceRef })
        .onThirdCall()
        .resolves(successResponse2);

      // 1. First fetch (success)
      let content = await refSource.getContent();
      expect(content).to.equal(successResponse1.body.content);

      // 2. Second fetch (DAP error) - should re-throw
      let dapError;
      try {
        await refSource.getContent();
      } catch (e) {
        dapError = e;
      }
      expect(dapError).to.be.instanceOf(Error);
      expect((dapError as Error).message).to.contain(
        `Adapter returned no content.`,
      );

      // 3. Third fetch (success)
      // Note: The previous error is not "cleared" from a property, as it's re-thrown.
      // A new fetch attempt will run _doFetchContent again.
      content = await refSource.getContent();
      expect(content).to.equal(successResponse2.body.content);

      expect(mockSessionHandler.sendRequest.callCount).to.equal(3);
    });
  });

  describe('Edge Case DAP Responses for getContent()', () => {
    let refSource: DebugSource;
    const sourceRef = RAW_SOURCE_DATA_REF.sourceReference!;
    const expectedArgs = { sourceReference: sourceRef };

    // Define a base response for this specific describe block
    const baseEdgeCaseMockResponse: DebugProtocol.SourceResponse = {
      request_seq: 1,
      seq: 1,
      success: true,
      command: 'source',
      type: 'response',
      body: { content: '', mimeType: 'text/plain' }, // Placeholder body
    };

    beforeEach(async () => {
      refSource = new DebugSource(
        RAW_SOURCE_DATA_REF,
        mockSessionHandler,
        mockLogger,
      );
      // Potentially pre-populate for tests that check clearing, though getContent doesn't store content internally
      // For now, just ensure spies are reset.
      sinon.resetHistory();
    });

    it('should handle response with empty string content successfully', async () => {
      const emptyContentFullResponse: DebugProtocol.SourceResponse = {
        ...baseEdgeCaseMockResponse,
        body: { content: '', mimeType: 'text/plain' },
      };
      mockSessionHandler.sendRequest
        .withArgs('source', sinon.match(expectedArgs))
        .resolves(emptyContentFullResponse);

      const fetchedContent = await refSource.getContent();
      expect(fetchedContent).to.equal('');
      expect(mockSessionHandler.notifyFetchError.called).to.be.false;
    });

    it('should handle response with null content, re-throw and notify', async () => {
      const nullContentFullResponse: DebugProtocol.SourceResponse = {
        ...baseEdgeCaseMockResponse,
        body: { content: null as unknown as string, mimeType: 'text/plain' },
      };
      mockSessionHandler.sendRequest
        .withArgs('source', sinon.match(expectedArgs))
        .resolves(nullContentFullResponse);

      let caughtError;
      try {
        await refSource.getContent();
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).to.be.instanceOf(Error);
      // This case (null content in an otherwise valid body) results in "Adapter returned no content."
      expect((caughtError as Error).message).to.contain(
        `Adapter returned no content.`,
      );
      expect(mockSessionHandler.notifyFetchError.calledOnce).to.be.true;
    });

    it('should handle response with null body, re-throw and notify', async () => {
      const nullBodyFullResponse = {
        request_seq: baseEdgeCaseMockResponse.request_seq,
        seq: baseEdgeCaseMockResponse.seq,
        type: 'response' as const,
        command: baseEdgeCaseMockResponse.command,
        success: false,
        body: null,
        message: 'Null body',
      } as DebugProtocol.Response;
      mockSessionHandler.sendRequest
        .withArgs('source', sinon.match(expectedArgs))
        .resolves(nullBodyFullResponse);
      let caughtError;
      try {
        await refSource.getContent();
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).to.be.instanceOf(Error);
      expect((caughtError as Error).message).to.contain(
        'Adapter returned no content.',
      );
      expect(mockSessionHandler.notifyFetchError.calledOnce).to.be.true;
    });

    it('should handle response with empty body object, re-throw and notify', async () => {
      const emptyBodyFullResponse: DebugProtocol.SourceResponse = {
        ...baseEdgeCaseMockResponse,
        body: {} as DebugProtocol.SourceResponse['body'],
      };
      mockSessionHandler.sendRequest
        .withArgs('source', sinon.match(expectedArgs))
        .resolves(emptyBodyFullResponse);
      let caughtError;
      try {
        await refSource.getContent();
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).to.be.instanceOf(Error);
      // This case (empty body object) also results in "Adapter returned no content."
      // because response.content will be undefined.
      expect((caughtError as Error).message).to.contain(
        `Adapter returned no content.`,
      );
      expect(mockSessionHandler.notifyFetchError.calledOnce).to.be.true;
    });
  });

  describe('id property', () => {
    it('should generate ID using sourceReference if valid (>0)', () => {
      const refSource = new DebugSource(
        {
          sourceReference: 12345,
          name: 'runtime.js',
          path: '/path/ignored.js',
        },
        mockSessionHandler,
        mockLogger,
      );
      expect(refSource.id).to.equal('ref:12345');
    });

    it('should generate ID using path if sourceReference is not valid and path exists', () => {
      const pathSource = new DebugSource(
        { path: '/my/file.ts', name: 'file.ts', sourceReference: 0 },
        mockSessionHandler,
        mockLogger,
      );
      expect(pathSource.id).to.equal('path:/my/file.ts');
      const pathSourceNoRef = new DebugSource(
        { path: '/my/file.ts', name: 'file.ts' },
        mockSessionHandler,
        mockLogger,
      );
      expect(pathSourceNoRef.id).to.equal('path:/my/file.ts');
    });

    it('should generate ID using name if sourceReference is not valid and path does not exist', () => {
      const nameOnlySource = new DebugSource(
        { name: 'anonymous.js', sourceReference: 0 },
        mockSessionHandler,
        mockLogger,
      );
      expect(nameOnlySource.id).to.equal('name:anonymous.js');
      const nameOnlyNoRef = new DebugSource(
        { name: 'anonymous.js' },
        mockSessionHandler,
        mockLogger,
      );
      expect(nameOnlyNoRef.id).to.equal('name:anonymous.js');
    });

    it('should generate a fallback ID if no other identifiers are present', () => {
      const emptySource = new DebugSource(
        {} as DebugProtocol.Source,
        mockSessionHandler,
        mockLogger,
      );
      expect(emptySource.id).to.match(/^unknownSource:\d+$/);
    });
  });
});
