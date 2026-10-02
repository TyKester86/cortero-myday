import { HOUSEHOLD_TYPE_ICON, ROLE_ICONS, type HouseholdType, type XpTrack } from '@myday/shared';

/** Which role picture a person gets: kids → Hermes; solo / empty-nester / retired grown-ups → their life-stage art; else their role. */
export function roleIcon(kind: 'kid' | 'adult', track: XpTrack | null, householdType?: HouseholdType): string {
  if (kind === 'kid') return ROLE_ICONS.kid;
  if (track === 'student') return ROLE_ICONS.student;
  if (householdType === 'solo' || householdType === 'empty_nesters' || householdType === 'retired') return HOUSEHOLD_TYPE_ICON[householdType];
  return track === 'woman' ? ROLE_ICONS.woman : ROLE_ICONS.leader;
}

export default function RoleArt({ src, size = 'sm', alt = '' }: { src: string; size?: 'sm' | 'lg'; alt?: string }) {
  return <img className={size === 'lg' ? 'role-art lg' : 'role-art'} src={src} alt={alt} width={size === 'lg' ? 140 : 72} height={size === 'lg' ? 140 : 72} loading="lazy" />;
}
