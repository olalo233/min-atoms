import { and, asc, eq } from "drizzle-orm";

import {
  generatedAppData,
  projects,
  type GeneratedAppData,
} from "@/db/schema";
import type { GeneratedAppDataValue } from "@/lib/generated-app-data/contract";
import { getDb } from "@/lib/db/client";

export type GeneratedAppDataItem = Pick<GeneratedAppData, "key" | "value" | "updatedAt">;
export type OwnedGeneratedAppDataLookup =
  | { projectFound: false }
  | {
      projectFound: true;
      value: GeneratedAppDataValue | undefined;
    };

async function ownsProject(ownerId: string, projectId: string): Promise<boolean> {
  const [project] = await getDb()
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .limit(1);
  return Boolean(project);
}

export async function listOwnedGeneratedAppData(
  ownerId: string,
  projectId: string,
): Promise<GeneratedAppDataItem[] | null> {
  if (!(await ownsProject(ownerId, projectId))) {
    return null;
  }
  return getDb()
    .select({ key: generatedAppData.key, updatedAt: generatedAppData.updatedAt, value: generatedAppData.value })
    .from(generatedAppData)
    .where(eq(generatedAppData.projectId, projectId))
    .orderBy(asc(generatedAppData.key));
}

export async function getOwnedGeneratedAppData(
  ownerId: string,
  projectId: string,
  key: string,
): Promise<OwnedGeneratedAppDataLookup> {
  if (!(await ownsProject(ownerId, projectId))) {
    return { projectFound: false };
  }
  const [item] = await getDb()
    .select({ value: generatedAppData.value })
    .from(generatedAppData)
    .where(and(eq(generatedAppData.projectId, projectId), eq(generatedAppData.key, key)))
    .limit(1);
  return { projectFound: true, value: item?.value };
}

export async function setOwnedGeneratedAppData(
  ownerId: string,
  projectId: string,
  key: string,
  value: GeneratedAppDataValue,
): Promise<GeneratedAppDataValue | undefined> {
  if (!(await ownsProject(ownerId, projectId))) {
    return undefined;
  }
  const [item] = await getDb()
    .insert(generatedAppData)
    .values({ key, projectId, value })
    .onConflictDoUpdate({
      set: { updatedAt: new Date(), value },
      target: [generatedAppData.projectId, generatedAppData.key],
    })
    .returning({ value: generatedAppData.value });
  return item?.value;
}

export async function deleteOwnedGeneratedAppData(
  ownerId: string,
  projectId: string,
  key: string,
): Promise<boolean | null> {
  if (!(await ownsProject(ownerId, projectId))) {
    return null;
  }
  const deleted = await getDb()
    .delete(generatedAppData)
    .where(and(eq(generatedAppData.projectId, projectId), eq(generatedAppData.key, key)))
    .returning({ key: generatedAppData.key });
  return Boolean(deleted[0]);
}
