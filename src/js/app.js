/**
 * Meteo Boue — assemblage de l'interface.
 *
 * Chaine complete :
 *   spots.enriched.json (sol fige) + Open-Meteo (meteo du jour)
 *     -> bilan hydrique quotidien
 *     -> etat de sol par jour, sur 7 jours passes et 7 jours a venir.
 *
 * L'interface est organisee autour d'une seule question : « ou et quand ? ».
 * D'ou la grille spots x jours plutot qu'une liste, et un jour actif qui
 * recolore la carte et reordonne les spots.
 */

import {
  bilanHydrique,
  delaiAvantSechage,
  cumulPluie,
  couleurEtat,
  ETATS_ROULABLES,
  RATIO_NEIGE,
} from './mud-model.js';
import { vitesseSechage } from './soil.js';
import { meteoTousSpots, humiditeModele, JOURS_PASSES, JOURS_FUTURS } from './weather.js';

const TOULOUSE = { lat: 43.6045, lon: 1.4442 };
const COULEURS_TEXTURE = { argile: '#9a3412', limon: '#ca8a04', sable: '#fcd34d' };

/* --- Vignettes ---------------------------------------------------- */

/** Sous ce cumul, la bande de pluie ne se dessine pas : il n'a pas plu. */
const SEUIL_EAU_MM = 0.5;
/**
 * Largeur de la colonne du jour choisi, en parts de colonne ordinaire. A 3 elle
 * passe d'une trentaine de pixels a quatre-vingts : de quoi ecrire les mesures
 * au lieu de les suggerer.
 *
 * Les quatorze autres paient la difference, une dizaine de pour cent de
 * largeur. C'est tenable sur un grand ecran, pas en dessous de 1350 px ou
 * elles descendraient sous 25 px : la feuille de style y rend les colonnes
 * egales, et la lecture chiffree se replie sur le glyphe.
 */
const FACTEUR_JOUR_ACTIF = 3;
/** Cumul a partir duquel la bande sature : au-dela, c'est deja « beaucoup ». */
const EAU_SATURANTE_MM = 14;
/** Bande de pluie : hauteur en px, du minimum visible au maximum. */
const BANDE_PLUIE = { min: 2, max: 8 };
/**
 * Niveau d'eau du sol : part de la vignette occupee a vide, puis au plus.
 * Le plancher n'est pas cosmetique — sans lui, un ete sec efface la marque
 * partout et le lecteur ne sait plus si la jauge est vide ou absente.
 */
const SOL_VIDE_PCT = 7;
const SOL_PLEIN_PCT = 55;

/** Detour routier moyen par rapport a la distance a vol d'oiseau. */
const FACTEUR_ROUTE = 1.3;
/** Vitesse moyenne retenue pour estimer un temps de trajet, en km/h. */
const VITESSE_MOYENNE = 68;

const el = (id) => document.getElementById(id);

const CHEVRON =
  '<svg class="podium__fleche" viewBox="0 0 20 20" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M7.5 4.5 13 10l-5.5 5.5" /></svg>';

const pluriel = (n) => (n > 1 ? 's' : '');

const etat = {
  spots: [],
  jours: new Map(), // id -> bilan journalier complet
  idxAuj: 0, // index d'aujourd'hui dans les series
  jourActif: 0, // index du jour selectionne
  selection: null,
  zone: '', // '' = toutes
  trajetMax: '', // '' = sans limite, sinon un seuil en km a vol d'oiseau
  marqueurs: new Map(),
  carte: null,
  // Telephone seulement : « liste » ou « carte ». Au-dessus de 900 px la
  // grille et la carte tiennent cote a cote et l'attribut est sans effet.
  // La liste est le defaut : c'est elle qui repond a « ou rouler ? ».
  vue: 'liste',
};

/* ------------------------------------------------------------------ */
/* Demarrage                                                           */
/* ------------------------------------------------------------------ */

demarrer().catch((err) => {
  console.error(err);
  afficherErreur(`Impossible de charger les données : ${err.message}`);
  el('chargement').hidden = true;
});

async function demarrer() {
  const reponse = await fetch('./data/spots.enriched.json');
  if (!reponse.ok) {
    throw new Error(
      "spots.enriched.json est introuvable — lancez d'abord « node scripts/enrich-spots.mjs »"
    );
  }
  const { spots, genere } = await reponse.json();
  etat.spots = spots;

  initialiserCarte();

  const meteo = await meteoTousSpots(spots);
  calculerBilans(spots, meteo);
  etat.jourActif = etat.idxAuj;

  remplirFiltres(spots);

  el('chargement').remove();
  el('horodatage').textContent = `Sol : relevé ${formaterDateCourte(genere)}`;

  dessinerRail();
  dessinerTableau();
  dessinerListe();
  dessinerMarqueurs();
  dessinerVerdict();
  initialiserOnglets();

  // Les puces de zone et de trajet appellent filtrer() elles-memes : elles
  // changent la zone geographique regardee, et la carte suit.
  el('tri').addEventListener('change', rafraichirVues);
  el('fermer-detail').addEventListener('click', fermerDetail);
  el('rafraichir').addEventListener('click', () => {
    localStorage.removeItem('meteoboue.meteo.v2');
    location.reload();
  });
}

function calculerBilans(spots, meteo) {
  const aujourdhui = dateDuJour();

  for (const spot of spots) {
    const donnees = meteo.get(spot.id);
    if (!donnees?.daily) continue;

    etat.jours.set(spot.id, bilanHydrique(donnees.daily, spot.hydro));

    // Toutes les series viennent du meme appel : l'axe des dates est commun.
    if (!etat.dates) {
      etat.dates = donnees.daily.time;
      const trouve = etat.dates.indexOf(aujourdhui);
      // Filet de securite si le fuseau de l'API et celui du navigateur divergent.
      etat.idxAuj = trouve === -1 ? etat.dates.length - JOURS_FUTURS - 1 : trouve;
    }
  }
}

