// PNG and ASCII previews of a map: ground colors, roads, streams, obstacles and action objects by category.

import { objectTypes } from '../data/enums.ts';
import { ObjectGroup, type MapFormat, type TileInfo } from '../fh2m/types.ts';
import { Grid } from '../grid.ts';
import { Ground, groundByImageIndex } from '../terrain/ground.ts';
import { MovementModel, isMonster, townColor, type MapObjectRef } from '../validate.ts';
import { RgbImage } from './png.ts';

type Rgb = readonly [number, number, number];

const GROUND_COLORS: Record<number, Rgb> = {
  [Ground.WATER]: [40, 90, 160],
  [Ground.GRASS]: [70, 140, 60],
  [Ground.SNOW]: [225, 230, 235],
  [Ground.SWAMP]: [80, 110, 85],
  [Ground.LAVA]: [90, 60, 55],
  [Ground.DESERT]: [215, 190, 120],
  [Ground.DIRT]: [140, 110, 70],
  [Ground.WASTELAND]: [170, 150, 110],
  [Ground.BEACH]: [235, 215, 160],
};

const PLAYER_COLORS: Rgb[] = [
  [40, 80, 255],
  [30, 200, 60],
  [230, 40, 40],
  [250, 230, 40],
  [250, 140, 20],
  [170, 60, 210],
  [150, 150, 150],
];

export type Category = 'castle' | 'hero' | 'mine' | 'monster' | 'treasure' | 'artifact' | 'dwelling' | 'powerup' | 'other';

export function categoryOf(o: MapObjectRef): Category {
  switch (o.group) {
    case ObjectGroup.KINGDOM_TOWNS:
      return 'castle';
    case ObjectGroup.KINGDOM_HEROES:
      return 'hero';
    case ObjectGroup.ADVENTURE_MINES:
      return 'mine';
    case ObjectGroup.MONSTERS:
      return 'monster';
    case ObjectGroup.ADVENTURE_TREASURES:
      return 'treasure';
    case ObjectGroup.ADVENTURE_ARTIFACTS:
      return 'artifact';
    case ObjectGroup.ADVENTURE_DWELLINGS:
      return 'dwelling';
    case ObjectGroup.ADVENTURE_POWER_UPS:
      return 'powerup';
    default:
      return isMonster(o.info) ? 'monster' : 'other';
  }
}

const CATEGORY_COLORS: Record<Category, Rgb> = {
  castle: [255, 255, 255],
  hero: [255, 255, 255],
  mine: [255, 140, 0],
  monster: [200, 0, 0],
  treasure: [255, 215, 0],
  artifact: [0, 230, 230],
  dwelling: [160, 90, 230],
  powerup: [255, 105, 180],
  other: [240, 240, 240],
};

const shade = (c: Rgb, f: number): Rgb => [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)];

export interface PreviewOptions {
  scale?: number;
  zoneOf?: Int16Array; // draws zone borders when given
}

export function renderPng(map: MapFormat, opts: PreviewOptions = {}): Uint8Array {
  const scale = opts.scale ?? Math.max(2, Math.floor(576 / map.width));
  const grid = new Grid(map.width);
  const model = new MovementModel(map);
  const img = new RgbImage(map.width * scale, map.width * scale);

  for (let t = 0; t < grid.size; ++t) {
    const tile = map.tiles[t] as TileInfo;
    let c = GROUND_COLORS[groundByImageIndex(tile.terrainIndex)] ?? [0, 0, 0];
    if (model.blocked[t]) c = shade(c, 0.55);
    if (opts.zoneOf) {
      const z = opts.zoneOf[t];
      const right = grid.x(t) + 1 < grid.width ? opts.zoneOf[t + 1] : z;
      const down = grid.y(t) + 1 < grid.width ? opts.zoneOf[t + grid.width] : z;
      if (right !== z || down !== z) c = shade(c, 0.8);
    }
    img.fillRect(grid.x(t) * scale, grid.y(t) * scale, scale, scale, c);
    if (tile.objects.some((o) => o.group === ObjectGroup.ROADS)) {
      const m = Math.max(1, Math.floor(scale / 3));
      img.fillRect(grid.x(t) * scale + m, grid.y(t) * scale + m, scale - 2 * m, scale - 2 * m, [190, 160, 110]);
    }
    if (tile.objects.some((o) => o.group === ObjectGroup.STREAMS)) {
      const m = Math.max(1, Math.floor(scale / 3));
      img.fillRect(grid.x(t) * scale + m, grid.y(t) * scale + m, scale - 2 * m, scale - 2 * m, [90, 150, 230]);
    }
  }

  for (const o of model.objects) {
    if (!o.info.isAction) continue;
    const category = categoryOf(o);
    let color = CATEGORY_COLORS[category];
    let size = 1;
    if (category === 'castle') {
      const c = townColor(map, o.tile, o.uid);
      color = PLAYER_COLORS[c >= 0 && c < 7 ? c : 6] as Rgb;
      size = 2;
    } else if (category === 'hero') {
      color = PLAYER_COLORS[o.info.metadata[0]] ?? color;
    } else if (o.info.objectType === objectTypes.OBJ_BOAT) {
      color = [120, 70, 20];
    }
    for (const a of o.info.actionCells) {
      const x = grid.x(o.tile) + a.dx;
      const y = grid.y(o.tile) + a.dy;
      const m = size === 2 ? 0 : Math.floor(scale / 4);
      img.fillRect(x * scale + m, y * scale + m, scale - 2 * m, scale - 2 * m, color);
    }
    if (category === 'castle') {
      // Outline the castle footprint.
      for (const p of o.info.occupied) img.fillRect((grid.x(o.tile) + p.dx) * scale, (grid.y(o.tile) + p.dy) * scale, scale, Math.max(1, scale >> 2), color);
    }
  }
  return img.toPng();
}

const GROUND_CHARS: Record<number, string> = {
  [Ground.WATER]: '~',
  [Ground.GRASS]: '.',
  [Ground.SNOW]: '*',
  [Ground.SWAMP]: '"',
  [Ground.LAVA]: '%',
  [Ground.DESERT]: ':',
  [Ground.DIRT]: ',',
  [Ground.WASTELAND]: ';',
  [Ground.BEACH]: '_',
};

const CATEGORY_CHARS: Record<Category, string> = {
  castle: 'C',
  hero: 'H',
  mine: 'M',
  monster: 'X',
  treasure: '$',
  artifact: 'A',
  dwelling: 'D',
  powerup: 'P',
  other: 'o',
};

export function renderAscii(map: MapFormat): string {
  const grid = new Grid(map.width);
  const model = new MovementModel(map);
  const chars: string[] = [];
  for (let t = 0; t < grid.size; ++t) {
    const tile = map.tiles[t] as TileInfo;
    let ch = GROUND_CHARS[groundByImageIndex(tile.terrainIndex)] ?? '?';
    if (tile.objects.some((o) => o.group === ObjectGroup.ROADS)) ch = '=';
    if (model.blocked[t]) ch = '#';
    chars.push(ch);
  }
  for (const o of model.objects) {
    if (!o.info.isAction) continue;
    for (const a of o.info.actionCells) {
      const x = grid.x(o.tile) + a.dx;
      const y = grid.y(o.tile) + a.dy;
      if (grid.inside(x, y)) chars[grid.index(x, y)] = CATEGORY_CHARS[categoryOf(o)];
    }
  }
  const lines: string[] = [];
  for (let y = 0; y < grid.width; ++y) lines.push(chars.slice(y * grid.width, (y + 1) * grid.width).join(''));
  return lines.join('\n');
}
