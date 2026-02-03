/**
 * Worker Environment Types
 */

export interface Env {
  WORKSPACE: DurableObjectNamespace;
  API_KEY: string;
  FILES: R2Bucket;
}

/**
 * File storage types
 */
export type FileType = 'attachments' | 'downloads' | 'long_responses';

export interface FileMetadata {
  name: string;
  size: number;
  mimeType: string;
  uploadedAt: number;
}

export const VALID_FILE_TYPES: FileType[] = ['attachments', 'downloads', 'long_responses'];

export function isValidFileType(type: string): type is FileType {
  return VALID_FILE_TYPES.includes(type as FileType);
}
