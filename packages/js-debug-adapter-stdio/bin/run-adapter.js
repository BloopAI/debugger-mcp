#!/usr/bin/env node

const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DAPParser } = require('../lib/dapParser');

/**
 * Logger with configurable levels and output
 */
class Logger {
  static LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
  };

  /**
   * Creates a new logger instance
   * @param {string} filePath - Path to log file
   * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR)
   */
  constructor(filePath, level = 'INFO') {
    this.filePath = filePath;
    this.level = Logger.LEVELS[level.toUpperCase()] || Logger.LEVELS.INFO;
    
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, '', 'utf8');
      this.info('Logger initialized', { filePath, level });
    } catch (err) {
      console.error(`Failed to initialize logger: ${err}`);
    }
  }

  /**
   * Writes a log message with specified level
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} data - Additional data to log
   */
  _log(level, message, data = null) {
    if (Logger.LEVELS[level] < this.level) return;

    const timestamp = new Date().toISOString();
    const logData = data ? ` | ${JSON.stringify(data)}` : '';
    const logMessage = `[${timestamp}] [${level}] ${message}${logData}\n`;
    
    try {
      fs.appendFileSync(this.filePath, logMessage, 'utf8');
    } catch (err) {
      console.error(`[Logger Fallback] ${logMessage.trim()}`);
    }
  }

  debug(message, data) { this._log('DEBUG', message, data); }
  info(message, data) { this._log('INFO', message, data); }
  warn(message, data) { this._log('WARN', message, data); }
  error(message, data) { this._log('ERROR', message, data); }
}

// Configure logging
const LOG_LEVEL = process.env.DAP_LOG_LEVEL || 'INFO';
const LOG_DIR = process.env.DAP_LOG_DIR || path.join(os.tmpdir(), 'js-debug-adapter-stdio');
const LOG_FILE = path.join(LOG_DIR, 'run-adapter.log');
const logger = new Logger(LOG_FILE, LOG_LEVEL);

logger.info('Script started', {
  pid: process.pid,
  nodeVersion: process.version,
  arguments: process.argv.slice(2)
});

const dapServerScriptPath = path.join(__dirname, '..', 'dist', 'src', 'dapDebugServer.js');
const nodePath = process.execPath;

logger.info('Launching DAP server', {
  cwd: process.cwd(),
  serverPath: dapServerScriptPath
});

const dapProcess = spawn(
  nodePath,
  ['--enable-source-maps', dapServerScriptPath, '0'],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, NODE_OPTIONS: '' },
  },
);

logger.info('DAP server spawned', {
  command: `${nodePath} --enable-source-maps ${dapServerScriptPath} 0`,
  pid: dapProcess.pid
});

let dapServerPort = 0;
let dapServerHost = '::1';
let dapServerConnection = null;
let dapConnectionStack = [];
let dapSequenceNumber = 100;
let mcpClientSequenceNumber = 1;
let initialLaunchArgs = null;

/**
 * Generates next sequence number for DAP server messages
 * @returns {number} Next sequence number
 */
function getNextDapSeq() {
  return dapSequenceNumber++;
}

/**
 * Generates next sequence number for MCP client messages
 * @returns {number} Next sequence number
 */
function getNextMcpClientSeq() {
  return mcpClientSequenceNumber++;
}

dapProcess.stdout.on('data', (data) => {
  const output = data.toString();
  logger.debug('DAP server stdout', { output: output.trim() });
  
  if (output.includes('listening at')) {
    const parts = output.trim().split(':');
    const portStr = parts[parts.length - 1];
    const port = parseInt(portStr, 10);
    if (!isNaN(port)) {
      dapServerPort = port;
      logger.info('DAP server started', { port: dapServerPort });
      connectToDapServer();
    }
  }
});

dapProcess.stderr.on('data', (data) => {
  logger.warn('DAP server stderr', { output: data.toString().trim() });
});

dapProcess.on('error', (err) => {
  logger.error('Failed to start DAP server process', { error: err.message });
  process.exit(1);
});

dapProcess.on('exit', (code, signal) => {
  logger.info('DAP server process exited', { code, signal });
});

/**
 * Establishes connection to the DAP server
 * @returns {Promise<void>} Promise that resolves when connected
 */
function connectToDapServer() {
  return new Promise((resolve, reject) => {
    logger.info('Connecting to DAP server', { host: dapServerHost, port: dapServerPort });
    
    if (dapServerConnection && !dapServerConnection.destroyed) {
      dapServerConnection.removeAllListeners();
      dapServerConnection.destroy();
    }

    dapServerConnection = net.createConnection({
      host: dapServerHost,
      port: dapServerPort
    });

    const onConnect = () => {
      logger.info('Successfully connected to DAP server');
      dapServerConnection.removeListener('error', onError);
      setupCommunication();
      setupConnectionErrorHandlers();
      resolve();
    };

    const onError = (err) => {
      logger.error('DAP server connection error', { error: err.message });
      dapServerConnection.removeListener('connect', onConnect);
      reject(err);
    };

    dapServerConnection.once('connect', onConnect);
    dapServerConnection.once('error', onError);
  });
}

