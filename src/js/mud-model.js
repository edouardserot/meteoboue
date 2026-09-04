/**
 * Bilan hydrique journalier d'un sentier, et traduction en etat de sol.
 *
 * Principe : un reservoir de 15 cm de sol, alimente par la pluie et la fonte
 * nivale, vide par le ruissellement, le drainage vertical et
 * l'evapotranspiration. Les parametres du reservoir viennent du sol local
 * (soil.js), la meteo vient d'Open-Meteo.
 */

import { DEPTH_MM } from './soil.js';

/** Facteur degre-jour de fonte nivale (mm d'eau par °C au-dessus de 0). */
const FONTE_DEGRE_JOUR = 3.5;
/** Coefficient cultural de base (sol nu a sous-bois). */
const KC_BASE = 0.85;
/** Open-Meteo convertit l'equivalent en eau en hauteur de neige au ratio 1:7. */
export const RATIO_NEIGE = 0.7;

/**
 * Les etats du sol.
 *
 * `roulabilite` (0-100) est le SEUL axe porte par la couleur : « est-ce que
 * j'y vais ? ». L'humidite, elle, n'est plus codee par la teinte — un sol
 * gele et un sol sec roulent tous les deux bien, et melanger les deux
 * grandeurs obligeait a memoriser une legende de huit entrees.
 *
 * `glyphe` ne porte que la CAUSE, et seulement quand elle est inattendue :
 * l'eau etant l'explication par defaut, elle n'a pas de pictogramme.
 */
export const ETATS = {
  parfait:  { cle: 'parfait',  label: 'Grip parfait',            court: 'Parfait',  roulabilite: 100, glyphe: null },
  humide:   { cle: 'humide',   label: 'Humide, ça tient',        court: 'Humide',   roulabilite: 82,  glyphe: null },
  gele:     { cle: 'gele',     label: 'Sol gelé, dur et roulant', court: 'Gelé',    roulabilite: 72,  glyphe: '❄' },
  sec:      { cle: 'sec',      label: 'Sec et dur',              court: 'Sec',      roulabilite: 68,  glyphe: null },
  gras:     { cle: 'gras',     label: 'Ça colle aux pneus',      court: 'Gras',     roulabilite: 38,  glyphe: null },
  neige:    { cle: 'neige',    label: 'Sous la neige',           court: 'Neige',    roulabilite: 28,  glyphe: '❄' },
  degel:    { cle: 'degel',    label: 'Dégel, sentiers fragiles', court: 'Dégel',   roulabilite: 15,  glyphe: '❄' },
  bourbier: { cle: 'bourbier', label: 'Bourbier',                court: 'Bourbier', roulabilite: 5,   glyphe: null },
};

/** Etats sur lesquels on part rouler sans y penser. */
export const ETATS_ROULABLES = ['parfait', 'humide', 'sec', 'gele'];

/**
 * Rampe rouge -> vert. Un seul degrade continu, donc rien a apprendre :
 * plus c'est vert, plus on y va.
 *
 * Le palier jaune est a 55, pas a 62 : « sec » vaut 68 et « gele » 72, deux
 * etats de ETATS_ROULABLES qui tombaient juste au-dessus d'un jaune d'alerte.
 * Une semaine seche affichait alors trente-quatre lignes jaunes alors que
 * tout roulait. Le vert s'etale desormais de 70 a 100 (palier ajoute a 85),
 * ce qui donne quatre verts distincts aux quatre etats roulables.
 * La moitie rouge ne bouge quasiment pas : elle se lisait deja bien.
 *
 * Toute modification ici doit etre reportee sur .legende__rampe dans
 * src/style.css, qui recopie le degrade a la main.
 */
const RAMPE = [
  { p: 0, c: [124, 22, 22] },
  { p: 20, c: [196, 44, 40] },
  { p: 40, c: [223, 110, 32] },
  { p: 55, c: [214, 168, 34] },
  { p: 70, c: [126, 178, 54] },
  { p: 85, c: [46, 150, 72] },
  { p: 100, c: [26, 168, 84] },
];

/** Couleur d'un etat, deduite de sa seule roulabilite. */
export function couleurRoulabilite(score) {
  const v = Math.min(100, Math.max(0, score));
  let bas = RAMPE[0];
  let haut = RAMPE[RAMPE.length - 1];
  for (let i = 0; i < RAMPE.length - 1; i++) {
    if (v >= RAMPE[i].p && v <= RAMPE[i + 1].p) {
      bas = RAMPE[i];
      haut = RAMPE[i + 1];
      break;
    }
  }
  const t = haut.p === bas.p ? 0 : (v - bas.p) / (haut.p - bas.p);
  const canal = (i) => Math.round(bas.c[i] + (haut.c[i] - bas.c[i]) * t);
  return `rgb(${canal(0)}, ${canal(1)}, ${canal(2)})`;
}

/** Couleur de l'etat d'un jour. */
export function couleurEtat(etat) {
  return couleurRoulabilite(etat.roulabilite);
}

/**
 * Deroule le bilan hydrique sur toute la serie fournie.
 *
 * @param {object} meteo  series journalieres Open-Meteo (time, rain_sum,
 *                        snowfall_sum, et0_fao_evapotranspiration,
 *                        temperature_2m_max/min/mean)
 * @param {object} p      parametres hydro du spot (parametresHydro)
 * @returns {Array} un objet par jour
 */
