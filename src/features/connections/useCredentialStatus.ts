// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react';
import { create } from 'zustand';
import { ipc } from '../../shared/ipc';
import type { CredentialStatus } from '../../shared/types';

const useStatusStore = create<{ status: CredentialStatus | null; requested: boolean }>(() => ({
  status: null,
  requested: false,
}));

/** Backend availability of the OS keychain, probed once per app run. */
export function useCredentialStatus(): CredentialStatus | null {
  const status = useStatusStore((s) => s.status);
  useEffect(() => {
    if (useStatusStore.getState().requested) return;
    useStatusStore.setState({ requested: true });
    ipc
      .credentialsStatus()
      .then((s) => useStatusStore.setState({ status: s }))
      .catch(() =>
        useStatusStore.setState({
          status: { available: false, backend: 'system keychain', detail: 'status unavailable' },
        }),
      );
  }, []);
  return status;
}
