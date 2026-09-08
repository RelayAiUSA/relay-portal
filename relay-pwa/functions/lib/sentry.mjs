// relay-pwa/functions/lib/sentry.mjs
//
// Reports errors to Sentry over its envelope HTTP endpoint, with no SDK.
//
// Why no @sentry/node:
//   1. Bundling. The twilio SDK's dynamic requires could not be resolved by
//      esbuild and crashed every function at import (see CLAUDE.md). Adding
//      another large SDK to the same bundler is avoidable risk.
//   2. Flushing. In serverless, the SDK queues events and the runtime can
//      freeze before they are sent, silently dropping exactly the errors you
//      most wanted. Awaiting a single fetch has no such window.
//   3. Size. This file is a few KB against roughly a megabyte of SDK.
//
// The trade is that automatic breadcrumbs and performance tracing are not
// included. Error reporting - the reason this exists - is.
//
// Env: SENTRY_DSN. Unset means this is a silent no-op, which is the correct
// behaviour for local work and for a deploy where monitoring is not wanted.

const DSN     = process.env.SENTRY_DSN || '';
const RELEASE = process.env.COMMIT_REF || process.env.SENTRY_RELEASE || 'unknown';
const ENVIRONMENT = process.env.CONTEXT || 'production';   // Netlify sets CONTEXT

/** Split a DSN into the pieces needed to build the ingest URL. */
export function parseDsn(dsn) {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, '');
    if (!u.username || !projectId) return null;
    return {
      publicKey: u.username,
      host:      u.host,
      projectId,
      endpoint:  `${u.protocol}//${u.host}/api/${projectId}/envelope/`,
    };
  } catch {
    return null;
  }
}

/**
 * Turn a V8 stack string into Sentry frames.
 * Sentry renders frames oldest-first, so the array is reversed: the line that
 * actually threw ends up at the bottom of the report, where it is read first.
 */
export function parseStack(stack) {
  const frames = [];
  for (const line of String(stack || '').split('\n').slice(1)) {
    // "    at fn (/path/file.mjs:12:34)"  or  "    at /path/file.mjs:12:34"
    const m = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    frames.push({
      function: m[1] || '<anonymous>',
      filename: m[2],
      lineno:   Number(m[3]),
      colno:    Number(m[4]),
      in_app:   !m[2].includes('node_modules') && !m[2].startsWith('node:'),
    });
  }
  return frames.reverse();
}

function uuid32() {
  const b = new Uint8Array(16);
  (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Build the event body. Exported so it can be asserted in tests. */
export function buildEvent(err, { fn, level = 'error', tags = {}, extra = {} } = {}) {
  const eventId = uuid32();
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    event_id:    eventId,
    timestamp:   Date.now() / 1000,
    platform:    'node',
    level,
    logger:      fn || 'function',
    release:     RELEASE,
    environment: ENVIRONMENT,
    server_name: fn || undefined,
    tags:        { function: fn || 'unknown', ...tags },
    extra,
    exception: {
      values: [{
        type:  e.name || 'Error',
        value: String(e.message || e).slice(0, 2000),
        stacktrace: { frames: parseStack(e.stack) },
      }],
    },
  };
}

/**
 * Send an error to Sentry. Never throws and never rejects: reporting a failure
 * must not itself become a failure, and must never mask the original error.
 * @returns {Promise<{sent: boolean, reason: string}>}
 */
export async function captureException(err, opts = {}) {
  if (!DSN) return { sent: false, reason: 'no_dsn' };
  const parsed = parseDsn(DSN);
  if (!parsed) return { sent: false, reason: 'bad_dsn' };

  try {
    const event = buildEvent(err, opts);
    const body = [
      JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString(), dsn: DSN }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n');

    const res = await fetch(parsed.endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body,
      signal:  AbortSignal.timeout(3000),   // never hold a response open for telemetry
    });
    if (!res.ok) {
      console.error('[sentry] rejected:', res.status, (await res.text()).slice(0, 200));
      return { sent: false, reason: `http_${res.status}` };
    }
    return { sent: true, reason: 'ok' };
  } catch (e) {
    console.error('[sentry] send failed:', e?.message);
    return { sent: false, reason: 'exception' };
  }
}
