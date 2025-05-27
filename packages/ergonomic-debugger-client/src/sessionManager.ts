import * as child_process from 'child_process';
import { DebugProtocol } from '@vscode/debugprotocol';
import { LoggerInterface } from './logging';
import { DAPProtocolClient, IDAPProtocolClient } from './dapProtocolClient';
import { DAPSessionHandler } from './dapSessionHandler';
import { ConfigManager } from './config/configManager';

/**
 * Configuration for a debug adapter.
 */
export interface AdapterConfig {
  /**
   * Unique type identifier for the adapter (e.g., 'node', 'python').
   */
  type: string;
  /**
   * The command to execute to start the debug adapter.
   */
  command: string;
  /**
   * Optional arguments to pass to the command.
   */
  args?: string[];
  /**
   * Optional environment variables for the adapter process.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Optional current working directory for the adapter process.
   */
  cwd?: string;
  // Future: Add options for different connection types (stdio, socket, etc.)
}

export class AdapterProcessError extends Error {
  constructor(
    message: string,
    public readonly stage: 'spawn' | 'early_exit' | 'stream_setup',
    public readonly adapterType: string,
    public readonly adapterConfig: AdapterConfig,
    public readonly underlyingError?: Error,
    public readonly stderrOutput?: string,
    public readonly exitCode?: number | null,
    public readonly signal?: string | null,
  ) {
    super(message);
    this.name = 'AdapterProcessError';
    Object.setPrototypeOf(this, AdapterProcessError.prototype);
  }
}

export class AdapterProcessErrorBuilder {
  private _message!: string;
  private _stage!: 'spawn' | 'early_exit' | 'stream_setup';
  private _adapterType!: string;
  private _adapterConfig!: AdapterConfig;
  private _underlyingError?: Error;
  private _stderrOutput?: string;
  private _exitCode?: number | null;
  private _signal?: string | null;

  constructor(message: string) {
    this._message = message;
  }

  public stage(stage: 'spawn' | 'early_exit' | 'stream_setup'): this {
    this._stage = stage;
    return this;
  }

  public adapterType(adapterType: string): this {
    this._adapterType = adapterType;
    return this;
  }

  public adapterConfig(adapterConfig: AdapterConfig): this {
    this._adapterConfig = adapterConfig;
    return this;
  }

  public underlyingError(error: Error): this {
    this._underlyingError = error;
    return this;
  }

  public stderrOutput(stderr: string): this {
    this._stderrOutput = stderr;
    return this;
  }

  public exitCode(exitCode: number | null): this {
    this._exitCode = exitCode;
    return this;
  }

  public signal(signal: string | null): this {
    this._signal = signal;
    return this;
  }

  public build(): AdapterProcessError {
    if (!this._message) {
      throw new Error("AdapterProcessErrorBuilder: 'message' is required.");
    }
    if (!this._stage) {
      throw new Error("AdapterProcessErrorBuilder: 'stage' is required.");
    }
    if (!this._adapterType) {
      throw new Error("AdapterProcessErrorBuilder: 'adapterType' is required.");
    }
    if (!this._adapterConfig) {
      throw new Error(
        "AdapterProcessErrorBuilder: 'adapterConfig' is required.",
      );
    }
    return new AdapterProcessError(
      this._message,
      this._stage,
      this._adapterType,
      this._adapterConfig,
      this._underlyingError,
      this._stderrOutput,
      this._exitCode,
      this._signal,
    );
  }
}

/**
 * Optional global configuration for the SessionManager.
 */
export interface SessionManagerGlobalConfig {
  /** Example: Default timeout for certain operations if needed by SessionManager itself */
  defaultOperationTimeoutMs?: number;

  /** Path to adapter configuration file */
  adapterConfigPath?: string;

  /** Path to launch configuration file */
  launchConfigPath?: string;

  /** Path to VSCode launch.json file (can be used instead of separate adapter and launch config files) */
  vscodeConfigPath?: string;
}

/**
 * Represents an active debug session managed by the SessionManager.
 */
interface ActiveSessionEntry {
  handler: DAPSessionHandler;
  process: child_process.ChildProcess;
  adapterType: string; // Store for logging/debugging purposes
}

/**
 * Manages debug adapter configurations, launches adapter processes,
 * and orchestrates DAPSessionHandler instances.
 */
export class SessionManager {
  private readonly logger: LoggerInterface;
  private readonly _adapterConfigurations = new Map<string, AdapterConfig>();
  private readonly activeSessions = new Map<string, ActiveSessionEntry>(); // Keyed by a unique session ID
  private nextSessionId = 1;
  private readonly globalConfig?: SessionManagerGlobalConfig;
  private readonly configManager: ConfigManager;

