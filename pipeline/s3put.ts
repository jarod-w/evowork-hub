/**
 * 往 MinIO 传一个对象：S3 的 PutObject + AWS SigV4 签名，只用 node 自带的 crypto。
 *
 * 为什么不用 mc：它是个 30MB 的二进制，而试点服务器的出网带宽只有每秒十几 KB
 * （2026-10-03 实测，拷一份 mc 要半小时），发版机上又没法直接从镜像下载。
 * 我们只需要「PUT 几个小文件」这一个动作，自己签名比拖一个客户端进来更简单、更好审。
 */
import { createHash, createHmac } from 'node:crypto';

export interface S3Target {
  /** 例如 `http://127.0.0.1:19000`（ssh 隧道的本地端）。 */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly region?: string | undefined;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

export function signPut(
  target: S3Target,
  key: string,
  body: Uint8Array,
  contentType: string,
  now: Date,
): { readonly url: string; readonly headers: Record<string, string> } {
  const region = target.region ?? 'us-east-1';
  const url = new URL(target.endpoint);
  const path = `/${target.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers: Record<string, string> = {
    'content-type': contentType,
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    'PUT',
    path,
    '',
    ...names.map((n) => `${n}:${headers[n]}`),
    '',
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${target.secretKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    url: `${url.origin}${path}`,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${target.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
  };
}

export async function putObject(target: S3Target, key: string, body: Uint8Array, contentType: string): Promise<void> {
  const { url, headers } = signPut(target, key, body, contentType, new Date());
  const { host: _host, ...sendHeaders } = headers;
  const res = await fetch(url, { method: 'PUT', headers: sendHeaders, body: Buffer.from(body) });
  if (res.status !== 200) {
    throw new Error(`上传 ${key} 失败：${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
