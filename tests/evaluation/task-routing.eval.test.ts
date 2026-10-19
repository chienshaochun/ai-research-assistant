import { describe, expect, it } from 'vitest';
import { interpretCommand } from '../../electron/research/research-task.js';
import { TASK_ROUTING_CASES } from '../../evaluation/task-routing-cases.js';

describe('fixed task-routing baseline', () => {
  it.each(TASK_ROUTING_CASES)('$id', ({ input, expected }) => {
    expect(interpretCommand(input)).toMatchObject(expected);
  });
});
