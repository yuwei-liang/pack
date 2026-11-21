// A trip's PLAN: the flights and stays, the documents to hand over at a counter, and
// the places worth seeing — what the owner's native app (心安) shows on the road.
//
// It belongs to a list (one trip, one plan) but it is not list CONTENT the way folders
// and bags are: a booking reference, a seat, the address of where you sleep tonight
// are the owner's, so the plan never rides a share link. It is read and written only
// with the list's edit capability (the MCP tools) or the owner's account (app sync),
// and the editor does not carry it at all.
//
// The shape is fixed by the app that reads it — field names here are a contract with
// it, so they are spelled exactly as the app expects. Everything is normalized on the
// way in (normalizePlan), on both the op path and the whole-list path, the same way
// every other entity is.

import { safeUrl } from "./trailLink";
import { tidyText } from "./tidyText";

export const SEGMENT_KINDS = ["flight", "ground", "stay", "event"] as const;
export const DOC_KINDS = ["entry", "sim", "booking", "address", "other"] as const;
export const PLAN_STATUSES = ["booked", "todo"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];
export type DocKind = (typeof DOC_KINDS)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface PlanPlace {
  code?: string;
  name?: string;
}

export interface PlanSegment {
  id: string;
  kind: SegmentKind;
  title: string;
  /** ISO 8601 with its UTC offset: "2026-11-22T09:00:00-08:00" */
  start: string;
  end: string | null;
  /** IANA zones, when known */
  startTz?: string;
  endTz?: string;
  from: PlanPlace | null;
  to: PlanPlace | null;
  carrier?: string;
  number?: string;
  /** person is a name, as typed */
  seats?: { person: string; seat: string }[];
  confirmation?: string;
  bookedBy?: string;
  status: PlanStatus;
  note?: string;
  sortOrder: number;
}

export interface PlanDoc {
  id: string;
  kind: DocKind;
  title: string;
  person?: string;
  fields: { label: string; value: string; copy: boolean }[];
  /** what a QR code encodes, not an image */
  qr?: string;
  /** the language the doc is written in, e.g. "th" for an address shown to a driver */
  lang?: string;
  note?: string;
  sortOrder: number;
}

export interface PlanSpot {
  id: string;
  name: string;
  nameEn?: string;
  group?: string;
  note?: string;
  lat?: number;
  lng?: number;
  photoUrl?: string;
  visited: boolean;
  sortOrder: number;
}

export interface TripPlan {
  segments: PlanSegment[];
  docs: PlanDoc[];
  places: PlanSpot[];
}

export const MAX_PLAN_SEGMENTS = 100;
export const MAX_PLAN_DOCS = 100;
export const MAX_PLAN_PLACES = 300;
const MAX_FIELDS = 30;
const MAX_SEATS = 12;
const MAX_ID = 128;

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** a human string, tidied and capped; "" and non-strings are absent */
const txt = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = tidyText(v.slice(0, max)).trim();
  return t || undefined;
};
/** a machine string (a time, a zone, a code): trimmed and capped, never tidied */
const raw = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, max);
  return t || undefined;
};
const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
const oneOf = <T extends string>(v: unknown, set: readonly T[], fallback: T): T =>
  typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : fallback;
const order = (v: unknown, i: number) => (typeof v === "number" && Number.isFinite(v) ? v : i);

/** An ISO date-time as given, if Date can read it; the offset is kept verbatim. */
function isoTime(v: unknown): string | undefined {
  const s = raw(v, 40);
  return s && !Number.isNaN(Date.parse(s)) ? s : undefined;
}

function place(v: unknown): PlanPlace | null {
  const r = rec(v);
  if (!r) return null;
  const out: PlanPlace = {};
  const code = raw(r.code, 16);
  const name = txt(r.name, 200);
  if (code) out.code = code;
  if (name) out.name = name;
  return code || name ? out : null;
}

const put = <T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined) => {
  if (v !== undefined) o[k] = v;
};