/** Les 15 index affiches : 7 jours passes, aujourd'hui, 7 a venir. */
function fenetre() {
  const debut = Math.max(0, etat.idxAuj - JOURS_PASSES);
  const fin = Math.min((etat.dates?.length ?? 0) - 1, etat.idxAuj + JOURS_FUTURS);
  const index = [];
  for (let i = debut; i <= fin; i++) index.push(i);
  return index;
}

function rafraichirVues() {
  dessinerRail();
  dessinerTableau();
  dessinerListe();
  majMarqueurs();
  dessinerVerdict();
}

function filtrer() {
  majBoutonFiltres();
  rafraichirVues();
  const visibles = spotsAffiches();
  // La carte peut etre masquee (vue Liste sur telephone) : son conteneur fait
  // alors 0 px et le recadrage n'a pas de sens.
  if (visibles.length && el('carte').clientWidth > 0) {
    etat.carte.fitBounds(emprise(visibles), { padding: 36, maxZoom: 10.5, duration: 600 });
  }
}

/* ------------------------------------------------------------------ */
/* Selection des spots affiches                                        */
/* ------------------------------------------------------------------ */

/**
 * Seuils de trajet. La valeur reste une distance a vol d'oiseau en km ;
 * le libelle donne le temps de route, qui est ce qu'on a en tete.
 */
const TRAJETS = [
  ['', 'Tout'],
  ['30', '≤ 30 min'],
  ['60', '≤ 1 h'],
  ['100', '≤ 1 h 30'],
  ['160', '≤ 2 h 30'],
];

function remplirFiltres(spots) {
  const zones = [
    ['', 'Toutes'],
    ...[...new Set(spots.map((s) => s.zone))].map((z) => [z, z]),
  ];
  dessinerPuces(el('filtre-zone'), zones, 'zone');
  dessinerPuces(el('filtre-distance'), TRAJETS, 'trajetMax');

  // Sur telephone la barre est repliee : le bouton doit dire ce qui est
  // filtre, sinon on cherche pourquoi des spots manquent.
  document.body.dataset.filtres = 'ferme';
  el('bouton-filtres').addEventListener('click', basculerFiltres);
  majBoutonFiltres();
}

function basculerFiltres() {
  const ouvert = document.body.dataset.filtres === 'ouvert';
  document.body.dataset.filtres = ouvert ? 'ferme' : 'ouvert';
  el('bouton-filtres').setAttribute('aria-expanded', String(!ouvert));
}

function majBoutonFiltres() {
  const actifs = [];
  if (etat.zone) actifs.push(etat.zone);
  if (etat.trajetMax) {
    actifs.push(TRAJETS.find(([valeur]) => valeur === etat.trajetMax)[1]);
  }
  el('libelle-filtres').textContent = actifs.length ? actifs.join(' · ') : 'Filtrer';
  el('bouton-filtres').classList.toggle('bouton-filtres--actif', actifs.length > 0);
}

/** Un groupe de puces exclusives, liees a une cle de `etat`. */
function dessinerPuces(conteneur, options, cle) {
  conteneur.replaceChildren();

  for (const [valeur, libelle] of options) {
    const choisie = etat[cle] === valeur;
    const puce = document.createElement('button');
    puce.type = 'button';
    puce.className = 'puce' + (choisie ? ' puce--actif' : '');
    puce.textContent = libelle;
    puce.setAttribute('aria-pressed', String(choisie));
    puce.addEventListener('click', () => {
      if (etat[cle] === valeur) return;
      etat[cle] = valeur;
      dessinerPuces(conteneur, options, cle);
      filtrer();
    });
    conteneur.append(puce);
  }
}

function spotsAffiches() {
  const zone = etat.zone;
  const distanceMax = Number(etat.trajetMax) || Infinity;
  const tri = el('tri').value;

  const liste = etat.spots.filter(
    (s) =>
      etat.jours.has(s.id) &&
      distanceVol(s) <= distanceMax &&
      (!zone || s.zone === zone)
  );

  liste.sort((a, b) => {
    switch (tri) {
      case 'nom':
        return a.nom.localeCompare(b.nom, 'fr');
      case 'altitude':
        return (b.altitude ?? 0) - (a.altitude ?? 0);
      case 'distance':
        return distanceVol(a) - distanceVol(b);
      default: {
        // Meilleur le jour choisi, puis le plus proche a qualite egale.
        const ecart = jourDe(b.id).etat.roulabilite - jourDe(a.id).etat.roulabilite;
        return ecart !== 0 ? ecart : distanceVol(a) - distanceVol(b);
      }
    }
  });

  return liste;
}

/* ------------------------------------------------------------------ */
/* Bandeau de verdict                                                  */
/* ------------------------------------------------------------------ */

/**
 * Compter ne decide rien : « 34 spots sur 34 roulent » laisse le lecteur
 * devant la meme question qu'avant. Le bandeau classe donc, et propose les
 * trois premiers du jour choisi, cliquables.
 */
