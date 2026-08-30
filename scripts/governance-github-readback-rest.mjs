import { TextDecoder } from 'node:util';

import {
  API_ORIGIN,
  API_VERSION,
  approvalError,
  deepFreeze,
  hasExactKeys,
  isSafePositiveInteger,
  isSafeString,
  requireCondition,
  stableJson,
} from './governance-github-readback-common.mjs';

const CLIENT_KEYS = Object.freeze(['fetch', 'token', 'apiVersion']);
const clientStates = new WeakMap();

export const createRestClient = (options) => {
  requireCondition(
    hasExactKeys(options, CLIENT_KEYS)
      && typeof options.fetch === 'function'
      && isSafeString(options.token, 4096)
      && !/[\r\n]/.test(options.token),
    'APPROVAL_GITHUB_CLIENT_INVALID',
  );
  requireCondition(options.apiVersion === API_VERSION, 'APPROVAL_GITHUB_API_VERSION_INVALID');
  const client = deepFreeze({ schema_version: 'github-readback-client/v1' });
  clientStates.set(client, Object.freeze({ fetch: options.fetch, token: options.token }));
  return client;
};

export const getRestState = (client) => {
  const state = clientStates.get(client);
  requireCondition(state !== undefined, 'APPROVAL_GITHUB_CLIENT_INVALID');
  return state;
};

export const apiUrl = (segments, query = undefined) => {
  const url = new URL(API_ORIGIN);
  url.pathname = `/${segments.map((segment) => encodeURIComponent(String(segment))).join('/')}`;
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  }
  return url;
};

const readResponseBytes = async (response, maximum) => {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        requireCondition(value instanceof Uint8Array, 'APPROVAL_GITHUB_RESPONSE_INVALID');
        total += value.byteLength;
        if (total > maximum) {
          await reader.cancel().catch(() => {});
          throw approvalError('APPROVAL_GITHUB_RESPONSE_TOO_LARGE');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }
  requireCondition(typeof response.arrayBuffer === 'function', 'APPROVAL_GITHUB_RESPONSE_INVALID');
  const bytes = Buffer.from(await response.arrayBuffer());
  requireCondition(bytes.length <= maximum, 'APPROVAL_GITHUB_RESPONSE_TOO_LARGE');
  return bytes;
};

const statusError = (status) => {
  if (status >= 300 && status <= 399) return 'APPROVAL_GITHUB_REDIRECT_REJECTED';
  if (status === 403) return 'APPROVAL_GITHUB_FORBIDDEN';
  if (status === 404) return 'APPROVAL_GITHUB_NOT_FOUND';
  if (status === 409) return 'APPROVAL_GITHUB_CONFLICT';
  if (status === 429) return 'APPROVAL_GITHUB_RATE_LIMITED';
  return 'APPROVAL_GITHUB_REQUEST_FAILED';
};

const withTimeout = async (operation, signal, deadline) => {
  if (signal.aborted) throw approvalError('APPROVAL_GITHUB_TIMEOUT');
  let onTimeout;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    onTimeout = () => reject(approvalError('APPROVAL_GITHUB_TIMEOUT'));
    signal.addEventListener('abort', onTimeout, { once: true });
    timer = setTimeout(onTimeout, Math.max(1, deadline - Date.now()));
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onTimeout);
  }
};

export const fetchJson = async (state, url, limits) => {
  requireCondition(url instanceof URL && url.origin === API_ORIGIN, 'APPROVAL_GITHUB_ORIGIN_FORBIDDEN');
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    Authorization: `Bearer ${state.token}`,
  };
  let response;
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const deadline = Date.now() + limits.timeoutMs;
  try {
    response = await withTimeout(state.fetch(url.href, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal,
    }), signal, deadline);
  } catch (error) {
    if (error?.message === 'APPROVAL_GITHUB_TIMEOUT'
      || error?.name === 'AbortError'
      || error?.name === 'TimeoutError') {
      throw approvalError('APPROVAL_GITHUB_TIMEOUT');
    }
    throw approvalError('APPROVAL_GITHUB_REQUEST_FAILED');
  }
  requireCondition(
    response !== null
      && Number.isInteger(response.status)
      && typeof response.headers?.get === 'function',
    'APPROVAL_GITHUB_RESPONSE_INVALID',
  );
  if (response.status < 200 || response.status >= 300) throw approvalError(statusError(response.status));
  const bytes = await withTimeout(readResponseBytes(response, limits.maxResponseBytes), signal, deadline);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw approvalError('APPROVAL_GITHUB_RESPONSE_INVALID');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw approvalError('APPROVAL_GITHUB_RESPONSE_INVALID');
  }
  return { value, link: response.headers.get('link') };
};

