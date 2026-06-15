/**
 * WebSocket 消息类型定义
 * RemoteBridge 通信协议核心
 */

// ===== 消息类型枚举 =====
export enum WSMessageType {
  // 连接管理
  PING = 'PING',
  PONG = 'PONG',
  CLIENT_JOINED = 'CLIENT_JOINED',
  CLIENT_LEFT = 'CLIENT_LEFT',
  HOST_ONLINE = 'HOST_ONLINE',
  HOST_OFFLINE = 'HOST_OFFLINE',
  SESSION_REVOKED = 'SESSION_REVOKED',

  // 目录操作
  CMD_LIST_DIR = 'CMD_LIST_DIR',
  RESP_DIR_LIST = 'RESP_DIR_LIST',
  RESP_DIR_ERROR = 'RESP_DIR_ERROR',
  CMD_LIST_ALLOWED = 'CMD_LIST_ALLOWED',

  // 文件预览
  CMD_REQUEST_PREVIEW = 'CMD_REQUEST_PREVIEW',
  RESP_PREVIEW_READY = 'RESP_PREVIEW_READY',
  RESP_PREVIEW_ERROR = 'RESP_PREVIEW_ERROR',

  // 文件下载
  CMD_REQUEST_DOWNLOAD = 'CMD_REQUEST_DOWNLOAD',
  RESP_DOWNLOAD_READY = 'RESP_DOWNLOAD_READY',
  RESP_DOWNLOAD_ERROR = 'RESP_DOWNLOAD_ERROR',

  // 文件隧道（Relay 代理 ↔ Host，不经过 Client）
  // Host 的本地文件服务器只监听 127.0.0.1，Relay 跨 NAT 无法直接 HTTP 拉取，
  // 文件内容必须借道 Host 已建立的出站 WS 连接分块回传
  CMD_FETCH_FILE = 'CMD_FETCH_FILE',
  RESP_FILE_CHUNK = 'RESP_FILE_CHUNK',
  RESP_FILE_ERROR = 'RESP_FILE_ERROR',

  // 消息通知
  MSG_TEXT = 'MSG_TEXT',
  MSG_SYSTEM = 'MSG_SYSTEM',
  MSG_NOTIFICATION = 'MSG_NOTIFICATION',

  // 错误处理
  ERROR = 'ERROR',
  ACK = 'ACK',
}

// ===== 基础消息结构 =====
export interface WSMessage {
  id: string;
  type: WSMessageType | string;
  payload: unknown;
  timestamp: number;
  sessionId?: string;
  senderId?: string;
  senderType?: string;
}

// ===== 文件条目 =====
export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  modifiedAt: number;
  extension: string;
  isPreviewable: boolean;
}

// ===== 中继路由字段 =====
// Relay 在转发 CMD_* 时注入到 payload；Host 必须在 RESP_* 中原样回显,
// Relay 依赖这两个字段把响应路由回正确的 Client。
export interface RelayRoutingFields {
  clientId?: string;
  sessionId?: string;
}

// ===== 目录操作 Payload =====
export interface CmdListDirPayload extends RelayRoutingFields {
  path: string;
  requestId: string;
}

export interface RespDirListPayload extends RelayRoutingFields {
  requestId: string;
  /** 列出的目录路径；为 null 时表示白名单根列表（CMD_LIST_ALLOWED 的响应） */
  path: string | null;
  entries: FileEntry[];
  parentPath: string | null;
}

export interface RespDirErrorPayload extends RelayRoutingFields {
  requestId: string;
  code: string;
  message: string;
}

// ===== 文件预览 Payload =====
export interface CmdRequestPreviewPayload extends RelayRoutingFields {
  filePath: string;
  requestId: string;
}

export interface RespPreviewReadyPayload extends RelayRoutingFields {
  requestId: string;
  previewUrl: string;
  fileName: string;
  fileSize: number;
  extension: string;
  category: 'image' | 'text' | 'pdf' | 'unknown';
  expiresAt: number;
}

export interface RespPreviewErrorPayload extends RelayRoutingFields {
  requestId: string;
  code: string;
  message: string;
}

// ===== 文件下载 Payload =====
export interface CmdRequestDownloadPayload extends RelayRoutingFields {
  filePath: string;
  requestId: string;
}

export interface RespDownloadReadyPayload extends RelayRoutingFields {
  requestId: string;
  downloadUrl: string;
  fileName: string;
  fileSize: number;
  expiresAt: number;
}

export interface RespDownloadErrorPayload extends RelayRoutingFields {
  requestId: string;
  code: string;
  message: string;
}

// ===== 文件隧道 Payload（Relay ↔ Host 专用，永不中继给 Client） =====
export interface CmdFetchFilePayload {
  transferId: string;
  /** 下载/预览令牌（单次使用，由 CMD_REQUEST_DOWNLOAD / CMD_REQUEST_PREVIEW 签发） */
  token: string;
  /** 字节范围（含端点）；缺省表示完整文件。仅支持 start-end 形式 */
  rangeStart?: number;
  rangeEnd?: number;
}

/**
 * RESP_FILE_CHUNK 的线上格式（P1-12）：非空分块的首选传输方式是
 * `packages/shared/src/file-tunnel-codec.ts` 定义的自描述二进制 WS 帧
 * （`encodeFileChunkFrame`/`decodeFileChunkFrame`），而不是本接口描述的
 * JSON+base64 形式。Relay 通过 WS `message` 事件的 `isBinary` 标志区分两种格式，
 * 二进制路径优先；本接口仅用于：
 *  - 空文件场景（totalSize === 0 的单帧 eof 响应，仍走 JSON）；
 *  - 旧版（未更新）Host 走的 legacy JSON 解析路径的解析目标类型。
 * 两条路径最终都规范化为内部 `data: Buffer` 形态，proxy.ts 无需分支处理。
 */
export interface RespFileChunkPayload {
  transferId: string;
  /** 分块序号，从 0 递增 */
  seq: number;
  /** base64 编码的文件内容分块；eof 帧可为空串 */
  data: string;
  eof: boolean;
  /**
   * 以下文件元信息字段只在首帧（seq === 0）携带，后续分块帧省略——
   * 消费端构造响应头只需读取首帧。
   */
  /** 文件总大小（字节），Relay 据此构造 Content-Range */
  totalSize?: number;
  /** 本次传输实际覆盖的字节范围（含端点） */
  rangeStart?: number;
  rangeEnd?: number;
  /** MIME 类型（预览需要；下载用 octet-stream） */
  contentType?: string;
  fileName?: string;
}

export interface RespFileErrorPayload {
  transferId: string;
  code: string;
  message: string;
}

// ===== 消息 Payload =====
export interface MsgTextPayload {
  content: string;
  senderId: string;
  senderLabel: string;
}

export interface MsgSystemPayload {
  content: string;
  level: 'info' | 'warning' | 'error';
}

// ===== 连接事件 Payload =====
export interface ClientJoinedPayload {
  clientId: string;
  clientLabel: string;
  timestamp: number;
}

export interface ClientLeftPayload {
  clientId: string;
  timestamp: number;
}

export interface HostOnlinePayload {
  hostId: string;
  hostName: string;
  timestamp: number;
}

export interface HostOfflinePayload {
  hostId: string;
  timestamp: number;
}

export interface SessionRevokedPayload {
  sessionId: string;
  reason: string;
  timestamp: number;
}

// ===== 错误 Payload =====
export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}
