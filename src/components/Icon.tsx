// Small inline SVG icon set (original, stroke-based, 16px grid).

const paths = {
  chevron: 'M6 4l4 4-4 4',
  folder:
    'M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z',
  server: 'M3 3h10v4H3zM3 9h10v4H3zM5.5 5h.01M5.5 11h.01',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3.5-3.5',
  plus: 'M8 3v10M3 8h10',
  folderPlus:
    'M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5zM8 7v4M6 9h4',
  close: 'M4 4l8 8M12 4l-8 8',
  sidebar: 'M2.5 3h11v10h-11zM6 3v10',
  settings:
    'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM13 8l1.3-1-1.2-2.1-1.6.5a4.8 4.8 0 0 0-1.3-.8L9.9 3H7.5l-.3 1.6a4.8 4.8 0 0 0-1.3.8l-1.6-.5L3.1 7 4.4 8l-1.3 1 1.2 2.1 1.6-.5c.4.3.8.6 1.3.8l.3 1.6h2.4l.3-1.6c.5-.2.9-.5 1.3-.8l1.6.5 1.2-2.1z',
  key: 'M10 6.5a3.5 3.5 0 1 1-1 2.5L2.5 15.5V13H5v-2h2l1.2-1.2',
  lock: 'M4 7h8v6H4zM5.5 7V5a2.5 2.5 0 0 1 5 0v2',
  edit: 'M10.5 3.5l2 2L6 12l-2.5.5L4 10z',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5',
  plug: 'M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3',
  terminal: 'M2.5 3h11v10h-11zM5 6.5l2 1.5-2 1.5M8.5 10H11',
  chevronUp: 'M4 10l4-4 4 4',
  chevronDown: 'M4 6l4 4 4-4',
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.5',
  upload: 'M8 11V3M5 6l3-3 3 3M3 13h10',
  download: 'M8 3v8M5 8l3 3 3-3M3 13h10',
  file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
  parent: 'M8 13V4M5 7l3-3 3 3',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  panelLeft: 'M2.5 3h11v10h-11zM6.5 3v10',
  panelRight: 'M2.5 3h11v10h-11zM9.5 3v10',
  splitVertical: 'M2.5 3h11v10h-11zM8 3v10',
  splitHorizontal: 'M2.5 3h11v10h-11zM2.5 8h11',
  newFile: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3M8 8v4M6 10h4',
  newFolder:
    'M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5zM8 7v4M6 9h4',
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 14,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1024 1024" aria-hidden="true">
      <defs>
        <linearGradient id="pt-fg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffc2a1" />
          <stop offset="1" stopColor="#f2875d" />
        </linearGradient>
      </defs>
      <rect x="64" y="64" width="896" height="896" rx="200" fill="var(--surface-2)" />
      <path
        d="M300 360 L480 512 L300 664"
        fill="none"
        stroke="url(#pt-fg)"
        strokeWidth="84"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="540" y="620" width="200" height="84" rx="42" fill="url(#pt-fg)" />
    </svg>
  );
}
