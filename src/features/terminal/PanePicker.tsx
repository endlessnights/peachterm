import { Icon } from '../../components/Icon';
import { useTabs } from '../sessions/store';

/**
 * Shown in the second pane right after "Split": pick an existing tab, start a
 * new session of the same saved connection, or cancel the split.
 */
export function PanePicker() {
  const tabs = useTabs((s) => s.tabs);
  const split = useTabs((s) => s.split);
  const setSecondPane = useTabs((s) => s.setSecondPane);
  const splitWithNewSession = useTabs((s) => s.splitWithNewSession);
  const unsplit = useTabs((s) => s.unsplit);
  const first = tabs.find((t) => t.id === split?.panes[0]);
  if (!split || !first) return null;
  const others = tabs.filter((t) => t.id !== first.id);
  return (
    <div className="pane-picker" role="group" aria-label="Choose what to show in this pane">
      <h3>Show in this pane</h3>
      <button className="btn btn-primary" onClick={() => splitWithNewSession()} data-autofocus>
        <Icon name="plus" /> New session — {first.title}
      </button>
      {others.length > 0 && <div className="pane-picker-label">Or an open tab</div>}
      <ul>
        {others.map((tab) => (
          <li key={tab.id}>
            <button className="pane-picker-row" onClick={() => setSecondPane(tab.id)}>
              <span className="status-dot" data-status={tab.status} />
              <span className="pane-picker-title">{tab.title}</span>
              <span className="pane-picker-sub">{tab.subtitle}</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="btn" onClick={unsplit}>
        Cancel split
      </button>
    </div>
  );
}