export function bilanHydrique(meteo, p) {
  const n = meteo.time.length;
  let stock = p.stockFc;        // depart a la capacite au champ
  let manteauNeigeux = 0;       // mm d'equivalent en eau
  const jours = [];

  for (let i = 0; i < n; i++) {
    const pluie = num(meteo.rain_sum?.[i]);
    const neigeCm = num(meteo.snowfall_sum?.[i]);
    const et0 = num(meteo.et0_fao_evapotranspiration?.[i]);
    const tmax = num(meteo.temperature_2m_max?.[i], null);
    const tmin = num(meteo.temperature_2m_min?.[i], null);
    const tmoy = num(meteo.temperature_2m_mean?.[i], moyenne(tmax, tmin));

    // 1. Accumulation nivale
    manteauNeigeux += neigeCm / RATIO_NEIGE;

    // 2. Fonte
    let fonte = 0;
    if (manteauNeigeux > 0 && tmoy > 0) {
      fonte = Math.min(manteauNeigeux, FONTE_DEGRE_JOUR * tmoy);
      manteauNeigeux -= fonte;
    }

    // 3. Ruissellement : croit avec la saturation deja atteinte
    const exces = Math.max(0, (stock - p.stockFc) / Math.max(1e-6, p.stockSat - p.stockFc));
    const fractionRuissellement = clamp(p.ruissellementBase + 0.5 * exces, 0, 0.85);
    const apport = pluie + fonte;
    const ruissellement = apport * fractionRuissellement;
    stock += apport - ruissellement;

    // 4. Drainage vertical de l'exces au-dessus de la capacite au champ
    let drainage = 0;
    if (stock > p.stockFc) {
      drainage = (stock - p.stockFc) * p.drainage;
      stock -= drainage;
    }

    // 5. Evapotranspiration reelle : nulle sous la neige ou par gel,
    //    et ralentie a mesure que le sol s'asseche.
    let eta = 0;
    const solAccessible = manteauNeigeux < 5 && (tmax === null || tmax > 0);
    if (solAccessible) {
      const reserve = (stock - p.stockWp) / Math.max(1e-6, p.stockFc - p.stockWp);
      eta = et0 * KC_BASE * p.kcExposition * clamp(reserve / 0.6, 0, 1);
      stock -= eta;
    }

    stock = clamp(stock, p.stockWp, p.stockSat);

    const w = (stock - p.stockWp) / Math.max(1e-6, p.stockFc - p.stockWp);
    const etat = classerEtat({ w, manteauNeigeux, tmax, tmin });

    jours.push({
      date: meteo.time[i],
      pluie: round(pluie, 1),
      neige: round(neigeCm, 1),
      manteauNeigeux: round(manteauNeigeux, 1),
      et0: round(et0, 2),
      eta: round(eta, 2),
      ruissellement: round(ruissellement, 2),
      drainage: round(drainage, 2),
      stock: round(stock, 1),
      tmax,
      tmin,
      humidite: round(w, 3),
      indice: indiceBoue(w),
      etat,
    });
  }

  return jours;
}

/**
 * Indice de boue 0-100. 0 = sol sec et dur, 50 = capacite au champ,
 * 100 = sature. Sert a l'affichage et aux comparaisons entre spots.
 */
export function indiceBoue(w) {
  return Math.round(clamp((w - 0.35) / (1.35 - 0.35), 0, 1) * 100);
}

function classerEtat({ w, manteauNeigeux, tmax, tmin }) {
  if (manteauNeigeux >= 15) return ETATS.neige;
  if (tmax !== null && tmax < -0.5) return ETATS.gele;
  // Le pire cas : un sol charge en eau qui degele en cours de journee.
  if (tmin !== null && tmax !== null && tmin < -2 && tmax > 4 && w > 0.85) return ETATS.degel;
  if (w < 0.50) return ETATS.sec;
  if (w < 0.78) return ETATS.parfait;
  if (w < 1.00) return ETATS.humide;
  if (w < 1.22) return ETATS.gras;
  return ETATS.bourbier;
}

/**
 * Nombre de jours avant de retrouver un sol roulant, a partir d'aujourd'hui.
 * Renvoie null si c'est deja bon, ou si ca ne s'ameliore pas sur la fenetre.
 */
export function delaiAvantSechage(jours, indexAujourdhui) {
  const roulable = (j) => ETATS_ROULABLES.includes(j.etat.cle);
  if (roulable(jours[indexAujourdhui])) return 0;
  for (let i = indexAujourdhui + 1; i < jours.length; i++) {
    if (roulable(jours[i])) return i - indexAujourdhui;
  }
  return null;
}

/** Cumul de pluie sur les n derniers jours (jour courant inclus). */
export function cumulPluie(jours, indexFin, n) {
  let total = 0;
  for (let i = Math.max(0, indexFin - n + 1); i <= indexFin; i++) {
    total += jours[i].pluie + jours[i].neige / RATIO_NEIGE;
  }
  return round(total, 1);
}

export { DEPTH_MM };

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }
function num(v, fallback = 0) { return Number.isFinite(v) ? v : fallback; }
function moyenne(a, b) { return a !== null && b !== null ? (a + b) / 2 : 0; }
