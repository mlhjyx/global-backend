import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DoclingClient } from './docling.client';

const BASE_URL = 'http://docling.test:5001';
const TASK_ID = '9a240308-003e-479a-81b8-9efd1767399a';
const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const PDF_BYTES = Buffer.from('%PDF-1.7');

const json = (data: unknown, status = 200) => Response.json(data, { status });

describe('DoclingClient local asynchronous conversion', () => {
  beforeEach(() => {
    vi.stubEnv('DOCLING_BACKEND', 'local');
    vi.stubEnv('DOCLING_URL', BASE_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('persists a submitted task before polling, then resumes it without a second upload after a wait timeout', async () => {
    let storedTaskId: string | undefined;
    const saveTaskId = vi.fn(async (taskId: string | null) => {
      storedTaskId = taskId ?? undefined;
    });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ task_id: TASK_ID, task_type: 'convert', task_status: 'pending' }))
      .mockImplementationOnce(async () => {
        expect(storedTaskId).toBe(TASK_ID);
        throw new DOMException('test deadline', 'TimeoutError');
      })
      .mockResolvedValueOnce(json({ task_id: TASK_ID, task_type: 'convert', task_status: 'success' }))
      .mockResolvedValueOnce(json({ status: 'success', document: { md_content: '# Parsed catalogue' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DoclingClient().convertToMarkdown('catalog.pdf', PDF_BYTES, undefined, WORKSPACE_ID, {
      localAsync: { saveTaskId },
      pageRange: [1, 15],
    })).rejects.toMatchObject({ code: 'KB_DOCLING_UNAVAILABLE', disposition: 'retryable' });
    const resumed = await new DoclingClient().convertToMarkdown('catalog.pdf', PDF_BYTES, undefined, WORKSPACE_ID, {
      localAsync: { taskId: storedTaskId, saveTaskId },
      pageRange: [1, 15],
    });

    expect(resumed).toEqual({ markdown: '# Parsed catalogue' });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${BASE_URL}/v1/convert/source/async`, 'POST'],
      [`${BASE_URL}/v1/status/poll/${TASK_ID}`, 'GET'],
      [`${BASE_URL}/v1/status/poll/${TASK_ID}`, 'GET'],
      [`${BASE_URL}/v1/result/${TASK_ID}`, 'GET'],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      options: { to_formats: ['md'], page_range: [1, 15] },
      sources: [{ kind: 'file', base64_string: PDF_BYTES.toString('base64'), filename: 'catalog.pdf' }],
    });
    expect(fetchMock.mock.calls.every(([, init]) =>
      new Headers(init?.headers).get('x-workspace-id') === WORKSPACE_ID,
    )).toBe(true);
  });

  it('clears a confirmed missing task and defers submitting again until the next attempt', async () => {
    const saveTaskId = vi.fn(async () => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'Task not found.' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DoclingClient().convertToMarkdown('catalog.pdf', PDF_BYTES, undefined, {
      localAsync: { taskId: TASK_ID, saveTaskId },
    })).rejects.toMatchObject({ code: 'KB_DOCLING_UNAVAILABLE', disposition: 'retryable' });

    expect(saveTaskId).toHaveBeenCalledWith(null);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${BASE_URL}/v1/status/poll/${TASK_ID}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('retains the task on an unclassified 404', async () => {
    const saveTaskId = vi.fn(async () => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'Not Found' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DoclingClient().convertToMarkdown('catalog.pdf', PDF_BYTES, undefined, {
      localAsync: { taskId: TASK_ID, saveTaskId },
    })).rejects.toMatchObject({ code: 'KB_DOCLING_UNAVAILABLE', disposition: 'retryable' });

    expect(saveTaskId).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps polling a started task until the same task has a result', async () => {
    const saveTaskId = vi.fn(async () => undefined);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ task_id: TASK_ID, task_type: 'convert', task_status: 'started' }))
      .mockResolvedValueOnce(json({ task_id: TASK_ID, task_type: 'convert', task_status: 'success' }))
      .mockResolvedValueOnce(json({ status: 'partial_success', document: { md_content: '# Pages parsed' } }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await new DoclingClient().convertToMarkdown('catalog.pdf', PDF_BYTES, undefined, {
      localAsync: { taskId: TASK_ID, saveTaskId },
    })).toEqual({ markdown: '# Pages parsed' });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${BASE_URL}/v1/status/poll/${TASK_ID}`,
      `${BASE_URL}/v1/status/poll/${TASK_ID}`,
      `${BASE_URL}/v1/result/${TASK_ID}`,
    ]);
    expect(saveTaskId).not.toHaveBeenCalled();
  });

  it('does not accept a failed task as an empty successful PDF', async () => {
    const saveTaskId = vi.fn(async () => undefined);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ task_id: TASK_ID, task_type: 'convert', task_status: 'failure' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DoclingClient().convertToMarkdown('catalog.pdf', PDF_BYTES, undefined, {
      allowEmptyMarkdown: true,
      localAsync: { taskId: TASK_ID, saveTaskId },
    })).rejects.toMatchObject({ code: 'KB_DOCLING_UNAVAILABLE', disposition: 'retryable' });

    expect(saveTaskId).toHaveBeenCalledWith(null);
  });

  it('rejects an invalid task reference before building a parser URL', async () => {
    const saveTaskId = vi.fn(async () => undefined);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DoclingClient().convertToMarkdown('catalog.pdf', PDF_BYTES, undefined, {
      localAsync: { taskId: '../catalog.pdf', saveTaskId },
    })).rejects.toMatchObject({ code: 'KB_DOCLING_UNAVAILABLE', disposition: 'retryable' });

    expect(saveTaskId).toHaveBeenCalledWith(null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the managed parser on the existing synchronous contract', async () => {
    vi.stubEnv('DOCLING_BACKEND', 'managed_api');
    vi.stubEnv('DOCLING_MANAGED_URL', BASE_URL);
    const saveTaskId = vi.fn(async () => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ document: { md_content: '# Document' } }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await new DoclingClient().convertToMarkdown('catalog.pdf', PDF_BYTES, undefined, {
      localAsync: { saveTaskId },
    })).toEqual({ markdown: '# Document' });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${BASE_URL}/v1/convert/source`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(saveTaskId).not.toHaveBeenCalled();
  });
});