export function normalizeSegment(v: unknown, i = 0): PlanSegment | null {
  const r = rec(v);
  const id = raw(r?.id, MAX_ID);
  const start = isoTime(r?.start);
  if (!r || !id || !start) return null; // a segment with no start is not on a timeline
  const seg: PlanSegment = {
    id,
    kind: oneOf(r.kind, SEGMENT_KINDS, "event"),
    title: txt(r.title, 200) ?? "",
    start,
    end: isoTime(r.end) ?? null,
    from: place(r.from),
    to: place(r.to),
    status: oneOf(r.status, PLAN_STATUSES, "booked"),
    sortOrder: order(r.sortOrder, i),
  };
  put(seg, "startTz", raw(r.startTz, 64));
  put(seg, "endTz", raw(r.endTz, 64));
  put(seg, "carrier", txt(r.carrier, 120));
  put(seg, "number", raw(r.number, 32));
  if (Array.isArray(r.seats)) {
    const seats = r.seats.slice(0, MAX_SEATS).flatMap((s) => {
      const sr = rec(s);
      const person = txt(sr?.person, 60);
      const seat = raw(sr?.seat, 16);
      return person && seat ? [{ person, seat }] : [];
    });
    if (seats.length) seg.seats = seats;
  }
  put(seg, "confirmation", raw(r.confirmation, 64));
  put(seg, "bookedBy", txt(r.bookedBy, 120));
  put(seg, "note", txt(r.note, 2000));
  return seg;
}

export function normalizeDoc(v: unknown, i = 0): PlanDoc | null {
  const r = rec(v);
  const id = raw(r?.id, MAX_ID);
  if (!r || !id) return null;
  const doc: PlanDoc = {
    id,
    kind: oneOf(r.kind, DOC_KINDS, "other"),
    title: txt(r.title, 200) ?? "",
    fields: Array.isArray(r.fields)
      ? r.fields.slice(0, MAX_FIELDS).flatMap((f) => {
          const fr = rec(f);
          const label = txt(fr?.label, 120);
          // a value is shown and copied as typed: an address in Thai, a code
          const value = typeof fr?.value === "string" ? fr.value.trim().slice(0, 1000) : "";
          return label || value ? [{ label: label ?? "", value, copy: fr?.copy === true }] : [];
        })
      : [],
    sortOrder: order(r.sortOrder, i),
  };
  put(doc, "person", txt(r.person, 60));
  put(doc, "qr", raw(r.qr, 4000));
  put(doc, "lang", raw(r.lang, 16));
  put(doc, "note", txt(r.note, 2000));
  return doc;
}

export function normalizeSpot(v: unknown, i = 0): PlanSpot | null {
  const r = rec(v);
  const id = raw(r?.id, MAX_ID);
  const name = txt(r?.name, 200);
  if (!r || !id || !name) return null;
  const spot: PlanSpot = { id, name, visited: r.visited === true, sortOrder: order(r.sortOrder, i) };
  put(spot, "nameEn", txt(r.nameEn, 200));
  put(spot, "group", txt(r.group, 120));
  put(spot, "note", txt(r.note, 2000));
  put(spot, "lat", num(r.lat, -90, 90));
  put(spot, "lng", num(r.lng, -180, 180));
  // http(s) only: the app downloads it, and nothing else should be fetched on its say-so
  const photo = raw(r.photoUrl, 2000);
  if (photo && safeUrl(photo)) spot.photoUrl = photo;
  return spot;
}

function list<T extends { id: string; sortOrder: number }>(
  v: unknown,
  max: number,
  norm: (x: unknown, i: number) => T | null,
): T[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const [i, x] of v.slice(0, max).entries()) {
    const e = norm(x, i);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder);
}

/** A plan from anywhere (an op, a stored row, a backup) → its stored form, or
 *  undefined when it holds nothing, so an emptied plan leaves no key behind. */
export function normalizePlan(v: unknown): TripPlan | undefined {
  const r = rec(v);
  if (!r) return undefined;
  const plan: TripPlan = {
    segments: list(r.segments, MAX_PLAN_SEGMENTS, normalizeSegment),
    docs: list(r.docs, MAX_PLAN_DOCS, normalizeDoc),
    places: list(r.places, MAX_PLAN_PLACES, normalizeSpot),
  };
  return plan.segments.length || plan.docs.length || plan.places.length ? plan : undefined;
}
