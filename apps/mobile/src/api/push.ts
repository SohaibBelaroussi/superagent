import { myPushQuery, queryKeys, testPush } from '@superagent/client';
import type { MyPush, PushDevice, PushKind } from '@superagent/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pushAvailable, registerThisPhone, unregisterThisPhone } from '../push/registration';

/** This phone's registration for pushes, and whether the server can send at all. */
export function useMyPush() {
  return useQuery({ ...myPushQuery(), enabled: pushAvailable() });
}

function useKeepDevice() {
  const queryClient = useQueryClient();
  return (device: PushDevice | null) =>
    queryClient.setQueryData<MyPush>(queryKeys.myPush, (current) => ({
      configured: current?.configured ?? true,
      device,
    }));
}

/** Turns push on for `kinds`, or changes them. Its errors are the screen's to show. */
export function useRegisterPush() {
  const keep = useKeepDevice();
  return useMutation({
    mutationFn: (kinds: PushKind[]) => registerThisPhone(kinds),
    onSuccess: keep,
    meta: { silent: true },
  });
}

export function useUnregisterPush() {
  const keep = useKeepDevice();
  return useMutation({
    mutationFn: unregisterThisPhone,
    onSuccess: () => keep(null),
    meta: { failure: 'Couldn’t turn notifications off' },
  });
}

export function useTestPush() {
  return useMutation({ mutationFn: testPush, meta: { failure: 'Couldn’t send the test' } });
}
