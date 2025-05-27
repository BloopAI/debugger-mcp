import { expect } from 'chai';
import * as sinon from 'sinon';
import {
  DAPSessionHandler,
  DAPSessionHandlerEvents as _DAPSessionHandlerEvents,
} from '../src/dapSessionHandler';
import { DAPProtocolClient } from '../src/dapProtocolClient';
import { LoggerInterface } from '../src/logging';
import { DebugProtocol } from '@vscode/debugprotocol';
import { EventEmitter } from 'events';

// Simple mock logger for tests
const mockLogger: LoggerInterface = {
  trace: (...args: unknown[]) => console.log('[TestLogger TRACE]', ...args),
  debug: (...args: unknown[]) => console.log('[TestLogger DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[TestLogger INFO]', ...args),
  warn: (...args: unknown[]) => console.warn('[TestLogger WARN]', ...args),
  error: (...args: unknown[]) => console.error('[TestLogger ERROR]', ...args),
  child: () => mockLogger,
};

// Helper function to wait for specific events
function _waitForEvent<T>(
  emitter: EventEmitter,
  eventName: string,
  timeout: number = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(eventName, listener);
      reject(
        new Error(
          `Timeout waiting for event ${eventName} after ${timeout}ms in dapSessionHandler.test.ts`,
        ),
      );
    }, timeout);
    const listener = (data: T) => {
      clearTimeout(timer);
      emitter.removeListener(eventName, listener);
      resolve(data);
    };
    emitter.on(eventName, listener);
  });
}

class MockDAPProtocolClient extends EventEmitter {
  public sendRequest: sinon.SinonStub<
    [string, unknown?, number?],
    Promise<DebugProtocol.Response>
  >;
  public dispose: sinon.SinonStub<[], void>;
  public isConnected: sinon.SinonStub<[], boolean>;

  constructor() {
    super();
    this.sendRequest = sinon.stub();
    this.dispose = sinon.stub();
    this.isConnected = sinon.stub<[], boolean>().returns(true);
  }

  public simulateAdapterEvent(eventName: string, ...args: unknown[]) {
    this.emit(eventName, ...args);
  }

  public _receiveResponse(_response: DebugProtocol.Response) {
    // This would typically be handled by sendRequest's promise resolution.
  }
}

