/**
 * Converts Intercom attribute syntax in macro bodies to MacroPilot template syntax (src/shared/template.ts).
 *
 *   {{first_name}}                           -> {{user}}
 *   {{ first_name | fallback: "there" }}     -> {{user|there}}
 *   {{name}}                                 -> {{user}}
 *   {{email}}, {{last_name}}                 -> unchanged
 *   {{Custom Plan | fallback: 'basic'}}      -> {{custom_plan|basic}}
 *   {{user|there}} (MacroPilot-native)       -> unchanged, byte for byte
 */

const MUSTACHE_RE = /\{\{([^{}]*)\}\}/g;
const NATIVE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTERCOM_FALLBACK_RE = /^\s*fallback\s*:\s*/i;
const ATTRIBUTE_PREFIX_RE = /^(?:user|contact|lead|customer)\./;
const INVALID_NAME_CHARS_RE = /[^a-z0-9_]+/g;
const EDGE_UNDERSCORES_RE = /^_+|_+$/g;
const LEADING_DIGIT_RE = /^[0-9]/;
const OPENING_QUOTES = new Set(['"', "'", '“', '‘']);
const CLOSING_QUOTES = new Set(['"', "'", '”', '’']);

/** Intercom person attributes that map onto MacroPilot's standard {{user}} variable. */
const ATTRIBUTE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['first_name', 'user'],
  ['firstname', 'user'],
  ['name', 'user'],
]);

/** Rewrite every Intercom-style {{ attribute | fallback: "x" }} in `body`; everything else is left untouched. */
export function convertIntercomVariables(body: string): string {
  return body.replace(MUSTACHE_RE, convertToken);
}

function convertToken(raw: string, inner: string): string {
  const pipe = inner.indexOf('|');
  const rawName = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const rawFallback = pipe === -1 ? null : inner.slice(pipe + 1);
  const isIntercomFallback = rawFallback !== null && INTERCOM_FALLBACK_RE.test(rawFallback);
  const isNativeName = NATIVE_NAME_RE.test(rawName) && !ATTRIBUTE_ALIASES.has(rawName.toLowerCase());
  if (isNativeName && !isIntercomFallback) return raw;

  const name = toVariableName(rawName);
  if (!name) return raw;
  if (rawFallback === null) return `{{${name}}}`;
  const fallback = isIntercomFallback ? unquote(rawFallback.replace(INTERCOM_FALLBACK_RE, '').trim()) : rawFallback;
  return `{{${name}|${fallback}}}`;
}

/** Lowercase, strip "user."-style prefixes, replace invalid characters with "_" and apply aliases. */
function toVariableName(rawName: string): string {
  const cleaned = rawName
    .toLowerCase()
    .replace(ATTRIBUTE_PREFIX_RE, '')
    .replace(INVALID_NAME_CHARS_RE, '_')
    .replace(EDGE_UNDERSCORES_RE, '');
  if (!cleaned) return '';
  const name = LEADING_DIGIT_RE.test(cleaned) ? `_${cleaned}` : cleaned;
  return ATTRIBUTE_ALIASES.get(name) ?? name;
}

function unquote(text: string): string {
  if (text.length >= 2 && OPENING_QUOTES.has(text.charAt(0)) && CLOSING_QUOTES.has(text.charAt(text.length - 1))) {
    return text.slice(1, -1);
  }
  return text;
}
