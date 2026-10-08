import { describe, expect, it } from 'vitest';
import { listVariables } from '../../shared/template.js';
import { convertIntercomVariables } from './intercom.js';

describe('convertIntercomVariables', () => {
  it.each([
    ['{{first_name}}', '{{user}}'],
    ['{{ first_name | fallback: "there" }}', '{{user|there}}'],
    ['{{first_name|fallback:"there"}}', '{{user|there}}'],
    ["{{first_name | fallback: 'friend'}}", '{{user|friend}}'],
    ['{{first_name | fallback: \u201Cthere\u201D}}', '{{user|there}}'],
    ['{{first_name | fallback: there}}', '{{user|there}}'],
    ['{{First Name}}', '{{user}}'],
    ['{{name}}', '{{user}}'],
    ['{{ name | fallback: "Player" }}', '{{user|Player}}'],
    ['{{user.first_name | fallback: "there"}}', '{{user|there}}'],
    ['{{email}}', '{{email}}'],
    ['{{ email | fallback: "your email" }}', '{{email|your email}}'],
    ['{{last_name}}', '{{last_name}}'],
    ['{{Custom Plan | fallback: "basic"}}', '{{custom_plan|basic}}'],
    ['{{company.name}}', '{{company_name}}'],
    ['{{VIP-Level (custom)}}', '{{vip_level_custom}}'],
    ['{{2fa code}}', '{{_2fa_code}}'],
    ['{{ first_name | fallback: "" }}', '{{user|}}'],
  ])('%s -> %s', (input, expected) => {
    expect(convertIntercomVariables(input)).toBe(expected);
  });

  it('leaves MacroPilot-native syntax untouched byte for byte', () => {
    const native = 'Hi {{user|there}}, your {{ amount }} {{Currency}} will arrive in {{eta_time|24 hours}}.';
    expect(convertIntercomVariables(native)).toBe(native);
  });

  it('renames Intercom aliases even in native fallback syntax but keeps the fallback text', () => {
    expect(convertIntercomVariables('{{first_name|my friend}}')).toBe('{{user|my friend}}');
  });

  it('leaves text without attributes and empty braces alone', () => {
    const text = 'Use code {{ }} or {single} braces; {{!!!}} stays.';
    expect(convertIntercomVariables(text)).toBe(text);
  });

  it('converts every attribute in a longer body and produces parseable template variables', () => {
    const body = 'Hi {{ first_name | fallback: "there" }},\n\nWe sent the confirmation to {{email}}. Plan: {{Custom Plan}}.';
    const converted = convertIntercomVariables(body);
    expect(converted).toBe('Hi {{user|there}},\n\nWe sent the confirmation to {{email}}. Plan: {{custom_plan}}.');
    expect(listVariables(converted)).toEqual(['user', 'email', 'custom_plan']);
  });
});
