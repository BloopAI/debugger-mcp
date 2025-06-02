# Debugger MCP

A Model Context Protocol (MCP) server for connecting Debug Adapter Protocol (DAP) compatible debuggers to Claude, Roocode, Cursor, etc...

DAP debuggers are the found in VSCode and other IDEs, and provide powerful features for setting breakpoints, reading the values of code, etc...

This is useful in large complex codebases, where bugs aren't always obvious from looking at the code alone.

The server supports debugging Python and Node projects, but can be easily extended to support other languages with DAP debuggers.

![](debugger_mcp.gif)

## Features

### Core Debugging Capabilities

- **Session Management**: Start, terminate, and list debug sessions
- **Breakpoint Control**: Set conditional breakpoints and logpoints
- **Execution Control**: Step over, step into, step out, and continue execution
- **Variable Inspection**: Evaluate expressions and examine variable scopes
- **Call Stack Analysis**: Retrieve and analyze execution call stacks
- **Real-time Events**: Monitor debug events and state changes

### Supported Languages

- **Python**: Full debugging support with debugpy adapter
- **Node.js**: Full debugging support with vscode-js-debug
- **Extensible**: Architecture supports additional language adapters

## Installation

### Prerequisites

- Node.js (for MCP server and Node debugging)
- Python 3.7+ (for Python debugging)
- `uv` and `debugpy` (for Python debugging)

### Setup

```bash
# Install debugpy for Python debugging
pip install debugpy

# Or using uv (recommended)
uv add debugpy
```

## Configuration

### MCP Client Configuration

Add the debugger server to your MCP client configuration:

```json
{
  "mcpServers": {
    "debugger-mcp": {
      "command": "npx",
      "args": ["--yes", "@bloopai/debugger-mcp"]
    }
  }
}
```

### Environment Setup

The server automatically configures debug adapters:

- **Python**: Uses `debugpy.adapter` via uv or pip
- **Node**: Uses `vscode-js-debug` which is downloaded automatically
- **Working Directory**: Configurable per session
- **Environment Variables**: Customizable for each debug session

## Usage Examples

### Starting a Debug Session

```prompt
Please debug the issue with my file `/absolute/path/to/my/file/my_file.py`
```
