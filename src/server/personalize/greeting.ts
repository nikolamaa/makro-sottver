/**
 * Greeting detection, splitting and insertion. Pure functions, no I/O.
 */
import { renderTemplate } from '../../shared/template.js';
import { variableValue } from './text.js';

const GREETING_WORDS = String.raw`(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening)|greetings)\b`;

/** The first non-empty line starts with a greeting word (case-insensitive). */
const GREETING_RE = new RegExp(`^\\s*${GREETING_WORDS}`, 'i');

/** A short greeting followed by more content on the same line: "Hi John, your withdrawal is ...". */
const INLINE_GREETING_RE = new RegExp(`^(${GREETING_WORDS}[^,!.?\\n]{0,40}[,!])[ \\t]+(\\S.*)$`, 'i');

/** `{{user}}` without an inline fallback (an inline fallback chosen by the macro author wins over the setting). */
const BARE_USER_VAR_RE = /\{\{\s*user\s*\}\}/gi;

export interface GreetingSplit {
  /** The greeting itself, e.g. "Hi John," (leading blank lines removed). */
  greeting: string;
  /** Whitespace that separated the greeting from the rest: " " (same line), "\n" or "\n\n". */
  separator: string;
  /** Everything after the greeting (may be empty). */
  rest: string;
}

/** True when the first non-empty line starts with hi/hello/hey/dear/good morning|afternoon|evening/greetings. */
export function startsWithGreeting(text: string): boolean {
  return GREETING_RE.test(text);
}

/**
 * Split a text into its leading greeting and the rest, or null when it does not start with a greeting.
 * A greeting line such as "Hi John," stays a unit; "Hi John, your withdrawal ..." is split after the comma.
 */
export function splitGreeting(text: string): GreetingSplit | null {
  if (!startsWithGreeting(text)) return null;
  const trimmed = text.replace(/^\s+/, '');
  const newline = trimmed.indexOf('\n');
  const firstLine = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trimEnd();
  const remainder = newline === -1 ? '' : trimmed.slice(newline);

  const inline = INLINE_GREETING_RE.exec(firstLine);
  if (inline?.[1] && inline[2]) {
    return { greeting: inline[1], separator: ' ', rest: inline[2] + remainder };
  }
  const gap = /^\s*/.exec(remainder)?.[0] ?? '';
  const newlines = gap.split('\n').length - 1;
  return {
    greeting: firstLine,
    separator: newlines >= 2 ? '\n\n' : '\n',
    rest: remainder.slice(gap.length),
  };
}

/**
 * Replace a bare `{{user}}` with the configured fallback (e.g. "there") when no user value is known.
 * `{{user|valued customer}}` keeps its own inline fallback.
 */
export function withUserFallback(template: string, vars: Record<string, string>, userFallback: string): string {
  const fallback = userFallback.trim();
  if (!fallback || variableValue(vars, 'user') !== undefined) return template;
  return template.replace(BARE_USER_VAR_RE, () => fallback);
}

/**
 * Ensure the reply starts with a greeting. If the text already starts with a greeting (hi/hello/hey/dear/
 * good morning...), it is kept. Otherwise `greetingTemplate` (e.g. "Hi {{user}},") is rendered with `vars`
 * (user falls back to `userFallback`) and prepended on its own line, followed by a blank line.
 * An empty greeting template leaves the text unchanged.
 */
export function ensureGreeting(text: string, greetingTemplate: string, vars: Record<string, string>, userFallback: string): string {
  if (startsWithGreeting(text)) return text;
  const greeting = renderTemplate(withUserFallback(greetingTemplate, vars, userFallback), vars).text.trim();
  if (!greeting) return text;
  const body = text.replace(/^\s+/, '');
  return body ? `${greeting}\n\n${body}` : greeting;
}
