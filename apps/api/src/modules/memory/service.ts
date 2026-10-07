import type { IMastraLogger } from '@mastra/core/logger';
import { deepMergeWorkingMemory } from '@mastra/memory';
import { type OwnerProfile, type OwnerProfilePatch, OwnerProfileSchema } from '@superagent/shared';
import { ApiError } from '../../http/problem';
import { Mutex } from '../../util/mutex';
import type { OrgDirectory } from '../org/directory';
import { departmentNotesAt, type MemoryProfiles, OWNER_PROFILE_AT, parseProfile } from './profiles';

/**
 * The owner's profile and the departments' notes, read and written outside agent runs (decision D30).
 * Working memory writes don't validate or merge, so this does both.
 */
export class MemoryService {
  private readonly profileLock = new Mutex();

  constructor(
    private readonly memory: MemoryProfiles,
    private readonly directory: OrgDirectory,
    private readonly logger: IMastraLogger,
  ) {}

  async profile(): Promise<OwnerProfile> {
    return parseProfile(await this.memory.chief.getWorkingMemory(OWNER_PROFILE_AT), this.logger);
  }

  /** Fields given replace the stored ones (lists included); null removes a field. */
  updateProfile(patch: OwnerProfilePatch): Promise<OwnerProfile> {
    return this.profileLock.run(async () => {
      const merged = deepMergeWorkingMemory(await this.profile(), patch as Record<string, unknown>);
      const next = OwnerProfileSchema.safeParse(merged);
      if (!next.success) throw new ApiError(400, 'validation_failed', 'The profile would not be valid');
      await this.memory.chief.updateWorkingMemory({
        ...OWNER_PROFILE_AT,
        workingMemory: JSON.stringify(next.data),
      });
      return next.data;
    });
  }

  async departmentNotes(departmentId: string): Promise<string | null> {
    return this.memory.lead.getWorkingMemory(departmentNotesAt(this.department(departmentId).slug));
  }

  async setDepartmentNotes(departmentId: string, notes: string): Promise<string> {
    const at = departmentNotesAt(this.department(departmentId).slug);
    await this.memory.lead.updateWorkingMemory({ ...at, workingMemory: notes });
    return notes;
  }

  private department(id: string) {
    const department = this.directory.department(id);
    if (!department) throw new ApiError(404, 'department_not_found', `No department with id ${id}`);
    return department;
  }
}
