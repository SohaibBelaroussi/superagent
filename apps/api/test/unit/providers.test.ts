import { describe, expect, it } from 'vitest';
import { SecretBox } from '../../src/crypto/secret-box';
import { guessModelKind, parseModelList } from '../../src/modules/providers/discovery';
import { providerSlugOf, routerId, unconfiguredRouterId } from '../../src/modules/providers/model-ref';
import { redactSecrets } from '../../src/util/text';

const KEY = Buffer.alloc(32, 1).toString('base64');

describe('SecretBox', () => {
  const box = new SecretBox(KEY);

  it('round-trips a secret', () => {
    const sealed = box.seal('sk-very-secret', 'provider:1:api_key');
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('sk-very-secret');
    expect(box.open(sealed, 'provider:1:api_key')).toBe('sk-very-secret');
  });

  it('uses a fresh IV every time', () => {
    expect(box.seal('same', 'ctx')).not.toBe(box.seal('same', 'ctx'));
  });

  it('refuses a value moved to another row or field', () => {
    const sealed = box.seal('sk-very-secret', 'provider:1:api_key');
    expect(() => box.open(sealed, 'provider:2:api_key')).toThrow();
    expect(() => box.open(sealed, 'provider:1:headers')).toThrow();
  });

  it('detects tampering and wrong keys', () => {
    const sealed = box.seal('sk-very-secret', 'ctx');
    const parts = sealed.split('.');
    const flipped = parts[3]?.startsWith('A') ? `B${parts[3].slice(1)}` : `A${parts[3]?.slice(1)}`;
    expect(() => box.open([parts[0], parts[1], parts[2], flipped].join('.'), 'ctx')).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 2).toString('base64')).open(sealed, 'ctx')).toThrow();
  });

  it('rejects truncated authentication tags', () => {
    const [version, iv, tag, ciphertext] = box.seal('sk-very-secret', 'ctx').split('.');
    const shortTag = Buffer.from(tag ?? '', 'base64url')
      .subarray(0, 4)
      .toString('base64url');
    expect(() => box.open([version, iv, shortTag, ciphertext].join('.'), 'ctx')).toThrow(
      /authentication tag/,
    );
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('model references', () => {
  it('builds gateway router ids, keeping slashes in model ids', () => {
    expect(routerId({ provider: 'home', model: 'Qwen/Qwen3-8B' })).toBe('sa/home/Qwen/Qwen3-8B');
    expect(unconfiguredRouterId('fast')).toBe('sa/unconfigured/fast');
  });

  it('extracts the provider slug with or without the gateway prefix', () => {
    expect(providerSlugOf('sa/home/Qwen/Qwen3-8B')).toBe('home');
    expect(providerSlugOf('home/Qwen/Qwen3-8B')).toBe('home');
  });
});

describe('model discovery parsing', () => {
  it('reads the OpenAI list shape and guesses kinds', () => {
    expect(parseModelList({ object: 'list', data: [{ id: 'chat-a' }, { id: 'text-embedding-3' }] })).toEqual([
      { modelId: 'chat-a', kind: 'chat' },
      { modelId: 'text-embedding-3', kind: 'embedding' },
    ]);
  });

  it('accepts common variants and ignores junk', () => {
    expect(
      parseModelList({ models: [{ name: 'a' }, { model: 'b' }, 'c', 42, null] })?.map((m) => m.modelId),
    ).toEqual(['a', 'b', 'c']);
    expect(parseModelList(['x', 'x', ' y '])).toEqual([
      { modelId: 'x', kind: 'chat' },
      { modelId: 'y', kind: 'chat' },
    ]);
  });

  it('returns null, not an empty list, when there is no model list at all', () => {
    expect(parseModelList({ unexpected: true })).toBeNull();
    expect(parseModelList(null)).toBeNull();
    expect(parseModelList({ data: [] })).toEqual([]);
  });

  it('guesses embedding models from their id', () => {
    expect(guessModelKind('nomic-embed-text')).toBe('embedding');
    expect(guessModelKind('acme-coder')).toBe('chat');
  });
});

describe('redactSecrets', () => {
  it('removes every occurrence of each secret', () => {
    expect(redactSecrets('bad key sk-123456 (sk-123456)', ['sk-123456', null])).toBe(
      'bad key [redacted] ([redacted])',
    );
  });
});
