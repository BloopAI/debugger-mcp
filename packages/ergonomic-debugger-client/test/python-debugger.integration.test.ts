import * as path from 'path';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import {
  DebuggerClient,
  SessionConfigBuilder,
  LoggerInterface,
  AdapterConfig,
  DebugSession,
  DAPSessionHandler,
} from '../src/index';

const logger: LoggerInterface = {
  trace: (message, ...meta) => console.log(`[TRACE] ${message}`, ...meta),
  debug: (message, ...meta) => console.log(`[DEBUG] ${message}`, ...meta),
  info: (message, ...meta) => console.log(`[INFO] ${message}`, ...meta),
  warn: (message, ...meta) => console.warn(`[WARN] ${message}`, ...meta),
  error: (message, ...meta) => console.error(`[ERROR] ${message}`, ...meta),
};

const VENV_PATH = path.resolve(
  __dirname,
  '..',
  '.test_python_venv_integration',
);
const PYTHON_EXECUTABLE_IN_VENV =
  process.platform === 'win32'
    ? path.join(VENV_PATH, 'Scripts', 'python.exe')
    : path.join(VENV_PATH, 'bin', 'python');
const PYTHON_COMMAND = 'python3';

function setupPythonVirtualEnv(): string {
  logger.info(
    `Setting up Python virtual environment for integration tests at: ${VENV_PATH}`,
  );
  if (fs.existsSync(VENV_PATH)) {
    logger.info(`Removing existing test virtual environment at: ${VENV_PATH}`);
    fs.rmSync(VENV_PATH, { recursive: true, force: true });
  }
  execSync(`${PYTHON_COMMAND} -m venv ${VENV_PATH}`, { stdio: 'inherit' });
  logger.info('Test virtual environment created.');
  execSync(`${PYTHON_EXECUTABLE_IN_VENV} -m pip install debugpy`, {
    stdio: 'inherit',
  });
  logger.info('debugpy installed in test virtual environment.');
  return PYTHON_EXECUTABLE_IN_VENV;
}

function cleanupPythonVirtualEnv(): void {
  if (fs.existsSync(VENV_PATH)) {
    logger.info(`Cleaning up Python virtual environment at: ${VENV_PATH}`);
    fs.rmSync(VENV_PATH, { recursive: true, force: true });
    logger.info('Python virtual environment cleaned up.');
  }
}

