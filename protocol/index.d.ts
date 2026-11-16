/** Public protocol v1. User media and credentials never transit Fanclan servers. */
export type RecordingStatus = 'queued' | 'starting' | 'recording' | 'stopping' | 'finalizing' | 'completed' | 'interrupted' | 'failed';
export type RecordingFormat = 'mp4' | 'mkv' | 'ts';
export type RecordingQuality = 'best' | '1080p' | '720p' | '480p' | '360p';
export type MediaKind = 'stream' | 'download' | 'preview' | 'thumbnail';
export interface CompanionInfo {
  name: 'StreamSnipe'; version: string; protocolVersion: 1; mode: 'desktop' | 'docker';
}
export interface PairingChallenge {
  id: string; code: string; expiresAt: string; pollToken: string;
}
export interface PairingStatus {
  status: 'pending' | 'approved' | 'expired'; token?: string;
}
export interface Channel {
  id: string; name: string; url: string; platform: string; quality: RecordingQuality;
  autoRecord: boolean; enabled: boolean; isLive: boolean; lastChecked?: string;
  createdAt: string; updatedAt: string;
}
export interface Recording {
  id: string; channelId?: string; url: string; platform: string; title: string;
  status: RecordingStatus; quality: RecordingQuality; format: RecordingFormat;
  fileSize: number; duration?: number; startedAt: string; completedAt?: string;
  error?: string; hasPreview: boolean; hasThumbnail: boolean; uploadedToCloud: boolean;
  uploadState?: 'uploading' | 'completed' | 'failed' | 'cancelled'; uploadProgress?: number;
}
export interface StartRecording {
  url: string; title?: string; channelId?: string; quality?: RecordingQuality; format?: RecordingFormat;
}
export interface MediaTicket {url: string; expiresAt: string}
export interface Settings {
  recordingsPath: string; defaultQuality: RecordingQuality; defaultFormat: RecordingFormat;
  monitorIntervalSeconds: number; maxConcurrentRecordings: number; maxDiskUsagePercent: number;
  autoCleanupEnabled: boolean; autoCleanupDays: number;
  s3Enabled: boolean; s3Bucket: string; s3Region: string; s3Endpoint: string;
  hasS3Credentials: boolean; lockedFields?: string[];
}
export type SettingsUpdate = Partial<Omit<Settings, 'hasS3Credentials' | 'lockedFields'>> & {
  s3AccessKeyId?: string; s3SecretAccessKey?: string;
  uploadDestinationApproval?: string;
};
export type UploadDestination = Pick<Settings, 's3Enabled' | 's3Bucket' | 's3Region' | 's3Endpoint'>;
export interface UploadApprovalRequest {id: string; expiresAt: string}
export interface UploadApprovalStatus {
  status: 'pending' | 'approved' | 'rejected' | 'expired'; approvalToken?: string;
}
export interface SystemStatus {
  activeRecordings: number; totalRecordings: number; totalChannels: number;
  disk: {total: number; used: number; available: number; usedPercent: number};
  version: string; uptime: number;
}
export interface Session {id: string; name: string; createdAt: string; expiresAt: string}
export type CompanionEvent =
  | {type: 'recording_update'; data: Recording}
  | {type: 'channel_update'; data: Channel}
  | {type: 'notification'; data: {message?: string; [key: string]: unknown}};
export interface ApiError {error: string; code?: string}
