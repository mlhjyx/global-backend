import { describe, expect, it, vi } from 'vitest';
import {
  PERSONAL_DATA_ACCESS_RETENTION_DAYS,
  fieldClassesForContacts,
  recordPersonalDataAccess,
} from './personal-data-access-audit';

function makeClient() {
  const create = vi.fn(async () => undefined);
  return { client: { personalDataAccessAudit: { create } }, create };
}

describe('个人数据访问审计（Q25 补偿控制）', () => {
  it('keeps the retention window at 180 days', () => {
    expect(PERSONAL_DATA_ACCESS_RETENTION_DAYS).toBe(180);
  });

  it('derives field classes from persisted contacts without recording values', () => {
    expect(
      fieldClassesForContacts([
        { title: 'CEO', contactPoints: [{ type: 'email' }, { type: 'linkedin' }] },
        { title: null, contactPoints: [{ type: 'phone' }] },
      ]),
    ).toEqual(['person_name', 'job_title', 'email', 'phone', 'linkedin']);
    expect(fieldClassesForContacts([])).toEqual(['person_name']);
    expect(fieldClassesForContacts([{ contactPoints: [] }])).toEqual(['person_name']);
  });

  it('writes who/when/company/field-classes/purpose with a bounded, control-free shape', async () => {
    const { client, create } = makeClient();
    await recordPersonalDataAccess(client as never, {
      workspaceId: 'ws-1',
      actorId: 'user\u0000-1',
      actorKind: 'user',
      purpose: 'contact_discovery',
      companyId: 'company-1',
      fieldClasses: ['email', 'person_name', 'email'],
      subjectCount: 3.9,
      lawfulBasisRef: 'OWNER-DECISION-2026-10-11\n',
      correlationId: 'attempt-1',
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws-1',
        actorId: 'user -1',
        actorKind: 'user',
        purpose: 'contact_discovery',
        companyId: 'company-1',
        fieldClasses: ['email', 'person_name'],
        subjectCount: 3,
        lawfulBasisRef: 'OWNER-DECISION-2026-10-11',
        correlationId: 'attempt-1',
      },
    });
  });

  it('falls back to an unknown actor and null optional fields instead of dropping the row', async () => {
    const { client, create } = makeClient();
    await recordPersonalDataAccess(client as never, {
      workspaceId: 'ws-1',
      actorId: ' \u0000 ',
      actorKind: 'system',
      purpose: 'run_email_guess',
      fieldClasses: ['person_name', 'email'],
      subjectCount: -5,
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'unknown',
        companyId: null,
        subjectCount: 0,
        lawfulBasisRef: null,
        correlationId: null,
      }),
    });
  });

  it('bounds every text field to its column limit', async () => {
    const { client, create } = makeClient();
    await recordPersonalDataAccess(client as never, {
      workspaceId: 'ws-1',
      actorId: 'a'.repeat(500),
      actorKind: 'platform',
      purpose: 'email_verification',
      fieldClasses: ['email'],
      subjectCount: 1_000_000_000,
      lawfulBasisRef: 'r'.repeat(700),
      correlationId: 'c'.repeat(300),
    });
    const data = create.mock.calls[0]![0].data as Record<string, unknown>;
    expect((data.actorId as string).length).toBe(200);
    expect((data.lawfulBasisRef as string).length).toBe(512);
    expect((data.correlationId as string).length).toBe(200);
    expect(data.subjectCount).toBe(1_000_000);
  });
});
