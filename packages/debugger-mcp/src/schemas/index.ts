export const startDebugSessionSchema = {
  description:
    'Starts a new debug session for a given target program. Supports standard DAP launch arguments and allows passing additional, adapter-specific parameters directly. Returns the session ID and initial state.',
  type: 'object',
  required: ['targetPath'],
  properties: {
    targetType: {
      type: 'string',
      description:
        "Type of target to debug (e.g., 'node', 'python'). This will be validated against available adapters at runtime. Defaults to 'python'.",
      default: 'python',
    },
    targetPath: {
      type: 'string',
      description:
        'Absolute path to the executable file or main script of the program to be debugged. Relative paths are not supported and will likely cause errors. Ensure `cwd` (current working directory) is also set correctly if your debug adapter or program relies on it, though the path itself must be absolute.',
    },
    stopOnEntry: {
      type: 'boolean',
      description: 'Whether to stop at the entry point of the program.',
      default: true,
    },
    launchArgs: {
      type: 'array',
      description: 'Arguments to pass to the program being debugged.',
      items: { type: 'string' },
      default: [],
    },
    cwd: {
      type: 'string',
      description:
        'Working directory for the debug session. This is the directory from which the debugged program will be launched. This setting is important if the program itself uses relative paths to access files or resources, or if the debug adapter requires a specific CWD for its operation. Note: `targetPath` should still be an absolute path.',
    },
    env: {
      type: 'object',
      description: 'Environment variables for the debug session.',
      additionalProperties: { type: 'string' },
    },
  },
  additionalProperties: true,
};

export const setBreakpointSchema = {
  type: 'object',
  required: ['sessionId', 'filePath', 'lineNumber'],
  properties: {
    sessionId: {
      type: 'string',
      description: 'The ID of the debug session.',
    },
    filePath: {
      type: 'string',
      description: 'The path to the file in which to set the breakpoint.',
    },
    lineNumber: {
      type: 'number',
      description: 'The line number for the breakpoint (1-based).',
    },
  },
};

export const evaluateExpressionSchema = {
  type: 'object',
  required: ['sessionId', 'expression'],
  properties: {
    sessionId: {
      type: 'string',
      description: 'The ID of the debug session.',
    },
    expression: {
      type: 'string',
      description: 'The expression to evaluate.',
    },
    frameId: {
      type: 'number',
      description: 'Optional frame ID in which to evaluate the expression.',
    },
    context: {
      type: 'string',
      description:
        "Context in which to evaluate the expression (e.g., 'watch', 'repl', 'hover'). Defaults to 'repl'.",
      default: 'repl',
    },
  },
};

export const getVariablesSchema = {
  type: 'object',
  required: ['sessionId', 'variablesReference'],
  properties: {
    sessionId: {
      type: 'string',
      description: 'The ID of the debug session.',
    },
    variablesReference: {
      type: 'number',
      description:
        'The reference ID (number) for a variable scope (e.g., from a stack frame) or a structured variable (e.g., an object or array) whose children/properties are to be retrieved. Typically obtained from a stack frame, a previous `evaluateExpression` call, or a `getVariables` call for a complex variable.',
    },
  },
};

export const getCallStackSchema = {
  type: 'object',
  required: ['sessionId', 'threadId'],
  properties: {
    sessionId: {
      type: 'string',
      description: 'The ID of the debug session.',
    },
    threadId: {
      type: 'number',
      description: 'The ID of the thread for which to retrieve the call stack.',
    },
  },
};

export const continueSchema = {
  description:
    'Continues execution of the debug target and returns the current state of the debug session.',
  type: 'object',
  required: ['sessionId'],
  properties: {
    sessionId: {
      type: 'string',
      description: 'The ID of the debug session.',
    },
    threadId: {
      type: 'number',
      description:
        'Optional ID of the thread to continue. If not provided, all threads may be continued.',
    },
  },
};

export const stepOverSchema = {
  type: 'object',
  required: ['sessionId', 'threadId'],
  properties: {
    sessionId: {
      type: 'string',
      description: 'The ID of the debug session.',
    },
    threadId: {
      type: 'number',
      description: 'The ID of the thread to step over.',
    },
  },
};

export const stepInSchema = {
  description: 'Steps into the function call at the current execution line.',
  type: 'object',
  required: ['sessionId', 'threadId'],
  properties: {
    sessionId: {
      type: 'string',
      description: 'The ID of the debug session.',
    },
    threadId: {
      type: 'number',
      description: 'The ID of the thread to step into.',
    },
  },
};

export const stepOutSchema = {
  description: 'Steps out of the current function.',
  type: 'object',
  required: ['sessionId', 'threadId'],
  properties: {
    sessionId: {
      type: 'string',
      description: 'The ID of the debug session.',
    },
    threadId: {
      type: 'number',
      description: 'The ID of the thread to step out of.',
    },
  },
};

export const terminateSessionSchema = {
  description: 'Terminates a debug session and the debuggee process.',
  type: 'object',
  required: ['sessionId'],
  properties: {
    sessionId: {
      type: 'string',
      description: 'The ID of the debug session to terminate.',
    },
  },
};

export const listSessionsSchema = {
  type: 'object',
  properties: {}, // No specific parameters for listing sessions
};
export const listAdaptersSchema = {
  type: 'object',
  properties: {}, // No specific parameters for listing adapters
};
export const getSessionDetailsSchema = {
  description:
    'Retrieves detailed information about a specific debug session, including its state (e.g., running, paused, terminated), active threads, and the call stack if the session is paused. Useful for understanding the current execution context, inspecting variables, or deciding the next debugging step.',
  type: 'object',
  required: ['sessionId'],
  properties: {
    sessionId: {
      type: 'string',
      description: 'The ID of the debug session to get details for.',
    },
  },
  additionalProperties: false,
};
export const getPendingAsyncEventsSchema = {
  type: 'object',
  properties: {}, // No specific parameters
  additionalProperties: false,
};