/**
 * Pushes a DAP connection to the stack for management
 * @param {net.Socket} connection - The connection to push
 * @param {string} pendingTargetId - The pending target ID associated with this connection
 */
function pushDapConnection(connection, pendingTargetId) {
  const connectionInfo = {
    connection,
    pendingTargetId,
    timestamp: Date.now()
  };
  dapConnectionStack.push(connectionInfo);
  logger.debug('Pushed connection to stack', {
    stackSize: dapConnectionStack.length,
    targetId: pendingTargetId
  });
}

/**
 * Pops and closes a DAP connection from the stack
 * @returns {Object|null} The connection info that was popped
 */
function popDapConnection() {
  const connectionInfo = dapConnectionStack.pop();
  if (connectionInfo) {
    logger.debug('Popped connection from stack', {
      stackSize: dapConnectionStack.length,
      targetId: connectionInfo.pendingTargetId
    });
    if (connectionInfo.connection && !connectionInfo.connection.destroyed) {
      connectionInfo.connection.removeAllListeners();
      connectionInfo.connection.destroy();
    }
  }
  return connectionInfo;
}

/**
 * Creates a new DAP connection without destroying existing ones
 * @returns {Promise<void>} Promise that resolves when connection is established
 */
function createNewDapConnection() {
  return new Promise((resolve, reject) => {
    logger.info('Creating new DAP connection', { host: dapServerHost, port: dapServerPort });
    
    const newConnection = net.createConnection({
      host: dapServerHost,
      port: dapServerPort
    });

    const onConnect = () => {
      logger.info('New DAP connection established');
      newConnection.removeListener('error', onError);
      
      newConnection.on('close', () => {
        logger.debug('DAP connection closed, managing stack');
        popDapConnection();
      });
      
      dapServerConnection = newConnection;
      setupCommunication();
      setupConnectionErrorHandlers();
      resolve();
    };

    const onError = (err) => {
      logger.error('New DAP connection failed', { error: err.message });
      newConnection.removeListener('connect', onConnect);
      reject(err);
    };

    newConnection.once('connect', onConnect);
    newConnection.once('error', onError);
  });
}

/**
 * Determines whether a DAP event should be filtered out to reduce noise
 * @param {Object} message - The DAP message to check
 * @returns {boolean} True if the message should be filtered out
 */
function shouldFilterEvent(message) {
  if (message.type !== 'event') {
    return false;
  }

  // Filter out telemetry events
  if (message.event === 'output' && message.body?.category === 'telemetry') {
    return true;
  }

  // Filter out loadedSource events for Node.js internals
  if (message.event === 'loadedSource' &&
      message.body?.source?.name?.includes('<node_internals>')) {
    return true;
  }

  return false;
}

/**
 * Sets up communication parsers and data forwarding between MCP client and DAP server
 */
function setupCommunication() {
  process.stdin.removeAllListeners('data');
  if (dapServerConnection) {
    dapServerConnection.removeAllListeners('data');
  }

  const clientParser = new DAPParser((message) => {
    const messageType = message.command || message.event || message.type;
    logger.debug('MCP Client -> DAP Server', {
      port: dapServerPort,
      messageType,
      seq: message.seq
    });
    
    if (message.type === 'request' && message.command === 'launch' && message.arguments) {
      if (!initialLaunchArgs) {
        initialLaunchArgs = JSON.parse(JSON.stringify(message.arguments));
        logger.info('Stored initial launch arguments', {
          type: initialLaunchArgs.type,
          program: initialLaunchArgs.program
        });
      }
      
      const originalType = message.arguments.type;
      
      if (message.arguments.type === 'node') {
        message.arguments.type = 'pwa-node';
      }
      
      if (message.arguments.options) {
        delete message.arguments.options;
      }
      
      if (!message.arguments.args) {
        message.arguments.args = [];
      }
      
      logger.debug('Transformed launch configuration', {
        originalType,
        newType: message.arguments.type,
        program: message.arguments.program
      });
    }

    logger.debug('Full message to DAP', { message });
    
    const messageStr = JSON.stringify(message);
    const rawMessage = `Content-Length: ${Buffer.byteLength(messageStr)}\r\n\r\n${messageStr}`;
    
    if (dapServerConnection && !dapServerConnection.destroyed) {
      dapServerConnection.write(rawMessage);
    }
  });

  const serverParser = new DAPParser((message) => {
    const messageKind = message.type === 'request' ? message.command :
                      message.type === 'event' ? message.event : message.type;

    logger.debug('DAP Server -> MCP Client', {
      port: dapServerPort,
      messageKind,
      seq: message.seq
    });
    
    if (message.type === 'response') {
      logger.debug('DAP response received', {
        command: message.command,
        success: message.success,
        request_seq: message.request_seq
      });
    } else if (message.type === 'event') {
      logger.debug('DAP event received', {
        event: message.event,
        body: message.body
      });

      // Filter out verbose telemetry and loadedSource events
      if (shouldFilterEvent(message)) {
        logger.debug('Filtered verbose event', { event: message.event });
        return;
      }
    } else if (message.type === 'request') {
      logger.info('DAP reverse request received', {
        command: message.command,
        seq: message.seq
      });
      
      if (message.command === 'startDebugging') {
        handleStartDebuggingRequest(message);
        return;
      }
    }

    logger.debug('Full message from DAP', { message });

    const messageStr = JSON.stringify(message);
    const rawMessage = `Content-Length: ${Buffer.byteLength(messageStr)}\r\n\r\n${messageStr}`;
    process.stdout.write(rawMessage);
  });

  process.stdin.on('data', (data) => {
    clientParser.handleData(data);
  });

  if (dapServerConnection) {
    dapServerConnection.on('data', (data) => {
      serverParser.handleData(data);
    });
  }
}
/**
 * Performs the DAP initialize sequence followed by launch and configurationDone
 * @param {Object} launchArgs - Launch arguments for the debug session
 * @returns {Promise<void>} Promise that resolves when sequence is complete
 */
