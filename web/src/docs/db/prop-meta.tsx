// What the app knows about each kind of property and view: its icon, its
// name, how wide its column starts out.

import {
  ArrowUpRight,
  Calendar,
  CalendarDays,
  ChartGantt,
  CircleChevronDown,
  ClipboardList,
  Clock,
  Hash,
  LayoutGrid,
  Link2,
  type LucideIcon,
  ScanSearch,
  Sigma,
  SquareCheck,
  SquareKanban,
  Table2,
  Tags,
  Type,
  UserRound,
  UserRoundPen,
} from "lucide-react";
import { t } from "@/lib/i18n";
import { COMPUTED_TYPES, type DBProperty, type PropertyType, type ViewType } from "@/types/docs";

const PROP_ICONS: Record<PropertyType, LucideIcon> = {
  text: Type,
  number: Hash,
  select: CircleChevronDown,
  multi_select: Tags,
  date: Calendar,
  checkbox: SquareCheck,
  url: Link2,
  member: UserRound,
  relation: ArrowUpRight,
  rollup: ScanSearch,
  formula: Sigma,
  created_at: Clock,
  updated_at: Clock,
  created_by: UserRoundPen,
};

export const propTypeName = (type: PropertyType): string =>
  ({
    text: t("db.type.text"),
    number: t("db.type.number"),
    select: t("db.type.select"),
    multi_select: t("db.type.multi_select"),
    date: t("db.type.date"),
    checkbox: t("db.type.checkbox"),
    url: t("db.type.url"),
    member: t("db.type.member"),
    relation: t("db.type.relation"),
    rollup: t("db.type.rollup"),
    formula: t("db.type.formula"),
    created_at: t("db.type.created_at"),
    updated_at: t("db.type.updated_at"),
    created_by: t("db.type.created_by"),
  })[type];

/** A column's starting width in the table, in pixels. */
export const PROP_WIDTHS: Record<PropertyType, number> = {
  text: 200,
  number: 110,
  select: 150,
  multi_select: 200,
  date: 130,
  checkbox: 96,
  url: 200,
  member: 160,
  relation: 200,
  rollup: 130,
  formula: 160,
  created_at: 150,
  updated_at: 150,
  created_by: 130,
};

export const TITLE_WIDTH = 280;

export const isComputed = (prop: Pick<DBProperty, "type">) => COMPUTED_TYPES.includes(prop.type);

export const VIEW_ICONS: Record<ViewType, LucideIcon> = {
  table: Table2,
  board: SquareKanban,
  calendar: CalendarDays,
  gallery: LayoutGrid,
  timeline: ChartGantt,
  form: ClipboardList,
};

export const viewTypeName = (type: ViewType): string =>
  ({
    table: t("db.view.table"),
    board: t("db.view.board"),
    calendar: t("db.view.calendar"),
    gallery: t("db.view.gallery"),
    timeline: t("db.view.timeline"),
    form: t("db.view.form"),
  })[type];

export function PropIcon({ type, className }: { type: PropertyType; className?: string }) {
  const Icon = PROP_ICONS[type] ?? Type;
  return <Icon className={className ?? "size-3.5 shrink-0 text-ink-3"} aria-hidden />;
}
