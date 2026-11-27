export const MAX_SELLER_DOCUMENT_INGEST_ATTEMPTS = 8;
export const MAX_SELLER_DOCUMENT_RETRY_SECONDS = 3600;

// Lease-fenced parser checkpoints live alongside parsed metadata and are stripped from API reads.
export const SELLER_DOCUMENT_DOCLING_TASKS_KEY = '_doclingTasks';
