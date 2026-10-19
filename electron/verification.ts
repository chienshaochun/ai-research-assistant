import type { ChatGPTClient, ChatGPTModel, SessionState } from '@siwc/local';
import { preferredDevelopmentModel } from '../shared.js';

export const VERIFICATION_PROMPT = 'Reply with exactly: Token sharing works.';

export function selectVerificationModel(
  session: SessionState,
  models: ChatGPTModel[],
  requestedSlug?: string,
): ChatGPTModel {
  if (session.status !== 'connected') throw new Error('請先完成 ChatGPT 登入。');
  if (!session.sharing) throw new Error('已登入，但尚未取得 ChatGPT plan usage 授權。');
  if (models.length === 0) throw new Error('此帳號目前沒有可用模型。');
  if (!requestedSlug) return preferredDevelopmentModel(models)!;
  const model = models.find((candidate) => candidate.slug === requestedSlug);
  if (!model) throw new Error('指定模型不在目前帳號回傳的模型清單中。');
  return model;
}

export async function verifyTokenSharing(
  chatgpt: Pick<ChatGPTClient, 'streamResponse'>,
  model: ChatGPTModel,
  signal: AbortSignal,
  onDelta?: (delta: string) => void,
): Promise<string> {
  const result = await chatgpt.streamResponse({
    model: model.slug,
    input: VERIFICATION_PROMPT,
    signal,
    onDelta,
  });
  const text = result.text.trim();
  if (!text) throw new Error('模型串流已結束，但沒有完成文字。');
  return text;
}
