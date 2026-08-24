import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { GenericOperationArtifactSubjectRepository } from "./generic-operation-artifact-subject.repository";

const WORKSPACE_ID = "e03abddd-1307-47cb-a731-7e7a786615a0";
const SUBJECT_ID = "b8b3ee5c-fbb8-42ef-a382-9c10c16dca72";

describe("GenericOperationArtifactSubjectRepository.resolveExistingSubject", () => {
  it("resolves only an exact canonical subject in the app session current workspace", async () => {
    const queryRaw = vi.fn(async () => [
      {
        workspace_id: WORKSPACE_ID,
        subject_type: "company",
        subject_id: SUBJECT_ID,
      },
    ]);
    const repository = new GenericOperationArtifactSubjectRepository();

    await expect(
      repository.resolveExistingSubject(
        { $queryRaw: queryRaw } as never,
        {
          workspaceId: WORKSPACE_ID,
          subjectRef: { subjectType: "company", subjectId: SUBJECT_ID },
        },
      ),
    ).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      subjectType: "company",
      subjectId: SUBJECT_ID,
    });

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    const statement = sql.strings.join("");
    expect(statement).toContain("FROM public.canonical_company");
    expect(statement).toContain("FROM public.canonical_contact");
    expect(statement).toContain("session_user = 'app_user'");
    expect(statement).toContain(
      "current_setting('role', true) IS NOT DISTINCT FROM 'none'",
    );
    expect(statement).toContain("current_workspace_id()");
    expect(sql.values).toEqual([
      WORKSPACE_ID,
      "company",
      SUBJECT_ID,
      WORKSPACE_ID,
      "company",
      SUBJECT_ID,
    ]);
  });

  it("reports no canonical subject when the exact current-workspace query finds none", async () => {
    const repository = new GenericOperationArtifactSubjectRepository();

    await expect(
      repository.resolveExistingSubject(
        { $queryRaw: vi.fn(async () => []) } as never,
        {
          workspaceId: WORKSPACE_ID,
          subjectRef: { subjectType: "contact", subjectId: SUBJECT_ID },
        },
      ),
    ).resolves.toBeNull();
  });
});