async function performInitializeSequence(launchArgs) {
  return new Promise((resolve, reject) => {
    logger.info('Starting DAP initialize sequence', {
      targetId: launchArgs.__pendingTargetId,
      program: launchArgs.program
    });
    
    if (!dapServerConnection || dapServerConnection.destroyed) {
      reject(new Error('No active DAP server connection'));
      return;
    }
    
    let initializeResponseReceived = false;
    let pendingMessages = [];
    
    const tempParser = new DAPParser((message) => {
      if (message.type === 'response' && message.command === 'initialize' && !initializeResponseReceived) {
        initializeResponseReceived = true;
        logger.info('Initialize response received', { success: message.success });
        
        if (message.success) {
          const launchRequest = {
            seq: getNextDapSeq(),
            type: 'request',
            command: launchArgs.request || 'launch',
            arguments: launchArgs
          };
          
          const launchRequestStr = JSON.stringify(launchRequest);
          const rawLaunchRequest = `Content-Length: ${Buffer.byteLength(launchRequestStr)}\r\n\r\n${launchRequestStr}`;
          
          dapServerConnection.write(rawLaunchRequest);
          logger.debug('Launch request sent', { seq: launchRequest.seq });
          
          const configurationDoneRequest = {
            seq: getNextDapSeq(),
            type: 'request',
            command: 'configurationDone'
          };
          
          const configurationDoneStr = JSON.stringify(configurationDoneRequest);
          const rawConfigurationDone = `Content-Length: ${Buffer.byteLength(configurationDoneStr)}\r\n\r\n${configurationDoneStr}`;
          
          dapServerConnection.write(rawConfigurationDone);
          logger.debug('ConfigurationDone request sent', { seq: configurationDoneRequest.seq });
          
          dapServerConnection.removeListener('data', tempDataHandler);
          if (originalDataHandler) {
            dapServerConnection.on('data', originalDataHandler);
            
            pendingMessages.forEach(msg => {
              if (!(msg.type === 'response' && msg.command === 'initialize')) {
                const msgStr = JSON.stringify(msg);
                const rawMsg = `Content-Length: ${Buffer.byteLength(msgStr)}\r\n\r\n${msgStr}`;
                process.stdout.write(rawMsg);
              }
            });
          }
          
          resolve();
        } else {
          dapServerConnection.removeListener('data', tempDataHandler);
          if (originalDataHandler) {
            dapServerConnection.on('data', originalDataHandler);
          }
          reject(new Error(`Initialize failed: ${message.message}`));
        }
      } else if (!(message.type === 'response' && message.command === 'initialize')) {
        pendingMessages.push(message);
      }
    });
    
    const originalDataHandler = dapServerConnection.listeners('data')[0];
    dapServerConnection.removeListener('data', originalDataHandler);
    
    const tempDataHandler = (data) => {
      tempParser.handleData(data);
    };
    
    dapServerConnection.on('data', tempDataHandler);
    
    const timeoutId = setTimeout(() => {
      if (!initializeResponseReceived) {
        dapServerConnection.removeListener('data', tempDataHandler);
        if (originalDataHandler) {
          dapServerConnection.on('data', originalDataHandler);
        }
        reject(new Error('Initialize sequence timeout after 5 seconds'));
      }
    }, 5000);
    
    const originalResolve = resolve;
    const originalReject = reject;
    resolve = (...args) => {
      clearTimeout(timeoutId);
      originalResolve(...args);
    };
    reject = (...args) => {
      clearTimeout(timeoutId);
      originalReject(...args);
    };
    
    const initializeRequest = {
      seq: getNextDapSeq(),
      type: 'request',
      command: 'initialize',
      arguments: {
        clientID: 'js-debug-adapter-stdio',
        clientName: 'JS Debug Adapter STDIO',
        adapterID: 'pwa-node',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsVariablePaging: true,
        supportsRunInTerminalRequest: true,
        locale: 'en-us'
      }
    };
    
    const initializeRequestStr = JSON.stringify(initializeRequest);
    const rawInitializeRequest = `Content-Length: ${Buffer.byteLength(initializeRequestStr)}\r\n\r\n${initializeRequestStr}`;
    
    dapServerConnection.write(rawInitializeRequest);
    logger.debug('Initialize request sent', { seq: initializeRequest.seq });
  });
}

