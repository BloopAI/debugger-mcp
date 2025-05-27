import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from '../../src/sessionManager';
import { ConfigManager } from '../../src/config/configManager';
import { DAPSessionHandler } from '../../src/dapSessionHandler';
import { LoggerInterface } from '../../src/logging';

const mockLogger: LoggerInterface = {
  trace: (...args: unknown[]) => console.log('[TRACE]', ...args),
  debug: (...args: unknown[]) => console.log('[DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[INFO]', ...args),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
  child: () => mockLogger,
};

describe('Configuration Integration Tests', function () {
  this.timeout(30000);

  let tempDir: string;
  let adapterConfigPath: string;
  let launchConfigPath: string;
  let mockProgramPath: string;
  let sessionManager: SessionManager;
  let sessionHandler: DAPSessionHandler | null = null;

  before(function () {
    try {
      const mockDebugPath = path.resolve(
        __dirname,
        '../vendor/vscode-mock-debug/out/runDebugAdapter.sh',
      );
      if (!fs.existsSync(mockDebugPath)) {
        console.warn(
          'Skipping integration tests: mock-debug not found at',
          mockDebugPath,
        );
        this.skip();
      }
    } catch (error) {
      console.warn('Error checking for mock-debug:', error);
      this.skip();
    }

    tempDir = path.join(__dirname, '..', 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    mockProgramPath = path.join(tempDir, 'testProg.js');
    fs.writeFileSync(
      mockProgramPath,
      '// Test Program\nvar a = 1; // Line 2\nvar b = 2; // Line 3\nconsole.log(a + b); // Line 4',
    );

    adapterConfigPath = path.join(tempDir, 'adapters.json');
    const mockDebugPath = path.resolve(
      __dirname,
      '../vendor/vscode-mock-debug/out/runDebugAdapter.sh',
    );
    const adapterConfig = {
      adapters: {
        mock: {
          command: mockDebugPath,
          args: [],
        },
      },
    };
    fs.writeFileSync(adapterConfigPath, JSON.stringify(adapterConfig, null, 2));

    launchConfigPath = path.join(tempDir, 'launch.json');
    const launchConfig = {
      configurations: [
        {
          name: 'Launch Mock Program',
          type: 'mock',
          request: 'launch',
          program: mockProgramPath,
          stopOnEntry: true,
        },
      ],
    };
    fs.writeFileSync(launchConfigPath, JSON.stringify(launchConfig, null, 2));

    sessionManager = new SessionManager(mockLogger, {
      adapterConfigPath,
      launchConfigPath,
    });
  });

  after(function () {
    if (fs.existsSync(mockProgramPath)) {
      fs.unlinkSync(mockProgramPath);
    }
    if (fs.existsSync(adapterConfigPath)) {
      fs.unlinkSync(adapterConfigPath);
    }
    if (fs.existsSync(launchConfigPath)) {
      fs.unlinkSync(launchConfigPath);
    }
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmdirSync(tempDir);
      } catch (error) {
        console.warn('Error removing temp directory:', error);
      }
    }
  });

  afterEach(async function () {
    if (sessionHandler) {
      try {
        await sessionHandler.disconnect();
      } catch (error) {
        console.warn('Error disconnecting session:', error);
      }
      sessionHandler = null;
    }

    try {
      await sessionManager.disposeAllSessions();
    } catch (error) {
      console.warn('Error disposing sessions:', error);
    }
  });

  it('should load and process configurations correctly', async function () {
    this.timeout(30000);

    try {
      const configManager = new ConfigManager(mockLogger);

      configManager.loadAdapterConfigs(adapterConfigPath);
      const adapterConfigs = configManager.getAllAdapterConfigs();

      expect(adapterConfigs).to.be.an('array');
      expect(adapterConfigs.length).to.equal(1);
      expect(adapterConfigs[0].type).to.equal('mock');
      expect(adapterConfigs[0].command).to.equal(
        path.resolve(
          __dirname,
          '../vendor/vscode-mock-debug/out/runDebugAdapter.sh',
        ),
      );

      configManager.loadLaunchConfigs(launchConfigPath);
      const launchConfigs = configManager.getAllLaunchConfigs();

      expect(launchConfigs).to.be.an('array');
      expect(launchConfigs.length).to.equal(1);
      expect(launchConfigs[0].name).to.equal('Launch Mock Program');
      expect(launchConfigs[0].type).to.equal('mock');
      expect(launchConfigs[0].request).to.equal('launch');
      expect(launchConfigs[0].program).to.equal(mockProgramPath);
      expect(launchConfigs[0].stopOnEntry).to.be.true;

      const { args, requestType, adapterType } =
        configManager.getLaunchArguments('Launch Mock Program');

      expect(args).to.not.have.property('name');
      expect(args).to.not.have.property('type');
      expect(args).to.not.have.property('request');
      expect(args).to.have.property('program', mockProgramPath);
      expect(args).to.have.property('stopOnEntry', true);
      expect(requestType).to.equal('launch');
      expect(adapterType).to.equal('mock');

      const startSessionStub = sinon
        .stub(sessionManager, 'startSession')
        .resolves({} as DAPSessionHandler);

      try {
        configManager.getAllAdapterConfigs().forEach((config) => {
          sessionManager.registerAdapterConfiguration(config);
        });

        (
          sessionManager as unknown as { configManager: ConfigManager }
        ).configManager = configManager;

        await sessionManager.startSessionByConfig('Launch Mock Program');

        expect(startSessionStub.calledOnce).to.be.true;
        const [adapterType, args, requestType] =
          startSessionStub.firstCall.args;
        expect(adapterType).to.equal('mock');
        expect(args).to.have.property('program', mockProgramPath);
        expect(requestType).to.equal('launch');
      } finally {
        startSessionStub.restore();
      }
    } catch (error) {
      console.error('Error in test:', error);
      throw error;
    }
  });
});
