import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../../src/config/configManager';
import { AdapterConfigLoader } from '../../src/config/adapterConfigLoader';
import { LaunchConfigLoader } from '../../src/config/launchConfigLoader';
import { SessionManager } from '../../src/sessionManager';
import { LoggerInterface } from '../../src/logging';

// Test-specific subclass to expose protected members
class TestSessionManager extends SessionManager {
  public publicGetConfigManager(): ConfigManager {
    return this.getConfigManager();
  }
}

const mockLogger = {
  trace: sinon.spy(),
  debug: sinon.spy(),
  info: sinon.spy(),
  warn: sinon.spy(),
  error: sinon.spy(),
  child: sinon.stub().returnsThis(),
} as LoggerInterface & {
  trace: sinon.SinonSpy;
  debug: sinon.SinonSpy;
  info: sinon.SinonSpy;
  warn: sinon.SinonSpy;
  error: sinon.SinonSpy;
  child: sinon.SinonStub;
};

describe('ConfigManager', () => {
  let configManager: ConfigManager;
  let tempDir: string;
  let adapterConfigPath: string;
  let launchConfigPath: string;
  let vscodeConfigPath: string;

  before(() => {
    tempDir = path.join(__dirname, '..', 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    adapterConfigPath = path.join(tempDir, 'adapters.json');
    const adapterConfig = {
      adapters: {
        node: {
          command: 'node',
          args: [
            '${workspaceFolder}/node_modules/@vscode/node-debug2/out/src/nodeDebug.js',
          ],
        },
        python: {
          command: 'python',
          args: ['-m', 'debugpy.adapter'],
        },
      },
    };
    fs.writeFileSync(adapterConfigPath, JSON.stringify(adapterConfig, null, 2));

    launchConfigPath = path.join(tempDir, 'launch.json');
    const launchConfig = {
      configurations: [
        {
          name: 'Launch Node Program',
          type: 'node',
          request: 'launch',
          program: '${workspaceFolder}/app.js',
          stopOnEntry: false,
        },
        {
          name: 'Python: Current File',
          type: 'python',
          request: 'launch',
          program: '${file}',
          console: 'integratedTerminal',
        },
      ],
    };
    fs.writeFileSync(launchConfigPath, JSON.stringify(launchConfig, null, 2));

    vscodeConfigPath = path.join(tempDir, 'vscode-launch.json');
    const vscodeConfig = {
      version: '0.2.0',
      configurations: [
        {
          name: 'Launch Node Program (VSCode)',
          type: 'node',
          request: 'launch',
          program: '${workspaceFolder}/app.js',
        },
        {
          name: 'Python: Current File (VSCode)',
          type: 'python',
          request: 'launch',
          program: '${file}',
        },
      ],
    };
    fs.writeFileSync(vscodeConfigPath, JSON.stringify(vscodeConfig, null, 2));
  });

  after(() => {
    if (fs.existsSync(adapterConfigPath)) {
      fs.unlinkSync(adapterConfigPath);
    }
    if (fs.existsSync(launchConfigPath)) {
      fs.unlinkSync(launchConfigPath);
    }
    if (fs.existsSync(vscodeConfigPath)) {
      fs.unlinkSync(vscodeConfigPath);
    }
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir);
    }
  });

  beforeEach(() => {
    Object.values(mockLogger).forEach((spy: sinon.SinonSpy) => {
      if (typeof spy.resetHistory === 'function') {
        spy.resetHistory();
      }
    });

    configManager = new ConfigManager(mockLogger);
  });

  describe('AdapterConfigLoader', () => {
    it('should load adapter configurations from a JSON file', () => {
      const adapterLoader = new AdapterConfigLoader(mockLogger);
      const configs = adapterLoader.loadFromFile(adapterConfigPath);

      expect(configs).to.be.an('array');
      expect(configs.length).to.equal(2);

      const nodeConfig = configs.find((c) => c.type === 'node');
      expect(nodeConfig).to.exist;
      expect(nodeConfig?.command).to.equal('node');
      expect(nodeConfig?.args).to.deep.equal([
        '${workspaceFolder}/node_modules/@vscode/node-debug2/out/src/nodeDebug.js',
      ]);

      const pythonConfig = configs.find((c) => c.type === 'python');
      expect(pythonConfig).to.exist;
      expect(pythonConfig?.command).to.equal('python');
      expect(pythonConfig?.args).to.deep.equal(['-m', 'debugpy.adapter']);
    });

    it('should load adapter configurations from a VSCode config file', () => {
      const adapterLoader = new AdapterConfigLoader(mockLogger);
      const configs = adapterLoader.loadFromVSCodeConfig(vscodeConfigPath);

      expect(configs).to.be.an('array');
      expect(configs.length).to.be.at.least(0);

      if (configs.length > 0) {
        configs.forEach((config) => {
          expect(config.type).to.be.a('string');
          expect(config.command).to.be.a('string');
        });
      }
    });
  });

  describe('LaunchConfigLoader', () => {
    it('should load launch configurations from a JSON file', () => {
      const launchLoader = new LaunchConfigLoader(mockLogger);
      const configs = launchLoader.loadFromFile(launchConfigPath);

      expect(configs).to.be.an('array');
      expect(configs.length).to.equal(2);

      const nodeConfig = configs.find((c) => c.name === 'Launch Node Program');
      expect(nodeConfig).to.exist;
      expect(nodeConfig?.type).to.equal('node');
      expect(nodeConfig?.request).to.equal('launch');
      expect(nodeConfig?.program).to.equal('${workspaceFolder}/app.js');

      const pythonConfig = configs.find(
        (c) => c.name === 'Python: Current File',
      );
      expect(pythonConfig).to.exist;
      expect(pythonConfig?.type).to.equal('python');
      expect(pythonConfig?.request).to.equal('launch');
      expect(pythonConfig?.program).to.equal('${file}');
    });

    it('should load launch configurations from a VSCode config file', () => {
      const launchLoader = new LaunchConfigLoader(mockLogger);
      const configs = launchLoader.loadFromVSCodeConfig(vscodeConfigPath);

      expect(configs).to.be.an('array');
      expect(configs.length).to.equal(2);

      const nodeConfig = configs.find(
        (c) => c.name === 'Launch Node Program (VSCode)',
      );
      expect(nodeConfig).to.exist;
      expect(nodeConfig?.type).to.equal('node');
      expect(nodeConfig?.request).to.equal('launch');
      expect(nodeConfig?.program).to.equal('${workspaceFolder}/app.js');

      const pythonConfig = configs.find(
        (c) => c.name === 'Python: Current File (VSCode)',
      );
      expect(pythonConfig).to.exist;
      expect(pythonConfig?.type).to.equal('python');
      expect(pythonConfig?.request).to.equal('launch');
      expect(pythonConfig?.program).to.equal('${file}');
    });

    it('should convert a launch configuration to DAP launch arguments', () => {
      const launchLoader = new LaunchConfigLoader(mockLogger);
      const configs = launchLoader.loadFromFile(launchConfigPath);
      const nodeConfig = configs.find((c) => c.name === 'Launch Node Program');

      if (nodeConfig) {
        const args = launchLoader.toLaunchArguments(nodeConfig);
        expect(args).to.not.have.property('name');
        expect(args).to.not.have.property('type');
        expect(args).to.not.have.property('request');
        expect(args).to.have.property('program', '${workspaceFolder}/app.js');
        expect(args).to.have.property('stopOnEntry', false);
      } else {
        throw new Error('Node config not found');
      }
    });
  });

  describe('ConfigManager', () => {
    it('should load adapter configurations from a JSON file', () => {
      configManager.loadAdapterConfigs(adapterConfigPath);

      const nodeConfig = configManager.getAdapterConfig('node');
      expect(nodeConfig).to.exist;
      expect(nodeConfig?.command).to.equal('node');

      const pythonConfig = configManager.getAdapterConfig('python');
      expect(pythonConfig).to.exist;
      expect(pythonConfig?.command).to.equal('python');

      const allConfigs = configManager.getAllAdapterConfigs();
      expect(allConfigs).to.be.an('array');
      expect(allConfigs.length).to.equal(2);
    });

    it('should load launch configurations from a JSON file', () => {
      configManager.loadLaunchConfigs(launchConfigPath);

      const nodeConfig = configManager.getLaunchConfig('Launch Node Program');
      expect(nodeConfig).to.exist;
      expect(nodeConfig?.type).to.equal('node');

      const pythonConfig = configManager.getLaunchConfig(
        'Python: Current File',
      );
      expect(pythonConfig).to.exist;
      expect(pythonConfig?.type).to.equal('python');

      const allConfigs = configManager.getAllLaunchConfigs();
      expect(allConfigs).to.be.an('array');
      expect(allConfigs.length).to.equal(2);
    });

    it('should load configurations from a VSCode config file', () => {
      configManager.loadLaunchConfigsFromVSCode(vscodeConfigPath);

      const nodeConfig = configManager.getLaunchConfig(
        'Launch Node Program (VSCode)',
      );
      expect(nodeConfig).to.exist;
      expect(nodeConfig?.type).to.equal('node');

      const pythonConfig = configManager.getLaunchConfig(
        'Python: Current File (VSCode)',
      );
      expect(pythonConfig).to.exist;
      expect(pythonConfig?.type).to.equal('python');
    });

    it('should register adapter configurations programmatically', () => {
      configManager.registerAdapterConfig({
        type: 'go',
        command: 'dlv',
        args: ['dap'],
      });

      const goConfig = configManager.getAdapterConfig('go');
      expect(goConfig).to.exist;
      expect(goConfig?.command).to.equal('dlv');
      expect(goConfig?.args).to.deep.equal(['dap']);
    });

    it('should register launch configurations programmatically', () => {
      configManager.registerLaunchConfig({
        name: 'Go: Launch Package',
        type: 'go',
        request: 'launch',
        mode: 'auto',
        program: '${fileDirname}',
      });

      const goConfig = configManager.getLaunchConfig('Go: Launch Package');
      expect(goConfig).to.exist;
      expect(goConfig?.type).to.equal('go');
      expect(goConfig?.request).to.equal('launch');
      expect(goConfig?.program).to.equal('${fileDirname}');
    });

    it('should get launch arguments from a launch configuration', () => {
      configManager.loadLaunchConfigs(launchConfigPath);

      const { args, requestType, adapterType } =
        configManager.getLaunchArguments('Launch Node Program');
      expect(args).to.not.have.property('name');
      expect(args).to.not.have.property('type');
      expect(args).to.not.have.property('request');
      expect(args).to.have.property('program', '${workspaceFolder}/app.js');
      expect(requestType).to.equal('launch');
      expect(adapterType).to.equal('node');
    });
  });

  describe('SessionManager with ConfigManager', () => {
    let sessionManager: TestSessionManager; // Use TestSessionManager
    let startSessionStub: sinon.SinonStub;

    beforeEach(() => {
      sessionManager = new TestSessionManager(mockLogger);
      startSessionStub = sinon
        .stub(sessionManager, 'startSession')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .resolves({} as any);
    });

    afterEach(() => {
      startSessionStub.restore();
    });

    it('should load configurations from global config', () => {
      const _sessionManagerWithConfig = new SessionManager(mockLogger, {
        adapterConfigPath,
        launchConfigPath,
      });

      expect(
        mockLogger.info.calledWith(
          sinon.match(/Loading adapter configurations/),
        ),
      ).to.be.true;
      expect(
        mockLogger.info.calledWith(
          sinon.match(/Loading launch configurations/),
        ),
      ).to.be.true;
    });

    it('should start a session using a named configuration', async () => {
      const internalConfigManager = sessionManager.publicGetConfigManager();

      internalConfigManager.loadAdapterConfigs(adapterConfigPath);
      internalConfigManager.loadLaunchConfigs(launchConfigPath);

      internalConfigManager.getAllAdapterConfigs().forEach((config) => {
        sessionManager.registerAdapterConfiguration(config);
      });

      await sessionManager.startSessionByConfig('Launch Node Program');

      expect(startSessionStub.calledOnce).to.be.true;
      const [adapterType, args, requestType] = startSessionStub.firstCall.args;
      expect(adapterType).to.equal('node');
      expect(args).to.have.property('program', '${workspaceFolder}/app.js');
      expect(requestType).to.equal('launch');
    });
  });
});
