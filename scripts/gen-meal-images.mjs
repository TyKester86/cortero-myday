#!/usr/bin/env node
/**
 * Generates one illustrated picture per meal in api/content/meals.csv into
 * web/public/meals/<slug>.svg — a consistent, warm, brand-styled style
 * (cream card, the MyDay navy peaks + sun mark, top-down food on a plate or
 * in a bowl, drawn from the meal's real ingredients). Deterministic: the
 * same meal always produces the same picture.
 *
 *   node scripts/gen-meal-images.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = path.join(root, 'api', 'content', 'meals.csv');
const outDir = path.join(root, 'web', 'public', 'meals');

// One slug rule for the importer and the pictures (shared/src/index.ts).
const { mealSlug: slugify } = await import('../shared/dist/index.js');

function parse(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/* ---------- deterministic randomness per meal ---------- */
function rng(seedText) {
  let h = 2166136261;
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- what's on the plate ---------- */
const has = (text, ...words) => words.some((w) => text.includes(w));

function analyze(title, cuisine, ingredients) {
  const t = `${title} ${ingredients}`.toLowerCase().replace(/fish sauce/g, 'fsauce').replace(/chili powder|chili flakes|chili bean paste|sweet chili/g, 'spice');
  const name = title.toLowerCase();
  const vessel =
    has(name, 'soup', 'chili', 'stew', 'pho', 'gumbo', 'pozole', 'curry', 'dal', 'masala', 'chowder') && !has(name, 'casserole', 'chili mac', 'pasta')
      ? 'bowl'
      : has(t, 'parfait', 'overnight oats')
        ? 'jar'
        : has(t, 'taco', 'burrito', 'wrap', 'quesadilla', 'fajita', 'gyro', 'pita', 'enchilada') && !has(t, 'bowl', 'casserole', 'skillet')
          ? 'tortilla'
          : has(name, 'sheet pan', 'sheet-pan', 'skillet', 'shakshuka', 'hash', 'casserole', 'bake', 'ziti', 'pie', 'jambalaya')
            ? 'skillet'
            : 'plate';
  const protein =
    has(t, 'salmon') ? 'salmon'
    : has(t, 'shrimp') ? 'shrimp'
    : has(t, 'tuna', 'cod', 'fish and chips') ? 'fish'
    : has(t, 'tofu') ? 'tofu'
    : has(t, 'meatball', 'kofta') ? 'balls'
    : has(t, 'sausage', 'andouille', 'ham') && !has(t, 'chicken breast') ? 'sausage'
    : has(t, 'ground beef', 'ground turkey', 'ground chicken', 'ground pork', 'ground lamb', 'sloppy', 'bolognese') ? 'crumbles'
    : has(t, 'steak', 'flank', 'sirloin', 'chuck', 'stew meat', 'lamb') ? 'beef'
    : has(t, 'pork') ? 'pork'
    : has(t, 'turkey') ? 'turkey'
    : has(t, 'chicken') ? 'chicken'
    : has(t, 'egg') ? 'egg'
    : has(t, 'chickpea', 'lentil', 'bean') ? 'beans'
    : has(t, 'yogurt', 'oats', 'pancake', 'muffin') ? 'grain'
    : 'chicken';
  const carb =
    has(t, 'noodle', 'spaghetti', 'linguine', 'lo mein', 'yakisoba', 'pad thai') ? 'noodles'
    : has(t, 'penne', 'ziti', 'orzo', 'macaroni', 'pasta') ? 'pasta'
    : has(t, 'quinoa') ? 'quinoa'
    : has(t, 'rice', 'grits', 'barley') ? 'rice'
    : has(t, 'potato') ? 'potatoes'
    : has(t, 'tortilla', 'naan', 'pita') ? 'flatbread'
    : has(t, 'bun', 'bread', 'bagel', 'crouton') ? 'bread'
    : has(t, 'oats', 'granola', 'pancake', 'muffin') ? 'oats'
    : null;
  const veg = [];
  const v = (key, ...words) => { if (has(t, ...words) && veg.length < 3 && !veg.includes(key)) veg.push(key); };
  v('broccoli', 'broccoli', 'bok choy');
  v('greens', 'lettuce', 'romaine', 'spinach', 'kale', 'greens', 'arugula', 'basil', 'cilantro', 'parsley');
  v('peppers', 'bell pepper', 'jalapeno', 'chilies');
  v('tomato', 'tomato', 'pico');
  v('carrots', 'carrot');
  v('corn', 'corn');
  v('avocado', 'avocado');
  v('cucumber', 'cucumber');
  v('beans', 'green beans', 'asparagus', 'snap peas', 'edamame');
  v('cabbage', 'cabbage', 'slaw');
  v('berries', 'berries');
  v('lemon', 'lemon', 'lime');
  if (!veg.length) veg.push('greens');
  const sauce =
    has(t, 'marinara', 'tomato sauce', 'crushed tomatoes', 'enchilada sauce', 'bolognese') ? '#C8432C'
    : has(t, 'curry', 'masala', 'tikka', 'butter chicken', 'dal') ? '#D9822B'
    : has(t, 'teriyaki', 'soy', 'adobo', 'bulgogi', 'hoisin', 'orange chicken') ? '#7A4320'
    : has(t, 'pesto', 'chimichurri', 'green curry') ? '#5E8C31'
    : has(t, 'yogurt', 'tzatziki', 'alfredo', 'half-and-half', 'cream') ? '#F2EBDD'
    : null;
  const broth = has(t, 'pho', 'noodle soup', 'orzo soup', 'dumplings') ? '#E7C27A'
    : has(t, 'chili', 'tortilla soup', 'pozole', 'minestrone', 'tomato', 'gumbo', 'stew', 'barley', 'hamburger') ? '#B5462E'
    : has(t, 'curry', 'masala', 'dal', 'split pea') ? '#C98A2E'
    : '#C9A15A';
  const salad = cuisine === 'Salad' || has(name, 'salad', 'larb');
  return { vessel, protein, carb, veg, sauce, broth, salad };
}

/* ---------- drawing ---------- */
const CUISINE_TINT = {
  Mexican: '#F6E3CF', Italian: '#F4E1DA', Chinese: '#F6E0D6', Japanese: '#EDE6DA', Korean: '#F3E0DC', Thai: '#E9EEDC',
  Vietnamese: '#E5EEDF', Indian: '#F7E6CC', Greek: '#E3EAF2', Mediterranean: '#E6EDE9', 'Middle Eastern': '#F3E6D2',
  Cajun: '#F4DFD2', Southern: '#F3E4D3', Breakfast: '#F8EDD5', Salad: '#E6F0DF', Soup: '#F2E4D8', Hawaiian: '#E3F0EE',
  British: '#E9E6E1', Caribbean: '#E8F0DC', Filipino: '#F2E3D8', Argentine: '#ECE4DA', Asian: '#F1E5D9', American: '#F2E6DA',
};

function grains(r, cx, cy, rx, ry, color, n, len) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r());
    const x = cx + Math.cos(a) * rx * d, y = cy + Math.sin(a) * ry * d;
    s += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${len}" ry="${(len * 0.45).toFixed(1)}" fill="${color}" transform="rotate(${Math.round(r() * 180)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }
  return s;
}

