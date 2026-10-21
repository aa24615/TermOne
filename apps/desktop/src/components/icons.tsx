interface IconProps {
  size?: number;
  className?: string;
}

function base(size?: number, className?: string) {
  return {
    width: size ?? 14,
    height: size ?? 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
  };
}

export const IconPlus = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconX = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconMinus = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M5 12h14" />
  </svg>
);

export const IconSquare = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
);

export const IconCaretDown = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const IconCheck = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M4 12.5l5 5L20 6.5" />
  </svg>
);

export const IconEdit = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);

export const IconTrash = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5" />
  </svg>
);

export const IconGear = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.8v3M12 18.2v3M4.1 7.4l2.6 1.5M17.3 15.1l2.6 1.5M4.1 16.6l2.6-1.5M17.3 8.9l2.6-1.5" />
  </svg>
);

export const IconUser = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </svg>
);

export const IconSync = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M21 12a9 9 0 0 1-15.5 6.2M3 12A9 9 0 0 1 18.5 5.8M18.5 2v4h-4M5.5 22v-4h4" />
  </svg>
);

export const IconTerminal = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M5 7l5 5-5 5M12 17h7" />
  </svg>
);

export const IconGlobe = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9Z" />
  </svg>
);

export const IconUsb = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M12 21V8M8 12l4-4 4 4M9 5h6M7 17l-2.5-3H2M17 15l2.5-3H22" />
  </svg>
);

export const IconRefresh = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v5h-5" />
  </svg>
);

export const IconInfo = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.5v.5" />
  </svg>
);
