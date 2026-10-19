import { describe, expect, it, vi } from 'vitest';
import type { ChatGPTModel, SessionState } from '@siwc/local';
import { selectVerificationModel, verifyTokenSharing } from '../electron/verification.js';

const connected: SessionState = { status: 'connected', sharing: true };
const models: ChatGPTModel[] = [
  { slug: 'account-model-a', displayName: 'Account model A' },
  { slug: 'account-model-b', displayName: 'Account model B' },
];

describe('stage A token sharing verification', () => {
  it('rejects promptly when verification is cancelled', async () => {
    const controller = new AbortController();
  
    const streamResponse = vi.fn(({ signal }) =>
      new Promise<{ text: string }>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error();
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })
    );
  
    const pending = verifyTokenSharing(
      { streamResponse },
      models[0],
      controller.signal,
    );
  
    controller.abort();
  
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
  it('does not treat identity-only sign-in as plan authorization', () => {
    expect(() => selectVerificationModel({ status: 'connected', sharing: false }, models))
      .toThrow('尚未取得 ChatGPT plan usage 授權');
  });

  it('only accepts a model returned by the active account', () => {
    expect(selectVerificationModel(connected, models, 'account-model-b')).toEqual(models[1]);
    expect(() => selectVerificationModel(connected, models, 'invented-model'))
      .toThrow('不在目前帳號回傳的模型清單');
  });

  it('defaults to an available Luna model for development', () => {
    const luna = { slug: 'gpt-6-luna', displayName: 'GPT-6 Luna' };
    expect(selectVerificationModel(connected, [models[0], luna])).toEqual(luna);
  });

  it('requires non-empty completed text', async () => {
    const streamResponse = vi.fn().mockResolvedValue({ text: '   ' });
    await expect(verifyTokenSharing({ streamResponse }, models[0], new AbortController().signal))
      .rejects.toThrow('沒有完成文字');
  });

  it('returns the real response and forwards stream deltas', async () => {
    const onDelta = vi.fn();
    const streamResponse = vi.fn(async ({ onDelta: emit }) => {
      emit?.('Token sharing ');
      emit?.('works.');
      return { text: 'Token sharing works.' };
    });
    await expect(verifyTokenSharing(
      { streamResponse }, models[0], new AbortController().signal, onDelta,
    )).resolves.toBe('Token sharing works.');
    expect(onDelta).toHaveBeenCalledTimes(2);
    expect(streamResponse).toHaveBeenCalledWith(expect.objectContaining({ model: 'account-model-a' }));
  });
});
