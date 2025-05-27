import * as fs from 'fs';
import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';
import { LoggerInterface } from '../logging';

/**
 * Interface for launch configuration file format
 */
export interface LaunchConfigFile {
  configurations: LaunchConfig[];
}

/**
 * Interface for a launch configuration
 */
export interface LaunchConfig {
  /**
   * Name of the configuration
   */
  name: string;

  /**
   * Type of the debug adapter to use
   */
  type: string;

  /**
   * Request type: 'launch' or 'attach'
   */
  request: 'launch' | 'attach';

  /**
   * Additional configuration properties specific to the debug adapter
   */
  [key: string]: unknown;
}

/**
 * Loads launch configurations from a JSON file
 */
export class LaunchConfigLoader {
  private readonly logger: LoggerInterface;

  /**
   * Creates a new LaunchConfigLoader
   * @param logger Logger instance
   */
  constructor(logger: LoggerInterface) {
    this.logger = logger.child
      ? logger.child({ className: 'LaunchConfigLoader' })
      : logger;
  }

  /**
   * Loads launch configurations from a JSON file
   * @param configPath Path to the launch configuration file
   * @returns Array of launch configurations
   */
  public loadFromFile(configPath: string): LaunchConfig[] {
    try {
      this.logger.info(`Loading launch configurations from ${configPath}`);

      // Resolve path if it's relative
      const resolvedPath = path.isAbsolute(configPath)
        ? configPath
        : path.resolve(process.cwd(), configPath);

      if (!fs.existsSync(resolvedPath)) {
        this.logger.error(
          `Launch configuration file not found: ${resolvedPath}`,
        );
        throw new Error(`Launch configuration file not found: ${resolvedPath}`);
      }

      const fileContent = fs.readFileSync(resolvedPath, 'utf8');
      const config = JSON.parse(fileContent) as LaunchConfigFile;

      if (!config.configurations || !Array.isArray(config.configurations)) {
        this.logger.error(
          'Invalid launch configuration file format: missing or invalid "configurations" property',
        );
        throw new Error(
          'Invalid launch configuration file format: missing or invalid "configurations" property',
        );
      }

      // Validate each configuration
      config.configurations.forEach((launchConfig, index) => {
        if (!launchConfig.name) {
          this.logger.warn(
            `Launch configuration at index ${index} is missing a name, adding a default name`,
          );
          launchConfig.name = `Configuration ${index + 1}`;
        }

        if (!launchConfig.type) {
          this.logger.error(
            `Launch configuration "${launchConfig.name}" is missing required property "type"`,
          );
          throw new Error(
            `Launch configuration "${launchConfig.name}" is missing required property "type"`,
          );
        }

        if (
          !launchConfig.request ||
          (launchConfig.request !== 'launch' &&
            launchConfig.request !== 'attach')
        ) {
          this.logger.error(
            `Launch configuration "${launchConfig.name}" has invalid "request" property. Must be "launch" or "attach"`,
          );
          throw new Error(
            `Launch configuration "${launchConfig.name}" has invalid "request" property. Must be "launch" or "attach"`,
          );
        }
      });

      this.logger.info(
        `Loaded ${config.configurations.length} launch configurations`,
      );
      return config.configurations;
    } catch (error) {
      this.logger.error('Error loading launch configurations', error);
      throw new Error(
        `Failed to load launch configurations: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Loads launch configurations from a VSCode-style launch.json file
   * @param vscodeConfigPath Path to the VSCode launch.json file
   * @returns Array of launch configurations
   */
  public loadFromVSCodeConfig(vscodeConfigPath: string): LaunchConfig[] {
    try {
      this.logger.info(
        `Loading launch configurations from VSCode config: ${vscodeConfigPath}`,
      );

      // Resolve path if it's relative
      const resolvedPath = path.isAbsolute(vscodeConfigPath)
        ? vscodeConfigPath
        : path.resolve(process.cwd(), vscodeConfigPath);

      if (!fs.existsSync(resolvedPath)) {
        this.logger.error(
          `VSCode configuration file not found: ${resolvedPath}`,
        );
        throw new Error(`VSCode configuration file not found: ${resolvedPath}`);
      }

      const fileContent = fs.readFileSync(resolvedPath, 'utf8');
      const vscodeConfig = JSON.parse(fileContent);

      if (
        !vscodeConfig.configurations ||
        !Array.isArray(vscodeConfig.configurations)
      ) {
        this.logger.error(
          'Invalid VSCode configuration file format: missing or invalid "configurations" property',
        );
        throw new Error(
          'Invalid VSCode configuration file format: missing or invalid "configurations" property',
        );
      }

      // VSCode launch.json format is already compatible with our LaunchConfig interface
      const launchConfigs = vscodeConfig.configurations as LaunchConfig[];

      // Validate each configuration
      launchConfigs.forEach((launchConfig, index) => {
        if (!launchConfig.name) {
          this.logger.warn(
            `Launch configuration at index ${index} is missing a name, adding a default name`,
          );
          launchConfig.name = `Configuration ${index + 1}`;
        }

        if (!launchConfig.type) {
          this.logger.error(
            `Launch configuration "${launchConfig.name}" is missing required property "type"`,
          );
          throw new Error(
            `Launch configuration "${launchConfig.name}" is missing required property "type"`,
          );
        }

        if (
          !launchConfig.request ||
          (launchConfig.request !== 'launch' &&
            launchConfig.request !== 'attach')
        ) {
          this.logger.error(
            `Launch configuration "${launchConfig.name}" has invalid "request" property. Must be "launch" or "attach"`,
          );
          throw new Error(
            `Launch configuration "${launchConfig.name}" has invalid "request" property. Must be "launch" or "attach"`,
          );
        }
      });

      this.logger.info(
        `Loaded ${launchConfigs.length} launch configurations from VSCode config`,
      );
      return launchConfigs;
    } catch (error) {
      this.logger.error(
        'Error loading launch configurations from VSCode config',
        error,
      );
      throw new Error(
        `Failed to load launch configurations from VSCode config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Converts a launch configuration to DAP launch/attach arguments
   * @param launchConfig Launch configuration
   * @returns DAP launch/attach arguments
   */
  public toLaunchArguments(
    launchConfig: LaunchConfig,
  ):
    | DebugProtocol.LaunchRequestArguments
    | DebugProtocol.AttachRequestArguments {
    // Create a copy of the launch config without the name, type, and request properties
    const {
      name: _name,
      type: _type,
      request: _request,
      ...args
    } = launchConfig;

    // Return the remaining properties as launch/attach arguments
    return args;
  }
}
