const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

/** "3 minutes ago", "yesterday", "il y a 2 heures": a past or future date relative to now, in the user's language. */
export function formatRelative(
  date: string | Date,
  locale: string,
  now = Date.now(),
) {
  const seconds = Math.round((new Date(date).getTime() - now) / 1000);
  const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) ?? [
    "second",
    1,
  ];
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(seconds / size),
    unit,
  );
}