function dessinerVerdict() {
  const boite = el('verdict-jour');
  const liste = spotsAffiches();
  boite.hidden = false;
  boite.replaceChildren();

  if (!liste.length) {
    boite.innerHTML = `<p class="verdict-jour__texte">Aucun spot dans ce rayon.</p>`;
    return;
  }

  // Le podium ne suit pas le tri choisi dans la barre de filtres : la
  // question « ou aller ? » a toujours la meme reponse, le meilleur du jour
  // et, a qualite egale, le plus proche.
  const classement = [...liste].sort((a, b) => {
    const ecart = jourDe(b.id).etat.roulabilite - jourDe(a.id).etat.roulabilite;
    return ecart !== 0 ? ecart : distanceVol(a) - distanceVol(b);
  });

  const roulables = classement.filter((s) => ETATS_ROULABLES.includes(jourDe(s.id).etat.cle));
  const aEviter = classement.filter((s) => jourDe(s.id).etat.roulabilite < 40);
  const podium = classement.slice(0, 3);

  let resume;
  if (!roulables.length) {
    resume = 'rien de vraiment roulant, voici les moins mauvais.';
  } else {
    resume = `${roulables.length} spot${pluriel(roulables.length)} sur ${liste.length} ` +
      `${roulables.length > 1 ? 'roulent' : 'roule'}`;
    resume += aEviter.length ? `, ${aEviter.length} à éviter.` : '.';
  }

  const entete = document.createElement('div');
  entete.className = 'verdict__entete';
  entete.innerHTML =
    `<span class="verdict__sur">La réponse pour</span>` +
    `<strong class="verdict__jour">${echapper(majuscule(nomJour(etat.jourActif)))}</strong>` +
    `<span class="verdict__resume">${resume}</span>` +
    `<span class="verdict__tri">Classés : le meilleur du jour, puis le plus proche</span>`;
  boite.append(entete);

  const rangee = document.createElement('div');
  rangee.className = 'podium';
  podium.forEach((spot, i) => rangee.append(carteVerdict(spot, i + 1)));
  if (aEviter.length) rangee.append(carteAEviter(aEviter));
  boite.append(rangee);

  // Sur telephone une seule carte tient : le reste passe en une ligne.
  const suite = document.createElement('p');
  suite.className = 'verdict__suite';
  const autres = podium.slice(1).map((s) => `${s.nom} (${trajet(s)})`).join(', ');
  suite.textContent =
    (autres ? `Puis ${autres}.` : '') +
    (aEviter.length ? ` ${aEviter.length} spot${pluriel(aEviter.length)} à éviter.` : '');
  boite.append(suite);
}

function carteVerdict(spot, rang) {
  const jours = etat.jours.get(spot.id);
  const jour = jours[etat.jourActif];
  const couleur = couleurEtat(jour.etat);

  const carte = document.createElement('button');
  carte.type = 'button';
  carte.className = 'podium__carte';
  carte.innerHTML =
    `<span class="podium__rang">${rang}</span>` +
    `<span class="podium__puce" style="background:${couleur}"></span>` +
    `<span class="podium__ident">` +
    `<span class="podium__nom">${echapper(spot.nom)}</span>` +
    `<span class="podium__meta">${trajet(spot)} · ${spot.altitude ?? '?'} m · ` +
    `${echapper(vitesseSechage(spot.hydro.drainage))}</span>` +
    `</span>` +
    `<span class="podium__bilan">` +
    `<span class="podium__etat" style="color:${couleur}">${echapper(jour.etat.court)}</span>` +
    `<span class="podium__note">${echapper(noteEtat(jours, etat.jourActif))}</span>` +
    `</span>` +
    CHEVRON;
  carte.addEventListener('click', () => selectionner(spot.id, { recentrer: true }));
  return carte;
}

function carteAEviter(aEviter) {
  const pire = aEviter[aEviter.length - 1];
  const jours = etat.jours.get(pire.id);
  const couleur = couleurEtat(jours[etat.jourActif].etat);
  // aEviter suit le classement, du moins pire au pire : on nomme les pires.
  const noms = aEviter.slice(-3).reverse().map((s) => s.nom).join(', ');

  const carte = document.createElement('div');
  carte.className = 'podium__carte podium__carte--eviter';
  carte.style.borderLeftColor = couleur;
  carte.innerHTML =
    `<span class="podium__ident">` +
    `<span class="podium__nom">À éviter — ${aEviter.length} spot${pluriel(aEviter.length)}</span>` +
    `<span class="podium__meta">${echapper(noms)}${aEviter.length > 3 ? '…' : ''}</span>` +
    `</span>` +
    `<span class="podium__bilan">` +
    `<span class="podium__etat" style="color:${couleur}">` +
    `${echapper(jours[etat.jourActif].etat.court)}</span>` +
    `<span class="podium__note">${echapper(noteEtat(jours, etat.jourActif))}</span>` +
    `</span>`;
  return carte;
}

/* ------------------------------------------------------------------ */
/* Vignettes spot × jour                                               */
/* ------------------------------------------------------------------ */

/**
 * Eau tombee dans la journee, en mm. La neige compte pour son equivalent en
 * eau, comme dans le bilan hydrique : sinon elle pesait moins lourd a l'ecran
 * qu'elle ne charge le sol a la fonte.
 */
function eauDuJour(j) {
  return j.pluie + j.neige / RATIO_NEIGE;
}

/**
 * Ce qu'une vignette dit en plus de sa teinte.
 *
 * La teinte ne prend que huit valeurs, une par etat : une semaine de
 * « parfait » donnait sept carres strictement identiques alors que le sol y
 * passait de 15 a 43 d'indice de boue. Deux marques rendent ce relief, chacune
 * sur son bord, et l'une explique l'autre :
 *
 *   en haut, l'eau tombee ce jour-la — bleue, blanche quand c'est de la neige
 *   en bas, l'eau restee dans le sol — l'indice de boue, de 0 a 100
 *
 * On lit alors une sequence et non plus un etat isole : « grosse bande mardi,
 * le niveau monte, il redescend a partir de jeudi ».
 */
