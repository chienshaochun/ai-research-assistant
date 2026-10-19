import { describe, expect, it } from 'vitest';
import { optionalIpcText, requiredIpcText } from '../electron/ipc-input.js';

describe('IPC input validation', () => {
  it('normalizes valid text at the main-process boundary', () => {
    expect(requiredIpcText('  最近七天 AI Agent  ', '研究指令', 100))
      .toBe('最近七天 AI Agent');
  });

  it('rejects non-text, empty, oversized, and control-character values', () => {
    expect(() => requiredIpcText({ command: 'research' }, '研究指令', 100))
      .toThrow('必須是文字');
    expect(() => requiredIpcText('   ', '研究指令', 100)).toThrow('1 到 100');
    expect(() => requiredIpcText('x'.repeat(101), '研究指令', 100)).toThrow('1 到 100');
    expect(() => requiredIpcText('research\u0000now', '研究指令', 100)).toThrow('1 到 100');
  });

  it('only treats an omitted optional argument as absent', () => {
    expect(optionalIpcText(undefined, '模型名稱', 200)).toBeUndefined();
    expect(() => optionalIpcText(null, '模型名稱', 200)).toThrow('必須是文字');
  });
});