  /**
   * Creates an instance of SessionManager.
   * @param logger An instance of LoggerInterface for logging.
   * @param globalConfig Optional global configuration for the SessionManager.
   */
  constructor(
    logger: LoggerInterface,
    globalConfig?: SessionManagerGlobalConfig,
  ) {
    this.logger = logger.child
      ? logger.child({ className: 'SessionManager' })
      : logger;
    this.globalConfig = globalConfig;
    this.configManager = new ConfigManager(this.logger);

    this.logger.info('SessionManager initialized.');

    if (this.globalConfig) {
      this.logger.info('Global config provided:', this.globalConfig);

      // Load configurations if paths are provided
      this.loadConfigurationsFromGlobalConfig();
    }
  }

  /**
   * Loads configurations from the global config if paths are provided
   */
  private loadConfigurationsFromGlobalConfig(): void {
    if (!this.globalConfig) return;

    try {
      // Load from VSCode config if provided
      if (this.globalConfig.vscodeConfigPath) {
        this.logger.info(
          `Loading configurations from VSCode config: ${this.globalConfig.vscodeConfigPath}`,
        );
        this.configManager.loadLaunchConfigsFromVSCode(
          this.globalConfig.vscodeConfigPath,
        );
        this.configManager.loadAdapterConfigsFromVSCode(
          this.globalConfig.vscodeConfigPath,
        );

        // Register all adapter configs
        this.configManager.getAllAdapterConfigs().forEach((config) => {
          this.registerAdapterConfiguration(config);
        });
      } else {
        // Load from separate config files if provided
        if (this.globalConfig.adapterConfigPath) {
          this.logger.info(
            `Loading adapter configurations from: ${this.globalConfig.adapterConfigPath}`,
          );
          this.configManager.loadAdapterConfigs(
            this.globalConfig.adapterConfigPath,
          );

          // Register all adapter configs
          this.configManager.getAllAdapterConfigs().forEach((config) => {
            this.registerAdapterConfiguration(config);
          });
        }

        if (this.globalConfig.launchConfigPath) {
          this.logger.info(
            `Loading launch configurations from: ${this.globalConfig.launchConfigPath}`,
          );
          this.configManager.loadLaunchConfigs(
            this.globalConfig.launchConfigPath,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'Error loading configurations from global config',
        error,
      );
      // Don't throw here, just log the error and continue
    }
  }

  /**
   * Registers a debug adapter configuration.
   * @param config The adapter configuration to register.
   */
  public registerAdapterConfiguration(config: AdapterConfig): void {
    if (!config || !config.type || !config.command) {
      this.logger.error('Invalid adapter configuration provided.', { config });
      throw new Error(
        'Invalid adapter configuration: type and command are required.',
      );
    }
    if (this._adapterConfigurations.has(config.type)) {
      this.logger.warn(
        `Adapter configuration for type '${config.type}' is being overwritten.`,
      );
    }
    this._adapterConfigurations.set(config.type, config);
    this.logger.info(
      `Adapter configuration registered for type '${config.type}'.`,
      { command: config.command },
    );
  }

  /**
   * Returns a map of registered adapter configurations.
   * @returns A `Map` where keys are adapter types (strings) and values are `AdapterConfig` objects.
   */
  public get adapterConfigurations(): ReadonlyMap<string, AdapterConfig> {
    return this._adapterConfigurations;
  }

  /**
   * Returns the ConfigManager instance.
   * Primarily for testing or tightly coupled extensions.
   * @returns The ConfigManager instance.
   */
  protected getConfigManager(): ConfigManager {
    return this.configManager;
  }

  /**
   * Starts a new debug session.
   * @param adapterType The type of the debug adapter to start (must be registered).
   * @param launchArgs The launch or attach arguments for the debug session.
   * @param launchMode Whether to 'launch' a new process or 'attach' to an existing one.
   * @returns A Promise that resolves with the DAPSessionHandler instance upon successful session establishment.
   */
  /**
   * Starts a new debug session using a named launch configuration.
   * @param configName The name of the launch configuration to use.
   * @returns A Promise that resolves with the DAPSessionHandler instance upon successful session establishment.
   */
  public async startSessionByConfig(
    configName: string,
  ): Promise<DAPSessionHandler> {
    this.logger.info(
      `Attempting to start session using launch configuration '${configName}'`,
    );

    const launchConfig = this.configManager.getLaunchConfig(configName);
    if (!launchConfig) {
      const errMsg = `Launch configuration not found: '${configName}'`;
      this.logger.error(errMsg);
      throw new Error(errMsg);
    }

    const { args, requestType, adapterType } =
      this.configManager.getLaunchArguments(configName);

    return this.startSession(adapterType, args, requestType);
  }

  /**
   * Starts a new debug session.
   * @param adapterType The type of the debug adapter to start (must be registered).
   * @param launchArgs The launch or attach arguments for the debug session.
   * @param launchMode Whether to 'launch' a new process or 'attach' to an existing one.
   * @returns A Promise that resolves with the DAPSessionHandler instance upon successful session establishment.
   */
  public async startSession(
    adapterType: string,
    launchArgs:
      | DebugProtocol.LaunchRequestArguments
      | DebugProtocol.AttachRequestArguments,
    launchMode: 'launch' | 'attach',
  ): Promise<DAPSessionHandler> {
    this.logger.info(
      `Attempting to start session for adapter type '${adapterType}' in '${launchMode}' mode.`,
      { launchArgs },
    );

    const adapterConfig = this._adapterConfigurations.get(adapterType);
    if (!adapterConfig) {
      const errMsg = `Adapter configuration not found for type '${adapterType}'.`;
      this.logger.error(errMsg);
      throw new Error(errMsg);
    }
    this.logger.info(`Found adapter configuration for '${adapterType}':`, {
      command: adapterConfig.command,
      args: adapterConfig.args,
    });

    let adapterProcess: child_process.ChildProcess;
    try {
      adapterProcess = await this._spawnAdapterProcess(
        adapterConfig,
        adapterType,
      );
      // _setupAdapterProcessListeners is called after successful spawn.
      this._setupAdapterProcessListeners(adapterProcess, adapterType);
    } catch (error: unknown) {
      if (error instanceof AdapterProcessError) {
        this.logger.error(
          `AdapterProcessError starting session for '${adapterType}': ${error.message}`,
          {
            stage: error.stage,
            adapterType: error.adapterType,
            underlyingErrorMessage: error.underlyingError?.message,
            stderrOutput: error.stderrOutput,
            exitCode: error.exitCode,
            signal: error.signal,
            stack: error.stack,
          },
        );
        throw error;
      }
      // Fallback for other unexpected errors during spawn/setup
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const wrappedError = new Error(
        `Session setup failed for '${adapterType}': Failed to start adapter process. Original error: ${errorMessage}`,
      );
      if (error instanceof Error) {
        (wrappedError as Error & { cause?: Error }).cause = error;
      }
      this.logger.error(wrappedError.message, {
        originalError: error,
        stack: (error as Error)?.stack,
      });
      throw wrappedError;
    }

    const protocolClient = this._createProtocolClientAndConnect(
      adapterProcess,
      adapterType,
      adapterConfig,
    );
    const sessionId = `session-${this.nextSessionId++}`;

    try {
      const sessionHandler = await this._createAndInitializeSessionHandler(
        protocolClient,
        adapterType,
        sessionId,
        launchArgs,
        launchMode,
      );

      this.activeSessions.set(sessionId, {
        handler: sessionHandler,
        process: adapterProcess,
        adapterType,
      });
      this.logger.info(
        `Session '${sessionId}' (type: ${adapterType}) added to active sessions. Total active: ${this.activeSessions.size}.`,
      );

      // Listen for session end to clean up
      sessionHandler.on('sessionEnded', (payload) =>
        this.handleSessionEnd(sessionId, payload.reason),
      );
      sessionHandler.on('error', (payload) => {
        this.logger.error(
          `Error event from DAPSessionHandler for session '${sessionId}':`,
          { message: payload.error.message, stack: payload.error.stack },
        );
        // DAPSessionHandler should manage its state and emit 'sessionEnded' if the error is fatal.
      });

      return sessionHandler;
    } catch (error: unknown) {
      const setupErrorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Error during session setup for adapter '${adapterType}', session ID '${sessionId}'. Cleaning up.`,
        { error: setupErrorMessage, stack: errorStack, launchArgs },
      );
      // Ensure the adapter process is terminated if session setup fails at this stage
      if (adapterProcess && !adapterProcess.killed) {
        adapterProcess.kill();
        this.logger.info(
          `Killed adapter process PID ${adapterProcess.pid} due to session setup failure.`,
        );
      }
      // Remove from active sessions if it was partially added
      if (this.activeSessions.has(sessionId)) {
        this.activeSessions.delete(sessionId);
        this.logger.info(
          `Removed session '${sessionId}' from active sessions due to setup failure.`,
        );
      }
      if (protocolClient && protocolClient.isConnected()) {
        protocolClient.dispose(); // Clean up protocol client resources
      }
      // Re-throw the original error or a new error wrapping it
      const finalErrorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Session setup failed for '${adapterType}': ${finalErrorMessage}`,
      );
    }
  }

  /**
   * Handles the end of a debug session.
   * @param sessionId The ID of the session that ended.
   * @param reason Optional reason for session end.
   */
  private handleSessionEnd(sessionId: string, reason?: string): void {
    const sessionData = this.activeSessions.get(sessionId);
    if (sessionData) {
      this.logger.info(
        `Session '${sessionId}' ended. Reason: ${reason || 'N/A'}. Removing from active sessions.`,
      );
      this.activeSessions.delete(sessionId);

      const { process: adapterProcess } = sessionData;
      if (adapterProcess && !adapterProcess.killed) {
        this.logger.info(
          `Terminating adapter process PID ${adapterProcess.pid} for ended session '${sessionId}'.`,
        );
        adapterProcess.kill();
      }
      // DAPSessionHandler does not have a public dispose() method.
      // Its cleanup is internal, triggered by events leading to handleSessionTermination.
      this.logger.info(`Total active sessions: ${this.activeSessions.size}.`);
    } else {
      this.logger.warn(
        `Received sessionEnded event for unknown or already removed session ID '${sessionId}'.`,
      );
    }
  }

  /**
   * Disposes all active debug sessions and terminates their adapter processes.
   */
  public async disposeAllSessions(): Promise<void> {
    this.logger.info(
      `Disposing all ${this.activeSessions.size} active sessions.`,
    );
    const disposalPromises: Promise<void>[] = [];

    this.activeSessions.forEach((sessionData, sessionId) => {
      this.logger.info(`Disposing session '${sessionId}'...`);
      // Attempt to gracefully disconnect first, then kill process
      const disposePromise = (async () => {
        try {
          // Attempt to gracefully disconnect. DAPSessionHandler.disconnect() will update its status
          // and the adapter should eventually send 'terminated' or 'exited', or close streams,
          // which will trigger handleSessionEnd for actual cleanup.
          this.logger.info(
            `Attempting graceful disconnect for session '${sessionId}'...`,
          );
          await sessionData.handler.disconnect();
        } catch (error: unknown) {
          const disconnectErrorMessage =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Error during graceful disconnect request for session '${sessionId}': ${disconnectErrorMessage}. Forcing termination.`,
            { error },
          );
          // If disconnect fails or if we need to be more forceful:
          if (sessionData.process && !sessionData.process.killed) {
            this.logger.info(
              `Terminating adapter process PID ${sessionData.process.pid} for session '${sessionId}' due to disconnect error or forceful disposal.`,
            );
            sessionData.process.kill();
            // Killing the process should lead to events that DAPSessionHandler handles for cleanup.
          }
        }
        // sessionData.handler.dispose() is not public; cleanup is internal to DAPSessionHandler.
      })();
      disposalPromises.push(disposePromise);
    });

    await Promise.allSettled(disposalPromises);
    this.activeSessions.clear();
    this.logger.info('All active sessions have been processed for disposal.');
  }

  /**
   * Spawns the debug adapter process.
   * @param adapterConfig The configuration for the adapter.
   * @param adapterType The type of the adapter (for logging).
   * @returns A Promise resolving with the spawned child process, or rejecting if spawning fails with AdapterProcessError.
   */
  private _spawnAdapterProcess(
    adapterConfig: AdapterConfig,
    adapterType: string,
  ): Promise<child_process.ChildProcess> {
    return new Promise((resolve, reject) => {
      const errMsgPrefix = `Failed to spawn debug adapter process for '${adapterType}'. Command: ${adapterConfig.command}`;
      let stderrOutput = '';
      let promiseSettled = false;

      let adapterProcess: child_process.ChildProcess | undefined = undefined;

      // Define handlers for spawn-time events
      const spawnErrorHandler = (spawnError: Error) => {
        if (promiseSettled) return;
        promiseSettled = true;
        this.logger.error(`${errMsgPrefix}: Process emitted 'error' event.`, {
          originalError: spawnError.message,
          stack: spawnError.stack,
          stderr: stderrOutput,
        });

        if (adapterProcess) {
          // Clean up if process object exists
          adapterProcess.removeAllListeners(); // Remove all listeners to prevent further events
          adapterProcess.unref(); // Allow parent to exit if this was the only handle
        }

        reject(
          new AdapterProcessErrorBuilder(
            `${errMsgPrefix}: ${spawnError.message}`,
          )
            .stage('spawn')
            .adapterType(adapterType)
            .adapterConfig(adapterConfig)
            .underlyingError(spawnError)
            .stderrOutput(stderrOutput)
            .build(),
        );
      };

      const prematureExitHandler = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (promiseSettled) return;
        promiseSettled = true;
        this.logger.error(
          `${errMsgPrefix}: Process exited prematurely. Code: ${code}, Signal: ${signal}.`,
          { stderr: stderrOutput },
        );

        if (adapterProcess) {
          adapterProcess.removeAllListeners();
          adapterProcess.unref();
        }

        const builder = new AdapterProcessErrorBuilder(
          `${errMsgPrefix}: Process exited prematurely. Code: ${code}, Signal: ${signal}`,
        )
          .stage('early_exit')
          .adapterType(adapterType)
          .adapterConfig(adapterConfig)
          .stderrOutput(stderrOutput);
        if (code !== null) builder.exitCode(code);
        if (signal) builder.signal(signal);
        reject(builder.build());
      };

      try {
        const spawnOptions: child_process.SpawnOptions = {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...adapterConfig.env },
          detached: false,
        };
        if (adapterConfig.cwd) {
          spawnOptions.cwd = adapterConfig.cwd;
          this.logger.info(
            `Setting CWD for adapter '${adapterType}' to '${adapterConfig.cwd}'`,
          );
        }

        adapterProcess = child_process.spawn(
          adapterConfig.command,
          adapterConfig.args ?? [],
          spawnOptions,
        );

        // Attach listeners immediately
        adapterProcess.on('error', spawnErrorHandler);
        adapterProcess.on('exit', prematureExitHandler);

        if (adapterProcess.stderr) {
          adapterProcess.stderr.on('data', (data) => {
            stderrOutput += data.toString();
          });
          adapterProcess.stderr.on('error', (err) => {
            // Log stderr stream errors but don't necessarily reject the promise for them
            this.logger.error(`${errMsgPrefix}: stderr stream error.`, {
              originalError: err.message,
              stderrOutput,
            });
          });
        }

        // If we reach here, spawn was initiated, we have a PID.
        // The 'error' or 'exit' listeners above will handle failures before this point.
        if (promiseSettled) return; // If an error/exit occurred almost immediately

        // This block is entered if no synchronous spawn error occurred and
        // no 'error' or 'exit' event has settled the promise yet.
        if (adapterProcess.pid) {
          // PID exists, this is a good sign. We will resolve.
          const successLog = `Adapter process for '${adapterType}' spawned successfully with PID: ${adapterProcess.pid}.`;
          this.logger.info(successLog);

          // Remove spawn-time listeners as we are resolving.
          // These listeners are only for catching initial spawn/exit problems.
          // _setupAdapterProcessListeners will attach ongoing lifecycle listeners later.
          adapterProcess.removeListener('error', spawnErrorHandler);
          adapterProcess.removeListener('exit', prematureExitHandler);
          if (adapterProcess.stderr) {
            // Clear only the listeners specifically attached by _spawnAdapterProcess for stderr capture during spawn.
            // Assuming 'data' and 'error' on stderr were the ones for capturing initial stderrOutput.
            adapterProcess.stderr.removeAllListeners('data');
            adapterProcess.stderr.removeAllListeners('error');
          }

          promiseSettled = true; // Mark as settled *before* resolving
          resolve(adapterProcess);
        } else {
          // PID is undefined, typical for immediate spawn failures (e.g., ENOENT).
          // Wait for 'error' or 'exit' event handlers to reject the promise.
          this.logger.debug(
            `Adapter process for '${adapterType}' spawned, but PID is initially undefined. Waiting for 'error' or 'exit' event.`,
          );
        }
      } catch (syncSpawnError: unknown) {
        // Catches synchronous errors from child_process.spawn() itself
        if (promiseSettled) return;
        promiseSettled = true;
        const err =
          syncSpawnError instanceof Error
            ? syncSpawnError
            : new Error(String(syncSpawnError));
        this.logger.error(
          `${errMsgPrefix}: Synchronous error during child_process.spawn.`,
          {
            originalError: err.message,
            stack: err.stack,
            stderr: stderrOutput,
          },
        );

        if (adapterProcess) {
          // If adapterProcess was created before sync error (unlikely for spawn itself)
          adapterProcess.removeAllListeners();
          adapterProcess.unref();
        }

        reject(
          new AdapterProcessErrorBuilder(`${errMsgPrefix}: ${err.message}`)
            .stage('spawn')
            .adapterType(adapterType)
            .adapterConfig(adapterConfig)
            .underlyingError(err)
            .stderrOutput(stderrOutput)
            .build(),
        );
      }
    });
  }

  /**
   * Sets up event listeners for the adapter process *after* it has successfully spawned.
   * @param adapterProcess The child process of the debug adapter.
   * @param adapterType The type of the adapter (for logging).
   */
  private _setupAdapterProcessListeners(
    adapterProcess: child_process.ChildProcess,
    adapterType: string,
  ): void {
    this.logger.debug(
      `Setting up ongoing listeners for adapter process [${adapterType}, PID: ${adapterProcess.pid}]`,
    );
    let accumulatedStderrForLogging = ''; // For logging full stderr on close, separate from early spawn stderr.

    // Stdout: Primarily for DAPProtocolClient, but log errors/closure.
    if (adapterProcess.stdout) {
      adapterProcess.stdout.on('error', (err: Error) => {
        this.logger.error(
          `Adapter [${adapterType}, PID: ${adapterProcess.pid}] stdout stream ERROR (post-spawn): ${err.message}`,
          { error: err },
        );
      });
      adapterProcess.stdout.on('close', () => {
        this.logger.info(
          `Adapter [${adapterType}, PID: ${adapterProcess.pid}] stdout stream CLOSED (post-spawn).`,
        );
      });
      if (this.logger.trace) {
        adapterProcess.stdout.on('data', (data: Buffer) => {
          const outputStr = data.toString();
          this.logger.trace(
            `Adapter [${adapterType}, PID: ${adapterProcess.pid}] stdout (post-spawn): ${outputStr.substring(0, 100)}${outputStr.length > 100 ? '...' : ''}`,
          );
        });
      }
    } else {
      this.logger.warn(
        `Adapter [${adapterType}, PID: ${adapterProcess.pid}] has no stdout stream (post-spawn).`,
      );
    }

    // Stdin: Primarily for DAPProtocolClient, but log errors/closure.
    if (adapterProcess.stdin) {
      adapterProcess.stdin.on('error', (err: Error) => {
        this.logger.error(
          `Adapter [${adapterType}, PID: ${adapterProcess.pid}] stdin stream ERROR (post-spawn): ${err.message}`,
          { error: err },
        );
      });
      adapterProcess.stdin.on('close', () => {
        this.logger.info(
          `Adapter [${adapterType}, PID: ${adapterProcess.pid}] stdin stream CLOSED (post-spawn).`,
        );
      });
    } else {
      this.logger.warn(
        `Adapter [${adapterType}, PID: ${adapterProcess.pid}] has no stdin stream (post-spawn).`,
      );
    }

    // Stderr: Log data, errors, and closure.
    if (adapterProcess.stderr) {
      adapterProcess.stderr.on('data', (data: Buffer) => {
        const strData = data.toString();
        accumulatedStderrForLogging += strData;
        this.logger.warn(
          `Adapter [${adapterType}, PID: ${adapterProcess.pid}] STDERR (post-spawn): ${strData.trim()}`,
        );
      });
      adapterProcess.stderr.on('error', (err: Error) => {
        this.logger.error(
          `Adapter [${adapterType}, PID: ${adapterProcess.pid}] stderr stream ERROR (post-spawn): ${err.message}`,
          { error: err },
        );
      });
      this.logger.warn(
        `Adapter [${adapterType}, PID: ${adapterProcess.pid}] has no stdout stream (post-spawn).`,
      );
    }

    // Stdin: Primarily for DAPProtocolClient, but log errors/closure.
    if (adapterProcess.stdin) {
      adapterProcess.stdin.on('error', (err: Error) => {
        this.logger.error(
          `Adapter [${adapterType}, PID: ${adapterProcess.pid}] stdin stream ERROR (post-spawn): ${err.message}`,
          { error: err },
        );
      });
      adapterProcess.stdin.on('close', () => {
        this.logger.info(
          `Adapter [${adapterType}, PID: ${adapterProcess.pid}] stdin stream CLOSED (post-spawn).`,
        );
      });
    } else {
      this.logger.warn(
        `Adapter [${adapterType}, PID: ${adapterProcess.pid}] has no stdin stream (post-spawn).`,
      );
    }

    // Stderr: Log data, errors, and closure.
    if (adapterProcess.stderr) {
      adapterProcess.stderr.on('data', (data: Buffer) => {
        const strData = data.toString();
        accumulatedStderrForLogging += strData;
        this.logger.warn(
          `Adapter [${adapterType}, PID: ${adapterProcess.pid}] STDERR (post-spawn): ${strData.trim()}`,
        );
      });
      adapterProcess.stderr.on('error', (err: Error) => {
        this.logger.error(
          `Adapter [${adapterType}, PID: ${adapterProcess.pid}] stderr stream ERROR (post-spawn): ${err.message}`,
          { error: err },
        );
      });
      adapterProcess.stderr.on('close', () => {
        this.logger.info(
          `Adapter [${adapterType}, PID: ${adapterProcess.pid}] stderr stream CLOSED (post-spawn). Full stderr for this session (post-spawn): ${accumulatedStderrForLogging.trim()}`,
        );
      });
    } else {
      this.logger.warn(
        `Adapter [${adapterType}, PID: ${adapterProcess.pid}] has no stderr stream (post-spawn).`,
      );
    }

    // Process-level 'error' and 'exit' are crucial.
    // DAPSessionHandler also derives session end from protocol client events (close, exited DAP event).
    // These listeners provide a safety net and logging.
    adapterProcess.on('error', (err) => {
      // This listener is distinct from the one in _spawnAdapterProcess used for spawn-time errors.
      // This handles errors on the process object *after* successful spawning.
      this.logger.error(
        `Adapter process [${adapterType}, PID: ${adapterProcess.pid}] emitted PROCESS 'error' event (post-spawn): ${err.message}`,
        { error: err },
      );
      // This error might lead to stream closures, which DAPSessionHandler should handle to terminate the session.
    });

    adapterProcess.on('exit', (code, signal) => {
      // This listener is distinct from the one in _spawnAdapterProcess used for premature exits.
      // This handles exits *after* successful spawning.
      this.logger.info(
        `Adapter process [${adapterType}, PID: ${adapterProcess.pid}] 'exit' event (post-spawn). Code: ${code}, Signal: ${signal}.`,
      );
      // DAPSessionHandler's 'exited' event (derived from DAPProtocolClient) is the primary mechanism for session termination logic.
    });

    // The 'close' event on the process fires after all stdio streams have been closed.
    adapterProcess.on('close', (code, signal) => {
      this.logger.info(
        `Adapter process [${adapterType}, PID: ${adapterProcess.pid}] PROCESS 'close' event (all stdio streams closed, post-spawn). Code: ${code}, Signal: ${signal}.`,
      );
    });
  }

  /**
   * Creates a DAPProtocolClient and connects it to the adapter process streams.
   * @param adapterProcess The spawned adapter process.
   * @param adapterType The type of the adapter (for logging).
   * @returns The connected DAPProtocolClient.
   * @throws AdapterProcessError if connection fails.
   */
  private _createProtocolClientAndConnect(
    adapterProcess: child_process.ChildProcess,
    adapterType: string,
    adapterConfig: AdapterConfig, // Added for AdapterProcessError
  ): IDAPProtocolClient {
    const protocolClientLogger = this.logger.child
      ? this.logger.child({ component: 'DAPProtocolClient', adapterType })
      : this.logger;
    const protocolClient = new DAPProtocolClient(protocolClientLogger);
    this.logger.info(
      `DAPProtocolClient instantiated for adapter '${adapterType}'.`,
    );
    // Stderr captured during _spawnAdapterProcess is not directly available here
    // unless passed explicitly. For 'stream_setup' errors, stderr from the spawn phase
    // might be less relevant than immediate issues with the streams themselves.
    // We'll use an empty string for now for stderrOutput in AdapterProcessError from this function.
    const currentStderrOutput = ''; // Or retrieve from adapterProcess if a mechanism is added

    if (!adapterProcess.stdout || !adapterProcess.stdin) {
      const errMsg = `Adapter process for '${adapterType}' is missing stdout or stdin streams. PID: ${adapterProcess.pid}`;
      this.logger.error(errMsg);
      if (adapterProcess && !adapterProcess.killed) adapterProcess.kill(); // Ensure process is killed
      throw (
        new AdapterProcessErrorBuilder(errMsg)
          .stage('stream_setup')
          .adapterType(adapterType)
          .adapterConfig(adapterConfig)
          // No specific underlyingError here, the error is missing streams
          .stderrOutput(currentStderrOutput)
          .build()
      );
    }

    try {
      protocolClient.connect(adapterProcess.stdout, adapterProcess.stdin);
      this.logger.info(
        `DAPProtocolClient connected to adapter '${adapterType}' I/O streams.`,
      );
      return protocolClient;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const errMsg = `Error connecting DAPProtocolClient to adapter '${adapterType}' streams: ${err.message}`;
      this.logger.error(errMsg, {
        originalError: err.message,
        stack: err.stack,
      });
      if (adapterProcess && !adapterProcess.killed) {
        this.logger.info(
          `Killing adapter process PID ${adapterProcess.pid} due to DAPProtocolClient connection failure.`,
        );
        adapterProcess.kill();
      }
      throw new AdapterProcessErrorBuilder(errMsg)
        .stage('stream_setup')
        .adapterType(adapterType)
        .adapterConfig(adapterConfig)
        .underlyingError(err)
        .stderrOutput(currentStderrOutput)
        .build();
    }
  }
  /**
   * Creates, initializes, and launches/attaches a DAPSessionHandler.
   * @param protocolClient The connected DAPProtocolClient.
   * @param adapterType The type of the adapter.
   * @param sessionId The unique ID for this session.
   * @param launchArgs The launch or attach arguments.
   * @param launchMode The mode ('launch' or 'attach').
   * @returns The configured DAPSessionHandler.
   * @throws Error if any step fails.
   */
  private async _createAndInitializeSessionHandler(
    protocolClient: IDAPProtocolClient,
    adapterType: string,
    sessionId: string,
    launchArgs:
      | DebugProtocol.LaunchRequestArguments
      | DebugProtocol.AttachRequestArguments,
    launchMode: 'launch' | 'attach',
  ): Promise<DAPSessionHandler> {
    const sessionHandlerLogger = this.logger.child
      ? this.logger.child({
          component: 'DAPSessionHandler',
          sessionId,
          adapterType,
        })
      : this.logger;
    const sessionHandler = new DAPSessionHandler(
      protocolClient,
      sessionHandlerLogger,
    );
    this.logger.info(
      `DAPSessionHandler instantiated for adapter '${adapterType}', session ID '${sessionId}'.`,
    );

    // Define standard initialization arguments
    const initializeArgs: DebugProtocol.InitializeRequestArguments = {
      adapterID: adapterType,
      clientID: 'ergonomic-debugger-client',
      clientName: 'Ergonomic Debugger Client',
      locale: 'en-US', // TODO: Make configurable?
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: true,
      pathFormat: 'path', // Required by many debug adapters
      // ... any other common/default InitializeRequestArguments
    };

    // Step 1: Send initialize request. DAPSessionHandler.initialize() will set status to 'initializing'.
    await sessionHandler.initialize(initializeArgs);
    this.logger.info(
      `DAP 'initialize' request for session '${sessionId}' completed. DAPSessionHandler status: ${sessionHandler.status}.`,
    );

    // Step 2: Set up listeners for adapterInitializedAndConfigured, sessionEnded, and error
    // *before* sending launch/attach and configurationDone, to prevent race conditions.
    const adapterReadyPromise = new Promise<void>((resolve, reject) => {
      const timeoutValue =
        this.globalConfig?.defaultOperationTimeoutMs || 15000;
      let timeout: NodeJS.Timeout | undefined = setTimeout(() => {
        timeout = undefined; // Clear timeout variable
        reject(
          new Error(
            `Timeout waiting for 'adapterInitializedAndConfigured' event from session '${sessionId}' after ${launchMode} request. Timeout: ${timeoutValue}ms. Current DAPSessionHandler status: ${sessionHandler.status}. Check DAPSessionHandler logs for potential 'configurationDone' issues if applicable.`,
          ),
        );
      }, timeoutValue);

      const cleanupListeners = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        // 'once' listeners remove themselves after firing.
      };

      sessionHandler.once('adapterInitializedAndConfigured', () => {
        if (!timeout) return; // Already timed out or resolved/rejected
        this.logger.info(
          `Session '${sessionId}' adapter is initialized and configured. DAPSessionHandler status: ${sessionHandler.status}.`,
        );
        cleanupListeners();
        resolve();
      });
      sessionHandler.once('sessionEnded', (payload) => {
        if (!timeout) return; // Already timed out or resolved/rejected
        this.logger.warn(
          `Session '${sessionId}' ended prematurely (reason: ${payload.reason}) while waiting for adapter to be configured post-${launchMode}.`,
        );
        cleanupListeners();
        reject(
          new Error(
            `Session '${sessionId}' ended prematurely (reason: ${payload.reason}) while waiting for adapter to be configured post-${launchMode}.`,
          ),
        );
      });
      sessionHandler.once('error', (payload) => {
        if (!timeout) return; // Already timed out or resolved/rejected
        this.logger.error(
          `Session '${sessionId}' encountered an error (message: ${payload.error.message}) while waiting for adapter to be configured post-${launchMode}.`,
        );
        cleanupListeners();
        reject(
          new Error(
            `Session '${sessionId}' encountered an error (message: ${payload.error.message}) while waiting for adapter to be configured post-${launchMode}.`,
          ),
        );
      });
    });

    // Step 3: Send launch/attach request and await its acknowledgment.
    if (launchMode === 'launch') {
      const launchRequestArgs =
        launchArgs as DebugProtocol.LaunchRequestArguments;
      if (typeof launchRequestArgs.noDebug === 'undefined') {
        launchRequestArgs.noDebug = false;
      }
      await sessionHandler.launch(launchRequestArgs);
      this.logger.info(
        `Session '${sessionId}' ${launchMode} request sent and acknowledged by adapter.`,
      );
    } else {
      // attach
      await sessionHandler.attach(
        launchArgs as DebugProtocol.AttachRequestArguments,
      );
      this.logger.info(
        `Session '${sessionId}' ${launchMode} request sent and acknowledged by adapter.`,
      );
    }

    // Step 4: If adapter supports configurationDoneRequest, send it now.
    const capabilities = sessionHandler.getAdapterCapabilities();
    if (capabilities.supportsConfigurationDoneRequest) {
      this.logger.info(
        `Adapter for session '${sessionId}' supports 'configurationDone'. Sending it now after ${launchMode} was acknowledged.`,
      );
      try {
        await sessionHandler.configurationDone();
        this.logger.info(
          `'configurationDone' request sent successfully for session '${sessionId}' after ${launchMode} was acknowledged.`,
        );
      } catch (configDoneError: unknown) {
        const configErrorMessage =
          configDoneError instanceof Error
            ? configDoneError.message
            : String(configDoneError);
        this.logger.warn(
          `Error sending 'configurationDone' for session '${sessionId}' after ${launchMode} was acknowledged. This might be ok.`,
          { error: configErrorMessage },
        );
        // Do not rethrow; allow adapterReadyPromise to handle overall success/failure.
      }
    } else {
      this.logger.info(
        `Adapter for session '${sessionId}' does not support 'configurationDone'. Skipping.`,
      );
    }

    // Step 5: Await the promise that listens for adapterInitializedAndConfigured (or errors/session end).
    this.logger.info(
      `Session '${sessionId}' ${launchMode} and configurationDone (if applicable) processed. Waiting for adapter to be fully initialized and configured...`,
    );
    await adapterReadyPromise;

    this.logger.info(
      `Session '${sessionId}' is fully ready and ${launchMode} process is underway. DAPSessionHandler status: ${sessionHandler.status}.`,
    );
    return sessionHandler;
  }
}
