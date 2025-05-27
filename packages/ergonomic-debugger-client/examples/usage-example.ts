import {
  SessionManager,
  ConfigManager,
  LoggerInterface,
  DebugProtocol,
} from '../src';

// Simple logger implementation
const logger: LoggerInterface = {
  trace: (...args: unknown[]) => console.log('[TRACE]', ...args),
  debug: (...args: unknown[]) => console.log('[DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[INFO]', ...args),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
  child: () => logger,
};

async function main() {
  try {
    // Example 1: Using separate adapter and launch config files
    console.log(
      '\n=== Example 1: Using separate adapter and launch config files ===\n',
    );

    // Create a session manager with config paths
    const sessionManager1 = new SessionManager(logger, {
      adapterConfigPath: './examples/adapters.json',
      launchConfigPath: './examples/launch.json',
    });

    // Start a session using a named configuration
    console.log(
      'Starting debug session using "Launch Node Program" configuration...',
    );
    const session1 = await sessionManager1.startSessionByConfig(
      'Launch Node Program',
    );
    console.log(`Session started with status: ${session1.status}`);

    // Clean up
    await sessionManager1.disposeAllSessions();

    // Example 2: Using VSCode-style launch.json
    console.log('\n=== Example 2: Using VSCode-style launch.json ===\n');

    // Create a session manager with VSCode config path
    const sessionManager2 = new SessionManager(logger, {
      vscodeConfigPath: './examples/vscode-launch.json',
    });

    // Start a session using a named configuration
    console.log(
      'Starting debug session using "Python: Current File" configuration...',
    );
    const session2 = await sessionManager2.startSessionByConfig(
      'Python: Current File',
    );
    console.log(`Session started with status: ${session2.status}`);

    // Clean up
    await sessionManager2.disposeAllSessions();

    // Example 3: Using the ConfigManager directly
    console.log('\n=== Example 3: Using the ConfigManager directly ===\n');

    // Create a config manager
    const configManager = new ConfigManager(logger);

    // Load configurations
    configManager.loadAdapterConfigs('./examples/adapters.json');
    configManager.loadLaunchConfigs('./examples/launch.json');

    // Create a session manager
    const sessionManager3 = new SessionManager(logger);

    // Register adapter configurations
    configManager.getAllAdapterConfigs().forEach((config) => {
      sessionManager3.registerAdapterConfiguration(config);
    });

    // Get a launch configuration and start a session
    const launchConfig = configManager.getLaunchConfig(
      'Launch Chrome against localhost',
    );
    if (launchConfig) {
      console.log(
        'Starting debug session using "Launch Chrome against localhost" configuration...',
      );
      const { args, requestType, adapterType } =
        configManager.getLaunchArguments(launchConfig.name);
      const session3 = await sessionManager3.startSession(
        adapterType,
        args,
        requestType,
      );
      console.log(`Session started with status: ${session3.status}`);

      // Clean up
      await sessionManager3.disposeAllSessions();
    }

    // Example 4: Programmatic configuration
    console.log('\n=== Example 4: Programmatic configuration ===\n');

    // Create a session manager
    const sessionManager4 = new SessionManager(logger);

    // Register an adapter configuration programmatically
    sessionManager4.registerAdapterConfiguration({
      type: 'node',
      command: 'node',
      args: ['./node_modules/@vscode/node-debug2/out/src/nodeDebug.js'],
    });

    // Start a session with direct arguments
    console.log('Starting debug session with direct arguments...');
    // Cast to any to avoid type issues with specific launch arguments
    const session4 = await sessionManager4.startSession(
      'node',
      {
        program: './app.js',
        stopOnEntry: true,
      } as DebugProtocol.LaunchRequestArguments,
      'launch',
    );
    console.log(`Session started with status: ${session4.status}`);

    // Clean up
    await sessionManager4.disposeAllSessions();
  } catch (error) {
    console.error('Error in example:', error);
  }
}

// Run the example
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
