// Icon components — minimal stroke icons
const Icon = {
  Dashboard: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="5" height="5" rx="1"/>
      <rect x="9" y="2" width="5" height="5" rx="1"/>
      <rect x="2" y="9" width="5" height="5" rx="1"/>
      <rect x="9" y="9" width="5" height="5" rx="1"/>
    </svg>
  ),
  Projects: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 4.5L2 12.5C2 13 2.5 13.5 3 13.5L13 13.5C13.5 13.5 14 13 14 12.5L14 5.5C14 5 13.5 4.5 13 4.5L8 4.5L6.5 3L3 3C2.5 3 2 3.5 2 4.5Z"/>
    </svg>
  ),
  Agents: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="5.5" cy="6" r="2"/>
      <circle cx="11" cy="6" r="1.6"/>
      <path d="M2 13C2 11 3.5 9.5 5.5 9.5C7.5 9.5 9 11 9 13"/>
      <path d="M9.5 13C9.5 11.5 10.5 10 12 10C13.4 10 14 11 14 12"/>
    </svg>
  ),
  Logs: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 4H13"/>
      <path d="M3 8H10"/>
      <path d="M3 12H12"/>
    </svg>
  ),
  ChevronLeft: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 12L6 8L10 4"/>
    </svg>
  ),
  ChevronRight: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4L10 8L6 12"/>
    </svg>
  ),
  Close: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 4L12 12M12 4L4 12"/>
    </svg>
  ),
  Clock: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6"/>
      <path d="M8 5V8L10 9.5" strokeLinecap="round"/>
    </svg>
  ),
  Tool: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 2.5L13.5 5L11.5 7L9 4.5L11 2.5Z"/>
      <path d="M9 4.5L3 10.5V13H5.5L11.5 7"/>
    </svg>
  ),
  Search: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="4.5"/>
      <path d="M10.5 10.5L13.5 13.5" strokeLinecap="round"/>
    </svg>
  ),
  Spark: ({ size = 60 }) => (
    <svg width={size} height={size * 0.4} viewBox="0 0 60 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M0 18L8 14L14 16L20 9L26 12L32 6L38 10L44 4L50 8L60 2"/>
    </svg>
  ),
  Activity: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8H4L6 3L10 13L12 8H15"/>
    </svg>
  ),
  Gate: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 14V5L8 2L13 5V14"/>
      <path d="M3 14H13"/>
      <path d="M6.5 14V8.5H9.5V14"/>
    </svg>
  ),
};

window.Icon = Icon;
