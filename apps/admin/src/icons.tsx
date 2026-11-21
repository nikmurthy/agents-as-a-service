// Simple line icons for flow steps, so a step can be recognised without reading. Decorative: always next to words.
const P: Record<string, string> = {
  mail: "M4 6h16v12H4z M4 7l8 6 8-6",
  sort: "M4 6h16 M7 12h10 M10 18h4",
  calendar: "M4 5h16v15H4z M4 10h16 M9 3v4 M15 3v4",
  link: "M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1 M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1",
  person: "M12 4a4 4 0 1 1 0 8a4 4 0 1 1 0-8z M4 21c1-4 4-6 8-6s7 2 8 6",
  pen: "M5 19l2-6L17 3l4 4-10 10z M5 19l4-2",
  check: "M5 12l5 5L20 7",
  auto: "M4 12a8 8 0 0 1 14-5 M20 12a8 8 0 0 1-14 5 M18 3v4h-4 M6 21v-4h4",
  send: "M4 12l16-8-6 16-3-7z",
  star: "M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z",
  quote: "M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h5",
  clock: "M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z M12 7v5l3 2",
  lock: "M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3",
  off: "M5 5l14 14 M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z",
  phone: "M8 3h8v18H8z M11 18h2",
  list: "M4 7h16 M4 12h16 M4 17h10",
  play: "M7 4l13 8-13 8z",
};
export type IconName = keyof typeof P;
export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {P[name].split(" M").map((d, i) => <path key={i} d={(i ? "M" : "") + d} />)}
    </svg>
  );
}
