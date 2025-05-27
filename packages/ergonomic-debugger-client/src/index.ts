/**
 * @file Main entry point for the Debugger Client library
 *
 * This file exports the main client class and all necessary types and interfaces
 * for interacting with debug adapters using the Debug Adapter Protocol (DAP).
 *
 * @module ergonomic-debugger-client
 */

import { DebugProtocol } from '@vscode/debugprotocol';
import { SessionManager, AdapterConfig } from './sessionManager';
import { DAPSessionHandler } from './dapSessionHandler';
import { LoggerInterface } from './logging';

// Re-export DebugProtocol namespace
export { DebugProtocol };

/**
 * Configuration for starting a debug session
 */
export interface SessionConfig {
  /**
   * The type of debug adapter to use (e.g., 'node', 'python')
   */
  adapterType: string;

  /**
   * The path to the program to debug
   */
  program: string;

  /**
   * Arguments to pass to the program
   */
  args?: string[];

  /**
   * Whether to stop at the entry point of the program
   */
  stopOnEntry?: boolean;

  /**
   * Working directory for the debug session
   */
  cwd?: string;

  /**
   * Environment variables for the debug session
   */
  env?: Record<string, string>;

  /**
   * Additional configuration options specific to the debug adapter.
   * These properties are passed directly to the debug adapter during the
   * launch or attach request. Refer to the specific adapter's documentation
   * for available options.
   * E.g., `{ "console": "internalConsole" }` for some Node.js debuggers.
   */
  [key: string]: unknown;
}

/**
 * Builder for creating session configurations
 */
export class SessionConfigBuilder {
  private config: SessionConfig;

  /**
   * Creates a new SessionConfigBuilder
   *
   * @param adapterType The type of debug adapter to use
   * @param program The path to the program to debug
   */
  constructor(adapterType: string, program: string) {
    this.config = {
      adapterType,
      program,
    };
  }

  /**
   * Sets the arguments to pass to the program
   *
   * @param args The arguments
   * @returns The builder instance for chaining
   */
  withArgs(args: string[]): SessionConfigBuilder {
    this.config.args = args;
    return this;
  }

  /**
   * Sets whether to stop at the entry point of the program
   *
   * @param stopOnEntry Whether to stop at the entry point
   * @returns The builder instance for chaining
   */
  withStopOnEntry(stopOnEntry: boolean): SessionConfigBuilder {
    this.config.stopOnEntry = stopOnEntry;
    return this;
  }

  /**
   * Sets the working directory for the debug session
   *
   * @param cwd The working directory
   * @returns The builder instance for chaining
   */
  withCwd(cwd: string): SessionConfigBuilder {
    this.config.cwd = cwd;
    return this;
  }

  /**
   * Sets the environment variables for the debug session
   *
   * @param env The environment variables
   * @returns The builder instance for chaining
   */
  withEnv(env: Record<string, string>): SessionConfigBuilder {
    this.config.env = env;
    return this;
  }

  /**
   * Sets an additional configuration option
   *
   * @param key The option key
   * @param value The option value
   * @returns The builder instance for chaining
   */
  withOption(key: string, value: unknown): SessionConfigBuilder {
    this.config[key] = value;
    return this;
  }

  /**
   * Builds the session configuration
   *
   * @returns The session configuration
   */
  build(): SessionConfig {
    return { ...this.config };
  }
}

/**
 * Result of a debug operation
 */
export interface DebugResult<T> {
  /**
   * Whether the operation was successful
   */
  success: boolean;

  /**
   * The result of the operation, if successful
   */
  result?: T;

  /**
   * The error that occurred, if unsuccessful
   */
  error?: Error;

  /**
   * Additional information about the operation
   */
  info?: Record<string, unknown>;
}

/**
 * Main client class for interactive debugging
 *
 * This class provides a high-level API for interacting with debug adapters
 * using the Debug Adapter Protocol (DAP).
 */
export class DebuggerClient {
  private readonly sessionManager: SessionManager;
  private readonly logger: LoggerInterface;
  private isConnected: boolean = false;

  /**
   * Creates a new DebuggerClient
   *
   * @param logger The logger to use
   * @param options Optional configuration options
   */
  constructor(
    logger: LoggerInterface,
    options?: {
      /**
       * Path to the adapter configuration file
       */
      adapterConfigPath?: string;

      /**
       * Path to the launch configuration file
       */
      launchConfigPath?: string;

      /**
       * Path to the VSCode launch.json file
       */
      vscodeConfigPath?: string;
    },
  ) {
    this.logger = logger;
    this.sessionManager = new SessionManager(logger, options);

    this.logger.info('DebuggerClient initialized');
  }

  /**
   * Registers a debug adapter configuration
   *
   * @param config The adapter configuration
   * @throws Error if the configuration is invalid
   */
  registerAdapter(config: AdapterConfig): void {
    if (!config || !config.type || !config.command) {
      throw new Error(
        'Invalid adapter configuration: type and command are required',
      );
    }

    this.sessionManager.registerAdapterConfiguration(config);
    this.logger.info(
      `Registered adapter configuration for type '${config.type}'`,
    );
  }

  /**
   * Starts a debug session using a configuration builder
   *
   * @param configBuilder The session configuration builder
   * @returns A promise that resolves to the debug session handler
   * @throws Error if the session cannot be started
   */
  async startSessionWithBuilder(
    configBuilder: SessionConfigBuilder,
  ): Promise<DebugResult<DAPSessionHandler>> {
    return this.startSession(configBuilder.build());
  }