function drawCarb(r, kind, cx, cy) {
  switch (kind) {
    case 'rice':
      return `<ellipse cx="${cx}" cy="${cy}" rx="58" ry="44" fill="#FBF8F1"/>` + grains(r, cx, cy, 52, 38, '#E9E1CF', 70, 3.2);
    case 'quinoa':
      return `<ellipse cx="${cx}" cy="${cy}" rx="56" ry="42" fill="#EBDDBE"/>` + grains(r, cx, cy, 50, 36, '#D6C29A', 90, 2);
    case 'noodles':
    case 'pasta': {
      const col = kind === 'noodles' ? '#F0D9A0' : '#EFC97E';
      let s = `<ellipse cx="${cx}" cy="${cy}" rx="58" ry="44" fill="${col}" opacity="0.55"/>`;
      for (let i = 0; i < 9; i++) {
        const y = cy - 34 + i * 8.5 + r() * 3;
        s += `<path d="M${cx - 52} ${y.toFixed(1)} q 13 -9 26 0 t 26 0 t 26 0 t 26 0" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round"/>`;
      }
      return s;
    }
    case 'potatoes': {
      let s = '';
      for (let i = 0; i < 7; i++) {
        const x = cx - 40 + r() * 80, y = cy - 30 + r() * 60;
        s += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="16" ry="12" fill="#E2A94A" stroke="#C98A2E" stroke-width="2" transform="rotate(${Math.round(r() * 90)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
      }
      return s;
    }
    case 'flatbread':
      return `<path d="M${cx - 60} ${cy + 10} a62 44 0 0 1 120 -18 l -8 34 z" fill="#EBC889" stroke="#D2A55C" stroke-width="3"/>` + grains(r, cx, cy, 40, 20, '#C8954A', 14, 3);
    case 'bread':
      return `<rect x="${cx - 52}" y="${cy - 34}" width="104" height="68" rx="22" fill="#D99A4E"/><rect x="${cx - 44}" y="${cy - 26}" width="88" height="52" rx="16" fill="#F2D09A"/>`;
    case 'oats':
      return `<ellipse cx="${cx}" cy="${cy}" rx="56" ry="42" fill="#E9D7B4"/>` + grains(r, cx, cy, 50, 36, '#CDB083', 60, 4);
    default:
      return '';
  }
}

