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
const RATIO_NEIGE = 0.7;

export const ETATS = {
  gele:     { cle: 'gele',     label: 'Sol gelé',            court: 'Gelé',      couleur: '#7dd3fc', roulabilite: 'bon' },
  neige:    { cle: 'neige',    label: 'Enneigé',             court: 'Neige',     couleur: '#e2e8f0', roulabilite: 'variable' },
  degel:    { cle: 'degel',    label: 'Dégel — sol fragile', court: 'Dégel',     couleur: '#c084fc', roulabilite: 'mauvais' },
  sec:      { cle: 'sec',      label: 'Sec, poussiéreux',    court: 'Sec',       couleur: '#fbbf24', roulabilite: 'bon' },
  parfait:  { cle: 'parfait',  label: 'Parfait',             court: 'Parfait',   couleur: '#22c55e', roulabilite: 'excellent' },
  humide:   { cle: 'humide',   label: 'Humide mais roulant', court: 'Humide',    couleur: '#84cc16', roulabilite: 'bon' },
  gras:     { cle: 'gras',     label: 'Gras par endroits',   court: 'Gras',      couleur: '#f97316', roulabilite: 'moyen' },
  bourbier: { cle: 'bourbier', label: 'Bourbier',            court: 'Bourbier',  couleur: '#b45309', roulabilite: 'mauvais' },
};

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
  const roulable = (j) => ['sec', 'parfait', 'humide'].includes(j.etat.cle);
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
