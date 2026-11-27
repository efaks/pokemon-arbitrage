import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ArbitrageMcpServer } from './mcpServer.ts';
import { JSON_RPC_ERROR_CODES, jsonRpcError } from './protocol.ts';
import type { JsonRpcResponse } from './protocol.ts';

export interface StdioTransportOptions {
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
}

export class StdioMcpTransport {
  private readonly server: Pick<ArbitrageMcpServer, 'handleMessage'>;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly errorOutput: Writable;
  private reader?: Interface;
  private stopped = false;

  constructor(server: Pick<ArbitrageMcpServer, 'handleMessage'>, options: StdioTransportOptions = {}) {
    this.server = server;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.errorOutput = options.errorOutput ?? process.stderr;
  }

  async start(): Promise<void> {
    if (this.reader) throw new Error('MCP stdio transport is already running');
    this.stopped = false;
    const reader = createInterface({ input: this.input, terminal: false, crlfDelay: Infinity });
    this.reader = reader;

    // Stream errors may be emitted during the asynchronous write as well as passed to its callback.
    const onOutputError = () => this.stop();
    this.output.on('error', onOutputError);
    try {
      for await (const line of reader) {
        if (this.stopped) break;
        if (!line.trim()) continue;

        let response: JsonRpcResponse | JsonRpcResponse[] | undefined;
        try {
          response = await this.handleLine(line);
        } catch (error) {
          this.errorOutput.write(`MCP stdio request failed: ${error instanceof Error ? error.message : String(error)}\n`);
          continue;
        }
        if (response === undefined) continue;
        const frame = JSON.stringify(response) + '\n';
        await new Promise<void>((resolve, reject) => {
          this.output.write(frame, error => error ? reject(error) : resolve());
        });
      }
    } finally {
      reader.close();
      this.output.off('error', onOutputError);
      this.reader = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    this.reader?.close();
  }

  private async handleLine(line: string): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return jsonRpcError(null, JSON_RPC_ERROR_CODES.PARSE_ERROR, 'Parse error');
    }
    return this.server.handleMessage(message);
  }
}
