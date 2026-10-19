const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

export function requiredIpcText(value: unknown, label: string, maximum: number): string {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error('IPC 文字上限設定無效。');
  if (typeof value !== 'string') throw new Error(`${label} 必須是文字。`);
  const text = value.trim();
  if (!text || text.length > maximum || FORBIDDEN_CONTROLS.test(text)) {
    throw new Error(`${label} 必須是 1 到 ${maximum} 個可顯示字元。`);
  }
  return text;
}

export function optionalIpcText(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredIpcText(value, label, maximum);
}