function marquesVignette(j, { glyphe = false, lecture = false, pluie = true } = {}) {
  const eau = eauDuJour(j);
  const marques = [];

  if (pluie && eau >= SEUIL_EAU_MM) {
    const part = Math.min(1, eau / EAU_SATURANTE_MM);
    const hauteur = BANDE_PLUIE.min + (BANDE_PLUIE.max - BANDE_PLUIE.min) * part;
    // La neige ne charge le sol qu'a la fonte : une autre couleur evite de
    // lire « il a plu » un jour ou rien n'a coule.
    const neigeuse = j.neige / RATIO_NEIGE > j.pluie;
    marques.push(
      `<i class="vig__pluie${neigeuse ? ' vig__pluie--neige' : ''}"` +
        ` style="height:${hauteur.toFixed(1)}px"></i>`
    );
  }

  const niveau = SOL_VIDE_PCT + ((SOL_PLEIN_PCT - SOL_VIDE_PCT) * j.indice) / 100;
  marques.push(`<i class="vig__sol" style="height:${niveau.toFixed(1)}%"></i>`);

  if (lecture) {
    marques.push(lectureVignette(j, eau));
  } else if (glyphe && j.etat.glyphe) {
    // Trente pixels de large ne tiennent qu'une marque : le glyphe, qui porte
    // une cause inattendue — gel, neige — passe avant tout chiffre.
    marques.push(`<span class="vig__glyphe">${j.etat.glyphe}</span>`);
  }

  return marques.join('');
}

/**
 * Ce que la colonne du jour choisi ecrit, elle qui est deux fois et demie plus
 * large que les autres. La colonne « Etat » dit deja l'etat en toutes lettres
 * et le prochain creneau : restent les mesures, celles qu'on va chercher dans
 * le detail alors qu'elles tiennent ici — l'eau tombee, puis les temperatures.
 */
function lectureVignette(j, eau) {
  // Deux mesures, jamais trois : au-dela la ligne deborde des quatre-vingts
  // pixels de la colonne. L'ordre dit la priorite — une cause inattendue,
  // puis l'eau tombee, puis les temperatures si la place reste.
  const mesures = [];
  if (j.etat.glyphe) mesures.push(`<span class="vig__glyphe">${j.etat.glyphe}</span>`);
  if (eau >= SEUIL_EAU_MM) mesures.push(`<b>${echapper(formaterMm(eau))} mm</b>`);
  if (mesures.length < 2 && j.tmin !== null && j.tmax !== null) {
    mesures.push(`<em>${Math.round(j.tmin)}/${Math.round(j.tmax)}°</em>`);
  }

  return mesures.length ? `<span class="vig__lecture">${mesures.join('')}</span>` : '';
}

/** « 0,8 » ou « 12 » : trois caracteres, c'est tout ce qui tient. */
function formaterMm(mm) {
  return mm < 10 ? mm.toFixed(1).replace('.', ',') : String(Math.round(mm));
}

/* ------------------------------------------------------------------ */
/* Grille spots x jours                                                */
/* ------------------------------------------------------------------ */

function dessinerTableau() {
  const conteneur = el('tableau');
  const index = fenetre();
  const liste = spotsAffiches();

  // Le jour choisi s'elargit sur place plutot que d'ouvrir un panneau : la
  // comparaison avec les quatorze autres colonnes reste sous les yeux. En
  // dessous de 1350 px la feuille de style annule cet elargissement, d'ou
  // --nb-jours, qui lui sert alors a reformer des colonnes egales.
  conteneur.style.setProperty('--nb-jours', index.length);
  conteneur.style.setProperty(
    '--colonnes-jours',
    index
      .map((i) =>
        i === etat.jourActif ? `minmax(0, ${FACTEUR_JOUR_ACTIF}fr)` : 'minmax(0, 1fr)'
      )
      .join(' ')
  );
  conteneur.replaceChildren();

  // --- En-tete : les colonnes de jours servent de selecteur ---
  const entete = document.createElement('div');
  entete.className = 'tab__ligne tab__ligne--entete';
  entete.append(cellule('div', 'tab__coin', 'Spot'));

  for (const i of index) {
    const date = new Date(`${etat.dates[i]}T12:00:00`);
    const bouton = document.createElement('button');
    bouton.type = 'button';
    bouton.className =
      'tab__jour' +
      (i === etat.jourActif ? ' tab__jour--actif' : '') +
      (i === etat.idxAuj ? ' tab__jour--aujourdhui' : '') +
      (i > etat.idxAuj ? ' tab__jour--futur' : '');
    bouton.innerHTML =
      `<span>${date.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '')}</span>` +
      `<strong>${date.getDate()}</strong>`;
    bouton.title = `Voir ${nomJour(i)}`;
    bouton.addEventListener('click', () => choisirJour(i));
    entete.append(bouton);
  }

  const finEntete = document.createElement('div');
  finEntete.className = 'tab__coin--fin';
  finEntete.innerHTML = `<span>État<br>${dateCourte(etat.jourActif)}</span>`;
  entete.append(finEntete);

  conteneur.append(entete);

  // --- Une ligne par spot ---
  const corps = document.createElement('div');
  corps.className = 'tab__corps';

  for (const spot of liste) {
    const ligne = document.createElement('div');
    ligne.className = 'tab__ligne' + (spot.id === etat.selection ? ' tab__ligne--active' : '');

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'tab__label';
    label.innerHTML =
      `<span class="tab__nom">${echapper(spot.nom)}</span>` +
      `<span class="tab__meta">${trajet(spot)} · ${spot.altitude ?? '?'} m</span>`;
    label.addEventListener('click', () => selectionner(spot.id, { recentrer: true }));
    ligne.append(label);

    const jours = etat.jours.get(spot.id);
    for (const i of index) {
      const j = jours[i];
      const c = document.createElement('button');
      c.type = 'button';
      c.className =
        'tab__cellule' +
        (i === etat.jourActif ? ' tab__cellule--colonne' : '') +
        (i > etat.idxAuj ? ' tab__cellule--futur' : '');
      c.style.background = couleurEtat(j.etat);
      c.title = `${spot.nom} — ${nomJour(i)} · ${infobulle(j, { date: false })}`;
      c.setAttribute('aria-label', c.title);
      // Les mesures ne sortent que dans la colonne du jour choisi : c'est la
      // seule ou l'on decide, et quinze colonnes chiffrees ne se scannent plus.
      c.innerHTML = marquesVignette(j, { glyphe: true, lecture: i === etat.jourActif });
      c.addEventListener('click', () => {
        choisirJour(i);
        selectionner(spot.id, { recentrer: true });
      });
      ligne.append(c);
    }

    // La couleur dit « c'est bon » ou « c'est mauvais », pas quoi en faire :
    // cette colonne ecrit l'etat du jour choisi et le prochain bon creneau.
    const jourActif = jours[etat.jourActif];
    const fin = document.createElement('span');
    fin.className = 'tab__fin';
    fin.innerHTML =
      `<span class="tab__fin-etat" style="color:${couleurEtat(jourActif.etat)}">` +
      `${echapper(jourActif.etat.court)}</span>` +
      `<span class="tab__fin-note">${echapper(noteEtat(jours, etat.jourActif))}</span>`;
    ligne.append(fin);

    corps.append(ligne);
  }

  conteneur.append(corps);
}

