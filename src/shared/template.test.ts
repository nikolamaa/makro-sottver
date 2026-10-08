import { describe, expect, it } from 'vitest';
import { editRatio, findPlaceholders, listVariables, placeholderLabel, renderTemplate } from './template.js';

describe('template', () => {
  it('lists variables case-insensitively and uniquely', () => {
    expect(listVariables('Hi {{User}}, your {{bonus_name}} for {{user}} {{ eta_time | soon }}')).toEqual([
      'user',
      'bonus_name',
      'eta_time',
    ]);
  });

  it('renders values, fallbacks and placeholders', () => {
    const r = renderTemplate('Hi {{user|there}}, your withdrawal of {{amount}} {{currency}} will arrive in {{eta_time}}.', {
      amount: '250',
      currency: ' USDT ',
      eta_time: '  ',
    });
    expect(r.text).toBe('Hi there, your withdrawal of 250 USDT will arrive in [ENTER ETA TIME].');
    expect(r.filled).toEqual({ amount: '250', currency: 'USDT' });
    expect(r.usedFallback).toEqual(['user']);
    expect(r.placeholders).toEqual([{ label: '[ENTER ETA TIME]', variable: 'eta_time' }]);
  });

  it('does not duplicate placeholders and finds them in edited text', () => {
    const r = renderTemplate('{{tx_hash}} / {{tx_hash}}', {});
    expect(r.placeholders).toHaveLength(1);
    expect(findPlaceholders(r.text)).toEqual(['[ENTER TX HASH]']);
    expect(placeholderLabel('document_type')).toBe('[ENTER DOCUMENT TYPE]');
  });

  it('leaves text without variables untouched', () => {
    expect(renderTemplate('No vars {here}.', { here: 'x' }).text).toBe('No vars {here}.');
  });

  it('computes edit ratio', () => {
    expect(editRatio('abc', 'abc')).toBe(0);
    expect(editRatio('', 'abc')).toBe(1);
    expect(editRatio('kitten', 'sitting')).toBeCloseTo(3 / 7, 5);
  });
});
