/**
 * What each person sees: routes, bottom tabs and the grouped menu.
 * One place, used by the shell (phone tabs + menu, desktop sidebar) and the
 * Me page.
 */
import { FEED_URL } from '../apps';
import { liveFeatures, type Me } from '@myday/shared';
import { MODULES, NAV_GROUPS, type ModuleRoute, type NavGroup } from './index';

export interface NavItem {
  path: string;
  label: string;
  tabLabel: string;
  icon: string;
  group: NavGroup;
}

export interface Nav {
  routes: ModuleRoute[];
  tabs: NavItem[];
  /** Grouped, in menu order (only groups with something in them). */
  groups: Array<{ key: NavGroup; label: string; items: NavItem[] }>;
  /** Hana is on for this household (floating button for grown-ups). */
  hana: boolean;
}

export function navFor(me: Me): Nav {
  const who: 'kid' | 'adult' = me.member?.kind === 'adult' ? 'adult' : 'kid';
  const off = new Set(me.household?.modulesOff ?? []);
  const hasKids = me.household?.hasKids ?? false;
  // A solo grown-up (no kids, nobody else signed in here) doesn't get family pages until that changes.
  const family = me.household ? liveFeatures(me.household).family : true;
  const tooYoung = (m: ModuleRoute): boolean => m.minKidAge !== undefined && who === 'kid' && (me.member?.age ?? 0) < m.minKidAge;
  const visible = (m: ModuleRoute): boolean =>
    !tooYoung(m) &&
    !(m.module && off.has(m.module)) &&
    // A grown-up's kid tools only when there are kids (kids always see their own).
    !(m.kidsOnly && who === 'adult' && !hasKids) &&
    !(m.familyOnly && who === 'adult' && !family) &&
    (m.audience === 'all' ||
      m.audience === who ||
      (m.audience === 'tutor' && (who === 'kid' || me.xpTrack === 'student')) ||
      (m.audience === 'admin' && me.isAdmin));
  const routes = MODULES.filter(visible);
  const item = (m: ModuleRoute): NavItem => {
    const n = m.nav as NonNullable<ModuleRoute['nav']>;
    const label = who === 'kid' && n.kidLabel ? n.kidLabel : n.label;
    return { path: m.path, label, tabLabel: n.tabLabel ?? label, icon: n.icon, group: !family && m.soloGroup ? m.soloGroup : n.group };
  };
  const tabs = routes.filter((m) => m.nav?.tabFor?.includes(who)).map(item);
  // With the Feed app on its own domain, the horn on the tab bar is the Feed's one front door (no second entry).
  const listed = routes.filter((m) => m.nav && !m.nav.tabFor?.includes(who) && !(FEED_URL && m.path === '/feed')).map(item);
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: listed.filter((i) => i.group === g.key) })).filter((g) => g.items.length > 0);
  return { routes, tabs, groups, hana: who === 'adult' && !off.has('hana') };
}