/**
 * Ce qu'il faut savoir en plus de l'etat du jour : combien de temps ca tient,
 * ou a partir de quand ca redevient roulant.
 */
function noteEtat(jours, idx) {
  const roulable = (j) => ETATS_ROULABLES.includes(j.etat.cle);
  const fin = Math.min(jours.length - 1, etat.idxAuj + JOURS_FUTURS);

  if (roulable(jours[idx])) {
    for (let i = idx + 1; i <= fin; i++) {
      if (!roulable(jours[i])) {
        return i === idx + 1
          ? `se gâte ${nomJourCourt(i)}`
          : `tient jusqu’à ${nomJourCourt(i - 1)}`;
      }
    }
    return 'ça tient';
  }

  const delai = delaiAvantSechage(jours, idx);
  return delai === null ? 'hors fenêtre' : `bon dès ${nomJourCourt(idx + delai)}`;
}

/* ------------------------------------------------------------------ */
/* Rail de jours et liste — vues telephone                             */
/* ------------------------------------------------------------------ */

/**
 * Sur telephone la grille n'est pas toujours a l'ecran : sans ce rail, le
 * jour choisi ne serait plus modifiable depuis la liste ni depuis la carte.
 */
function dessinerRail() {
  const rail = el('rail-jours');
  const liste = spotsAffiches();
  rail.replaceChildren();

  for (const i of fenetre()) {
    const date = new Date(`${etat.dates[i]}T12:00:00`);
    const bouton = document.createElement('button');
    bouton.type = 'button';
    bouton.className =
      'rail__jour' +
      (i === etat.jourActif ? ' rail__jour--actif' : '') +
      (i === etat.idxAuj ? ' rail__jour--aujourdhui' : '');

    const bons = liste.filter((s) =>
      ETATS_ROULABLES.includes(etat.jours.get(s.id)[i].etat.cle)
    ).length;
    const part = liste.length ? Math.round((bons / liste.length) * 100) : 0;

    bouton.innerHTML =
      `<span class="rail__nom">${
        i === etat.idxAuj
          ? 'auj.'
          : date.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '')
      }</span>` +
      `<span class="rail__num">${date.getDate()}</span>` +
      `<span class="rail__sante"><i style="width:${part}%"></i></span>`;
    bouton.title = `${nomJour(i)} — ${bons} spots sur ${liste.length} roulants`;
    bouton.addEventListener('click', () => choisirJour(i));
    rail.append(bouton);
  }

  // Le rail s'ouvre sur aujourd'hui, et suit le jour choisi s'il sort du cadre.
  const actif = rail.querySelector('.rail__jour--actif');
  if (actif) {
    const debut = actif.offsetLeft;
    const finBouton = debut + actif.offsetWidth;
    if (debut < rail.scrollLeft || finBouton > rail.scrollLeft + rail.clientWidth) {
      rail.scrollLeft = Math.max(0, debut - 12);
    }
  }
}

/**
 * La vue de reference sur telephone, ou la grille ne tient pas en largeur :
 * la meme information lue ligne par ligne — le nom, l'etat du jour choisi
 * ecrit en toutes lettres, et la frise des 15 jours, cliquable case par case.
 */
