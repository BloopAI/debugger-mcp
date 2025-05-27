import * as fs from 'fs';
import * as path from 'path';
import { AdapterConfig } from '../sessionManager';
import { LoggerInterface } from '../logging';

/**
 * Interface for adapter configuration file format
 */
export interface AdapterConfigFile {
  adapters: {
    [key: string]: Omit<AdapterConfig, 'type'>;
  };
}

/**
 * Loads debug adapter configurations from a JSON file
 */
export class AdapterConfigLoader {
  private readonly logger: LoggerInterface;

  /**
   * Creates a new AdapterConfigLoader
   * @param logger Logger instance
   */
  constructor(logger: LoggerInterface) {
    this.logger = logger.child
      ? logger.child({ className: 'AdapterConfigLoader' })
      : logger;
  }

  /**
   * Loads adapter configurations from a JSON file
   * @param configPath Path to the adapter configuration file
   * @returns Array of adapter configurations
   */
  public loadFromFile(configPath: string): AdapterConfig[] {
    try {
      this.logger.info(`Loading adapter configurations from ${configPath}`);

      // Resolve path if it's relative
      const resolvedPath = path.isAbsolute(configPath)
        ? configPath
        : path.resolve(process.cwd(), configPath);

      if (!fs.existsSync(resolvedPath)) {
        this.logger.error(
          `Adapter configuration file not found: ${resolvedPath}`,
        );
        throw new Error(
          `Adapter configuration file not found: ${resolvedPath}`,
        );
      }

      const fileContent = fs.readFileSync(resolvedPath, 'utf8');
      const config = JSON.parse(fileContent) as AdapterConfigFile;

      if (!config.adapters || typeof config.adapters !== 'object') {
        this.logger.error(
          'Invalid adapter configuration file format: missing or invalid "adapters" property',
        );
        throw new Error(
          'Invalid adapter configuration file format: missing or invalid "adapters" property',
        );
      }

      const adapterConfigs: AdapterConfig[] = [];

      for (const [type, adapterConfig] of Object.entries(config.adapters)) {
        adapterConfigs.push({
          type,
          ...adapterConfig,
        });
      }

      this.logger.info(
        `Loaded ${adapterConfigs.length} adapter configurations`,
      );
      return adapterConfigs;
    } catch (error) {
      this.logger.error('Error loading adapter configurations', error);
      throw new Error(
        `Failed to load adapter configurations: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Loads adapter configurations from a VSCode-style launch.json file
   * @param vscodeConfigPath Path to the VSCode launch.json file
   * @returns Array of adapter configurations
   */
  public loadFromVSCodeConfig(vscodeConfigPath: string): AdapterConfig[] {
    try {
      this.logger.info(
        `Loading adapter configurations from VSCode config: ${vscodeConfigPath}`,
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

      // Extract unique adapter types from the configurations
      const adapterTypes = new Set<string>();
      vscodeConfig.configurations.forEach((config: unknown) => {
        if (
          config &&
          typeof config === 'object' &&
          'type' in config &&
          typeof (config as { type: unknown }).type === 'string'
        ) {
          adapterTypes.add((config as { type: string }).type);
        }
      });

      // For each adapter type, try to find the corresponding adapter executable
      const adapterConfigs: AdapterConfig[] = [];

      adapterTypes.forEach((type) => {
        // In VSCode, adapters are typically installed as extensions
        // Here we'll make a best effort to find the adapter based on common patterns
        const adapterConfig = this.findAdapterForType(type);
        if (adapterConfig) {
          adapterConfigs.push(adapterConfig);
        }
      });

      this.logger.info(
        `Loaded ${adapterConfigs.length} adapter configurations from VSCode config`,
      );
      return adapterConfigs;
    } catch (error) {
      this.logger.error(
        'Error loading adapter configurations from VSCode config',
        error,
      );
      throw new Error(
        `Failed to load adapter configurations from VSCode config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Attempts to find an adapter configuration for a given type
   * This is a best-effort approach and may need to be customized for specific adapters
   * @param type Adapter type
   * @returns Adapter configuration if found, undefined otherwise
   */
  private findAdapterForType(type: string): AdapterConfig | undefined {
    // This is a simplified implementation that would need to be expanded
    // for real-world usage with various debug adapters

    // Common adapter mappings
    const adapterMappings: Record<string, Partial<AdapterConfig>> = {
      node: {
        command: 'node',
        args: [
          path.join(
            'node_modules',
            '@vscode',
            'node-debug2',
            'out',
            'src',
            'nodeDebug.js',
          ),
        ],
      },
      chrome: {
        command: 'node',
        args: [
          path.join(
            'node_modules',
            '@vscode',
            'chrome-debug',
            'out',
            'src',
            'chromeDebug.js',
          ),
        ],
      },
      python: {
        command: 'python',
        args: ['-m', 'debugpy.adapter'],
      },
      go: {
        command: 'dlv',
        args: ['dap'],
      },
      mock: {
        command: 'node',
        args: [
          path.join(
            'node_modules',
            '@vscode',
            'mock-debug',
            'out',
            'mockDebug.js',
          ),
        ],
      },
    };

    if (type in adapterMappings) {
      const mapping = adapterMappings[type];
      return {
        type,
        command: mapping.command!,
        args: mapping.args,
        env: mapping.env,
        cwd: mapping.cwd,
      };
    }

    this.logger.warn(`No adapter configuration found for type: ${type}`);
    return undefined;
  }
}
