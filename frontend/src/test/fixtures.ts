import type { Photo } from "@/services/api";

const EVENTS: { year: number; event: string; month: string }[] = [
  { year: 2026, event: "Diwali", month: "10" },
  { year: 2026, event: "Goa Trip", month: "06" },
  { year: 2026, event: "Holi", month: "03" },
  { year: 2025, event: "Daughter's Birthday", month: "11" },
  { year: 2025, event: "Shimla Winter", month: "01" },
  { year: 2024, event: "New House", month: "08" },
];
const PEOPLE = ["Dad", "Mom", "Son", "Daughter"];

function img(seed: string, w: number, h: number) {
  return `https://picsum.photos/seed/${seed}/${w}/${h}`;
}

export function makePhoto(i: number, overrides: Partial<Photo> = {}): Photo {
  const ev = EVENTS[i % EVENTS.length]!;
  const seed = overrides.id ?? `fv${i}`;
  const w = 4032 - (i % 3) * 1000;
  const h = Math.round(w * 0.75);
  const day = String((i % 27) + 1).padStart(2, "0");
  return {
    id: `p${i}`,
    filename: `IMG_${String(2000 + i)}.jpg`,
    kind: "photo",
    url: img(seed, 1200, 900),
    thumb: img(seed, 480, 360),
    width: w,
    height: h,
    sizeBytes: 2_400_000 + ((i * 731_113) % 3_000_000),
    takenAt: `${ev.year}-${ev.month}-${day}T1${i % 10}:2${i % 6}:00`,
    folder: `${ev.year}/${ev.year}-${ev.month} ${ev.event}`,
    year: ev.year,
    event: `${ev.year}-${ev.month} ${ev.event}`,
    person: PEOPLE[i % 4]!,
    people: [],
    autoPeople: [],
    maybePeople: [],
    ...overrides,
  };
}

export function seedPhotos(): Photo[] {
  const list: Photo[] = [];
  for (let i = 0; i < 48; i++) list.push(makePhoto(i));
  // a few tagged items for extra clean-up filters
  list[3]!.tags = ["screenshot"];
  list[3]!.filename = "Screenshot_2026-10-12.png";
  list[9]!.tags = ["screenshot"];
  list[9]!.filename = "Screenshot_2026-06-03.png";
  list[14]!.tags = ["blurry"];
  list[21]!.tags = ["blurry"];
  list[30]!.kind = "video";
  list[30]!.filename = "VID_2030.mp4";
  list[30]!.sizeBytes = 1_800_000_000;
  list[30]!.tags = ["large-video"];
  list[7]!.kind = "video";
  list[7]!.filename = "VID_2007.mp4";
  list[7]!.sizeBytes = 640_000_000;
  list[7]!.tags = ["large-video"];
  return list;
}