describe('Python Debugger Integration Test', function () {
  this.timeout(30000);

  let pythonExecutableInVenv: string;
  let client: DebuggerClient;
  let debugSession: DebugSession;
  let dapSessionHandler: DAPSessionHandler;

  before(function () {
    this.timeout(60000);
    pythonExecutableInVenv = setupPythonVirtualEnv();
    client = new DebuggerClient(logger);

    const pythonAdapterConfig: AdapterConfig = {
      type: 'python',
      command: pythonExecutableInVenv,
      args: ['-m', 'debugpy.adapter'],
    };
    client.registerAdapter(pythonAdapterConfig);
    logger.info(`Registered Python adapter using: ${pythonExecutableInVenv}`);
  });

  after(async function () {
    this.timeout(15000);
    if (client) {
      logger.info('Disconnecting client in after hook...');
      await client.disconnect();
      logger.info('Client disconnected in after hook.');
    }
    cleanupPythonVirtualEnv();
  });

  it('should start a debug session, hit stopOnEntry, get stack trace, receive output, and terminate', (done) => {
    const programPath = path.resolve(
      __dirname,
      '..',
      'examples/python-example.py',
    );
    const sessionConfig = new SessionConfigBuilder('python', programPath)
      .withStopOnEntry(true)
      .withCwd(path.resolve(__dirname, '..', 'examples'))
      .build();

    let stoppedEventReceived = false;
    let stackTraceVerified = false;
    let expectedOutputReceived = false;
    let sessionEndedReceived = false;
    let initialStopOnEntryReceived = false;
    let _breakpointStopReceived = false; // This flag is set but not currently asserted upon.

    client
      .startSession(sessionConfig)
      .then((sessionResult) => {
        expect(sessionResult.success, 'Session should start successfully').to.be
          .true;
        expect(
          sessionResult.result,
          'Session result should have a DAPSessionHandler',
        ).to.exist;
        dapSessionHandler = sessionResult.result!;

        debugSession = new DebugSession(
          sessionConfig.adapterType,
          sessionConfig.program,
          dapSessionHandler,
          logger,
        );
        logger.info(
          `DebugSession created for test. Client Session ID: ${debugSession.id}`,
        );

        dapSessionHandler.on('stopped', async (stoppedEvent) => {
          logger.info('Test: Debugger stopped event received', stoppedEvent);

          if (stoppedEvent.reason === 'entry' && !initialStopOnEntryReceived) {
            initialStopOnEntryReceived = true;
            stoppedEventReceived = true;
            logger.info(
              'Test: Initial stop on entry. Setting breakpoint and continuing.',
            );
            expect(stoppedEvent.threadId).to.be.a('number');

            const breakpointLine = 10; // Line number of `total = 0` in calculate_sum
            try {
              await debugSession.setBreakpoint({
                filePath: programPath,
                line: breakpointLine,
              });
              logger.info(
                `Test: Breakpoint set at ${programPath}:${breakpointLine}. Continuing execution...`,
              );
              await debugSession.continue(stoppedEvent.threadId!);
            } catch (err: unknown) {
              if (err instanceof Error) {
                logger.error(
                  'Test: Error setting breakpoint or continuing:',
                  err,
                );
                done(err);
              } else {
                logger.error(
                  'Test: Caught non-Error setting breakpoint or continuing:',
                  String(err),
                );
                done(new Error(String(err)));
              }
            }
          } else if (
            stoppedEvent.reason === 'breakpoint' &&
            initialStopOnEntryReceived
          ) {
            _breakpointStopReceived = true;
            logger.info('Test: Stopped at breakpoint. Verifying stack trace.');
            expect(stoppedEvent.threadId).to.be.a('number');

            try {
              const stackFrames = await debugSession.getCallStack(
                stoppedEvent.threadId!,
              );
              logger.info(
                'Test: Stack trace received',
                stackFrames.map((f) => ({
                  name: f.name,
                  line: f.line,
                  source: f.source?.path,
                })),
              );
              expect(stackFrames).to.be.an('array').with.length.greaterThan(0);
              expect(stackFrames[0].name).to.equal('calculate_sum');
              expect(stackFrames[0].line).to.equal(10); // Line of `total = 0`
              expect(stackFrames[0].source?.path).to.equal(programPath);
              stackTraceVerified = true;

              logger.info('Test: Continuing execution from breakpoint...');
              await debugSession.continue(stoppedEvent.threadId!);
            } catch (err: unknown) {
              if (err instanceof Error) {
                logger.error(
                  'Test: Error getting stack trace or continuing from breakpoint:',
                  err,
                );
                done(err);
              } else {
                logger.error(
                  'Test: Caught non-Error getting stack trace or continuing from breakpoint:',
                  String(err),
                );
                done(new Error(String(err)));
              }
            }
          } else {
            logger.warn(
              'Test: Received an unexpected stopped event or out of order stop:',
              stoppedEvent,
            );
          }
        });

        dapSessionHandler.on('output', (outputEvent) => {
          logger.info(
            `Test: [PROGRAM OUTPUT] ${outputEvent.category}: ${outputEvent.output.trim()}`,
          );
          if (
            outputEvent.output.includes(
              'Error occurred: list index out of range',
            )
          ) {
            expectedOutputReceived = true;
          }
        });

        dapSessionHandler.on('sessionEnded', (sessionEndedEvent) => {
          logger.info(
            'Test: Debug sessionEnded event received.',
            sessionEndedEvent,
          );
          sessionEndedReceived = true;

          setTimeout(() => {
            expect(
              stoppedEventReceived,
              'Stopped event should have been received',
            ).to.be.true;
            expect(stackTraceVerified, 'Stack trace should have been verified')
              .to.be.true;
            expect(
              expectedOutputReceived,
              'Expected error output from Python script should have been received',
            ).to.be.true;
            done();
          }, 500);
        });

        setTimeout(() => {
          if (!sessionEndedReceived) {
            const err = new Error(
              'Test timed out: Did not receive sessionEnded event. State: stopped=' +
                stoppedEventReceived +
                ', stackTrace=' +
                stackTraceVerified +
                ', output=' +
                expectedOutputReceived,
            );
            logger.error(err.message);
            done(err);
          }
        }, 25000);
      })
      .catch((err) => {
        logger.error('Test: Failed to start debug session in test case:', err);
        done(err);
      });
  });
});
