/**
 * Feishu (Lark) Adapter — implements BaseChannelAdapter for Feishu Bot API.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient for real-time event
 * subscription and REST Client for message sending / resource downloading.
 * Routes messages through an internal async queue (same pattern as Telegram).
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 * - Permission prompts → interactive card with action buttons
 *
 * card.action.trigger events are handled via EventDispatcher (Openclaw pattern):
 * button clicks are converted to synthetic text messages and routed through
 * the normal /perm command processing pipeline.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../types';
import type { FileAttachment } from '../types';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter';
import { getBridgeContext } from '../context';
import {
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
  hasComplexMarkdown,
  buildCardContent,
  buildPostContent,
} from '../markdown/feishu';
import * as broker from '../permission-broker';

/** Max number of message_ids to keep for dedup. */
const DEDUP_MAX = 1000;

/** Max file download size (20 MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Contextual emoji reactions — Phase 1 (instant) + Phase 2 (post-response).
 * Uses Feishu emoji_type values from:
 * https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
 */

/** Phase 1: instant reaction based on inbound message content. */
const PHASE1_RULES: Array<{ patterns: RegExp; emoji: string }> = [
  { patterns: /你好|hi\b|hello|hey|早上好|晚上好|早安|晚安|morning|evening/i, emoji: 'WAVE' },
  { patterns: /哈哈|lol|笑|funny|有趣|搞笑|joke|段子|逗/i, emoji: 'LAUGH' },
  { patterns: /谢谢|thanks|thank you|辛苦|感谢|多谢/i, emoji: 'HEART' },
  { patterns: /帮我|请|麻烦|do\b|create|make|生成|建|搭/i, emoji: 'OnIt' },
  { patterns: /分析|看看|检查|查一下|debug|排查|诊断|investigate/i, emoji: 'SMART' },
  { patterns: /code|function|api|deploy|bug|error|报错|代码|部署|编译/i, emoji: 'StatusFlashOfInspiration' },
  { patterns: /写|总结|报告|翻译|review|文档|draft|文章/i, emoji: 'StatusReading' },
  { patterns: /为什么|怎么理解|explain|对比|区别|原理|how|why/i, emoji: 'THINKING' },
  { patterns: /urgent|赶紧|马上|asap|挂了|炸了|紧急|立刻|crash/i, emoji: 'Fire' },
];

/** Phase 2: contextual reactions based on response content (0-2 emojis). */
const PHASE2_RULES: Array<{ patterns: RegExp; emoji: string }> = [
  { patterns: /```[\s\S]{50,}```/m, emoji: 'DONE' },               // code delivered
  { patterns: /\b(fix|fixed|解决|修复|搞定|完成)\b/i, emoji: 'CheckMark' },
  { patterns: /\b(warning|注意|caution|小心|风险)\b/i, emoji: 'Alarm' },
  { patterns: /\b(sorry|抱歉|unfortunately|遗憾|无法|不支持)\b/i, emoji: 'FROWN' },
  { patterns: /[😂🤣😄😆]|哈哈|笑/u, emoji: 'LOL' },
  { patterns: /\|.*\|.*\|/m, emoji: 'Pin' },                       // table
  { patterns: /^\s*(\d+\.|[-*])\s/m, emoji: 'JIAYI' },             // structured list
];

/** Pick Phase 1 emoji. Returns null if no strong match (skip rather than force). */
function pickPhase1Emoji(text: string): string | null {
  for (const rule of PHASE1_RULES) {
    if (rule.patterns.test(text)) return rule.emoji;
  }
  // Long messages suggest deep thinking; short/simple ones → skip
  return text.length > 200 ? 'THINKING' : null;
}

/** Pick Phase 2 emojis from response text. Returns 0-2 emojis (better-to-have). */
function pickPhase2Emojis(_inbound: string, response: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rule of PHASE2_RULES) {
    if (rule.patterns.test(response) && !seen.has(rule.emoji)) {
      seen.add(rule.emoji);
      result.push(rule.emoji);
      if (result.length >= 2) break;
    }
  }
  return result;
}
const PCM_SAMPLE_RATE = 16000;
const WAV_HEADER_BYTES = 44;

/** Shape of the SDK's im.message.receive_v1 event data. */
type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};

type FeishuCardActionEventData = {
  open_id?: string;
  user_id?: string;
  open_message_id?: string;
  tenant_key?: string;
  action?: {
    tag?: string;
    value?: Record<string, unknown>;
    option?: string;
    timezone?: string;
  };
};


/** MIME type guesses by message_type. */
const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

/**
 * Detect MIME type from binary magic bytes. Returns null if unrecognized.
 */
function detectMimeFromBytes(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // Images
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  // RIFF container (WebP or WAV)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    const fourcc = buf.subarray(8, 12).toString('ascii');
    if (fourcc === 'WEBP') return 'image/webp';
    if (fourcc === 'WAVE') return 'audio/wav';
    if (fourcc === 'AVI ') return 'video/avi';
  }
  // OGG (Opus/Vorbis)
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'audio/ogg';
  // MP3 (ID3 tag or sync word)
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg';
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'audio/mpeg';
  // FLAC
  if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) return 'audio/flac';
  // PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  // ZIP (docx/xlsx/pptx are also ZIP)
  if (buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) return 'application/zip';
  // MP4 / M4A (ftyp box)
  if (buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    return 'video/mp4';
  }
  return null;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/mp4': 'm4a',
  'video/mp4': 'mp4', 'video/avi': 'avi',
  'application/pdf': 'pdf', 'application/zip': 'zip',
};

