/** The kiln arch: a firing chamber with its door. Used as the app mark. */
export function KilnMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className="kiln-mark"
    >
      <path d="M3.5 17V9.5a6.5 6.5 0 0 1 13 0V17" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.75 17v-2.75a2.25 2.25 0 0 1 4.5 0V17" stroke="currentColor" strokeWidth="1.5" />
      <path d="M1.5 17.25h17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
