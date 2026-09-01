/**
 * Derivation des parametres hydrologiques d'un spot a partir de :
 *  - la granulometrie SoilGrids (argile / limon / sable / densite apparente)
 *  - la lithologie BRGM (roche mere : karst, granite, marne...)
 *  - la pente issue du MNT IGN
 *
 * Module pur : utilise tel quel par le script d'enrichissement (Node)
 * et par le navigateur.
 */

/** Epaisseur de sol qui determine l'etat de surface d'un sentier (mm). */
export const DEPTH_MM = 150;

/* ------------------------------------------------------------------ */
/* Lithologie                                                          */
/* ------------------------------------------------------------------ */

/**
 * La granulometrie seule ne suffit pas : un limon sur karst calcaire draine
 * infiniment mieux que le meme limon sur marne. Le facteur corrige le
 * drainage vertical estime a partir de la texture.
 */
const FAMILLES_LITHO = [
  { re: /calcaire|karst|dolomi/i,                      classe: 'calcaire',       facteur: 1.45 },
  { re: /gr(e|è)s|sable|sabl/i,                        classe: 'gréseux',        facteur: 1.30 },
  { re: /granit|granodiorit|magmatiq|volcaniq|basalt|rhyolit|diorit|gabbro/i,
                                                       classe: 'magmatique',     facteur: 1.15 },
  { re: /schist|gneiss|micaschist|m(e|é)tamorphiq|migmatit|ardois/i,
                                                       classe: 'métamorphique',  facteur: 1.10 },
  { re: /alluvion|colluvion|superficiel|d(e|é)p(o|ô)t|terrasse|moraine|(e|é)boulis/i,
                                                       classe: 'alluvial',       facteur: 0.95 },
  { re: /marne|argile|molasse|flysch|pelit|gypse/i,    classe: 'marno-argileux', facteur: 0.60 },
];

/**
 * Les unites du BRGM sont souvent composites (« Calcaires, marnes et gypse »).
 * Prendre la premiere famille reconnue serait trompeur : dans un ensemble
 * marno-calcaire, c'est la marne qui gouverne la tenue du sentier. On moyenne
 * donc les facteurs de toutes les familles presentes.
 */
export function classerLithologie(descr = '', type = '') {
  const texte = `${descr ?? ''} ${type ?? ''}`;
  const familles = FAMILLES_LITHO.filter((f) => f.re.test(texte));

  if (!familles.length) {
    return { classe: 'indéterminé', facteur: 1.0, familles: [], descr: descr || null };
  }

  const facteur = familles.reduce((somme, f) => somme + f.facteur, 0) / familles.length;
  return {
    classe: familles.map((f) => f.classe).join(' / '),
    facteur,
    familles: familles.map((f) => f.classe),
    descr: descr || null,
  };
}

/* ------------------------------------------------------------------ */
/* Texture                                                             */
/* ------------------------------------------------------------------ */

/** Classe texturale simplifiee (triangle USDA), pour l'affichage. */
export function classerTexture(argile, limon, sable) {
  if (argile >= 40) return 'argile';
  if (argile >= 27) return sable >= 45 ? 'argile sableuse' : 'argile limoneuse';
  if (limon >= 50 && argile >= 12) return 'limon argileux';
  if (limon >= 50) return 'limon fin';
  if (sable >= 70) return argile >= 15 ? 'sable argileux' : 'sable';
  if (argile >= 20) return 'limon argilo-sableux';
  return 'limon';
}

/* ------------------------------------------------------------------ */
/* Fonctions de pedotransfert                                          */
/* ------------------------------------------------------------------ */

/**
 * Teneurs en eau caracteristiques, d'apres les regressions de
 * Saxton & Rawls (forme simplifiee, sans terme de matiere organique).
 * argile / sable en %, densite apparente en kg/dm3.
 */
export function teneursCaracteristiques(argile, sable, densite) {
  let thetaFc = 0.2576 - 0.002 * sable + 0.0036 * argile; // capacite au champ
  let thetaWp = 0.026 + 0.005 * argile;                   // point de fletrissement
  let thetaSat = densite > 0 ? 1 - densite / 2.65 : 0.45; // porosite totale

  // Garde-fous : l'ordre wp < fc < sat doit toujours tenir.
  thetaWp = clamp(thetaWp, 0.02, 0.35);
  thetaFc = clamp(thetaFc, thetaWp + 0.04, 0.55);
  thetaSat = clamp(thetaSat, thetaFc + 0.05, 0.70);

  return { thetaWp, thetaFc, thetaSat };
}

/* ------------------------------------------------------------------ */
/* Parametres hydro complets d'un spot                                 */
/* ------------------------------------------------------------------ */

export function parametresHydro({ argile, limon, sable, densite, litho, pentePct = 0, exposition = null }) {
  const { thetaWp, thetaFc, thetaSat } = teneursCaracteristiques(argile, sable, densite);
  const lithoInfo = classerLithologie(litho?.descr, litho?.type);

  // Drainage vertical : fraction de l'exces au-dessus de la capacite au champ
  // evacuee chaque jour. Pilote par l'argile, corrige par la roche mere, puis
  // par la pente (drainage lateral : un sentier pentu se purge tout seul).
  // L'effet de pente est plafonne, au-dela de ~50 % c'est du rocher.
  const drainageTexture = clamp(0.90 - 0.016 * argile, 0.12, 0.90);
  const effetPente = 1 + (Math.min(pentePct, 50) / 100) * 0.6;
  const drainage = clamp(drainageTexture * lithoInfo.facteur * effetPente, 0.08, 0.92);

  // Ruissellement de base : l'eau qui part sans s'infiltrer.
  const ruissellementBase = clamp(0.03 + 0.004 * argile + 0.005 * pentePct, 0, 0.60);

  // Un versant sud recoit nettement plus d'energie qu'un versant nord ;
  // l'effet s'annule sur terrain plat.
  let kcExposition = 1;
  if (exposition !== null && Number.isFinite(exposition)) {
    const poidsPente = Math.min(1, pentePct / 25);
    kcExposition = 1 + 0.15 * Math.cos(((exposition - 180) * Math.PI) / 180) * poidsPente;
  }

  return {
    thetaWp,
    thetaFc,
    thetaSat,
    stockWp: thetaWp * DEPTH_MM,
    stockFc: thetaFc * DEPTH_MM,
    stockSat: thetaSat * DEPTH_MM,
    drainage,
    ruissellementBase,
    kcExposition,
    texture: classerTexture(argile, limon, sable),
    litho: lithoInfo,
  };
}

/** Vitesse de ressuyage en clair, pour l'interface. */
export function vitesseSechage(drainage) {
  if (drainage >= 0.72) return 'sèche très vite';
  if (drainage >= 0.50) return 'sèche vite';
  if (drainage >= 0.32) return 'séchage moyen';
  if (drainage >= 0.20) return 'sèche lentement';
  return 'retient l’eau longtemps';
}

/** Phrase courte decrivant le comportement du sol. */
export function decrireSol(p) {
  // On prefere le libelle brut du BRGM a notre classe collapsee : il est plus
  // informatif, et il montre les unites composites telles qu'elles sont.
  const roche = (p.litho.descr ?? p.litho.classe).toLowerCase();
  return `${p.texture} sur ${roche} — ${vitesseSechage(p.drainage)}`;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
