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
    expect(statement).toContain("FROM public.company_profile");
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
      WORKSPACE_ID,
      "company",
      SUBJECT_ID,
    ]);
  });

  it("resolves the tenant's seller company_profile as its own subject kind", async () => {
    const queryRaw = vi.fn(async () => [
      {
        workspace_id: WORKSPACE_ID,
        subject_type: "company_profile",
        subject_id: SUBJECT_ID,
      },
    ]);
    const repository = new GenericOperationArtifactSubjectRepository();

    await expect(
      repository.resolveExistingSubject(
        { $queryRaw: queryRaw } as never,
        {
          workspaceId: WORKSPACE_ID,
          subjectRef: { subjectType: "company_profile", subjectId: SUBJECT_ID },
        },
      ),
    ).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      subjectType: "company_profile",
      subjectId: SUBJECT_ID,
    });

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    // Each branch is keyed by its own kind: a profile id never resolves as a
    // canonical company, nor a canonical company id as a profile.
    expect(sql.strings.join("")).toMatch(
      /'company_profile'::text AS subject_type,\s+profile\.id AS subject_id\s+FROM public\.company_profile profile\s+WHERE profile\.workspace_id = /u,
    );
    expect(sql.values.filter((value) => value === "company_profile")).toHaveLength(3);
  });

  it("refuses a row of another kind than the one asked for", async () => {
    const repository = new GenericOperationArtifactSubjectRepository();

    await expect(
      repository.resolveExistingSubject(
        {
          $queryRaw: vi.fn(async () => [
            {
              workspace_id: WORKSPACE_ID,
              subject_type: "company",
              subject_id: SUBJECT_ID,
            },
          ]),
        } as never,
        {
          workspaceId: WORKSPACE_ID,
          subjectRef: { subjectType: "company_profile", subjectId: SUBJECT_ID },
        },
      ),
    ).rejects.toThrow("GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID");
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
