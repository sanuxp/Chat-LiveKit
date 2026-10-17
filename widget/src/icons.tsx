// Small inline SVG icons (Phosphor-style strokes), so the widget bundle needs no icon package.
const base = { viewBox: "0 0 256 256", fill: "currentColor", "aria-hidden": true } as const;

export const ChatIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M4 4.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H10l-4.5 3.5V17H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1Z" /></svg>
);

export const CloseIcon = () => (
  <svg {...base}><path d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128 50.34 61.66a8 8 0 0 1 11.32-11.32L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128Z" stroke="currentColor" strokeWidth="12" /></svg>
);

export const SendIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.4 11.2 20.2 3.6a.8.8 0 0 1 1.1.9l-3.4 15.7a.8.8 0 0 1-1.3.4l-4.4-3.6-2.5 3.2a.8.8 0 0 1-1.4-.5v-4.4l8.3-7.7-10.4 6-3.3-1.3a.8.8 0 0 1 .1-1.5Z" /></svg>
);

export const MicIcon = ({ off }: { off?: boolean }) => (
  <svg {...base}>
    <path d="M128 176a48.05 48.05 0 0 0 48-48V64a48 48 0 0 0-96 0v64a48.05 48.05 0 0 0 48 48Zm-32-112a32 32 0 0 1 64 0v64a32 32 0 0 1-64 0Zm40 143.6V232a8 8 0 0 1-16 0v-24.4A80.11 80.11 0 0 1 48 128a8 8 0 0 1 16 0 64 64 0 0 0 128 0 8 8 0 0 1 16 0 80.11 80.11 0 0 1-72 79.6Z" />
    {off && <path d="M213.9 210.6 53.9 34.6a8 8 0 1 0-11.8 10.8l160 176a8 8 0 1 0 11.8-10.8Z" />}
  </svg>
);

export const CameraIcon = ({ off }: { off?: boolean }) => (
  <svg {...base}>
    <path d="M251.77 73a8 8 0 0 0-8.21.39L208 97.05V72a16 16 0 0 0-16-16H32a16 16 0 0 0-16 16v112a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16v-25.05l35.56 23.71A8 8 0 0 0 248 192a8 8 0 0 0 8-8V80a8 8 0 0 0-4.23-7ZM192 184H32V72h160v112Zm48-22.95-32-21.34v-23.42l32-21.34Z" />
    {off && <path d="M213.9 210.6 53.9 34.6a8 8 0 1 0-11.8 10.8l160 176a8 8 0 1 0 11.8-10.8Z" />}
  </svg>
);

export const TrashIcon = () => (
  <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216 48h-40v-8a24 24 0 0 0-24-24h-48a24 24 0 0 0-24 24v8H40a8 8 0 0 0 0 16h8v144a16 16 0 0 0 16 16h128a16 16 0 0 0 16-16V64h8a8 8 0 0 0 0-16ZM96 40a8 8 0 0 1 8-8h48a8 8 0 0 1 8 8v8H96Zm96 168H64V64h128Zm-80-104v64a8 8 0 0 1-16 0v-64a8 8 0 0 1 16 0Zm48 0v64a8 8 0 0 1-16 0v-64a8 8 0 0 1 16 0Z" /></svg>
);
