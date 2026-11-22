// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { connect } from '../../app/actions';
import { Icon } from '../../components/Icon';
import { useConnections } from '../connections/store';
import { useRecent } from './recentStore';

/**
 * The most recently used saved connections, as compact rows on the home
 * screen. Clicking one opens a NEW session in a new tab (an open tab of the
 * same connection is never reused or focused).
 */
export function RecentSessions() {
  const ids = useRecent((s) => s.ids);
  const connections = useConnections((s) => s.tree.connections);
  const rows = ids
    .map((id) => connections.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);
  if (rows.length === 0) return null;
  return (
    <section className="recent" aria-labelledby="recent-title">
      <h3 id="recent-title">Recent Sessions</h3>
      <ul>
        {rows.map((c) => (
          <li key={c.id}>
            <button
              className="recent-row"
              onClick={() => connect(c)}
              title={`${c.username ? `${c.username}@` : ''}${c.host}:${c.port}`}
            >
              <Icon name="server" size={13} />
              <span className="recent-name">{c.name}</span>
              {c.host !== c.name && <span className="recent-host">{c.host}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