const parseNextLink = (header, currentUrl) => {
  if (header === null || header === '') return null;
  requireCondition(typeof header === 'string' && header.length <= 8192, 'APPROVAL_GITHUB_PAGINATION_INVALID');
  const links = new Map();
  for (const part of header.split(',')) {
    const match = /^\s*<([^<>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
    requireCondition(match !== null && !links.has(match?.[2]), 'APPROVAL_GITHUB_PAGINATION_INVALID');
    links.set(match[2], match[1]);
  }
  const nextTarget = links.get('next');
  if (nextTarget === undefined) return null;
  let next;
  try {
    next = new URL(nextTarget, currentUrl);
  } catch {
    throw approvalError('APPROVAL_GITHUB_PAGINATION_INVALID');
  }
  requireCondition(next.origin === API_ORIGIN, 'APPROVAL_GITHUB_ORIGIN_FORBIDDEN');
  requireCondition(next.pathname === currentUrl.pathname, 'APPROVAL_GITHUB_PAGINATION_INVALID');
  requireCondition(next.href !== currentUrl.href, 'APPROVAL_GITHUB_PAGINATION_LOOP');
  requireCondition(next.hash === '', 'APPROVAL_GITHUB_PAGINATION_INVALID');
  const closedQuery = (url) => {
    const result = new Map();
    for (const [key, value] of url.searchParams) {
      requireCondition(!result.has(key), 'APPROVAL_GITHUB_PAGINATION_INVALID');
      result.set(key, value);
    }
    return result;
  };
  const currentQuery = closedQuery(currentUrl);
  const nextQuery = closedQuery(next);
  requireCondition(
    currentQuery.size === nextQuery.size
      && [...currentQuery.keys()].every((key) => nextQuery.has(key)),
    'APPROVAL_GITHUB_PAGINATION_INVALID',
  );
  const currentPage = Number(currentQuery.get('page'));
  const nextPage = Number(nextQuery.get('page'));
  requireCondition(
    Number.isSafeInteger(currentPage)
      && Number.isSafeInteger(nextPage)
      && nextPage === currentPage + 1,
    'APPROVAL_GITHUB_PAGINATION_INVALID',
  );
  for (const [key, value] of currentQuery) {
    if (key !== 'page') requireCondition(nextQuery.get(key) === value, 'APPROVAL_GITHUB_PAGINATION_INVALID');
  }
  return next;
};

export const paginate = async (
  state,
  firstUrl,
  limits,
  budget,
  extract,
  totalField = null,
  options = {},
) => {
  const visited = new Set();
  const items = [];
  const seenItemIds = new Set();
  const seenPages = new Set();
  let url = firstUrl;
  let declaredTotal = null;
  while (url !== null) {
    requireCondition(!visited.has(url.href), 'APPROVAL_GITHUB_PAGINATION_LOOP');
    budget.pages += 1;
    requireCondition(budget.pages <= limits.maxPages, 'APPROVAL_GITHUB_PAGE_LIMIT_EXCEEDED');
    visited.add(url.href);
    const response = await fetchJson(state, url, limits);
    const pageItems = extract(response.value);
    requireCondition(Array.isArray(pageItems), 'APPROVAL_GITHUB_RESPONSE_INVALID');
    if (options.rejectDuplicatePage === true) {
      const fingerprint = stableJson(pageItems);
      requireCondition(!seenPages.has(fingerprint), 'APPROVAL_GITHUB_PAGINATION_INVALID');
      seenPages.add(fingerprint);
    }
    if (typeof options.itemId === 'function') {
      for (const item of pageItems) {
        const id = options.itemId(item);
        requireCondition(
          isSafePositiveInteger(id) && !seenItemIds.has(id),
          'APPROVAL_GITHUB_PAGINATION_INVALID',
        );
        seenItemIds.add(id);
      }
    }
    if (totalField !== null) {
      requireCondition(
        Number.isSafeInteger(response.value?.[totalField]) && response.value[totalField] >= 0,
        'APPROVAL_GITHUB_RESPONSE_INVALID',
      );
      if (declaredTotal === null) declaredTotal = response.value[totalField];
      requireCondition(declaredTotal === response.value[totalField], 'APPROVAL_GITHUB_PAGINATION_INVALID');
    }
    budget.items += pageItems.length;
    requireCondition(budget.items <= limits.maxItems, 'APPROVAL_GITHUB_ITEM_LIMIT_EXCEEDED');
    items.push(...pageItems);
    url = parseNextLink(response.link, url);
  }
  if (declaredTotal !== null) {
    requireCondition(declaredTotal === items.length, 'APPROVAL_GITHUB_PAGINATION_INVALID');
  }
  return items;
};
