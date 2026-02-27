import { diffDays } from "../utils/time";

export const cadenceIntervalDays = (cadence: string): number => {
  switch (cadence) {
    case "weekly":
      return 7;
    case "biweekly":
      return 14;
    case "every_4_weeks":
      return 28;
    case "monthly":
      return 30;
    case "quarterly":
      return 91;
    case "yearly":
      return 365;
    default:
      return 30;
  }
};

export const isInactiveByCadence = (
  lastSeenDate: string,
  cadence: string,
  referenceDateIso: string,
  cycles = 2
): boolean => {
  const daysSinceLastSeen = Math.max(0, diffDays(referenceDateIso, lastSeenDate));
  return daysSinceLastSeen > cadenceIntervalDays(cadence) * cycles;
};
