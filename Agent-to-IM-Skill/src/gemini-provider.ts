import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import type { LLMProvider, StreamChatParams, FileAttachment } from 'agent-to-im-core/src/lib/bridge/host.js';
import { sseEvent } from './sse-utils.js';
import { buildSubprocessEnv } from './llm-provider.js';

type GeminiStreamEvent =
  | { type: 'init'; session_id?: string; model?: string }
  | { type: 'message'; role?: 'user' | 'assistant'; content?: string; delta?: boolean }
  | { type: 'tool_use'; tool_name?: string; tool_id?: string; parameters?: unknown }
  | { type: 'tool_result'; tool_id?: string; status?: 'success' | 'error'; output?: string; error?: { type?: string; message?: string } }
  | { type: 'result'; status?: 'success' | 'error'; stats?: Record<string, unknown>; error?: { message?: string } }
  | { type: 'error'; message?: string; severity?: string }
  | { type: string; [key: string]: unknown };

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'text/plain': '.txt',
  'application/json': '.json',
};

function isGeminiModel(model: string | undefined): boolean {
  return !!model && /^gemini([_-]|$)/i.test(model);
}

export function toApprovalMode(permissionMode?: string, autoApprove?: boolean): string {
  if (autoApprove) return 'yolo';
  switch (permissionMode) {
    case 'acceptEdits':
      return 'auto_edit';
    case 'plan':
      return 'plan';
    case 'default':
    default:
      return 'default';
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderConversationPrompt(params: StreamChatParams, attachmentPaths: string[]): string {
  const sections: string[] = [];

  if (params.systemPrompt?.trim()) {
    sections.push('System instructions:');
    sections.push(params.systemPrompt.trim());
  }

  if (params.conversationHistory?.length) {
    sections.push('Conversation history:');
    for (const msg of params.conversationHistory) {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User';
      sections.push(`${role}:`);
      sections.push(msg.content.trim());
    }
  }

  if (attachmentPaths.length) {
    sections.push('Attached local files:');
    for (const filePath of attachmentPaths) {
      sections.push(`@${filePath}`);
    }
  }

  sections.push('Latest user message:');
  sections.push(params.prompt);
  return sections.join('\n\n');
}

function writeAttachmentTempFiles(files: FileAttachment[] | undefined): { paths: string[]; cleanup: () => void } {
  if (!files?.length) {
    return { paths: [], cleanup: () => {} };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-to-im-'));
  const paths: string[] = [];

  for (const file of files) {
    const ext = MIME_EXT[file.type] || path.extname(file.name) || '.bin';
    const safeBase = (file.name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(tmpDir, `${safeBase}${safeBase.endsWith(ext) ? '' : ext}`);
    fs.writeFileSync(filePath, Buffer.from(file.data, 'base64'));
    paths.push(filePath);
  }

  return {
    paths,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup failures
      }
    },
  };
}

export function parseUsage(stats: Record<string, unknown> | undefined): Record<string, number> | undefined {
  if (!stats) return undefined;
  const inputTokens = typeof stats.inputTokenCount === 'number'
    ? stats.inputTokenCount
    : typeof stats.input_tokens === 'number'
      ? stats.input_tokens
      : 0;
  const outputTokens = typeof stats.outputTokenCount === 'number'
    ? stats.outputTokenCount
    : typeof stats.output_tokens === 'number'
      ? stats.output_tokens
      : 0;
  const cacheRead = typeof stats.cachedContentTokenCount === 'number'
    ? stats.cachedContentTokenCount
    : typeof stats.cache_read_input_tokens === 'number'
      ? stats.cache_read_input_tokens
      : 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheRead,
  };
}

export class GeminiProvider implements LLMProvider {
  constructor(
    private cliPath: string,
    private autoApprove = false,
  ) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const cliPath = this.cliPath;
    const autoApprove = this.autoApprove;

    return new ReadableStream<string>({
      start(controller) {
        const { paths: attachmentPaths, cleanup } = writeAttachmentTempFiles(params.files);
        const includeDirs = new Set<string>();
        for (const filePath of attachmentPaths) {
          includeDirs.add(path.dirname(filePath));
        }

        let child: ReturnType<typeof spawn> | null = null;
        let stdoutBuffer = '';
        let stderrBuffer = '';
        let sessionId: string | undefined;
        let closed = false;

        const finishWithError = (message: string) => {
          if (closed) return;
          closed = true;
          controller.enqueue(sseEvent('error', message));
          controller.close();
        };

        const closeStream = () => {
          if (closed) return;
          closed = true;
          controller.close();
        };

        const handleEvent = (event: GeminiStreamEvent) => {
          if (closed) return;
          switch (event.type) {
            case 'init':
              sessionId = event.session_id || sessionId;
              controller.enqueue(sseEvent('status', {
                session_id: event.session_id || params.sessionId,
                model: event.model || params.model,
              }));
              break;

            case 'message':
              if (event.role === 'assistant' && typeof event.content === 'string' && event.content.length > 0) {
                controller.enqueue(sseEvent('text', event.content));
              }
              break;

            case 'tool_use':
              controller.enqueue(sseEvent('tool_use', {
                id: event.tool_id || `gemini-tool-${Date.now()}`,
                name: event.tool_name || 'GeminiTool',
                input: event.parameters ?? {},
              }));
              break;

            case 'tool_result':
              controller.enqueue(sseEvent('tool_result', {
                tool_use_id: event.tool_id || '',
                content: event.output || event.error?.message || '',
                is_error: event.status === 'error',
              }));
              break;

            case 'result':
              if (event.status === 'error') {
                controller.enqueue(sseEvent('error', event.error?.message || 'Gemini CLI execution failed'));
              } else {
                controller.enqueue(sseEvent('result', {
                  session_id: sessionId || params.sessionId,
                  usage: parseUsage(event.stats),
                }));
              }
              closeStream();
              break;

            case 'error':
              controller.enqueue(sseEvent('error', event.message || 'Gemini CLI error'));
              break;

            default:
              break;
          }
        };

        try {
          const env = buildSubprocessEnv();
          if (process.env.CTI_GEMINI_API_KEY) env.GEMINI_API_KEY = process.env.CTI_GEMINI_API_KEY;
          if (process.env.CTI_GOOGLE_API_KEY) env.GOOGLE_API_KEY = process.env.CTI_GOOGLE_API_KEY;

          const prompt = renderConversationPrompt(params, attachmentPaths);
          const args = [
            '--prompt',
            prompt,
            '--output-format',
            'stream-json',
            '--approval-mode',
            toApprovalMode(params.permissionMode, autoApprove),
          ];

          if (isGeminiModel(params.model)) {
            args.push('--model', params.model);
          }
          for (const dir of includeDirs) {
            args.push('--include-directories', dir);
          }

          child = spawn(cliPath, args, {
            cwd: params.workingDirectory,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          params.onRuntimeStatusChange?.('running');

          params.abortController?.signal.addEventListener('abort', () => {
            try {
              child?.kill('SIGTERM');
            } catch {
              // ignore
            }
          }, { once: true });

          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => {
            stdoutBuffer += chunk;
            let newlineIndex = stdoutBuffer.indexOf('\n');
            while (newlineIndex >= 0) {
              const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
              stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
              if (rawLine) {
                try {
                  handleEvent(JSON.parse(rawLine) as GeminiStreamEvent);
                } catch {
                  // Non-JSON output usually indicates an auth or startup problem.
                  finishWithError(`Gemini CLI emitted non-JSON output: ${rawLine}`);
                  try { child?.kill('SIGTERM'); } catch { /* ignore */ }
                  break;
                }
              }
              newlineIndex = stdoutBuffer.indexOf('\n');
            }
          });

          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk: string) => {
            stderrBuffer += chunk;
          });

          child.on('error', (err) => {
            params.onRuntimeStatusChange?.('error');
            finishWithError(`Failed to start Gemini CLI: ${err.message}`);
            cleanup();
          });

          child.on('close', (code, signal) => {
            params.onRuntimeStatusChange?.(code === 0 ? 'idle' : 'error');
            cleanup();

            if (code === 0) {
              if (stdoutBuffer.trim()) {
                try {
                  handleEvent(JSON.parse(stdoutBuffer.trim()) as GeminiStreamEvent);
                } catch {
                  // ignore trailing partial output
                }
              }
              return;
            }

            const stderr = stderrBuffer.trim();
            const authHint = stderr.includes('Opening authentication page')
              ? ' Gemini CLI is trying to start interactive OAuth. Configure CTI_GEMINI_API_KEY or CTI_GOOGLE_API_KEY for daemon use.'
              : '';
            finishWithError(`Gemini CLI exited with code ${code ?? 'unknown'}${signal ? ` (signal: ${signal})` : ''}.${stderr ? ` ${stderr}` : ''}${authHint}`);
          });
        } catch (err) {
          cleanup();
          const message = err instanceof Error ? err.message : String(err);
          finishWithError(`Gemini provider setup failed: ${message}`);
        }
      },

      cancel() {
        // no-op, abort path is handled above
      },
    });
  }
}
