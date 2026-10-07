import type { IMastraLogger } from '@mastra/core/logger';
import { type OwnerProfile, type OwnerProfilePatch, OwnerProfileSchema } from '@superagent/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { departmentNotes, ownerProfile } from '../../db/schema';
import { ApiError } from '../../http/problem';
import { Mutex } from '../../util/mutex';
import type { OrgDirectory } from '../org/directory';

const OWNER = 'owner';
export const MAX_NOTES_CHARS = 20_000;
const NOTES_HEADING = '# Department notes';

/**
 * The owner's profile and the departments' notes (decision D30). Every write goes through here, so it
 * is validated, merged and serialized: the owner's edits, the chief's update_owner_profile and the
 * leads' save_department_note can't lose each other's changes.
 */
export class MemoryService {
  private readonly profileLock = new Mutex();
  private readonly notesLock = new Mutex();

  constructor(
    private readonly db: Db,
    private readonly directory: OrgDirectory,
    private readonly logger: IMastraLogger,
  ) {}

  async profile(): Promise<OwnerProfile> {
    const [row] = await this.db.select().from(ownerProfile).where(eq(ownerProfile.id, OWNER));
    return this.salvage(row?.profile);
  }

  /** Fields given replace the stored ones (lists included); null removes a field. */
  updateProfile(patch: OwnerProfilePatch): Promise<OwnerProfile> {
    return this.profileLock.run(async () => {
      const next: Record<string, unknown> = { ...(await this.profile()) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else if (value !== undefined) next[key] = value;
      }
      const parsed = OwnerProfileSchema.safeParse(next);
      if (!parsed.success) throw new ApiError(400, 'validation_failed', 'The profile would not be valid');
      const now = new Date();
      await this.db
        .insert(ownerProfile)
        .values({ id: OWNER, profile: parsed.data, updatedAt: now })
        .onConflictDoUpdate({ target: ownerProfile.id, set: { profile: parsed.data, updatedAt: now } });
      return parsed.data;
    });
  }

  async departmentNotes(departmentId: string): Promise<string | null> {
    this.department(departmentId);
    const [row] = await this.db
      .select()
      .from(departmentNotes)
      .where(eq(departmentNotes.departmentId, departmentId));
    return row?.notes ?? null;
  }

  /** Replaces a department's notes (the owner's corrections). */
  setDepartmentNotes(departmentId: string, notes: string): Promise<string> {
    this.department(departmentId);
    return this.notesLock.run(() => this.writeNotes(departmentId, notes));
  }

  /** Adds one line to a department's notes, as leads do: appends never overwrite anyone's change. */
  addDepartmentNote(departmentId: string, note: string): Promise<string> {
    this.department(departmentId);
    return this.notesLock.run(async () => {
      const current = (await this.departmentNotes(departmentId)) ?? NOTES_HEADING;
      const line = `- ${note.trim().replace(/\s+/g, ' ')}`;
      if (current.split('\n').includes(line)) return current;
      const next = `${current.trimEnd()}\n${line}`;
      if (next.length > MAX_NOTES_CHARS) {
        throw new ApiError(409, 'notes_full', 'The department notes are full: ask the owner to tidy them up');
      }
      return this.writeNotes(departmentId, next);
    });
  }

  private async writeNotes(departmentId: string, notes: string): Promise<string> {
    const now = new Date();
    await this.db
      .insert(departmentNotes)
      .values({ departmentId, notes, updatedAt: now })
      .onConflictDoUpdate({ target: departmentNotes.departmentId, set: { notes, updatedAt: now } });
    return notes;
  }

  /** Keeps every field that still fits the schema: one bad field (an older schema) doesn't cost the rest. */
  private salvage(raw: unknown): OwnerProfile {
    if (!raw || typeof raw !== 'object') return {};
    const shape = OwnerProfileSchema.shape;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = shape[key as keyof typeof shape];
      if (!field) continue;
      const parsed = field.safeParse(value);
      if (parsed.success) kept[key] = parsed.data;
      else this.logger.warn('Dropping an owner profile field that no longer fits', { field: key });
    }
    return kept as OwnerProfile;
  }

  private department(id: string) {
    const department = this.directory.department(id);
    if (!department) throw new ApiError(404, 'department_not_found', `No department with id ${id}`);
    return department;
  }
}