function dessinerListe() {
  const conteneur = el('liste');
  const liste = spotsAffiches();
  const index = fenetre();
  conteneur.replaceChildren();

  if (!liste.length) {
    const vide = document.createElement('p');
    vide.className = 'liste__vide';
    vide.textContent = 'Aucun spot dans ce rayon.';
    conteneur.append(vide);
    return;
  }

  for (const spot of liste) {
    const jours = etat.jours.get(spot.id);
    const jour = jours[etat.jourActif];
    const couleur = couleurEtat(jour.etat);

    const ligne = document.createElement('div');
    ligne.className = 'spot' + (spot.id === etat.selection ? ' spot--actif' : '');

    const infos = document.createElement('button');
    infos.type = 'button';
    infos.className = 'spot__infos';
    infos.innerHTML =
      `<span class="spot__puce" style="background:${couleur}"></span>` +
      `<span class="spot__nom">${echapper(spot.nom)}</span>` +
      `<span class="spot__etat" style="color:${couleur}">${echapper(jour.etat.court)}</span>` +
      `<span class="spot__meta">${trajet(spot)} · ${spot.altitude ?? '?'} m</span>` +
      `<span class="spot__note">${echapper(noteEtat(jours, etat.jourActif))}</span>`;
    infos.addEventListener('click', () => selectionner(spot.id, { recentrer: false }));
    ligne.append(infos);

    // Chaque case de la frise est un jour : la rendre cliquable donne a la
    // liste le geste de la grille — choisir un spot et un jour d'un coup.
    const frise = document.createElement('span');
    frise.className = 'spot__frise';
    for (const i of index) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className =
        'spot__case' +
        (i > etat.idxAuj ? ' spot__case--futur' : '') +
        (i === etat.jourActif ? ' spot__case--actif' : '');
      c.style.backgroundColor = couleurEtat(jours[i].etat);
      c.title = `${spot.nom} — ${nomJour(i)} · ${infobulle(jours[i], { date: false })}`;
      c.setAttribute('aria-label', c.title);
      // Onze pixels de haut : les deux bandes passent, pas le glyphe ni le
      // chiffre — l'etat en toutes lettres est juste au-dessus, dans la ligne.
      c.innerHTML = marquesVignette(jours[i]);
      c.addEventListener('click', () => {
        choisirJour(i);
        selectionner(spot.id, { recentrer: false });
      });
      frise.append(c);
    }
    ligne.append(frise);

    conteneur.append(ligne);
  }
}

function initialiserOnglets() {
  for (const bouton of document.querySelectorAll('.onglet')) {
    bouton.addEventListener('click', () => basculerVue(bouton.dataset.vue));
  }
  basculerVue(etat.vue);
}

function basculerVue(vue) {
  etat.vue = vue;
  document.body.dataset.vue = vue;

  for (const bouton of document.querySelectorAll('.onglet')) {
    const actif = bouton.dataset.vue === vue;
    bouton.classList.toggle('onglet--actif', actif);
    bouton.setAttribute('aria-pressed', String(actif));
  }

  // MapLibre ne recalcule pas sa taille tant qu'il etait masque.
  if (vue === 'carte') etat.carte?.resize();
}

function choisirJour(i) {
  etat.jourActif = i;
  rafraichirVues();
  if (etat.selection) dessinerDetail(etat.spots.find((s) => s.id === etat.selection));
}

/* ------------------------------------------------------------------ */
/* Carte                                                               */
/* ------------------------------------------------------------------ */

function initialiserCarte() {
  etat.carte = new maplibregl.Map({
    container: 'carte',
    style: {
      version: 8,
      sources: {
        ign: {
          type: 'raster',
          tiles: [
            'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile' +
              '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM' +
              '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
          ],
          tileSize: 256,
          attribution: '&copy; IGN-F/Géoportail — sol : BRGM, SoilGrids — météo : Open-Meteo',
        },
      },
      layers: [{ id: 'ign', type: 'raster', source: 'ign' }],
    },
    bounds: emprise(etat.spots),
    fitBoundsOptions: { padding: 36, maxZoom: 9 },
  });

  etat.carte.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  etat.carte.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }));
}

