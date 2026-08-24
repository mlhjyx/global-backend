import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

export interface MultipartS3Client {
  send(
    command: object,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<unknown>;
}

const MULTIPART_PART_BYTES = 5 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function commandOptions(
  signal?: AbortSignal,
): Readonly<{ abortSignal?: AbortSignal }> | undefined {
  return signal ? { abortSignal: signal } : undefined;
}

function readableBody(body: Iterable<Uint8Array>): Readable {
  const stream = Readable.from(body);
  stream.on('error', () => undefined);
  return stream;
}

export async function uploadGenericOperationArtifactStaging(
  input: Readonly<{
    bucket: string;
    key: string;
    body: AsyncIterable<Uint8Array>;
    mediaType: string;
    client: MultipartS3Client;
    unavailable: () => Error;
    signal?: AbortSignal;
  }>,
): Promise<void> {
  let uploadId: string | undefined;
  let uploadCompleted = false;
  const completedParts: Array<{ ETag: string; PartNumber: number }> = [];
  let partChunks: Uint8Array[] = [];
  let partBytes = 0;

  const startMultipart = async (): Promise<string> => {
    if (uploadId) return uploadId;
    const output = asRecord(
      await input.client.send(
        new CreateMultipartUploadCommand({
          Bucket: input.bucket,
          Key: input.key,
          ContentType: input.mediaType,
          ServerSideEncryption: 'AES256',
        }),
        commandOptions(input.signal),
      ),
    );
    if (typeof output?.UploadId !== 'string' || !output.UploadId)
      throw input.unavailable();
    uploadId = output.UploadId;
    return uploadId;
  };

  const flushPart = async (): Promise<void> => {
    if (partBytes === 0) return;
    const currentUploadId = await startMultipart();
    const partNumber = completedParts.length + 1;
    const output = asRecord(
      await input.client.send(
        new UploadPartCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: currentUploadId,
          PartNumber: partNumber,
          Body: readableBody(partChunks),
          ContentLength: partBytes,
        }),
        commandOptions(input.signal),
      ),
    );
    if (typeof output?.ETag !== 'string' || !output.ETag)
      throw input.unavailable();
    completedParts.push({ ETag: output.ETag, PartNumber: partNumber });
    partChunks = [];
    partBytes = 0;
  };

  try {
    for await (const sourceChunk of input.body) {
      if (!uploadId && sourceChunk.byteLength > 0) await startMultipart();
      let offset = 0;
      while (offset < sourceChunk.byteLength) {
        const available = MULTIPART_PART_BYTES - partBytes;
        const length = Math.min(available, sourceChunk.byteLength - offset);
        partChunks.push(sourceChunk.subarray(offset, offset + length));
        partBytes += length;
        offset += length;
        if (partBytes === MULTIPART_PART_BYTES) await flushPart();
      }
    }
    if (!uploadId && partBytes === 0) {
      await input.client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: readableBody([]),
          ContentLength: 0,
          ContentType: input.mediaType,
          ServerSideEncryption: 'AES256',
        }),
        commandOptions(input.signal),
      );
      return;
    }
    await flushPart();
    if (!uploadId || completedParts.length === 0) throw input.unavailable();
    await input.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completedParts },
      }),
      commandOptions(input.signal),
    );
    uploadCompleted = true;
  } finally {
    if (uploadId && !uploadCompleted) {
      await input.client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: input.bucket,
            Key: input.key,
            UploadId: uploadId,
          }),
        )
        .catch(() => undefined);
    }
  }
}
