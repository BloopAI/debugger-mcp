/**
 * Interface for a structured logger.
 * This allows for dependency injection of a specific logging implementation (e.g., pino).
 */
export interface LoggerInterface {
  /**
   * Logs a message at the 'trace' level.
   * @param message The main message to log.
   * @param args Additional arguments or a context object.
   */
  trace(message: string, ...args: unknown[]): void;
  trace(obj: object, message?: string, ...args: unknown[]): void;

  /**
   * Logs a message at the 'debug' level.
   * @param message The main message to log.
   * @param args Additional arguments or a context object.
   */
  debug(message: string, ...args: unknown[]): void;
  debug(obj: object, message?: string, ...args: unknown[]): void;

  /**
   * Logs a message at the 'info' level.
   * @param message The main message to log.
   * @param args Additional arguments or a context object.
   */
  info(message: string, ...args: unknown[]): void;
  info(obj: object, message?: string, ...args: unknown[]): void;

  /**
   * Logs a message at the 'warn' level.
   * @param message The main message to log.
   * @param args Additional arguments or a context object.
   */
  warn(message: string, ...args: unknown[]): void;
  warn(obj: object, message?: string, ...args: unknown[]): void;

  /**
   * Logs a message at the 'error' level.
   * @param message The main message to log.
   * @param args Additional arguments or a context object.
   */
  error(message: string, ...args: unknown[]): void;
  error(obj: object, message?: string, ...args: unknown[]): void;

  /**
   * Logs a message at the 'fatal' level (often implies process exit).
   * @param message The main message to log.
   * @param args Additional arguments or a context object.
   */
  fatal?(message: string, ...args: unknown[]): void;
  fatal?(obj: object, message?: string, ...args: unknown[]): void;

  /**
   * Creates a child logger with additional bound context.
   * @param bindings An object containing properties to be bound to the child logger.
   */
  child?(bindings: Record<string, unknown>): LoggerInterface;
}
