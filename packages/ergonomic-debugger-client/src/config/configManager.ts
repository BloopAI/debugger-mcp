import { DebugProtocol } from '@vscode/debugprotocol';
import { LoggerInterface } from '../logging';
import { AdapterConfig } from '../sessionManager';
import { AdapterConfigLoader } from './adapterConfigLoader';
import { LaunchConfigLoader, LaunchConfig } from './launchConfigLoader';

/**
 * Manages debug adapter and launch configurations
 */
export class ConfigManager {
  private readonly logger: LoggerInterface;
  private readonly adapterConfigLoader: AdapterConfigLoader;
  private readonly launchConfigLoader: LaunchConfigLoader;

  private adapterConfigs: Map<string, AdapterConfig> = new Map();
  private launchConfigs: Map<string, LaunchConfig> = new Map();

  /**
   * Creates a new ConfigManager
   * @param logger Logger instance
   */
  constructor(logger: LoggerInterface) {
    this.logger = logger.child
      ? logger.child({ className: 'ConfigManager' })
      : logger;
    this.adapterConfigLoader = new AdapterConfigLoader(this.logger);
    this.launchConfigLoader = new LaunchConfigLoader(this.logger);
  }

  /**
   * Loads adapter configurations from a JSON file
   * @param configPath Path to the adapter configuration file
   */
  public loadAdapterConfigs(configPath: string): void {
    try {
      const configs = this.adapterConfigLoader.loadFromFile(configPath);
      configs.forEach((config) => {
        this.adapterConfigs.set(config.type, config);
      });
      this.logger.info(
        `Loaded ${configs.length} adapter configurations from ${configPath}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to load adapter configurations from ${configPath}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Loads adapter configurations from a VSCode-style launch.json file
   * @param vscodeConfigPath Path to the VSCode launch.json file
   */
  public loadAdapterConfigsFromVSCode(vscodeConfigPath: string): void {
    try {
      const configs =
        this.adapterConfigLoader.loadFromVSCodeConfig(vscodeConfigPath);
      configs.forEach((config) => {
        this.adapterConfigs.set(config.type, config);
      });
      this.logger.info(
        `Loaded ${configs.length} adapter configurations from VSCode config ${vscodeConfigPath}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to load adapter configurations from VSCode config ${vscodeConfigPath}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Loads launch configurations from a JSON file
   * @param configPath Path to the launch configuration file
   */
  public loadLaunchConfigs(configPath: string): void {
    try {
      const configs = this.launchConfigLoader.loadFromFile(configPath);
      configs.forEach((config) => {
        this.launchConfigs.set(config.name, config);
      });
      this.logger.info(
        `Loaded ${configs.length} launch configurations from ${configPath}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to load launch configurations from ${configPath}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Loads launch configurations from a VSCode-style launch.json file
   * @param vscodeConfigPath Path to the VSCode launch.json file
   */
  public loadLaunchConfigsFromVSCode(vscodeConfigPath: string): void {
    try {
      const configs =
        this.launchConfigLoader.loadFromVSCodeConfig(vscodeConfigPath);
      configs.forEach((config) => {
        this.launchConfigs.set(config.name, config);
      });
      this.logger.info(
        `Loaded ${configs.length} launch configurations from VSCode config ${vscodeConfigPath}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to load launch configurations from VSCode config ${vscodeConfigPath}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Gets an adapter configuration by type
   * @param type Adapter type
   * @returns Adapter configuration or undefined if not found
   */
  public getAdapterConfig(type: string): AdapterConfig | undefined {
    return this.adapterConfigs.get(type);
  }

  /**
   * Gets all adapter configurations
   * @returns Array of adapter configurations
   */
  public getAllAdapterConfigs(): AdapterConfig[] {
    return Array.from(this.adapterConfigs.values());
  }

  /**
   * Gets a launch configuration by name
   * @param name Launch configuration name
   * @returns Launch configuration or undefined if not found
   */
  public getLaunchConfig(name: string): LaunchConfig | undefined {
    return this.launchConfigs.get(name);
  }

  /**
   * Gets all launch configurations
   * @returns Array of launch configurations
   */
  public getAllLaunchConfigs(): LaunchConfig[] {
    return Array.from(this.launchConfigs.values());
  }

  /**
   * Registers an adapter configuration
   * @param config Adapter configuration
   */
  public registerAdapterConfig(config: AdapterConfig): void {
    this.adapterConfigs.set(config.type, config);
    this.logger.info(
      `Registered adapter configuration for type '${config.type}'`,
    );
  }

  /**
   * Registers a launch configuration
   * @param config Launch configuration
   */
  public registerLaunchConfig(config: LaunchConfig): void {
    this.launchConfigs.set(config.name, config);
    this.logger.info(`Registered launch configuration '${config.name}'`);
  }

  /**
   * Converts a launch configuration to DAP launch/attach arguments
   * @param configName Name of the launch configuration
   * @returns DAP launch/attach arguments and request type
   */
  public getLaunchArguments(configName: string): {
    args:
      | DebugProtocol.LaunchRequestArguments
      | DebugProtocol.AttachRequestArguments;
    requestType: 'launch' | 'attach';
    adapterType: string;
  } {
    const config = this.launchConfigs.get(configName);
    if (!config) {
      throw new Error(`Launch configuration '${configName}' not found`);
    }

    return {
      args: this.launchConfigLoader.toLaunchArguments(config),
      requestType: config.request,
      adapterType: config.type,
    };
  }
}