describe('DAPSessionHandler', () => {
  let dapSessionHandler: DAPSessionHandler;
  let mockProtocolClient: MockDAPProtocolClient;

  beforeEach(() => {
    mockProtocolClient = new MockDAPProtocolClient();
    dapSessionHandler = new DAPSessionHandler(
      mockProtocolClient as unknown as DAPProtocolClient,
      mockLogger,
    );
  });

  afterEach(() => {
    mockProtocolClient.sendRequest.resetHistory();
    dapSessionHandler.removeAllListeners();
  });

  describe('Session Lifecycle', () => {
    it('should initialize, emit sessionStarted and capabilitiesUpdated', async function () {
      this.timeout(10000);
      const mockCapabilities: DebugProtocol.Capabilities = {
        supportsConfigurationDoneRequest: true,
        supportsSetVariable: true,
      };
      mockProtocolClient.sendRequest
        .withArgs('initialize', sinon.match.any)
        .resolves({
          request_seq: 1,
          seq: 1,
          success: true,
          command: 'initialize',
          type: 'response',
          body: mockCapabilities,
        } as DebugProtocol.InitializeResponse);

      mockProtocolClient.sendRequest
        .withArgs('configurationDone', undefined)
        .resolves({
          request_seq: 2,
          seq: 2,
          success: true,
          command: 'configurationDone',
          type: 'response',
        } as DebugProtocol.ConfigurationDoneResponse);

      let sessionStartedArgs: DebugProtocol.Capabilities | undefined;
      let capabilitiesUpdatedArgs: DebugProtocol.Capabilities | undefined;
      let adapterConfigured = false;

      dapSessionHandler.on('sessionStarted', (payload) => {
        sessionStartedArgs = payload.capabilities;
      });
      dapSessionHandler.on('capabilitiesUpdated', (payload) => {
        capabilitiesUpdatedArgs = payload.capabilities;
      });
      const adapterConfiguredPromise = new Promise<void>((resolve) => {
        dapSessionHandler.once('adapterInitializedAndConfigured', () => {
          adapterConfigured = true;
          resolve();
        });
      });

      const initializeArgs: DebugProtocol.InitializeRequestArguments = {
        adapterID: 'mock',
      };
      // Call initialize but don't await its promise yet
      const resultCapsPromise = dapSessionHandler.initialize(initializeArgs);

      // Simulate the event immediately after calling initialize, before awaiting its promise
      mockProtocolClient.simulateAdapterEvent('initialized', {
        event: 'initialized',
        seq: 100,
        type: 'event',
      } as DebugProtocol.InitializedEvent);

      // Now await the promise from initialize()
      const resultCaps = await resultCapsPromise;

      // And then await the promise that confirms our event listener ran
      await adapterConfiguredPromise;

      expect(resultCaps).to.deep.equal(mockCapabilities);
      expect(sessionStartedArgs).to.deep.equal(mockCapabilities);
      expect(capabilitiesUpdatedArgs).to.deep.equal(mockCapabilities);
      expect(dapSessionHandler.status).to.equal('initialized');
      expect(adapterConfigured).to.be.true;
      expect(dapSessionHandler.capabilities).to.deep.equal(mockCapabilities);
      expect(
        mockProtocolClient.sendRequest.calledOnceWith(
          'initialize',
          initializeArgs,
        ),
      ).to.be.true;
    });

    it('should handle initialize failure (DAP error) and emit sessionEnded', async () => {
      const dapErrorResponse: DebugProtocol.ErrorResponse = {
        request_seq: 1,
        seq: 1,
        success: false,
        command: 'initialize',
        type: 'response',
        message: 'Initialization failed by adapter',
        body: {
          /* error: undefined */
        },
      };
      mockProtocolClient.sendRequest
        .withArgs('initialize', sinon.match.any)
        .resolves(dapErrorResponse);

      let sessionEndedReason: string | undefined;
      dapSessionHandler.on('sessionEnded', (payload) => {
        sessionEndedReason = payload.reason;
      });
      let emittedDAPErrorPayload:
        | { sessionId: string; error: Error }
        | undefined;
      dapSessionHandler.on('error', (payload) => {
        emittedDAPErrorPayload = payload;
      });

      const initializeArgs: DebugProtocol.InitializeRequestArguments = {
        adapterID: 'mock',
      };
      try {
        await dapSessionHandler.initialize(initializeArgs);
      } catch {
        // Network errors would be caught here.
      }

      expect(emittedDAPErrorPayload).to.exist;
      expect(emittedDAPErrorPayload?.error.message).to.equal(
        'Initialization failed by adapter',
      );
      expect(emittedDAPErrorPayload?.sessionId).to.equal(
        dapSessionHandler.sessionId,
      );

      expect(sessionEndedReason).to.exist;
      expect(sessionEndedReason).to.equal(
        'initializationFailed: Initialization failed by adapter',
      );
      expect(dapSessionHandler.status).to.equal('terminated');
      expect(dapSessionHandler.capabilities).to.deep.equal({});
    });

    it('should handle launch failure (DAP error) and emit sessionEnded', async function () {
      this.timeout(10000);
      // First, successful initialize
      const mockInitCaps: DebugProtocol.Capabilities = {
        supportsConfigurationDoneRequest: true,
      };
      mockProtocolClient.sendRequest.withArgs('initialize').resolves({
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'initialize',
        type: 'response',
        body: mockInitCaps,
      } as DebugProtocol.InitializeResponse);

      // Add a stub for configurationDone for this test as well, as it's part of the initialization flow
      mockProtocolClient.sendRequest
        .withArgs('configurationDone', undefined)
        .resolves({
          request_seq: 2,
          seq: 2,
          success: true,
          command: 'configurationDone',
          type: 'response',
        } as DebugProtocol.ConfigurationDoneResponse);

      let adapterConfiguredInLaunchFailureTest = false;
      const adapterConfiguredPromiseLaunchFailure = new Promise<void>(
        (resolve) => {
          dapSessionHandler.once('adapterInitializedAndConfigured', () => {
            adapterConfiguredInLaunchFailureTest = true;
            resolve();
          });
        },
      );

      const initializePromise = dapSessionHandler.initialize({
        adapterID: 'mock',
      });
      // Simulate the event immediately after calling initialize
      mockProtocolClient.simulateAdapterEvent('initialized', {
        event: 'initialized',
        seq: 101,
        type: 'event',
      } as DebugProtocol.InitializedEvent);

      // Now await the promise from initialize()
      await initializePromise;

      // And then await the promise that confirms our event listener ran
      await adapterConfiguredPromiseLaunchFailure;

      expect(dapSessionHandler.status).to.equal('initialized');
      expect(adapterConfiguredInLaunchFailureTest).to.be.true;

      // Then, launch fails
      const dapErrorResponse: DebugProtocol.ErrorResponse = {
        request_seq: 2,
        seq: 2,
        success: false,
        command: 'launch',
        type: 'response',
        message: 'Launch failed by adapter',
        body: {},
      };
      mockProtocolClient.sendRequest
        .withArgs('launch')
        .resolves(dapErrorResponse);

      let sessionEndedReason: string | undefined;
      dapSessionHandler.on('sessionEnded', (payload) => {
        sessionEndedReason = payload.reason;
      });
      let emittedDAPErrorPayload:
        | { sessionId: string; error: Error }
        | undefined;
      dapSessionHandler.on('error', (payload) => {
        emittedDAPErrorPayload = payload;
      });

      const launchArgs: DebugProtocol.LaunchRequestArguments = {};
      try {
        await dapSessionHandler.launch(launchArgs);
      } catch {
        // Network errors would be caught here.
      }

      expect(emittedDAPErrorPayload).to.exist;
      expect(emittedDAPErrorPayload?.error.message).to.equal(
        'Launch failed by adapter',
      );
      expect(emittedDAPErrorPayload?.sessionId).to.equal(
        dapSessionHandler.sessionId,
      );

      expect(sessionEndedReason).to.equal(
        'launchFailed: Launch failed by adapter',
      );
      expect(dapSessionHandler.status).to.equal('terminated');
    });

    it('should transition to active on successful launch', async () => {
      // First, initialize
      const mockInitCaps: DebugProtocol.Capabilities = {
        supportsConfigurationDoneRequest: true,
      };
      mockProtocolClient.sendRequest.withArgs('initialize').resolves({
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'initialize',
        type: 'response',
        body: mockInitCaps,
      } as DebugProtocol.InitializeResponse);
      await dapSessionHandler.initialize({ adapterID: 'mock' });

      // Then, launch
      mockProtocolClient.sendRequest.withArgs('launch').resolves({
        request_seq: 2,
        seq: 2,
        success: true,
        command: 'launch',
        type: 'response',
      } as DebugProtocol.LaunchResponse);

      const launchArgs: DebugProtocol.LaunchRequestArguments = {};
      await dapSessionHandler.launch(launchArgs);

      expect(dapSessionHandler.status).to.equal('active');
      expect(mockProtocolClient.sendRequest.calledWith('launch', launchArgs)).to
        .be.true;
    });

    it('should emit sessionEnded when "terminated" event is received from protocol client', (done) => {
      dapSessionHandler.on('sessionEnded', (payload) => {
        expect(payload.reason).to.equal('terminatedByAdapter');
        expect(dapSessionHandler.status).to.equal('terminated');
        done();
      });

      mockProtocolClient.simulateAdapterEvent('terminated', {
        event: 'terminated',
        seq: 1,
        type: 'event',
        body: { restart: false },
      } as DebugProtocol.TerminatedEvent);
    });

    it('should handle disconnect correctly and emit sessionEnded', async () => {
      // Initial state: active (after initialize and launch/attach)
      mockProtocolClient.sendRequest.withArgs('initialize').resolves({
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'initialize',
        type: 'response',
        body: { supportsConfigurationDoneRequest: true },
      } as DebugProtocol.InitializeResponse);
      await dapSessionHandler.initialize({ adapterID: 'mock' });

      mockProtocolClient.sendRequest.withArgs('launch').resolves({
        request_seq: 2,
        seq: 2,
        success: true,
        command: 'launch',
        type: 'response',
      } as DebugProtocol.LaunchResponse);
      await dapSessionHandler.launch({});
      expect(dapSessionHandler.status).to.equal('active');

      // Setup for disconnect
      mockProtocolClient.sendRequest.withArgs('disconnect').resolves({
        request_seq: 3,
        seq: 3,
        success: true,
        command: 'disconnect',
        type: 'response',
      } as DebugProtocol.DisconnectResponse);

      const sessionEndedPromise = new Promise<{ reason?: string }>(
        (resolve, reject) => {
          dapSessionHandler.once('sessionEnded', (payload) => {
            resolve({ reason: payload.reason });
          });
          setTimeout(
            () =>
              reject(
                new Error(
                  'Timeout waiting for sessionEnded event in disconnect test',
                ),
              ),
            1900,
          );
        },
      );

      await dapSessionHandler.disconnect();
      expect(dapSessionHandler.status).to.equal('terminating');

      mockProtocolClient.simulateAdapterEvent('terminated', {
        event: 'terminated',
        seq: 100,
        type: 'event',
        body: { restart: false },
      } as DebugProtocol.TerminatedEvent);

      const endPayload = await sessionEndedPromise;

      expect(endPayload.reason).to.equal('terminatedByAdapter');
      expect(dapSessionHandler.status).to.equal('terminated');
    });

    it('should handle disconnect failure (DAP error) and still emit sessionEnded', async () => {
      // Setup: initialize and launch successfully
      mockProtocolClient.sendRequest.withArgs('initialize').resolves({
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'initialize',
        type: 'response',
        body: { supportsConfigurationDoneRequest: true },
      } as DebugProtocol.InitializeResponse);
      await dapSessionHandler.initialize({ adapterID: 'mock' });
      mockProtocolClient.sendRequest.withArgs('launch').resolves({
        request_seq: 2,
        seq: 2,
        success: true,
        command: 'launch',
        type: 'response',
      } as DebugProtocol.LaunchResponse);
      await dapSessionHandler.launch({});
      expect(dapSessionHandler.status).to.equal('active');

      // Mock disconnect to fail with a DAP error
      const dapErrorResponse: DebugProtocol.ErrorResponse = {
        request_seq: 3,
        seq: 3,
        success: false,
        command: 'disconnect',
        type: 'response',
        message: 'Disconnect rejected by adapter',
        body: {},
      };
      mockProtocolClient.sendRequest
        .withArgs('disconnect')
        .resolves(dapErrorResponse);

      let sessionEndedReason: string | undefined;
      dapSessionHandler.on('sessionEnded', (payload) => {
        sessionEndedReason = payload.reason;
      });
      let emittedDAPErrorPayload:
        | { sessionId: string; error: Error }
        | undefined;
      dapSessionHandler.on('error', (payload) => {
        emittedDAPErrorPayload = payload;
      });

      try {
        await dapSessionHandler.disconnect();
      } catch {
        // No throw expected from disconnect() itself for DAP errors.
      }

      expect(emittedDAPErrorPayload).to.exist;
      expect(emittedDAPErrorPayload?.error.message).to.equal(
        'Disconnect rejected by adapter',
      );
      expect(emittedDAPErrorPayload?.sessionId).to.equal(
        dapSessionHandler.sessionId,
      );

      expect(sessionEndedReason).to.equal(
        'disconnectRequestFailed: Disconnect rejected by adapter',
      );
      expect(dapSessionHandler.status).to.equal('terminated');
    });

    it('should handle being called multiple times gracefully', async () => {
      // Setup: initialize and launch successfully
      mockProtocolClient.sendRequest.withArgs('initialize').resolves({
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'initialize',
        type: 'response',
        body: { supportsConfigurationDoneRequest: true },
      } as DebugProtocol.InitializeResponse);
      await dapSessionHandler.initialize({ adapterID: 'mock' });
      mockProtocolClient.sendRequest.withArgs('launch').resolves({
        request_seq: 2,
        seq: 2,
        success: true,
        command: 'launch',
        type: 'response',
      } as DebugProtocol.LaunchResponse);
      await dapSessionHandler.launch({});
      expect(dapSessionHandler.status).to.equal('active');

      // Mock disconnect to succeed
      mockProtocolClient.sendRequest.withArgs('disconnect').resolves({
        request_seq: 3,
        seq: 3,
        success: true,
        command: 'disconnect',
        type: 'response',
      } as DebugProtocol.DisconnectResponse);

      const sessionEndedSpy = sinon.spy();
      dapSessionHandler.on('sessionEnded', sessionEndedSpy);

      await dapSessionHandler.disconnect(); // First call
      expect(dapSessionHandler.status).to.equal('terminating');

      // Simulate terminated event from adapter
      mockProtocolClient.simulateAdapterEvent('terminated', {
        event: 'terminated',
        seq: 100,
        type: 'event',
        body: { restart: false },
      } as DebugProtocol.TerminatedEvent);
      expect(sessionEndedSpy.calledOnce).to.be.true; // Should have ended once
      expect(dapSessionHandler.status).to.equal('terminated');

      // Call disconnect again
      await dapSessionHandler.disconnect();
      expect(dapSessionHandler.status).to.equal('terminated'); // Status should remain terminated
      expect(sessionEndedSpy.calledOnce).to.be.true; // sessionEnded should not be emitted again

      // Call disconnect a third time
      await dapSessionHandler.disconnect();
      expect(dapSessionHandler.status).to.equal('terminated');
      expect(sessionEndedSpy.calledOnce).to.be.true;
    });

    it('should emit sessionEnded with "adapterProcessExited" when "exited" event is received from protocol client while active', (done) => {
      // Setup: initialize and launch successfully
      Promise.resolve()
        .then(async () => {
          mockProtocolClient.sendRequest.withArgs('initialize').resolves({
            request_seq: 1,
            seq: 1,
            success: true,
            command: 'initialize',
            type: 'response',
            body: { supportsConfigurationDoneRequest: true },
          });
          await dapSessionHandler.initialize({ adapterID: 'mock' });
          mockProtocolClient.sendRequest.withArgs('launch').resolves({
            request_seq: 2,
            seq: 2,
            success: true,
            command: 'launch',
            type: 'response',
          });
          await dapSessionHandler.launch({});
          expect(dapSessionHandler.status).to.equal('active');

          dapSessionHandler.on('sessionEnded', (payload) => {
            expect(payload.reason).to.equal(
              'adapterProcessExited Unexpectedly (Code: 123)',
            );
            expect(dapSessionHandler.status).to.equal('terminated');
            done();
          });
          mockProtocolClient.simulateAdapterEvent('exited', {
            event: 'exited',
            seq: 1,
            type: 'event',
            body: { exitCode: 123 },
          } as DebugProtocol.ExitedEvent);
        })
        .catch(done);
    });

    it('should emit sessionEnded with "protocolClientClosed" when "close" event is received from protocol client while active', (done) => {
      Promise.resolve()
        .then(async () => {
          mockProtocolClient.sendRequest.withArgs('initialize').resolves({
            request_seq: 1,
            seq: 1,
            success: true,
            command: 'initialize',
            type: 'response',
            body: { supportsConfigurationDoneRequest: true },
          });
          await dapSessionHandler.initialize({ adapterID: 'mock' });
          mockProtocolClient.sendRequest.withArgs('launch').resolves({
            request_seq: 2,
            seq: 2,
            success: true,
            command: 'launch',
            type: 'response',
          });
          await dapSessionHandler.launch({});
          expect(dapSessionHandler.status).to.equal('active');

          dapSessionHandler.on('sessionEnded', (payload) => {
            expect(payload.reason).to.equal('protocolClientClosed');
            expect(dapSessionHandler.status).to.equal('terminated');
            done();
          });
          mockProtocolClient.simulateAdapterEvent('close');
        })
        .catch(done);
    });

    it('should emit sessionEnded with "protocolClientError" when "error" event is received from protocol client while active', (done) => {
      Promise.resolve()
        .then(async () => {
          mockProtocolClient.sendRequest.withArgs('initialize').resolves({
            request_seq: 1,
            seq: 1,
            success: true,
            command: 'initialize',
            type: 'response',
            body: { supportsConfigurationDoneRequest: true },
          });
          await dapSessionHandler.initialize({ adapterID: 'mock' });
          mockProtocolClient.sendRequest.withArgs('launch').resolves({
            request_seq: 2,
            seq: 2,
            success: true,
            command: 'launch',
            type: 'response',
          });
          await dapSessionHandler.launch({});
          expect(dapSessionHandler.status).to.equal('active');

          const testErrorMessage = 'Low level socket error';
          dapSessionHandler.on('sessionEnded', (payload) => {
            expect(payload.reason).to.equal(
              `protocolClientError: ${testErrorMessage}`,
            );
            expect(dapSessionHandler.status).to.equal('terminated');
            done();
          });
          let emittedErrorPayload:
            | { sessionId: string; error: Error }
            | undefined;
          dapSessionHandler.on('error', (payload) => {
            emittedErrorPayload = payload;
          });

          mockProtocolClient.simulateAdapterEvent(
            'error',
            new Error(testErrorMessage),
          );
          expect(emittedErrorPayload).to.exist;
          expect(emittedErrorPayload?.error.message).to.equal(testErrorMessage);
          expect(emittedErrorPayload?.sessionId).to.equal(
            dapSessionHandler.sessionId,
          );
        })
        .catch(done);
    });
  });

  describe('Basic Operations', () => {
    beforeEach(async () => {
      // Ensure session is initialized and active for these tests
      // Using a known valid capability. Others like supportsSetBreakpointsRequest are not standard.
      const mockInitCaps: DebugProtocol.Capabilities = {
        supportsConfigurationDoneRequest: true,
        supportsBreakpointLocationsRequest: true,
      };
      mockProtocolClient.sendRequest.withArgs('initialize').resolves({
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'initialize',
        type: 'response',
        body: mockInitCaps,
      } as DebugProtocol.InitializeResponse);
      await dapSessionHandler.initialize({ adapterID: 'mock' });

      mockProtocolClient.sendRequest.withArgs('launch').resolves({
        request_seq: 2,
        seq: 2,
        success: true,
        command: 'launch',
        type: 'response',
      } as DebugProtocol.LaunchResponse);
      await dapSessionHandler.launch({}); // Using empty launchArgs
      expect(dapSessionHandler.status).to.equal('active');
    });

    it('should send setBreakpoints request and return response', async () => {
      const breakpointsArgs: DebugProtocol.SetBreakpointsArguments = {
        source: { path: 'test/data/test.md' },
        breakpoints: [{ line: 3 }],
      };
      const mockBpResponse: DebugProtocol.SetBreakpointsResponse = {
        request_seq: 3,
        seq: 3,
        success: true,
        command: 'setBreakpoints',
        type: 'response',
        body: {
          breakpoints: [{ verified: true, line: 3 }],
        },
      };
      mockProtocolClient.sendRequest
        .withArgs('setBreakpoints', breakpointsArgs)
        .resolves(mockBpResponse);

      const response = await dapSessionHandler.setBreakpoints(breakpointsArgs);
      expect(response).to.deep.equal(mockBpResponse);
      expect(
        mockProtocolClient.sendRequest.calledWith(
          'setBreakpoints',
          breakpointsArgs,
        ),
      ).to.equal(true);
    });

    it('should send evaluate request and return response', async () => {
      const evaluateArgs: DebugProtocol.EvaluateArguments = {
        expression: '1+1',
      };
      const mockEvalResponse: DebugProtocol.EvaluateResponse = {
        request_seq: 4,
        seq: 4,
        success: true,
        command: 'evaluate',
        type: 'response',
        body: { result: '2', variablesReference: 0 },
      };
      mockProtocolClient.sendRequest
        .withArgs('evaluate', evaluateArgs)
        .resolves(mockEvalResponse);

      const response = await dapSessionHandler.evaluate(evaluateArgs);
      expect(response).to.deep.equal(mockEvalResponse);
      expect(
        mockProtocolClient.sendRequest.calledWith('evaluate', evaluateArgs),
      ).to.be.true;
    });
  });

  describe('Event Passthrough', () => {
    it('should emit "output" event when DAPProtocolClient emits "output"', (done) => {
      const outputPayload: DebugProtocol.OutputEvent['body'] = {
        category: 'console',
        output: 'Hello from adapter\n',
      };
      dapSessionHandler.on('output', (payload) => {
        expect(payload.category).to.equal(outputPayload.category);
        expect(payload.output).to.equal(outputPayload.output);
        expect(payload.data).to.be.undefined;
        expect(payload.sessionId).to.equal(dapSessionHandler.sessionId);
        done();
      });
      // Simulate DAPProtocolClient itself emitting an 'output' event
      mockProtocolClient.simulateAdapterEvent('output', {
        event: 'output',
        seq: 1,
        type: 'event',
        body: outputPayload,
      } as DebugProtocol.OutputEvent);
    });
  });

  describe('Error Handling', () => {
    it('should emit "error" event and handle DAP error response for a request', async () => {
      // Initialize session
      mockProtocolClient.sendRequest.withArgs('initialize').resolves({
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'initialize',
        type: 'response',
        body: { supportsConfigurationDoneRequest: true },
      } as DebugProtocol.InitializeResponse);
      await dapSessionHandler.initialize({ adapterID: 'mock' });

      // Launch the session to make it 'active'
      mockProtocolClient.sendRequest.withArgs('launch').resolves({
        request_seq: 10, // Different seq for clarity
        seq: 10,
        success: true,
        command: 'launch',
        type: 'response',
      } as DebugProtocol.LaunchResponse);
      await dapSessionHandler.launch({}); // Empty launch args
      expect(dapSessionHandler.status).to.equal('active');

      const _badCommand = 'evaluate'; // We are testing 'evaluate' specifically to trigger DAP error
      const dapErrorResponse: DebugProtocol.ErrorResponse = {
        request_seq: 2,
        seq: 2,
        success: false,
        command: 'evaluate', // Command should be 'evaluate' as that's what we're calling
        type: 'response',
        message: 'Command not recognized', // This is the DAP error message from the adapter
        body: {
          error: {
            id: 1000, // Example error ID
            format: 'Error: {message}', // This format string is from the adapter
            variables: { message: 'Command not recognized' }, // Variables for the format string
          },
        },
      };
      const evaluateArgs: DebugProtocol.EvaluateArguments = {
        expression: 'triggerDAPError',
      };
      // Configure sendRequest for this specific 'evaluate' call to return the DAP error
      mockProtocolClient.sendRequest
        .withArgs('evaluate', evaluateArgs)
        .resolves(dapErrorResponse);

      let emittedErrorPayload: { sessionId: string; error: Error } | undefined;
      dapSessionHandler.on('error', (payload) => {
        emittedErrorPayload = payload;
      });

      // Call evaluate. It will internally use DAPRequestBuilder.
      const response = await dapSessionHandler.evaluate(evaluateArgs);

      // Check that the response from evaluate indicates failure, as per the mocked DAP error.
      expect(response.success).to.be.false;
      expect(response.message).to.equal('Command not recognized');

      // Check that the 'error' event was emitted by DAPRequestBuilder (via DAPSessionHandler)
      expect(emittedErrorPayload).to.exist;
      if (emittedErrorPayload) {
        // DAPRequestBuilder emits new Error(dapErrorMessage), where dapErrorMessage is response.message
        expect(emittedErrorPayload.error.message).to.equal(
          'Command not recognized',
        );
        expect(emittedErrorPayload.sessionId).to.equal(
          dapSessionHandler.sessionId,
        );
      }
      // Session should remain active as per default DAPRequestBuilder options for non-terminating errors.
      expect(dapSessionHandler.status).to.equal('active');
    });

    it('should emit "error" and re-throw for network/protocol error during a request', async () => {
      // Ensure session is active for this test.
      mockProtocolClient.sendRequest.withArgs('initialize').resolves({
        request_seq: 1,
        seq: 1,
        success: true,
        command: 'initialize',
        type: 'response',
        body: { supportsConfigurationDoneRequest: true },
      } as DebugProtocol.InitializeResponse);
      await dapSessionHandler.initialize({ adapterID: 'mock' });
      mockProtocolClient.sendRequest.withArgs('launch').resolves({
        request_seq: 10,
        seq: 10,
        success: true,
        command: 'launch',
        type: 'response',
      } as DebugProtocol.LaunchResponse);
      await dapSessionHandler.launch({});
      expect(dapSessionHandler.status).to.equal('active');

      const networkError = new Error('Network connection lost');
      const breakpointsArgs: DebugProtocol.SetBreakpointsArguments = {
        source: { path: 'test/data/test.md' },
        breakpoints: [{ line: 3 }],
      };
      // Configure sendRequest to reject, simulating a network/protocol error
      mockProtocolClient.sendRequest
        .withArgs('setBreakpoints', breakpointsArgs)
        .rejects(networkError);

      let emittedErrorPayload: { sessionId: string; error: Error } | undefined;
      dapSessionHandler.on('error', (payload) => {
        emittedErrorPayload = payload;
      });

      let caughtError: Error | undefined;
      try {
        await dapSessionHandler.setBreakpoints(breakpointsArgs);
        expect.fail(
          'setBreakpoints should have thrown an error for network failure',
        );
      } catch (e: unknown) {
        caughtError = e as Error;
      }

      expect(emittedErrorPayload).to.exist;
      // DAPRequestBuilder emits the original network error
      expect(emittedErrorPayload?.error).to.equal(networkError);
      expect(emittedErrorPayload?.sessionId).to.equal(
        dapSessionHandler.sessionId,
      );

      expect(caughtError).to.exist;
      // DAPSessionHandler.setBreakpoints re-throws it (via DAPRequestBuilder)
      expect(caughtError).to.equal(networkError);
      // Session status should remain 'active' because setBreakpoints's DAPRequestBuilder
      // is configured with isTerminatingFailure: false by default in DAPSessionHandler.setBreakpoints.
      // A network error for a non-critical request shouldn't kill the session.
      expect(dapSessionHandler.status).to.equal('active');
    });
  });
});