type GeneratedVoiceReply = {
  fileName: string;
  mimeType: string;
  data: Buffer;
};

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private botOpenId: string | null = null;
  /** All known bot IDs (open_id, user_id, union_id) for mention matching. */
  private botIds = new Set<string>();
  /** Track last incoming message ID per chat for typing indicator. */
  private lastIncomingMessageId = new Map<string, string>();
  private lastIncomingText = new Map<string, string>();
  /** Track active typing reaction IDs per chat for cleanup. */
  private typingReactions = new Map<string, string>();
  private tenantAccessToken: string | null = null;
  private tenantAccessTokenExpiresAt = 0;
  private senderNameCache = new Map<string, string | null>();
  private contactPermissionAvailable = true;
  /** Streaming preview: map chatId → message_id of the current preview card. */
  private previewMessages = new Map<string, string>();
  /** Streaming preview: pending sendPreview promise (for awaiting in endPreview). */
  private previewPending = new Map<string, Promise<void>>();
  /** Streaming preview: chats where preview permanently failed. */
  private previewDegraded = new Set<string>();

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id') || '';
    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret') || '';
    const domain = this.resolveDomain();

    // Create REST client
    this.restClient = new lark.Client({
      appId,
      appSecret,
      domain,
    });

    // Resolve bot identity for @mention detection
    await this.resolveBotIdentity(appId, appSecret, domain);

    this.running = true;

    // Register both inbound chat messages and card action callbacks.
    // Feishu long-connection callback delivery is only available when the app
    // is configured for "Receive events/callbacks through persistent connection".
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
      'card.action.trigger': async (data) => {
        return this.handleCardActionEvent(data as FeishuCardActionEventData);
      },
    });

    // Create and start WSClient
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
    });
    this.wsClient.start({ eventDispatcher: dispatcher });

    console.log('[feishu-adapter] Started (botOpenId:', this.botOpenId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Close WebSocket connection (SDK exposes close())
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch (err) {
        console.warn('[feishu-adapter] WSClient close error:', err instanceof Error ? err.message : err);
      }
      this.wsClient = null;
    }
    this.restClient = null;

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Clear state
    this.seenMessageIds.clear();
    this.lastIncomingMessageId.clear();
    this.lastIncomingText.clear();
    this.typingReactions.clear();
    this.senderNameCache.clear();
    this.previewMessages.clear();
    this.previewDegraded.clear();
    this.contactPermissionAvailable = true;
    this.tenantAccessToken = null;
    this.tenantAccessTokenExpiresAt = 0;

    console.log('[feishu-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Contextual emoji reactions ──────────────────────────────

  /**
   * Phase 1: Add an instant contextual emoji reaction to the user's message.
   * Gives immediate acknowledgment with emotional nuance based on message content.
   */
  onMessageStart(chatId: string): void {
    const messageId = this.lastIncomingMessageId.get(chatId);
    const inboundText = this.lastIncomingText.get(chatId) || '';
    if (!messageId || !this.restClient) return;

    const emoji = pickPhase1Emoji(inboundText);
    if (!emoji) return;  // No strong match — skip rather than force

    this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    }).then((res) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reactionId = (res as any)?.data?.reaction_id;
      if (reactionId) {
        this.typingReactions.set(chatId, reactionId);
      }
    }).catch(() => { /* non-critical */ });
  }

  /**
   * Phase 2: Remove Phase 1 emoji, then add 0-N contextual emojis
   * based on the response content. These stay as the "summary reaction".
   */
  onMessageEnd(chatId: string, inboundText?: string, responseText?: string): void {
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!messageId || !this.restClient) return;

    // Remove Phase 1 emoji
    const phase1ReactionId = this.typingReactions.get(chatId);
    this.typingReactions.delete(chatId);
    if (phase1ReactionId) {
      this.restClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: phase1ReactionId },
      }).catch(() => { /* ignore */ });
    }

    // Add Phase 2 emojis (fire-and-forget)
    if (responseText) {
      const emojis = pickPhase2Emojis(inboundText || '', responseText);
      for (const emoji of emojis) {
        this.restClient.im.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emoji } },
        }).catch(() => { /* non-critical */ });
      }
    }
  }

  // ── Streaming preview ────────────────────────────────────────

  getPreviewCapabilities(chatId: string): PreviewCapabilities | null {
    // Global kill switch
    if (getBridgeContext().store.getSetting('bridge_feishu_stream_enabled') === 'false') return null;

    // Already degraded for this chat
    if (this.previewDegraded.has(chatId)) return null;

    return { supported: true, privateOnly: false };
  }

  async sendPreview(chatId: string, text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.restClient) return 'skip';

    // Track this call so endPreview can await it before deleting
    const result = this._doSendPreview(chatId, text);
    this.previewPending.set(chatId, result.then(() => {}));
    return result;
  }

  private async _doSendPreview(chatId: string, text: string): Promise<'sent' | 'skip' | 'degrade'> {
    const cardBody = JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: '\u23F3 Generating...' },
          ],
        },
      ],
    });

    const existingMsgId = this.previewMessages.get(chatId);

    try {
      if (existingMsgId) {
        // Patch the existing preview card
        const res = await this.restClient.im.message.patch({
          path: { message_id: existingMsgId },
          data: { content: cardBody },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((res as any)?.code === 0) return 'sent';
        // Non-zero code — treat as transient unless clearly permanent
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (res as any)?.code;
        if (code === 230001 || code === 230002) {
          // Message not found / no permission — permanent
          this.previewDegraded.add(chatId);
          this.previewMessages.delete(chatId);
          return 'degrade';
        }
        return 'skip';
      } else {
        // Send a new preview card
        const res = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardBody,
          },
        });
        if (res?.data?.message_id) {
          this.previewMessages.set(chatId, res.data.message_id);
          return 'sent';
        }
        return 'skip';
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const httpStatus = (err as any)?.httpStatus ?? (err as any)?.response?.status;
      if (httpStatus === 400 || httpStatus === 404) {
        this.previewDegraded.add(chatId);
        this.previewMessages.delete(chatId);
        return 'degrade';
      }
      // 429 or transient — skip this update
      return 'skip';
    }
  }

  endPreview(chatId: string, _draftId: number, finalText?: string): void {
    const pending = this.previewPending.get(chatId);
    this.previewPending.delete(chatId);

    // Fire-and-forget: await any in-flight sendPreview, then finalize or delete.
    const doEnd = async () => {
      if (pending) await pending.catch(() => {});
      const msgId = this.previewMessages.get(chatId);
      this.previewMessages.delete(chatId);
      if (!msgId || !this.restClient) return;

      if (finalText) {
        // Patch the card with final content — remove "Generating..." footer.
        // The card stays as the final output. No separate delivery needed.
        const card = JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [{ tag: 'markdown', content: finalText }],
        });
        await this.restClient.im.message.patch({
          path: { message_id: msgId },
          data: { content: card },
        }).catch((err: unknown) => {
          console.warn('[feishu-adapter] Final card patch failed:', err instanceof Error ? err.message : err);
        });
      } else {
        // No final text (watchdog/error) — delete the preview card
        await this.restClient.im.message.delete({
          path: { message_id: msgId },
        }).catch(() => {});
      }
    };
    doEnd().catch(() => {});
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    let text = message.text;

    // Convert HTML to markdown for Feishu rendering (e.g. command responses)
    if (message.parseMode === 'HTML') {
      text = htmlToFeishuMarkdown(text);
    }

    // Preprocess markdown for Claude responses
    if (message.parseMode === 'Markdown') {
      text = preprocessFeishuMarkdown(text);
    }

    // If there are inline buttons (permission prompts), send card with action buttons
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(message.address.chatId, text, message.inlineButtons);
    }

    // Rendering strategy (aligned with Openclaw):
    // - Code blocks / tables → interactive card (schema 2.0 markdown)
    // - Other text → post (msg_type: 'post') with md tag
    if (hasComplexMarkdown(text)) {
      return this.sendAsCard(message.address.chatId, text);
    }
    return this.sendAsPost(message.address.chatId, text);
  }

  async sendFileAttachment(chatId: string, attachment: GeneratedVoiceReply): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    try {
      console.log('[feishu-adapter] Uploading outbound file attachment:', attachment.fileName, attachment.mimeType, attachment.data.length);
      const upload = await this.restClient.im.file.create({
        data: {
          file_type: this.resolveUploadFileType(attachment.fileName, attachment.mimeType),
          file_name: attachment.fileName,
          file: attachment.data,
        },
      });

      if (!upload?.file_key) {
        return { ok: false, error: 'Feishu file upload failed' };
      }
      console.log('[feishu-adapter] Outbound file uploaded:', upload.file_key);

      const sent = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: upload.file_key }),
        },
      });

      if (sent?.data?.message_id) {
        console.log('[feishu-adapter] Outbound file message sent:', sent.data.message_id);
        return { ok: true, messageId: sent.data.message_id };
      }
      return { ok: false, error: sent?.msg || 'Feishu file send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Feishu file send failed' };
    }
  }

  /**
   * Send text as an interactive card (schema 2.0 markdown).
   * Used for code blocks and tables — card renders them properly.
   */
  private async sendAsCard(chatId: string, text: string): Promise<SendResult> {
    const cardContent = buildCardContent(text);

    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardContent,
        },
      });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Card send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Card send error, falling back to post:', err instanceof Error ? err.message : err);
    }

    // Fallback to post
    return this.sendAsPost(chatId, text);
  }

  /**
   * Send text as a post message (msg_type: 'post') with md tag.
   * Used for simple text — renders bold, italic, inline code, links.
   */
  private async sendAsPost(chatId: string, text: string): Promise<SendResult> {
    const postContent = buildPostContent(text);

    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: postContent,
        },
      });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Post send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Post send error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Permission card (with real action buttons) ─────────────

  /**
   * Send a permission card with standard Feishu card buttons.
   * Each button carries a structured `value` payload which is consumed by
   * the card.action.trigger callback handler.
   */
  private async sendPermissionCard(
    chatId: string,
    text: string,
    inlineButtons: import('../types').InlineButton[][],
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    // Build button data and command text
    const permButtons: Array<{
      text: string;
      command: string;
      type: 'primary' | 'default' | 'danger';
      callbackData: string;
    }> = [];
    const permCommands: string[] = [];

    inlineButtons.flat().forEach((btn) => {
      if (btn.callbackData.startsWith('perm:')) {
        const parts = btn.callbackData.split(':');
        const action = parts[1];
        const permId = parts.slice(2).join(':');
        const command = `/perm ${action} ${permId}`;

        permCommands.push(`\`${command}\``);

        // Map button styles
        let buttonType: 'primary' | 'default' | 'danger' = 'default';
        if (action === 'allow') buttonType = 'primary';
        if (action === 'deny') buttonType = 'danger';

        permButtons.push({ text: btn.text, command, type: buttonType, callbackData: btn.callbackData });
      }
    });

    const buttonElements = permButtons.map((btn) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: btn.text },
      type: btn.type,
      value: {
        callbackData: btn.callbackData,
        chatId,
      },
    }));

    // Use the classic interactive-card shape (`config/header/elements`).
    // The current Feishu API rejects `tag: action` inside schema 2.0 cards.
    const cardJson = JSON.stringify({
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '🔐 Permission Required' },
      },
      elements: [
        { tag: 'markdown', content: text },
        { tag: 'hr' },
        ...(buttonElements.length > 0 ? [{
          tag: 'action',
          actions: buttonElements,
        }] : []),
        { tag: 'hr' },
        { tag: 'markdown', content: '**Fallback: copy & send one of these commands:**\n' + permCommands.join('\n') },
      ],
    });

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardJson,
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Permission card send failed:', res?.msg);
    } catch (err) {
      console.warn('[feishu-adapter] Permission card error:', err instanceof Error ? err.message : err);
    }

    // Fallback: plain text
    const plainCommands = inlineButtons.flat().map((btn) => {
      if (btn.callbackData.startsWith('perm:')) {
        const parts = btn.callbackData.split(':');
        return `/perm ${parts[1]} ${parts.slice(2).join(':')}`;
      }
      return btn.text;
    });
    const fallbackText = text + '\n\nReply with:\n' + plainCommands.join('\n');

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: fallbackText }),
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  private resolveUploadFileType(fileName: string, mimeType: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
    const lowerName = fileName.toLowerCase();
    const lowerMime = mimeType.toLowerCase();
    if (lowerName.endsWith('.opus') || lowerMime.includes('opus')) return 'opus';
    if (lowerName.endsWith('.mp4') || lowerMime === 'video/mp4') return 'mp4';
    if (lowerName.endsWith('.pdf') || lowerMime === 'application/pdf') return 'pdf';
    if (lowerName.endsWith('.doc') || lowerName.endsWith('.docx')) return 'doc';
    if (lowerName.endsWith('.xls') || lowerName.endsWith('.xlsx')) return 'xls';
    if (lowerName.endsWith('.ppt') || lowerName.endsWith('.pptx')) return 'ppt';
    return 'stream';
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const enabled = getBridgeContext().store.getSetting('bridge_feishu_enabled');
    if (enabled !== 'true') return 'bridge_feishu_enabled is not true';

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id');
    if (!appId) return 'bridge_feishu_app_id not configured';

    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret');
    if (!appSecret) return 'bridge_feishu_app_secret not configured';

    return null;
  }

  private resolveDomain(): lark.Domain {
    const domainSetting = (getBridgeContext().store.getSetting('bridge_feishu_domain') || 'feishu').toLowerCase();
    return domainSetting.includes('lark')
      ? lark.Domain.Lark
      : lark.Domain.Feishu;
  }

  private resolveDomainBase(): string {
    return this.resolveDomain() === lark.Domain.Lark
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_feishu_allowed_users') || '';
    if (!allowedUsers) {
      // No restriction configured — allow all
      return true;
    }

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;

    return allowed.includes(userId) || allowed.includes(chatId);
  }

  // ── Incoming event handler ──────────────────────────────────

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    try {
      await this.processIncomingEvent(data);
    } catch (err) {
      console.error(
        '[feishu-adapter] Unhandled error in event handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private async handleCardActionEvent(
    data: FeishuCardActionEventData,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const value = data.action?.value;
      const callbackData = typeof value?.callbackData === 'string' ? value.callbackData : '';
      const chatId = typeof value?.chatId === 'string' ? value.chatId : '';

      if (!callbackData || !chatId) {
        console.warn('[feishu-adapter] Ignoring card action without callbackData/chatId');
        return undefined;
      }

      const handled = broker.handlePermissionCallback(
        callbackData,
        chatId,
        data.open_message_id,
      );

      const [, , permissionId = ''] = callbackData.split(':');
      const link = permissionId
        ? getBridgeContext().store.getPermissionLink(permissionId)
        : null;
      const targetMessageId = link?.messageId || data.open_message_id;
      const resultCard = this.buildPermissionResultCard(callbackData, handled);

      if (targetMessageId) {
        this.schedulePermissionResultCardPatch(targetMessageId, resultCard);
      }

      if (!handled) {
        console.warn('[feishu-adapter] Permission card action was not accepted:', callbackData);
      }
      // Let Feishu show its default click acknowledgement. We update the
      // original card asynchronously to avoid racing the interaction callback.
      return undefined;
    } catch (err) {
      console.error(
        '[feishu-adapter] Unhandled error in card action handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
      return undefined;
    }
  }

  private buildPermissionResultCard(
    callbackData: string,
    handled: boolean,
  ): Record<string, unknown> {
    const [, action = 'unknown', permissionId = ''] = callbackData.split(':');
    const selectedLabel = this.permissionActionLabel(action);
    const headerTemplate = action === 'deny' ? 'red' : 'green';
    const title = handled ? 'Permission Resolved' : 'Permission Already Handled';
    const summary = handled
      ? `**Selected:** ${selectedLabel}\n**Request ID:** \`${permissionId}\``
      : `**Selection ignored:** ${selectedLabel}\nThis permission request was already handled or no longer exists.\n**Request ID:** \`${permissionId}\``;

    const stateLines = [
      this.buildResolvedButton('Allow', action === 'allow', 'primary'),
      this.buildResolvedButton('Allow Session', action === 'allow_session', 'primary'),
      this.buildResolvedButton('Deny', action === 'deny', 'danger'),
    ];

    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: handled ? headerTemplate : 'grey',
        title: { tag: 'plain_text', content: title },
      },
      elements: [
        { tag: 'markdown', content: summary },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: stateLines,
        },
      ],
    };
  }

  private async patchPermissionResultCard(
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    if (!this.restClient) return;
    try {
      const res = await this.restClient.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      if (res?.code === 0) {
        console.log('[feishu-adapter] Patched permission result card:', messageId);
        return;
      }
      console.warn('[feishu-adapter] Permission result card patch returned non-zero code:', res?.code, res?.msg);
    } catch (err) {
      console.warn('[feishu-adapter] Failed to patch permission result card:', err instanceof Error ? err.message : err);
    }
  }

  private schedulePermissionResultCardPatch(
    messageId: string,
    card: Record<string, unknown>,
  ): void {
    setTimeout(() => {
      void this.patchPermissionResultCard(messageId, card);
    }, 250);
  }

  private buildResolvedButton(
    label: string,
    selected: boolean,
    selectedType: 'primary' | 'danger',
  ): { tag: 'button'; text: { tag: 'plain_text'; content: string }; type: 'default' | 'primary' | 'danger' } {
    return {
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: selected ? `${label} Selected` : `${label} Disabled`,
      },
      type: selected ? selectedType : 'default',
    };
  }

  private permissionActionLabel(action: string): string {
    switch (action) {
      case 'allow':
        return 'Allow';
      case 'allow_session':
        return 'Allow Session';
      case 'deny':
        return 'Deny';
      default:
        return action;
    }
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const msg = data.message;
    const sender = data.sender;

    // [P1] Filter out bot messages to prevent self-triggering loops
    if (sender.sender_type === 'bot') return;

    // Dedup by message_id
    if (this.seenMessageIds.has(msg.message_id)) return;
    this.addToDedup(msg.message_id);

    const chatId = msg.chat_id;
    // [P2] Complete sender ID fallback chain: open_id > user_id > union_id
    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const isGroup = msg.chat_type === 'group';

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[feishu-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
      return;
    }

    // Group chat policy
    if (isGroup) {
      const policy = getBridgeContext().store.getSetting('bridge_feishu_group_policy') || 'open';

      if (policy === 'disabled') {
        console.log('[feishu-adapter] Group message ignored (policy=disabled), chatId:', chatId);
        return;
      }

      if (policy === 'allowlist') {
        const allowedGroups = (getBridgeContext().store.getSetting('bridge_feishu_group_allow_from') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!allowedGroups.includes(chatId)) {
          console.log('[feishu-adapter] Group message ignored (not in allowlist), chatId:', chatId);
          return;
        }
      }

      // Require @mention check
      const requireMention = getBridgeContext().store.getSetting('bridge_feishu_require_mention') !== 'false';
      if (requireMention && !this.isBotMentioned(msg.mentions)) {
        console.log('[feishu-adapter] Group message ignored (bot not @mentioned), chatId:', chatId, 'msgId:', msg.message_id);
        try {
          getBridgeContext().store.insertAuditLog({
            channelType: 'feishu',
            chatId,
            direction: 'inbound',
            messageId: msg.message_id,
            summary: '[FILTERED] Group message dropped: bot not @mentioned (require_mention=true)',
          });
        } catch { /* best effort */ }
        return;
      }
    }

    // Track last message ID and text per chat for contextual emoji reactions
    this.lastIncomingMessageId.set(chatId, msg.message_id);

    // Extract content based on message type
    const messageType = msg.message_type;
    let text = '';
    const attachments: FileAttachment[] = [];

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
    } else if (messageType === 'image') {
      // [P1] Download image with failure fallback
      console.log('[feishu-adapter] Image message received, content:', msg.content);
      const fileKey = this.extractFileKey(msg.content);
      console.log('[feishu-adapter] Extracted fileKey:', fileKey);
      if (fileKey) {
        const attachment = await this.downloadResource(msg.message_id, fileKey, 'image');
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = '[image download failed]';
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] Image download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'file' || messageType === 'audio' || messageType === 'video' || messageType === 'media') {
      // [P2] Support file/audio/video/media downloads
      const fileKey = this.extractFileKey(msg.content);
      if (fileKey) {
        const resourceType = messageType === 'audio' || messageType === 'video' || messageType === 'media'
          ? messageType
          : 'file';
        const attachment = await this.downloadResource(msg.message_id, fileKey, resourceType);
        if (attachment) {
          attachments.push(attachment);
          if (messageType === 'audio') {
            const transcription = await this.transcribeAudioAttachment(attachment);
            if (transcription.transcript) {
              text = this.mergeTranscriptText(text, transcription.transcript);
            } else if (!text.trim()) {
              text = transcription.failureText || this.buildAudioTranscriptionFailureText(attachment);
            }
          }
        } else {
          text = `[${messageType} download failed]`;
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] ${messageType} download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'post') {
      // [P2] Extract text and image keys from rich text (post) messages
      const { extractedText, imageKeys } = this.parsePostContent(msg.content);
      text = extractedText;
      for (const key of imageKeys) {
        const attachment = await this.downloadResource(msg.message_id, key, 'image');
        if (attachment) {
          attachments.push(attachment);
        }
        // Don't add fallback text for individual post images — the text already carries context
      }
    } else if (messageType === 'merge_forward') {
      const result = await this.parseMergeForwardContent(msg.message_id);
      text = result.text;
      attachments.push(...result.attachments);
    } else {
      // Unsupported type — log and skip
      console.log(`[feishu-adapter] Unsupported message type: ${messageType}, msgId: ${msg.message_id}`);
      return;
    }

    // Strip @mention markers from text
    text = this.stripMentionMarkers(text);

    // Store inbound text for Phase 1 emoji reactions
    if (text.trim()) this.lastIncomingText.set(chatId, text.trim());

    if (!text.trim() && attachments.length === 0) return;

    const timestamp = parseInt(msg.create_time, 10) || Date.now();
    const address = {
      channelType: 'feishu' as const,
      chatId,
      userId,
    };

    // [P1] Check for /perm text command (permission approval fallback)
    const trimmedText = text.trim();
    if (trimmedText.startsWith('/perm ')) {
      const permParts = trimmedText.split(/\s+/);
      // /perm <action> <permId>
      if (permParts.length >= 3) {
        const action = permParts[1]; // allow / allow_session / deny
        const permId = permParts.slice(2).join(' ');
        const callbackData = `perm:${action}:${permId}`;

        const inbound: InboundMessage = {
          messageId: msg.message_id,
          address,
          text: trimmedText,
          timestamp,
          callbackData,
        };
        this.enqueue(inbound);
        return;
      }
    }

    const inbound: InboundMessage = {
      messageId: msg.message_id,
      address,
      text: text.trim(),
      timestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: 'feishu',
        chatId,
        direction: 'inbound',
        messageId: msg.message_id,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueue(inbound);
  }

  // ── Merge-forward support ───────────────────────────────────

  /** Max entries in the sender name cache. */
  private static readonly SENDER_CACHE_MAX = 500;

  /**
   * Resolve a Feishu open_id to a human-readable display name.
   * Uses an in-memory LRU cache and the contact.v3.user.get API.
   * Returns null when the name cannot be determined.
   */
  private async resolveUserName(openId: string): Promise<string | null> {
    if (this.senderNameCache.has(openId)) {
      return this.senderNameCache.get(openId)!;
    }

    if (!this.contactPermissionAvailable || !this.restClient) {
      this.senderNameCache.set(openId, null);
      this.evictSenderCacheIfNeeded();
      return null;
    }

    try {
      const res = await this.restClient.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (res as any)?.data?.user;
      const name: string | null = user?.name || null;
      this.senderNameCache.set(openId, name);
      this.evictSenderCacheIfNeeded();
      return name;
    } catch (err) {
      // Permission denied (code 99991401 / 99991403) → disable further attempts
      const code = (err as { code?: number })?.code;
      if (code === 99991401 || code === 99991403) {
        console.warn('[feishu-adapter] Contact permission unavailable, disabling name resolution');
        this.contactPermissionAvailable = false;
      }
      this.senderNameCache.set(openId, null);
      this.evictSenderCacheIfNeeded();
      return null;
    }
  }

  private evictSenderCacheIfNeeded(): void {
    if (this.senderNameCache.size <= FeishuAdapter.SENDER_CACHE_MAX) return;
    const excess = this.senderNameCache.size - FeishuAdapter.SENDER_CACHE_MAX;
    let removed = 0;
    for (const key of this.senderNameCache.keys()) {
      if (removed >= excess) break;
      this.senderNameCache.delete(key);
      removed++;
    }
  }

  /**
   * Parse a merge_forward message: fetch child messages via the get API,
   * resolve sender names, and format as a readable conversation block.
   *
   * Feishu docs: call GET /im/v1/messages/{message_id} with the merge_forward
   * message_id → returns items[] where child messages have upper_message_id
   * pointing to the parent.
   */
  private async parseMergeForwardContent(
    messageId: string,
  ): Promise<{ text: string; attachments: FileAttachment[] }> {
    if (!this.restClient) {
      return { text: '[合并转发消息：客户端未初始化]', attachments: [] };
    }

    try {
      // GET /im/v1/messages/{message_id} returns the merge_forward message
      // itself plus all child messages in data.items[].
      const res = await this.restClient.im.message.get({
        path: { message_id: messageId },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allItems: any[] = (res as any)?.data?.items || [];

      // Filter: only keep child messages whose upper_message_id matches
      // the merge_forward parent. The first item is usually the parent itself.
      const items = allItems.filter(
        (item: any) => item.upper_message_id === messageId,
      );

      if (items.length === 0) {
        return { text: '[合并转发消息：无法获取子消息内容]', attachments: [] };
      }

      const lines: string[] = [];
      const attachments: FileAttachment[] = [];
      const unknownSenderIds = new Set<string>();

      for (const item of items) {
        // The get API returns sender as { sender_id: { open_id, ... }, sender_type }
        const senderId: string = item.sender?.sender_id?.open_id
          || item.sender?.sender_id?.user_id
          || item.sender?.id
          || '';
        const senderType: string = item.sender?.sender_type || '';
        const msgType: string = item.msg_type || '';
        const body: string = typeof item.body?.content === 'string' ? item.body.content : '';
        const childMsgId: string = item.message_id || '';

        // Resolve sender display name
        let senderLabel: string;
        if (senderType === 'bot') {
          senderLabel = '(bot)';
        } else if (senderId) {
          const name = await this.resolveUserName(senderId);
          if (name) {
            senderLabel = name;
          } else {
            senderLabel = senderId;
            unknownSenderIds.add(senderId);
          }
        } else {
          senderLabel = '(unknown)';
        }

        // Parse content by message type
        let content: string;
        if (msgType === 'text') {
          content = this.parseTextContent(body);
        } else if (msgType === 'post') {
          const { extractedText, imageKeys } = this.parsePostContent(body);
          content = extractedText || '[富文本]';
          for (const key of imageKeys) {
            if (childMsgId) {
              const att = await this.downloadResource(childMsgId, key, 'image');
              if (att) attachments.push(att);
            }
          }
        } else if (msgType === 'image') {
          content = '[图片]';
          const fileKey = this.extractFileKey(body);
          if (fileKey && childMsgId) {
            const att = await this.downloadResource(childMsgId, fileKey, 'image');
            if (att) attachments.push(att);
          }
        } else if (msgType === 'file') {
          content = '[文件]';
        } else if (msgType === 'audio') {
          content = '[语音]';
        } else if (msgType === 'video' || msgType === 'media') {
          content = '[视频]';
        } else if (msgType === 'sticker') {
          content = '[表情]';
        } else if (msgType === 'merge_forward') {
          content = '[嵌套合并转发]';
        } else {
          content = `[${msgType || '未知类型'}]`;
        }

        lines.push(`${senderLabel}: ${content}`);
      }

      let text = '--- 以下是一组合并转发的聊天记录 ---\n'
        + lines.join('\n')
        + '\n--- 合并转发结束 ---';

      // If contact permission is unavailable, hint the user
      if (unknownSenderIds.size > 0 && !this.contactPermissionAvailable) {
        const ids = Array.from(unknownSenderIds).join(', ');
        text += `\n(无法自动获取发送者姓名，应用可能缺少通讯录权限。如果你知道这些 ID 对应的人，请告诉我：${ids})`;
      }

      return { text, attachments };
    } catch (err) {
      console.error(
        '[feishu-adapter] Failed to parse merge_forward content:',
        err instanceof Error ? err.stack || err.message : err,
      );
      return {
        text: '[合并转发消息：获取内容失败，请尝试直接复制文字发送]',
        attachments: [],
      };
    }
  }

  // ── Content parsing ─────────────────────────────────────────

  private parseTextContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return parsed.text || '';
    } catch {
      return content;
    }
  }

  /**
   * Extract file key from message content JSON.
   * Handles multiple key names: image_key, file_key, imageKey, fileKey.
   */
  private extractFileKey(content: string): string | null {
    try {
      const parsed = JSON.parse(content);
      return parsed.image_key || parsed.file_key || parsed.imageKey || parsed.fileKey || null;
    } catch {
      return null;
    }
  }

  /**
   * Parse rich text (post) content.
   * Extracts plain text from text elements and image keys from img elements.
   */
  private parsePostContent(content: string): { extractedText: string; imageKeys: string[] } {
    const imageKeys: string[] = [];
    const textParts: string[] = [];

    try {
      const parsed = JSON.parse(content);
      // Post content structure: { title, content: [[{tag, text/image_key}]] }
      const title = parsed.title;
      if (title) textParts.push(title);

      const paragraphs = parsed.content;
      if (Array.isArray(paragraphs)) {
        for (const paragraph of paragraphs) {
          if (!Array.isArray(paragraph)) continue;
          for (const element of paragraph) {
            if (element.tag === 'text' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'a' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'at' && element.user_id) {
              // Mention in post — handled by isBotMentioned for group policy
            } else if (element.tag === 'img') {
              const key = element.image_key || element.file_key || element.imageKey;
              if (key) imageKeys.push(key);
            }
          }
          textParts.push('\n');
        }
      }
    } catch {
      // Failed to parse post content
    }

    return { extractedText: textParts.join('').trim(), imageKeys };
  }

  // ── Bot identity ────────────────────────────────────────────

  /**
   * Resolve bot identity via the Feishu REST API /bot/v3/info/.
   * Collects all available bot IDs for comprehensive mention matching.
   */
  private async resolveBotIdentity(
    appId: string,
    appSecret: string,
    domain: lark.Domain,
  ): Promise<void> {
    try {
      const baseUrl = domain === lark.Domain.Lark
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';

      const token = await this.getTenantAccessToken();
      if (!token) {
        return;
      }

      const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botData: any = await botRes.json();
      if (botData?.bot?.open_id) {
        this.botOpenId = botData.bot.open_id;
        this.botIds.add(botData.bot.open_id);
      }
      // Also record app_id-based IDs if available
      if (botData?.bot?.bot_id) {
        this.botIds.add(botData.bot.bot_id);
      }
      if (!this.botOpenId) {
        console.warn('[feishu-adapter] Could not resolve bot open_id');
      }
    } catch (err) {
      console.warn(
        '[feishu-adapter] Failed to resolve bot identity:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── @Mention detection ──────────────────────────────────────

  /**
   * [P2] Check if bot is mentioned — matches against open_id, user_id, union_id.
   */
  private isBotMentioned(
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((m) => {
      const ids = [m.id.open_id, m.id.user_id, m.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  private stripMentionMarkers(text: string): string {
    // Feishu uses @_user_N placeholders for mentions
    return text.replace(/@_user_\d+/g, '').trim();
  }

  private isAudioTranscriptionEnabled(): boolean {
    return getBridgeContext().store.getSetting('bridge_feishu_audio_transcribe') !== 'false';
  }

  private mergeTranscriptText(text: string, transcript: string): string {
    const cleanedTranscript = transcript.trim();
    if (!cleanedTranscript) return text;
    if (!text.trim()) return `[Voice transcript]\n${cleanedTranscript}`;
    return `${text.trim()}\n\n[Voice transcript]\n${cleanedTranscript}`;
  }

  private async transcribeAudioAttachment(
    attachment: FileAttachment,
  ): Promise<{ transcript: string | null; failureText?: string }> {
    if (!this.isAudioTranscriptionEnabled()) {
      return { transcript: null };
    }

    try {
      const speech = this.toSpeechPayload(attachment);
      if (!speech) {
        console.warn('[feishu-adapter] Audio transcription skipped: unsupported audio format or transcoder unavailable');
        return {
          transcript: null,
          failureText: this.buildAudioTranscriptionFailureText(attachment),
        };
      }

      const token = await this.getTenantAccessToken();
      if (!token) {
        console.warn('[feishu-adapter] Audio transcription skipped: tenant_access_token unavailable');
        return {
          transcript: null,
          failureText: '[voice message received but bridge transcription failed: tenant access token unavailable]',
        };
      }

      const response = await fetch(`${this.resolveDomainBase()}/open-apis/speech_to_text/v1/speech/file_recognize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          speech: { speech },
          config: {
            file_id: this.makeSpeechFileId(),
            format: 'pcm',
            engine_type: '16k_auto',
          },
        }),
      });

      const payload = await response.json() as {
        code?: number;
        msg?: string;
        data?: Record<string, unknown>;
      };
      if (!response.ok || payload.code !== 0) {
        console.warn('[feishu-adapter] Audio transcription failed:', payload.msg || response.statusText);
        const whisperFallback = await this.transcribeWithOpenAIWhisper(attachment);
        if (whisperFallback) {
          return { transcript: whisperFallback };
        }
        return {
          transcript: null,
          failureText: this.buildApiTranscriptionFailureText(payload.msg),
        };
      }

      return {
        transcript: this.extractTranscript(payload.data),
      };
    } catch (err) {
      console.warn('[feishu-adapter] Audio transcription error:', err instanceof Error ? err.message : err);
      return {
        transcript: null,
        failureText: '[voice message received but bridge transcription failed: speech-to-text request errored]',
      };
    }
  }

  private buildAudioTranscriptionFailureText(attachment: FileAttachment): string {
    const name = attachment.name.toLowerCase();
    const type = attachment.type.toLowerCase();
    const explicit = (getBridgeContext().store.getSetting('bridge_audio_transcoder') || '').trim();
    const ffmpegAvailable = (explicit && this.commandExists(explicit))
      || this.commandExists('ffmpeg')
      || this.commandExists('/opt/homebrew/bin/ffmpeg');

    if ((type === 'audio/ogg' || name.endsWith('.ogg') || name.endsWith('.opus')) && !ffmpegAvailable) {
      return '[voice message received but bridge transcription failed: Ogg/Opus audio requires ffmpeg on the bridge host]';
    }

    return '[voice message received but transcription failed]';
  }

  private buildApiTranscriptionFailureText(message: string | undefined): string {
    const text = (message || '').trim();
    if (text.includes('speech_to_text:speech')) {
      return '[voice message received but bridge transcription failed: Feishu app is missing the speech_to_text:speech permission]';
    }
    if (text.includes('request trigger frequency limit')) {
      if (this.getOpenAIApiKey()) {
        return '[voice message received but bridge transcription failed: Feishu STT is rate-limited and the OpenAI Whisper fallback also failed]';
      }
      return '[voice message received but bridge transcription failed: Feishu STT is rate-limited. To enable OpenAI Whisper fallback, set CTI_OPENAI_API_KEY in the bridge config.]';
    }
    if (text) {
      return `[voice message received but bridge transcription failed: ${text}]`;
    }
    return '[voice message received but transcription failed]';
  }

  private getOpenAIApiKey(): string {
    return (getBridgeContext().store.getSetting('bridge_openai_api_key') || '').trim();
  }

  private async transcribeWithOpenAIWhisper(attachment: FileAttachment): Promise<string | null> {
    const apiKey = this.getOpenAIApiKey();
    if (!apiKey) return null;

    try {
      const bytes = Buffer.from(attachment.data, 'base64');
      const form = new FormData();
      form.set('model', 'whisper-1');
      form.set('response_format', 'json');
      form.set('file', new Blob([bytes], { type: attachment.type || 'application/octet-stream' }), attachment.name);

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
      });

      const payload = await response.json() as {
        text?: string;
        error?: { message?: string };
      };

      if (!response.ok) {
        console.warn('[feishu-adapter] OpenAI Whisper fallback failed:', payload.error?.message || response.statusText);
        return null;
      }

      return typeof payload.text === 'string' && payload.text.trim()
        ? payload.text.trim()
        : null;
    } catch (err) {
      console.warn('[feishu-adapter] OpenAI Whisper fallback error:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private makeSpeechFileId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  private extractTranscript(data: Record<string, unknown> | undefined): string | null {
    if (!data) return null;
    const directText = [
      data.recognition_text,
      data.text,
      data.result,
      data.transcript,
    ].find((value) => typeof value === 'string' && value.trim().length > 0);
    if (typeof directText === 'string') return directText.trim();

    const recursive = (value: unknown): string | null => {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value)) {
        const parts = value.map(item => recursive(item)).filter((item): item is string => !!item);
        return parts.length > 0 ? parts.join('\n') : null;
      }
      if (value && typeof value === 'object') {
        for (const nested of Object.values(value as Record<string, unknown>)) {
          const found = recursive(nested);
          if (found) return found;
        }
      }
      return null;
    };

    return recursive(data);
  }

  private async getTenantAccessToken(): Promise<string | null> {
    if (this.tenantAccessToken && Date.now() < this.tenantAccessTokenExpiresAt - 60_000) {
      return this.tenantAccessToken;
    }

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id') || '';
    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret') || '';
    if (!appId || !appSecret) return null;

    const tokenRes = await fetch(`${this.resolveDomainBase()}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenData = await tokenRes.json() as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
      expire_in?: number;
    };

    if (!tokenRes.ok || tokenData.code !== 0 || !tokenData.tenant_access_token) {
      console.warn('[feishu-adapter] Failed to fetch tenant access token:', tokenData.msg || tokenRes.statusText);
      return null;
    }

    const expiresInSeconds = typeof tokenData.expire === 'number'
      ? tokenData.expire
      : typeof tokenData.expire_in === 'number'
        ? tokenData.expire_in
        : 7200;
    this.tenantAccessToken = tokenData.tenant_access_token;
    this.tenantAccessTokenExpiresAt = Date.now() + expiresInSeconds * 1000;
    return this.tenantAccessToken;
  }

  private toSpeechPayload(attachment: FileAttachment): string | null {
    const bytes = Buffer.from(attachment.data, 'base64');
    if (this.isRawPcmAttachment(attachment)) {
      return bytes.toString('base64');
    }

    const wavData = this.extractPcmFromWav(bytes);
    if (wavData) {
      return wavData.toString('base64');
    }

    const transcoded = this.transcodeAudioToPcm(bytes, attachment);
    return transcoded ? transcoded.toString('base64') : null;
  }

  private isRawPcmAttachment(attachment: FileAttachment): boolean {
    const name = attachment.name.toLowerCase();
    const mime = attachment.type.toLowerCase();
    return mime === 'audio/pcm'
      || mime === 'audio/raw'
      || mime === 'audio/l16'
      || name.endsWith('.pcm')
      || name.endsWith('.raw');
  }

  private extractPcmFromWav(bytes: Buffer): Buffer | null {
    if (bytes.byteLength < WAV_HEADER_BYTES) return null;
    if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WAVE') {
      return null;
    }

    let offset = 12;
    let audioFormat = 0;
    let channels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    let dataChunk: Buffer | null = null;

    while (offset + 8 <= bytes.length) {
      const chunkId = bytes.subarray(offset, offset + 4).toString('ascii');
      const chunkSize = bytes.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      const chunkEnd = chunkStart + chunkSize;
      if (chunkEnd > bytes.length) break;

      if (chunkId === 'fmt ' && chunkSize >= 16) {
        audioFormat = bytes.readUInt16LE(chunkStart);
        channels = bytes.readUInt16LE(chunkStart + 2);
        sampleRate = bytes.readUInt32LE(chunkStart + 4);
        bitsPerSample = bytes.readUInt16LE(chunkStart + 14);
      } else if (chunkId === 'data') {
        dataChunk = bytes.subarray(chunkStart, chunkEnd);
      }

      offset = chunkEnd + (chunkSize % 2);
    }

    if (audioFormat !== 1 || channels !== 1 || sampleRate !== PCM_SAMPLE_RATE || bitsPerSample !== 16) {
      return null;
    }
    return dataChunk;
  }

  private transcodeAudioToPcm(bytes: Buffer, attachment: FileAttachment): Buffer | null {
    const explicitTranscoder = getBridgeContext().store.getSetting('bridge_audio_transcoder') || '';
    const transcoders = explicitTranscoder ? [explicitTranscoder] : ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/afconvert'];

    for (const transcoder of transcoders) {
      const trimmed = transcoder.trim();
      if (!trimmed || !this.commandExists(trimmed)) continue;
      const output = trimmed.endsWith('afconvert')
        ? this.transcodeWithAfconvert(trimmed, bytes, attachment)
        : this.transcodeWithFfmpeg(trimmed, bytes, attachment);
      if (output) return output;
    }
    return null;
  }

  private commandExists(command: string): boolean {
    if (path.isAbsolute(command)) {
      return fs.existsSync(command);
    }
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  private transcodeWithFfmpeg(command: string, bytes: Buffer, attachment: FileAttachment): Buffer | null {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-audio-'));
    const inputPath = path.join(tmpDir, this.makeTempAudioName(attachment));
    const outputPath = path.join(tmpDir, 'output.pcm');
    try {
      fs.writeFileSync(inputPath, bytes);
      execFileSync(command, [
        '-nostdin', '-y', '-i', inputPath,
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        '-ac', '1',
        '-ar', String(PCM_SAMPLE_RATE),
        outputPath,
      ], { stdio: 'ignore', timeout: 15_000 });
      return fs.readFileSync(outputPath);
    } catch {
      return null;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private transcodeWithAfconvert(command: string, bytes: Buffer, attachment: FileAttachment): Buffer | null {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-audio-'));
    const inputPath = path.join(tmpDir, this.makeTempAudioName(attachment));
    const outputPath = path.join(tmpDir, 'output.wav');
    try {
      fs.writeFileSync(inputPath, bytes);
      execFileSync(command, [
        '-f', 'WAVE',
        '-d', `LEI16@${PCM_SAMPLE_RATE}`,
        '-c', '1',
        inputPath,
        outputPath,
      ], { stdio: 'ignore', timeout: 15_000 });
      return this.extractPcmFromWav(fs.readFileSync(outputPath));
    } catch {
      return null;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private makeTempAudioName(attachment: FileAttachment): string {
    const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (safeName.includes('.')) return safeName;

    switch (attachment.type) {
      case 'audio/ogg':
        return `${safeName}.ogg`;
      case 'audio/mpeg':
        return `${safeName}.mp3`;
      case 'audio/mp4':
        return `${safeName}.m4a`;
      case 'audio/wav':
      case 'audio/x-wav':
        return `${safeName}.wav`;
      case 'audio/pcm':
        return `${safeName}.pcm`;
      default:
        return `${safeName}.bin`;
    }
  }

  // ── Resource download ───────────────────────────────────────

  /**
   * Download a message resource (image/file/audio/video) via SDK.
   * Returns null on failure (caller decides fallback behavior).
   */
  private async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
  ): Promise<FileAttachment | null> {
    if (!this.restClient) return null;

    try {
      console.log(`[feishu-adapter] Downloading resource: type=${resourceType}, key=${fileKey}, msgId=${messageId}`);

      const res = await this.restClient.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: resourceType === 'image' ? 'image' : 'file',
        },
      });

      if (!res) {
        console.warn('[feishu-adapter] messageResource.get returned null/undefined');
        return null;
      }

      // SDK returns { writeFile, getReadableStream, headers }
      // Try stream approach first, fall back to writeFile + read if stream fails
      let buffer: Buffer;

      try {
        const readable = res.getReadableStream();
        const chunks: Buffer[] = [];
        let totalSize = 0;

        for await (const chunk of readable) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
          chunks.push(buf);
        }
        buffer = Buffer.concat(chunks);
      } catch (streamErr) {
        // Stream approach failed — fall back to writeFile + read
        console.warn('[feishu-adapter] Stream read failed, falling back to writeFile:', streamErr instanceof Error ? streamErr.message : streamErr);

        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const tmpPath = path.join(os.tmpdir(), `feishu-dl-${crypto.randomUUID()}`);
        try {
          await res.writeFile(tmpPath);
          buffer = fs.readFileSync(tmpPath);
          if (buffer.length > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
        }
      }

      if (!buffer || buffer.length === 0) {
        console.warn('[feishu-adapter] Downloaded resource is empty, key:', fileKey);
        return null;
      }

      const base64 = buffer.toString('base64');
      const headerMime = res.headers?.['content-type'] || '';
      const detectedMime = detectMimeFromBytes(buffer);
      // Prefer magic-bytes detection, then HTTP header, then fallback by resource type
      const mimeType = detectedMime || (headerMime && !headerMime.includes('octet-stream') ? headerMime : null) || MIME_BY_TYPE[resourceType] || 'application/octet-stream';
      const ext = MIME_TO_EXT[mimeType] || (resourceType === 'image' ? 'png' : resourceType === 'audio' ? 'ogg' : resourceType === 'video' ? 'mp4' : 'bin');

      console.log(`[feishu-adapter] Resource downloaded: ${buffer.length} bytes, key=${fileKey}, mime=${mimeType} (detected=${detectedMime}, header=${headerMime})`);

      return {
        id: fileKey,
        name: `${fileKey}.${ext}`,
        type: mimeType,
        size: buffer.length,
        data: base64,
      };
    } catch (err) {
      console.error(
        `[feishu-adapter] Resource download failed (type=${resourceType}, key=${fileKey}):`,
        err instanceof Error ? err.stack || err.message : err,
      );
      return null;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);

    // LRU eviction: remove oldest entries when exceeding limit
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(key);
        removed++;
      }
    }
  }
}

// Self-register so bridge-manager can create FeishuAdapter via the registry.
registerAdapterFactory('feishu', () => new FeishuAdapter());