function drawProtein(r, kind, cx, cy) {
  const slices = (fill, mark, n = 5) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      const x = cx - 40 + i * 20, y = cy + (i % 2 ? 6 : -4);
      s += `<rect x="${x}" y="${y - 22}" width="26" height="46" rx="10" fill="${fill}" transform="rotate(-18 ${x + 13} ${y})"/>`;
      s += `<line x1="${x + 4}" y1="${y - 10}" x2="${x + 22}" y2="${y - 14}" stroke="${mark}" stroke-width="3" stroke-linecap="round" transform="rotate(-18 ${x + 13} ${y})"/>`;
      s += `<line x1="${x + 4}" y1="${y + 4}" x2="${x + 22}" y2="${y}" stroke="${mark}" stroke-width="3" stroke-linecap="round" transform="rotate(-18 ${x + 13} ${y})"/>`;
    }
    return s;
  };
  switch (kind) {
    case 'chicken':
    case 'turkey':
      return slices('#E8C08A', '#B9824A');
    case 'pork':
      return slices('#EDB9A0', '#B97A5C');
    case 'beef':
      return slices('#8E4A33', '#5E2E1F');
    case 'salmon':
      return `<rect x="${cx - 46}" y="${cy - 26}" width="92" height="52" rx="20" fill="#F08C5F"/>` +
        [0, 1, 2, 3].map((i) => `<path d="M${cx - 30 + i * 20} ${cy - 22} q 6 22 0 44" fill="none" stroke="#FBD4BE" stroke-width="3"/>`).join('') +
        `<rect x="${cx - 46}" y="${cy - 26}" width="92" height="52" rx="20" fill="none" stroke="#C85F37" stroke-width="2"/>`;
    case 'fish':
      return `<rect x="${cx - 46}" y="${cy - 24}" width="92" height="48" rx="20" fill="#F6EEDF" stroke="#E2D2B4" stroke-width="2"/>` +
        [0, 1, 2].map((i) => `<path d="M${cx - 24 + i * 22} ${cy - 18} q 8 18 0 36" fill="none" stroke="#E6D8BC" stroke-width="3"/>`).join('');
    case 'shrimp': {
      let s = '';
      for (let i = 0; i < 6; i++) {
        const x = cx - 40 + (i % 3) * 38 + r() * 6, y = cy - 16 + Math.floor(i / 3) * 30;
        s += `<path d="M${x} ${y} a14 14 0 1 1 18 14" fill="none" stroke="#F28A6B" stroke-width="10" stroke-linecap="round"/>`;
        s += `<path d="M${x} ${y} a14 14 0 1 1 18 14" fill="none" stroke="#FBC3AE" stroke-width="3" stroke-linecap="round"/>`;
      }
      return s;
    }
    case 'balls': {
      let s = '';
      for (let i = 0; i < 6; i++) {
        const x = cx - 36 + (i % 3) * 34, y = cy - 14 + Math.floor(i / 3) * 30;
        s += `<circle cx="${x}" cy="${y}" r="15" fill="#8A4B30"/><circle cx="${x - 4}" cy="${y - 5}" r="5" fill="#A8664A"/>`;
      }
      return s;
    }
    case 'crumbles': {
      let s = '';
      for (let i = 0; i < 26; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 40;
        const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * 0.7;
        s += `<path d="M${x.toFixed(1)} ${y.toFixed(1)} l 7 -3 l 4 6 l -6 5 l -7 -2 z" fill="${i % 3 ? '#7E4128' : '#9A5636'}"/>`;
      }
      return s;
    }
    case 'sausage': {
      let s = '';
      for (let i = 0; i < 8; i++) {
        const x = cx - 42 + (i % 4) * 28 + r() * 4, y = cy - 14 + Math.floor(i / 4) * 30;
        s += `<circle cx="${x}" cy="${y}" r="12" fill="#A0452E"/><circle cx="${x}" cy="${y}" r="8" fill="#C46A4E"/>`;
      }
      return s;
    }
    case 'tofu': {
      let s = '';
      for (let i = 0; i < 8; i++) {
        const x = cx - 44 + (i % 4) * 24, y = cy - 22 + Math.floor(i / 4) * 26;
        s += `<rect x="${x}" y="${y}" width="20" height="20" rx="4" fill="#F2DDA8" stroke="#D7B36A" stroke-width="2"/>`;
      }
      return s;
    }
    case 'egg':
      return [0, 1].map((i) => `<ellipse cx="${cx - 24 + i * 48}" cy="${cy}" rx="26" ry="22" fill="#FFFFFF"/><circle cx="${cx - 24 + i * 48}" cy="${cy}" r="10" fill="#F2B632"/>`).join('');
    case 'beans':
      return grains(r, cx, cy, 44, 30, '#7A3B2E', 40, 5) + grains(r, cx, cy, 44, 30, '#E8D3A0', 12, 5);
    case 'grain':
      return `<ellipse cx="${cx}" cy="${cy}" rx="46" ry="34" fill="#F8F4EC"/>`;
    default:
      return '';
  }
}