/** Rectangle englobant tous les spots : le cadrage suit les zones ajoutees. */
function emprise(spots) {
  const lons = spots.map((s) => s.lon);
  const lats = spots.map((s) => s.lat);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

function dessinerMarqueurs() {
  for (const spot of etat.spots) {
    if (!etat.jours.has(spot.id)) continue;

    const noeud = document.createElement('div');
    noeud.className = 'marqueur';
    noeud.addEventListener('click', (e) => {
      e.stopPropagation();
      selectionner(spot.id, { recentrer: false });
    });

    new maplibregl.Marker({ element: noeud }).setLngLat([spot.lon, spot.lat]).addTo(etat.carte);
    etat.marqueurs.set(spot.id, noeud);
  }
  majMarqueurs();
}

/** Recolore la carte pour le jour actif, et masque les spots filtres. */
function majMarqueurs() {
  const visibles = new Set(spotsAffiches().map((s) => s.id));

  for (const [id, noeud] of etat.marqueurs) {
    const j = jourDe(id);
    noeud.style.background = couleurEtat(j.etat);
    noeud.textContent = j.etat.glyphe ?? '';
    noeud.title = `${etat.spots.find((s) => s.id === id).nom} — ${j.etat.label}`;
    noeud.classList.toggle('marqueur--estompe', !visibles.has(id));
    noeud.classList.toggle('marqueur--actif', id === etat.selection);
  }
}

/* ------------------------------------------------------------------ */
/* Détail                                                              */
/* ------------------------------------------------------------------ */

function selectionner(id, { recentrer }) {
  etat.selection = id;
  dessinerTableau();
  dessinerListe();
  majMarqueurs();

  const spot = etat.spots.find((s) => s.id === id);
  if (recentrer) {
    etat.carte.flyTo({ center: [spot.lon, spot.lat], zoom: 10.5, duration: 700 });
  }

  dessinerDetail(spot);
  el('detail').hidden = false;
  el('detail').scrollTop = 0;
}

function fermerDetail() {
  etat.selection = null;
  el('detail').hidden = true;
  dessinerTableau();
  dessinerListe();
  majMarqueurs();
}

function dessinerDetail(spot) {
  const jours = etat.jours.get(spot.id);
  const idx = etat.jourActif;
  const jour = jours[idx];
  const index = fenetre();
  const pluieMax = Math.max(6, ...index.map((i) => jours[i].pluie + jours[i].neige));

  const colonnes = index
    .map((i) => {
      const j = jours[i];
      const precip = j.pluie + j.neige;
      const hauteur = precip > 0 ? Math.max(3, (precip / pluieMax) * 100) : 0;
      const date = new Date(`${j.date}T12:00:00`);
      const classes = [
        'jour',
        i > etat.idxAuj ? 'jour--futur' : '',
        i === etat.jourActif ? 'jour--actif' : '',
      ]
        .filter(Boolean)
        .join(' ');

      return `
        <div class="${classes}" title="${echapper(infobulle(j))}">
          <div class="jour__date">
            ${date.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '')}
            <strong>${date.getDate()}</strong>
          </div>
          <div class="jour__pluie"><div class="jour__pluie-barre" style="height:${hauteur}%"></div></div>
          <div class="jour__pluie-valeur">${precip >= 0.5 ? precip.toFixed(0) : ''}</div>
          <div class="jour__etat" style="background:${couleurEtat(j.etat)}">${
            marquesVignette(j, { glyphe: true, pluie: false })
          }</div>
        </div>`;
    })
    .join('');

  const h = spot.hydro;
  const total = spot.sol.argile + spot.sol.limon + spot.sol.sable || 100;

  el('detail-contenu').innerHTML = `
    <h2>${echapper(spot.nom)}</h2>
    <p class="detail__meta">
      ${echapper(spot.zone)} · ${trajet(spot)} · ${spot.altitude ?? '?'} m
      · pente ${spot.pentePct ?? '?'} % · versant ${cardinal(spot.exposition)}
    </p>

    <div class="verdict" style="border-left-color:${couleurEtat(jour.etat)}">
      <span class="verdict__quand">${majuscule(nomJour(idx))}</span>
      <span class="verdict__etat" style="color:${couleurEtat(jour.etat)}">${jour.etat.label}</span>
      <span class="verdict__texte">${echapper(conseil(jours, idx))}</span>
    </div>

    <div class="frise">${colonnes}</div>
    <div class="frise-legende">
      <span>← 7 jours passés (observé)</span>
      <span>barres bleues : précipitations en mm</span>
      <span>7 jours à venir (prévu, hachuré) →</span>
    </div>

    <div class="fiches">
      <div class="fiche">
        <h3>Nature du sol</h3>
        <div class="texture">
          <span style="width:${(spot.sol.argile / total) * 100}%;background:${COULEURS_TEXTURE.argile}"></span>
          <span style="width:${(spot.sol.limon / total) * 100}%;background:${COULEURS_TEXTURE.limon}"></span>
          <span style="width:${(spot.sol.sable / total) * 100}%;background:${COULEURS_TEXTURE.sable}"></span>
        </div>
        <div class="texture-legende">
          <span><i style="background:${COULEURS_TEXTURE.argile}"></i>argile ${spot.sol.argile} %</span>
          <span><i style="background:${COULEURS_TEXTURE.limon}"></i>limon ${spot.sol.limon} %</span>
          <span><i style="background:${COULEURS_TEXTURE.sable}"></i>sable ${spot.sol.sable} %</span>
        </div>
        <p class="note">
          ${echapper(h.texture)} sur ${echapper(spot.lithologie.descr ?? 'lithologie inconnue')}
          (BRGM) — ${echapper(vitesseSechage(h.drainage))}.
        </p>
      </div>

      <div class="fiche">
        <h3>Bilan hydrique</h3>
        <dl>
          <dt>Saturation</dt><dd>${Math.round(jour.humidite * 100)} %</dd>
          <dt>Réserve du sol</dt><dd>${jour.stock} mm</dd>
          <dt>Capacité au champ</dt><dd>${h.stockFc.toFixed(0)} mm</dd>
          <dt>Pluie 7 j. passés</dt><dd>${cumulPluie(jours, etat.idxAuj - 1, JOURS_PASSES)} mm</dd>
          <dt>Pluie 7 j. à venir</dt><dd>${cumulPluieFuture(jours)} mm</dd>
          ${jour.manteauNeigeux > 1 ? `<dt>Manteau neigeux</dt><dd>${jour.manteauNeigeux} mm eq.</dd>` : ''}
        </dl>
      </div>

      <div class="fiche">
        <h3>Paramètres du modèle</h3>
        <dl>
          <dt>Indice de boue</dt><dd>${jour.indice} / 100</dd>
          <dt>Drainage / jour</dt><dd>${(h.drainage * 100).toFixed(0)} %</dd>
          <dt>Ruissellement</dt><dd>${(h.ruissellementBase * 100).toFixed(0)} %</dd>
          <dt>Effet d’exposition</dt><dd>×${h.kcExposition.toFixed(2)}</dd>
        </dl>
        <p class="note" id="signal-modele">Signal modèle Open-Meteo : chargement…</p>
      </div>
    </div>`;

  chargerSignalModele(spot, jours);
}

/**
 * Compare notre bilan a l'humidite de sol simulee par Open-Meteo.
 * C'est un controle de coherence sur la dynamique, pas une verite terrain :
 * le modele meteo ignore le sol local.
 */
async function chargerSignalModele(spot, jours) {
  const cible = el('signal-modele');
  try {
    const parJour = await humiditeModele(spot);
    if (etat.selection !== spot.id || !cible.isConnected) return;
    if (!parJour) {
      cible.textContent = 'Signal modèle Open-Meteo : indisponible.';
      return;
    }

    const valeurs = jours
      .slice(Math.max(0, etat.idxAuj - JOURS_PASSES), etat.idxAuj + 1)
      .map((j) => parJour[j.date])
      .filter(Number.isFinite);

    if (valeurs.length < 2) {
      cible.textContent = 'Signal modèle Open-Meteo : indisponible.';
      return;
    }

    const actuel = valeurs.at(-1);
    const tendance = actuel - valeurs[0];
    // Seuil large : sous 2 points d'humidite volumique, la derive du modele
    // ne se distingue pas d'une vraie tendance.
    const sens = tendance > 0.02 ? 'en charge' : tendance < -0.02 ? 'en ressuyage' : 'stable';
    cible.textContent =
      `Signal modèle Open-Meteo : ${(actuel * 100).toFixed(0)} % d’humidité de sol, ${sens} ` +
      `sur 7 jours. Grille de plusieurs km, à lire comme une tendance.`;
  } catch {
    if (cible.isConnected) cible.textContent = 'Signal modèle Open-Meteo : indisponible.';
  }
}

/* ------------------------------------------------------------------ */
/* Formulation du conseil                                              */
/* ------------------------------------------------------------------ */

function conseil(jours, idx) {
  const jour = jours[idx];
  const delai = delaiAvantSechage(jours, idx);
  const pluieAVenir = cumulPluieFuture(jours);

  if (jour.etat.cle === 'neige') return 'Sentiers sous la neige — plutôt raquettes que VTT.';
  if (jour.etat.cle === 'gele') return 'Sol dur et roulant. Attention au verglas en dévers.';
  if (jour.etat.cle === 'degel')
    return 'C’est le moment où l’on abîme le plus les sentiers. À éviter.';

  if (delai === 0) {
    const degradation = jours
      .slice(idx + 1, idx + 1 + JOURS_FUTURS)
      .findIndex((j) => ['gras', 'bourbier'].includes(j.etat.cle));
    if (degradation >= 0) {
      return `Ça roule. Ça se dégrade dans ${degradation + 1} j (${pluieAVenir} mm annoncés).`;
    }
    return pluieAVenir > 5
      ? `Ça roule, et ça devrait tenir malgré les ${pluieAVenir} mm annoncés.`
      : 'Ça roule, et rien de méchant à l’horizon.';
  }

  if (delai === null) {
    return `Ça ne ressuie pas sur la fenêtre de prévision (${pluieAVenir} mm à venir).`;
  }
  return delai === 1
    ? 'Ça devrait être bon dès le lendemain.'
    : `Compter ${delai} jours avant que ça redevienne roulant.`;
}

function cumulPluieFuture(jours) {
  let total = 0;
  for (let i = etat.idxAuj + 1; i <= Math.min(jours.length - 1, etat.idxAuj + JOURS_FUTURS); i++) {
    total += jours[i].pluie + jours[i].neige;
  }
  return Math.round(total * 10) / 10;
}

/**
 * Le resume d'un jour en une ligne. Sans sa date quand l'appelant l'a deja
 * dite — l'infobulle d'une vignette nomme le spot et le jour avant elle. Les
 * deux marques de la vignette y sont nommees : l'eau tombee, l'eau du sol.
 */
function infobulle(j, { date = true } = {}) {
  const morceaux = date ? [j.date] : [];
  morceaux.push(j.etat.label, `${formaterMm(eauDuJour(j))} mm d’eau`, `sol ${j.indice}/100`);
  if (j.neige > 0) morceaux.push(`neige ${j.neige} cm`);
  if (j.tmin !== null && j.tmax !== null) {
    morceaux.push(`${Math.round(j.tmin)}/${Math.round(j.tmax)} °C`);
  }
  return morceaux.join(' · ');
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

/** Etat d'un spot le jour actif. */
function jourDe(id) {
  return etat.jours.get(id)[etat.jourActif];
}

/** Nom relatif d'un jour : « aujourd'hui », « demain », « samedi 5 »… */
function nomJour(i) {
  const ecart = i - etat.idxAuj;
  const relatifs = { '-2': 'avant-hier', '-1': 'hier', 0: 'aujourd’hui', 1: 'demain', 2: 'après-demain' };
  if (relatifs[ecart]) return relatifs[ecart];

  const date = new Date(`${etat.dates[i]}T12:00:00`);
  const jour = date.toLocaleDateString('fr-FR', { weekday: 'long' });
  return `${ecart < 0 ? `${jour} dernier` : jour} ${date.getDate()}`;
}

/** « mer. 2 » — assez court pour un en-tete de colonne ou une note. */
function dateCourte(i) {
  const date = new Date(`${etat.dates[i]}T12:00:00`);
  const jour = date.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
  return `${jour}. ${date.getDate()}`;
}

/** Comme dateCourte, mais « aujourd'hui » et « demain » restent en clair. */
function nomJourCourt(i) {
  const ecart = i - etat.idxAuj;
  if (ecart === 0) return 'aujourd’hui';
  if (ecart === 1) return 'demain';
  return dateCourte(i);
}

/** Distance a vol d'oiseau depuis Toulouse, en km. */
function distanceVol(spot) {
  const R = 6371;
  const dLat = ((spot.lat - TOULOUSE.lat) * Math.PI) / 180;
  const dLon = ((spot.lon - TOULOUSE.lon) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((TOULOUSE.lat * Math.PI) / 180) *
      Math.cos((spot.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Estimation de trajet depuis Toulouse. Volontairement grossiere : elle part
 * de la distance a vol d'oiseau, sans calcul d'itineraire.
 */
function trajet(spot) {
  const km = distanceVol(spot);
  const minutes = Math.round(((km * FACTEUR_ROUTE) / VITESSE_MOYENNE) * 60 + 8);
  const duree = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`;
  return `~${duree}`;
}

const POINTS_CARDINAUX = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];

function cardinal(azimut) {
  if (azimut === null || !Number.isFinite(azimut)) return 'plat';
  return POINTS_CARDINAUX[Math.round(azimut / 45) % 8];
}

function dateDuJour() {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function formaterDateCourte(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function cellule(balise, classe, texte) {
  const n = document.createElement(balise);
  n.className = classe;
  n.textContent = texte;
  return n;
}

function majuscule(t) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function echapper(texte) {
  const div = document.createElement('div');
  div.textContent = texte ?? '';
  return div.innerHTML;
}

function afficherErreur(message) {
  const boite = el('erreur');
  boite.textContent = message;
  boite.hidden = false;
}
