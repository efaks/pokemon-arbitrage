export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'] as const;

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcNotification extends Omit<JsonRpcRequest, 'id'> {
  id?: never;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown; error?: never }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: JsonRpcErrorObject; result?: never };

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: readonly string[]; additionalProperties?: boolean };
  annotations: McpToolAnnotations;
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolCallResult {
  content: McpTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDefinition {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: McpTextContent;
}

export interface McpInitializeResult {
  protocolVersion: (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];
  capabilities: { tools: Record<string, never>; resources: Record<string, never>; prompts: Record<string, never> };
  serverInfo: { name: string; version: string };
  instructions: string;
}

export function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function mcpToolSuccess(text: string, structuredContent?: Record<string, unknown>): McpToolCallResult {
  return { content: [{ type: 'text', text }], ...(structuredContent === undefined ? {} : { structuredContent }) };
}

export function mcpToolError(message: string, details?: Record<string, unknown>): McpToolCallResult {
  return { ...mcpToolSuccess(message, details), isError: true };
}