  /**
   * Starts a debug session using a configuration object
   *
   * @param config The session configuration
   * @returns A promise that resolves to the debug session handler
   * @throws Error if the session cannot be started
   */
  async startSession(
    config: SessionConfig,
  ): Promise<DebugResult<DAPSessionHandler>> {
    try {
      // Validate configuration
      if (!config || !config.adapterType || !config.program) {
        throw new Error(
          'Invalid session configuration: adapterType and program are required',
        );
      }

      // Convert SessionConfig to DAP launch arguments
      const {
        program, // Required for launch
        args,
        stopOnEntry,
        cwd,
        env,
        ...adapterSpecificOptions // Captures all other properties from SessionConfig
      } = config;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const launchArgs: any = {
        program, // program is a required field for LaunchRequestArguments
        args,
        stopOnEntry,
        cwd,
        env,
        ...adapterSpecificOptions,
      };
      // Optional properties from SessionConfig will be undefined in launchArgs if not provided.
      // Most adapters handle undefined optional properties correctly.

      // Start the session
      this.logger.info(
        `Starting debug session for adapter type '${config.adapterType}'`,
        { config },
      );
      const sessionHandler = await this.sessionManager.startSession(
        config.adapterType,
        launchArgs,
        'launch',
      );

      return {
        success: true,
        result: sessionHandler,
      };
    } catch (error) {
      this.logger.error('Failed to start debug session', { error, config });
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Starts a debug session using a named configuration
   *
   * @param configName The name of the configuration to use
   * @returns A promise that resolves to the debug session handler
   * @throws Error if the session cannot be started
   */
  async startSessionByName(
    configName: string,
  ): Promise<DebugResult<DAPSessionHandler>> {
    try {
      this.logger.info(
        `Starting debug session using configuration '${configName}'`,
      );
      const sessionHandler =
        await this.sessionManager.startSessionByConfig(configName);

      return {
        success: true,
        result: sessionHandler,
      };
    } catch (error) {
      this.logger.error(
        `Failed to start debug session using configuration '${configName}'`,
        { error },
      );
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Marks the client as "connected".
   *
   * This method updates an internal flag to signify that the client considers itself in a "connected" state.
   * It's a conceptual counterpart to `disconnect()` and primarily gates the `disconnect()` operation if called before it.
   *
   * **Important Note:** This method does **not** establish any actual network connections to a debug adapter
   * or perform any other I/O. Debug session-specific connections are managed by the `DAPSessionHandler`
   * when a session is initiated via `startSession()` or `startSessionByName()`. The `SessionManager`
   * handles the lifecycle of these `DAPSessionHandler` instances.
   *
   * This method can be used if your application logic requires an explicit "client active" status.
   *
   * @returns A promise that resolves immediately, as no asynchronous operations are performed.
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      this.logger.warn('Already connected');
      return;
    }

    this.logger.info('Connecting to debug adapter');
    this.isConnected = true;
  }

  /**
   * Disconnects the client and disposes all active debug sessions.
   *
   * This method signals the `SessionManager` to dispose of all currently managed `DAPSessionHandler`
   * instances. Disposing a session typically involves sending a 'disconnect' request to the
   * debug adapter and cleaning up associated resources.
   * It also updates an internal flag to mark the client as "disconnected".
   *
   * This should be called when the application no longer needs to interact with any debug sessions
   * to ensure graceful termination of adapter processes and release of resources.
   *
   * @returns A promise that resolves when the `SessionManager` has attempted to dispose all sessions.
   *          The promise's resolution indicates that the disposal process has been initiated for all
   *          active sessions, not necessarily that all underlying adapter processes have fully terminated.
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      this.logger.warn('Not connected');
      return;
    }

    this.logger.info('Disconnecting from debug adapter');
    await this.sessionManager.disposeAllSessions();
    this.isConnected = false;
  }

  /**
   * Gets the session manager
   *
   * @returns The session manager
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }
}

// Export core classes
export {
  SessionManager,
  AdapterProcessError,
  AdapterProcessErrorBuilder,
} from './sessionManager';
export { DAPSessionHandler } from './dapSessionHandler';
export { ConfigManager } from './config/configManager';
export { AdapterConfigLoader } from './config/adapterConfigLoader';
export { LaunchConfigLoader } from './config/launchConfigLoader';
export { DAPProtocolClient, DAPRequestError } from './dapProtocolClient';
export { DAPRequestBuilder } from './dapRequestBuilder';
export {
  DebugSession,
  BreakpointConfigBuilder,
  DebugSessionError,
  BreakpointError,
  EvaluationError,
  InvalidStateError,
} from './debugSession';

// Export interfaces and types
export type { AdapterConfig } from './sessionManager';
export type { LoggerInterface } from './logging';
export type {
  SessionStatus,
  DAPSessionHandlerEvents,
} from './dapSessionHandler';
export type { LaunchConfig } from './config/launchConfigLoader';
export type { AdapterConfigFile } from './config/adapterConfigLoader';
export type { SessionManagerGlobalConfig } from './sessionManager';
export type { IDAPProtocolClient } from './dapProtocolClient';
export type { DAPRequestBuilderOptions } from './dapRequestBuilder';
export type {
  BreakpointConfig,
  BreakpointResult,
  Breakpoint,
  EvaluationResult,
} from './debugSession';

// Exports for model classes
export { DebugScope } from './model/DebugScope';
export { DebugSource } from './model/DebugSource';
export { DebugStackFrame } from './model/DebugStackFrame';
export { DebugThread } from './model/DebugThread';
export { DebugVariable } from './model/DebugVariable';

export * from './model/model.types';