function drawVeg(r, kind, cx, cy) {
  const dots = (fill, n, rad, spread = 34) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread;
      s += `<circle cx="${(cx + Math.cos(a) * d).toFixed(1)}" cy="${(cy + Math.sin(a) * d * 0.7).toFixed(1)}" r="${rad}" fill="${fill}"/>`;
    }
    return s;
  };
  const sticks = (fill, n, w, l) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      const x = cx - 30 + r() * 60, y = cy - 18 + r() * 36;
      s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${l}" height="${w}" rx="${w / 2}" fill="${fill}" transform="rotate(${Math.round(r() * 160)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
    }
    return s;
  };
  switch (kind) {
    case 'broccoli': {
      let s = '';
      for (let i = 0; i < 5; i++) {
        const x = cx - 26 + (i % 3) * 26 + r() * 6, y = cy - 12 + Math.floor(i / 3) * 24;
        s += `<rect x="${x - 3}" y="${y}" width="6" height="12" fill="#8DB25C"/><circle cx="${x - 6}" cy="${y}" r="8" fill="#3F7F35"/><circle cx="${x + 6}" cy="${y}" r="8" fill="#3F7F35"/><circle cx="${x}" cy="${y - 6}" r="9" fill="#4E9440"/>`;
      }
      return s;
    }
    case 'greens': {
      let s = '';
      for (let i = 0; i < 6; i++) {
        const x = cx - 30 + r() * 60, y = cy - 18 + r() * 36;
        s += `<path d="M${x.toFixed(1)} ${y.toFixed(1)} q 14 -16 28 0 q -14 16 -28 0 z" fill="${i % 2 ? '#6AAE4B' : '#4E9440'}" transform="rotate(${Math.round(r() * 180)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
      }
      return s;
    }
    case 'peppers':
      return sticks('#D8432F', 4, 7, 30) + sticks('#E8B02F', 2, 7, 28) + sticks('#5B9A3C', 2, 7, 28);
    case 'tomato': {
      let s = '';
      for (let i = 0; i < 5; i++) {
        const x = cx - 26 + r() * 52, y = cy - 16 + r() * 32;
        s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="#E2483A"/><circle cx="${(x - 3).toFixed(1)}" cy="${(y - 3).toFixed(1)}" r="3" fill="#F49283"/>`;
      }
      return s;
    }
    case 'carrots':
      return sticks('#EE8A2E', 7, 6, 26);
    case 'corn':
      return dots('#F2C230', 30, 3.6);
    case 'avocado':
      return [0, 1, 2].map((i) => `<path d="M${cx - 30 + i * 22} ${cy + 16} q 10 -40 22 -36 q 6 20 -22 36 z" fill="#B8D36A" stroke="#4F7A2B" stroke-width="3"/>`).join('');
    case 'cucumber':
      return [0, 1, 2, 3].map((i) => `<circle cx="${cx - 30 + i * 20}" cy="${cy + (i % 2 ? 8 : -6)}" r="11" fill="#CFE6A9" stroke="#4F8A3A" stroke-width="3"/>`).join('');
    case 'beans':
      return sticks('#4E9440', 9, 5, 34);
    case 'cabbage':
      return sticks('#9B6BB0', 10, 3, 26) + sticks('#CFE0A6', 8, 3, 26);
    case 'berries':
      return dots('#3E4FA8', 10, 6) + dots('#D2364B', 8, 6);
    case 'lemon':
      return `<path d="M${cx - 18} ${cy + 10} a 22 22 0 0 1 44 0 z" fill="#F4D63E" stroke="#E2B92B" stroke-width="3"/><path d="M${cx + 4} ${cy + 10} l 0 -18 M${cx + 4} ${cy + 10} l -12 -12 M${cx + 4} ${cy + 10} l 12 -12" stroke="#E2B92B" stroke-width="2"/>`;
    default:
      return '';
  }
}

