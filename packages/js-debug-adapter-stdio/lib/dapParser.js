// js-debug-adapter-stdio/lib/dapParser.js
class DAPParser {
  /**
   * @param {function(any): void} onMessageCallback
   */
  constructor(onMessageCallback) {
    this.onMessageCallback = onMessageCallback;
    this.buffer = Buffer.alloc(0);
    this.contentLength = -1;
  }

  /**
   * @param {Buffer} chunk
   */
  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      if (this.contentLength === -1) {
        // Try to parse headers
        const headerEndIndex = this.buffer.indexOf('\r\n\r\n');
        if (headerEndIndex === -1) {
          // Not enough data for headers yet
          break;
        }

        const headersStr = this.buffer.slice(0, headerEndIndex).toString('utf8');
        const lines = headersStr.split('\r\n');
        let foundContentLength = false;
        for (const line of lines) {
          if (line.toLowerCase().startsWith('content-length:')) {
            const lengthStr = line.substring('content-length:'.length).trim();
            this.contentLength = parseInt(lengthStr, 10);
            if (isNaN(this.contentLength)) {
              // Using console.error directly as logger instance isn't passed here.
              // In a more complex setup, a logger instance would be preferable.
              console.error('[DAPParser] Invalid Content-Length:', lengthStr); 
              this.reset();
              return;
            }
            foundContentLength = true;
            break;
          }
        }

        if (!foundContentLength) {
          console.error('[DAPParser] Headers found, but no Content-Length.');
          this.reset();
          return;
        }
        
        this.buffer = this.buffer.slice(headerEndIndex + 4); // Consume headers
      }

      if (this.contentLength !== -1) {
        if (this.buffer.length >= this.contentLength) {
          const messageBody = this.buffer.slice(0, this.contentLength);
          this.buffer = this.buffer.slice(this.contentLength);
          this.contentLength = -1; // Reset for next message

          try {
            const message = JSON.parse(messageBody.toString('utf8'));
            this.onMessageCallback(message);
          } catch (e) {
            console.error('[DAPParser] Error parsing message JSON:', e, 'Body:', messageBody.toString('utf8'));
          }
        } else {
          // Not enough data for the full message body yet
          break;
        }
      } else {
        // Should have content length or be waiting for headers
        break;
      }
    }
  }

  reset() {
    this.buffer = Buffer.alloc(0);
    this.contentLength = -1;
  }
}

module.exports = { DAPParser };
