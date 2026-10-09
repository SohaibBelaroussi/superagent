import { createOrgLookup, type OrgLookup } from '@superagent/client';
import { useMemo } from 'react';
import { useAgents, useDepartments } from '../../api/queries';

/** Departments and agents by id, slug and key: tasks and events refer to them every way. */
export function useOrg(): OrgLookup {
  const departments = useDepartments();
  const agents = useAgents();
  return useMemo(
    () => ({
      ...createOrgLookup(departments.data, agents.data),
      ready: departments.isSuccess && agents.isSuccess,
      fetching: departments.isFetching || agents.isFetching,
      error: (departments.data ? null : departments.error) ?? (agents.data ? null : agents.error),
      refetch: () => {
        void departments.refetch();
        void agents.refetch();
      },
    }),
    [
      departments.data,
      departments.isSuccess,
      departments.isFetching,
      departments.error,
      departments.refetch,
      agents.data,
      agents.isSuccess,
      agents.isFetching,
      agents.error,
      agents.refetch,
    ],
  );
}
