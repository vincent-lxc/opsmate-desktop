type OpsMateLogoProps = {
  size?: number;
};

export function OpsMateLogo({ size = 28 }: OpsMateLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="OpsMate"
      style={{ display: "block", flexShrink: 0 }}
    >
      <defs>
        <linearGradient id="opsmate-logo-grad" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0ea5e9" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill="url(#opsmate-logo-grad)" />
      <path
        d="M8 22V10h3.2l3.4 7.2L18 10h3.2v12h-2.6v-7.1L14.2 22h-2.1l-4.4-7.1V22H8z"
        fill="#ffffff"
      />
      <circle cx="24" cy="9" r="2.2" fill="#a5f3fc" opacity="0.95" />
    </svg>
  );
}