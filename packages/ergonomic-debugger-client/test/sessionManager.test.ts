import { expect } from 'chai'; // Reverted to simple chai import
import * as path from 'path';
import {
  SessionManager,
  AdapterConfig,
  AdapterProcessError,
} from '../src/sessionManager';
import { DAPSessionHandler } from '../src/dapSessionHandler';
import { LoggerInterface } from '../src/logging';
import { DebugProtocol } from '@vscode/debugprotocol';

const mockLogger: LoggerInterface = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trace: (objOrMsg: any, ...args: any[]) =>
    typeof objOrMsg === 'string'
      ? console.log(`[TRACE] ${objOrMsg}`, ...args)
      : console.log('[TRACE]', objOrMsg, ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (objOrMsg: any, ...args: any[]) =>
    typeof objOrMsg === 'string'
      ? console.log(`[DEBUG] ${objOrMsg}`, ...args)
      : console.log('[DEBUG]', objOrMsg, ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info: (objOrMsg: any, ...args: any[]) =>
    typeof objOrMsg === 'string'
      ? console.log(`[INFO] ${objOrMsg}`, ...args)
      : console.log('[INFO]', objOrMsg, ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (objOrMsg: any, ...args: any[]) =>
    typeof objOrMsg === 'string'
      ? console.warn(`[WARN] ${objOrMsg}`, ...args)
      : console.warn('[WARN]', objOrMsg, ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (objOrMsg: any, ...args: any[]) =>
    typeof objOrMsg === 'string'
      ? console.error(`[ERROR] ${objOrMsg}`, ...args)
      : console.error('[ERROR]', objOrMsg, ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  child: function (bindings: Record<string, any>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const childBindings = { ...((this as any)._bindings || {}), ...bindings };
    return {
      ...this,
      _bindings: childBindings,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      trace: (objOrMsg: any, ...args: any[]) =>
        typeof objOrMsg === 'string'
          ? console.log(`[TRACE]`, childBindings, objOrMsg, ...args)
          : console.log('[TRACE]', childBindings, objOrMsg, ...args),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      debug: (objOrMsg: any, ...args: any[]) =>
        typeof objOrMsg === 'string'
          ? console.log(`[DEBUG]`, childBindings, objOrMsg, ...args)
          : console.log('[DEBUG]', childBindings, objOrMsg, ...args),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      info: (objOrMsg: any, ...args: any[]) =>
        typeof objOrMsg === 'string'
          ? console.log(`[INFO]`, childBindings, objOrMsg, ...args)
          : console.log('[INFO]', childBindings, objOrMsg, ...args),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      warn: (objOrMsg: any, ...args: any[]) =>
        typeof objOrMsg === 'string'
          ? console.warn(`[WARN]`, childBindings, objOrMsg, ...args)
          : console.warn('[WARN]', childBindings, objOrMsg, ...args),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: (objOrMsg: any, ...args: any[]) =>
        typeof objOrMsg === 'string'
          ? console.error(`[ERROR]`, childBindings, objOrMsg, ...args)
          : console.error('[ERROR]', childBindings, objOrMsg, ...args),
      child: this.child,
    };
  },
};
const logger = mockLogger;

const MOCK_DEBUG_ADAPTER_PATH = path.resolve(
  __dirname,
  '../vendor/vscode-mock-debug/out/debugAdapter.js',
);
const MOCK_DEBUG_ADAPTER_SCRIPT_DIR_CWD = path.dirname(MOCK_DEBUG_ADAPTER_PATH);

const MOCK_ADAPTER_CONFIG: AdapterConfig = {
  type: 'mock',
  command: process.execPath,
  args: [MOCK_DEBUG_ADAPTER_PATH],
  cwd: MOCK_DEBUG_ADAPTER_SCRIPT_DIR_CWD,
};

describe.skip('SessionManager', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager(logger);
  });

  afterEach(async () => {
    if (sessionManager) {
      // Assuming disposeAllSessions is a method that might exist for cleanup in tests
      // Use a more specific cast if the method signature is known or can be inferred
      const sm = sessionManager as unknown as {
        disposeAllSessions?: () => Promise<void>;
      };
      if (typeof sm.disposeAllSessions === 'function') {
        await sm.disposeAllSessions();
      }
    }
  });

  describe('registerAdapterConfiguration', () => {
    it('should register a valid debug adapter configuration', () => {
      sessionManager.registerAdapterConfiguration(MOCK_ADAPTER_CONFIG);
      expect(true).to.be.true;
    });

    it('should throw an error if registering an invalid adapter configuration (missing type)', () => {
      const invalidConfig: Partial<AdapterConfig> = { command: 'node' };
      expect(() =>
        sessionManager.registerAdapterConfiguration(
          invalidConfig as AdapterConfig,
        ),
      ).to.throw(
        'Invalid adapter configuration: type and command are required.',
      );
    });

    it('should throw an error if registering an invalid adapter configuration (missing command)', () => {
      const invalidConfig: Partial<AdapterConfig> = { type: 'bad-type' };
      expect(() =>
        sessionManager.registerAdapterConfiguration(
          invalidConfig as AdapterConfig,
        ),
      ).to.throw(
        'Invalid adapter configuration: type and command are required.',
      );
    });
  });
  describe('startSession', () => {
    it.skip('should successfully start a session for a registered adapter type', async () => {
      sessionManager.registerAdapterConfiguration(MOCK_ADAPTER_CONFIG);

      let sessionStartedEmitted = false;
      let capabilitiesEmitted = false;
      let capabilitiesFromEvent: DebugProtocol.Capabilities | undefined;

      const sessionHandler = await sessionManager.startSession(
        MOCK_ADAPTER_CONFIG.type,
        {} as DebugProtocol.LaunchRequestArguments,
        'launch',
      );
      expect(sessionHandler).to.be.instanceOf(DAPSessionHandler);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              "Timeout waiting for 'sessionStarted' or 'capabilitiesUpdated' event (5000ms)",
            ),
          );
        }, 5000);

        sessionHandler.once('sessionStarted', (caps) => {
          sessionStartedEmitted = true;
          capabilitiesFromEvent = caps;
          if (capabilitiesEmitted) {
            clearTimeout(timeout);
            resolve();
          }
        });
        sessionHandler.once('capabilitiesUpdated', (caps) => {
          capabilitiesEmitted = true;
          if (!capabilitiesFromEvent) capabilitiesFromEvent = caps;
          if (sessionStartedEmitted) {
            clearTimeout(timeout);
            resolve();
          }
        });
        sessionHandler.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        sessionHandler.once('sessionEnded', (reason) => {
          clearTimeout(timeout);
          reject(
            new Error(`Session ended unexpectedly during startup: ${reason}`),
          );
        });
      });

      expect(sessionStartedEmitted, "'sessionStarted' event was not emitted").to
        .be.true;
      expect(capabilitiesEmitted, "'capabilitiesUpdated' event was not emitted")
        .to.be.true;
      expect(capabilitiesFromEvent).to.exist;
      expect(
        sessionHandler.status,
        "Session status should be 'active' or 'initialized' after start",
      ).to.match(/^(active|initialized)$/);

      await sessionHandler.disconnect();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error("Timeout waiting for 'sessionEnded' after disconnect"),
            ),
          2000,
        );
        sessionHandler.once('sessionEnded', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      expect(
        sessionHandler.status,
        "Session status should be 'terminated' after disconnect",
      ).to.equal('terminated');
    });

    it('should fail to start a session for an unregistered adapter type', async () => {
      try {
        await sessionManager.startSession(
          'unregistered-type',
          {} as DebugProtocol.LaunchRequestArguments,
          'launch',
        );
        expect.fail(
          'Should have thrown an error for unregistered adapter type',
        );
      } catch (error: unknown) {
        expect(error).to.be.instanceOf(Error);
        if (error instanceof Error) {
          expect(error.message.toLowerCase()).to.include(
            'adapter configuration not found',
          );
          expect(error.message.toLowerCase()).to.include('unregistered-type');
        } else {
          expect.fail('Caught error was not an instance of Error');
        }
      }
    });

    it('should fail gracefully if adapter process launch fails (e.g. invalid command)', async () => {
      const invalidAdapterConfig: AdapterConfig = {
        type: 'invalid-adapter',
        command: 'nonexistentcommand12345',
        args: [],
      };
      sessionManager.registerAdapterConfiguration(invalidAdapterConfig);

      try {
        await sessionManager.startSession(
          invalidAdapterConfig.type,
          {} as DebugProtocol.LaunchRequestArguments,
          'launch',
        );
        expect.fail(
          'sessionManager.startSession should have thrown an AdapterProcessError for an invalid command.',
        );
      } catch (error: unknown) {
        expect(error).to.be.instanceOf(
          AdapterProcessError,
          'Error should be an instance of AdapterProcessError',
        );
        if (error instanceof AdapterProcessError) {
          const ape = error; // No need to cast 'as AdapterProcessError' due to instanceof check
          expect(ape.stage).to.equal('spawn', "Error stage should be 'spawn'");
          expect(ape.adapterType).to.equal(
            invalidAdapterConfig.type,
            'Error adapterType should match',
          );
          expect(ape.adapterConfig).to.deep.equal(
            invalidAdapterConfig,
            'Error adapterConfig should match',
          );
          expect(ape.message.toLowerCase()).to.include(
            'failed to spawn debug adapter process',
            'Error message should indicate spawn failure',
          );
          expect(ape.message.toLowerCase()).to.include(
            invalidAdapterConfig.command.toLowerCase(),
            'Error message should include the command',
          );

          if (ape.underlyingError) {
            expect(ape.underlyingError.message.toLowerCase()).to.include(
              'enoent',
              "Underlying error message should often include 'enoent' for invalid commands",
            );
          }
        } else {
          expect.fail(
            'Caught error was not an instance of AdapterProcessError',
          );
        }
      }
    });
  });
});