/**
 * Handles DAP startDebugging reverse requests to create new debug sessions
 * @param {Object} request - The startDebugging request from DAP server
 */
async function handleStartDebuggingRequest(request) {
  const config = request.arguments;
  const pendingTargetId = config.configuration?.__pendingTargetId;
  
  logger.info('Handling startDebugging request', {
    seq: request.seq,
    targetId: pendingTargetId,
    type: config.configuration?.type,
    name: config.configuration?.name
  });
  
  try {
    const response = {
      seq: getNextDapSeq(),
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: true,
      body: {}
    };
    
    const responseStr = JSON.stringify(response);
    const rawResponse = `Content-Length: ${Buffer.byteLength(responseStr)}\r\n\r\n${responseStr}`;
    
    if (dapServerConnection && !dapServerConnection.destroyed) {
      dapServerConnection.write(rawResponse);
      logger.debug('Sent success response for startDebugging');
    }
    
    if (dapServerConnection && !dapServerConnection.destroyed) {
      pushDapConnection(dapServerConnection, pendingTargetId);
    }
    
    logger.info('Creating new debug session connection');
    await createNewDapConnection();
    
    const newLaunchArgs = {
      ...initialLaunchArgs,
      ...config.configuration,
      type: config.configuration.type === 'node' ? 'pwa-node' : config.configuration.type,
      request: config.request || 'launch'
    };
    
    if (newLaunchArgs.options) {
      delete newLaunchArgs.options;
    }
    
    if (!newLaunchArgs.args) {
      newLaunchArgs.args = [];
    }
    
    logger.debug('Prepared launch configuration', {
      type: newLaunchArgs.type,
      program: newLaunchArgs.program,
      targetId: pendingTargetId
    });
    
    await performInitializeSequence(newLaunchArgs);
    logger.info('Successfully created new debug session', { targetId: pendingTargetId });
    
  } catch (error) {
    logger.error('Failed to handle startDebugging request', {
      error: error.message,
      targetId: pendingTargetId
    });
    
    const errorResponse = {
      seq: getNextDapSeq(),
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: false,
      message: error.message || 'Failed to handle startDebugging request',
      body: { error: { id: 1, format: error.message || 'Unknown error' } }
    };
    
    const errorResponseStr = JSON.stringify(errorResponse);
    const rawErrorResponse = `Content-Length: ${Buffer.byteLength(errorResponseStr)}\r\n\r\n${errorResponseStr}`;
    
    if (dapServerConnection && !dapServerConnection.destroyed) {
      dapServerConnection.write(rawErrorResponse);
      logger.debug('Sent error response for startDebugging', { error: error.message });
    }
  }
}



/**
 * Sets up error and close event handlers for DAP server connections
 */
function setupConnectionErrorHandlers() {
  if (dapServerConnection) {
    dapServerConnection.on('error', (err) => {
      logger.error('DAP server connection error', { error: err.message });
    });

    dapServerConnection.on('close', () => {
      logger.info('DAP server connection closed');
    });
  }
}

// Process event handlers
process.stdin.on('end', () => {
  logger.info('STDIN ended, cleaning up connections');
  
  if (dapServerConnection && !dapServerConnection.destroyed) {
    dapServerConnection.end();
  }
  
  while (dapConnectionStack.length > 0) {
    popDapConnection();
  }
  
  if (dapProcess && !dapProcess.killed) {
    logger.info('Terminating DAP server process');
    dapProcess.kill('SIGTERM');
  }
});

process.on('exit', (code) => {
  logger.info('Process exiting', { code });
  
  while (dapConnectionStack.length > 0) {
    popDapConnection();
  }
  
  if (dapProcess && !dapProcess.killed) {
    dapProcess.kill('SIGTERM');
  }
});