function brandMark() {
  // The MyDay peaks + sun, small, in the corner.
  return `<g transform="translate(330 248) scale(0.085)" opacity="0.9">
    <path d="M95 400 C113.3 369.2 167.5 224.2 205 215 C242.5 205.8 283.3 355.0 320 345 C356.7 335.0 395.8 145.0 425 155 C454.2 165.0 483.3 363.3 495 405" fill="none" stroke="#1B1B44" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="425" cy="78" r="34" fill="#F2A41E"/></g>`;
}

export function mealSvg(meal) {
  const r = rng(meal.slug);
  const a = analyze(meal.title, meal.cuisine, meal.ingredients);
  const bg = CUISINE_TINT[meal.cuisine] ?? '#F2E6DA';
  const cx = 200, cy = 150;
  let food = '';
  let vessel = '';
  if (a.vessel === 'bowl') {
    vessel = `<ellipse cx="${cx}" cy="${cy + 12}" rx="130" ry="100" fill="#000" opacity="0.08"/>
      <circle cx="${cx}" cy="${cy}" r="122" fill="#FFFFFF"/><circle cx="${cx}" cy="${cy}" r="122" fill="none" stroke="#E7E1D6" stroke-width="3"/>
      <circle cx="${cx}" cy="${cy}" r="102" fill="${a.broth}"/><circle cx="${cx}" cy="${cy}" r="102" fill="url(#shine)"/>`;
    food = drawProtein(r, a.protein, cx - 30, cy - 20) + (a.carb ? drawCarb(r, a.carb, cx + 34, cy + 30).replace(/<ellipse cx="[\d.]+" cy="[\d.]+" rx="5\d" ry="4\d" fill="[^"]+"\/>/, '') : '')
      + a.veg.map((v, i) => drawVeg(r, v, cx + [40, -40, 10][i % 3], cy + [-30, 40, 60][i % 3])).join('');
  } else if (a.vessel === 'jar') {
    vessel = `<rect x="${cx - 70}" y="${cy - 100}" width="140" height="200" rx="26" fill="#FFFFFF" opacity="0.85" stroke="#E2DCD2" stroke-width="3"/>`;
    food = `<rect x="${cx - 60}" y="${cy - 20}" width="120" height="110" rx="18" fill="#F8F4EC"/>` + drawCarb(r, 'oats', cx, cy - 40).replace('rx="56" ry="42"', 'rx="58" ry="26"') + drawVeg(r, 'berries', cx, cy - 70);
  } else if (a.vessel === 'tortilla') {
    vessel = `<ellipse cx="${cx}" cy="${cy + 12}" rx="150" ry="110" fill="#000" opacity="0.07"/><circle cx="${cx}" cy="${cy}" r="135" fill="#FFFFFF"/><circle cx="${cx}" cy="${cy}" r="135" fill="none" stroke="#E7E1D6" stroke-width="3"/>`;
    food = [-1, 1].map((s) => `<path d="M${cx + s * 50 - 55} ${cy + 40} a 58 58 0 0 1 110 0 z" fill="#EBC889" stroke="#D2A55C" stroke-width="3"/>`).join('')
      + drawProtein(r, a.protein, cx - 50, cy + 8).replace(/width="26" height="46"/g, 'width="16" height="30"')
      + a.veg.slice(0, 2).map((v, i) => drawVeg(r, v, cx + 50, cy + 10 - i * 14)).join('');
  } else {
    const isPan = a.vessel === 'skillet';
    vessel = isPan
      ? `<rect x="${cx + 120}" y="${cy - 14}" width="70" height="26" rx="12" fill="#2B2B2B"/><circle cx="${cx}" cy="${cy}" r="130" fill="#2F2F33"/><circle cx="${cx}" cy="${cy}" r="116" fill="#3A3A40"/>`
      : `<ellipse cx="${cx}" cy="${cy + 12}" rx="146" ry="110" fill="#000" opacity="0.07"/><circle cx="${cx}" cy="${cy}" r="135" fill="#FFFFFF"/><circle cx="${cx}" cy="${cy}" r="135" fill="none" stroke="#E7E1D6" stroke-width="3"/><circle cx="${cx}" cy="${cy}" r="110" fill="none" stroke="#F1ECE3" stroke-width="2"/>`;
    const bed = a.salad ? [0, 1, 2, 3, 4, 5].map((i) => drawVeg(r, 'greens', cx - 60 + (i % 3) * 60, cy - 30 + Math.floor(i / 3) * 60)).join('') : '';
    const sauce = a.sauce ? `<ellipse cx="${cx + 10}" cy="${cy + 6}" rx="${isPan ? 100 : 86}" ry="${isPan ? 90 : 70}" fill="${a.sauce}" opacity="0.85"/>` : '';
    food = bed + sauce + (a.carb ? drawCarb(r, a.carb, cx - 46, cy + 26) : '') + drawProtein(r, a.protein, cx + 30, cy - 36)
      + a.veg.map((v, i) => drawVeg(r, v, cx + [56, -50, 50][i % 3], cy + [44, -50, -2][i % 3])).join('');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" role="img" aria-label="${meal.title.replace(/&/g, 'and')}">
  <defs>
    <radialGradient id="bg" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="#FFFCF6"/><stop offset="1" stop-color="${bg}"/></radialGradient>
    <radialGradient id="shine" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.35"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="400" height="300" rx="28" fill="url(#bg)"/>
  <circle cx="${(40 + r() * 40).toFixed(0)}" cy="${(250 + r() * 20).toFixed(0)}" r="5" fill="#F2A41E" opacity="0.5"/>
  <circle cx="${(330 + r() * 30).toFixed(0)}" cy="${(30 + r() * 20).toFixed(0)}" r="4" fill="#1B1B44" opacity="0.15"/>
  ${vessel}
  <g>${food}</g>
  ${brandMark()}
</svg>
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const rows = parse(readFileSync(csvPath, 'utf8')).slice(1);
  mkdirSync(outDir, { recursive: true });
  for (const r of rows) {
    const meal = { title: r[1], cuisine: r[2], ingredients: r[7], slug: slugify(r[1]) };
    writeFileSync(path.join(outDir, `${meal.slug}.svg`), mealSvg(meal));
  }
  // Fallback for meals imported later without a picture: never a broken image.
  writeFileSync(path.join(outDir, '_placeholder.svg'), mealSvg({ title: 'A home-cooked meal', cuisine: 'American', ingredients: 'chicken rice broccoli', slug: '_placeholder' }));
  console.log(`wrote ${rows.length} meal pictures (+ placeholder) to web/public/meals/`);
}
