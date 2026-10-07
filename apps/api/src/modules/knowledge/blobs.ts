import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** Where uploaded files are kept (decision D09: SeaweedFS behind its S3 API). */
export interface BlobStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  close?(): void;
}

export interface S3Options {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;

  constructor(private readonly options: S3Options) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
    });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return object.Body ? await object.Body.transformToByteArray() : undefined;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  close(): void {
    this.client.destroy();
  }
}

/** Keeps blobs in memory (tests). */
export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key)?.body;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
